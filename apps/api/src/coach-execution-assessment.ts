import type {
  CoachEvidenceRef, CoachQualityExecutionSummary, MobilePlannedDay, MobileWorkoutStep, WorkoutExecutionAssessment, WorkoutSegment
} from "@rai/api-contracts";
import { coachLocalDate } from "./coach-loop-facts.js";
import { coachReason } from "./coach-loop-policy.js";
import { prescriptionDigest, digest } from "./plan-digest.js";
import { normalizeSessionStructure } from "./session-structure.js";
import { flattenStructure } from "./workout-segments.js";
import { isValidLocalDate } from "./local-date.js";

/**
 * O2-A/B candidate tolerances. Pure evaluation only: these conclusions are not
 * used by the production adaptation/quality-count/score paths until reviewed.
 */
export const EXECUTION_ASSESSMENT_CANDIDATE_VERSION = "rai-coach-execution-assessment-candidate-v1";
export const EXECUTION_DOSE_FRACTION = 0.9;
export const EXECUTION_SIGNAL_COVERAGE_FRACTION = 0.8;
export const EXECUTION_TARGET_FRACTION = 0.8;

export interface CoachExecutionPrescription {
  day: MobilePlannedDay;
  revision: number;
  createdAt: string;
  availableAt: string | null;
  evidenceRef: CoachEvidenceRef;
}

/** An identity association is separate from the measured dose and intensity. */
export interface CoachExecutionAssociation {
  workoutId: string;
  prescriptionDigest: string;
  method: WorkoutExecutionAssessment["association"]["method"];
  validFrom: string;
  validUntil: string | null;
  availableAt: string | null;
  retractedAt: string | null;
  evidenceRef: CoachEvidenceRef;
}

/** Already measured intervals, never inferred from average HR/pace. */
export interface CoachExecutionSignalInterval {
  channel: "pace" | "heart_rate";
  startOffsetSeconds: number;
  durationSeconds: number;
  value: number;
  availableAt: string | null;
}

export interface CoachExecutionWorkout {
  id: string;
  startedAt: string;
  endedAt: string;
  availableAt: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  evidenceLevel: Exclude<WorkoutExecutionAssessment["evidenceLevel"], "none">;
  /** False if source steps are partial; absent groups then remain unknown. */
  measuredStepsComplete: boolean;
  segments: readonly WorkoutSegment[];
  signalIntervals: readonly CoachExecutionSignalInterval[];
  evidenceRef: CoachEvidenceRef;
}

const knownBy = (instant: string | null, asOf: string): boolean =>
  instant !== null && Number.isFinite(Date.parse(instant)) && Date.parse(instant) <= Date.parse(asOf);
const positiveOrZero = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
const fractionMeets = (observed: number, required: number, fraction: number) => observed >= required * fraction - 1e-9;

/** Validate chronological measured boundaries before interpreting step labels. */
function validSegments(workout: CoachExecutionWorkout): boolean {
  let previousEnd = 0;
  let previousIndex = 0;
  const elapsed = (Date.parse(workout.endedAt) - Date.parse(workout.startedAt)) / 1000;
  for (const segment of workout.segments) {
    if (!Number.isInteger(segment.index) || segment.index <= previousIndex ||
      !Number.isFinite(segment.startOffsetSeconds) || segment.startOffsetSeconds < previousEnd - 1e-9 ||
      !Number.isFinite(segment.durationSeconds) || segment.durationSeconds <= 0 ||
      !positiveOrZero(segment.distanceMeters) ||
      segment.startOffsetSeconds + segment.durationSeconds > elapsed + 1e-9) return false;
    previousEnd = segment.startOffsetSeconds + segment.durationSeconds;
    previousIndex = segment.index;
  }
  return true;
}

/**
 * Assess one frozen obligation. Same-day workouts are not combined into a
 * synthetic interval session; averages never certify time-in-target.
 */
