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
  type JobCancellationResult
} from "./recompute-job-repository.js";
export {
  activeDurationSecondsSql,
  MODEL_RUN_SUMMARY_SELECT
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
