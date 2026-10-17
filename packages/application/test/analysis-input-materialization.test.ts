// O06-A / WP-22 步骤 3–5：**固定输入**的事实视图（物化快照 / 分段校验读）。
//
// 为什么必须有这条用例：WP-22a 只固定了"绑定"，事实本身仍从写连接懒读。于是"这一版算的是什么"
// 有书面证据，而 CPU 阶段真正读到的却可能是下一版 —— 两者的差值恰好会被
// `verifyAndPoint` 的 dataset 判据当成"中介批次"拒掉，而不是被当成"混代候选"。
// 这条用例钉住三件事：
//   ① 物化是**在捕获的那个读事务里**完成的，事务随即关闭（快照固定、无长读事务）；
//   ② 超过预算**不**退化成无限读，而是分段读 + 每条读核对依赖绑定；
//   ③ 分段读一旦看到依赖代次前进就抛 `AnalysisInputDriftError`（候选作废而不是拼接），
//      而 raw-only 前进**只留痕**（判据是依赖绑定，与发布端 D4 同一口径）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AnalysisInputDriftError,
  AnalysisInputReadBudgetExceeded,
  DEFAULT_ANALYSIS_INPUT_BUDGET,
  RECORDS_MAX_LOOKBACK_MS,
  SNAPSHOT_TABLES,
  SqliteAnalysisInputReader,
  buildFactTableFilters,
  probeFactSize,
  type AnalysisInputBudget
} from "../src/index.js";
import { RaiDatabase } from "@rai/storage-sqlite";

const SMALL_BUDGET: AnalysisInputBudget = {
  maxRows: 1,
  maxBytes: 1,
  maxReadRows: 10_000,
  maxReadMs: 60_000
};

function seed(database: DatabaseSync): void {
  database.prepare("INSERT INTO import_manifest (key, value) VALUES ('dataset_version', ?)")
    .run("dataset_fixture_v1");
  database.prepare("INSERT INTO profile (id, attributes_json) VALUES (1, ?)")
    .run(JSON.stringify({ HKCharacteristicTypeIdentifierDateOfBirth: "1990-05-06T00:00:00Z" }));
  const record = database.prepare(`INSERT INTO health_records
    (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
     start_at, end_at, created_at, metadata_json, raw_attributes_json)
    VALUES (?, ?, 'Fixture Watch', 'apple_watch', '1', 'Watch', 'count/min', ?, NULL, ?, ?, ?, '{}', '{}')`);
  record.run("record_rhr_1", "HKQuantityTypeIdentifierRestingHeartRate", 48,
    "2025-01-02T22:00:00.000Z", "2025-01-02T22:05:00.000Z", "2025-01-02T22:06:00.000Z");
  record.run("record_rhr_2", "HKQuantityTypeIdentifierRestingHeartRate", 52,
    "2025-01-05T22:00:00.000Z", "2025-01-05T22:05:00.000Z", "2025-01-05T22:06:00.000Z");
  record.run("record_hr_1", "HKQuantityTypeIdentifierHeartRate", 142,
    "2025-01-04T09:00:00.000Z", "2025-01-04T09:00:10.000Z", "2025-01-04T09:01:00.000Z");
  database.prepare(`INSERT INTO workouts
    (id, activity_type, source_name, source_category, source_version, device, start_at, end_at, created_at,
     duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
    VALUES ('workout_1', 'HKWorkoutActivityTypeRunning', 'Fixture Watch', 'apple_watch', '1', 'Watch',
      '2025-01-04T09:00:00.000Z', '2025-01-04T09:30:00.000Z', '2025-01-04T09:31:00.000Z',
      1800, 0, '{}', '{}', 1)`).run();
  database.prepare(`INSERT INTO training_sessions
    (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
    VALUES ('session_1', 'HKWorkoutActivityTypeRunning', '2025-01-04T09:00:00.000Z',
      '2025-01-04T09:30:00.000Z', 5, 'workout_1', 'active')`).run();
  database.prepare(`INSERT INTO workout_statistics
    (workout_id, ordinal, type, unit, sum_value, average_value, minimum_value, maximum_value)
    VALUES ('workout_1', 0, 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'km', 5, NULL, NULL, NULL)`).run();
  database.prepare(`INSERT INTO canonical_nights
    (id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank, has_stages,
     sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
     stage_minutes_json, segment_count, provenance_json, computed_at)
    VALUES ('night_1', '2025-01-04', 'UTC', 'main', 'Fixture Watch', 'apple_watch', 1, 1,
      '2025-01-03T22:30:00.000Z', '2025-01-04T06:30:00.000Z', 450, 470, 20, '{}', 5, '{}',
      '2025-01-04T07:00:00.000Z')`).run();
  database.prepare(`INSERT INTO canonical_hrv_days
    (id, local_date, timezone_identifier, night_id, hrv_sdnn_ms, sample_count, confidence,
     window_start_at, window_end_at, source_name, provenance_json, computed_at)
    VALUES ('hrv_1', '2025-01-04', 'UTC', 'night_1', 55, 12, 'confident',
      '2025-01-04T05:00:00.000Z', '2025-01-04T06:00:00.000Z', 'Fixture Watch', '{}',
      '2025-01-04T07:00:00.000Z')`).run();
  database.prepare(`INSERT INTO workout_overrides
    (id, training_session_id, revision, eligibility_override, session_type, rpe, condition_tags_json, note)
    VALUES ('override_1', 'session_1', 1, 'include', 'easy', 4, '[]', NULL)`).run();
  database.prepare(`INSERT INTO training_zone_profile_settings
    (id, revision, effective_from_local_date, resting_mode, resting_value_bpm,
     maximum_mode, maximum_value_bpm, threshold_pace_mode, threshold_pace_seconds_per_km)
    VALUES ('zone_settings_1', 1, '2025-01-01', 'manual', 50, 'manual', 190, 'manual', 300)`).run();
}

