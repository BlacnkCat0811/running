import { replayModelPair } from "@rai/model-eval";
import type { CoachPolicyManifest } from "@rai/api-contracts";
import { DATABASE_TIMEZONE } from "@rai/contracts";
import { coachLocalDate } from "../apps/api/src/coach-loop-facts.js";
import { digest } from "../apps/api/src/plan-digest.js";

export interface FrozenCoachEvent<Payload> {
  eventId: string;
  observedAt: string;
  availableAt: string | null;
  payload: Payload;
  payloadHash: string;
}

export interface FrozenCoachSequence<Input, Payload, Output> {
  id: string;
  version: string;
  initialState: Input & { asOf: string };
  initialStateHash: string;
  replayMode: "as_known_then";
  policyManifest: CoachPolicyManifest;
  events: readonly FrozenCoachEvent<Payload>[];
  checkpoints: readonly {
    asOf: string;
    assertions: readonly { id: string; acceptanceId: string; check(output: Output): boolean }[];
  }[];
}

/**
 * Same external event stream at every checkpoint. Frozen inputs and labels
 * remain separate; callback adapters have no access to future expectations.
 * Reuses model-eval's immutable input/double-run guard, not a training simulator.
 */
export function replayFrozenCoachSequence<Input extends { asOf: string }, Payload, Output>(
  sequence: FrozenCoachSequence<Input, Payload, Output>,
  adapter: {
    version: string;
    apply(input: Input, event: FrozenCoachEvent<Payload>): Input;
    run(input: Input): Output;
  }
) {
  if (!sequence.version || sequence.initialStateHash !== digest(sequence.initialState) || !sequence.checkpoints.length) {
    throw new Error("Invalid frozen coach sequence identity/checkpoints");
  }
  coachLocalDate(sequence.initialState.asOf);
  const ids = new Set<string>();
  for (const event of sequence.events) {
    coachLocalDate(event.observedAt);
    if (event.availableAt === null) throw new Error("Unknown arrival cannot certify as_known_then");
    coachLocalDate(event.availableAt);
    if (!event.eventId || ids.has(event.eventId) || digest(event.payload) !== event.payloadHash) {
      throw new Error("Frozen coach event identity/hash mismatch");
    }
    ids.add(event.eventId);
  }
  const sorted = [...sequence.events].sort((a, b) => Date.parse(a.availableAt!) - Date.parse(b.availableAt!) ||
    Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.eventId.localeCompare(b.eventId));
  const checkpointIds = new Set<string>();
  const checkpoints = [...sequence.checkpoints].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf)).map(checkpoint => {
    coachLocalDate(checkpoint.asOf);
    if (Date.parse(checkpoint.asOf) < Date.parse(sequence.initialState.asOf) || !checkpoint.assertions.length) {
      throw new Error("Checkpoint precedes frozen state or lacks behavior assertions");
    }
    let state = structuredClone(sequence.initialState) as Input;
    state.asOf = checkpoint.asOf;
    const visibleEventIds: string[] = [];
    for (const event of sorted) {
      if (Date.parse(event.observedAt) > Date.parse(checkpoint.asOf) || Date.parse(event.availableAt!) > Date.parse(checkpoint.asOf)) continue;
      visibleEventIds.push(event.eventId);
      state = adapter.apply(state, structuredClone(event));
    }
    const evaluationAdapter = { version: adapter.version, run: adapter.run };
    const pair = replayModelPair(state, {
      caseId: sequence.id, asOf: checkpoint.asOf, timezoneIdentifier: DATABASE_TIMEZONE,
      replayMode: sequence.replayMode, factsSnapshotHash: digest(state),
      overrideSnapshotHash: digest({ visibleEventIds }), availabilityUnknown: false
    }, evaluationAdapter, evaluationAdapter);
    const output = pair.candidate.output;
    return {
      asOf: checkpoint.asOf, factsHash: digest(state), visibleEventIds,
      output, outputHash: digest(output),
      assertions: checkpoint.assertions.map(assertion => {
        const id = `${checkpoint.asOf}:${assertion.id}`;
        if (checkpointIds.has(id)) throw new Error("Duplicate frozen coach assertion");
        checkpointIds.add(id);
        return { id: assertion.id, acceptanceId: assertion.acceptanceId, status: assertion.check(output) ? "passed" : "failed" };
      })
    };
  });
  return {
    scenarioId: sequence.id, scenarioVersion: sequence.version, adapterVersion: adapter.version,
    initialStateHash: sequence.initialStateHash, policyManifest: sequence.policyManifest,
    replayMode: sequence.replayMode, evidenceBoundary: "offline_candidate_only_not_publication_or_training_effect",
    events: sorted.map(({ eventId, observedAt, availableAt, payloadHash }) => ({ eventId, observedAt, availableAt, payloadHash })),
    status: checkpoints.every(checkpoint => checkpoint.assertions.every(assertion => assertion.status === "passed")) ? "passed" : "failed",
    metrics: {
      checkpoints: checkpoints.length,
      assertionCount: checkpoints.reduce((sum, checkpoint) => sum + checkpoint.assertions.length, 0),
      productionPublication: "not_evaluable", legacyComparison: "not_evaluable", longTermTrainingEffect: "not_evaluable"
    },
    checkpoints
  };
}
