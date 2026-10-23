import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiApplicationService, SqliteAnalysisInputReader } from "@rai/application";
import { DIRECT_SYNC_ANALYSIS_REQUEST_MODE, healthTypes, workoutTypes } from "@rai/contracts";
import {
  canonicalizeRunningWorkouts, importGpxRoutes, parseAppleHealthXml, planIncrementalAnalysisDirtyRange,
  type DirtyRangeChange, type DirtyRangeWorkout, type RecomputePlan
} from "@rai/health-export-parser";
import { physStateFromReadiness } from "@rai/readiness";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";
import { addDays, configHash, localDateStartAt } from "../src/utils.js";
import { loadDatedReadiness, loadDatedRecoveryFacts, loadDatedRecoveryFactsBatch } from "../src/model-v2-snapshots.js";
import { loadDailyPhysEvidence } from "../src/training-load-data.js";
import {
  assertBusinessEquivalent, assertCompleteBusinessProjection,
  projectionStats,
  readBusinessProjection,
  type BusinessProjection
} from "./business-artifact-projection.js";

/**
 * O09（WP-32）分域增量复用的**永久回归**。
 *
 * ## 这些用例守的是什么缺陷
 *
 * 负荷／分区／日级三个域都是有**滚动状态**的（指数平滑、90 天距离参考队列、分区带的逐日继承）。
 * 一旦"为了快"改成"从半路按默认值续算"，产出的错值会落在**历史前缀**里：
 * 行数、覆盖、发布 gate 全部照旧通过，只有把增量结果与**离线从头计算**逐字段对照才看得见。
 * 所以本文件的判据不是"跑通了"，而是：
 *
 * 1. 同一份合成输入下，增量结果（新增／训练内更正／删除／override／配置变化五种）
 *    必须等于**另一个库上从头全量计算**的结果；分类与 missing reason **精确**比较，
 *    数值留浮点余量。行数相等不算数。
 * 2. 近期小变更只重算受影响后缀，且复用前缀里的业务数值逐字段不变。
 * 3. 复用证明失败（checkpoint 缺失/被改、前缀与父 run 不一致、删除导致前缀缺行）时
 *    **整段重算**并把 `reused` 记 0 —— 失败绝不假装成功。
 * 4. 批量恢复事实读取（一次范围读 + 双指针）与逐日读取（每天 7 条 SQL）**逐字段相同**，
 *    尤其是按天自己的 `asOf` 判定出来的 `publicationAt`：塌缩成 run 级截止会让历史日
 *    提前看到未来证据。这条是 O09 步骤 5 的硬前提，不是"顺带测一下"。
 *
 * 全部使用合成夹具（程序生成的 XML 与行），不复制任何真实健康库，不把健康明细写进日志。
 */

const TZ = "Asia/Shanghai";
const EVAL_1 = "2026-02-10T04:00:00.000Z";
const EVAL_2 = "2026-02-12T04:00:00.000Z";
const EVAL_3 = "2026-02-15T04:00:00.000Z";
/**
 * 40 场训练（每个自然日一场，2026-01-01 起）。
 *
 * 🔴 为什么不是 7 场：发布 gate 的 `maxEligibleSessionDelta` 是 **5%**，而"新增一场训练"
 * 会让可用会话数 +1。小夹具下 +1 就能超过 5% ⇒ 候选被 gate 拒 —— 那是既有发布口径的
 * **正确**行为，与增量复用无关；夹具太小会把"gate 正常拒绝"误读成"复用有问题"。
 * 实测（本夹具）：base 可用 25 / candidate 26 ⇒ delta 4% ✓。
 */
const BASE_DAYS = Array.from({ length: 40 }, (_, index) => index + 1);
const NEW_WORKOUT_DAY = 42;
const NEW_WORKOUT_FROM = "2026-02-11T00:00:00.000Z";
const NEW_WORKOUT_PREFIX_DATE = "2026-02-11";
const SECOND_NEW_WORKOUT_DAY = 44;
const SECOND_NEW_WORKOUT_FROM = "2026-02-13T00:00:00.000Z";

/** 第 n 天（从 1 起）的真实本地日期：跨月也对，不靠"1 月有 32 号"凑数。 */
const dateOfDay = (day: number): string =>
  new Date(Date.parse("2026-01-01T00:00:00.000Z") + (day - 1) * 86_400_000).toISOString().slice(0, 10);
const appleDate = (day: number, time: string): string => `${dateOfDay(day)} ${time}:00 +0800`;
const localDay = (day: number): string => dateOfDay(day);

/**
 * 合成 XML：每天一场 30 分钟跑 + 15 条心率记录（跨天的更正/新增都靠改这个数组）。
 *
 * `routes` 只为点名的 day 生成显式 `WorkoutRoute` 引用；增量批次可以只带 XML、
 * 不带 GPX 文件（T11 路线 A→B 的关键变体）。
 */
