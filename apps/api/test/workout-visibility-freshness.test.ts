// P0-1 / P0-3（2026-10-18 同步诊断）：**事实已提交、分析未发布**时的读侧契约。
//
// 这个文件钉的是生产事故的直接成因（`output/diagnosis-2026-10-18-run-partial/lane-api.md` §2.1）：
// 同一份训练事实在 12:29:38 已经提交，读侧却因为 `INNER JOIN active_ability_assessments`
// 把它呈现成 404（详情）与"不存在"（列表），直到 12:31:21 分析发布才出现 —— 102.5 s。
// 门一旦重新变成"分析发布"，本文件的 pending 断言会立刻红，而不是等下一次真机复现。
//
// 覆盖四件事：
//   1. 事实可见性：pending 训练进列表/详情（200）、派生字段是 null/占位、`analysisPublishStatus`
//      可区分 pending 与 published；`days` 窗口以**事实侧**最新训练为锚点；
//   2. 详情的 `facts.analysisState` 真的能取到 "pending"（旧实现是死分支）；
//   3. `GET /v1/workouts/:id/freshness`：facts 批次账目、分析任务、每指标 samples/state、
//      24h 稳定性判据（P2-1/P0-3）；
//   4. `GET /v1/sync/coverage`：每类型覆盖区间与过滤（P1-1），以及 handshake 的能力位。
//
// 最后一条用例走**真实服务进程**：`/v1/workouts/:id` 在 pending 时返回 200 是这次修复的
// 用户可见判据，store 层非空还不足以下这个结论（路由可能仍然 404）。

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { HandshakeResponse, WorkoutDetailResponse, WorkoutFreshnessResponse, WorkoutListResponse } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

import { RaiReadStore } from "../src/data.js";

const projectRoot = resolve(import.meta.dirname, "../../..");

/** 事故当次训练的窗口（UTC）：11:46:38 → 12:28:46 = 2528 s。 */
const STARTED_AT = "2026-10-18T11:46:38.000Z";
const ENDED_AT = "2026-10-18T12:28:46.000Z";
const WORKOUT_ID = "workout_pending_fixture";
const SESSION_ID = "training_session_pending_fixture";
/** 批 2 的完成时刻（生产：workout + route + HR + PhysicalEffort + VO2Max）。 */
const FACTS_BATCH = "batch_facts_fixture";
const FACTS_BATCH_COMPLETED_AT = "2026-10-18T12:29:38.755Z";
/** 批 3 的完成时刻（生产：RunningStrideLength 482 条，record-only）。 */
const STRIDE_BATCH = "batch_stride_fixture";
const STRIDE_BATCH_COMPLETED_AT = "2026-10-18T12:30:23.070Z";
const ANALYSIS_JOB = "recompute_job_fixture";

const insertHealthRecordSql = `INSERT INTO health_records
  (id, type, source_name, source_category, unit, value_numeric, start_at, end_at,
   metadata_json, raw_attributes_json)
  VALUES (?, ?, 'Fixture Apple Watch', 'apple_watch', ?, ?, ?, ?, '{}', '{}')`;

const insertImportBatchSql = `INSERT INTO import_batches
  (id, xml_sha256, status, import_mode, completed_at, summary_json)
  VALUES (?, ?, 'succeeded', 'incremental', ?, '{}')`;

const insertImportChangeSql = `INSERT INTO import_entity_changes
  (batch_id, entity_kind, entity_id, change_type, effective_at, content_hash)
  VALUES (?, ?, ?, 'inserted', ?, NULL)`;

/**
 * 造一份"事实已提交、分析未发布"的库，形态与生产事故的批 2 一致：
 * workout + training_session + HR/speed 记录 + workout_statistics 距离/平均心率，全部在
 * 同一个事实批次里；分析任务已登记但还没发布。
 */
