import assert from "node:assert/strict";
import test from "node:test";
import { assessSessionDose, buildCompleteEasyStructure } from "../src/coach-session-dose.js";
import { buildCoachLoopCandidate } from "../src/coach-loop-decision.js";
import { buildCoachCapacityAnchor } from "../src/weekly-capacity.js";
import { recentSingleRunExposure } from "../src/coach-extension-eligibility.js";
import { shiftCoachDate, type CoachReservation } from "../src/coach-loop-facts.js";
import { executionPolicyContext, raceExecutionProtection, applyUnsupportedRacePlanPolicy } from "../src/race-plan-policy.js";
import { buildCompleteCoachWeekPlan } from "../src/coach-complete-plan.js";
import { coachReplayInput, coachReplayScenarios, replayEvent, replayRun } from "../../../scripts/coach-replay-scenarios.mjs";
import { replayCoachScenario } from "../../../scripts/coach-replay-core.mjs";
import { digest } from "../src/plan-digest.js";
import { buildPlanAdherence, replanAdvice } from "../src/plan-adherence.js";
import { buildPeriodization } from "../src/plan-periodization.js";
import { applyRacePlanPolicy } from "../src/weekly-plan-validate.js";
import { constrainUpcomingPlan, generateWeeklyPlan } from "../src/weekly-plan-service.js";
import type { MobileTodayResponse } from "@rai/api-contracts";

const inputAfterTwenty = () => {
  const initial = coachReplayInput();
  return { ...initial, facts: [...initial.facts, replayRun("monday-20", "2026-10-05", 20)] };
};
const slot = (date: string, overrides: Partial<CoachReservation> = {}): CoachReservation => ({
  slotId: `slot-${date}`, localDate: date, allocation: "extension", distanceKm: 5,
  approvedAt: `${date}T00:00:00Z`, status: "pending", matchedWorkoutIds: [], deviceScheduleUnresolved: false, ...overrides
});

test("AC0-05: exact duration, fastest distance bound, availability and open goals", () => {
  const zones = coachReplayInput().zones;
  for (const seconds of [1799, 1800, 1801]) {
    const structure = buildCompleteEasyStructure("easy", zones);
    structure.blocks[0]!.steps[0]!.goal = { type: "time", seconds: seconds - 600 };
    const measured = assessSessionDose({ kind: "easy", structure, zones });
    assert.equal(measured.status, seconds >= 1800 ? "feasible" : "not_feasible");
    assert.equal(measured.durationSeconds?.lower, seconds);
    assert.ok(Math.abs((measured.distanceKm?.upper ?? 0) - seconds / 360) < 1e-9);
  }
  const structure = buildCompleteEasyStructure("easy", zones);
  assert.equal(assessSessionDose({ kind: "easy", structure, zones, availableSeconds: 1200 }).status, "not_feasible");
  assert.equal(assessSessionDose({ kind: "easy", structure, zones, availableSeconds: 1800 }).status, "feasible");
  assert.equal(assessSessionDose({ kind: "easy", structure, zones, maximumDistanceKm: 4.99 }).status, "not_feasible");
  structure.blocks[0]!.steps[0]!.goal = { type: "distance", meters: 3000 };
  const distanceDose = assessSessionDose({ kind: "easy", structure, zones });
  assert.equal(distanceDose.durationSeconds?.lower, 1680);
  assert.equal(distanceDose.durationSeconds?.upper, 1860);
  assert.equal(distanceDose.status, "not_feasible", "slow-end 31 min cannot prove a 30 min minimum");
  structure.blocks[0]!.steps[0]!.goal = { type: "open" };
  assert.equal(assessSessionDose({ kind: "easy", structure, zones }).status, "not_assessable");
});

