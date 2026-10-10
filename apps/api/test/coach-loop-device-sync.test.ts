import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { CoachLoopDeviceReceipt, CoachLoopRuntimeResponse } from "@rai/api-contracts";
import { registerCoachLoopRoutes } from "../src/coach-loop-routes.js";
import { COACH_RUNTIME_POLICY_HASH, type CoachRuntimeReceipt } from "../src/coach-loop-runtime.js";
import { prescriptionDigest } from "../src/plan-digest.js";
import { MobileGoalsRevisionConflictError } from "../src/mobile-goals.js";
import { coachRuntimeFixture, runtimeReplayScope as scope, runtimeReplaySettings as settings } from "../../../scripts/coach-runtime-fixtures.mjs";

function receipt(state: CoachLoopRuntimeResponse): CoachLoopDeviceReceipt {
  const workoutID = randomUUID();
  return { contractVersion: 2, scope, operationId: randomUUID(), coherenceToken: state.executionToken,
    localDate: state.today.day.localDate, kind: state.today.day.kind, revision: state.revision,
    structure: state.today.day.structure!, workoutID, scheduledAt: `${state.today.day.localDate}T05:00:00Z`,
    verifiedAt: `${state.today.day.localDate}T04:01:00Z`, timezone: "Asia/Shanghai",
    prescriptionDigest: prescriptionDigest(state.today.day.kind, state.today.day.structure!),
    lifecycleEvent: "verified", idempotencyKey: workoutID,
    coachLoop: { contractVersion: 1, policyHash: state.policyHash, decisionRef: state.today.decisionRef } };
}

test("AC0-17/21: safety occupancy and withdrawal lookup cannot be truncated by 250 newer unrelated receipts", () => {
  const f = coachRuntimeFixture();
  try {
    const id = randomUUID(), at = "2026-10-08T05:00:00Z";
    f.store.recordPlanPush({ localDate: "2026-10-08", kind: "easy", revision: 0, structure: null,
      pushedAt: "2026-10-01T00:00:00Z", workoutID: id, scheduledAt: at });
    for (let i = 0; i < 250; i++) f.store.recordPlanPush({ localDate: "2026-10-08", kind: "rest",
      revision: 0, structure: null, pushedAt: "2026-10-09T00:00:00Z" });
    assert.ok(!f.store.planPushes("0000", 200).some(push => push.workoutID === id));
    assert.equal(f.store.activePlanPushes().filter(push => push.workoutID === id).length, 1);
    assert.ok(f.store.planPushForSystemEntry(id, at));
    assert.throws(() => f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH })),
      /旧设备排期/, "AC0-17-old-device-not-forgotten");
    assert.equal(f.store.read().revision, 0);
  } finally { f.close(); }
});

test("AC0-12/17/21 R22: new receipt registers exact today authorization; retries, pause and withdrawal preserve occupancy", () => {
  const f = coachRuntimeFixture();
  try {
    const published = f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
    const body = receipt(published), registered = f.runtime.recordDeviceReceipt(body);
    assert.equal(registered.matchesCurrent, true, "AC0-12-device-current");
    assert.deepEqual(f.runtime.recordDeviceReceipt(body), registered);
    assert.equal(f.store.planPushes("0000").length, 1);
    assert.equal(f.runtime.read().today.executable, true, "registering the existing slot must not duplicate/block itself");
    f.runtime.command(f.command("pause"));
    const pausedRetry = f.runtime.recordDeviceReceipt(body);
    assert.equal(pausedRetry.recordedAt, registered.recordedAt);
    assert.equal(pausedRetry.matchesCurrent, false, "AC0-21-idempotent-retry-is-not-eternal-execution-authority");
    assert.equal(f.store.planPushes("0000").length, 1, "revalidation cannot write a second receipt");
    const saved = f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(scope))!;
    assert.equal(saved.reservations[0]?.deviceScheduleUnresolved, true, "AC0-17-device-occupancy");
    assert.equal(f.runtime.read().today.executable, false);
    const withdrawn = f.runtime.recordDeviceReceipt({ ...body, lifecycleEvent: "withdrawn",
      idempotencyKey: `${body.workoutID}:withdrawn` });
    assert.equal(withdrawn.matchesCurrent, false);
    assert.equal(f.store.planPushIsActive(body.workoutID!, body.scheduledAt!), false);
    f.runtime.command(f.command("refresh"));
    assert.equal(f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(scope))!.reservations[0]?.deviceScheduleUnresolved, false);
  } finally { f.close(); }
});

