import assert from "node:assert/strict";
import test from "node:test";
import type { MobilePlannedDay, MobileTodayResponse } from "@rai/api-contracts";
import {
  coachPlanRepairCost, coachRepairConstraintClosure, compareCoachPlanRepairCost, repairCoachPlan,
  type CoachRepairCandidate, type CoachRepairDay, type CoachRepairValidation
} from "../src/coach-plan-repair.js";
import { buildCompleteEasyStructure } from "../src/coach-session-dose.js";
import { buildSessionStructure, plannedDayNumbers } from "../src/mobile-coach.js";
import { constrainUpcomingPlan } from "../src/weekly-plan-service.js";
import { digest, prescriptionDigest } from "../src/plan-digest.js";
import { coachReplayInput } from "../../../scripts/coach-replay-scenarios.mjs";
import { coachReason } from "../src/coach-loop-policy.js";

const ZONES = coachReplayInput().zones;
const easy = (date: string, seconds = 1800): CoachRepairDay => {
  const structure = buildCompleteEasyStructure("easy", ZONES);
  structure.blocks[0]!.steps[0]!.goal = { type: "time", seconds: seconds - 600 };
  return { day: { localDate: date, kind: "easy", ...plannedDayNumbers("easy", structure, null, ZONES), reason: "original" },
    executable: true, authorizedDecisionRef: null };
};
const rest = (date: string): CoachRepairDay => ({
  day: { localDate: date, kind: "rest", distanceKm: null, structure: null, reason: "explicit rest" },
  executable: false, authorizedDecisionRef: null
});
const candidate = (row: CoachRepairDay, templateId: string, originDate: string | null = null,
  preferenceRank = 1): CoachRepairCandidate => ({ ...row, templateId, originDate, preferenceRank });

/** Existing API final pipeline, with outside-window rows retained as fixed constraints. */
function apiValidator(previous: readonly CoachRepairDay[], overrides: {
  weeklyKm?: number; actualKm?: number; qualityCap?: number; injuryCodes?: string[];
} = {}): (stored: readonly MobilePlannedDay[]) => CoachRepairValidation {
  const today = {
    today: { localDate: "2026-10-08", workoutCount: 0 }, week: {
      periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: overrides.actualKm ?? 0
    }, lock: { present: false }, weekStructure: { qualitySessionCount: 0 },
    injuryFlags: (overrides.injuryCodes ?? []).map(code => ({ code })), nextSession: { kind: "rest", distanceKm: null }
  } as unknown as MobileTodayResponse;
  return stored => {
    const constrained = constrainUpcomingPlan([...stored], { today, prescription: ZONES,
      weeklyVolumeBaselineKm: overrides.weeklyKm ?? 30, recentWeeklyKm: 30,
      previousWeekDistanceKm: 30, automaticDosePolicy: true,
      goals: { raceTarget: null, qualitySessionCap: overrides.qualityCap ?? 0,
        easyDurationFloorFraction: 0.7, weekPlan: [...stored] }
    });
    return { feasible: true, effectiveDays: stored.map(day => {
      const safe = constrained.find(row => row.localDate === day.localDate) ?? day;
      return { day: safe, executable: safe.kind !== "rest" && safe.structure != null,
        authorizedDecisionRef: previous.find(row => row.day.localDate === day.localDate)?.authorizedDecisionRef ?? null };
    }), reasons: [] };
  };
}

const solve = (input: Partial<Parameters<typeof repairCoachPlan>[0]> = {}) => {
  const previous = [easy("2026-10-08"), easy("2026-10-10")];
  return repairCoachPlan({
    previous, windowDates: ["2026-10-08", "2026-10-10"], affectedDates: ["2026-10-08", "2026-10-10"],
    protectedDates: [], requiredIntentDates: [], candidates: {},
    maximumEvaluations: 100, inputDigest: digest({ facts: "synthetic", revision: 1 }),
    reasonsByDate: {}, validate: apiValidator(previous), ...input
  });
};

