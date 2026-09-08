import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test, { after, before, type TestContext } from "node:test";

import { chromium, type Browser, type Page, type Request } from "playwright-core";
import { ImportSourceManager } from "../../api/src/import-sources.js";

import { JobEventNotifier } from "../src/events.js";

type E2eTestFn = (context: TestContext) => void | Promise<void>;
const desktopTest = (name: string, fn: E2eTestFn) => test(name, {
  skip: process.env.npm_lifecycle_event === "test:e2e:responsive",
}, fn);
const responsiveTest = (name: string, fn: E2eTestFn) => test(name, {
  skip: process.env.npm_lifecycle_event === "test:e2e:web",
}, fn);

const projectRoot = resolve(import.meta.dirname, "../../..");
const realDatabase = resolve(projectRoot, "var/rai.sqlite");
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

interface RunningApi {
  child: ChildProcess;
  origin: string;
  output: () => string;
}

let browser: Browser;
let realApi: RunningApi | null = null;
let fixtureApi: RunningApi;
let firstRunApi: RunningApi;
let temporaryRoot: string;
let syntheticExport: string;

async function startApi(
  databasePath: string,
  runtimeRoot = projectRoot,
): Promise<RunningApi> {
  let output = "";
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/src/server.ts"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        RAI_API_PORT: "0",
        RAI_DATABASE: databasePath,
        RAI_RUNTIME_ROOT: runtimeRoot,
        RAI_LOG_LEVEL: "fatal",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-8000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const port = await new Promise<number>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(output || "API did not report its bound port")), 20_000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(output || `API exited with ${code}`));
    };
    child.once("exit", onExit);
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" && message !== null &&
        (message as { type?: unknown }).type === "rai:ready" &&
        Number.isInteger((message as { port?: unknown }).port)
      ) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolvePort((message as { port: number }).port);
      }
    });
  }).catch(async (error) => {
    await stopApi({ child, origin: "", output: () => output }).catch(() => child.kill("SIGKILL"));
    throw error;
  });
  const origin = `http://127.0.0.1:${port}`;
  const failStart = async (message: string): Promise<never> => {
    const startupError = new Error(message);
    try {
      await stopApi({ child, origin, output: () => output });
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "API startup failed and cleanup did not complete",
      );
    }
    throw startupError;
  };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return failStart(`API 提前退出：${output}`);
    }
    try {
      const response = await fetch(`${origin}/v1/health`);
      if (response.ok) return { child, origin, output: () => output };
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return failStart(`API 启动超时：${output}`);
}

function appleDate(day: number, time: string): string {
  return `2026-01-${String(day).padStart(2, "0")} ${time}:00 +0800`;
}

async function createSyntheticExport(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const days = [1, 4, 7, 10, 13, 16, 19];
  const workouts = days
    .map(
      (day, index) => `
  <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="E2E Apple Watch" sourceVersion="1" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" device="Watch">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" sum="${(5 + index * 0.08).toFixed(2)}" unit="km"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" average="${145 + index}" minimum="120" maximum="172" unit="count/min"/>
  </Workout>`,
    )
    .join("");
  const heartRateRecords = days.flatMap((day, index) =>
    Array.from({ length: 15 }, (_, sample) => {
      const minute = String(sample * 2).padStart(2, "0");
      const endMinute = String(sample * 2 + 1).padStart(2, "0");
      return `
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="E2E Apple Watch" sourceVersion="1" unit="count/min" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, `08:${minute}`)}" endDate="${appleDate(day, `08:${endMinute}`)}" value="${140 + index + (sample % 3)}"/>`;
    }),
  ).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <ExportDate value="${appleDate(25, "12:00")}"/>
  <Me biologicalSex="HKBiologicalSexMale"/>${workouts}${heartRateRecords}
</HealthData>`;
  await writeFile(resolve(path, "export.xml"), xml, "utf8");
}

async function backupDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }
}

async function importSyntheticFixture(api: RunningApi, sourceId: string): Promise<void> {
  const response = await fetch(`${api.origin}/v1/import-jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rai-local-request": "1",
    },
    body: JSON.stringify({ sourceId }),
  });
  assert.equal(response.status, 200, await response.text());
  await waitForImport(api.origin);
}

async function forceStopApiProcess(child: ChildProcess): Promise<void> {
  if (process.platform !== "win32") {
    if (!child.kill("SIGKILL") && child.exitCode === null) {
      throw new Error("Failed to send SIGKILL to API process");
    }
    return;
  }
  if (child.pid === undefined) throw new Error("API process has no PID for taskkill");
  const killer = spawn(
    "taskkill",
    ["/PID", String(child.pid), "/T", "/F"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-4000);
  };
  killer.stdout?.on("data", append);
  killer.stderr?.on("data", append);
  const completed = new Promise<void>((resolveKill, rejectKill) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) rejectKill(error);
      else resolveKill();
    };
    killer.once("error", (error) => finish(error));
    killer.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`taskkill exited with code ${String(code)}${output ? `: ${output.trim()}` : ""}`));
    });
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("taskkill timed out")),
          10_000,
        );
      }),
    ]);
  } catch (error) {
    if (killer.exitCode === null) killer.kill("SIGKILL");
    await completed.catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function stopApi(api: RunningApi | null): Promise<void> {
  if (!api) return;
  const child = api.child;
  if (child.exitCode !== null && child.stdout?.closed && child.stderr?.closed && !child.connected) return;
  const closed = new Promise<void>((resolveStop) => {
    child.once("close", () => resolveStop());
  });
  const waitForClose = (timeoutMs: number): Promise<void> => {
    return new Promise<void>((resolveStop, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("API shutdown timed out")),
        timeoutMs,
      );
      closed.then(() => {
        clearTimeout(timeout);
        resolveStop();
      });
    });
  };
  if (child.connected) child.send("rai:shutdown");
  else child.kill("SIGTERM");
  try {
    await waitForClose(10_000);
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await forceStopApiProcess(child);
    } catch (forceError) {
      failures.push(forceError);
    }
    try {
      await waitForClose(10_000);
    } catch (closeError) {
      failures.push(closeError);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "API graceful shutdown timed out and forced cleanup did not complete cleanly",
      );
    }
    throw error;
  }
}

interface RuntimeErrorRecord {
  source: "pageerror" | "console";
  message: string;
  url?: string;
}

function collectRuntimeErrors(page: Page): RuntimeErrorRecord[] {
  const errors: RuntimeErrorRecord[] = [];
  page.on("pageerror", (error) => errors.push({ source: "pageerror", message: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push({
        source: "console",
        message: message.text(),
        url: message.location().url,
      });
    }
  });
  return errors;
}

function collectPendingRequests(page: Page): () => string[] {
  const pending = new Map<Request, { method: string; url: string; startedAt: number }>();
  page.on("request", (request) => {
    pending.set(request, {
      method: request.method(),
      url: request.url(),
      startedAt: Date.now(),
    });
  });
  const remove = (request: Request): void => {
    pending.delete(request);
  };
  page.on("requestfinished", remove);
  page.on("requestfailed", remove);
  return () => [...pending.values()].map(
    ({ method, url, startedAt }) => `${method} ${url} (${Date.now() - startedAt}ms)`,
  );
}

async function navigateToSettingsWithDiagnostics(
  page: Page,
  runtimeErrors: RuntimeErrorRecord[],
  pendingRequests: () => string[],
): Promise<void> {
  const urlReady = page.waitForURL((url) => url.pathname === "/settings");
  const headingReady = page.getByRole("heading", { name: "设置" }).waitFor();
  try {
    await page.getByRole("link", { name: "设置", exact: true }).click();
    await Promise.all([urlReady, headingReady]);
  } catch (error) {
    throw new Error(
      `设置导航未完成：url=${page.url()} pending=${JSON.stringify(pendingRequests())} runtimeErrors=${JSON.stringify(runtimeErrors)}`,
      { cause: error },
    );
  }
}

