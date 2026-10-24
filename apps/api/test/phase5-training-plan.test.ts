import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { CoachLoopRuntimeResponse, TrainingPlanStateResponseV2 } from "@rai/api-contracts";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { coachLocalDate } from "../src/coach-loop-facts.js";

const token = "synthetic-phase5-api-token";
const scope = { serverId: "phase5-validation", athleteId: "athlete_1", datasetEpoch: "phase5-synthetic" };
const key = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
async function start(root: string, validation: boolean): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    env: { ...process.env, RAI_RUNTIME_ROOT: root, RAI_DATABASE: join(root, "var/rai.sqlite"),
      RAI_CONTROL_DATABASE: join(root, "var/rai-control.sqlite"), RAI_API_PORT: "0", RAI_API_HOST: "127.0.0.1",
      RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: token, RAI_SERVER_ID: scope.serverId, RAI_ATHLETE_ID: scope.athleteId,
      RAI_DATASET_EPOCH: scope.datasetEpoch, RAI_TRAINING_PLAN_COMMAND_MODE: validation ? "validation" : "disabled" },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(output || "server startup timed out")); }, 60_000);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    child.on("message", message => {
      const value = message as { type: string; port: number };
      if (value.type === "rai:ready") { clearTimeout(timer); resolve(value.port); }
    });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  if (child.connected) child.send("rai:shutdown"); else child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await closed; clearTimeout(timer);
}

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), "rai-phase5-regression-"));
  const seeded = spawnSync(process.execPath, ["--import", "tsx", "scripts/prepare-phase5-fixture.mts", root], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
  return root;
}

function client(url: string) {
  const call = async (path: string, body?: object, headers: Record<string, string> = {}) => {
    // The command routes require the same explicit negotiation as the handshake;
    // only the old-app handshake assertions intentionally omit it.
    const negotiated = path.startsWith("/v1/mobile/training-plan/commands")
      ? { "X-RAI-Client-Training-Commands": "2", ...headers } : headers;
    const response = await fetch(url + path, { headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...negotiated },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as any };
  };
  const read = async () => {
    const result = await call("/v1/mobile/training-plan-state", undefined, { "X-RAI-Training-Contract": "2" });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value as TrainingPlanStateResponseV2;
  };
  const draft = async (action: string, extra: object = {}) => {
    const input = { contractVersion: 2, operationScope: scope, expectedStateRevision: (await read()).stateRevision, action, ...extra };
    const preview = await call("/v1/mobile/training-plan/commands/preview", input);
    assert.equal(preview.status, 200, JSON.stringify(preview.value));
    return { ...input, operationId: randomUUID(), candidateId: preview.value.candidateId };
  };
  const command = async (action: string, extra: object = {}) => {
    const body = await draft(action, extra);
    const response = await call("/v1/mobile/training-plan/commands", body);
    assert.equal(response.status, 200, JSON.stringify(response.value));
    return { body, response };
  };
  const enable = async () => {
    const loop = (await call("/v1/mobile/coach-loop")).value as CoachLoopRuntimeResponse;
    const result = await call("/v1/mobile/coach-loop", { contractVersion: 1, operationId: randomUUID(), operationScope: scope,
      expectedRevision: loop.revision, expectedFactsHash: loop.factsHash, action: "enable", acceptedPolicyHash: loop.policyHash,
      settings: { mode: "daily_adaptive", runningDays: [1,2,3,4,5,6,7], longRunDays: [7], availabilityMinutesByWeekday: {}, targetType: "pace", race: null } });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value as CoachLoopRuntimeResponse;
  };
  return { call, read, draft, command, enable };
}

const controlTables = ["mobile_goals", "mobile_goals_history", "mobile_training_state", "mobile_training_state_history",
  "mobile_plan_operations", "mobile_coach_loop_receipts", "mobile_plan_pushes"];
