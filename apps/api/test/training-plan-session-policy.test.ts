import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { MobilePlannedDay, MobileSessionStructure, TrainingPlanSession } from "@rai/api-contracts";

import { MobileGoalsStore } from "../src/mobile-goals.js";
import { digest } from "../src/plan-digest.js";
import type { CoachZonePrescription } from "../src/mobile-coach.js";
import { resolveTrainingPlanSessions, trainingPlanProtectedDays } from "../src/training-plan-session-policy.js";
import { parseTrainingPlanState, TrainingPlanStore, type TrainingPlanLegacyState,
  type TrainingPlanSessionState } from "../src/training-plan-store.js";
import { TrainingPlanCommandService } from "../src/training-plan-commands.js";
import { generateWeeklyPlan } from "../src/weekly-plan-service.js";
import { weeklyPlanVolumeCeiling } from "../src/weekly-plan-validate.js";
import { trainingPlanGenerationPreferences } from "../src/training-plan-preferences.js";

const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json", import.meta.url), "utf8")) as {
  payload2: TrainingPlanSessionState; initial: TrainingPlanSession; moved: TrainingPlanSession; edited: TrainingPlanSession;
  scope: { serverId: string; athleteId: string; datasetEpoch: string };
};
const identity = fixture.scope;
const scopeKey = JSON.stringify([identity.serverId, identity.athleteId, identity.datasetEpoch]);
const BUSINESS_DATE = "2026-10-25";
const AVAILABLE_AT = "2026-10-25T04:00:00.000Z";
const day = (localDate: string, kind: MobilePlannedDay["kind"], distanceKm: number | null = null,
  reason: string | null = null): MobilePlannedDay => ({ localDate, kind, distanceKm,
  structure: null, reason });

const base = (): TrainingPlanSessionState => parseTrainingPlanState(fixture.payload2) as TrainingPlanSessionState;

test("B03/S01-02: protected course and explicit rest win field-by-field; moved source date never resurrects", () => {
  const state = base();
  const protectedBefore = structuredClone(state.sessions.find(session => session.protection === "user_protected")!);
  const generated = [day("2026-10-28", "easy", 6, "generated"), day("2026-10-29", "interval", 9, "generated"),
    day("2026-10-30", "easy", 6, "generated"), day("2026-10-31", "easy", 6, "generated")];
  let sequence = 0;
  const result = resolveTrainingPlanSessions({ state, generatedDays: generated, businessDate: BUSINESS_DATE,
    availableAt: AVAILABLE_AT, allocateSessionId: () => `allocated-${++sequence}` });

  const protectedAfter = result.sessions.find(session => session.sessionId === protectedBefore.sessionId)!;
  assert.deepEqual(protectedAfter, protectedBefore, "user-protected session (including override, revision and structure) is byte-identical");
  assert.deepEqual(result.weekPlan.find(value => value.localDate === "2026-10-29"), protectedBefore.prescription);
  assert.deepEqual(result.weekPlan.find(value => value.localDate === "2026-10-28"),
    day("2026-10-28", "rest", null, "课程已改期；源日不自动补课。"));
  assert.deepEqual(result.weekPlan.find(value => value.localDate === "2026-10-30"),
    day("2026-10-30", "rest", null, "用户指定休息。"));
  assert.equal(result.sessions.filter(session => session.supersededBySessionId === null && session.lifecycle !== "cancelled" &&
    session.prescription.localDate === "2026-10-28").length, 0, "source date has no active obligation");
  assert.ok(result.createdSessionIds.length === 1, "only the unprotected, unsuppressed 10-31 day receives a new automatic course");
  assert.equal(result.sessions.find(session => session.sessionId === result.createdSessionIds[0])!.prescription.localDate, "2026-10-31");
  assert.deepEqual(result.suppressions, state.suppressions, "future suppressions are carried, not regenerated");
});

