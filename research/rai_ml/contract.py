from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Final, Iterable

FEATURE_SCHEMA_VERSION: Final = "race-residual-feature-v3"
DISTANCES: Final = ("five_k", "ten_k", "half_marathon")
ISO_INSTANT_PATTERN: Final = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)

# This order is the public ONNX input contract. Never reorder in-place: publish a
# new feature schema version instead.
BASE_FEATURE_NAMES: Final = (
    "logPredictedSeconds",
    "readiness",
    "conditionAdjustmentFraction",
    "performanceVdot",
    "vo2Max",
    "vo2Gap",
    "lactateThresholdPaceSecondsPerKm",
    "lactateThresholdConfidence",
    "recoveryReadiness",
    "weeklyDistance4wKm",
    "weeklyDistance8wKm",
    "longestRun8wKm",
    "runFrequency4wPerWeek",
    "targetDistanceExposure8w",
    "daysSinceLastRun",
    "acuteChronicLoadRatio",
    "temperatureC",
    "humidityPercent",
    "elevationGainMeters",
    "directVo2EvidenceCount",
    "thresholdEvidenceCount",
    "performanceVdotEvidenceCount",
    "overallDataQuality",
)
FEATURE_NAMES: Final = BASE_FEATURE_NAMES + (
    "isFiveK",
    "isTenK",
    "isHalfMarathon",
)


class ContractError(ValueError):
    """Raised when a training dataset violates the versioned contract."""


def _parse_iso8601(name: str, value: Any) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{name} must be a non-empty ISO 8601 string")
    if ISO_INSTANT_PATTERN.fullmatch(value) is None:
        raise ContractError(
            f"{name} must be a timezone-qualified ISO 8601 instant with at most 6 fractional digits"
        )
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ContractError(f"{name} must be a valid ISO 8601 date-time") from error
    return parsed


