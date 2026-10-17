import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiApplicationService, SqliteAnalysisInputReader } from "@rai/application";
import { DIRECT_SYNC_ANALYSIS_REQUEST_MODE, healthTypes, workoutTypes } from "@rai/contracts";
import {
  canonicalizeRunningWorkouts, parseAppleHealthXml, planIncrementalAnalysisDirtyRange,
  type DirtyRangeChange, type DirtyRangeWorkout, type RecomputePlan
} from "@rai/health-export-parser";
import { physStateFromReadiness } from "@rai/readiness";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";
import { addDays, configHash, localDateStartAt } from "../src/utils.js";
import { loadDatedReadiness, loadDatedRecoveryFacts, loadDatedRecoveryFactsBatch } from "../src/model-v2-snapshots.js";
import { loadDailyPhysEvidence } from "../src/training-load-data.js";

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

/** 第 n 天（从 1 起）的真实本地日期：跨月也对，不靠"1 月有 32 号"凑数。 */
const dateOfDay = (day: number): string =>
  new Date(Date.parse("2026-01-01T00:00:00.000Z") + (day - 1) * 86_400_000).toISOString().slice(0, 10);
const appleDate = (day: number, time: string): string => `${dateOfDay(day)} ${time}:00 +0800`;
const localDay = (day: number): string => dateOfDay(day);