test("B03/S01-02: a cancelled tombstone suppresses the date and repeated resolution never resurrects it", () => {
  const state = parseTrainingPlanState({ ...base(),
    suppressions: [...base().suppressions, { localDate: "2026-10-27", reason: "cancelled",
      sessionId: fixture.initial.sessionId, availableAt: AVAILABLE_AT }] }) as TrainingPlanSessionState;
  const first = resolveTrainingPlanSessions({ state, generatedDays: [day("2026-10-27", "easy", 6, "generated")],
    businessDate: BUSINESS_DATE, availableAt: AVAILABLE_AT, allocateSessionId: () => "must-not-exist" });
  assert.deepEqual(first.weekPlan.find(value => value.localDate === "2026-10-27"),
    day("2026-10-27", "rest", null, "课程已取消；不自动复活。"));
  assert.equal(first.createdSessionIds.length, 0);
  const retry = resolveTrainingPlanSessions({ state: { ...state, suppressions: first.suppressions },
    generatedDays: [day("2026-10-27", "easy", 6, "generated")], businessDate: BUSINESS_DATE,
    availableAt: "2026-10-25T04:00:01.000Z", allocateSessionId: () => "still-must-not-exist" });
  assert.deepEqual(retry.weekPlan.find(value => value.localDate === "2026-10-27"),
    day("2026-10-27", "rest", null, "课程已取消；不自动复活。"), "a retry cannot revive the cancelled date");
});

test("B03/S01-02: future protected course outside the generated window is retained and materialized", () => {
  const state = base();
  const future = structuredClone(fixture.moved);
  future.sessionId = "future-protected";
  future.sessionRevision = 1;
  future.prescription = { ...structuredClone(fixture.moved.prescription), localDate: "2026-11-05" };
  future.userOverride = { action: "move", prescription: structuredClone(future.prescription), availableAt: AVAILABLE_AT };
  const withSessions = parseTrainingPlanState({ ...state, sessions: [...state.sessions, future],
    weekPlan: [...state.weekPlan.filter(value => value.localDate !== "2026-11-05"), future.prescription] }) as TrainingPlanSessionState;
  const window = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];
  const result = resolveTrainingPlanSessions({ state: withSessions,
    generatedDays: window.map((localDate, index) => day(localDate, index === 0 ? "easy" : "rest",
      index === 0 ? 5 : null, "generated")),
    businessDate: BUSINESS_DATE, availableAt: AVAILABLE_AT, allocateSessionId: () => "never" });
  assert.deepEqual(result.sessions.find(session => session.sessionId === "future-protected"), future);
  assert.deepEqual(result.weekPlan.find(value => value.localDate === "2026-11-05"), future.prescription);
  assert.equal(result.protectedDays.some(value => value.localDate === "2026-11-05"), false,
    "the generator budget only receives protected days inside its candidate window");
  assert.ok(trainingPlanProtectedDays(withSessions).some(value => value.localDate === "2026-11-05"),
    "the full protected set is still available to a caller that reserves future obligations");
});

test("B03/S01-02: today's lock is authoritative even when the generator proposes another course", () => {
  const state = base();
  const lockedPrescription = { ...structuredClone(fixture.initial.prescription), localDate: "2026-10-26", kind: "recovery" as const,
    distanceKm: 4, structure: null, reason: "today lock" };
  const locked = parseTrainingPlanState({ ...state, lockedSession: { localDate: "2026-10-26", session: {
    kind: "recovery", title: "恢复跑", reason: "today lock", distanceKm: 4, durationMinutes: 30,
    paceSecondsPerKmLower: 360, paceSecondsPerKmUpper: 390, heartRateBpmLower: null, heartRateBpmUpper: null, structure: null
  }, verdictTone: "green", lockedAt: AVAILABLE_AT } }) as TrainingPlanSessionState;
  let sequence = 0;
  const result = resolveTrainingPlanSessions({ state: locked, generatedDays: [day("2026-10-26", "interval", 10, "generated")],
    businessDate: BUSINESS_DATE, availableAt: AVAILABLE_AT, allocateSessionId: () => `lock-${++sequence}` });
  assert.deepEqual(result.weekPlan.find(value => value.localDate === "2026-10-26"), lockedPrescription);
  assert.equal(result.createdSessionIds.length, 1);
  assert.deepEqual(result.sessions.find(session => session.sessionId === result.createdSessionIds[0])!.prescription, lockedPrescription);
});

