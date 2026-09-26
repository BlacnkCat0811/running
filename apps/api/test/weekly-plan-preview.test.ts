import assert from "node:assert/strict";
import test from "node:test";
import { WeeklyPlanPreviews, PlanPreviewError } from "../src/weekly-plan-preview.js";
import { racePlanPhase } from "../src/race-plan-policy.js";
import { applyRacePlanPolicy } from "../src/weekly-plan-validate.js";
import { validateManualPlan, ManualPlanPolicyError } from "../src/manual-plan-policy.js";
import type { MobileGoalsResponse, MobileTodayResponse, MobileWeeklyPlanPreviewResponse } from "@rai/api-contracts";

const candidate = (): Omit<MobileWeeklyPlanPreviewResponse, "candidateId" | "expiresAt"> => ({
  generatedAt: "2026-09-25T00:00:00Z", revision: 4, days: [], warnings: [], replacedDates: [],
  windowStart: "2026-09-25", windowEnd: "2026-10-01",
  audit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: "2026-09-25T00:00:00Z" }
});

test("preview never commits and confirmation is idempotent after a lost acknowledgement", () => {
  const store = new WeeklyPlanPreviews();
  const preview = store.create(candidate(), "input-A");
  let writes = 0;
  const write = () => { writes++; return { ...candidate(), revision: 5 }; };
  assert.equal(writes, 0);
  assert.throws(() => store.confirm(preview.candidateId, 4, "input-B", write), PlanPreviewError);
  assert.throws(() => store.confirm(preview.candidateId, 3, "input-A", write), PlanPreviewError);
  assert.equal(store.confirm(preview.candidateId, 4, "input-A", write).revision, 5);
  assert.equal(store.confirm(preview.candidateId, 4, "input-after-write", write).revision, 5);
  assert.equal(writes, 1);
});

test("expired, restarted and evicted candidates cannot write", () => {
  let now = 0;
  const store = new WeeklyPlanPreviews(() => now);
  const old = store.create(candidate(), "scope");
  now = 16 * 60_000;
  const never = () => { throw new Error("must not write"); };
  assert.throws(() => store.confirm(old.candidateId, 4, "scope", never), PlanPreviewError);
  const first = store.create(candidate(), "scope");
  for (let i = 0; i < 8; i++) store.create(candidate(), "scope");
  assert.throws(() => store.confirm(first.candidateId, 4, "scope", never), PlanPreviewError);
  assert.throws(() => new WeeklyPlanPreviews().confirm(first.candidateId, 4, "scope", never), PlanPreviewError);
});

test("race rule is idempotent, reserves race day and does not invent race completion", () => {
  const target = { date: "2026-09-27", distance: "half_marathon" as const, targetPaceSecondsPerKm: 330 };
  const source = ["2026-09-25", "2026-09-27"].map(localDate => ({ localDate, kind: "interval" as const, distanceKm: 10, structure: null }));
  const safe = applyRacePlanPolicy(source, target, 40, null);
  assert.equal(safe[1]!.kind, "rest");
  assert.notEqual(safe[0]!.kind, "interval");
  assert.deepEqual(applyRacePlanPolicy(safe, target, 40, null), safe);
  assert.equal(racePlanPhase("2026-09-28", target), "past");
  assert.equal(racePlanPhase("2026-09-12", target), "build");
  assert.equal(racePlanPhase("2026-09-13", target), "taper");
});

test("manual race-day edits persist the safe policy rewrite", () => {
  const goals = {
    weeklyDistanceKm: 40,
    qualitySessionCap: 2,
    easyDurationFloorFraction: 0.8,
    raceTarget: { date: "2026-09-27", distance: "half_marathon", targetPaceSecondsPerKm: 330 },
    weekPlan: [{ localDate: "2026-09-27", kind: "interval", distanceKm: 10, structure: null }]
  } as MobileGoalsResponse;
  const today = {
    today: { localDate: "2026-09-25", workoutCount: 0 },
    lock: { present: false },
    week: { periodStart: "2026-09-21", distanceKm: 0 },
    weekStructure: { qualitySessionCount: 0 },
    injuryFlags: []
  } as unknown as MobileTodayResponse;
  const safe = validateManualPlan(goals, today, null, 0);
  assert.equal(safe.weekPlan[0]!.kind, "rest");
  assert.equal(safe.weekPlan[0]!.distanceKm, null);
  assert.equal(safe.weekPlan[0]!.structure, null);
});

test("manual writes reject forbidden quality and completed-volume overrun before persistence", () => {
  const goals = { weeklyDistanceKm: 10, qualitySessionCap: 0, easyDurationFloorFraction: 0.8,
    raceTarget: null, weekPlan: [{ localDate: "2026-09-26", kind: "tempo", distanceKm: 10, structure: null }] } as MobileGoalsResponse;
  const today = { today: { localDate: "2026-09-25", workoutCount: 0 }, lock: { present: false },
    week: { periodStart: "2026-09-21", distanceKm: 0 }, weekStructure: { qualitySessionCount: 0 }, injuryFlags: [] } as unknown as MobileTodayResponse;
  assert.throws(() => validateManualPlan(goals, today, null, 0), ManualPlanPolicyError);
  today.week.distanceKm = 10;
  goals.weekPlan[0]!.kind = "easy";
  assert.throws(() => validateManualPlan(goals, today, null, 0), /预算已用完/);
});