async function createPendingFixture(root: string): Promise<string> {
  const path = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(path, { createMigrationBackup: false });
  store.close();
  const database = new DatabaseSync(path);
  try {
    database.prepare(`INSERT INTO workouts
      (id, activity_type, source_name, source_category, source_version, device,
       start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
      VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture Apple Watch', 'apple_watch', '1', 'Watch',
        ?, ?, 2528, 0, '{}', '{}', 1)`).run(WORKOUT_ID, STARTED_AT, ENDED_AT);
    database.prepare(`INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
      VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 6.0125, ?, 'active')`)
      .run(SESSION_ID, STARTED_AT, ENDED_AT, WORKOUT_ID);
    // 事实侧的聚合统计：分析未发布时列表/详情用它们给出距离与平均心率（P0-1 的兜底）。
    const insertStatistic = database.prepare(`INSERT INTO workout_statistics
      (workout_id, ordinal, type, unit, sum_value, average_value)
      VALUES (?, ?, ?, ?, ?, ?)`);
    insertStatistic.run(WORKOUT_ID, 0, "HKQuantityTypeIdentifierDistanceWalkingRunning", "km", 6.0125, null);
    insertStatistic.run(WORKOUT_ID, 1, "HKQuantityTypeIdentifierHeartRate", "count/min", null, 153.4);

    const insertRecord = database.prepare(insertHealthRecordSql);
    const insertBatch = database.prepare(insertImportBatchSql);
    const insertChange = database.prepare(insertImportChangeSql);
    insertBatch.run(FACTS_BATCH, "a".repeat(64), FACTS_BATCH_COMPLETED_AT);
    insertBatch.run(STRIDE_BATCH, "b".repeat(64), STRIDE_BATCH_COMPLETED_AT);
    insertChange.run(FACTS_BATCH, "workout", WORKOUT_ID, STARTED_AT);

    const base = Date.parse(STARTED_AT);
    const instant = (offsetSeconds: number): string => new Date(base + offsetSeconds * 1000).toISOString();
    for (const [index, offset] of [0, 60, 120].entries()) {
      const sampleAt = instant(offset);
      insertRecord.run(`fixture_hr_${index}`, "HKQuantityTypeIdentifierHeartRate", "count/min",
        150 + index, sampleAt, sampleAt);
      insertChange.run(FACTS_BATCH, "record", `fixture_hr_${index}`, sampleAt);
    }
    for (const [index, offset] of [0, 60].entries()) {
      const sampleAt = instant(offset);
      insertRecord.run(`fixture_speed_${index}`, "HKQuantityTypeIdentifierRunningSpeed", "km/hr",
        10 + index * 0.2, sampleAt, sampleAt);
      insertChange.run(FACTS_BATCH, "record", `fixture_speed_${index}`, sampleAt);
    }
    // 批 3 的 stride 在初始相位**还没到**：freshness 必须报 not_seen_yet，而不是"设备没有"。
    database.prepare(`INSERT INTO recompute_jobs
      (id, job_type, status, request_json, progress_phase)
      VALUES (?, 'import', 'queued', ?, 'queued')`)
      .run(ANALYSIS_JOB, JSON.stringify({ mode: "direct_sync_analysis", importBatchId: FACTS_BATCH }));
  } finally {
    database.close();
  }
  return path;
}

/** 补上批 3 的 stride 记录 + 账本（模拟"手表迟到样本在下一批到达"）。 */
function addStrideBatch(path: string): void {
  const database = new DatabaseSync(path);
  try {
    const insertRecord = database.prepare(insertHealthRecordSql);
    const insertChange = database.prepare(insertImportChangeSql);
    const base = Date.parse(STARTED_AT);
    for (const [index, offset] of [0, 60].entries()) {
      const sampleAt = new Date(base + offset * 1000).toISOString();
      insertRecord.run(`fixture_stride_${index}`, "HKQuantityTypeIdentifierRunningStrideLength", "m",
        1.02 + index * 0.01, sampleAt, sampleAt);
      insertChange.run(STRIDE_BATCH, "record", `fixture_stride_${index}`, sampleAt);
    }
  } finally {
    database.close();
  }
}

