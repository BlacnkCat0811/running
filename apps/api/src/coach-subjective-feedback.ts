import type { CoachDecisionReason, SubjectiveFeedback } from "@rai/api-contracts";
import { ISO_UTC_OFFSET } from "@rai/contracts";
import { coachLocalDate, shiftCoachDate } from "./coach-loop-facts.js";
import { coachReason } from "./coach-loop-policy.js";
import { digest } from "./plan-digest.js";

export const SUBJECTIVE_FEEDBACK_CANDIDATE_VERSION = "rai-coach-subjective-feedback-candidate-v1";
type FeedbackFields = Pick<SubjectiveFeedback,
  "phase" | "workoutId" | "fatigue" | "soreness" | "discomfort" | "requestedAction" |
  "interruptionReason" | "replacementReason" | "rpeOverrideRef" | "observedAt">;

/** Candidate-only canonicalization. No collection, persistence or second RPE value. */
export function buildSubjectiveFeedback(input: {
  fields: FeedbackFields;
  id: string;
  revision: number;
  scope: SubjectiveFeedback["scope"];
  recordedAt: string;
  availableAt: string;
  knownWorkoutIds: readonly string[];
  knownRpeOverrides: readonly NonNullable<SubjectiveFeedback["rpeOverrideRef"]>[];
}): SubjectiveFeedback | null {
  const { fields } = input;
  const keys = new Set(["phase", "workoutId", "fatigue", "soreness", "discomfort", "requestedAction",
    "interruptionReason", "replacementReason", "rpeOverrideRef", "observedAt"]);
  if (Object.keys(fields).some(key => !keys.has(key))) throw new Error("Unknown subjective feedback field; RPE stays in override commands");
  const valid = (value: string | null, values: readonly string[]) => value === null || values.includes(value);
  if (!input.id || !Number.isInteger(input.revision) || input.revision < 1 || !input.scope.athleteId || !input.scope.datasetEpoch ||
    !["pre_run", "post_run"].includes(fields.phase) ||
    !valid(fields.fatigue, ["usual", "elevated", "high"]) ||
    !valid(fields.soreness, ["none", "mild", "marked"]) || !valid(fields.discomfort, ["none", "present"]) ||
    !valid(fields.requestedAction, ["none", "easy_only", "rest"]) ||
    !valid(fields.interruptionReason, ["time_constraint", "fatigue", "discomfort", "weather", "equipment", "other"]) ||
    !valid(fields.replacementReason, ["time_constraint", "preference", "fatigue", "discomfort", "other"])) {
    throw new Error("Invalid subjective feedback identity/fields");
  }
  const localDate = coachLocalDate(fields.observedAt);
  coachLocalDate(input.recordedAt);
  coachLocalDate(input.availableAt);
  if (Date.parse(fields.observedAt) > Date.parse(input.recordedAt) || Date.parse(input.availableAt) < Date.parse(input.recordedAt)) {
    throw new Error("Feedback cannot occur in the future or arrive before first server save");
  }
  if (fields.phase === "pre_run" && (fields.workoutId !== null || fields.rpeOverrideRef !== null ||
    fields.interruptionReason !== null || fields.replacementReason !== null)) {
    throw new Error("Pre-run feedback does not bind workout/RPE/post-run reasons");
  }
  if (fields.phase === "post_run" && (!fields.workoutId || !input.knownWorkoutIds.includes(fields.workoutId))) {
    throw new Error("Post-run feedback must bind a real workout in the frozen data scope");
  }
  if (fields.rpeOverrideRef && (fields.rpeOverrideRef.workoutId !== fields.workoutId ||
    Object.keys(fields.rpeOverrideRef).some(key => !["workoutId", "revision"].includes(key)) ||
    !Number.isInteger(fields.rpeOverrideRef.revision) || fields.rpeOverrideRef.revision < 1 ||
    !input.knownRpeOverrides.some(override => override.workoutId === fields.rpeOverrideRef!.workoutId &&
      override.revision === fields.rpeOverrideRef!.revision))) throw new Error("Unknown RPE override revision");
  if ([fields.fatigue, fields.soreness, fields.discomfort, fields.requestedAction,
    fields.interruptionReason, fields.replacementReason, fields.rpeOverrideRef].every(value => value === null)) return null;
  return {
    ...fields, rpeOverrideRef: fields.rpeOverrideRef ? { workoutId: fields.rpeOverrideRef.workoutId, revision: fields.rpeOverrideRef.revision } : null,
    id: input.id, revision: input.revision, scope: { ...input.scope },
    policyVersion: SUBJECTIVE_FEEDBACK_CANDIDATE_VERSION, policyStatus: "candidate",
    localDate, recordedAt: input.recordedAt, availableAt: input.availableAt,
    validUntil: `${shiftCoachDate(localDate, 1)}T00:00:00${ISO_UTC_OFFSET}`, retractedAt: null
  };
}

