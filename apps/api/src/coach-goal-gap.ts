import type { CoachGoalGap, CoachPredictionSummary } from "@rai/api-contracts";
import { coachLocalDate } from "./coach-loop-facts.js";
import { coachReason } from "./coach-loop-policy.js";
import { digest } from "./plan-digest.js";

export const GOAL_GAP_CANDIDATE_VERSION = "rai-coach-goal-gap-candidate-v1";
export const PREDICTION_SUMMARY_STALE_AFTER_DAYS = 7;
export type CoachPredictionIdentity = Pick<CoachPredictionSummary,
  "athleteId" | "bundleId" | "bundleHash" | "datasetEpoch" | "factsHash" | "overrideHash" |
  "labelCohortHash" | "activePredictionArtifactId" | "predictionPolicyVersion" | "scenario">;
const identity = (summary: CoachPredictionIdentity): CoachPredictionIdentity => ({
  athleteId: summary.athleteId, bundleId: summary.bundleId, bundleHash: summary.bundleHash,
  datasetEpoch: summary.datasetEpoch, factsHash: summary.factsHash, overrideHash: summary.overrideHash,
  labelCohortHash: summary.labelCohortHash, activePredictionArtifactId: summary.activePredictionArtifactId,
  predictionPolicyVersion: summary.predictionPolicyVersion, scenario: summary.scenario
});

/**
 * Light candidate read assembly only. No report builder/ONNX, queue, DB write,
 * capacity input, success probability or implicit prediction-distance expansion.
 */
export function coachGoalGap(input: {
  asOf: string;
  distance: "five_k" | "ten_k" | "half_marathon" | "unsupported" | null;
  targetSeconds: number | null;
  summary: CoachPredictionSummary | null;
  currentIdentity: CoachPredictionIdentity | null;
  preparationGaps?: CoachGoalGap["preparationGaps"];
}): CoachGoalGap {
  const today = coachLocalDate(input.asOf);
  const result: CoachGoalGap = {
    policyVersion: GOAL_GAP_CANDIDATE_VERSION, policyStatus: "candidate", status: "summary_unavailable",
    summaryId: null, distance: input.distance === "unsupported" ? null : input.distance,
    targetSeconds: input.targetSeconds, referenceSeconds: null, gapSeconds: null,
    preparationGaps: [...(input.preparationGaps ?? [])],
    freshness: { asOf: null, dataThroughAt: null, stale: false }, calibrationStatus: null, reasons: []
  };
  const reason = (code: string, params: CoachGoalGap["reasons"][number]["params"] = {}) =>
    result.reasons.push(coachReason(code, GOAL_GAP_CANDIDATE_VERSION, [today], params));
  if (input.targetSeconds === null) { result.status = "no_time_goal"; reason("no_time_goal"); return result; }
  if (!Number.isFinite(input.targetSeconds) || input.targetSeconds <= 0) throw new Error("Goal time must be finite and positive");
  if (input.distance === null || input.distance === "unsupported") {
    result.status = "unsupported_distance"; reason("unsupported_prediction_distance"); return result;
  }
  const summary = input.summary;
  if (!summary) { reason("prediction_summary_unavailable"); return result; }
  result.summaryId = summary.id;
  result.freshness = { asOf: summary.asOf, dataThroughAt: summary.dataThroughAt, stale: false };
  const temporalValid = [summary.asOf, summary.publishedAt, summary.availableAt].every(instant =>
    /(Z|[+-]\d{2}:\d{2})$/.test(instant) && Number.isFinite(Date.parse(instant)) &&
    Date.parse(instant) <= Date.parse(input.asOf)) && Date.parse(summary.asOf) <= Date.parse(summary.publishedAt) &&
    Date.parse(summary.asOf) <= Date.parse(summary.availableAt);
  const identityValid = [summary.athleteId, summary.bundleId, summary.bundleHash, summary.datasetEpoch,
    summary.factsHash, summary.overrideHash, summary.predictionPolicyVersion].every(value => typeof value === "string" && value.length > 0);
  if (!temporalValid || summary.schemaVersion !== 1 || !summary.id ||
    !identityValid ||
    !input.currentIdentity || summary.scenario !== "current_prepared" || input.currentIdentity.scenario !== "current_prepared" ||
    digest(identity(summary)) !== digest(identity(input.currentIdentity))) {
    result.status = "incompatible"; reason("prediction_summary_incompatible"); return result;
  }
  if (!summary.dataThroughAt) { reason("prediction_data_cutoff_unavailable"); return result; }
  if (!Number.isFinite(Date.parse(summary.dataThroughAt)) || Date.parse(summary.dataThroughAt) > Date.parse(summary.asOf)) {
    result.status = "incompatible"; reason("prediction_data_cutoff_invalid"); return result;
  }
  const throughDate = coachLocalDate(summary.dataThroughAt);
  const ageDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${throughDate}T00:00:00Z`)) / 86_400_000);
  if (ageDays > PREDICTION_SUMMARY_STALE_AFTER_DAYS) {
    result.status = "stale"; result.freshness.stale = true;
    reason("prediction_summary_stale", { ageDays, maximumAgeDays: PREDICTION_SUMMARY_STALE_AFTER_DAYS });
    return result;
  }
  const entries = summary.entries.filter(entry => entry.distance === input.distance);
  if (entries.length !== 1) { result.status = "incompatible"; reason("prediction_distance_entry_ambiguous"); return result; }
  const entry = entries[0]!;
  if (entry.status !== "available" || entry.referenceSeconds === null) { reason("prediction_distance_insufficient_data"); return result; }
  if (!Number.isFinite(entry.referenceSeconds) || entry.referenceSeconds <= 0 || !entry.method ||
    !["uncalibrated", "personal_reference", "empirically_evaluated"].includes(entry.calibrationStatus) ||
    entry.range && (!Number.isFinite(entry.range.lowerSeconds) || !Number.isFinite(entry.range.upperSeconds) ||
      entry.range.lowerSeconds <= 0 || entry.range.upperSeconds < entry.range.lowerSeconds ||
      entry.range.kind !== (entry.calibrationStatus === "uncalibrated" ? "heuristic_not_calibrated" :
        entry.calibrationStatus === "personal_reference" ? "personal_reference" : "empirical"))) {
    result.status = "incompatible"; reason("prediction_distance_entry_invalid"); return result;
  }
  result.status = "available";
  result.referenceSeconds = entry.referenceSeconds;
  result.gapSeconds = entry.referenceSeconds - input.targetSeconds;
  result.calibrationStatus = entry.calibrationStatus;
  result.reasons.push(coachReason("goal_gap_seconds_only", GOAL_GAP_CANDIDATE_VERSION, [today], {
    gapSeconds: result.gapSeconds, targetSeconds: input.targetSeconds, referenceSeconds: entry.referenceSeconds,
    calibrationStatus: entry.calibrationStatus
  }, entry.evidenceRefs));
  reason("goal_gap_not_a_probability");
  return result;
}
