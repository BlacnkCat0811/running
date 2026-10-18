import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPeriodization,
  currentPeriodizationWeek,
  periodizationPhaseFor,
  periodizationVolumeFraction,
  periodizationWeekStart
} from "../src/plan-periodization.js";
import { weeklyPlanVolumeCeiling } from "../src/weekly-plan-validate.js";
import { weeklyCapacity } from "../src/weekly-capacity.js";
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
  assert.equal(byPhase("peak"), 1, "peak precedes the full taper window");
  assert.equal(byPhase("build"), 4);
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
  assert.equal(fiveK.weeks.filter((item) => item.phase === "peak").length, 1);
  assert.equal(fiveK.weeks.filter((item) => item.phase === "build").length, 2);
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

test("G01: weeksToRace 23 and 24 include the current week; 25 is the first forward-only skeleton", () => {
  const week = (weeksToRace: number) => buildPeriodization({
    today: TODAY,
    raceTarget: { date: raceIn(weeksToRace), distance: "half_marathon" },
    recentWeeklyKm: 40
  });

  const twentyThree = week(23);
  assert.equal(twentyThree.weeks.length, 24, "current week + 23 weeks to the race");
  assert.equal(twentyThree.current?.weekStart, periodizationWeekStart(TODAY));
  assert.equal(twentyThree.current?.phase, "base");
  assert.equal(twentyThree.weeks[0]!.weekStart, periodizationWeekStart(TODAY));
  assert.equal(twentyThree.reasonCodes.includes("race_beyond_maximum_horizon"), false);

  const twentyFour = week(24);
  assert.equal(twentyFour.weeks.length, 25, "the supported 24-week horizon still contains the current week");
  assert.equal(twentyFour.current?.weekStart, periodizationWeekStart(TODAY));
  assert.equal(twentyFour.current?.phase, "base");
  assert.equal(twentyFour.current?.weeksToRace, 24);
  assert.equal(twentyFour.weeks[0]!.weekStart, periodizationWeekStart(TODAY));
  assert.equal(twentyFour.weeks.at(-1)!.phase, "race_week");
  assert.deepEqual(twentyFour.reasonCodes, [], "a 24-week race is supported, not beyond the horizon");
  assert.deepEqual(
    twentyFour.weeks.map((item) => item.weeksToRace),
    Array.from({ length: 25 }, (_, index) => 24 - index)
  );

  const twentyFive = week(25);
  assert.equal(twentyFive.weeks.length, 24, "beyond the horizon only the 24 future rows remain");
  assert.equal(twentyFive.current, null, "a 25-week race has no current row to render");
  assert.equal(twentyFive.weeks[0]!.weekStart, addDays(periodizationWeekStart(TODAY), 14), "the forward window starts two weeks ahead");
  assert.equal(twentyFive.weeks[0]!.weeksToRace, 23);
  assert.ok(twentyFive.reasonCodes.includes("race_beyond_maximum_horizon"));
  assert.ok(twentyFive.reasonCodes.includes("current_week_outside_window"));
  assert.equal(twentyFive.weeks.at(-1)!.phase, "race_week");
});

test("G01: weeklyCapacity keeps the phase (and its trim) at the supported 24-week boundary", () => {
  const at = (weeksToRace: number) => weeklyCapacity({
    today: TODAY,
    raceTarget: { date: raceIn(weeksToRace), distance: "half_marathon" },
    recentWeeklyKm: 40,
    previousWeekDistanceKm: 40
  });

  const twentyThree = at(23);
  const twentyFour = at(24);
  assert.equal(twentyThree.phase, "base");
  assert.equal(twentyFour.phase, "base", "a supported 24-week race must still have a phase");
  // 35 km half-marathon race baseline × base upper 1.05, capped by recent × 1.3.
  assert.equal(twentyThree.baselineKm, 36.75);
  assert.equal(twentyFour.baselineKm, 36.75, "the phase trim was previously lost at exactly 24 weeks (35)");

  const beyond = at(25);
  assert.equal(beyond.phase, null, "past the horizon the phase is deliberately not claimed here");
  assert.equal(beyond.baselineKm, 35);
});

