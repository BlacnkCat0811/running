import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { CoachLoopRuntimeResponse, TrainingPlanStateResponseV2 } from "@rai/api-contracts";
import { TRAINING_PLAN_CLOSED_LOOP_CONTRACT, trainingPlanClosedLoopSupport } from "@rai/api-contracts";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { coachLocalDate } from "../src/coach-loop-facts.js";
import { applySessionIdentityMigration, inspectSessionIdentityMigration } from "../src/training-plan-session-migration.js";

import { posixOnlyReason } from "./posix-only.js";

/**
 * 🔴 CI 2026-10-25（`windows-latest`）：本条红在
 * `renameSync(rai.sqlite, rai.sqlite.unavailable)` 上 ——
 * `EBUSY: resource busy or locked, rename '…\var\rai.sqlite' -> '…\var\rai.sqlite.unavailable'`。
 * 机制是 Windows 的文件共享语义：**不允许 rename/unlink 一个仍被打开的文件**，而这里的
 * 主库正被真子进程 API 服务开着（这条用例的全部价值就在于它是真服务、真路由）。POSIX 允许
 * （rename 只换目录项，已打开的句柄继续读旧 inode）。
 *
 * 这条判据要证明的是"导库/重算繁忙期必须挡住新的 unmanaged 与 managed 生成，重放与暂停仍然
 * 可用，并且随后库不可读时仍保留 database_not_ready 围栏"。它后半段依赖"把主库搬走"这个
 * 动作，而该动作在 Windows 上做不出来，所以这条判据在那里没有被检查。
 * 同文件其余 Phase 5 用例不搬库，在 Windows 上照常通过。
 */
const DATABASE_MOVE_ONLY = posixOnlyReason(
  "Windows 不允许 rename/unlink 仍被打开的文件：主库正被真子进程 API 开着，"
  + "用例把它 rename 成 rai.sqlite.unavailable 时直接 EBUSY"
  + "（CI 2026-10-25：「EBUSY: resource busy or locked, rename …rai.sqlite」）。"
  + "本条判据（繁忙期挡住新生成、重放与暂停仍可用、库不可读时保留 database_not_ready 围栏）"
  + "依赖的『搬走主库』动作在 Windows 上做不出来，因此没有被检查；真正的 Windows 换库路径另立工单。"
);

const token = "synthetic-phase5-api-token";
const scope = { serverId: "phase5-validation", athleteId: "athlete_1", datasetEpoch: "phase5-synthetic" };
const key = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
async function start(root: string, validation: boolean, sessionValidation = false,
  executionValidation = false, autoPublishValidation = false, mode: "validation" | "production" = "validation"): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    env: { ...process.env, RAI_RUNTIME_ROOT: root, RAI_DATABASE: join(root, "var/rai.sqlite"),
      RAI_CONTROL_DATABASE: join(root, "var/rai-control.sqlite"), RAI_API_PORT: "0", RAI_API_HOST: "127.0.0.1",
      RAI_LOG_LEVEL: process.env.RAI_TEST_LOG_LEVEL ?? "silent", RAI_API_TOKEN: token, RAI_SERVER_ID: scope.serverId, RAI_ATHLETE_ID: scope.athleteId,
      RAI_DATASET_EPOCH: scope.datasetEpoch, RAI_TRAINING_PLAN_COMMAND_MODE: validation ? mode : "disabled",
      RAI_TRAINING_PLAN_SESSION_COMMAND_MODE: sessionValidation ? mode : "disabled",
      RAI_TRAINING_PLAN_EXECUTION_COMMAND_MODE: executionValidation ? mode : "disabled",
      RAI_TRAINING_PLAN_AUTO_PUBLISH_MODE: autoPublishValidation ? mode : "disabled" },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = ""; child.stdout!.on("data", data => { output += data; if (process.env.RAI_TEST_LOG_LEVEL) process.stderr.write(data); }); child.stderr!.on("data", data => { output += data; if (process.env.RAI_TEST_LOG_LEVEL) process.stderr.write(data); });
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

