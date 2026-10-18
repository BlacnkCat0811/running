import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import type { CoachLoopDeviceReceipt, CoachLoopRuntimeResponse, MobileLockedSession, MobilePlannedDay } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { COACH_RUNTIME_POLICY_HASH, CoachLoopRuntime, type CoachRuntimeReceipt } from "../src/coach-loop-runtime.js";
import { registerCoachLoopRoutes } from "../src/coach-loop-routes.js";
import { assessSessionDose, buildCompleteEasyStructure } from "../src/coach-session-dose.js";
import { shiftCoachDate } from "../src/coach-loop-facts.js";
import { prescriptionDigest } from "../src/plan-digest.js";
import { runCoachSessionTargets } from "../src/run-coach-policy.js";
import { RaiReadStore } from "../src/data.js";
import { buildSessionStructure } from "../src/mobile-coach.js";
import { planDayWithLock, type PlanHistoryRevision } from "../src/mobile-goals.js";
import { PlanOperationError } from "../src/plan-publication.js";
import { coachQualityExecutionSummary } from "../src/coach-execution-assessment.js";
import {
  coachRuntimeFixture as fixture, runtimeReplaySettings as settings, runtimeReplayScope as scope
} from "../../../scripts/coach-runtime-fixtures.mjs";

type Fixture = ReturnType<typeof fixture>;

function clearCurrentWeek(f: Fixture, scale = 1): void {
  f.facts.facts = f.facts.facts.filter(run => run.id !== "monday-20").map(run => ({
    ...run, distanceKm: run.distanceKm * scale, durationSeconds: run.durationSeconds * scale
  }));
  Object.assign(f.facts.inputs, {
    weeklyVolumeBaselineKm: 20 * scale, recentWeeklyKm: 20 * scale, previousWeekDistanceKm: 20 * scale
  });
  Object.assign(f.facts.inputs.today.week, { distanceKm: 0, durationSeconds: 0 });
}

function easyDay(f: Fixture, date: string, seconds = 1800): MobilePlannedDay {
  const structure = buildCompleteEasyStructure("easy", f.facts.inputs.prescription);
  structure.blocks[0]!.steps[0]!.goal = { type: "time", seconds: seconds - 600 };
  return { localDate: date, kind: "easy", structure, distanceKm: seconds / 360, reason: `stored ${seconds}s` };
}

function lock(day: MobilePlannedDay, at: string): MobileLockedSession {
  return {
    localDate: day.localDate, verdictTone: "yellow", lockedAt: at,
    session: {
      kind: day.kind, title: "Explicit locked prescription", reason: day.reason ?? "",
      distanceKm: day.distanceKm ?? null, durationMinutes: null, structure: day.structure ?? null,
      paceSecondsPerKmLower: null, paceSecondsPerKmUpper: null, heartRateBpmLower: null, heartRateBpmUpper: null
    }
  };
}

function deviceReceipt(state: CoachLoopRuntimeResponse): CoachLoopDeviceReceipt {
  const workoutID = randomUUID();
  return {
    contractVersion: 2, scope, operationId: randomUUID(), coherenceToken: state.executionToken,
    localDate: state.today.day.localDate, kind: state.today.day.kind, revision: state.revision,
    structure: state.today.day.structure!, workoutID, scheduledAt: `${state.today.day.localDate}T05:00:00Z`,
    verifiedAt: `${state.today.day.localDate}T04:01:00Z`, timezone: "Asia/Shanghai",
    prescriptionDigest: prescriptionDigest(state.today.day.kind, state.today.day.structure!),
    lifecycleEvent: "verified", idempotencyKey: workoutID,
    coachLoop: { contractVersion: 1, policyHash: state.policyHash, decisionRef: state.today.decisionRef }
  };
}