/**
 * 发布分析（模拟写侧的发布事务）：feature_run → workout_feature → model_run →
 * ability_assessment → active_model_run 指针。行按生产 DDL 的最小必填集插入，
 * **不**跑评分（本文件只证明读侧怎么解释已发布状态，不重复验证模型）。
 */
function publishAnalysis(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.prepare(`INSERT INTO feature_runs
      (id, dataset_version, canonical_contract_version, feature_schema_version,
       feature_config_json, feature_config_hash, status)
      VALUES ('feature_run_fixture', 'dataset_fixture', 'v1', 'v1', '{}', 'hash', 'succeeded')`).run();
    database.prepare(`INSERT INTO workout_features
      (id, feature_run_id, training_session_id, canonical_workout_id, workout_start_at,
       duration_seconds, distance_km, average_heart_rate_bpm, heart_rate_sample_count,
       heart_rate_coverage, route_point_count, route_quality, source_confidence, session_type,
       session_type_source, eligibility_status, quality_score, missing_reasons_json,
       features_json, provenance_json)
      VALUES ('workout_feature_fixture', 'feature_run_fixture', ?, ?, ?, 2528, 6.0125, 153.4, 3,
        0.8, 0, NULL, 0.9, 'easy', 'auto', 'eligible', 0.82, '[]', '{}', '{}')`)
      .run(SESSION_ID, WORKOUT_ID, STARTED_AT);
    database.prepare(`INSERT INTO model_runs
      (id, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
       evaluated_at, status)
      VALUES ('model_run_fixture', 'feature_run_fixture', 'dataset_fixture', 'rai-model-config-fixture',
        '{}', 'hash', '2026-10-18T12:31:16.543Z', 'succeeded')`).run();
    database.prepare(`INSERT INTO ability_assessments
      (id, model_run_id, feature_id, training_session_id, sequence_number, assessment_status,
       current_ability, efficiency_score, pace_score, cardio_score, stability_score, recovery_score,
       effective_weights_json, confidence, confidence_factors_json, workout_contribution,
       updated_true_ability, explanation_codes_json, explanation_json, assessed_at)
      VALUES ('assessment_fixture', 'model_run_fixture', 'workout_feature_fixture', ?, 1, 'eligible',
        61.5, 60, 62, 58, 55, 50, '{"pace":0.4}', 0.72, '{}', 0.3, 1, '[]', '{}',
        '2026-10-18T12:31:16.543Z')`).run(SESSION_ID);
    database.prepare(`INSERT INTO active_model_run (singleton, model_run_id, activated_at)
      VALUES (1, 'model_run_fixture', '2026-10-18T12:31:21.265Z')`).run();
    database.prepare("UPDATE recompute_jobs SET status = 'succeeded', completed_at = ? WHERE id = ?")
      .run("2026-10-18T12:31:21.669Z", ANALYSIS_JOB);
  } finally {
    database.close();
  }
}

async function withReadStore<T>(path: string, run: (read: RaiReadStore) => T): Promise<T> {
  const read = new RaiReadStore(path);
  try {
    return run(read);
  } finally {
    read.close();
  }
}

