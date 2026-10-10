import { replayModelPair } from "@rai/model-eval";
import { buildCoachLoopCandidate, type CoachLoopDecisionInput } from "../apps/api/src/coach-loop-decision.js";
import { coachLocalDate, type CoachReservation, type CoachRunFact } from "../apps/api/src/coach-loop-facts.js";
import { digest } from "../apps/api/src/plan-digest.js";
import { COACH_POLICY_MANIFEST, COACH_REPLAY_VERSION } from "../apps/api/src/coach-loop-policy.js";
import type { CoachLoopCandidate } from "@rai/api-contracts";

export type CoachReplayEventPayload =
  | { kind: "training"; fact: CoachRunFact }
  | { kind: "reservation"; reservation: CoachReservation }
  | { kind: "config"; changes: Partial<Pick<CoachLoopDecisionInput,
      "mode" | "raceTarget" | "raceDate" | "lifecycleAllowsTraining" | "runningDay" | "requestedRest" |
      "syncStatus" | "blockingFlagCodes" | "recoveryRestricted" | "zones" | "availableSeconds">> };

export interface CoachReplayEvent {
  eventId: string;
  observedAt: string;
  availableAt: string | null;
  payload: CoachReplayEventPayload;
  payloadHash: string;
}

/** Expectations are evaluator-owned and never passed to the decision adapter. */
export interface CoachReplayAssertion {
  id: string;
  acceptanceId: string;
  check(output: CoachLoopCandidate): boolean;
}

export interface CoachReplayScenario {
  id: string;
  version: string;
  timezone: "Asia/Shanghai";
  initialState: CoachLoopDecisionInput;
  initialStateHash: string;
  replayMode: "as_known_then" | "event_time_reconstruction";
  events: readonly CoachReplayEvent[];
  checkpoints: readonly { asOf: string; assertions: readonly CoachReplayAssertion[] }[];
}

