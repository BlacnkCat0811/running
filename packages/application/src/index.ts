export * from "./service.js";
export * from "./recompute-job-repository.js";
export * from "./prediction-report.js";
export * from "./prediction-model-service.js";
export * from "./prediction-training-data.js";
// §5.2: the condition extractor is the single implementation of "which environment did this
// workout see". Exported so the coverage report reuses it rather than re-parsing metadata and
// silently disagreeing with the runtime.
export {
  loadRaceReadiness,
  loadRaceReadinessEvidence,
  buildLabelFunnel,
  parsePerformanceConditions
} from "./prediction-data.js";
export { RecomputePipeline } from "./services/recompute-pipeline.js";

export { loadDatedReadiness, loadDatedRecoveryFacts, type DatedReadinessFacts } from "./model-v2-snapshots.js";

export { replayFitnessVersions, type ModelReplayInput } from "./model-replay-v2.js";
export { replayReadinessRulings, type ReadinessReplayFacts } from "./readiness-replay-v2.js";
export { replayLoadRulings, type LoadReplayFacts, type LoadReplayFact } from "./load-replay-v2.js";
export {
  buildReadinessReplayCoverage,
  assessmentInstantForLocalDate,
  READINESS_REPLAY_COVERAGE_VERSION,
  type ReadinessReplayCoverageOptions
} from "./readiness-replay-coverage.js";
export { backfillCanonicalNights, type CanonicalNightsBackfillResult } from "./backfill-canonical-nights.js";
export {
  buildBaselineRebaseReview,
  BASELINE_REBASE_REVIEW_VERSION,
  type BaselineRebaseReviewOptions
} from "./baseline-rebase-review.js";
