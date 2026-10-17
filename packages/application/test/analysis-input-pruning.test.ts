// R06（2026-10-17）：裁剪物化的**端到端**判据 —— 等价性、覆盖守卫与消费面清单。
//
// 为什么单独一份：`analysis-input-materialization.test.ts` 证的是"读取器裁得对不对"，
// 而 R06 真正的验收是"**少读数据不得换来错误结果**"（实施文档 §4-R06 验收第 3 条）。
// 所以这里用**两个逐字节相同的合成库**各跑一次增量直连分析：
//   · 一个开着裁剪（R06 的快路径），一个强制关闭裁剪（等价于回退路径）；
//   · 比对五张发布表的语义列（id/时间戳这类每次运行都会变的列除外）——必须逐位一致；
//   · 同时断言"开着裁剪的那次**确实裁了**"：否则这条等价会因为裁剪从未生效而变成空话
//     （同样的道理见纪律 #4：跑绿 ≠ 断言有效）。
//
// 第二条判据是**守卫**：把覆盖边界人为收紧到比任何事实都晚（模拟"裁剪边界算错"这一类
// 缺陷），运行必须显式失败并**关闭裁剪重捕获一次** —— 结果仍然正确，且事件里留下证据。
//
// 夹具全部是合成的（无真实健康数据）；断言只看计数、状态与语义列。

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  FACT_PRUNE_ALWAYS_KEPT_RECORD_TYPES,
  FACT_PRUNE_WINDOWED_RECORD_TYPES,
  RaiApplicationService,
  SnapshotFactView,
  SqliteAnalysisInputReader,
  type AnalysisInputBudget,
  type AnalysisInputCapture,
  type AnalysisInputCaptureRequest
} from "../src/index.js";
import {
  heartRateType,
  restingHeartRateType,
  runningSpeedType
} from "../src/service-types.js";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

const BASELINE_AS_OF = "2025-02-01T00:00:00.000Z";
const BASELINE2_AS_OF = "2025-02-02T00:00:00.000Z";
const INCREMENTAL_AS_OF = "2025-02-08T00:00:00.000Z";
/**
 * 老历史的会话数。**为什么是 30**：模型迁移门（`maxEligibleSessionDelta = 0.05`）按
 * `|base - candidate| / base` 判合格会话数的变化，而增量批要新增 1 场训练 ⇒ 需要
 * `1/(N-6) ≤ 0.05`（前 6 场按准备期标为 `calibrating`，不计入合格数）⇒ N ≥ 26。
 * 那是**既有的**门禁行为，不是本用例要测的东西，所以夹具顺着它取 N = 30（余量 0.008）。
 */
const OLD_SESSION_COUNT = 30;
const BIG_BUDGET: AnalysisInputBudget = { maxRows: 400_000, maxBytes: 1 << 30, maxReadRows: 10_000, maxReadMs: 60_000 };

/**
 * 老历史（2022）：全部落在"必要窗口"之外 —— 明细按 545 天裁、路线点按被算会话裁。
 * 间隔 11 天、30 场 ⇒ 最晚一场在 2022-11-18：`R06 全局最早证据` 那条用例需要
 * "2022-12-04 之后没有任何**既有**行"，才能让本批插入的那条成为快照里最早的行。
 */
function oldSessionStart(index: number): string {
  return new Date(Date.UTC(2022, 0, 3 + index * 11, 9, 0, 0)).toISOString();
}
const LATE_SESSION_START = "2025-01-19T09:00:00.000Z";