function seed(outsideTemporaryRoot = false): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "rai-phase5-regression-"));
  let relocated: string | undefined;
  try {
    const seeded = spawnSync(process.execPath, ["--import", "tsx", "scripts/prepare-phase5-fixture.mts", temporaryRoot], { encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    if (!outsideTemporaryRoot) return temporaryRoot;
    // The fixture generator keeps its temporary-only safety contract. Copy its
    // closed synthetic databases into a new test-owned directory to exercise a
    // normal production path; never accept an existing/personal runtime here.
    relocated = mkdtempSync(join(process.cwd(), ".rai-production-write-test-"));
    cpSync(temporaryRoot, relocated, { recursive: true });
    rmSync(temporaryRoot, { recursive: true, force: true });
    return relocated;
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (relocated) rmSync(relocated, { recursive: true, force: true });
    throw error;
  }
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
  "mobile_plan_operations", "mobile_coach_loop_receipts", "mobile_plan_pushes", "mobile_training_session_history",
  "mobile_training_execution", "mobile_training_execution_history", "mobile_training_plan_evaluation"];
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
    // B02: real maintenance upgrade + real server restart. Reads preserve a
    // positive plan and durable IDs without enabling the still-unaccepted writer.
    assert.ok(unified.plan.days.some(day => day.kind !== "rest"), "a zero-running fixture cannot prove identity preservation");
    await stop(server.child); server = undefined;
    const migrationDb = new DatabaseSync(join(root, "var/rai-control.sqlite"));
    try {
      const migration = inspectSessionIdentityMigration(migrationDb, key);
      applySessionIdentityMigration(migrationDb, key, migration.sourceDigest, migration.existingRevision);
    } finally { migrationDb.close(); }
    server = await start(root, false);
    const upgraded = client(server.url);
    const header = { "X-RAI-Training-Contract": "2", "X-RAI-Training-Sessions": "1" };
    const frozen = controlSnapshot(root);
    const extended = await upgraded.call("/v1/mobile/training-plan-state", undefined, header);
    assert.equal(extended.status, 200, JSON.stringify(extended.value));
    assert.deepEqual(extended.value.plan.days, unified.plan.days);
    assert.ok(extended.value.sessions.sessions.length > 0);
    assert.ok(extended.value.sessions.sessions.every((session: any) => session.protection === "user_protected"));
    assert.equal(extended.value.execution.permitted, false);
    assert.deepEqual((await upgraded.call("/v1/mobile/training-plan-state", undefined, header)).value.sessions, extended.value.sessions);
    assert.equal((await upgraded.read()).sessions, undefined, "unnegotiated v2 retains the old wire shape");
    assert.equal((await upgraded.call("/v1/handshake", undefined, header)).value.trainingPlanSessionContractVersion, 1,
      "B03/G1 advertises session read only after controlled migration and owner readiness");
    const unknown = await upgraded.call("/v1/mobile/training-plan-state", undefined, { ...header, "X-RAI-Training-Sessions": "999" });
    assert.equal(unknown.value.code, "training_session_contract_unsupported");
    assert.deepEqual(controlSnapshot(root), frozen, "negotiated and ordinary GETs allocate no IDs and write no business rows");
  } finally { if (server) await stop(server.child); rmSync(root, { recursive: true, force: true }); }
});