function fixtureXml(
  days: number[],
  shifted: ReadonlySet<number> = new Set(),
  routes: ReadonlyMap<number, string> = new Map()
): string {
  const workouts = days.map((day, index) => {
    const routePath = routes.get(day);
    return `
  <Workout workoutActivityType="${workoutTypes.running}" duration="30" durationUnit="min" sourceName="Fixture Apple Watch" sourceVersion="1" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" device="Watch">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <WorkoutStatistics type="${healthTypes.distanceWalkingRunning}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" sum="${(5 + index * 0.08).toFixed(2)}" unit="km"/>
    <WorkoutStatistics type="${healthTypes.heartRate}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" average="${145 + index}" minimum="120" maximum="172" unit="count/min"/>
    ${routePath === undefined ? "" : `<WorkoutRoute><FileReference path="/workout-routes/${routePath}"/></WorkoutRoute>`}
  </Workout>`;
  }).join("");
  const heartRecords = days.flatMap((day, index) =>
    Array.from({ length: 15 }, (_, sample) => {
      const minute = String(sample * 2).padStart(2, "0");
      const endMinute = String(sample * 2 + 1).padStart(2, "0");
      const shift = shifted.has(day) ? 9 : 0;
      return `
  <Record type="${healthTypes.heartRate}" sourceName="Fixture Apple Watch" sourceVersion="1" unit="count/min" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, `08:${minute}`)}" endDate="${appleDate(day, `08:${endMinute}`)}" value="${140 + index + shift + (sample % 3)}"/>`;
    })
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <ExportDate value="${appleDate(25, "12:00")}"/>
  <Me biologicalSex="HKBiologicalSexMale"/>${workouts}${heartRecords}
</HealthData>`;
}

interface Workspace { root: string; store: RaiDatabase }

async function openWorkspace(): Promise<Workspace> {
  const root = mkdtempSync(join(tmpdir(), "rai-wp32-"));
  return { root, store: await RaiDatabase.open(join(root, "rai.sqlite")) };
}

function closeWorkspace(workspace: Workspace): void {
  workspace.store.close();
  rmSync(workspace.root, { recursive: true, force: true });
}

interface IngestOptions {
  routes?: ReadonlyMap<number, string>;
  gpx?: Readonly<Record<string, string>>;
  /** 增量批次：保留本批未出现的路线，只把显式引用的路径改归新训练。 */
  preserveAbsent?: boolean;
  generation?: string;
}

/** 导入一份合成 XML 并做 canonical 分组（两次分析必须喂**同一份输入**）。 */
async function ingest(
  workspace: Workspace,
  days: number[],
  shifted?: ReadonlySet<number>,
  options: IngestOptions = {}
): Promise<void> {
  const path = join(workspace.root, "export.xml");
  writeFileSync(path, fixtureXml(days, shifted, options.routes), "utf8");
  if (options.gpx !== undefined) {
    mkdirSync(join(workspace.root, "workout-routes"), { recursive: true });
    for (const [name, content] of Object.entries(options.gpx)) {
      writeFileSync(join(workspace.root, "workout-routes", name), content, "utf8");
    }
  }
  await parseAppleHealthXml(path, workspace.store, {
    fileSize: 1,
    ...(options.preserveAbsent
      ? { incremental: { generation: options.generation ?? "wp32-route-batch", preserveAbsent: true } }
      : {})
  });
  if (options.gpx !== undefined) {
    await importGpxRoutes(workspace.root, workspace.store, { preserveAbsent: true });
  }
  canonicalizeRunningWorkouts(workspace.store.database);
}

function runAnalysis(store: RaiDatabase, plan: RecomputePlan | null, evaluatedAt: string): string {
  const service = new RaiApplicationService(store);
  if (plan === null) service.enqueueFullRecompute({ evaluatedAt, timezoneIdentifier: TZ });
  else service.enqueueIncrementalRecompute(plan, { evaluatedAt, timezoneIdentifier: TZ });
  const job = service.runNextJob();
  assert.equal(job?.status, "succeeded", `analysis job failed: ${JSON.stringify(job)}`);
  return activeModelRunId(store);
}

function activeModelRunId(store: RaiDatabase): string {
  const row = store.database.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1").get();
  assert.ok(row, "no active model run");
  return String((row as { id: string }).id);
}

function activeMetricRunId(store: RaiDatabase, modelRunId: string): string {
  const row = store.database.prepare(
    "SELECT id FROM training_metric_runs WHERE model_run_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1"
  ).get(modelRunId);
  assert.ok(row, "no succeeded metric run");
  return String((row as { id: string }).id);
}

interface ReuseCounters {
  attempted: boolean;
  proof: string;
  rejectionReason: string | null;
  loads: { reused: number; recomputed: number };
  zoneProfiles: { reused: number; recomputed: number };
  dailyMetrics: { reused: number; recomputed: number };
  checkpointWritten: boolean;
  reuseFromLocalDate: string | null;
  reuseThroughLocalDate: string | null;
}

function readReuse(store: RaiDatabase, modelRunId: string): ReuseCounters {
  const metricRunId = activeMetricRunId(store, modelRunId);
  const summary = JSON.parse(String(store.database.prepare(
    "SELECT summary_json AS json FROM training_metric_runs WHERE id = ?"
  ).get(metricRunId)?.json ?? "{}")) as { reuse?: Record<string, unknown> };
  assert.ok(summary.reuse, "per-domain reuse counters must be durable in training_metric_runs.summary_json");
  return summary.reuse as unknown as ReuseCounters;
}

function readWorkouts(store: RaiDatabase): DirtyRangeWorkout[] {
  return store.database.prepare("SELECT start_at AS startAt, end_at AS endAt FROM workouts ORDER BY start_at")
    .all() as unknown as DirtyRangeWorkout[];
}

/** Feature run 的复用计数（`feature_runs.reused/recomputed_feature_count`，durable）。 */
function readFeatureCounters(store: RaiDatabase, modelRunId: string): { reused: number; recomputed: number } {
  const row = store.database.prepare(`
    SELECT feature.reused_feature_count AS reused, feature.recomputed_feature_count AS recomputed
    FROM model_runs model JOIN feature_runs feature ON feature.id = model.feature_run_id
    WHERE model.id = ?
  `).get(modelRunId) as { reused: number; recomputed: number } | undefined;
  assert.ok(row, "feature run counters must exist");
  return { reused: Number(row.reused), recomputed: Number(row.recomputed) };
}

/** Fitness replay 的复用计数（`model_runs.reused_assessment_count`，durable）。 */
function readReusedAssessmentCount(store: RaiDatabase, modelRunId: string): number {
  const row = store.database.prepare(
    "SELECT reused_assessment_count AS reused FROM model_runs WHERE id = ?"
  ).get(modelRunId) as { reused: number } | undefined;
  assert.ok(row, "model run row must exist");
  return Number(row.reused);
}

/** P3-06 证据行：输出真实执行到的复用计数与投影行/字段数（供 evidence JSON 使用）。 */
function emitProjectionEvidence(
  scenario: string,
  store: RaiDatabase,
  modelRunId: string,
  reuse: ReuseCounters,
  features: { reused: number; recomputed: number }
): void {
  const tables = projectionStats(readBusiness(store));
  console.log(`P3-06_EVIDENCE ${JSON.stringify({
    scenario,
    reuse,
    featureCounters: features,
    reusedAssessmentCount: readReusedAssessmentCount(store, modelRunId),
    tables
  })}`);
}

interface EpochHashObservation {
  source: string;
  path: string;
  value: string | null;
}

function collectEpochHashObservations(
  value: unknown,
  source: string,
  path: string,
  sink: EpochHashObservation[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEpochHashObservations(item, source, `${path}[${index}]`, sink));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (key === "baselineEpochId" || key === "calibrationCohortHash") {
      assert.ok(child === null || typeof child === "string", `${source}${childPath}: expected string|null`);
      sink.push({ source, path: childPath, value: child });
    }
    collectEpochHashObservations(child, source, childPath, sink);
  }
}

/**
 * Every raw occurrence of the two derived hashes: lineage, daily snapshots,
 * assessment explanations and the five sealed domain payloads. These must match
 * field-by-field between incremental A and full B — no semantic substitution.
 */
function readRawEpochHashObservations(store: RaiDatabase): EpochHashObservation[] {
  const db = store.database;
  const modelRunId = activeModelRunId(store);
  const observations: EpochHashObservation[] = [];
  const lineage = db.prepare(
    "SELECT lineage_json AS json FROM model_v2_runs WHERE model_run_id = ?"
  ).get(modelRunId) as { json: string } | undefined;
  assert.ok(lineage, "model_v2_runs lineage row must exist");
  collectEpochHashObservations(JSON.parse(lineage.json), "lineage", "$", observations);
  const daily = db.prepare(`
    SELECT local_date AS localDate, baseline_epoch_id AS baselineEpochId
    FROM daily_ability_snapshots WHERE model_run_id = ? ORDER BY local_date
  `).all(modelRunId) as Array<{ localDate: string; baselineEpochId: string | null }>;
  for (const row of daily) {
    observations.push({
      source: `daily:${row.localDate}`,
      path: "$.baselineEpochId",
      value: row.baselineEpochId === null ? null : String(row.baselineEpochId)
    });
  }
  const assessments = db.prepare(`
    SELECT training_session_id AS trainingSessionId, sequence_number AS sequenceNumber,
           explanation_json AS explanationJson
    FROM ability_assessments WHERE model_run_id = ? ORDER BY sequence_number
  `).all(modelRunId) as Array<{ trainingSessionId: string; sequenceNumber: number; explanationJson: string }>;
  for (const row of assessments) {
    collectEpochHashObservations(
      JSON.parse(row.explanationJson),
      `assessment:${row.trainingSessionId}:${row.sequenceNumber}`,
      "$",
      observations
    );
  }
  const domains = db.prepare(`
    SELECT domain, snapshot_key AS snapshotKey, payload_json AS payloadJson
    FROM model_domain_snapshots WHERE model_run_id = ? ORDER BY domain, snapshot_key
  `).all(modelRunId) as Array<{ domain: string; snapshotKey: string; payloadJson: string }>;
  for (const row of domains) {
    collectEpochHashObservations(
      JSON.parse(row.payloadJson),
      `domain:${row.domain}:${row.snapshotKey}`,
      "$",
      observations
    );
  }
  return observations;
}

function readRawLineage(
  store: RaiDatabase,
  modelRunId: string
): { baselineEpochId: string | null; calibrationCohortHash: string | null } {
  const row = store.database.prepare(
    "SELECT lineage_json AS json FROM model_v2_runs WHERE model_run_id = ?"
  ).get(modelRunId) as { json: string } | undefined;
  assert.ok(row, `model_v2_runs lineage row missing for ${modelRunId}`);
  const lineage = JSON.parse(row.json) as {
    baselineEpochId?: unknown;
    calibrationCohortHash?: unknown;
  };
  assert.ok(lineage.baselineEpochId === null || typeof lineage.baselineEpochId === "string");
  assert.ok(lineage.calibrationCohortHash === null || typeof lineage.calibrationCohortHash === "string");
  return {
    baselineEpochId: lineage.baselineEpochId as string | null,
    calibrationCohortHash: lineage.calibrationCohortHash as string | null
  };
}

/**
 * A resumed run must write its **own** feature ids into every checkpoint state.
 * Carrying the parent run's ids forward would make the next `fitnessEpochId()`
 * filter an empty set (the defect this lane fixes).
 */
function assertCheckpointBaselinesUseCurrentFeatureIds(store: RaiDatabase, modelRunId: string): string[] {
  const currentFeatureIds = new Set(
    (store.database.prepare(`
      SELECT id FROM workout_features
      WHERE feature_run_id = (SELECT feature_run_id FROM model_runs WHERE id = ?)
    `).all(modelRunId) as Array<{ id: string }>).map((row) => String(row.id))
  );
  const checkpoints = store.database.prepare(`
    SELECT sequence_number AS sequenceNumber, state_json AS stateJson
    FROM model_checkpoints WHERE model_run_id = ? ORDER BY sequence_number
  `).all(modelRunId) as Array<{ sequenceNumber: number; stateJson: string }>;
  assert.ok(checkpoints.length > 0, "the resumed run must persist at least the copied checkpoint");
  let expected: string[] | null = null;
  for (const checkpoint of checkpoints) {
    const state = JSON.parse(checkpoint.stateJson) as {
      baseline?: { calibrationFeatureIds?: unknown };
    };
    assert.ok(state.baseline && Array.isArray(state.baseline.calibrationFeatureIds),
      `checkpoint ${checkpoint.sequenceNumber}: baseline.calibrationFeatureIds missing`);
    const ids = (state.baseline.calibrationFeatureIds as unknown[]).map(String);
    assert.ok(ids.length > 0, `checkpoint ${checkpoint.sequenceNumber}: empty calibration cohort`);
    for (const id of ids) {
      assert.ok(currentFeatureIds.has(id),
        `checkpoint ${checkpoint.sequenceNumber}: parent-run feature id ${id} survived into the current run`);
    }
    if (expected === null) expected = ids;
    else assert.deepEqual(ids, expected, `checkpoint ${checkpoint.sequenceNumber}: calibration cohort changed`);
  }
  return expected!;
}

function assertRawEpochHashesEqual(incremental: RaiDatabase, offline: RaiDatabase): void {
  const actual = readRawEpochHashObservations(incremental);
  const expected = readRawEpochHashObservations(offline);
  assert.deepEqual(actual, expected,
    "incremental vs offline-full: raw baselineEpochId / calibrationCohortHash must match field-by-field");
  assert.ok(actual.some((item) =>
    item.source === "lineage" && item.path === "$.baselineEpochId" && item.value !== null),
  "the fixture must persist a non-null raw lineage baselineEpochId");
  assert.ok(actual.some((item) =>
    item.source === "lineage" && item.path === "$.calibrationCohortHash" && item.value !== null),
  "the fixture must persist a non-null raw lineage calibrationCohortHash");
  assert.ok(actual.some((item) => item.source.startsWith("daily:") && item.value !== null),
    "the fixture must persist raw daily baseline_epoch_id values");
  assert.ok(actual.some((item) =>
    item.source.startsWith("assessment:") && item.path === "$.baselineEpochId" && item.value !== null),
  "the fixture must persist raw baselineEpochId values in assessment explanations");
  assert.ok(actual.some((item) =>
    item.source.startsWith("domain:") && item.path.endsWith(".lineage.baselineEpochId") && item.value !== null),
  "the fixture must persist raw lineage hashes in the sealed domain snapshots");
}

function countRows(store: RaiDatabase, table: "workout_training_loads" | "daily_zone_profiles" | "daily_training_metrics", runId: string): number {
  const row = store.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE training_metric_run_id = ?`).get(runId);
  return Number(row?.n ?? 0);
}

/** 用与直连车道**同一个纯函数**把变更归约成分域计划（口径不复制第二份）。 */
function planFor(store: RaiDatabase, changes: DirtyRangeChange[]): RecomputePlan {
  const range = planIncrementalAnalysisDirtyRange({ changes, workouts: readWorkouts(store) });
  assert.equal(range.full, false, "the synthetic change must yield a bounded plan");
  assert.notEqual(range.dirtyFromAt, null);
  return { mode: "partial", dirtySessionIds: [], dirtyFromAt: range.dirtyFromAt, domains: range.domains, reasons: range.reasons };
}

/**
 * P3-06：完整业务投影（workout_features / ability_assessments / daily_ability_snapshots /
 * model_runs + model_v2_runs lineage / model_domain_snapshots 五域 payload /
 * analysis_run_input_bindings + analysis_job_coverage）。
 *
 * 投影与比较器在 `./business-artifact-projection.ts`；这里保留原名以免改动 900 行夹具的
 * 所有调用点，同时让**每一个**既有等价用例自动升级为完整业务产物差分。
 */
function readBusiness(store: RaiDatabase): BusinessProjection {
  const projection = readBusinessProjection(store);
  // 复审 §3.4：生产 fixture 必须先满足独立的 15 表/关键列规范，再进入差分。
  assertCompleteBusinessProjection(projection, "training-metric-domain-reuse production fixture");
  return projection;
}

/** 增量库（A）与离线从头计算库（B）逐表/逐键/逐字段对照（含原始 epoch/cohort hash）。 */
function assertSameBusiness(incremental: RaiDatabase, offline: RaiDatabase): void {
  const incrementalProjection = readBusiness(incremental);
  assertBusinessEquivalent(incrementalProjection, readBusiness(offline),
    "incremental vs offline-full (P3-06 full business projection)");
  assertRawEpochHashesEqual(incremental, offline);
  const stats = projectionStats(incrementalProjection);
  assert.ok((stats.workout_features?.rows ?? 0) > 0 && (stats.daily_ability_snapshots?.rows ?? 0) > 0,
    "the comparison must not be empty-on-empty");
  // 发布投影不能是空表被 trivially 比较：每次等价的 run 都必须有 bundle、active 指针
  // 与可读状态，且 active 指针必须指向一个已激活的 bundle。
  const bundles = incrementalProjection.tables.find((table) => table.name === "model_release_bundles");
  const readable = incrementalProjection.tables.find((table) => table.name === "release_readable_state");
  assert.ok(bundles && bundles.rows.length > 0, "model_release_bundles projection must not be empty");
  assert.equal(readable?.rows.length, 1, "release_readable_state must expose exactly one active state");
  const active = readable!.rows[0] as { activeRunOrdinal: number; activeReleaseOrdinal: number; bundleStatus: string };
  const activeBundle = bundles!.rows.find((row) =>
    (row as { runOrdinal: number }).runOrdinal === active.activeRunOrdinal);
  assert.ok(activeBundle, "active pointer must resolve to a release bundle");
  assert.equal(active.activeReleaseOrdinal, active.activeRunOrdinal,
    "active_model_run and active_model_release must point at the same logical run");
  assert.equal((activeBundle as { status: string }).status, "passed");
  assert.equal((activeBundle as { activated: boolean }).activated, true);
  assert.equal(active.bundleStatus, "passed");
}

/**
 * 变更描述**从库里现取**（和 `loadDirtyRangeInput` 的 JOIN 同源）。
 *
 * 🔴 不能拿夹具里的 Apple 时间串当边界：`planIncrementalAnalysisDirtyRange` 要求
 * **规范化 ISO 时刻**，Apple 的 `+0800` 写法会让它直接判 `full`（那是它的 fail-safe，
 * 不是缺陷）。这里取的是已经入库规范化的 `workouts.start_at` / `health_records.start_at`。
 */
interface WorkoutInterval { startAt: string; endAt: string }

function readWorkoutInterval(store: RaiDatabase, predicate: string, parameter: string): WorkoutInterval {
  const row = store.database.prepare(
    `SELECT start_at AS startAt, end_at AS endAt FROM workouts WHERE ${predicate} ORDER BY start_at LIMIT 1`
  ).get(parameter) as WorkoutInterval | undefined;
  assert.ok(row, `fixture workout not found (${predicate} ${parameter})`);
  return row;
}

