import type { WorkoutExecutionAssessment } from "@rai/api-contracts";
import {
  assessWorkoutExecution, EXECUTION_ASSESSMENT_CANDIDATE_VERSION,
  type CoachExecutionAssociation, type CoachExecutionPrescription, type CoachExecutionWorkout
} from "../apps/api/src/coach-execution-assessment.js";
import { PLAN_REPAIR_CANDIDATE_VERSION, type CoachPlanRepairResult } from "../apps/api/src/coach-plan-repair.js";
import { COACH_POLICY_MANIFEST } from "../apps/api/src/coach-loop-policy.js";
import { digest } from "../apps/api/src/plan-digest.js";
import { executionFixture } from "./coach-execution-fixtures.mjs";
import { replayFrozenCoachSequence, type FrozenCoachEvent, type FrozenCoachSequence } from "./coach-sequence-replay.mjs";
import { runFrozenRepairInput, syntheticRepairEasy, syntheticRepairRest, type FrozenRepairInput } from "./coach-repair-fixtures.mjs";
import { coachReplayInput } from "./coach-replay-scenarios.mjs";

interface ExecutionState {
  asOf: string;
  prescription: CoachExecutionPrescription;
  workouts: readonly CoachExecutionWorkout[];
  associations: readonly CoachExecutionAssociation[];
}
type ExecutionEvent = { kind: "training"; workout: CoachExecutionWorkout } |
  { kind: "association"; association: CoachExecutionAssociation };

const event = <Payload,>(eventId: string, observedAt: string, availableAt: string, payload: Payload): FrozenCoachEvent<Payload> => ({
  eventId, observedAt, availableAt, payload, payloadHash: digest(payload)
});
const executionAdapter = {
  version: EXECUTION_ASSESSMENT_CANDIDATE_VERSION,
  apply(state: ExecutionState, item: FrozenCoachEvent<ExecutionEvent>): ExecutionState {
    return item.payload.kind === "training" ? { ...state, workouts: [...state.workouts, item.payload.workout] }
      : { ...state, associations: [...state.associations, item.payload.association] };
  },
  run: assessWorkoutExecution
};

export function coachExecutionReplays() {
  const fixture = executionFixture();
  const initial: ExecutionState = {
    asOf: "2026-10-05T00:00:00Z", prescription: fixture.prescription, workouts: [], associations: [fixture.association]
  };
  const make = (id: string, workout: CoachExecutionWorkout,
    assertion: { id: string; acceptanceId: string; check(output: WorkoutExecutionAssessment): boolean }) => {
    const sequence: FrozenCoachSequence<ExecutionState, ExecutionEvent, WorkoutExecutionAssessment> = {
      id, version: "synthetic-v1", initialState: initial, initialStateHash: digest(initial), replayMode: "as_known_then",
      policyManifest: { ...COACH_POLICY_MANIFEST },
      events: [event("training", workout.startedAt, workout.availableAt!, { kind: "training", workout })],
      checkpoints: [
        { asOf: "2026-10-05T04:00:00Z", assertions: [{ id: "unknown-not-missed", acceptanceId: "AC2-02",
          check: output => output.observation === "unknown" && output.completion === "unconfirmed" }] },
        { asOf: "2026-10-08T04:00:00Z", assertions: [assertion] },
        { asOf: "2026-10-12T04:00:00Z", assertions: [assertion] }
      ]
    };
    return replayFrozenCoachSequence(sequence, executionAdapter);
  };
  return [
    make("R02-weak-groups-candidate", { ...fixture.workout, evidenceLevel: "reconstructed_segments" }, {
      id: "reconstruction-cannot-confirm", acceptanceId: "AC2-04", check: output =>
        output.observation === "observed" && output.dose.verifiedReps === null && output.completion === "unconfirmed"
    }),
    make("R05-dose-without-signal-candidate", { ...fixture.workout, signalIntervals: [] }, {
      id: "coverage-gap-not-failed", acceptanceId: "AC2-03", check: output =>
        output.dose.status === "met" && output.stimulus.status === "not_assessable" && output.completion === "unconfirmed"
    }),
    (() => {
      const late = { ...fixture.workout, availableAt: "2026-10-09T00:00:00Z" };
      const sequence: FrozenCoachSequence<ExecutionState, ExecutionEvent, WorkoutExecutionAssessment> = {
        id: "R11-late-quality-candidate", version: "synthetic-v1", initialState: initial, initialStateHash: digest(initial),
        replayMode: "as_known_then", policyManifest: { ...COACH_POLICY_MANIFEST },
        events: [event("late-training", late.startedAt, late.availableAt, { kind: "training", workout: late })],
        checkpoints: [
          { asOf: "2026-10-08T04:00:00Z", assertions: [{ id: "not-yet-known", acceptanceId: "AC2-08",
            check: output => output.observation === "unknown" }] },
          { asOf: "2026-10-09T04:00:00Z", assertions: [{ id: "confirm-only-after-arrival", acceptanceId: "AC2-08",
            check: output => output.completion === "confirmed" }] },
          { asOf: "2026-10-12T04:00:00Z", assertions: [{ id: "historical-obligation-kept", acceptanceId: "AC2-08",
            check: output => output.prescriptionDigest === fixture.association.prescriptionDigest && output.completion === "confirmed" }] }
        ]
      };
      return replayFrozenCoachSequence(sequence, executionAdapter);
    })()
  ];
}

