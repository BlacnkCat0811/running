import { loadPersistedTrainingLoads, loadDailyPhysEvidence } from "../training-load-data.js";
import { NO_WRITE_GATE, type AnalysisStore, type WriteGate } from "../write-gate.js";
import { identityNormalizationConfigHash } from "@rai/normalization";
import { readinessForRun } from "../model-v2-snapshots.js";
import { DURABILITY_MODEL_VERSION, PREPARATION_TARGETS, PREPARATION_WINDOW_DAYS, assessPreparation, assessDurability, buildDurabilitySnapshot } from "@rai/durability";
import type { ModelLineageV2, WorkoutFeaturePayloadV4 } from "@rai/contracts";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { RecomputeProgressGate } from "./recompute-progress.js";
import { BoundedCache } from "./bounded-cache.js";
import { ChunkedWriter } from "./chunked-write.js";
import type { AnalysisInputCapture, AnalysisInputSource } from "./analysis-input-reader.js";
import type { AnalysisDirtyDomains } from "@rai/health-export-parser";

import {
  DATABASE_TIMEZONE,
  CONTRACT_VERSION,
  FEATURE_SCHEMA_VERSION,
  type AbilityAssessment,
  type DailyZoneProfile,
  type DailyAbilitySnapshot,
  type EligibilityStatus,
  type FeatureRun,
  type MissingReasonCode,
  type ModelRun,
  type PerformanceProtocol,
  type RecomputeJob,
  type RunStatus,
  type SessionStratum,
  type SessionType,
  type StratumHistory,
  type TrainingZoneProfileSettings,
  type WorkoutFeatureVector,
  type WorkoutOverride,
  type WorkoutZoneSummary
} from "@rai/contracts";
import {
  FEATURE_CONFIG_VERSION,
  defaultFeatureConfig,
  extractWorkoutFeatureVector,
  extractWorkoutFeatureVectorV4, projectFeatureV4, encodeFeaturePayloadV4, decodeStoredFeature,
  type FeatureConfig,
  type WorkoutFeatureSource
} from "@rai/features";
import {
  RaiDatabase,
  SqliteModelRunRepository, SqliteModelReleaseRepository, semanticHash, evaluateModelTransitionGateV2,
  RecomputeJobRepository,
  SqliteTrainingSessionRepository,
  type ModelTransitionSourceBackfillEvidence
} from "@rai/storage-sqlite";
import {
  buildAdaptiveBaselineTimeline,
  buildLegacyStratumHistory,
  defaultAdaptiveBaselinePolicy,
  BASELINE_POLICY_VERSION,
  createPersonalBaseline,
  defaultRaiModelConfig,
  hasCompletedCalibration,
  inactivityDecay,
  MODEL_CONFIG_VERSION, SCORING_MODEL_VERSION,
  scoreFeature,
  sessionStratum,
  sortWorkoutFeaturesChronologically,
  trueAbilityAfterInactivity,
  updateTrueAbilityFromFeatureScore,
  type PersonalBaseline
} from "@rai/scoring";
import {
  buildDailyTrainingMetricsV2 as buildDailyTrainingMetrics,
  buildDailyTrainingMetrics as buildLegacyDailyTrainingMetrics,
  calculateWorkoutTrainingLoad, buildLoadVectorV2,
  classifyPhysState,
  defaultDailyMetricConfig,
  type DailyPhysEvidence,
} from "@rai/training-load";
import { TRAINING_LOAD_CONFIG_VERSION, type DailyTrainingMetric, type WorkoutTrainingLoad } from "@rai/contracts";
import { TRAINING_ZONE_CONFIG_VERSION } from "@rai/contracts";
import {
  analyzeWorkoutZones,
  buildDailyZoneProfile,
  calculateCompositeTrainingLoad,
  percentile,
  type MaximumHeartRateEvidence,
  type RestingHeartRateEvidence,
  type ThresholdPaceCandidate,
  type TimedMetricSample
} from "@rai/training-zones";
import {
  estimateLactateThresholdFromPerformanceVdot,
  estimatePerformanceVdot,
  estimateVo2Max
} from "@rai/physiology";
import {
  loadDirectVo2Evidence,
  loadLabeledPerformanceEvidence,
  loadLactateThresholdEvidence,
  loadPerformanceVdotEvidence, parsePerformanceConditions
} from "../prediction-data.js";

import {
  addDays,
  appNow,
  configHash,
  daysBetween,
  deterministicId,
  localDateAt,
  localDateStartAt,
  median,
  opaqueId,
  parseJson
} from "../utils.js";

import {
  runningType,
  heartRateType,
  runningSpeedType,
  restingHeartRateType,
  hrvType,
  sleepType,
  distanceType,
  MODEL_CHECKPOINT_VERSION,
  type SessionRow,
  type StatisticRow,
  type RecordRow,
  type RouteQualityRow,
  type TimelineAssessment,
  type RecomputeRequest,
  type ModelCheckpointState,
  type ReplayResume
} from "../service-types.js";

import {
  clamp,
  asNullableNumber,
  finiteNumber,
  convertDistanceToKilometers,
  convertSpeedToMetersPerSecond,
  weightedRecordIntervals,
  sustainedThirtySecondPeak,
  summaryFromRecords,
  fallbackStatisticSummary,
  defaultRequest,
  normalizeInstant,
  type WeightedRecordInterval
} from "../recompute-helpers.js";

interface OverrideSnapshot {
  ids: string[];
  byTrainingSessionId: Map<string, WorkoutOverride>;
}

/**
 * Superseded recomputation runs kept beyond the active one.
 *
 * Every recompute writes a new model_run / feature_run / training_metric_run
 * and materialises the complete derived output into it, so unbounded retention
 * grows the database as O(runs × days) and multiplies the cost of every
 * migration that rewrites a derived table. Keeping a small recent history
 * preserves run-to-run comparison while bounding that growth. `0` disables
 * pruning entirely.
 */
export const SUPERSEDED_RUN_RETENTION = 2;

/**
 * Feature extraction, training metrics/zones, and ability timeline replay.
 * Split from RaiApplicationService (ARCHITECTURE_DEBT_MIGRATION P4).
 */
export class RecomputePipeline {
  private allowNativeAggregates = true;
  private recoveryIsolationHolds = true;
  private readonly recordCache = new BoundedCache<RecordRow[]>(16, 20_000);
  private readonly progressGate = new RecomputeProgressGate();
  private healthRecordHasUnitColumn: boolean | null = null;

  constructor(
    private readonly store: AnalysisStore,
    private readonly jobs: RecomputeJobRepository,
    private readonly modelRuns: SqliteModelRunRepository,
    private readonly sessions: SqliteTrainingSessionRepository,
    private readonly nativeElevationGains?: ReadonlyMap<string, number | null>,
    private readonly gate: WriteGate = NO_WRITE_GATE,
    /**
     * 分析输入源（O06-A / WP-22）。**注入**而不是在这里开连接：`write-lease.test.ts` 的
     * 结构判据（**按原文匹配**，连注释里的构造调用也算）钉住本文件不得出现直接构造
     * `DatabaseSync` / 直接打开 `RaiDatabase` 的写法 —— 分析只允许用被写租约代理包住的
     * 那一条连接。判据按原文而不是"去掉注释再匹配"，是为了让"把代码注释掉"这种
     * 「方法仍在、逻辑失效」的突变同样转红。
     * 读取器由 worker 线程构造（那里允许开只读连接），默认 `undefined` = 老行为。
     */
    private readonly inputSource?: AnalysisInputSource
  ) {}

  /** 本次直连分析捕获到的输入绑定；非直连任务为 null ⇒ 不写绑定行（老路径零改动）。 */
  private pendingInputCapture: AnalysisInputCapture | null = null;

  get database(): DatabaseSync {
    return this.store.database;
  }

  private hasHealthRecordUnitColumn(): boolean {
    if (this.healthRecordHasUnitColumn === null) {
      const columns = this.database
        .prepare("PRAGMA table_info(health_records)")
        .all() as unknown as Array<{ name: string }>;
      this.healthRecordHasUnitColumn = columns.some((column) => column.name === "unit");
    }
    return this.healthRecordHasUnitColumn;
  }

  runFullRecompute(job: RecomputeJob): void {
    this.recordCache.clear();
    this.recoveryIsolationHolds = true;
    const request = this.parseRequest(job.request);
    // Capture the incumbent before writing a candidate. The incumbent remains
    // active until the candidate has passed the shadow gate.
    const incumbent = this.database
      .prepare("SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1")
      .get() as { modelRunId: string } | undefined;
    const incumbentModelRunId = incumbent?.modelRunId ?? null;
    const datasetVersion = this.manifestValue("dataset_version") ?? "dataset_unknown";
    const overrideSnapshot = this.captureOverrideSnapshot();
    const featureRun = this.createFeatureRun(datasetVersion, request.featureConfig);
    this.setJobRunIds(job.id, featureRun.id, null);
    this.updateJobProgress(job.id, "feature_extraction", 0, 0, "Extracting canonical workout features");

    let features: WorkoutFeatureVector[];
    try {
      features = this.measureCompute(job.id, "features", () => this.extractFeatures(job.id, featureRun, request, overrideSnapshot));
      this.finishFeatureRun(featureRun.id, "succeeded", null);
    } catch (error) {
      this.finishFeatureRun(featureRun.id, this.isCancellationError(error) ? "cancelled" : "failed", error);
      throw error;
    }

    this.throwIfCancelled(job.id);
    const modelRun = this.createModelRun(datasetVersion, featureRun.id, request);
    this.setJobRunIds(job.id, featureRun.id, modelRun.id);
    const metricRunId = this.createTrainingMetricRun(modelRun.id, request, overrideSnapshot.ids);
    const lineage: ModelLineageV2 = {
      sourceRunId: modelRun.id, datasetVersion, factsSnapshotHash: semanticHash({datasetVersion,asOf:request.evaluatedAt,sessions:features.map((f)=>({session:f.trainingSessionId,at:f.workoutStartAt}))}),
      overrideSnapshotHash: semanticHash(overrideSnapshot.ids), modelVersion: SCORING_MODEL_VERSION,
      configVersion: MODEL_CONFIG_VERSION, configHash: modelRun.modelConfigHash, featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      calibrationCohortHash:null, baselineEpochId:null, normalizationVersion:"rai-normalization-identity-v1", normalizationConfigHash:identityNormalizationConfigHash(),
      timezoneIdentifier:request.timezoneIdentifier,asOf:request.evaluatedAt,dataThroughAt:features.at(-1)?.workoutStartAt??null
    };
    try {
      this.updateJobProgress(job.id, "training_metrics", 0, features.length, "Calculating training load");
      this.measureCompute(job.id, "trainingMetrics", () => this.replayTrainingMetrics(job.id, metricRunId, features, request, overrideSnapshot));
      this.finishTrainingMetricRun(metricRunId, "succeeded", null);
      this.updateJobProgress(job.id, "model_replay", 0, features.length, "Replaying ability timeline");
      this.measureCompute(job.id, "modelReplay", () => this.replayModel(job.id, modelRun, features, request));
      const summary = this.database.prepare("SELECT summary_json AS json FROM model_runs WHERE id=?").get(modelRun.id)?.json;
      const reference = typeof summary === "string" ? (JSON.parse(summary) as {baseline:PersonalBaseline|null}).baseline : null;
      lineage.baselineEpochId = this.fitnessEpochId(reference, features, request, modelRun);
      lineage.calibrationCohortHash = reference ? semanticHash(sortWorkoutFeaturesChronologically(features)
        .filter((f)=>reference.calibrationFeatureIds.includes(f.id)).map((f)=>({sessionId:f.trainingSessionId,at:f.workoutStartAt}))) : null;
      // D5：逐日快照先于 epoch 计算落地，所以这里回填而不是重排序。NULL 表示"该行写下时
      // 还不知道标尺"，读端必须把它当未知，不得当成"与当前 epoch 相同"。
      if (lineage.baselineEpochId !== null) {
        this.database.prepare(`UPDATE daily_ability_snapshots SET baseline_epoch_id = ?
          WHERE model_run_id = ? AND baseline_epoch_id IS NULL`)
          .run(lineage.baselineEpochId, modelRun.id);
      }
      new SqliteModelReleaseRepository(this.database).recordLineage(modelRun.id, SCORING_MODEL_VERSION, MODEL_CONFIG_VERSION, lineage);
      this.finishModelRun(modelRun.id, "succeeded", null);
      const releases = new SqliteModelReleaseRepository(this.database);
      this.sealDomainSnapshots(modelRun, metricRunId, features, request, lineage);
      const legacy = this.modelRuns.evaluateValidationGate(modelRun.id, incumbentModelRunId, false);
      // The incumbent is immutable and still contains deleted sessions. Only
      // explicit inactive facts explain removal; a missing candidate row for an
      // active session must still fail the original eligibility drift gate.
      const deletedAssessments = (id: string | null): number => id === null ? 0 : Number(
        this.database.prepare(`SELECT COUNT(*) AS n FROM ability_assessments a
          JOIN training_sessions s ON s.id=a.training_session_id
          WHERE a.model_run_id=? AND s.status='inactive'
          AND a.assessment_status IN ('eligible','trial')
          AND NOT EXISTS (SELECT 1 FROM effective_workout_overrides o
            WHERE o.training_session_id=a.training_session_id)`).get(id)?.n ?? 0);
      const removedEligibleSessions = deletedAssessments(incumbentModelRunId);
      const retainedDeletedSessions = Number(this.database.prepare(`SELECT COUNT(*) AS n
        FROM workout_features f JOIN training_sessions s ON s.id=f.training_session_id
        WHERE f.feature_run_id=? AND s.status='inactive'`).get(modelRun.featureRunId)?.n ?? 0);
      const comparableBaseEligible = legacy.metrics.baseEligibleSessions - removedEligibleSessions;
      const factAdjustedMetrics = {
        baseEligibleSessions: comparableBaseEligible,
        eligibleSessionDelta: Math.abs(comparableBaseEligible - legacy.metrics.candidateEligibleSessions) /
          Math.max(1, comparableBaseEligible),
        invalidValueCount: legacy.metrics.invalidValueCount + retainedDeletedSessions
      };
      const baseSchema = incumbentModelRunId ? this.database.prepare(`SELECT f.feature_schema_version AS schema
        FROM model_runs m JOIN feature_runs f ON f.id=m.feature_run_id WHERE m.id=?`).get(incumbentModelRunId)?.schema : null;
      const previousLineage = incumbentModelRunId ? this.database.prepare("SELECT lineage_json AS json FROM model_v2_runs WHERE model_run_id=?").get(incumbentModelRunId)?.json : null;
      const previousEpoch = typeof previousLineage === "string" ? (JSON.parse(previousLineage) as ModelLineageV2).baselineEpochId : null;
      const removedCalibrationSessions = incumbentModelRunId ? Number(this.database.prepare(`
        SELECT COUNT(*) AS n FROM model_runs m,
          json_each(json_extract(m.summary_json,'$.baseline.calibrationFeatureIds')) calibration
        JOIN workout_features f ON f.id=calibration.value
        JOIN training_sessions s ON s.id=f.training_session_id
        WHERE m.id=? AND s.status='inactive'`).get(incumbentModelRunId)?.n??0) : 0;
      const deletionRecalibration = removedCalibrationSessions > 0 &&
        previousEpoch !== null && previousEpoch !== lineage.baselineEpochId;
      const explicitRebase = request.modelConfig.baselineReferenceStartAt !== undefined && reference !== null &&
        previousEpoch !== null && previousEpoch !== lineage.baselineEpochId;
      // Recalibration intentionally marks the earlier period as calibrating in the
      // new coordinate system. Do not confuse that planned relabeling with lost
      // source eligibility; post-calibration statuses still face the normal gate.
      let rebaseMetrics: { matchedSessions:number; baseEligibleSessions:number; candidateEligibleSessions:number;
        eligibleSessionDelta:number; assessmentStatusChangeRate:number } | null = null;
      if ((explicitRebase || deletionRecalibration) && incumbentModelRunId) {
        const matched = this.database.prepare(`SELECT COUNT(*) AS n,
          SUM(CASE WHEN b.assessment_status<>c.assessment_status THEN 1 ELSE 0 END) AS changed
          FROM ability_assessments b JOIN ability_assessments c ON b.training_session_id=c.training_session_id
          JOIN workout_features f ON f.id=c.feature_id
          WHERE b.model_run_id=? AND c.model_run_id=? AND julianday(f.workout_start_at)>julianday(?)`)
          .get(incumbentModelRunId,modelRun.id,reference?.calibrationEndAt??request.evaluatedAt) as {n:number;changed:number|null};
        const eligible = (id:string):number => Number(this.database.prepare(`SELECT COUNT(*) AS n
          FROM model_runs m JOIN workout_features f ON f.feature_run_id=m.feature_run_id
          WHERE m.id=? AND f.eligibility_status IN ('eligible','trial')
          AND NOT EXISTS (SELECT 1 FROM training_sessions s
            WHERE s.id=f.training_session_id AND s.status='inactive')`).get(id)?.n??0);
        const oldCount=eligible(incumbentModelRunId),newCount=eligible(modelRun.id);
        rebaseMetrics={matchedSessions:deletionRecalibration?legacy.metrics.matchedSessions:matched.n,
          baseEligibleSessions:oldCount,candidateEligibleSessions:newCount,
          eligibleSessionDelta:Math.abs(oldCount-newCount)/Math.max(1,oldCount),
          assessmentStatusChangeRate:matched.n?Number(matched.changed??0)/matched.n:0};
      }
      const sourceBackfill = this.sourceBackfillEvidence(
        request.importBatchId, removedEligibleSessions, removedCalibrationSessions);
      const gate = incumbentModelRunId ? evaluateModelTransitionGateV2({
        candidateModelRunId:modelRun.id, baseModelRunId:incumbentModelRunId,
        ...(features.length === 0 ? {emptyCohort: this.emptyCohortEvidence(incumbentModelRunId,modelRun.id,metricRunId)} : {}),
        ...(sourceBackfill === undefined ? {} : {sourceBackfill}),
        schema:{baseModelVersion:legacy.metrics.baseModelVersion??null,candidateModelVersion:MODEL_CONFIG_VERSION,
          baseFeatureSchemaVersion:typeof baseSchema === "string" ? baseSchema : null,candidateFeatureSchemaVersion:FEATURE_SCHEMA_VERSION,
          baseScaleId:previousEpoch,candidateScaleId:lineage.baselineEpochId ??
            (deletionRecalibration ? "uncalibrated_after_confirmed_calibration_removal" : null)},
        metrics:{...legacy.metrics,assessmentStatusChangeRate:legacy.metrics.assessmentStatusChangeRate??0,
          ...factAdjustedMetrics,
          ...(rebaseMetrics??{}),
          readinessOutputCoverage:Number(releases.snapshots(modelRun.id).some((row)=>row.domain==="readiness")),recoveryIsolationHolds:this.recoveryIsolationHolds}
      }) : {
        gateVersion:"rai-bootstrap-invariants-v1", status:this.recoveryIsolationHolds ? "passed" as const : "failed" as const,
        blocksActivation:!this.recoveryIsolationHolds, failureReasons:this.recoveryIsolationHolds?[]:["recovery_isolation_violated"]
      };
      releases.recordEvaluation({runId:modelRun.id,baseRunId:incumbentModelRunId,datasetVersion,
        status:gate.status,report:{...gate,factChanges:{
          removedEligibleSessions,retainedDeletedSessions,removedCalibrationSessions,deletionRecalibration,
          eligibilityComparisonBasis:rebaseMetrics?"source_features":"ability_assessments",
          originalBaseEligibleSessions:legacy.metrics.baseEligibleSessions,
          originalEligibleSessionDelta:legacy.metrics.eligibleSessionDelta,
          sourceBackfill:sourceBackfill??null
        },rebase:explicitRebase||deletionRecalibration?{
          referenceStartAt:request.modelConfig.baselineReferenceStartAt??null,calibrationEndAt:reference?.calibrationEndAt??null,
          effectiveAt:request.evaluatedAt,rebaseReason:explicitRebase?"explicit_reference_start":"calibration_evidence_removed",
          previousEpoch,candidateEpoch:lineage.baselineEpochId,fullHistoryMetrics:legacy.metrics}:null},createdAt:request.evaluatedAt});
      if (gate.blocksActivation) throw new Error(`Model-version gate failed: ${gate.failureReasons.join(", ") || "not_evaluable"}`);
      this.activateModelRunAndCompleteJob(job.id, modelRun.id, features.length);
    } catch (error) {
      this.finishTrainingMetricRun(
        metricRunId,
        this.isCancellationError(error) ? "cancelled" : "failed",
        error
      );
      this.finishModelRun(modelRun.id, this.isCancellationError(error) ? "cancelled" : "failed", error);
      throw error;
    }
  }