function readHeartRecordInterval(store: RaiDatabase, day: string): WorkoutInterval {
  const row = store.database.prepare(`
    SELECT start_at AS startAt, end_at AS endAt FROM health_records
    WHERE type = ? AND start_at >= ? AND start_at < ? ORDER BY start_at LIMIT 1
  `).get(healthTypes.heartRate, `${day}T00:00:00.000Z`, `${addDays(day, 1)}T00:00:00.000Z`) as WorkoutInterval | undefined;
  assert.ok(row, `fixture heart-rate record not found for ${day}`);
  return row;
}

function insertedWorkoutChange(interval: WorkoutInterval): DirtyRangeChange {
  return {
    entityKind: "workout", changeType: "inserted", newType: "workout",
    newStart: interval.startAt, newEnd: interval.endAt,
    previousType: null, previousStart: null, previousEnd: null
  };
}

function removedWorkoutChange(interval: WorkoutInterval): DirtyRangeChange {
  return {
    entityKind: "workout", changeType: "removed", newType: null, newStart: null, newEnd: null,
    previousType: "workout", previousStart: interval.startAt, previousEnd: interval.endAt
  };
}

/** 一个变更种类：施加方式（返回变更描述）+ 期望的复用结论。 */
interface ChangeKind {
  name: string;
  /** 基线夹具；缺省为 40 天无路线数据。 */
  base?: (workspace: Workspace) => Promise<void>;
  apply: (workspace: Workspace) => Promise<DirtyRangeChange[]>;
  expectReuse: boolean;
  /** 该变更的边界是否在校准区之后（能力时间线 replay 可续用 checkpoint）。 */
  expectAssessmentReuse?: boolean;
  /** 在 A/B 比较之外补充本场景特有的业务断言。 */
  verify?: (incremental: Workspace, runId: string) => void;
}

async function runChangeKind(kind: ChangeKind): Promise<void> {
  const incremental = await openWorkspace();
  const offline = await openWorkspace();
  try {
    for (const workspace of [incremental, offline]) {
      if (kind.base === undefined) await ingest(workspace, BASE_DAYS);
      else await kind.base(workspace);
      workspace.store.setManifest("dataset_version", `dataset_${kind.name}_before`);
      workspace.store.flush();
      // 🔴 两次全量基线是**必需的**，不是拖时间：分区/负荷的证据链（labeled / performance /
      // threshold）经 `active_model_run` 的 feature 行读取 ⇒ 库里的**首次**全量 run 是在
      // "还没有 active run"（证据为空）下算的。第二次全量让证据源成为真实存在的已发布 run，
      // 于是第三次（增量）run 与离线从头计算面对的是**同一代证据**。
      // 本工作包的证据：少了这一步，增量前缀会带着"空证据"的阈值配速，与从头计算差 5 倍负荷。
      runAnalysis(workspace.store, null, EVAL_1);
      runAnalysis(workspace.store, null, EVAL_1);
    }
    let changes: DirtyRangeChange[] = [];
    for (const workspace of [incremental, offline]) {
      changes = await kind.apply(workspace);
      workspace.store.setManifest("dataset_version", `dataset_${kind.name}_after`);
      workspace.store.flush();
    }
    const plan = planFor(incremental.store, changes);
    const incrementalRun = runAnalysis(incremental.store, plan, EVAL_2);
    runAnalysis(offline.store, null, EVAL_2);
    assertSameBusiness(incremental.store, offline.store);
    kind.verify?.(incremental, incrementalRun);
    const reuse = readReuse(incremental.store, incrementalRun);
    const metricRunId = activeMetricRunId(incremental.store, incrementalRun);
    const features = readFeatureCounters(incremental.store, incrementalRun);
    const featureRows = Number(incremental.store.database.prepare(
      "SELECT COUNT(*) AS n FROM workout_features WHERE feature_run_id = (SELECT feature_run_id FROM model_runs WHERE id = ?)"
    ).get(incrementalRun)?.n ?? 0);
    assert.equal(features.reused + features.recomputed, featureRows,
      `${kind.name}: feature reused+recomputed must equal the output set`);
    if (kind.expectReuse) {
      assert.equal(reuse.proof, "verified", `${kind.name}: expected a verified reuse proof (${reuse.rejectionReason ?? ""})`);
      assert.ok(reuse.loads.reused > 0, `${kind.name}: expected reused loads`);
      assert.ok(reuse.zoneProfiles.reused > 0, `${kind.name}: expected reused zone profiles`);
      assert.ok(reuse.dailyMetrics.reused > 0, `${kind.name}: expected reused daily metrics`);
      assert.equal(reuse.loads.reused + reuse.loads.recomputed, countRows(incremental.store, "workout_training_loads", metricRunId),
        `${kind.name}: loads reused+recomputed must equal the output set`);
      assert.equal(reuse.zoneProfiles.reused + reuse.zoneProfiles.recomputed, countRows(incremental.store, "daily_zone_profiles", metricRunId),
        `${kind.name}: zone profiles reused+recomputed must equal the output set`);
      assert.equal(reuse.dailyMetrics.reused + reuse.dailyMetrics.recomputed, countRows(incremental.store, "daily_training_metrics", metricRunId),
        `${kind.name}: daily metrics reused+recomputed must equal the output set`);
      if (kind.expectAssessmentReuse === true) {
        assert.ok(readReusedAssessmentCount(incremental.store, incrementalRun) > 0,
          `${kind.name}: Fitness/ability replay must resume at least one assessment from the checkpoint`);
      }
    } else {
      assert.equal(reuse.proof, "rejected", `${kind.name}: this change must NOT reuse a prefix`);
      assert.equal(reuse.loads.reused, 0);
      assert.equal(reuse.zoneProfiles.reused, 0);
      assert.equal(reuse.dailyMetrics.reused, 0);
      assert.notEqual(reuse.rejectionReason, null);
    }
    emitProjectionEvidence(kind.name, incremental.store, incrementalRun, reuse, features);
  } finally {
    closeWorkspace(incremental);
    closeWorkspace(offline);
  }
}

test("O09: a newly imported workout keeps the prefix and equals an offline from-scratch run", async () => {
  await runChangeKind({
    name: "new_workout", expectReuse: true, expectAssessmentReuse: true,
    apply: async (workspace) => {
      await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
      return [insertedWorkoutChange(readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM))];
    }
  });
});

/**
 * T11 端到端 A/B：XML 显式把已有路线从较早的 A 改挂到较晚的 B，**本批不附 GPX**。
 *
 * 旧实现按“本批 GPX 文件清单”快照旧归属，A 不在清单里 ⇒ A 不会进入脏范围，
 * 增量 run 会保留 A 的旧路线特征。本用例同时验证：
 * - 增量 A 与同条件全量 B 的完整业务投影（含原始 epoch/cohort）等价；
 * - A 的路线特征真实消失、B 的路线特征真实出现；
 * - 路线点与已发布版本在改归属后保留。
 */
test("P3-06 T11: an XML-only route move dirties the old owner and equals offline-full", async () => {
  const routePath = "route-1.gpx";
  const gpx = `<gpx><trk><trkseg>${[0, 1, 2].map((index) =>
    `<trkpt lat="23.1${index}" lon="113.3${index}"><ele>12.5</ele>` +
    `<time>2026-02-09T00:00:0${index}Z</time></trkpt>`
  ).join("")}</trkseg></trk></gpx>`;
  const lastBefore = (workspace: Workspace): WorkoutInterval => {
    const row = workspace.store.database.prepare(
      "SELECT start_at AS startAt, end_at AS endAt FROM workouts WHERE start_at < ? ORDER BY start_at DESC LIMIT 1"
    ).get(NEW_WORKOUT_FROM) as WorkoutInterval | undefined;
    assert.ok(row, "base fixture must have a workout before the new owner");
    return row;
  };
  const move = async (workspace: Workspace): Promise<DirtyRangeChange[]> => {
    const oldOwner = lastBefore(workspace);
    const newOwner = readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM);
    return [
      insertedWorkoutChange(newOwner),
      {
        entityKind: "route", changeType: "updated", newType: null,
        newStart: oldOwner.startAt, newEnd: oldOwner.endAt,
        previousType: null, previousStart: null, previousEnd: null
      }
    ];
  };
  await runChangeKind({
    name: "route_move_xml_only", expectReuse: true, expectAssessmentReuse: true,
    base: async (workspace) => {
      await ingest(workspace, BASE_DAYS, undefined, {
        routes: new Map([[40, routePath]]),
        gpx: { [routePath]: gpx },
        generation: "wp32-route-base"
      });
    },
    apply: async (workspace) => {
      // 增量包只有 XML：工作区里没有 workout-routes/route-1.gpx。
      await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY], undefined, {
        routes: new Map([[NEW_WORKOUT_DAY, routePath]]),
        preserveAbsent: true,
        generation: "wp32-route-move"
      });
      return move(workspace);
    },
    verify: (workspace, runId) => {
      const oldOwner = lastBefore(workspace);
      const newOwner = readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM);
      const featurePoints = (startAt: string): number => Number(workspace.store.database.prepare(`
        SELECT feature.route_point_count AS points
        FROM workout_features feature
        JOIN training_sessions session ON session.id = feature.training_session_id
        WHERE feature.feature_run_id = (SELECT feature_run_id FROM model_runs WHERE id = ?)
          AND session.anchor_start_at = ?`).get(runId, startAt)?.points ?? 0);
      assert.equal(featurePoints(oldOwner.startAt), 0,
        "A 的旧路线特征必须从增量结果中移除");
      assert.equal(featurePoints(newOwner.startAt), 3,
        "B 的新路线特征必须出现（3 个轨迹点）");
      const route = workspace.store.database.prepare(`
        SELECT workout.start_at AS startAt, route.point_count AS pointCount,
               route.published_route_version_id AS versionId
        FROM workout_routes route JOIN workouts workout ON workout.id = route.workout_id
        WHERE route.relative_path = 'workout-routes/route-1.gpx'`).get() as
        { startAt: string; pointCount: number; versionId: string | null } | undefined;
      assert.ok(route, "route row must survive the move");
      assert.equal(route.startAt, newOwner.startAt, "路线必须改归 B");
      assert.equal(Number(route.pointCount), 3, "改归属不得丢路线点");
      assert.ok(route.versionId, "改归属不得丢已发布路线版本");
    }
  });
});

/**
 * P3-06 §7.3 回归：连续多轮增量都必须把父 checkpoint 的校准 cohort 重映射到
 * **当前** feature run，从而让 raw `baselineEpochId` / `calibrationCohortHash`
 * 在每一轮都保持稳定。修复前：第一轮 resume 把父 feature id 原样带入，epoch
 * 退化成空集 hash；下一轮继续沿用，永远不会自愈。
 */
