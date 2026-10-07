import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { MobilePlanSource, MobileSessionStructure } from "@rai/api-contracts";
import { MobileGoalsStore, WeeklyPlanConfirmationRequiredError } from "../src/mobile-goals.js";
import { shouldGenerateWeeklyPlan } from "../src/weekly-plan-service.js";
import { buildPlanAdherence } from "../src/plan-adherence.js";
import { buildPlanExecution } from "../src/plan-execution.js";
import { buildPeriodization } from "../src/plan-periodization.js";

const TODAY = "2026-10-06";
const structure: MobileSessionStructure = { warmup: null, cooldown: null,
  blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 5000 }, alert: null }] }] };

function seed(store: MobileGoalsStore, generatedBy: MobilePlanSource = "llm") {
  return store.write({ easyDurationFloorFraction: 0.8, qualitySessionCap: 2,
    raceTarget: { date: "2026-12-06", distance: "ten_k", targetPaceSecondsPerKm: 330 },
    weekPlan: ["2026-10-05", TODAY, "2026-10-07", "2026-12-01"].map(localDate => ({
      localDate, kind: "easy", distanceKm: 5, structure, reason: "保存的处方，包括后续手工修改"
    })),
    weekPlanAudit: { generatedBy, model: generatedBy === "llm" ? "legacy:model" : null,
      promptVersion: generatedBy === "llm" ? "legacy-v1" : null, generatedAt: "2026-10-05T00:00:00Z" },
    lockedSession: { localDate: TODAY, lockedAt: "2026-10-06T00:00:00Z", verdictTone: "green",
      session: { kind: "easy", title: "轻松跑", reason: "已锁定", distanceKm: 5, durationMinutes: 30,
        paceSecondsPerKmLower: 330, paceSecondsPerKmUpper: 390, heartRateBpmLower: null,
        heartRateBpmUpper: null, structure } }
  });
}