function controlSnapshot(root: string) {
  const db = new DatabaseSync(join(root, "var/rai-control.sqlite"), { readOnly: true });
  try { return controlTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
  finally { db.close(); }
}

test("real router: first coach enable generates for the retained unified race goal", async () => {
  const root = seed();
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(root, true);
    const api = client(server.url);
    await api.command("set_race_goal", { raceGoal: {
      date: "2026-12-20", distanceKm: 10, goal: "time", targetTimeSeconds: 3000
    } });
    const before = await api.read();
    const enabled = await api.enable();
    const reread = (await api.call("/v1/mobile/coach-loop")).value as CoachLoopRuntimeResponse;
    const unified = await api.read();
    assert.equal(enabled.settings?.mode, "race_preparation", "the retained goal owns the mode before generation");
    assert.equal(enabled.settings?.race?.raceDate, before.raceGoal?.date);
    assert.equal(enabled.settings?.race?.targetTimeSeconds, 3000);
    assert.deepEqual(reread.settings, enabled.settings, "submission and the next read describe the same configuration");
    assert.equal(enabled.refreshRequired, false);
    assert.equal(reread.refreshRequired, false, "a just-published plan needs no corrective refresh");
    assert.deepEqual(unified.raceGoal, before.raceGoal, "enabling preferences preserves the existing race identity");
    assert.equal(unified.mode, "race");
    assert.equal(unified.plan.current, true);
    const control = new DatabaseSync(join(root, "var/rai-control.sqlite"), { readOnly: true });
    try {
      const receipt = control.prepare("SELECT payload_json FROM mobile_coach_loop_receipts ORDER BY sequence DESC LIMIT 1").get()!;
      assert.deepEqual(JSON.parse(String(receipt.payload_json)).settings, reread.settings,
        "the immutable receipt records the configuration used by subsequent reads");
    } finally { control.close(); }
  } finally { if (server) await stop(server.child); rmSync(root, { recursive: true, force: true }); }
});

test("real router: import/recompute busy blocks new unmanaged and managed generation; replay and pause remain available", async () => {
  const root = seed();
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    server = await start(root, true);
    const api = client(server.url);
    for (const managed of [false, true]) {
      if (managed) await api.enable();
      const committed = await api.command("set_race_goal", { raceGoal: { date: "2026-12-20", distanceKm: 10, goal: "finish", targetTimeSeconds: null } });
      const refresh = { contractVersion: 2, operationScope: scope, operationId: randomUUID(), expectedStateRevision: (await api.read()).stateRevision };
      const refreshed = await api.call("/v1/mobile/training-plan/commands/refresh", refresh);
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.value));
      const db = new DatabaseSync(join(root, "var/rai.sqlite"));
      try {
        // Durable in-flight import continuation / recompute evidence, seen by the
        // production readiness predicate. No production job or personal DB is used.
        for (const jobType of ["import", "full_recompute"]) {
          const id = randomUUID();
          db.prepare(`INSERT INTO recompute_jobs (id,job_type,status,request_json,progress_phase,started_at)
            VALUES (?,?,'running','{}','synthetic-readiness-latch',?)`).run(id, jobType, new Date().toISOString());
          const frozen = controlSnapshot(root);
          for (const action of ["set_race_goal", "clear_race_goal"]) {
            const body = await api.draft(action, { raceGoal: { date: "2026-12-21", distanceKm: 10, goal: "finish", targetTimeSeconds: null } });
            const rejected = await api.call("/v1/mobile/training-plan/commands", body);
            assert.equal(rejected.status, 409);
            assert.equal(rejected.value.code, "coach_sync_pending");
          }
          const rejectedRefresh = await api.call("/v1/mobile/training-plan/commands/refresh", {
            ...refresh, operationId: randomUUID(), expectedStateRevision: (await api.read()).stateRevision });
          assert.equal(rejectedRefresh.status, 409);
          assert.equal(rejectedRefresh.value.code, "coach_sync_pending");
          assert.deepEqual(controlSnapshot(root), frozen, "busy rejection adds no state, goals, history, receipt or operation");
          assert.deepEqual(await api.call("/v1/mobile/training-plan/commands", committed.body), committed.response);
          assert.deepEqual(await api.call("/v1/mobile/training-plan/commands/refresh", refresh), refreshed);
          assert.deepEqual(controlSnapshot(root), frozen, "committed results replay before busy admission");
          await api.command("pause");
          const paused = controlSnapshot(root);
          const resume = await api.draft("resume");
          const rejectedResume = await api.call("/v1/mobile/training-plan/commands", resume);
          assert.equal(rejectedResume.value.code, "coach_sync_pending");
          assert.deepEqual(controlSnapshot(root), paused, "resume cannot publish while facts are updating");
          db.prepare("UPDATE recompute_jobs SET status=?,completed_at=? WHERE id=?")
            .run(jobType === "import" ? "failed" : "succeeded", new Date().toISOString(), id);
          const recovered = await api.call("/v1/mobile/training-plan/commands", resume);
          assert.equal(recovered.status, 200, JSON.stringify(recovered.value));
          assert.equal(recovered.value.planRefreshRequired, false, "ready again after either task failure or success");
        }
      } finally { db.close(); }
      const mainPath = join(root, "var/rai.sqlite");
      const frozen = controlSnapshot(root);
      renameSync(mainPath, mainPath + ".unavailable");
      try {
        const unavailable = await api.call("/v1/mobile/training-plan/commands/refresh", {
          ...refresh, operationId: randomUUID(), expectedStateRevision: (await api.read()).stateRevision });
        assert.equal(unavailable.status, 409);
        assert.equal(unavailable.value.code, "database_not_ready", "lease-free generation retains the missing-database fence");
        assert.deepEqual(await api.call("/v1/mobile/training-plan/commands", committed.body), committed.response);
        assert.deepEqual(await api.call("/v1/mobile/training-plan/commands/refresh", refresh), refreshed);
        assert.deepEqual(controlSnapshot(root), frozen);
      } finally { renameSync(mainPath + ".unavailable", mainPath); }
    }
  } finally { if (server) await stop(server.child); rmSync(root, { recursive: true, force: true }); }
});

