import assert from "node:assert/strict";
import test from "node:test";

import { buildPlanAdherence, replanAdvice } from "../src/plan-adherence.js";
import { buildPeriodization, periodizationWeekStart } from "../src/plan-periodization.js";
import type { PlanHistoryRevision } from "../src/mobile-goals.js";

/**
 * Re-plan advice wording (plan-card review 2026-10-06, C3 / 方案 A3).
 *
 * The `consecutive_low_volume_weeks` heuristic only reads **completed** weeks, but
 * its detail used to say "当前周量可能已经不现实" — an assertion about the current
 * week that the same card could contradict with "本周 按计划". Both numbers were
 * right; the sentence was not. The detail must name the window it actually
 * measured: weeks that have ended.
 */

const TODAY = "2026-10-05"; // Monday
const addDays = (localDate: string, days: number): string => {
  const value = new Date(`${localDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const weeksAgo = (n: number): string => addDays(periodizationWeekStart(TODAY), -7 * n);

function revision(changedAt: string, revisionNumber: number, weekPlan: PlanHistoryRevision["weekPlan"]): PlanHistoryRevision {
  return { revision: revisionNumber, changedAt, weekPlan, lockedSession: null };
}

/** Three prescribed 10 km days in the week starting `weekStart`. */
const lowWeekPlan = (weekStart: string) =>
  Array.from({ length: 3 }, (_, index) => ({
    localDate: addDays(weekStart, index * 2),
    kind: "easy" as const,
    distanceKm: 10
  }));

test("A3: two completed low weeks recommend a re-draft without claiming anything about the current week", () => {
  const periodization = buildPeriodization({ today: TODAY, raceTarget: null, recentWeeklyKm: 40 });
  const history: PlanHistoryRevision[] = [
    // Current week was drafted this morning and is on track.
    revision(`${TODAY}T09:00:00+08:00`, 4, [{ localDate: TODAY, kind: "easy" as const, distanceKm: 10 }]),
    // Each earlier revision is stamped the week before the week it prescribes.
    revision(`${weeksAgo(3)}T20:00:00+08:00`, 1, lowWeekPlan(weeksAgo(3))),
    revision(`${weeksAgo(2)}T20:00:00+08:00`, 2, lowWeekPlan(weeksAgo(2))),
    revision(`${weeksAgo(1)}T20:00:00+08:00`, 3, lowWeekPlan(weeksAgo(1)))
  ];
  const adherence = buildPlanAdherence({
    today: TODAY,
    history,
    actual: [
      // Two completed weeks delivered 2 km of the prescribed 30 km: under.
      { localDate: weeksAgo(2), distanceKm: 2, workoutCount: 1 },
      { localDate: weeksAgo(1), distanceKm: 2, workoutCount: 1 },
      // Current week delivered its 10 km obligation: on_track, not under.
      { localDate: TODAY, distanceKm: 10, workoutCount: 1 }
    ],
    periodization
  });

  assert.equal(adherence.current?.status, "on_track");
  const advice = replanAdvice({ adherence, periodization });
  assert.equal(advice.recommended, true);
  const low = advice.reasons.find((reason) => reason.code === "consecutive_low_volume_weeks");
  assert.ok(low, "two completed low weeks must trigger the advice");
  assert.match(low!.detail, /连续 2 周（已结束）/);
  assert.match(low!.detail, /周量上限可能需要下调/);
  assert.equal(low!.detail.includes("当前周"), false,
    "the heuristic only counts completed weeks; the detail must not assert anything about the current week");
  assert.equal(low!.detail.includes("已经不现实"), false);
  assert.equal(advice.reasons.some((reason) => reason.code === "plan_above_phase_band"), false,
    "no race skeleton means no phase-band comparison");
});

test("A3: only one completed low week is not enough; a completed on-track week breaks the streak", () => {
  const periodization = buildPeriodization({ today: TODAY, raceTarget: null, recentWeeklyKm: 40 });
  const onTrackWeek = (weekStart: string) => [{ localDate: weekStart, kind: "easy" as const, distanceKm: 10 }];
  const history: PlanHistoryRevision[] = [
    revision(`${weeksAgo(2)}T20:00:00+08:00`, 1, lowWeekPlan(weeksAgo(2))),
    revision(`${weeksAgo(1)}T20:00:00+08:00`, 2, onTrackWeek(weeksAgo(1)))
  ];
  const advice = replanAdvice({
    adherence: buildPlanAdherence({
      today: TODAY,
      history,
      actual: [
        { localDate: weeksAgo(2), distanceKm: 2, workoutCount: 1 },
        { localDate: weeksAgo(1), distanceKm: 10, workoutCount: 1 }
      ],
      periodization
    }),
    periodization
  });
  assert.deepEqual(advice.reasons, []);
});
