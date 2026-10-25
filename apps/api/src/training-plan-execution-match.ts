import type { TrainingPlanExecutionCandidate } from "@rai/api-contracts";
import { coachLocalDate } from "./coach-loop-facts.js";
import { isValidLocalDate } from "./local-date.js";
import { digest } from "./plan-digest.js";
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

/**
 * Page the filtered facts. The cursor carries the last `(startedAt, id)` pair
 * and is validated against the same scope/range by the caller; it is not a
 * capability token and authorises no write.
 */
export function pageExecutionCandidates(input: {
  facts: readonly ExecutionFact[];
  range: ExecutionRange;
  cursor?: string | null;
  limit?: number;
}): CandidatePage {
  const limit = input.limit ?? TRAINING_PLAN_CLOSED_LOOP_CONTRACT.candidatePageSize;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TRAINING_PLAN_CLOSED_LOOP_CONTRACT.candidatePageSize) {
    throw new Error("candidate page size is out of range");
  }
  let rows = factsInRange(input.facts, input.range);
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== "") {
    const after = parseExecutionCursor(input.cursor);
    rows = rows.filter(fact => fact.startedAt > after.startedAt ||
      (fact.startedAt === after.startedAt && fact.trainingSessionId > after.trainingSessionId));
  }
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    candidates: page.map(fact => ({ trainingSessionId: fact.trainingSessionId,
      sourceFactDigest: fact.sourceFactDigest, startedAt: fact.startedAt, endedAt: fact.endedAt,
      distanceMeters: fact.distanceMeters, durationSeconds: fact.durationSeconds,
      evidence: "needs_confirmation" as const })),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeExecutionCursor({ startedAt: last.startedAt, trainingSessionId: last.trainingSessionId }) : null
  };
}

export interface ExecutionCursor {
  startedAt: string;
  trainingSessionId: string;
}

export function encodeExecutionCursor(cursor: ExecutionCursor): string {
  return Buffer.from(JSON.stringify([cursor.startedAt, cursor.trainingSessionId]), "utf8").toString("base64url");
}

export function parseExecutionCursor(value: string): ExecutionCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string" || typeof parsed[1] !== "string" ||
        !Number.isFinite(Date.parse(parsed[0])) || !parsed[1]) throw new Error("shape");
    return { startedAt: parsed[0], trainingSessionId: parsed[1] };
  } catch {
    throw new Error("execution cursor is invalid");
  }
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