test("real router: lock → pause clears both current locks and stops today/aggregate execution; resume cannot reuse the old lock", async () => {
  const root = seed();
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const store = new MobileGoalsStore(root, join(root, "var/rai-control.sqlite"));
    try {
      store.bindTrainingPlanOwner(() => scope);
      store.lockSession({ localDate: coachLocalDate(new Date().toISOString()), verdictTone: "green", lockedAt: new Date().toISOString(),
        session: { kind: "easy", title: "synthetic revoked lock", reason: "pause regression", distanceKm: 3, durationMinutes: 20,
          paceSecondsPerKmLower: null, paceSecondsPerKmUpper: null, heartRateBpmLower: null, heartRateBpmUpper: null, structure: null } });
    } finally { store.close(); }
    server = await start(root, true);
    const api = client(server.url);
    const before = await api.call("/v1/mobile/today");
    assert.equal(before.value.lock.present, true);
    assert.equal(before.value.nextSession.title, "synthetic revoked lock");
    const frozen = controlSnapshot(root);
    const control = new DatabaseSync(join(root, "var/rai-control.sqlite"));
    try {
      control.exec(`CREATE TRIGGER reject_pause BEFORE INSERT ON mobile_training_state_history
        WHEN NEW.event_type='command:pause' BEGIN SELECT RAISE(ABORT,'synthetic-pause-rollback'); END`);
      const failed = await api.call("/v1/mobile/training-plan/commands", await api.draft("pause"));
      assert.equal(failed.status, 500);
      assert.deepEqual(controlSnapshot(root), frozen, "failed pause rolls back both lock clears and every publication row");
      assert.equal((await api.call("/v1/mobile/today")).value.lock.present, true);
    } finally { control.exec("DROP TRIGGER reject_pause"); control.close(); }
    await api.command("pause");
    const paused = await api.read();
    assert.equal(paused.runState, "paused");
    assert.equal(paused.plan.lockedToday, false);
    const today = await api.call("/v1/mobile/today");
    const aggregate = await api.call("/v1/mobile/training-plan-state");
    const workout = await api.call("/v1/mobile/workout-plan");
    for (const value of [today.value, aggregate.value.today]) {
      assert.equal(value.nextSession.kind, "rest");
      assert.equal(value.lock.present, false);
      assert.equal(value.lock.relockSuggested, false);
      assert.equal(value.lock.candidate.kind, "rest");
      assert.notEqual(value.phase, "locked");
      assert.equal(value.recommendation.effectiveKind, "rest");
    }
    assert.equal(aggregate.value.goals.lockedSession, null);
    assert.ok(workout.value.days.every((day: { executable: boolean }) => !day.executable));
    assert.ok(aggregate.value.workoutPlan.days.every((day: { executable: boolean }) => !day.executable));
    assert.equal((await api.call("/v1/mobile/lock", { action: "lock", expectedRevision: today.value.recommendationRevision })).status, 409);
    const stored = controlSnapshot(root);
    assert.equal(JSON.parse(String(stored[0]![0]!.payload_json)).lockedSession, null);
    assert.equal(JSON.parse(String(stored[2]![0]!.payload_json)).lockedSession, null);
    for (const index of [1, 3]) assert.deepEqual(stored[index]!.slice(0, frozen[index]!.length), frozen[index], "historical locks stay append-only");
    for (const index of [5, 6]) assert.deepEqual(stored[index], frozen[index], "pause retains device and coach receipt ledgers");
    await api.command("resume");
    const resumed = await api.call("/v1/mobile/today");
    assert.equal(resumed.value.lock.present, false);
    assert.notEqual(resumed.value.nextSession.title, "synthetic revoked lock");
    assert.equal((await api.read()).plan.lockedToday, false);
  } finally { if (server) await stop(server.child); rmSync(root, { recursive: true, force: true }); }
});