test("AC3-02/07: a still-feasible overlap keeps original bytes even when evidence or explanation changes", () => {
  const previous = [easy("2026-10-08"), easy("2026-10-10")];
  const output = solve({ previous, candidates: {
    "2026-10-08": [candidate(easy("2026-10-08", 2400), "longer-easy")],
    "2026-10-10": [candidate(rest("2026-10-10"), "rest")]
  } });
  assert.equal(output.status, "no_change");
  assert.deepEqual(output.storedDays, previous.map(row => row.day));
  assert.deepEqual(output.changes, []);
  assert.equal(output.cost?.changedDates, 0);
  assert.equal(output.publishable, false);
  assert.deepEqual(solve({ previous, inputDigest: "other-evidence", reasonsByDate: {
    "2026-10-08": [coachReason("explanation_only", "synthetic-v1", ["2026-10-08"])]
  } }).storedDays, output.storedDays);
});

test("AC3-03: only constrained dates are changed and final rather than pre-clamp content is logged", () => {
  const previous = [easy("2026-10-08"), easy("2026-10-10")];
  const result = solve({ previous, affectedDates: ["2026-10-08"],
    candidates: { "2026-10-08": [candidate(rest("2026-10-08"), "safe-rest")] },
    validate: days => ({ feasible: true, effectiveDays: days.map(day => day.localDate === "2026-10-08"
      ? rest(day.localDate) : { day, executable: true, authorizedDecisionRef: null }),
    reasons: [coachReason("recovery_restriction", "synthetic-v1", ["2026-10-08"])] })
  });
  assert.equal(result.status, "patched");
  assert.equal(result.storedDays[0]?.kind, "rest");
  assert.deepEqual(result.storedDays[1], previous[1]?.day);
  assert.deepEqual(result.affectedDates, ["2026-10-08"]);
  assert.ok(result.changes.every(change => change.reasons.some(reason => reason.code === "recovery_restriction")));
});

test("AC3-04: locked storage is fixed, not a bypass of effective safety", () => {
  const row = easy("2026-10-08");
  const result = solve({ previous: [row], windowDates: [row.day.localDate], protectedDates: [row.day.localDate],
    affectedDates: [row.day.localDate], validate: () => ({ feasible: true,
      effectiveDays: [rest(row.day.localDate)], reasons: [coachReason("recovery_restriction", "synthetic-v1", [row.day.localDate])] })
  });
  assert.deepEqual(result.storedDays[0], row.day, "do not rewrite a lock or its history");
  assert.equal(result.effectiveDays[0]?.executable, false);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0]?.layer, "effective_execution");
  assert.equal(result.changes[0]?.safetyDowngrade, true);
});

test("AC3-05: outside-window saved rows are passed to the one validator and remain stored", () => {
  const previous = [easy("2026-10-08"), easy("2026-10-10"), easy("2026-10-15", 3600)];
  let observedOutside = false;
  const primary = apiValidator(previous, { weeklyKm: 10, actualKm: 5 });
  const result = solve({ previous, windowDates: ["2026-10-08", "2026-10-10", "2026-10-12"],
    affectedDates: ["2026-10-08", "2026-10-10", "2026-10-12"],
    candidates: {
      "2026-10-08": [candidate(rest("2026-10-08"), "rest")],
      "2026-10-10": [candidate(rest("2026-10-10"), "rest")],
      "2026-10-12": [candidate(easy("2026-10-12"), "new-easy"), candidate(rest("2026-10-12"), "rest")]
    }, validate: days => { observedOutside ||= days.some(day => day.localDate === "2026-10-15"); return primary(days); }
  });
  assert.equal(observedOutside, true);
  assert.deepEqual(result.storedDays.find(day => day.localDate === "2026-10-15"), previous[2]?.day);
  assert.equal(result.effectiveDays.find(row => row.day.localDate === "2026-10-12")?.day.kind, "rest",
    "next week already has a fixed complete-session reservation; it is not free budget");
});

test("AC3-06: unknown previous training never expands the supplied intent/candidate space", () => {
  const previous = [easy("2026-10-01"), easy("2026-10-08")];
  const result = solve({ previous, windowDates: ["2026-10-08"], affectedDates: ["2026-10-08"] });
  assert.equal(result.status, "no_change");
  assert.equal(result.storedDays.filter(day => day.kind !== "rest").length, 2);
  assert.deepEqual(result.storedDays[0], previous[0]?.day);
});

