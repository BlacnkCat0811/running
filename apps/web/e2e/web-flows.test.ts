import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

import { chromium, type Browser, type Page } from "playwright-core";

const projectRoot = resolve(import.meta.dirname, "../../..");
const realDatabase = resolve(projectRoot, "var/rai.sqlite");
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

interface RunningApi {
  child: ChildProcess;
  origin: string;
  output: () => string;
}

let browser: Browser;
let realApi: RunningApi | null = null;
let firstRunApi: RunningApi;
let temporaryRoot: string;
let syntheticExport: string;

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 E2E 端口"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function startApi(
  databasePath: string,
  runtimeRoot = projectRoot,
): Promise<RunningApi> {
  const port = await availablePort();
  let output = "";
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/api/src/server.ts"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        RAI_API_PORT: String(port),
        RAI_DATABASE: databasePath,
        RAI_RUNTIME_ROOT: runtimeRoot,
        RAI_LOG_LEVEL: "fatal",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-8000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API 提前退出：${output}`);
    try {
      const response = await fetch(`${origin}/v1/health`);
      if (response.ok) return { child, origin, output: () => output };
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  child.kill();
  throw new Error(`API 启动超时：${output}`);
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
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <ExportDate value="${appleDate(25, "12:00")}"/>
  <Me biologicalSex="HKBiologicalSexMale"/>${workouts}
</HealthData>`;
  await writeFile(resolve(path, "export.xml"), xml, "utf8");
}

async function stopApi(api: RunningApi | null): Promise<void> {
  if (!api || api.child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => {
      api.child.kill("SIGKILL");
      resolveStop();
    }, 3000);
    api.child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    api.child.kill();
  });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

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
    temporaryRoot,
  );
  if (existsSync(realDatabase)) realApi = await startApi(realDatabase);
});

