from __future__ import annotations

from dataclasses import asdict
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from rai_ml import cli
from rai_ml.pipeline import TrainingConfig, TrainingError


@pytest.mark.parametrize("scope, minimum, per_distance", [(None, 50, 8), ("population", 50, 8), ("personal", 24, 4)])
def test_scope_changes_only_intake_floors(tmp_path, monkeypatch, capsys, scope, minimum, per_distance):
    path = tmp_path / "samples.jsonl"
    path.write_text("", encoding="utf-8")
    monkeypatch.setattr(cli, "load_jsonl", lambda _: [])
    captured = []

    def train(*args, config, **kwargs):
        assert kwargs["scope"] == (scope or "population")
        captured.append(config)
        raise TrainingError("release holdout remains required")

    monkeypatch.setattr(cli, "train_and_export", train)
    args = ["--input", str(path), "--output-dir", str(tmp_path / "output"), "--data-through-at", "2026-10-01T00:00:00Z"]
    if scope is not None:
        args.extend(["--scope", scope])
    assert cli.main(args) == 1
    config = asdict(captured[0])
    assert config.pop("minimum_labels") == minimum
    assert config.pop("minimum_labels_per_distance") == per_distance
    expected = asdict(TrainingConfig())
    expected.pop("minimum_labels")
    expected.pop("minimum_labels_per_distance")
    assert config == expected
    assert json.loads(capsys.readouterr().out)["error"] == "release holdout remains required"


def test_invalid_scope_is_rejected():
    with pytest.raises(SystemExit):
        cli.parser().parse_args(["--input", "x", "--output-dir", "y", "--data-through-at", "2026-10-01T00:00:00Z", "--scope", "unknown"])


def test_personal_runner_reaches_python_without_weakening_release_gates(tmp_path):
    node = shutil.which("node")
    if node is None:
        pytest.skip("requires the project's Node runtime for the real training runner")
    root = Path(__file__).resolve().parents[2]
    database = tmp_path / "rai.sqlite"
    script = """
import { RaiDatabase, SqlitePerformanceEntryRepository } from '@rai/storage-sqlite';
const store = await RaiDatabase.open(process.argv[1], { createMigrationBackup: false });
try {
  store.database.exec(`INSERT INTO health_records
    (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
    VALUES ('prior-vo2', 'HKQuantityTypeIdentifierVO2Max', 'Watch', 'apple_watch', 'mL/min*kg', 50,
      '2023-12-01T00:00:00.000Z', '2023-12-01T00:00:00.000Z', '{}', '{}')`);
  const repository = new SqlitePerformanceEntryRepository(store.database);
  const distances = ['five_k', 'ten_k', 'half_marathon'];
  const durations = [1150, 2400, 5200];
  for (let index = 0; index < 30; index++) {
    const date = new Date(Date.UTC(2024, 0, 7) + index * 14 * 86400000);
    repository.insert({ localDate: date.toISOString().slice(0, 10), distance: distances[index % 3],
      durationSeconds: durations[index % 3], recordedAt: new Date(date.getTime() + 86400000).toISOString(), note: null });
  }
} finally { store.close(); }
"""
    subprocess.run([node, "--import", "tsx", "--input-type=module", "-e", script, str(database)], cwd=root, check=True, capture_output=True)
    environment = {**os.environ, "RAI_PYTHON": sys.executable, "PYTHONPATH": str(root / "research")}
    for scope in ("population", "personal"):
        result = subprocess.run([
            node, "--import", "tsx", "packages/application/src/prediction-training-runner.ts",
            "--database", str(database), "--run-id", "fixture", "--as-of", "2026-10-01T00:00:00.000Z",
            "--scope", scope, "--artifact-directory", str(tmp_path / scope), "--result", str(tmp_path / f"{scope}.json"),
        ], cwd=root, env=environment, capture_output=True, text=True)
        assert result.returncode == 1
        if scope == "population":
            assert "训练标签不足" in result.stderr
        else:
            assert "训练标签不足" not in result.stderr
            assert "release training split does not satisfy" in result.stderr
