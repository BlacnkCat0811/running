import { randomUUID } from "node:crypto";

import type { MobilePlannedDay, TrainingPlanSession, TrainingPlanSessionExecution, TrainingPlanSuppression } from "@rai/api-contracts";

import { isValidLocalDate } from "./local-date.js";
import { digest } from "./plan-digest.js";
import { assertTrainingPlanLockedRestInvariant, parseSessionPrescription, TrainingPlanSessionStateError } from "./training-plan-session-state.js";
import type { TrainingPlanSessionState, TrainingPlanState } from "./training-plan-store.js";

/**
 * B03 / S01-02: the one resolver between a generated week and stable sessions.
 *
 * The generator owns **automatic** running days. It may never edit a
 * `user_protected` course, a completed/partial/skipped course, a cancelled
 * decision, an explicit rest day or a moved source date. Those are the user's
 * decisions and are carried through field by field.
 *
 * Boundaries, deliberately small:
 * - input is already parsed state (schema 2) plus one generated candidate window;
 * - no database, clock, HTTP or device access; the caller supplies `availableAt`;
 * - adding a session allocates one opaque server ID (injectable for fixtures);
 * - an automatic session the generator no longer wants is archived (its frozen
 *   revision stays in `mobile_training_session_history`, which is append-only),
 *   never silently overwritten and never re-used for a different course;
 * - `weekPlan` is a materialization of the resolved sessions and rest decisions,
 *   never an independent edit surface.
 *
 * This is not a second planner. It does not choose training content; it enforces
 * ownership, occupancy and the source-day suppression contract around content the
 * existing generator produced.
 */

export interface TrainingPlanSessionRecommendationSource {
  source: string;
  policyHash: string | null;
}

export interface ResolveTrainingPlanSessionsInput {
  state: TrainingPlanSessionState;
  /** Current execution rows retain their course identity and prescription for review/correction. */
  executions?: readonly TrainingPlanSessionExecution[];
  /** Candidate days for the current window. May be sparse in fixtures, never duplicated. */
  generatedDays: readonly MobilePlannedDay[];
  businessDate: string;
  /** Canonical UTC instant used as `availableAt` for newly allocated sessions. */
  availableAt: string;
  recommendation?: TrainingPlanSessionRecommendationSource;
  allocateSessionId?: () => string;
}

export interface ResolvedTrainingPlanSessions {
  sessions: TrainingPlanSession[];
  suppressions: TrainingPlanSuppression[];
  weekPlan: MobilePlannedDay[];
  /** Whole protected prescriptions the generator must count first (inside the candidate window). */
  protectedDays: MobilePlannedDay[];
  createdSessionIds: string[];
  archivedSessionIds: string[];
  warnings: string[];
}

const activeSession = (session: TrainingPlanSession): boolean =>
  session.supersededBySessionId === null && session.lifecycle !== "cancelled";

const rest = (localDate: string, reason: string): MobilePlannedDay => ({
  localDate, kind: "rest", distanceKm: null, structure: null, reason
});


/** The locked prescription as a plan day; extra display fields are not part of the prescription. */
function lockedSessionDay(lock: NonNullable<TrainingPlanSessionState["lockedSession"]>): MobilePlannedDay {
  return { localDate: lock.localDate, kind: lock.session.kind, distanceKm: lock.session.distanceKm,
    structure: lock.session.structure === null ? null : structuredClone(lock.session.structure),
    reason: lock.session.reason.length > 0 ? lock.session.reason : "今日锁课" };
}

const suppressionReason = (reason: TrainingPlanSuppression["reason"]): string => {
  if (reason === "moved") return "课程已改期；源日不自动补课。";
  if (reason === "cancelled") return "课程已取消；不自动复活。";
  return "用户指定休息。";
};

