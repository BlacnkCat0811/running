import type { TrainingPlanExecutionCandidate } from "@rai/api-contracts";
import { coachLocalDate } from "./coach-loop-facts.js";
import { isValidLocalDate } from "./local-date.js";
import { digest } from "./plan-digest.js";
import { PlanOperationError } from "./plan-publication.js";
import { TRAINING_PLAN_CLOSED_LOOP_CONTRACT } from "@rai/api-contracts";

/**
 * B06 candidate assembly.
 *
 * A date match is a filter, never an identity. The only evidence this version
 * can certify is a link the user (or a previous command) already confirmed and
 * whose source fact digest still matches; everything else is
 * `needs_confirmation`. That is deliberate: the plan (§8.2 item 1–3) rejects
 * "same day, similar distance, or a schedule receipt" as proof of the actual
 * HealthKit workout, and a wrong automatic link is worse than no link.
 */

/** A running fact as stored in the main library. No plan fields are trusted here. */
export interface ExecutionFact {
  trainingSessionId: string;
  startedAt: string;
  endedAt: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  /** Digest over identity, timing, dose and the fact's own updated_at. */
  sourceFactDigest: string;
}

export interface ExecutionRange {
  rangeStart: string;
  rangeEnd: string;
}

const DAY_MS = 86_400_000;

export function shiftLocalDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Resolve the query window around the session's own local date.
 *
 * Default is the frozen ±2 days; a caller may widen it to at most 31 natural
 * days (inclusive). A range that excludes the session date is rejected: the
 * user is expanding the search for the run that fulfilled this course, not
 * asking for an unrelated timeline.
 */
export function resolveExecutionRange(sessionDate: string, rangeStart?: string | null, rangeEnd?: string | null): ExecutionRange {
  if (!isValidLocalDate(sessionDate)) throw new Error("session localDate is invalid");
  const hasStart = rangeStart !== undefined && rangeStart !== null;
  const hasEnd = rangeEnd !== undefined && rangeEnd !== null;
  if (hasStart !== hasEnd) throw new Error("rangeStart and rangeEnd must be provided together");
  if (!hasStart) {
    return { rangeStart: shiftLocalDate(sessionDate, -TRAINING_PLAN_CLOSED_LOOP_CONTRACT.candidateDaysBefore),
      rangeEnd: shiftLocalDate(sessionDate, TRAINING_PLAN_CLOSED_LOOP_CONTRACT.candidateDaysAfter) };
  }
  if (!isValidLocalDate(rangeStart!) || !isValidLocalDate(rangeEnd!)) throw new Error("range is not a real local date");
  const days = Math.round((Date.parse(`${rangeEnd!}T00:00:00Z`) - Date.parse(`${rangeStart!}T00:00:00Z`)) / DAY_MS) + 1;
  if (days < 1 || days > TRAINING_PLAN_CLOSED_LOOP_CONTRACT.candidateMaxRangeDays) {
    throw new Error(`range must span 1..${TRAINING_PLAN_CLOSED_LOOP_CONTRACT.candidateMaxRangeDays} natural days`);
  }
  if (sessionDate < rangeStart! || sessionDate > rangeEnd!) throw new Error("range must include the session date");
  return { rangeStart: rangeStart!, rangeEnd: rangeEnd! };
}

const factDate = (fact: ExecutionFact): string => coachLocalDate(fact.startedAt);

/** Stable digest of a main-library fact; a correction or re-import changes it. */
export function executionFactDigest(input: {
  trainingSessionId: string;
  startedAt: string;
  endedAt: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  updatedAt: string;
}): string {
  return digest({ contract: "rai-training-execution-fact-v1", ...input });
}

export function factsInRange(facts: readonly ExecutionFact[], range: ExecutionRange): ExecutionFact[] {
  return facts.filter(fact => {
    const date = factDate(fact);
    return date >= range.rangeStart && date <= range.rangeEnd;
  }).sort((left, right) => left.startedAt.localeCompare(right.startedAt) ||
    left.trainingSessionId.localeCompare(right.trainingSessionId));
}

export interface CandidatePage {
  candidates: TrainingPlanExecutionCandidate[];
  nextCursor: string | null;
}

/** Stable digest over every fact that can appear in a candidate page. */
export function executionCandidateFactsDigest(facts: readonly ExecutionFact[], range: ExecutionRange): string {
  return digest({ contract: "rai-training-plan-execution-candidates-v1",
    rangeStart: range.rangeStart, rangeEnd: range.rangeEnd,
    facts: factsInRange(facts, range).map(fact => ({
      trainingSessionId: fact.trainingSessionId, startedAt: fact.startedAt, endedAt: fact.endedAt,
      distanceMeters: fact.distanceMeters, durationSeconds: fact.durationSeconds,
      sourceFactDigest: fact.sourceFactDigest
    })) });
}

/**
 * A cursor is a continuation token, not a capability token: it authorises no
 * write and is only accepted for the exact contract, scope, range and fact set
 * that produced it. Clients must restart from page 1 when any of those change.
 */
export class ExecutionCursorError extends PlanOperationError {
  constructor(message = "执行候选游标非法，请重新读取。") {
    super("training_session_command_invalid", message, 422);
    this.name = "ExecutionCursorError";
  }
}

export interface ExecutionCursorContext {
  /** Canonical scope key supplied by the caller (same string used for control rows). */
  scope?: string | null;
  range: ExecutionRange;
  /** Digest of the full candidate fact set in `range`, not just the current page. */
  factsDigest: string;
}

/**
 * Page the filtered facts with stable `(startedAt, trainingSessionId)` ordering.
 * `scope` is required as soon as a cursor is issued or consumed: the pure
 * function cannot infer a data-domain identity from the facts themselves.
 */
