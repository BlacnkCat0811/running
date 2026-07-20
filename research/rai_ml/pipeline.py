from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Final, Sequence

import numpy as np
import sys
from importlib.metadata import version as package_version

from .contract import (
    BASE_FEATURE_NAMES,
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
    model_version: str = "race-residual-catboost-v3"
    minimum_labels: int = 50
    minimum_labels_per_distance: int = 8
    initial_training_size: int = 12
    minimum_walk_forward_predictions: int = 12
    minimum_walk_forward_per_distance: int = 3
    minimum_training_labels: int = 24
    minimum_training_labels_per_distance: int = 4
    minimum_release_holdout: int = 24
    minimum_release_holdout_per_distance: int = 6
    release_embargo_hours: int = 24
    bootstrap_iterations: int = 2000
    bootstrap_block_events: int = 3
    minimum_bootstrap_blocks: int = 6
    minimum_mae_improvement: float = 0.05
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


def _event_key(sample: TrainingSample) -> tuple[datetime, datetime]:
    return (_instant(sample.observed_at), _instant(sample.completed_at))


def _validate_training_cutoff(
    samples: Sequence[TrainingSample], training_data_through_at: str
) -> None:
    cutoff = _instant(training_data_through_at)
    future = [sample.sample_id for sample in samples if _instant(sample.label_available_at) > cutoff]
    if future:
        preview = ", ".join(future[:3])
        raise TrainingError(
            "training labels unavailable at training_data_through_at: " + preview
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


def _release_split(
    samples: Sequence[TrainingSample], config: TrainingConfig
) -> tuple[list[TrainingSample], list[TrainingSample], dict[str, Any]]:
    ordered = sorted(samples, key=lambda row: (_instant(row.observed_at), row.sample_id))
    grouped: dict[tuple[datetime, datetime], list[TrainingSample]] = {}
    for sample in ordered:
        event_key = _event_key(sample)
        grouped.setdefault(event_key, []).append(sample)
    groups = [grouped[key] for key in sorted(grouped)]
    holdout: list[TrainingSample] = []
    split_index = len(groups)
    for index in range(len(groups) - 1, -1, -1):
        holdout = groups[index] + holdout
        counts = {distance: sum(row.distance == distance for row in holdout) for distance in DISTANCES}
        if (
            len(holdout) >= config.minimum_release_holdout
            and all(value >= config.minimum_release_holdout_per_distance for value in counts.values())
        ):
            split_index = index
            break
    if split_index == len(groups):
        raise TrainingError("release holdout does not satisfy total and per-distance minimums")
    holdout_start = min(_instant(row.observed_at) for row in holdout)
    label_cutoff = holdout_start - timedelta(hours=config.release_embargo_hours)
    training = [
        row for group in groups[:split_index] for row in group
        if _instant(row.label_available_at) <= label_cutoff
    ]
    training_counts = {distance: sum(row.distance == distance for row in training) for distance in DISTANCES}
    if (
        len(training) < config.minimum_training_labels
        or any(value < config.minimum_training_labels_per_distance for value in training_counts.values())
    ):
        raise TrainingError("release training split does not satisfy total and per-distance minimums")
    training_ids = {row.sample_id for row in training}
    holdout_ids = {row.sample_id for row in holdout}
    if training_ids & holdout_ids:
        raise TrainingError("release training and holdout samples overlap")
    return training, holdout, {
        "method": "temporal_event_grouped_holdout_v1",
        "eventGrouping": ["observedAt", "completedAt"],
        "embargoHours": config.release_embargo_hours,
        "holdoutStartsAt": holdout_start.isoformat(),
        "trainingLabelAvailabilityCutoff": label_cutoff.isoformat(),
        "trainingSampleIds": [row.sample_id for row in training],
        "holdoutSampleIds": [row.sample_id for row in holdout],
        "trainingDataHash": dataset_sha256(training),
        "holdoutDataHash": dataset_sha256(holdout),
        "trainingCount": len(training),
        "holdoutCount": len(holdout),
        "trainingCountByDistance": training_counts,
        "holdoutCountByDistance": {
            distance: sum(row.distance == distance for row in holdout) for distance in DISTANCES
        },
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
            if _instant(prior.label_available_at) <= observed
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
                    prior.label_available_at for prior in training_samples
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
    if len(samples) < config.minimum_training_labels:
        reasons.append("insufficient_total_labels")
    if any(value < config.minimum_training_labels_per_distance for value in counts.values()):
        reasons.append("insufficient_labels_per_distance")
    if len(candidate) < config.minimum_walk_forward_predictions:
        reasons.append("insufficient_walk_forward_predictions")
    if any(value < config.minimum_walk_forward_per_distance for value in holdout_counts.values()):
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
            "minimumLabels": config.minimum_training_labels,
            "minimumLabelsPerDistance": config.minimum_training_labels_per_distance,
            "initialTrainingSize": config.initial_training_size,
            "minimumWalkForwardPredictions": config.minimum_walk_forward_predictions,
            "minimumWalkForwardPerDistance": config.minimum_walk_forward_per_distance,
            "minimumMaeImprovement": config.minimum_mae_improvement,
            "maximumDistanceRegression": config.maximum_distance_regression,
            "maximumCoverageDrop": config.maximum_coverage_drop,
        },
    }
    return not reasons, reasons, details


def _bootstrap_improvement_interval(
    baseline: Sequence[PredictionResult], candidate: Sequence[PredictionResult],
    samples: Sequence[TrainingSample], iterations: int, block_events: int,
    minimum_blocks: int,
) -> tuple[float | None, float | None, int]:
    baseline_errors = np.asarray(
        [abs(row.predicted_seconds - row.actual_seconds) for row in baseline], dtype=np.float64
    )
    candidate_errors = np.asarray(
        [abs(row.predicted_seconds - row.actual_seconds) for row in candidate], dtype=np.float64
    )
    if len(baseline_errors) == 0 or len(baseline_errors) != len(candidate_errors):
        raise TrainingError("release holdout errors are unavailable")
    if block_events < 1 or minimum_blocks < 2:
        raise TrainingError("temporal bootstrap block settings are invalid")
    grouped_indices: dict[tuple[datetime, datetime], list[int]] = {}
    for index, sample in enumerate(samples):
        grouped_indices.setdefault(_event_key(sample), []).append(index)
    event_groups = list(grouped_indices.values())
    blocks = [
        [index for group in event_groups[start:start + block_events] for index in group]
        for start in range(0, len(event_groups), block_events)
    ]
    if len(blocks) < minimum_blocks:
        return None, None, len(blocks)
    random = np.random.default_rng(20260717)
    estimates = []
    for _ in range(iterations):
        sampled_blocks = random.integers(0, len(blocks), len(blocks))
        indices = np.asarray(
            [index for block_index in sampled_blocks for index in blocks[int(block_index)]],
            dtype=np.int64,
        )
        baseline_mae = float(np.mean(baseline_errors[indices]))
        candidate_mae = float(np.mean(candidate_errors[indices]))
        estimates.append(
            0.0 if baseline_mae == 0 and candidate_mae == 0
            else -1.0 if baseline_mae == 0
            else 1 - candidate_mae / baseline_mae
        )
    return (
        float(np.quantile(estimates, 0.025)),
        float(np.quantile(estimates, 0.975)),
        len(blocks),
    )


def _release_gate(
    baseline: Sequence[PredictionResult], candidate: Sequence[PredictionResult],
    samples: Sequence[TrainingSample], config: TrainingConfig
) -> tuple[bool, list[str], dict[str, Any]]:
    reasons: list[str] = []
    baseline_metrics = regression_metrics(baseline)
    candidate_metrics = regression_metrics(candidate)
    baseline_mae = baseline_metrics.meanAbsoluteErrorSeconds
    candidate_mae = candidate_metrics.meanAbsoluteErrorSeconds
    improvement = None if baseline_mae in (None, 0) or candidate_mae is None else 1 - candidate_mae / baseline_mae
    lower, upper, effective_blocks = _bootstrap_improvement_interval(
        baseline, candidate, samples, config.bootstrap_iterations,
        config.bootstrap_block_events, config.minimum_bootstrap_blocks,
    )
    counts = {distance: sum(row.distance == distance for row in candidate) for distance in DISTANCES}
    if len(candidate) < config.minimum_release_holdout:
        reasons.append("release_holdout_below_minimum")
    if any(value < config.minimum_release_holdout_per_distance for value in counts.values()):
        reasons.append("release_holdout_per_distance_below_minimum")
    if improvement is None or improvement < config.minimum_mae_improvement:
        reasons.append("release_mae_improvement_below_threshold")
    if effective_blocks < config.minimum_bootstrap_blocks:
        reasons.append("release_temporal_blocks_below_minimum")
    elif lower is None or lower <= 0:
        reasons.append("release_mae_improvement_confidence_not_positive")
    distance_regressions: dict[str, float | None] = {}
    for distance in DISTANCES:
        base = regression_metrics(row for row in baseline if row.distance == distance)
        model = regression_metrics(row for row in candidate if row.distance == distance)
        regression = None if base.meanAbsoluteErrorSeconds in (None, 0) or model.meanAbsoluteErrorSeconds is None else model.meanAbsoluteErrorSeconds / base.meanAbsoluteErrorSeconds - 1
        distance_regressions[distance] = regression
        if regression is None or regression > config.maximum_distance_regression:
            reasons.append(f"release_distance_mae_regression:{distance}")
    coverage_drop = None if baseline_metrics.intervalCoverage is None or candidate_metrics.intervalCoverage is None else baseline_metrics.intervalCoverage - candidate_metrics.intervalCoverage
    if coverage_drop is None or coverage_drop > config.maximum_coverage_drop:
        reasons.append("release_interval_coverage_drop_above_threshold")
    return not reasons, reasons, {
        "baselineMetrics": baseline_metrics.to_dict(),
        "candidateMetrics": candidate_metrics.to_dict(),
        "baselineByDistance": _metrics_by_distance(baseline),
        "candidateByDistance": _metrics_by_distance(candidate),
        "meanAbsoluteErrorImprovement": improvement,
        "maeImprovementBootstrap95": {
            "method": "non_overlapping_temporal_event_block_v1",
            "lower": lower,
            "upper": upper,
            "iterations": config.bootstrap_iterations,
            "blockEvents": config.bootstrap_block_events,
            "effectiveBlocks": effective_blocks,
        },
        "distanceMaeRegression": distance_regressions,
        "intervalCoverageDrop": coverage_drop,
        "thresholds": {
            "minimumHoldout": config.minimum_release_holdout,
            "minimumHoldoutPerDistance": config.minimum_release_holdout_per_distance,
            "minimumMaeImprovement": config.minimum_mae_improvement,
            "maximumDistanceRegression": config.maximum_distance_regression,
            "maximumCoverageDrop": config.maximum_coverage_drop,
            "requirePositiveBootstrapLowerBound": True,
            "minimumBootstrapBlocks": config.minimum_bootstrap_blocks,
        },
    }


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
            "onnx_model_version": 2,
            "onnx_doc_string": "RAI CatBoost race residual targetLogResidual",
            "onnx_graph_name": "rai_race_residual_catboost_v3",
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


def _golden_vectors(model: Any, samples: Sequence[TrainingSample], cap: float) -> dict[str, Any]:
    predictions = np.asarray(model.predict(_matrix(samples)), dtype=np.float32).reshape(-1)
    vectors = []
    for sample, raw in zip(samples, predictions, strict=True):
        flags = {
            "isFiveK": 1.0 if sample.distance == "five_k" else 0.0,
            "isTenK": 1.0 if sample.distance == "ten_k" else 0.0,
            "isHalfMarathon": 1.0 if sample.distance == "half_marathon" else 0.0,
        }
        features = {name: sample.features.get(name) for name in BASE_FEATURE_NAMES}
        features.update(flags)
        target = float(raw)
        vectors.append({
            "sampleId": sample.sample_id,
            "distance": sample.distance,
            "features": features,
            "targetLogResidual": target,
            "correctionFraction": _clamp(math.exp(target) - 1, -cap, cap),
            "actualSeconds": sample.actual_seconds,
            "baselinePredictedSeconds": sample.baseline_predicted_seconds,
            "baselineOptimisticSeconds": sample.baseline_optimistic_seconds,
            "baselinePessimisticSeconds": sample.baseline_pessimistic_seconds,
        })
    return {"toleranceExclusive": 1e-6, "scope": "release_holdout", "vectors": vectors}


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
    if len(samples) < config.minimum_labels:
        raise TrainingError(
            f"dataset requires at least {config.minimum_labels} samples"
        )
    _validate_training_cutoff(samples, training_data_through_at)
    output = Path(output_directory).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        training, holdout, split = _release_split(samples, config)
        baseline, candidate, predictions = _walk_forward(training, config)
        algorithm_accepted, algorithm_reasons, gate = _gate(training, baseline, candidate, config)
        baseline_metrics = regression_metrics(baseline)
        candidate_metrics = regression_metrics(candidate)
        release_model = _fit(training)
        release_raw = np.asarray(
            release_model.predict(_matrix(holdout)), dtype=np.float32
        ).reshape(-1)
        release_baseline = [_baseline_prediction(sample) for sample in holdout]
        release_candidate = [
            _adjusted_prediction(sample, float(raw), config.correction_cap_fraction)
            for sample, raw in zip(holdout, release_raw, strict=True)
        ]
        release_accepted, release_reasons, release_gate = _release_gate(
            release_baseline, release_candidate, holdout, config
        )
        accepted = algorithm_accepted and release_accepted
        rejection_reasons = algorithm_reasons + release_reasons
        model_path = temporary / "model.onnx"
        input_name, output_name = _export_onnx(release_model, model_path)
        model_sha256 = _sha256(model_path)
        parity = _onnx_parity(
            release_model, model_path, input_name, output_name, holdout, config.parity_tolerance
        )
        evaluation = {
            "evaluationVersion": "race-residual-temporal-release-v1",
            "status": "accepted" if accepted else "rejected",
            "rejectionReasons": rejection_reasons,
            "releaseSplit": split,
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
            "releaseHoldout": release_gate,
            "publishedArtifact": {
                "fitStrategy": "training_partition_only",
                "generalizationMetricsSource": "temporal_release_holdout",
                "directGeneralizationMetric": True,
                "numericParityFixture": "onnx-golden.json",
                "evaluatedArtifactSha256": model_sha256,
            },
            "onnxParity": parity,
        }
        _write_json(
            temporary / "onnx-golden.json",
            _golden_vectors(release_model, holdout, config.correction_cap_fraction),
        )
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
            "trainingDataHash": dataset_sha256(training),
            "holdoutDataHash": dataset_sha256(holdout),
            "trainingDataThroughAt": training_data_through_at,
            "inputFileSha256": input_file_sha256,
            "modelSha256": model_sha256,
            "labelCount": len(training),
            "supportedDistances": list(DISTANCES),
            "featureNames": list(FEATURE_NAMES),
            "inputName": input_name,
            "outputName": output_name,
            "correctionCapFraction": config.correction_cap_fraction,
            "metrics": {
                "baseline": release_gate["baselineMetrics"],
                "candidate": release_gate["candidateMetrics"],
                "byDistance": {
                    "baseline": release_gate["baselineByDistance"],
                    "candidate": release_gate["candidateByDistance"],
                },
                "meanAbsoluteErrorImprovement": release_gate["meanAbsoluteErrorImprovement"],
                "intervalCoverageDrop": release_gate["intervalCoverageDrop"],
            },
            "generatedAt": timestamp,
            "status": "accepted" if accepted else "rejected",
            "catBoostParameters": CATBOOST_PARAMETERS,
            "onnxParity": parity,
            "artifactFiles": {
                "model.onnx": _sha256(model_path),
                "feature-schema.json": _sha256(temporary / "feature-schema.json"),
                "evaluation.json": _sha256(temporary / "evaluation.json"),
                "onnx-golden.json": _sha256(temporary / "onnx-golden.json"),
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