test("P3-06: consecutive incremental replay keeps the raw baseline epoch stable", async () => {
  const workspace = await openWorkspace();
  try {
    await ingest(workspace, BASE_DAYS);
    workspace.store.setManifest("dataset_version", "dataset_multi_round_before");
    workspace.store.flush();
    runAnalysis(workspace.store, null, EVAL_1);
    runAnalysis(workspace.store, null, EVAL_1);

    await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
    workspace.store.setManifest("dataset_version", "dataset_multi_round_round_1");
    workspace.store.flush();
    const inserted1 = insertedWorkoutChange(
      readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM)
    );
    const run1 = runAnalysis(workspace.store, planFor(workspace.store, [inserted1]), EVAL_2);
    assert.ok(readReusedAssessmentCount(workspace.store, run1) > 0,
      "round 1 must resume the assessment prefix from the parent checkpoint");
    const lineage1 = readRawLineage(workspace.store, run1);
    assert.notEqual(lineage1.baselineEpochId, null);
    assert.notEqual(lineage1.calibrationCohortHash, null);
    const checkpointIds1 = assertCheckpointBaselinesUseCurrentFeatureIds(workspace.store, run1);
    assert.equal(checkpointIds1.length, 15, "the fixture calibration cohort is 15 sessions");

    await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY, SECOND_NEW_WORKOUT_DAY]);
    workspace.store.setManifest("dataset_version", "dataset_multi_round_round_2");
    workspace.store.flush();
    const inserted2 = insertedWorkoutChange(
      readWorkoutInterval(workspace.store, "start_at >= ?", SECOND_NEW_WORKOUT_FROM)
    );
    const run2 = runAnalysis(workspace.store, planFor(workspace.store, [inserted2]), EVAL_3);
    assert.ok(readReusedAssessmentCount(workspace.store, run2) > 0,
      "round 2 must resume from round 1's checkpoint");
    const lineage2 = readRawLineage(workspace.store, run2);
    assert.equal(lineage2.baselineEpochId, lineage1.baselineEpochId,
      "consecutive incremental runs must not drift the raw baselineEpochId");
    assert.equal(lineage2.calibrationCohortHash, lineage1.calibrationCohortHash,
      "consecutive incremental runs must not drift the raw calibrationCohortHash");
    assertCheckpointBaselinesUseCurrentFeatureIds(workspace.store, run2);
    const dailyEpochs = workspace.store.database.prepare(`
      SELECT DISTINCT baseline_epoch_id AS epoch FROM daily_ability_snapshots WHERE model_run_id = ?
    `).all(run2).map((row) => (row as { epoch: string | null }).epoch);
    assert.deepEqual(dailyEpochs, [lineage1.baselineEpochId],
      "every daily snapshot must carry the same raw epoch as the lineage");
  } finally {
    closeWorkspace(workspace);
  }
});

/**
 * P3-06 §7.3 负对照：父 checkpoint 的 calibration cohort 一旦无法无歧义地映射到
 * 当前 run（这里用重复 id 制造歧义），resume 必须被拒绝并退回全量，而不是把
 * 过滤后的空集当成"同一标尺"继续复用。
 */
test("P3-06: a corrupt parent calibration cohort refuses the resume, never an empty cohort", async () => {
  const incremental = await openWorkspace();
  const offline = await openWorkspace();
  try {
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, BASE_DAYS);
      workspace.store.setManifest("dataset_version", "dataset_bad_cohort_before");
      workspace.store.flush();
      runAnalysis(workspace.store, null, EVAL_1);
      runAnalysis(workspace.store, null, EVAL_1);
    }
    const parentRun = activeModelRunId(incremental.store);
    const checkpoint = incremental.store.database.prepare(`
      SELECT id, state_json AS stateJson FROM model_checkpoints
      WHERE model_run_id = ? AND through_at < ?
      ORDER BY through_at DESC, sequence_number DESC LIMIT 1
    `).get(parentRun, NEW_WORKOUT_FROM) as { id: string; stateJson: string } | undefined;
    assert.ok(checkpoint, "the parent run must have a resumable checkpoint");
    const state = JSON.parse(checkpoint.stateJson) as {
      baseline: { calibrationFeatureIds: string[] };
    };
    assert.ok(state.baseline.calibrationFeatureIds.length > 1);
    // Same count as before, but a duplicate makes the remap ambiguous. The state hash
    // is recomputed so only the cohort-remap gate can reject it.
    state.baseline.calibrationFeatureIds = [
      state.baseline.calibrationFeatureIds[0]!,
      ...state.baseline.calibrationFeatureIds
    ];
    const tampered = incremental.store.database.prepare(`
      UPDATE model_checkpoints SET state_json = ?, state_hash = ? WHERE id = ?
    `).run(JSON.stringify(state), configHash(state), checkpoint.id).changes;
    assert.equal(Number(tampered), 1);

    for (const workspace of [incremental, offline]) {
      await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
      workspace.store.setManifest("dataset_version", "dataset_bad_cohort_after");
      workspace.store.flush();
    }
    const inserted = insertedWorkoutChange(
      readWorkoutInterval(incremental.store, "start_at >= ?", NEW_WORKOUT_FROM)
    );
    const incrementalRun = runAnalysis(incremental.store, planFor(incremental.store, [inserted]), EVAL_2);
    runAnalysis(offline.store, null, EVAL_2);
    assert.equal(readReusedAssessmentCount(incremental.store, incrementalRun), 0,
      "an ambiguous calibration cohort must refuse the assessment resume");
    assertSameBusiness(incremental.store, offline.store);
  } finally {
    closeWorkspace(incremental);
    closeWorkspace(offline);
  }
});

test("O09: an in-training heart-rate correction rewinds the boundary and equals an offline run", async () => {
  await runChangeKind({
    name: "in_training_correction", expectReuse: true,
    apply: async (workspace) => {
      await ingest(workspace, BASE_DAYS, new Set([13]));
      const interval = readHeartRecordInterval(workspace.store, "2026-01-13");
      return [{
        entityKind: "record", changeType: "updated",
        newType: healthTypes.heartRate, newStart: interval.startAt, newEnd: interval.endAt,
        previousType: healthTypes.heartRate, previousStart: interval.startAt, previousEnd: interval.endAt
      }];
    }
  });
});

test("O09: a deletion refuses the prefix (missing rows) and still equals an offline run", async () => {
  await runChangeKind({
    name: "deletion", expectReuse: false,
    apply: async (workspace) => {
      const target = workspace.store.database.prepare(`
        SELECT session.id AS sessionId, workout.start_at AS startAt, workout.end_at AS endAt
        FROM training_sessions session
        JOIN workouts workout ON workout.id = session.canonical_workout_id
        ORDER BY workout.start_at DESC LIMIT 1
      `).get() as { sessionId: string; startAt: string; endAt: string };
      // 重现 canonicalize 的删除形态：显式 inactive + 解除 canonical 指针。
      workspace.store.database.prepare(
        "UPDATE training_sessions SET status = 'inactive', canonical_workout_id = NULL WHERE id = ?"
      ).run(target.sessionId);
      return [removedWorkoutChange({ startAt: target.startAt, endAt: target.endAt })];
    }
  });
});

test("O09: an override change invalidates the override digest and equals an offline run", async () => {
  await runChangeKind({
    name: "override", expectReuse: false,
    apply: async (workspace) => {
      await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
      const session = workspace.store.database.prepare(`
        SELECT session.id AS sessionId FROM training_sessions session
        JOIN workouts workout ON workout.id = session.canonical_workout_id
        ORDER BY workout.start_at LIMIT 1
      `).get() as { sessionId: string };
      workspace.store.database.prepare(`
        INSERT INTO workout_overrides (id, training_session_id, revision, rpe)
        VALUES ('override_wp32', ?, 1, 8)
      `).run(session.sessionId);
      return [insertedWorkoutChange(readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM))];
    }
  });
});

test("O09: a zone-config change invalidates the settings digest and equals an offline run", async () => {
  await runChangeKind({
    name: "config", expectReuse: false,
    apply: async (workspace) => {
      await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
      workspace.store.database.prepare(`
        INSERT INTO training_zone_profile_settings (
          id, revision, effective_from_local_date, resting_mode, resting_value_bpm,
          maximum_mode, maximum_value_bpm, threshold_pace_mode, threshold_pace_seconds_per_km, created_at
        ) VALUES ('zone_settings_wp32', 2, '2026-01-01', 'auto', NULL, 'auto', NULL, 'auto', NULL, '2026-01-01T00:00:00.000Z')
      `).run();
      return [insertedWorkoutChange(readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM))];
    }
  });
});

test("O09: prefix rows are copied with run-partitioned ids and stay byte-identical", async () => {
  const workspace = await openWorkspace();
  try {
    await ingest(workspace, BASE_DAYS);
    workspace.store.setManifest("dataset_version", "dataset_copy_before");
    workspace.store.flush();
    runAnalysis(workspace.store, null, EVAL_1);
    const firstRun = runAnalysis(workspace.store, null, EVAL_1);
    const firstMetricRun = activeMetricRunId(workspace.store, firstRun);
    await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
    workspace.store.setManifest("dataset_version", "dataset_copy_after");
    workspace.store.flush();
    const plan = planFor(workspace.store, [insertedWorkoutChange(readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM))]);
    const secondRun = runAnalysis(workspace.store, plan, EVAL_2);
    const secondMetricRun = activeMetricRunId(workspace.store, secondRun);
    const reuse = readReuse(workspace.store, secondRun);
    assert.equal(reuse.proof, "verified");

    // 1) 复用的行**不携带源 run 的 id**（逐 run 分区的确定性 id 一旦沿用旧 run 就是这个缺陷本身）。
    const sharedIds = workspace.store.database.prepare(`
      SELECT COUNT(*) AS n FROM workout_training_loads fresh
      WHERE fresh.training_metric_run_id = ?
        AND EXISTS (SELECT 1 FROM workout_training_loads old
          WHERE old.training_metric_run_id = ? AND old.id = fresh.id)
    `).get(secondMetricRun, firstMetricRun)?.n;
    assert.equal(Number(sharedIds), 0, "copied loads must not keep the source run's ids");
    // 2) 外键重映射：每一行都指向**新 run** 的 feature / 分区。
    const dangling = workspace.store.database.prepare(`
      SELECT COUNT(*) AS n FROM workout_training_loads load
      WHERE load.training_metric_run_id = ?
        AND (NOT EXISTS (SELECT 1 FROM workout_features f WHERE f.id = load.feature_id AND f.feature_run_id = (
              SELECT feature_run_id FROM model_runs WHERE id = ?))
          OR NOT EXISTS (SELECT 1 FROM daily_zone_profiles p
              WHERE p.id = load.zone_profile_id AND p.training_metric_run_id = ?
                AND p.local_date = load.local_date))
    `).get(secondMetricRun, secondRun, secondMetricRun)?.n;
    assert.equal(Number(dangling), 0, "copied loads must reference the new run's feature and zone profile");
    const danglingSummaries = workspace.store.database.prepare(`
      SELECT COUNT(*) AS n FROM workout_zone_summaries z
      WHERE z.training_metric_run_id = ?
        AND NOT EXISTS (SELECT 1 FROM daily_zone_profiles p
          WHERE p.id = z.zone_profile_id AND p.training_metric_run_id = ?)
    `).get(secondMetricRun, secondMetricRun)?.n;
    assert.equal(Number(danglingSummaries), 0, "zone summaries' NOT NULL profile FK must be remapped");

    // 3) 复用前缀的业务数值逐字段不变。
    const prefixKeys = workspace.store.database.prepare(`
      SELECT training_session_id AS sessionId FROM workout_training_loads
      WHERE training_metric_run_id = ? AND local_date < ? ORDER BY training_session_id
    `).all(firstMetricRun, NEW_WORKOUT_PREFIX_DATE) as unknown as Array<{ sessionId: string }>;
    assert.ok(prefixKeys.length > 0);
    for (const { sessionId } of prefixKeys) {
      const oldRow = workspace.store.database.prepare(`
        SELECT training_load AS load, intensity, load_source AS source, confidence, stimulus_type AS stimulusType,
               explanation_codes_json AS codes, distance_factor AS distanceFactor,
               distance_reference_meters AS distanceReference, elevation_gain_meters AS elevation
        FROM workout_training_loads WHERE training_metric_run_id = ? AND training_session_id = ?
      `).get(firstMetricRun, sessionId) as Record<string, unknown>;
      const newRow = workspace.store.database.prepare(`
        SELECT training_load AS load, intensity, load_source AS source, confidence, stimulus_type AS stimulusType,
               explanation_codes_json AS codes, distance_factor AS distanceFactor,
               distance_reference_meters AS distanceReference, elevation_gain_meters AS elevation
        FROM workout_training_loads WHERE training_metric_run_id = ? AND training_session_id = ?
      `).get(secondMetricRun, sessionId) as Record<string, unknown>;
      assert.deepEqual(newRow, oldRow, `reused prefix load for ${sessionId} changed`);
    }
    const oldDaily = workspace.store.database.prepare(`
      SELECT local_date AS localDate, daily_load AS load, acute_ewma AS acuteEwma, chronic_ewma AS chronicEwma,
             training_status AS trainingStatus, explanation_codes_json AS codes, history_days AS historyDays,
             load_workout_count AS loadWorkoutCount
      FROM daily_training_metrics WHERE training_metric_run_id = ? AND local_date < ? ORDER BY local_date
    `).all(firstMetricRun, NEW_WORKOUT_PREFIX_DATE);
    const newDaily = workspace.store.database.prepare(`
      SELECT local_date AS localDate, daily_load AS load, acute_ewma AS acuteEwma, chronic_ewma AS chronicEwma,
             training_status AS trainingStatus, explanation_codes_json AS codes, history_days AS historyDays,
             load_workout_count AS loadWorkoutCount
      FROM daily_training_metrics WHERE training_metric_run_id = ? AND local_date < ? ORDER BY local_date
    `).all(secondMetricRun, NEW_WORKOUT_PREFIX_DATE);
    assert.deepEqual(newDaily, oldDaily, "reused prefix daily metrics changed");
  } finally {
    closeWorkspace(workspace);
  }
});

