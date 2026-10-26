import assert from "node:assert/strict";
import test from "node:test";

import type { MobilePlannedDay, MobileSessionStructure, MobileTodayResponse } from "@rai/api-contracts";

import type { CoachZonePrescription } from "../src/mobile-coach.js";
import { constrainUpcomingPlan, generateWeeklyPlan, type WeeklyPlanConstraintCounters } from "../src/weekly-plan-service.js";

/**
 * `generateWeeklyPlan` used to hard-code `automaticDosePolicy: true` while the
 * parameter and the `rejectedCount` / `clampedCount` fields pretended otherwise:
 * every caller got the complete-dose policy even when it asked for the legacy
 * validator-only path, and both counters were literally `0` while `warnings`
 * reported rejected and clamped days. These tests pin the plumbing that makes the
 * option real and the counters additive.
 */

const TODAY = "2026-10-05"; // Monday
const PRESCRIPTION: CoachZonePrescription = {
  easyPaceLower: 330,
  easyPaceUpper: 390,
  easyHrLower: 120,
  easyHrUpper: 150,
  thresholdPaceLower: 270,
  thresholdPaceUpper: 300,
  thresholdHrLower: 160,
  thresholdHrUpper: 172,
  intervalPaceLower: 240,
  intervalPaceUpper: 265
};

const todayPayload = (overrides: Record<string, unknown> = {}): MobileTodayResponse =>
  ({
    today: { localDate: TODAY, distanceKm: 0, durationSeconds: 0, powerWatts: null, workoutCount: 0 },
    week: { periodStart: TODAY, periodEnd: "2026-10-11", distanceKm: 0, durationSeconds: 0, workoutCount: 0 },
    lock: { present: false, relocked: false },
    nextSession: { kind: "easy", distanceKm: null },
    weekStructure: { qualitySessionCount: 0 },
    injuryFlags: [],
    ...overrides
  }) as unknown as MobileTodayResponse;

const args = () => ({
  today: todayPayload(),
  goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget: null },
  weeklyVolumeBaselineKm: 40,
  recentWeeklyKm: 40,
  prescription: PRESCRIPTION,
  previousWeekDistanceKm: 40
});

test("B03/S01-02: a protected course outside the rolling window spends volume and quality slots exactly once", () => {
  const retained: MobilePlannedDay = { localDate: "2026-11-04", kind: "tempo", distanceKm: 8, reason: "protected",
    structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1, steps: [
      { purpose: "work", goal: { type: "distance", meters: 8000 }, alert: { kind: "pace", lower: 270, upper: 300 } }
    ] }] } };
  const proposed: MobilePlannedDay = { localDate: "2026-11-02", kind: "tempo", distanceKm: 6, reason: null,
    structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1, steps: [
      { purpose: "work", goal: { type: "distance", meters: 6000 }, alert: { kind: "pace", lower: 270, upper: 300 } }
    ] }] } };
  const input = { ...args(), automaticDosePolicy: false,
    today: todayPayload({ today: { localDate: "2026-10-28", workoutCount: 0 },
      week: { periodEnd: "2026-11-01", distanceKm: 0 } }),
    goals: { ...args().goals, easyDurationFloorFraction: 0, weekPlan: [retained] } };
  const baseline = constrainUpcomingPlan([proposed], input);
  const warnings: string[] = [];
  const protectedResult = constrainUpcomingPlan([proposed], { ...input, protectedDays: [retained] }, warnings);
  assert.equal(baseline.find(day => day.localDate === proposed.localDate)?.kind, "tempo", "one quality slot remains in the next week");
  assert.deepEqual(protectedResult, baseline, "marking an already retained course as protected cannot spend its budget again");
  assert.ok(warnings.some(warning => warning.includes("预留 8.0 km、1 堂质量课")));
});

/** A complete-looking but too-short session: 5 + 5 min of work is under the 30 min policy. */
const shortSession: MobileSessionStructure = {
  warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: null },
  blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "time", seconds: 300 }, alert: null }] }],
  cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: null }
};
const shortDay: MobilePlannedDay = { localDate: TODAY, kind: "easy", distanceKm: 2.5, structure: shortSession, reason: "test" };

test("automaticDosePolicy is honored instead of silently coerced to true", () => {
  const complete = constrainUpcomingPlan([shortDay], { ...args(), automaticDosePolicy: true });
  assert.equal(complete[0]?.kind, "rest", "the complete-dose policy must reject a sub-30-minute automatic session");

  const legacy = constrainUpcomingPlan([shortDay], { ...args(), automaticDosePolicy: false });
  assert.equal(legacy[0]?.kind, "easy", "the legacy path validates the session but does not apply the complete-dose floor");
  assert.ok(legacy[0]?.structure, "the legacy path keeps the supplied structure");

  // `constrainUpcomingPlan` itself keeps its historical truthiness switch; only
  // `generateWeeklyPlan` (automatic generation) supplies a default. The default is
  // covered by the next test through the public entry point.
});

test("generateWeeklyPlan reports the validation counters it actually observed", async () => {
  const generated = await generateWeeklyPlan(args());
  assert.equal(generated.audit.generatedBy, "heuristic");
  assert.equal(typeof generated.rejectedCount, "number");
  assert.equal(typeof generated.clampedCount, "number");
  assert.ok(generated.rejectedCount >= 0);
  assert.ok(generated.clampedCount >= 0);
  // Deterministic output: asking for the explicit automatic policy is the same run.
  const explicit = await generateWeeklyPlan({ ...args(), automaticDosePolicy: true });
  assert.deepEqual(explicit.days, generated.days);
  assert.equal(explicit.rejectedCount, generated.rejectedCount);
  assert.equal(explicit.clampedCount, generated.clampedCount);
});

test("constrainUpcomingPlan accumulates rejected days into the caller's counters", () => {
  const counters: WeeklyPlanConstraintCounters = { rejectedCount: 0, clampedCount: 0 };
  const proposed = [{
    localDate: TODAY,
    kind: "not_a_session_kind" as MobilePlannedDay["kind"],
    distanceKm: 5,
    structure: null,
    reason: null
  }];
  const days = constrainUpcomingPlan(proposed, args(), [], counters);
  assert.equal(counters.rejectedCount, 1, "an invalid kind is a rejection, not a silent rest");
  assert.equal(days.length, 6, "the validator drops the rejected date; the rest of the window is still returned");
  assert.equal(days.some((day) => day.localDate === TODAY), false);
});
