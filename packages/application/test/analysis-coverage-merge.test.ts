// F00（R01/R02 共同机制）：**"读到了当前事实" ≠ "从旧发布到当前的全部变更都已重新计算"**。
//
// 两条被复查确认的缺陷形态（2026-10-16 合成夹具）：
//   - R01：漂移重排丢掉原任务尚未发布的 dirty 范围 —— 后继任务只算"漂移之后"的批次，
//     原任务登记的早期更正（A）被漏，结果仍是未更正的值；
//   - R02：合并任务把"调度成员"当成"事实覆盖"，未入选批次（时间窗/成员上限之外）的
//     早期更正被漏算，发布却宣称（并写入覆盖记录）已到最新代次。
//
// 这个文件钉的是**共用机制**（覆盖计划生成）：无论调用方是"重排"还是"合并"，
// 计划都必须覆盖「可信基线之后全部影响分析的未覆盖批次 ∪ 原任务未发布范围」。
// 断言只看计划边界与批次清单 —— 它们正是发布与结算读的那份证据。
//
// ⚠️ 修复前本文件必须**精确失败**（断言失败，而不是编译失败）：所以夹具只用既有字段。
//    "未覆盖影响批次 ⇒ 保守拒绝"的另一半（新夹具）在实现落地后追加。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteAnalysisInputReader, type AnalysisInputCaptureRequest } from "../src/index.js";
import { RaiDatabase } from "@rai/storage-sqlite";

/**
 * 三个批次的固定夹具：
 *
 * - `batch_old`：**更正** 03-01 训练段内的一条心率记录 ⇒ 影响边界回退到 03-01T09:00（最早）。
 * - `batch_new_a`：新增 03-05 的训练。
 * - `batch_new_b`：新增 03-06 的训练。
 *
 * 后两批更晚到达（漂移/时间窗的不入选者），但 `batch_old` 的更正**必须**仍进入计划。
 */
