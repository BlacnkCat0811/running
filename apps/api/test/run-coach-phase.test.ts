import assert from "node:assert/strict";
import test from "node:test";

import type { MobileRaceDistance, MobileRunCoachConfig } from "@rai/api-contracts";
import { runCoachPhase, runCoachRaceTarget } from "../src/run-coach-policy.js";
import { PHASE_BOUNDARIES, periodizationWeekStart } from "../src/plan-periodization.js";

/**
 * `runCoachPhase` is an adapter over the §20 skeleton, not a second implementation.
 *
 * It used to be its own algorithm — `floor(daysBetween(today, raceDate) / 7)` with a flat
 * `taper + 5` build window — and three things about it were measurable:
 *
 *   1. it was a function of the **day**, not the natural week, so one week could read
 *      `peak` on Monday and `taper` on Tuesday: the week plan and the "第 N 周 · 强化期"
 *      label would change under the runner mid-week;
 *   2. its build window ignored the distance, giving a 5K plan **five** weeks of build and
 *      the half marathon **four** — backwards, since a longer race needs the longer build;
 *   3. it never checked the distance against the calibrated 5K / 10K / half-marathon set, so
 *      a 42.195 km race was handed a phase even though it has no skeleton, no volume band
 *      and no taper to be in.
 *
 * The boundary table is the single source; every expectation below is read from it (or is
 * the acceptance value for the table itself), so a drifting constant shows up as a failure
 * rather than as a silently different plan.
 */

const TODAY = "2026-10-07"; // Wednesday
const WEEK_START = periodizationWeekStart(TODAY); // 2026-10-05

const addDays = (localDate: string, days: number): string =>
  new Date(Date.parse(`${localDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The Monday of the week `weeks` natural weeks away, so the skeleton reads `weeksToRace === weeks`. */
const raceInWeeks = (weeks: number): string => addDays(WEEK_START, 7 * weeks);

const config = (raceDate: string, raceDistanceKm: number): MobileRunCoachConfig => ({
  goal: "finish", raceDate, raceDistanceKm, targetTimeSeconds: null,
  runningDays: [1, 2, 3, 4, 5, 6, 7], longRunDays: [7], targetType: "pace", strengthTraining: false
});

const DISTANCES: ReadonlyArray<[MobileRaceDistance, number]> = [
  ["five_k", 5], ["ten_k", 10], ["half_marathon", 21.0975]
];

const phaseAt = (weeks: number, km: number): string | null => runCoachPhase(TODAY, config(raceInWeeks(weeks), km));

test("the build window is the distance's own boundary, and a longer race never builds less", () => {
  const buildLengths: number[] = [];
  for (const [distance, km] of DISTANCES) {
    const boundaries = PHASE_BOUNDARIES[distance];
    const observed = Array.from({ length: boundaries.taper + 1 + boundaries.build + 3 }, (_, weeks) => weeks)
      .filter(weeks => phaseAt(weeks, km) === "build");
    // Read from the table, not restated: a test that hard-coded `2` would keep passing after
    // the table moved, which is the drift this whole gate exists to prevent.
    assert.deepEqual(observed, Array.from({ length: boundaries.build }, (_, index) => boundaries.taper + 2 + index),
      `${distance} must spend exactly PHASE_BOUNDARIES.${distance}.build (${boundaries.build}) weeks in build`);
    buildLengths.push(observed.length);
  }
  // …and the acceptance value for the table itself, so a mutation of the table is visible.
  assert.deepEqual(buildLengths, [2, 3, 4], "5K / 10K / half marathon build lengths");
  assert.ok(buildLengths[0]! < buildLengths[1]! && buildLengths[1]! < buildLengths[2]!,
    "the build must grow with the distance: 5K < 10K < half marathon");
});

test("phase is constant across every natural week it is asked about", () => {
  for (const [distance, km] of DISTANCES) {
    const raceDate = raceInWeeks(8);
    for (let weeks = -1; weeks <= 10; weeks += 1) {
      const days = Array.from({ length: 7 }, (_, index) => addDays(addDays(WEEK_START, 7 * weeks), index));
      const phases = new Set(days.map(day => runCoachPhase(day, config(raceDate, km))));
      assert.equal(phases.size, 1,
        `${distance}: the week starting ${days[0]} read ${[...phases].join(" / ")} — phase must be a function of the week`);
    }
  }
});

test("race week, past, taper and peak keep the boundaries the §20 skeleton declares", () => {
  for (const [distance, km] of DISTANCES) {
    const { taper } = PHASE_BOUNDARIES[distance];
    assert.equal(phaseAt(-1, km), "past", `${distance}: a race in the past`);
    assert.equal(phaseAt(0, km), "race_week", `${distance}: the race week itself`);
    for (let weeks = 1; weeks <= taper; weeks += 1) {
      assert.equal(phaseAt(weeks, km), "taper", `${distance}: ${weeks} weeks out is still the taper`);
    }
    assert.equal(phaseAt(taper + 1, km), "peak", `${distance}: peak is the week before the taper`);
    assert.equal(phaseAt(taper + 2, km), "build", `${distance}: build starts as the taper ends`);
  }
});

test("a distance outside the calibrated set has no phase, not an invented one", () => {
  for (const km of [42.195, 1.6, 30, 1609.344]) {
    assert.equal(runCoachRaceTarget(config(raceInWeeks(8), km)), null, `${km} km is not a calibrated distance`);
    // "base" here was an assertion that a periodised plan exists. It does not: no skeleton,
    // no volume band, no taper. `null` is the honest answer, and the UI already has a word
    // for it ("持续训练").
    assert.equal(runCoachPhase(TODAY, config(raceInWeeks(8), km)), null, `${km} km must not be given a phase`);
  }
  // A fitness programme has no race at all, so it has no phase either.
  assert.equal(runCoachPhase(TODAY, { ...config(raceInWeeks(8), 10), goal: "fitness", raceDate: null, raceDistanceKm: null }), null);
});
