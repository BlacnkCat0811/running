import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPeriodization,
  currentPeriodizationWeek,
  periodizationVolumeFraction,
  periodizationWeekStart
} from "../src/plan-periodization.js";
import { enforcePhaseCeiling, weeklyPlanVolumeCeiling } from "../src/weekly-plan-validate.js";
import { buildPlanAdherence, replanAdvice, type PlanDayObservation } from "../src/plan-adherence.js";
import type { PlanHistoryRevision } from "../src/mobile-goals.js";

/**
 * G01–G04: the ways a race-driven plan goes wrong quietly.
 *
 *   G01  the phase boundaries drift, so "taper" is where "build" should be;
 *   G02  editing this week's plan rewrites last week's adherence;
 *   G03  an unobserved day is scored as a missed one;
 *   G04  advice turns into an automatic re-write.
 */

const TODAY = "2026-10-05"; // Monday
const addDays = (localDate: string, days: number): string => {
  const value = new Date(`${localDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
/** Monday of the week `n` weeks *before* today's week. */
const weeksAgo = (n: number): string => addDays(periodizationWeekStart(TODAY), -7 * n);
/** Race day `n` weeks from today, on the Saturday of that week. */
const raceIn = (n: number): string => addDays(periodizationWeekStart(TODAY), 7 * n + 5);

test("G01: phase boundaries follow the race distance, and the race week is the last one", () => {
  const half = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(12), distance: "half_marathon" },
    recentWeeklyKm: 40
  });
  assert.equal(half.weeks.length, 13, "race week plus twelve build weeks");
  const byPhase = (phase: string) => half.weeks.filter((item) => item.phase === phase).length;
  assert.equal(byPhase("taper"), 2, "a half marathon tapers for two weeks");
  assert.equal(byPhase("race_week"), 1);
  assert.ok(byPhase("base") >= 4);
  assert.equal(half.current?.weekStart, periodizationWeekStart(TODAY));
  // The *assignment* matters, not only the counts: a transposition that puts
  // `race_week` on the furthest week keeps every count identical.
  assert.equal(half.weeks.at(-1)!.phase, "race_week");
  assert.equal(half.weeks.at(-1)!.weeksToRace, 0);
  assert.equal(half.current!.phase, "base");
  assert.equal(half.current!.weeksToRace, half.weeks.length - 1);
  assert.deepEqual(
    half.weeks.map((week) => week.weeksToRace),
    half.weeks.map((_, index) => half.weeks.length - 1 - index),
    "weeksToRace counts down to zero at the race week"
  );

  // A 5K sharpens sooner: fewer base weeks, shorter taper.
  const fiveK = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(6), distance: "five_k" },
    recentWeeklyKm: 30
  });
  assert.equal(fiveK.weeks.filter((item) => item.phase === "taper").length, 1);
  assert.equal(fiveK.weeks.filter((item) => item.phase === "race_week").length, 1);
});

test("G01: taper and race week carry visibly smaller bands than build", () => {
  const plan = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(10), distance: "ten_k" },
    recentWeeklyKm: 40
  });
  const build = plan.weeks.find((item) => item.phase === "build")!;
  const taper = plan.weeks.find((item) => item.phase === "taper")!;
  const race = plan.weeks.find((item) => item.phase === "race_week")!;
  assert.ok(taper.volumeBandKm.upper < build.volumeBandKm.upper * 0.8, "taper must be a real reduction");
  assert.ok(race.volumeBandKm.upper < taper.volumeBandKm.upper);
  assert.ok(build.longRunCapKm > taper.longRunCapKm);
  assert.ok(plan.weeks.every((item) => item.volumeBandKm.lower <= item.volumeBandKm.upper));
  assert.ok(plan.weeks.every((item) => item.longRunCapKm <= item.volumeBandKm.upper));
  assert.equal(periodizationVolumeFraction("taper") < periodizationVolumeFraction("build"), true);
});

test("G01: a race more than 24 weeks out is capped, and a past race produces no skeleton", () => {
  const far = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(40), distance: "half_marathon" },
    recentWeeklyKm: 50
  });
  assert.equal(far.weeks.length, 24, "the horizon is bounded, not the ambition");
  assert.ok(far.reasonCodes.includes("race_beyond_maximum_horizon"));

  const past = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(-2), distance: "ten_k" },
    recentWeeklyKm: 50
  });
  assert.deepEqual(past.weeks, []);
  assert.equal(past.current, null);
  assert.ok(past.reasonCodes.includes("race_in_the_past"));
});

test("G01: without a race target the coach says so instead of inventing a phase", () => {
  const plan = buildPeriodization({ today: TODAY, raceTarget: null, recentWeeklyKm: 40 });
  assert.equal(plan.raceDate, null);
  assert.deepEqual(plan.weeks, []);
  assert.ok(plan.reasonCodes.includes("no_race_target"));
});

test("G01: a skeleton never reaches into the past", () => {
  const plan = buildPeriodization({
    today: weeksAgo(-4),
    raceTarget: { date: raceIn(6), distance: "ten_k" },
    recentWeeklyKm: 40
  });
  assert.ok(plan.weeks.every((item) => item.weekStart >= weeksAgo(-4)));
  assert.equal(plan.weeks[0]!.weekStart, weeksAgo(-4));
});

function revision(changedAt: string, revision: number, weekPlan: PlanHistoryRevision["weekPlan"]): PlanHistoryRevision {
  return { revision, changedAt, weekPlan, lockedSession: null };
}

const plannedWeek = (weekStart: string, distanceKm: number, kind: "easy" | "tempo" = "easy") =>
  Array.from({ length: 3 }, (_, index) => {
    const value = new Date(`${weekStart}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + index * 2);
    return {
      localDate: value.toISOString().slice(0, 10),
      kind,
      distanceKm
    };
  });