test("O09: a tampered checkpoint state is refused (hash), never resumed from defaults", async () => {
  const incremental = await openWorkspace();
  const offline = await openWorkspace();
  try {
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, BASE_DAYS);
      workspace.store.setManifest("dataset_version", "dataset_tamper_before");
      workspace.store.flush();
      runAnalysis(workspace.store, null, EVAL_1);
      runAnalysis(workspace.store, null, EVAL_1);
    }
    // 伪造：把 state_json 里**日级平滑种子**改掉，形状仍然合法、也仍然能被解析 ——
    // 唯一挡住它的就是 `state_hash`。这正是"把默认值/被改过的值当历史"的形态：
    // 状态看起来还是那个状态，但它已经不是写入侧算过的那一份。
    // 断言**拒绝原因**而不只是"拒绝了"：少了完整性戳，下一道（种子 vs 库中事实）
    // 也会拒绝，但那是另一个原因 —— 原因的差别正是这一层的可观测面。
    const tampered = incremental.store.database.prepare(`
      UPDATE training_metric_checkpoints
      SET state_json = json_set(state_json, '$.daily.acuteEwma', 999)
      WHERE training_metric_run_id = ?
    `).run(activeMetricRunId(incremental.store, activeModelRunId(incremental.store))).changes;
    assert.equal(Number(tampered), 1, "the checkpoint row must have been written by the baseline run");
    await ingest(incremental, [...BASE_DAYS, NEW_WORKOUT_DAY]);
    incremental.store.setManifest("dataset_version", "dataset_tamper_after");
    incremental.store.flush();
    await ingest(offline, [...BASE_DAYS, NEW_WORKOUT_DAY]);
    offline.store.setManifest("dataset_version", "dataset_tamper_after");
    offline.store.flush();
    const inserted = insertedWorkoutChange(readWorkoutInterval(incremental.store, "start_at >= ?", NEW_WORKOUT_FROM));
    const incrementalRun = runAnalysis(incremental.store, planFor(incremental.store, [inserted]), EVAL_2);
    runAnalysis(offline.store, null, EVAL_2);
    const reuse = readReuse(incremental.store, incrementalRun);
    assert.equal(reuse.proof, "rejected", "a tampered checkpoint state must not be reused");
    assert.equal(reuse.rejectionReason, "checkpoint_state");
    assert.equal(reuse.loads.reused, 0);
    assertSameBusiness(incremental.store, offline.store);
  } finally {
    closeWorkspace(incremental);
    closeWorkspace(offline);
  }
});

test("O09: a prefix whose daily rows no longer match is narrowed, not copied", async () => {
  const workspace = await openWorkspace();
  const offline = await openWorkspace();
  try {
    for (const target of [workspace, offline]) {
      await ingest(target, BASE_DAYS);
      target.store.setManifest("dataset_version", "dataset_prefix_before");
      target.store.flush();
      runAnalysis(target.store, null, EVAL_1);
      runAnalysis(target.store, null, EVAL_1);
    }
    const baselineRun = activeModelRunId(workspace.store);
    const baselineMetricRun = activeMetricRunId(workspace.store, baselineRun);
    // 篡改父 run 前缀里的一天（不是链尾那天，所以 checkpoint 的种子比对仍然通过）：
    // 前缀证明必须发现"父 run 的行 ≠ 用父 run 前缀负荷重算的行"。
    const day = workspace.store.database.prepare(
      "SELECT MIN(local_date) AS localDate FROM daily_training_metrics WHERE training_metric_run_id = ?"
    ).get(baselineMetricRun) as { localDate: string };
    const bumped = workspace.store.database.prepare(
      "UPDATE daily_training_metrics SET daily_load = daily_load + 3 WHERE training_metric_run_id = ? AND local_date = ?"
    ).run(baselineMetricRun, addDays(day.localDate, 1)).changes;
    assert.equal(Number(bumped), 1);
    for (const target of [workspace, offline]) {
      await ingest(target, [...BASE_DAYS, NEW_WORKOUT_DAY]);
      target.store.setManifest("dataset_version", "dataset_prefix_after");
      target.store.flush();
    }
    // 离线库的父 run 没被篡改 ⇒ 它的全量结果就是"正确值"；增量库必须收敛到同一个值。
    const inserted = insertedWorkoutChange(readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM));
    const incrementalRun = runAnalysis(workspace.store, planFor(workspace.store, [inserted]), EVAL_2);
    runAnalysis(offline.store, null, EVAL_2);
    const reuse = readReuse(workspace.store, incrementalRun);
    assert.equal(reuse.proof, "verified", "divergence narrows the prefix instead of discarding everything");
    assert.ok(reuse.dailyMetrics.reused < Number(workspace.store.database.prepare(
      "SELECT COUNT(*) AS n FROM daily_training_metrics WHERE training_metric_run_id = ?"
    ).get(activeMetricRunId(workspace.store, incrementalRun))?.n),
      "the mismatching day and everything after it must be recomputed");
    assertSameBusiness(workspace.store, offline.store);
  } finally {
    closeWorkspace(workspace);
    closeWorkspace(offline);
  }
});

/**
 * 批量恢复事实读取的**逐字段等价**证明（O09 步骤 5）。
 *
 * 判据不是"两个函数返回值差不多"：`loadDatedRecoveryFactsBatch` 与逐日 `loadDatedRecoveryFacts`
 * 必须给出**同一个对象**（含 `asOf`、signals 的 observedAt/availableAt/availabilitySource、
 * nights 数组），因为下游 `assessDatedReadiness` 会拿这些字段做可用性判定。
 * 夹具刻意包含：发布完成时刻之前的日（`publicationAt` 必须为 null）、正好等于发布时刻的日、
 * HRV 一天多条（取值口径 = `computed_at` 最新且 `window_end_at <= asOf`）、
 * 以及只有 6 天基线（不足 7 天 ⇒ 基线必须为 null）的窗口。
 */
test("O09: the batched recovery-fact read is field-identical to the per-day read", async () => {
  const workspace = await openWorkspace();
  try {
    const db = workspace.store.database;
    const importCompletedAt = "2026-01-20T02:00:00.000Z";
    db.prepare("INSERT INTO import_manifest (key, value) VALUES ('import_completed_at', ?)").run(importCompletedAt);
    for (let day = 1; day <= 24; day += 1) {
      const wakeDate = localDay(day);
      const wakeAt = `${localDay(day)}T00:30:00.000Z`;
      db.prepare(`INSERT INTO canonical_nights (
        id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank, has_stages,
        sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
        stage_minutes_json, segment_count, provenance_json, computed_at
      ) VALUES (?, ?, ?, 'main', 'Watch', 'apple_watch', 1, 0, ?, ?, ?, ?, 0, '{}', 1, '{}', ?)`)
        .run(`night_${day}`, wakeDate, TZ, `${localDay(day)}T00:00:00.000Z`, wakeAt, 420 + (day % 5) * 3, 450, `${localDay(day)}T01:00:00.000Z`);
      db.prepare(`INSERT INTO canonical_hrv_days (
        id, local_date, timezone_identifier, night_id, hrv_sdnn_ms, sample_count, confidence,
        window_start_at, window_end_at, source_name, provenance_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, 4, 'confident', ?, ?, 'Watch', '{}', ?)`)
        .run(`hrv_${day}_a`, wakeDate, TZ, `night_${day}`, 48 + (day % 7), `${localDay(day)}T00:00:00.000Z`,
          `${localDay(day)}T00:20:00.000Z`, `${localDay(day)}T00:25:00.000Z`);
      for (const hour of ["01", "13", "23"]) {
        db.prepare(`INSERT INTO health_records (
          id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json
        ) VALUES (?, ?, 'Watch', 'apple_watch', 'count/min', ?, ?, ?, '{}', '{}')`)
          .run(`rhr_${day}_${hour}`, healthTypes.restingHeartRate, 52 + (day % 6),
            `${localDay(day)}T${hour}:00:00.000Z`, `${localDay(day)}T${hour}:00:30.000Z`);
      }
    }
    // 只有 6 天基线的窗口（起点附近）：基线必须为 null，而批量路径不能"补齐"成 7 天。
    const days = Array.from({ length: 22 }, (_, index) => addDays("2026-01-01", index));
    // `asOf` = 那一天**本地日的日终**（min 到全局截止），与生产入口逐字同义。
    const requests = days.map((localDate) => ({
      localDate,
      asOf: new Date(Math.min(
        Date.parse(localDateStartAt(addDays(localDate, 1), TZ)) - 1,
        Date.parse("2026-01-24T04:00:00.000Z")
      )).toISOString()
    }));
    const batched = loadDatedRecoveryFactsBatch(db, requests, TZ);
    assert.equal(batched.length, requests.length);
    for (const [index, request] of requests.entries()) {
      const single = loadDatedRecoveryFacts(db, request.asOf, TZ);
      assert.deepEqual(batched[index], single, `day ${request.localDate}: batched facts differ from the per-day read`);
    }
    // 发布时刻之前的日子：rhr 的可用时刻必须是 null（不得提前拿到后来的发布）。
    const beforePublication = batched.find((facts) => facts.localDate === "2026-01-15")!;
    assert.equal(beforePublication.signals.rhr.availableAt, null);
    assert.equal(beforePublication.signals.rhr.availabilitySource, "unknown");
    // 整段物理状态：批量入口 vs **逐日 7 条 SQL** 的显式循环，必须逐位一致。
    const perDay: Array<{ localDate: string; physState: string }> = [];
    for (let date = "2026-01-01"; date <= "2026-01-24"; date = addDays(date, 1)) {
      const end = Date.parse(localDateStartAt(addDays(date, 1), TZ)) - 1;
      const asOf = new Date(Math.min(end, Date.parse("2026-01-24T04:00:00.000Z"))).toISOString();
      perDay.push({ localDate: date, physState: physStateFromReadiness(loadDatedReadiness(db, asOf, TZ)) });
    }
    assert.deepEqual(loadDailyPhysEvidence(db, "2026-01-01", "2026-01-24", TZ, "2026-01-24T04:00:00.000Z"), perDay);
    assert.ok(perDay.some((row) => row.physState !== "unknown"), "the fixture must exercise a classified day");
  } finally {
    closeWorkspace(workspace);
  }
});

