from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Final, Sequence

import numpy as np
import sys
from importlib.metadata import version as package_version

from .contract import (
    DISTANCES,
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    TrainingSample,
    dataset_sha256,
    feature_schema_document,
    feature_schema_sha256,
)
from .metrics import PredictionResult, regression_metrics

CATBOOST_PARAMETERS: Final[dict[str, Any]] = {
    "loss_function": "RMSE",
    "iterations": 300,
    "depth": 4,
    "learning_rate": 0.03,
    "l2_leaf_reg": 10,
    "random_seed": 20260711,
    "allow_writing_files": False,
    "verbose": False,
    "thread_count": 1,
}


class TrainingError(RuntimeError):
    """Raised when model training or export cannot be completed safely."""


@dataclass(frozen=True)
class TrainingConfig:
    model_version: str = "race-residual-catboost-v1"
    minimum_labels: int = 50
    minimum_labels_per_distance: int = 8
    initial_training_size: int = 30
    minimum_holdout_predictions: int = 15
    minimum_holdout_per_distance: int = 3
    minimum_mae_improvement: float = 0.03
    maximum_distance_regression: float = 0.05
    maximum_coverage_drop: float = 0.05
    correction_cap_fraction: float = 0.12
    parity_tolerance: float = 1e-6


@dataclass(frozen=True)
class TrainingResult:
    status: str
    output_directory: Path
    manifest: dict[str, Any]
    evaluation: dict[str, Any]


def _instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise TrainingError("training timestamps must include a timezone")
    return parsed


def _validate_training_cutoff(
    samples: Sequence[TrainingSample], training_data_through_at: str
) -> None:
    cutoff = _instant(training_data_through_at)
    future = [sample.sample_id for sample in samples if _instant(sample.completed_at) > cutoff]
    if future:
        preview = ", ".join(future[:3])
        raise TrainingError(
            "training labels completed after training_data_through_at: " + preview
        )


def _matrix(samples: Sequence[TrainingSample]) -> np.ndarray:
    return np.asarray([sample.feature_row() for sample in samples], dtype=np.float32)


def _targets(samples: Sequence[TrainingSample]) -> np.ndarray:
    return np.asarray([sample.target_log_residual for sample in samples], dtype=np.float32)


def _fit(samples: Sequence[TrainingSample]):
    try:
        from catboost import CatBoostRegressor
    except ImportError as error:
        raise TrainingError(
            "CatBoost is not installed; run `python -m pip install -e research[test]`"
        ) from error
    model = CatBoostRegressor(**CATBOOST_PARAMETERS)
    model.fit(_matrix(samples), _targets(samples))
    return model


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def _adjusted_prediction(
    sample: TrainingSample, target_log_residual: float, cap: float
) -> PredictionResult:
    fraction = _clamp(math.exp(float(target_log_residual)) - 1, -cap, cap)
    factor = 1 + fraction
    scale = lambda value: None if value is None else max(1.0, value * factor)
    return PredictionResult(
        distance=sample.distance,
        actual_seconds=sample.actual_seconds,
        predicted_seconds=max(1.0, sample.baseline_predicted_seconds * factor),
        optimistic_seconds=scale(sample.baseline_optimistic_seconds),
        pessimistic_seconds=scale(sample.baseline_pessimistic_seconds),
    )


def _baseline_prediction(sample: TrainingSample) -> PredictionResult:
    return PredictionResult(
        distance=sample.distance,
        actual_seconds=sample.actual_seconds,
        predicted_seconds=sample.baseline_predicted_seconds,
        optimistic_seconds=sample.baseline_optimistic_seconds,
        pessimistic_seconds=sample.baseline_pessimistic_seconds,
    )


def _metrics_by_distance(rows: Sequence[PredictionResult]) -> dict[str, Any]:
    return {
        distance: regression_metrics(row for row in rows if row.distance == distance).to_dict()
        for distance in DISTANCES
    }