test("unsupported-race protection rejects both new and retained long runs in the last two days", () => {
  for (const locked of [false, true]) {
    const f = fixture();
    try {
      clearCurrentWeek(f, 3);
      const race = {
        goal: "finish" as const, raceDate: "2026-11-22", raceDistanceKm: 42.195, targetTimeSeconds: null,
        runningDays: settings.runningDays, longRunDays: settings.runningDays,
        targetType: "pace" as const, strengthTraining: false
      };
      const config = { ...settings, mode: "race_preparation" as const, longRunDays: settings.runningDays, race };
      const enabled = f.runtime.command(f.command("enable", { settings: config, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
      assert.ok(enabled.days.some(row => row.day.kind === "long_run" && row.executable),
        "the unprotected positive case must retain a real long-run opportunity");

      f.facts.facts = f.facts.facts.map(run => ({
        ...run, startedAt: shiftCoachDate(run.startedAt.slice(0, 10), 43) + run.startedAt.slice(10),
        availableAt: shiftCoachDate(run.availableAt!.slice(0, 10), 43) + run.availableAt!.slice(10)
      }));
      Object.assign(f.facts, {
        date: "2026-11-20", asOf: "2026-11-20T04:00:00Z", factsHash: "race-minus-two",
        historyCoverageFrom: "2026-09-13"
      });
      f.facts.inputs.today.today.localDate = f.facts.date;
      const retained = { ...easyDay(f, f.facts.date, 3600), kind: "long_run" as const };
      const before = f.store.write({ weekPlan: [retained], ...(locked ? { lockedSession: lock(retained, f.facts.asOf) } : {}) },
        { prescription: f.facts.inputs.prescription, evaluatedAt: f.facts.asOf });
      const originalLock = f.store.read().lockedSession;
      for (const result of [f.runtime.read(), f.runtime.command(f.command("refresh"))]) {
        assert.ok(result.executionPolicy.protections.some(p => p.constraints.some(c => c.kind === "no_quality_or_long_run")));
        for (const row of result.days.filter(row => row.day.localDate <= race.raceDate)) {
          assert.ok(!["long_run", "tempo", "interval"].includes(row.day.kind), JSON.stringify(row));
        }
        assert.equal(result.days.find(row => row.day.localDate === race.raceDate)?.executable, false);
        if (locked) {
          assert.deepEqual(f.store.read().lockedSession, originalLock);
          assert.deepEqual(result.goals.lockedSession?.session.structure, originalLock?.session.structure);
          assert.deepEqual(result.goals.weekPlan.find(day => day.localDate === f.facts.date), before.weekPlan[0]);
        }
      }
      assert.equal(f.runtime.read().refreshRequired, false);
    } finally { f.close(); }
  }
});

test("today's locked rest is authoritative with or without a conflicting stored day", () => {
  for (const withStoredDay of [false, true]) {
    const f = fixture();
    try {
      clearCurrentWeek(f);
      const stored = easyDay(f, f.facts.date);
      const locked = lock({ localDate: f.facts.date, kind: "rest", structure: null, distanceKm: null, reason: "Do not run" }, f.facts.asOf);
      const before = f.store.write({
        lockedSession: locked, ...(withStoredDay ? { weekPlan: [stored] } : {})
      }, { prescription: f.facts.inputs.prescription, evaluatedAt: f.facts.asOf });
      const initial = f.runtime.read();
      assert.equal(initial.today.day.kind, "rest");
      const enabled = f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
      for (const result of [enabled, f.runtime.command(f.command("refresh")), f.runtime.read()]) {
        assert.equal(result.today.day.kind, "rest");
        assert.equal(result.today.executable, false);
        assert.equal(result.today.decisionRef, null);
        assert.deepEqual(result.goals.lockedSession, before.lockedSession);
        if (withStoredDay) assert.deepEqual(result.goals.weekPlan.find(day => day.localDate === f.facts.date), before.weekPlan[0]);
      }
      assert.equal(f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(scope))!.reservations.length, 0);
    } finally { f.close(); }
  }
});

test("a complete locked course uses its own structure for execution and device evidence, without rewriting the stored day", () => {
  const f = fixture();
  try {
    clearCurrentWeek(f);
    const stored = easyDay(f, f.facts.date, 2400), locked = lock(easyDay(f, f.facts.date), f.facts.asOf);
    const before = f.store.write({ weekPlan: [stored], lockedSession: locked },
      { prescription: f.facts.inputs.prescription, evaluatedAt: f.facts.asOf });
    const result = f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
    assert.deepEqual(result.today.day.structure, locked.session.structure);
    assert.equal(result.today.executable, true);
    assert.equal(result.refreshRequired, false);
    assert.deepEqual(result.goals.weekPlan.find(day => day.localDate === f.facts.date), before.weekPlan[0]);
    assert.deepEqual(result.goals.lockedSession, before.lockedSession);
    const receipt = deviceReceipt(result);
    assert.equal(f.runtime.recordDeviceReceipt(receipt).matchesCurrent, true);
    assert.equal(f.runtime.command(f.command("refresh")).revision, result.revision);
    assert.deepEqual(f.runtime.read().today, result.today);
    assert.equal(f.runtime.recordDeviceReceipt({ ...receipt, lifecycleEvent: "withdrawn",
      idempotencyKey: `${receipt.workoutID}:withdrawn` }).matchesCurrent, false);
  } finally { f.close(); }
});

test("locked short courses remain unchanged but cannot be silently upgraded to an automatic complete course", () => {
  const f = fixture();
  try {
    clearCurrentWeek(f);
    const short = lock(easyDay(f, f.facts.date, 1200), f.facts.asOf);
    const before = f.store.write({ lockedSession: short }, { prescription: f.facts.inputs.prescription, evaluatedAt: f.facts.asOf });
    const result = f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
    assert.equal(result.today.day.kind, "rest");
    assert.equal(result.today.executable, false);
    assert.deepEqual(result.goals.lockedSession, before.lockedSession);
    assert.deepEqual(result.goals.weekPlan.find(day => day.localDate === f.facts.date)?.structure, short.session.structure);
  } finally { f.close(); }
});

test("frozen execution assessment and quality summary use the historical lock rather than a conflicting week row", async () => {
  const f = fixture(), root = mkdtempSync(join(tmpdir(), "coach-locked-assessment-"));
  const path = join(root, "rai.sqlite");
  let read: RaiReadStore | undefined;
  try {
    (await RaiDatabase.open(path)).close();
    read = new RaiReadStore(path);
    const day: MobilePlannedDay = { localDate: f.facts.date, kind: "interval", distanceKm: 7,
      structure: buildSessionStructure("interval", f.facts.inputs.prescription), reason: "locked interval" };
    const history: PlanHistoryRevision[] = [{
      revision: 1, changedAt: "2026-10-07T04:00:00Z", weekPlan: [easyDay(f, f.facts.date)],
      lockedSession: lock(day, "2026-10-07T04:00:00Z")
    }];
    const assessments = read.coachExecutionAssessments(history, [], f.facts.asOf);
    assert.equal(assessments.length, 1);
    assert.equal(assessments[0]?.prescriptionDigest, prescriptionDigest(day.kind, day.structure ?? null));
    assert.equal(assessments[0]?.completion, "unconfirmed");
    const summary = coachQualityExecutionSummary({
      asOf: f.facts.asOf, observedDates: [], assessments,
      prescriptions: [{ day: planDayWithLock(history[0]!, f.facts.date)!, revision: 1,
        createdAt: history[0]!.changedAt, availableAt: history[0]!.changedAt,
        evidenceRef: { source: "plan_history", id: `1:${f.facts.date}`, observedAt: history[0]!.changedAt,
          availableAt: history[0]!.changedAt, revisionOrHash: assessments[0]!.prescriptionDigest } }]
    });
    assert.equal(summary.qualityPlanned, 1);
    assert.equal(summary.qualityUnconfirmed, 1);
  } finally { read?.close(); f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("HTTP aggregates stay exactly seven days before opt-in, after publication and after restart; outside reservations still constrain budgets", async () => {
  const f = fixture(), app = Fastify();
  registerCoachLoopRoutes({ app, runtime: f.runtime, identity: () => scope,
    openMainDatabase: async () => { throw new Error("GET must not write the main DB"); } });
  try {
    const outside = easyDay(f, "2026-10-15", 5400), laterRest: MobilePlannedDay = {
      localDate: "2026-10-22", kind: "rest", structure: null, distanceKm: null, reason: "outside rest"
    };
    const before = f.store.write({ weekPlan: [outside, laterRest] },
      { prescription: f.facts.inputs.prescription, evaluatedAt: f.facts.asOf });
    const dates = Array.from({ length: 7 }, (_, offset) => shiftCoachDate(f.facts.date, offset));
    const initial = (await app.inject({ method: "GET", url: "/v1/mobile/coach-loop" })).json<CoachLoopRuntimeResponse>();
    assert.equal(initial.settings, null);
    assert.deepEqual(initial.days.map(row => row.day.localDate), dates);
    assert.equal(f.store.read().revision, before.revision, "GET never removes old rows");
    const published = await app.inject({ method: "POST", url: "/v1/mobile/coach-loop",
      payload: f.command("enable", { settings, acceptedPolicyHash: initial.policyHash }) });
    assert.equal(published.statusCode, 200, published.body);
    const result = published.json<CoachLoopRuntimeResponse>();
    assert.deepEqual(result.days.map(row => row.day.localDate), dates);
    assert.deepEqual(result.goals.weekPlan.filter(day => day.localDate > dates.at(-1)!), before.weekPlan);
    const nextWeek = result.goals.weekPlan.filter(day => day.localDate >= "2026-10-12" && day.localDate <= "2026-10-18");
    const cost = nextWeek.reduce((sum, day) => sum + (assessSessionDose({
      kind: day.kind, structure: day.structure ?? null, zones: f.facts.inputs.prescription
    }).distanceKm?.upper ?? 0), 0);
    assert.ok(cost <= 20 + 1e-9, `outside reservation must still count: ${cost}`);
    assert.ok(nextWeek.some(day => day.localDate < outside.localDate && day.kind !== "rest"),
      "the constrained positive case must not pass by returning all rest");
    f.restart();
    assert.deepEqual(f.runtime.read().days.map(row => row.day.localDate), dates);
    const refreshed = f.runtime.command(f.command("refresh"));
    assert.deepEqual(refreshed.days.map(row => row.day.localDate), dates);
    assert.equal(refreshed.revision, result.revision);
  } finally { await app.close(); f.close(); }
});

test("an eligible 30-minute extension replaces an unprotected 40-minute stored course and preserves its exact authorization on retry", () => {
  for (const targetType of ["pace", "heart_rate"] as const) {
    const f = fixture();
    try {
      f.facts.facts = f.facts.facts.map(run => run.id === "monday-20" ? {
        ...run, distanceKm: 18, durationSeconds: 6480
      } : run);
      Object.assign(f.facts.inputs.today.week, { distanceKm: 18, durationSeconds: 6480 });
      const stored = runCoachSessionTargets(easyDay(f, f.facts.date, 2400), { targetType }, f.facts.inputs.prescription);
      f.store.write({ weekPlan: [stored] }, { prescription: f.facts.inputs.prescription, evaluatedAt: f.facts.asOf });
      const request = f.command("enable", {
        settings: { ...settings, runningDays: [4], longRunDays: [], targetType }, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH
      });
      const result = f.runtime.command(request);
      assert.equal(result.volumePolicy.extension.status, "eligible");
      assert.equal(result.today.executable, true);
      assert.equal(result.refreshRequired, false);
      assert.equal(result.today.day.kind, "easy");
      assert.equal(assessSessionDose({ kind: result.today.day.kind, structure: result.today.day.structure!,
        zones: f.facts.inputs.prescription }).durationSeconds?.upper, 1800);
      const receipt = f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(scope))!;
      const slot = receipt.reservations.find(row => row.status === "pending")!;
      assert.ok(slot);
      assert.equal(slot.prescriptionDigest, prescriptionDigest(result.today.day.kind, result.today.day.structure!));
      assert.equal(slot.prescriptionDigest, result.volumePolicy.extension.candidatePrescriptionDigest);
      assert.equal(slot.decisionRef, result.today.decisionRef);
      assert.equal(slot.distanceKm, 5);
      assert.deepEqual(f.runtime.command(request), result);
      const refreshed = f.runtime.command(f.command("refresh"));
      assert.equal(refreshed.revision, result.revision);
      assert.deepEqual(refreshed.today, result.today);
      assert.equal(f.runtime.recordDeviceReceipt(deviceReceipt(refreshed)).matchesCurrent, true);
      assert.equal(f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(scope))!.reservations.length, 1);
    } finally { f.close(); }
  }
});

test("G(guard): a control write during the coach-loop read fails closed with 503 coach_snapshot_changed", () => {
  const f = fixture();
  try {
    let builds = 0;
    const runtime = new CoachLoopRuntime(f.store, () => scope, () => {
      // Simulate the Monday generation / a second device's refresh landing while
      // the facts read is in flight: the control digest pair must discard this
      // candidate instead of returning "old control state + new facts".
      builds += 1;
      f.store.write({ qualitySessionCap: Math.min(5, builds) });
      return f.facts;
    });
    assert.throws(() => runtime.read(), (error: unknown) =>
      error instanceof PlanOperationError &&
      error.code === "coach_snapshot_changed" &&
      error.statusCode === 503);
    assert.equal(builds, 3, "three attempts, each discarded because control changed during the build");
  } finally { f.close(); }
});
