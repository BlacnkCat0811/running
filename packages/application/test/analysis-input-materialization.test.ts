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
  SqliteAnalysisInputReader,
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
    assert.deepEqual(stats.overruns, [], "预算内的读不该被记为越界");
    view.dispose();
  });
});

test("分段模式：单条读越过 maxReadRows 只记账上报，绝不截断结果", async () => {
  await withFixture((input) => {
    const capture = captureWith(input, { ...SMALL_BUDGET, maxReadRows: 1 });
    assert.equal(capture.facts.mode, "segmented");
    const rows = capture.facts.database.prepare("SELECT id FROM health_records").all() as unknown[];
    assert.equal(rows.length, 3, "越界不得截断 —— 截断会变成'少读了几行'的错结果");
    assert.ok(
      capture.facts.stats().overruns.some((item) => item.startsWith("rows:3>1:health_records")),
      `越界必须记账：${JSON.stringify(capture.facts.stats().overruns)}`
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
