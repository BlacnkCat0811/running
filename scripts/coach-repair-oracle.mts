import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { repairCoachPlan, type CoachRepairCandidate, type CoachRepairDay } from "../apps/api/src/coach-plan-repair.js";
import { syntheticRepairEasy, syntheticRepairRest } from "./coach-repair-fixtures.mjs";
import { digest } from "../apps/api/src/plan-digest.js";

/** Evaluator-owned exhaustive objective, not production cost/helper reuse.
 * Scope is frozen easy/rest, no relocation. A human independent review is
 * still separate from this independently implemented mathematical oracle. */
export function sevenDayRepairOracle() {
  const dates = Array.from({ length: 7 }, (_, i) => `2026-10-${String(i + 8).padStart(2, "0")}`);
  const previous = dates.map(syntheticRepairEasy);
  const options = dates.map((date, index): CoachRepairCandidate[] => {
    const longer = structuredClone(syntheticRepairEasy(date));
    longer.day.structure!.blocks[0]!.steps[0]!.goal = { type: "time", seconds: 1800 };
    return [
      { ...previous[index]!, originDate: date, templateId: "keep-original", preferenceRank: 0 },
      { ...longer, originDate: date, templateId: "longer", preferenceRank: 1 },
      { ...syntheticRepairRest(date), originDate: null, templateId: "rest", preferenceRank: 2 }
    ];
  });
  const results = [120, 180, 210].map(minutes => {
    let optimum: number[] | null = null, combinations = 0;
    const enumerate = (indices: number[]) => {
      if (indices.length < 7) { for (const index of [0, 1, 2]) enumerate([...indices, index]); return; }
      combinations++;
      // Golden doses are fixture-owned: keep=30, alternative=40, rest=0.
      const duration = indices.reduce((sum, i) => sum + [30, 40, 0][i]!, 0);
      if (duration > minutes) return;
      const tuple = [indices.filter(i => i !== 0).length, 0, indices.filter(i => i === 2).length,
        indices.filter(i => i === 1).length * 0.5, indices.reduce((sum, i) => sum + i, 0)];
      if (!optimum || tuple.some((n, i) => n < optimum![i]! && tuple.slice(0, i).every((v, j) => v === optimum![j]))) optimum = tuple;
    };
    enumerate([]);
    assert.equal(combinations, 2187, "AC3-09-oracle-full-seven-days");
    const solve = () => repairCoachPlan({ previous, windowDates: dates, affectedDates: dates, protectedDates: [],
      requiredIntentDates: [], candidates: Object.fromEntries(dates.map((date, i) => [date, options[i]!.slice(1)])),
      maximumEvaluations: 2187, inputDigest: digest({ minutes, previous }),
      reasonsByDate: {}, validate: days => ({
        feasible: days.reduce((sum, day) => sum + (day.kind === "rest" ? 0 : 600 +
          (day.structure!.blocks[0]!.steps[0]!.goal as { type: "time"; seconds: number }).seconds), 0) <= minutes * 60,
        effectiveDays: days.map(day => ({ day, executable: day.kind !== "rest", authorizedDecisionRef: null } satisfies CoachRepairDay)),
        reasons: []
      }) });
    const rounds = [1, 2].map(round => {
      const started = performance.now(), result = solve(), elapsedMs = performance.now() - started;
      assert.notEqual(result.status, "not_evaluable", "AC3-search-seven-day-budget");
      assert.equal(result.evaluatedCandidates, combinations);
      assert.deepEqual(Object.values(result.cost!), optimum, "AC3-09-independent-seven-day-optimum");
      return { round, elapsedMs, evaluatedCandidates: result.evaluatedCandidates, outputHash: digest(result) };
    });
    assert.equal(rounds[0]!.outputHash, rounds[1]!.outputHash, "AC3-07-seven-day-determinism");
    return { minutes, optimum, combinations, rounds };
  });
  return { scenarioId: "R10-seven-day-exhaustive-oracle", status: "passed" as const, scope: "synthetic_easy_rest_without_relocation",
    maximumEvaluations: 2187, productionDatabaseSLA: "not_evaluable", independentHumanReview: "not_evaluable", results };
}
