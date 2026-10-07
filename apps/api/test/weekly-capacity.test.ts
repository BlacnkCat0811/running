import assert from "node:assert/strict";
import test from "node:test";

import type { MobileRaceTarget, MobileTodayResponse } from "@rai/api-contracts";
import { recentWeeklyKm } from "../src/data.js";
import { periodizationVolumeFraction, periodizationWeekStart } from "../src/plan-periodization.js";
import { generateWeeklyPlan } from "../src/weekly-plan-service.js";
import { weeklyPlanVolumeCeiling } from "../src/weekly-plan-validate.js";
import { NO_HISTORY_WEEKLY_KM, RACE_WEEKLY_BASELINE_KM, weeklyCapacity } from "../src/weekly-capacity.js";

/**
 * Capacity is derived, never configured.
 *
 * The runner used to store a weekly distance goal and the coach read it as both
 * the ceiling and the athlete's recent volume. `weeklyCapacity` is the single
 * replacement: a race target, or observed volume, or a bare restart floor. Every
 * assertion below is a comparison between two numbers, so a mutation that
 * silently widens or narrows the ceiling cannot pass.
 */

const TODAY = "2026-10-05"; // Monday
const addDays = (localDate: string, days: number): string => {
  const value = new Date(`${localDate}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
/** Race day `n` weeks from today, on the Saturday of that week. */
const raceIn = (n: number): string => addDays(periodizationWeekStart(TODAY), 7 * n + 5);

/**
 * Tolerance-based equality for derived numbers.
 *
 * `19.25 * 1.3` is `25.025000000000002`: the assertion still pins the value, but
 * the fraction `RAMP_LIMIT_FRACTION` cannot be represented exactly, so an exact
 * comparison would fail on rounding rather than on behaviour.
 */
const close = (actual: number, expected: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
};

test("W01: without a race target the baseline is observed volume, and the phase stays null", () => {
  const capacity = weeklyCapacity({
    today: TODAY,
    raceTarget: null,
    recentWeeklyKm: 20,
    previousWeekDistanceKm: 20
  });
  assert.equal(capacity.source, "recent_volume");
  assert.equal(capacity.baselineKm, 20);
  assert.equal(capacity.phase, null, "no race target means no phase — never an invented one");
  assert.equal(capacity.coldStart, false);
  // A flat week stays flat: min(20, max(20, 10) * 1.3) = 20.
  assert.equal(weeklyPlanVolumeCeiling(capacity.baselineKm, 20), 20);
});

test("W02: a race target raises the ceiling only as far as recent volume allows", () => {
  const raceTarget = { date: raceIn(5), distance: "half_marathon" as const };
  const capacity = weeklyCapacity({
    today: TODAY,
    raceTarget,
    recentWeeklyKm: 8,
    previousWeekDistanceKm: 8
  });
  const raceTargetKm = RACE_WEEKLY_BASELINE_KM.half_marathon * periodizationVolumeFraction("build");
  assert.equal(capacity.phase, "build", "five weeks out is the build phase for a half marathon");
  assert.equal(capacity.source, "race_target");
  close(capacity.baselineKm, 10.4, "recent volume plus 30% caps the race baseline");
  assert.ok(capacity.baselineKm < raceTargetKm, "the race target is not reached from an 8 km week");

  // The reason this guard is written out instead of delegated: the shared
  // ceiling floors its ramp base at half the *goal*, which for a race baseline
  // would permit a threefold jump. These two numbers are the whole argument.
  close(weeklyPlanVolumeCeiling(raceTargetKm, 8), 25.025, "the shared ramp would allow this week");
  close(weeklyPlanVolumeCeiling(capacity.baselineKm, 8), 10.4, "this week's ceiling comes from observed volume");
  assert.ok(
    weeklyPlanVolumeCeiling(raceTargetKm, 8) > weeklyPlanVolumeCeiling(capacity.baselineKm, 8) * 2.4,
    "delegating to the shared ramp would have allowed more than twice this week"
  );
});

test("W03: a recent surge does not lift the ceiling above the race target", () => {
  const capacity = weeklyCapacity({
    today: TODAY,
    raceTarget: { date: raceIn(5), distance: "half_marathon" },
    recentWeeklyKm: 60,
    previousWeekDistanceKm: 60
  });
  const raceTargetKm = RACE_WEEKLY_BASELINE_KM.half_marathon * periodizationVolumeFraction("build");
  assert.equal(capacity.source, "race_target");
  assert.equal(capacity.baselineKm, raceTargetKm);
  assert.ok(capacity.baselineKm < 60, "a 60 km habit does not become a 60 km goal");
});

test("W04: with nothing observed the baseline is the restart floor, not a stored default", () => {
  const capacity = weeklyCapacity({
    today: TODAY,
    raceTarget: null,
    recentWeeklyKm: 0,
    previousWeekDistanceKm: null
  });
  assert.equal(capacity.source, "no_history");
  assert.equal(capacity.coldStart, true);
  assert.equal(capacity.baselineKm, NO_HISTORY_WEEKLY_KM);
  assert.equal(capacity.baselineKm, 5);
  assert.ok(capacity.reasonCodes.includes("no_recent_weekly_volume"));
  assert.ok(capacity.reasonCodes.includes("no_race_target"));
  // The floor exists to stay above `MIN_PLANNED_DISTANCE_KM`: at 1 km the shared
  // ceiling's `Math.min` is pinned by its own floor and no later ramp lifts it.
  assert.equal(weeklyPlanVolumeCeiling(capacity.baselineKm, null), 5);
  assert.equal(weeklyPlanVolumeCeiling(0, null), 1, "a zero baseline would collapse the week");
});

test("W05: a race target does not invent volume that was never observed", () => {
  const capacity = weeklyCapacity({
    today: TODAY,
    raceTarget: { date: raceIn(5), distance: "half_marathon" },
    recentWeeklyKm: 0,
    previousWeekDistanceKm: null
  });
  assert.equal(capacity.source, "no_history");
  assert.equal(capacity.baselineKm, NO_HISTORY_WEEKLY_KM);
  assert.equal(capacity.phase, "build", "the phase is still reported; it just cannot raise the floor");
});

test("W06: an unknown race distance degrades to observed volume instead of poisoning the ceiling", () => {
  const capacity = weeklyCapacity({
    today: TODAY,
    raceTarget: { date: raceIn(5), distance: "ultra_100k" as never },
    recentWeeklyKm: 20,
    previousWeekDistanceKm: 20
  });
  assert.equal(capacity.source, "recent_volume");
  assert.equal(capacity.baselineKm, 20);
  assert.ok(Number.isFinite(capacity.baselineKm), "a bad distance must not produce NaN");
});

test("W07: a pre-resolved phase is honoured rather than re-derived", () => {
  const capacity = weeklyCapacity({
    today: TODAY,
    raceTarget: { date: raceIn(5), distance: "half_marathon" },
    recentWeeklyKm: 40,
    previousWeekDistanceKm: 40,
    phase: "taper"
  });
  assert.equal(capacity.phase, "taper");
  assert.equal(capacity.baselineKm, 26.25, "35 km race baseline trimmed by the taper fraction");
});

test("W08: low recorded volume retains a restart baseline without bypassing the ramp", () => {
  for (const raceTarget of [null, { date: raceIn(12), distance: "ten_k" as const }]) {
    const capacity = weeklyCapacity({ today: TODAY, raceTarget, recentWeeklyKm: 1.3, previousWeekDistanceKm: 5 });
    assert.equal(capacity.baselineKm, 5);
    assert.ok(capacity.reasonCodes.includes("restart_volume_floor"));
    assert.equal(weeklyPlanVolumeCeiling(capacity.baselineKm, 5), 5);
    close(weeklyPlanVolumeCeiling(capacity.baselineKm, 1), 3.25, "a small realised week still constrains the restart floor");
  }
  assert.equal(weeklyCapacity({ today: TODAY, recentWeeklyKm: 0, previousWeekDistanceKm: 5 }).baselineKm, 5);
});

test("W09: following a coach restart plan remains executable across eight calendar weeks", async () => {
  for (const distance of [null, "five_k", "ten_k", "half_marathon"] as const) {
    const raceTarget: MobileRaceTarget | null = distance == null ? null : {
      date: raceIn(16), distance, targetPaceSecondsPerKm: 330
    };
    const observed: Array<{ localDate: string; distanceMeters: number }> = [];
    let previousWeekDistanceKm = 0;
    for (let week = 0; week < 8; week += 1) {
      const today = addDays(TODAY, week * 7);
      const recent = recentWeeklyKm(observed, today);
      const capacity = weeklyCapacity({ today, raceTarget, recentWeeklyKm: recent, previousWeekDistanceKm });
      const snapshot = {
        today: { localDate: today, workoutCount: 0 },
        week: { periodStart: today, periodEnd: addDays(today, 6), distanceKm: 0 },
        lock: { present: false }, weekStructure: { qualitySessionCount: 0 }, injuryFlags: []
      } as unknown as MobileTodayResponse;
      const plan = await generateWeeklyPlan({ today: snapshot,
        goals: { raceTarget, easyDurationFloorFraction: 0.8, qualitySessionCap: 2 }, prescription: null,
        weeklyVolumeBaselineKm: capacity.baselineKm, recentWeeklyKm: recent, previousWeekDistanceKm });
      const realisedKm = plan.days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
      const context = `${distance ?? "no race"}, week ${week + 1}, recent ${recent}`;
      assert.ok(realisedKm > 0, `${context}: successful training must not cause an all-rest week`);
      assert.ok(realisedKm <= weeklyPlanVolumeCeiling(capacity.baselineKm, previousWeekDistanceKm) + 1e-6, context);
      observed.push(...plan.days.map(day => ({ localDate: day.localDate, distanceMeters: (day.distanceKm ?? 0) * 1000 })));
      previousWeekDistanceKm = realisedKm;
    }
  }
});

test("W10: missing completion evidence never creates catch-up volume", async () => {
  const completed = [{ localDate: TODAY, distanceMeters: 5000 }];
  for (let week = 1; week <= 6; week += 1) {
    const today = addDays(TODAY, week * 7);
    const capacity = weeklyCapacity({ today, recentWeeklyKm: recentWeeklyKm(completed, today),
      previousWeekDistanceKm: week === 1 ? 5 : 0 });
    assert.equal(capacity.baselineKm, 5, "the restart stays conservative instead of stacking missed weeks");
  }
});
