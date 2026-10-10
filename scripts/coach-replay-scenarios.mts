import type { CoachLoopDecisionInput } from "../apps/api/src/coach-loop-decision.js";
import { shiftCoachDate, type CoachRunFact } from "../apps/api/src/coach-loop-facts.js";
import { digest } from "../apps/api/src/plan-digest.js";
import type { CoachReplayEvent, CoachReplayEventPayload, CoachReplayScenario } from "./coach-replay-core.mjs";

export const replayRun = (id: string, date: string, distanceKm: number): CoachRunFact => ({
  id, startedAt: `${date}T01:00:00Z`, availableAt: `${date}T02:00:00Z`,
  distanceKm, durationSeconds: distanceKm * 360, revisionOrHash: `synthetic-${id}-v1`
});

/** 8+ observed days/28-day coverage; 20km prior single exposure is real input. */
export function coachReplayInput(overrides: Partial<CoachLoopDecisionInput> = {}): CoachLoopDecisionInput {
  const facts: CoachRunFact[] = [
    replayRun("prior-long", "2026-08-30", 20),
    ...[-28, -21, -14, -7].flatMap((offset, week) =>
      [0, 3].map((day, index) => replayRun(`history-${week}-${index}`, shiftCoachDate("2026-10-05", offset + day), 10)))
  ];
  return {
    asOf: "2026-10-08T04:00:00Z", scope: { athleteId: "synthetic", datasetEpoch: "synthetic-v1" },
    mode: "daily_adaptive", raceTarget: null, raceDate: null,
    lifecycleAllowsTraining: true, runningDay: true, requestedRest: false,
    facts, reservations: [], historyCoverageFrom: "2026-08-01", anchorRevision: 1,
    loadHistorySufficient: true, syncStatus: "ok", blockingFlagCodes: [], recoveryRestricted: false,
    zones: { easyPaceLower: 360, easyPaceUpper: 420, easyHrLower: 120, easyHrUpper: 145,
      thresholdPaceLower: 270, thresholdPaceUpper: 300, thresholdHrLower: 160, thresholdHrUpper: 172,
      intervalPaceLower: 240, intervalPaceUpper: 270 },
    availableSeconds: 1800, suggestedWeeklyKm: 20, legacyProtectionKm: 20,
    absoluteProtectionKm: 200, explicitPhaseHardCapKm: null, ...overrides
  };
}

export function replayEvent(id: string, observedAt: string, availableAt: string | null, payload: CoachReplayEventPayload): CoachReplayEvent {
  return { eventId: id, observedAt, availableAt, payload, payloadHash: digest(payload) };
}

const scenario = (id: string, initialState: CoachLoopDecisionInput, events: CoachReplayEvent[],
  checkpoints: CoachReplayScenario["checkpoints"]): CoachReplayScenario => {
  const initialAsOf = [initialState.asOf, ...events.map(event => event.observedAt), ...checkpoints.map(checkpoint => checkpoint.asOf)]
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
  const frozenInitial = { ...initialState, asOf: initialAsOf };
  return {
    id, version: "synthetic-v1", timezone: "Asia/Shanghai", initialState: frozenInitial, initialStateHash: digest(frozenInitial),
    replayMode: "as_known_then", events, checkpoints
  };
};
const trainingEvent = (id: string, date: string, km: number) => {
  const fact = replayRun(id, date, km);
  return replayEvent(id, fact.startedAt, fact.availableAt, { kind: "training", fact });
};

/** Focused cross-week baseline scenarios, not the plan's full 22-scenario exit gate. */
export function coachReplayScenarios(): CoachReplayScenario[] {
  return [
    scenario("R14-complete-dose-candidate", coachReplayInput(), [trainingEvent("monday", "2026-10-05", 10)], [
      { asOf: "2026-10-05T04:00:00Z", assertions: [{ id: "no-second-session", acceptanceId: "AC0-07", check: out => out.allocation === "rest" }] },
      { asOf: "2026-10-08T04:00:00Z", assertions: [{ id: "complete-regular", acceptanceId: "AC0-03", check: out =>
        out.allocation === "regular" && out.dose.durationSeconds?.lower === 1800 && out.volumePolicy.suggestedWeeklyKm === 20 }] },
      { asOf: "2026-10-12T04:00:00Z", assertions: [{ id: "no-carry-debt", acceptanceId: "AC0-09", check: out =>
        out.volumePolicy.actualWeekKm === 0 && out.volumePolicy.suggestedWeeklyKm === 20 }] }
    ]),
    scenario("R19-extension-candidate-not-publication", coachReplayInput(), [
      trainingEvent("monday-20", "2026-10-05", 20), trainingEvent("completed-extra", "2026-10-11", 5)
    ], [
      { asOf: "2026-10-08T04:00:00Z", assertions: [{ id: "allow-above-suggestion", acceptanceId: "AC0-13-candidate-only", check: out =>
        out.allocation === "extension" && out.volumePolicy.weeklyProtectionKm === 26 &&
        out.volumePolicy.actualWeekKm === 20 && out.dose.distanceKm?.upper === 5 &&
        out.volumePolicy.suggestedWeeklyKm === 20 && out.volumePolicy.extension.authorizedDecisionRef === null && !out.executable }] },
      { asOf: "2026-10-12T04:00:00Z", assertions: [{ id: "cross-week-protection", acceptanceId: "AC0-16", check: out =>
        out.volumePolicy.constraints.some(item => item.code === "rolling_7_days" && item.actualKm > 0) }] }
    ]),
    scenario("R21-single-exposure-candidate", coachReplayInput({
      facts: coachReplayInput().facts.filter(fact => fact.id !== "prior-long")
    }), [trainingEvent("first-20", "2026-10-05", 20)], [
      { asOf: "2026-10-08T04:00:00Z", assertions: [{ id: "no-self-baseline", acceptanceId: "AC0-19", check: out =>
        out.allocation === "rest" && out.reasons.some(reason => reason.code === "recent_single_run_spike") }] },
      { asOf: "2026-10-12T04:00:00Z", assertions: [{ id: "exposure-expired-not-auto-recovered", acceptanceId: "AC0-19", check: out =>
        !out.reasons.some(reason => reason.code === "recent_single_run_spike") }] }
    ]),
    scenario("R11-late-arrival-candidate", coachReplayInput(), [
      (() => { const fact = { ...replayRun("late-20", "2026-10-05", 20), availableAt: "2026-10-09T02:00:00Z" };
        return replayEvent(fact.id, fact.startedAt, fact.availableAt, { kind: "training", fact }); })()
    ], [
      { asOf: "2026-10-08T04:00:00Z", assertions: [{ id: "not-yet-available", acceptanceId: "AC8-03", check: out => out.volumePolicy.actualWeekKm === 0 }] },
      { asOf: "2026-10-09T04:00:00Z", assertions: [{ id: "available-now", acceptanceId: "AC8-03", check: out => out.volumePolicy.actualWeekKm === 20 }] },
      { asOf: "2026-10-12T04:00:00Z", assertions: [{ id: "history-only-new-anchor", acceptanceId: "AC0-22-candidate-only", check: out =>
        out.volumePolicy.anchor.historyThrough === "2026-10-11" }] }
    ])
  ];
}
