import type { CoachGoalGap, CoachPredictionSummary, SubjectiveFeedback } from "@rai/api-contracts";
import {
  buildSubjectiveFeedback, effectiveSubjectiveFeedback, retractSubjectiveFeedback, SUBJECTIVE_FEEDBACK_CANDIDATE_VERSION
} from "../apps/api/src/coach-subjective-feedback.js";
import { coachGoalGap, GOAL_GAP_CANDIDATE_VERSION, type CoachPredictionIdentity } from "../apps/api/src/coach-goal-gap.js";
import { COACH_POLICY_MANIFEST } from "../apps/api/src/coach-loop-policy.js";
import { digest } from "../apps/api/src/plan-digest.js";
import { replayFrozenCoachSequence, type FrozenCoachEvent, type FrozenCoachSequence } from "./coach-sequence-replay.mjs";

const event = <Payload,>(eventId: string, observedAt: string, availableAt: string, payload: Payload): FrozenCoachEvent<Payload> => ({
  eventId, observedAt, availableAt, payload, payloadHash: digest(payload)
});

export function coachFeedbackReplays() {
  const scope = { athleteId: "synthetic", datasetEpoch: "synthetic-v1" };
  const original = buildSubjectiveFeedback({
    id: "synthetic-rest", revision: 1, scope,
    fields: { phase: "pre_run", workoutId: null, observedAt: "2026-10-08T01:00:00Z",
      fatigue: null, soreness: null, discomfort: null, requestedAction: "rest",
      interruptionReason: null, replacementReason: null, rpeOverrideRef: null },
    recordedAt: "2026-10-08T02:00:00Z", availableAt: "2026-10-08T02:00:00Z",
    knownWorkoutIds: [], knownRpeOverrides: []
  })!;
  const tombstone = retractSubjectiveFeedback(original, {
    revision: 2, recordedAt: "2026-10-08T05:00:00Z", availableAt: "2026-10-08T05:00:00Z"
  });
  const late = buildSubjectiveFeedback({
    id: "synthetic-late-fatigue", revision: 1, scope,
    fields: { phase: "pre_run", workoutId: null, observedAt: "2026-10-09T01:00:00Z",
      fatigue: "high", soreness: "marked", discomfort: null, requestedAction: "rest",
      interruptionReason: null, replacementReason: null, rpeOverrideRef: null },
    recordedAt: "2026-10-10T01:00:00Z", availableAt: "2026-10-10T01:00:00Z",
    knownWorkoutIds: [], knownRpeOverrides: []
  })!;
  type State = { asOf: string; scope: typeof scope; revisions: SubjectiveFeedback[] };
  type Output = ReturnType<typeof effectiveSubjectiveFeedback>;
  const initial: State = { asOf: "2026-10-05T00:00:00Z", scope, revisions: [] };
  const sequence: FrozenCoachSequence<State, SubjectiveFeedback, Output> = {
    id: "R06-feedback-time-candidate", version: "synthetic-v1", initialState: initial, initialStateHash: digest(initial),
    replayMode: "as_known_then", policyManifest: { ...COACH_POLICY_MANIFEST },
    events: [event("feedback", original.observedAt, original.availableAt, original),
      event("retraction", tombstone.retractedAt!, tombstone.availableAt, tombstone),
      event("late-feedback", late.observedAt, late.availableAt, late)],
    checkpoints: [
      { asOf: "2026-10-08T04:00:00Z", assertions: [{ id: "explicit-stop-honored", acceptanceId: "AC5-04",
        check: output => output.restRequested && output.extensionBlocked }] },
      { asOf: "2026-10-08T06:00:00Z", assertions: [{ id: "withdrawal-after-arrival", acceptanceId: "AC5-07",
        check: output => !output.restRequested }] },
      { asOf: "2026-10-09T04:00:00Z", assertions: [{ id: "late-fact-not-yet-known", acceptanceId: "AC5-03",
        check: output => !output.qualityBlocked && output.activeFeedbackIds.length === 0 }] },
      { asOf: "2026-10-10T04:00:00Z", assertions: [{ id: "old-feeling-not-todays-state", acceptanceId: "AC5-03",
        check: output => !output.restRequested && !output.extensionBlocked }] },
      { asOf: "2026-10-12T04:00:00Z", assertions: [{ id: "cross-week-no-filled-gaps", acceptanceId: "AC5-02",
        check: output => output.evidenceStatus === "expired" && output.activeFeedbackIds.length === 0 }] }
    ]
  };
  return [replayFrozenCoachSequence(sequence, {
    version: SUBJECTIVE_FEEDBACK_CANDIDATE_VERSION,
    apply: (input, item) => ({ ...input, revisions: [...input.revisions, item.payload] }),
    run: effectiveSubjectiveFeedback
  })];
}

