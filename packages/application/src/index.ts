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

export { loadDatedReadiness } from "./model-v2-snapshots.js";

export { replayFitnessVersions, type ModelReplayInput } from "./model-replay-v2.js";
export { replayReadinessRulings, type ReadinessReplayFacts } from "./readiness-replay-v2.js";
