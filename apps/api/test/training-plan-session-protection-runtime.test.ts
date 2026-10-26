import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { COACH_RUNTIME_POLICY_HASH } from "../src/coach-loop-runtime.js";
import { digest } from "../src/plan-digest.js";
import { parseTrainingPlanState, TrainingPlanStore } from "../src/training-plan-store.js";
import { coachRuntimeFixture, runtimeReplaySettings as settings, runtimeReplayScope as scope } from "../../../scripts/coach-runtime-fixtures.mjs";

/**
 * B03 / G1: the managed (coach-loop) generation path must see a future
 * `user_protected` course before it allocates or repairs the week. The session
 * resolver still enforces the same rule at commit, but a runtime that never sees
 * the protection would spend its budget twice and then be corrected only after
 * the fact. This test pins both halves: the protected day is an input to the
 * runtime and the exact prescription survives `prepareUnified`.
 */
for (const ownership of ["user_protected", "execution"] as const) {
test(`B03/S01-02: managed runtime keeps a future ${ownership} course field-by-field and budgets around it`, () => {
  const f = coachRuntimeFixture();
  let database: DatabaseSync | undefined;
  try {
    f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
    const key = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
    database = new DatabaseSync(f.controlPath);
    const row = database.prepare(`SELECT operation_id,payload_json FROM mobile_coach_loop_receipts
      WHERE scope=? ORDER BY sequence DESC LIMIT 1`).get(JSON.stringify(scope)) as { operation_id: string; payload_json: string };
    const saved = JSON.parse(row.payload_json) as { policyHash: string; evaluatedAt: string };
    const goals = f.store.read();
    const protectedDate = "2026-10-12";
    const candidate = { localDate: protectedDate, kind: "tempo" as const, distanceKm: 8, structure: null, reason: "protected" };
    f.store.write({ weekPlan: [...goals.weekPlan.filter(day => day.localDate !== protectedDate), candidate] },
      { prescription: f.facts.inputs.prescription });
    const weekPlan = f.store.read().weekPlan;
    const protectedDay = weekPlan.find(day => day.localDate === protectedDate)!;
    const legacy = {
      schemaVersion: 1 as const, migrationVersion: 1, source: "coach_loop" as const, sourceStatus: "active" as const,
      sourceDigest: digest("b03-managed-protection").slice(0, 64), runState: "active" as const, raceGoal: null,
      preferencesComplete: true, legacyRaceTarget: null, weekPlan, lockedSession: null, runCoach: null,
      coachLoop: { operationId: row.operation_id, policyHash: saved.policyHash, evaluatedAt: saved.evaluatedAt },
      goalsRevision: f.store.read().revision, planContextDigest: null, migratedAt: "2026-10-08T00:00:00.000Z"
    };
    const store = new TrainingPlanStore(database);
    store.applyMigration({ scope: key, expectedAbsentOrRevision: 0, sourceDigest: legacy.sourceDigest, state: legacy });
    const sessions = weekPlan.filter(day => day.kind !== "rest").map((day, index) => ({
      planInstanceId: "managed-plan", sessionId: day.localDate === protectedDate ? "managed-protected" : `managed-auto-${index}`,
      sessionRevision: 1, prescription: day, recommendation: null,
      userOverride: day.localDate === protectedDate && ownership === "user_protected" ? { action: "edit" as const, prescription: day,
        availableAt: "2026-10-08T00:00:00.000Z" } : null,
      protection: day.localDate === protectedDate && ownership === "user_protected" ? "user_protected" as const : "automatic" as const,
      lifecycle: "pending" as const, availableAt: "2026-10-08T00:00:00.000Z", supersededBySessionId: null
    }));
    const state = parseTrainingPlanState({ ...legacy, schemaVersion: 2, migrationVersion: 2, planInstanceId: "managed-plan",
      sessions, suppressions: weekPlan.filter(day => day.kind === "rest").map(day => ({ localDate: day.localDate,
        reason: "explicit_rest" as const, sessionId: null, availableAt: "2026-10-08T00:00:00.000Z" })),
      publishedInputKey: null });
    store.commitState({ scope: key, expectedRevision: 1, state, eventType: "fixture:managed-protection" },
      { sessionMigration: true });
    if (state.schemaVersion !== 2) throw new Error("schema 2 required");
    f.store.bindTrainingPlanOwner(() => scope, () => f.facts.date);
    if (ownership === "execution") {
      f.store.withPublicationTransaction(() => f.store.appendTrainingPlanExecution(key, state.planInstanceId, {
        sessionId: "managed-protected", executionRevision: 1, association: "invalidated",
        trainingSessionId: "corrected-run", sourceFactDigest: "a".repeat(64), prescriptionSessionRevision: 1,
        assessment: null, availableAt: "2026-10-09T00:00:00.000Z", reasonCodes: ["execution_source_changed"]
      }, "fixture:source_changed"));
    }
    const prepared = f.runtime.prepareUnified(state);
    assert.deepEqual(prepared.days.find(day => day.localDate === protectedDate), protectedDay,
      "future protected course is not re-templated or resized by the managed runtime");
    // The legacy coach-loop command contract is still valid for this dataset and
    // must not become a second writer that bypasses the resolver.
    f.runtime.command(f.command("update", { settings: { ...settings, runningDays: [1, 2, 3, 4, 5, 6], longRunDays: [6] } }));
    const updated = store.read(key);
    assert.equal(updated?.state.schemaVersion, 2);
    if (updated?.state.schemaVersion !== 2) throw new Error("schema 2 required after update");
    assert.deepEqual(updated.state.sessions.find(session => session.sessionId === "managed-protected")!.prescription, protectedDay,
      "legacy coach-loop update cannot rewrite the protected course");
    assert.deepEqual(updated.state.weekPlan.find(day => day.localDate === protectedDate), protectedDay);
    const automatic = prepared.days.filter(day => day.kind !== "rest" && day.localDate !== protectedDate)
      .reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
    const protectedKm = protectedDay.distanceKm ?? 0;
    assert.ok(automatic > 0, "other automatic days still receive a feasible dose");
    assert.ok(automatic + protectedKm <= prepared.coachReceipt.volumePolicy.weeklyProtectionKm + 1e-9,
      `automatic ${automatic} + protected ${protectedKm} must fit the managed weekly protection envelope`);
  } finally {
    database?.close();
    f.close();
  }
});
}