def _walk_forward(
    samples: Sequence[TrainingSample], config: TrainingConfig
) -> tuple[list[PredictionResult], list[PredictionResult], list[dict[str, Any]]]:
    baseline: list[PredictionResult] = []
    candidate: list[PredictionResult] = []
    predictions: list[dict[str, Any]] = []
    for sample in samples:
        # A label becomes available only after its workout is complete.  Using
        # an earlier list position is not sufficient: overlapping workouts or
        # samples with the same start time would otherwise leak an outcome into
        # another prediction made before that outcome was known.
        observed = _instant(sample.observed_at)
        training_samples = [
            prior
            for prior in samples
            if _instant(prior.completed_at) <= observed
        ]
        if len(training_samples) < config.initial_training_size:
            continue
        model = _fit(training_samples)
        raw = float(np.asarray(model.predict(_matrix([sample]))).reshape(-1)[0])
        baseline_row = _baseline_prediction(sample)
        candidate_row = _adjusted_prediction(sample, raw, config.correction_cap_fraction)
        baseline.append(baseline_row)
        candidate.append(candidate_row)
        predictions.append(
            {
                "sampleId": sample.sample_id,
                "observedAt": sample.observed_at,
                "distance": sample.distance,
                "actualSeconds": sample.actual_seconds,
                "baselinePredictedSeconds": sample.baseline_predicted_seconds,
                "candidatePredictedSeconds": candidate_row.predicted_seconds,
                "rawTargetLogResidual": raw,
                "trainingLabelCount": len(training_samples),
                "trainingDataThroughAt": max(
                    prior.completed_at for prior in training_samples
                ),
                "appliedCorrectionFraction": (
                    candidate_row.predicted_seconds / sample.baseline_predicted_seconds - 1
                ),
            }
        )
    return baseline, candidate, predictions


def _gate(
    samples: Sequence[TrainingSample],
    baseline: Sequence[PredictionResult],
    candidate: Sequence[PredictionResult],
    config: TrainingConfig,
) -> tuple[bool, list[str], dict[str, Any]]:
    reasons: list[str] = []
    counts = {distance: sum(row.distance == distance for row in samples) for distance in DISTANCES}
    holdout_counts = {
        distance: sum(row.distance == distance for row in candidate) for distance in DISTANCES
    }
    if len(samples) < config.minimum_labels:
        reasons.append("insufficient_total_labels")
    if any(value < config.minimum_labels_per_distance for value in counts.values()):
        reasons.append("insufficient_labels_per_distance")
    if len(candidate) < config.minimum_holdout_predictions:
        reasons.append("insufficient_walk_forward_predictions")
    if any(value < config.minimum_holdout_per_distance for value in holdout_counts.values()):
        reasons.append("insufficient_walk_forward_predictions_per_distance")

    baseline_metrics = regression_metrics(baseline)
    candidate_metrics = regression_metrics(candidate)
    baseline_mae = baseline_metrics.meanAbsoluteErrorSeconds
    candidate_mae = candidate_metrics.meanAbsoluteErrorSeconds
    improvement = (
        None
        if baseline_mae is None or candidate_mae is None or baseline_mae == 0
        else 1 - candidate_mae / baseline_mae
    )
    if improvement is None or improvement < config.minimum_mae_improvement:
        reasons.append("overall_mae_improvement_below_threshold")

    distance_regressions: dict[str, float | None] = {}
    for distance in DISTANCES:
        base = regression_metrics(row for row in baseline if row.distance == distance)
        model = regression_metrics(row for row in candidate if row.distance == distance)
        regression = (
            None
            if base.meanAbsoluteErrorSeconds in (None, 0) or model.meanAbsoluteErrorSeconds is None
            else model.meanAbsoluteErrorSeconds / base.meanAbsoluteErrorSeconds - 1
        )
        distance_regressions[distance] = regression
        if regression is None or regression > config.maximum_distance_regression:
            reasons.append(f"distance_mae_regression:{distance}")

    coverage_drop = (
        None
        if baseline_metrics.intervalCoverage is None or candidate_metrics.intervalCoverage is None
        else baseline_metrics.intervalCoverage - candidate_metrics.intervalCoverage
    )
    if coverage_drop is None:
        reasons.append("interval_coverage_unavailable")
    elif coverage_drop > config.maximum_coverage_drop:
        reasons.append("interval_coverage_drop_above_threshold")
    details = {
        "labelCount": len(samples),
        "labelCountByDistance": counts,
        "holdoutCount": len(candidate),
        "holdoutCountByDistance": holdout_counts,
        "meanAbsoluteErrorImprovement": improvement,
        "distanceMaeRegression": distance_regressions,
        "intervalCoverageDrop": coverage_drop,
        "thresholds": {
            "minimumLabels": config.minimum_labels,
            "minimumLabelsPerDistance": config.minimum_labels_per_distance,
            "initialTrainingSize": config.initial_training_size,
            "minimumHoldoutPredictions": config.minimum_holdout_predictions,
            "minimumHoldoutPerDistance": config.minimum_holdout_per_distance,
            "minimumMaeImprovement": config.minimum_mae_improvement,
            "maximumDistanceRegression": config.maximum_distance_regression,
            "maximumCoverageDrop": config.maximum_coverage_drop,
        },
    }
    return not reasons, reasons, details