/** 合成 XML：每天一场 30 分钟跑 + 15 条心率记录（跨天的更正/新增都靠改这个数组）。 */
function fixtureXml(days: number[], shifted: ReadonlySet<number> = new Set()): string {
  const workouts = days.map((day, index) => `
  <Workout workoutActivityType="${workoutTypes.running}" duration="30" durationUnit="min" sourceName="Fixture Apple Watch" sourceVersion="1" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" device="Watch">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <WorkoutStatistics type="${healthTypes.distanceWalkingRunning}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" sum="${(5 + index * 0.08).toFixed(2)}" unit="km"/>
    <WorkoutStatistics type="${healthTypes.heartRate}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" average="${145 + index}" minimum="120" maximum="172" unit="count/min"/>
  </Workout>`).join("");
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

/** 导入一份合成 XML 并做 canonical 分组（两次分析必须喂**同一份输入**）。 */
async function ingest(workspace: Workspace, days: number[], shifted?: ReadonlySet<number>): Promise<void> {
  const path = join(workspace.root, "export.xml");
  writeFileSync(path, fixtureXml(days, shifted), "utf8");
  await parseAppleHealthXml(path, workspace.store, { fileSize: 1 });
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

/** 用与直连车道**同一个纯函数**把变更归约成分域计划（口径不复制第二份）。 */
function planFor(store: RaiDatabase, changes: DirtyRangeChange[]): RecomputePlan {
  const range = planIncrementalAnalysisDirtyRange({ changes, workouts: readWorkouts(store) });
  assert.equal(range.full, false, "the synthetic change must yield a bounded plan");
  assert.notEqual(range.dirtyFromAt, null);
  return { mode: "partial", dirtySessionIds: [], dirtyFromAt: range.dirtyFromAt, domains: range.domains, reasons: range.reasons };
}

/** 业务快照：分类/解释码（精确）与数值（浮点留余量）分开比。 */
interface Business {
  features: Array<Record<string, unknown>>;
  loads: Array<Record<string, unknown>>;
  zones: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  daily: Array<Record<string, unknown>>;
  assessments: Array<Record<string, unknown>>;
}

function readBusiness(store: RaiDatabase): Business {
  const modelRunId = activeModelRunId(store);
  const metricRunId = activeMetricRunId(store, modelRunId);
  const db = store.database;
  return {
    features: db.prepare(`SELECT f.training_session_id AS sessionId, f.eligibility_status AS eligibility,
      f.missing_reasons_json AS missingReasons, f.quality_score AS qualityScore, f.distance_km AS distanceKm,
      f.heart_rate_coverage AS heartRateCoverage, f.route_quality AS routeQuality
      FROM workout_features f JOIN model_runs m ON m.feature_run_id = f.feature_run_id
      WHERE m.id = ? ORDER BY f.training_session_id`).all(modelRunId) as never,
    loads: db.prepare(`SELECT l.training_session_id AS sessionId, l.local_date AS localDate, l.training_load AS load,
      l.intensity, l.load_source AS source, l.confidence, l.stimulus_type AS stimulusType,
      l.explanation_codes_json AS codes, l.distance_factor AS distanceFactor,
      l.distance_reference_meters AS distanceReferenceMeters, l.average_heart_rate_bpm AS averageHeartRate
      FROM workout_training_loads l WHERE l.training_metric_run_id = ? ORDER BY l.training_session_id`).all(metricRunId) as never,
    zones: db.prepare(`SELECT z.training_session_id AS sessionId, z.stimulus_type AS stimulusType,
      z.explanation_codes_json AS codes, z.stimulus_confidence AS stimulusConfidence,
      z.heart_rate_coverage AS heartRateCoverage, z.pace_coverage AS paceCoverage,
      z.stimulus_scores_json AS stimulusScores
      FROM workout_zone_summaries z WHERE z.training_metric_run_id = ? ORDER BY z.training_session_id`).all(metricRunId) as never,
    profiles: db.prepare(`SELECT p.local_date AS localDate, p.resting_heart_rate_bpm AS resting,
      p.maximum_heart_rate_bpm AS maximum, p.threshold_pace_seconds_per_km AS threshold,
      p.heart_rate_source AS heartRateSource, p.pace_source AS paceSource, p.profile_status AS status,
      p.heart_rate_bands_json AS heartRateBands, p.pace_bands_json AS paceBands, p.evidence_json AS evidence
      FROM daily_zone_profiles p WHERE p.training_metric_run_id = ? ORDER BY p.local_date`).all(metricRunId) as never,
    daily: db.prepare(`SELECT d.local_date AS localDate, d.daily_load AS load, d.acute_ewma AS acuteEwma,
      d.chronic_ewma AS chronicEwma, d.load_ratio AS loadRatio, d.ramp_rate AS rampRate, d.monotony, d.strain,
      d.training_status AS trainingStatus, d.explanation_codes_json AS codes, d.history_days AS historyDays,
      d.load_workout_count AS loadWorkoutCount, d.workout_count AS workoutCount, d.confidence
      FROM daily_training_metrics d WHERE d.training_metric_run_id = ? ORDER BY d.local_date`).all(metricRunId) as never,
    assessments: db.prepare(`SELECT a.training_session_id AS sessionId, a.assessment_status AS status,
      a.true_ability_after AS trueAbilityAfter, a.sequence_number AS sequenceNumber
      FROM ability_assessments a WHERE a.model_run_id = ? ORDER BY a.sequence_number`).all(modelRunId) as never
  };
}

const NUMERIC = new Set([
  "qualityScore", "distanceKm", "heartRateCoverage", "routeQuality", "load", "intensity", "confidence",
  "distanceFactor", "distanceReferenceMeters", "averageHeartRate", "stimulusConfidence", "paceCoverage",
  "resting", "maximum", "threshold", "acuteEwma", "chronicEwma", "loadRatio", "rampRate", "monotony",
  "strain", "historyDays", "loadWorkoutCount", "workoutCount", "trueAbilityAfter", "sequenceNumber"
]);

function assertSameRow(kind: string, key: unknown, left: Record<string, unknown>, right: Record<string, unknown>): void {
  assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), `${kind}[${key}] shape`);
  for (const field of Object.keys(left)) {
    const a = left[field], b = right[field];
    if (NUMERIC.has(field)) {
      if (a === null || b === null) {
        assert.equal(a, b, `${kind}[${key}].${field}: ${String(a)} vs ${String(b)}`);
        continue;
      }
      const x = Number(a), y = Number(b);
      assert.ok(Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)),
        `${kind}[${key}].${field}: ${String(a)} vs ${String(b)}`);
      continue;
    }
    assert.deepEqual(a, b, `${kind}[${key}].${field}`);
  }
}

