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
  parsePerformanceConditions,
  // §12.10 手工成绩条目：标签装载器的两个入口都要能被独立核对 —— 评估只吃
  // `loadLabeledRaceOutcomes`（合并结果），而诊断要能分别看到两类来源。
  loadLabeledRaceOutcomes,
  loadManualPerformanceOutcomes,
  type LabelFunnelReport,
  type LabeledRaceOutcome
} from "./prediction-data.js";
export { RecomputePipeline } from "./services/recompute-pipeline.js";
// §12.11 个人自校准：留一法回放产出残差样本，拟合与展示闸门在 @rai/model-eval。
export {
  buildPersonalCalibrationSamples,
  personalCalibrationStatus,
  type PersonalCalibrationPass
} from "./personal-calibration.js";
// §6.9 / F08: the speed inventory must normalise units with the *same* converter the pipeline
// uses. Exporting it keeps a read-only report from growing a second unit convention that would
// disagree with the runtime (the unit column is not homogeneous: this DB holds both km/hr and m/s).
export { convertSpeedToMetersPerSecond } from "./recompute-helpers.js";

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
  recordBaselineRebaseReview,
  BASELINE_REBASE_REVIEW_VERSION,
  type BaselineRebaseReviewOptions
} from "./baseline-rebase-review.js";