async function withFixture<T>(run: (input: DatabaseSync, writer: DatabaseSync) => T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rai-input-materialization-"));
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

function captureWith(input: DatabaseSync, budget?: AnalysisInputBudget) {
  const reader = new SqliteAnalysisInputReader(input, "direct-sync", budget);
  return reader.capture({
    runId: "",
    jobId: "job_fixture",
    scope: "direct-sync",
    timezoneIdentifier: "UTC",
    evaluatedAt: "2025-01-10T00:00:00.000Z",
    targetRawGeneration: null,
    targetDependencyGeneration: null,
    expectedIncumbentReleaseId: null,
    registeredPlan: null
  });
}

/** 读事务是否还开着：SQLite 不允许嵌套 `BEGIN`，所以这条检查就是"事务已关闭"的结构性证据。 */
function assertNoOpenTransaction(input: DatabaseSync, label: string): void {
  input.exec("BEGIN DEFERRED");
  input.exec("ROLLBACK");
  assert.ok(true, label);
}

test("物化模式：事实在捕获的同一个读事务里复制，事务随即关闭，之后源库变化看不见", async () => {
  await withFixture((input, writer) => {
    const capture = captureWith(input);
    assert.equal(capture.materialization.mode, "materialized");
    assert.equal(capture.materialization.reason, null);
    assert.equal(capture.binding.capturedRawGeneration, 0);

    const view = capture.facts;
    const records = () => view.database.prepare(
      "SELECT COUNT(*) AS n FROM health_records"
    ).get() as { n: number };
    assert.equal(Number(records().n), 3, "快照必须包含捕获那一刻的全部事实行");

    // ① 读事务已关闭（没有"整段 CPU 期间握着读快照"）。
    assertNoOpenTransaction(input, "捕获结束后不得留下读事务");

    // ② 源库在捕获之后变化：快照**看不见**（输入被固定），活连接看得见。
    writer.prepare(`INSERT INTO health_records
      (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
       start_at, end_at, created_at, metadata_json, raw_attributes_json)
      VALUES ('record_late', 'HKQuantityTypeIdentifierRestingHeartRate', 'Fixture Watch', 'apple_watch',
        '1', 'Watch', 'count/min', 60, NULL, '2025-01-06T22:00:00.000Z', '2025-01-06T22:05:00.000Z',
        '2025-01-06T22:06:00.000Z', '{}', '{}')`).run();
    assert.equal(Number(records().n), 3, "快照必须固定在捕获那一版（这正是 O06 的病灶）");
    assert.equal(Number((input.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number }).n), 4);

    // ③ 覆盖范围是**全量事实**而不是只有心率：训练／统计／夜间恢复／override／设置都在快照里。
    assert.equal(Number((view.database.prepare("SELECT COUNT(*) AS n FROM workouts").get() as { n: number }).n), 1);
    assert.equal(Number((view.database.prepare("SELECT COUNT(*) AS n FROM training_sessions").get() as { n: number }).n), 1);
    assert.equal(Number((view.database.prepare("SELECT COUNT(*) AS n FROM workout_statistics").get() as { n: number }).n), 1);
    assert.equal(Number((view.database.prepare("SELECT COUNT(*) AS n FROM canonical_nights").get() as { n: number }).n), 1);
    assert.equal(Number((view.database.prepare("SELECT COUNT(*) AS n FROM canonical_hrv_days").get() as { n: number }).n), 1);
    assert.equal(Number((view.database.prepare("SELECT COUNT(*) AS n FROM effective_workout_overrides").get() as { n: number }).n), 1);
    assert.equal(Number((view.database.prepare("SELECT COUNT(*) AS n FROM training_zone_profile_settings").get() as { n: number }).n), 1);
    assert.equal(Number((view.database.prepare("SELECT COUNT(*) AS n FROM profile").get() as { n: number }).n), 1);
    assert.equal((view.database.prepare("SELECT value FROM import_manifest WHERE key='dataset_version'").get() as { value: string }).value,
      "dataset_fixture_v1");

    // ④ 快照是**副本**：在它上面改动不得动到源库（事实视图不承担写路径）。
    view.database.exec("DELETE FROM health_records");
    assert.equal(
      Number((input.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number }).n),
      4,
      "内存快照与源库必须彼此隔离"
    );

    view.dispose();
  });
});