test("real router: import/recompute busy blocks new unmanaged and managed generation; replay and pause remain available", { skip: DATABASE_MOVE_ONLY }, async () => {
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
    for (const item of cases) item.server = await start(item.root, true, false, false, true);
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
    // B01 freezes contracts without advertising new runtime capabilities, even
    // to a client that asks for all four extensions in the validation server.
    const extensionHeaders = Object.fromEntries(
      (["sessions", "sessionCommands", "executionCommands", "updates"] as const)
        .map(key => [TRAINING_PLAN_CLOSED_LOOP_CONTRACT[key].header, "1"]));
    const assertClosedLoopDeferred = async () => {
      const handshake = (await call("/v1/handshake", undefined,
        { ...extensionHeaders, "X-RAI-Client-Training-Commands": "2" })).value;
      for (const key of ["sessions", "sessionCommands", "executionCommands", "updates"] as const) {
        assert.equal(handshake[TRAINING_PLAN_CLOSED_LOOP_CONTRACT[key].capability], undefined, key);
      }
      assert.deepEqual(trainingPlanClosedLoopSupport(handshake),
        { sessions: false, sessionCommands: false, executionCommands: false, updates: false });
    };
    await assertClosedLoopDeferred();
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
    await assertClosedLoopDeferred();
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


for (const mode of ["validation", "production"] as const) {
test(`B04 real HTTP: independent negotiation, six session actions, safety, restart replay and writer disable/replay (${mode})`, async () => {
  const root = seed(mode === "production");
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const control = new DatabaseSync(join(root, "var/rai-control.sqlite"));
    try { const migration = inspectSessionIdentityMigration(control, key);
      applySessionIdentityMigration(control, key, migration.sourceDigest, migration.existingRevision);
    } finally { control.close(); }
    server = await start(root, false, true, false, false, mode);
    let api = client(server.url);
    assert.equal((await fetch(server.url + "/v1/handshake")).status, 401);
    assert.equal((await fetch(server.url + "/v1/mobile/training-plan/session-commands", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    })).status, 401, "write admission never bypasses Bearer authentication");
    const headers = { "X-RAI-Client-Training-Session-Commands": "1" };
    const read = async () => (await api.call("/v1/mobile/training-plan-state", undefined,
      { "X-RAI-Training-Contract": "2", "X-RAI-Training-Sessions": "1" })).value;
    const today = (await read()).businessDate;
    const date = (offset: number) => new Date(Date.parse(today + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
    const prescription = (offset: number, km: number) => ({ localDate: date(offset), kind: "easy", distanceKm: km,
      reason: null, structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1,
        steps: [{ purpose: "work", goal: { type: "distance", meters: km * 1000 }, alert: null }] }] } });
    const request = async (draft: object) => { const state = await read(); return { contractVersion: 1, operationScope: scope,
      expectedStateRevision: state.stateRevision, planInstanceId: state.sessions.planInstanceId, draft }; };
    const save = async (draft: object) => {
      const input = await request(draft);
      const preview = await api.call("/v1/mobile/training-plan/session-commands/preview", input, headers);
      assert.equal(preview.status, 200, JSON.stringify(preview.value));
      const body = { ...input, operationId: randomUUID(), candidateId: preview.value.candidateId };
      const response = await api.call("/v1/mobile/training-plan/session-commands", body, headers);
      assert.equal(response.status, 200, JSON.stringify(response.value)); return { body, response, preview: preview.value };
    };
    assert.equal((await api.call("/v1/handshake")).value.trainingPlanSessionCommandContractVersion, undefined);
    const sessionHandshake = (await api.call("/v1/handshake", undefined, headers)).value;
    assert.equal(sessionHandshake.trainingPlanSessionCommandContractVersion, 1);
    assert.equal(sessionHandshake.trainingPlanCommandContractVersion, undefined, "session writes do not require the separate configuration switch");
    const add = await request({ action: "add", prescription: prescription(2, 2) });
    assert.equal((await api.call("/v1/mobile/training-plan/session-commands/preview", add)).value.code, "training_session_commands_disabled");
    const added = await save(add.draft);
    assert.equal(added.response.value.session.sessionId, added.preview.impact.after.sessionId);
    let session = added.response.value.session;
    const existing = () => ({ sessionId: session.sessionId, sessionRevision: session.sessionRevision });
    const frozen = controlSnapshot(root);
    const tooMuch = await request({ action: "edit", ...existing(), patch: { distanceKm: 30, structure: prescription(2, 30).structure } });
    assert.equal((await api.call("/v1/mobile/training-plan/session-commands/preview", tooMuch, headers)).value.code, "training_session_safety_rejected");
    assert.deepEqual(controlSnapshot(root), frozen);
    session = (await save({ action: "move", ...existing(), localDate: date(3) })).response.value.session;
    assert.equal(session.sessionId, added.response.value.session.sessionId);
    session = (await save({ action: "edit", ...existing(), patch: { distanceKm: 3, structure: prescription(3, 3).structure, reason: null } })).response.value.session;
    assert.equal(session.prescription.distanceKm, 3);
    session = (await save({ action: "edit", ...existing(), patch: { kind: "recovery" } })).response.value.session;
    assert.equal(session.prescription.kind, "recovery");
    assert.equal(session.prescription.structure.blocks[0].steps[0].goal.meters, 3000);
    const protectedCourse = structuredClone(session);
    await stop(server.child); server = undefined;
    server = await start(root, true, true, false, false, mode); api = client(server.url);
    for (let pass = 0; pass < 3; pass++) {
      const current = await read();
      const refreshed = await api.call("/v1/mobile/training-plan/commands/refresh", { contractVersion: 2,
        operationId: randomUUID(), operationScope: scope, expectedStateRevision: current.stateRevision });
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.value));
      const after = await read();
      assert.deepEqual(after.sessions.sessions.find((item: any) => item.sessionId === session.sessionId), protectedCourse,
        "repeated real refresh preserves the exact edited course, ID and session revision");
      assert.equal(after.plan.days.find((item: any) => item.localDate === date(2))?.kind, "rest", "the moved source cannot resurrect");
    }
    session = (await save({ action: "unlock", ...existing() })).response.value.session;
    assert.equal(session.protection, "automatic");
    session = (await save({ action: "cancel", ...existing() })).response.value.session;
    assert.equal(session.lifecycle, "cancelled");
    const rest = await save({ action: "set_rest", localDate: date(10) });
    const finalState = await read();
    await stop(server.child); server = undefined;
    server = await start(root, false, false, false, false, mode); api = client(server.url);
    const before = controlSnapshot(root);
    assert.deepEqual(await api.call("/v1/mobile/training-plan/session-commands", rest.body, headers), rest.response,
      "committed replay is available after restart with the writer closed");
    assert.equal((await read()).sessions.sessions[0].lifecycle, "cancelled");
    assert.deepEqual((await read()).sessions, finalState.sessions);
    assert.equal((await api.call("/v1/handshake", undefined, headers)).value.trainingPlanSessionCommandContractVersion, undefined);
    assert.equal((await api.call("/v1/mobile/training-plan/session-commands/preview", await request({ action: "set_rest", localDate: date(11) }), headers)).value.code,
      "training_session_commands_disabled");
    assert.deepEqual(controlSnapshot(root), before);
  } finally { if (server) await stop(server.child); rmSync(root, { recursive: true, force: true }); }
});
}