test("B03/S01-02: automatic replacement uses a new ID plus superseded relation; re-planning to rest archives only the pending auto course", () => {
  const auto = { ...structuredClone(fixture.initial), protection: "automatic" as const };
  const state = parseTrainingPlanState({ ...base(), sessions: [auto], suppressions: [], weekPlan: [auto.prescription] }) as TrainingPlanSessionState;
  let sequence = 0;
  const replaced = resolveTrainingPlanSessions({ state, generatedDays: [day("2026-10-28", "tempo", 8, "replacement")],
    businessDate: BUSINESS_DATE, availableAt: AVAILABLE_AT, allocateSessionId: () => `new-${++sequence}` });
  const old = replaced.sessions.find(session => session.sessionId === auto.sessionId)!;
  const next = replaced.sessions.find(session => session.sessionId === "new-1")!;
  assert.equal(old.sessionRevision, auto.sessionRevision + 1, "replacement relation changes the old session revision");
  assert.equal(old.supersededBySessionId, "new-1");
  assert.equal(next.sessionRevision, 1);
  assert.deepEqual(next.prescription, day("2026-10-28", "tempo", 8, "replacement"));
  assert.deepEqual(replaced.weekPlan, [next.prescription]);

  const archived = resolveTrainingPlanSessions({ state: parseTrainingPlanState({ ...state, sessions: [auto],
    suppressions: [], weekPlan: [auto.prescription] }) as TrainingPlanSessionState,
    generatedDays: [day("2026-10-28", "rest", null, "rest")], businessDate: BUSINESS_DATE, availableAt: AVAILABLE_AT,
    allocateSessionId: () => "unused" });
  assert.deepEqual(archived.archivedSessionIds, [auto.sessionId]);
  assert.equal(archived.sessions.length, 0);
  assert.deepEqual(archived.weekPlan, [day("2026-10-28", "rest", null, "rest")]);
});

test("B03/S01-02: duplicate generated dates and two active owners are rejected, never merged", () => {
  const state = base();
  assert.throws(() => resolveTrainingPlanSessions({ state, generatedDays: [day("2026-10-28", "easy", 5), day("2026-10-28", "rest")],
    businessDate: BUSINESS_DATE, availableAt: AVAILABLE_AT }), /duplicate generated date/);
  const corrupt = structuredClone(state);
  corrupt.sessions.push({ ...corrupt.sessions[0]!, sessionId: "second-owner" });
  assert.throws(() => resolveTrainingPlanSessions({ state: corrupt, generatedDays: [day("2026-10-28", "easy", 5)],
    businessDate: BUSINESS_DATE, availableAt: AVAILABLE_AT }), /same date/);
});

const PRESCRIPTION: CoachZonePrescription = {
  easyPaceLower: 330, easyPaceUpper: 390, easyHrLower: 120, easyHrUpper: 150,
  thresholdPaceLower: 270, thresholdPaceUpper: 300, thresholdHrLower: 160, thresholdHrUpper: 172,
  intervalPaceLower: 240, intervalPaceUpper: 265
};
const todayPayload = { today: { localDate: "2026-10-05", distanceKm: 0, durationSeconds: 0, workoutCount: 0 },
  week: { periodStart: "2026-10-05", periodEnd: "2026-10-11", distanceKm: 0, durationSeconds: 0, workoutCount: 0 },
  lock: { present: false, relocked: false }, nextSession: { kind: "easy", distanceKm: null },
  weekStructure: { qualitySessionCount: 0 }, injuryFlags: [] } as unknown as import("@rai/api-contracts").MobileTodayResponse;
const weeklyArgs = () => ({ today: todayPayload,
  goals: { easyDurationFloorFraction: 0.7, qualitySessionCap: 2, raceTarget: null },
  weeklyVolumeBaselineKm: 40, recentWeeklyKm: 40, prescription: PRESCRIPTION, previousWeekDistanceKm: 40 });

test("B03/S01-02/S01-04: protected courses spend the budget first and migrated running days/target type are actually consumed", async () => {
  const protectedDay: MobilePlannedDay = { localDate: "2026-10-09", kind: "tempo", distanceKm: 12, structure: null, reason: "user protected" };
  const withProtection = await generateWeeklyPlan({ ...weeklyArgs(), protectedDays: [protectedDay] });
  const protectedResult = withProtection.days.find(value => value.localDate === "2026-10-09")!;
  assert.deepEqual(protectedResult, protectedDay, "the protected day is returned byte-for-byte, never re-normalized");
  const automaticKm = withProtection.days.filter(value => value.kind !== "rest" && value.localDate !== protectedDay.localDate)
    .reduce((sum, value) => sum + (value.distanceKm ?? 0), 0);
  assert.ok(automaticKm + 12 <= weeklyPlanVolumeCeiling(40, 40) + 1e-9,
    `automatic volume ${automaticKm} + protected 12 must fit the same weekly ceiling`);

  const preferences = { runningDays: [2, 4, 6], longRunDays: [6], targetType: "heart_rate" as const };
  const planned = await generateWeeklyPlan({ ...weeklyArgs(), preferences });
  const nonRest = planned.days.filter(value => value.kind !== "rest");
  assert.deepEqual(nonRest.map(value => value.localDate), ["2026-10-06", "2026-10-08", "2026-10-10"]);
  for (const value of nonRest) {
    assert.equal(value.structure?.blocks[0]?.steps[0]?.alert?.kind, "heart_rate",
      "targetType is applied to the generated work steps, not only displayed as preference");
  }
});