test("超过预算：转为分段读（不是无限读），读数仍然完整且每条读之后不留事务", async () => {
  await withFixture((input) => {
    const capture = captureWith(input, SMALL_BUDGET);
    assert.equal(capture.materialization.mode, "segmented");
    assert.equal(capture.materialization.reason, "fact_rows_exceed_budget");
    assert.ok(capture.materialization.tables >= 10, "预算探针必须覆盖整份事实清单，而不是只数心率表");

    const view = capture.facts;
    const rows = view.database.prepare(
      "SELECT id FROM health_records ORDER BY id"
    ).all() as Array<{ id: string }>;
    assert.deepEqual(rows.map((row) => row.id), ["record_hr_1", "record_rhr_1", "record_rhr_2"]);
    assert.equal(
      (view.database.prepare("SELECT asleep_union_minutes AS value FROM canonical_nights WHERE id='night_1'")
        .get() as { value: number }).value,
      450
    );
    assertNoOpenTransaction(input, "分段读结束之后不得留下读事务");
    const stats = view.stats();
    assert.equal(stats.mode, "segmented");
    assert.ok(stats.reads >= 2);
    assert.deepEqual(stats.nearLimit, [], "预算内的读不该被记为接近上限");
    view.dispose();
  });
});

test("分段模式：单条读越过 maxReadRows 直接失败，绝不截断后当完整输入计算", async () => {
  await withFixture((input) => {
    const capture = captureWith(input, { ...SMALL_BUDGET, maxReadRows: 1 });
    assert.equal(capture.facts.mode, "segmented");
    // 旧行为是"记一条 overrun 然后照常返回全部行"。那等于没有上限：调用方会把一份
    // 可能已经吃掉几百 MB 的结果当成完整输入继续算。
    assert.throws(
      () => capture.facts.database.prepare("SELECT id FROM health_records").all(),
      (error: unknown) => error instanceof AnalysisInputReadBudgetExceeded
        && error.detail.table === "health_records"
    );
    capture.facts.dispose();
  });
});

test("分段模式：依赖代次前进 ⇒ 抛 AnalysisInputDriftError（候选作废，不拼接）", async () => {
  await withFixture((input, writer) => {
    const capture = captureWith(input, SMALL_BUDGET);
    assert.equal(capture.facts.mode, "segmented");
    // 先证明这一版的读是通的。
    assert.equal(
      Number((capture.facts.database.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number }).n),
      3
    );
    // 下一批导入推进了**依赖**代次：绑定变了。
    writer.prepare(`UPDATE import_generations SET raw_generation = 1, dependency_generation = 1 WHERE singleton = 1`).run();
    assert.throws(
      () => capture.facts.database.prepare("SELECT COUNT(*) AS n FROM health_records").get(),
      (error: unknown) => error instanceof AnalysisInputDriftError &&
        error.name === "AnalysisInputDriftError" &&
        /read|stage/.test(error.stage)
    );
    // 段间判据同样转红（不是只有"下一次读"才看得到）。
    assert.throws(() => capture.facts.assertPinned("stage:features"), AnalysisInputDriftError);
    capture.facts.dispose();
  });
});

test("分段模式：只有 raw 前进 ⇒ 不作废，但必须逐条留痕（判据是依赖绑定）", async () => {
  await withFixture((input, writer) => {
    const capture = captureWith(input, SMALL_BUDGET);
    writer.prepare(`UPDATE import_generations SET raw_generation = 7, dependency_generation = 0 WHERE singleton = 1`).run();
    const count = capture.facts.database.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number };
    assert.equal(Number(count.n), 3, "raw-only 批次不动依赖 ⇒ 与发布端 D4 同一结论：不构成混代");
    const stats = capture.facts.stats();
    assert.ok(stats.rawAdvances.length > 0, "raw 前进必须留痕，不能悄悄放过");
    assert.deepEqual(stats.observedGenerations, ["0/0@health_records"]);
    capture.facts.dispose();
  });
});

test("漂移重排：mergeFromRawGeneration 把'那一代之后'的账本并进计划", async () => {
  await withFixture((input, writer) => {
    // 一批推进了**依赖**代次的导入：它改了评分输入（记录时间更正）。
    writer.prepare(`INSERT INTO import_batches (id, xml_sha256, status, import_mode, created_at,
      raw_generation, dependency_generation, dependency_bumped)
      VALUES ('batch_1', ?, 'succeeded', 'incremental', '2025-01-06T00:00:00.000Z', 1, 1, 1)`)
      .run("0".repeat(64));
    writer.prepare(`INSERT INTO import_entity_changes
      (batch_id, entity_kind, entity_id, change_type, effective_at)
      VALUES ('batch_1', 'record', 'record_hr_1', 'updated', '2025-01-04T09:00:00.000Z')`).run();
    writer.prepare("UPDATE import_generations SET raw_generation = 1, dependency_generation = 1 WHERE singleton = 1").run();

    const reader = new SqliteAnalysisInputReader(input, "direct-sync");
    const capture = reader.capture({
      runId: "", jobId: "job_replan", scope: "direct-sync", timezoneIdentifier: "UTC",
      evaluatedAt: "2025-01-10T00:00:00.000Z",
      targetRawGeneration: 0, targetDependencyGeneration: 0,
      expectedIncumbentReleaseId: null, registeredPlan: null,
      mergeFromRawGeneration: 0
    });
    assert.equal(capture.planAdjustment, "coverage_merged");
    assert.deepEqual(capture.mergedBatchIds, ["batch_1"]);
    assert.equal(capture.plan?.dirtyFromAt, "2025-01-04T09:00:00.000Z");
    capture.facts.dispose();
  });
});