for (const mode of ["validation", "production"] as const) {
test(`B06 real HTTP: execution candidates, confirm, unified execution read, replay and retract (${mode})`, async () => {
  const root = seed(mode === "production");
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const control = new DatabaseSync(join(root, "var/rai-control.sqlite"));
    try {
      const migration = inspectSessionIdentityMigration(control, key);
      applySessionIdentityMigration(control, key, migration.sourceDigest, migration.existingRevision);
    } finally { control.close(); }
    server = await start(root, true, true, true, false, mode);
    let api = client(server.url);
    const sessionHeaders = { "X-RAI-Client-Training-Session-Commands": "1" };
    const executionHeaders = { "X-RAI-Client-Training-Execution-Commands": "1" };
    const read = async () => (await api.call("/v1/mobile/training-plan-state", undefined,
      { "X-RAI-Training-Contract": "2", "X-RAI-Training-Sessions": "1" })).value;
    const today = (await read()).businessDate;
    const prescription = { localDate: today, kind: "easy", distanceKm: 2, reason: "B06 synthetic",
      structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1,
        steps: [{ purpose: "work", goal: { type: "distance", meters: 2000 }, alert: null }] }] } };
    const addInput = { contractVersion: 1, operationScope: scope, expectedStateRevision: (await read()).stateRevision,
      planInstanceId: (await read()).sessions.planInstanceId, draft: { action: "add", prescription } };
    const preview = await api.call("/v1/mobile/training-plan/session-commands/preview", addInput, sessionHeaders);
    assert.equal(preview.status, 200, JSON.stringify(preview.value));
    const addBody = { ...addInput, operationId: randomUUID(), candidateId: preview.value.candidateId };
    const added = await api.call("/v1/mobile/training-plan/session-commands", addBody, sessionHeaders);
    assert.equal(added.status, 200, JSON.stringify(added.value));
    const sessionId = added.value.session.sessionId as string;
    assert.equal(added.value.session.lifecycle, "pending");

    // The synthetic course is published now; the synthetic run happened at
    // 00:05 today. Age the course's availability so the real frozen-prescription
    // rule ("published before the run") is exercised instead of bypassed.
    const agedAt = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().replace(".000Z", ".000Z");
    const aged = new Date(Date.parse(`${today}T00:00:00+08:00`) - 86400000).toISOString();
    const controlWrite = new DatabaseSync(join(root, "var/rai-control.sqlite"));
    try {
      const raw = controlWrite.prepare("SELECT payload_json FROM mobile_training_state WHERE scope=?").get(key) as { payload_json: string };
      const payload = JSON.parse(raw.payload_json) as any;
      const course = payload.sessions.find((item: any) => item.sessionId === sessionId);
      assert.ok(course, "the added course is in the unified state");
      course.availableAt = aged;
      controlWrite.prepare("UPDATE mobile_training_state SET payload_json=? WHERE scope=?").run(JSON.stringify(payload), key);
      const frozen = controlWrite.prepare(`SELECT payload_json FROM mobile_training_session_history
        WHERE scope=? AND session_id=? AND session_revision=?`).get(key, sessionId, course.sessionRevision) as { payload_json: string };
      const history = JSON.parse(frozen.payload_json) as any;
      history.availableAt = aged;
      controlWrite.prepare(`UPDATE mobile_training_session_history SET payload_json=?, available_at=?
        WHERE scope=? AND session_id=? AND session_revision=?`).run(JSON.stringify(history), aged, key, sessionId, course.sessionRevision);
    } finally { controlWrite.close(); }
    void agedAt;

    const runStart = `${today}T00:05:00+08:00`, runEnd = `${today}T00:50:00+08:00`;
    const main = new DatabaseSync(join(root, "var/rai.sqlite"));
    try {
      main.prepare(`INSERT INTO workouts (id,activity_type,source_name,source_category,start_at,end_at,duration_seconds,
        metadata_json,raw_attributes_json,is_canonical) VALUES (?,?,?,?,?,?,?,?,?,1)`)
        .run("b06-workout", "HKWorkoutActivityTypeRunning", "Synthetic Watch", "watchOS", runStart, runEnd, 2700, "{}", "{}");
      main.prepare(`INSERT INTO training_sessions (id,activity_type,anchor_start_at,anchor_end_at,anchor_distance_km,
        canonical_workout_id,status) VALUES (?,?,?,?,?,?,'active')`)
        .run("b06-run", "HKWorkoutActivityTypeRunning", runStart, runEnd, 2.1, "b06-workout");
    } finally { main.close(); }

    assert.equal((await api.call("/v1/handshake")).value.trainingPlanExecutionCommandContractVersion, undefined);
    assert.equal((await api.call("/v1/handshake", undefined, executionHeaders)).value.trainingPlanExecutionCommandContractVersion, 1);
    const candidatePath = `/v1/mobile/training-plan/sessions/${sessionId}/execution-candidates?planInstanceId=${encodeURIComponent((await read()).sessions.planInstanceId)}`;
    assert.equal((await api.call(candidatePath)).value.code, "training_execution_commands_disabled");
    const candidates = await api.call(candidatePath, undefined, executionHeaders);
    assert.equal(candidates.status, 200, JSON.stringify(candidates.value));
    const candidate = candidates.value.candidates.find((item: any) => item.trainingSessionId === "b06-run");
    assert.ok(candidate, JSON.stringify(candidates.value));
    assert.equal(candidate.evidence, "needs_confirmation");
    assert.equal(candidate.distanceMeters, 2100);
    assert.equal(candidates.value.executionRevision, 0);
    const body = { contractVersion: 1, operationId: randomUUID(), operationScope: scope,
      expectedStateRevision: (await read()).stateRevision, planInstanceId: (await read()).sessions.planInstanceId,
      sessionId, sessionRevision: added.value.session.sessionRevision, executionRevision: 0,
      draft: { action: "confirm", trainingSessionId: "b06-run", sourceFactDigest: candidate.sourceFactDigest } };
    const confirmed = await api.call("/v1/mobile/training-plan/execution-commands", body, executionHeaders);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.value));
    assert.equal(confirmed.value.execution.association, "confirmed");
    assert.equal(confirmed.value.execution.assessment.dose.status, "met");
    assert.equal(confirmed.value.session.lifecycle, "completed");
    const after = await read();
    const execution = after.sessions.executions.find((item: any) => item.sessionId === sessionId);
    assert.ok(execution, "the unified sessions view exposes the current execution");
    assert.equal(execution.trainingSessionId, "b06-run");
    assert.equal(execution.assessment.stimulus.status, "not_assessable");
    const verified = await api.call(candidatePath, undefined, executionHeaders);
    assert.equal(verified.value.candidates.find((item: any) => item.trainingSessionId === "b06-run").evidence, "verified_identity");
    assert.equal(verified.value.executionRevision, 1);
    assert.deepEqual(await api.call("/v1/mobile/training-plan/execution-commands", body, executionHeaders), confirmed,
      "the durable key replays the original result");
    const retract = { ...body, operationId: randomUUID(), expectedStateRevision: after.stateRevision,
      sessionRevision: confirmed.value.session.sessionRevision, executionRevision: 1,
      draft: { action: "retract", trainingSessionId: "b06-run", sourceFactDigest: candidate.sourceFactDigest } };
    const retracted = await api.call("/v1/mobile/training-plan/execution-commands", retract, executionHeaders);
    assert.equal(retracted.status, 200, JSON.stringify(retracted.value));
    assert.equal(retracted.value.execution.association, "invalidated");
    assert.equal(retracted.value.session.lifecycle, "pending");
    const final = await read();
    assert.equal(final.sessions.executions.find((item: any) => item.sessionId === sessionId).association, "invalidated");
    const history = new DatabaseSync(join(root, "var/rai-control.sqlite"), { readOnly: true });
    try {
      assert.equal((history.prepare("SELECT COUNT(*) AS n FROM mobile_training_execution_history WHERE session_id=?").get(sessionId) as { n: number }).n, 2);
    } finally { history.close(); }
    await stop(server.child); server = undefined;
    server = await start(root, false); api = client(server.url);
    const closedSnapshot = controlSnapshot(root);
    assert.deepEqual(await api.call("/v1/mobile/training-plan/execution-commands", body, executionHeaders), confirmed,
      "closing the production writer preserves the original operation result");
    assert.equal((await api.call(candidatePath, undefined, executionHeaders)).value.code, "training_execution_commands_disabled");
    assert.deepEqual(controlSnapshot(root), closedSnapshot, "disabled replay remains read-only");
  } finally { if (server) await stop(server.child); rmSync(root, { recursive: true, force: true }); }
});
}