def _write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _export_onnx(model: Any, path: Path) -> tuple[str, str]:
    model.save_model(
        str(path),
        format="onnx",
        export_parameters={
            "onnx_domain": "ai.rai",
            "onnx_model_version": 1,
            "onnx_doc_string": "RAI CatBoost race residual targetLogResidual",
            "onnx_graph_name": "rai_race_residual_catboost_v1",
        },
    )
    # CatBoost writes a wall-clock train_finish_time and a random model_guid into
    # ONNX metadata. They do not affect inference, but they make otherwise
    # identical artifacts hash differently. Remove only those non-semantic
    # fields and serialize deterministically before parity validation.
    try:
        import onnx
    except ImportError as error:
        raise TrainingError(
            "onnx is not installed; run `python -m pip install -e research[test]`"
        ) from error
    graph = onnx.load(str(path))
    metadata = [
        (entry.key, entry.value)
        for entry in graph.metadata_props
        if entry.key not in {"train_finish_time", "model_guid"}
    ]
    del graph.metadata_props[:]
    for key, value in metadata:
        entry = graph.metadata_props.add()
        entry.key = key
        entry.value = value
    path.write_bytes(graph.SerializeToString(deterministic=True))
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise TrainingError(
            "onnxruntime is not installed; run `python -m pip install -e research[test]`"
        ) from error
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    if len(session.get_inputs()) != 1 or len(session.get_outputs()) != 1:
        raise TrainingError("ONNX model must expose exactly one input and one output")
    input_meta = session.get_inputs()[0]
    output_meta = session.get_outputs()[0]
    if input_meta.type != "tensor(float)":
        raise TrainingError(f"ONNX input must be float32, received {input_meta.type}")
    if output_meta.type != "tensor(float)":
        raise TrainingError(f"ONNX output must be float32, received {output_meta.type}")
    return input_meta.name, output_meta.name


def _onnx_parity(
    model: Any,
    path: Path,
    input_name: str,
    output_name: str,
    samples: Sequence[TrainingSample],
    tolerance: float,
) -> dict[str, Any]:
    import onnxruntime as ort

    test_samples = list(samples[: min(len(samples), 32)])
    matrix = _matrix(test_samples)
    native = np.asarray(model.predict(matrix), dtype=np.float32).reshape(-1, 1)
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    onnx = np.asarray(session.run([output_name], {input_name: matrix})[0], dtype=np.float32)
    if onnx.shape != (len(test_samples), 1):
        raise TrainingError(
            f"ONNX output shape must be [N,1], received {list(onnx.shape)}"
        )
    maximum = float(np.max(np.abs(native - onnx))) if len(test_samples) else 0.0
    if maximum >= tolerance:
        raise TrainingError(
            f"ONNX parity failed: max absolute error {maximum} is not below {tolerance}"
        )
    return {
        "sampleCount": len(test_samples),
        "maximumAbsoluteError": maximum,
        "toleranceExclusive": tolerance,
        "passed": True,
    }