function seed(database: DatabaseSync): void {
  database.prepare("INSERT INTO import_manifest (key, value) VALUES ('dataset_version', ?)")
    .run("dataset_fixture_v1");
  const insertWorkout = database.prepare(`
    INSERT INTO workouts
      (id, activity_type, source_name, source_category, source_version, device, start_at, end_at,
       duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
    VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture Watch', 'apple_watch', '1', 'Watch', ?, ?, 1800, 0, '{}', '{}', 1)
  `);
  insertWorkout.run("workout_old", "2026-03-01T09:00:00.000Z", "2026-03-01T09:30:00.000Z");
  insertWorkout.run("workout_a", "2026-03-05T09:00:00.000Z", "2026-03-05T09:30:00.000Z");
  insertWorkout.run("workout_b", "2026-03-06T09:00:00.000Z", "2026-03-06T09:30:00.000Z");
  const insertSession = database.prepare(`
    INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
    VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')
  `);
  insertSession.run("session_old", "2026-03-01T09:00:00.000Z", "2026-03-01T09:30:00.000Z", "workout_old");
  insertSession.run("session_a", "2026-03-05T09:00:00.000Z", "2026-03-05T09:30:00.000Z", "workout_a");
  insertSession.run("session_b", "2026-03-06T09:00:00.000Z", "2026-03-06T09:30:00.000Z", "workout_b");
  database.prepare(`INSERT INTO health_records
    (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
     start_at, end_at, created_at, metadata_json, raw_attributes_json)
    VALUES ('record_hr_old', 'HKQuantityTypeIdentifierHeartRate', 'Fixture Watch', 'apple_watch', '1',
      'Watch', 'count/min', 141, NULL, '2026-03-01T09:05:00.000Z', '2026-03-01T09:05:10.000Z',
      '2026-03-01T09:06:00.000Z', '{}', '{}')`).run();

  // 三个成功批次 + 代次推进（raw 也随行 —— 与直连车道的结构一致：bumped=1 的批次两个代次都推进）。
  const insertBatch = database.prepare(`
    INSERT INTO import_batches (id, xml_sha256, status, import_mode, created_at, raw_generation,
      dependency_generation, dependency_bumped)
    VALUES (?, ?, 'succeeded', 'incremental', ?, ?, ?, 1)
  `);
  insertBatch.run("batch_old", "0".repeat(64), "2026-03-01T10:00:00.000Z", 1, 1);
  insertBatch.run("batch_new_a", "1".repeat(64), "2026-03-05T10:00:00.000Z", 2, 2);
  insertBatch.run("batch_new_b", "2".repeat(64), "2026-03-06T10:00:00.000Z", 3, 3);
  const insertChange = database.prepare(`
    INSERT INTO import_entity_changes (batch_id, entity_kind, entity_id, change_type, effective_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  // 更正记录：影响边界由「相交训练回退」压到训练开始时刻（03-01T09:00）——最早的脏边界。
  insertChange.run("batch_old", "record", "record_hr_old", "updated", "2026-03-01T09:05:00.000Z");
  insertChange.run("batch_new_a", "workout", "workout_a", "inserted", "2026-03-05T09:00:00.000Z");
  insertChange.run("batch_new_b", "workout", "workout_b", "inserted", "2026-03-06T09:00:00.000Z");
  database.prepare(
    "UPDATE import_generations SET raw_generation = 3, dependency_generation = 3 WHERE singleton = 1"
  ).run();
}

/** 可信旧发布（R0）的绑定：捕获 0/0 —— base 之后的全部批次都是"未覆盖变更"。 */
function seedReleaseBaseline(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO feature_runs (
      id, dataset_version, canonical_contract_version, feature_schema_version,
      feature_config_json, feature_config_hash, status
    ) VALUES ('feature_run_r0', 'dataset_fixture_v1', 'contract', 'workout-feature-v4', '{}', 'hash', 'succeeded')
  `).run();
  database.prepare(`
    INSERT INTO model_runs (
      id, feature_run_id, dataset_version, model_version, model_config_json,
      model_config_hash, evaluated_at, status
    ) VALUES ('model_run_r0', 'feature_run_r0', 'dataset_fixture_v1', 'model', '{}', 'hash',
      '2026-03-02T00:00:00.000Z', 'succeeded')
  `).run();
  database.prepare("INSERT INTO active_model_run (singleton, model_run_id) VALUES (1, 'model_run_r0')").run();
  database.prepare(`
    INSERT INTO analysis_run_input_bindings (
      run_id, job_id, scope, dataset_version, captured_raw_generation,
      captured_dependency_generation, target_raw_generation, target_dependency_generation,
      incumbent_release_id, timezone_identifier, override_digest, config_digest,
      cutoff_at, input_digest
    ) VALUES ('model_run_r0', 'job_r0', 'direct-sync', 'dataset_fixture_v1', 0, 0, NULL, NULL, NULL,
      'UTC', '', '', '2026-03-02T00:00:00.000Z', 'digest_r0')
  `).run();
}

