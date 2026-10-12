export { parseAppleHealthXml, CALLER_OWNED_PARSE_SAVEPOINT } from "./apple-health-parser.js";
export {
  DATA_ONLY_RECORD_TYPES, DATA_ONLY_MAX_XML_BYTES, DATA_ONLY_MAX_RECORDS,
  DATA_ONLY_WRITE_GUARD, RecordDeltaNotEligibleError, isDataOnlyRecordXml,
  classifyDirectSyncPayload,
  type DirectSyncPayloadFacts, type DirectSyncPayloadClassification
} from "./record-delta-policy.js";
export {
  parseHealthSyncManifest, readHealthSyncManifest,
  type HealthSyncManifest, type HealthKitRecordDeletion
} from "./sync-manifest.js";
export {
  prepareNative, nativeElevationGains, importEngine, nativeFallback, nativeBinary, NativeWorkerError,
  NATIVE_PROTOCOL, NATIVE_VERSION, NATIVE_OPERATIONS,
  type ImportEngine, type NativeOptions, type NativeMetrics, type NativeOperation
} from "./native-worker.js";
export {
  ABSENT_REMOVAL_GUARD_MAX_RATIO,
  ABSENT_REMOVAL_GUARD_MIN_ENTITIES,
  evaluateRemovalGuard,
  ImportRemovalGuardError,
  type RemovalGuardPayload,
  type RemovalGuardEvaluation
} from "./import-guard.js";
export {
  buildAudit,
  renderAuditMarkdown,
  stageAuditFiles,
  stageBuiltAuditFiles,
  writeAuditFiles,
  type DataAudit,
  type StagedAuditFiles,
} from "./audit.js";
export {
  canonicalizeRunningWorkouts,
  type IncrementalCanonicalizationOptions
} from "./canonicalize.js";
export {
  canonicalizeNights,
  canonicalizeNightsForWindow,
  CANONICAL_NIGHT_ALGORITHM_VERSION,
  type CanonicalNight,
  type CanonicalHrvDay,
  type CanonicalizationNightsResult,
  type HrvDayConfidence
} from "./canonicalize-nights.js";
export {
  RaiDatabase,
  SEED_CONTENT_HASH,
  type RaiDatabaseOpenOptions,
  type RouteImportTarget
} from "./database.js";
export { importGpxRoutes } from "./gpx-parser.js";
export { acquireDatabasePublicationLock } from "@rai/storage-sqlite";
export {
  diffDataset,
  fingerprintFile,
  planRecompute,
  readDatasetFingerprints,
  type DatasetDiff,
  type DatasetFingerprints,
  type ImportChangeType,
  type ImportEntityChange,
  type ImportEntityKind,
  type RecomputePlan
} from "./incremental.js";
export {
  FROZEN_IDENTITY_ALGORITHM,
  IDENTITY_ALGORITHM_PROBES,
  identityAlgorithmFingerprint
} from "./identity-algorithm.js";
