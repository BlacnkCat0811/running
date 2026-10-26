import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { MobilePlannedDay, TrainingPlanSessionImpact } from "@rai/api-contracts";
import { validateTrainingSessionSafety } from "../src/training-plan-session-safety.js";
import type { TrainingPlanSessionState } from "../src/training-plan-store.js";
import { coachRuntimeFixture } from "../../../scripts/coach-runtime-fixtures.mjs";

const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json", import.meta.url), "utf8")) as { payload2: TrainingPlanSessionState };
const day = (distance: number, target = 390): MobilePlannedDay => ({ localDate: "2026-10-09", kind: "easy", distanceKm: distance, reason: null,
  structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: distance * 1000 },
    alert: { kind: "pace", lower: target, upper: target } }] }] } });

test("B04 safety: real zone bounds, natural-week actuals, phase and other protected courses constrain the exact user intent", () => {
  const f = coachRuntimeFixture();
  try {
    const state = structuredClone(fixture.payload2);
    const course = { ...state.sessions[0]!, prescription: day(5), userOverride: null, protection: "automatic" as const };
    state.sessions = [course]; state.weekPlan = [course.prescription]; state.suppressions = []; state.raceGoal = null;
    const impact: TrainingPlanSessionImpact = { before: null, after: course, suppressions: [], affectedDates: [course.prescription.localDate],
      deviceWithdrawalRequired: false, warnings: [] };
    const input = { goals: f.store.read(), ...structuredClone(f.facts.inputs) };
    input.today.week.distanceKm = 0;
    input.previousWeekDistanceKm = 20;
    input.today.injuryFlags = [];
    assert.doesNotThrow(() => validateTrainingSessionSafety(state, impact, input));
    const original = structuredClone(state);
    course.prescription = day(5, 180);
    assert.throws(() => validateTrainingSessionSafety(state, impact, input), (e: unknown) => (e as { code: string }).code === "training_session_safety_rejected");
    course.prescription = day(5);
    input.today.week.distanceKm = input.weeklyVolumeBaselineKm;
    assert.throws(() => validateTrainingSessionSafety(state, impact, input));
    input.today.week.distanceKm = 0;
    state.sessions.push({ ...course, sessionId: "other-protected", protection: "user_protected", prescription: { ...day(18), localDate: "2026-10-10" } });
    assert.throws(() => validateTrainingSessionSafety(state, impact, input), "other whole-course obligations spend the same week budget");
    state.sessions = [course];
    course.prescription = day(5);
    state.raceGoal = { id: "race", date: "2026-10-10", distanceKm: 10, goal: "time", targetTimeSeconds: 3000 };
    assert.throws(() => validateTrainingSessionSafety(state, impact, input), "existing race-eve policy still applies to manual edits");
    state.raceGoal = null;
    assert.deepEqual(state.sessions, original.sessions, "safety rejections never silently resize a protected user draft");
  } finally { f.close(); }
});