test("AC0-06/07: cold start is an estimate, padding cannot impersonate work", () => {
  const structure = buildCompleteEasyStructure("easy", null);
  assert.equal(assessSessionDose({ kind: "easy", structure, zones: null }).status, "not_assessable");
  const cold = assessSessionDose({ kind: "easy", structure, zones: null, allowColdStartEstimate: true, maximumDistanceKm: 5 });
  assert.equal(cold.status, "feasible");
  assert.equal(cold.estimateSource, "cold_start_policy");
  assert.ok([structure.warmup, ...structure.blocks.flatMap(block => block.steps), structure.cooldown].every(step => step?.alert === null));
  const padded = buildCompleteEasyStructure("easy", coachReplayInput().zones);
  padded.warmup!.goal = { type: "time", seconds: 1740 };
  padded.blocks[0]!.steps[0]!.goal = { type: "time", seconds: 60 };
  padded.cooldown = null;
  assert.ok(assessSessionDose({ kind: "tempo", structure: padded, zones: coachReplayInput().zones }).reasonCodes.includes("minimum_work_dose_not_met"));
});

test("AC0-13 candidate positive: S stays 20; H is 26; 30-minute cost is 5; GET cannot authorize", () => {
  const input = inputAfterTwenty();
  const before = digest(input);
  const output = buildCoachLoopCandidate(input);
  assert.equal(output.allocation, "extension");
  assert.equal(output.kind, "easy");
  assert.equal(output.dose.durationSeconds?.lower, 1800);
  assert.equal(output.dose.distanceKm?.upper, 5);
  assert.equal(output.volumePolicy.suggestedWeeklyKm, 20);
  assert.equal(output.volumePolicy.actualWeekKm, 20);
  assert.equal(output.volumePolicy.weeklyProtectionKm, 26);
  assert.ok(output.volumePolicy.constraints.every(item => item.passed));
  assert.equal(output.volumePolicy.extension.authorizedDecisionRef, null);
  assert.equal(output.executable, false);
  for (let repeat = 0; repeat < 10; repeat++) assert.deepEqual(buildCoachLoopCandidate(input), output);
  assert.equal(digest(input), before, "reads do not mutate frozen facts or reservations");
});

test("AC0-14/16: actual over S is not itself a veto, hard and cross-week limits are", () => {
  const source = inputAfterTwenty();
  source.facts[source.facts.length - 1] = replayRun("monday-22", "2026-10-05", 22);
  const insufficient = buildCoachLoopCandidate(source);
  assert.equal(insufficient.allocation, "rest");
  assert.ok(insufficient.reasons.some(reason => reason.code === "weekly_protection_reached"));
  const stronger = { ...source, facts: source.facts.map(fact => ({ ...fact,
    distanceKm: fact.id.startsWith("history") ? 13 : fact.distanceKm })) };
  assert.equal(buildCoachLoopCandidate(stronger).allocation, "extension");
  const crossWeek = { ...inputAfterTwenty(), facts: [...inputAfterTwenty().facts, replayRun("sunday", "2026-10-04", 10)] };
  assert.ok(buildCoachLoopCandidate(crossWeek).reasons.some(reason => reason.code === "rolling_load_limit"));
  const outsideWindow = { ...inputAfterTwenty(), reservations: [slot("2026-10-15", {
    allocation: "other", distanceKm: 30, approvedAt: "2026-10-08T00:00:00Z"
  })] };
  assert.ok(buildCoachLoopCandidate(outsideWindow).volumePolicy.constraints.some(item => !item.passed && item.to === "2026-10-15"));
});