function assertInput(input: ResolveTrainingPlanSessionsInput): void {
  if (!isValidLocalDate(input.businessDate)) throw new TrainingPlanSessionStateError("resolver: invalid businessDate");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.availableAt) ||
      !Number.isFinite(Date.parse(input.availableAt)) || new Date(input.availableAt).toISOString() !== input.availableAt) {
    throw new TrainingPlanSessionStateError("resolver: canonical availableAt instant required");
  }
  const dates = new Set<string>();
  for (const [index, day] of input.generatedDays.entries()) {
    const parsed = parseSessionPrescription(day, `generatedDays[${index}]`);
    if (dates.has(parsed.localDate)) throw new TrainingPlanSessionStateError(`resolver: duplicate generated date ${parsed.localDate}`);
    dates.add(parsed.localDate);
  }
  // Fail closed on a state the strict reader also rejects: a locked prescription
  // and an explicit rest decision must never claim the same day (the budget would
  // reserve the locked course while the plan materializes rest).
  assertTrainingPlanLockedRestInvariant(input.state);
}

/**
 * Resolve one generated window into sessions, suppressions and the compatibility
 * materialization. The function is total for valid input: it either returns a
 * consistent snapshot or throws, never a partially applied plan.
 */
export function resolveTrainingPlanSessions(input: ResolveTrainingPlanSessionsInput): ResolvedTrainingPlanSessions {
  assertInput(input);
  const { state } = input;
  const allocate = input.allocateSessionId ?? (() => `session-${randomUUID()}`);
  const recommendationPolicyHash = input.recommendation?.policyHash !== null &&
    input.recommendation?.policyHash !== undefined && /^[a-f0-9]{64}$/i.test(input.recommendation.policyHash)
    ? input.recommendation.policyHash : null;
  const warnings: string[] = [];
  const createdSessionIds: string[] = [];
  const archivedSessionIds: string[] = [];
  const generated = input.generatedDays.map(day => structuredClone(day));

  const previous = state.sessions.map(session => structuredClone(session));
  const byId = new Map(previous.map(session => [session.sessionId, session]));
  const active = previous.filter(activeSession);
  if (active.length !== new Set(active.map(session => session.prescription.localDate)).size) {
    throw new TrainingPlanSessionStateError("resolver: two active sessions occupy the same date");
  }

  const suppressionByDate = new Map(state.suppressions.map(value => [value.localDate, value]));
  for (const [date, suppression] of suppressionByDate) {
    if (suppression.reason === "explicit_rest" && active.some(session => session.prescription.localDate === date)) {
      throw new TrainingPlanSessionStateError(`resolver: explicit rest date ${date} is occupied`);
    }
  }

  const protectedByDate = new Map(active.filter(session => session.protection === "user_protected")
    .map(session => [session.prescription.localDate, session]));
  const executionSessionIds = new Set(input.executions?.map(execution => execution.sessionId));
  const frozenByDate = new Map(active.filter(session => session.lifecycle !== "pending" || executionSessionIds.has(session.sessionId))
    .map(session => [session.prescription.localDate, session]));

  const windowDates = new Set(generated.map(day => day.localDate));
  const effective = new Map<string, MobilePlannedDay>();

  for (const day of generated) {
    const date = day.localDate;
    const protectedSession = protectedByDate.get(date);
    const frozen = frozenByDate.get(date);
    const suppression = suppressionByDate.get(date);
    if (protectedSession) {
      effective.set(date, structuredClone(protectedSession.prescription));
      if (day.kind !== "rest" && digest(day) !== digest(protectedSession.prescription)) {
        warnings.push(`${date} 保留用户保护课程；生成候选不得替换该课。`);
      }
      continue;
    }
    if (frozen) {
      effective.set(date, structuredClone(frozen.prescription));
      if (day.kind !== "rest" && digest(day) !== digest(frozen.prescription)) {
        warnings.push(`${date} 已执行、已跳过或有执行关联记录的课程保留原处方；生成候选不得改写。`);
      }
      continue;
    }
    if (suppression) {
      effective.set(date, rest(date, suppressionReason(suppression.reason)));
      if (day.kind !== "rest") warnings.push(`${date} 受${suppression.reason === "moved" ? "改期源日" : suppression.reason === "cancelled" ? "取消" : "明确休息"}抑制；生成候选未排课。`);
      continue;
    }
    const lock = state.lockedSession?.localDate === date ? state.lockedSession : null;
    if (lock) {
      const lockedDay = lockedSessionDay(lock);
      effective.set(date, lockedDay);
      if (day.kind !== "rest" && digest(day) !== digest(lockedDay)) {
        warnings.push(`${date} 保留今日锁课；生成候选不得替换。`);
      }
      continue;
    }
    effective.set(date, structuredClone(day));
  }

  // Automatic sessions inside the generated window are reconciled against the
  // effective day. Equal content keeps the same identity and revision; a genuine
  // replacement gets a new ID and leaves an explicit superseded relation.
  const automaticByDate = new Map(active.filter(session => session.protection === "automatic" &&
    session.lifecycle === "pending").map(session => [session.prescription.localDate, session]));
  const sessions: TrainingPlanSession[] = [];
  const materialized = new Map<string, MobilePlannedDay>();

  for (const session of previous) {
    const date = session.prescription.localDate;
    if (!activeSession(session)) {
      sessions.push(session);
      continue;
    }
    if (protectedByDate.has(date) || frozenByDate.has(date)) {
      sessions.push(session);
      materialized.set(date, structuredClone(session.prescription));
      continue;
    }
    const target = effective.get(date);
    if (target && target.kind !== "rest") {
      if (session.protection === "automatic" && session.lifecycle === "pending") {
        if (digest(session.prescription) === digest(target)) {
          sessions.push(session);
          materialized.set(date, structuredClone(session.prescription));
        } else {
          const replacement: TrainingPlanSession = {
            planInstanceId: state.planInstanceId,
            sessionId: allocate(),
            sessionRevision: 1,
            prescription: structuredClone(target),
            recommendation: { prescription: structuredClone(target), source: input.recommendation?.source ?? "heuristic",
              policyHash: recommendationPolicyHash },
            userOverride: null,
            protection: "automatic",
            lifecycle: "pending",
            availableAt: input.availableAt,
            supersededBySessionId: null
          };
          sessions.push({ ...session, sessionRevision: session.sessionRevision + 1,
            supersededBySessionId: replacement.sessionId, availableAt: input.availableAt });
          sessions.push(replacement);
          createdSessionIds.push(replacement.sessionId);
          materialized.set(date, structuredClone(replacement.prescription));
          warnings.push(`${date} 自动课内容变化：新课程 ${replacement.sessionId}，旧课程保留 superseded 关系。`);
        }
      } else {
        sessions.push(session);
        materialized.set(date, structuredClone(session.prescription));
      }
      continue;
    }
    // No effective course: only an unexecuted automatic course may leave the
    // current payload. Its frozen revision remains queryable in session history.
    if (session.protection === "automatic" && session.lifecycle === "pending" &&
        (windowDates.has(date) || date < input.businessDate)) {
      archivedSessionIds.push(session.sessionId);
      warnings.push(`${date} 自动课已由重算归档；历史修订保留，不伪造取消或跳过。`);
    } else {
      sessions.push(session);
      materialized.set(date, structuredClone(session.prescription));
    }
  }

  // New automatic sessions for generated running days that have no owner yet.
  for (const [date, day] of effective) {
    if (day.kind === "rest" || materialized.has(date) || sessions.some(session => activeSession(session) &&
      session.prescription.localDate === date)) continue;
    if (suppressionByDate.has(date) || protectedByDate.has(date)) continue;
    const session: TrainingPlanSession = {
      planInstanceId: state.planInstanceId,
      sessionId: allocate(),
      sessionRevision: 1,
      prescription: structuredClone(day),
      recommendation: { prescription: structuredClone(day), source: input.recommendation?.source ?? "heuristic",
        policyHash: recommendationPolicyHash },
      userOverride: null,
      protection: "automatic",
      lifecycle: "pending",
      availableAt: input.availableAt,
      supersededBySessionId: null
    };
    sessions.push(session);
    createdSessionIds.push(session.sessionId);
    materialized.set(date, structuredClone(day));
  }

  // Keep future protections/suppressions outside the generated window; past
  // decisions are already frozen in history and no longer bind a new candidate.
  const suppressions = state.suppressions.filter(value => value.localDate >= input.businessDate)
    .map(value => ({ ...value }));

  const weekPlan = new Map<string, MobilePlannedDay>();
  for (const [date, day] of materialized) weekPlan.set(date, day);
  for (const [date, day] of effective) {
    if (!weekPlan.has(date)) weekPlan.set(date, day);
  }
  for (const suppression of suppressions) {
    if (suppression.reason === "explicit_rest" && !weekPlan.has(suppression.localDate)) {
      weekPlan.set(suppression.localDate, rest(suppression.localDate, suppressionReason("explicit_rest")));
    }
  }
  for (const session of sessions) {
    if (!activeSession(session)) continue;
    if (!weekPlan.has(session.prescription.localDate)) weekPlan.set(session.prescription.localDate, structuredClone(session.prescription));
  }

  const protectedDays = [...protectedByDate.values()]
    .filter(session => windowDates.has(session.prescription.localDate))
    .map(session => structuredClone(session.prescription));
  for (const session of frozenByDate.values()) {
    if (windowDates.has(session.prescription.localDate) && !protectedDays.some(day => day.localDate === session.prescription.localDate)) {
      protectedDays.push(structuredClone(session.prescription));
    }
  }

  // One last structural check: no orphan/superseded/cancelled course is
  // materialized as an active day, and every materialized running day is owned.
  for (const [date, day] of weekPlan) {
    if (day.kind === "rest") continue;
    const owners = sessions.filter(session => activeSession(session) && session.prescription.localDate === date);
    if (owners.length !== 1) throw new TrainingPlanSessionStateError(`resolver: ${date} must have exactly one active session owner`);
    if (digest(owners[0]!.prescription) !== digest(day)) throw new TrainingPlanSessionStateError(`resolver: ${date} materialization differs from its owner`);
  }
  for (const session of sessions) {
    if (!activeSession(session)) continue;
    if (!weekPlan.has(session.prescription.localDate)) throw new TrainingPlanSessionStateError("resolver: active session missing from weekPlan");
  }

  return {
    sessions,
    suppressions,
    weekPlan: [...weekPlan.values()].sort((left, right) => left.localDate.localeCompare(right.localDate)),
    protectedDays,
    createdSessionIds,
    archivedSessionIds,
    warnings
  };
}

