from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Iterable


@dataclass(frozen=True)
class RegressionMetrics:
    sampleCount: int
    meanAbsoluteErrorSeconds: float | None
    rootMeanSquaredErrorSeconds: float | None
    meanAbsolutePercentageError: float | None
    meanSignedErrorSeconds: float | None
    intervalCoverage: float | None
    intervalSampleCount: int

    def to_dict(self) -> dict[str, int | float | None]:
        return asdict(self)


@dataclass(frozen=True)
class PredictionResult:
    distance: str
    actual_seconds: float
    predicted_seconds: float
    optimistic_seconds: float | None
    pessimistic_seconds: float | None


def regression_metrics(values: Iterable[PredictionResult]) -> RegressionMetrics:
    rows = list(values)
    if not rows:
        return RegressionMetrics(0, None, None, None, None, None, 0)
    errors = [row.predicted_seconds - row.actual_seconds for row in rows]
    absolute = [abs(value) for value in errors]
    interval_rows = [
        row
        for row in rows
        if row.optimistic_seconds is not None and row.pessimistic_seconds is not None
    ]
    covered = [
        row.optimistic_seconds <= row.actual_seconds <= row.pessimistic_seconds
        for row in interval_rows
        if row.optimistic_seconds is not None and row.pessimistic_seconds is not None
    ]
    return RegressionMetrics(
        sampleCount=len(rows),
        meanAbsoluteErrorSeconds=sum(absolute) / len(rows),
        rootMeanSquaredErrorSeconds=math.sqrt(sum(value * value for value in errors) / len(rows)),
        meanAbsolutePercentageError=sum(
            abs(error) / row.actual_seconds for error, row in zip(errors, rows, strict=True)
        )
        / len(rows),
        meanSignedErrorSeconds=sum(errors) / len(rows),
        intervalCoverage=sum(covered) / len(covered) if covered else None,
        intervalSampleCount=len(covered),
    )