test("漂移重排：raw-only 批次不产出可复用边界 ⇒ 显式 coverage_gap（全量），绝不静默复用", async () => {
  await withFixture((input, writer) => {
    writer.prepare(`INSERT INTO import_batches (id, xml_sha256, status, import_mode, created_at,
      raw_generation, dependency_generation, dependency_bumped)
      VALUES ('batch_raw_only', ?, 'succeeded', 'incremental', '2025-01-06T00:00:00.000Z', 1, 0, 0)`)
      .run("0".repeat(64));
    writer.prepare(`INSERT INTO import_entity_changes
      (batch_id, entity_kind, entity_id, change_type, effective_at)
      VALUES ('batch_raw_only', 'record', 'record_hr_1', 'updated', '2025-01-04T09:00:00.000Z')`).run();
    writer.prepare("UPDATE import_generations SET raw_generation = 1, dependency_generation = 0 WHERE singleton = 1").run();

    const reader = new SqliteAnalysisInputReader(input, "direct-sync");
    const capture = reader.capture({
      runId: "", jobId: "job_replan", scope: "direct-sync", timezoneIdentifier: "UTC",
      evaluatedAt: "2025-01-10T00:00:00.000Z",
      targetRawGeneration: 0, targetDependencyGeneration: 0,
      expectedIncumbentReleaseId: null, registeredPlan: null,
      mergeFromRawGeneration: 0
    });
    // raw-only 批次按 D4 不算"动了分析输入"，因此合并集为空 ⇒ 没有可复用边界。
    // 结果是**显式的** coverage_gap（全量重算），不是拿着旧 dirty 继续走 partial。
    assert.equal(capture.planAdjustment, "coverage_gap");
    assert.equal(capture.plan, null);
    assert.deepEqual(capture.mergedBatchIds, []);
    capture.facts.dispose();
  });
});

test("预算探针：行数与字节都按事实清单统计（不是只数一张表）", async () => {
  await withFixture((input) => {
    const probe = probeFactSize(input);
    assert.ok(probe.rows >= 9, `事实清单行数被低估：${probe.rows}`);
    assert.ok(probe.bytes > probe.rows * 32, "字节必须把文本列长度算进去");
    assert.ok(probe.tables >= 10);
  });
});

// ===================== R06（2026-10-16 复查）：有界探针与快照索引 =====================
//
// 复查证据："输入捕获复制全部历史事实，内存快照还丢失查询索引" —— 两半各自可独立证伪：
// ① 探针在行数超限后仍然把每个表的文本列 `SUM(LENGTH(...))` 全部扫完（"为了判断是否超限
//    又把全部历史扫一遍"）；② 快照只重放表 DDL、不重放索引 ⇒ 区间查询在快照里退化成 SCAN。
// 本组只覆盖这两半；**裁剪物化（只复制必要行）属未实施项**（见实施文档 §0：不得计入
// 增量性能达标）。

test("R06：预算探针有界 —— 行数超限后不再做任何 SUM(LENGTH)，并如实标记下界", async () => {
  await withFixture((input) => {
    const bounded = probeFactSize(input, undefined, { stopAfterRows: 0 });
    assert.equal(bounded.bytesExact, false, "行数一超限就必须标记字节是下界");
    // 超限后**唯一的字节来源是行开销**（`SUM(LENGTH(...))` 一个都没做）。
    assert.equal(
      bounded.bytes, bounded.rows * 32,
      `超限后不得再做文本列扫描（bytes=${bounded.bytes}, rows=${bounded.rows}）`
    );
    // 表级 COUNT 仍覆盖全清单（"看过哪些表"是审计字段，且计数走最小索引、便宜）。
    const unbounded = probeFactSize(input);
    assert.equal(unbounded.bytesExact, true);
    assert.ok(unbounded.tables >= 10, "无界探针仍覆盖整份事实清单");
    assert.equal(bounded.tables, unbounded.tables, "超限只跳过文本扫描，不减表级覆盖");
    assert.ok(unbounded.bytes > bounded.bytes, "无界探针的字节必须把文本列长度算进去");
  });
});

