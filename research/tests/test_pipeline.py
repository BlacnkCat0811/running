from __future__ import annotations

import math

import pytest

from rai_ml.contract import BASE_FEATURE_NAMES, FEATURE_NAMES, TrainingSample
from rai_ml.metrics import PredictionResult
from rai_ml.pipeline import (
    TrainingConfig,
    TrainingError,
    _adjusted_prediction,
    _bootstrap_improvement_interval,
    _event_key,
    _gate,
    _release_split,
    _release_gate,
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
        label_available_at=f"2026-01-{index + 1:02d}T00:30:00Z",
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
            "label_available_at": "2026-01-03T00:00:00Z",
        }
    )
    completed = TrainingSample(
        **{
            **first.__dict__,
            "sample_id": "completed",
            "observed_at": "2026-01-01T01:00:00Z",
            "completed_at": "2026-01-01T02:00:00Z",
            "label_available_at": "2026-01-01T02:00:00Z",
        }
    )
    target = TrainingSample(
        **{
            **first.__dict__,
            "sample_id": "target",
            "observed_at": "2026-01-02T00:00:00Z",
            "completed_at": "2026-01-02T00:30:00Z",
            "label_available_at": "2026-01-02T00:30:00Z",
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


def test_training_cutoff_rejects_labels_not_yet_available():
    value = sample(0)
    with pytest.raises(TrainingError, match="unavailable"):
        _validate_training_cutoff([value], "2026-01-01T00:15:00Z")
    _validate_training_cutoff([value], value.completed_at)


def test_walk_forward_excludes_a_completed_race_labeled_later(monkeypatch):
    class ZeroModel:
        def predict(self, matrix):
            return [0.0] * len(matrix)

    monkeypatch.setattr("rai_ml.pipeline._fit", lambda rows: ZeroModel())
    prior = TrainingSample(**{
        **sample(0).__dict__,
        "label_available_at": "2026-01-03T00:00:00Z",
    })
    target = sample(1)
    _, candidate, predictions = _walk_forward(
        [prior, target], TrainingConfig(initial_training_size=1)
    )
    assert candidate == []
    assert predictions == []


def test_activation_gate_enforces_distribution_and_improvement():
    distances = ["five_k", "ten_k", "half_marathon"]
    samples = [sample(i, distances[i % 3]) for i in range(51)]
    baseline = [prediction(distances[i % 3], 1000, 1100) for i in range(24)]
    candidate = [prediction(distances[i % 3], 1000, 1050) for i in range(24)]
    accepted, reasons, details = _gate(samples, baseline, candidate, TrainingConfig())
    assert accepted
    assert reasons == []
    assert details["meanAbsoluteErrorImprovement"] == pytest.approx(0.5)


def test_activation_gate_rejects_distance_regression():
    distances = ["five_k", "ten_k", "half_marathon"]
    samples = [sample(i, distances[i % 3]) for i in range(51)]
    baseline = [prediction(distances[i % 3], 1000, 1100) for i in range(24)]
    candidate = [
        prediction(distance, 1000, 1200 if distance == "ten_k" else 1020)
        for distance in [distances[i % 3] for i in range(24)]
    ]
    accepted, reasons, _ = _gate(samples, baseline, candidate, TrainingConfig())
    assert not accepted
    assert "distance_mae_regression:ten_k" in reasons


def test_feature_contract_has_expected_onnx_width():
    assert len(FEATURE_NAMES) == 26


def test_release_split_keeps_events_atomic_and_applies_label_embargo():
    rows = [sample(index, ["five_k", "ten_k", "half_marathon"][index % 3]) for index in range(15)]
    overlapping = TrainingSample(**{
        **rows[5].__dict__,
        "sample_id": "late-label",
        "completed_at": "2026-01-11T23:30:00Z",
        "label_available_at": "2026-01-11T23:30:00Z",
    })
    rows.append(overlapping)
    training, holdout, details = _release_split(rows, TrainingConfig(
        minimum_training_labels=6,
        minimum_training_labels_per_distance=1,
        minimum_release_holdout=6,
        minimum_release_holdout_per_distance=2,
        release_embargo_hours=24,
    ))
    assert len(holdout) == 6
    assert "late-label" not in {row.sample_id for row in training}
    assert not ({row.sample_id for row in training} & {row.sample_id for row in holdout})
    assert details["embargoHours"] == 24
    assert details["trainingDataHash"] != details["holdoutDataHash"]


def test_release_split_groups_equivalent_timezone_representations_as_one_event():
    distances = ["five_k", "ten_k", "half_marathon"]
    rows = [sample(index, distances[index % 3]) for index in range(15)]
    equivalent = TrainingSample(**{
        **rows[9].__dict__,
        "sample_id": "same-event-offset",
        "observed_at": "2026-01-10T08:00:00+08:00",
        "completed_at": "2026-01-10T08:30:00+08:00",
        "label_available_at": "2026-01-10T08:30:00+08:00",
    })
    rows.append(equivalent)
    training, holdout, _ = _release_split(rows, TrainingConfig(
        minimum_training_labels=6,
        minimum_training_labels_per_distance=1,
        minimum_release_holdout=6,
        minimum_release_holdout_per_distance=1,
        release_embargo_hours=24,
    ))
    training_ids = {row.sample_id for row in training}
    holdout_ids = {row.sample_id for row in holdout}
    assert {rows[9].sample_id, equivalent.sample_id} <= holdout_ids
    assert rows[9].sample_id not in training_ids
    assert equivalent.sample_id not in training_ids


def test_event_key_preserves_microseconds_while_normalizing_timezone_offsets():
    original = sample(0)
    first = TrainingSample(**{
        **original.__dict__,
        "observed_at": "2026-01-01T00:00:00.000100Z",
    })
    equivalent = TrainingSample(**{
        **original.__dict__,
        "observed_at": "2026-01-01T08:00:00.000100+08:00",
    })
    distinct = TrainingSample(**{
        **original.__dict__,
        "observed_at": "2026-01-01T00:00:00.000900Z",
    })
    assert _event_key(first) == _event_key(equivalent)
    assert _event_key(first) != _event_key(distinct)


def test_release_gate_requires_positive_paired_bootstrap_confidence():
    distances = ["five_k", "ten_k", "half_marathon"]
    rows = [sample(index, distances[index % 3]) for index in range(6)]
    baseline = [prediction(row.distance, 1000, 1100) for row in rows]
    improved = [prediction(row.distance, 1000, 1040) for row in rows]
    config = TrainingConfig(
        minimum_release_holdout=6,
        minimum_release_holdout_per_distance=2,
        bootstrap_iterations=200,
        bootstrap_block_events=1,
        minimum_bootstrap_blocks=6,
    )
    accepted, reasons, details = _release_gate(baseline, improved, rows, config)
    assert accepted
    assert reasons == []
    assert details["maeImprovementBootstrap95"]["lower"] > 0
    assert details["maeImprovementBootstrap95"]["method"] == (
        "non_overlapping_temporal_event_block_v1"
    )
    assert details["maeImprovementBootstrap95"]["effectiveBlocks"] == 6

    unstable = [
        prediction(row.distance, 1000, 1000 if index % 2 == 0 else 1200)
        for index, row in enumerate(rows)
    ]
    accepted, reasons, _ = _release_gate(baseline, unstable, rows, config)
    assert not accepted
    assert "release_mae_improvement_confidence_not_positive" in reasons


def test_release_gate_requires_enough_independent_temporal_blocks():
    distances = ["five_k", "ten_k", "half_marathon"]
    rows = [sample(index, distances[index % 3]) for index in range(6)]
    baseline = [prediction(row.distance, 1000, 1100) for row in rows]
    improved = [prediction(row.distance, 1000, 1040) for row in rows]
    accepted, reasons, details = _release_gate(
        baseline,
        improved,
        rows,
        TrainingConfig(
            minimum_release_holdout=6,
            minimum_release_holdout_per_distance=2,
            bootstrap_iterations=50,
            bootstrap_block_events=3,
            minimum_bootstrap_blocks=3,
        ),
    )
    assert not accepted
    assert "release_temporal_blocks_below_minimum" in reasons
    assert details["maeImprovementBootstrap95"]["lower"] is None
    assert details["maeImprovementBootstrap95"]["effectiveBlocks"] == 2


def test_temporal_bootstrap_does_not_double_count_equivalent_timezone_events():
    rows = []
    for index in range(3):
        original = sample(index)
        rows.extend([
            original,
            TrainingSample(**{
                **original.__dict__,
                "sample_id": f"offset-{index}",
                "observed_at": f"2026-01-{index + 1:02d}T08:00:00+08:00",
                "completed_at": f"2026-01-{index + 1:02d}T08:30:00+08:00",
                "label_available_at": f"2026-01-{index + 1:02d}T08:30:00+08:00",
            }),
        ])
    baseline = [prediction("five_k", 1000, 1100) for _ in rows]
    candidate = [prediction("five_k", 1000, 1040) for _ in rows]
    lower, upper, effective_blocks = _bootstrap_improvement_interval(
        baseline, candidate, rows, 50, 1, 6
    )
    assert effective_blocks == 3
    assert lower is None
    assert upper is None
