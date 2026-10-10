import type { CoachSessionDose, MobileSessionKind, MobileSessionStructure, MobileWorkoutStep } from "@rai/api-contracts";
import type { CoachZonePrescription } from "./mobile-coach.js";
import { MAX_BLOCKS, MAX_BLOCK_ITERATIONS, MAX_STEP_METERS, MAX_STEP_SECONDS, normalizeSessionStructure } from "./session-structure.js";

export const SESSION_DOSE_POLICY_VERSION = "rai-coach-session-dose-v1";
export const MINIMUM_SESSION_DURATION_SECONDS = 1800;
/** Cold-start cost estimate, NOT a measured pace or an intensity target. */
export const COLD_START_ESTIMATE_SECONDS_PER_KM = 360;

type Range = { lower: number; upper: number };

function paceRange(kind: MobileSessionKind, zones: CoachZonePrescription | null): Range | null {
  const lower = kind === "interval" ? zones?.intervalPaceLower : kind === "tempo" ? zones?.thresholdPaceLower : zones?.easyPaceLower;
  const upper = kind === "interval" ? zones?.intervalPaceUpper : kind === "tempo" ? zones?.thresholdPaceUpper : zones?.easyPaceUpper;
  return lower != null && upper != null && Number.isFinite(lower) && Number.isFinite(upper) &&
    lower >= 120 && upper <= 1200 && lower <= upper ? { lower, upper } : null;
}

/** Expand bounded steps without copying the structure or assigning meaning to open goals. */
function stepsWithCounts(structure: MobileSessionStructure): Array<{ step: MobileWorkoutStep; count: number }> | null {
  if (!Array.isArray(structure.blocks) || structure.blocks.length > MAX_BLOCKS) return null;
  const result = [
    ...(structure.warmup ? [{ step: structure.warmup, count: 1 }] : []),
    ...(structure.cooldown ? [{ step: structure.cooldown, count: 1 }] : [])
  ];
  for (const block of structure.blocks) {
    if (!Number.isInteger(block.iterations) || block.iterations < 1 || block.iterations > MAX_BLOCK_ITERATIONS ||
      !Array.isArray(block.steps) || !block.steps.length) return null;
    result.push(...block.steps.map(step => ({ step, count: block.iterations })));
  }
  return result;
}

/**
 * Final-structure validation, in seconds and unrounded km. Distance duration
 * uses the fastest/slowest permitted pace; time-goal cost uses the fastest end.
 * No automatic extension may use the cold-start estimate as measured evidence.
 */
