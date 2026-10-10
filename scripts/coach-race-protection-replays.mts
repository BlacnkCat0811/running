import type { CoachExecutionPolicyContext, MobileRaceTarget } from "@rai/api-contracts";
import { COACH_POLICY_MANIFEST } from "../apps/api/src/coach-loop-policy.js";
import { executionPolicyContext, EXECUTION_PROTECTION_POLICY_VERSION } from "../apps/api/src/race-plan-policy.js";
import { coachLocalDate, shiftCoachDate } from "../apps/api/src/coach-loop-facts.js";
import { periodizationWeekStart } from "../apps/api/src/plan-periodization.js";
import { digest } from "../apps/api/src/plan-digest.js";
import { replayFrozenCoachSequence, type FrozenCoachSequence } from "./coach-sequence-replay.mjs";

/** Explicit-date semantic protection baseline: no claim of old/new dose equality. */
export function coachRaceProtectionReplays() {
  return (["five_k", "ten_k", "half_marathon"] as const).map(distance => {
    type State = { asOf: string; raceTarget: MobileRaceTarget; weeklyDistanceKm: number };
    const initial: State = { asOf: "2026-09-27T04:00:00Z",
      raceTarget: { date: "2026-11-01", distance, targetPaceSecondsPerKm: null }, weeklyDistanceKm: 20 };
    const sequence: FrozenCoachSequence<State, never, CoachExecutionPolicyContext> = {
      id: `R03-protection-${distance}`, version: "synthetic-v1", initialState: initial, initialStateHash: digest(initial),
      replayMode: "as_known_then", policyManifest: { ...COACH_POLICY_MANIFEST }, events: [],
      checkpoints: Array.from({ length: 43 }, (_, index) => {
        const localDate = shiftCoachDate("2026-09-27", index);
        const daysToRace = 35 - index;
        return { asOf: `${localDate}T04:00:00Z`, assertions: [
          { id: "independent-14-day-boundary", acceptanceId: "AC1-02", check: (output: CoachExecutionPolicyContext) =>
            output.protections.some(protection => protection.code === "pre_race_execution_protection") ===
              (daysToRace > 0 && daysToRace <= 14) },
          { id: "race-day-no-extra", acceptanceId: "AC1-03", check: (output: CoachExecutionPolicyContext) =>
            output.protections.some(protection => protection.code === "race_day_no_extra_training") === (daysToRace === 0) },
          ...(distance === "five_k" && daysToRace === 14 ? [{ id: "syn01-single-phase", acceptanceId: "AC1-04",
            check: (output: CoachExecutionPolicyContext) => output.phase === "peak" }] : [])
        ] };
      })
    };
    const report = replayFrozenCoachSequence(sequence, {
      version: EXECUTION_PROTECTION_POLICY_VERSION,
      apply: state => state,
      run: state => executionPolicyContext({ localDate: coachLocalDate(state.asOf),
        raceTarget: state.raceTarget, weeklyDistanceKm: state.weeklyDistanceKm })
    });
    const phasesByWeek = new Map<string, string | null>();
    let weekStable = true;
    for (const checkpoint of report.checkpoints) {
      const week = periodizationWeekStart(coachLocalDate(checkpoint.asOf));
      const previous = phasesByWeek.get(week);
      if (phasesByWeek.has(week) && previous !== checkpoint.output.phase) weekStable = false;
      phasesByWeek.set(week, checkpoint.output.phase);
    }
    return { ...report, status: report.status === "passed" && weekStable ? "passed" : "failed",
      metrics: { ...report.metrics, naturalWeekPhaseStable: weekStable, sameDoseVersionLegacyComparison: "not_evaluable" } };
  });
}