// ===================== R06（2026-10-17）：裁剪物化（只复制必要行） =====================
//
// 复查证据：输入捕获复制**全部**历史事实 ⇒ 捕获行数随全历史近似线性增长（1 万条约 253ms、
// 10 万条约 2,242ms）。修法 = 按覆盖计划把事实裁到"必要窗口"，并用 pipeline 侧的覆盖守卫
// 兜住"裁错"的后果（越界 ⇒ 显式失败 + 关闭裁剪重捕获一次）。本组钉四件事：
//   ① 逐域边界 → 表级谓词的推导只有一处实现，字面值可写死比对；
//   ② 快照**确实少行**，且少掉的都是"从不被读"的行；被保留的读口一个不少；
//   ③ 每个真实读口在裁剪/全量两个快照上给出**逐位相同**的结果（逐查询等价性）；
//   ④ T11：相同必要窗口下历史 ×10 ⇒ 捕获行数**不**近似 ×10（全量模式必须近似 ×10，形成对照）。

/** 覆盖计划夹具：边界 = 夹具里那次训练的开始时刻（2025-01-04）。 */
const PRUNE_BOUNDARY = "2025-01-04T00:00:00.000Z";
const PRUNE_PLAN = {
  dirtyFromAt: PRUNE_BOUNDARY,
  domains: { features: PRUNE_BOUNDARY, fitness: PRUNE_BOUNDARY, readiness: null }
};

function captureWithPlan(
  input: DatabaseSync,
  plan: typeof PRUNE_PLAN | null,
  options: { budget?: AnalysisInputBudget; disableFactPruning?: boolean } = {}
) {
  const reader = new SqliteAnalysisInputReader(input, "direct-sync", options.budget ?? DEFAULT_ANALYSIS_INPUT_BUDGET);
  return reader.capture({
    runId: "",
    jobId: "job_prune_fixture",
    scope: "direct-sync",
    timezoneIdentifier: "UTC",
    evaluatedAt: "2025-01-10T00:00:00.000Z",
    targetRawGeneration: null,
    targetDependencyGeneration: null,
    expectedIncumbentReleaseId: null,
    registeredPlan: plan,
    ...(options.disableFactPruning === true ? { disableFactPruning: true } : {})
  });
}

/**
 * 追加一段"老历史"（2023 年初），四类行各一条 + 一场老训练与它的路线点。
 *
 * 关键布置：**全局最早的一条是心率明细**（2023-01-05），它必须被裁掉 ——
 * 于是"快照自己的 `MIN(start_at)`"与"全局最早"在裁剪之后**不再相等**。
 * 这正是占位查询（`sourceBackfillEvidence` / 发布 gate）必须改用捕获证据的原因。
 */
function seedOldHistory(database: DatabaseSync): void {
  const insertRecord = database.prepare(`INSERT INTO health_records
    (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
     start_at, end_at, created_at, metadata_json, raw_attributes_json)
    VALUES (?, ?, 'Fixture Watch', 'apple_watch', '1', 'Watch', 'count/min', ?, NULL, ?, ?, ?, '{}', '{}')`);
  insertRecord.run("record_old_hr", "HKQuantityTypeIdentifierHeartRate", 138,
    "2023-01-05T09:10:00.000Z", "2023-01-05T09:10:10.000Z", "2023-01-05T09:11:00.000Z");
  insertRecord.run("record_old_rhr", "HKQuantityTypeIdentifierRestingHeartRate", 51,
    "2023-01-11T22:00:00.000Z", "2023-01-11T22:05:00.000Z", "2023-01-11T22:06:00.000Z");
  insertRecord.run("record_old_vo2", "HKQuantityTypeIdentifierVO2Max", 52,
    "2023-01-12T09:00:00.000Z", "2023-01-12T09:00:00.000Z", "2023-01-12T09:01:00.000Z");
  insertRecord.run("record_old_body_mass", "HKQuantityTypeIdentifierBodyMass", 70,
    "2023-01-13T09:00:00.000Z", "2023-01-13T09:00:00.000Z", "2023-01-13T09:01:00.000Z");
  database.prepare(`INSERT INTO workouts
    (id, activity_type, source_name, source_category, source_version, device, start_at, end_at, created_at,
     duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
    VALUES ('workout_old', 'HKWorkoutActivityTypeRunning', 'Fixture Watch', 'apple_watch', '1', 'Watch',
      '2023-06-01T09:00:00.000Z', '2023-06-01T09:30:00.000Z', '2023-06-01T09:31:00.000Z',
      1800, 0, '{}', '{}', 1)`).run();
  database.prepare(`INSERT INTO training_sessions
    (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
    VALUES ('session_old', 'HKWorkoutActivityTypeRunning', '2023-06-01T09:00:00.000Z',
      '2023-06-01T09:30:00.000Z', 5, 'workout_old', 'active')`).run();
  insertRoute(database, "route_old", "workout_old", 3, 100);
  insertRoute(database, "route_new", "workout_1", 3, 0);
}