export function coachGoalGapReplays() {
  const currentIdentity: CoachPredictionIdentity = {
    athleteId: "synthetic", bundleId: "bundle", bundleHash: "bundle-hash", datasetEpoch: "dataset",
    factsHash: "facts", overrideHash: "overrides", labelCohortHash: null,
    activePredictionArtifactId: "model", predictionPolicyVersion: "synthetic-model-v1", scenario: "current_prepared"
  };
  const summary: CoachPredictionSummary = {
    ...currentIdentity, schemaVersion: 1, id: "synthetic-summary",
    asOf: "2026-10-10T01:00:00Z", publishedAt: "2026-10-10T02:00:00Z",
    availableAt: "2026-10-10T02:00:00Z", dataThroughAt: "2026-10-09T01:00:00Z",
    entries: [{ distance: "ten_k", status: "available", referenceSeconds: 3000,
      method: "synthetic-reference", calibrationStatus: "uncalibrated", range: null,
      evidenceRefs: [], limitationCodes: ["not_calibrated"] }]
  };
  type State = Parameters<typeof coachGoalGap>[0];
  type Payload = { kind: "summary"; summary: CoachPredictionSummary } | { kind: "goal"; targetSeconds: number } |
    { kind: "identity"; currentIdentity: CoachPredictionIdentity };
  const initial: State = { asOf: "2026-10-05T00:00:00Z", distance: "ten_k", targetSeconds: 2700, summary: null, currentIdentity };
  const sequence: FrozenCoachSequence<State, Payload, CoachGoalGap> = {
    id: "R08-goal-reference-candidate", version: "synthetic-v1", initialState: initial, initialStateHash: digest(initial),
    replayMode: "as_known_then", policyManifest: { ...COACH_POLICY_MANIFEST },
    events: [
      event("summary-arrival", summary.asOf, summary.availableAt, { kind: "summary", summary }),
      event("goal-change", "2026-10-11T01:00:00Z", "2026-10-11T01:00:00Z", { kind: "goal", targetSeconds: 3300 }),
      event("model-change", "2026-10-12T01:00:00Z", "2026-10-12T01:00:00Z", {
        kind: "identity", currentIdentity: { ...currentIdentity, activePredictionArtifactId: "another-model" }
      }),
      event("model-rollback", "2026-10-18T01:00:00Z", "2026-10-18T01:00:00Z", { kind: "identity", currentIdentity })
    ],
    checkpoints: [
      { asOf: "2026-10-09T04:00:00Z", assertions: [{ id: "no-on-demand-prediction", acceptanceId: "AC6-06",
        check: output => output.status === "summary_unavailable" && output.gapSeconds === null }] },
      { asOf: "2026-10-10T04:00:00Z", assertions: [{ id: "reference-slower-by-300", acceptanceId: "AC6-01",
        check: output => output.gapSeconds === 300 && output.calibrationStatus === "uncalibrated" }] },
      { asOf: "2026-10-11T04:00:00Z", assertions: [{ id: "goal-changes-gap-only", acceptanceId: "AC6-03",
        check: output => output.gapSeconds === -300 && output.referenceSeconds === 3000 }] },
      { asOf: "2026-10-12T04:00:00Z", assertions: [{ id: "old-model-summary-not-current", acceptanceId: "AC6-05",
        check: output => output.status === "incompatible" && output.gapSeconds === null }] },
      { asOf: "2026-10-18T04:00:00Z", assertions: [{ id: "rollback-does-not-refresh-old-training", acceptanceId: "AC6-04",
        check: output => output.status === "stale" && output.freshness.stale }] }
    ]
  };
  return [replayFrozenCoachSequence(sequence, {
    version: GOAL_GAP_CANDIDATE_VERSION,
    apply: (input, item) => item.payload.kind === "summary" ? { ...input, summary: item.payload.summary } :
      item.payload.kind === "goal" ? { ...input, targetSeconds: item.payload.targetSeconds } :
        { ...input, currentIdentity: item.payload.currentIdentity },
    run: coachGoalGap
  })];
}
