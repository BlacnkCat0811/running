// 阶段 6 S13 负载器回归：真实 HTTP 假 API，不依赖业务库。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REPO_ROOT } from "../../../scripts/phase6/safety.mjs";

const TOKEN = "phase6-test-token-0123456789";

/**
 * 只能在 POSIX 上执行的判据在 Windows 上必须**显式跳过**并说清什么没有被检查
 * （仓库规则见 `scripts/run-ios.mjs` 头注释与 `apps/ios/tests/run-ios-gates.sh`）。
 *
 * 本文件是 `.mjs`，不能 import `apps/api/test/posix-only.ts`，所以内联同样三行语义；
 * 判据的理由写在 `SIGTERM` 用例那一处（不要为了 DRY 另建加载路径）。
 */
const POSIX_ONLY = process.platform === "win32"
  ? "Windows 没有 POSIX 信号：child.kill(\"SIGTERM\") 由 libuv 映射成 TerminateProcess，"
    + "驱动器进程拿不到 SIGTERM、没有机会把已投放请求收口，incomplete 结果文件与守恒账本都写不出来，"
    + "实测 exit 为 null 而不是 3（CI 2026-10-25）。因此『已投放请求有终态、输出标记 incomplete』"
    + "这条判据在 Windows 上没有被检查；Windows 上的停止语义（TerminateProcess + 无收尾）另立工单。"
  : false;

async function fakeApi(delayMs = 0, { persistWrites = true, invalidReads = false } = {}) {
  const entries = [];
  const server = createServer((request, response) => {
    let requestBody = "";
    request.on("data", (chunk) => { requestBody += String(chunk); });
    request.on("end", () => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      if (request.method === "POST" && path === "/v1/performance-entries") {
        const body = JSON.parse(requestBody);
        const entry = { id: `entry-${body.localDate}`, localDate: body.localDate };
        if (persistWrites) entries.push(entry);
        response.end(JSON.stringify(entry));
        return;
      }
      if (request.method === "GET" && path === "/v1/performance-entries") {
        response.end(JSON.stringify({ entries: persistWrites ? [...entries] : [] }));
        return;
      }
      if (path === "/v1/health") {
        response.end(JSON.stringify({ status: "ok", databaseReady: true, serverId: "phase6" }));
        return;
      }
      if (invalidReads) {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (path === "/v1/workouts") {
        response.end(JSON.stringify({
          items: [{ id: "sess-000000", startedAt: "2026-01-01T00:00:00.000Z" }], total: 1
        }));
        return;
      }
      if (path === "/v1/dashboard") {
        response.end(JSON.stringify({ latestWorkout: { id: "sess-000000" } }));
        return;
      }
      if (path === "/v1/mobile/today") {
        response.end(JSON.stringify({ today: { date: "2026-01-01" }, timezone: "Asia/Shanghai" }));
        return;
      }
      if (path === "/v1/mobile/training-plan-state") {
        response.end(JSON.stringify({ metadata: { contractVersion: 1, serverId: "phase6" } }));
        return;
      }
      if (path === "/v1/data-summary") {
        response.end(JSON.stringify({ counts: { healthRecords: 1, workouts: 1 } }));
        return;
      }
      if (/^\/v1\/workouts\/[^/]+\/series$/.test(path)) {
        response.end(JSON.stringify({
          trainingSessionId: "sess-000000",
          series: { heartRate: { totalSamples: 10 } },
          splits: []
        }));
        return;
      }
      response.end(JSON.stringify({ status: "ok" }));
    }, delayMs);
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { server, port: server.address().port };
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "phase6-driver-"));
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ ids: { series: { small: "sess-000000" } }, rows: {} }));
  return { dir, manifest, out: join(dir, "out") };
}

function driverArgs(port, out, manifest, options) {
  return [
    "scripts/phase6/driver.mjs",
    "--base-url", `http://127.0.0.1:${port}`,
    "--token", TOKEN,
    "--scenario", options.scenario ?? "S13",
    "--dataset", "D1",
    "--profile", options.profile ?? "dev",
    "--run-id", "test-run",
    "--out", out,
    "--rate", String(options.rate ?? 1),
    "--duration-ms", String(options.durationMs ?? 1000),
    "--warmup-ms", String(options.warmupMs ?? 0),
    "--max-in-flight", String(options.maxInFlight ?? 64),
    "--timeout-ms", String(options.timeoutMs ?? 5000),
    ...(options.clientTrainingCommands === true ? ["--client-training-commands", "2"] : []),
    "--manifest", manifest
  ];
}

function runDriver(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("exit", (code) => resolveRun({ status: code, stderr }));
  });
}

function readShape(out) {
  const events = readFileSync(join(out, "raw", "task-events.jsonl"), "utf8")
    .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  return events.find((event) => event.type === "s13_load_shape");
}