test("authorizing identical steps is an execution change, not no_change; automatic rest upgrade needs explicit intent", () => {
  const automaticRest = rest("2026-10-08");
  automaticRest.day.reason = "automatic budget rest";
  const previous = [automaticRest];
  const required = solve({ previous, windowDates: ["2026-10-08"], affectedDates: ["2026-10-08"],
    requiredIntentDates: ["2026-10-08"],
    candidates: { "2026-10-08": [candidate(easy("2026-10-08"), "selected-complete-easy")] },
    validate: apiValidator(previous) });
  assert.equal(required.status, "patched");
  assert.equal(required.effectiveDays[0]?.day.kind, "easy");
  const noIntent = solve({ previous, windowDates: ["2026-10-08"], affectedDates: ["2026-10-08"],
    candidates: { "2026-10-08": [candidate(easy("2026-10-08"), "optional-easy")] },
    validate: apiValidator(previous) });
  assert.equal(noIntent.status, "no_change", "good readiness alone does not obligate another run");
  const row = easy("2026-10-08");
  row.executable = false;
  const authorized = solve({ previous: [row], windowDates: ["2026-10-08"], affectedDates: ["2026-10-08"],
    validate: days => ({ feasible: true, effectiveDays: days.map(day => ({
      day, executable: true, authorizedDecisionRef: "synthetic-authorization"
    })), reasons: [coachReason("extension_allowed", "synthetic-v1", ["2026-10-08"])] })
  });
  assert.equal(authorized.status, "patched");
  assert.deepEqual(authorized.storedDays[0], row.day);
  assert.equal(authorized.changes[0]?.layer, "effective_execution");
  assert.equal(authorized.publishable, false, "the repairer itself has not issued this authorization");
});

test("moves count once and duplicate origin candidates cannot duplicate a workout", () => {
  const original = easy("2026-10-08");
  const previous = [original, rest("2026-10-09")];
  const moved = candidate({ ...original, day: { ...original.day, localDate: "2026-10-09" } }, "move", "2026-10-08");
  const cost = coachPlanRepairCost(previous, [candidate(rest("2026-10-08"), "rest"), moved], [
    rest("2026-10-08"), moved
  ]);
  assert.equal(cost.changedDates, 1);
  assert.equal(cost.movedSessions, 1);
  const result = solve({ previous, windowDates: ["2026-10-08", "2026-10-09"], affectedDates: ["2026-10-08", "2026-10-09"],
    requiredIntentDates: ["2026-10-09"],
    candidates: { "2026-10-08": [candidate(rest("2026-10-08"), "rest")], "2026-10-09": [moved] },
    validate: apiValidator(previous) });
  assert.equal(result.effectiveDays.filter(row => row.day.kind !== "rest").length, 1);
});

test("AC3-09: small-window independent exhaustive oracle agrees with the lexicographic winner", () => {
  const previous = [easy("2026-10-08"), easy("2026-10-10")];
  const variants = previous.map(row => [
    candidate(row, "keep-original", row.day.localDate, 0),
    candidate(easy(row.day.localDate, 2400), "longer", row.day.localDate, 1),
    candidate(rest(row.day.localDate), "rest", null, 2)
  ]);
  const validate = (stored: readonly MobilePlannedDay[]): CoachRepairValidation => ({
    feasible: stored.filter(day => day.kind !== "rest").length <= 1,
    effectiveDays: stored.map(day => ({ day, executable: day.kind !== "rest", authorizedDecisionRef: null })), reasons: []
  });
  // Evaluator-owned enumeration and independently defined tuple; do not call
  // the production cost helper/comparator to manufacture the expected optimum.
  const oracle: number[][] = [];
  for (const first of variants[0]!) for (const second of variants[1]!) {
    const selected = [first, second], stored = selected.map(row => row.day);
    if (!validate(stored).feasible) continue;
    let changes = 0, kinds = 0, dose = 0;
    for (let index = 0; index < 2; index++) {
      const before = previous[index]!.day, after = stored[index]!;
      if (prescriptionDigest(before.kind, before.structure ?? null) !== prescriptionDigest(after.kind, after.structure ?? null)) changes++;
      if (before.kind !== after.kind) kinds++;
      if (before.kind === after.kind && after.kind === "easy") {
        const seconds = after.structure!.blocks[0]!.steps[0]!.goal;
        dose += seconds.type === "time" ? Math.abs(seconds.seconds - 1200) / 1200 : 0;
      }
    }
    oracle.push([changes, 0, kinds, dose, first.preferenceRank + second.preferenceRank]);
  }
  oracle.sort((a, b) => {
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! - b[index]!;
    return 0;
  });
  const result = solve({ previous, candidates: {
    "2026-10-08": variants[0]!.slice(1), "2026-10-10": variants[1]!.slice(1)
  }, validate });
  assert.deepEqual(Object.values(result.cost!), oracle[0]);
  assert.deepEqual(result, solve({ previous, candidates: {
    "2026-10-10": [...variants[1]!.slice(1)].reverse(), "2026-10-08": [...variants[0]!.slice(1)].reverse()
  }, validate }));
});