test("G02: a week is judged by the revision in force at its own midnight", () => {
  const periodization = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(8), distance: "ten_k" },
    recentWeeklyKm: 40
  });
  const history: PlanHistoryRevision[] = [
    // Edited today: must not rewrite what last week asked for.
    revision(`${TODAY}T09:00:00+08:00`, 2, plannedWeek(weeksAgo(0), 5)),
    revision(`${weeksAgo(2)}T20:00:00+08:00`, 1, plannedWeek(weeksAgo(1), 10))
  ];
  const actual: PlanDayObservation[] = [
    { localDate: weeksAgo(1), distanceKm: 10, workoutCount: 1 },
    { localDate: addDays(weeksAgo(1), 2), distanceKm: 10, workoutCount: 1 },
    { localDate: addDays(weeksAgo(1), 4), distanceKm: 10, workoutCount: 1 }
  ];
  const adherence = buildPlanAdherence({ today: TODAY, history, actual, periodization });
  const lastWeek = adherence.weeks.find((item) => item.weekStart === weeksAgo(1))!;
  assert.equal(lastWeek.plannedDistanceKm, 30, "the older revision asked for 3 × 10 km");
  assert.equal(lastWeek.status, "met");
  assert.equal(lastWeek.volumeRatio, 1);
});

test("G03: unobserved planned days are unknown, not missed", () => {
  const periodization = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(8), distance: "ten_k" },
    recentWeeklyKm: 40
  });
  const history = [revision(`${weeksAgo(2)}T20:00:00+08:00`, 1, plannedWeek(weeksAgo(1), 10))];
  const adherence = buildPlanAdherence({ today: TODAY, history, actual: [], periodization });
  const lastWeek = adherence.weeks.find((item) => item.weekStart === weeksAgo(1))!;
  assert.equal(lastWeek.observedDays, 0);
  assert.equal(lastWeek.unknownDays, 3);
  assert.equal(lastWeek.status, "unknown", "no observations is not a failed week");
  assert.equal(lastWeek.volumeRatio, 0);
});

test("G03: with no plan history the adherence block is explicitly unknown", () => {
  const periodization = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(8), distance: "ten_k" },
    recentWeeklyKm: 40
  });
  const adherence = buildPlanAdherence({ today: TODAY, history: [], actual: [], periodization });
  assert.ok(adherence.reasonCodes.includes("no_plan_history"));
  assert.ok(adherence.weeks.every((item) => item.status === "unknown"));
});

test("G03: a week the plan asked nothing for is not 'met'", () => {
  const periodization = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(8), distance: "ten_k" },
    recentWeeklyKm: 40
  });
  const history = [revision(`${weeksAgo(2)}T20:00:00+08:00`, 1, [])];
  const adherence = buildPlanAdherence({ today: TODAY, history, actual: [{ localDate: weeksAgo(1), distanceKm: 12, workoutCount: 1 }], periodization });
  const lastWeek = adherence.weeks.find((item) => item.weekStart === weeksAgo(1))!;
  assert.equal(lastWeek.plannedDistanceKm, null);
  assert.equal(lastWeek.volumeRatio, null);
  assert.notEqual(lastWeek.status, "met");
});

test("G04: re-plan advice needs two consecutive low weeks and never writes", () => {
  const periodization = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(8), distance: "ten_k" },
    recentWeeklyKm: 40
  });
  // Each revision is stamped the week before the week it prescribes.
  const history = [
    revision(`${weeksAgo(4)}T20:00:00+08:00`, 1, plannedWeek(weeksAgo(3), 10)),
    revision(`${weeksAgo(3)}T20:00:00+08:00`, 2, plannedWeek(weeksAgo(2), 10)),
    revision(`${weeksAgo(2)}T20:00:00+08:00`, 3, plannedWeek(weeksAgo(1), 10))
  ];
  const oneLowWeek = buildPlanAdherence({
    today: TODAY,
    history,
    actual: [{ localDate: weeksAgo(1), distanceKm: 2, workoutCount: 1 }],
    periodization
  });
  // Only one of the two recent weeks has observations, the other is unknown: the
  // advice must not treat "we did not see it" as "it did not happen".
  const advice = replanAdvice({ adherence: oneLowWeek, periodization });
  assert.equal(advice.recommended, false);
  assert.deepEqual(advice.reasons, []);

  const twoLowWeeks = buildPlanAdherence({
    today: TODAY,
    history,
    actual: [
      { localDate: weeksAgo(2), distanceKm: 2, workoutCount: 1 },
      { localDate: addDays(weeksAgo(2), 2), distanceKm: 2, workoutCount: 1 },
      { localDate: weeksAgo(1), distanceKm: 2, workoutCount: 1 }
    ],
    periodization
  });
  const advised = replanAdvice({ adherence: twoLowWeeks, periodization });
  assert.equal(advised.recommended, true);
  assert.ok(advised.reasons.some((reason) => reason.code === "consecutive_low_volume_weeks"));
  assert.match(advised.reasons[0]!.detail, /低于计划/);
});

