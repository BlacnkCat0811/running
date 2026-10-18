import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { healthTypes, workoutTypes } from "@rai/contracts";
import {
  canonicalizeRunningWorkouts, parseAppleHealthXml, planIncrementalAnalysisDirtyRange,
  type DirtyRangeWorkout, type RecomputePlan
} from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

/**
 * P0-2（2026-10-18）：**消费侧**证明一条 VO2Max 变更只重算有界后缀，不退化成全量。
 *
 * ## 守的是什么
 *
 * 生产实测：一个批次含 **1 条 VO2Max** ⇒ `planIncrementalAnalysisDirtyRange` 旧实现
 * 命中 `vo2_evidence_changed` 就 `full=true` ⇒ 分析任务不写 `incrementalPlan` ⇒
 * `feature_runs.recomputed_feature_count=286, reused=0` + 全库 103 s。
 *
 * 纯函数测试（`dirty-range.test.ts`）只证明**计划**有界；本文件证明**消费侧**真的按
 * `domains` 边界复用（`recompute-pipeline` 的 `DomainBoundaries` / `resolveMetricReuse`）：
 *
 * 1. `full=false` 的计划必须产出 `reuse.proof === "verified"`（不是 `not_attempted`）；
 * 2. 特征前缀/负荷/分区/日级都必须真的复用（`reused > 0`），重算条数收敛到边界之后
 *    的那一场训练（不是 40 场）；
 * 3. 有界增量的结果必须与**同输入从头全量计算**逐字段相同（数值 1e-9 相对余量）。
 */

const TZ = "Asia/Shanghai";
const EVAL_1 = "2026-02-10T04:00:00.000Z";
const EVAL_2 = "2026-02-12T04:00:00.000Z";
/**
 * 40 场训练（每个自然日一场，2026-01-01 起）。与既有分域复用回归同规模：发布 gate 的
 * `maxEligibleSessionDelta` 是 5%，夹具太小会把"gate 正常拒绝"误读成"复用有问题"。
 */
const BASE_DAYS = Array.from({ length: 40 }, (_, index) => index + 1);

const dateOfDay = (day: number): string =>
  new Date(Date.parse("2026-01-01T00:00:00.000Z") + (day - 1) * 86_400_000).toISOString().slice(0, 10);
const appleDate = (day: number, time: string): string => `${dateOfDay(day)} ${time}:00 +0800`;

/** 合成 XML：每天一场 30 分钟跑 + 15 条心率记录（与既有分域复用回归同一形态）。 */
function fixtureXml(days: number[]): string {
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
      return `
  <Record type="${healthTypes.heartRate}" sourceName="Fixture Apple Watch" sourceVersion="1" unit="count/min" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, `08:${minute}`)}" endDate="${appleDate(day, `08:${endMinute}`)}" value="${140 + index + (sample % 3)}"/>`;
    })
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <ExportDate value="${appleDate(25, "12:00")}"/>
  <Me biologicalSex="HKBiologicalSexMale"/>${workouts}${heartRecords}