test("O09: the checkpoint records versions, digests and rolling state (and hashes them)", async () => {
  const workspace = await openWorkspace();
  try {
    await ingest(workspace, BASE_DAYS);
    workspace.store.setManifest("dataset_version", "dataset_checkpoint");
    workspace.store.flush();
    runAnalysis(workspace.store, null, EVAL_1);
    const modelRunId = runAnalysis(workspace.store, null, EVAL_1);
    const metricRunId = activeMetricRunId(workspace.store, modelRunId);
    const row = workspace.store.database.prepare(
      "SELECT * FROM training_metric_checkpoints WHERE training_metric_run_id = ?"
    ).get(metricRunId) as Record<string, unknown>;
    assert.ok(row, "the baseline run must write a checkpoint");
    assert.equal(row.checkpoint_version, "rai-training-metric-checkpoint-v2");
    assert.equal(row.load_algorithm_version, "training-load-config-v5");
    assert.equal(row.zone_algorithm_version, "training-zone-config-v4");
    assert.equal(row.daily_algorithm_version, "rai-daily-metric-v2");
    assert.equal(row.timezone_identifier, TZ);
    assert.equal(row.through_local_date, "2026-02-10");
    // R05：两列摘要各有职责，同一处写出 —— 身份摘要（含代次）留作谱系；复用判据读的是
    // **前缀兼容摘要**（不含代次）。空串 = 缺证明（核验方会拒绝），不允许出现。
    assert.equal(typeof row.input_binding_digest, "string", "身份摘要必须留作谱系证据");
    assert.equal(typeof row.prefix_compat_digest, "string", "前缀兼容摘要必须与 checkpoint 同批落库");
    assert.notEqual(row.prefix_compat_digest, "", "prefix_compat_digest 不允许为空串");
    const state = JSON.parse(String(row.state_json)) as {
      version: string; distanceQueueComplete: boolean; distanceQueue: Array<{ observedAt: string; distanceMeters: number }>;
      zonePrevious: { localDate: string } | null; daily: { acuteEwma: number; chronicEwma: number } | null;
    };
    assert.equal(state.version, "rai-training-metric-checkpoint-v2");
    assert.equal(configHash(state), row.state_hash, "state_hash must be the write-side integrity stamp");
    assert.equal(state.distanceQueueComplete, true);
    assert.equal(state.distanceQueue.length, BASE_DAYS.length, "every non-excluded workout is in the 90-day queue");
    assert.equal(state.zonePrevious?.localDate, "2026-02-10");
    assert.ok(state.daily !== null && Number.isFinite(state.daily.acuteEwma) && state.daily.acuteEwma > 0,
      "the daily smoothing seed must be a real value, never a default zero");
    const rate = workspace.store.database.prepare(
      "SELECT acute_ewma AS acute, chronic_ewma AS chronic FROM daily_training_metrics WHERE training_metric_run_id = ? AND local_date = ?"
    ).get(metricRunId, "2026-02-10") as { acute: number; chronic: number };
    assert.equal(state.daily!.acuteEwma, Number(rate.acute));
    assert.equal(state.daily!.chronicEwma, Number(rate.chronic));
  } finally {
    closeWorkspace(workspace);
  }
});

/**
 * 证据链与链尾的拒绝路径（O09 步骤 7：证明失败不假装成功）。
 *
 * 这两条守的是**同一类**缺陷：前缀看起来"有状态"，但那份状态不是在**这次**的输入下算出来的。
 * 分区/负荷的证据链有三类经 `active_model_run` 的 feature 行读取（labeled / performance /
 * threshold），所以库里**首次**全量 run 是在"还没有 active run、证据为空"的条件下算出的；
 * 而链尾（`zoneStart-1` 那天的分区）是百分比/配速带继承的起点，被改动后照抄会让后缀
 * 从一份不存在过的状态续算。两者都必须拒绝复用并退回全量。
 */
test("O09: a parent computed without an evidence source is refused, never resumed from defaults", async () => {
  const incremental = await openWorkspace();
  const offline = await openWorkspace();
  try {
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, BASE_DAYS);
      workspace.store.setManifest("dataset_version", "dataset_no_source_before");
      workspace.store.flush();
      // 只有**一次**基线：写入 checkpoint 时 active run 还不存在 ⇒ 证据源为空。
      runAnalysis(workspace.store, null, EVAL_1);
      await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
      workspace.store.setManifest("dataset_version", "dataset_no_source_after");
      workspace.store.flush();
    }
    const inserted = insertedWorkoutChange(readWorkoutInterval(incremental.store, "start_at >= ?", NEW_WORKOUT_FROM));
    const incrementalRun = runAnalysis(incremental.store, planFor(incremental.store, [inserted]), EVAL_2);
    runAnalysis(offline.store, null, EVAL_2);
    const reuse = readReuse(incremental.store, incrementalRun);
    assert.equal(reuse.proof, "rejected");
    assert.equal(reuse.rejectionReason, "evidence_source_missing");
    assert.equal(reuse.loads.reused, 0);
    assertSameBusiness(incremental.store, offline.store);
  } finally {
    closeWorkspace(incremental);
    closeWorkspace(offline);
  }
});

test("O09: a parent whose zone-chain tail no longer matches the checkpoint is refused", async () => {
  const incremental = await openWorkspace();
  const offline = await openWorkspace();
  try {
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, BASE_DAYS);
      workspace.store.setManifest("dataset_version", "dataset_tail_before");
      workspace.store.flush();
      runAnalysis(workspace.store, null, EVAL_1);
      runAnalysis(workspace.store, null, EVAL_1);
    }
    // 改动父 run 的链尾（`through_local_date` 那天那一行）：checkpoint 里的链尾快照与
    // 库中事实不再一致 ⇒ 必须拒绝，而不是"从这份被改过的状态续算"。
    const parentRun = activeModelRunId(incremental.store);
    const parentMetricRun = activeMetricRunId(incremental.store, parentRun);
    const tail = incremental.store.database.prepare(
      "SELECT MAX(local_date) AS localDate FROM daily_zone_profiles WHERE training_metric_run_id = ?"
    ).get(parentMetricRun) as { localDate: string };
    const tampered = incremental.store.database.prepare(`
      UPDATE daily_zone_profiles SET maximum_heart_rate_bpm = 181
      WHERE training_metric_run_id = ? AND local_date = ?
    `).run(parentMetricRun, tail.localDate).changes;
    assert.equal(Number(tampered), 1);
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
      workspace.store.setManifest("dataset_version", "dataset_tail_after");
      workspace.store.flush();
    }
    const inserted = insertedWorkoutChange(readWorkoutInterval(incremental.store, "start_at >= ?", NEW_WORKOUT_FROM));
    const incrementalRun = runAnalysis(incremental.store, planFor(incremental.store, [inserted]), EVAL_2);
    runAnalysis(offline.store, null, EVAL_2);
    const reuse = readReuse(incremental.store, incrementalRun);
    assert.equal(reuse.proof, "rejected");
    assert.equal(reuse.rejectionReason, "zone_chain_mismatch");
    assertSameBusiness(incremental.store, offline.store);
  } finally {
    closeWorkspace(incremental);
    closeWorkspace(offline);
  }
});

/**
 * P3-06 / T13：VO2Max-only 计划在**两个独立库**上做 A（有界增量）与 B（从头全量）
 * 的完整业务产物差分（不是同一库先增量后全量的折中证明）。
 *
 * 复用判据：loads/zones/daily 前缀真实复用，feature 只重算与样本相交的 1 场，
 * Fitness 时间线从边界前的 checkpoint 续算（reusedAssessmentCount>0），且最终
 * 全部业务表（含 5+2 个域封存快照）逐字段等价。
 */
test("P3-06 T13: VO2Max-only bounded reuse equals offline-full on the full business projection", async () => {
  const incremental = await openWorkspace();
  const offline = await openWorkspace();
  const vo2ObservedAt = "2026-02-09T00:10:00.000Z";
  const expectedBoundary = "2026-02-09T00:00:00.000Z";
  try {
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, BASE_DAYS);
      workspace.store.setManifest("dataset_version", "dataset_vo2_before");
      workspace.store.flush();
      runAnalysis(workspace.store, null, EVAL_1);
      runAnalysis(workspace.store, null, EVAL_1);
      workspace.store.insertRecord({
        id: "record_p3_vo2_fixture", type: healthTypes.vo2Max, sourceName: "Fixture Apple Watch",
        sourceVersion: "1", device: "Watch", unit: "mL/min*kg", numericValue: 56, textValue: null,
        startAt: vo2ObservedAt, endAt: vo2ObservedAt, createdAt: vo2ObservedAt, metadata: {}
      }, "apple_watch", {});
      workspace.store.setManifest("dataset_version", "dataset_vo2_after");
      workspace.store.flush();
    }
    const range = planIncrementalAnalysisDirtyRange({
      changes: [{
        entityKind: "record", changeType: "inserted",
        newType: healthTypes.vo2Max, newStart: vo2ObservedAt, newEnd: vo2ObservedAt,
        previousType: null, previousStart: null, previousEnd: null
      }],
      workouts: readWorkouts(incremental.store)
    });
    assert.equal(range.full, false, "VO2Max-only must stay a bounded plan");
    assert.equal(range.dirtyFromAt, expectedBoundary);
    assert.ok(range.reasons.includes("vo2_evidence_changed"));
    const plan: RecomputePlan = {
      mode: "partial", dirtySessionIds: [],
      dirtyFromAt: range.dirtyFromAt, domains: range.domains, reasons: range.reasons
    };
    const incrementalRun = runAnalysis(incremental.store, plan, EVAL_2);
    runAnalysis(offline.store, null, EVAL_2);
    assertSameBusiness(incremental.store, offline.store);

    const reuse = readReuse(incremental.store, incrementalRun);
    assert.equal(reuse.proof, "verified", `VO2 plan must reuse (${reuse.rejectionReason ?? "none"})`);
    assert.ok(reuse.loads.reused > 0 && reuse.zoneProfiles.reused > 0 && reuse.dailyMetrics.reused > 0);
    assert.equal(reuse.loads.reused, BASE_DAYS.length - 1);
    assert.equal(reuse.loads.recomputed, 1);
    const features = readFeatureCounters(incremental.store, incrementalRun);
    assert.equal(features.reused, BASE_DAYS.length - 1);
    assert.equal(features.recomputed, 1);
    assert.ok(readReusedAssessmentCount(incremental.store, incrementalRun) > 0,
      "Fitness replay must resume the pre-boundary assessment prefix");
    const metricRunId = activeMetricRunId(incremental.store, incrementalRun);
    assert.equal(reuse.loads.reused + reuse.loads.recomputed, countRows(incremental.store, "workout_training_loads", metricRunId));
    assert.equal(reuse.zoneProfiles.reused + reuse.zoneProfiles.recomputed, countRows(incremental.store, "daily_zone_profiles", metricRunId));
    assert.equal(reuse.dailyMetrics.reused + reuse.dailyMetrics.recomputed, countRows(incremental.store, "daily_training_metrics", metricRunId));
    emitProjectionEvidence("vo2_only", incremental.store, incrementalRun, reuse, features);
  } finally {
    closeWorkspace(incremental);
    closeWorkspace(offline);
  }
});

/**
 * P3-06：直连车道的输入绑定/覆盖证据。A 走有界增量（executed plan = partial），
 * B 走同批次的从头全量（rebuild）；两边 binding 的业务输入字段与 coverage 账本
 * 必须一致，且完整业务产物等价。
 */