def train_and_export(
    samples: Sequence[TrainingSample],
    output_directory: str | Path,
    config: TrainingConfig = TrainingConfig(),
    *,
    training_data_through_at: str,
    generated_at: str | None = None,
    input_file_sha256: str | None = None,
) -> TrainingResult:
    if config.initial_training_size < 2:
        raise TrainingError("initial_training_size must be at least 2")
    if len(samples) <= config.initial_training_size:
        raise TrainingError(
            f"dataset requires more than {config.initial_training_size} samples for walk-forward"
        )
    _validate_training_cutoff(samples, training_data_through_at)
    output = Path(output_directory).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        baseline, candidate, predictions = _walk_forward(samples, config)
        accepted, rejection_reasons, gate = _gate(samples, baseline, candidate, config)
        baseline_metrics = regression_metrics(baseline)
        candidate_metrics = regression_metrics(candidate)
        evaluation = {
            "evaluationVersion": "race-residual-walk-forward-v1",
            "status": "accepted" if accepted else "rejected",
            "rejectionReasons": rejection_reasons,
            "walkForward": {
                "method": "expanding_window",
                "futureLeakagePolicy": "sample i is predicted using samples [0,i)",
                "baselineMetrics": baseline_metrics.to_dict(),
                "candidateMetrics": candidate_metrics.to_dict(),
                "baselineByDistance": _metrics_by_distance(baseline),
                "candidateByDistance": _metrics_by_distance(candidate),
                "predictions": predictions,
            },
            "activationGate": gate,
        }
        final_model = _fit(samples)
        model_path = temporary / "model.onnx"
        input_name, output_name = _export_onnx(final_model, model_path)
        parity = _onnx_parity(
            final_model,
            model_path,
            input_name,
            output_name,
            samples,
            config.parity_tolerance,
        )
        evaluation["onnxParity"] = parity
        schema = feature_schema_document()
        schema["featureSchemaHash"] = feature_schema_sha256()
        _write_json(temporary / "feature-schema.json", schema)
        _write_json(temporary / "evaluation.json", evaluation)
        timestamp = generated_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        manifest = {
            "modelVersion": config.model_version,
            "algorithm": "catboost",
            "pythonRuntime": {
                "python": sys.version.split()[0],
                "packages": {
                    name: package_version(name)
                    for name in ("catboost", "numpy", "onnx", "onnxruntime")
                },
            },
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
            "featureSchemaHash": feature_schema_sha256(),
            "trainingDataHash": dataset_sha256(samples),
            "trainingDataThroughAt": training_data_through_at,
            "inputFileSha256": input_file_sha256,
            "modelSha256": _sha256(model_path),
            "labelCount": len(samples),
            "supportedDistances": list(DISTANCES),
            "featureNames": list(FEATURE_NAMES),
            "inputName": input_name,
            "outputName": output_name,
            "correctionCapFraction": config.correction_cap_fraction,
            "metrics": {
                "baseline": baseline_metrics.to_dict(),
                "candidate": candidate_metrics.to_dict(),
                "byDistance": {
                    "baseline": _metrics_by_distance(baseline),
                    "candidate": _metrics_by_distance(candidate),
                },
                "meanAbsoluteErrorImprovement": gate["meanAbsoluteErrorImprovement"],
                "intervalCoverageDrop": gate["intervalCoverageDrop"],
            },
            "generatedAt": timestamp,
            "status": "accepted" if accepted else "rejected",
            "catBoostParameters": CATBOOST_PARAMETERS,
            "onnxParity": parity,
            "artifactFiles": {
                "model.onnx": _sha256(model_path),
                "feature-schema.json": _sha256(temporary / "feature-schema.json"),
                "evaluation.json": _sha256(temporary / "evaluation.json"),
            },
        }
        _write_json(temporary / "manifest.json", manifest)
        if output.exists():
            raise TrainingError(f"output directory already exists: {output}")
        os.replace(temporary, output)
        return TrainingResult(
            status=manifest["status"],
            output_directory=output,
            manifest=manifest,
            evaluation=evaluation,
        )
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