export function replayCoachScenario(scenario: CoachReplayScenario) {
  if (scenario.timezone !== "Asia/Shanghai" || scenario.initialStateHash !== digest(scenario.initialState)) {
    throw new Error("Replay timezone or frozen initial-state hash mismatch");
  }
  if (!scenario.checkpoints.length) throw new Error("Empty coach replay cannot pass");
  coachLocalDate(scenario.initialState.asOf);
  if (scenario.checkpoints.some(checkpoint => Date.parse(checkpoint.asOf) < Date.parse(scenario.initialState.asOf))) {
    throw new Error("Replay checkpoint precedes the frozen initial-state clock");
  }
  if (scenario.initialState.facts.some(fact => fact.availableAt === null)) {
    throw new Error("Unknown initial availability: not_evaluable; event-time reconstruction adapter is not implemented");
  }
  const eventIds = new Set<string>();
  for (const event of scenario.events) {
    coachLocalDate(event.observedAt);
    if (event.availableAt != null) coachLocalDate(event.availableAt);
    if (scenario.replayMode === "as_known_then" && event.availableAt === null) {
      throw new Error("Unknown availability cannot certify as_known_then");
    }
    if (event.availableAt === null) throw new Error("Unknown availability: not_evaluable; event-time reconstruction adapter is not implemented");
    if (eventIds.has(event.eventId) || !event.eventId || event.payloadHash !== digest(event.payload)) {
      throw new Error("Replay event identity/hash mismatch");
    }
    if (event.payload.kind === "training" && (event.payload.fact.startedAt !== event.observedAt ||
      event.payload.fact.availableAt !== event.availableAt)) throw new Error("Training event/source times disagree");
    eventIds.add(event.eventId);
  }
  const sortedEvents = [...scenario.events].sort((a, b) =>
    Date.parse(a.availableAt ?? a.observedAt) - Date.parse(b.availableAt ?? b.observedAt) ||
    Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.eventId.localeCompare(b.eventId));
  const assertions = new Set<string>();
  const rows = [...scenario.checkpoints].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf)).map(checkpoint => {
    coachLocalDate(checkpoint.asOf);
    if (!checkpoint.assertions.length) throw new Error("A coach checkpoint without behavioral assertions cannot pass");
    let input: CoachLoopDecisionInput = structuredClone(scenario.initialState);
    input.asOf = checkpoint.asOf;
    const visibleEventIds: string[] = [];
    for (const event of sortedEvents) {
      if (Date.parse(event.observedAt) > Date.parse(checkpoint.asOf) ||
        Date.parse(event.availableAt ?? event.observedAt) > Date.parse(checkpoint.asOf)) continue;
      visibleEventIds.push(event.eventId);
      const payload = event.payload;
      if (payload.kind === "training") {
        input.facts = [...input.facts.filter(run => run.id !== payload.fact.id),
          payload.fact];
      } else if (payload.kind === "reservation") {
        input.reservations = [...input.reservations.filter(slot => slot.slotId !== payload.reservation.slotId), payload.reservation];
      } else input = { ...input, ...payload.changes };
    }
    const adapter = { version: COACH_REPLAY_VERSION, run: buildCoachLoopCandidate };
    // Reuse the model-eval freeze/double-run/determinism boundary. This is
    // candidate repeatability, not an invented legacy-vs-production comparison.
    const pair = replayModelPair(input, {
      caseId: scenario.id, asOf: checkpoint.asOf, timezoneIdentifier: scenario.timezone,
      replayMode: scenario.replayMode, factsSnapshotHash: digest(input.facts), overrideSnapshotHash: digest(input.reservations),
      availabilityUnknown: scenario.events.some(event => event.availableAt === null) ||
        scenario.initialState.facts.some(fact => fact.availableAt === null)
    }, adapter, adapter);
    const output = pair.candidate.output;
    return {
      asOf: checkpoint.asOf, factsHash: digest(input.facts), visibleEventIds, outputHash: digest(output), output,
      assertions: checkpoint.assertions.map(assertion => {
        const key = `${checkpoint.asOf}:${assertion.id}`;
        if (assertions.has(key)) throw new Error("Duplicate replay assertion");
        assertions.add(key);
        return { id: assertion.id, acceptanceId: assertion.acceptanceId, status: assertion.check(output) ? "passed" : "failed" };
      })
    };
  });
  const candidateRows = rows.filter(row => row.output.allocation !== "rest");
  return {
    scenarioId: scenario.id, scenarioVersion: scenario.version, replayVersion: COACH_REPLAY_VERSION,
    policyManifest: COACH_POLICY_MANIFEST, initialStateHash: scenario.initialStateHash, replayMode: scenario.replayMode,
    evidenceBoundary: "offline_candidate_only_not_publication_or_training_effect",
    events: sortedEvents.map(({ eventId, observedAt, availableAt, payloadHash }) => ({ eventId, observedAt, availableAt, payloadHash })),
    status: rows.every(row => row.assertions.every(assertion => assertion.status === "passed")) ? "passed" : "failed",
    metrics: {
      checkpoints: rows.length, assertionCount: rows.reduce((sum, row) => sum + row.assertions.length, 0),
      proposedSessionCount: candidateRows.length,
      proposedShortSessionCount: candidateRows.filter(row => (row.output.dose.durationSeconds?.lower ?? 0) < 1800).length,
      proposedHardConstraintViolationCount: candidateRows.reduce((sum, row) => sum +
        row.output.volumePolicy.constraints.filter(constraint => !constraint.passed).length, 0),
      proposedExtensionCount: candidateRows.filter(row => row.output.allocation === "extension").length,
      productionPublication: "not_evaluable", legacyComparison: "not_evaluable",
      minimumRepairCostOracle: "not_evaluable", longTermTrainingEffect: "not_evaluable"
    },
    checkpoints: rows
  };
}