test("G04: a plan above the phase band is flagged, not silently trimmed", () => {
  const periodization = buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(1), distance: "ten_k" },
    recentWeeklyKm: 40
  });
  const history = [revision(`${weeksAgo(1)}T20:00:00+08:00`, 1, plannedWeek(weeksAgo(0), 30))];
  const adherence = buildPlanAdherence({ today: TODAY, history, actual: [], periodization });
  const advice = replanAdvice({ adherence, periodization });
  assert.ok(advice.reasons.some((reason) => reason.code === "plan_above_phase_band"));
});

/**
 * G05: the skeleton has to reach the prescription, not just the read-out.
 *
 * The failure this pins is a taper that exists in the plan view while the generated
 * week is still a build week — the runner sees "减量期" and is handed the volume of
 * 专项期, which is worse than showing no phase at all.
 */

test("G05: without a race target nothing changes — the same ceiling as before", () => {
  const before = weeklyPlanVolumeCeiling(40, null);
  assert.equal(weeklyPlanVolumeCeiling(40, null, null), before);
  assert.equal(weeklyPlanVolumeCeiling(40, null, undefined), before);
  // A phase cap may only ever lower a ceiling, never raise one.
  assert.equal(weeklyPlanVolumeCeiling(40, null, 2), before);
  assert.ok(weeklyPlanVolumeCeiling(40, null, periodizationVolumeFraction("taper")) < before);
  // The ramp limit still wins when it is the tighter of the two.
  assert.equal(weeklyPlanVolumeCeiling(40, 10, 1.5), weeklyPlanVolumeCeiling(40, 10));
});

test("G05: the current week is the phase the skeleton reports, and null without a race", () => {
  const taper = currentPeriodizationWeek({
    today: TODAY,
    raceTarget: { date: raceIn(1), distance: "half_marathon" },
    recentWeeklyKm: 60
  });
  assert.equal(taper?.phase, "taper");
  assert.equal(taper?.volumeBandKm.upper, 45, "0.75 × 60 km");

  const raceWeek = currentPeriodizationWeek({
    today: TODAY,
    raceTarget: { date: addDays(periodizationWeekStart(TODAY), 3), distance: "ten_k" },
    recentWeeklyKm: 60
  });
  assert.equal(raceWeek?.phase, "race_week");
  assert.ok(raceWeek!.volumeBandKm.upper < taper!.volumeBandKm.upper);

  assert.equal(
    currentPeriodizationWeek({ today: TODAY, raceTarget: null, recentWeeklyKm: 60 }),
    null,
    "no race target means no phase, not a default one"
  );
});

test("G05: enforcement compresses the week proportionally and keeps its shape", () => {
  const days = [
    { localDate: "2026-10-05", kind: "easy" as const, distanceKm: 10, structure: null, reason: null },
    { localDate: "2026-10-06", kind: "tempo" as const, distanceKm: 12, structure: null, reason: null },
    { localDate: "2026-10-07", kind: "rest" as const, distanceKm: null, structure: null, reason: null },
    { localDate: "2026-10-08", kind: "long_run" as const, distanceKm: 18, structure: null, reason: null }
  ];
  const warnings: string[] = [];
  const capped = enforcePhaseCeiling(days, 20, "减量期", warnings);
  const total = capped.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  assert.ok(total <= 20 + 0.5, `expected the week inside the ceiling, got ${total}`);
  assert.equal(capped[2]!.kind, "rest", "a rest day is not scaled into a run");
  assert.equal(capped[2]!.distanceKm, null);
  // Proportional: the long run stays the longest day and the easy run stays the shortest.
  assert.ok(capped[3]!.distanceKm! > capped[1]!.distanceKm!);
  assert.ok(capped[1]!.distanceKm! > capped[0]!.distanceKm!);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /减量期/);
  assert.match(warnings[0]!, /40\.0 km/);

  // Inside the ceiling, or with no ceiling at all: untouched, and no warning.
  const quiet: string[] = [];
  assert.deepEqual(enforcePhaseCeiling(days, 100, "基础期", quiet), days);
  assert.deepEqual(enforcePhaseCeiling(days, null, null, quiet), days);
  assert.deepEqual(enforcePhaseCeiling(days, Number.NaN, "基础期", quiet), days);
  assert.deepEqual(quiet, []);
});