test("P3-06: direct-lane input binding and coverage evidence agree with offline-full", async () => {
  const incremental = await openWorkspace();
  const offline = await openWorkspace();
  const batchId = "batch_p3_binding";
  try {
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, BASE_DAYS);
      workspace.store.setManifest("dataset_version", "dataset_p3_binding_before");
      workspace.store.flush();
      await runDirectTask(workspace, { batchId: "batch_p3_binding_base1", evaluatedAt: EVAL_1, plan: null, targetRaw: 0, targetDependency: 0 });
      await runDirectTask(workspace, { batchId: "batch_p3_binding_base2", evaluatedAt: EVAL_1, plan: null, targetRaw: 0, targetDependency: 0 });
    }
    let changes: DirtyRangeChange[] = [];
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
      workspace.store.setManifest("dataset_version", "dataset_p3_binding_after");
      workspace.store.flush();
      changes = [commitDeltaBatch(workspace, batchId)];
    }
    const incrementalRun = await runDirectTask(incremental, {
      batchId, evaluatedAt: EVAL_2, plan: planFor(incremental.store, changes), targetRaw: 1, targetDependency: 1
    });
    const offlineRun = await runDirectTask(offline, {
      batchId, evaluatedAt: EVAL_2, plan: null, targetRaw: 1, targetDependency: 1
    });
    assertSameBusiness(incremental.store, offline.store);

    const binding = (store: RaiDatabase, runId: string) => {
      const row = store.database.prepare(`
        SELECT executed_plan_json AS plan, job_id AS jobId, dataset_version AS datasetVersion,
               captured_raw_generation AS capturedRaw, captured_dependency_generation AS capturedDependency,
               timezone_identifier AS timezone, override_digest AS overrideDigest, config_digest AS configDigest
        FROM analysis_run_input_bindings WHERE run_id = ?
      `).get(runId) as Record<string, unknown> | undefined;
      assert.ok(row, `binding row missing for ${runId}`);
      return row;
    };
    const incrementalBinding = binding(incremental.store, incrementalRun);
    const offlineBinding = binding(offline.store, offlineRun);
    assert.equal((JSON.parse(String(incrementalBinding.plan)) as { mode: string }).mode, "partial");
    assert.equal((JSON.parse(String(offlineBinding.plan)) as { mode: string }).mode, "rebuild");
    for (const field of ["datasetVersion", "capturedRaw", "capturedDependency", "timezone", "overrideDigest", "configDigest"]) {
      assert.deepEqual(incrementalBinding[field], offlineBinding[field], `binding.${field}`);
    }
    const coverage = (store: RaiDatabase, jobId: unknown) => store.database.prepare(`
      SELECT import_batch_id AS batchId, dependency_generation_from AS fromGeneration,
             dependency_generation_to AS toGeneration
      FROM analysis_job_coverage WHERE job_id = ? ORDER BY import_batch_id
    `).all(String(jobId));
    assert.deepEqual(coverage(incremental.store, incrementalBinding.jobId), coverage(offline.store, offlineBinding.jobId));
    assert.ok((coverage(incremental.store, incrementalBinding.jobId) as Array<{ batchId: string }>).some((row) => row.batchId === batchId));
    const reuse = readReuse(incremental.store, incrementalRun);
    assert.equal(reuse.proof, "verified");
    assert.ok(reuse.loads.reused > 0);
    emitProjectionEvidence("direct_binding", incremental.store, incrementalRun, reuse, readFeatureCounters(incremental.store, incrementalRun));
  } finally {
    closeWorkspace(incremental);
    closeWorkspace(offline);
  }
});

// ===================== R05（2026-10-16 复查）：直连车道的前缀复用 =====================
//
// 复查证据：生产增量路径（直连任务）的负荷／分区／日级前缀复用被**代次摘要恒定拒绝**
// （原因码 `input_binding`）—— 一条心率更正仍重算 7 次训练、46 天分区和日指标。
// 根因：旧复用判据 `input_binding_digest` 含 raw／dependency 代次，而每批导入都推进代次。
// 修复：判据拆成「前缀兼容摘要（不含代次）＋**覆盖基线存在**（旧发布输入绑定）」。
// 下面两条：合法直连增量必须真的复用；没有覆盖基线（CLI 直接发布 / 从未发布）时必须拒绝。

/** 直连任务登记 + 执行（与 `direct-sync-ingest.ts` 登记端同形状的最小版本）。 */
async function runDirectTask(
  workspace: Workspace,
  options: {
    batchId: string;
    evaluatedAt: string;
    plan: RecomputePlan | null;
    targetRaw: number;
    targetDependency: number;
  }
): Promise<string> {
  workspace.store.flush();
  const input = RaiDatabase.openReadonly(join(workspace.root, "rai.sqlite"));
  try {
    const reader = new SqliteAnalysisInputReader(input);
    const service = new RaiApplicationService(workspace.store, "owned", undefined, undefined, reader);
    const datasetVersion = String(workspace.store.database.prepare(
      "SELECT value FROM import_manifest WHERE key = 'dataset_version'"
    ).get()?.value ?? "dataset_unknown");
    new RecomputeJobRepository(workspace.store.database).enqueue(
      "import",
      datasetVersion,
      {
        mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
        importBatchId: options.batchId,
        evaluatedAt: options.evaluatedAt,
        timezoneIdentifier: TZ,
        ...(options.plan === null
          ? {}
          : { incrementalPlan: { mode: "partial", dirtyFromAt: options.plan.dirtyFromAt, domains: options.plan.domains } })
      },
      { targetRawGeneration: options.targetRaw, targetDependencyGeneration: options.targetDependency }
    );
    const job = service.runNextJob();
    assert.equal(job?.status, "succeeded", `direct task failed: ${JSON.stringify(job?.error ?? job)}`);
    return String(job?.modelRunId);
  } finally {
    input.close();
  }
}

/** 第二批落库：真实成功批次行 + 账本 + 两个代次推进（与直连接收端同形状）。 */
function commitDeltaBatch(workspace: Workspace, batchId: string): DirtyRangeChange {
  const inserted = insertedWorkoutChange(readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM));
  const workout = workspace.store.database.prepare(
    "SELECT id AS workoutId, start_at AS startAt FROM workouts WHERE start_at >= ? ORDER BY start_at LIMIT 1"
  ).get(NEW_WORKOUT_FROM) as { workoutId: string; startAt: string };
  workspace.store.database.prepare(`
    INSERT INTO import_batches (
      id, xml_sha256, status, import_mode, created_at, raw_generation, dependency_generation, dependency_bumped
    ) VALUES (?, ?, 'succeeded', 'incremental', ?, 1, 1, 1)
  `).run(batchId, "0".repeat(64), new Date().toISOString());
  workspace.store.database.prepare(`
    INSERT INTO import_entity_changes (batch_id, entity_kind, entity_id, change_type, effective_at)
    VALUES (?, 'workout', ?, 'inserted', ?)
  `).run(batchId, workout.workoutId, workout.startAt);
  workspace.store.database.prepare(
    "UPDATE import_generations SET raw_generation = 1, dependency_generation = 1 WHERE singleton = 1"
  ).run();
  return inserted;
}

test("R05: 连续两次真实直连增量（代次不同）仍然复用安全前缀，不再恒定拒绝", async () => {
  const workspace = await openWorkspace();
  try {
    await ingest(workspace, BASE_DAYS);
    workspace.store.setManifest("dataset_version", "dataset_r05_before");
    workspace.store.flush();
    // 两次直连全量基线：第一次建立发布、第二次让"证据源"成为真实存在的已发布 run
    //（与 CLI 用例的两次全量同理；直连发布会在发布事务里写下输入绑定 —— 覆盖基线的载体）。
    await runDirectTask(workspace, { batchId: "batch_r05_a1", evaluatedAt: EVAL_1, plan: null, targetRaw: 0, targetDependency: 0 });
    await runDirectTask(workspace, { batchId: "batch_r05_a2", evaluatedAt: EVAL_1, plan: null, targetRaw: 0, targetDependency: 0 });

    await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
    workspace.store.setManifest("dataset_version", "dataset_r05_after");
    workspace.store.flush();
    const inserted = commitDeltaBatch(workspace, "batch_r05_delta");

    const incrementalRun = await runDirectTask(workspace, {
      batchId: "batch_r05_delta",
      evaluatedAt: EVAL_2,
      plan: planFor(workspace.store, [inserted]),
      targetRaw: 1,
      targetDependency: 1
    });
    const reuse = readReuse(workspace.store, incrementalRun);
    assert.equal(reuse.proof, "verified",
      `直连增量必须复用安全前缀（拒绝原因：${reuse.rejectionReason ?? "none"}）`);
    assert.ok(reuse.loads.reused > 0, "loads 前缀必须真的被复用");
    assert.ok(reuse.zoneProfiles.reused > 0, "分区前缀必须真的被复用");
    assert.ok(reuse.dailyMetrics.reused > 0, "日级前缀必须真的被复用");
    // 复用计数与真实落库行数一致（不是只报了数）。
    const rowsInRun = Number(workspace.store.database.prepare(
      "SELECT COUNT(*) AS n FROM workout_training_loads WHERE training_metric_run_id = ?"
    ).get(activeMetricRunId(workspace.store, incrementalRun))?.n ?? 0);
    assert.equal(reuse.loads.reused + reuse.loads.recomputed, rowsInRun);
  } finally {
    closeWorkspace(workspace);
  }
});

test("R05: 无可信覆盖基线（历史发布无输入绑定）的直连增量拒绝复用 —— 不允许把无法证明的前缀当安全", async () => {
  const workspace = await openWorkspace();
  try {
    await ingest(workspace, BASE_DAYS);
    workspace.store.setManifest("dataset_version", "dataset_r05_nobase_before");
    workspace.store.flush();
    // 同一条车道（直连发布写直连形状的 checkpoint），但把旧发布的**输入绑定**去掉 ——
    // 等价于 v39 之前的老发布 / 绑定行缺失的历史库：checkpoint 在，覆盖基线不在。
    // 摘要匹配（prefix_compat ✓）而基线缺失 ⇒ 必须拒于 `coverage_base_missing`，
    // 而不是"反正摘要对了就复用"。
    await runDirectTask(workspace, { batchId: "batch_r05_nb_a1", evaluatedAt: EVAL_1, plan: null, targetRaw: 0, targetDependency: 0 });
    await runDirectTask(workspace, { batchId: "batch_r05_nb_a2", evaluatedAt: EVAL_1, plan: null, targetRaw: 0, targetDependency: 0 });
    workspace.store.database.prepare(
      "DELETE FROM analysis_run_input_bindings WHERE run_id = ?"
    ).run(activeModelRunId(workspace.store));
    workspace.store.flush();

    await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
    workspace.store.setManifest("dataset_version", "dataset_r05_nobase_after");
    workspace.store.flush();
    const inserted = commitDeltaBatch(workspace, "batch_r05_nobase_delta");

    const incrementalRun = await runDirectTask(workspace, {
      batchId: "batch_r05_nobase_delta",
      evaluatedAt: EVAL_2,
      plan: planFor(workspace.store, [inserted]),
      targetRaw: 1,
      targetDependency: 1
    });
    const reuse = readReuse(workspace.store, incrementalRun);
    assert.equal(reuse.proof, "rejected");
    assert.equal(reuse.rejectionReason, "coverage_base_missing",
      "没有旧发布输入绑定就证明不了'父到当前无未处理影响' ⇒ 拒绝复用");
    assert.equal(reuse.loads.reused, 0);
    assert.equal(reuse.zoneProfiles.reused, 0);
    assert.equal(reuse.dailyMetrics.reused, 0);
    // 拒绝复用 ≠ 结果错：全量重算照常发布（上面 runDirectTask 已断言 succeeded）。
  } finally {
    closeWorkspace(workspace);
  }
});

// ===================== P3-06 / T12：跨夜睡眠 + HRV 更正的分域 A/B =====================

const T12_DAYS = Array.from({ length: 70 }, (_, index) => index + 1);
/** 夹具结束于 2026-03-11；两个评估时刻都必须在夹具之后（且本地日仍是 3 月 12/14 日）。 */
const T12_EVAL_1 = "2026-03-12T04:00:00.000Z";
const T12_EVAL_2 = "2026-03-14T04:00:00.000Z";
const T12_FIRST_REVISION_DAY = 5;
const T12_SECOND_REVISION_DAY = 50;
/** 两处非相邻更正之间的中段：day 34..49（本地日 2026-02-03..2026-02-18）。 */
const T12_MIDDLE_DAYS = Array.from({ length: 16 }, (_, index) => index + 34);
const T12_MIDDLE_FROM = localDay(T12_MIDDLE_DAYS[0]!);
const T12_MIDDLE_THROUGH = localDay(T12_MIDDLE_DAYS[T12_MIDDLE_DAYS.length - 1]!);