test("B08 real HTTP: update stages, no-change refresh cursor, GET zero-write and a new fact moving the input identity", async () => {
  const root = seed();
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const control = new DatabaseSync(join(root, "var/rai-control.sqlite"));
    try {
      const migration = inspectSessionIdentityMigration(control, key);
      applySessionIdentityMigration(control, key, migration.sourceDigest, migration.existingRevision);
    } finally { control.close(); }
    server = await start(root, true, false, false, true);
    const api = client(server.url);
    const updateHeaders = { "X-RAI-Training-Contract": "2", "X-RAI-Training-Sessions": "1", "X-RAI-Training-Updates": "1" };
    const read = async () => (await api.call("/v1/mobile/training-plan-state", undefined, updateHeaders)).value;
    const handshake = (await api.call("/v1/handshake", undefined, updateHeaders)).value;
    assert.equal(handshake.trainingPlanUpdateContractVersion, 1);
    assert.equal((await api.call("/v1/mobile/training-plan-state", undefined,
      { "X-RAI-Training-Contract": "2" })).value.update, undefined, "update view is never sent unnegotiated");
    assert.equal((await api.call("/v1/mobile/training-plan-state", undefined,
      { "X-RAI-Training-Contract": "2", "X-RAI-Training-Updates": "1" })).value.code, "training_update_contract_unsupported");
    const first = await read();
    assert.equal(first.update.contractVersion, 1);
    assert.equal(first.update.facts.status, "pending");
    assert.equal(first.update.plan.status, "pending");
    assert.equal(first.update.plan.publishedInputKey, null);
    const refresh = async (operationId: string) => {
      const state = await read();
      return api.call("/v1/mobile/training-plan/commands/refresh", { contractVersion: 2, operationId,
        operationScope: scope, expectedStateRevision: state.stateRevision });
    };
    const changed = await refresh("b08-refresh-1");
    assert.equal(changed.status, 200, JSON.stringify(changed.value));
    assert.equal(changed.value.outcome, "changed");
    const afterFirst = await read();
    assert.equal(afterFirst.update.plan.status, "current");
    assert.equal(afterFirst.update.plan.publishedInputKey, afterFirst.update.plan.desiredInputKey);
    assert.ok(afterFirst.sessions.sessions.length > 0);
    const frozen = controlSnapshot(root);
    // Repeated reads (all four stages) are pure: no state, history, operation or cursor writes.
    for (let pass = 0; pass < 3; pass++) assert.deepEqual(await read(), afterFirst);
    assert.deepEqual(controlSnapshot(root), frozen);

    const second = await refresh("b08-refresh-2");
    assert.equal(second.status, 200, JSON.stringify(second.value));
    assert.equal(second.value.outcome, "no_change", "same inputs do not publish a second content revision");
    assert.equal(second.value.stateRevision, afterFirst.stateRevision);
    const afterSecond = await read();
    assert.equal(afterSecond.stateRevision, afterFirst.stateRevision);
    assert.equal(afterSecond.update.plan.evaluatedInputKey, afterSecond.update.plan.desiredInputKey);

    // A corrected/added running fact changes the desired key; the published plan
    // is no longer presented as current until the next publication.
    const today = afterSecond.businessDate;
    const main = new DatabaseSync(join(root, "var/rai.sqlite"));
    try {
      main.prepare(`INSERT INTO workouts (id,activity_type,source_name,source_category,start_at,end_at,duration_seconds,
        metadata_json,raw_attributes_json,is_canonical) VALUES (?,?,?,?,?,?,?,?,?,1)`)
        .run("b08-workout", "HKWorkoutActivityTypeRunning", "Synthetic Watch", "watchOS",
          `${today}T06:00:00+08:00`, `${today}T06:40:00+08:00`, 2400, "{}", "{}");
      main.prepare(`INSERT INTO training_sessions (id,activity_type,anchor_start_at,anchor_end_at,anchor_distance_km,
        canonical_workout_id,status) VALUES (?,?,?,?,?,?,'active')`)
        .run("b08-run", "HKWorkoutActivityTypeRunning", `${today}T06:00:00+08:00`, `${today}T06:40:00+08:00`, 7, "b08-workout");
    } finally { main.close(); }
    const dirty = await read();
    assert.equal(dirty.update.facts.status, "stored");
    assert.notEqual(dirty.update.plan.desiredInputKey, dirty.update.plan.publishedInputKey);
    assert.equal(dirty.update.plan.status, "pending");
    assert.ok(dirty.update.plan.reasonCodes.includes("input_changed"), JSON.stringify(dirty.update.plan));
    const third = await refresh("b08-refresh-3");
    assert.equal(third.status, 200, JSON.stringify(third.value));
    assert.equal(third.value.outcome, "no_change", "a new easy run changed the input but not the generated content");
    assert.equal(third.value.stateRevision, afterSecond.stateRevision, "no content revision was fabricated");
    const afterThird = await read();
    assert.equal(afterThird.update.plan.status, "current");
    assert.equal(afterThird.update.plan.evaluatedInputKey, afterThird.update.plan.desiredInputKey);
    assert.equal(afterThird.update.plan.publishedInputKey, afterSecond.update.plan.publishedInputKey,
      "content still comes from the last publication that actually changed it");
  } finally { if (server) await stop(server.child); rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["validation", "production"] as const) {
test(`B08 real server timer: a newly confirmed execution converges to a current evaluation without a manual refresh (${mode})`, async () => {
  const root = seed(mode === "production");
  let server: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const control = new DatabaseSync(join(root, "var/rai-control.sqlite"));
    try {
      const migration = inspectSessionIdentityMigration(control, key);
      applySessionIdentityMigration(control, key, migration.sourceDigest, migration.existingRevision);
    } finally { control.close(); }
    server = await start(root, true, true, true, true, mode);
    const api = client(server.url);
    const sessionHeaders = { "X-RAI-Client-Training-Session-Commands": "1" };
    const executionHeaders = { "X-RAI-Client-Training-Execution-Commands": "1" };
    const updateHeaders = { "X-RAI-Training-Contract": "2", "X-RAI-Training-Sessions": "1", "X-RAI-Training-Updates": "1" };
    const read = async () => (await api.call("/v1/mobile/training-plan-state", undefined, updateHeaders)).value;
    let state = await read();
    const today = state.businessDate;
    let course = state.sessions.sessions.find((item: any) => item.prescription.localDate === today && item.lifecycle === "pending");
    if (!course) {
      const prescription = { localDate: today, kind: "easy", distanceKm: 2, reason: "B08 auto synthetic",
        structure: { warmup: null, cooldown: null, blocks: [{ iterations: 1,
          steps: [{ purpose: "work", goal: { type: "distance", meters: 2000 }, alert: null }] }] } };
      const draft = { contractVersion: 1, operationScope: scope, expectedStateRevision: state.stateRevision,
        planInstanceId: state.sessions.planInstanceId, draft: { action: "add", prescription } };
      const preview = await api.call("/v1/mobile/training-plan/session-commands/preview", draft, sessionHeaders);
      assert.equal(preview.status, 200, JSON.stringify(preview.value));
      const saved = await api.call("/v1/mobile/training-plan/session-commands", { ...draft,
        operationId: randomUUID(), candidateId: preview.value.candidateId }, sessionHeaders);
      assert.equal(saved.status, 200, JSON.stringify(saved.value));
      course = saved.value.session; state = await read();
    }
    const sessionId = course.sessionId as string;
    const aged = new Date(Date.parse(`${today}T00:00:00+08:00`) - 86400000).toISOString();
    const controlWrite = new DatabaseSync(join(root, "var/rai-control.sqlite"));
    try {
      const raw = controlWrite.prepare("SELECT payload_json FROM mobile_training_state WHERE scope=?").get(key) as { payload_json: string };
      const payload = JSON.parse(raw.payload_json) as any;
      const entry = payload.sessions.find((item: any) => item.sessionId === sessionId);
      entry.availableAt = aged;
      controlWrite.prepare("UPDATE mobile_training_state SET payload_json=? WHERE scope=?").run(JSON.stringify(payload), key);
      const frozen = controlWrite.prepare(`SELECT payload_json FROM mobile_training_session_history
        WHERE scope=? AND session_id=? AND session_revision=?`).get(key, sessionId, entry.sessionRevision) as { payload_json: string };
      const history = JSON.parse(frozen.payload_json) as any; history.availableAt = aged;
      controlWrite.prepare(`UPDATE mobile_training_session_history SET payload_json=?, available_at=?
        WHERE scope=? AND session_id=? AND session_revision=?`).run(JSON.stringify(history), aged, key, sessionId, entry.sessionRevision);
    } finally { controlWrite.close(); }
    // Keep the synthetic run finished even when this test runs before 06:25.
    const runEndMs = Date.now() - 1000;
    const runStartMs = Math.max(Date.parse(`${today}T00:00:00+08:00`), runEndMs - 1500000);
    const runStart = new Date(runStartMs).toISOString(), runEnd = new Date(runEndMs).toISOString();
    const runDurationSeconds = (runEndMs - runStartMs) / 1000;
    const main = new DatabaseSync(join(root, "var/rai.sqlite"));
    try {
      main.prepare(`INSERT INTO workouts (id,activity_type,source_name,source_category,start_at,end_at,duration_seconds,
        metadata_json,raw_attributes_json,is_canonical) VALUES (?,?,?,?,?,?,?,?,?,1)`)
        .run("b08-auto-workout", "HKWorkoutActivityTypeRunning", "Synthetic Watch", "watchOS", runStart, runEnd, runDurationSeconds, "{}", "{}");
      main.prepare(`INSERT INTO training_sessions (id,activity_type,anchor_start_at,anchor_end_at,anchor_distance_km,
        canonical_workout_id,status) VALUES (?,?,?,?,?,?,'active')`)
        .run("b08-auto-run", "HKWorkoutActivityTypeRunning", runStart, runEnd, 2.1, "b08-auto-workout");
    } finally { main.close(); }
    const candidatePath = `/v1/mobile/training-plan/sessions/${sessionId}/execution-candidates?planInstanceId=${encodeURIComponent(state.sessions.planInstanceId)}`;
    const candidates = await api.call(candidatePath, undefined, executionHeaders);
    assert.equal(candidates.status, 200, JSON.stringify(candidates.value));
    const candidate = candidates.value.candidates.find((item: any) => item.trainingSessionId === "b08-auto-run");
    assert.ok(candidate, JSON.stringify(candidates.value));
    const confirm = await api.call("/v1/mobile/training-plan/execution-commands", { contractVersion: 1,
      operationId: randomUUID(), operationScope: scope, expectedStateRevision: state.stateRevision,
      planInstanceId: state.sessions.planInstanceId, sessionId, sessionRevision: state.sessions.sessions.find((item: any) => item.sessionId === sessionId).sessionRevision,
      executionRevision: 0, draft: { action: "confirm", trainingSessionId: "b08-auto-run", sourceFactDigest: candidate.sourceFactDigest } }, executionHeaders);
    assert.equal(confirm.status, 200, JSON.stringify(confirm.value));
    assert.equal(confirm.value.execution.association, "confirmed");
    // The 60-second startup/periodic convergence tick must notice the new
    // execution digest and evaluate it without any client refresh.
    await new Promise(resolve => setTimeout(resolve, 72_000));
    const converged = await read();
    assert.ok(converged.update, "the update view is negotiated");
    assert.equal(converged.update.plan.status, "current", JSON.stringify(converged.update.plan));
    assert.equal(converged.update.plan.evaluatedInputKey, converged.update.plan.desiredInputKey);
    assert.equal(converged.sessions.executions.find((item: any) => item.sessionId === sessionId).association, "confirmed");
  } finally { if (server) await stop(server.child); rmSync(root, { recursive: true, force: true }); }
});
}


