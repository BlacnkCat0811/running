export {
  acquireDatabasePublicationLock,
  processIsAlive,
  type ProcessProbe,
  type PublicationLockOwner
} from "./publication-lock.js";
export { SqliteModelReleaseRepository, semanticHash, REQUIRED_MODEL_DOMAINS } from "./model-release-repository.js";
export {
  publishDatabaseFile,
  type DatabaseFilePublication,
  type DatabaseFilePublisherOptions
} from "./database-file-publisher.js";
export {
  isStructurallyReadable,
  probeDatabaseStructure,
  type DatabaseStructureReport
} from "./database-structure-probe.js";
export {
  SqliteModelRunRepository,
  ModelRunActivationError,
  recordModelReleaseRefusal,
  type ModelReleaseRefusalStage,
  type StoredModelRunSummary,
  type ModelValidationGateResult
} from "./model-run-repository.js";
export {
  MODEL_TRANSITION_GATE_VERSION,
  MODEL_TRANSITION_GATE_THRESHOLDS_V2,
  evaluateModelTransitionGateV2,
  type ModelTransitionGateInput,
  type ModelTransitionGateResultV2,
  type ModelTransitionGateStatus,
  type ModelTransitionGateThresholdsV2,
  type ModelTransitionKind,
  type ModelTransitionMetricsV2,
  type ModelTransitionSchemaContext,
  type ModelTransitionSourceBackfillEvidence
} from "./model-transition-gate.js";
export {
  RaiDatabase,
  PendingMigrationsError,
  SEED_CONTENT_HASH,
  type GenerationRemovalPreview,
  type RaiDatabaseOpenOptions,
  type RouteImportTarget,
  type SupersededRunPruneResult
} from "./database.js";
export {
  RecomputeJobRepository,
  ANALYSIS_JOB_MERGE_MAX_ATTEMPTS,
  ANALYSIS_JOB_MERGE_MAX_MEMBERS,
  ANALYSIS_JOB_MERGE_MAX_SPAN_MS,
  ANALYSIS_JOB_MERGE_REQUEST_KEY,
  type AnalysisJobMergeState,
  type JobCancellationResult,
  type JobCoverageReport
} from "./recompute-job-repository.js";
export {
  isRetryableJobFailure,
  isWriteTransactionScope,
  RETRYABLE_JOB_ATTEMPT_LIMIT,
  rollbackWithoutReplacing,
  withDatabaseTransaction,
  type RetryableJobFailure,
  type WriteTransactionScope
} from "./transaction.js";
export {
  activeDurationSecondsSql,
  MODEL_RUN_SUMMARY_SELECT,
  sessionFactPresentConditionSql,
  usableRouteConditionSql,
  workoutPresentConditionSql
} from "./sql/fragments.js";
export {
  SqliteTrainingSessionRepository,
  type FeatureSessionRow
} from "./training-session-repository.js";
export {
  SqliteDashboardReadRepository,
  type StoredAbilityDimensions,
  type StoredAbilitySnapshot,
  type StoredCalibrationProgress,
  type StoredEligibilityTotals
} from "./read/dashboard-read-repository.js";
export {
  SqliteWorkoutReadRepository,
  type StoredWorkoutDetailRow,
  type StoredWorkoutListItem,
  type StoredWorkoutOverride,
  type WorkoutListFilterQuery,
  type WorkoutListSqlFilter
} from "./read/workout-read-repository.js";
export {
  SqliteZoneReadRepository
} from "./read/zone-read-repository.js";
export {
  SqliteTrainingStatisticsReadRepository,
  type LoadTimelineComponent
} from "./read/training-statistics-read-repository.js";
export {
  SqliteSeriesReadRepository,
  type MetricInterval,
  type StoredMeasuredSegment,
  type StoredMetricSeries,
  type StoredRoutePoint,
  type StoredSeriesSession,
  type StoredSpeedSample,
  type StoredSpeedTrack,
  type StoredWorkoutEventInterval,
  type StoredWorkoutSplit
} from "./read/series-read-repository.js";
export {
  SqliteTrendsReadRepository,
  type StoredTrends
} from "./read/trends-read-repository.js";
export {
  ANALYSIS_BLOCK_KEYS,
  FACTS_BLOCK_KEYS,
  readFactReadView,
  readFactReadViewInTransaction,
  type FactReadView,
  type FactReadViewContext,
  type FactReadViewLimits
} from "./read/fact-read-view.js";
export {
  SqliteAuditReadRepository,
  type StoredDataAudit,
  type StoredDataSummary,
  type StoredDiagnosticsActiveModel
} from "./read/audit-read-repository.js";
export { SqliteRecoveryFactsReadRepository, type StoredCanonicalNight, type StoredCanonicalHrvDay } from "./read/recovery-facts-read-repository.js";
export {
  SqlitePredictionRecoveryReadRepository,
  type PredictionRecoveryReadings,
  type PredictionRecoveryProvenance
} from "./read/prediction-recovery-read-repository.js";

export { SqliteCalibrationRepository } from "./calibration-repository.js";
export { SqliteCoachFactsRepository } from "./coach-facts-repository.js";

// §12.10 手工成绩条目：标签闭环的入口，只作标签/评估证据。
export {
  PERFORMANCE_ENTRY_DISTANCE_METERS,
  loadPerformanceEventSessions,
  PerformanceEntryValidationError,
  SqlitePerformanceEntryRepository,
  type PerformanceEntryDistance,
  type StoredPerformanceEntry
} from "./performance-entry-repository.js";

// §5.5/D9 隐私区：主库表，随备份/恢复一起走。
export {
  PrivacyZoneRevisionConflictError,
  PrivacyZoneValidationError,
  SqlitePrivacyZoneRepository,
  type PrivacyZoneInput,
  type StoredPrivacyZone
} from "./privacy-zone-repository.js";

// §4 固定代次事实读取器（PR3 交付的**契约**）。
//
// ⚠️ 消费方在 PR4：本包导出它，但**今天没有任何生产调用方**（全仓只有它的测试与设计文档）。
// 它读的是 `import_fact_history` / `valid_from_generation` 那套版本化事实，而 v34 的
// 写入方同样还没落地 —— 所以现在能读到的只有"当前行"（NULL 视为自古以来有效）。
// 完整的口径与已知边界见 `read/facts-reader.ts` 的文件头。
export {
  openFactsReader,
  type FactsReader,
  type FactsRecordFilter,
  type FactsWorkoutFilter
} from "./read/facts-reader.js";