function consumeExpectedHttpFailures(
  errors: RuntimeErrorRecord[],
  status: number,
  expectedUrl: string | RegExp,
  expectedCount = 1,
): void {
  const expected = new RegExp(
    `^Failed to load resource: the server responded with a status of ${status}(?: \\([^)]*\\))?$`,
  );
  const matchingIndexes: number[] = [];
  for (let index = 0; index < errors.length; index += 1) {
    const error = errors[index];
    if (error?.source !== "console" || !expected.test(error.message) || !error.url) continue;
    const urlMatches = typeof expectedUrl === "string"
      ? error.url.endsWith(expectedUrl)
      : (expectedUrl.lastIndex = 0, expectedUrl.test(error.url));
    if (urlMatches) matchingIndexes.push(index);
  }
  assert.equal(
    matchingIndexes.length,
    expectedCount,
    `预期 ${expectedCount} 个 ${status} ${String(expectedUrl)} 失败，实际 ${matchingIndexes.length} 个`,
  );
  for (let index = matchingIndexes.length - 1; index >= 0; index -= 1) {
    errors.splice(matchingIndexes[index]!, 1);
  }
}

desktopTest("预期 HTTP 失败过滤不会吞掉其他运行时错误", () => {
  const errors: RuntimeErrorRecord[] = [
    { source: "console", message: "Failed to load resource: the server responded with a status of 503 (Service Unavailable)", url: "http://127.0.0.1:4173/v1/expected" },
    { source: "console", message: "Failed to load resource: the server responded with a status of 503 (Service Unavailable)", url: "http://127.0.0.1:4173/v1/unrelated" },
    { source: "console", message: "unexpected console failure" },
    { source: "pageerror", message: "unexpected page failure" },
  ];
  consumeExpectedHttpFailures(errors, 503, "/v1/expected");
  assert.deepEqual(errors, [
    { source: "console", message: "Failed to load resource: the server responded with a status of 503 (Service Unavailable)", url: "http://127.0.0.1:4173/v1/unrelated" },
    { source: "console", message: "unexpected console failure" },
    { source: "pageerror", message: "unexpected page failure" },
  ]);

  const duplicates: RuntimeErrorRecord[] = [
    { source: "console", message: "Failed to load resource: the server responded with a status of 503 (Service Unavailable)", url: "http://127.0.0.1:4173/v1/expected" },
    { source: "console", message: "Failed to load resource: the server responded with a status of 503 (Service Unavailable)", url: "http://127.0.0.1:4173/v1/expected" },
  ];
  assert.throws(
    () => consumeExpectedHttpFailures(duplicates, 503, "/v1/expected"),
    /预期 1 个 503 \/v1\/expected 失败，实际 2 个/,
  );
  assert.equal(duplicates.length, 2);
});

desktopTest("后台任务事件按 job 和事件类型独立去重", () => {
  const target = new EventTarget();
  const notifier = new JobEventNotifier(target);
  let dataUpdates = 0;
  let databaseStateChanges = 0;
  target.addEventListener("rai:data-updated", () => { dataUpdates += 1; });
  target.addEventListener("rai:database-state-changed", () => { databaseStateChanges += 1; });

  assert.equal(notifier.notifyDataUpdated("import-1"), true);
  assert.equal(notifier.notifyDataUpdated("import-1"), false);
  assert.equal(notifier.notifyDatabaseStateChanged("import-1"), true);
  assert.equal(notifier.notifyDatabaseStateChanged("import-1"), false);
  assert.equal(notifier.notifyDataUpdated("import-2"), true);
  assert.deepEqual({ dataUpdates, databaseStateChanges }, {
    dataUpdates: 2,
    databaseStateChanges: 1,
  });
});

async function assertNoHorizontalOverflow(
  page: Page,
  path: string,
): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.locator("main").waitFor();
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    metrics.document <= metrics.viewport,
    `${path} document 溢出：${JSON.stringify(metrics)}`,
  );
  assert.ok(
    metrics.body <= metrics.viewport,
    `${path} body 溢出：${JSON.stringify(metrics)}`,
  );
}