test("AC0-15/18/19: pre-week anchor is immutable to this week's runs; spike cannot self-justify", () => {
  const input = coachReplayInput();
  const first = buildCoachCapacityAnchor({ ...input, revision: 1 });
  const after = buildCoachCapacityAnchor({ ...inputAfterTwenty(), revision: 1 });
  assert.deepEqual(first, after);
  assert.equal(first.recentWeeklyKm, 20);
  assert.equal(first.previousWeekKm, 20);
  const missingHistory = { ...inputAfterTwenty(), historyCoverageFrom: null, loadHistorySufficient: false };
  assert.notEqual(buildCoachLoopCandidate(missingHistory).volumePolicy.extension.status, "eligible");
  const single = inputAfterTwenty().facts.filter(fact => fact.id !== "prior-long");
  const spike = recentSingleRunExposure(single, "2026-10-08");
  assert.equal(spike.spikes[0]?.previousMaximumKm, 10);
  assert.equal(spike.spikes[0]?.run.distanceKm, 20);
  assert.equal(buildCoachLoopCandidate({ ...inputAfterTwenty(), facts: single }).allocation, "rest");
  assert.equal(recentSingleRunExposure(single, "2026-10-12").spikes.length, 0);
});

test("AC0-17 candidate count: completed, cancelled and unresolved device slots retain correct occupancy", () => {
  const input = inputAfterTwenty();
  const completed = replayRun("completed-extension", "2026-10-07", 5);
  const occupied = [slot("2026-10-04", { status: "completed", matchedWorkoutIds: ["old-completed"] }),
    slot("2026-10-07", { status: "completed", matchedWorkoutIds: [completed.id] })];
  const out = buildCoachLoopCandidate({ ...input, reservations: occupied, facts: [...input.facts, completed] });
  assert.equal(out.volumePolicy.extension.approvedSessionsInRolling7Days, 2);
  assert.equal(out.volumePolicy.extensionReservedKm, 0, "actual replaces reservation exactly once");
  assert.equal(out.volumePolicy.actualWeekKm, 25);
  const unresolved = buildCoachLoopCandidate({ ...input, reservations: [
    slot("2026-10-04", { status: "cancelled", deviceScheduleUnresolved: true }),
    slot("2026-10-06", { status: "cancelled", deviceScheduleUnresolved: true })
  ] });
  assert.equal(unresolved.volumePolicy.extension.approvedSessionsInRolling7Days, 2);
  assert.ok(unresolved.reasons.some(reason => reason.code === "extension_count_limit"));
  const released = buildCoachLoopCandidate({ ...input, reservations: [slot("2026-10-06", { status: "cancelled" })] });
  assert.equal(released.volumePolicy.extension.approvedSessionsInRolling7Days, 0);
  assert.equal(released.allocation, "extension");
  assert.throws(() => buildCoachLoopCandidate({ ...input, reservations: [slot("2026-10-06"), slot("2026-10-06", { distanceKm: 6 })] }),
    /Ambiguous coach decision slot/);
});

test("AC0-18/20: no recovery devices required, but explicit evidence/sync/lifecycle restrictions cannot be bypassed", () => {
  const input = inputAfterTwenty();
  for (const overrides of [
    { syncStatus: "pending" as const }, { syncStatus: "failed" as const }, { loadHistorySufficient: false },
    { lifecycleAllowsTraining: false }, { requestedRest: true }, { recoveryRestricted: true }, { availableSeconds: 1200 },
    { blockingFlagCodes: ["strain"] }, { blockingFlagCodes: ["sleep_streak"] },
    { mode: "race_preparation" as const, raceDate: "2026-11-01", raceTarget: { date: "2026-11-01", distance: "five_k" as const,
      targetPaceSecondsPerKm: null }, asOf: "2026-10-18T04:00:00Z" },
    { mode: "race_preparation" as const, raceDate: "2026-12-01", raceTarget: null }
  ]) assert.notEqual(buildCoachLoopCandidate({ ...input, ...overrides }).allocation, "extension", JSON.stringify(overrides));
  const partial = buildCoachLoopCandidate({ ...input, zones: null });
  assert.notEqual(partial.allocation, "extension", "cold-start pace estimate is not extension evidence");
});