function withStore(run: (store: MobileGoalsStore, root: string, controlPath: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "rai-rule-plan-migration-"));
  const controlPath = join(root, "var", "control.sqlite");
  const store = new MobileGoalsStore(root, controlPath);
  try { run(store, root, controlPath); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

test("retirement preserves today, locks, provenance, historical revisions and push receipts", () => {
  withStore((store, root, controlPath) => {
    const before = seed(store);
    store.recordPlanPush({ localDate: "2026-10-07", revision: before.revision, kind: "easy",
      structure, pushedAt: "2026-10-05T01:00:00Z" });
    const history = store.planHistory();
    const pushes = store.planPushes("2026-01-01T00:00:00Z");
    const retired = store.retireLegacyModelPlan(TODAY);
    assert.equal(retired.revision, before.revision + 1);
    assert.equal(retired.weekPlanReplanRequired, true);
    assert.equal(retired.weekPlanPreservedDate, TODAY);
    assert.deepEqual(retired.weekPlan, before.weekPlan.filter(day => day.localDate <= TODAY));
    assert.deepEqual(retired.lockedSession, before.lockedSession);
    assert.deepEqual(retired.weekPlanAudit, before.weekPlanAudit);
    assert.deepEqual(retired.raceTarget, before.raceTarget);
    assert.deepEqual(store.planHistory().slice(1), history);
    assert.deepEqual(store.planPushes("2026-01-01T00:00:00Z"), pushes);
    assert.deepEqual(store.retireLegacyModelPlan(TODAY), retired);
    const reopened = new MobileGoalsStore(root, controlPath);
    try {
      assert.deepEqual(reopened.retireLegacyModelPlan("2026-10-12"), retired);
      assert.equal(reopened.read().weekPlanReplanRequired, true);
    } finally { reopened.close(); }
  });
});

test("migration leaves rule/manual plans and historical-only model plans unchanged", () => {
  for (const source of ["heuristic", "manual", "llm"] as const) withStore(store => {
    seed(store, source);
    const before = source === "llm" ? store.write({
      weekPlan: store.read().weekPlan.filter(day => day.localDate < TODAY) }) : store.read();
    assert.deepEqual(store.retireLegacyModelPlan(TODAY), before);
    assert.equal(before.weekPlanReplanRequired, false);
  });
});

test("already-retired legacy payloads acquire today's protection once", () => {
  withStore((store, _root, controlPath) => {
    seed(store);
    const retired = store.retireLegacyModelPlan(TODAY);
    const writer = new DatabaseSync(controlPath);
    try {
      const row = writer.prepare("SELECT payload_json FROM mobile_goals WHERE singleton = 1").get() as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      delete payload.weekPlanPreservedDate;
      writer.prepare("UPDATE mobile_goals SET payload_json = ? WHERE singleton = 1").run(JSON.stringify(payload));
      assert.equal(store.read().weekPlanPreservedDate, null);
      const upgraded = store.retireLegacyModelPlan(TODAY);
      assert.equal(upgraded.weekPlanPreservedDate, TODAY);
      assert.equal(upgraded.revision, retired.revision + 1);
      assert.deepEqual(upgraded.weekPlan, retired.weekPlan);
      assert.deepEqual(store.retireLegacyModelPlan(TODAY), upgraded);
    } finally { writer.close(); }
  });
});

test("a today-only legacy plan is protected without opening the future-plan confirmation gate", () => {
  withStore(store => {
    seed(store);
    const before = store.write({ weekPlan: store.read().weekPlan.filter(day => day.localDate <= TODAY) });
    const protectedPlan = store.retireLegacyModelPlan(TODAY);
    assert.equal(protectedPlan.revision, before.revision + 1);
    assert.equal(protectedPlan.weekPlanPreservedDate, TODAY);
    assert.equal(protectedPlan.weekPlanReplanRequired, false);
    assert.deepEqual(protectedPlan.weekPlan, before.weekPlan);
    assert.deepEqual(protectedPlan.weekPlanAudit, before.weekPlanAudit);
    assert.deepEqual(store.retireLegacyModelPlan(TODAY), protectedPlan);
  });
});

test("retired future days never reappear as obligations from preserved history", () => {
  withStore(store => {
    const before = seed(store);
    const retired = store.retireLegacyModelPlan(TODAY);
    assert.equal(retired.weekPlanPreservedDate, TODAY);
    const history = [
      { revision: retired.revision, changedAt: "2026-10-06T04:00:00Z",
        weekPlan: retired.weekPlan, lockedSession: retired.lockedSession },
      { revision: before.revision, changedAt: "2026-10-04T00:00:00Z",
        weekPlan: before.weekPlan, lockedSession: null }
    ];
    const adherence = buildPlanAdherence({ today: "2026-10-07", history,
      actual: [{ localDate: "2026-10-05", distanceKm: 5, workoutCount: 1 },
        { localDate: TODAY, distanceKm: 5, workoutCount: 1 }],
      periodization: buildPeriodization({ today: "2026-10-07", raceTarget: before.raceTarget, recentWeeklyKm: 40 }) });
    assert.equal(adherence.current?.plannedDays, 2);
    assert.equal(adherence.current?.plannedDistanceKm, 10);
    assert.equal(adherence.current?.unknownDays, 0);
    const execution = buildPlanExecution("2026-10-08", history, []);
    assert.equal(execution.find(day => day.localDate === "2026-10-07")?.plannedKind, null);
    assert.equal(execution.find(day => day.localDate === "2026-10-07")?.status, "unknown");
    assert.equal(execution.find(day => day.localDate === "2026-10-05")?.planRevision, before.revision);
  });
});

test("failed migration rolls back both current goals and the revision journal", () => {
  withStore((store, _root, controlPath) => {
    const before = seed(store);
    const history = store.planHistory();
    const writer = new DatabaseSync(controlPath);
    try {
      writer.exec("CREATE TRIGGER fail_retirement BEFORE INSERT ON mobile_goals_history BEGIN SELECT RAISE(ABORT, 'fixture journal failure'); END");
      assert.throws(() => store.retireLegacyModelPlan(TODAY), /fixture journal failure/);
      assert.deepEqual(store.read(), before);
      assert.deepEqual(store.planHistory(), history);
      writer.exec("DROP TRIGGER fail_retirement");
      assert.equal(store.retireLegacyModelPlan(TODAY).revision, before.revision + 1);
    } finally { writer.close(); }
  });
});

test("file-only migration backs up the full old plan and persists its pending state", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-rule-plan-file-"));
  try {
    const store = new MobileGoalsStore(root);
    seed(store);
    const path = join(root, "var", "mobile-goals.json");
    const original = readFileSync(path, "utf8");
    const retired = store.retireLegacyModelPlan(TODAY);
    assert.equal(readFileSync(`${path}.llm-retired.bak`, "utf8"), original);
    const reopened = new MobileGoalsStore(root);
    assert.deepEqual(reopened.retireLegacyModelPlan("2026-10-12"), retired);
    assert.equal(readFileSync(`${path}.llm-retired.bak`, "utf8"), original);
    const confirmed = reopened.write({ weekPlan: retired.weekPlan,
      weekPlanAudit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: null }
    }, { confirmCoachPlan: true });
    const confirmedReopened = new MobileGoalsStore(root);
    assert.equal(confirmedReopened.read().weekPlanPreservedDate, TODAY);
    assert.deepEqual(confirmedReopened.retireLegacyModelPlan(TODAY), confirmed);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only coach confirmation clears pending retirement; settings and locks remain writable", () => {
  withStore(store => {
    seed(store);
    const pending = store.retireLegacyModelPlan(TODAY);
    assert.throws(() => store.write({ weekPlan: [] }), WeeklyPlanConfirmationRequiredError);
    assert.equal(store.read().revision, pending.revision);
    const settings = store.write({ expectedRevision: pending.revision,
      easyDurationFloorFraction: 0.85, qualitySessionCap: 1 });
    assert.equal(settings.weekPlanReplanRequired, true);
    assert.equal(settings.weekPlanPreservedDate, TODAY);
    const locked = store.lockSession(settings.lockedSession!);
    assert.equal(locked.weekPlanReplanRequired, true);
    assert.throws(() => store.write({ weekPlan: [] }, { confirmCoachPlan: true }), /规则教练方案/);
    const confirmed = store.write({ expectedRevision: locked.revision,
      weekPlan: [...locked.weekPlan, { localDate: "2026-10-07", kind: "easy", distanceKm: 5, structure }],
      weekPlanAudit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: "2026-10-06T01:00:00Z" }
    }, { confirmCoachPlan: true });
    assert.equal(confirmed.weekPlanReplanRequired, false);
    assert.equal(confirmed.weekPlanPreservedDate, TODAY);
    assert.deepEqual(confirmed.weekPlan.filter(day => day.localDate <= TODAY), pending.weekPlan);
    assert.deepEqual(confirmed.lockedSession, pending.lockedSession);
    assert.doesNotThrow(() => store.write({ weekPlan: confirmed.weekPlan }));
  });
});