test("production training writes require authentication and explicit database targets before opening any database", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-production-mode-refusal-"));
  const modeKeys = ["RAI_TRAINING_PLAN_COMMAND_MODE", "RAI_TRAINING_PLAN_SESSION_COMMAND_MODE",
    "RAI_TRAINING_PLAN_EXECUTION_COMMAND_MODE", "RAI_TRAINING_PLAN_AUTO_PUBLISH_MODE"];
  const baseEnv = { ...process.env, RAI_RUNTIME_ROOT: root, RAI_DATABASE: join(root, "facts.sqlite"),
    RAI_CONTROL_DATABASE: join(root, "control.sqlite"), RAI_API_PORT: "0", RAI_API_HOST: "127.0.0.1",
    ...Object.fromEntries(modeKeys.map(name => [name, "disabled"])) };
  try {
    for (const name of modeKeys) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
        env: { ...baseEnv, RAI_API_TOKEN: " ", [name]: "production" }, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL"
      });
      assert.ok(result.status !== null && result.status !== 0, result.stdout + result.stderr);
      assert.match(result.stderr, /production writes require RAI_API_TOKEN/);
      assert.deepEqual(readdirSync(root), [], "refusal must precede database/sidecar creation");
    }
    const result = spawnSync(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      env: { ...baseEnv, RAI_API_TOKEN: token, RAI_CONTROL_DATABASE: "", RAI_TRAINING_PLAN_SESSION_COMMAND_MODE: "production" },
      encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL"
    });
    assert.ok(result.status !== null && result.status !== 0, result.stdout + result.stderr);
    assert.match(result.stderr, /production writes require explicit RAI_RUNTIME_ROOT/);
    assert.deepEqual(readdirSync(root), []);
    const mixed = spawnSync(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      env: { ...baseEnv, RAI_API_TOKEN: token, RAI_TRAINING_PLAN_SESSION_COMMAND_MODE: "production",
        RAI_TRAINING_PLAN_COMMAND_MODE: "validation", RAI_API_HOST: "0.0.0.0" },
      encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL"
    });
    assert.ok(mixed.status !== null && mixed.status !== 0, mixed.stdout + mixed.stderr);
    assert.match(mixed.stderr, /validation requires an isolated temporary runtime/,
      "production must not disable the validation-mode isolation guard");
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