/** Append a tombstone revision; original event/validity are not rewritten. */
export function retractSubjectiveFeedback(previous: SubjectiveFeedback, input: {
  revision: number; recordedAt: string; availableAt: string;
}): SubjectiveFeedback {
  coachLocalDate(input.recordedAt);
  coachLocalDate(input.availableAt);
  if (input.revision !== previous.revision + 1 || Date.parse(input.recordedAt) < Date.parse(previous.recordedAt) ||
    Date.parse(input.availableAt) < Date.parse(input.recordedAt)) throw new Error("Invalid subjective feedback tombstone revision/time");
  return { ...previous, revision: input.revision, recordedAt: input.recordedAt, availableAt: input.availableAt,
    retractedAt: input.recordedAt };
}

/** Does not read device recovery or produce a fake composite recovery/ability score. */
export function effectiveSubjectiveFeedback(input: {
  asOf: string;
  scope: SubjectiveFeedback["scope"];
  revisions: readonly SubjectiveFeedback[];
}): {
  policyVersion: string; policyStatus: "candidate";
  evidenceStatus: "none" | "available" | "expired";
  activeFeedbackIds: string[];
  restRequested: boolean;
  qualityBlocked: boolean;
  extensionBlocked: boolean;
  reasons: CoachDecisionReason[];
} {
  const today = coachLocalDate(input.asOf);
  const latest = new Map<string, SubjectiveFeedback>();
  const seen = new Map<string, string>();
  for (const revision of input.revisions) {
    if (revision.scope.athleteId !== input.scope.athleteId || revision.scope.datasetEpoch !== input.scope.datasetEpoch ||
      Date.parse(revision.observedAt) > Date.parse(input.asOf) || Date.parse(revision.availableAt) > Date.parse(input.asOf)) continue;
    if (revision.localDate !== coachLocalDate(revision.observedAt) || revision.policyVersion !== SUBJECTIVE_FEEDBACK_CANDIDATE_VERSION) {
      throw new Error("Feedback date/policy identity is not compatible");
    }
    coachLocalDate(revision.availableAt);
    coachLocalDate(revision.recordedAt);
    coachLocalDate(revision.validUntil);
    if (Date.parse(revision.availableAt) < Date.parse(revision.recordedAt) ||
      Date.parse(revision.recordedAt) < Date.parse(revision.observedAt) ||
      Date.parse(revision.validUntil) !== Date.parse(`${shiftCoachDate(revision.localDate, 1)}T00:00:00${ISO_UTC_OFFSET}`)) {
      throw new Error("Feedback availability/validity boundary is not compatible");
    }
    const revisionKey = `${revision.id}:${revision.revision}`;
    const previousDigest = seen.get(revisionKey);
    if (previousDigest && previousDigest !== digest(revision)) throw new Error("Ambiguous feedback revision");
    seen.set(revisionKey, digest(revision));
    const previous = latest.get(revision.id);
    if (!previous || revision.revision > previous.revision) latest.set(revision.id, revision);
  }
  const active = [...latest.values()].filter(revision => revision.phase === "pre_run" &&
    revision.localDate === today && Date.parse(input.asOf) < Date.parse(revision.validUntil) &&
    (!revision.retractedAt || Date.parse(revision.retractedAt) > Date.parse(input.asOf))).sort((a, b) => a.id.localeCompare(b.id));
  const result = {
    policyVersion: SUBJECTIVE_FEEDBACK_CANDIDATE_VERSION, policyStatus: "candidate" as const,
    evidenceStatus: (active.length ? "available" : [...latest.values()].some(row =>
      row.phase === "pre_run" && Date.parse(row.validUntil) <= Date.parse(input.asOf)) ? "expired" : "none") as "none" | "available" | "expired",
    activeFeedbackIds: active.map(revision => revision.id),
    restRequested: false, qualityBlocked: false, extensionBlocked: false, reasons: [] as CoachDecisionReason[]
  };
  for (const revision of active) {
    const evidence = [{ source: "subjective_feedback", id: revision.id, observedAt: revision.observedAt,
      availableAt: revision.availableAt, revisionOrHash: digest(revision) }];
    const reason = (code: string) => result.reasons.push(coachReason(code, SUBJECTIVE_FEEDBACK_CANDIDATE_VERSION,
      [today], { revision: revision.revision }, evidence));
    if (revision.requestedAction === "rest") {
      result.restRequested = true; result.qualityBlocked = true; result.extensionBlocked = true;
      reason("subjective_rest_requested");
    } else if (revision.requestedAction === "easy_only") {
      result.qualityBlocked = true;
      reason("subjective_easy_only_requested");
    }
    if (revision.discomfort === "present" || revision.fatigue === "high" && revision.soreness === "marked") {
      result.qualityBlocked = true; result.extensionBlocked = true;
      reason("subjective_restriction");
    } else if (revision.fatigue === "elevated" || revision.fatigue === "high") reason("subjective_fatigue_reported");
  }
  return result;
}
