import type {
  MobilePlannedDay, TrainingPlanAssociationStatus, TrainingPlanSession, TrainingPlanSessionExecution,
  TrainingPlanSuppression, WorkoutExecutionAssessment
} from "@rai/api-contracts";
import { MOBILE_SESSION_KINDS } from "@rai/contracts";
import { isValidLocalDate } from "./local-date.js";
import { digest } from "./plan-digest.js";
import { normalizeSessionStructure } from "./session-structure.js";

export class TrainingPlanSessionStateError extends Error {}
const fail = (message: string): never => { throw new TrainingPlanSessionStateError(message); };
export const sessionRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface TrainingPlanLockedRestConflict {
  localDate: string;
  lockedKind: MobilePlannedDay["kind"] | null;
  kind: "locked_session_explicit_rest" | "locked_session_week_plan_rest";
  lockedAt: string | null;
  availableAt: string | null;
}

// Inspect raw historical payloads before a strict parser rejects them. Only
// dates and parseable timestamps leave this boundary, never a prescription.
export function trainingPlanLockedRestConflicts(raw: unknown): TrainingPlanLockedRestConflict[] {
  if (!sessionRecord(raw) || !sessionRecord(raw.lockedSession)) return [];
  const lock = raw.lockedSession, date = lock.localDate;
  if (typeof date !== "string" || !isValidLocalDate(date)) return [];
  const lockedPrescription = sessionRecord(lock.session) ? lock.session : null;
  const lockedKind = MOBILE_SESSION_KINDS.find(kind => kind === lockedPrescription?.kind) ?? null;
  const instant = (value: unknown): string | null => typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const conflicts: TrainingPlanLockedRestConflict[] = [];
  if (lockedKind !== "rest" && Array.isArray(raw.weekPlan) && raw.weekPlan.some(day => sessionRecord(day) && day.localDate === date && day.kind === "rest")) {
    conflicts.push({ localDate: date, lockedKind, kind: "locked_session_week_plan_rest", lockedAt: instant(lock.lockedAt), availableAt: null });
  }
  if (Array.isArray(raw.suppressions)) for (const value of raw.suppressions) {
    if (sessionRecord(value) && value.localDate === date && value.reason === "explicit_rest") {
      conflicts.push({ localDate: date, lockedKind, kind: "locked_session_explicit_rest", lockedAt: instant(lock.lockedAt), availableAt: instant(value.availableAt) });
    }
  }
  return conflicts;
}