/** 一条可读路线（legacy 分支：指针为 NULL + `file_status='imported'` + `point_count>0`）。 */
function insertRoute(database: DatabaseSync, routeId: string, workoutId: string, points: number, sequenceBase: number): void {
  database.prepare(`INSERT INTO workout_routes
    (id, workout_id, source_name, source_category, source_version, start_at, end_at, created_at,
     relative_path, metadata_json, point_count, file_status)
    VALUES (?, ?, 'Fixture Watch', 'apple_watch', '1', NULL, NULL, '2023-01-01T00:00:00.000Z', ?, '{}', ?, 'imported')`)
    .run(routeId, workoutId, `routes/${routeId}.gpx`, points);
  const insertPoint = database.prepare(`INSERT INTO route_points
    (route_id, sequence, timestamp, latitude, longitude, elevation_meters, speed_mps, course_degrees,
     horizontal_accuracy_meters, vertical_accuracy_meters)
    VALUES (?, ?, ?, 23.1, 113.3, ?, 3.0, 0, 5, 3)`);
  for (let index = 0; index < points; index += 1) {
    insertPoint.run(routeId, sequenceBase + index, "2023-01-01T00:00:00.000Z", 10 + index * 0.5);
  }
}

test("R06：表级谓词只有一处实现 —— 白名单全史 + 明细按回看窗 + 路线点按被算会话", () => {
  const coverage = { recordsFrom: "2023-07-09T00:00:00.000Z", routeFrom: "2025-01-03T00:00:00.000Z" };
  const filters = buildFactTableFilters(coverage, "HKWorkoutActivityTypeRunning");
  assert.deepEqual([...filters.keys()].sort(), ["health_records", "route_points", "route_version_points"]);
  const records = filters.get("health_records")!;
  assert.equal(
    records.where,
    "type IN (?, ?) OR (type IN (?, ?) AND start_at >= ?)",
    "谓词形状必须同时表达'白名单全史'与'窗口类型起算点'"
  );
  assert.deepEqual(records.params, [
    "HKQuantityTypeIdentifierRestingHeartRate", "HKQuantityTypeIdentifierVO2Max",
    "HKQuantityTypeIdentifierHeartRate", "HKQuantityTypeIdentifierRunningSpeed",
    coverage.recordsFrom
  ]);
  // 会话口径必须与 `listActiveForFeatures` 逐字一致（抄一份字面量就是下一次静默分叉）。
  for (const table of ["route_points", "route_version_points"] as const) {
    const route = filters.get(table)!;
    assert.match(route.where, /session\.activity_type = \? AND session\.status IN \('active', 'ambiguous'\)/);
    assert.match(route.where, /workout\.start_at >= \?/);
    assert.deepEqual(route.params, ["HKWorkoutActivityTypeRunning", coverage.routeFrom]);
  }
  // 边界本身：545 天 + 1 天，字面值写死（改小常量必须让这条测试红）。
  assert.equal(RECORDS_MAX_LOOKBACK_MS, 545 * 86_400_000);
});