</HealthData>`;
}

async function ingest(store: RaiDatabase, root: string, days: number[]): Promise<void> {
  const path = join(root, "export.xml");
  writeFileSync(path, fixtureXml(days), "utf8");
  await parseAppleHealthXml(path, store, { fileSize: 1 });
  canonicalizeRunningWorkouts(store.database);
}

function runAnalysis(store: RaiDatabase, plan: RecomputePlan | null, evaluatedAt: string): string {
  const service = new RaiApplicationService(store);
  if (plan === null) service.enqueueFullRecompute({ evaluatedAt, timezoneIdentifier: TZ });
  else service.enqueueIncrementalRecompute(plan, { evaluatedAt, timezoneIdentifier: TZ });
  const job = service.runNextJob();
  assert.equal(job?.status, "succeeded", `analysis job failed: ${JSON.stringify(job)}`);
  return String(job?.modelRunId);
}

function readWorkouts(store: RaiDatabase): DirtyRangeWorkout[] {
  return store.database.prepare("SELECT start_at AS startAt, end_at AS endAt FROM workouts ORDER BY start_at")
    .all() as unknown as DirtyRangeWorkout[];
}

interface ReuseCounters {
  proof: string;
  rejectionReason: string | null;
  loads: { reused: number; recomputed: number };
  zoneProfiles: { reused: number; recomputed: number };
  dailyMetrics: { reused: number; recomputed: number };
}

function readReuse(store: RaiDatabase, modelRunId: string): ReuseCounters {
  const metricRunId = String((store.database.prepare(
    "SELECT id FROM training_metric_runs WHERE model_run_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1"
  ).get(modelRunId) as { id: string }).id);
  const summary = JSON.parse(String(store.database.prepare(
    "SELECT summary_json AS json FROM training_metric_runs WHERE id = ?"
  ).get(metricRunId)?.json ?? "{}")) as { reuse?: Record<string, unknown> };
  assert.ok(summary.reuse, "per-domain reuse counters must be durable in training_metric_runs.summary_json");
  return summary.reuse as unknown as ReuseCounters;
}

function featureCounters(store: RaiDatabase, modelRunId: string): { reused: number; recomputed: number } {
  const row = store.database.prepare(`
    SELECT feature.reused_feature_count AS reused, feature.recomputed_feature_count AS recomputed
    FROM model_runs model JOIN feature_runs feature ON feature.id = model.feature_run_id
    WHERE model.id = ?
  `).get(modelRunId) as { reused: number; recomputed: number } | undefined;
  assert.ok(row, "feature run counters must exist");
  return { reused: Number(row.reused), recomputed: Number(row.recomputed) };
}

interface Business {
  features: Array<Record<string, unknown>>;
  loads: Array<Record<string, unknown>>;
  zones: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  daily: Array<Record<string, unknown>>;
  assessments: Array<Record<string, unknown>>;
}

function readBusiness(store: RaiDatabase, modelRunId: string): Business {
  const metricRunId = String((store.database.prepare(
    "SELECT id FROM training_metric_runs WHERE model_run_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1"
  ).get(modelRunId) as { id: string }).id);
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

/** 有界增量（A）与同输入从头全量（B）逐表对照：分类/解释码精确，数值 1e-9 相对余量。 */
function assertSameBusiness(incremental: Business, offline: Business): void {
  const compare = (kind: keyof Business, keyField: string): void => {
    const a = incremental[kind], b = offline[kind];
    assert.deepEqual(a.map((row) => row[keyField]), b.map((row) => row[keyField]),
      `${kind}: row identity differs (bounded incremental vs from-scratch)`);
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

/** VO2Max 样本：落在第 40 天训练（本地 08:00–08:30 ⇒ UTC 00:00–00:30）**内部**。 */
const VO2_OBSERVED_AT = "2026-02-09T00:10:00.000Z";
/** 相交回退后的边界 = 第 40 天训练起点。 */
const EXPECTED_BOUNDARY = "2026-02-09T00:00:00.000Z";

test("P0-2 消费侧：VO2Max-only 计划有界复用（不复用被拒/不退化全量），结果与从头全量一致", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-vo2-domain-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    await ingest(store, root, BASE_DAYS);
    store.setManifest("dataset_version", "dataset_vo2_before");
    store.flush();
    // 两次全量基线是**必需的**（与既有分域复用回归同一理由）：首次全量在"还没有 active run"
    // 下算，证据源为空；第二次让证据源成为真实存在的已发布 run，增量与从头计算才面对同一代证据。
    runAnalysis(store, null, EVAL_1);
    runAnalysis(store, null, EVAL_1);

    // 一条新的 VO2Max 样本（管道直读 health_records；不需要走直连接收端就能钉消费侧行为）。
    store.insertRecord({
      id: "record_vo2_p02_fixture", type: healthTypes.vo2Max, sourceName: "Fixture Apple Watch",
      sourceVersion: "1", device: "Watch", unit: "mL/min*kg", numericValue: 56, textValue: null,
      startAt: VO2_OBSERVED_AT, endAt: VO2_OBSERVED_AT, createdAt: VO2_OBSERVED_AT, metadata: {}
    }, "apple_watch", {});
    store.setManifest("dataset_version", "dataset_vo2_after");
    store.flush();

    // 与直连接收端**同一个纯函数**装配计划（口径不复制第二份）。
    const range = planIncrementalAnalysisDirtyRange({
      changes: [{
        entityKind: "record", changeType: "inserted",
        newType: healthTypes.vo2Max, newStart: VO2_OBSERVED_AT, newEnd: VO2_OBSERVED_AT,
        previousType: null, previousStart: null, previousEnd: null
      }],
      workouts: readWorkouts(store)
    });
    assert.equal(range.full, false, "VO2Max 不得再升级为全量（旧实现 full=true）");
    assert.equal(range.dirtyFromAt, EXPECTED_BOUNDARY, "边界 = 包含样本的训练起点（相交回退）");
    assert.equal(range.domains.fitness, EXPECTED_BOUNDARY, "domains.fitness 必须拿到边界");
    assert.ok(range.reasons.includes("vo2_evidence_changed"), "原因码保留");

    const plan: RecomputePlan = {
      mode: "partial", dirtySessionIds: [],
      dirtyFromAt: range.dirtyFromAt, domains: range.domains, reasons: range.reasons
    };
    const incrementalRun = runAnalysis(store, plan, EVAL_2);

    // 🔴 消费侧判据 1：计划被真的当成分域增量，而不是被拒/退化成全量。
    const reuse = readReuse(store, incrementalRun);
    assert.equal(reuse.proof, "verified",
      `VO2 有界计划必须复用安全前缀（拒绝原因：${reuse.rejectionReason ?? "none"}）`);
    assert.ok(reuse.loads.reused > 0, "负荷前缀必须真的被复用");
    assert.ok(reuse.zoneProfiles.reused > 0, "分区前缀必须真的被复用");
    assert.ok(reuse.dailyMetrics.reused > 0, "日级前缀必须真的被复用");

    // 判据 2：重算收敛到边界之后的那一场训练，不是 40 场（生产旧行为是 286 条全量）。
    assert.equal(reuse.loads.reused, BASE_DAYS.length - 1, "边界之前的 39 场训练应全部复用");
    assert.equal(reuse.loads.recomputed, 1, "只重算与 VO2 相交的那一场训练");
    const features = featureCounters(store, incrementalRun);
    assert.equal(features.reused, BASE_DAYS.length - 1, "特征前缀复用 39 场");
    assert.equal(features.recomputed, 1, "特征只重算 1 场（+3s 级，而不是全史 286 条）");

    // 判据 3：有界增量的业务结果必须与**同输入从头全量计算**逐字段相同。
    const incrementalBusiness = readBusiness(store, incrementalRun);
    const fullRun = runAnalysis(store, null, EVAL_2);
    assertSameBusiness(incrementalBusiness, readBusiness(store, fullRun));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