test("G01: invalid calendar dates are rejected instead of rolled into a neighbouring day", () => {
  // `Date.parse("2026-02-30T00:00:00Z")` silently becomes 2 March, so a bare
  // regex-plus-parse check accepted it. Both entry points now share the strict
  // calendar validator.
  assert.throws(() => buildPeriodization({
    today: "2026-02-30",
    raceTarget: { date: "2026-03-21", distance: "ten_k" },
    recentWeeklyKm: 30
  }), /local date/);
  assert.throws(() => periodizationPhaseFor("2026-02-30", { date: "2026-03-21", distance: "ten_k" }), /local dates/);
  assert.throws(() => periodizationPhaseFor("2026-02-29", { date: "2026-03-21", distance: "ten_k" }), /local dates/,
    "2026 is not a leap year");
  assert.equal(periodizationPhaseFor("2024-02-29", { date: "2024-06-01", distance: "ten_k" }), "base",
    "2024-02-29 exists and must be accepted");
  assert.equal(periodizationWeekStart("2028-02-29"), "2028-02-28");
  assert.equal(periodizationWeekStart("2024-02-29"), "2024-02-26");

  // An invalid race date is not a race target; it must not produce a skeleton.
  const invalidRace = buildPeriodization({
    today: TODAY,
    raceTarget: { date: "2026-02-30", distance: "ten_k" },
    recentWeeklyKm: 30
  });
  assert.equal(invalidRace.raceDate, null);
  assert.deepEqual(invalidRace.weeks, []);
  assert.ok(invalidRace.reasonCodes.includes("no_race_target"));

  // weeklyCapacity gates the phase on the same strict validator rather than throwing.
  const invalidToday = weeklyCapacity({
    today: "2026-02-30",
    raceTarget: { date: raceIn(4), distance: "ten_k" },
    recentWeeklyKm: 30
  });
  assert.equal(invalidToday.phase, null);
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

test("G02: later edits do not rewrite an elapsed week's prescriptions", () => {
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

test("Monday and midweek plans are counted without rewriting elapsed days", () => {
  const today = "2026-10-07";
  const periodization = buildPeriodization({ today, raceTarget: null, recentWeeklyKm: 40 });
  const monday = plannedWeek("2026-10-05", 10);
  const midweek = [
    { localDate: "2026-10-05", kind: "easy" as const, distanceKm: 99 },
    { localDate: today, kind: "easy" as const, distanceKm: 5 },
    { localDate: "2026-10-09", kind: "easy" as const, distanceKm: 15 }
  ];
  const history = [revision("2026-10-07T09:00:00+08:00", 2, midweek),
    revision("2026-10-05T09:00:00+08:00", 1, monday)];
  const adherence = buildPlanAdherence({ today, history, periodization, actual: [
    { localDate: "2026-10-05", workoutCount: 1, distanceKm: 10 },
    { localDate: today, workoutCount: 1, distanceKm: 10 }
  ] });
  assert.equal(adherence.policyVersion, "rai-plan-adherence-v3");
  assert.equal(adherence.current!.plannedDays, 3);
  assert.equal(adherence.current!.plannedDistanceKm, 35, "past/current days freeze; future days use the latest plan");
  assert.equal(adherence.current!.observedDistanceKm, 20);
  assert.equal(adherence.current!.status, "on_track");
  const firstMidweek = buildPlanAdherence({ today, periodization, actual: [],
    history: [revision("2026-10-07T09:00:00+08:00", 1, midweek.filter(day => day.localDate >= today))] });
  assert.equal(firstMidweek.current!.plannedDays, 2);
  assert.equal(firstMidweek.current!.plannedDistanceKm, 20);
  // Rest days are not obligations and must not be counted: a week of one run plus six explicit
  // rest days reported `plannedDays: 7` while `unknownDays`/`qualityPlanned` were derived from
  // the single prescribed day. Nothing renders it, which is why it survived — until someone
  // builds "本周剩余 N 次" on top of it.
  const withRests = buildPlanAdherence({ today, periodization, actual: [],
    history: [revision("2026-10-07T09:00:00+08:00", 1, [
      { localDate: today, kind: "easy" as const, distanceKm: 5 },
      ...[2, 3, 4, 5, 6, 7].map(offset => ({ localDate: addDays(today, offset), kind: "rest" as const, distanceKm: null }))
    ])] });
  assert.equal(withRests.current!.plannedDays, 1, "six rest days are not six planned sessions");
  assert.equal(withRests.current!.plannedDistanceKm, 5);
  assert.equal(withRests.current!.unknownDays, 1, "unknownDays counts the same universe as plannedDays");
  const allRests = buildPlanAdherence({ today, periodization, actual: [],
    history: [revision("2026-10-07T09:00:00+08:00", 1,
      [2, 3, 4, 5, 6, 7].map(offset => ({ localDate: addDays(today, offset), kind: "rest" as const, distanceKm: null })))] });
  assert.equal(allRests.current!.plannedDays, 0);
  assert.equal(allRests.current!.status, "unknown", "a week with no obligation cannot report progress");
  const nextWeek = buildPlanAdherence({ today: "2026-10-12", history, periodization, actual: [] });
  assert.equal(nextWeek.weeks[1]!.plannedDistanceKm, 35, "the same daily obligations survive after the week ends");
});

test("same-day initial obligations cannot be replaced by later revisions", () => {
  const today = "2026-10-05";
  const periodization = buildPeriodization({ today, raceTarget: null, recentWeeklyKm: 40 });
  const first = [{ localDate: today, kind: "easy" as const, distanceKm: 10 }];
  const history = [revision("2026-10-05T17:00:00+08:00", 2, [{ ...first[0]!, distanceKm: 1 }]),
    revision("2026-10-05T09:00:00+08:00", 1, first)];
  const current = buildPlanAdherence({ today, history, periodization,
    actual: [{ localDate: today, workoutCount: 1, distanceKm: 10 }] }).current!;
  assert.equal(current.plannedDistanceKm, 10);
  assert.equal(current.volumeRatio, 1);
  const futureBackfill = buildPlanAdherence({ today: "2026-10-12", periodization, actual: [],
    history: [revision("2026-10-12T09:00:00+08:00", 1, first)] });
  assert.equal(futureBackfill.weeks[1]!.plannedDays, 0);
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

test("G03: runs before a midweek plan cannot fulfill its unobserved prescriptions", () => {
  const periodization = buildPeriodization({ today: TODAY, raceTarget: null, recentWeeklyKm: 40 });
  const lastMonday = weeksAgo(1);
  const history = [revision(`${addDays(lastMonday, 3)}T09:00:00+08:00`, 1, [
    { localDate: addDays(lastMonday, 4), kind: "easy", distanceKm: 5 },
    { localDate: addDays(lastMonday, 6), kind: "easy", distanceKm: 5 }
  ])];
  const adherence = buildPlanAdherence({ today: TODAY, history, periodization,
    actual: [{ localDate: lastMonday, distanceKm: 10, workoutCount: 1 }] });
  const lastWeek = adherence.weeks[1]!;
  assert.equal(lastWeek.plannedDistanceKm, 10);
  assert.equal(lastWeek.observedDistanceKm, 0);
  assert.equal(lastWeek.observedDays, 0);
  assert.equal(lastWeek.unknownDays, 2);
  assert.equal(lastWeek.volumeRatio, 0);
  assert.equal(lastWeek.status, "unknown");
  assert.equal(replanAdvice({ adherence, periodization }).recommended, false);
});

test("G03: rest-day runs do not inflate adherence and missing rest-day observations are not unknown", () => {
  const periodization = buildPeriodization({ today: TODAY, raceTarget: null, recentWeeklyKm: 40 });
  const lastMonday = weeksAgo(1);
  const history = [revision(`${weeksAgo(2)}T09:00:00+08:00`, 1, [
    { localDate: lastMonday, kind: "rest", distanceKm: null },
    { localDate: addDays(lastMonday, 1), kind: "rest", distanceKm: null },
    { localDate: addDays(lastMonday, 2), kind: "easy", distanceKm: 10 },
    { localDate: addDays(lastMonday, 4), kind: "easy", distanceKm: 10 }
  ])];
  const lastWeek = buildPlanAdherence({ today: TODAY, history, periodization, actual: [
    { localDate: lastMonday, distanceKm: 30, workoutCount: 1 },
    { localDate: addDays(lastMonday, 2), distanceKm: 5, workoutCount: 1 }
  ] }).weeks[1]!;
  assert.equal(lastWeek.plannedDistanceKm, 20);
  assert.equal(lastWeek.observedDistanceKm, 5);
  assert.equal(lastWeek.observedDays, 1);
  assert.equal(lastWeek.unknownDays, 1);
  assert.equal(lastWeek.volumeRatio, 0.25);
  assert.equal(lastWeek.status, "under");
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

test("G01: all distances reach peak without shortening taper or build", () => {
  for (const [distance, taperWeeks, buildWeeks] of [
    ["five_k", 1, 2], ["ten_k", 2, 3], ["half_marathon", 2, 4]
  ] as const) {
    const plan = buildPeriodization({ today: TODAY, raceTarget: { date: raceIn(12), distance }, recentWeeklyKm: 40 });
    const phaseAt = (weeksToRace: number) => plan.weeks.find(week => week.weeksToRace === weeksToRace)!.phase;
    assert.equal(phaseAt(0), "race_week");
    for (let week = 1; week <= taperWeeks; week++) assert.equal(phaseAt(week), "taper");
    assert.equal(phaseAt(taperWeeks + 1), "peak");
    for (let week = taperWeeks + 2; week <= taperWeeks + buildWeeks + 1; week++) assert.equal(phaseAt(week), "build");
    assert.equal(phaseAt(taperWeeks + buildWeeks + 2), "base");
  }
});

test("future quality sessions do not make Monday under-delivered or trigger replanning", () => {
  const periodization = buildPeriodization({ today: TODAY, raceTarget: null, recentWeeklyKm: 40 });
  const history = [revision(`${weeksAgo(1)}T20:00:00+08:00`, 1, [
    { localDate: TODAY, kind: "easy", distanceKm: 8 },
    { localDate: addDays(TODAY, 2), kind: "tempo", distanceKm: 12 },
    { localDate: addDays(TODAY, 4), kind: "interval", distanceKm: 20 }
  ])];
  const adherence = buildPlanAdherence({ today: TODAY, history, actual: [{ localDate: TODAY, distanceKm: 8, workoutCount: 1 }], periodization });
  assert.equal(adherence.current!.plannedDistanceKm, 40);
  assert.equal(adherence.current!.status, "on_track");
  assert.equal(replanAdvice({ adherence, periodization }).recommended, false);
});

test("unknown weeks break consecutive low-volume observations", () => {
  const periodization = buildPeriodization({ today: TODAY, raceTarget: null, recentWeeklyKm: 40 });
  const history = [revision(`${weeksAgo(4)}T20:00:00+08:00`, 1, [
    ...plannedWeek(weeksAgo(1), 10), ...plannedWeek(weeksAgo(2), 10), ...plannedWeek(weeksAgo(3), 10)
  ])];
  const adherence = buildPlanAdherence({ today: TODAY, history, actual: [
    { localDate: weeksAgo(1), distanceKm: 2, workoutCount: 1 },
    { localDate: weeksAgo(3), distanceKm: 2, workoutCount: 1 }
  ], periodization });
  assert.equal(replanAdvice({ adherence, periodization }).recommended, false);
});