export function pageExecutionCandidates(input: {
  facts: readonly ExecutionFact[];
  range: ExecutionRange;
  scope?: string | null;
  cursor?: string | null;
  limit?: number;
}): CandidatePage {
  const limit = input.limit ?? TRAINING_PLAN_CLOSED_LOOP_CONTRACT.candidatePageSize;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TRAINING_PLAN_CLOSED_LOOP_CONTRACT.candidatePageSize) {
    throw new Error("candidate page size is out of range");
  }
  const rows = factsInRange(input.facts, input.range);
  const factsDigest = executionCandidateFactsDigest(input.facts, input.range);
  const hasCursor = input.cursor !== undefined && input.cursor !== null && input.cursor !== "";
  if ((hasCursor || rows.length > limit) && (typeof input.scope !== "string" || input.scope.length === 0)) {
    throw new ExecutionCursorError("候选游标缺少 scope 上下文，请重新读取候选。");
  }
  let pageRows = rows;
  if (hasCursor) {
    const after = parseExecutionCursor(input.cursor!, {
      scope: input.scope!, range: input.range, factsDigest
    });
    pageRows = rows.filter(fact => fact.startedAt > after.startedAt ||
      (fact.startedAt === after.startedAt && fact.trainingSessionId > after.trainingSessionId));
  }
  const page = pageRows.slice(0, limit);
  const last = page.at(-1);
  return {
    candidates: page.map(fact => ({ trainingSessionId: fact.trainingSessionId,
      sourceFactDigest: fact.sourceFactDigest, startedAt: fact.startedAt, endedAt: fact.endedAt,
      distanceMeters: fact.distanceMeters, durationSeconds: fact.durationSeconds,
      evidence: "needs_confirmation" as const })),
    nextCursor: pageRows.length > limit && last !== undefined
      ? encodeExecutionCursor({ startedAt: last.startedAt, trainingSessionId: last.trainingSessionId }, {
        scope: input.scope!, range: input.range, factsDigest
      }) : null
  };
}

export interface ExecutionCursor {
  startedAt: string;
  trainingSessionId: string;
}

const EXECUTION_CURSOR_CONTRACT = "rai-training-plan-execution-cursor-v1";
const EXECUTION_CURSOR_VERSION = TRAINING_PLAN_CLOSED_LOOP_CONTRACT.executionCommands.version;
const CURSOR_BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Encode a continuation token bound to the exact query that issued it. */
export function encodeExecutionCursor(cursor: ExecutionCursor, context: ExecutionCursorContext): string {
  if (typeof context.scope !== "string" || context.scope.length === 0) {
    throw new ExecutionCursorError("候选游标缺少 scope 上下文，请重新读取候选。");
  }
  return Buffer.from(JSON.stringify({
    contract: EXECUTION_CURSOR_CONTRACT,
    version: EXECUTION_CURSOR_VERSION,
    scope: context.scope,
    rangeStart: context.range.rangeStart,
    rangeEnd: context.range.rangeEnd,
    factsDigest: context.factsDigest,
    startedAt: cursor.startedAt,
    trainingSessionId: cursor.trainingSessionId
  }), "utf8").toString("base64url");
}

/**
 * Decode and validate a cursor. With `expected`, the contract/scope/range/fact
 * binding is enforced; without it only structural validity and the cursor
 * contract version are checked (useful for diagnostics/tests).
 */
export function parseExecutionCursor(value: string, expected?: ExecutionCursorContext): ExecutionCursor {
  let payload: Record<string, unknown>;
  try {
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || !CURSOR_BASE64URL.test(value)) {
      throw new Error("base64url");
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length === 0 || bytes.toString("base64url") !== value) throw new Error("base64url");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new ExecutionCursorError("执行候选游标格式非法，请重新读取。");
  }
  if (payload.contract !== EXECUTION_CURSOR_CONTRACT || payload.version !== EXECUTION_CURSOR_VERSION ||
      typeof payload.scope !== "string" || payload.scope.length === 0 ||
      typeof payload.rangeStart !== "string" || !isValidLocalDate(payload.rangeStart) ||
      typeof payload.rangeEnd !== "string" || !isValidLocalDate(payload.rangeEnd) ||
      typeof payload.factsDigest !== "string" || !/^[a-f0-9]{64}$/.test(payload.factsDigest) ||
      typeof payload.startedAt !== "string" || !Number.isFinite(Date.parse(payload.startedAt)) ||
      typeof payload.trainingSessionId !== "string" || payload.trainingSessionId.length === 0) {
    throw new ExecutionCursorError("执行候选游标格式非法，请重新读取。");
  }
  if (expected !== undefined) {
    if (payload.scope !== expected.scope || payload.rangeStart !== expected.range.rangeStart ||
        payload.rangeEnd !== expected.range.rangeEnd || payload.factsDigest !== expected.factsDigest) {
      throw new ExecutionCursorError("执行候选游标与当前 scope、范围或事实不匹配，请重新读取候选。");
    }
  }
  return { startedAt: payload.startedAt, trainingSessionId: payload.trainingSessionId };
}

/**
 * Choose the assessment lifecycle from a real, confirmed association.
 *
 * `completed` means "a linked, ended actual run exists" — not that dose and
 * stimulus were met. Only explicit insufficient-dose evidence becomes
 * `partial`; unknown dose stays `completed` with an unknown assessment.
 */
export function lifecycleForAssessment(assessment: { dose: { status: string } } | null): "completed" | "partial" {
  return assessment?.dose.status === "partial" || assessment?.dose.status === "not_met" ? "partial" : "completed";
}