test("search exhaustion/mutation cannot publish an unchecked winner; safety outranks stability", () => {
  const previous = [easy("2026-10-08"), easy("2026-10-10")];
  const exhausted = solve({ previous, maximumEvaluations: 1, candidates: {
    "2026-10-08": [candidate(rest("2026-10-08"), "rest")], "2026-10-10": [candidate(rest("2026-10-10"), "rest")]
  } });
  assert.equal(exhausted.status, "not_evaluable");
  assert.equal(exhausted.effectiveDays.length, 0);
  assert.equal(exhausted.publishable, false);
  assert.ok(exhausted.reasons.some(reason => reason.code === "repair_search_budget_exhausted"));
  assert.throws(() => solve({ validate: days => {
    (days[0] as MobilePlannedDay).kind = "rest";
    return { feasible: true, effectiveDays: [], reasons: [] };
  } }), /mutated prescriptions/);
  assert.throws(() => solve({ validate: () => ({ feasible: true, effectiveDays: [], reasons: [] }) }),
    /account for every stored date/);
  const cannotRun = solve({ previous, requiredIntentDates: ["2026-10-08"], candidates: {},
    validate: apiValidator(previous, { weeklyKm: 0.1 }) });
  assert.equal(cannotRun.status, "safe_fallback");
  assert.ok(cannotRun.effectiveDays.every(row => row.day.kind === "rest"));
});

test("closure does not expand stored modifications outside the rolling window; comparator cannot buy safety with preferences", () => {
  assert.deepEqual(coachRepairConstraintClosure({ windowDates: ["2026-10-08", "2026-10-09", "2026-10-10"],
    seeds: ["2026-10-08"], dependencies: [
      { code: "same_week", dates: ["2026-10-08", "2026-10-09", "2026-10-15"] },
      { code: "quality_spacing", dates: ["2026-10-09", "2026-10-10"] }
    ] }), ["2026-10-08", "2026-10-09", "2026-10-10"]);
  assert.ok(compareCoachPlanRepairCost(
    { changedDates: 0, movedSessions: 0, kindChanges: 0, workDoseRelativeDifference: 0, preferenceRank: 1000 },
    { changedDates: 1, movedSessions: 0, kindChanges: 0, workDoseRelativeDifference: 0, preferenceRank: 0 }) < 0);
});

test("equivalent candidate deduplication is stable under enumeration order, including template metadata", () => {
  const a = candidate(easy("2026-10-08"), "a-template", null, 1);
  const z = candidate({ ...a, day: { ...a.day, reason: "equivalent explanation" } }, "z-template", null, 1);
  const input = { previous: [], windowDates: ["2026-10-08"], affectedDates: ["2026-10-08"],
    requiredIntentDates: ["2026-10-08"], validate: apiValidator([]) };
  const forward = solve({ ...input, candidates: { "2026-10-08": [z, a] } });
  const backward = solve({ ...input, candidates: { "2026-10-08": [a, z] } });
  assert.deepEqual(forward, backward);
  assert.equal(forward.storedDays[0]?.reason, a.day.reason);
});