async function waitForImport(
  origin: string,
  previousJobId: string | null = null,
): Promise<string> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/v1/runtime-status`);
    if (response.ok) {
      const runtime = (await response.json()) as {
        importJob: {
          id: string;
          status: string;
          error: string | null;
          message: string;
        } | null;
      };
      if (
        runtime.importJob?.id &&
        runtime.importJob.id !== previousJobId &&
        runtime.importJob.status === "succeeded"
      )
        return runtime.importJob.id;
      if (
        runtime.importJob?.id !== previousJobId &&
        ["failed", "cancelled"].includes(runtime.importJob?.status ?? "")
      ) {
        throw new Error(
          `合成数据导入失败：${runtime.importJob?.error ?? runtime.importJob?.message ?? "未知错误"}`,
        );
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("合成数据导入在 120 秒内未完成");
}

before(async () => {
  const executablePath = chromeCandidates.find(existsSync);
  assert.ok(executablePath, "未找到可用于 E2E 的本机 Chrome 或 Edge");
  browser = await chromium.launch({ executablePath, headless: true });
  temporaryRoot = await mkdtemp(join(tmpdir(), "rai-web-e2e-"));
  syntheticExport = resolve(temporaryRoot, "synthetic-apple-health");
  await createSyntheticExport(syntheticExport);
  firstRunApi = await startApi(
    resolve(temporaryRoot, "database", "rai.sqlite"),
    resolve(temporaryRoot, "first-run"),
  );
  const fixtureRoot = resolve(temporaryRoot, "fixture");
  const fixtureSource = await new ImportSourceManager(
    fixtureRoot,
    projectRoot,
  ).registerDirectory(syntheticExport);
  fixtureApi = await startApi(resolve(fixtureRoot, "var/rai.sqlite"), fixtureRoot);
  await importSyntheticFixture(fixtureApi, fixtureSource.sourceId);
  if (
    process.env.npm_lifecycle_event === "test:e2e:responsive" &&
    existsSync(realDatabase)
  ) {
    const realDatabaseCopy = resolve(temporaryRoot, "workspace-copy", "var/rai.sqlite");
    await backupDatabase(realDatabase, realDatabaseCopy);
    realApi = await startApi(realDatabaseCopy, resolve(temporaryRoot, "workspace-copy"));
  }
});

after(async () => {
  await Promise.all([stopApi(realApi), stopApi(fixtureApi), stopApi(firstRunApi)]);
  await browser?.close();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

desktopTest("1024px desktop keeps prediction model actions within the viewport", async () => {
  const context = await browser.newContext({
    viewport: { width: 1024, height: 900 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    await page.route("**/v1/prediction-models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runs: [{
            id: "prediction-layout-run",
            status: "succeeded",
            active: false,
            modelVersion: "catboost-layout-verification",
            featureSchemaVersion: "prediction_features_v1",
            createdAt: new Date().toISOString(),
            labelCount: 60,
            holdoutPredictionCount: 12,
            labelCountByDistance: { five_k: 20, ten_k: 20, half_marathon: 20 },
            metrics: {
              maeImprovement: 0.12,
              baselineMaeSeconds: 30,
              modelMaeSeconds: 26,
            },
          }],
        }),
      });
    });
    await page.goto(`${fixtureApi.origin}/data`, { waitUntil: "domcontentloaded" });
    await page.getByText("catboost-layout-verification").waitFor();
    const metrics = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      modelList: document.querySelector(".prediction-model-list")?.scrollWidth ?? 0,
      modelPanel: document.querySelector(".prediction-model-management")?.clientWidth ?? 0,
    }));
    assert.ok(metrics.document <= metrics.viewport, JSON.stringify(metrics));
    assert.ok(metrics.body <= metrics.viewport, JSON.stringify(metrics));
    assert.ok(metrics.modelList <= metrics.modelPanel, JSON.stringify(metrics));
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
});

desktopTest("无数据库时只开放安全的首次导入流程", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    const crossOriginWrite = await fetch(`${firstRunApi.origin}/v1/model-runs`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "text/plain",
      },
      body: "",
    });
    assert.equal(crossOriginWrite.status, 403);
    assert.equal(
      (await crossOriginWrite.json() as { code: string }).code,
      "untrusted_origin",
    );

    await page.goto(firstRunApi.origin, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", {
        name: "从 Apple Health 导出 建立你的 RAI 时间线",
      })
      .waitFor();
    assert.equal(await page.title(), "概览 - RAI");
    await page.route(
      "**/v1/health",
      async (route) => {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "后台健康检查暂不可用" }),
        });
      },
      { times: 1 },
    );
    await page.evaluate(() =>
      window.dispatchEvent(new Event("rai:database-state-changed")),
    );
    await page
      .getByRole("status")
      .filter({ hasText: "后台健康检查暂不可用" })
      .waitFor();
    await page
      .getByRole("heading", {
        name: "从 Apple Health 导出 建立你的 RAI 时间线",
      })
      .waitFor();
    consumeExpectedHttpFailures(runtimeErrors, 503, "/v1/health");
    await page.getByRole("button", { name: "重试" }).click();
    await page
      .getByText("数据库状态刷新失败")
      .waitFor({ state: "hidden" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", {
        name: "从 Apple Health 导出 建立你的 RAI 时间线",
      })
      .waitFor();
    await page.keyboard.press("Tab");
    assert.equal(
      await page
        .getByRole("link", { name: "跳到主要内容" })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page.keyboard.press("Enter");
    assert.equal(
      await page
        .locator("#main-content")
        .evaluate((element) => element === document.activeElement),
      true,
    );

    await page.goto(`${firstRunApi.origin}/workouts`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("link", { name: "前往导入" }).waitFor();

    await page.goto(`${firstRunApi.origin}/data`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "数据与模型" }).waitFor();
    assert.equal(await page.title(), "数据与模型 - RAI");
    assert.equal(
      await page.getByRole("button", { name: "完整重算" }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "训练并自动激活" }).isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "训练并自动激活" })
        .getAttribute("aria-describedby"),
      "prediction-training-requirements prediction-training-state",
    );
    await page.getByText("公式基线", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("基线 Run").isDisabled(), true);
    assert.equal(
      await page.getByRole("button", { name: /选择 Apple 健康导出 ZIP/ }).isEnabled(),
      true,
    );

    await page.goto(`${firstRunApi.origin}/settings`, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(
      await page.getByRole("button", { name: "创建备份" }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "删除数据库" }).isDisabled(),
      true,
    );
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
});

desktopTest("概览趋势失败时显示可重试错误而非永久加载", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    await page.route(
      "**/v1/trends?days=28",
      async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "趋势暂不可用" }),
        });
      },
      { times: 1 },
    );
    await page.goto(fixtureApi.origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的跑步能力" }).waitFor();
    await page.getByRole("alert").filter({ hasText: "趋势暂不可用" }).waitFor();
    consumeExpectedHttpFailures(runtimeErrors, 500, "/v1/trends?days=28");
    await page.getByRole("button", { name: "重试" }).click();
    await page.getByText("TA 真实跑力", { exact: true }).waitFor();
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
});

desktopTest("概览统计失败时显示错误而不伪装成数据积累", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    await page.route(
      "**/v1/training-statistics/overview",
      async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "统计暂不可用" }),
        });
      },
      { times: 1 },
    );
    await page.goto(fixtureApi.origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的跑步能力" }).waitFor();
    await page.getByRole("alert").filter({ hasText: "统计暂不可用" }).waitFor();
    assert.equal(await page.getByText("数据积累中", { exact: true }).count(), 0);
    consumeExpectedHttpFailures(runtimeErrors, 500, "/v1/training-statistics/overview");
    await page.getByRole("button", { name: "重试" }).click();
    await page.getByRole("heading", { name: "训练状态" }).waitFor();
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
});

desktopTest("合成数据主流程可导航、筛选、检查详情和只读比较", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    await page.goto(fixtureApi.origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的跑步能力" }).waitFor();
    await page.getByText("诊断，不参与当前 CA", { exact: true }).waitFor();

    await page.getByRole("link", { name: "训练", exact: true }).click();
    await page.getByRole("heading", { name: "训练记录" }).waitFor();
    assert.equal(await page.title(), "训练记录 - RAI");
    assert.equal(
      await page
        .locator("#main-content")
        .evaluate((element) => element === document.activeElement),
      true,
    );
    const normalizedWorkoutRequest = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/workouts?") &&
        response.url().includes("environment=outdoor") &&
        response.url().includes("offset=0"),
    );
    await page.goto(
      `${fixtureApi.origin}/workouts?unknown=1&status=bogus&environment=outdoor&offset=NaN`,
      { waitUntil: "domcontentloaded" },
    );
    await normalizedWorkoutRequest;
    await page.waitForFunction(
      () => window.location.search === "?environment=outdoor",
    );
    assert.equal(await page.getByLabel("环境").inputValue(), "outdoor");
    await page.goto(`${fixtureApi.origin}/workouts?offset=-3.8`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => window.location.search === "");
    const outOfRangeResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/workouts?") &&
        response.url().includes("offset=999999") &&
        response.ok(),
    );
    await page.goto(`${fixtureApi.origin}/workouts?offset=999999`, {
      waitUntil: "domcontentloaded",
    });
    const outOfRangeResponse = (await outOfRangeResponsePromise);
    const outOfRangeBody = (await outOfRangeResponse.json()) as {
      total: number;
    };
    const expectedLastOffset =
      outOfRangeBody.total === 0
        ? 0
        : Math.floor((outOfRangeBody.total - 1) / 30) * 30;
    await page.waitForFunction(
      (expectedOffset) =>
        new URLSearchParams(window.location.search).get("offset") ===
        (expectedOffset === 0 ? null : String(expectedOffset)),
      expectedLastOffset,
    );
    if (outOfRangeBody.total > 0) {
      await page.locator(".workout-table .row-link").first().waitFor();
    }
    await page.getByLabel("资格").selectOption("eligible");
    await page.getByLabel("环境").selectOption("outdoor");
    await page.getByLabel("时间").selectOption("365");
    const filteredResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/workouts?") &&
        response.url().includes("sourceGroup=apple_watch") &&
        response.ok(),
    );
    await page.getByLabel("来源").selectOption("apple_watch");
    await filteredResponse;
    await page.locator(".workout-table .row-link").first().waitFor();
    await page.getByRole("table", { name: "训练记录" }).waitFor();
    assert.ok((await page.locator(".workout-table tbody tr").count()) > 0);
    await page.goBack();
    await page.waitForFunction(
      () => !window.location.search.includes("sourceGroup="),
    );
    assert.equal(await page.getByLabel("来源").inputValue(), "");
    await page.goForward();
    await page.waitForFunction(() =>
      window.location.search.includes("sourceGroup=apple_watch"),
    );
    assert.equal(
      await page.getByLabel("来源").inputValue(),
      "apple_watch",
    );
    const stimulusResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/workouts?") &&
        response.url().includes("stimulusType=unclassified") &&
        response.ok(),
    );
    await page.getByLabel("生理刺激").selectOption("unclassified");
    await stimulusResponse;
    assert.match(page.url(), /stimulusType=unclassified/);
    const resetStimulusResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/workouts?") &&
        !response.url().includes("stimulusType=") &&
        response.ok(),
    );
    await page.getByLabel("生理刺激").selectOption("");
    await resetStimulusResponse;
    await page.locator(".workout-table .row-link").first().waitFor();

    await page.locator(".workout-table .row-link").first().click();
    await page.getByRole("heading", { name: /跑步$/ }).waitFor();
    await page.getByRole("heading", { name: "公里分段" }).waitFor();
    if (await page.locator(".splits-table").count()) {
      await page.getByRole("table", { name: "公里分段" }).waitFor();
    }
    if (await page.locator(".workout-zones-panel").count()) {
      await page.locator(".workout-zone-distribution", { hasText: "心率分区" }).waitFor();
      await page.locator(".workout-zone-distribution", { hasText: "配速分区" }).waitFor();
    }
    await page.getByRole("heading", { name: "训练内变化" }).waitFor();
    for (const title of [
      "心率",
      "跑速",
      "步频",
      "海拔",
      "跑步功率",
      "步幅",
      "垂直振幅",
      "触地时间",
    ]) {
      await page
        .locator(".series-chart header span", { hasText: title })
        .waitFor();
    }
    const heartRateData = page.getByText("查看心率数据", { exact: true });
    if (await heartRateData.count()) {
      assert.equal(
        await page.getByRole("table", { name: "心率训练时间序列数据" }).count(),
        0,
      );
      await heartRateData.click();
      await page
        .getByRole("table", { name: "心率训练时间序列数据" })
        .waitFor();
      await heartRateData.click();
      assert.equal(
        await page.getByRole("table", { name: "心率训练时间序列数据" }).count(),
        0,
      );
    }
    await page.getByRole("button", { name: "编辑覆盖" }).click();
    const overrideDialog = page.getByRole("dialog", { name: "编辑训练覆盖" });
    await overrideDialog.waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "关闭" })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page.keyboard.press("Escape");
    await overrideDialog.waitFor({ state: "hidden" });
    await page.getByRole("link", { name: "返回训练记录" }).click();
    await page.getByRole("heading", { name: "训练记录" }).waitFor();
    assert.match(page.url(), /environment=outdoor/);
    assert.match(page.url(), /sourceGroup=apple_watch/);
    assert.equal(await page.getByLabel("环境").inputValue(), "outdoor");

    await page.getByRole("link", { name: "统计", exact: true }).click();
    await page.getByRole("heading", { name: "运动统计" }).waitFor();
    await page.getByRole("heading", { name: "负荷摘要" }).waitFor();
    await page.getByRole("heading", { name: "负荷趋势" }).waitFor();
    const volumeData = page.getByText("查看跑量与负荷数据", { exact: true });
    await volumeData.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("table", { name: "跑量与训练负荷历史数据" }).waitFor();
    await volumeData.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "内部", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "内部", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByText("查看内部负荷数据", { exact: true }).waitFor();
    await page.getByRole("button", { name: "配速", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "配速", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByText("查看配速负荷数据", { exact: true }).waitFor();
    await page.getByRole("button", { name: "综合", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "周" }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "月" }).click();
    assert.equal(await page.getByRole("button", { name: "月" }).getAttribute("aria-pressed"), "true");
    await page.getByRole("heading", { name: "月跑量与负荷" }).waitFor();
    await page.getByRole("button", { name: "年" }).click();
    await page.getByRole("heading", { name: "年跑量与负荷" }).waitFor();
    await page.getByRole("button", { name: "周" }).click();
    await page.getByRole("heading", { name: "周跑量与负荷" }).waitFor();

    const defaultTrendResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/trends?days=90") && response.ok(),
    );
    await page.getByRole("link", { name: "趋势", exact: true }).click();
    await defaultTrendResponse;
    await page.getByRole("heading", { name: "能力趋势" }).waitFor();
    await page.getByRole("button", { name: "1 年" }).click();
    assert.equal(await page.getByRole("button", { name: "1 年" }).getAttribute("aria-pressed"), "true");
    await page.getByText("TA 真实跑力", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "五维即时趋势" }).waitFor();
    await page.getByRole("heading", { name: "训练上下文" }).waitFor();
    const dimensionData = page.getByText("查看五维即时趋势数据", {
      exact: true,
    });
    if (await dimensionData.count()) {
      await dimensionData.click();
      await page
        .getByRole("table", { name: "五维即时能力趋势数据" })
        .waitFor();
    }
    await page.getByText("查看训练上下文数据", { exact: true }).click();
    await page
      .getByRole("table", { name: "训练上下文数据" })
      .waitFor();
    const caDataEntry = page.locator(".ability-chart-data summary").first();
    assert.equal(await page.getByRole("link", { name: /即时能力 CA.*查看训练详情/ }).count(), 0);
    await caDataEntry.focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(".ability-chart-data").first().getAttribute("open"), "");
    const caPoint = page.getByRole("link", { name: /即时能力 CA.*查看训练详情/ }).first();
    await caPoint.focus();
    assert.equal(await caPoint.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: /跑步$/ }).waitFor();
    await page.getByRole("link", { name: "返回上一页" }).click();
    await page.getByRole("heading", { name: "能力趋势" }).waitFor();

    await page.getByRole("link", { name: "预测", exact: true }).click();
    await page.getByRole("heading", { name: "生理与成绩预测" }).waitFor();
    await page.getByText("有效 VDOT", { exact: true }).waitFor();
    assert.equal(await page.getByText("较上周", { exact: false }).count(), 0);
    assert.ok(await page.getByText("当前模型快照", { exact: false }).count() >= 2);
    assert.equal(await page.getByLabel("天气").count(), 0);
    await page.getByLabel("温度").fill("30");
    await page.getByLabel("湿度").fill("80");
    await page.getByLabel("10K 爬升").fill("150");
    const scenarioResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/predictions?") &&
        response.url().includes("temperatureC=30") &&
        response.url().includes("humidityPercent=80") &&
        response.url().includes("elevationGain10k=150") &&
        response.ok(),
    );
    await page.getByRole("button", { name: "应用场景" }).click();
    const scenarioBody = (await (await scenarioResponse).json()) as {
      inputs: {
        scenario: {
          temperatureC: number | null;
          humidityPercent: number | null;
          elevationGainMeters: { ten_k: number | null };
        };
      };
    };
    assert.equal(scenarioBody.inputs.scenario.temperatureC, 30);
    assert.equal(scenarioBody.inputs.scenario.humidityPercent, 80);
    assert.equal(scenarioBody.inputs.scenario.elevationGainMeters.ten_k, 150);
    await page.getByText("温湿度", { exact: true }).first().waitFor();
    await page.getByRole("heading", { name: "CatBoost 预测模型" }).waitFor();
    await page.getByText(/CatBoost 已应用|CatBoost 已激活|模型不可用，已回退公式|模型已过期，请重新训练|样本不足|公式基线/, { exact: true }).first().waitFor();
    const invalidHumidity = await fetch(
      `${fixtureApi.origin}/v1/predictions?humidityPercent=101`,
    );
    assert.equal(invalidHumidity.status, 400);
    const unknownPredictionParameter = await fetch(
      `${fixtureApi.origin}/v1/predictions?unknown=1`,
    );
    assert.equal(unknownPredictionParameter.status, 400);
    const predictionPrivacy = JSON.stringify(
      await fetch(`${fixtureApi.origin}/v1/predictions`).then((response) =>
        response.json(),
      ),
    );
    assert.equal(predictionPrivacy.includes("latitude"), false);
    assert.equal(predictionPrivacy.includes("source_name"), false);

    await page.getByRole("link", { name: "数据与模型", exact: true }).click();
    await page.getByRole("heading", { name: "数据与模型" }).waitFor();
    await page.getByRole("heading", { name: "成绩预测模型" }).waitFor();
    await page.locator(".model-list > div").first().waitFor();
    const base = page.getByLabel("基线 Run");
    const candidate = page.getByLabel("候选 Run");
    const optionCount = await base.locator("option").count();
    if (optionCount >= 3) {
      await base.selectOption({ index: 1 });
      await candidate.selectOption({ index: 2 });
      await page.getByRole("button", { name: "运行对照" }).click();
      await page.getByText("共同训练", { exact: true }).waitFor();
    } else {
      assert.ok(
        (await page.locator(".model-list > div").count()) >= 1,
        "应至少展示当前 active Model Run",
      );
    }
    await page.getByRole("button", { name: "详情" }).first().click();
    await page.getByRole("heading", { name: "任务阶段" }).waitFor();
    await page.getByRole("button", { name: "关闭任务详情" }).click();

    await page.getByRole("link", { name: "查看数据审计" }).click();
    await page.getByRole("heading", { name: "数据审计" }).waitFor();
    assert.equal(await page.getByText("变化（7天）", { exact: true }).count(), 0);
    assert.ok(await page.getByText("当前数据集", { exact: true }).count() > 0);

    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("heading", { name: "健康免责声明" }).waitFor();
    const diagnosticResponse = await fetch(`${fixtureApi.origin}/v1/diagnostics`);
    assert.equal(diagnosticResponse.ok, true);
    assert.match(
      diagnosticResponse.headers.get("content-disposition") ?? "",
      /rai-diagnostics-/,
    );
    const diagnosticBody = (await diagnosticResponse.json()) as {
      privacy: {
        coordinatesRemoved: boolean;
        healthTimeSeriesRemoved: boolean;
      };
    };
    assert.equal(diagnosticBody.privacy.coordinatesRemoved, true);
    assert.equal(diagnosticBody.privacy.healthTimeSeriesRemoved, true);
    const deleteTrigger = page.getByRole("button", { name: "删除数据库" });
    await deleteTrigger.click();
    const confirmButton = page.getByRole("button", { name: "确认删除" });
    const confirmationInput = page.getByLabel("确认文字");
    assert.equal(
      await confirmationInput.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await page
        .getByRole("button", { name: "取消" })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page.keyboard.press("Tab");
    assert.equal(
      await confirmationInput.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
    );
    await confirmationInput.fill("删除我的 RAI 数据");
    assert.equal(await confirmButton.isDisabled(), false);
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "确认删除本地数据库" })
      .waitFor({ state: "hidden" });
    assert.equal(
      await deleteTrigger.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
    );
    await deleteTrigger.click();
    assert.equal(await confirmButton.isDisabled(), true);
    await confirmationInput.fill("错误确认文字");
    assert.equal(await confirmButton.isDisabled(), true);
    await page.getByRole("button", { name: "取消" }).click();

    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
});

responsiveTest("390px 下首次启动可从更多进入恢复设置，且关键页无横向溢出", async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    for (const path of ["/", "/data", "/settings", "/more"]) {
      await assertNoHorizontalOverflow(page, `${firstRunApi.origin}${path}`);
    }
    await page.goto(`${firstRunApi.origin}/more`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "更多" }).waitFor();
    await page.getByRole("link", { name: /设置/ }).click();
    await page.getByRole("heading", { name: "设置" }).waitFor();
    if (realApi) {
      const workoutResponse = await fetch(
        `${realApi.origin}/v1/workouts?limit=1&offset=0`,
      );
      assert.equal(workoutResponse.ok, true);
      const workoutBody = (await workoutResponse.json()) as {
        items: Array<{ id: string }>;
      };
      const workoutId = workoutBody.items[0]?.id;
      const paths = [
        "/",
        "/workouts",
        "/statistics",
        "/trends",
        "/more",
        "/predictions",
        "/data",
        "/data/audit",
        "/settings",
      ];
      if (workoutId) paths.splice(2, 0, `/workouts/${workoutId}`);
      for (const path of paths) {
        await assertNoHorizontalOverflow(page, `${realApi.origin}${path}`);
      }
      await page.goto(`${realApi.origin}/predictions`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("heading", { name: "生理与成绩预测" }).waitFor();
      assert.match(
        (await page
          .locator('.mobile-nav-links a[href="/more"]')
          .getAttribute("class")) ?? "",
        /active/,
      );
    }
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
});

desktopTest("合成数据可完成首次导入、覆盖重算、模型切换和删除恢复", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  const pendingRequests = collectPendingRequests(page);
  let releaseInitialRuntimeStatus: (() => void) | undefined;
  let releaseTerminalRuntimeStatus: (() => void) | undefined;
  let releaseTerminalImportPoll: (() => void) | undefined;
  try {
    let delayedInitialRuntimeStatus = false;
    let createdImportJob: ({ id: string } & Record<string, unknown>) | null = null;
    const importCreated = new Promise<void>((resolveCreated) => {
      releaseInitialRuntimeStatus = resolveCreated;
    });
    const terminalRuntimeStatusGate = new Promise<void>((resolveTerminal) => {
      releaseTerminalRuntimeStatus = resolveTerminal;
    });
    await page.route("**/v1/runtime-status", async (route) => {
      if (!delayedInitialRuntimeStatus) {
        delayedInitialRuntimeStatus = true;
        await importCreated;
        assert.ok(createdImportJob);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            databaseReady: false,
            busy: true,
            recomputeJob: null,
            importJob: { ...createdImportJob, status: "running" },
          }),
        });
        return;
      }
      await terminalRuntimeStatusGate;
      await route.continue();
    });
    const firstRunSource = await new ImportSourceManager(
      resolve(temporaryRoot, "first-run"),
      projectRoot,
    ).registerDirectory(syntheticExport);
    await page.goto(`${firstRunApi.origin}/data`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: /synthetic-apple-health/ }).click();
    await page.getByRole("button", { name: "开始更新" }).waitFor();
    let rejectedFirstImportPoll = false;
    const terminalImportPollGate = new Promise<void>((resolvePoll) => {
      releaseTerminalImportPoll = resolvePoll;
    });
    await page.route("**/v1/import-jobs/*", async (route) => {
      if (route.request().method() === "GET" && !rejectedFirstImportPoll) {
        rejectedFirstImportPoll = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "临时不可用" }),
        });
      } else {
        if (route.request().method() === "GET") await terminalImportPollGate;
        await route.continue();
      }
    });
    const createdImportResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/import-jobs") &&
        response.request().method() === "POST" &&
        response.ok(),
    );
    await page.getByRole("button", { name: "开始更新" }).click();
    createdImportJob = await (await createdImportResponse).json() as {
      id: string;
    } & Record<string, unknown>;
    releaseInitialRuntimeStatus?.();
    const importCompleted = waitForImport(firstRunApi.origin);
    await page.getByLabel("后台任务状态").waitFor();
    await page.getByText("正在重新连接导入任务", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("rai:active-import-job")),
      createdImportJob.id,
    );
    assert.equal(delayedInitialRuntimeStatus, true);
    consumeExpectedHttpFailures(runtimeErrors, 503, /\/v1\/import-jobs\/[^/]+$/);
    await navigateToSettingsWithDiagnostics(page, runtimeErrors, pendingRequests);
    releaseTerminalImportPoll?.();
    await page.unroute("**/v1/import-jobs/*");
    let healthRequestCount = 0;
    await page.route("**/v1/health", async (route) => {
      healthRequestCount += 1;
      await route.continue();
    });
    const refreshedHealth = page.waitForResponse(
      (response) => response.url().endsWith("/v1/health") && response.ok(),
    );
    releaseTerminalRuntimeStatus?.();
    const firstImportJobId = await importCompleted;
    assert.equal(firstImportJobId, createdImportJob.id);
    await refreshedHealth;
    await page.waitForTimeout(250);
    assert.equal(healthRequestCount, 1);
    await page.unroute("**/v1/health");
    assert.equal(
      await page.evaluate(() => localStorage.getItem("rai:active-import-job")),
      firstImportJobId,
    );
    const importedHealth = (await fetch(`${firstRunApi.origin}/v1/health`).then(
      (response) => response.json(),
    )) as { databaseReady: boolean };
    assert.equal(importedHealth.databaseReady, true);
    await page.getByRole("link", { name: "概览", exact: true }).click();
    await page.getByRole("heading", { name: "你的跑步能力" }).waitFor();
    await page.getByRole("link", { name: "数据与模型", exact: true }).click();
    await page.getByRole("heading", { name: "数据与模型" }).waitFor();
    await page
      .getByRole("link", { name: "查看数据审计" })
      .waitFor({ timeout: 15_000 });
    assert.equal(await page.getByRole("button", { name: "完整重算" }).isEnabled(), true);
    await page.waitForFunction(
      () => localStorage.getItem("rai:active-import-job") === null,
      undefined,
      { timeout: 15_000 },
    );
    await page.unroute("**/v1/runtime-status");

    const insufficientTrainingResponse = await fetch(
      `${firstRunApi.origin}/v1/prediction-models/train`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rai-local-request": "1",
        },
        body: "{}",
      },
    );
    assert.equal(
      insufficientTrainingResponse.status,
      422,
      JSON.stringify(await insufficientTrainingResponse.clone().json()),
    );
    const insufficientTrainingBody =
      (await insufficientTrainingResponse.json()) as {
        code: string;
        available: number;
        required: number;
      };
    assert.equal(
      insufficientTrainingBody.code,
      "insufficient_labeled_outcomes",
    );
    assert.equal(insufficientTrainingBody.available, 0);
    assert.equal(insufficientTrainingBody.required, 50);
    await page.getByRole("button", { name: "训练并自动激活" }).click();
    const trainingError = page.locator(".prediction-model-notice.error");
    await trainingError
      .getByText("暂时不能开始训练", { exact: true })
      .waitFor();
    await trainingError
      .getByText("当前有 0/50 条可用真实结果，尚不能训练。", { exact: true })
      .waitFor();
    await trainingError.getByText("5K0/8", { exact: true }).waitFor();
    await trainingError.getByText("10K0/8", { exact: true }).waitFor();
    await trainingError.getByText("半马0/8", { exact: true }).waitFor();
    consumeExpectedHttpFailures(runtimeErrors, 422, "/v1/prediction-models/train");
    await page.route(
      "**/v1/prediction-models/train",
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ runId: "e2e-catboost-run", status: "queued" }),
        });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "训练并自动激活" }).click();
    await page.getByRole("status").filter({ hasText: "当前排队中" }).waitFor();

    await page.getByRole("link", { name: "训练", exact: true }).click();
    const syntheticWorkouts = (await fetch(
      `${firstRunApi.origin}/v1/workouts?limit=1&offset=0`,
    ).then((response) => response.json())) as {
      items: Array<{ stimulusType: string }>;
    };
    const syntheticStimulus = syntheticWorkouts.items[0]?.stimulusType;
    assert.ok(syntheticStimulus);
    const syntheticStimulusResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/workouts?") &&
        response.url().includes(`stimulusType=${syntheticStimulus}`) &&
        response.ok(),
    );
    await page.getByLabel("生理刺激").selectOption(syntheticStimulus);
    await syntheticStimulusResponse;
    await page.locator(".workout-table .row-link").first().click();
    const syntheticWorkoutId = new URL(page.url()).pathname.split("/").at(-1);
    assert.ok(syntheticWorkoutId);
    await page.getByRole("heading", { name: "公里分段" }).waitFor();
    await page.locator(".workout-zones-panel").waitFor();
    await page.locator(".workout-zone-distribution", { hasText: "心率分区" }).waitFor();
    await page.locator(".workout-zone-distribution", { hasText: "配速分区" }).waitFor();
    await page.locator(".workout-load-band").waitFor();

    await page.getByRole("link", { name: "统计", exact: true }).click();
    await page.getByRole("heading", { name: "负荷趋势" }).waitFor();
    await page.getByRole("button", { name: "内部", exact: true }).click();
    await page.getByText("查看内部负荷数据", { exact: true }).waitFor();
    await page.getByRole("button", { name: "配速", exact: true }).click();
    await page.getByText("查看配速负荷数据", { exact: true }).waitFor();
    await page.getByRole("button", { name: "综合", exact: true }).click();
    await page.goto(`${firstRunApi.origin}/workouts/${syntheticWorkoutId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: /跑步$/ }).waitFor();
    await page.getByRole("button", { name: "编辑覆盖" }).click();
    await page.getByLabel("训练类型").selectOption("easy");
    await page.getByLabel("RPE").fill("6");
    await page.getByLabel("状态标签").fill("E2E，状态良好");
    await page.getByLabel("备注").fill("合成数据写入流程验收");
    await page.route("**/v1/workouts/*/override", async (route) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "覆盖保存测试失败" }),
      });
    }, { times: 1 });
    await page.getByRole("button", { name: "保存并重算" }).click();
    assert.equal(await page.getByRole("button", { name: "关闭" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "取消" }).isDisabled(), true);
    assert.equal(await page.getByLabel("训练类型").isDisabled(), true);
    assert.equal(await page.getByLabel("RPE").isDisabled(), true);
    assert.equal(await page.getByLabel("状态标签").isDisabled(), true);
    assert.equal(await page.getByLabel("备注").isDisabled(), true);
    assert.equal(await page.getByRole("dialog", { name: "编辑训练覆盖" }).getAttribute("aria-busy"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog", { name: "编辑训练覆盖" }).isVisible(), true);
    await page.getByRole("alert").filter({ hasText: "覆盖保存测试失败" }).waitFor();
    consumeExpectedHttpFailures(runtimeErrors, 500, /\/v1\/workouts\/[^/]+\/override$/);
    assert.equal(await page.getByLabel("备注").isEnabled(), true);
    await page.getByRole("button", { name: "保存并重算" }).click();
    await page
      .getByText("新模型已激活", { exact: true })
      .waitFor({ timeout: 120_000 });

    const modelsBeforeSwitch = (await fetch(
      `${firstRunApi.origin}/v1/model-runs`,
    ).then((response) => response.json())) as Array<{
      id: string;
      active: boolean;
    }>;
    assert.equal(modelsBeforeSwitch.length, 2);
    const activeBeforeSwitch = modelsBeforeSwitch.find(
      (model) => model.active,
    )?.id;
    assert.ok(activeBeforeSwitch);

    await page.getByRole("link", { name: "数据与模型", exact: true }).click();
    await page.locator(".model-list > div").first().waitFor();
    const syntheticBase = page.getByLabel("基线 Run");
    const syntheticCandidate = page.getByLabel("候选 Run");
    assert.ok((await syntheticBase.locator("option").count()) >= 3);
    await syntheticBase.selectOption({ index: 1 });
    await syntheticCandidate.selectOption({ index: 2 });
    await page.getByRole("button", { name: "运行对照" }).click();
    await page.getByText("共同训练", { exact: true }).waitFor();
    await page.route(
      "**/v1/model-runs/compare?*",
      async (route) => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        await route.continue();
      },
      { times: 1 },
    );
    const staleComparisonResponse = page.waitForResponse((response) =>
      response.url().includes("/v1/model-runs/compare?"),
    );
    await page.getByRole("button", { name: "运行对照" }).click();
    await syntheticCandidate.selectOption({ index: 1 });
    await staleComparisonResponse;
    assert.equal(await page.getByText("共同训练", { exact: true }).count(), 0);
    await page.route("**/v1/model-runs/*/activate", async (route) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      await route.continue();
    });
    const activateButton = page.locator(".model-list .text-button").first();
    const activationResponse = page.waitForResponse((response) =>
      response.url().endsWith("/activate"),
    );
    await activateButton.click();
    assert.equal(await activateButton.isDisabled(), true);
    await activationResponse;
    await page.unroute("**/v1/model-runs/*/activate");
    await page.waitForFunction(async (previous) => {
      const response = await fetch("/v1/model-runs");
      const models = (await response.json()) as Array<{
        id: string;
        active: boolean;
      }>;
      return models.find((model) => model.active)?.id !== previous;
    }, activeBeforeSwitch);

    await page.goto(`${firstRunApi.origin}/data`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: /synthetic-apple-health/ }).click();
    const unchangedImportButton = page.getByRole("button", { name: "数据已是最新" });
    await unchangedImportButton.waitFor();
    assert.equal(await unchangedImportButton.isDisabled(), true);
    const repeatedImportResponse = await fetch(`${firstRunApi.origin}/v1/import-jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rai-local-request": "1",
      },
      body: JSON.stringify({ sourceId: firstRunSource.sourceId }),
    });
    const repeatedImportBody = await repeatedImportResponse.text();
    assert.equal(repeatedImportResponse.status, 200, repeatedImportBody);
    const repeatedImportJob = JSON.parse(repeatedImportBody) as {
      id: string;
      status: string;
    };
    assert.equal(repeatedImportJob.id, firstImportJobId);
    assert.equal(repeatedImportJob.status, "succeeded");
    const modelsAfterUpdate = (await fetch(
      `${firstRunApi.origin}/v1/model-runs`,
    ).then((response) => response.json())) as Array<{
      id: string;
      active: boolean;
    }>;
    // A repeated submission for an unchanged source must not create another immutable run.
    assert.equal(modelsAfterUpdate.length, 2);
    assert.equal(modelsAfterUpdate.filter((model) => model.active).length, 1);
    const preservedDetail = (await fetch(
      `${firstRunApi.origin}/v1/workouts/${syntheticWorkoutId}`,
    ).then((response) => response.json())) as {
      override: { rpe: number; note: string } | null;
    };
    assert.equal(preservedDetail.override?.rpe, 6);
    assert.equal(preservedDetail.override?.note, "合成数据写入流程验收");

    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "删除数据库" }).click();
    await page.getByLabel("确认文字").fill("删除我的 RAI 数据");
    await page.route("**/v1/database", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "删除测试失败" }),
      });
    }, { times: 1 });
    await page.getByRole("button", { name: "确认删除" }).click();
    const deleteDialogError = page.getByRole("alert").filter({ hasText: "删除测试失败" });
    await deleteDialogError.waitFor();
    assert.equal(await deleteDialogError.evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.getByRole("dialog", { name: "确认删除本地数据库" }).isVisible(), true);
    consumeExpectedHttpFailures(runtimeErrors, 500, "/v1/database");
    await page.getByRole("button", { name: "确认删除" }).click();
    await page
      .getByText(/本地数据库已删除；可恢复的删除前备份/)
      .waitFor({ timeout: 30_000 });

    const deletedHealth = (await fetch(`${firstRunApi.origin}/v1/health`).then(
      (response) => response.json(),
    )) as { databaseReady: boolean };
    assert.equal(deletedHealth.databaseReady, false);
    const backups = (await fetch(`${firstRunApi.origin}/v1/backups`).then(
      (response) => response.json(),
    )) as unknown[];
    assert.ok(backups.length >= 1);
    await page.goto(firstRunApi.origin, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", {
        name: "从 Apple Health 导出 建立你的 RAI 时间线",
      })
      .waitFor();
    await page.getByRole("link", { name: "设置", exact: true }).click();
    const restoreTrigger = page.getByRole("button", { name: "恢复" }).first();
    await restoreTrigger.click();
    const restoreButton = page.getByRole("button", { name: "确认恢复" });
    const restoreInput = page.getByLabel("恢复确认文字");
    assert.equal(
      await restoreInput.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "恢复本地数据库备份" })
      .waitFor({ state: "hidden" });
    assert.equal(
      await restoreTrigger.evaluate(
        (element) => element === document.activeElement,
      ),
      true,
    );
    await restoreTrigger.click();
    assert.equal(await restoreButton.isDisabled(), true);
    await restoreInput.fill("恢复此备份");
    await page.route("**/v1/backups/*/restore", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "恢复测试失败" }),
      });
    }, { times: 1 });
    await restoreButton.click();
    const restoreDialogError = page.getByRole("alert").filter({ hasText: "恢复测试失败" });
    await restoreDialogError.waitFor();
    assert.equal(await restoreDialogError.evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.getByRole("dialog", { name: "恢复本地数据库备份" }).isVisible(), true);
    consumeExpectedHttpFailures(runtimeErrors, 500, /\/v1\/backups\/[^/]+\/restore$/);
    await restoreButton.click();
    await page.getByText(/已恢复备份/).waitFor({ timeout: 30_000 });
    await page.waitForFunction(async () => {
      const response = await fetch("/v1/health");
      return ((await response.json()) as { databaseReady: boolean })
        .databaseReady;
    });
    await page.goto(firstRunApi.origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的跑步能力" }).waitFor();
    const restoredModels = (await fetch(
      `${firstRunApi.origin}/v1/model-runs`,
    ).then((response) => response.json())) as Array<{ id: string }>;
    assert.equal(restoredModels.length, 2);
    assert.deepEqual(runtimeErrors, []);
  } finally {
    releaseInitialRuntimeStatus?.();
    releaseTerminalImportPoll?.();
    releaseTerminalRuntimeStatus?.();
    await page.unrouteAll({ behavior: "wait" });
    await context.close();
  }
});

desktopTest("训练分区设置校验、刷新重试并连续递增 revision", async () => {
  const initialResponse = await fetch(
    `${firstRunApi.origin}/v1/training-zones/current`,
  );
  assert.equal(initialResponse.ok, true);
  const initial = (await initialResponse.json()) as {
    settings: {
      revision: number;
      effectiveFromLocalDate: string;
      restingHeartRate: { mode: "auto" | "manual"; valueBpm: number | null };
      maximumHeartRate: { mode: "auto" | "manual"; valueBpm: number | null };
      lactateThresholdPace: {
        mode: "auto" | "manual";
        valueSecondsPerKm: number | null;
      };
      createdAt: string;
    };
    profile: { maximumHeartRateBpm: number } & Record<string, unknown>;
  } & Record<string, unknown>;
  const baseRevision = initial.settings.revision;
  const initialView = {
    ...initial,
    settings: {
      ...initial.settings,
      maximumHeartRate: { mode: "auto" as const, valueBpm: null },
    },
  };
  const savedSettings = (revision: number, valueBpm: number) => ({
    ...initialView.settings,
    revision,
    effectiveFromLocalDate: "2026-07-16",
    restingHeartRate: { mode: "manual" as const, valueBpm },
    createdAt: `2026-07-15T00:00:0${revision - baseRevision}.000Z`,
  });
  const patchBodies: Array<{ expectedRevision: number }> = [];
  let currentRequestCount = 0;
  let latestSettings = initial.settings;
  let releaseFirstPatch: () => void = () => {};
  let reportFirstPatchStarted: () => void = () => {};
  const firstPatchGate = new Promise<void>((resolveGate) => { releaseFirstPatch = resolveGate; });
  const firstPatchStarted = new Promise<void>((resolveStarted) => { reportFirstPatchStarted = resolveStarted; });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    await page.route("**/v1/training-zones/current", async (route) => {
      currentRequestCount += 1;
      if (currentRequestCount === 2) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "分区刷新测试失败" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...initialView,
          profile: {
            ...initialView.profile,
            maximumHeartRateBpm: currentRequestCount >= 3
              ? initialView.profile.maximumHeartRateBpm + 3
              : initialView.profile.maximumHeartRateBpm,
          },
          settings: latestSettings,
        }),
      });
    });
    await page.route("**/v1/training-zones/profile", async (route) => {
      const body = route.request().postDataJSON() as { expectedRevision: number };
      patchBodies.push(body);
      latestSettings = savedSettings(
        baseRevision + patchBodies.length,
        patchBodies.length === 1 ? 55 : 56,
      );
      if (patchBodies.length === 1) {
        reportFirstPatchStarted();
        await firstPatchGate;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latestSettings),
      });
    });
    await page.goto(`${firstRunApi.origin}/zones`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "训练分区" }).waitFor();

    await page
      .getByRole("group", { name: "静息心率模式" })
      .getByRole("button", { name: "手动" })
      .click();
    const restingHeartRateInput = page
      .locator(".zone-setting-row")
      .filter({ hasText: "静息心率" })
      .locator('input[type="number"]');
    await restingHeartRateInput.fill("20");
    await page.getByRole("button", { name: "保存设置" }).click();
    await page.getByText(/请输入 35.*110 bpm 范围内的有效数值/).waitFor();
    assert.equal(patchBodies.length, 0);

    await restingHeartRateInput.fill("55");
    await page.getByRole("button", { name: "保存设置" }).click();
    await firstPatchStarted;
    assert.equal(await page.getByRole("button", { name: "正在保存" }).isDisabled(), true);
    for (const label of ["静息心率模式", "最高心率模式", "乳酸阈配速模式"]) {
      const group = page.getByRole("group", { name: label });
      assert.equal(await group.getByRole("button", { name: "自动" }).isDisabled(), true);
      assert.equal(await group.getByRole("button", { name: "手动" }).isDisabled(), true);
    }
    const numericInputs = page.locator('.zone-setting-row input[type="number"]');
    assert.equal(await numericInputs.count(), 3);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await numericInputs.nth(index).isDisabled(), true);
    }
    assert.equal(await restingHeartRateInput.inputValue(), "55");
    releaseFirstPatch();
    await page
      .getByRole("status")
      .filter({ hasText: `revision ${baseRevision + 1}` })
      .waitFor();
    assert.equal(await restingHeartRateInput.inputValue(), "55");
    await page
      .getByRole("alert")
      .filter({ hasText: "设置已保存，但最新分区刷新失败" })
      .waitFor();
    consumeExpectedHttpFailures(runtimeErrors, 503, "/v1/training-zones/current");
    const maximumHeartRateInput = page
      .locator(".zone-setting-row")
      .filter({ hasText: "最高心率" })
      .locator('input[type="number"]');
    const originalMaximumHeartRate = await maximumHeartRateInput.inputValue();
    const refreshed = page.waitForResponse(
      (response) => response.url().includes("/v1/training-zones/current") && response.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("rai:data-updated")));
    await refreshed;
    await page
      .getByText("设置已保存，但最新分区刷新失败")
      .waitFor({ state: "hidden" });
    assert.notEqual(await maximumHeartRateInput.inputValue(), originalMaximumHeartRate);

    await restingHeartRateInput.fill("56");
    await page.getByRole("button", { name: "保存设置" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: `revision ${baseRevision + 2}` })
      .waitFor();
    assert.deepEqual(
      patchBodies.map((body) => body.expectedRevision),
      [baseRevision, baseRevision + 1],
    );
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
});

desktopTest("训练分区编辑在外部 revision 更新时保留草稿并提交编辑基线", async () => {
  const initialResponse = await fetch(
    `${firstRunApi.origin}/v1/training-zones/current`,
  );
  assert.equal(initialResponse.ok, true);
  const initial = (await initialResponse.json()) as {
    settings: {
      revision: number;
      effectiveFromLocalDate: string;
      restingHeartRate: { mode: "auto" | "manual"; valueBpm: number | null };
      maximumHeartRate: { mode: "auto" | "manual"; valueBpm: number | null };
      lactateThresholdPace: {
        mode: "auto" | "manual";
        valueSecondsPerKm: number | null;
      };
      createdAt: string;
    };
  } & Record<string, unknown>;
  const baseRevision = initial.settings.revision;
  let latest = initial;
  const patchBodies: Array<{ expectedRevision: number }> = [];
  let reportPatchStarted!: () => void;
  const patchStarted = new Promise<void>((resolvePromise) => {
    reportPatchStarted = resolvePromise;
  });
  let releasePatch!: () => void;
  const patchGate = new Promise<void>((resolvePromise) => {
    releasePatch = resolvePromise;
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    await page.route("**/v1/training-zones/current", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latest),
      });
    });
    await page.route("**/v1/training-zones/profile", async (route) => {
      patchBodies.push(route.request().postDataJSON() as { expectedRevision: number });
      reportPatchStarted();
      await patchGate;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "Training zone settings revision conflict" }),
      });
    });
    await page.goto(`${firstRunApi.origin}/zones`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "训练分区" }).waitFor();
    await page
      .getByRole("group", { name: "静息心率模式" })
      .getByRole("button", { name: "手动" })
      .click();
    const restingHeartRateInput = page
      .locator(".zone-setting-row")
      .filter({ hasText: "静息心率" })
      .locator('input[type="number"]');
    await restingHeartRateInput.fill("57");

    latest = {
      ...initial,
      settings: {
        ...initial.settings,
        revision: baseRevision + 1,
        restingHeartRate: { mode: "manual", valueBpm: 58 },
      },
    };
    assert.equal(await restingHeartRateInput.inputValue(), "57");
    await page.getByRole("button", { name: "保存设置" }).evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await patchStarted;
    assert.equal(patchBodies.length, 1);
    const refreshed = page.waitForResponse(
      (response) => response.url().includes("/v1/training-zones/current") && response.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("rai:data-updated")));
    await refreshed;
    const loadLatestButton = page.getByRole("button", { name: "加载最新设置" });
    await loadLatestButton.waitFor();
    assert.equal(await loadLatestButton.isDisabled(), true);
    assert.equal(await restingHeartRateInput.inputValue(), "57");
    releasePatch();
    await page
      .getByRole("alert")
      .filter({ hasText: "Training zone settings revision conflict" })
      .waitFor();
    await page
      .getByRole("alert")
      .filter({ hasText: `revision ${baseRevision + 1} 的外部更新` })
      .waitFor();
    assert.deepEqual(patchBodies.map((body) => body.expectedRevision), [baseRevision]);
    assert.equal(await restingHeartRateInput.inputValue(), "57");
    consumeExpectedHttpFailures(runtimeErrors, 409, "/v1/training-zones/profile");
    assert.deepEqual(runtimeErrors, []);
  } finally {
    releasePatch();
    await context.close();
  }
});