test("R06：裁剪物化只复制必要行，且全局最早证据改由捕获值提供（不再照读被裁快照的 MIN）", async () => {
  await withFixture((input, writer) => {
    seedOldHistory(writer);
    const capture = captureWithPlan(input, PRUNE_PLAN);
    assert.equal(capture.materialization.mode, "materialized");
    assert.deepEqual(capture.materialization.pruning, {
      recordsFrom: "2023-07-09T00:00:00.000Z",
      routeFrom: "2025-01-03T00:00:00.000Z"
    });
    const snapshot = capture.facts.database;
    // ① 白名单类型全史保留；明细类型按 `recordsFrom` 裁；从不被读的类型整类不复制。
    assert.deepEqual(
      (snapshot.prepare("SELECT id FROM health_records ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id),
      ["record_hr_1", "record_old_rhr", "record_old_vo2", "record_rhr_1", "record_rhr_2"],
      "RHR/VO2 必须全史保留（任意 asOf 可重算的证据链），老心率明细与非消费类型必须被裁"
    );
    // ② 路线点：只有"被算会话"（start_at >= routeFrom）名下的点进快照。
    assert.equal(Number((snapshot.prepare("SELECT COUNT(*) AS n FROM route_points").get() as { n: number }).n), 3);
    assert.equal(Number((snapshot.prepare("SELECT COUNT(*) AS n FROM route_points WHERE route_id='route_old'").get() as { n: number }).n), 0);
    assert.equal(Number((snapshot.prepare("SELECT COUNT(*) AS n FROM readable_route_points WHERE route_id='route_new'").get() as { n: number }).n), 3);
    // ③ 🔴 全局最早：被裁快照自己的 MIN 已经不是全局最早（老心率被裁）——
    //    所以"是不是这一批把时间线推向更早"的判据必须用捕获值，不能照读快照。
    const snapshotEarliest = snapshot.prepare(
      "SELECT id FROM health_records WHERE start_at = (SELECT MIN(start_at) FROM health_records) LIMIT 1"
    ).get() as { id: string } | undefined;
    assert.equal(snapshotEarliest?.id, "record_old_rhr", "前提：被裁快照的 MIN 已经是'留下的最早的'");
    assert.equal(capture.facts.snapshotCoverage?.globalEarliestRecordId, "record_old_hr",
      "覆盖元数据必须携带**捕获读事务**里算出的全局最早行（与运行期查询逐字同 SQL）");
    // ④ 少复制了多少：与不裁剪的对照同一份夹具。
    const full = captureWithPlan(input, PRUNE_PLAN, { disableFactPruning: true });
    assert.equal(full.materialization.pruning, null);
    assert.equal(full.facts.snapshotCoverage?.recordsFrom, null);
    assert.ok(
      capture.materialization.rows < full.materialization.rows,
      `裁剪必须真的少复制行（裁剪 ${capture.materialization.rows} vs 全量 ${full.materialization.rows}）`
    );
    full.facts.dispose();
    capture.facts.dispose();
  });
});

test("R06：逐查询等价性 —— 每个真实读口在裁剪/全量两个快照上给出同一结果", async () => {
  await withFixture((input, writer) => {
    seedOldHistory(writer);
    const pruned = captureWithPlan(input, PRUNE_PLAN);
    const full = captureWithPlan(input, PRUNE_PLAN, { disableFactPruning: true });
    const read = (database: DatabaseSync, sql: string, ...params: string[]): unknown =>
      database.prepare(sql).all(...params);
    // ① `queryRecordSeries`（装配缓存的唯一取数口）：被算会话窗内的去重明细。
    const series = `SELECT DISTINCT value_numeric AS value, start_at AS startAt, end_at AS endAt
      FROM health_records WHERE source_name = ? AND type = ? AND value_numeric IS NOT NULL
        AND start_at <= ? AND end_at >= ? ORDER BY start_at`;
    assert.deepEqual(
      read(pruned.facts.database, series, "Fixture Watch", "HKQuantityTypeIdentifierHeartRate",
        "2025-01-04T09:30:00.000Z", "2025-01-04T09:00:00.000Z"),
      read(full.facts.database, series, "Fixture Watch", "HKQuantityTypeIdentifierHeartRate",
        "2025-01-04T09:30:00.000Z", "2025-01-04T09:00:00.000Z")
    );
    // ② `loadObservedMaximumHeartRate`：训练起点 - 180 天的最大心率（特征阶段）。
    const peak = `SELECT MAX(value_numeric) AS value FROM health_records
      WHERE type = ? AND value_numeric IS NOT NULL AND start_at >= ? AND start_at < ?`;
    assert.deepEqual(
      read(pruned.facts.database, peak, "HKQuantityTypeIdentifierHeartRate",
        "2024-07-08T09:00:00.000Z", "2025-01-04T09:00:00.000Z"),
      read(full.facts.database, peak, "HKQuantityTypeIdentifierHeartRate",
        "2024-07-08T09:00:00.000Z", "2025-01-04T09:00:00.000Z")
    );
    // ③ `loadRestingHeartRateEvidence`：全史静息心率（白名单类型不受裁剪影响）。
    const rhr = `SELECT value_numeric AS valueBpm, start_at AS observedAt FROM health_records
      WHERE type = ? AND value_numeric IS NOT NULL AND start_at < ? ORDER BY start_at`;
    assert.deepEqual(
      read(pruned.facts.database, rhr, "HKQuantityTypeIdentifierRestingHeartRate", "2025-01-10T00:00:00.000Z"),
      read(full.facts.database, rhr, "HKQuantityTypeIdentifierRestingHeartRate", "2025-01-10T00:00:00.000Z")
    );
    // ④ 路线质量/高程（`SqliteRoutePointReader` 两个取数口）走唯一入口 `readable_route_points`。
    const points = `SELECT sequence, latitude, longitude, elevation_meters, horizontal_accuracy_meters
      FROM readable_route_points WHERE route_id = ? ORDER BY sequence`;
    assert.deepEqual(
      read(pruned.facts.database, points, "route_new"),
      read(full.facts.database, points, "route_new")
    );
    // ⑤ 老会话窗内的明细：两侧都读不到**老心率**（裁剪侧因为被裁，全量侧因为窗口不含它）。
    //    这条同时证明"被裁的行确实从不被读"。
    const oldWindow = read(pruned.facts.database, series, "Fixture Watch", "HKQuantityTypeIdentifierHeartRate",
      "2023-01-05T09:10:10.000Z", "2023-01-05T09:10:00.000Z");
    assert.equal((oldWindow as unknown[]).length, 0, "老心率明细在裁剪快照里必须读不到");
    assert.notEqual(
      (read(full.facts.database, "SELECT id FROM health_records WHERE id='record_old_hr'") as unknown[]).length, 0,
      "前提：全量快照里那条老心率还在（否则④⑤两条就没有判据）"
    );
    full.facts.dispose();
    pruned.facts.dispose();
  });
});

test("R06 T11：相同必要窗口下历史 ×10 ⇒ 捕获行数不近似 ×10（全量模式形成对照）", async () => {
  await withFixture((input, writer) => {
    seedOldHistory(writer);
    // 老历史的"体量"：每条记录 1 行心率明细 + 1 个路线点（都在必要窗口之外）。
    const addHistory = (count: number): void => {
      const insertRecord = writer.prepare(`INSERT INTO health_records
        (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
         start_at, end_at, created_at, metadata_json, raw_attributes_json)
        VALUES (?, 'HKQuantityTypeIdentifierHeartRate', 'Fixture Watch', 'apple_watch', '1', 'Watch',
          'count/min', 130, NULL, ?, ?, ?, '{}', '{}')`);
      const insertPoint = writer.prepare(`INSERT INTO route_points
        (route_id, sequence, timestamp, latitude, longitude, elevation_meters, speed_mps, course_degrees,
         horizontal_accuracy_meters, vertical_accuracy_meters)
        VALUES ('route_old', ?, '2023-01-01T00:00:00.000Z', 23.1, 113.3, 10, 3.0, 0, 5, 3)`);
      const base = Date.parse("2022-01-01T00:00:00.000Z");
      for (let index = 0; index < count; index += 1) {
        const at = new Date(base + index * 3_600_000).toISOString();
        insertRecord.run(`record_bulk_${count}_${index}`, at, at, at);
        insertPoint.run(1000 + count * 10 + index);
      }
    };
    addHistory(100);
    const prunedSmall = captureWithPlan(input, PRUNE_PLAN);
    const fullSmall = captureWithPlan(input, PRUNE_PLAN, { disableFactPruning: true });
    addHistory(900);
    const prunedBig = captureWithPlan(input, PRUNE_PLAN);
    const fullBig = captureWithPlan(input, PRUNE_PLAN, { disableFactPruning: true });
    const rows = {
      prunedSmall: prunedSmall.materialization.rows,
      prunedBig: prunedBig.materialization.rows,
      fullSmall: fullSmall.materialization.rows,
      fullBig: fullBig.materialization.rows
    };
    for (const capture of [prunedSmall, fullSmall, prunedBig, fullBig]) capture.facts.dispose();
    // 对照：全量模式必须随历史近似线性增长 —— 否则"裁剪模式没长"可能只是因为夹具没长肉。
    assert.ok(
      rows.fullBig > rows.fullSmall * 8,
      `前提（对照）：全量捕获必须随历史增长（${rows.fullSmall} → ${rows.fullBig}）`
    );
    // T11 判据：裁剪模式的捕获行数不随历史近似线性增长。
    assert.ok(
      rows.prunedBig < rows.prunedSmall * 2,
      `T11：历史 ×10 时捕获行数不得近似 ×10（${rows.prunedSmall} → ${rows.prunedBig}；全量 ${rows.fullSmall} → ${rows.fullBig}）`
    );
  });
});

test("R06：全量计划（或显式禁用裁剪）⇒ 不裁剪、不产生覆盖元数据（与旧行为逐字节相同）", async () => {
  await withFixture((input) => {
    const full = captureWithPlan(input, null);
    assert.equal(full.materialization.pruning, null);
    assert.deepEqual(full.facts.snapshotCoverage, {
      recordsFrom: null, routeFrom: null, globalEarliestRecordId: "record_rhr_1"
    });
    const disabled = captureWithPlan(input, PRUNE_PLAN, { disableFactPruning: true });
    assert.equal(disabled.materialization.pruning, null);
    assert.equal(disabled.facts.snapshotCoverage?.recordsFrom, null);
    assert.equal(
      Number((disabled.facts.database.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number }).n),
      Number((full.facts.database.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number }).n),
      "禁用裁剪必须与全量计划复制同一批行"
    );
    full.facts.dispose();
    disabled.facts.dispose();
  });
});

