import assert from "node:assert/strict";
import test from "node:test";
import { coachExecutionReplays, coachRepairReplays } from "../../../scripts/coach-loop-extra-replays.mjs";
import { replayFrozenCoachSequence } from "../../../scripts/coach-sequence-replay.mjs";
import { COACH_POLICY_MANIFEST } from "../src/coach-loop-policy.js";
import { digest } from "../src/plan-digest.js";
import { coachFeedbackReplays, coachGoalGapReplays } from "../../../scripts/coach-feedback-goal-replays.mjs";
import { coachRaceProtectionReplays } from "../../../scripts/coach-race-protection-replays.mjs";
import { sevenDayRepairOracle } from "../../../scripts/coach-repair-oracle.mjs";

test("AC3-07/09: seven dates and all 2187 combinations agree with evaluator-owned oracle twice", () => {
  const result = sevenDayRepairOracle();
  assert.equal(result.status, "passed");
  assert.equal(result.results.length, 3);
  assert.ok(result.results.every(row => row.rounds.every(round => round.evaluatedCandidates === 2187)));
});

test("O8 continuation: O2 and O3 cross-week candidate sequences are deterministic and asserted", () => {
  const first = [...coachExecutionReplays(), ...coachRepairReplays()];
  const second = [...coachExecutionReplays(), ...coachRepairReplays()];
  assert.deepEqual(first, second);
  assert.equal(first.length, 4);
  for (const scenario of first) {
    assert.equal(scenario.status, "passed", JSON.stringify(scenario.checkpoints.map(checkpoint => checkpoint.assertions)));
    assert.equal(scenario.metrics.productionPublication, "not_evaluable");
    assert.ok(scenario.metrics.checkpoints >= 3);
    assert.ok(scenario.checkpoints.every(checkpoint => checkpoint.assertions.length > 0));
  }
});

test("O8 continuation: feedback, goal-gap and three-distance protection have frozen cross-week traces", () => {
  const first = [...coachFeedbackReplays(), ...coachGoalGapReplays(), ...coachRaceProtectionReplays()];
  assert.deepEqual(first, [...coachFeedbackReplays(), ...coachGoalGapReplays(), ...coachRaceProtectionReplays()]);
  assert.equal(first.length, 5);
  assert.ok(first.every(scenario => scenario.status === "passed"), JSON.stringify(first.map(scenario => scenario.scenarioId)));
  assert.ok(first.every(scenario => scenario.metrics.productionPublication === "not_evaluable"));
  assert.ok(coachRaceProtectionReplays().every(scenario =>
    scenario.metrics.naturalWeekPhaseStable && scenario.metrics.checkpoints === 43));
});

test("O8 generic event adapter keeps future and late facts out of earlier checkpoints", () => {
  const initialState = { asOf: "2026-10-05T00:00:00Z", known: [] as string[] };
  const payload = { id: "late" };
  const sequence = {
    id: "temporal-boundary", version: "synthetic-v1", initialState, initialStateHash: digest(initialState),
    replayMode: "as_known_then" as const, policyManifest: { ...COACH_POLICY_MANIFEST },
    events: [{
      eventId: "late", observedAt: "2026-10-05T01:00:00Z", availableAt: "2026-10-09T00:00:00Z",
      payload, payloadHash: digest(payload)
    }],
    checkpoints: [
      { asOf: "2026-10-08T04:00:00Z", assertions: [{
        id: "no-early-arrival", acceptanceId: "AC8-03", check: (known: string[]) => known.length === 0
      }] },
      { asOf: "2026-10-12T04:00:00Z", assertions: [{
        id: "arrival-visible", acceptanceId: "AC8-03", check: (known: string[]) => known.join() === "late"
      }] }
    ]
  };
  const adapter = {
    version: "synthetic-adapter-v1",
    apply: (input: typeof initialState, event: { payload: typeof payload }) => ({ ...input, known: [...input.known, event.payload.id] }),
    run: (input: typeof initialState) => input.known
  };
  const report = replayFrozenCoachSequence(sequence, adapter);
  assert.equal(report.status, "passed");
  assert.equal(report.checkpoints[0]?.visibleEventIds.length, 0);
  assert.throws(() => replayFrozenCoachSequence({ ...sequence,
    events: sequence.events.map(event => ({ ...event, availableAt: null })) }, adapter), /Unknown arrival/);
  assert.throws(() => replayFrozenCoachSequence({ ...sequence, initialStateHash: "wrong" }, adapter), /identity/);
  assert.throws(() => replayFrozenCoachSequence({ ...sequence, checkpoints: [{ ...sequence.checkpoints[0]!, assertions: [] }] }, adapter),
    /lacks behavior assertions/);
});
