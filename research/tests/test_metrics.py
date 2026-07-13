import pytest

from rai_ml.metrics import PredictionResult, regression_metrics


def test_metrics_include_error_bias_and_interval_coverage():
    metrics = regression_metrics(
        [
            PredictionResult("five_k", 100.0, 110.0, 90.0, 120.0),
            PredictionResult("five_k", 100.0, 90.0, 80.0, 95.0),
        ]
    )
    assert metrics.meanAbsoluteErrorSeconds == 10
    assert metrics.rootMeanSquaredErrorSeconds == 10
    assert metrics.meanAbsolutePercentageError == pytest.approx(0.1)
    assert metrics.meanSignedErrorSeconds == 0
    assert metrics.intervalCoverage == 0.5
    assert metrics.intervalSampleCount == 2