test("B03/S01-04: the same run-coach source produces the same available days, target type and phase before and after the session migration", async () => {
  const plan = { id: "migration-compare", goal: "finish" as const, raceDate: "2026-12-06", raceDistanceKm: 10,
    targetTimeSeconds: null, runningDays: [2, 4, 6], longRunDays: [6], targetType: "heart_rate" as const,
    strengthTraining: false, durationWeeks: 12, startedOn: BUSINESS_DATE, status: "active" as const,
    pausedOn: null, endedOn: null, adaptationKey: null, adaptedAt: null };
  const baseState = base();
  const { planInstanceId: _instance, sessions: _sessions, suppressions: _suppressions, publishedInputKey: _key,
    ...withoutSessions } = baseState;
  const before = parseTrainingPlanState({ ...withoutSessions, schemaVersion: 1, source: "run_coach", runCoach: plan,
    preferencesComplete: true, raceGoal: { id: "goal-1", date: "2026-12-06", distanceKm: 10, goal: "finish",
      targetTimeSeconds: null } });
  const after = parseTrainingPlanState({ ...before, schemaVersion: 2, migrationVersion: 2, planInstanceId: "plan-after",
    sessions: [], suppressions: [], publishedInputKey: null, weekPlan: [] });
  const beforePreferences = trainingPlanGenerationPreferences(before);
  const afterPreferences = trainingPlanGenerationPreferences(after);
  assert.deepEqual(afterPreferences, beforePreferences, "session identity migration does not change the consumed preference");
  const raceTarget = { date: "2026-12-06", distance: "ten_k" as const, targetPaceSecondsPerKm: null };
  const args = { ...weeklyArgs(), goals: { ...weeklyArgs().goals, raceTarget } };
  const beforeDays = await generateWeeklyPlan({ ...args, preferences: beforePreferences });
  const afterDays = await generateWeeklyPlan({ ...args, preferences: afterPreferences });
  assert.deepEqual(afterDays.days, beforeDays.days, "same source yields identical days/structure/phase after migration");
  assert.deepEqual(beforeDays.days.filter(day => day.kind !== "rest").map(day => day.localDate),
    ["2026-10-06", "2026-10-08", "2026-10-10"], "the migrated runningDays are consumed, not replaced by seven-day availability");
});

test("B03/S01-04: retained run-coach evidence maps to generation preferences; missing/ended evidence fails closed, legacy has no invented seven-day preference", () => {
  const plan = { id: "retained", goal: "fitness" as const, raceDate: null, raceDistanceKm: null, targetTimeSeconds: null,
    runningDays: [6, 2, 4], longRunDays: [6], targetType: "heart_rate" as const, strengthTraining: true,
    durationWeeks: 12, startedOn: BUSINESS_DATE, status: "active" as const, pausedOn: null, endedOn: null,
    adaptationKey: null, adaptedAt: null };
  const state = { ...base(), source: "run_coach" as const, runCoach: plan, preferencesComplete: true };
  assert.deepEqual(trainingPlanGenerationPreferences(state), { runningDays: [2, 4, 6], longRunDays: [6],
    targetType: "heart_rate", strengthTraining: true, availabilityMinutesByWeekday: {}, source: "run_coach" });
  assert.throws(() => trainingPlanGenerationPreferences({ ...state, runCoach: { ...plan, status: "ended" } }),
    (error: unknown) => (error as { code?: string }).code === "training_preferences_incomplete");
  assert.throws(() => trainingPlanGenerationPreferences({ ...state, runCoach: null }),
    (error: unknown) => (error as { code?: string }).code === "training_preferences_incomplete");
  assert.throws(() => trainingPlanGenerationPreferences({ ...state,
    runCoach: { ...plan, availabilityMinutesByWeekday: { "2": 30 } } as unknown as typeof plan }),
    (error: unknown) => (error as { code?: string }).code === "training_preferences_incomplete");
  const legacy = { ...state, source: "legacy_goals" as const, runCoach: null };
  const defaults = trainingPlanGenerationPreferences(legacy);
  assert.equal(defaults.runningDays, null, "no saved preference is not the seven-day default");
  assert.equal(defaults.targetType, "pace");
});

const createStoreFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "rai-b03-policy-"));
  const control = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, control);
  const db = new DatabaseSync(control);
  const store = new TrainingPlanStore(db);
  const first = parseTrainingPlanState({ ...fixture.payload2, sessions: [fixture.initial], suppressions: [],
    weekPlan: [fixture.initial.prescription] }) as TrainingPlanSessionState;
  goals.write({ weekPlan: [fixture.initial.prescription] });
  const { planInstanceId: _instance, sessions: _sessions, suppressions: _suppressions, publishedInputKey: _key,
    ...legacyBase } = first;
  const legacy: TrainingPlanLegacyState = { ...legacyBase, schemaVersion: 1, migrationVersion: 1,
    goalsRevision: goals.read().revision };
  const applied = store.applyMigration({ scope: scopeKey, expectedAbsentOrRevision: 0,
    sourceDigest: legacy.sourceDigest, state: legacy });
  assert.equal(applied.status, "applied");
  let revision = store.commitState({ scope: scopeKey, expectedRevision: 1, state: first,
    eventType: "fixture:session-upgrade" }, { sessionMigration: true }).revision;
  const movedState = parseTrainingPlanState({ ...first, sessions: [fixture.moved],
    suppressions: fixture.payload2.suppressions, weekPlan: [fixture.moved.prescription] }) as TrainingPlanSessionState;
  revision = store.commitState({ scope: scopeKey, expectedRevision: revision, state: movedState,
    eventType: "fixture:move" }).revision;
  const service = new TrainingPlanCommandService(goals, () => scopeKey, () => identity, () => BUSINESS_DATE,
    () => Date.parse(AVAILABLE_AT));
  return { root, goals, db, store, service, movedState, revision,
    close: () => { db.close(); goals.close(); rmSync(root, { recursive: true, force: true }); } };
};

test("B03/S01-02/G1: preserveWeekPlan keeps nullable reason and exact protected prescription through normalize/measure/copy", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-b03-preserve-"));
  const control = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, control);
  try {
    const exact: MobilePlannedDay = { localDate: "2026-10-20", kind: "tempo", distanceKm: 8,
      structure: null, reason: null };
    const written = goals.write({ weekPlan: [exact] }, { preserveWeekPlan: true });
    assert.deepEqual(written.weekPlan[0], exact);
    assert.equal(goals.read().weekPlan[0]?.reason, null, "read-side measurement must not drop an explicit null");
    const db = new DatabaseSync(control);
    try {
      const raw = JSON.parse((db.prepare("SELECT payload_json FROM mobile_goals WHERE singleton=1").get() as {
        payload_json: string }).payload_json) as { weekPlan: MobilePlannedDay[] };
      assert.equal(raw.weekPlan[0]?.reason, null, "stored bytes keep the explicit null");
    } finally { db.close(); }
  } finally { goals.close(); rmSync(root, { recursive: true, force: true }); }
});