function insertSession(
  database: DatabaseSync,
  id: string,
  startAt: string,
  options: { withRoute: boolean; heartRateSamples: number }
): void {
  const endAt = new Date(Date.parse(startAt) + 1_800_000).toISOString();
  const workoutId = `workout_${id}`;
  database.prepare(`INSERT INTO workouts
    (id, activity_type, source_name, source_category, source_version, device, start_at, end_at, created_at,
     duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
    VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture Apple Watch', 'apple_watch', '1', 'Watch',
      ?, ?, ?, 1800, 0, '{}', '{}', 1)`).run(workoutId, startAt, endAt, endAt);
  database.prepare(`INSERT INTO workout_statistics
    (workout_id, ordinal, type, unit, sum_value, average_value, minimum_value, maximum_value)
    VALUES (?, 0, 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'km', 5, NULL, NULL, NULL)`).run(workoutId);
  database.prepare(`INSERT INTO workout_statistics
    (workout_id, ordinal, type, unit, sum_value, average_value, minimum_value, maximum_value)
    VALUES (?, 1, 'HKQuantityTypeIdentifierHeartRate', 'count/min', NULL, 145, 130, 165)`).run(workoutId);
  database.prepare(`INSERT INTO training_sessions
    (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
    VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')`).run(id, startAt, endAt, workoutId);
  const insertRecord = database.prepare(`INSERT INTO health_records
    (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
     start_at, end_at, created_at, metadata_json, raw_attributes_json)
    VALUES (?, 'HKQuantityTypeIdentifierHeartRate', 'Fixture Apple Watch', 'apple_watch', '1', 'Watch',
      'count/min', ?, NULL, ?, ?, ?, '{}', '{}')`);
  for (let sample = 0; sample < options.heartRateSamples; sample += 1) {
    const at = new Date(Date.parse(startAt) + sample * 60_000).toISOString();
    insertRecord.run(`record_${id}_${sample}`, 140 + (sample % 10), at, at, at);
  }
  if (!options.withRoute) return;
  database.prepare(`INSERT INTO workout_routes
    (id, workout_id, source_name, source_category, source_version, start_at, end_at, created_at,
     relative_path, metadata_json, point_count, file_status)
    VALUES (?, ?, 'Fixture Apple Watch', 'apple_watch', '1', ?, ?, ?, ?, '{}', 10, 'imported')`)
    .run(`route_${id}`, workoutId, startAt, endAt, endAt, `routes/${id}.gpx`);
  const insertPoint = database.prepare(`INSERT INTO route_points
    (route_id, sequence, timestamp, latitude, longitude, elevation_meters, speed_mps, course_degrees,
     horizontal_accuracy_meters, vertical_accuracy_meters)
    VALUES (?, ?, ?, 23.1, 113.3, ?, 3.0, 0, 5, 3)`);
  for (let point = 0; point < 10; point += 1) {
    insertPoint.run(`route_${id}`, point,
      new Date(Date.parse(startAt) + point * 60_000).toISOString(), 10 + point);
  }
}

function seed(database: DatabaseSync): void {
  database.prepare("INSERT INTO import_manifest (key, value) VALUES ('dataset_version', ?)")
    .run("dataset_fixture_v1");
  database.prepare("INSERT INTO import_manifest (key, value) VALUES ('parser_contract_version', ?)")
    .run("canonical-health-v1");
  database.prepare("INSERT INTO profile (id, attributes_json) VALUES (1, ?)")
    .run(JSON.stringify({ HKCharacteristicTypeIdentifierDateOfBirth: "1990-05-06T00:00:00Z" }));
  // 一条白名单（静息心率）行：全史保留，且**刻意放在本批插入的那条之后**
  // （见 `R06 全局最早证据` 用例：只有"没有任何**既有**行早于本批插入的那条"，
  //  照读被裁快照的 MIN 才会落到本批插入的那条上，两种实现才会分叉）。
  database.prepare(`INSERT INTO health_records
    (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
     start_at, end_at, created_at, metadata_json, raw_attributes_json)
    VALUES ('record_rhr_recent', 'HKQuantityTypeIdentifierRestingHeartRate', 'Fixture Apple Watch',
      'apple_watch', '1', 'Watch', 'count/min', 50, NULL, '2024-07-05T22:00:00.000Z',
      '2024-07-05T22:05:00.000Z', '2024-07-05T22:06:00.000Z', '{}', '{}')`).run();
  // 🔴 一条**没有任何批次插入过**的极老心率明细（2019）：它才是真正的"全局最早"，
  // 且在新的裁剪边界（2022 之后）之外 ⇒ 被裁。`R06 全局最早证据` 那条用例靠它把
  // "取自捕获"与"照读被裁快照"两种实现分开（后者的 MIN 会落在本批插入的那条上）。
  database.prepare(`INSERT INTO health_records
    (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
     start_at, end_at, created_at, metadata_json, raw_attributes_json)
    VALUES ('record_ancient_hr', 'HKQuantityTypeIdentifierHeartRate', 'Fixture Apple Watch',
      'apple_watch', '1', 'Watch', 'count/min', 128, NULL, '2019-01-05T09:00:00.000Z',
      '2019-01-05T09:00:10.000Z', '2019-01-05T09:01:00.000Z', '{}', '{}')`).run();
  for (let index = 0; index < OLD_SESSION_COUNT; index += 1) {
    insertSession(database, `session_old_${index}`, oldSessionStart(index),
      { withRoute: true, heartRateSamples: 12 });
  }
}

