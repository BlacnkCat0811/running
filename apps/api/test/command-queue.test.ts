import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import Fastify from "fastify";
import { RaiDatabase } from "@rai/storage-sqlite";
import { CommandQueue, CommandConflictError, applyMutationCommand } from "../src/command-queue.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { registerCommandRoutes } from "../src/routes/command-routes.js";

const override = {
  trainingSessionId: "session_fixture", eligibilityOverride: null, statisticsParticipation: null,
  sessionType: null, performanceProtocol: null, rpe: 5, conditionTags: [], note: "fixture"
};
async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "command did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("business effect and receipt commit together; failed acknowledgement cannot duplicate an override", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-command-receipt-"));
  const main = join(root, "main.sqlite");
  const store = await RaiDatabase.open(main);
  store.database.exec(`
    INSERT INTO workouts (id, activity_type, source_name, source_category, start_at, end_at, duration_seconds, metadata_json, raw_attributes_json)
    VALUES ('workout_fixture', 'HKWorkoutActivityTypeRunning', 'fixture', 'apple_watch',
      '2026-01-01T00:00:00Z','2026-01-01T00:30:00Z',1800,'{}','{}');
    INSERT INTO training_sessions (id,activity_type,anchor_start_at,anchor_end_at,canonical_workout_id,status)
    VALUES ('session_fixture','HKWorkoutActivityTypeRunning','2026-01-01T00:00:00Z','2026-01-01T00:30:00Z','workout_fixture','active');
  `);
  store.close();
  let applies = 0;
  const queue = new CommandQueue(root, "fixture", new TaskAdmissionScheduler(new MutationCoordinator()).owner("commands"), async (command) => {
    applies++;
    return applyMutationCommand(main, join(root, "artifacts"), command);
  });
  const runtime = new DatabaseSync(join(root, "var/runtime.sqlite"));
  runtime.exec(`CREATE TRIGGER fail_ack BEFORE UPDATE ON mutation_commands WHEN NEW.status='succeeded'
    BEGIN SELECT RAISE(ABORT,'fixture acknowledgement failure'); END;`);
  try {
    const command = queue.enqueue({ idempotencyKey: "request-0001", kind: "workout_override", payload: override });
    await waitFor(() => applies >= 1 && queue.get(command.id)?.status === "running");
    runtime.exec("DROP TRIGGER fail_ack");
    await waitFor(() => queue.get(command.id)?.status === "succeeded");
    assert.ok(applies >= 2);
    const db = new DatabaseSync(main);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM workout_overrides").get() as { n: number }).n, 1);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recompute_jobs").get() as { n: number }).n, 1);
      const first = queue.get(command.id)?.result;
      assert.deepEqual(await applyMutationCommand(main, join(root, "artifacts"), command), first);
    } finally { db.close(); }
    assert.throws(() => queue.enqueue({ idempotencyKey: "request-0001", kind: "workout_override", payload: { ...override, rpe: 8 } }), CommandConflictError);
  } finally {
    runtime.close(); await queue.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("command route validates payload before acceptance and cancellation works while main writer is busy", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-command-route-"));
  const mutations = new MutationCoordinator();
  const release = mutations.acquire("import");
  const queue = new CommandQueue(root, "fixture", new TaskAdmissionScheduler(mutations).owner("commands"), async () => {
    throw new Error("cancelled command must never execute");
  });
  const app = Fastify();
  registerCommandRoutes(app, queue);
  try {
    const invalid = await app.inject({ method: "POST", url: "/v1/commands",
      payload: { idempotencyKey: "request-0001", kind: "workout_override", payload: {} } });
    assert.equal(invalid.statusCode, 400);
    const accepted = await app.inject({ method: "POST", url: "/v1/commands",
      payload: { idempotencyKey: "request-0001", kind: "workout_override", payload: override } });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const id = accepted.json<{ id: string }>().id;
    assert.equal(accepted.json().payload, undefined, "do not echo raw health notes");
    const cancelled = await app.inject({ method: "POST", url: `/v1/commands/${id}/cancel` });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(queue.hasPending, false);
    const duplicate = queue.enqueue({ idempotencyKey: "request-0001", kind: "workout_override", payload: Object.fromEntries(Object.entries(override).reverse()) });
    assert.equal(duplicate.id, id);
    assert.equal(duplicate.status, "cancelled");
  } finally {
    release(); await queue.close(); await app.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("an operation failure rolls back both business writes and its receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-command-rollback-"));
  const main = join(root, "main.sqlite");
  const store = await RaiDatabase.open(main);
  store.close();
  const queue = new CommandQueue(root, "fixture", new TaskAdmissionScheduler(new MutationCoordinator()).owner("commands"), async (command) =>
    applyMutationCommand(main, join(root, "artifacts"), command));
  try {
    const command = queue.enqueue({ idempotencyKey: "missing-session", kind: "workout_override", payload: override });
    await waitFor(() => queue.get(command.id)?.status === "failed");
    const db = new DatabaseSync(main);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM workout_overrides").get() as { n: number }).n, 0);
      assert.equal(db.prepare("SELECT value FROM import_manifest WHERE key=?").get(`rai.applied-command.${command.id}`), undefined);
    } finally { db.close(); }
  } finally { await queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("feedback CAS is checked at execution, conflicts do not mutate, receipt replay bypasses only its own CAS", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-feedback-cas-"));
  const main = join(root, "main.sqlite");
  const store = await RaiDatabase.open(main);
  store.database.exec(`
    INSERT INTO workouts (id, activity_type, source_name, source_category, start_at, end_at, duration_seconds, metadata_json, raw_attributes_json)
    VALUES ('workout_fixture', 'HKWorkoutActivityTypeRunning', 'fixture', 'apple_watch',
      '2026-01-01T00:00:00Z','2026-01-01T00:30:00Z',1800,'{}','{}');
    INSERT INTO training_sessions (id,activity_type,anchor_start_at,anchor_end_at,canonical_workout_id,status)
    VALUES ('session_fixture','HKWorkoutActivityTypeRunning','2026-01-01T00:00:00Z','2026-01-01T00:30:00Z','workout_fixture','active');
  `);
  store.close();
  const queue = new CommandQueue(root, "fixture", new TaskAdmissionScheduler(new MutationCoordinator()).owner("commands"), async command =>
    applyMutationCommand(main, join(root, "artifacts"), command));
  try {
    const one = queue.enqueue({ idempotencyKey: "feedback-first", kind: "workout_override", payload: { ...override, expectedRevision: 0 } });
    const stale = queue.enqueue({ idempotencyKey: "feedback-stale", kind: "workout_override", payload: { ...override, expectedRevision: 0, rpe: 9 } });
    await waitFor(() => queue.get(stale.id)?.status === "failed");
    assert.equal(queue.get(one.id)?.status, "succeeded");
    assert.equal(queue.get(stale.id)?.error?.code, "workout_override_revision_conflict");
    assert.deepEqual(await applyMutationCommand(main, join(root, "artifacts"), one), queue.get(one.id)?.result);
    const db = new DatabaseSync(main);
    try {
      const rows = db.prepare("SELECT revision,rpe,note FROM workout_overrides").all();
      assert.equal(rows.length, 1); assert.equal(rows[0]?.rpe, 5);
    } finally { db.close(); }
    const next = queue.enqueue({ idempotencyKey: "feedback-next", kind: "workout_override", payload: { ...override, expectedRevision: 1, rpe: null, note: null } });
    await waitFor(() => queue.get(next.id)?.status === "succeeded");
  } finally { await queue.close(); rmSync(root, { recursive: true, force: true }); }
});