after(async () => {
  await Promise.all([stopApi(realApi), stopApi(firstRunApi)]);
  await browser?.close();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test("无数据库时只开放安全的首次导入流程", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
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

test("概览趋势失败时显示可重试错误而非永久加载", async (t) => {
  if (!realApi) {
    t.skip("工作区没有 var/rai.sqlite，跳过真实数据趋势错误态 E2E");
    return;
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
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
    await page.goto(realApi.origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的跑步能力" }).waitFor();
    await page.getByRole("alert").filter({ hasText: "趋势暂不可用" }).waitFor();
    runtimeErrors.length = 0; // 500 是本用例主动注入并由趋势面板处理的预期响应。
    await page.getByRole("button", { name: "重试" }).click();
    await page.getByText("TA 真实跑力", { exact: true }).waitFor();
    assert.deepEqual(runtimeErrors, []);
  } finally {
    await context.close();
  }
});

test("真实数据主流程可导航、筛选、检查详情和只读比较", async (t) => {
  if (!realApi) {
    t.skip("工作区没有 var/rai.sqlite，跳过真实数据只读 E2E");
    return;
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    await page.goto(realApi.origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的跑步能力" }).waitFor();
    await page.getByText("诊断，不参与当前 CA", { exact: true }).waitFor();

    await page.getByRole("link", { name: "训练", exact: true }).click();
    await page.getByRole("heading", { name: "训练记录" }).waitFor();
    const normalizedWorkoutRequest = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/workouts?") &&
        response.url().includes("environment=outdoor") &&
        response.url().includes("offset=0"),
    );
    await page.goto(
      `${realApi.origin}/workouts?unknown=1&status=bogus&environment=outdoor&offset=NaN`,
      { waitUntil: "domcontentloaded" },
    );
    await normalizedWorkoutRequest;
    await page.waitForFunction(
      () => window.location.search === "?environment=outdoor",
    );
    assert.equal(await page.getByLabel("环境").inputValue(), "outdoor");
    await page.goto(`${realApi.origin}/workouts?offset=-3.8`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => window.location.search === "");
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
    assert.ok((await page.locator(".workout-table tbody tr").count()) > 0);

    await page.locator(".workout-table .row-link").first().click();
    await page.getByRole("heading", { name: /跑步$/ }).waitFor();
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
    await page.getByRole("heading", { name: "急性与慢性负荷" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "周" }).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "月" }).click();
    assert.equal(await page.getByRole("button", { name: "月" }).getAttribute("aria-pressed"), "true");
    await page.getByRole("heading", { name: "月跑量与负荷" }).waitFor();
    await page.getByRole("button", { name: "年" }).click();
    await page.getByRole("heading", { name: "年跑量与负荷" }).waitFor();
    await page.getByRole("button", { name: "周" }).click();
    await page.getByRole("heading", { name: "周跑量与负荷" }).waitFor();

    await page.getByRole("link", { name: "趋势", exact: true }).click();
    await page.getByRole("heading", { name: "能力趋势" }).waitFor();
    await page.getByRole("button", { name: "1 年" }).click();
    assert.equal(await page.getByRole("button", { name: "1 年" }).getAttribute("aria-pressed"), "true");
    await page.getByText("TA 真实跑力", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "五维即时趋势" }).waitFor();
    await page.getByRole("heading", { name: "训练上下文" }).waitFor();
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
    await page.getByText(/CatBoost 已激活|公式基线/, { exact: true }).waitFor();
    const invalidHumidity = await fetch(
      `${realApi.origin}/v1/predictions?humidityPercent=101`,
    );
    assert.equal(invalidHumidity.status, 400);
    const unknownPredictionParameter = await fetch(
      `${realApi.origin}/v1/predictions?unknown=1`,
    );
    assert.equal(unknownPredictionParameter.status, 400);
    const predictionPrivacy = JSON.stringify(
      await fetch(`${realApi.origin}/v1/predictions`).then((response) =>
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

    await page.getByRole("link", { name: "设置", exact: true }).click();
    await page.getByRole("heading", { name: "健康免责声明" }).waitFor();
    const diagnosticResponse = await fetch(`${realApi.origin}/v1/diagnostics`);
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

test("390px 下首次启动可从更多进入恢复设置，且关键页无横向溢出", async () => {
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

test("合成数据可完成首次导入、覆盖重算、模型切换和删除恢复", async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    await page.goto(`${firstRunApi.origin}/data`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByText("高级：从已解压目录导入").click();
    await page.getByLabel("导出目录").fill(syntheticExport);
    let rejectedFirstImportPoll = false;
    await page.route("**/v1/import-jobs/*", async (route) => {
      if (route.request().method() === "GET" && !rejectedFirstImportPoll) {
        rejectedFirstImportPoll = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "临时不可用" }),
        });
      } else {
        await route.continue();
      }
    });
    await page.getByRole("button", { name: "从目录更新" }).click();
    const importCompleted = waitForImport(firstRunApi.origin);
    await page.getByText("正在重新连接导入任务", { exact: true }).waitFor();
    const firstImportJobId = await importCompleted;
    runtimeErrors.length = 0; // 首次轮询 503 是本用例主动注入并由页面重试的预期响应。
    await page.unroute("**/v1/import-jobs/*");
    await page
      .locator(".import-status .status-badge")
      .getByText("已通过", { exact: true })
      .waitFor({ timeout: 10_000 });
    await page.reload({ waitUntil: "domcontentloaded" });

    const importedHealth = (await fetch(`${firstRunApi.origin}/v1/health`).then(
      (response) => response.json(),
    )) as { databaseReady: boolean };
    assert.equal(importedHealth.databaseReady, true);
    await page
      .getByRole("link", { name: "查看数据审计" })
      .waitFor({ timeout: 15_000 });

    const insufficientTrainingResponse = await fetch(
      `${firstRunApi.origin}/v1/prediction-models/train`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(insufficientTrainingResponse.status, 422);
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
    runtimeErrors.length = 0; // 422 是本用例主动触发并已由界面处理的预期响应。
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
    await page.getByRole("status").filter({ hasText: "已进入队列" }).waitFor();

    await page.getByRole("link", { name: "训练", exact: true }).click();
    await page.locator(".workout-table .row-link").first().click();
    const syntheticWorkoutId = new URL(page.url()).pathname.split("/").at(-1);
    assert.ok(syntheticWorkoutId);
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
    runtimeErrors.length = 0; // 500 是本用例主动注入并由抽屉内错误提示处理的预期响应。
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
    await page.getByText("高级：从已解压目录导入").click();
    await page.getByLabel("导出目录").fill(syntheticExport);
    await page.getByRole("button", { name: "从目录更新" }).click();
    await waitForImport(firstRunApi.origin, firstImportJobId);
    const modelsAfterUpdate = (await fetch(
      `${firstRunApi.origin}/v1/model-runs`,
    ).then((response) => response.json())) as Array<{
      id: string;
      active: boolean;
    }>;
    // Re-importing an identical Apple Health export must not create another immutable run.
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
    runtimeErrors.length = 0; // 500 是本用例主动注入并由删除模态框处理的预期响应。
    await page.getByRole("button", { name: "确认删除" }).click();
    await page
      .getByText(/本地数据库已删除；删除前备份/)
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
    runtimeErrors.length = 0; // 500 是本用例主动注入并由恢复模态框处理的预期响应。
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
    await context.close();
  }
});
