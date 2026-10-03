from __future__ import annotations

import json
import math
from pathlib import Path
import shutil
import subprocess

import pytest

from rai_ml.contract import (
    BASE_FEATURE_NAMES,
    ContractError,
    FEATURE_NAMES,
    FEATURE_SCHEMA_VERSION,
    dataset_sha256,
    feature_schema_document,
    feature_schema_sha256,
    load_jsonl,
)


def row(sample_id: str = "sample-1", observed_at: str = "2026-01-01T00:00:00Z"):
    baseline = 1500.0
    features = {name: 1.0 for name in BASE_FEATURE_NAMES}
    features["logPredictedSeconds"] = math.log(baseline)
    features["readiness"] = 0.7
    features["lactateThresholdConfidence"] = 0.5
    features["recoveryReadiness"] = 0.8
    features["overallDataQuality"] = 0.9
    return {
        "schemaVersion": FEATURE_SCHEMA_VERSION,
        "sampleId": sample_id,
        "observedAt": observed_at,
        "completedAt": "2026-01-01T00:30:00Z",
        "labelAvailableAt": "2026-01-01T00:30:00Z",
        "distance": "five_k",
        "baselinePredictedSeconds": baseline,
        "baselineOptimisticSeconds": 1450.0,
        "baselinePessimisticSeconds": 1600.0,
        "actualSeconds": 1530.0,
        "features": features,
    }


def write_jsonl(tmp_path, rows):
    path = tmp_path / "samples.jsonl"
    path.write_text("".join(json.dumps(item) + "\n" for item in rows), encoding="utf-8")
    return path


def test_loads_contract_and_builds_ordered_float_features(tmp_path):
    sample = load_jsonl(write_jsonl(tmp_path, [row()]))[0]
    assert len(sample.feature_row()) == len(FEATURE_NAMES)
    assert sample.feature_row()[-3:] == [1.0, 0.0, 0.0]
    assert sample.target_log_residual == pytest.approx(math.log(1530 / 1500))


def test_typescript_manual_results_export_valid_training_clocks(tmp_path):
    node = shutil.which("node")
    if node is None:
        pytest.skip("requires the project's Node runtime to export real manual labels")
    script = """
import { RaiDatabase, SqlitePerformanceEntryRepository } from '@rai/storage-sqlite';
import { buildRaceResidualTrainingDataset } from '@rai/application';
const store = await RaiDatabase.open(process.argv[1], { createMigrationBackup: false });
try {
  store.database.exec(`INSERT INTO health_records
    (id, type, source_name, source_category, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
    VALUES ('prior-vo2', 'HKQuantityTypeIdentifierVO2Max', 'Watch', 'apple_watch', 50,
      '2024-02-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z', '{}', '{}')`);
  const repository = new SqlitePerformanceEntryRepository(store.database);
  repository.insert({ localDate: '2024-03-10', distance: 'five_k', durationSeconds: 1290,
    recordedAt: '2026-10-01T00:00:00.000Z', note: null });
  repository.insert({ localDate: '2026-10-02', distance: 'ten_k', durationSeconds: 2500,
    recordedAt: '2026-10-02T02:00:00.000Z', note: null });
  const { samples } = buildRaceResidualTrainingDataset(store.database, '2026-10-02T03:00:00.000Z');
  for (const sample of samples) console.log(JSON.stringify(sample));
} finally { store.close(); }
"""
    exported = subprocess.run(
        [node, "--import", "tsx", "--input-type=module", "-e", script, str(tmp_path / "rai.sqlite")],
        cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, check=True,
    )
    path = tmp_path / "manual.jsonl"
    path.write_text(exported.stdout, encoding="utf-8")
    samples = load_jsonl(path)
    assert len(samples) == 2
    assert all(sample.completed_at > sample.observed_at for sample in samples)
    assert all(sample.label_available_at >= sample.completed_at for sample in samples)


def test_null_feature_becomes_nan(tmp_path):
    value = row()
    value["features"]["temperatureC"] = None
    sample = load_jsonl(write_jsonl(tmp_path, [value]))[0]
    index = FEATURE_NAMES.index("temperatureC")
    assert math.isnan(sample.feature_row()[index])


def test_rejects_unknown_fields_and_future_order(tmp_path):
    unknown = row()
    unknown["features"]["futureMetric"] = 1
    with pytest.raises(ContractError, match="unknown feature"):
        load_jsonl(write_jsonl(tmp_path, [unknown]))
    later = row("later", "2026-01-02T00:00:00Z")
    later["completedAt"] = "2026-01-02T00:30:00Z"
    later["labelAvailableAt"] = "2026-01-02T00:30:00Z"
    earlier = row("earlier")
    with pytest.raises(ContractError, match="must be ordered"):
        load_jsonl(write_jsonl(tmp_path, [later, earlier]))


def test_dataset_hash_is_canonical(tmp_path):
    first = load_jsonl(write_jsonl(tmp_path, [row()]))
    second = load_jsonl(write_jsonl(tmp_path, [row()]))
    assert dataset_sha256(first) == dataset_sha256(second)


def test_feature_schema_hash_includes_acwr_semantics():
    assert feature_schema_document()["featureSemantics"]["acuteChronicLoadRatio"] == (
        "active composite daily training load; 7-day/28-day half-life EWMA ratio "
        "through asOf"
    )
    assert feature_schema_sha256() == (
        "462e213399e199f268ce1122eeae924db6d55c4dbc0795c643394d22f0366aa7"
    )


def test_ordering_uses_absolute_instants_instead_of_raw_timezone_strings(tmp_path):
    later = row("later", "2026-01-01T00:00:00Z")
    earlier = row("earlier", "2026-01-01T00:30:00+02:00")
    earlier["completedAt"] = "2025-12-31T23:00:00Z"
    earlier["labelAvailableAt"] = "2025-12-31T23:00:00Z"
    with pytest.raises(ContractError, match="must be ordered"):
        load_jsonl(write_jsonl(tmp_path, [later, earlier]))


@pytest.mark.parametrize("observed_at", [
    "2026-01-01 00:00:00Z",
    "2026-01-01T00:00:00.1234567Z",
])
def test_rejects_timestamp_syntax_not_supported_by_the_ts_runner(tmp_path, observed_at):
    with pytest.raises(ContractError, match="timezone-qualified ISO 8601 instant"):
        load_jsonl(write_jsonl(tmp_path, [row(observed_at=observed_at)]))
