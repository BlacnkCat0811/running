export * from "./service.js";
export * from "./write-gate.js";
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
export { RecomputePipeline, TRAINING_METRIC_CHECKPOINT_VERSION } from "./services/recompute-pipeline.js";
// The formula baseline version enters `currentAbilityBaselineHash`, so it is part of
// the public identity of a prediction — exported for the doc/version consistency test.
export { FORMULA_PREDICTION_BASE_VERSION } from "./prediction-ability-baseline.js";
// O06-A / WP-22：分析输入读取器（只读连接上的**一个读事务**捕获输入绑定与账本覆盖）。
// 注入点在 worker 线程（`apps/api/src/recompute-thread.ts`）——分析不允许自己去开连接。
export {
  SqliteAnalysisInputReader,
  type AnalysisInputCapture,
  type AnalysisInputCaptureRequest,
  type AnalysisInputSource
} from "./services/analysis-input-reader.js";
// O06-A / WP-22 步骤 3–5：固定输入的事实视图（物化快照 / 分段校验读）。
export {
  AnalysisInputCoverageOutOfBoundsError,
  AnalysisInputDriftError,
  DEFAULT_ANALYSIS_INPUT_BUDGET,
  FACT_PRUNE_ALWAYS_KEPT_RECORD_TYPES,
  FACT_PRUNE_WINDOWED_RECORD_TYPES,
  PEAK_EVIDENCE_LOOKBACK_MS,
  PINNED_FACT_TABLES,
  PINNED_PUBLISHED_EVIDENCE_TABLES,
  RECORDS_MAX_LOOKBACK_MS,
  SESSION_RECORDS_LOOKBACK_MS,
  SNAPSHOT_TABLES,
  SegmentedFactView,
  SnapshotFactView,
  buildFactTableFilters,
  materializeFactSnapshot,
  probeFactSize,
  AnalysisInputReadBudgetExceeded,
  type AnalysisFactView,
  type AnalysisFactViewStats,
  type AnalysisInputBudget,
  type FactPruneCoverage,
  type FactTableFilter,
  type FactTableFilters,
  type FactViewGenerations,
  type SnapshotCoverage
} from "./services/analysis-fact-view.js";
export { analysisInputDigest, type AnalysisInputBinding } from "./analysis-input-binding.js";
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
