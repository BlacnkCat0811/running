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

/**
 * §16.1 **S04** 的后半句：「活跃**及回滚** bundle 依赖不被删」。
 *
 * 🔴 这半句此前**从未被执行过**。2026-09-30 的独立审计指出：
 * `pruneSupersededModelRuns` 里有一段"被 `model_release_bundles` 引用 ⇒ 保留"
 * （`database.ts:2872-2874`），但**没有任何 prune 用例会写入 `model_release_bundles`**，
 * 所以那三行实现的保护一次也没跑过，状态文档却把它当成既有证据写进了 §9.1 的条件 7。
 *
 * 这条用例把它跑起来。注意它同时是**两条**防线：
 * 1. 保留循环主动把被引用的 run 加进 retained；
 * 2. 即使循环失效，`model_release_bundles.model_run_id` 的外键是
 *    `ON DELETE RESTRICT` —— 删掉被引用的 run 会直接抛错，而不是悄悄留下悬挂引用。
 * 所以断言分两种失败模式：run 必须存活，且 prune 必须**不抛**。
 */
test("S04: a run referenced by a release bundle survives pruning (rollback target)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prune-bundle-"));
  const store = await openStore(root);
  try {
      const runs = [
        seedRun(store, "a", "2026-01-01T00:00:00.000Z", 1, null),
        seedRun(store, "b", "2026-01-02T00:00:00.000Z", 1, null),
        seedRun(store, "c", "2026-01-03T00:00:00.000Z", 1, null),
        seedRun(store, "d", "2026-01-04T00:00:00.000Z", 1, null)
      ];
      const rollbackTarget = runs[0] as SeededRun; // 最老的一个：keepRecent: 1 下必然被清
      const active = runs[3] as SeededRun;
      activate(store, active.modelRunId, "2026-01-04T01:00:00.000Z");

      // 发过一个 release bundle，并把它的 run 留作回滚目标（未激活）。
      store.database.prepare(`INSERT INTO model_release_bundles
        (model_run_id, base_model_run_id, dataset_version, snapshot_hash, evaluation_json, status, created_at)
        VALUES (?, NULL, 'ds-1', 'hash-1', '{}', 'passed', '2026-01-01T02:00:00.000Z')`)
        .run(rollbackTarget.modelRunId);

      // keepRecent: 1 ⇒ 不设保护的话 'a' 与 'b' 都会被清。
      const result = store.pruneSupersededModelRuns({ keepRecent: 1 });

      const survivors = (store.database.prepare("SELECT id FROM model_runs").all() as unknown as Array<{ id: string }>)
        .map((row) => row.id);
      assert.ok(
        survivors.includes(rollbackTarget.modelRunId),
        "被 release bundle 引用的 run 是回滚目标，prune 不得删它"
      );
      assert.ok(survivors.includes(active.modelRunId), "活跃 run 当然也必须在");
      assert.equal(result.retainedModelRuns, survivors.length);
      // bundle 行本身必须还在，否则"回滚按钮"指向一个已消失的目标。
      assert.equal(count(store, "model_release_bundles"), 1);
      assert.equal(
        (store.database.prepare("SELECT model_run_id AS id FROM model_release_bundles").get() as { id: string }).id,
        rollbackTarget.modelRunId
      );
      assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
});

/**
 * 反向：**没有** bundle 引用时，老 run 仍然要被清掉。
 *
 * 缺了这条，"保留循环"可以退化成"永不删除任何东西"而上面那条依然全绿 ——
 * 那就把 prune 变成了 no-op，同样不是我们想要的。
 */
test("S04: without a bundle reference the older run is still pruned", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-prune-nobundle-"));
  try {
    const store = await openStore(root);
    try {
      seedRun(store, "a", "2026-01-01T00:00:00.000Z", 1, null);
      seedRun(store, "b", "2026-01-02T00:00:00.000Z", 1, null);
      const active = seedRun(store, "c", "2026-01-03T00:00:00.000Z", 1, null);
      activate(store, active.modelRunId, "2026-01-03T01:00:00.000Z");

      const result = store.pruneSupersededModelRuns({ keepRecent: 0 });
      assert.equal(result.modelRuns, 2, "no bundle reference ⇒ nothing is protected beyond the active run");
      assert.equal(count(store, "model_runs"), 1);
      assert.deepEqual(store.database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
