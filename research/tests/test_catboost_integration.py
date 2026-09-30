from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timedelta, timezone

import pytest

pytest.importorskip("catboost")
pytest.importorskip("onnxruntime")

from rai_ml.contract import BASE_FEATURE_NAMES, FEATURE_NAMES, TrainingSample
from rai_ml.pipeline import train_and_export


def samples() -> list[TrainingSample]:
    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    distances = ("five_k", "ten_k", "half_marathon")
    result = []
    for index in range(51):
        distance = distances[index % len(distances)]
        baseline = {"five_k": 1_500.0, "ten_k": 3_150.0, "half_marathon": 7_200.0}[distance]
        readiness = 0.35 + (index % 10) * 0.055
        residual = 0.10 * (0.75 - readiness) + {"five_k": -0.01, "ten_k": 0.0, "half_marathon": 0.015}[distance]
        observed = start + timedelta(days=index * 7)
        features = {name: float((index % 5) + 1) for name in BASE_FEATURE_NAMES}
        features.update(
            {
                "logPredictedSeconds": math.log(baseline),
                "readiness": readiness,
                "conditionAdjustmentFraction": 0.01,
                "performanceVdot": 40 + index % 4,
                "vo2Max": 43 + index % 3,
                "vo2Gap": 2.0,
                "lactateThresholdConfidence": 0.6,
                "recoveryReadiness": 0.8,
                "overallDataQuality": 0.9,
            }
        )
        result.append(
            TrainingSample(
                sample_id=f"sample-{index:03d}",
                observed_at=observed.isoformat(),
                completed_at=(observed + timedelta(minutes=30)).isoformat(),
                label_available_at=(observed + timedelta(minutes=30)).isoformat(),
                distance=distance,
                baseline_predicted_seconds=baseline,
                baseline_optimistic_seconds=baseline * 0.85,
                baseline_pessimistic_seconds=baseline * 1.2,
                actual_seconds=baseline * math.exp(residual),
                features=features,
            )
        )
    return result


def test_real_catboost_walk_forward_and_onnx_export_are_deterministic(tmp_path):
    generated_at = "2026-07-11T00:00:00Z"
    input_hash = "d" * 64
    first = train_and_export(
        samples(), tmp_path / "first", training_data_through_at=generated_at,
        generated_at=generated_at,
        input_file_sha256=input_hash,
    )
    second = train_and_export(
        samples(), tmp_path / "second", training_data_through_at=generated_at,
        generated_at=generated_at,
        input_file_sha256=input_hash,
    )
    # This synthetic constant-residual cohort is solved by the simple Ridge
    # challenger. Deterministic export does not justify activating a more complex model.
    assert first.status == "rejected"
    assert first.evaluation["ridgeChallenger"]["status"] == "failed"
    assert any(reason.startswith("ridge:") for reason in first.evaluation["rejectionReasons"])
    assert second.status == first.status
    assert first.manifest["modelSha256"] == second.manifest["modelSha256"]
    assert first.manifest["artifactFiles"] == second.manifest["artifactFiles"]
    assert first.manifest["inputFileSha256"] == input_hash
    assert first.manifest["algorithm"] == "catboost"
    assert first.manifest["featureNames"] == list(FEATURE_NAMES)
    assert first.manifest["correctionCapFraction"] == 0.12
    assert first.manifest["onnxParity"]["passed"] is True
    assert first.manifest["onnxParity"]["maximumAbsoluteError"] < 1e-6
    for name in ("model.onnx", "manifest.json", "feature-schema.json", "evaluation.json", "onnx-golden.json"):
        assert (tmp_path / "first" / name).is_file()
    model_hash = hashlib.sha256((tmp_path / "first" / "model.onnx").read_bytes()).hexdigest()
    assert model_hash == first.manifest["modelSha256"]
    for name, expected_hash in first.manifest["artifactFiles"].items():
        actual_hash = hashlib.sha256((tmp_path / "first" / name).read_bytes()).hexdigest()
        assert actual_hash == expected_hash
    evaluation = json.loads((tmp_path / "first" / "evaluation.json").read_text("utf-8"))
    assert evaluation["walkForward"]["method"] == "expanding_window"
    assert evaluation["releaseSplit"]["trainingCount"] == 27
    assert evaluation["releaseSplit"]["holdoutCount"] == 24
    assert evaluation["activationGate"]["holdoutCount"] == 15
    assert evaluation["releaseHoldout"]["candidateMetrics"]["sampleCount"] == 24
    assert evaluation["releaseHoldout"]["maeImprovementBootstrap95"]["lower"] > 0
    assert evaluation["publishedArtifact"] == {
        "directGeneralizationMetric": True,
        "evaluatedArtifactSha256": first.manifest["modelSha256"],
        "fitStrategy": "training_partition_only",
        "generalizationMetricsSource": "temporal_release_holdout",
        "numericParityFixture": "onnx-golden.json",
    }