/**
 * 70 个连续自然日（2026-01-01..2026-03-11）的 canonical 睡眠/HRV 事实。
 *
 * 睡眠值按日序在 420..450 之间循环（5 分钟一档）。第 5 天的跨夜更正把 60 分钟
 * 从 night 5 移到 night 6；day 34 的 28 天睡眠基线窗恰好从 night 6 开始，但该窗
 * 中位数取第 14/15 位（435/435），night 6 的 450→510 仍落在中位数之上，因此
 * 中间期的基线中位数不变。运行级（2026-03-14）的基线窗包含被更正的 day 50，
 * 所以 readiness 输出仍然真实改变。
 */
function seedT12RecoveryFacts(workspace: Workspace): void {
  const database = workspace.store.database;
  const insertNight = database.prepare(`
    INSERT INTO canonical_nights (
      id, wake_date, timezone_identifier, kind, source_name, source_category, source_rank, has_stages,
      sleep_onset_at, wake_at, asleep_union_minutes, in_bed_union_minutes, awake_minutes,
      stage_minutes_json, segment_count, provenance_json, computed_at
    ) VALUES (?, ?, ?, 'main', 'Watch', 'apple_watch', 1, 0, ?, ?, ?, ?, 20, '{}', 1, '{}', ?)
  `);
  const insertHrv = database.prepare(`
    INSERT INTO canonical_hrv_days (
      id, local_date, timezone_identifier, night_id, hrv_sdnn_ms, sample_count, confidence,
      window_start_at, window_end_at, source_name, provenance_json, computed_at
    ) VALUES (?, ?, ?, ?, ?, 4, 'confident', ?, ?, 'Watch', '{}', ?)
  `);
  const computedAt = "2026-01-01T00:00:00.000Z";
  for (const day of T12_DAYS) {
    const localDate = localDay(day);
    const asleepMinutes = 420 + (day % 7) * 5;
    insertNight.run(
      `t12_night_${day}`, localDate, TZ,
      `${localDate}T00:00:00.000Z`, `${localDate}T06:30:00.000Z`,
      asleepMinutes, asleepMinutes + 20, computedAt
    );
    insertHrv.run(
      `t12_hrv_${day}`, localDate, TZ, `t12_night_${day}`, 48 + (day % 6),
      `${localDate}T06:30:00.000Z`, `${localDate}T06:50:00.000Z`, computedAt
    );
  }
}

/** 两处**完全相同**的恢复更正：night d 少 60 分钟、night d+1 多 60 分钟，day d 的 HRV +10。 */
function applyT12RecoveryRevision(workspace: Workspace): void {
  const database = workspace.store.database;
  for (const day of [T12_FIRST_REVISION_DAY, T12_SECOND_REVISION_DAY]) {
    const movedOut = database.prepare(
      "UPDATE canonical_nights SET asleep_union_minutes = asleep_union_minutes - 60 WHERE id = ?"
    ).run(`t12_night_${day}`).changes;
    const movedIn = database.prepare(
      "UPDATE canonical_nights SET asleep_union_minutes = asleep_union_minutes + 60 WHERE id = ?"
    ).run(`t12_night_${day + 1}`).changes;
    const hrv = database.prepare(
      "UPDATE canonical_hrv_days SET hrv_sdnn_ms = hrv_sdnn_ms + 10 WHERE id = ?"
    ).run(`t12_hrv_${day}`).changes;
    assert.equal(Number(movedOut) + Number(movedIn) + Number(hrv), 3,
      `revision at day ${day} must touch both nights and the HRV row`);
  }
}

interface T12DomainSnapshot {
  domain: string;
  snapshotKey: string;
  asOf: string;
  payload: unknown;
}

/** 从既有业务投影里取某个域的全部封存快照（payload 已去掉执行身份）。 */
function readT12DomainSnapshots(store: RaiDatabase, domain: "readiness" | "fitness"): T12DomainSnapshot[] {
  const projection = readBusinessProjection(store);
  const table = projection.tables.find((candidate) => candidate.name === "model_domain_snapshots");
  assert.ok(table, "model_domain_snapshots must be part of the business projection");
  return table.rows
    .filter((row) => String((row as { domain?: unknown }).domain) === domain)
    .map((row) => ({
      domain,
      snapshotKey: String((row as { snapshotKey?: unknown }).snapshotKey),
      asOf: String((row as { asOf?: unknown }).asOf),
      payload: (row as { payload?: unknown }).payload
    }))
    .sort((left, right) => left.snapshotKey.localeCompare(right.snapshotKey));
}

interface T12MiddleBaseline {
  readiness: Array<{ localDate: string; asOf: string; assessment: ReturnType<typeof loadDatedReadiness> }>;
  nights: Array<Record<string, unknown>>;
  hrvDays: Array<Record<string, unknown>>;
}

/** 中间期每一天自己的本地日终（min 到全局截止）——与生产入口逐字同义。 */
function t12LocalDayEnd(day: number): string {
  const localDate = localDay(day);
  return new Date(Math.min(
    Date.parse(localDateStartAt(addDays(localDate, 1), TZ)) - 1,
    Date.parse(T12_EVAL_2)
  )).toISOString();
}

function captureT12MiddleBaseline(store: RaiDatabase): T12MiddleBaseline {
  const readiness = T12_MIDDLE_DAYS.map((day) => ({
    localDate: localDay(day),
    asOf: t12LocalDayEnd(day),
    assessment: loadDatedReadiness(store.database, t12LocalDayEnd(day), TZ)
  }));
  const nights = store.database.prepare(
    "SELECT * FROM canonical_nights WHERE wake_date >= ? AND wake_date <= ? ORDER BY wake_date, id"
  ).all(T12_MIDDLE_FROM, T12_MIDDLE_THROUGH) as Array<Record<string, unknown>>;
  const hrvDays = store.database.prepare(
    "SELECT * FROM canonical_hrv_days WHERE local_date >= ? AND local_date <= ? ORDER BY local_date, id"
  ).all(T12_MIDDLE_FROM, T12_MIDDLE_THROUGH) as Array<Record<string, unknown>>;
  return { readiness, nights, hrvDays };
}

/**
 * T12 端到端 A/B：两个**独立数据库**、同一份 70 天合成输入。
 *
 * 两处非相邻的跨夜恢复更正（day 5、day 50）只通过 readiness 边界进入增量计划 A；
 * B 忽略边界从头全量。判据：
 * 1. 完整业务投影（含五域封存快照 / 发布 bundle / active 指针 / 可读状态）逐字段等价；
 * 2. 更正之间的 day 34..49 逐日 readiness 与 canonical 行都等于更正前基线；
 * 3. Fitness 域 payload 与更正前基线、与全量 B 都逐字段相同（恢复事实不进入 Fitness）。
 */
test("P3-06 T12: cross-night sleep/HRV revision — readiness output equals offline-full, middle period unchanged, Fitness isolated", { timeout: 120_000 }, async () => {
  const incremental = await openWorkspace();
  const offline = await openWorkspace();
  const readinessBoundary = localDateStartAt(localDay(T12_FIRST_REVISION_DAY), TZ);
  try {
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, T12_DAYS);
      // readiness 的 publicationAt 不能是 null：数据集发布完成时刻必须在评估日之前。
      workspace.store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
      // 本场景不改导入批次：恢复更正是 canonical 事实级的回填，因此 dataset_version
      // 保持稳定 —— Fitness payload 的 lineage.datasetVersion 也必须是同一代输入。
      workspace.store.setManifest("dataset_version", "dataset_t12_recovery");
      seedT12RecoveryFacts(workspace);
      workspace.store.flush();
      // 两次全量基线（证据链必需）：第一次建立发布，第二次让证据源成为真实存在的已发布 run。
      runAnalysis(workspace.store, null, T12_EVAL_1);
      runAnalysis(workspace.store, null, T12_EVAL_2);
    }

    // 更正前基线：运行级 readiness/fitness 封存 payload + 中间期逐日 readiness + canonical 行。
    const readinessBefore = readT12DomainSnapshots(incremental.store, "readiness");
    const fitnessBefore = readT12DomainSnapshots(incremental.store, "fitness");
    assert.equal(readinessBefore.length, 1, "readiness domain snapshot must exist before the revision");
    assert.ok(fitnessBefore.length > 0, "fitness domain snapshots must exist before the revision");
    const middleBefore = captureT12MiddleBaseline(incremental.store);
    assert.equal(middleBefore.readiness.length, T12_MIDDLE_DAYS.length);
    assert.equal(middleBefore.nights.length, T12_MIDDLE_DAYS.length, "one canonical night per middle day");
    assert.equal(middleBefore.hrvDays.length, T12_MIDDLE_DAYS.length, "one canonical HRV row per middle day");

    for (const workspace of [incremental, offline]) {
      applyT12RecoveryRevision(workspace);
      workspace.store.flush();
    }

    const range = planIncrementalAnalysisDirtyRange({
      changes: [],
      workouts: readWorkouts(incremental.store),
      recoveryBoundaries: [readinessBoundary]
    });
    assert.equal(range.full, false, "a recovery-only revision must stay a bounded plan");
    assert.equal(range.domains.readiness, readinessBoundary,
      "readiness must start at the first revised local day");
    const plan: RecomputePlan = {
      mode: "partial", dirtySessionIds: [], dirtyFromAt: range.dirtyFromAt, domains: range.domains, reasons: range.reasons
    };
    const incrementalRun = runAnalysis(incremental.store, plan, T12_EVAL_2);
    runAnalysis(offline.store, null, T12_EVAL_2);

    // (a) 完整业务产物等价（含 readiness/fitness 域 payload、bundle、active 指针、可读状态）。
    assertSameBusiness(incremental.store, offline.store);

    // (b) readiness：增量 == 全量，且确实不同于更正前（证明更正真的改变了输出）。
    const readinessAfter = readT12DomainSnapshots(incremental.store, "readiness");
    assert.ok(readinessAfter.length > 0, "readiness domain payload must not be empty");
    assert.deepEqual(readinessAfter, readT12DomainSnapshots(offline.store, "readiness"),
      "incremental readiness payload must equal offline-full");
    assert.notDeepEqual(readinessAfter, readinessBefore,
      "the recovery revision must actually change the readiness domain payload");

    // (c) Fitness：增量 == 更正前基线 == 全量（恢复事实不进入 Fitness）。
    const fitnessAfter = readT12DomainSnapshots(incremental.store, "fitness");
    assert.deepEqual(fitnessAfter, fitnessBefore,
      "Fitness domain must not be polluted by recovery revisions");
    assert.deepEqual(fitnessAfter, readT12DomainSnapshots(offline.store, "fitness"),
      "incremental Fitness domain must equal offline-full");

    // (d) 中间期：逐日 readiness 与 canonical 行逐字节不变。
    const middleAfter = captureT12MiddleBaseline(incremental.store);
    assert.deepEqual(middleAfter.readiness, middleBefore.readiness,
      "day 34..49 readiness must be identical to the pre-revision baseline");
    assert.deepEqual(middleAfter.nights, middleBefore.nights,
      "day 34..49 canonical_nights rows must be byte-identical to the pre-revision snapshot");
    assert.deepEqual(middleAfter.hrvDays, middleBefore.hrvDays,
      "day 34..49 canonical_hrv_days rows must be byte-identical to the pre-revision snapshot");

    // (e) 复用证明与边界。
    const reuse = readReuse(incremental.store, incrementalRun);
    assert.equal(reuse.proof, "verified",
      `T12 recovery revision must reuse the safe prefix (${reuse.rejectionReason ?? "none"})`);
    assert.ok(reuse.loads.reused > 0 && reuse.zoneProfiles.reused > 0 && reuse.dailyMetrics.reused > 0,
      "the pre-revision prefix must be reused");
  } finally {
    closeWorkspace(incremental);
    closeWorkspace(offline);
  }
});
