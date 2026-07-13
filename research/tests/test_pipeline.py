from __future__ import annotations

import math

import pytest

from rai_ml.contract import BASE_FEATURE_NAMES, FEATURE_NAMES, TrainingSample
from rai_ml.metrics import PredictionResult
from rai_ml.pipeline import (
    TrainingConfig,
    TrainingError,
    _adjusted_prediction,
    _gate,
    _validate_training_cutoff,
    _walk_forward,
)


def sample(index: int, distance: str = "five_k") -> TrainingSample:
    baseline = 1000.0
    features = {name: 1.0 for name in BASE_FEATURE_NAMES}
    features["logPredictedSeconds"] = math.log(baseline)
    return TrainingSample(
        sample_id=f"sample-{index:03d}",
        observed_at=f"2026-01-{index + 1:02d}T00:00:00Z",
        completed_at=f"2026-01-{index + 1:02d}T00:30:00Z",
        distance=distance,
        baseline_predicted_seconds=baseline,
        baseline_optimistic_seconds=900,
        baseline_pessimistic_seconds=1200,
        actual_seconds=1100,
        features=features,
    )


def prediction(distance: str, actual: float, predicted: float) -> PredictionResult:
    return PredictionResult(distance, actual, predicted, predicted - 150, predicted + 150)


def test_correction_is_capped_at_twelve_percent():
    value = _adjusted_prediction(sample(0), math.log(2), 0.12)
    assert value.predicted_seconds == pytest.approx(1120)
    assert value.optimistic_seconds == pytest.approx(1008)
    assert value.pessimistic_seconds == pytest.approx(1344)
    value = _adjusted_prediction(sample(0), math.log(0.2), 0.12)
    assert value.predicted_seconds == pytest.approx(880)
    assert value.optimistic_seconds == pytest.approx(792)
    assert value.pessimistic_seconds == pytest.approx(1056)


def test_walk_forward_uses_only_labels_completed_before_prediction(monkeypatch):
    class ZeroModel:
        def predict(self, matrix):
            return [0.0] * len(matrix)

    monkeypatch.setattr("rai_ml.pipeline._fit", lambda rows: ZeroModel())
    first = sample(0)
    overlapping = TrainingSample(
        **{
            **first.__dict__,
            "sample_id": "overlapping",
            "observed_at": "2026-01-01T00:00:00Z",
            "completed_at": "2026-01-03T00:00:00Z",
        }
    )
    completed = TrainingSample(
        **{
            **first.__dict__,
            "sample_id": "completed",
            "observed_at": "2026-01-01T01:00:00Z",
            "completed_at": "2026-01-01T02:00:00Z",
        }
    )
    target = TrainingSample(
        **{
            **first.__dict__,
            "sample_id": "target",
            "observed_at": "2026-01-02T00:00:00Z",
            "completed_at": "2026-01-02T00:30:00Z",
        }
    )
    _, candidate, predictions = _walk_forward(
        [overlapping, completed, target],
        TrainingConfig(initial_training_size=1),
    )
    assert len(candidate) == 1
    assert predictions[0]["sampleId"] == "target"
    assert predictions[0]["trainingLabelCount"] == 1
    assert predictions[0]["trainingDataThroughAt"] == completed.completed_at


def test_training_cutoff_rejects_labels_not_yet_completed():
    value = sample(0)
    with pytest.raises(TrainingError, match="completed after"):
        _validate_training_cutoff([value], "2026-01-01T00:15:00Z")
    _validate_training_cutoff([value], value.completed_at)


def test_activation_gate_enforces_distribution_and_improvement():
    distances = ["five_k", "ten_k", "half_marathon"]
    samples = [sample(i, distances[i % 3]) for i in range(51)]
    baseline = [prediction(distances[i % 3], 1000, 1100) for i in range(18)]
    candidate = [prediction(distances[i % 3], 1000, 1050) for i in range(18)]
    accepted, reasons, details = _gate(samples, baseline, candidate, TrainingConfig())
    assert accepted
    assert reasons == []
    assert details["meanAbsoluteErrorImprovement"] == pytest.approx(0.5)


def test_activation_gate_rejects_distance_regression():
    distances = ["five_k", "ten_k", "half_marathon"]
    samples = [sample(i, distances[i % 3]) for i in range(51)]
    baseline = [prediction(distances[i % 3], 1000, 1100) for i in range(18)]
    candidate = [
        prediction(distance, 1000, 1200 if distance == "ten_k" else 1020)
        for distance in [distances[i % 3] for i in range(18)]
    ]
    accepted, reasons, _ = _gate(samples, baseline, candidate, TrainingConfig())
    assert not accepted
    assert "distance_mae_regression:ten_k" in reasons


def test_feature_contract_has_expected_onnx_width():
    assert len(FEATURE_NAMES) == 26