/** 下一批（直连车道）：新会话 + 心率明细 + 路线点，并推进依赖代次。 */
function commitLateSession(database: DatabaseSync, options: { batchRecord?: boolean } = {}): void {
  insertSession(database, "session_late", LATE_SESSION_START, { withRoute: true, heartRateSamples: 20 });
  database.prepare(`INSERT INTO import_batches (id, xml_sha256, status, import_mode, created_at,
    raw_generation, dependency_generation, dependency_bumped)
    VALUES ('batch_late', ?, 'succeeded', 'incremental', '2025-01-20T00:00:00.000Z', 1, 1, 1)`)
    .run("0".repeat(64));
  database.prepare(`INSERT INTO import_entity_changes
    (batch_id, entity_kind, entity_id, change_type, effective_at)
    VALUES ('batch_late', 'workout', 'workout_session_late', 'inserted', ?)`).run(LATE_SESSION_START);
  if (options.batchRecord === true) {
    // 本批插入的一条心率明细（2024-06-01）。它落在 2022 老历史与 2025 晚场之间的空档里，
    // 而**本批的边界就是它**（= 覆盖起点 + 545 天）⇒ 它进快照、且成为快照里最早的明细行。
    // 于是"全局最早是不是本批插入的"这条判据在两种实现下给出不同答案（见对应用例）。
    database.prepare(`INSERT INTO health_records
      (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
       start_at, end_at, created_at, metadata_json, raw_attributes_json)
      VALUES ('record_batch_hr', 'HKQuantityTypeIdentifierHeartRate', 'Fixture Apple Watch',
        'apple_watch', '1', 'Watch', 'count/min', 131, NULL, '2024-06-01T09:00:00.000Z',
        '2024-06-01T09:00:10.000Z', '2024-06-01T09:01:00.000Z', '{}', '{}')`).run();
    database.prepare(`INSERT INTO import_entity_changes
      (batch_id, entity_kind, entity_id, change_type, effective_at)
      VALUES ('batch_late', 'record', 'record_batch_hr', 'inserted', '2024-06-01T09:00:00.000Z')`).run();
  }
  database.prepare("UPDATE import_generations SET raw_generation = 1, dependency_generation = 1 WHERE singleton = 1").run();
}

interface Fixture {
  path: string;
  store: Awaited<ReturnType<typeof RaiDatabase.open>>;
}