/** 增量库（A）与离线从头计算库（B）逐表对照：分类/解释码精确，数值 1e-9 相对余量。 */
function assertSameBusiness(incremental: Business, offline: Business): void {
  const compare = (kind: keyof Business, keyField: string): void => {
    const a = incremental[kind], b = offline[kind];
    assert.deepEqual(a.map((row) => row[keyField]), b.map((row) => row[keyField]),
      `${kind}: row identity differs (incremental vs offline-scratch)`);
    for (const [index, row] of a.entries()) assertSameRow(kind, row[keyField], row, b[index]!);
  };
  compare("features", "sessionId");
  compare("loads", "sessionId");
  compare("zones", "sessionId");
  compare("profiles", "localDate");
  compare("daily", "localDate");
  compare("assessments", "sessionId");
  assert.ok(incremental.loads.length > 0 && incremental.daily.length > 0, "the comparison must not be empty-on-empty");
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
  apply: (workspace: Workspace) => Promise<DirtyRangeChange[]>;
  expectReuse: boolean;
}

async function runChangeKind(kind: ChangeKind): Promise<void> {
  const incremental = await openWorkspace();
  const offline = await openWorkspace();
  try {
    for (const workspace of [incremental, offline]) {
      await ingest(workspace, BASE_DAYS);
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
    assertSameBusiness(readBusiness(incremental.store), readBusiness(offline.store));
    const reuse = readReuse(incremental.store, incrementalRun);
    if (kind.expectReuse) {
      assert.equal(reuse.proof, "verified", `${kind.name}: expected a verified reuse proof (${reuse.rejectionReason ?? ""})`);
      assert.ok(reuse.loads.reused > 0, `${kind.name}: expected reused loads`);
      assert.ok(reuse.zoneProfiles.reused > 0, `${kind.name}: expected reused zone profiles`);
      assert.ok(reuse.dailyMetrics.reused > 0, `${kind.name}: expected reused daily metrics`);
      const rowsInRun = Number(incremental.store.database.prepare(
        "SELECT COUNT(*) AS n FROM workout_training_loads WHERE training_metric_run_id = ?"
      ).get(activeMetricRunId(incremental.store, incrementalRun))?.n ?? 0);
      assert.equal(reuse.loads.reused + reuse.loads.recomputed, rowsInRun);
    } else {
      assert.equal(reuse.proof, "rejected", `${kind.name}: this change must NOT reuse a prefix`);
      assert.equal(reuse.loads.reused, 0);
      assert.equal(reuse.zoneProfiles.reused, 0);
      assert.equal(reuse.dailyMetrics.reused, 0);
      assert.notEqual(reuse.rejectionReason, null);
    }
  } finally {
    closeWorkspace(incremental);
    closeWorkspace(offline);
  }
}

test("O09: a newly imported workout keeps the prefix and equals an offline from-scratch run", async () => {
  await runChangeKind({
    name: "new_workout", expectReuse: true,
    apply: async (workspace) => {
      await ingest(workspace, [...BASE_DAYS, NEW_WORKOUT_DAY]);
      return [insertedWorkoutChange(readWorkoutInterval(workspace.store, "start_at >= ?", NEW_WORKOUT_FROM))];
    }
  });
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
    assertSameBusiness(readBusiness(incremental.store), readBusiness(offline.store));
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
    assertSameBusiness(readBusiness(workspace.store), readBusiness(offline.store));
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
    assertSameBusiness(readBusiness(incremental.store), readBusiness(offline.store));
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
    assertSameBusiness(readBusiness(incremental.store), readBusiness(offline.store));
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
