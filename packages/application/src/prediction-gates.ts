/**
 * The ML release/activation thresholds — the single definition for every reader.
 *
 * `prediction-model-service` and `prediction-training-runner` enforce them when a
 * model is activated; `prediction-report` reports `recommend_activation` (and its
 * restored-pointer validity check) against them. They used to be independent
 * numbers (3% in the report, 5% in the activation gate), so a report could say
 * "recommend activation" for an artifact the activation service would reject.
 * `docs/ALGORITHM.md` §12.12 states the gate is ≥5% for both scopes.
 *
 * This module is a leaf on purpose. The existing chain is
 * `prediction-model-service` -> `prediction-training-data` -> `prediction-report`
 * (training-data imports `buildFormulaPredictionBase` from the report), so reading
 * these constants off the service would close the loop
 * report -> service -> training-data -> report. A module that imports nothing
 * cannot.
 */

/** A candidate must beat the rule baseline by this fraction of MAE to be activated. */
export const MINIMUM_MAE_IMPROVEMENT = 0.05;

/** Per-distance MAE may not regress by more than this fraction. */
export const MAXIMUM_DISTANCE_MAE_REGRESSION = 0.05;

/** Interval coverage may not drop by more than this much. */
export const MAXIMUM_INTERVAL_COVERAGE_DROP = 0.05;