export function coachRepairReplays() {
  const previous = [syntheticRepairEasy("2026-10-11"), syntheticRepairEasy("2026-10-12")];
  const initial: FrozenRepairInput = {
    asOf: "2026-10-11T00:00:00Z", previous, candidates: {
      "2026-10-11": [{ ...syntheticRepairRest("2026-10-11"), originDate: null, templateId: "safe-rest", preferenceRank: 1 }]
    }, affectedDates: ["2026-10-11", "2026-10-12"], protectedDates: [], requiredIntentDates: [],
    zones: coachReplayInput().zones, weeklyKm: 20, actualKm: 0, injuryCodes: []
  };
  type Payload = { kind: "volume"; actualKm: number };
  const sequence: FrozenCoachSequence<FrozenRepairInput, Payload, CoachPlanRepairResult> = {
    id: "R10-minimal-repair-candidate", version: "synthetic-v1", initialState: initial,
    initialStateHash: digest(initial), replayMode: "as_known_then", policyManifest: { ...COACH_POLICY_MANIFEST },
    events: [event("sunday-volume", "2026-10-11T01:00:00Z", "2026-10-11T02:00:00Z", { kind: "volume", actualKm: 18 }),
      event("monday-new-week", "2026-10-12T00:00:00Z", "2026-10-12T00:00:00Z", { kind: "volume", actualKm: 0 })],
    checkpoints: [
      { asOf: "2026-10-11T00:30:00Z", assertions: [{ id: "feasible-overlap-kept", acceptanceId: "AC3-02",
        check: output => output.status === "no_change" && output.changes.length === 0 }] },
      { asOf: "2026-10-11T04:00:00Z", assertions: [{ id: "only-sunday-needs-repair", acceptanceId: "AC3-03",
        check: output => output.status === "patched" && output.affectedDates.length === 1 && output.affectedDates[0] === "2026-10-11" }] },
      { asOf: "2026-10-12T04:00:00Z", assertions: [{ id: "no-catch-up-next-week", acceptanceId: "AC3-05",
        check: output => output.status === "no_change" && output.storedDays.length === previous.length &&
          output.storedDays.find(day => day.localDate === "2026-10-12")?.kind === "easy" }] }
    ]
  };
  const adapter = {
    version: PLAN_REPAIR_CANDIDATE_VERSION,
    apply(input: FrozenRepairInput, item: FrozenCoachEvent<Payload>) { return { ...input, actualKm: item.payload.actualKm }; },
    run: runFrozenRepairInput
  };
  return [replayFrozenCoachSequence(sequence, adapter)];
}