test("P0-1：事实已提交、分析未发布 ⇒ 列表含 pending 行，派生字段是 null/占位而不是 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-visibility-pending-"));
  try {
    const path = await createPendingFixture(root);
    await withReadStore(path, (read) => {
      const list = read.workouts({ limit: 10, offset: 0 });
      assert.equal(list.total, 1, "pending 训练必须计入总数（旧实现以发布门为驱动表 ⇒ 0）");
      const [item] = list.items;
      assert.ok(item, "pending 训练必须出现在列表里");
      assert.equal(item.id, SESSION_ID);
      assert.equal(item.analysisPublishStatus, "pending");
      // 事实侧拿得到的字段：开始/结束/时长/距离/平均心率都来自事实，不是派生评分。
      assert.equal(item.startedAt, STARTED_AT);
      assert.equal(item.endedAt, ENDED_AT);
      assert.equal(item.durationSeconds, 2528);
      assert.equal(item.distanceKm, 6.0125);
      assert.equal(item.averageHeartRateBpm, 153.4);
      assert.equal(item.indoor, false);
      assert.equal(item.hasRoute, false);
      // 派生字段必须是占位/null —— 不得把 pending 当成 0 分或 unclassified 的结论。
      assert.equal(item.sessionType, "unclassified");
      assert.equal(item.eligibilityStatus, "pending");
      assert.equal(item.qualityScore, 0);
      assert.equal(item.currentAbility, null);
      assert.equal(item.confidence, null);
      assert.equal(item.trueAbilityDelta, null);
      assert.equal(item.assessmentStatus, null);
      assert.deepEqual(item.missingReasons, []);

      // days 窗口的锚点必须是**事实侧**最新训练：用发布门取最新值时 pending 行会掉出窗口。
      assert.equal(read.workouts({ limit: 10, offset: 0, days: 28 }).total, 1);
      assert.equal(read.workouts({
        limit: 10, offset: 0, startedFrom: STARTED_AT, startedBefore: ENDED_AT
      }).total, 1);
      // 带特征过滤时 pending 行被排除是**契约允许**的：它还没有 eligibility/sessionType。
      assert.equal(read.workouts({ limit: 10, offset: 0, participation: "included" }).total, 0);

      // dashboard 的 latestWorkout 同样走事实侧：刚跑完、还没发布时不能显示成"没有训练"。
      const dashboard = read.dashboard();
      assert.equal(dashboard.latestWorkout?.id, SESSION_ID);
      assert.equal(dashboard.latestWorkout?.analysisPublishStatus, "pending");

      const detail = read.workout(SESSION_ID);
      assert.ok(detail, "详情在事实存在时必须返回（旧实现返回 null ⇒ 404）");
      assert.equal(detail.workout.analysisPublishStatus, "pending");
      assert.equal(detail.workout.assessmentStatus, null);
      assert.equal(detail.workout.modelVersion, "");
      assert.equal(detail.workout.qualityScore, 0);
      assert.equal(detail.workout.eligibilityStatus, "pending");
      assert.equal(detail.workout.distanceKm, 6.0125);
      assert.equal(detail.workout.averageHeartRateBpm, 153.4);
      assert.equal(detail.workout.elapsedSeconds, 2528);
      assert.equal(detail.workout.currentAbility, null);
      assert.deepEqual(detail.dimensions, {
        efficiency: null, pace: null, cardio: null, stability: null, recovery: null
      });
      // 🔴 data.ts 的 analysisState 死分支修复：pending 必须真的取得到。
      assert.equal(detail.facts?.analysisState, "pending");
      assert.equal(detail.analysis, null, "没有已发布 release 时分析块显式 null，不伪造空对象");

      // 不存在的会话仍然 404（"不存在"与"还没发布"必须可分辨）。
      assert.equal(read.workout("training_session_does_not_exist"), null);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P0-3：freshness 按事实批次/分析任务/每指标样本数回答，stride 到达前后 state 翻转", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-visibility-freshness-"));
  try {
    const path = await createPendingFixture(root);
    // 分析未发布：facts 已到、任务在排队。时间固定，24h 稳定性判据不依赖墙钟。
    const beforePublish = new Date("2026-10-18T12:31:00.000Z");
    await withReadStore(path, (read) => {
      const freshness = read.workoutFreshness(SESSION_ID, beforePublish);
      assert.ok(freshness, "事实存在 ⇒ freshness 必须可读");
      assert.equal(freshness.facts.committedAt, FACTS_BATCH_COMPLETED_AT);
      assert.equal(freshness.facts.lastBatchAt, FACTS_BATCH_COMPLETED_AT);
      assert.equal(freshness.facts.batches, 1);
      assert.deepEqual(freshness.analysis, {
        status: "pending", jobId: ANALYSIS_JOB, publishedAt: null
      });
      assert.equal(freshness.completeness, "partial");
      const byMetric = new Map(freshness.series.map((metric) => [metric.metric, metric]));
      assert.deepEqual(
        [byMetric.get("heartRate")?.samples, byMetric.get("heartRate")?.state],
        [3, "present"]
      );
      assert.deepEqual(
        [byMetric.get("speed")?.samples, byMetric.get("speed")?.state],
        [2, "present"]
      );
      // 关键：还没见到 ≠ 设备没有。power/stride/cadence/VO/GCT/elevation 都是 not_seen_yet。
      for (const metric of ["power", "cadence", "strideLength", "verticalOscillation",
        "groundContactTime", "elevation"]) {
        assert.equal(byMetric.get(metric)?.samples, 0, `${metric} 初始相位不应有样本`);
        assert.equal(byMetric.get(metric)?.state, "not_seen_yet",
          `${metric} 没有样本时必须报 not_seen_yet（"还没到"不是"设备没有"）`);
      }
      // 没有 v46 的 available_at 列（或旧行）时诚实返回 null，不编时间。
      assert.equal(byMetric.get("heartRate")?.lastAvailableAt, null);

      // 不存在/已软删的事实 ⇒ null（路由 404，与详情一致）。
      assert.equal(read.workoutFreshness("training_session_does_not_exist", beforePublish), null);
    });

    // 批 3 到达：stride 从 not_seen_yet 变 present，lastBatchAt/batches 跟着走。
    addStrideBatch(path);
    await withReadStore(path, (read) => {
      const freshness = read.workoutFreshness(SESSION_ID, beforePublish);
      assert.ok(freshness);
      const stride = freshness.series.find((metric) => metric.metric === "strideLength");
      assert.equal(stride?.samples, 2);
      assert.equal(stride?.state, "present");
      assert.equal(freshness.facts.batches, 2, "批 3 只碰窗口内记录，也必须算进本训练的批次账");
      assert.equal(freshness.facts.lastBatchAt, STRIDE_BATCH_COMPLETED_AT);
      // 未发布 ⇒ 无论多久没有新批次，都只能是 partial。
      const muchLater = new Date("2026-10-20T13:00:00.000Z");
      assert.equal(read.workoutFreshness(SESSION_ID, muchLater)?.completeness, "partial");
    });

    // 发布之后：status=published，publishedAt 来自 active 指针；24h 稳定性判据开始生效。
    publishAnalysis(path);
    await withReadStore(path, (read) => {
      const published = read.workoutFreshness(SESSION_ID, new Date("2026-10-18T13:31:00.000Z"));
      assert.ok(published);
      assert.deepEqual(published.analysis, {
        status: "published",
        jobId: ANALYSIS_JOB,
        publishedAt: "2026-10-18T12:31:21.265Z"
      });
      assert.equal(published.completeness, "partial", "发布后 1h 内仍可能补齐 ⇒ partial");
      const stable = read.workoutFreshness(SESSION_ID, new Date("2026-10-20T13:00:00.000Z"));
      assert.equal(stable?.completeness, "complete", "发布 24h+ 无新批 ⇒ 可以声明数据已稳定");
      // 同一时刻列表/详情的可见性状态同步翻转。
      const item = read.workouts({ limit: 10, offset: 0 }).items[0];
      assert.equal(item?.analysisPublishStatus, "published");
      assert.equal(item?.sessionType, "easy");
      assert.equal(item?.eligibilityStatus, "eligible");
      assert.equal(item?.qualityScore, 0.82);
      assert.equal(item?.currentAbility, 61.5);
      const detail = read.workout(SESSION_ID);
      assert.equal(detail?.workout.analysisPublishStatus, "published");
      assert.equal(detail?.workout.modelVersion, "rai-model-config-fixture");
      assert.equal(detail?.facts?.analysisState, "analyzed");
      assert.ok(detail?.analysis, "已发布时分析块必须存在");
      assert.equal(detail?.analysis?.workoutId, SESSION_ID);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P1-1：syncCoverage 按类型给出覆盖区间与计数，支持过滤，并按 data_version 失效 memo", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-visibility-coverage-"));
  try {
    const path = await createPendingFixture(root);
    addStrideBatch(path);
    await withReadStore(path, (read) => {
      const all = read.syncCoverage();
      const byType = new Map(all.map((entry) => [entry.type, entry]));
      assert.deepEqual(byType.get("HKQuantityTypeIdentifierHeartRate"), {
        type: "HKQuantityTypeIdentifierHeartRate",
        knownFrom: STARTED_AT,
        // 第 3 条 HR 样本起于 +120 s（夹具的 end_at 与 start_at 相同）。
        knownUntil: "2026-10-18T11:48:38.000Z",
        sampleCount: 3
      });
      assert.equal(byType.get("HKQuantityTypeIdentifierRunningStrideLength")?.sampleCount, 2);
      // 过滤：只回被点名的类型；服务端没有的类型**不补空行**。
      assert.deepEqual(read.syncCoverage(["HKQuantityTypeIdentifierRunningStrideLength"]), [{
        type: "HKQuantityTypeIdentifierRunningStrideLength",
        knownFrom: STARTED_AT,
        knownUntil: "2026-10-18T11:47:38.000Z",
        sampleCount: 2
      }]);
      assert.deepEqual(read.syncCoverage(["HKQuantityTypeIdentifierRunningPower"]), []);
      // memo 命中不改变结果（同一 data_version 两次调用逐字节相同）。
      assert.deepEqual(read.syncCoverage(), all);

      // 另一个连接提交新记录 ⇒ PRAGMA data_version 变化 ⇒ memo 失效，计数跟着走。
      const writer = new DatabaseSync(path);
      try {
        writer.prepare(insertHealthRecordSql).run(
          "fixture_power_0", "HKQuantityTypeIdentifierRunningPower", "W", 210,
          STARTED_AT, STARTED_AT
        );
      } finally {
        writer.close();
      }
      const refreshed = read.syncCoverage(["HKQuantityTypeIdentifierRunningPower"]);
      assert.equal(refreshed.length, 1, "memo 必须以 data_version 失效，而不是永远缓存第一次结果");
      assert.equal(refreshed[0]?.sampleCount, 1);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 真实服务进程：pending 详情的 **HTTP 200** 与两个新端点的线上形状。
// ---------------------------------------------------------------------------

test("HTTP：pending 详情返回 200，freshness/coverage 端点与 handshake 能力位可用", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-visibility-http-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  // `createPendingFixture` 把库建在给定目录下的 rai.sqlite ⇒ 直接落在 var/ 里。
  await createPendingFixture(join(runtimeRoot, "var"));
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "acceptance-token",
      RAI_SERVER_ID: "local", RAI_ATHLETE_ID: "athlete_1", RAI_DATASET_EPOCH: "default"
    },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
    await waitForApi(child, url, () => output);
    const authorized = (path: string): Promise<Response> => fetch(`${url}${path}`, {
      headers: { authorization: "Bearer acceptance-token" }
    });

    const listResponse = await authorized("/v1/workouts?limit=10&offset=0");
    assert.equal(listResponse.status, 200, await listResponse.clone().text());
    const list = await listResponse.json() as WorkoutListResponse;
    assert.equal(list.total, 1);
    assert.equal(list.items[0]?.analysisPublishStatus, "pending");

    const detailResponse = await authorized(`/v1/workouts/${SESSION_ID}`);
    assert.equal(detailResponse.status, 200,
      "事实已提交、分析未发布 ⇒ 详情必须 200（生产事故里这里是 404）");
    const detail = await detailResponse.json() as WorkoutDetailResponse;
    assert.equal(detail.workout.analysisPublishStatus, "pending");
    assert.equal(detail.workout.qualityScore, 0);
    assert.equal(detail.facts?.analysisState, "pending");
    assert.equal(detail.analysis, null);

    const missingResponse = await authorized("/v1/workouts/training_session_does_not_exist");
    assert.equal(missingResponse.status, 404, "只有事实不存在时才 404");

    const freshnessResponse = await authorized(`/v1/workouts/${SESSION_ID}/freshness`);
    assert.equal(freshnessResponse.status, 200, await freshnessResponse.clone().text());
    const freshness = await freshnessResponse.json() as WorkoutFreshnessResponse;
    assert.equal(freshness.workoutId, SESSION_ID);
    assert.equal(freshness.facts.batches, 1);
    assert.equal(freshness.analysis.status, "pending");
    assert.equal(freshness.completeness, "partial");
    assert.equal(freshness.series.find((metric) => metric.metric === "strideLength")?.state,
      "not_seen_yet");

    const coverageResponse = await authorized(
      "/v1/sync/coverage?types=HKQuantityTypeIdentifierHeartRate"
    );
    assert.equal(coverageResponse.status, 200, await coverageResponse.clone().text());
    const coverage = await coverageResponse.json() as {
      datasetEpoch: string; types: Array<{ type: string; sampleCount: number }>;
    };
    assert.equal(coverage.datasetEpoch, "default", "datasetEpoch 必须复用 handshake 的权威值");
    assert.deepEqual(coverage.types, [{
      type: "HKQuantityTypeIdentifierHeartRate", knownFrom: STARTED_AT,
      knownUntil: "2026-10-18T11:48:38.000Z", sampleCount: 3
    }]);

    const handshake = await (await authorized("/v1/handshake")).json() as HandshakeResponse;
    assert.equal(handshake.syncCoverageVersion, 1,
      "缺这个能力位，客户端只能回落全量重放（P1-1 的服务端契约）");
  } finally {
    await stopApi(child);
    await removeRuntimeRoot(runtimeRoot);
  }
});

async function waitForApi(child: ChildProcess, url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(output() || `API exited with ${child.exitCode}`);
    try {
      // 配了 RAI_API_TOKEN 时 `/v1/health` 也会回 401/403 —— 有响应就说明端口已经在听。
      await fetch(`${url}/v1/health`);
      return;
    } catch { /* API 还在启动。 */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(output() || "API did not become ready");
}

async function waitForBoundPort(child: ChildProcess, output: () => string): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(output() || "API did not report its bound port")), 60_000);
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      reject(new Error(output() || `API exited with ${code}`));
    };
    child.once("exit", onExit);
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" && message !== null &&
        (message as { type?: unknown }).type === "rai:ready" &&
        Number.isInteger((message as { port?: unknown }).port)
      ) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolvePort((message as { port: number }).port);
      }
    });
  });
}