export function assessWorkoutExecution(input: {
  asOf: string;
  prescription: CoachExecutionPrescription;
  workouts: readonly CoachExecutionWorkout[];
  associations: readonly CoachExecutionAssociation[];
}): WorkoutExecutionAssessment {
  coachLocalDate(input.asOf);
  const { prescription } = input;
  const { day } = prescription;
  const hash = prescriptionDigest(day.kind, day.structure ?? null);
  const reasons: WorkoutExecutionAssessment["reasons"] = [];
  const reason = (code: string, params: WorkoutExecutionAssessment["reasons"][number]["params"] = {},
    evidenceRefs: CoachEvidenceRef[] = []) => {
    reasons.push(coachReason(code, EXECUTION_ASSESSMENT_CANDIDATE_VERSION, [day.localDate], params, evidenceRefs));
  };
  const base: WorkoutExecutionAssessment = {
    version: EXECUTION_ASSESSMENT_CANDIDATE_VERSION, policyStatus: "candidate",
    localDate: day.localDate, asOf: input.asOf, planRevision: prescription.revision,
    prescriptionDigest: hash, workoutIds: [],
    association: { status: "unmatched", method: null, evidenceRefs: [] },
    observation: "unknown", evidenceLevel: "none",
    dose: { status: "not_assessable", basis: null,
      requiredDistanceMeters: null, observedDistanceMeters: null,
      requiredWorkSeconds: null, observedWorkSeconds: null, requiredReps: null, verifiedReps: null },
    stimulus: { status: "not_assessable", channel: null, validCoverageFraction: null, timeInTargetFraction: null },
    completion: day.kind === "rest" ? "not_applicable" : "unconfirmed", reasons
  };
  const unique = new Map<string, CoachExecutionWorkout>();
  for (const workout of input.workouts) {
    coachLocalDate(workout.startedAt);
    coachLocalDate(workout.endedAt);
    if (!workout.id || Date.parse(workout.endedAt) <= Date.parse(workout.startedAt)) throw new Error("Invalid execution workout identity/timeline");
    if (!knownBy(workout.startedAt, input.asOf) || !knownBy(workout.endedAt, input.asOf) || !knownBy(workout.availableAt, input.asOf)) continue;
    const previous = unique.get(workout.id);
    if (previous && digest(previous) !== digest(workout)) throw new Error("Ambiguous execution workout revision");
    unique.set(workout.id, workout);
  }
  const visible = [...unique.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  // Observation belongs to the local-date obligation, even when association
  // is absent. A receipt may explicitly bind a neighbouring-day execution.
  const onDate = visible.filter(workout => coachLocalDate(workout.startedAt) === day.localDate);
  base.workoutIds = onDate.map(workout => workout.id);
  base.observation = onDate.length ? "observed" : "unknown";
  if (!onDate.length) reason("training_observation_unknown");
  if (day.kind === "rest") return base;
  if (!knownBy(prescription.createdAt, input.asOf) || !knownBy(prescription.availableAt, input.asOf)) {
    reason("prescription_not_available");
    return base;
  }
  const associated = visible.flatMap(workout => {
    const bindings = input.associations.filter(binding => binding.workoutId === workout.id && binding.prescriptionDigest === hash &&
      binding.method !== null && knownBy(binding.availableAt, input.asOf) &&
      (!binding.retractedAt || !knownBy(binding.retractedAt, input.asOf)) &&
      knownBy(binding.validFrom, workout.startedAt) &&
      (!binding.validUntil || Date.parse(workout.startedAt) < Date.parse(binding.validUntil)) &&
      Date.parse(prescription.createdAt) <= Date.parse(workout.startedAt) &&
      knownBy(prescription.availableAt, workout.startedAt));
    if (!bindings.length) return [];
    // Association precedence is independent of signal coverage. Multiple
    // proofs for the SAME prescription are corroboration, not ambiguity.
    const priority = (binding: CoachExecutionAssociation) => binding.method === "measured_steps_with_plan" ? 0 :
      binding.method === "valid_receipt" ? 1 : 2;
    bindings.sort((a, b) => priority(a) - priority(b) || Date.parse(b.validFrom) - Date.parse(a.validFrom) ||
      digest(a.evidenceRef).localeCompare(digest(b.evidenceRef)));
    return [{ workout, binding: bindings[0]! }];
  });
  if (associated.length !== 1) {
    base.association.status = associated.length ? "ambiguous" : "unmatched";
    reason(associated.length ? "prescription_association_ambiguous" : "prescription_association_unavailable");
    return base;
  }
  const { workout, binding } = associated[0]!;
  base.workoutIds = [workout.id];
  base.observation = "observed";
  base.evidenceLevel = workout.evidenceLevel;
  base.association = { status: "matched", method: binding.method,
    evidenceRefs: [prescription.evidenceRef, binding.evidenceRef, workout.evidenceRef] };
  const normalized = normalizeSessionStructure(day.structure);
  if (!normalized || digest(normalized) !== digest(day.structure)) {
    reason("execution_structure_unavailable");
    return base;
  }
  const planned = flattenStructure(normalized).map(item => item.step);
  const work = planned.flatMap((step, index) => step.purpose === "work" ? [{ step, index: index + 1 }] : []);
  if (!work.length || work.some(item => item.step.goal.type === "open")) {
    reason("work_dose_not_bounded");
    return base;
  }
  base.dose.requiredDistanceMeters = work.some(item => item.step.goal.type === "distance")
    ? work.reduce((sum, item) => sum + (item.step.goal.type === "distance" ? item.step.goal.meters : 0), 0) : null;
  base.dose.requiredWorkSeconds = work.some(item => item.step.goal.type === "time")
    ? work.reduce((sum, item) => sum + (item.step.goal.type === "time" ? item.step.goal.seconds : 0), 0) : null;
  base.dose.requiredReps = day.kind === "interval" ? work.length : null;
  const segmentsUsable = validSegments(workout);
  const measured = workout.evidenceLevel === "measured_steps" && segmentsUsable;
  const comparable = work.map(item => ({ ...item, segment: workout.segments.find(segment =>
    segment.index === item.index && segment.purpose === "work") ?? null }));
  if (measured) {
    const observed = comparable.flatMap(item => item.segment ? [item.segment] : []);
    base.dose.basis = "work_steps";
    base.dose.observedDistanceMeters = observed.reduce((sum, segment) => sum + segment.distanceMeters, 0);
    base.dose.observedWorkSeconds = observed.reduce((sum, segment) => sum + segment.durationSeconds, 0);
    const meetsStep = (step: MobileWorkoutStep, segment: WorkoutSegment | null) => segment !== null &&
      (step.goal.type === "distance" ? fractionMeets(segment.distanceMeters, step.goal.meters, EXECUTION_DOSE_FRACTION)
        : step.goal.type === "time" && fractionMeets(segment.durationSeconds, step.goal.seconds, EXECUTION_DOSE_FRACTION));
    const meets = comparable.map(item => meetsStep(item.step, item.segment));
    if (day.kind === "interval") {
      base.dose.verifiedReps = workout.measuredStepsComplete ? meets.filter(Boolean).length : null;
      // Every work/recovery boundary must remain distinguishable. A long
      // work segment cannot impersonate several repetitions or their recoveries.
      const supportComplete = planned.every((step, index) => step.purpose !== "recovery" ||
        workout.segments.some(segment => segment.index === index + 1 && segment.purpose === "recovery"));
      base.dose.status = !workout.measuredStepsComplete ? "not_assessable"
        : meets.every(Boolean) && supportComplete ? "met" : observed.length ? "partial" : "not_met";
    } else {
      base.dose.status = comparable.some(item => item.segment === null) && !workout.measuredStepsComplete ? "not_assessable"
        : meets.every(Boolean) ? "met" : observed.length ? "partial" : "not_met";
    }
  } else if (!["interval", "tempo"].includes(day.kind) && planned.every(step => step.purpose === "work") &&
    planned.every(step => step.goal.type === "distance") && positiveOrZero(workout.distanceMeters)) {
    // A genuinely continuous, distance-only prescription can compare totals.
    // Timed warmups/support cannot be subtracted from summaries by guessing pace.
    base.dose.basis = "whole_session";
    base.dose.observedDistanceMeters = workout.distanceMeters;
    base.dose.status = fractionMeets(workout.distanceMeters, base.dose.requiredDistanceMeters!, EXECUTION_DOSE_FRACTION)
      ? "met" : workout.distanceMeters > 0 ? "partial" : "not_met";
  } else {
    reason(day.kind === "interval" ? "rep_evidence_unavailable" : "work_dose_evidence_unavailable");
  }
  if (!segmentsUsable) reason("segment_boundaries_invalid");
  if (day.kind === "interval" && base.dose.verifiedReps === null) reason("rep_evidence_unavailable");
  if (base.dose.status === "partial" || base.dose.status === "not_met") reason("work_dose_not_met",
    { requiredReps: base.dose.requiredReps, verifiedReps: base.dose.verifiedReps });
  // Stimulus requires measured work-time boundaries and raw signal intervals.
  // A plan-reconstructed 480s step or its average HR is not a target-duration measurement.
  if (measured && comparable.every(item => item.segment !== null)) {
    const heartRateOnlyInterval = day.kind === "interval" && work.some(item => item.step.alert?.kind === "heart_rate");
    if (heartRateOnlyInterval) reason("interval_hr_lag_policy_unavailable");
    else base.stimulus = assessStimulus(comparable.map(item => ({ step: item.step, segment: item.segment! })),
      workout, input.asOf);
  }
  if (base.stimulus.status === "not_assessable") reason("stimulus_evidence_unavailable",
    { coverage: base.stimulus.validCoverageFraction });
  else if (base.stimulus.status !== "matched") reason("stimulus_mismatch", { status: base.stimulus.status });
  const knownNotMet = base.dose.status === "partial" || base.dose.status === "not_met" ||
    base.stimulus.status === "too_hard" || base.stimulus.status === "too_easy";
  base.completion = knownNotMet ? "known_not_met" :
    base.dose.status === "met" && base.stimulus.status === "matched" ? "confirmed" : "unconfirmed";
  return base;
}

function assessStimulus(work: Array<{ step: MobileWorkoutStep; segment: WorkoutSegment }>,
  workout: CoachExecutionWorkout, asOf: string): WorkoutExecutionAssessment["stimulus"] {
  const unknown: WorkoutExecutionAssessment["stimulus"] = {
    status: "not_assessable", channel: null, validCoverageFraction: null, timeInTargetFraction: null
  };
  const channels = new Set(work.map(item => item.step.alert?.kind));
  if (channels.size !== 1 || channels.has(undefined)) return unknown;
  const channel = work[0]!.step.alert!.kind;
  if (work.some(item => item.step.alert?.lower == null || item.step.alert.upper == null)) return { ...unknown, channel };
  const intervals = workout.signalIntervals.filter(interval => interval.channel === channel &&
    knownBy(interval.availableAt, asOf)).sort((a, b) => a.startOffsetSeconds - b.startOffsetSeconds);
  let previousEnd = 0;
  for (const interval of intervals) {
    if (!Number.isFinite(interval.startOffsetSeconds) || interval.startOffsetSeconds < previousEnd - 1e-9 ||
      !Number.isFinite(interval.durationSeconds) || interval.durationSeconds <= 0 ||
      !Number.isFinite(interval.value) || interval.value <= 0) return { ...unknown, channel };
    previousEnd = interval.startOffsetSeconds + interval.durationSeconds;
  }
  let total = 0, valid = 0, matched = 0, tooHard = 0, tooEasy = 0;
  for (const { step, segment } of work) {
    const start = segment.startOffsetSeconds, end = start + segment.durationSeconds;
    total += segment.durationSeconds;
    for (const interval of intervals) {
      const seconds = Math.max(0, Math.min(end, interval.startOffsetSeconds + interval.durationSeconds) -
        Math.max(start, interval.startOffsetSeconds));
      if (seconds === 0) continue;
      valid += seconds;
      const lower = step.alert!.lower!, upper = step.alert!.upper!;
      if (interval.value >= lower && interval.value <= upper) matched += seconds;
      else if (channel === "pace" ? interval.value < lower : interval.value > upper) tooHard += seconds;
      else tooEasy += seconds;
    }
  }
  const coverage = total > 0 ? valid / total : 0;
  const target = valid > 0 ? matched / valid : null;
  const result = { ...unknown, channel, validCoverageFraction: coverage, timeInTargetFraction: target };
  if (!fractionMeets(valid, total, EXECUTION_SIGNAL_COVERAGE_FRACTION) || total <= 0) return result;
  if (fractionMeets(matched, valid, EXECUTION_TARGET_FRACTION)) return { ...result, status: "matched" };
  // Conflicting over/under evidence is not collapsed into a physiological diagnosis.
  if (tooHard === tooEasy) return result;
  return { ...result, status: tooHard > tooEasy ? "too_hard" : "too_easy" };
}

/**
 * Batch obligations must not both consume the same measured workout. Ambiguous
 * many-to-one mappings remain unconfirmed instead of choosing by array order.
 */
export function assessWorkoutExecutionBatch(input: {
  asOf: string;
  prescriptions: readonly CoachExecutionPrescription[];
  workouts: readonly CoachExecutionWorkout[];
  associations: readonly CoachExecutionAssociation[];
}): WorkoutExecutionAssessment[] {
  const assessed = input.prescriptions.map(prescription => assessWorkoutExecution({ ...input, prescription }));
  const matchedCounts = new Map<string, number>();
  for (const row of assessed) if (row.association.status === "matched") for (const id of row.workoutIds) {
    matchedCounts.set(id, (matchedCounts.get(id) ?? 0) + 1);
  }
  return assessed.map(row => row.association.status === "matched" && row.workoutIds.some(id => matchedCounts.get(id)! > 1)
    ? { ...row, association: { ...row.association, status: "ambiguous" },
      dose: { ...row.dose, status: "not_assessable", verifiedReps: null },
      stimulus: { ...row.stimulus, status: "not_assessable" }, completion: "unconfirmed",
      reasons: [...row.reasons, coachReason("workout_associated_to_multiple_obligations",
        EXECUTION_ASSESSMENT_CANDIDATE_VERSION, [row.localDate], {}, row.association.evidenceRefs)] }
    : row);
}

/** Keep compatible date observations separate from candidate dose/stimulus counts. */
export function coachQualityExecutionSummary(input: {
  asOf: string;
  /** Caller freezes one historical obligation per date, not every revision. */
  prescriptions: readonly CoachExecutionPrescription[];
  observedDates: readonly string[];
  assessments: readonly WorkoutExecutionAssessment[];
}): CoachQualityExecutionSummary {
  const today = coachLocalDate(input.asOf);
  if (input.observedDates.some(date => !isValidLocalDate(date))) throw new Error("Invalid execution observation date");
  if (input.assessments.some(row => row.asOf !== input.asOf || row.version !== EXECUTION_ASSESSMENT_CANDIDATE_VERSION)) {
    throw new Error("Execution summary cannot mix fact clocks/policy versions");
  }
  const visible = input.prescriptions.filter(row => row.day.localDate <= today &&
    knownBy(row.createdAt, input.asOf) && knownBy(row.availableAt, input.asOf));
  if (new Set(visible.map(row => row.day.localDate)).size !== visible.length) {
    throw new Error("Execution summary requires one frozen obligation per date");
  }
  const quality = visible.filter(row => row.day.kind === "interval" || row.day.kind === "tempo");
  const result: CoachQualityExecutionSummary = {
    version: EXECUTION_ASSESSMENT_CANDIDATE_VERSION, policyStatus: "candidate", asOf: input.asOf,
    qualityPlanned: quality.length, qualityObserved: 0, qualityConfirmed: 0, qualityKnownNotMet: 0, qualityUnconfirmed: 0
  };
  for (const prescription of quality) {
    if (input.observedDates.includes(prescription.day.localDate)) result.qualityObserved++;
    const key = prescriptionDigest(prescription.day.kind, prescription.day.structure ?? null);
    const rows = input.assessments.filter(row => row.localDate === prescription.day.localDate &&
      row.planRevision === prescription.revision && row.prescriptionDigest === key);
    if (rows.length === 1 && rows[0]!.completion === "confirmed" && rows[0]!.association.status === "matched") {
      result.qualityConfirmed++;
    } else if (rows.length === 1 && rows[0]!.completion === "known_not_met" && rows[0]!.association.status === "matched") {
      result.qualityKnownNotMet++;
    } else result.qualityUnconfirmed++;
  }
  return result;
}