test("AC0-22/AC3-08: new receipt rejects identity/structure/auth forgeries and rolls back inserted evidence on failure", () => {
  const f = coachRuntimeFixture();
  try {
    const state = f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
    const body = receipt(state);
    assert.throws(() => f.runtime.recordDeviceReceipt({ ...body, scope: { ...scope, datasetEpoch: "other" } }), /数据集/);
    assert.throws(() => f.runtime.recordDeviceReceipt({ ...body, coachLoop: { ...body.coachLoop, decisionRef: "f".repeat(64) } }), /真实发布/);
    assert.throws(() => f.runtime.recordDeviceReceipt({ ...body, prescriptionDigest: "f".repeat(64) }), /不一致/);
    assert.throws(() => f.runtime.recordDeviceReceipt({ ...body, lifecycleEvent: "withdrawn" }), /不能撤销/);
    const original = f.store.recordPlanPush.bind(f.store);
    f.store.recordPlanPush = input => { original(input); throw new Error("injected after receipt insert"); };
    assert.throws(() => f.runtime.recordDeviceReceipt(body), /injected/);
    assert.equal(f.store.planPushes("0000").length, 0, "AC0-22-device-rollback");
    f.store.recordPlanPush = original;
    assert.equal(f.runtime.recordDeviceReceipt(body).matchesCurrent, true);
  } finally { f.close(); }
});

test("AC0-17/21: stale verified device evidence is historical, duplicate schedules are not current, future outlook is not device authority", () => {
  const f = coachRuntimeFixture();
  try {
    const state = f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
    const body = receipt(state);
    assert.equal(f.runtime.recordDeviceReceipt(body).matchesCurrent, true);
    f.facts.factsHash = "changed";
    assert.equal(f.runtime.recordDeviceReceipt(body).matchesCurrent, false, "AC0-21-stale-device-token");
    const current = f.runtime.command(f.command("refresh"));
    assert.equal(f.runtime.recordDeviceReceipt(receipt(current)).matchesCurrent, false, "AC0-17-duplicate-device");
    const day = state.days.find(row => row.day.localDate !== state.today.day.localDate && row.day.kind !== "rest");
    assert.ok(day, "positive future outlook is required for this device-negative assertion");
    {
      const future = { ...body, localDate: day.day.localDate, kind: day.day.kind, structure: day.day.structure!,
        scheduledAt: `${day.day.localDate}T05:00:00Z`, prescriptionDigest: prescriptionDigest(day.day.kind, day.day.structure!),
        coachLoop: { ...body.coachLoop, decisionRef: null }, workoutID: randomUUID(), idempotencyKey: randomUUID() };
      assert.equal(f.runtime.recordDeviceReceipt(future).matchesCurrent, false, "future cannot be certified");
    }
    assert.equal(f.store.read().revision, current.revision);
  } finally { f.close(); }
});

test("AC0-12/22: HTTP capability/schema refuses unknown receipt versions and concurrent enable loses CAS, not half authorization", async () => {
  const f = coachRuntimeFixture(), app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  app.setErrorHandler((error, _request, reply) => {
    const details: Error & { statusCode?: number } = error instanceof Error ? error : new Error(String(error));
    return reply.code(error instanceof MobileGoalsRevisionConflictError ? 409 : details.statusCode ?? 500)
      .send({ message: details.message });
  });
  registerCoachLoopRoutes({ app, runtime: f.runtime, identity: () => scope,
    openMainDatabase: async () => { throw new Error("no main DB needed"); } });
  try {
    const a = f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH });
    const b = { ...a, operationId: randomUUID() };
    const replies = await Promise.all([a, b].map(payload => app.inject({ method: "POST", url: "/v1/mobile/coach-loop", payload })));
    assert.deepEqual(replies.map(r => r.statusCode).sort(), [200, 409]);
    assert.equal(f.store.coachLoopReceipts(JSON.stringify(scope)).length, 1);
    const state = f.runtime.read(), body = receipt(state);
    const result = await app.inject({ method: "POST", url: "/v1/mobile/coach-loop/synced", payload: body });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().matchesCurrent, true);
    const invalid = await app.inject({ method: "POST", url: "/v1/mobile/coach-loop/synced",
      payload: { ...body, coachLoop: { ...body.coachLoop, contractVersion: 9 } } });
    assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); f.close(); }
});

test("AC0-12: regular courses with null authority/unknown targets use the new HTTP contract without inventing pace or HR", async () => {
  const f = coachRuntimeFixture(), app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  registerCoachLoopRoutes({ app, runtime: f.runtime, identity: () => scope,
    openMainDatabase: async () => { throw new Error("system receipt does not write health facts"); } });
  try {
    f.facts.facts = f.facts.facts.filter(run => run.id !== "monday-20");
    f.facts.inputs.prescription = null;
    const state = f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
    assert.equal(state.today.executable, true);
    assert.equal(state.today.decisionRef, null);
    const body = receipt(state);
    assert.equal(body.structure!.warmup!.alert, null);
    assert.equal(body.structure!.blocks[0]!.steps[0]!.alert, null);
    const response = await app.inject({ method: "POST", url: "/v1/mobile/coach-loop/synced", payload: body });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().matchesCurrent, true);
    assert.equal(f.store.planPushes("0000")[0]!.coachLoop!.decisionRef, null);
  } finally { await app.close(); f.close(); }
});