test("AC0-03: automatic regular generator allocates complete sessions, not seven mileage fragments", () => {
  const input = coachReplayInput();
  const allowedDates = Array.from({ length: 7 }, (_, day) => shiftCoachDate("2026-10-05", day));
  const plan = buildCompleteCoachWeekPlan({ allowedDates, prescription: input.zones, weeklyDistanceKm: 10,
    qualitySessionCap: 0, easyDurationFloorFraction: 0.7, injuryFlagCodes: [] });
  assert.equal(plan.filter(day => day.kind !== "rest").length, 2);
  assert.ok(plan.filter(day => day.kind !== "rest").every(day =>
    assessSessionDose({ kind: day.kind, structure: day.structure ?? null, zones: input.zones }).durationSeconds?.lower === 1800));
  const small = buildCompleteCoachWeekPlan({ allowedDates, prescription: input.zones, weeklyDistanceKm: 2.6,
    qualitySessionCap: 0, easyDurationFloorFraction: 0.7, injuryFlagCodes: [] });
  assert.ok(small.every(day => day.kind === "rest"), "unapproved extension is not silently filled from H");
});

test("O0-B/C partial production chain: S20 with Monday10 keeps complete future doses after final clamping", async () => {
  const zones = coachReplayInput().zones;
  const today = {
    today: { localDate: "2026-10-05", workoutCount: 1 },
    week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 10 },
    lock: { present: false }, weekStructure: { qualitySessionCount: 0 }, injuryFlags: []
  } as unknown as MobileTodayResponse;
  const args = { today, goals: { raceTarget: null, qualitySessionCap: 0, easyDurationFloorFraction: 0.7 },
    weeklyVolumeBaselineKm: 20, recentWeeklyKm: 20, previousWeekDistanceKm: 20, prescription: zones };
  const generated = await generateWeeklyPlan(args);
  const runs = generated.days.filter(day => day.kind !== "rest");
  assert.equal(runs.length, 2);
  assert.ok(runs.every(day => assessSessionDose({ kind: day.kind, structure: day.structure ?? null, zones }).status === "feasible"));
  assert.ok(runs.reduce((sum, day) => sum +
    (assessSessionDose({ kind: day.kind, structure: day.structure ?? null, zones }).distanceKm?.upper ?? 0), 0) <= 10);
  assert.deepEqual(constrainUpcomingPlan(generated.days, { ...args, automaticDosePolicy: true }), generated.days);
  for (const remaining of [2.6, 0]) {
    const small = await generateWeeklyPlan({ ...args, today: { ...today, week: { ...today.week, distanceKm: 20 - remaining } } });
    assert.ok(small.days.every(day => day.kind === "rest"), "production cannot use unapproved H/extension receipts");
  }
});

test("AC1-02/04/05: SYN-01 phase is peak; 14-day protection is independent and idempotent", () => {
  const raceTarget = { date: "2026-11-01", distance: "five_k" as const, targetPaceSecondsPerKm: null };
  const context = executionPolicyContext({ localDate: "2026-10-18", raceTarget, weeklyDistanceKm: 20 });
  assert.equal(context.phase, "peak");
  assert.equal(context.protections[0]?.code, "pre_race_execution_protection");
  assert.equal(context.protections[0]?.daysToRace, 14);
  assert.equal(raceExecutionProtection("2026-10-17", raceTarget.date).preRace, false);
  assert.equal(raceExecutionProtection("2026-10-18", raceTarget.date).preRace, true);
  assert.equal(raceExecutionProtection("2026-11-01", raceTarget.date).raceDay, true);
  const day = { localDate: "2026-10-18", kind: "interval" as const, distanceKm: 6,
    structure: null, reason: null };
  const once = applyRacePlanPolicy([day], raceTarget, 20, coachReplayInput().zones);
  assert.deepEqual(applyRacePlanPolicy(once, raceTarget, 20, coachReplayInput().zones), once);
});