test("R06：物化快照重放源库索引 —— 区间查询与源库走同一索引，不再退化", async () => {
  await withFixture((input) => {
    const capture = captureWith(input);
    const snapshot = capture.facts.database;
    // ① 源库**事实表**上的显式索引必须被完整重放（auto-index 随建表 DDL 生成、不在比对内）。
    const sourceIndexes = (input.prepare(
      "SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL"
    ).all() as Array<{ name: string; tableName: string }>)
      .filter((row) => (SNAPSHOT_TABLES as readonly string[]).includes(row.tableName));
    assert.ok(sourceIndexes.length > 0, "夹具必须至少有一个事实表索引，否则本用例没有判据");
    const snapshotIndexNames = new Set(
      (snapshot.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL"
      ).all() as Array<{ name: string }>).map((row) => row.name)
    );
    for (const index of sourceIndexes) {
      assert.ok(
        snapshotIndexNames.has(index.name),
        `快照缺少索引 ${index.name}（${index.tableName}）—— 区间查询会退化成 SCAN`
      );
    }
    // ② 行为级：源库与快照对同一查询给出**同一个索引**（planner 选择一致）。
    const planOf = (database: typeof snapshot): string =>
      (database.prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM health_records WHERE type = ? AND start_at >= ? ORDER BY start_at LIMIT 5"
      ).all("HKQuantityTypeIdentifierHeartRate", "2025-01-01T00:00:00.000Z") as Array<{ detail: string }>)
        .map((row) => row.detail).join("; ");
    const sourcePlan = planOf(input);
    assert.match(sourcePlan, /USING INDEX idx_health_records_type_time/,
      `前提：源库该查询必须走索引（实际：${sourcePlan}）`);
    const snapshotPlan = planOf(snapshot);
    assert.match(snapshotPlan, /USING INDEX idx_health_records_type_time/,
      `快照必须与源库走同一索引（实际：${snapshotPlan}）`);
    capture.facts.dispose();
  });
});