test("B03/S01-02: real refresh on schema 2 preserves protection/suppression, preserves reason:null and replays without duplicate sessions", async () => {
  const f = createStoreFixture();
  try {
    const before = f.store.read(scopeKey)!.state as TrainingPlanSessionState;
    const prepared = { days: [day("2026-10-28", "easy", 6, "generated"), day("2026-10-29", "interval", 9, "generated"),
      day("2026-10-30", "easy", 6, "generated"), day("2026-10-31", "easy", 6, "generated")],
      audit: { generatedBy: "heuristic" as const, model: null, promptVersion: null, generatedAt: AVAILABLE_AT },
      warnings: [], prescription: null, fingerprint: "facts-b03" };
    const deps = { prepare: async () => prepared, fingerprint: () => "facts-b03" };
    const request = { contractVersion: 2 as const, operationId: "b03-refresh", operationScope: identity,
      expectedStateRevision: f.revision };
    const result = await f.service.refresh(request, deps);
    const after = f.store.read(scopeKey)!.state as TrainingPlanSessionState;
    assert.deepEqual(after.sessions.find(session => session.sessionId === fixture.moved.sessionId), fixture.moved,
      "user-protected moved course is field-by-field unchanged");
    assert.deepEqual(after.weekPlan.find(value => value.localDate === "2026-10-29"), fixture.moved.prescription);
    assert.deepEqual(after.weekPlan.find(value => value.localDate === "2026-10-28"),
      day("2026-10-28", "rest", null, "课程已改期；源日不自动补课。"));
    assert.deepEqual(after.weekPlan.find(value => value.localDate === "2026-10-30"),
      day("2026-10-30", "rest", null, "用户指定休息。"));
    assert.deepEqual(after.weekPlan.find(value => value.localDate === "2026-10-31"), day("2026-10-31", "easy", 6, "generated"));
    assert.equal(after.sessions.filter(session => session.lifecycle !== "cancelled" && session.supersededBySessionId === null)
      .filter(session => session.prescription.localDate === "2026-10-31").length, 1);
    assert.equal(result.plan.days.find(value => value.localDate === "2026-10-29")!.kind, "easy");
    const sessionsAfter = after.sessions.length;
    const replay = await f.service.refresh(request, deps);
    assert.deepEqual(replay, result, "same operationId replays the frozen result");
    assert.equal((f.store.read(scopeKey)!.state as TrainingPlanSessionState).sessions.length, sessionsAfter);
    const projection = f.db.prepare("SELECT payload_json FROM mobile_goals WHERE singleton=1").get() as { payload_json: string };
    assert.equal(JSON.parse(projection.payload_json).weekPlan.find((value: MobilePlannedDay) => value.localDate === "2026-10-29").reason,
      fixture.moved.prescription.reason, "preserveWeekPlan keeps the exact nullable reason instead of normalize dropping it");
  } finally { f.close(); }
});

test("B03/S01-02: a configuration submit that publishes a plan uses the same resolver and cannot drop protection", async () => {
  const f = createStoreFixture();
  try {
    const preview = f.service.preview({ contractVersion: 2, operationScope: identity, expectedStateRevision: f.revision,
      action: "set_race_goal", raceGoal: { date: "2026-12-06", distanceKm: 10, goal: "finish", targetTimeSeconds: null } });
    const request = { contractVersion: 2 as const, operationId: "b03-submit", operationScope: identity,
      expectedStateRevision: f.revision, candidateId: preview.candidateId, action: "set_race_goal" as const,
      raceGoal: { date: "2026-12-06", distanceKm: 10, goal: "finish" as const, targetTimeSeconds: null } };
    const prepared = { days: [day("2026-10-29", "interval", 9, "generated"), day("2026-10-31", "easy", 6, "generated")],
      audit: { generatedBy: "heuristic" as const, model: null, promptVersion: null, generatedAt: AVAILABLE_AT },
      warnings: [], prescription: null, fingerprint: "facts-submit" };
    const result = f.service.submit(request, { prepared, fingerprint: () => "facts-submit" });
    assert.equal(result.planRefreshRequired, false);
    const after = f.store.read(scopeKey)!.state as TrainingPlanSessionState;
    assert.deepEqual(after.sessions.find(session => session.sessionId === fixture.moved.sessionId), fixture.moved);
    assert.deepEqual(after.weekPlan.find(value => value.localDate === "2026-10-29"), fixture.moved.prescription);
    assert.equal(after.weekPlan.some(value => value.localDate === "2026-10-31" && value.kind === "easy"), true);
    assert.equal(after.raceGoal?.date, "2026-12-06");
  } finally { f.close(); }
});

test("B03/S01-02: refresh failure on a new session history write rolls the whole publication back", async () => {
  const f = createStoreFixture();
  try {
    const before = f.store.read(scopeKey)!;
    const goalsBefore = f.goals.read();
    f.db.exec("CREATE TRIGGER b03_fail_session BEFORE INSERT ON mobile_training_session_history BEGIN SELECT RAISE(ABORT,'synthetic B03 failure'); END");
    await assert.rejects(() => f.service.refresh({ contractVersion: 2, operationId: "b03-fail", operationScope: identity,
      expectedStateRevision: f.revision }, {
      prepare: async () => ({ days: [day("2026-10-31", "easy", 6, "generated")],
        audit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: AVAILABLE_AT },
        warnings: [], prescription: null, fingerprint: "facts-b03" }), fingerprint: () => "facts-b03"
    }), /synthetic B03 failure/);
    assert.deepEqual(f.store.read(scopeKey), before);
    assert.deepEqual(f.goals.read(), goalsBefore);
  } finally { f.close(); }
});