test("real server startup timer: migrated managed empty window refreshes; paused and corrupt owners never publish", async () => {
  const cases: Array<{ kind: string; root: string; server?: Awaited<ReturnType<typeof start>>; before?: ReturnType<typeof controlSnapshot> }> = [];
  try {
    for (const kind of ["active", "paused", "corrupt"]) {
      const item: (typeof cases)[number] = { kind, root: seed() };
      cases.push(item);
      item.server = await start(item.root, true);
      const api = client(item.server.url);
      await api.command("clear_race_goal");
      await api.enable();
      if (kind === "paused") await api.command("pause");
      await stop(item.server.child);
      const store = new MobileGoalsStore(item.root, join(item.root, "var/rai-control.sqlite"));
      try {
        store.bindTrainingPlanOwner(() => scope);
        store.write({ weekPlan: [], weekPlanAudit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: new Date().toISOString() } },
          { confirmCoachPlan: true, runCoach: null });
        assert.equal(store.trainingPlanOwnerReady(), true);
      } finally { store.close(); }
      if (kind === "corrupt") {
        const db = new DatabaseSync(join(item.root, "var/rai-control.sqlite"));
        try { db.prepare("DELETE FROM mobile_coach_loop_receipts").run(); } finally { db.close(); }
      }
      item.before = controlSnapshot(item.root);
    }
    for (const item of cases) item.server = await start(item.root, true);
    // Cross the production 60-second startup timer, without exporting a special
    // test endpoint or directly calling the coordinator. Hourly timer shares it.
    await new Promise(resolve => setTimeout(resolve, 65_000));
    for (const item of cases) {
      if (item.kind !== "active") {
        assert.deepEqual(controlSnapshot(item.root), item.before, `${item.kind}: startup timer must not publish`);
        continue;
      }
      const after = await client(item.server!.url).read();
      assert.equal(after.runState, "active");
      assert.equal(after.plan.days.length, 7, "startup timer reached unified managed generation");
      const stored = controlSnapshot(item.root);
      assert.equal(Number(stored[2]![0]!.revision), Number(item.before![2]![0]!.revision) + 1);
      assert.equal(stored[4]!.length, item.before![4]!.length + 1, "one atomic refresh operation");
      const latest = stored[4]!.at(-1)!;
      assert.match(String(latest.operation_id), /^auto-/);
      assert.equal(after.plan.goalsRevision, after.plan.currentGoalsRevision);
      assert.equal(stored[5]!.length, item.before![5]!.length + 1, "managed refresh records its coach receipt");
    }
  } finally {
    for (const item of cases) { if (item.server) await stop(item.server.child); rmSync(item.root, { recursive: true, force: true }); }
  }
});

