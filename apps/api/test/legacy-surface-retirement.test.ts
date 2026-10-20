import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { MobileGoalsStore } from "../src/mobile-goals.js";

/**
 * Product decision 2026-10-20: four legacy `/v1` plan surfaces are retired.
 *
 * The routes STAY MOUNTED — route-table classification and OpenAPI audits
 * enumerate them — but every request answers
 * `410 { code: "legacy_surface_retired", message, replacement }`. This test is
 * the executable contract for that decision:
 *
 *  1. every retired method/URL combination is 410 with the right replacement;
 *  2. the answer does not depend on dataset state: on a *managed* dataset the
 *     old generic 409 must not preempt the retirement;
 *  3. the replacement surfaces are real (registered, not 404);
 *  4. a retired write never publishes a goals revision.
 */

const projectRoot = resolve(import.meta.dirname, "../../..");

async function waitForApi(child: ChildProcess, url: string, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited early (${child.exitCode}): ${output().slice(-2000)}`);
    try {
      const response = await fetch(`${url}/v1/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`API did not become ready: ${output().slice(-2000)}`);
}

/** The server reports its bound port over IPC (`rai:ready`), so no log parsing. */
async function waitForBoundPort(child: ChildProcess, output: () => string): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(output() || "API did not report its bound port")), 60_000);
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      reject(new Error(output() || `API exited with ${code}`));
    };
    child.once("exit", onExit);
    child.on("message", (message: unknown) => {
      const typed = message as { type?: unknown; port?: unknown };
      if (typed?.type === "rai:ready" && Number.isInteger(typed.port)) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolvePort(typed.port as number);
      }
    });
  });
}

async function stopApi(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>(resolveStop => { child.once("close", () => resolveStop()); });
  try {
    if (child.connected) child.send("rai:shutdown", () => {});
    else child.kill("SIGTERM");
  } catch { child.kill("SIGTERM"); }
  const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await closed;
  clearTimeout(killer);
}

async function removeRuntimeRoot(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => rmSync(path, { recursive: true, force: true }));
}

interface RetiredRoute {
  method: "GET" | "POST" | "PUT";
  path: string;
  replacement: string;
  body?: object;
}

const RETIRED: readonly RetiredRoute[] = [
  { method: "GET", path: "/v1/mobile/goals", replacement: "/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands" },
  { method: "PUT", path: "/v1/mobile/goals", replacement: "/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands", body: { qualitySessionCap: 1 } },
  { method: "GET", path: "/v1/mobile/run-coach", replacement: "/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands" },
  { method: "POST", path: "/v1/mobile/run-coach", replacement: "/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands", body: { expectedRevision: 0, action: "start" } },
  { method: "POST", path: "/v1/mobile/workout-plan/preview", replacement: "/v1/mobile/training-plan/commands/preview", body: { expectedRevision: 0 } },
  { method: "POST", path: "/v1/mobile/workout-plan/confirm", replacement: "/v1/mobile/training-plan/commands", body: { candidateId: "candidate", expectedRevision: 0 } },
  { method: "POST", path: "/v1/mobile/workout-plan/generate", replacement: "/v1/mobile/training-plan/commands/refresh", body: { expectedRevision: 0 } }
];

async function launchServer(runtimeRoot: string, databasePath: string, controlPath: string): Promise<{ child: ChildProcess; url: string; output: () => string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: { ...process.env, RAI_RUNTIME_ROOT: runtimeRoot, RAI_DATABASE: databasePath,
      RAI_CONTROL_DATABASE: controlPath, RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: "",
      RAI_SERVER_ID: "local", RAI_ATHLETE_ID: "athlete_1", RAI_DATASET_EPOCH: "default" },
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const url = `http://127.0.0.1:${await waitForBoundPort(child, () => output)}`;
  await waitForApi(child, url, () => output);
  return { child, url, output: () => output };
}

const readTrainingPlanState = async (url: string) =>
  await fetch(url + "/v1/mobile/training-plan-state").then(response => response.json()) as {
    metadata: { goalsRevision: number };
  };

