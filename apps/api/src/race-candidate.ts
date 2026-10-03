import { performanceResultValidationError, raceDistanceMeters, type PerformanceEntryDistance } from "@rai/contracts";

/**
 * Sessions that *look like* a race or a time trial (docs/ALGORITHM.md §12.13).
 *
 * The runner's own decision was "enter historical races by hand **and** confirm
 * existing workouts in one click". This module is the second half: the app proposes,
 * the runner confirms. Nothing here creates a label.
 *
 * What makes a candidate, and why each signal is in the list:
 *
 * - **A standard distance, within tolerance.** The label contract only accepts 5K/10K/
 *   half marathon, so a brilliant 8.3 km run cannot become a label no matter how hard
 *   it was — proposing it would be proposing an entry the API will refuse.
 * - **A plausible race pace.** The same bounds the manual-entry repository enforces.
 *   A signal that can produce an entry the write path rejects is a broken promise.
 * - **Faster than the runner's own median at that distance.** "Looks like a race" is a
 *   claim about *this* runner, not about a population: a 6:00/km half is a race for one
 *   person and an easy long run for another.
 * - **Not already labelled.** A confirmed event is not a candidate.
 *
 * The reasons travel with the candidate so the confirmation screen can show *why* it
 * was proposed: a suggestion the runner cannot audit is a suggestion they cannot trust.
 */

export const RACE_CANDIDATE_POLICY_VERSION = "rai-race-candidate-v2" as const;

/** How far a session may sit from a standard distance and still be proposed. */
export const DISTANCE_TOLERANCE_FRACTION = 0.03;
/** How much faster than the runner's median at that distance counts as "hard". */
export const RELATIVE_PACE_THRESHOLD = 0.05;

export const STANDARD_DISTANCE_METERS: Record<PerformanceEntryDistance, number> = raceDistanceMeters;

export interface RaceCandidateSession {
  trainingSessionId: string;
  completedAt: string;
  /** Local calendar date of the completion, as the entry form wants it. */
  localDate: string;
  distanceMeters: number;
  durationSeconds: number;
  /** True when this session already carries a confirmed race/test label. */
  labelled: boolean;
}

export interface RaceCandidate {
  trainingSessionId: string;
  localDate: string;
  distance: PerformanceEntryDistance;
  actualDistanceMeters: number;
  durationSeconds: number;
  paceSecondsPerKm: number;
  /** `likely` when every signal agrees, `possible` when only distance and pace do. */
  confidence: "likely" | "possible";
  reasons: string[];
}

/** Nearest standard distance within tolerance, or null. */
export function nearestStandardDistance(
  distanceMeters: number
): { distance: PerformanceEntryDistance; deviation: number } | null {
  let best: { distance: PerformanceEntryDistance; deviation: number } | null = null;
  for (const [distance, meters] of Object.entries(STANDARD_DISTANCE_METERS) as Array<
    [PerformanceEntryDistance, number]
  >) {
    const deviation = Math.abs(distanceMeters - meters) / meters;
    if (deviation > DISTANCE_TOLERANCE_FRACTION) continue;
    if (best === null || deviation < best.deviation) best = { distance, deviation };
  }
  return best;
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

/**
 * `localDate|distance` keys for entries the runner already created.
 *
 * A confirmed candidate becomes a *manual entry*, not a flag on the session, so
 * "already labelled" cannot be answered from the session table alone. Without this the
 * same race would be proposed again the moment after it was confirmed.
 */
export const candidateEntryKey = (localDate: string, distance: PerformanceEntryDistance): string =>
  `${localDate}|${distance}`;

export function findRaceCandidates(
  sessions: readonly RaceCandidateSession[],
  options: { existingEntryKeys?: ReadonlySet<string> } = {}
): RaceCandidate[] {
  const eligible = sessions.flatMap((session) => {
    if (session.labelled) return [];
    if (performanceResultValidationError(session.distanceMeters, session.durationSeconds) !== null) return [];
    const standard = nearestStandardDistance(session.distanceMeters);
    if (standard === null) return [];
    if (performanceResultValidationError(STANDARD_DISTANCE_METERS[standard.distance], session.durationSeconds) !== null) return [];
    const paceSecondsPerKm = session.durationSeconds / (session.distanceMeters / 1_000);
    return [{ session, standard, paceSecondsPerKm }];
  });

  // The runner's own median pace per distance, computed from the same eligible set so
  // that "faster than usual" means faster than the runs this module is looking at.
  const paceByDistance = new Map<PerformanceEntryDistance, number[]>();
  for (const item of eligible) {
    const list = paceByDistance.get(item.standard.distance) ?? [];
    list.push(item.paceSecondsPerKm);
    paceByDistance.set(item.standard.distance, list);
  }

  return eligible.flatMap((item) => {
    if (options.existingEntryKeys?.has(candidateEntryKey(item.session.localDate, item.standard.distance))) {
      return [];
    }
    const baseline = median(paceByDistance.get(item.standard.distance) ?? []);
    const reasons: string[] = [
      `距离 ${(item.session.distanceMeters / 1_000).toFixed(2)} km，距标准 ` +
        `${(STANDARD_DISTANCE_METERS[item.standard.distance] / 1_000).toFixed(1)} km ` +
        `${(item.standard.deviation * 100).toFixed(1)}%`
    ];
    const paceText = `${Math.floor(item.paceSecondsPerKm / 60)}:${String(
      Math.round(item.paceSecondsPerKm % 60)
    ).padStart(2, "0")}/km`;
    let hard = false;
    if (baseline !== null) {
      const improvement = (baseline - item.paceSecondsPerKm) / baseline;
      if (improvement >= RELATIVE_PACE_THRESHOLD) {
        hard = true;
        reasons.push(`配速 ${paceText}，比你该距离的中位配速快 ${(improvement * 100).toFixed(1)}%`);
      }
    }
    // A distance-and-pace-only match is still worth proposing — the runner knows
    // whether it was a race — but it is labelled `possible`, not `likely`.
    return [{
      trainingSessionId: item.session.trainingSessionId,
      localDate: item.session.localDate,
      distance: item.standard.distance,
      actualDistanceMeters: item.session.distanceMeters,
      durationSeconds: item.session.durationSeconds,
      paceSecondsPerKm: item.paceSecondsPerKm,
      confidence: hard ? ("likely" as const) : ("possible" as const),
      reasons
    }];
  });
}