def _positive_number(name: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise ContractError(f"{name} must be finite and greater than zero")
    return result


def _optional_number(name: str, value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ContractError(f"{name} must be a number or null")
    result = float(value)
    if not math.isfinite(result):
        raise ContractError(f"{name} must be finite or null")
    return result


@dataclass(frozen=True)
class TrainingSample:
    sample_id: str
    observed_at: str
    completed_at: str
    label_available_at: str
    distance: str
    baseline_predicted_seconds: float
    baseline_optimistic_seconds: float | None
    baseline_pessimistic_seconds: float | None
    actual_seconds: float
    features: dict[str, float | None]

    @property
    def target_log_residual(self) -> float:
        return math.log(self.actual_seconds / self.baseline_predicted_seconds)

    def feature_row(self) -> list[float]:
        flags = {
            "isFiveK": 1.0 if self.distance == "five_k" else 0.0,
            "isTenK": 1.0 if self.distance == "ten_k" else 0.0,
            "isHalfMarathon": 1.0 if self.distance == "half_marathon" else 0.0,
        }
        return [
            math.nan if self.features.get(name) is None else float(self.features[name])
            for name in BASE_FEATURE_NAMES
        ] + [flags[name] for name in FEATURE_NAMES[len(BASE_FEATURE_NAMES) :]]


def parse_sample(raw: Any, line_number: int) -> TrainingSample:
    prefix = f"line {line_number}: "
    if not isinstance(raw, dict):
        raise ContractError(prefix + "sample must be an object")
    if raw.get("schemaVersion") != FEATURE_SCHEMA_VERSION:
        raise ContractError(
            prefix + f"schemaVersion must equal {FEATURE_SCHEMA_VERSION!r}"
        )
    sample_id = raw.get("sampleId")
    if not isinstance(sample_id, str) or not sample_id.strip():
        raise ContractError(prefix + "sampleId must be a non-empty string")
    distance = raw.get("distance")
    if distance not in DISTANCES:
        raise ContractError(prefix + f"distance must be one of {DISTANCES}")
    observed_at = raw.get("observedAt")
    completed_at = raw.get("completedAt")
    label_available_at = raw.get("labelAvailableAt")
    observed = _parse_iso8601(prefix + "observedAt", observed_at)
    completed = _parse_iso8601(prefix + "completedAt", completed_at)
    label_available = _parse_iso8601(prefix + "labelAvailableAt", label_available_at)
    if completed <= observed:
        raise ContractError(prefix + "completedAt must be later than observedAt")
    if label_available < completed:
        raise ContractError(prefix + "labelAvailableAt must not be earlier than completedAt")

    baseline = _positive_number(
        prefix + "baselinePredictedSeconds", raw.get("baselinePredictedSeconds")
    )
    actual = _positive_number(prefix + "actualSeconds", raw.get("actualSeconds"))
    optimistic = _optional_number(
        prefix + "baselineOptimisticSeconds", raw.get("baselineOptimisticSeconds")
    )
    pessimistic = _optional_number(
        prefix + "baselinePessimisticSeconds", raw.get("baselinePessimisticSeconds")
    )
    if optimistic is not None and optimistic <= 0:
        raise ContractError(prefix + "baselineOptimisticSeconds must be greater than zero")
    if pessimistic is not None and pessimistic <= 0:
        raise ContractError(prefix + "baselinePessimisticSeconds must be greater than zero")
    if optimistic is not None and pessimistic is not None:
        if not optimistic <= baseline <= pessimistic:
            raise ContractError(
                prefix + "prediction interval must contain baselinePredictedSeconds"
            )

    features_raw = raw.get("features")
    if not isinstance(features_raw, dict):
        raise ContractError(prefix + "features must be an object")
    unknown = sorted(set(features_raw) - set(BASE_FEATURE_NAMES))
    missing = sorted(set(BASE_FEATURE_NAMES) - set(features_raw))
    if unknown:
        raise ContractError(prefix + f"unknown feature fields: {', '.join(unknown)}")
    if missing:
        raise ContractError(prefix + f"missing feature fields: {', '.join(missing)}")
    features = {
        name: _optional_number(prefix + f"features.{name}", features_raw[name])
        for name in BASE_FEATURE_NAMES
    }
    log_prediction = features["logPredictedSeconds"]
    if log_prediction is None or abs(log_prediction - math.log(baseline)) > 1e-6:
        raise ContractError(
            prefix + "features.logPredictedSeconds must equal log(baselinePredictedSeconds)"
        )
    for bounded in (
        "readiness",
        "lactateThresholdConfidence",
        "recoveryReadiness",
        "overallDataQuality",
    ):
        value = features[bounded]
        if value is not None and not 0 <= value <= 1:
            raise ContractError(prefix + f"features.{bounded} must be between 0 and 1")
    return TrainingSample(
        sample_id=sample_id,
        observed_at=observed_at,
        completed_at=completed_at,
        label_available_at=label_available_at,
        distance=distance,
        baseline_predicted_seconds=baseline,
        baseline_optimistic_seconds=optimistic,
        baseline_pessimistic_seconds=pessimistic,
        actual_seconds=actual,
        features=features,
    )


def load_jsonl(path: str | Path) -> list[TrainingSample]:
    input_path = Path(path)
    samples: list[TrainingSample] = []
    seen_ids: set[str] = set()
    with input_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as error:
                raise ContractError(f"line {line_number}: invalid JSON: {error.msg}") from error
            sample = parse_sample(raw, line_number)
            if sample.sample_id in seen_ids:
                raise ContractError(f"line {line_number}: duplicate sampleId {sample.sample_id!r}")
            seen_ids.add(sample.sample_id)
            samples.append(sample)
    if not samples:
        raise ContractError("dataset must contain at least one sample")
    ordered = sorted(
        samples,
        key=lambda item: (_parse_iso8601("observedAt", item.observed_at), item.sample_id),
    )
    if [item.sample_id for item in samples] != [item.sample_id for item in ordered]:
        raise ContractError("samples must be ordered by observedAt, then sampleId")
    return samples


def canonical_dataset_bytes(samples: Iterable[TrainingSample]) -> bytes:
    rows = []
    for sample in samples:
        rows.append(
            {
                "schemaVersion": FEATURE_SCHEMA_VERSION,
                "sampleId": sample.sample_id,
                "observedAt": sample.observed_at,
                "completedAt": sample.completed_at,
                "labelAvailableAt": sample.label_available_at,
                "distance": sample.distance,
                "baselinePredictedSeconds": sample.baseline_predicted_seconds,
                "baselineOptimisticSeconds": sample.baseline_optimistic_seconds,
                "baselinePessimisticSeconds": sample.baseline_pessimistic_seconds,
                "actualSeconds": sample.actual_seconds,
                "features": {name: sample.features[name] for name in BASE_FEATURE_NAMES},
            }
        )
    return b"".join(
        (json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        for row in rows
    )


def dataset_sha256(samples: Iterable[TrainingSample]) -> str:
    return hashlib.sha256(canonical_dataset_bytes(samples)).hexdigest()


def feature_schema_document() -> dict[str, Any]:
    return {
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureNames": list(FEATURE_NAMES),
        "featureSemantics": {
            "acuteChronicLoadRatio": (
                "active composite daily training load; 7-day/28-day half-life "
                "EWMA ratio through asOf"
            ),
            "environmentalScenario": (
                "missing unless an independently timestamped pre-race scenario is available; "
                "workout result metadata is excluded"
            ),
        },
        "inputDtype": "float32",
        "inputShape": ["N", len(FEATURE_NAMES)],
        "outputDtype": "float32",
        "outputShape": ["N", 1],
        "outputSemantics": "targetLogResidual=log(actualSeconds/baselinePredictedSeconds)",
        "missingValue": "NaN",
        "distanceEncoding": {
            "five_k": "isFiveK",
            "ten_k": "isTenK",
            "half_marathon": "isHalfMarathon",
        },
    }


def feature_schema_sha256() -> str:
    payload = json.dumps(
        feature_schema_document(), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()