test("every retired legacy plan route answers 410 legacy_surface_retired with a real replacement", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-retirement-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  const controlPath = join(runtimeRoot, "var", "rai-control.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  (await RaiDatabase.open(databasePath)).close();
  const server = await launchServer(runtimeRoot, databasePath, controlPath);
  try {
    const initial = await readTrainingPlanState(server.url);
    for (const route of RETIRED) {
      const response = await fetch(server.url + route.path, {
        method: route.method,
        ...(route.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(route.body) })
      });
      const text = await response.clone().text();
      assert.equal(response.status, 410, `${route.method} ${route.path}: ${text}`);
      assert.equal(response.headers.get("cache-control"), "no-store", `${route.method} ${route.path} must stay uncacheable`);
      const payload = await response.json() as { code: string; message: string; replacement: string };
      assert.equal(payload.code, "legacy_surface_retired", `${route.method} ${route.path}`);
      assert.equal(payload.replacement, route.replacement, `${route.method} ${route.path}`);
      assert.ok(payload.message.includes(route.replacement), `${route.method} ${route.path} message must name the replacement`);
      assert.ok(payload.message.length > 0);
    }
    assert.equal((await readTrainingPlanState(server.url)).metadata.goalsRevision, initial.metadata.goalsRevision,
      "a retired write must never publish a goals revision");

    // The replacements are registered, not aspirational. Fresh scope is not
    // migrated, so the honest answer is the typed 409 — anything but 404 proves
    // the route exists and the stale client has somewhere to go.
    const replacements: ReadonlyArray<[string, object]> = [
      ["/v1/mobile/training-plan/commands/preview", { contractVersion: 2, operationId: randomUUID(),
        operationScope: { serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" }, action: "pause" }],
      ["/v1/mobile/training-plan/commands", { contractVersion: 2, operationId: randomUUID(),
        operationScope: { serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" }, action: "pause",
        expectedStateRevision: 0 }],
      ["/v1/mobile/training-plan/commands/refresh", { contractVersion: 2, operationId: randomUUID(),
        operationScope: { serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" }, expectedStateRevision: 0 }]
    ];
    for (const [path, body] of replacements) {
      const response = await fetch(server.url + path, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.notEqual(response.status, 404, `${path} is a replacement surface and must be registered`);
      const payload = await response.json() as { code?: string };
      assert.equal(payload.code, "training_plan_not_migrated", `${path}: ${JSON.stringify(payload)}`);
    }
    assert.equal((await readTrainingPlanState(server.url)).metadata.goalsRevision, initial.metadata.goalsRevision,
      "replacement 409s must not migrate or publish anything");
  } finally {
    await stopApi(server.child).catch(() => server.child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("a managed dataset does not turn retirement into the generic 409 contract error", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "rai-retirement-managed-"));
  const databasePath = join(runtimeRoot, "var", "rai.sqlite");
  const controlPath = join(runtimeRoot, "var", "rai-control.sqlite");
  mkdirSync(join(runtimeRoot, "var"), { recursive: true });
  (await RaiDatabase.open(databasePath)).close();
  // A receipt row makes coachLoopManaged() true. The old gate answered 409 for
  // /goals and /run-coach; the retirement decision replaced those surfaces, so the
  // 410 must win (the old 409 named a contract path that no longer exists).
  const seed = new MobileGoalsStore(runtimeRoot, controlPath);
  seed.close();
  // The receipt writer is intentionally only reachable inside the publication
  // transaction; this fixture seeds the append-only row directly, which is
  // exactly the state a committed enable command would leave behind.
  const control = new DatabaseSync(controlPath);
  try {
    control.prepare("INSERT INTO mobile_coach_loop_receipts(scope, operation_id, payload_json) VALUES (?,?,?)")
      .run(JSON.stringify(["local", "athlete_1", "default"]), randomUUID(),
        JSON.stringify({ settings: { status: "active" } }));
  } finally { control.close(); }
  const server = await launchServer(runtimeRoot, databasePath, controlPath);
  try {
    for (const route of RETIRED) {
      const response = await fetch(server.url + route.path, {
        method: route.method,
        ...(route.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(route.body) })
      });
      assert.equal(response.status, 410, `${route.method} ${route.path}: ${await response.clone().text()}`);
      assert.equal((await response.json() as { code: string }).code, "legacy_surface_retired");
    }
  } finally {
    await stopApi(server.child).catch(() => server.child.kill("SIGKILL"));
    await removeRuntimeRoot(runtimeRoot);
  }
});