/** All active whole-course protections, for callers that only need the budget input. */
export function trainingPlanProtectedDays(state: TrainingPlanState | null,
  executions: readonly TrainingPlanSessionExecution[] = []): MobilePlannedDay[] {
  if (state === null || state.schemaVersion !== 2) return [];
  assertTrainingPlanLockedRestInvariant(state);
  const executionSessionIds = new Set(executions.map(execution => execution.sessionId));
  const days = state.sessions.filter(activeSession).filter(session => session.protection === "user_protected" ||
    session.lifecycle !== "pending" || executionSessionIds.has(session.sessionId)).map(session => structuredClone(session.prescription));
  if (state.lockedSession !== null && !days.some(day => day.localDate === state.lockedSession!.localDate)) {
    days.push(lockedSessionDay(state.lockedSession));
  }
  for (const suppression of state.suppressions) {
    if (suppression.reason === "explicit_rest" && !days.some(day => day.localDate === suppression.localDate)) {
      days.push(rest(suppression.localDate, suppressionReason("explicit_rest")));
    }
  }
  return days;
}

/** Occupancy check used before an edit/preview contract exists. */
export function trainingPlanDateOccupied(state: TrainingPlanSessionState, localDate: string): boolean {
  if (state.sessions.some(session => activeSession(session) && session.prescription.localDate === localDate)) return true;
  return state.suppressions.some(value => value.localDate === localDate);
}