async function stopApi(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
  child.kill();
  await Promise.race([closed, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function removeRuntimeRoot(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError;
}

test("P2-2：freshness 的 lastAvailableAt 读 health_records.available_at（v46），旧行 null", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-visibility-available-at-"));
  try {
    const path = await createPendingFixture(root);
    const database = new DatabaseSync(path);
    try {
      // 模拟 v46 之后写入的到达时刻：只有这一条 HR 有可信 available_at，其余行保持 NULL。
      database.prepare("UPDATE health_records SET available_at = ? WHERE id = 'fixture_hr_0'")
        .run("2026-10-18T12:31:50.405Z");
    } finally {
      database.close();
    }
    await withReadStore(path, (read) => {
      const freshness = read.workoutFreshness(SESSION_ID, new Date("2026-10-18T12:31:00.000Z"));
      assert.ok(freshness);
      const byMetric = new Map(freshness.series.map((metric) => [metric.metric, metric]));
      assert.equal(byMetric.get("heartRate")?.lastAvailableAt, "2026-10-18T12:31:50.405Z",
        "available_at 存在时必须返回该指标最近一次到达时刻");
      // 没有 available_at 的指标/行仍然是 null（不知道 ≠ 从未到达）。
      assert.equal(byMetric.get("speed")?.lastAvailableAt, null);
      assert.equal(byMetric.get("elevation")?.lastAvailableAt, null,
        "elevation 不是 health_records 行，不得伪造到达时刻");
    });
  } finally {
    await removeRuntimeRoot(root);
  }
});