  private emptyCohortEvidence(baseId:string,candidateId:string,metricRunId:string) {
    const counts = this.database.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN s.status='inactive' THEN 1 ELSE 0 END) AS removed
      FROM model_runs m JOIN workout_features f ON f.feature_run_id=m.feature_run_id
      LEFT JOIN training_sessions s ON s.id=f.training_session_id WHERE m.id=?`).get(baseId)!;
    const count = (sql:string,...args:string[]) => Number(this.database.prepare(sql).get(...args)?.n??0);
    const snapshots = new SqliteModelReleaseRepository(this.database).snapshots(candidateId);
    const emptyArray = (domain:string,key:string) => {
      const payload=snapshots.find(row=>row.domain===domain&&row.key==='summary')?.payload as Record<string,unknown>|undefined;
      return Array.isArray(payload?.[key]) && payload[key].length===0;
    };
    return {
      baseSessions:Number(counts.total),removedBaseSessions:Number(counts.removed??0),
      remainingSourceSessions:count("SELECT COUNT(*) AS n FROM training_sessions WHERE status IN ('active','ambiguous')"),
      candidateFeatures:count("SELECT COUNT(*) AS n FROM workout_features f JOIN model_runs m ON m.feature_run_id=f.feature_run_id WHERE m.id=?",candidateId),
      candidateAssessments:count("SELECT COUNT(*) AS n FROM ability_assessments WHERE model_run_id=?",candidateId),
      candidateLoads:count("SELECT COUNT(*) AS n FROM workout_training_loads WHERE training_metric_run_id=?",metricRunId),
      candidateDailyRows:count("SELECT COUNT(*) AS n FROM daily_ability_snapshots WHERE model_run_id=?",candidateId)+
        count("SELECT COUNT(*) AS n FROM daily_training_metrics WHERE training_metric_run_id=?",metricRunId)+
        count("SELECT COUNT(*) AS n FROM daily_zone_profiles WHERE training_metric_run_id=?",metricRunId),
      candidateCheckpointRows:count("SELECT COUNT(*) AS n FROM model_checkpoints WHERE model_run_id=?",candidateId),
      domainSnapshotsEmpty:emptyArray('fitness','assessments')&&emptyArray('fitness','daily')&&
        emptyArray('load','days')&&emptyArray('zones','profiles')&&
        !snapshots.some(row=>row.domain==='load_vector'||row.domain==='zone_coherence')
    };
  }

  /**
   * Structural proof that this candidate's eligibility drift is a pure source
   * backfill: the import removed nothing at all and is the one that pushed the
   * fact timeline backwards. Returns `undefined` (leaving the gate untouched)
   * whenever the batch identity is unknown, so a plain rebuild can never take the
   * exemption. Every field is a count or a membership test — no thresholds.
   */
  private sourceBackfillEvidence(
    importBatchId: string | undefined,
    removedEligibleSessions: number,
    removedCalibrationSessions: number
  ): ModelTransitionSourceBackfillEvidence | undefined {
    if (importBatchId === undefined) return undefined;
    const count = (sql: string, ...args: SQLInputValue[]): number =>
      Number(this.database.prepare(sql).get(...args)?.n ?? 0);
    // `import_entity_changes` is the per-batch change ledger and is the only place
    // a removal of a fact row is written with its batch identity: rows with
    // `change_type='removed'` are inserted by `removeDeletedHealthKitAliasCopies`
    // (database.ts) and `removeHealthKitRecords` (database.ts) exactly when the
    // corresponding `health_records` row is deleted. Counting them by kind is
    // therefore a direct, per-batch zero-deletion witness.
    const removedByKind = (kind: "record" | "workout" | "activity_summary"): number => count(
      `SELECT COUNT(*) AS n FROM import_entity_changes
       WHERE batch_id = ? AND entity_kind = ? AND change_type = 'removed'`,
      importBatchId, kind);
    const removedRecords = removedByKind("record");
    const removedWorkouts = removedByKind("workout");
    const removedActivitySummaries = removedByKind("activity_summary");
    // Durable tombstones attributed to this batch are the second, independent
    // witness. `recordEntityTombstones` is called on the same code paths that
    // delete a fact row, and also for an arrival-less deletion that leaves no
    // change row, so requiring both to be empty is strictly stronger than either
    // alone. Source tombstones are intentionally excluded: a deletion before the
    // entity ever arrived creates no fact-row loss.
    const batchTombstones = count(
      `SELECT COUNT(*) AS n FROM import_entity_tombstones WHERE batch_id = ?`, importBatchId);
    const preservedAbsent = removedRecords === 0 && removedWorkouts === 0 &&
      removedActivitySummaries === 0 && batchTombstones === 0;
    // Membership only — never a time-string comparison. The row that currently
    // holds the global minimum `start_at` must be one of this batch's *inserted*
    // records; an update of an already-present row would not have moved the
    // timeline backwards, so only `inserted` proves the backfill.
    const earliest = this.database.prepare(
      `SELECT id FROM health_records
       WHERE start_at = (SELECT MIN(start_at) FROM health_records) LIMIT 1`
    ).get() as { id: string } | undefined;
    const earliestInsertedIsNewGlobalEarliest = earliest !== undefined && count(
      `SELECT COUNT(*) AS n FROM import_entity_changes
       WHERE batch_id = ? AND entity_kind = 'record' AND change_type = 'inserted' AND entity_id = ?`,
      importBatchId, earliest.id) === 1;
    return {
      preservedAbsent, removedRecords, removedWorkouts, removedActivitySummaries,
      removedEligibleSessions, removedCalibrationSessions, earliestInsertedIsNewGlobalEarliest
    };
  }

  /**
   * 直连增量同步车道登记的分析任务（`job_type='import'` + 载荷
   * `mode='direct_sync_analysis'`，见 §13 PR4 步骤 1）。
   *
   * **前置条件**（由调用方 `RaiApplicationService.runNextJob` 用共享函数
   * `isApplicationConsumableJob(job.jobType, job.request)` 保证）：这条任务确实归应用消费者。
   * 这里**不再复写第二遍判据** —— 同一判据两处写法正是这个仓反复踩过的坑。
   *
   * ⚠️ 本步只落地"消费者认识它并**真正跑分析**"：计算复用 `runFullRecompute` 的同一套
   * feature / metric / model 计算与全部业务发布 gate，**尚未**按 `target_raw_generation` /
   * `target_dependency_generation` 读固定版本事实（`FactsReader`）。代次绑定与"同批登记"
   * 属 PR4 步骤 2，必须与登记、`deltaMode: "full"` 同批落地（见 `docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md`
   * 步骤 6b 的三步上线顺序）。
   */
  runDirectSyncAnalysis(job: RecomputeJob): void {
    // WP-22（O06-A）：消费端**终于读**登记时写下的代次绑定。
    //
    // 没有输入源时（CLI、老调用方、单测）行为与以前逐字节相同 —— 直接跑全量管线。
    // 有输入源时先在一个**只读连接的一致读事务**里捕获输入绑定，再按"捕获到的实际代次"
    // 决定执行计划（可能要把未覆盖账本并进 dirty；并不动就退回全量）。
    this.pendingInputCapture = null;
    if (!this.inputSource) {
      this.runFullRecompute(job);
      return;
    }
    const raw = job.request as Record<string, unknown>;
    const capture = this.inputSource.capture({
      runId: "",
      jobId: job.id,
      scope: "direct-sync",
      timezoneIdentifier: typeof raw.timezoneIdentifier === "string" ? raw.timezoneIdentifier : DATABASE_TIMEZONE,
      evaluatedAt: typeof raw.evaluatedAt === "string" ? normalizeInstant(raw.evaluatedAt, "evaluatedAt") : appNow(),
      targetRawGeneration: job.targetRawGeneration ?? null,
      targetDependencyGeneration: job.targetDependencyGeneration ?? null,
      expectedIncumbentReleaseId: job.expectedIncumbentReleaseId ?? null,
      registeredPlan: typeof raw.incrementalPlan === "object" && raw.incrementalPlan !== null
        && (raw.incrementalPlan as { mode?: unknown }).mode === "partial"
        && typeof (raw.incrementalPlan as { dirtyFromAt?: unknown }).dirtyFromAt === "string"
        ? {
            dirtyFromAt: normalizeInstant((raw.incrementalPlan as { dirtyFromAt: string }).dirtyFromAt, "dirtyFromAt"),
            domains: (raw.incrementalPlan as { domains?: AnalysisDirtyDomains }).domains
              ?? { features: normalizeInstant((raw.incrementalPlan as { dirtyFromAt: string }).dirtyFromAt, "dirtyFromAt"), fitness: null, readiness: null }
          }
        : null
    });
    this.pendingInputCapture = typeof raw.importBatchId === "string"
      && !capture.mergedBatchIds.includes(raw.importBatchId)
      ? { ...capture, mergedBatchIds: [...capture.mergedBatchIds, raw.importBatchId] }
      : capture;
    // 计划被调整（代次前进了）时，把实际计划写回请求：`reuseFeaturePrefix` /
    // `resumeModelReplay` 读的都是 `request.incrementalPlan`。计划为 null ⇒ 删掉键 ⇒ 全量。
    const request: Record<string, unknown> = { ...raw };
    if (capture.plan === null) delete request.incrementalPlan;
    else request.incrementalPlan = { mode: "partial", dirtyFromAt: capture.plan.dirtyFromAt, domains: capture.plan.domains };
    if (capture.planAdjustment !== null) {
      this.jobs.logEvent(job.id, "input_binding", 0, 0,
        `Analysis input plan adjusted: ${capture.planAdjustment} (coverage=${capture.coverage.reason})`);
    }
    try {
      this.runFullRecompute({ ...job, request });
    } finally {
      this.pendingInputCapture = null;
    }
  }

  runSnapshotRefresh(job: RecomputeJob): void {
    this.recordCache.clear();
    const request = this.parseRequest(job.request);
    this.throwIfCancelled(job.id);
    const active = this.database
      .prepare("SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1")
      .get() as unknown as { modelRunId: string } | undefined;
    if (!active) {
      this.completeJob(job.id, "no_active_model", 0, 0, "No active model run to refresh");
      return;
    }
    this.setJobRunIds(job.id, null, active.modelRunId);
    this.throwIfCancelled(job.id);
    const timeline = this.loadTimelineAssessments(active.modelRunId);
    this.writeDailySnapshots(
      active.modelRunId,
      timeline,
      request.evaluatedAt,
      request.timezoneIdentifier,
      true
    );
    this.throwIfCancelled(job.id);
    const metricRun = this.database
      .prepare("SELECT id FROM training_metric_runs WHERE model_run_id = ? AND status = 'succeeded'")
      .get(active.modelRunId) as unknown as { id: string } | undefined;
    if (metricRun) {
      const isV4=this.database.prepare(`SELECT f.feature_schema_version AS schema FROM model_runs m
        JOIN feature_runs f ON f.id=m.feature_run_id WHERE m.id=?`).get(active.modelRunId)?.schema==="workout-feature-v4";
      const featureRunId = this.modelRuns.featureRunId(active.modelRunId);
      if (featureRunId && isV4) {
        this.buildAndPersistZoneProfiles(
          metricRun.id,
          this.loadFeatureRunVectors(featureRunId),
          new Map(this.loadSessions(request.evaluatedAt).map((session) => [session.trainingSessionId, session])),
          request
        );
        this.throwIfCancelled(job.id);
      }
      const loads = this.loadPersistedTrainingLoads(metricRun.id);
      const throughDate = localDateAt(request.evaluatedAt, request.timezoneIdentifier);
      const existingThrough = this.database
        .prepare("SELECT MAX(local_date) AS localDate FROM daily_training_metrics WHERE training_metric_run_id = ?")
        .get(metricRun.id) as unknown as { localDate: string | null };
      if (existingThrough.localDate === null || existingThrough.localDate < throughDate) {
        const startDate = loads[0]?.localDate ?? throughDate;
        const physEvidence = (isV4 ? this.loadDailyPhysEvidence.bind(this) : this.loadLegacyDailyPhysEvidence.bind(this))(startDate, throughDate, request.timezoneIdentifier, request.evaluatedAt);
        const daily = (isV4 ? buildDailyTrainingMetrics : buildLegacyDailyTrainingMetrics)(loads, throughDate, physEvidence);
        this.persistDailyTrainingMetrics(metricRun.id, daily, request, true);
      }
    }
    this.throwIfCancelled(job.id);
    this.completeJob(job.id, "snapshot_refreshed", 1, 1, "Current-day snapshot appended");
  }

  private parseRequest(value: Record<string, unknown>): RecomputeRequest {
    const parsed = value as Partial<RecomputeRequest>;
    return {
      evaluatedAt: normalizeInstant(
        typeof parsed.evaluatedAt === "string" ? parsed.evaluatedAt : appNow(),
        "evaluatedAt"
      ),
      timezoneIdentifier:
        typeof parsed.timezoneIdentifier === "string" ? parsed.timezoneIdentifier : DATABASE_TIMEZONE,
      featureConfig: { ...defaultFeatureConfig, ...(parsed.featureConfig ?? {}) },
      modelConfig: { ...defaultRaiModelConfig, ...(parsed.modelConfig ?? {}) }
      // (2026-09-20) `validationMode` is deliberately not read back: historical
      // job.request records still carry the key, and the shadow replay it selected
      // no longer exists. Ignoring it keeps old jobs replayable.
      ,...(typeof parsed.importBatchId === "string" ? { importBatchId: parsed.importBatchId } : {})
      ,...(parsed.incrementalPlan?.mode === "partial" && typeof parsed.incrementalPlan.dirtyFromAt === "string"
        ? {
            incrementalPlan: {
              ...parsed.incrementalPlan,
              dirtyFromAt: normalizeInstant(parsed.incrementalPlan.dirtyFromAt, "dirtyFromAt")
            }
          }
        : {})
    };
  }

  private manifestValue(key: string): string | null {
    const row = this.database
      .prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get(key) as unknown as { value: string } | undefined;
    return row?.value ?? null;
  }

  private createFeatureRun(datasetVersion: string, config: FeatureConfig): FeatureRun {
    const id = opaqueId("feature_run");
    const createdAt = appNow();
    const canonicalContractVersion = this.manifestValue("parser_contract_version") ?? CONTRACT_VERSION;
    this.database
      .prepare(`
        INSERT INTO feature_runs (
          id, dataset_version, canonical_contract_version, feature_schema_version,
          feature_config_json, feature_config_hash, status, created_at, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `)
      .run(
        id,
        datasetVersion,
        canonicalContractVersion,
        FEATURE_SCHEMA_VERSION,
        JSON.stringify(config),
        configHash({ version: FEATURE_CONFIG_VERSION, config }),
        createdAt,
        createdAt
      );
    return {
      id,
      datasetVersion,
      canonicalContractVersion,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      featureConfig: config as unknown as Record<string, unknown>,
      featureConfigHash: configHash({ version: FEATURE_CONFIG_VERSION, config }),
      status: "running",
      createdAt,
      startedAt: createdAt,
      completedAt: null,
      failure: null
    };
  }

  private finishFeatureRun(
    id: string,
    status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
    error: unknown
  ): void {
    this.database
      .prepare(`
        UPDATE feature_runs
        SET status = ?, completed_at = ?, failure_json = ?
        WHERE id = ?
      `)
      .run(status, appNow(), error === null ? null : JSON.stringify(this.errorPayload(error)), id);
  }

  private createModelRun(
    datasetVersion: string,
    featureRunId: string,
    request: RecomputeRequest
  ): ModelRun {
    const id = opaqueId("model_run");
    const createdAt = appNow();
    const config = request.modelConfig;
    const hash = configHash({ version: MODEL_CONFIG_VERSION, engineVersion: SCORING_MODEL_VERSION, config });
    this.database
      .prepare(`
        INSERT INTO model_runs (
          id, feature_run_id, dataset_version, model_version, model_config_json,
          model_config_hash, evaluated_at, status, created_at, started_at, engine_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
      `)
      .run(
        id,
        featureRunId,
        datasetVersion,
        MODEL_CONFIG_VERSION,
        JSON.stringify(config),
        hash,
        request.evaluatedAt,
        createdAt,
        createdAt,
        // 引擎版本此前只作为 configHash 的输入存在，无法单独查询（§14.4）。历史行保持 NULL。
        SCORING_MODEL_VERSION
      );
    return {
      id,
      featureRunId,
      datasetVersion,
      modelVersion: MODEL_CONFIG_VERSION,
      modelConfig: config as unknown as Record<string, unknown>,
      modelConfigHash: hash,
      evaluatedAt: request.evaluatedAt,
      status: "running",
      createdAt,
      startedAt: createdAt,
      completedAt: null,
      summary: null,
      failure: null
    };
  }

  private finishModelRun(
    id: string,
    status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
    error: unknown
  ): void {
    this.database
      .prepare(`
        UPDATE model_runs
        SET status = ?, completed_at = ?, failure_json = ?
        WHERE id = ?
      `)
      .run(status, appNow(), error === null ? null : JSON.stringify(this.errorPayload(error)), id);
  }

  private createTrainingMetricRun(
    modelRunId: string,
    request: RecomputeRequest,
    overrideSnapshotIds: string[]
  ): string {
    const id = opaqueId("training_metric_run");
    const createdAt = appNow();
    const config = {
      dailyMetrics: defaultDailyMetricConfig,
      zoneVersion: TRAINING_ZONE_CONFIG_VERSION,
      heartRateReserveBoundaries: [0.6, 0.7, 0.8, 0.9],
      paceThresholdMultipliers: [1.15, 1.06, 0.97, 0.9],
      overrideSnapshotIds
    };
    this.database.prepare(`
      INSERT INTO training_metric_runs (
        id, model_run_id, algorithm_version, config_json, config_hash,
        timezone_identifier, evaluated_at, status, created_at, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      id,
      modelRunId,
      TRAINING_LOAD_CONFIG_VERSION,
      JSON.stringify(config),
      configHash({ version: TRAINING_LOAD_CONFIG_VERSION, config }),
      request.timezoneIdentifier,
      request.evaluatedAt,
      createdAt,
      createdAt
    );
    return id;
  }

  private finishTrainingMetricRun(
    id: string,
    status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">,
    error: unknown
  ): void {
    const current = this.database
      .prepare("SELECT status FROM training_metric_runs WHERE id = ?")
      .get(id) as unknown as { status: string } | undefined;
    if (!current || current.status !== "running") return;
    const summary = status === "succeeded"
      ? this.database.prepare(`
          SELECT
            (SELECT COUNT(*) FROM workout_training_loads WHERE training_metric_run_id = ?) AS loadCount,
            (SELECT COUNT(*) FROM daily_training_metrics WHERE training_metric_run_id = ?) AS dayCount
        `).get(id, id)
      : null;
    this.database.prepare(`
      UPDATE training_metric_runs
      SET status = ?, summary_json = ?, failure_json = ?, completed_at = ?
      WHERE id = ?
    `).run(
      status,
      summary === null ? null : JSON.stringify(summary),
      error === null ? null : JSON.stringify(this.errorPayload(error)),
      appNow(),
      id
    );
  }

  private loadSessions(evaluatedAt: string): SessionRow[] {
    return (this.sessions.listActiveForFeatures() as SessionRow[]).filter(
      (session) => session.workoutStartAt <= evaluatedAt && session.workoutEndAt <= evaluatedAt
    );
  }

  private captureOverrideSnapshot(): OverrideSnapshot {
    const rows = this.database.prepare(`
      SELECT * FROM effective_workout_overrides ORDER BY training_session_id
    `).all() as unknown as Array<Record<string, unknown>>;
    const overrides = rows.map((row): WorkoutOverride => ({
      id: String(row.id),
      trainingSessionId: String(row.training_session_id),
      revision: Number(row.revision),
      eligibilityOverride:
        row.eligibility_override === "include" || row.eligibility_override === "exclude"
          ? row.eligibility_override
          : null,
      statisticsParticipation:
        row.statistics_participation === "include" || row.statistics_participation === "exclude"
          ? row.statistics_participation
          : null,
      sessionType: typeof row.session_type === "string" ? row.session_type as SessionType : null,
      performanceProtocol:
        typeof row.performance_protocol === "string"
          ? row.performance_protocol as PerformanceProtocol
          : null,
      rpe: typeof row.rpe === "number" ? row.rpe : null,
      conditionTags: parseJson(typeof row.condition_tags_json === "string" ? row.condition_tags_json : "[]", []),
      note: typeof row.note === "string" ? row.note : null,
      createdAt: String(row.created_at)
    }));
    return {
      ids: overrides.map((override) => override.id),
      byTrainingSessionId: new Map(overrides.map((override) => [override.trainingSessionId, override]))
    };
  }

  private loadStatistic(workoutId: string, type: string): StatisticRow | null {
    const row = this.database
      .prepare(`
        SELECT average_value AS averageValue, minimum_value AS minimumValue,
               maximum_value AS maximumValue, unit
        FROM workout_statistics
        WHERE workout_id = ? AND type = ?
        ORDER BY ordinal
        LIMIT 1
      `)
      .get(workoutId, type) as unknown as StatisticRow | undefined;
    return row ?? null;
  }

  private loadRecordSeries(
    sourceName: string,
    workoutStartAt: string,
    workoutEndAt: string,
    type: string
  ): RecordRow[] {
    const key = JSON.stringify([sourceName, workoutStartAt, workoutEndAt, type]);
    const cached = this.recordCache.get(key);
    if (cached !== undefined) return cached;
    const records = this.queryRecordSeries(sourceName, workoutStartAt, workoutEndAt, type);
    this.recordCache.set(key, records, records.length);
    return records;
  }

  private queryRecordSeries(
    sourceName: string, workoutStartAt: string, workoutEndAt: string, type: string
  ): RecordRow[] {
    const unitSelect = this.hasHealthRecordUnitColumn() ? ", unit" : "";
    const exact = this.database
      .prepare(`
        SELECT value_numeric AS value, start_at AS startAt, end_at AS endAt${unitSelect}
        FROM (
          SELECT DISTINCT value_numeric, start_at, end_at${unitSelect}
          FROM health_records
          WHERE source_name = ?
            AND type = ?
            AND value_numeric IS NOT NULL
            AND start_at <= ?
            AND end_at >= ?
        )
        ORDER BY start_at
      `)
      .all(sourceName, type, workoutEndAt, workoutStartAt) as unknown as RecordRow[];
    if (exact.length > 0 || type !== heartRateType) return exact;

    const fallback = this.database.prepare(`
      SELECT source_name AS sourceName
      FROM health_records
      WHERE source_name <> ? AND type = ? AND value_numeric IS NOT NULL
        AND start_at <= ? AND end_at >= ?
        AND source_category IN ('apple_watch', 'coros', 'huawei', 'connect', 'other')
      GROUP BY source_name
      ORDER BY
        CASE MAX(source_category)
          WHEN 'apple_watch' THEN 5 WHEN 'coros' THEN 4 WHEN 'huawei' THEN 3
          WHEN 'connect' THEN 2 ELSE 1
        END DESC,
        COUNT(*) DESC,
        source_name
      LIMIT 1
    `).get(sourceName, type, workoutEndAt, workoutStartAt) as unknown as { sourceName: string } | undefined;
    if (!fallback) return exact;
    return this.database.prepare(`
      SELECT value_numeric AS value, start_at AS startAt, end_at AS endAt${unitSelect}
      FROM (
        SELECT DISTINCT value_numeric, start_at, end_at${unitSelect}
        FROM health_records
        WHERE source_name = ? AND type = ? AND value_numeric IS NOT NULL
          AND start_at <= ? AND end_at >= ?
      )
      ORDER BY start_at
    `).all(fallback.sourceName, type, workoutEndAt, workoutStartAt) as unknown as RecordRow[];
  }

  private loadPersonalRecovery(workoutStartAt: string, timezoneIdentifier: string): {
    restingHeartRate: number | null;
    hrvSdnn: number | null;
    sleepDurationMinutes: number | null;
    recentLoadMinutes: number | null;
    baseline: NonNullable<WorkoutFeatureSource["recoveryBaseline"]>;
    context: NonNullable<WorkoutFeatureSource["recoveryContext"]>;
  } {
    const instant = Date.parse(workoutStartAt);
    const localDate = localDateAt(workoutStartAt, timezoneIdentifier);
    const medianValue = (values: number[]): number | null => {
      const valid = values.filter((value) => Number.isFinite(value));
      return valid.length ? median(valid) : null;
    };
    const night = this.database.prepare(`
      SELECT id, wake_at AS wakeAt, asleep_union_minutes AS sleepMinutes
      FROM canonical_nights
      WHERE kind = 'main' AND timezone_identifier = ? AND wake_at IS NOT NULL AND wake_at < ?
      ORDER BY wake_at DESC LIMIT 1
    `).get(timezoneIdentifier, workoutStartAt) as unknown as { id: string; wakeAt: string; sleepMinutes: number | null } | undefined;
    const recentNight = night && Number.isFinite(Date.parse(night.wakeAt)) && instant - Date.parse(night.wakeAt) <= 36 * 3_600_000
      ? night
      : undefined;
    const hrv = recentNight
      ? this.database.prepare(`
          SELECT hrv_sdnn_ms AS value, confidence
          FROM canonical_hrv_days WHERE night_id = ? AND hrv_sdnn_ms IS NOT NULL
            AND window_end_at IS NOT NULL AND window_end_at < ?
          ORDER BY computed_at DESC LIMIT 1
        `).get(recentNight.id, workoutStartAt) as unknown as { value: number; confidence: string } | undefined
      : undefined;
    const rhrRows = this.database.prepare(`
      SELECT source_category AS sourceCategory, value_numeric AS value
      FROM health_records
      WHERE type = ? AND value_numeric IS NOT NULL
        AND source_category IN ('apple_watch', 'connect')
        AND start_at >= ? AND start_at < ?
      ORDER BY start_at
    `).all(
      restingHeartRateType,
      new Date(instant - 36 * 3_600_000).toISOString(),
      workoutStartAt
    ) as unknown as Array<{ sourceCategory: string; value: number }>;
    const watchRhr = rhrRows.filter((row) => row.sourceCategory === "apple_watch");
    const restingHeartRate = medianValue((watchRhr.length ? watchRhr : rhrRows).map((row) => Number(row.value)));

    const readBaseline = (table: "sleep" | "hrv" | "rhr" | "load", days: number): number[] => {
      const fromDate = addDays(localDate, -days);
      if (table === "sleep") {
        return (this.database.prepare(`SELECT asleep_union_minutes AS value FROM canonical_nights WHERE kind='main' AND timezone_identifier=? AND wake_date >= ? AND wake_date < ? AND wake_at < ?`).all(timezoneIdentifier, fromDate, localDate, workoutStartAt) as Array<{ value: number | null }>).flatMap((row) => row.value == null ? [] : [Number(row.value)]);
      }
      if (table === "hrv") {
        return (this.database.prepare(`SELECT hrv_sdnn_ms AS value FROM canonical_hrv_days WHERE timezone_identifier=? AND local_date >= ? AND local_date < ? AND confidence <> 'missing' AND window_end_at < ? AND hrv_sdnn_ms IS NOT NULL`).all(timezoneIdentifier, fromDate, localDate, workoutStartAt) as Array<{ value: number }>).map((row) => Number(row.value));
      }
      if (table === "rhr") {
        const rows = this.database.prepare(`SELECT source_category AS sourceCategory, value_numeric AS value, start_at AS startAt FROM health_records WHERE type=? AND value_numeric IS NOT NULL AND source_category IN ('apple_watch', 'connect') AND start_at >= ? AND start_at < ? AND end_at < ?`).all(restingHeartRateType, localDateStartAt(fromDate, timezoneIdentifier), localDateStartAt(localDate, timezoneIdentifier), localDateStartAt(localDate, timezoneIdentifier)) as Array<{ sourceCategory: string; value: number; startAt: string }>;
        // Apply Watch-first/Connect fallback independently for each local day.
        const byDate = new Map<string, Array<{ sourceCategory: string; value: number }>>();
        for (const row of rows) {
          const date = localDateAt(row.startAt, timezoneIdentifier);
          const bucket = byDate.get(date) ?? [];
          bucket.push(row);
          byDate.set(date, bucket);
        }
        return [...byDate.values()].flatMap((dayRows) => {
          const watch = dayRows.filter((row) => row.sourceCategory === "apple_watch");
          const value = medianValue((watch.length ? watch : dayRows).map((row) => Number(row.value)));
          return value === null ? [] : [value];
        });
      }
      const rows = this.database.prepare(`SELECT workout.start_at AS startAt, workout.duration_seconds AS durationSeconds FROM training_sessions session JOIN workouts workout ON workout.id=session.canonical_workout_id WHERE session.activity_type=? AND session.status='active' AND workout.start_at < ?`).all(runningType, workoutStartAt) as Array<{ startAt: string; durationSeconds: number }>;
      const byDate = new Map<string, number>();
      for (const row of rows) {
        const date = localDateAt(row.startAt, timezoneIdentifier);
        if (date >= fromDate && date < localDate) byDate.set(date, (byDate.get(date) ?? 0) + Number(row.durationSeconds) / 60);
      }
      return [...byDate.values()];
    };
    const baselineFor = (table: "sleep" | "hrv" | "rhr" | "load"): { value: number | null; lookbackDays: number; validDays: number } => {
      const recent = readBaseline(table, 28).filter(Number.isFinite);
      if (recent.length >= 7) return { value: medianValue(recent), lookbackDays: 28, validDays: recent.length };
      const extended = readBaseline(table, 60).filter(Number.isFinite);
      return { value: extended.length >= 7 ? medianValue(extended) : null, lookbackDays: 60, validDays: extended.length };
    };
    const sleepBase = baselineFor("sleep");
    const hrvBase = baselineFor("hrv");
    const rhrBase = baselineFor("rhr");
    const loadBase = baselineFor("load");
    const recentLoadRows = this.database.prepare(`SELECT SUM(duration_seconds)/60.0 AS value FROM training_sessions session JOIN workouts workout ON workout.id=session.canonical_workout_id WHERE session.activity_type=? AND session.status='active' AND workout.start_at >= ? AND workout.start_at < ?`).get(runningType, new Date(instant - 7 * 86_400_000).toISOString(), workoutStartAt) as unknown as { value: number | null } | undefined;
    return {
      restingHeartRate,
      hrvSdnn: hrv?.value == null ? null : Number(hrv.value),
      sleepDurationMinutes: recentNight?.sleepMinutes == null ? null : Number(recentNight.sleepMinutes),
      recentLoadMinutes: asNullableNumber(recentLoadRows?.value),
      baseline: {
        sleepMinutes: sleepBase.value,
        restingHeartRateBpm: rhrBase.value,
        hrvSdnnMs: hrvBase.value,
        loadMinutes: loadBase.value,
        lookbackDays: Math.max(sleepBase.lookbackDays, hrvBase.lookbackDays, rhrBase.lookbackDays, loadBase.lookbackDays),
        validDays: { sleep: sleepBase.validDays, hrv: hrvBase.validDays, rhr: rhrBase.validDays, load: loadBase.validDays }
      },
      context: {
        asOfAt: workoutStartAt,
        nightId: recentNight?.id ?? null,
        hrvConfidence: hrv?.confidence as NonNullable<WorkoutFeatureSource["recoveryContext"]>["hrvConfidence"] ?? null,
        rhrSourceCategory: watchRhr.length ? "apple_watch" : rhrRows.length ? "connect" : null
      }
    };
  }

  private loadObservedMaximumHeartRate(workoutStartAt: string): number | null {
    const cutoff = new Date(Date.parse(workoutStartAt) - 180 * 86_400_000).toISOString();
    const row = this.database
      .prepare(`
        SELECT MAX(value_numeric) AS value
        FROM health_records
        WHERE type = ? AND value_numeric IS NOT NULL
          AND start_at >= ? AND start_at < ?
      `)
      .get(heartRateType, cutoff, workoutStartAt) as unknown as { value: number | null } | undefined;
    return asNullableNumber(row?.value);
  }


  private loadRecentLoadMinutes(workoutStartAt: string): number | null {
    const cutoff = new Date(Date.parse(workoutStartAt) - 7 * 86_400_000).toISOString();
    const row = this.database
      .prepare(`
        SELECT SUM(workout.duration_seconds) / 60.0 AS value
        FROM training_sessions session
        JOIN workouts workout ON workout.id = session.canonical_workout_id
        WHERE session.activity_type = ? AND session.status = 'active'
          AND workout.start_at >= ? AND workout.start_at < ?
      `)
      .get(runningType, cutoff, workoutStartAt) as unknown as { value: number | null } | undefined;
    return asNullableNumber(row?.value);
  }

  private loadRouteQuality(workoutId: string): RouteQualityRow {
    const row = this.database
      .prepare(`
        SELECT
          COUNT(point.sequence) AS pointCount,
          AVG(point.horizontal_accuracy_meters) AS averageHorizontalAccuracy
        FROM workout_routes route
        LEFT JOIN route_points point ON point.route_id = route.id
        WHERE route.workout_id = ? AND route.file_status = 'imported'
      `)
      .get(workoutId) as unknown as RouteQualityRow | undefined;
    return {
      pointCount: Number(row?.pointCount ?? 0),
      averageHorizontalAccuracy: asNullableNumber(row?.averageHorizontalAccuracy)
    };
  }

  private loadElevationGain(workoutId: string): number | null {
    if (this.allowNativeAggregates && this.nativeElevationGains?.has(workoutId)) {
      return this.nativeElevationGains.get(workoutId) ?? null;
    }
    const rows = this.database.prepare(`
      SELECT point.elevation_meters AS elevation
      FROM workout_routes route
      JOIN route_points point ON point.route_id = route.id
      WHERE route.workout_id = ? AND point.elevation_meters IS NOT NULL
      ORDER BY point.sequence
    `).all(workoutId) as unknown as Array<{ elevation: number }>;
    if (rows.length < 2) return null;
    let gain = 0;
    let previous = Number(rows[0]!.elevation);
    for (const row of rows.slice(1)) {
      const current = Number(row.elevation);
      const delta = current - previous;
      // Reject GPS altitude spikes while preserving ordinary climbing.
      if (Number.isFinite(delta) && delta > 0 && delta < 30) gain += delta;
      previous = current;
    }
    return gain;
  }

  private buildFeatureSource(row: SessionRow, override: WorkoutOverride | null, timezoneIdentifier: string = DATABASE_TIMEZONE): WorkoutFeatureSource {
    const heartRecords = this.loadRecordSeries(
      row.sourceName,
      row.workoutStartAt,
      row.workoutEndAt,
      heartRateType
    );
    const speedRecords = this.loadRecordSeries(
      row.sourceName,
      row.workoutStartAt,
      row.workoutEndAt,
      runningSpeedType
    );
    const heartRate = heartRecords.length > 0
      ? summaryFromRecords(heartRecords, "count/min", row.workoutStartAt, row.workoutEndAt)
      : fallbackStatisticSummary(
          this.loadStatistic(row.canonicalWorkoutId, heartRateType),
          row.workoutStartAt,
          row.workoutEndAt
        );
    const speed = speedRecords.length > 0
      ? summaryFromRecords(
          speedRecords,
          null,
          row.workoutStartAt,
          row.workoutEndAt,
          convertSpeedToMetersPerSecond
        )
      : fallbackStatisticSummary(
          this.loadStatistic(row.canonicalWorkoutId, runningSpeedType),
          row.workoutStartAt,
          row.workoutEndAt,
          convertSpeedToMetersPerSecond
        );
    const route = this.loadRouteQuality(row.canonicalWorkoutId);
    const routeQuality =
      route.pointCount === 0
        ? null
        : route.averageHorizontalAccuracy === null
          ? 0.75
          : clamp(1 - route.averageHorizontalAccuracy / 50, 0, 1);
    return {
      id: row.canonicalWorkoutId,
      trainingSessionId: row.trainingSessionId,
      trainingSessionStatus: row.trainingSessionStatus,
      workoutStartAt: row.workoutStartAt,
      workoutEndAt: row.workoutEndAt,
      durationSeconds: Number(row.durationSeconds),
      distanceKm: convertDistanceToKilometers(asNullableNumber(row.distanceValue), row.distanceUnit),
      indoor: row.indoor === null ? null : Number(row.indoor) === 1,
      sourceCategory: row.sourceCategory,
      routePointCount: route.pointCount,
      routeQuality,
      speed,
      speedSamples: weightedRecordIntervals(
        speedRecords,
        row.workoutStartAt,
        row.workoutEndAt,
        (value, unit) => convertSpeedToMetersPerSecond(value, unit)
      ).map((interval) => ({
        value: interval.value,
        startOffsetSeconds: Math.max(0, (interval.startMs - Date.parse(row.workoutStartAt)) / 1000),
        durationSeconds: interval.durationSeconds
      })),
      heartRate,
      heartRateSamples: weightedRecordIntervals(heartRecords, row.workoutStartAt, row.workoutEndAt, (value) => value).map((interval) => ({
        value: interval.value, startOffsetSeconds: Math.max(0,(interval.startMs-Date.parse(row.workoutStartAt))/1000),durationSeconds:interval.durationSeconds
      })),
      environment: parsePerformanceConditions(String(this.database.prepare("SELECT metadata_json FROM workouts WHERE id=?").get(row.canonicalWorkoutId)?.metadata_json ?? "{}")),
      ...(() => {
        const recovery = this.loadPersonalRecovery(row.workoutStartAt, timezoneIdentifier);
        return {
          restingHeartRate: recovery.restingHeartRate,
          // Prior-day reference only. Missing history must not reopen the
          // recovery -> HRR -> session type -> Fitness channel.
          restingHeartRateReference: recovery.baseline.restingHeartRateBpm,
          hrvSdnn: recovery.hrvSdnn,
          sleepDurationMinutes: recovery.sleepDurationMinutes,
          recentLoadMinutes: recovery.recentLoadMinutes,
          recoveryBaseline: recovery.baseline,
          recoveryContext: recovery.context
        };
      })(),
      observedMaximumHeartRate: this.loadObservedMaximumHeartRate(row.workoutStartAt),
      override
    };
  }

  private extractFeatures(
    jobId: string,
    featureRun: FeatureRun,
    request: RecomputeRequest,
    overrideSnapshot: OverrideSnapshot
  ): WorkoutFeatureVector[] {
    const allSessions = this.loadSessions(request.evaluatedAt);
    const reuse = this.reuseFeaturePrefix(featureRun, request, overrideSnapshot);
    const sessions = reuse === null
      ? allSessions
      : allSessions.filter((session) => session.workoutStartAt >= reuse.dirtyFromAt);
    const insert = this.database.prepare(`
      INSERT INTO workout_features (
        id, feature_run_id, training_session_id, canonical_workout_id,
        workout_start_at, duration_seconds, distance_km, average_speed_mps,
        average_heart_rate_bpm, heart_rate_sample_count, heart_rate_coverage,
        route_point_count, route_quality, source_confidence, session_type,
        session_type_source, eligibility_status, quality_score,
        missing_reasons_json, features_json, provenance_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const features: WorkoutFeatureVector[] = [];
    // O07 步骤 4：≤100 行一个许可窗口（让路点在**提交之后**，见 `ChunkedWriter`）。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const [index, session] of sessions.entries()) {
      this.throwIfCancelled(jobId);
      // 让路点（PR4 §3.2.1）：把"接收优先"的等待上界从"一整轮"压到"一小段计算"。
      // 此刻没有开着的事务（分块在 `add()` 内即时提交），所以它是真的让路点。
      this.gate.yieldIfStale();
      const featureId = deterministicId("workout_feature", {
        featureRunId: featureRun.id,
        trainingSessionId: session.trainingSessionId
      });
      const source = this.buildFeatureSource(session, overrideSnapshot.byTrainingSessionId.get(session.trainingSessionId) ?? null, request.timezoneIdentifier);
      const v4 = extractWorkoutFeatureVectorV4(featureId, featureRun.id, source, request.featureConfig, request.evaluatedAt);
      const feature = projectFeatureV4(v4);
      // Small pure counterfactual, not a second full recomputation/shadow system.
      // 🔴 2026-10-15（P2-6）口径：这是**运行期哨兵**，不是数据证据。恒真的根因比"强制
      // null"更深 —— 突变实测（移除 `v4.ts:19-21` 的 null 覆盖后本反事实**仍恒真**）：V3
      // 冻结提取器本身就不消费 recovery 输入，null 覆盖是双保险。哨兵真正转红的条件 =
      // recovery 进入 **payload 输出**（已验证：给 payload.raw 注入一个 recovery 值，
      // 测试层的属性断言即转红）。数据证据在 `packages/features/test/v4.test.ts` 的
      // 参数化属性测试。
      const counterfactual = projectFeatureV4(extractWorkoutFeatureVectorV4(featureId, featureRun.id, {
        ...source, restingHeartRate: 99, hrvSdnn: 1, sleepDurationMinutes: 1, recentLoadMinutes: 9999
      }, request.featureConfig, request.evaluatedAt));
      this.recoveryIsolationHolds &&= semanticHash(feature) === semanticHash(counterfactual);
      writer.add(() => {
        insert.run(
          feature.id,
          feature.featureRunId,
          feature.trainingSessionId,
          feature.canonicalWorkoutId,
          feature.workoutStartAt,
          feature.durationSeconds,
          feature.distanceKm,
          feature.averageSpeedMetersPerSecond,
          feature.averageHeartRateBpm,
          feature.heartRateSampleCount,
          feature.heartRateCoverage,
          feature.routePointCount,
          feature.routeQuality,
          feature.sourceConfidence,
          feature.sessionType,
          feature.sessionTypeSource,
          feature.eligibilityStatus,
          feature.qualityScore,
          JSON.stringify(feature.missingReasons),
          encodeFeaturePayloadV4(v4.payload),
          JSON.stringify(v4.provenance),
          feature.computedAt
        );
        this.updateJobProgress(jobId, "feature_extraction", index + 1, sessions.length, "Feature extracted");
      });
      features.push(feature);
    }
    writer.flush();
    this.database.prepare(`
      UPDATE feature_runs SET reused_feature_count = ?, recomputed_feature_count = ? WHERE id = ?
    `).run(reuse?.count ?? 0, features.length, featureRun.id);
    return reuse === null ? features : this.loadFeatureRunVectors(featureRun.id);
  }

  private reuseFeaturePrefix(
    featureRun: FeatureRun,
    request: RecomputeRequest,
    overrideSnapshot: OverrideSnapshot
  ): { count: number; dirtyFromAt: string } | null {
    // O04（WP-20）：优先取分域边界（`domains.features` = 相交训练回退后的保守下界）；
    // 老 payload 没有 `domains` 时回落单一边界 `dirtyFromAt`。`domains` 存在但为 null
    // 表示"full"（不复用）——不得再回落到 dirtyFromAt（那是 payload 内部矛盾态）。
    const plan = request.incrementalPlan;
    const dirtyFromAt = plan?.domains ? plan.domains.features : plan?.dirtyFromAt;
    if (!dirtyFromAt) return null;
    const parent = this.database.prepare(`
      SELECT feature.id, feature.feature_config_hash AS configHash,
             feature.feature_schema_version AS schemaVersion,
             feature.canonical_contract_version AS contractVersion,
             metric.timezone_identifier AS timezone, metric.config_json AS metricConfig
      FROM active_model_run active
      JOIN model_runs model ON model.id = active.model_run_id AND model.status = 'succeeded'
      JOIN feature_runs feature ON feature.id = model.feature_run_id AND feature.status = 'succeeded'
      JOIN training_metric_runs metric ON metric.model_run_id = model.id AND metric.status = 'succeeded'
      WHERE active.singleton = 1
    `).get() as unknown as { id: string; configHash: string; schemaVersion: string; contractVersion: string; timezone: string; metricConfig: string } | undefined;
    const contract = this.manifestValue("parser_contract_version") ?? CONTRACT_VERSION;
    if (!parent || parent.configHash !== configHash({ version: FEATURE_CONFIG_VERSION, config: request.featureConfig }) ||
        parent.schemaVersion !== FEATURE_SCHEMA_VERSION || parent.contractVersion !== contract ||
        parent.timezone !== request.timezoneIdentifier) return null;

    const rows = this.database.prepare(`
      SELECT feature.*
      FROM workout_features feature
      JOIN training_sessions session ON session.id = feature.training_session_id
      JOIN workouts workout ON workout.id = session.canonical_workout_id
      WHERE feature.feature_run_id = ? AND feature.workout_start_at < ?
        AND workout.start_at <= ? AND workout.end_at <= ?
      ORDER BY feature.workout_start_at, feature.id
    `).all(parent.id, dirtyFromAt, request.evaluatedAt, request.evaluatedAt) as unknown as Array<Record<string, unknown>>;
    const expected = this.loadSessions(request.evaluatedAt).filter((session) => session.workoutStartAt < dirtyFromAt);
    const bySession = new Map(rows.map((row) => [String(row.training_session_id), row]));
    const oldOverrideIds = parseJson<{ overrideSnapshotIds?: unknown } | null>(parent.metricConfig, null)?.overrideSnapshotIds;
    if (!Array.isArray(oldOverrideIds) || oldOverrideIds.some((id) => typeof id !== "string")) return null;
    const oldOverrides = this.database.prepare(`SELECT id,training_session_id AS sessionId FROM workout_overrides
      WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(oldOverrideIds)) as { id: string; sessionId: string }[];
    if (oldOverrides.length !== new Set(oldOverrideIds).size) return null;
    const previousOverrides = new Map(oldOverrides.map((override) => [override.sessionId, override.id]));
    if (rows.length !== expected.length || expected.some((session) => {
      const row = bySession.get(session.trainingSessionId);
      return !row || row.canonical_workout_id !== session.canonicalWorkoutId || row.workout_start_at !== session.workoutStartAt ||
        (previousOverrides.get(session.trainingSessionId) ?? null) !== (overrideSnapshot.byTrainingSessionId.get(session.trainingSessionId)?.id ?? null);
    })) return null;
    const insert = this.database.prepare(`
      INSERT INTO workout_features (
        id, feature_run_id, training_session_id, canonical_workout_id, workout_start_at,
        duration_seconds, distance_km, average_speed_mps, average_heart_rate_bpm,
        heart_rate_sample_count, heart_rate_coverage, route_point_count, route_quality,
        source_confidence, session_type, session_type_source, eligibility_status, quality_score,
        missing_reasons_json, features_json, provenance_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // O07 步骤 4：复用前缀的逐行拷贝同样按分块短事务落地。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const row of rows) {
      this.gate.yieldIfStale();
      writer.add(() => insert.run(
        deterministicId("workout_feature", { featureRunId: featureRun.id, trainingSessionId: row.training_session_id }),
        featureRun.id, row.training_session_id as SQLInputValue, row.canonical_workout_id as SQLInputValue,
        row.workout_start_at as SQLInputValue, row.duration_seconds as SQLInputValue, row.distance_km as SQLInputValue,
        row.average_speed_mps as SQLInputValue, row.average_heart_rate_bpm as SQLInputValue,
        row.heart_rate_sample_count as SQLInputValue, row.heart_rate_coverage as SQLInputValue,
        row.route_point_count as SQLInputValue, row.route_quality as SQLInputValue, row.source_confidence as SQLInputValue,
        row.session_type as SQLInputValue, row.session_type_source as SQLInputValue, row.eligibility_status as SQLInputValue,
        row.quality_score as SQLInputValue, row.missing_reasons_json as SQLInputValue,
        row.features_json as SQLInputValue, row.provenance_json as SQLInputValue, row.computed_at as SQLInputValue
      ));
    }
    writer.flush();
    this.database.prepare("UPDATE feature_runs SET parent_feature_run_id = ? WHERE id = ?").run(parent.id, featureRun.id);
    return { count: rows.length, dirtyFromAt };
  }

  private loadFeatureRunVectors(featureRunId: string): WorkoutFeatureVector[] {
    const rows = this.database.prepare(`
      SELECT * FROM workout_features WHERE feature_run_id = ? ORDER BY workout_start_at, id
    `).all(featureRunId) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => decodeStoredFeature(String(row.features_json), {
      id: String(row.id), featureRunId: String(row.feature_run_id), trainingSessionId: String(row.training_session_id),
      canonicalWorkoutId: String(row.canonical_workout_id), workoutStartAt: String(row.workout_start_at),
      durationSeconds: Number(row.duration_seconds), distanceKm: asNullableNumber(row.distance_km),
      averageSpeedMetersPerSecond: asNullableNumber(row.average_speed_mps),
      averageHeartRateBpm: asNullableNumber(row.average_heart_rate_bpm),
      heartRateSampleCount: Number(row.heart_rate_sample_count), heartRateCoverage: asNullableNumber(row.heart_rate_coverage),
      routePointCount: Number(row.route_point_count), routeQuality: asNullableNumber(row.route_quality),
      sourceConfidence: Number(row.source_confidence), sessionType: String(row.session_type) as SessionType,
      sessionTypeSource: String(row.session_type_source) as WorkoutFeatureVector["sessionTypeSource"],
      eligibilityStatus: String(row.eligibility_status) as EligibilityStatus, qualityScore: Number(row.quality_score),
      missingReasons: parseJson(String(row.missing_reasons_json), []) as MissingReasonCode[],
      signals: parseJson(String(row.features_json), {}) as WorkoutFeatureVector["signals"],
      provenance: parseJson(String(row.provenance_json), {}), computedAt: String(row.computed_at)
    }));
  }

  private metricSamplesForSession(
    session: SessionRow,
    type: string,
    converter: (value: number, unit: string | null) => number
  ): TimedMetricSample[] {
    const intervals = weightedRecordIntervals(
      this.loadRecordSeries(session.sourceName, session.workoutStartAt, session.workoutEndAt, type),
      session.workoutStartAt,
      session.workoutEndAt,
      converter
    );
    const startMs = Date.parse(session.workoutStartAt);
    const samples = intervals.map((interval) => ({
      value: interval.value,
      durationSeconds: interval.durationSeconds,
      startOffsetSeconds: Math.max(0, (interval.startMs - startMs) / 1000),
      ...(type === runningSpeedType ? { distanceMeters: interval.value * interval.durationSeconds } : {})
    }));
    if (type !== runningSpeedType) return samples;
    const duration = Math.max(0, Math.ceil((Date.parse(session.workoutEndAt) - startMs) / 1000));
    const perSecond = new Array<number | null>(duration).fill(null);
    for (const sample of samples) {
      const pace = sample.value > 0 ? 1000 / sample.value : Number.POSITIVE_INFINITY;
      if (pace < 150 || pace > 900) continue;
      const start = Math.max(0, Math.floor(sample.startOffsetSeconds));
      const end = Math.min(duration, Math.ceil(sample.startOffsetSeconds + sample.durationSeconds));
      for (let second = start; second < end; second += 1) perSecond[second] = sample.value;
    }
    const smoothed: TimedMetricSample[] = [];
    for (let second = 0; second < perSecond.length; second += 1) {
      if (perSecond[second] === null) continue;
      const values = perSecond
        .slice(Math.max(0, second - 29), second + 1)
        .filter((sample): sample is number => finiteNumber(sample));
      const value = median(values);
      if (value === null) continue;
      smoothed.push({ value, durationSeconds: 1, startOffsetSeconds: second, distanceMeters: value });
    }
    return smoothed.length >= 30 ? smoothed : [];
  }

  private loadRestingHeartRateEvidence(evaluatedAt: string): RestingHeartRateEvidence[] {
    return (this.database.prepare(`
      SELECT value_numeric AS valueBpm, start_at AS observedAt
      FROM health_records
      WHERE type = ? AND value_numeric IS NOT NULL AND start_at < ?
      ORDER BY start_at
    `).all(restingHeartRateType, evaluatedAt) as unknown as RestingHeartRateEvidence[]);
  }

  private loadDateOfBirth(): string | null {
    const row = this.database.prepare("SELECT attributes_json AS attributesJson FROM profile WHERE id = 1")
      .get() as unknown as { attributesJson: string } | undefined;
    const attributes = parseJson<Record<string, unknown>>(row?.attributesJson, {});
    const value = attributes.HKCharacteristicTypeIdentifierDateOfBirth;
    return typeof value === "string" ? value.slice(0, 10) : null;
  }

  private loadZoneProfileSettings(): TrainingZoneProfileSettings[] {
    const rows = this.database.prepare(`
      SELECT * FROM training_zone_profile_settings ORDER BY revision
    `).all() as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      revision: Number(row.revision),
      effectiveFromLocalDate: String(row.effective_from_local_date),
      restingHeartRate: {
        mode: String(row.resting_mode) as "auto" | "manual",
        valueBpm: asNullableNumber(row.resting_value_bpm)
      },
      maximumHeartRate: {
        mode: String(row.maximum_mode) as "auto" | "manual",
        valueBpm: asNullableNumber(row.maximum_value_bpm)
      },
      lactateThresholdPace: {
        mode: String(row.threshold_pace_mode) as "auto" | "manual",
        valueSecondsPerKm: asNullableNumber(row.threshold_pace_seconds_per_km)
      },
      createdAt: String(row.created_at)
    }));
  }

  private buildAndPersistZoneProfiles(
    metricRunId: string,
    features: WorkoutFeatureVector[],
    sessions: Map<string, SessionRow>,
    request: RecomputeRequest
  ): Map<string, DailyZoneProfile> {
    const profiles = new Map<string, DailyZoneProfile>();
    if (features.length === 0) return profiles;
    const restingEvidence = this.loadRestingHeartRateEvidence(request.evaluatedAt);
    const maximumEvidence: MaximumHeartRateEvidence[] = [];
    for (const feature of features) {
      if ((feature.heartRateCoverage ?? 0) < 0.7 || feature.sourceConfidence < 0.6) continue;
      const session = sessions.get(feature.trainingSessionId);
      if (!session) continue;
      const intervals = weightedRecordIntervals(
        this.loadRecordSeries(session.sourceName, session.workoutStartAt, session.workoutEndAt, heartRateType),
        session.workoutStartAt,
        session.workoutEndAt,
        (value) => value
      );
      const peak = sustainedThirtySecondPeak(intervals, session.workoutStartAt, session.workoutEndAt);
      if (peak !== null) maximumEvidence.push({
        peakBpm: peak,
        observedAt: feature.workoutStartAt,
        coverage: feature.heartRateCoverage ?? 0,
        sourceConfidence: feature.sourceConfidence
      });
    }
    const directVo2 = loadDirectVo2Evidence(this.database, request.evaluatedAt);
    const labeledPerformance = loadLabeledPerformanceEvidence(this.database, request.evaluatedAt);
    const performanceEvidence = loadPerformanceVdotEvidence(this.database, request.evaluatedAt);
    const thresholdEvidence = loadLactateThresholdEvidence(this.database, request.evaluatedAt);
    const settings = this.loadZoneProfileSettings();
    const firstDate = features
      .map((feature) => localDateAt(feature.workoutStartAt, request.timezoneIdentifier))
      .sort()[0]!;
    const throughDate = localDateAt(request.evaluatedAt, request.timezoneIdentifier);
    const dateOfBirth = this.loadDateOfBirth();
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO daily_zone_profiles (
        id, training_metric_run_id, local_date, timezone_identifier, effective_at,
        data_through_at, resting_heart_rate_bpm, maximum_heart_rate_bpm,
        threshold_pace_seconds_per_km, heart_rate_source, pace_source,
        heart_rate_confidence, pace_confidence, profile_status,
        heart_rate_bands_json, pace_bands_json, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let previous: DailyZoneProfile | null = null;
    // O07 步骤 4：逐日分区行按分块短事务落地（让路点在提交之后）。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (let date = firstDate; date <= throughDate; date = addDays(date, 1)) {
      this.gate.yieldIfStale();
      const effectiveAt = localDateStartAt(date, request.timezoneIdentifier);
      const activeSettings = [...settings].reverse().find((item) => item.effectiveFromLocalDate <= date) ?? null;
      const temporary = buildDailyZoneProfile({
        id: deterministicId("daily_zone_profile", { metricRunId, date }),
        localDate: date,
        timezoneIdentifier: request.timezoneIdentifier,
        effectiveAt,
        createdAt: request.evaluatedAt,
        dateOfBirth,
        restingHeartRates: restingEvidence,
        maximumHeartRates: maximumEvidence,
        thresholdPace: null,
        previousProfile: previous,
        settings: activeSettings
      });
      // Race performance already feeds Performance VDOT; it is not a second
      // direct VO2 measurement in the threshold/profile path.
      const eligibleVo2 = directVo2.filter((item) => Date.parse(item.observedAt) < Date.parse(effectiveAt));
      const vo2 = estimateVo2Max(eligibleVo2, effectiveAt);
      const performance = estimatePerformanceVdot(
        vo2,
        performanceEvidence.filter((item) => item.observedAt < effectiveAt),
        effectiveAt
      );
      const threshold = estimateLactateThresholdFromPerformanceVdot(
        performance,
        {
          restingHeartRateBpm: temporary.restingHeartRateBpm,
          observedMaximumHeartRateBpm: temporary.maximumHeartRateBpm
        },
        thresholdEvidence.filter((item) => item.observedAt < effectiveAt),
        effectiveAt
      );
      const thresholdCandidate: ThresholdPaceCandidate | null = threshold.status === "available" && threshold.paceSecondsPerKm !== null
        ? {
            paceSecondsPerKm: threshold.paceSecondsPerKm,
            confidence: threshold.confidence,
            evidenceCount: threshold.evidenceCount,
            evidenceSource: threshold.method === "observed_threshold_v3" ? "observed" : "inferred",
            dataThroughAt: threshold.latestEvidenceAt
          }
        : null;
      const profile = buildDailyZoneProfile({
        id: temporary.id,
        localDate: date,
        timezoneIdentifier: request.timezoneIdentifier,
        effectiveAt,
        createdAt: request.evaluatedAt,
        dateOfBirth,
        restingHeartRates: restingEvidence,
        maximumHeartRates: maximumEvidence,
        thresholdPace: thresholdCandidate,
        previousProfile: previous,
        settings: activeSettings
      });
      writer.add(() => insert.run(
        profile.id, metricRunId, profile.localDate, profile.timezoneIdentifier,
        profile.effectiveAt, profile.dataThroughAt, profile.restingHeartRateBpm,
        profile.maximumHeartRateBpm, profile.lactateThresholdPaceSecondsPerKm,
        profile.heartRateSource, profile.paceSource, profile.heartRateConfidence,
        profile.paceConfidence, profile.status, JSON.stringify(profile.heartRateBands),
        JSON.stringify(profile.paceBands), JSON.stringify(profile.evidence), profile.createdAt
      ));
      profiles.set(date, profile);
      previous = profile;
    }
    writer.flush();
    return profiles;
  }

  private replayTrainingMetrics(
    jobId: string,
    metricRunId: string,
    features: WorkoutFeatureVector[],
    request: RecomputeRequest,
    overrideSnapshot: OverrideSnapshot
  ): void {
    const sessions = new Map(
      this.loadSessions(request.evaluatedAt).map((session) => [session.trainingSessionId, session])
    );
    const zoneProfiles = this.buildAndPersistZoneProfiles(metricRunId, features, sessions, request);
    const insert = this.database.prepare(`
      INSERT INTO workout_training_loads (
        id, training_metric_run_id, training_session_id, feature_id,
        local_date, timezone_identifier, distance_km, duration_seconds,
        training_load, intensity, load_source, confidence, heart_rate_coverage,
        average_heart_rate_bpm, elevation_gain_meters, rpe, session_type,
        explanation_codes_json, provenance_json, computed_at, zone_profile_id,
        stimulus_type, raw_hrr_trimp, internal_load, pace_load,
        distance_reference_meters, distance_exposure_ratio, distance_factor,
        heart_rate_load_confidence, pace_load_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertZoneSummary = this.database.prepare(`
      INSERT INTO workout_zone_summaries (
        id, training_metric_run_id, training_session_id, feature_id, zone_profile_id,
        stimulus_type, secondary_stimulus_types_json, stimulus_confidence,
        heart_rate_coverage, pace_coverage, heart_rate_exposure_json,
        pace_exposure_json, stimulus_scores_json, explanation_codes_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const loads: WorkoutTrainingLoad[] = [];
    const priorDistances: Array<{ observedAt: number; distanceMeters: number }> = [];
    // O07 步骤 4：训练负荷/分区摘要/域快照的逐训练写入按分块短事务落地。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const [index, feature] of features.entries()) {
      this.throwIfCancelled(jobId);
      this.gate.yieldIfStale();
      const session = sessions.get(feature.trainingSessionId);
      const override = overrideSnapshot.byTrainingSessionId.get(feature.trainingSessionId) ?? null;
      const implausibleStatistics = feature.missingReasons.includes("implausible_average_pace") &&
        override?.statisticsParticipation !== "include";
      const excluded = session?.trainingSessionStatus !== "active" ||
        override?.statisticsParticipation === "exclude" || implausibleStatistics;
      const localDate = localDateAt(feature.workoutStartAt, request.timezoneIdentifier);
      const zoneProfile = zoneProfiles.get(localDate);
      if (!zoneProfile) throw new Error(`Missing zone profile for ${localDate}`);
      const heartMetricSamples = session
        ? this.metricSamplesForSession(session, heartRateType, (value) => value)
        : [];
      const speedSamples = session
        ? this.metricSamplesForSession(session, runningSpeedType, (value, unit) => convertSpeedToMetersPerSecond(value, unit))
        : [];
      const distanceMeters = feature.distanceKm === null ? null : feature.distanceKm * 1000;
      const averagePaceSecondsPerKm = feature.distanceKm !== null && feature.distanceKm > 0
        ? feature.durationSeconds / feature.distanceKm
        : null;
      const elapsedSeconds = session
        ? (Date.parse(session.workoutEndAt) - Date.parse(session.workoutStartAt)) / 1000
        : Number.NaN;
      const elapsedDurationSeconds = Number.isFinite(elapsedSeconds)
        ? Math.max(feature.durationSeconds, elapsedSeconds)
        : feature.durationSeconds;
      const zoneSummary = analyzeWorkoutZones({
        trainingSessionId: feature.trainingSessionId,
        durationSeconds: feature.durationSeconds,
        elapsedDurationSeconds,
        distanceMeters,
        sourceConfidence: feature.sourceConfidence,
        profile: zoneProfile,
        heartRateSamples: heartMetricSamples,
        speedSamples,
        averageHeartRateBpm: feature.averageHeartRateBpm,
        averagePaceSecondsPerKm
      });
      const cutoff = Date.parse(feature.workoutStartAt) - 90 * 86_400_000;
      const distanceValues = priorDistances
        .filter((item) => item.observedAt >= cutoff)
        .map((item) => item.distanceMeters);
      const distanceReferenceMeters = distanceValues.length >= 5 ? percentile(distanceValues, 0.75) : null;
      const breakdown = calculateCompositeTrainingLoad({
        durationSeconds: feature.durationSeconds,
        elapsedDurationSeconds,
        distanceMeters,
        profile: zoneProfile,
        zoneSummary,
        heartRateSamples: heartMetricSamples,
        speedSamples,
        averageHeartRateBpm: feature.averageHeartRateBpm,
        averagePaceSecondsPerKm,
        distanceReferenceMeters,
        rpe: override?.rpe ?? null,
        sessionType: feature.sessionType,
        sourceConfidence: feature.sourceConfidence
      });
      const load = calculateWorkoutTrainingLoad({
        trainingSessionId: feature.trainingSessionId,
        localDate,
        durationSeconds: feature.durationSeconds,
        distanceMeters,
        heartRateSamples: heartMetricSamples.map((sample) => ({
          heartRate: sample.value,
          durationSeconds: sample.durationSeconds,
          ...(sample.startOffsetSeconds === undefined ? {} : { startOffsetSeconds: sample.startOffsetSeconds })
        })),
        ...(feature.heartRateCoverage === null ? {} : { heartRateCoverage: feature.heartRateCoverage }),
        averageHeartRate: feature.averageHeartRateBpm,
        restingHeartRate: zoneProfile.restingHeartRateBpm,
        observedMaxHeartRate: zoneProfile.maximumHeartRateBpm,
        rpe: override?.rpe ?? null,
        sessionType: feature.sessionType,
        elevationGainMeters: session ? this.loadElevationGain(session.canonicalWorkoutId) : null,
        sourceConfidence: feature.sourceConfidence,
        excluded,
        zoneSummary,
        loadBreakdown: breakdown
      });
      if (load) {
        const modelId = String(this.database.prepare("SELECT model_run_id FROM training_metric_runs WHERE id=?").get(metricRunId)?.model_run_id);
        writer.add(() => {
        new SqliteModelReleaseRepository(this.database).putSnapshot(modelId,"load_vector",feature.trainingSessionId,feature.workoutStartAt,
          buildLoadVectorV2({load,zoneSummary}));
        new SqliteModelReleaseRepository(this.database).putSnapshot(modelId,"zone_coherence",feature.trainingSessionId,feature.workoutStartAt,zoneSummary);
        insertZoneSummary.run(
          deterministicId("workout_zone_summary", { metricRunId, trainingSessionId: feature.trainingSessionId }),
          metricRunId, feature.trainingSessionId, feature.id, zoneProfile.id,
          zoneSummary.stimulusType, JSON.stringify(zoneSummary.secondaryStimulusTypes),
          zoneSummary.stimulusConfidence, zoneSummary.heartRateCoverage, zoneSummary.paceCoverage,
          JSON.stringify(zoneSummary.heartRateExposure), JSON.stringify(zoneSummary.paceExposure),
          JSON.stringify(zoneSummary.stimulusScores), JSON.stringify(zoneSummary.explanationCodes),
          request.evaluatedAt
        );
        insert.run(
          deterministicId("workout_training_load", {
            trainingMetricRunId: metricRunId,
            trainingSessionId: feature.trainingSessionId
          }),
          metricRunId,
          feature.trainingSessionId,
          feature.id,
          load.localDate,
          request.timezoneIdentifier,
          load.distanceMeters === null ? null : load.distanceMeters / 1000,
          load.durationSeconds,
          load.load,
          load.intensity,
          load.source,
          load.confidence,
          feature.heartRateCoverage,
          load.averageHeartRate,
          load.elevationGainMeters,
          load.rpe,
          load.sessionType,
          JSON.stringify(load.explanations.map((explanation) => explanation.code)),
          JSON.stringify({
            explanations: load.explanations,
            zoneExplanations: zoneSummary.explanationCodes,
            sourceConfidence: feature.sourceConfidence,
            loadComposition: {
              heartRateConfidence: load.breakdown.heartRateConfidence,
              paceConfidence: load.breakdown.paceConfidence,
              distanceFactor: load.breakdown.distanceFactor
            },
            statisticsParticipation: override?.statisticsParticipation ?? null
          }),
          request.evaluatedAt,
          zoneProfile.id,
          load.stimulusType,
          load.breakdown.rawHrrTrimp,
          load.breakdown.internalLoad,
          load.breakdown.paceLoad,
          load.breakdown.distanceReferenceMeters,
          load.breakdown.distanceExposureRatio,
          load.breakdown.distanceFactor,
          load.breakdown.heartRateConfidence,
          load.breakdown.paceConfidence
        );
        this.updateJobProgress(jobId, "training_metrics", index + 1, features.length, "Training load calculated");
        });
        loads.push(load);
      }
      if (!excluded && distanceMeters !== null && distanceMeters > 0) {
        priorDistances.push({ observedAt: Date.parse(feature.workoutStartAt), distanceMeters });
      }
    }
    writer.flush();
    const throughDate = localDateAt(request.evaluatedAt, request.timezoneIdentifier);
    const startDate = loads[0]?.localDate ?? throughDate;
    const physEvidence = this.loadDailyPhysEvidence(startDate, throughDate, request.timezoneIdentifier, request.evaluatedAt);
    const daily = buildDailyTrainingMetrics(loads, throughDate, physEvidence);
    this.persistDailyTrainingMetrics(metricRunId, daily, request, false);
  }

  private persistDailyTrainingMetrics(
    metricRunId: string,
    metrics: DailyTrainingMetric[],
    request: RecomputeRequest,
    ignoreExisting: boolean
  ): void {
    const insert = this.database.prepare(`
      INSERT ${ignoreExisting ? "OR IGNORE" : ""} INTO daily_training_metrics (
        id, training_metric_run_id, local_date, timezone_identifier,
        distance_km, duration_seconds, workout_count, daily_load,
        current_7d_load, previous_7d_load, acute_ewma, chronic_ewma,
        load_ratio, ramp_rate, monotony, strain, recovery_evidence,
        history_days, load_workout_count, training_status, confidence,
        explanation_codes_json, explanation_json, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let cumulativeWorkoutCount = 0;
    // O07 步骤 4：逐日训练指标按分块短事务落地。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const [index, metric] of metrics.entries()) {
      cumulativeWorkoutCount += metric.workoutCount;
      writer.add(() => insert.run(
        deterministicId("daily_training_metric", { metricRunId, localDate: metric.localDate }),
        metricRunId,
        metric.localDate,
        request.timezoneIdentifier,
        metric.distanceMeters / 1000,
        metric.durationSeconds,
        metric.workoutCount,
        metric.load,
        metric.current7dLoad,
        metric.previous7dLoad,
        metric.acuteEwma,
        metric.chronicEwma,
        metric.loadRatio,
        metric.rampRate,
        metric.monotony,
        metric.strain,
        metric.recoveryEvidence,
        index + 1,
        cumulativeWorkoutCount,
        metric.trainingStatus,
        metric.loadConfidence,
        JSON.stringify(metric.statusExplanations.map((explanation) => explanation.code)),
        JSON.stringify(metric.statusExplanations),
        request.evaluatedAt
      ));
    }
    writer.flush();
  }

  private loadPersistedTrainingLoads(metricRunId: string): WorkoutTrainingLoad[] {
    return loadPersistedTrainingLoads(this.database, metricRunId);
  }

  /**
   * Build one physiological state per local calendar day. All inputs are
   * canonical facts and every baseline is strictly as-of the day being scored.
   * The resulting state is used by training status; recovery_evidence remains
   * null and is retained only as a compatibility column.
   */
  private loadDailyPhysEvidence(startDate: string, throughDate: string, timezoneIdentifier: string, asOfAt: string): DailyPhysEvidence[] {
    return loadDailyPhysEvidence(this.database, startDate, throughDate, timezoneIdentifier, asOfAt);
  }

  private loadLegacyDailyPhysEvidence(startDate: string, throughDate: string, timezoneIdentifier: string, asOfAt: string): DailyPhysEvidence[] {
    if (throughDate < startDate) return [];
    const baselineStart = addDays(startDate, -60);
    const nightRows = this.database.prepare(`
      SELECT wake_date AS wakeDate, wake_at AS wakeAt, asleep_union_minutes AS sleepMinutes
      FROM canonical_nights
      WHERE kind = 'main' AND timezone_identifier = ?
        AND wake_date >= ? AND wake_date <= ? AND wake_at < ?
      ORDER BY wake_date
    `).all(timezoneIdentifier, baselineStart, throughDate, asOfAt) as unknown as Array<{ wakeDate: string; wakeAt: string | null; sleepMinutes: number | null }>;
    const hrvRows = this.database.prepare(`
      SELECT local_date AS localDate, window_end_at AS windowEndAt, hrv_sdnn_ms AS hrvMs
      FROM canonical_hrv_days
      WHERE timezone_identifier = ? AND local_date >= ? AND local_date <= ?
      ORDER BY local_date
    `).all(timezoneIdentifier, baselineStart, throughDate) as unknown as Array<{ localDate: string; windowEndAt: string | null; hrvMs: number | null }>;
    const rhrRows = this.database.prepare(`
      SELECT start_at AS startAt, source_category AS sourceCategory, value_numeric AS value
      FROM health_records
      WHERE type = 'HKQuantityTypeIdentifierRestingHeartRate'
        AND source_category IN ('apple_watch', 'connect')
        AND start_at >= ? AND start_at < ? AND value_numeric IS NOT NULL
      ORDER BY start_at
    `).all(
      localDateStartAt(baselineStart, timezoneIdentifier),
      localDateStartAt(addDays(throughDate, 1), timezoneIdentifier)
    ) as unknown as Array<{ startAt: string; sourceCategory: string; value: number }>;

    const finiteValues = (values: Array<number | null | undefined>): number[] => values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const medianValue = (values: number[]): number | null => {
      if (!values.length) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    };
    const baseline = (values: Map<string, number>, localDate: string): number | null => {
      const read = (days: number): number[] => {
        const from = addDays(localDate, -days);
        return [...values.entries()].filter(([date]) => date >= from && date < localDate).map(([, value]) => value);
      };
      const recent = read(28);
      if (recent.length >= 7) return medianValue(recent);
      const extended = read(60);
      return extended.length >= 7 ? medianValue(extended) : null;
    };
    const sleepByDate = new Map(nightRows.flatMap((row) => row.sleepMinutes == null || !Number.isFinite(Number(row.sleepMinutes)) ? [] : [[row.wakeDate, Number(row.sleepMinutes)]]));
    const asOfMs = Date.parse(asOfAt);
    const hrvByDate = new Map(hrvRows.flatMap((row) => row.hrvMs == null || !Number.isFinite(Number(row.hrvMs)) || (row.windowEndAt && Date.parse(row.windowEndAt) >= Date.parse(localDateStartAt(addDays(row.localDate, 1), timezoneIdentifier))) || (row.localDate === throughDate && row.windowEndAt && Date.parse(row.windowEndAt) >= asOfMs) ? [] : [[row.localDate, Number(row.hrvMs)]]));
    const rhrByDate = new Map<string, number>();
    for (let date = baselineStart; date <= throughDate; date = addDays(date, 1)) {
      const fullDayEnd = Date.parse(localDateStartAt(addDays(date, 1), timezoneIdentifier));
      const dayEnd = date === throughDate ? Math.min(fullDayEnd, Date.parse(asOfAt)) : fullDayEnd;
      const from = dayEnd - 36 * 60 * 60 * 1000;
      const selected = rhrRows.filter((row) => {
        const at = Date.parse(row.startAt);
        return Number.isFinite(at) && at >= from && at < dayEnd && Number.isFinite(Number(row.value));
      });
      const watch = selected.filter((row) => row.sourceCategory === "apple_watch");
      const values = finiteValues((watch.length ? watch : selected).map((row) => Number(row.value)));
      const value = medianValue(values);
      if (value !== null) rhrByDate.set(date, value);
    }
    const result: DailyPhysEvidence[] = [];
    for (let date = startDate; date <= throughDate; date = addDays(date, 1)) {
      const sleepBaseline = baseline(sleepByDate, date);
      const hrvBaseline = baseline(hrvByDate, date);
      const rhrBaseline = baseline(rhrByDate, date);
      const sleepMinutes = sleepByDate.get(date) ?? null;
      const hrvMs = hrvByDate.get(date) ?? null;
      const rhrBpm = rhrByDate.get(date) ?? null;
      const nightsBelowSleepBaseline = sleepBaseline === null ? 0 : [date, addDays(date, -1), addDays(date, -2)]
        .map((day) => sleepByDate.get(day))
        .filter((minutes): minutes is number => minutes !== undefined && minutes < sleepBaseline * 0.8).length;
      result.push({
        localDate: date,
        physState: classifyPhysState({
          sleepMinutes,
          sleepBaselineMinutes: sleepBaseline,
          hrvSdnnMs: hrvMs,
          hrvBaselineMs: hrvBaseline,
          rhrBpm,
          rhrBaselineBpm: rhrBaseline,
          nightsBelowSleepBaseline
        })
      });
    }
    return result;
  }

  private resumeModelReplay(
    modelRun: ModelRun,
    request: RecomputeRequest,
    features: WorkoutFeatureVector[],
    baseline: PersonalBaseline
  ): ReplayResume | null {
    // O04（WP-20）：与特征前缀**同一份边界解析**（domains 优先、老 payload 回落）。
    const replayPlan = request.incrementalPlan;
    const dirtyFromAt = replayPlan?.domains ? replayPlan.domains.features : replayPlan?.dirtyFromAt;
    if (!dirtyFromAt || dirtyFromAt <= baseline.calibrationEndAt) return null;
    // A complete feature-prefix copy is a prerequisite for assessment reuse.
    // Newly eligible historical workouts or a timezone change invalidate it.
    const currentFeatureRun = this.database.prepare("SELECT parent_feature_run_id AS parent FROM feature_runs WHERE id=?")
      .get(modelRun.featureRunId) as { parent: string | null } | undefined;
    if (!currentFeatureRun?.parent) return null;
    const expectedModelHash = configHash({ version: MODEL_CONFIG_VERSION, engineVersion: SCORING_MODEL_VERSION, config: request.modelConfig });
    const expectedFeatureHash = configHash(request.featureConfig);
    const row = this.database.prepare(`
      SELECT checkpoint.model_run_id AS parentModelRunId,
             checkpoint.sequence_number AS sequenceNumber,
             checkpoint.state_json AS stateJson, checkpoint.state_hash AS stateHash
      FROM active_model_run active
      JOIN model_runs parent ON parent.id = active.model_run_id AND parent.status = 'succeeded'
      JOIN feature_runs feature ON feature.id = parent.feature_run_id AND feature.status = 'succeeded'
      JOIN model_checkpoints checkpoint ON checkpoint.model_run_id = parent.id
      WHERE active.singleton = 1 AND checkpoint.through_at < ?
        AND checkpoint.checkpoint_version = ? AND checkpoint.model_version = ?
        AND checkpoint.model_config_hash = ? AND checkpoint.feature_schema_version = ?
        AND checkpoint.feature_config_hash = ? AND checkpoint.timezone_identifier = ?
      ORDER BY checkpoint.through_at DESC, checkpoint.sequence_number DESC LIMIT 1
    `).get(
      dirtyFromAt,
      MODEL_CHECKPOINT_VERSION,
      MODEL_CONFIG_VERSION,
      expectedModelHash,
      FEATURE_SCHEMA_VERSION,
      expectedFeatureHash,
      request.timezoneIdentifier
    ) as unknown as { parentModelRunId: string; sequenceNumber: number; stateJson: string; stateHash: string } | undefined;
    if (!row || row.sequenceNumber >= features.length || configHash(parseJson(row.stateJson, {})) !== row.stateHash) {
      return null;
    }
    const prefix = this.database.prepare(`SELECT training_session_id AS sessionId FROM ability_assessments
      WHERE model_run_id=? AND sequence_number<=? ORDER BY sequence_number`)
      .all(row.parentModelRunId, row.sequenceNumber) as { sessionId: string }[];
    if (prefix.length !== row.sequenceNumber + 1 ||
        prefix.some((item, index) => features[index]?.trainingSessionId !== item.sessionId)) return null;
    const state = parseJson<ModelCheckpointState | null>(row.stateJson, null);
    if (!state?.baseline || !Number.isFinite(state.trueAbility) || !Number.isFinite(state.eligibleWorkoutCount)) {
      return null;
    }
    // The confirmation buffer has to be reconstructible, not defaulted: resuming
    // with an empty buffer would let a replayed prefix confirm a decline the live
    // run had not, and vice versa.
    if (!Array.isArray(state.pendingNegativeIds) ||
        state.pendingNegativeIds.some((id) => typeof id !== "string")) {
      return null;
    }
    this.database.prepare(`
      INSERT INTO ability_assessments (
        id, model_run_id, feature_id, training_session_id, sequence_number,
        assessment_status, current_ability, efficiency_score, pace_score, cardio_score,
        stability_score, recovery_score, effective_weights_json, confidence,
        confidence_factors_json, workout_contribution, evidence_strength, direction_factor,
        growth_resistance, true_ability_before, true_ability_after, true_ability_delta,
        updated_true_ability, explanation_codes_json, explanation_json, assessed_at
      )
      SELECT ? || ':' || old.training_session_id, ?, fresh.id, old.training_session_id,
        old.sequence_number, old.assessment_status, old.current_ability, old.efficiency_score,
        old.pace_score, old.cardio_score, old.stability_score, old.recovery_score,
        old.effective_weights_json, old.confidence, old.confidence_factors_json,
        old.workout_contribution, old.evidence_strength, old.direction_factor,
        old.growth_resistance, old.true_ability_before, old.true_ability_after,
        old.true_ability_delta, old.updated_true_ability, old.explanation_codes_json,
        old.explanation_json, old.assessed_at
      FROM ability_assessments old
      JOIN workout_features fresh ON fresh.feature_run_id = ?
        AND fresh.training_session_id = old.training_session_id
      WHERE old.model_run_id = ? AND old.sequence_number <= ?
      ORDER BY old.sequence_number
    `).run(`assessment:${modelRun.id}`, modelRun.id, modelRun.featureRunId, row.parentModelRunId, row.sequenceNumber);
    this.database.prepare(`
      UPDATE model_runs SET parent_model_run_id = ?, reused_assessment_count = ? WHERE id = ?
    `).run(row.parentModelRunId, row.sequenceNumber + 1, modelRun.id);
    this.database.prepare(`
      INSERT INTO model_checkpoints (
        id, model_run_id, sequence_number, through_at, checkpoint_version,
        model_version, model_config_hash, feature_schema_version, feature_config_hash,
        timezone_identifier, state_json, state_hash
      )
      SELECT ?, ?, sequence_number, through_at, checkpoint_version, model_version,
        model_config_hash, feature_schema_version, feature_config_hash,
        timezone_identifier, state_json, state_hash
      FROM model_checkpoints WHERE model_run_id = ? AND sequence_number = ?
    `).run(
      deterministicId("model_checkpoint", { modelRunId: modelRun.id, sequenceNumber: row.sequenceNumber }),
      modelRun.id, row.parentModelRunId, row.sequenceNumber
    );
    return { parentModelRunId: row.parentModelRunId, throughSequence: row.sequenceNumber, state };
  }

  private writeModelCheckpoint(
    modelRun: ModelRun,
    sequenceNumber: number,
    throughAt: string,
    request: RecomputeRequest,
    state: ModelCheckpointState
  ): void {
    const stateJson = JSON.stringify(state);
    this.database.prepare(`
      INSERT OR REPLACE INTO model_checkpoints (
        id, model_run_id, sequence_number, through_at, checkpoint_version,
        model_version, model_config_hash, feature_schema_version, feature_config_hash,
        timezone_identifier, state_json, state_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deterministicId("model_checkpoint", { modelRunId: modelRun.id, sequenceNumber }),
      modelRun.id, sequenceNumber, throughAt, MODEL_CHECKPOINT_VERSION,
      MODEL_CONFIG_VERSION, modelRun.modelConfigHash, FEATURE_SCHEMA_VERSION,
      configHash(request.featureConfig), request.timezoneIdentifier, stateJson, configHash(state)
    );
  }

  private replayModel(
    jobId: string,
    modelRun: ModelRun,
    features: WorkoutFeatureVector[],
    request: RecomputeRequest
  ): void {
    const sorted = sortWorkoutFeaturesChronologically(features);
    const calibrationFeatures: WorkoutFeatureVector[] = [];
    for (const feature of sorted) {
      if (feature.eligibilityStatus !== "eligible") continue;
      if (request.modelConfig.baselineReferenceStartAt && Date.parse(feature.workoutStartAt)<Date.parse(request.modelConfig.baselineReferenceStartAt)) continue;
      calibrationFeatures.push(feature);
      if (hasCompletedCalibration(calibrationFeatures, request.modelConfig)) break;
    }
    let baseline = hasCompletedCalibration(calibrationFeatures, request.modelConfig)
      ? createPersonalBaseline(calibrationFeatures)
      : null;
    const calibrationIds = new Set(baseline?.calibrationFeatureIds ?? []);
    const calibrationCompletionIndex = baseline
      ? Math.max(
          ...sorted
            .map((feature, index) => (calibrationIds.has(feature.id) ? index : -1))
            .filter((index) => index >= 0)
        )
      : Number.POSITIVE_INFINITY;
    const insert = this.database.prepare(`
      INSERT INTO ability_assessments (
        id, model_run_id, feature_id, training_session_id, sequence_number,
        assessment_status, current_ability, efficiency_score, pace_score,
        cardio_score, stability_score, recovery_score, effective_weights_json,
        confidence, confidence_factors_json, workout_contribution,
        evidence_strength, direction_factor, growth_resistance,
        true_ability_before, true_ability_after, true_ability_delta,
        updated_true_ability, explanation_codes_json, explanation_json, assessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const resume = baseline ? this.resumeModelReplay(modelRun, request, sorted, baseline) : null;
    if (resume) baseline = resume.state.baseline;
    const timeline: TimelineAssessment[] = resume
      ? this.loadTimelineAssessments(modelRun.id)
      : [];
    let trueAbility = resume?.state.trueAbility ?? 50;
    let lastEligibleLocalDate: string | null = resume?.state.lastEligibleLocalDate ?? null;
    let lastEligibleTrueAbility = resume?.state.lastEligibleTrueAbility ?? 50;
    let eligibleWorkoutCount = resume?.state.eligibleWorkoutCount ?? 0;
    // §6.9 confirmation buffer. Carried in the checkpoint on purpose: a resumed
    // replay must not silently re-count or lose an unconfirmed decline.
    let pendingNegativeIds: string[] = [...(resume?.state.pendingNegativeIds ?? [])];
    let lastCheckpointMonth: string | null = resume
      ? localDateAt(sorted[resume.throughSequence]?.workoutStartAt ?? "", request.timezoneIdentifier).slice(0, 7)
      : null;

    // Same bounded evidence window in full replay, checkpoint resume and offline reports.
    const adaptiveBaselines = buildAdaptiveBaselineTimeline(sorted, {
      ...defaultAdaptiveBaselinePolicy,
      minimumIndependentSessions: request.modelConfig.comparabilityPolicy.minimumIndependentSessions,
      minimumSpanDays: request.modelConfig.comparabilityPolicy.minimumSpanDays
    });
    const stratumHistoryByIndex = request.modelConfig.comparabilityHistoryMode === "bounded"
      ? adaptiveBaselines.map((value) => value.history)
      : buildLegacyStratumHistory(sorted);
    const baselineEpochId = this.fitnessEpochId(baseline, features, request, modelRun);

    // O07 步骤 4：能力评估的逐训练写入按分块短事务落地（checkpoint 另算，频率低）。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (const [index, feature] of sorted.entries()) {
      if (resume && index <= resume.throughSequence) continue;
      this.throwIfCancelled(jobId);
      this.gate.yieldIfStale();
      const assessmentId = deterministicId("ability_assessment", {
        modelRunId: modelRun.id,
        trainingSessionId: feature.trainingSessionId
      });
      const featureDate = localDateAt(feature.workoutStartAt, request.timezoneIdentifier);
      let assessment: AbilityAssessment;

      if (feature.eligibilityStatus === "excluded") {
        assessment = this.createCalibrationAssessment(
          assessmentId,
          modelRun.id,
          feature,
          index,
          "excluded",
          ["data_insufficient"]
        );
      } else if (!baseline || index <= calibrationCompletionIndex) {
        assessment = this.createCalibrationAssessment(
          assessmentId,
          modelRun.id,
          feature,
          index,
          "calibrating",
          ["calibrating"]
        );
      } else {
        if (lastEligibleLocalDate !== null) {
          trueAbility = trueAbilityAfterInactivity(
            lastEligibleTrueAbility,
            daysBetween(lastEligibleLocalDate, featureDate)
          );
        }
        const calibrationMaturity = clamp((eligibleWorkoutCount + 1) / 12, 0.25, 1);
        const score = scoreFeature(
          feature,
          baseline,
          calibrationMaturity,
          stratumHistoryByIndex[index] ?? null,
          request.modelConfig
        );
        const update = updateTrueAbilityFromFeatureScore(
          trueAbility,
          eligibleWorkoutCount,
          score,
          request.modelConfig,
          pendingNegativeIds.length
        );
        // Keep the ids in step with the count the scoring layer reported: it either
        // advanced by one (this feature), or reset to zero (applied, or contradicted
        // by a positive). A non-qualifying workout leaves it untouched.
        if (update.pendingNegativeConfirmations === pendingNegativeIds.length + 1) {
          pendingNegativeIds = [...pendingNegativeIds, feature.id];
        } else if (update.pendingNegativeConfirmations === 0) {
          pendingNegativeIds = [];
        }
        const explanationCodes = [...score.explanationCodes];
        // `fatigue_protected_negative_update` is deliberately no longer emitted:
        // the direction factor is no longer conditioned on the recovery score, so
        // nothing here can be "protected by fatigue" any more. The value and its
        // UI label are kept in contracts/web because historical assessments still
        // contain it and must keep rendering.
        const nextTrueAbility = update.nextTrueAbility;
        assessment = {
          id: assessmentId,
          modelRunId: modelRun.id,
          featureId: feature.id,
          trainingSessionId: feature.trainingSessionId,
          sequenceNumber: index,
          assessmentStatus: score.status,
          currentAbility: score.currentAbility,
          dimensions: score.dimensions,
          effectiveWeights: score.effectiveWeights,
          confidence: score.confidence,
          confidenceFactors: score.confidenceFactors,
          workoutContribution: score.workoutContribution,
          evidenceStrength: score.evidenceStrength,
          directionFactor: update.directionFactor,
          growthResistance: update.growthResistance,
          trueAbilityBefore: trueAbility,
          trueAbilityAfter: nextTrueAbility,
          trueAbilityDelta: nextTrueAbility - trueAbility,
          updatedTrueAbility: update.updated,
          explanationCodes: [...new Set(explanationCodes)],
          explanation: {
            featureEligibility: feature.eligibilityStatus,
            missingReasons: feature.missingReasons,
            baselineCalibrationEndAt: baseline.calibrationEndAt,
            baselineEpochId,
            baselinePolicyVersion: BASELINE_POLICY_VERSION,
            comparabilityHistoryMode: request.modelConfig.comparabilityHistoryMode,
            adaptiveBaseline: adaptiveBaselines[index] ?? null,
            confidenceV2: score.confidenceV2,
            stratumComparability: score.stratumComparability,
            learningObservation: score.learningObservation
          },
          assessedAt: feature.workoutStartAt
        };
        trueAbility = nextTrueAbility;
        if (score.status === "eligible") {
          lastEligibleLocalDate = featureDate;
          lastEligibleTrueAbility = trueAbility;
          eligibleWorkoutCount += 1;
        }
      }

      writer.add(() => this.insertAssessment(insert, assessment));
      timeline.push({
        id: assessment.id,
        workoutStartAt: feature.workoutStartAt,
        assessmentStatus: assessment.assessmentStatus,
        trueAbilityAfter: assessment.trueAbilityAfter
      });
      if (baseline) {
        const month = featureDate.slice(0, 7);
        const shouldCheckpoint = index === calibrationCompletionIndex || (index + 1) % 25 === 0 ||
          (lastCheckpointMonth !== null && month !== lastCheckpointMonth) || index === sorted.length - 1;
        if (shouldCheckpoint) {
          this.writeModelCheckpoint(modelRun, index, feature.workoutStartAt, request, {
            baseline,
            trueAbility,
            lastEligibleLocalDate,
            lastEligibleTrueAbility,
            eligibleWorkoutCount,
            pendingNegativeIds
          });
        }
        lastCheckpointMonth = month;
      }
      this.updateJobProgress(jobId, "model_replay", index + 1, sorted.length, "Assessment replayed");
    }
    writer.flush();

    this.writeDailySnapshots(
      modelRun.id,
      timeline,
      request.evaluatedAt,
      request.timezoneIdentifier,
      false
    );
    this.database
      .prepare("UPDATE model_runs SET summary_json = ? WHERE id = ?")
      .run(
        JSON.stringify({
          featureCount: features.length,
          calibrationFeatureCount: baseline?.calibrationFeatureIds.length ?? 0,
          baseline: baseline ?? null
          ,reusedAssessmentCount: resume ? resume.throughSequence + 1 : 0
        }),
        modelRun.id
      );
  }

  private fitnessEpochId(baseline:PersonalBaseline|null, features:WorkoutFeatureVector[], request:RecomputeRequest, model:ModelRun):string|null {
    if (!baseline) return null;
    return semanticHash({policy:BASELINE_POLICY_VERSION,
      calibrationSessions:sortWorkoutFeaturesChronologically(features).filter((f)=>baseline.calibrationFeatureIds.includes(f.id))
        .map((f)=>({trainingSessionId:f.trainingSessionId,workoutStartAt:f.workoutStartAt})),
      // Learning-rate/confidence/history changes do not change score coordinates.
      // Including their config hash here would incorrectly waive regression gates.
      scaleConfig:{weights:request.modelConfig.dimensionWeights,zScale:request.modelConfig.dimensionScoreZScale},
      featureConfigVersion:FEATURE_CONFIG_VERSION,timezone:request.timezoneIdentifier,
      dimensions:{efficiency:baseline.dimensions.efficiency??null,pace:baseline.dimensions.pace??null,stability:baseline.dimensions.stability??null}});
  }

  private sealDomainSnapshots(model: ModelRun, metricRunId: string, features: WorkoutFeatureVector[], request: RecomputeRequest, lineage: ModelLineageV2): void {
    const releases = new SqliteModelReleaseRepository(this.database);
    const asOf=request.evaluatedAt;
    const put=(domain:string,payload:unknown)=>releases.putSnapshot(model.id,domain,"summary",asOf,payload);
    const assessments=this.database.prepare("SELECT * FROM ability_assessments WHERE model_run_id=? ORDER BY sequence_number").all(model.id);
    put("fitness",{lineage,assessments,daily:this.database.prepare("SELECT local_date,true_ability,snapshot_status FROM daily_ability_snapshots WHERE model_run_id=? ORDER BY local_date").all(model.id)});
    put("readiness",readinessForRun(this.database,lineage));
    put("load",{lineage:{...lineage,modelVersion:"rai-training-load-v2.0.0",configVersion:TRAINING_LOAD_CONFIG_VERSION,configHash:semanticHash({config:defaultDailyMetricConfig,version:TRAINING_LOAD_CONFIG_VERSION}),baselineEpochId:null,calibrationCohortHash:null},days:this.database.prepare("SELECT * FROM daily_training_metrics WHERE training_metric_run_id=? ORDER BY local_date").all(metricRunId)});
    put("zones",{lineage:{...lineage,modelVersion:"rai-training-zones-v2.0.0",configVersion:TRAINING_ZONE_CONFIG_VERSION,configHash:semanticHash({version:TRAINING_ZONE_CONFIG_VERSION,physiology:"rai-physiology-v1.8.0"}),baselineEpochId:null,calibrationCohortHash:null},profiles:this.database.prepare("SELECT * FROM daily_zone_profiles WHERE training_metric_run_id=? ORDER BY local_date").all(metricRunId)});
    const cutoff=Date.parse(asOf)-56*86400000;
    const preparation=assessPreparation(features.filter((f)=>f.eligibilityStatus!=="excluded" && (f.distanceKm??0)>0 && Date.parse(f.workoutStartAt)>=cutoff)
      .map((f)=>({observedAt:f.workoutStartAt,distanceKm:f.distanceKm!,durationSeconds:f.durationSeconds})),asOf);
    const lateRuns=features.flatMap((feature)=>{
      const payload=feature.provenance.featurePayloadV4 as WorkoutFeaturePayloadV4|undefined;
      if(!payload||feature.eligibilityStatus!=="eligible"||Date.parse(feature.workoutStartAt)<cutoff||
        !["easy","steady","long_run"].includes(feature.sessionType)||feature.durationSeconds<75*60||
        payload.execution.aerobicDecouplingPct===null)return [];
      return [{trainingSessionId:feature.trainingSessionId,asOf:feature.workoutStartAt,
        rawDecouplingPct:payload.execution.aerobicDecouplingPct,pairedCoverage:payload.execution.pairedCoverage,
        normalizationStatus:payload.normalization.status}];
    });
    const comparableCount=lateRuns.filter((row)=>row.normalizationStatus==="not_needed"||row.normalizationStatus==="applied").length;
    const durability=assessDurability({lateRunStability:null,matchedPerformanceEvidence:null,lateRunEvidenceCount:comparableCount,evidenceTargetCount:2});
    const domainLineage={...lineage,modelVersion:DURABILITY_MODEL_VERSION,configVersion:"rai-preparation-config-v1",
      configHash:semanticHash({targets:PREPARATION_TARGETS,windowDays:PREPARATION_WINDOW_DAYS,penalty:"disabled_until_calibrated"}),baselineEpochId:null,calibrationCohortHash:null};
    put("durability",["five_k","ten_k","half_marathon"].map((distance)=>({
      ...buildDurabilitySnapshot({distance:distance as "five_k"|"ten_k"|"half_marathon",preparation,durability,lineage:domainLineage}),
      rawLateRunEvidence:lateRuns,validationStatus:"not_empirically_calibrated"
    })));

  }

  private createCalibrationAssessment(
    id: string,
    modelRunId: string,
    feature: WorkoutFeatureVector,
    sequenceNumber: number,
    status: "excluded" | "calibrating",
    explanationCodes: AbilityAssessment["explanationCodes"]
  ): AbilityAssessment {
    return {
      id,
      modelRunId,
      featureId: feature.id,
      trainingSessionId: feature.trainingSessionId,
      sequenceNumber,
      assessmentStatus: status,
      currentAbility: null,
      dimensions: { efficiency: null, pace: null, cardio: null, stability: null, recovery: null },
      effectiveWeights: {},
      confidence: feature.qualityScore,
      confidenceFactors: {
        coverage: feature.qualityScore,
        source: feature.sourceConfidence,
        comparability: 0,
        maturity: 0
      },
      workoutContribution: null,
      evidenceStrength: null,
      directionFactor: null,
      growthResistance: null,
      trueAbilityBefore: null,
      trueAbilityAfter: null,
      trueAbilityDelta: null,
      updatedTrueAbility: false,
      explanationCodes,
      explanation: { featureEligibility: feature.eligibilityStatus, missingReasons: feature.missingReasons },
      assessedAt: feature.workoutStartAt
    };
  }

  private insertAssessment(
    insert: ReturnType<DatabaseSync["prepare"]>,
    assessment: AbilityAssessment
  ): void {
    insert.run(
      assessment.id,
      assessment.modelRunId,
      assessment.featureId,
      assessment.trainingSessionId,
      assessment.sequenceNumber,
      assessment.assessmentStatus,
      assessment.currentAbility,
      assessment.dimensions.efficiency,
      assessment.dimensions.pace,
      assessment.dimensions.cardio,
      assessment.dimensions.stability,
      assessment.dimensions.recovery,
      JSON.stringify(assessment.effectiveWeights),
      assessment.confidence,
      JSON.stringify(assessment.confidenceFactors),
      assessment.workoutContribution,
      assessment.evidenceStrength,
      assessment.directionFactor,
      assessment.growthResistance,
      assessment.trueAbilityBefore,
      assessment.trueAbilityAfter,
      assessment.trueAbilityDelta,
      assessment.updatedTrueAbility ? 1 : 0,
      JSON.stringify(assessment.explanationCodes),
      JSON.stringify(assessment.explanation),
      assessment.assessedAt
    );
  }

  private loadTimelineAssessments(modelRunId: string): TimelineAssessment[] {
    return this.database
      .prepare(`
        SELECT
          assessment.id,
          feature.workout_start_at AS workoutStartAt,
          assessment.assessment_status AS assessmentStatus,
          assessment.true_ability_after AS trueAbilityAfter
        FROM ability_assessments assessment
        JOIN workout_features feature ON feature.id = assessment.feature_id
        WHERE assessment.model_run_id = ?
        ORDER BY assessment.sequence_number
      `)
      .all(modelRunId) as unknown as TimelineAssessment[];
  }

  private writeDailySnapshots(
    modelRunId: string,
    timeline: TimelineAssessment[],
    evaluatedAt: string,
    timezoneIdentifier: string,
    ignoreExisting: boolean
  ): void {
    const first = timeline[0];
    if (!first) return;
    const startDate = localDateAt(first.workoutStartAt, timezoneIdentifier);
    const endDate = localDateAt(evaluatedAt, timezoneIdentifier);
    const byDate = new Map<string, TimelineAssessment[]>();
    for (const assessment of timeline) {
      const date = localDateAt(assessment.workoutStartAt, timezoneIdentifier);
      const current = byDate.get(date) ?? [];
      current.push(assessment);
      byDate.set(date, current);
    }
    const insert = this.database.prepare(`
      INSERT ${ignoreExisting ? "OR IGNORE" : ""} INTO daily_ability_snapshots (
        id, model_run_id, local_date, timezone_identifier, true_ability,
        decay_points, growth_velocity_per_week, last_assessment_id,
        snapshot_status, computed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const snapshots: DailyAbilitySnapshot[] = [];
    let currentAbility: number | null = null;
    let lastEligibleDate: string | null = null;
    let lastEligibleAbility: number | null = null;
    let lastAssessmentId: string | null = null;

    // O07 步骤 4：逐日快照按分块短事务落地（`snapshots` 仍在循环内即时累积，`lastEligible*`
    // 的推进依赖它，所以只有写本身进批）。
    const writer = new ChunkedWriter(this.database, this.gate);
    for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
      this.gate.yieldIfStale();
      for (const assessment of byDate.get(date) ?? []) {
        lastAssessmentId = assessment.id;
        if (assessment.trueAbilityAfter !== null) currentAbility = assessment.trueAbilityAfter;
        if (assessment.assessmentStatus === "eligible" && assessment.trueAbilityAfter !== null) {
          lastEligibleDate = date;
          lastEligibleAbility = assessment.trueAbilityAfter;
        }
      }
      let decayPoints = 0;
      if (currentAbility !== null && lastEligibleDate !== null && lastEligibleAbility !== null) {
        const days = daysBetween(lastEligibleDate, date);
        const decayed = trueAbilityAfterInactivity(lastEligibleAbility, days);
        decayPoints = inactivityDecay(days);
        currentAbility = decayed;
      }
      const priorValues = snapshots
        .slice(-27)
        .map((snapshot) => snapshot.trueAbility)
        .filter((value): value is number => value !== null);
      const growthVelocity = this.theilSenVelocity([...priorValues, ...(currentAbility === null ? [] : [currentAbility])]);
      const snapshot: DailyAbilitySnapshot = {
        id: deterministicId("daily_snapshot", { modelRunId, date }),
        modelRunId,
        localDate: date,
        timezoneIdentifier,
        trueAbility: currentAbility,
        decayPoints,
        growthVelocityPerWeek: growthVelocity,
        lastAssessmentId,
        snapshotStatus:
          currentAbility === null ? "calibrating" : decayPoints > 0 ? "decay" : "active",
        computedAt: evaluatedAt
      };
      writer.add(() => insert.run(
        snapshot.id,
        snapshot.modelRunId,
        snapshot.localDate,
        snapshot.timezoneIdentifier,
        snapshot.trueAbility,
        snapshot.decayPoints,
        snapshot.growthVelocityPerWeek,
        snapshot.lastAssessmentId,
        snapshot.snapshotStatus,
        snapshot.computedAt
      ));
      snapshots.push(snapshot);
    }
    writer.flush();
  }

  private theilSenVelocity(values: number[]): number | null {
    if (values.length < 3) return null;
    const slopes: number[] = [];
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        const leftValue = values[left];
        const rightValue = values[right];
        if (leftValue !== undefined && rightValue !== undefined) {
          slopes.push((rightValue - leftValue) / (right - left));
        }
      }
    }
    const slope = median(slopes);
    return slope === null ? null : slope * 7;
  }

  private activateModelRunAndCompleteJob(jobId: string, modelRunId: string, featureCount: number): void {
    const completed = this.jobs.complete(
      jobId,
      "completed",
      featureCount,
      featureCount,
      "Model run activated",
      () => {
        // 🔴 绑定必须**先于** `activateSucceeded` 落库：发布短事务里的 `verifyAndPoint`
        // 要读它来做依赖级判据（决策 D4）。两者在同一个事务里，所以候选一旦激活，
        // "它算的是哪一版输入"就已经是持久事实 —— 不会出现"指针动了、绑定没写"。
        this.writeAnalysisInputBinding(modelRunId);
        this.modelRuns.activateSucceeded(modelRunId, appNow());
        // CA/feature rebuild changes residual baselines; drop active CatBoost until retrain.
        this.modelRuns.clearActivePredictionModel();
      }
    );
    if (!completed) throw new Error("Task cancellation requested");
    // Runs after the activation commits. Retiring superseded runs is
    // housekeeping, so it must never be able to roll back or fail a recompute
    // that already succeeded.
    this.pruneSupersededRuns();
  }

  /**
   * 写下"这条发布算了哪一版输入"（O06-A / WP-22）。
   *
   * 非直连任务（CLI `full_recompute`）没有捕获过绑定 ⇒ 不写行，行为与以前逐字节相同；
   * 老 release 因此没有绑定行，`verifyAndPoint` 会走**显式**的 legacy 严格分支。
   *
   * ⛔ 调用点必须在发布事务里（`complete()` 的 `beforeComplete`）——它记录的是
   * "与指针翻转同一时刻的输入"，写到事务外就等于两件事各说各话。
   */
  private writeAnalysisInputBinding(modelRunId: string): void {
    const capture = this.pendingInputCapture;
    if (capture === null) return;
    const binding = capture.binding;
    this.database.prepare(`
      INSERT INTO analysis_run_input_bindings (
        run_id, job_id, scope, dataset_version, captured_raw_generation,
        captured_dependency_generation, target_raw_generation, target_dependency_generation,
        incumbent_release_id, timezone_identifier, override_digest, config_digest,
        cutoff_at, input_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        job_id = excluded.job_id, scope = excluded.scope, dataset_version = excluded.dataset_version,
        captured_raw_generation = excluded.captured_raw_generation,
        captured_dependency_generation = excluded.captured_dependency_generation,
        target_raw_generation = excluded.target_raw_generation,
        target_dependency_generation = excluded.target_dependency_generation,
        incumbent_release_id = excluded.incumbent_release_id,
        timezone_identifier = excluded.timezone_identifier,
        override_digest = excluded.override_digest, config_digest = excluded.config_digest,
        cutoff_at = excluded.cutoff_at, input_digest = excluded.input_digest
    `).run(
      modelRunId, binding.jobId, binding.scope, binding.datasetVersion,
      binding.capturedRawGeneration, binding.capturedDependencyGeneration,
      binding.targetRawGeneration, binding.targetDependencyGeneration,
      binding.incumbentReleaseId, binding.timezoneIdentifier,
      binding.overrideDigest, binding.configDigest, binding.cutoffAt,
      binding.inputDigest, binding.createdAt
    );
    // 覆盖记录：这条任务把哪些导入批次算进去了（含捕获代次前进时并进来的那些）。
    const jobId = binding.jobId;
    const from = binding.targetDependencyGeneration ?? binding.capturedDependencyGeneration;
    for (const batchId of capture.mergedBatchIds) {
      this.database.prepare(`
        INSERT INTO analysis_job_coverage (
          job_id, import_batch_id, dependency_generation_from, dependency_generation_to
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(job_id, import_batch_id) DO UPDATE SET
          dependency_generation_from = excluded.dependency_generation_from,
          dependency_generation_to = excluded.dependency_generation_to
      `).run(jobId, batchId, from, binding.capturedDependencyGeneration);
    }
  }

  private pruneSupersededRuns(): void {
    if (SUPERSEDED_RUN_RETENTION <= 0) return;
    try {
      new SqliteModelReleaseRepository(this.database).retireOldReleases(SUPERSEDED_RUN_RETENTION);
      this.gate.scope(() => this.store.pruneSupersededModelRuns({ keepRecent: SUPERSEDED_RUN_RETENTION }));
    } catch (error) {
      process.stderr.write(
        `Superseded run prune skipped: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  private throwIfCancelled(jobId: string): void {
    if (this.jobs.cancelIfRequested(jobId)) throw new Error("Task cancellation requested");
  }

  private setJobRunIds(jobId: string, featureRunId: string | null, modelRunId: string | null): void {
    this.jobs.setRunIds(jobId, featureRunId, modelRunId);
  }

  private updateJobProgress(
    jobId: string,
    phase: string,
    current: number,
    total: number,
    message: string
  ): void {
    if (!this.progressGate.shouldPublish(jobId, phase, current, total)) return;
    this.jobs.updateProgress(jobId, phase, current, total, message);
  }

  private measureCompute<T>(jobId: string, stage: string, operation: () => T): T {
    const started = performance.now();
    try { return operation(); }
    finally {
      const metrics = {
        stage, durationMs: performance.now() - started,
        processMaxRssKiB: process.resourceUsage().maxRSS,
        recordCacheHits: this.recordCache.hits, recordCacheMisses: this.recordCache.misses
      };
      this.jobs.logEvent(jobId, "performance", 0, 0, JSON.stringify(metrics));
      if (process.send && process.connected) process.send({ type: "rai:compute-performance", ...metrics }, () => {});
    }
  }

  private completeJob(
    jobId: string,
    phase: string,
    current: number,
    total: number,
    message: string
  ): void {
    if (!this.jobs.complete(jobId, phase, current, total, message)) {
      throw new Error("Task cancellation requested");
    }
  }

  private errorPayload(error: unknown): Record<string, unknown> {
    return {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error"
    };
  }

  private isCancellationError(error: unknown): boolean {
    return error instanceof Error && error.message === "Task cancellation requested";
  }
}
