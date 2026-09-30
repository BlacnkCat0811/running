import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "../src/database.js";

interface SeededRun {
  modelRunId: string;
  featureRunId: string;
  metricRunId: string;
  snapshotIds: string[];
  checkpointId: string;
}

/**
 * Builds one recomputation run the way the pipeline does: a fresh feature run,
 * model run and training metric run, each carrying its own copy of the derived
 * output.
 */
function seedRun(store: RaiDatabase, name: string, createdAt: string, snapshots: number, parentId: string | null): SeededRun {
  const db = store.database;
  const featureRunId = `feature_run_${name}`;
  const modelRunId = `model_run_${name}`;
  const metricRunId = `training_metric_run_${name}`;
  db.prepare(`
    INSERT INTO feature_runs (id, dataset_version, canonical_contract_version, feature_schema_version,
      feature_config_json, feature_config_hash, status, created_at)
    VALUES (?, 'dataset', 'canonical-health-v2', 'workout-feature-v3', '{}', ?, 'succeeded', ?)
  `).run(featureRunId, `hash_${name}`, createdAt);
  db.prepare(`
    INSERT INTO model_runs (id, feature_run_id, dataset_version, model_version, model_config_json,
      model_config_hash, evaluated_at, status, created_at, parent_model_run_id)
    VALUES (?, ?, 'dataset', 'model-v1', '{}', ?, ?, 'succeeded', ?, ?)
  `).run(modelRunId, featureRunId, `model_hash_${name}`, createdAt, createdAt, parentId);
  db.prepare(`
    INSERT INTO training_metric_runs (id, model_run_id, algorithm_version, config_json, config_hash,
      timezone_identifier, evaluated_at, status, created_at)
    VALUES (?, ?, 'v1', '{}', ?, 'Asia/Shanghai', ?, 'succeeded', ?)
  `).run(metricRunId, modelRunId, `metric_hash_${name}`, createdAt, createdAt);
  const snapshotIds: string[] = [];
  for (let index = 0; index < snapshots; index += 1) {
    const snapshotId = `snapshot_${name}_${index}`;
    snapshotIds.push(snapshotId);
    db.prepare(`
      INSERT INTO daily_ability_snapshots (id, model_run_id, local_date, timezone_identifier, snapshot_status)
      VALUES (?, ?, ?, 'Asia/Shanghai', 'active')
    `).run(snapshotId, modelRunId, `2026-0${1 + (index % 9)}-01`);
  }
  const checkpointId = `checkpoint_${name}`;
  db.prepare(`
    INSERT INTO model_checkpoints (id, model_run_id, sequence_number, through_at, checkpoint_version,
      model_version, model_config_hash, feature_schema_version, feature_config_hash, timezone_identifier,
      state_json, state_hash)
    VALUES (?, ?, 0, ?, 'v1', 'model-v1', ?, 'workout-feature-v3', ?, 'Asia/Shanghai', '{}', ?)
  `).run(checkpointId, modelRunId, createdAt, `model_hash_${name}`, `hash_${name}`, `state_${name}`);
  return { modelRunId, featureRunId, metricRunId, snapshotIds, checkpointId };
}

function activate(store: RaiDatabase, modelRunId: string, at: string): void {
  store.database.prepare(`
    INSERT INTO active_model_run (singleton, model_run_id, activated_at) VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET model_run_id = excluded.model_run_id, activated_at = excluded.activated_at
  `).run(modelRunId, at);
}

function count(store: RaiDatabase, table: string): number {
  return (store.database.prepare(`SELECT COUNT(*) AS rowCount FROM ${table}`).get() as { rowCount: number }).rowCount;
}

async function openStore(root: string): Promise<RaiDatabase> {
  return RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
}

/**
 * Each recompute materialises the complete derived output again, so without
 * retention the database grows as O(runs × days). Pruning must reclaim the
 * superseded copies — and only those.
 */