async function withFixture<T>(run: (input: DatabaseSync, writer: DatabaseSync) => T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rai-analysis-coverage-merge-"));
  const path = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(path, { createMigrationBackup: false });
  const input = RaiDatabase.openReadonly(path);
  try {
    seed(store.database);
    return run(input, store.database);
  } finally {
    input.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function captureWith(input: DatabaseSync, request: Partial<AnalysisInputCaptureRequest>) {
  return new SqliteAnalysisInputReader(input, "direct-sync").capture({
    runId: "",
    jobId: "job_fixture",
    scope: "direct-sync",
    timezoneIdentifier: "UTC",
    evaluatedAt: "2026-03-10T00:00:00.000Z",
    targetRawGeneration: null,
    targetDependencyGeneration: null,
    expectedIncumbentReleaseId: null,
    registeredPlan: null,
    ...request
  });
}

const BOUNDARY_OLD = "2026-03-01T09:00:00.000Z";
const BOUNDARY_NEW_A = "2026-03-05T09:00:00.000Z";

test("R02：合并任务捕获时必须把未入选批次的早期更正并入计划（base 之后的全部未覆盖变更）", async () => {
  await withFixture((input, writer) => {
    seedReleaseBaseline(writer);
    // 合并任务的登记计划 = 两个**入选成员**的并集（不含因时间窗/上限未入选的 `batch_old`）。
    const capture = captureWith(input, {
      targetRawGeneration: 3,
      targetDependencyGeneration: 3,
      registeredPlan: {
        dirtyFromAt: BOUNDARY_NEW_A,
        domains: { features: BOUNDARY_NEW_A, fitness: BOUNDARY_NEW_A, readiness: BOUNDARY_NEW_A }
      },
      // 合并任务登记的批次证据 = 两个入选成员的并集（不含未入选的 `batch_old`）。
      registeredBatchIds: ["batch_new_a", "batch_new_b"]
    });
    assert.equal(
      capture.plan?.dirtyFromAt,
      BOUNDARY_OLD,
      "未入选批次的更正早于成员并集边界：计划必须覆盖它，否则发布将把未算的早期更正宣称为最新"
    );
    assert.ok(
      capture.mergedBatchIds.includes("batch_old"),
      `执行覆盖批次必须包含未入选批次（实际：${JSON.stringify(capture.mergedBatchIds)}）`
    );
    capture.facts.dispose();
  });
});

test("R01：漂移重排不得丢掉原任务尚未发布的 dirty 范围（registered 计划与漂移批次取并集）", async () => {
  await withFixture((input, writer) => {
    seedReleaseBaseline(writer);
    // 漂移前捕获代次 = 1（含 batch_old）：原任务的计划从 03-01 起；漂移后 new_a/new_b 落库。
    const capture = captureWith(input, {
      targetRawGeneration: 1,
      targetDependencyGeneration: 1,
      registeredPlan: {
        dirtyFromAt: BOUNDARY_OLD,
        domains: { features: BOUNDARY_OLD, fitness: BOUNDARY_OLD, readiness: BOUNDARY_OLD }
      },
      registeredBatchIds: ["batch_old"],
      mergeFromRawGeneration: 1
    });
    assert.equal(
      capture.plan?.dirtyFromAt,
      BOUNDARY_OLD,
      "重排后的边界只能保持或向前扩大：原任务范围内的早期更正不得被漂移批次替换掉"
    );
    capture.facts.dispose();
  });
});

test("R01（无绑定的兼容路径）：重排同样保留原任务未发布范围", async () => {
  await withFixture((input) => {
    // 没有可信旧发布（无 active release 绑定）⇒ 兼容路径。
    const capture = captureWith(input, {
      targetRawGeneration: 1,
      targetDependencyGeneration: 1,
      registeredPlan: {
        dirtyFromAt: BOUNDARY_OLD,
        domains: { features: BOUNDARY_OLD, fitness: BOUNDARY_OLD, readiness: BOUNDARY_OLD }
      },
      // 原任务登记的批次证据：它证明 `batch_old` 的 dirty 有归属（未覆盖检查据此放行）。
      registeredBatchIds: ["batch_old"],
      mergeFromRawGeneration: 1
    });
    assert.equal(
      capture.plan?.dirtyFromAt,
      BOUNDARY_OLD,
      "兼容路径下重排仍必须把原任务计划与漂移批次账本取并集（否则早期更正丢失）"
    );
    capture.facts.dispose();
  });
});

test("B04：退回完整计算不得清空执行覆盖批次（否则成员发布后仍被重新排队）", async () => {
  await withFixture((input, writer) => {
    seedReleaseBaseline(writer);
    // 让入选批次带上路线证据 ⇒ 账本无法重建路线-only 更正 ⇒ 捕获器只能保守全量。
    // 这正是复查复现的那条路径（`route_evidence_unmerged`）。
    writer.prepare("UPDATE import_batches SET summary_json = ? WHERE id = 'batch_new_a'")
      .run(JSON.stringify({ routes: { importedRouteCount: 1 } }));
    const capture = captureWith(input, {
      targetRawGeneration: 3,
      targetDependencyGeneration: 3,
      registeredPlan: {
        dirtyFromAt: BOUNDARY_NEW_A,
        domains: { features: BOUNDARY_NEW_A, fitness: BOUNDARY_NEW_A, readiness: BOUNDARY_NEW_A }
      },
      registeredBatchIds: ["batch_new_a", "batch_new_b"]
    });
    assert.equal(capture.plan, null, "路线证据无法从账本重建时必须全量");
    assert.equal(capture.planAdjustment, "route_evidence_unmerged");
    // 🔴 修复前这里是空数组：发布事务写下空的 `analysis_job_coverage`，
    // 结算方报 `publication_missing_union_batch`，两个已经算完的成员重新排队。
    // 执行覆盖与计划模式是两件事 —— 退回全量只改变计划，不改变"谁被真的算了"。
    assert.deepEqual(
      [...capture.mergedBatchIds].sort(),
      ["batch_new_a", "batch_new_b", "batch_old"],
      "全量执行覆盖「登记成员 ∪ 基线之后的全部影响批次」——退回全量不能清空这份证据"
    );
    // B04 第二种形态：执行模式显式版本化，NULL 只表示"旧绑定缺证据"。
    assert.equal(capture.executedPlan.version, 1);
    assert.equal(capture.executedPlan.mode, "rebuild");
    assert.equal(capture.executedPlan.dirtyFromAt, null, "rebuild 的边界是「覆盖一切」而不是「未知」");
    capture.facts.dispose();
  });
});

test("B04：partial 计划写出版本化的逐域边界（与 rebuild 区分）", async () => {
  await withFixture((input, writer) => {
    seedReleaseBaseline(writer);
    const capture = captureWith(input, {
      targetRawGeneration: 3,
      targetDependencyGeneration: 3,
      registeredPlan: {
        dirtyFromAt: BOUNDARY_NEW_A,
        domains: { features: BOUNDARY_NEW_A, fitness: BOUNDARY_NEW_A, readiness: BOUNDARY_NEW_A }
      },
      registeredBatchIds: ["batch_new_a", "batch_new_b"]
    });
    assert.notEqual(capture.plan, null, "没有路线证据时应保留可复用的部分计划");
    assert.equal(capture.executedPlan.version, 1);
    assert.equal(capture.executedPlan.mode, "partial");
    assert.equal(capture.executedPlan.dirtyFromAt, BOUNDARY_OLD);
    capture.facts.dispose();
  });
});

test("B05：含路线证据的批次用持久证据重建计划，不再无条件全量", async () => {
  await withFixture((input, writer) => {
    seedReleaseBaseline(writer);
    // v45 的批次级证据：路线变更以"所属训练的开始时刻"作为合成条目，边界比账本能给出的更早。
    const evidenceBoundary = "2026-02-20T09:00:00.000Z";
    writer.prepare(
      "UPDATE import_batches SET summary_json = ?, analysis_dirty_plan_json = ? WHERE id = 'batch_new_a'"
    ).run(
      JSON.stringify({ routes: { importedRouteCount: 1 } }),
      JSON.stringify({
        version: 1,
        full: false,
        dirtyFromAt: evidenceBoundary,
        domains: {
          features: evidenceBoundary, fitness: evidenceBoundary, readiness: evidenceBoundary
        },
        routeDirtyTimes: ["2026-03-05T09:00:00.000Z"],
        recoveryBoundaries: [],
        reasons: ["bounded_health_change", "overlapping_workout_rewound"]
      })
    );
    const capture = captureWith(input, {
      targetRawGeneration: 3,
      targetDependencyGeneration: 3,
      registeredPlan: {
        dirtyFromAt: BOUNDARY_NEW_A,
        domains: { features: BOUNDARY_NEW_A, fitness: BOUNDARY_NEW_A, readiness: BOUNDARY_NEW_A }
      },
      registeredBatchIds: ["batch_new_a", "batch_new_b"]
    });
    // 修复前：只要 `routes.importedRouteCount > 0` 就 `route_evidence_unmerged` ⇒ 全量。
    assert.equal(capture.planAdjustment, "coverage_merged");
    assert.equal(
      capture.plan?.dirtyFromAt,
      evidenceBoundary,
      "路线批次的边界必须来自持久证据 —— 账本里没有路线，重建不出这个边界"
    );
    assert.ok(capture.mergedBatchIds.includes("batch_new_a"));
    capture.facts.dispose();
  });
});

test("B05：损坏的批次证据不得被当作「没有路线影响」（失败关闭）", async () => {
  await withFixture((input, writer) => {
    seedReleaseBaseline(writer);
    writer.prepare(
      "UPDATE import_batches SET summary_json = ?, analysis_dirty_plan_json = ? WHERE id = 'batch_new_a'"
    ).run(
      JSON.stringify({ routes: { importedRouteCount: 1 } }),
      // 缺 `full` / `domains`：这是"有值但形状不对"，必须拒绝，而不是按缺省放行。
      JSON.stringify({ version: 1 })
    );
    const capture = captureWith(input, {
      targetRawGeneration: 3,
      targetDependencyGeneration: 3,
      registeredPlan: {
        dirtyFromAt: BOUNDARY_NEW_A,
        domains: { features: BOUNDARY_NEW_A, fitness: BOUNDARY_NEW_A, readiness: BOUNDARY_NEW_A }
      },
      registeredBatchIds: ["batch_new_a", "batch_new_b"]
    });
    assert.equal(capture.plan, null, "证据损坏时必须全量");
    assert.equal(capture.planAdjustment, "route_evidence_unmerged");
    capture.facts.dispose();
  });
});

test("B05：证据说 full 的批次让合并计划保持全量（不冒充 partial）", async () => {
  await withFixture((input, writer) => {
    seedReleaseBaseline(writer);
    writer.prepare(
      "UPDATE import_batches SET summary_json = ?, analysis_dirty_plan_json = ? WHERE id = 'batch_new_a'"
    ).run(
      JSON.stringify({ routes: { importedRouteCount: 1 } }),
      JSON.stringify({
        version: 1,
        full: true,
        dirtyFromAt: null,
        domains: { features: null, fitness: null, readiness: null },
        routeDirtyTimes: [],
        recoveryBoundaries: [],
        reasons: ["invalid_health_interval"]
      })
    );
    const capture = captureWith(input, {
      targetRawGeneration: 3,
      targetDependencyGeneration: 3,
      registeredPlan: {
        dirtyFromAt: BOUNDARY_NEW_A,
        domains: { features: BOUNDARY_NEW_A, fitness: BOUNDARY_NEW_A, readiness: BOUNDARY_NEW_A }
      },
      registeredBatchIds: ["batch_new_a", "batch_new_b"]
    });
    assert.equal(capture.plan, null);
    assert.equal(capture.planAdjustment, "route_evidence_unmerged");
    capture.facts.dispose();
  });
});

test("兼容路径：库里存在既未登记、也无可归因归属的影响批次 ⇒ 保守全量（coverage_unverifiable）", async () => {
  await withFixture((input) => {
    // 场景：覆盖任务的登记批次只有两个新批，但库里还有 `batch_old`（时间窗/上限之外的
    // 未入选批次）。没有可信基线可证明它的 dirty 已被覆盖 ⇒ 不允许 partial 冒认。
    const capture = captureWith(input, {
      targetRawGeneration: 3,
      targetDependencyGeneration: 3,
      registeredPlan: {
        dirtyFromAt: BOUNDARY_NEW_A,
        domains: { features: BOUNDARY_NEW_A, fitness: BOUNDARY_NEW_A, readiness: BOUNDARY_NEW_A }
      },
      registeredBatchIds: ["batch_new_a", "batch_new_b"]
    });
    assert.equal(capture.plan, null, "不能证明完整覆盖时必须全量，而不是伪造较小的计划边界");
    assert.equal(capture.planAdjustment, "coverage_unverifiable");
    capture.facts.dispose();
  });
});
