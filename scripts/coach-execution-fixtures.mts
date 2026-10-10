import type { CoachEvidenceRef, MobileSessionKind, WorkoutSegment } from "@rai/api-contracts";
import type { CoachExecutionAssociation, CoachExecutionPrescription, CoachExecutionWorkout } from "../apps/api/src/coach-execution-assessment.js";
import { buildSessionStructure } from "../apps/api/src/mobile-coach.js";
import { buildCompleteEasyStructure } from "../apps/api/src/coach-session-dose.js";
import { flattenStructure } from "../apps/api/src/workout-segments.js";
import { prescriptionDigest } from "../apps/api/src/plan-digest.js";
import { coachReplayInput } from "./coach-replay-scenarios.mjs";

/** Frozen synthetic measurements for candidate tests/replay; no health database. */
export const EXECUTION_AS_OF = "2026-10-08T04:00:00Z";
export const executionEvidenceRef = (source: string, id: string, observedAt = "2026-10-07T00:00:00Z", availableAt = observedAt): CoachEvidenceRef => ({
  source, id, observedAt, availableAt, revisionOrHash: `synthetic-${id}-v1`
});

export function executionFixture(kind: MobileSessionKind = "interval") {
  const zones = coachReplayInput().zones;
  const structure = kind === "easy" || kind === "recovery" ? buildCompleteEasyStructure(kind, zones) :
    buildSessionStructure(kind, zones, { targetDistanceKm: 8 });
  const prescription: CoachExecutionPrescription = {
    day: { localDate: "2026-10-08", kind, distanceKm: 8, structure, reason: "synthetic" },
    revision: 1, createdAt: "2026-10-07T00:00:00Z", availableAt: "2026-10-07T00:00:00Z",
    evidenceRef: executionEvidenceRef("plan_history", "plan-1")
  };
  let offset = 0;
  const segments: WorkoutSegment[] = structure ? flattenStructure(structure).map(({ step }, index) => {
    const pace = step.purpose === "work" ? kind === "interval" ? 255 : kind === "tempo" ? 285 : 390 : 390;
    const durationSeconds = step.goal.type === "time" ? step.goal.seconds :
      step.goal.type === "distance" ? step.goal.meters / 1000 * pace : 0;
    const meters = step.goal.type === "distance" ? step.goal.meters : durationSeconds / pace * 1000;
    const segment: WorkoutSegment = {
      index: index + 1, label: step.purpose, purpose: step.purpose, goalType: step.goal.type,
      goalMeters: step.goal.type === "distance" ? step.goal.meters : null,
      goalSeconds: step.goal.type === "time" ? step.goal.seconds : null,
      alertKind: step.alert?.kind ?? null, alertLower: step.alert?.lower ?? null, alertUpper: step.alert?.upper ?? null,
      startOffsetSeconds: offset, durationSeconds, distanceMeters: meters,
      averagePaceSecondsPerKm: pace, averageHeartRateBpm: 140, averageCadenceSpm: null
    };
    offset += durationSeconds;
    return segment;
  }) : [];
  const workout: CoachExecutionWorkout = {
    id: "synthetic-workout", startedAt: "2026-10-08T01:00:00Z",
    endedAt: new Date(Date.parse("2026-10-08T01:00:00Z") + offset * 1000).toISOString(),
    availableAt: "2026-10-08T03:00:00Z", durationSeconds: offset,
    distanceMeters: segments.reduce((sum, segment) => sum + segment.distanceMeters, 0),
    evidenceLevel: "measured_steps", measuredStepsComplete: true, segments,
    signalIntervals: segments.filter(segment => segment.purpose === "work").map(segment => ({
      channel: "pace", startOffsetSeconds: segment.startOffsetSeconds,
      durationSeconds: segment.durationSeconds, value: segment.averagePaceSecondsPerKm!,
      availableAt: "2026-10-08T03:00:00Z"
    })), evidenceRef: executionEvidenceRef("workout", "synthetic-workout", "2026-10-08T01:00:00Z", "2026-10-08T03:00:00Z")
  };
  const association: CoachExecutionAssociation = {
    workoutId: workout.id, prescriptionDigest: prescriptionDigest(kind, structure), method: "measured_steps_with_plan",
    validFrom: prescription.createdAt, validUntil: null, availableAt: prescription.availableAt,
    retractedAt: null, evidenceRef: executionEvidenceRef("measured_steps_with_plan", "binding")
  };
  return { prescription, workout, association };
}