function withFixture<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rai-input-pruning-"));
  const path = join(root, "rai.sqlite");
  return RaiDatabase.open(path, { createMigrationBackup: false }).then(async (store) => {
    try {
      seed(store.database);
      return await run({ path, store });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

/** 强制关闭裁剪的读取器：与 `runDirectSyncAnalysis` 的覆盖越界回退走**同一条**代码路径。 */
class UnprunedReader extends SqliteAnalysisInputReader {
  override capture(request: AnalysisInputCaptureRequest, budget?: AnalysisInputBudget): AnalysisInputCapture {
    return super.capture({ ...request, disableFactPruning: true }, budget);
  }
}

/**
 * 人为收紧覆盖边界的读取器（**不是**产品路径）：把 `recordsFrom/routeFrom` 改成"比任何事实都晚"，
 * 用来模拟"裁剪边界算错"这一类缺陷 —— 守卫必须转红并回退，而不是对着缺数据的快照照读。
 */
class OverPrunedReader extends SqliteAnalysisInputReader {
  readonly requests: Array<boolean> = [];

  override capture(request: AnalysisInputCaptureRequest, budget?: AnalysisInputBudget): AnalysisInputCapture {
    this.requests.push(request.disableFactPruning === true);
    const capture = super.capture(request, budget);
    const coverage = capture.facts.snapshotCoverage;
    if (capture.facts.mode !== "materialized" || coverage === undefined || coverage.recordsFrom === null) {
      return capture;
    }
    const stats = capture.facts.stats();
    const overPruned = new SnapshotFactView(
      capture.facts.database, stats.rows, stats.bytes,
      () => capture.facts.observeGenerations(),
      {
        recordsFrom: "2999-01-01T00:00:00.000Z",
        routeFrom: "2999-01-01T00:00:00.000Z",
        globalEarliestRecordId: coverage.globalEarliestRecordId
      }
    );
    return { ...capture, facts: overPruned };
  }
}

/** 五张发布表的**语义列**投影（id / run id / created_at 这类每次运行都变的列不在内）。 */
const EQUIVALENCE_PROJECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["workout_features",
    "training_session_id, workout_start_at, duration_seconds, distance_km, average_speed_mps, " +
    "average_heart_rate_bpm, heart_rate_sample_count, heart_rate_coverage, route_point_count, " +
    "route_quality, source_confidence, session_type, eligibility_status, quality_score, missing_reasons_json"],
  ["workout_training_loads",
    "training_session_id, local_date, distance_km, duration_seconds, training_load, intensity, load_source, " +
    "confidence, heart_rate_coverage, average_heart_rate_bpm, elevation_gain_meters, rpe, session_type, " +
    "explanation_codes_json"],
  ["daily_zone_profiles",
    "local_date, resting_heart_rate_bpm, maximum_heart_rate_bpm, threshold_pace_seconds_per_km, " +
    "heart_rate_source, pace_source, heart_rate_confidence, pace_confidence, profile_status, " +
    "heart_rate_bands_json, pace_bands_json"],
  ["daily_training_metrics",
    "local_date, distance_km, duration_seconds, workout_count, daily_load, current_7d_load, previous_7d_load, " +
    "acute_ewma, chronic_ewma, load_ratio, ramp_rate, monotony, strain, history_days, load_workout_count, " +
    "training_status, confidence, explanation_codes_json"],
  ["ability_assessments",
    "training_session_id, sequence_number, assessment_status, current_ability, efficiency_score, pace_score, " +
    "cardio_score, stability_score, recovery_score, confidence, workout_contribution, evidence_strength, " +
    "direction_factor, growth_resistance, true_ability_before, true_ability_after, true_ability_delta, " +
    "updated_true_ability, explanation_codes_json"]
];

function dumpAnalysisState(database: DatabaseSync): Record<string, unknown[]> {
  const dump: Record<string, unknown[]> = {};
  for (const [table, columns] of EQUIVALENCE_PROJECTIONS) {
    // `ORDER BY 1, 2` 在原列上会并列（同一场训练有 A/B/C 三次运行各一行）⇒ 末尾补 `rowid`
    // 让顺序确定：两个变体的插入序列逐字节相同，所以 rowid 序列也相同。
    dump[table] = database.prepare(`SELECT ${columns} FROM "${table}" ORDER BY 1, 2, rowid`).all() as unknown[];
  }
  return dump;
}

/** 投影表的行数（投影键是常量清单，缺键只可能是清单本身写错）。 */
function rows(dump: Record<string, unknown[]>, table: string): unknown[] {
  const value = dump[table];
  assert.ok(Array.isArray(value), `等价性投影缺表 ${table}`);
  return value;
}

/**
 * 一次完整场景：直连车道两次全量发布 → 下一批落地 → 增量直连分析（裁剪开/关二选一）。
 *
 * 🔴 **为什么基线要走直连车道、而且要两次**（实测出来的两根硬约束，不是风格问题）：
 * 1. checkpoint 的 `prefix_compat_digest` 含**车道形状**（`scope` 等）—— CLI 车道写的
 *    checkpoint 与直连车道**天然不互相复用**，拿 CLI 基线当父级必然 `prefix_compat` 拒绝，
 *    于是本次运行退化成"全量重放"，裁剪路径根本走不到（还会被守卫正确地驳回）。
 * 2. 证据一致性判据要求父 checkpoint 的 `evidence.sourceRunId` 非空（"父 run 是在有证据源
 *    的情况下算出来的"）；第一次发布的 checkpoint 必然是 `null` ⇒ 需要第二次发布当父级。
 */
async function analyzeIncremental(
  fixture: Fixture,
  options: { disableFactPruning: boolean; batchRecord?: boolean; readerFactory?: (input: DatabaseSync) => SqliteAnalysisInputReader }
): Promise<{
  dump: Record<string, unknown[]>;
  materialization: Array<Record<string, unknown>>;
  reuse: string;
  /** 发布评估里持久化的"源回填"证据（判据落在**产物字段**上，不落在中间函数上）。 */
  backfill: { earliestInsertedIsNewGlobalEarliest?: boolean; preservedAbsent?: boolean } | null;
}> {
  const input = RaiDatabase.openReadonly(fixture.path);
  try {
    const reader = options.readerFactory !== undefined
      ? options.readerFactory(input)
      : options.disableFactPruning
        ? new UnprunedReader(input, "direct-sync", BIG_BUDGET)
        : new SqliteAnalysisInputReader(input, "direct-sync", BIG_BUDGET);
    const service = new RaiApplicationService(fixture.store, "owned", undefined, undefined, reader);
    const jobs = new RecomputeJobRepository(fixture.store.database);
    const runJob = (evaluatedAt: string, plan: string | null, targets: { raw: number; dependency: number }): string => {
      const jobId = jobs.enqueue("import", "dataset_fixture_v1", {
        mode: "direct_sync_analysis",
        evaluatedAt,
        timezoneIdentifier: "UTC",
        ...(plan === null ? {} : {
          importBatchId: "batch_late",
          // 登记计划：与直连车道同形状（域边界 = 新批弄脏的时刻）。
          incrementalPlan: {
            mode: "partial" as const,
            dirtyFromAt: plan,
            domains: { features: plan, fitness: plan, readiness: plan }
          }
        })
      }, { targetRawGeneration: targets.raw, targetDependencyGeneration: targets.dependency });
      const job = service.runNextJob();
      assert.equal(job?.id, jobId);
      assert.equal(job?.status, "succeeded", JSON.stringify(job?.error ?? {}));
      return jobId;
    };
    runJob(BASELINE_AS_OF, null, { raw: 0, dependency: 0 });
    runJob(BASELINE2_AS_OF, null, { raw: 0, dependency: 0 });
    commitLateSession(fixture.store.database, { batchRecord: options.batchRecord === true });
    const jobId = runJob(INCREMENTAL_AS_OF, LATE_SESSION_START, { raw: 1, dependency: 1 });

    const materialization = (fixture.store.database.prepare(`
      SELECT message FROM recompute_job_events
      WHERE job_id = ? AND phase = 'input_materialization' ORDER BY rowid`).all(jobId) as Array<{ message: string }>)
      .map((row) => JSON.parse(row.message) as Record<string, unknown>);
    const reuse = String((fixture.store.database.prepare(`
      SELECT summary_json AS json FROM training_metric_runs
      WHERE model_run_id = (SELECT model_run_id FROM recompute_jobs WHERE id = ?)`).get(jobId) as { json: string }).json);
    const bundle = fixture.store.database.prepare(`
      SELECT evaluation_json AS json FROM model_release_bundles
      WHERE model_run_id = (SELECT model_run_id FROM recompute_jobs WHERE id = ?)`).get(jobId) as { json: string } | undefined;
    const report = bundle === undefined
      ? null
      : JSON.parse(bundle.json) as { factChanges?: { sourceBackfill?: { earliestInsertedIsNewGlobalEarliest?: boolean; preservedAbsent?: boolean } } };
    return {
      dump: dumpAnalysisState(fixture.store.database),
      materialization,
      reuse,
      backfill: report?.factChanges?.sourceBackfill ?? null
    };
  } finally {
    input.close();
  }
}

test("R06 端到端等价：同一合成历史，裁剪开/关的发布产物逐位一致（且裁剪确实生效）", async () => {
  const pruned = await withFixture((fixture) => analyzeIncremental(fixture, { disableFactPruning: false }));
  const full = await withFixture((fixture) => analyzeIncremental(fixture, { disableFactPruning: true }));

  // ① 前提：夹具本来就该有内容（否则"逐位一致"是空的）。
  assert.ok(rows(pruned.dump, "workout_features").length >= OLD_SESSION_COUNT + 1, "夹具必须包含全部会话的特征行");
  assert.ok(rows(pruned.dump, "workout_training_loads").length >= OLD_SESSION_COUNT + 1, "夹具必须包含负荷行");
  assert.ok(rows(pruned.dump, "ability_assessments").length >= OLD_SESSION_COUNT + 1, "夹具必须包含能力评估行");
  // ② 前提：被测的那次运行必须**真走复用** —— 否则"裁剪被安全使用"这条命题无从谈起
  //    （复用被拒 ⇒ 日链从头算 ⇒ 守卫正确地驳回裁剪，测的就不是同一条路径了）。
  assert.match(pruned.reuse, /"proof":"verified"/, `被测运行必须走复用路径：${pruned.reuse.slice(-200)}`);
  assert.match(full.reuse, /"proof":"verified"/, `对照运行也必须走同一路径：${full.reuse.slice(-200)}`);

  // ③ 等价：五张发布表的语义列逐位一致。
  for (const [table] of EQUIVALENCE_PROJECTIONS) {
    assert.deepEqual(pruned.dump[table], full.dump[table],
      `${table} 在裁剪快照与全量快照下必须逐位一致（"少读数据"绝不能换来不同的结果）`);
  }

  // ④ 反空话：裁剪确实生效，且**没有**触发回退（回退会掩盖"裁剪是安全的"这条主张）。
  const prunedEvents = pruned.materialization.filter((event) => event.pruning != null);
  assert.equal(prunedEvents.length, 1, `增量运行的捕获必须带裁剪证据：${JSON.stringify(pruned.materialization)}`);
  assert.equal(pruned.materialization.length, 1, `合法复用路径不得有多余的捕获：${JSON.stringify(pruned.materialization)}`);
  assert.equal(full.materialization.filter((event) => event.pruning != null).length, 0);
  const prunedRows = Number(prunedEvents[0]!.rows);
  const fullRows = Number(full.materialization[0]!.rows);
  assert.ok(
    prunedRows < fullRows * 0.5,
    `裁剪必须显著少复制行（裁剪 ${prunedRows} vs 全量 ${fullRows}）——少的是 2022 年的明细与路线点`
  );
});

test("R06 覆盖守卫：边界被人为收紧 ⇒ 显式失败 + 关闭裁剪重捕获一次，结果与不裁剪一致", async () => {
  const overPruned = await withFixture((fixture) => analyzeIncremental(fixture, {
    disableFactPruning: false,
    readerFactory: (input) => new OverPrunedReader(input, "direct-sync", BIG_BUDGET)
  }));
  const full = await withFixture((fixture) => analyzeIncremental(fixture, { disableFactPruning: true }));

  // ① 回退证据：事件里必须写明"哪一次读越界、需要多早、覆盖从哪开始"。
  const fallback = overPruned.materialization.filter((event) => event.fallback === "fact_pruning_disabled");
  assert.equal(fallback.length, 1, `越界回退必须恰好发生一次：${JSON.stringify(overPruned.materialization)}`);
  assert.equal(fallback[0]!.coverageFrom, "2999-01-01T00:00:00.000Z");
  assert.equal(typeof fallback[0]!.requiredFrom, "string");
  assert.equal(typeof fallback[0]!.context, "string");
  // ② 回退之后的重捕获必须是**不裁剪**的（事件里最后一条的 pruning 为 null）。
  const last = overPruned.materialization.at(-1)!;
  assert.equal(last.pruning, null, `回退后的这一版输入不得再裁剪：${JSON.stringify(last)}`);
  assert.match(overPruned.reuse, /"proof":"verified"/, `被测运行同样必须走复用路径：${overPruned.reuse.slice(-200)}`);
  // ③ 结果仍然正确：与全程不裁剪的那次逐位一致。
  for (const [table] of EQUIVALENCE_PROJECTIONS) {
    assert.deepEqual(overPruned.dump[table], full.dump[table],
      `${table} 必须在回退后仍然逐位一致（守卫的代价是慢一次，不是结果不同）`);
  }
});

test("R06 全局最早证据：裁剪之后必须取自捕获值（照读被裁快照的 MIN 会换一个答案）", async () => {
  const run = await withFixture((fixture) => analyzeIncremental(fixture, {
    disableFactPruning: false, batchRecord: true
  }));
  // 前提①：这一批把边界推到它自己插入的那条明细上（2024-06-01）⇒ 覆盖起点 = 2022-12-04。
  const pruned = run.materialization.filter((event) => event.pruning != null);
  assert.equal(pruned.length, 1, `被测运行必须带裁剪证据：${JSON.stringify(run.materialization)}`);
  const pruning = pruned[0]!.pruning as { recordsFrom: string };
  assert.equal(pruning.recordsFrom, "2022-12-04T09:00:00.000Z");
  assert.ok(run.reuse.includes("\"proof\":\"verified\""), `被测运行必须走复用路径：${run.reuse.slice(-200)}`);
  // 前提②：真正的全局最早是一条**既有**的 2019 心率明细（被裁）；本批插入的那条（2024）
  // 才是快照里最早的明细行 —— 两种实现在这里分叉。
  // 判据（落在**产物字段**上）：发布评估里的"这一批是不是把时间线推向更早"必须是**假**
  // （历史里那条 2019 的记录不是本批插入的）。照读被裁快照会拿到"是"（=真），即静默换答案。
  assert.equal(
    run.backfill?.earliestInsertedIsNewGlobalEarliest, false,
    `全局最早证据必须来自捕获（发布评估里的 sourceBackfill）：${JSON.stringify(run.backfill)}`
  );
  assert.equal(run.backfill?.preservedAbsent, true, "本批没有任何删除 ⇒ 保真判据必须为真（前提）");
});

test("R06 消费面清单：分析读到的记录类型必须全部在裁剪清单里表态", () => {
  // 判据的形状：**只认"被声明过的类型引用"** —— 消费文件里出现任何一个新的类型常量/取值，
  // 都必须先落到 `FACT_PRUNE_*` 清单（或这张"明确不读 health_records"的免检表）里，
  // 否则本用例红。它防的是"新加一路明细读取，却被裁剪静默切掉"。
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const consumers = [
    "packages/application/src/services/recompute-pipeline.ts",
    "packages/application/src/prediction-data.ts",
    "packages/application/src/model-v2-snapshots.ts",
    "packages/application/src/readiness-replay-coverage.ts"
  ];
  // 免检表：这些常量确实出现，但**不用于读 `health_records`**（各有唯一用途），逐条给理由。
  const notHealthRecordsReads: Record<string, string> = {
    hrvType: "只用于 workout_statistics / canonical_hrv_days（HRV 明细不经 health_records 读）",
    sleepType: "只用于 workout_statistics / canonical_nights（睡眠明细不经 health_records 读）",
    distanceType: "只用于 workout_statistics（距离统计）",
    runningType: "训练活动类型（training_sessions.activity_type），不是记录类型"
  };
  const declared = new Set<string>([
    ...FACT_PRUNE_ALWAYS_KEPT_RECORD_TYPES,
    ...FACT_PRUNE_WINDOWED_RECORD_TYPES
  ]);
  // 两个命名空间各自一份"常量 → 类型字符串"映射（`healthTypes.<属性>` 与本地 `*Type` 常量）。
  // 两处写法就是下一次静默分叉，所以两边都要落到同一张判定表上。
  const values: Record<string, string> = {
    // `healthTypes.<属性>`（`@rai/health-export-parser` 的记录类型表）
    restingHeartRate: restingHeartRateType,
    heartRate: heartRateType,
    runningSpeed: runningSpeedType,
    vo2Max: "HKQuantityTypeIdentifierVO2Max",
    hrvSdnn: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
    sleepAnalysis: "HKCategoryTypeIdentifierSleepAnalysis",
    // 本地常量（`service-types.ts`）
    heartRateType,
    runningSpeedType,
    restingHeartRateType
  };
  const problems: string[] = [];
  for (const relative of consumers) {
    const source = readFileSync(join(root, relative), "utf8");
    const referenced = new Set<string>();
    for (const match of source.matchAll(/healthTypes\.([a-zA-Z0-9]+)/g)) referenced.add(match[1]!);
    for (const match of source.matchAll(/\b(heartRateType|runningSpeedType|restingHeartRateType)\b/g)) {
      referenced.add(match[1]!);
    }
    for (const name of referenced) {
      if (name in notHealthRecordsReads) continue;
      const value = values[name];
      if (value === undefined) {
        problems.push(`${relative}: 引用了未表态的记录类型 \`${name}\` —— 请先声明它属于哪一类`);
        continue;
      }
      if (!declared.has(value)) {
        problems.push(`${relative}: \`${name}\`（${value}）不在 FACT_PRUNE_* 清单里 —— 它会被裁剪静默切掉`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
  // 清单与非裁剪路径的常量必须同源（改了一边、另一边没改，是本仓反复踩过的形态）。
  assert.deepEqual([...FACT_PRUNE_WINDOWED_RECORD_TYPES].sort(), [heartRateType, runningSpeedType].sort());
  assert.deepEqual([...FACT_PRUNE_ALWAYS_KEPT_RECORD_TYPES].sort(), [restingHeartRateType, values.vo2Max].sort());
});