test("failed confirmation cannot clear the persisted replan gate", () => {
  withStore((store, _root, controlPath) => {
    seed(store);
    const pending = store.retireLegacyModelPlan(TODAY);
    const writer = new DatabaseSync(controlPath);
    try {
      writer.exec("CREATE TRIGGER fail_confirmation BEFORE INSERT ON mobile_goals_history BEGIN SELECT RAISE(ABORT, 'fixture confirm failure'); END");
      assert.throws(() => store.write({ expectedRevision: pending.revision,
        weekPlan: [{ localDate: "2026-10-07", kind: "easy", distanceKm: 5 }],
        weekPlanAudit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: null }
      }, { confirmCoachPlan: true }), /fixture confirm failure/);
      assert.deepEqual(store.read(), pending);
    } finally { writer.close(); }
  });
});

test("Monday generation never bypasses pending confirmation or overwrites an existing week", () => {
  assert.equal(shouldGenerateWeeklyPlan("2026-10-12", { weekPlan: [], weekPlanReplanRequired: true }), false);
  assert.equal(shouldGenerateWeeklyPlan("2026-10-12", { weekPlan: [], weekPlanReplanRequired: false }), true);
  assert.equal(shouldGenerateWeeklyPlan("2026-10-13", { weekPlan: [] }), false);
  assert.equal(shouldGenerateWeeklyPlan("2026-10-12", { weekPlan: [{ localDate: "2026-10-12", kind: "rest", distanceKm: null }] }), false);
  assert.equal(shouldGenerateWeeklyPlan("2026-10-12", { weekPlan: [{ localDate: "2026-10-14", kind: "easy", distanceKm: 5 }] }), false);
  assert.equal(shouldGenerateWeeklyPlan("2026-10-12", { weekPlan: [{ localDate: "2026-10-11", kind: "easy", distanceKm: 5 }] }), true);
  assert.equal(shouldGenerateWeeklyPlan("2026-10-12", { weekPlan: [{ localDate: "2026-10-19", kind: "easy", distanceKm: 5 }] }), true);
});