function readSamples(out) {
  return readFileSync(join(out, "raw", "requests.jsonl"), "utf8")
    .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

test("2 rps × 3 s：主/health 独立调度，计数守恒且无累计 Promise 丢弃", async (t) => {
  const api = await fakeApi(0);
  const dir = workspace();
  t.after(() => { api.server.close(); rmSync(dir.dir, { recursive: true, force: true }); });
  const result = await runDriver(driverArgs(api.port, dir.out, dir.manifest, {
    rate: 2, durationMs: 3000, maxInFlight: 64
  }));
  assert.equal(result.status, 0, result.stderr);
  const shape = readShape(dir.out);
  assert.equal(shape.mainOffered, 6);
  assert.equal(shape.healthOffered, 3);
  assert.equal(shape.mainDropped, 0);
  assert.ok(shape.peakInFlight < 64);
  assert.equal(shape.conservation.main, true);
  assert.equal(shape.conservation.health, true);
  assert.equal(shape.conservation.mainSent, true);
  assert.equal(shape.mainStillInFlight, 0);
  assert.ok(shape.writeSent > 0);
  assert.equal(shape.writeSuccessful, shape.writeSent);
  assert.equal(shape.writeReadbackSent, shape.writeSuccessful);
  assert.equal(shape.writeReadbackSuccessful, shape.writeSuccessful);
  const samples = readSamples(dir.out);
  assert.equal(samples.filter((sample) => sample.traffic === "write-readback").length, shape.writeSuccessful);
});

test("S13 读请求拒绝 `{\"status\":\"ok\"}` 这类无效业务响应", async (t) => {
  const api = await fakeApi(0, { invalidReads: true });
  const dir = workspace();
  t.after(() => { api.server.close(); rmSync(dir.dir, { recursive: true, force: true }); });
  const result = await runDriver(driverArgs(api.port, dir.out, dir.manifest, {
    rate: 10, durationMs: 2000, maxInFlight: 64
  }));
  assert.equal(result.status, 1, result.stderr);
  const correctness = JSON.parse(readFileSync(join(dir.out, "correctness", "S13.json"), "utf8"));
  const failedChecks = correctness.oracleFailures.flatMap((failure) => failure.checks ?? []);
  assert.ok(failedChecks.some((check) => !check.ok && [
    "workouts items array", "dashboard latestWorkout", "today object",
    "plan contractVersion", "summary healthRecords number", "series trainingSessionId"
  ].includes(check.name)));
  assert.ok(correctness.outcomes.oracle_failed > 0);
});

test("S13 写请求必须能从持久化结果读回；只回显 ID 不够", async (t) => {
  const api = await fakeApi(0, { persistWrites: false });
  const dir = workspace();
  t.after(() => { api.server.close(); rmSync(dir.dir, { recursive: true, force: true }); });
  const result = await runDriver(driverArgs(api.port, dir.out, dir.manifest, {
    rate: 2, durationMs: 1000, maxInFlight: 64
  }));
  assert.equal(result.status, 1, result.stderr);
  const samples = readSamples(dir.out);
  const readbacks = samples.filter((sample) => sample.traffic === "write-readback");
  assert.ok(readbacks.length > 0);
  assert.ok(readbacks.every((sample) => sample.outcome === "oracle_failed"));
  assert.ok(readbacks[0].oracle.checks.some((check) => check.name === "readback entry id" && !check.ok));
});

test("cloud-validation S12 设置能力头并实际执行候选写（preview + submit）", async (t) => {
  const seen = [];
  let raceGoalDate = null;
  const server = createServer((request, response) => {
    let requestBody = "";
    request.on("data", (chunk) => { requestBody += String(chunk); });
    request.on("end", () => {
      const parsed = requestBody === "" ? null : JSON.parse(requestBody);
      seen.push({ method: request.method, url: request.url, headers: request.headers, body: parsed });
      const send = (value) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url === "/v1/handshake") {
        return send({ apiVersion: "v1", trainingPlanCommandContractVersion: 2 });
      }
      if (request.url === "/v1/mobile/workout-plan") return send({ workoutPlan: {} });
      if (request.url === "/v1/mobile/today") return send({ today: {} });
      if (request.url === "/v1/mobile/training-plan-state") {
        if (request.headers["x-rai-training-contract"] === "2") {
          return send({
            contractVersion: 2,
            scope: { serverId: "phase6", athleteId: "athlete_1", datasetEpoch: "phase6" },
            stateRevision: raceGoalDate === null ? 1 : 2,
            raceGoal: raceGoalDate === null ? null : { date: raceGoalDate }
          });
        }
        return send({ metadata: { contractVersion: 1 } });
      }
      if (request.url === "/v1/mobile/training-plan/commands/preview") {
        return send({ contractVersion: 2, candidateId: "candidate-1", expectedStateRevision: 1, planRefreshRequired: true });
      }
      if (request.url === "/v1/mobile/training-plan/commands") {
        raceGoalDate = parsed.raceGoal.date;
        return send({
          contractVersion: 2, operationId: parsed.operationId, stateRevision: 2, goalsRevision: 1,
          after: { raceGoal: { date: raceGoalDate } }
        });
      }
      return send({ status: "ok" });
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const dir = workspace();
  t.after(() => { server.close(); rmSync(dir.dir, { recursive: true, force: true }); });
  const result = await runDriver(driverArgs(server.address().port, dir.out, dir.manifest, {
    scenario: "S12", profile: "cloud-validation", clientTrainingCommands: true
  }));
  assert.equal(result.status, 0, result.stderr);
  const commandWrites = seen.filter((entry) =>
    entry.method === "POST" && entry.url === "/v1/mobile/training-plan/commands");
  assert.equal(commandWrites.length, 1);
  assert.equal(commandWrites[0].headers["x-rai-client-training-commands"], "2");
  assert.equal(commandWrites[0].body.contractVersion, 2);
  assert.equal(commandWrites[0].body.action, "set_race_goal");
  assert.ok(seen.some((entry) =>
    entry.method === "POST" && entry.url === "/v1/mobile/training-plan/commands/preview"
    && entry.headers["x-rai-client-training-commands"] === "2"));
});

test("5 rps × 2 s：完成数可以超过 64，不能因累计 Promise 数触发丢弃", async (t) => {
  const api = await fakeApi(0);
  const dir = workspace();
  t.after(() => { api.server.close(); rmSync(dir.dir, { recursive: true, force: true }); });
  const result = await runDriver(driverArgs(api.port, dir.out, dir.manifest, {
    rate: 5, durationMs: 2000, maxInFlight: 64
  }));
  assert.equal(result.status, 0, result.stderr);
  const shape = readShape(dir.out);
  assert.equal(shape.mainOffered, 10);
  assert.equal(shape.mainSent, 10);
  assert.equal(shape.mainDropped, 0);
  assert.equal(shape.mainCompleted, 10);
});

test("0.5 rps × 4 s：health 不随主请求频率下降", async (t) => {
  const api = await fakeApi(0);
  const dir = workspace();
  t.after(() => { api.server.close(); rmSync(dir.dir, { recursive: true, force: true }); });
  const result = await runDriver(driverArgs(api.port, dir.out, dir.manifest, {
    rate: 0.5, durationMs: 4000, maxInFlight: 64
  }));
  assert.equal(result.status, 0, result.stderr);
  const shape = readShape(dir.out);
  assert.equal(shape.mainOffered, 2);
  assert.equal(shape.healthOffered, 4);
  assert.equal(shape.healthCompleted, 4);
});

test("慢 API 超过 64 在途：只在真实在途达到上限后丢弃，无无界 Promise", async (t) => {
  const api = await fakeApi(1200);
  const dir = workspace();
  t.after(() => { api.server.close(); rmSync(dir.dir, { recursive: true, force: true }); });
  const result = await runDriver(driverArgs(api.port, dir.out, dir.manifest, {
    rate: 20, durationMs: 800, maxInFlight: 2, timeoutMs: 5000
  }));
  // 丢弃是失败证据：有 runner_dropped 原始样本、driver 非 0，不能再伪装成功。
  assert.equal(result.status, 1, result.stderr);
  const shape = readShape(dir.out);
  assert.ok(shape.mainDroppedCapacity >= 1);
  assert.ok(shape.peakInFlight <= 2);
  assert.ok(shape.mainCompleted >= 1);
  assert.equal(shape.conservation.main, true);
  assert.equal(shape.mainStillInFlight, 0);
  const samples = readSamples(dir.out);
  const main = samples.filter((sample) => (sample.traffic ?? "main") === "main");
  const dropped = main.filter((sample) => sample.outcome === "runner_dropped");
  assert.equal(shape.mainOffered, main.length);
  assert.equal(shape.mainDropped, dropped.length);
  assert.ok(dropped.length >= 1);
  assert.ok(dropped.every((sample) => sample.sentAt === null && sample.status === null
    && sample.dropReason === "capacity"));
  const correctness = JSON.parse(readFileSync(join(dir.out, "correctness", "S13.json"), "utf8"));
  assert.ok(correctness.outcomes.runner_dropped >= 1);
});

test("SIGTERM：已投放请求有终态，输出 incomplete，不伪装稳态通过", { skip: POSIX_ONLY }, async (t) => {
  const api = await fakeApi(100);
  const dir = workspace();
  t.after(() => { api.server.close(); rmSync(dir.dir, { recursive: true, force: true }); });
  const child = spawn(process.execPath, driverArgs(api.port, dir.out, dir.manifest, {
    rate: 5, durationMs: 5000, maxInFlight: 64
  }), { cwd: REPO_ROOT, stdio: "ignore" });
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  child.kill("SIGTERM");
  const exitCode = await new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  assert.equal(exitCode, 3);
  const shape = readShape(dir.out);
  assert.equal(shape.incomplete, true);
  assert.equal(shape.conservation.main, true);
  assert.equal(shape.mainStillInFlight, 0);
  const correctness = JSON.parse(readFileSync(join(dir.out, "correctness", "S13.json"), "utf8"));
  assert.equal(correctness.incomplete, true);
});