test("AC1-06 partial: unsupported race metadata keeps the existing two-day compatibility policy, not a fake 14-day distance cap", () => {
  const fourteen = executionPolicyContext({ localDate: "2026-10-18", raceTarget: null, raceDate: "2026-11-01", weeklyDistanceKm: 45 });
  assert.equal(fourteen.phase, null);
  assert.deepEqual(fourteen.protections, []);
  const two = executionPolicyContext({ localDate: "2026-10-30", raceTarget: null, raceDate: "2026-11-01", weeklyDistanceKm: 45 });
  assert.equal(two.phase, null);
  assert.equal(two.protections[0]?.daysToRace, 2);
  assert.deepEqual(two.protections[0]?.constraints, [{ kind: "no_quality_or_long_run", value: null, unit: null }]);
  const long = { localDate: "2026-10-30", kind: "long_run" as const, distanceKm: 8,
    structure: null, reason: "original" };
  const low = { ...long, kind: "easy" as const };
  const safe = applyUnsupportedRacePlanPolicy([long, low], "2026-11-01", false);
  assert.equal(safe[0]?.kind, "rest");
  assert.deepEqual(safe[1], low);
  assert.deepEqual(applyUnsupportedRacePlanPolicy(safe, "2026-11-01", false), safe);
  assert.equal(long.kind, "long_run", "read-time compatibility restrictions do not rewrite stored text");
});

test("O2 partial: unobserved quality dates never independently recommend replanning", () => {
  const periodization = buildPeriodization({ today: "2026-10-12", raceTarget: null, recentWeeklyKm: 20 });
  const history = [{ revision: 1, changedAt: "2026-10-04T01:00:00Z", lockedSession: null,
    weekPlan: [{ localDate: "2026-10-05", kind: "easy" as const, distanceKm: 5 },
      { localDate: "2026-10-07", kind: "interval" as const, distanceKm: 5 },
      { localDate: "2026-10-09", kind: "tempo" as const, distanceKm: 5 }] }];
  const adherence = buildPlanAdherence({ today: "2026-10-12", periodization, history,
    actual: [{ localDate: "2026-10-05", distanceKm: 5, workoutCount: 1 }] });
  assert.equal(adherence.weeks[1]?.qualityObserved, 0);
  assert.equal(adherence.weeks[1]?.unknownDays, 2);
  assert.equal(replanAdvice({ adherence, periodization }).recommended, false);
});

test("O8: fixed cross-week event streams repeat deterministically; no late-arrival leakage", () => {
  for (const scenario of coachReplayScenarios()) {
    const first = replayCoachScenario(scenario);
    assert.deepEqual(first, replayCoachScenario(scenario));
    assert.equal(first.status, "passed", JSON.stringify(first.checkpoints.map(row => row.assertions)));
    assert.equal(first.metrics.proposedShortSessionCount, 0);
    assert.equal(first.metrics.proposedHardConstraintViolationCount, 0);
    assert.equal(first.metrics.productionPublication, "not_evaluable");
  }
  const late = coachReplayScenarios().find(scenario => scenario.id.startsWith("R11"))!;
  assert.ok(!replayCoachScenario(late).checkpoints[0]!.visibleEventIds.includes("late-20"));
});

test("O8: corrupted identities/unknown arrival and inert future config are not valid certificates", () => {
  const original = coachReplayScenarios()[0]!;
  assert.throws(() => replayCoachScenario({ ...original, initialStateHash: "wrong" }), /hash mismatch/);
  const unknown = replayEvent("unknown", "2026-10-05T01:00:00Z", null, { kind: "config", changes: { requestedRest: true } });
  assert.throws(() => replayCoachScenario({ ...original, events: [unknown] }), /Unknown availability/);
  const future = replayEvent("future-stop", "2026-10-20T00:00:00Z", "2026-10-08T00:00:00Z",
    { kind: "config", changes: { lifecycleAllowsTraining: false } });
  const report = replayCoachScenario({ ...original, events: [...original.events, future] });
  assert.equal(report.status, "passed");
  assert.ok(report.checkpoints.every(checkpoint => !checkpoint.visibleEventIds.includes(future.eventId)));
});