export function assessSessionDose(input: {
  kind: MobileSessionKind;
  structure: MobileSessionStructure | null;
  zones: CoachZonePrescription | null;
  availableSeconds?: number | null;
  maximumDistanceKm?: number | null;
  allowColdStartEstimate?: boolean;
}): CoachSessionDose {
  const base: CoachSessionDose = {
    policyVersion: SESSION_DOSE_POLICY_VERSION,
    status: input.kind === "rest" ? "not_applicable" : "not_assessable",
    estimateSource: "unavailable", durationSeconds: null, distanceKm: null,
    workSecondsLower: null, workMetersLower: null, workRepetitions: 0, reasonCodes: []
  };
  if (input.kind === "rest") return base;
  const steps = input.structure ? stepsWithCounts(input.structure) : null;
  if (!steps) return { ...base, reasonCodes: ["session_structure_unavailable"] };
  let usedColdStart = false;
  const duration = { lower: 0, upper: 0 };
  const distance = { lower: 0, upper: 0 };
  let workSeconds = 0;
  let workMeters = 0;
  let repetitions = 0;
  for (const { step, count } of steps) {
    if (!["warmup", "work", "recovery", "cooldown"].includes(step.purpose)) {
      return { ...base, reasonCodes: ["session_structure_invalid"] };
    }
    const goal = step.goal;
    if (goal.type === "open") return { ...base, reasonCodes: ["open_goal_not_bounded"] };
    const value = goal.type === "time" ? goal.seconds : goal.meters;
    const maximum = goal.type === "time" ? MAX_STEP_SECONDS : MAX_STEP_METERS;
    if (!Number.isFinite(value) || value <= 0 || value > maximum) return { ...base, reasonCodes: ["session_structure_invalid"] };
    let pace = paceRange(step.purpose === "work" ? input.kind : "easy", input.zones);
    // A step target can widen the assumed range but never conceal a faster
    // zone edge. HR preference does not discard the pace cost evidence.
    if (step.alert?.kind === "pace" && step.alert.lower != null && step.alert.upper != null) {
      if (!Number.isFinite(step.alert.lower) || !Number.isFinite(step.alert.upper) ||
        step.alert.lower < 120 || step.alert.upper > 1200 || step.alert.lower > step.alert.upper) {
        return { ...base, reasonCodes: ["step_pace_range_invalid"] };
      }
      pace = pace ? { lower: Math.min(pace.lower, step.alert.lower), upper: Math.max(pace.upper, step.alert.upper) }
        : { lower: step.alert.lower, upper: step.alert.upper };
    }
    if (!pace) {
      if (!input.allowColdStartEstimate || ["interval", "tempo"].includes(input.kind)) {
        return { ...base, reasonCodes: ["dose_pace_evidence_unavailable"] };
      }
      usedColdStart = true;
      pace = { lower: COLD_START_ESTIMATE_SECONDS_PER_KM, upper: COLD_START_ESTIMATE_SECONDS_PER_KM };
    }
    const secondsLower = goal.type === "time" ? goal.seconds : goal.meters / 1000 * pace.lower;
    const secondsUpper = goal.type === "time" ? goal.seconds : goal.meters / 1000 * pace.upper;
    const kmLower = goal.type === "distance" ? goal.meters / 1000 : goal.seconds / pace.upper;
    const kmUpper = goal.type === "distance" ? goal.meters / 1000 : goal.seconds / pace.lower;
    duration.lower += secondsLower * count;
    duration.upper += secondsUpper * count;
    distance.lower += kmLower * count;
    distance.upper += kmUpper * count;
    if (step.purpose === "work") {
      workSeconds += secondsLower * count;
      workMeters += kmLower * 1000 * count;
      repetitions += count;
    }
  }
  const reasons: string[] = [];
  if (duration.lower < MINIMUM_SESSION_DURATION_SECONDS) reasons.push("minimum_session_not_feasible");
  // Existing builders: easy/recovery/long need meaningful continuous work,
  // tempo is 3 x 8 min, intervals 4 x 800 m. No padding-only quality sessions.
  if (input.kind === "interval" ? repetitions < 4 || workMeters < 3200 :
    input.kind === "tempo" ? workSeconds < 1440 : workSeconds < 1200) reasons.push("minimum_work_dose_not_met");
  if (input.availableSeconds != null && (!Number.isFinite(input.availableSeconds) || duration.upper > input.availableSeconds)) {
    reasons.push("available_time_exceeded");
  }
  if (input.maximumDistanceKm != null && (!Number.isFinite(input.maximumDistanceKm) ||
    distance.upper > input.maximumDistanceKm + 1e-9)) reasons.push("session_distance_limit");
  return {
    ...base, status: reasons.length ? "not_feasible" : "feasible",
    estimateSource: usedColdStart ? "cold_start_policy" : "zone_pace_range",
    durationSeconds: duration, distanceKm: distance,
    workSecondsLower: workSeconds, workMetersLower: workMeters,
    workRepetitions: repetitions, reasonCodes: reasons
  };
}

/** Complete low-intensity dose: 5 min warmup, 20 min work, 5 min cooldown. */
export function buildCompleteEasyStructure(
  kind: "easy" | "recovery", zones: CoachZonePrescription | null
): MobileSessionStructure {
  const pace = paceRange(kind, zones);
  const hr = zones?.easyHrUpper != null && Number.isFinite(zones.easyHrUpper) &&
    zones.easyHrUpper > 0 && zones.easyHrUpper <= 240 &&
    (zones.easyHrLower === null || Number.isFinite(zones.easyHrLower) && zones.easyHrLower > 0 && zones.easyHrLower <= zones.easyHrUpper)
    ? { kind: "heart_rate" as const, lower: zones.easyHrLower, upper: zones.easyHrUpper } : null;
  return normalizeSessionStructure({
    warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: hr },
    blocks: [{ iterations: 1, steps: [{
      purpose: "work", goal: { type: "time", seconds: 1200 },
      alert: pace ? { kind: "pace", lower: pace.lower, upper: pace.upper } : null
    }] }],
    cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: hr }
  })!;
}