test("Phase 5: authenticated real router, unified ownership, managed lifecycle, restart and disabled admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-phase5-"));
  const seeded = spawnSync(process.execPath, ["--import", "tsx", "scripts/prepare-phase5-fixture.mts", root], { encoding: "utf8" });
  assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
  let server = await start(root, true);
  const call = async (path: string, body?: object, headers: Record<string, string> = {}) => {
    const negotiated = path.startsWith("/v1/mobile/training-plan/commands")
      ? { "X-RAI-Client-Training-Commands": "2", ...headers } : headers;
    const response = await fetch(server.url + path, { headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...negotiated },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as any };
  };
  const read = async () => {
    const response = await call("/v1/mobile/training-plan-state", undefined, { "X-RAI-Training-Contract": "2" });
    assert.equal(response.status, 200, JSON.stringify(response.value)); return response.value as TrainingPlanStateResponseV2;
  };
  const command = async (action: string, extra: object = {}) => {
    const state = await read();
    const draft = { contractVersion: 2, operationScope: scope, action, expectedStateRevision: state.stateRevision, ...extra };
    const preview = await call("/v1/mobile/training-plan/commands/preview", draft);
    assert.equal(preview.status, 200, JSON.stringify(preview.value));
    const payload = { ...draft, operationId: `phase5-${action}-${state.stateRevision}`, candidateId: preview.value.candidateId };
    const response = await call("/v1/mobile/training-plan/commands", payload);
    assert.equal(response.status, 200, JSON.stringify(response.value)); return { payload, response };
  };
  try {
    assert.equal((await fetch(server.url + "/v1/handshake")).status, 401);
    assert.equal((await call("/v1/handshake")).value.trainingPlanCommandContractVersion, undefined, "old Apps never receive the command capability");
    assert.equal((await call("/v1/handshake", undefined, { "X-RAI-Client-Training-Commands": "2" })).value.trainingPlanCommandContractVersion, 2);
    assert.equal((await call("/v1/mobile/goals")).status, 410);
    assert.equal((await call("/v1/nonexistent-phase5")).status, 404);
    const before = await read();
    const draft = { contractVersion: 2, operationScope: scope, action: "pause", expectedStateRevision: before.stateRevision };
    // Capability discovery alone must not authorize a write: the command route
    // requires the explicit client negotiation header on every new request.
    const unnegotiated = await fetch(server.url + "/v1/mobile/training-plan/commands/preview", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(draft)
    });
    assert.equal(unnegotiated.status, 409);
    assert.equal((await unnegotiated.json() as { code: string }).code, "training_commands_disabled");
    const negotiatedPreview = await call("/v1/mobile/training-plan/commands/preview", draft);
    assert.equal(negotiatedPreview.status, 200, JSON.stringify(negotiatedPreview.value));
    assert.equal((await read()).stateRevision, before.stateRevision, "preview/cancel does not commit");
    const set = await command("set_race_goal", { raceGoal: { date: "2026-12-20", distanceKm: 10, goal: "finish", targetTimeSeconds: null } });
    assert.deepEqual(await call("/v1/mobile/training-plan/commands", set.payload), set.response, "same HTTP retry returns frozen response");
    assert.equal((await read()).raceGoal?.date, "2026-12-20");
    assert.equal((await call("/v1/mobile/training-plan/commands", { ...set.payload, candidateId: "tampered" })).value.code, "plan_operation_key_conflict");
    await command("clear_race_goal");
    const loop = (await call("/v1/mobile/coach-loop")).value as CoachLoopRuntimeResponse;
    const enabled = await call("/v1/mobile/coach-loop", { contractVersion: 1, operationId: randomUUID(), operationScope: scope,
      expectedRevision: loop.revision, expectedFactsHash: loop.factsHash, action: "enable", acceptedPolicyHash: loop.policyHash,
      settings: { mode: "daily_adaptive", runningDays: [1,2,3,4,5,6,7], longRunDays: [7], availabilityMinutesByWeekday: {}, targetType: "pace", race: null } });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.value));
    assert.equal((await read()).runState, "active", "valid managed v2 is readable through the unified owner");
    assert.equal((await call("/v1/mobile/training-plan-state")).status, 409, "managed v1 remains rejected");
    const paused = await command("pause");
    assert.equal((await read()).runState, "paused");
    const pausedLoop = (await call("/v1/mobile/coach-loop")).value as CoachLoopRuntimeResponse;
    assert.equal(pausedLoop.settings?.status, "paused");
    assert.ok(pausedLoop.days.every(day => !day.executable), "pause immediately denies all new execution");
    assert.equal((await call("/v1/mobile/lock", { action: "lock", expectedRevision: "synthetic-recommendation" })).status, 409);
    await command("resume");
    const changed = await command("set_race_goal", { raceGoal: { date: "2026-12-20", distanceKm: 10, goal: "finish", targetTimeSeconds: null } });
    // F1 also covers refresh: a committed refresh may be retried after its own
    // revision bump, and must return the frozen response without generating again.
    const refreshBody = { contractVersion: 2, operationScope: scope, operationId: "phase5-refresh-replay",
      expectedStateRevision: (await read()).stateRevision };
    const refreshed = await call("/v1/mobile/training-plan/commands/refresh", refreshBody);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.value));
    const refreshedRevision = (await read()).stateRevision;
    assert.deepEqual(await call("/v1/mobile/training-plan/commands/refresh", refreshBody), refreshed,
      "refresh replay returns the original response");
    assert.equal((await read()).stateRevision, refreshedRevision, "refresh replay does not publish again");
    const coachRead = (await call("/v1/mobile/coach-loop")).value as CoachLoopRuntimeResponse;
    assert.equal(coachRead.settings?.race?.raceDate, "2026-12-20", "coach reads unified current goal");
    assert.equal(coachRead.settings?.status, "active");
    const db = new DatabaseSync(join(root, "var/rai-control.sqlite"), { readOnly: true });
    try {
      const current = db.prepare("SELECT revision,payload_json FROM mobile_training_state WHERE scope=?").get(key)!;
      const goals = db.prepare("SELECT revision,payload_json FROM mobile_goals WHERE singleton=1").get()!;
      const unified = JSON.parse(String(current.payload_json)); const projection = JSON.parse(String(goals.payload_json));
      assert.equal(unified.goalsRevision, Number(goals.revision));
      assert.deepEqual(unified.weekPlan, projection.weekPlan.map((day: object & { structure?: unknown }) => ({ ...day, structure: day.structure ?? null })));
      assert.deepEqual(unified.lockedSession, projection.lockedSession);
      assert.ok(unified.coachLoop.operationId);
    } finally { db.close(); }
    const latest = (await call("/v1/mobile/coach-loop")).value as CoachLoopRuntimeResponse;
    const ended = await call("/v1/mobile/coach-loop", { contractVersion: 1, operationId: randomUUID(), operationScope: scope,
      expectedRevision: latest.revision, expectedFactsHash: latest.factsHash, action: "end" });
    assert.equal(ended.status, 200, JSON.stringify(ended.value));
    assert.equal((await read()).runState, "paused");
    const cannotResume = await call("/v1/mobile/training-plan/commands/preview", { contractVersion: 2, operationScope: scope,
      expectedStateRevision: (await read()).stateRevision, action: "resume" });
    assert.equal(cannotResume.value.code, "training_cannot_resume");
    await stop(server.child); server = await start(root, false);
    assert.equal((await call("/v1/handshake", undefined, { "X-RAI-Client-Training-Commands": "2" })).value.trainingPlanCommandContractVersion, undefined);
    assert.deepEqual(await call("/v1/mobile/training-plan/commands", changed.payload), changed.response, "replay remains available after process restart and admission disabled");
    assert.equal((await call("/v1/mobile/training-plan/commands/preview", { contractVersion: 2, operationScope: scope,
      expectedStateRevision: (await read()).stateRevision, action: "clear_race_goal" })).value.code, "training_commands_disabled");
    // A missing receipt behind a live owner pointer is corruption, not a reason
    // to fall back to a second projection: managed/v2 reads stay closed.
    const control = new DatabaseSync(join(root, "var/rai-control.sqlite"));
    try { control.prepare("DELETE FROM mobile_coach_loop_receipts").run(); } finally { control.close(); }
    assert.equal((await call("/v1/mobile/training-plan-state", undefined, { "X-RAI-Training-Contract": "2" })).status, 409);
  } finally { await stop(server.child); rmSync(root, { recursive: true, force: true }); }
});