export function assertTrainingPlanLockedRestInvariant(raw: unknown): void {
  // Legacy can lock rest itself. Its matching rest materialization is one intent,
  // not a running prescription colliding with rest. explicit_rest remains strict.
  const conflicts = trainingPlanLockedRestConflicts(raw);
  if (conflicts.length > 0) {
    const kind = conflicts.some(value => value.kind === "locked_session_explicit_rest") ? "explicit rest" : "weekPlan rest";
    throw new TrainingPlanSessionStateError(
      `training_plan_locked_rest_conflict: ${kind} and locked session share a date: ${conflicts[0]!.localDate}`);
  }
}
export function sessionKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}: unknown field ${key}`);
}
export function sessionId(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) fail(`${path}: non-empty identity required (max 200)`);
  return value as string;
}
export function sessionInstant(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${path}: canonical UTC instant required`);
  }
  return value as string;
}
export function sessionRevision(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${path}: positive safe revision required`);
  return value as number;
}

/** Stored entities never normalize/clamp/drop fields. Legacy nullable structure remains readable. */
export function parseSessionPrescription(value: unknown, path = "prescription"): MobilePlannedDay {
  if (!sessionRecord(value)) return fail(`${path}: object required`);
  sessionKeys(value, ["localDate", "kind", "distanceKm", "structure", "reason"], path);
  if (typeof value.localDate !== "string" || !isValidLocalDate(value.localDate)) fail(`${path}: invalid localDate`);
  if (!(MOBILE_SESSION_KINDS as readonly unknown[]).includes(value.kind)) fail(`${path}: invalid kind`);
  if (value.distanceKm !== null && (typeof value.distanceKm !== "number" || !Number.isFinite(value.distanceKm) || value.distanceKm < 0)) {
    fail(`${path}: distanceKm must be non-negative or null`);
  }
  if (Object.hasOwn(value, "reason") && value.reason !== null && typeof value.reason !== "string") fail(`${path}: invalid reason`);
  if (Object.hasOwn(value, "structure") && value.structure !== null) {
    const normalized = normalizeSessionStructure(value.structure);
    if (normalized === null || digest(normalized) !== digest(value.structure)) fail(`${path}: structure would lose or normalize fields`);
  }
  return structuredClone(value) as unknown as MobilePlannedDay;
}

export function parseTrainingPlanSession(value: unknown, path = "session"): TrainingPlanSession {
  if (!sessionRecord(value)) return fail(`${path}: object required`);
  sessionKeys(value, ["planInstanceId", "sessionId", "sessionRevision", "prescription", "recommendation", "userOverride",
    "protection", "lifecycle", "availableAt", "supersededBySessionId"], path);
  const planInstanceId = sessionId(value.planInstanceId, `${path}.planInstanceId`);
  const id = sessionId(value.sessionId, `${path}.sessionId`);
  const revision = sessionRevision(value.sessionRevision, `${path}.sessionRevision`);
  const prescription = parseSessionPrescription(value.prescription, `${path}.prescription`);
  if (prescription.kind === "rest") fail(`${path}: rest is a day decision, not a running session`);
  if (!["automatic", "user_protected"].includes(value.protection as string)) fail(`${path}: invalid protection`);
  if (!["pending", "completed", "partial", "skipped", "cancelled"].includes(value.lifecycle as string)) fail(`${path}: invalid lifecycle`);
  const availableAt = sessionInstant(value.availableAt, `${path}.availableAt`);
  const superseded = value.supersededBySessionId === null ? null : sessionId(value.supersededBySessionId, `${path}.supersededBySessionId`);
  if (superseded === id) fail(`${path}: a session cannot supersede itself`);
  let recommendation: TrainingPlanSession["recommendation"] = null;
  if (value.recommendation !== null) {
    if (!sessionRecord(value.recommendation)) return fail(`${path}: invalid recommendation`);
    const raw = value.recommendation;
    sessionKeys(raw, ["prescription", "source", "policyHash"], `${path}.recommendation`);
    if (raw.policyHash !== null && (typeof raw.policyHash !== "string" || !/^[a-f0-9]{64}$/i.test(raw.policyHash))) fail(`${path}: invalid policyHash`);
    recommendation = { prescription: parseSessionPrescription(raw.prescription), source: sessionId(raw.source, `${path}.source`),
      policyHash: raw.policyHash as string | null };
  }
  let userOverride: TrainingPlanSession["userOverride"] = null;
  if (value.userOverride !== null) {
    if (!sessionRecord(value.userOverride)) return fail(`${path}: invalid userOverride`);
    const raw = value.userOverride;
    sessionKeys(raw, ["action", "prescription", "availableAt"], `${path}.userOverride`);
    if (!["move", "edit", "add", "cancel", "set_rest", "unlock"].includes(raw.action as string)) fail(`${path}: invalid override action`);
    userOverride = { action: raw.action as NonNullable<TrainingPlanSession["userOverride"]>["action"],
      prescription: parseSessionPrescription(raw.prescription), availableAt: sessionInstant(raw.availableAt, `${path}.userOverride.availableAt`) };
    if (value.protection !== "user_protected" || digest(userOverride.prescription) !== digest(prescription)) fail(`${path}: override/effective intent mismatch`);
  }
  return { planInstanceId, sessionId: id, sessionRevision: revision, prescription, recommendation, userOverride,
    protection: value.protection as TrainingPlanSession["protection"], lifecycle: value.lifecycle as TrainingPlanSession["lifecycle"],
    availableAt, supersededBySessionId: superseded };
}

export interface TrainingPlanSessionFields {
  planInstanceId: string;
  sessions: TrainingPlanSession[];
  suppressions: TrainingPlanSuppression[];
  publishedInputKey: string | null;
}

/** Structural identity/materialization check; B03 owns generation and protection policy. */
export function parseTrainingPlanSessionFields(raw: Record<string, unknown>, weekPlan: MobilePlannedDay[]): TrainingPlanSessionFields {
  assertTrainingPlanLockedRestInvariant(raw);
  const instance = sessionId(raw.planInstanceId, "planInstanceId");
  if (!Array.isArray(raw.sessions) || !Array.isArray(raw.suppressions)) return fail("sessions/suppressions arrays required");
  const sessions = raw.sessions.map((value, i) => parseTrainingPlanSession(value, `sessions[${i}]`));
  const ids = new Set<string>(), dates = new Set<string>();
  for (const session of sessions) {
    if (session.planInstanceId !== instance || ids.has(session.sessionId)) fail("session identity/instance collision");
    ids.add(session.sessionId);
    if (session.lifecycle !== "cancelled" && session.supersededBySessionId === null) {
      const date = session.prescription.localDate;
      if (dates.has(date)) fail(`session date occupied: ${date}`);
      dates.add(date);
      if (!weekPlan.some(day => digest(day) === digest(session.prescription))) fail(`session missing from materialized weekPlan: ${date}`);
    }
  }
  for (const day of weekPlan) if (day.kind !== "rest" && !sessions.some(session => session.lifecycle !== "cancelled" &&
      session.supersededBySessionId === null && digest(day) === digest(session.prescription))) fail(`weekPlan has no session owner: ${day.localDate}`);
  const suppressions = raw.suppressions.map((value, i): TrainingPlanSuppression => {
    if (!sessionRecord(value)) return fail(`suppressions[${i}]: object required`);
    sessionKeys(value, ["localDate", "reason", "sessionId", "availableAt"], `suppressions[${i}]`);
    if (typeof value.localDate !== "string" || !isValidLocalDate(value.localDate)) fail("suppression: invalid date");
    if (!["moved", "cancelled", "explicit_rest"].includes(value.reason as string)) fail("suppression: invalid reason");
    const id = value.sessionId === null ? null : sessionId(value.sessionId, "suppression.sessionId");
    if (id !== null && !ids.has(id)) fail("suppression references a missing session");
    if (value.reason !== "explicit_rest" && id === null) fail("suppression requires session identity");
    if (value.reason === "explicit_rest" && dates.has(value.localDate as string)) fail("explicit rest date occupied");
    return { localDate: value.localDate as string, reason: value.reason as TrainingPlanSuppression["reason"],
      sessionId: id, availableAt: sessionInstant(value.availableAt, "suppression.availableAt") };
  });
  if (raw.publishedInputKey !== null && (typeof raw.publishedInputKey !== "string" || !raw.publishedInputKey.trim())) fail("invalid publishedInputKey");
  return { planInstanceId: instance, sessions, suppressions, publishedInputKey: raw.publishedInputKey as string | null };
}

// ---------------------------------------------------------------------------
// B06 execution rows
// ---------------------------------------------------------------------------

const ASSOCIATION_STATUSES: readonly TrainingPlanAssociationStatus[] =
  ["unlinked", "pending_confirmation", "confirmed", "invalidated"];
const ASSESSMENT_VERSION_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/**
 * Strict reader for a stored execution snapshot. The repository writes only
 * values produced by `assessWorkoutExecution`, but a damaged row must fail the
 * read instead of being served as a guess (an unreadable association is not
 * "unlinked", and a lost assessment is not "unknown").
 */
export function parseWorkoutExecutionAssessment(value: unknown, path = "assessment"): WorkoutExecutionAssessment {
  if (!sessionRecord(value)) return fail(`${path}: object required`);
  sessionKeys(value, ["version", "policyStatus", "localDate", "asOf", "planRevision", "prescriptionDigest",
    "workoutIds", "association", "observation", "evidenceLevel", "dose", "stimulus", "completion", "reasons"], path);
  if (typeof value.version !== "string" || !ASSESSMENT_VERSION_PATTERN.test(value.version)) fail(`${path}: invalid version`);
  if (value.policyStatus !== "candidate") fail(`${path}: invalid policyStatus`);
  if (typeof value.localDate !== "string" || !isValidLocalDate(value.localDate)) fail(`${path}: invalid localDate`);
  sessionInstant(value.asOf, `${path}.asOf`);
  if (value.planRevision !== null && (typeof value.planRevision !== "number" || !Number.isSafeInteger(value.planRevision) || value.planRevision < 1)) {
    fail(`${path}: invalid planRevision`);
  }
  if (value.prescriptionDigest !== null && (typeof value.prescriptionDigest !== "string" || !SHA256_HEX.test(value.prescriptionDigest))) {
    fail(`${path}: invalid prescriptionDigest`);
  }
  if (!Array.isArray(value.workoutIds) || value.workoutIds.some(id => typeof id !== "string" || !id)) fail(`${path}: invalid workoutIds`);
  if (!sessionRecord(value.association)) return fail(`${path}: invalid association`);
  sessionKeys(value.association, ["status", "method", "evidenceRefs"], `${path}.association`);
  if (!["matched", "ambiguous", "unmatched"].includes(value.association.status as string)) fail(`${path}: invalid association status`);
  if (value.association.method !== null && !["measured_steps_with_plan", "valid_receipt", "plan_history"].includes(value.association.method as string)) {
    fail(`${path}: invalid association method`);
  }
  if (!Array.isArray(value.association.evidenceRefs) || value.association.evidenceRefs.some(ref => !sessionRecord(ref))) {
    fail(`${path}: invalid evidenceRefs`);
  }
  if (!["observed", "unknown"].includes(value.observation as string)) fail(`${path}: invalid observation`);
  if (!["measured_steps", "reconstructed_segments", "summary_only", "none"].includes(value.evidenceLevel as string)) {
    fail(`${path}: invalid evidenceLevel`);
  }
  if (!sessionRecord(value.dose)) return fail(`${path}: invalid dose`);
  sessionKeys(value.dose, ["status", "basis", "requiredDistanceMeters", "observedDistanceMeters",
    "requiredWorkSeconds", "observedWorkSeconds", "requiredReps", "verifiedReps"], `${path}.dose`);
  if (!["met", "partial", "not_met", "not_assessable"].includes(value.dose.status as string)) fail(`${path}: invalid dose status`);
  if (value.dose.basis !== null && !["work_steps", "whole_session"].includes(value.dose.basis as string)) fail(`${path}: invalid dose basis`);
  for (const key of ["requiredDistanceMeters", "observedDistanceMeters", "requiredWorkSeconds", "observedWorkSeconds", "requiredReps", "verifiedReps"] as const) {
    const number = value.dose[key];
    if (number !== null && (typeof number !== "number" || !Number.isFinite(number) || number < 0)) fail(`${path}: invalid dose ${key}`);
  }
  if (!sessionRecord(value.stimulus)) return fail(`${path}: invalid stimulus`);
  sessionKeys(value.stimulus, ["status", "channel", "validCoverageFraction", "timeInTargetFraction"], `${path}.stimulus`);
  if (!["matched", "too_hard", "too_easy", "not_assessable"].includes(value.stimulus.status as string)) fail(`${path}: invalid stimulus status`);
  if (value.stimulus.channel !== null && !["pace", "heart_rate"].includes(value.stimulus.channel as string)) fail(`${path}: invalid stimulus channel`);
  for (const key of ["validCoverageFraction", "timeInTargetFraction"] as const) {
    const number = value.stimulus[key];
    if (number !== null && (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 1)) fail(`${path}: invalid stimulus ${key}`);
  }
  if (!["confirmed", "known_not_met", "unconfirmed", "not_applicable"].includes(value.completion as string)) fail(`${path}: invalid completion`);
  if (!Array.isArray(value.reasons) || value.reasons.some(reason => !sessionRecord(reason))) fail(`${path}: invalid reasons`);
  return structuredClone(value) as unknown as WorkoutExecutionAssessment;
}

export function parseTrainingPlanSessionExecution(value: unknown, path = "execution"): TrainingPlanSessionExecution {
  if (!sessionRecord(value)) return fail(`${path}: object required`);
  sessionKeys(value, ["sessionId", "executionRevision", "association", "trainingSessionId", "sourceFactDigest",
    "prescriptionSessionRevision", "assessment", "availableAt", "reasonCodes"], path);
  const id = sessionId(value.sessionId, `${path}.sessionId`);
  const revision = sessionRevision(value.executionRevision, `${path}.executionRevision`);
  if (!ASSOCIATION_STATUSES.includes(value.association as TrainingPlanAssociationStatus)) fail(`${path}: invalid association`);
  const trainingSessionId = value.trainingSessionId === null ? null : sessionId(value.trainingSessionId, `${path}.trainingSessionId`);
  const factDigest = value.sourceFactDigest === null ? null : String(value.sourceFactDigest);
  if (factDigest !== null && !SHA256_HEX.test(factDigest)) fail(`${path}: invalid sourceFactDigest`);
  if (value.association === "confirmed" && (trainingSessionId === null || factDigest === null)) {
    fail(`${path}: a confirmed association requires training session identity and fact digest`);
  }
  if (value.association === "unlinked" && (trainingSessionId !== null || factDigest !== null)) {
    fail(`${path}: an unlinked execution cannot carry a source identity`);
  }
  const prescriptionRevision = sessionRevision(value.prescriptionSessionRevision, `${path}.prescriptionSessionRevision`);
  const assessment = value.assessment === null ? null : parseWorkoutExecutionAssessment(value.assessment, `${path}.assessment`);
  const availableAt = sessionInstant(value.availableAt, `${path}.availableAt`);
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.some(code => typeof code !== "string" || !code || code.length > 100)) {
    fail(`${path}: invalid reasonCodes`);
  }
  return { sessionId: id, executionRevision: revision, association: value.association as TrainingPlanAssociationStatus,
    trainingSessionId, sourceFactDigest: factDigest, prescriptionSessionRevision: prescriptionRevision, assessment,
    availableAt, reasonCodes: [...(value.reasonCodes as string[])] };
}