test("S04: prunes superseded runs and keeps the active run intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prune-runs-"));
  try {
    const store = await openStore(root);
    try {
      const runs = [
        seedRun(store, "a", "2026-01-01T00:00:00.000Z", 3, null),
        seedRun(store, "b", "2026-01-02T00:00:00.000Z", 3, null),
        seedRun(store, "c", "2026-01-03T00:00:00.000Z", 3, null),
        seedRun(store, "d", "2026-01-04T00:00:00.000Z", 3, null),
        seedRun(store, "e", "2026-01-05T00:00:00.000Z", 3, null)
      ];
      const active = runs[4] as SeededRun;
      activate(store, active.modelRunId, "2026-01-05T01:00:00.000Z");
      // A finished job still points at a run that is about to be superseded.
      store.database.prepare(`
        INSERT INTO recompute_jobs (id, job_type, status, feature_run_id, model_run_id, request_json, progress_phase)
        VALUES ('job-old', 'full_recompute', 'succeeded', ?, ?, '{}', 'completed')
      `).run((runs[0] as SeededRun).featureRunId, (runs[0] as SeededRun).modelRunId);

      assert.equal(count(store, "model_runs"), 5);
      assert.equal(count(store, "daily_ability_snapshots"), 15);

      const result = store.pruneSupersededModelRuns({ keepRecent: 2 });
      assert.equal(result.modelRuns, 2, "keeps the active run plus two recent runs");
      assert.equal(result.featureRuns, 2);
      assert.equal(result.trainingMetricRuns, 2);
      assert.equal(result.derivedRows, 8, "3 snapshots + 1 checkpoint per pruned run");
      assert.equal(result.detachedJobs, 1, "the audit job survives with a released reference");
      assert.equal(result.retainedModelRuns, 3);

      assert.equal(count(store, "model_runs"), 3);
      assert.equal(count(store, "feature_runs"), 3);
      assert.equal(count(store, "training_metric_runs"), 3);
      assert.equal(count(store, "daily_ability_snapshots"), 9);
      assert.equal(count(store, "model_checkpoints"), 3);

      // The active run is untouched, down to its derived rows.
      assert.equal(
        (store.database.prepare("SELECT COUNT(*) AS rowCount FROM daily_ability_snapshots WHERE model_run_id = ?")
          .get(active.modelRunId) as { rowCount: number }).rowCount,
        3
      );
      assert.equal(
        (store.database.prepare("SELECT model_run_id AS id FROM active_model_run").get() as { id: string }).id,
        active.modelRunId
      );
      // The job is kept: pruning retires a run, not the record that it happened.
      assert.equal(count(store, "recompute_jobs"), 1);
      assert.equal(
        (store.database.prepare("SELECT model_run_id AS id FROM recompute_jobs WHERE id = 'job-old'")
          .get() as { id: string | null }).id,
        null
      );
      assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);

      // Pruning again is a no-op rather than an error.
      assert.equal(store.pruneSupersededModelRuns({ keepRecent: 2 }).modelRuns, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Without a known live run there is no safe definition of "superseded", and a
 * wrong guess deletes live data. Refusing is the only defensible behaviour.
 */
test("refuses to prune while no run is active", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prune-inactive-"));
  try {
    const store = await openStore(root);
    try {
      seedRun(store, "a", "2026-01-01T00:00:00.000Z", 1, null);
      seedRun(store, "b", "2026-01-02T00:00:00.000Z", 1, null);
      assert.throws(
        () => store.pruneSupersededModelRuns({ keepRecent: 0 }),
        /no run is active/
      );
      assert.equal(count(store, "model_runs"), 2, "a refused prune must delete nothing");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * `model_runs.parent_model_run_id` is NO ACTION, so a retained run's ancestors
 * must survive even when they fall outside the retention window.
 */
test("S04: keeps the ancestry of a retained run", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prune-lineage-"));
  try {
    const store = await openStore(root);
    try {
      const oldest = seedRun(store, "root", "2026-01-01T00:00:00.000Z", 1, null);
      const middle = seedRun(store, "mid", "2026-01-02T00:00:00.000Z", 1, oldest.modelRunId);
      const newest = seedRun(store, "head", "2026-01-03T00:00:00.000Z", 1, middle.modelRunId);
      seedRun(store, "spare", "2026-01-04T00:00:00.000Z", 1, null);
      activate(store, newest.modelRunId, "2026-01-04T01:00:00.000Z");

      // keepRecent: 0 keeps only the active run, but its whole ancestry must stay.
      const result = store.pruneSupersededModelRuns({ keepRecent: 0 });
      assert.equal(result.retainedModelRuns, 3, "active run and its two ancestors");
      assert.equal(result.modelRuns, 1, "only the unrelated run is superseded");
      const survivors = (store.database.prepare("SELECT id FROM model_runs").all() as unknown as Array<{ id: string }>)
        .map((row) => row.id)
        .sort();
      assert.deepEqual(survivors, [oldest.modelRunId, middle.modelRunId, newest.modelRunId].sort());
      assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("protects feature ancestry when model replay has no parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prune-feature-lineage-"));
  const store = await openStore(root);
  try {
    const a = seedRun(store, "a", "2026-01-01", 1, null);
    const b = seedRun(store, "b", "2026-01-02", 1, null);
    const c = seedRun(store, "c", "2026-01-03", 1, null);
    seedRun(store, "unrelated", "2026-01-04", 1, null);
    const link = store.database.prepare("UPDATE feature_runs SET parent_feature_run_id = ? WHERE id = ?");
    link.run(a.featureRunId, b.featureRunId);
    link.run(b.featureRunId, c.featureRunId);
    activate(store, c.modelRunId, "2026-01-05");
    const result = store.pruneSupersededModelRuns({ keepRecent: 0 });
    assert.equal(result.modelRuns, 3);
    assert.equal(result.featureRuns, 1);
    assert.equal(count(store, "feature_runs"), 3);
    assert.equal(count(store, "model_runs"), 1);
    assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
