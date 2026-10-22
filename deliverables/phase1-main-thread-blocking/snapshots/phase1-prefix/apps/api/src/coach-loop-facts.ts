import type { CoachEvidenceRef } from "@rai/api-contracts";
import { DATABASE_UTC_OFFSET_HOURS } from "@rai/contracts";
import { isValidLocalDate } from "./local-date.js";
import { digest } from "./plan-digest.js";

/** Single workouts, never day aggregates; arrival time is required for eligibility. */
export interface CoachRunFact {
  id: string;
  startedAt: string;
  availableAt: string | null;
  distanceKm: number;
  durationSeconds: number;
  revisionOrHash: string;
}

export interface CoachReservation {
  slotId: string;
  localDate: string;
  allocation: "regular" | "extension" | "other";
  distanceKm: number;
  approvedAt: string;
  status: "pending" | "completed" | "cancelled" | "revoked" | "expired";
  matchedWorkoutIds: string[];
  /** Uncoordinated device schedules still occupy protection/count space. */
  deviceScheduleUnresolved: boolean;
}

export function coachLocalDate(instant: string): string {
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(instant) || !Number.isFinite(Date.parse(instant))) throw new Error("Explicit instant required");
  return new Date(Date.parse(instant) + DATABASE_UTC_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}

export function shiftCoachDate(date: string, days: number): string {
  if (!isValidLocalDate(date) || !Number.isInteger(days)) throw new Error("Invalid coach local date");
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function visibleCoachRuns(facts: readonly CoachRunFact[], asOf: string): CoachRunFact[] {
  const cutoff = Date.parse(asOf);
  coachLocalDate(asOf);
  const unique = new Map<string, CoachRunFact>();
  for (const fact of facts) {
    coachLocalDate(fact.startedAt);
    if (fact.availableAt != null) coachLocalDate(fact.availableAt);
    if (!fact.id || !fact.revisionOrHash || !Number.isFinite(fact.distanceKm) || fact.distanceKm <= 0 ||
      !Number.isFinite(fact.durationSeconds) || fact.durationSeconds <= 0) throw new Error("Invalid coach workout fact");
    if (Date.parse(fact.startedAt) > cutoff || fact.availableAt === null || Date.parse(fact.availableAt) > cutoff) continue;
    const previous = unique.get(fact.id);
    if (previous && digest(previous) !== digest(fact)) throw new Error("Ambiguous coach workout revision");
    unique.set(fact.id, fact);
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id));
}

export const runEvidenceRef = (fact: CoachRunFact): CoachEvidenceRef => ({
  source: "workout", id: fact.id, observedAt: fact.startedAt, availableAt: fact.availableAt, revisionOrHash: fact.revisionOrHash
});

export function visibleCoachReservations(reservations: readonly CoachReservation[], asOf: string): CoachReservation[] {
  const unique = new Map<string, CoachReservation>();
  for (const reservation of reservations) {
    if (!reservation.slotId || !isValidLocalDate(reservation.localDate) ||
      !Number.isFinite(reservation.distanceKm) || reservation.distanceKm <= 0) throw new Error("Invalid coach reservation");
    coachLocalDate(reservation.approvedAt);
    if (Date.parse(reservation.approvedAt) > Date.parse(asOf)) continue;
    const previous = unique.get(reservation.slotId);
    if (previous && digest(previous) !== digest(reservation)) throw new Error("Ambiguous coach decision slot");
    unique.set(reservation.slotId, reservation);
  }
  return [...unique.values()].sort((a, b) => a.localDate.localeCompare(b.localDate) || a.slotId.localeCompare(b.slotId));
}

/** An observed workout replaces its reservation, not its completed extension count. */
export function effectiveCoachReservations(reservations: readonly CoachReservation[], runs: readonly CoachRunFact[]): CoachReservation[] {
  const ids = new Set(runs.map(run => run.id));
  const actualDates = new Set(runs.map(run => coachLocalDate(run.startedAt)));
  return reservations.filter(reservation => {
    if (reservation.matchedWorkoutIds.some(id => ids.has(id))) return false;
    // Any actual running today removes a second automatic session, but not a
    // manual reservation or an unresolved old device schedule.
    if (reservation.allocation !== "other" && actualDates.has(reservation.localDate) && !reservation.deviceScheduleUnresolved) return false;
    return reservation.deviceScheduleUnresolved || reservation.status === "pending" || reservation.status === "completed";
  });
}
