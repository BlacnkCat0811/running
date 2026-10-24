// 阶段 6 HTTP 驱动：open-loop、逐请求原始样本、任务生命周期与业务 oracle。
//
// 口径（实施方案 §5.1 / §6 / W3）：
//   · 每个请求保存 scheduledAt / sentAt / firstByteAt / completedAt、routeTemplate、状态、
//     业务 code、结果类别、bodyBytes、业务摘要与 run/profile/dataset/scenario。
//   · 不保存原始 URL 参数、健康样本、Token；动态路径只保留 template。
//   · HTTP 接收成功、事实导入成功、分析成功、结果已发布是四个不同完成点：
//     导入场景分别记录 upload / inspect / job terminal / read-visible。
//   · 超时、错误、拒绝全部保留；不静默删除。
//
// 用法：
//   node --import tsx scripts/phase6/driver.mjs --base-url http://127.0.0.1:19001 \
//     --token <token> --scenario S02 --dataset D1 --manifest <fixture>/manifest.json \
//     --out <run>/results

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { assertLoopbackBaseUrl } from "./safety.mjs";
import { evaluateS08Contract } from "./s08-contract.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const baseUrl = assertLoopbackBaseUrl(readArg("--base-url", ""));
const token = readArg("--token", process.env.RAI_PHASE6_TOKEN ?? "");
if (token.length < 16) throw new Error("--token must be at least 16 characters");
const scenario = readArg("--scenario", "S02");
const dataset = readArg("--dataset", "D1");
const profile = readArg("--profile", "dev");
const runId = readArg("--run-id", "run-001");
const clientTrainingCommands = readArg("--client-training-commands", null);
if (clientTrainingCommands !== null && clientTrainingCommands !== "2") {
  throw new Error("--client-training-commands only supports the explicit value 2");
}
if (clientTrainingCommands === "2" && profile !== "cloud-validation") {
  throw new Error("--client-training-commands 2 is only valid for the cloud-validation profile");
}
const outDir = readArg("--out", "");
if (!outDir) throw new Error("--out is required");
const manifestPath = readArg("--manifest", null);
const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
const rate = Number(readArg("--rate", "5"));
const durationMs = Number(readArg("--duration-ms", "30000"));
const warmupMs = Number(readArg("--warmup-ms", "0"));
const timeoutMs = Number(readArg("--timeout-ms", "30000"));
const identity = {
  serverId: readArg("--server-id", "phase6"),
  athleteId: readArg("--athlete-id", "athlete_1"),
  datasetEpoch: readArg("--dataset-epoch", "phase6")
};

mkdirSync(join(outDir, "raw"), { recursive: true });
mkdirSync(join(outDir, "correctness"), { recursive: true });
const requestsPath = join(outDir, "raw", "requests.jsonl");
const taskEventsPath = join(outDir, "raw", "task-events.jsonl");
const casesPath = join(outDir, "raw", "cases.jsonl");
writeFileSync(requestsPath, "");
writeFileSync(taskEventsPath, "");
writeFileSync(casesPath, "");

const recorder = {
  samples: [],
  taskEvents: [],
  cases: [],
  record(sample) {
    this.samples.push(sample);
    appendLine(requestsPath, sample);
  },
  task(event) {
    const entry = { at: new Date().toISOString(), runId, profile, dataset, scenario, ...event };
    this.taskEvents.push(entry);
    appendLine(taskEventsPath, entry);
  },
  case(entry) {
    const value = { at: new Date().toISOString(), runId, profile, dataset, scenario, ...entry };
    this.cases.push(value);
    appendLine(casesPath, value);
  }
};
const caseFailures = [];

function appendLine(path, value) {
  // 单线程事件循环内 append；一次请求一行，便于逐行复算与 tail。
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "a" });
}

const wall = () => new Date().toISOString();

const businessFields = ["status", "code", "message", "trainingSessionId", "id", "databaseReady", "busy"];
function businessSummary(body) {
  if (body === null || typeof body !== "object") return null;
  const summary = {};
  for (const key of businessFields) if (key in body) summary[key] = body[key];
  if (Array.isArray(body.items)) summary.items = body.items.length;
  if (Array.isArray(body.records)) summary.records = body.records.length;
  if (body.counts && typeof body.counts === "object") summary.counts = body.counts;
  if (body.summary && typeof body.summary === "object") {
    summary.import = {
      status: body.status,
      imported: body.summary.directSync?.records?.parsed ?? null,
      analysisStatus: body.summary.directSync?.analysisStatus ?? null,
      importMode: body.summary.importMode ?? null
    };
  }
  if (body.metadata && typeof body.metadata === "object") {
    summary.metadata = {
      contractVersion: body.metadata.contractVersion ?? null,
      serverId: body.metadata.serverId ?? null,
      athleteId: body.metadata.athleteId ?? null,
      datasetEpoch: body.metadata.datasetEpoch ?? null
    };
  }
  if (body.failureCode !== undefined) summary.failureCode = body.failureCode;
  if (body.performance?.lane && typeof body.performance.lane === "object") {
    summary.lane = {
      outcome: body.performance.lane.outcome ?? null,
      directSource: body.performance.lane.directSource ?? null,
      reasons: Array.isArray(body.performance.lane.reasons) ? [...body.performance.lane.reasons] : []
    };
  }
  if (body.heartRate && typeof body.heartRate === "object") {
    summary.heartRate = { totalSamples: body.heartRate.totalSamples ?? null };
  }
  if (Array.isArray(body.splits)) summary.splits = body.splits.length;
  return summary;
}

/**
 * 发一个请求并记录原始样本。`expectStatus` 是允许的状态集合；oracle 返回
 * {ok, checks}。任何超时/网络错误都记录为样本，不抛出（由场景汇总裁决）。
 */
async function request({
  routeTemplate, path, method = "GET", json = null, form = null, headers = {},
  expectedStatus = [200], oracle = null, scheduledMono = null, scheduledWall = null,
  phase = null, payloadLabel = null, traffic = "main"
}) {
  const scheduledAt = scheduledWall ?? wall();
  const scheduled = scheduledMono ?? performance.now();
  const sentMono = performance.now();
  const requestHeaders = { ...headers };
  let body = null;
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (json !== null) {
    requestHeaders["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== null) {
    body = form;
  }
  const sample = {
    kind: "http",
    runId, profile, dataset, scenario, phase, payloadLabel, traffic,
    routeTemplate, method,
    scheduledAt, sentAt: wall(),
    sendLagMs: round(sentMono - scheduled),
    status: null, businessCode: null, outcome: null,
    expectedStatus: [...expectedStatus],
    bodyBytes: null, clientMs: null, totalMs: null,
    firstByteAt: null, completedAt: null,
    firstByteMs: null, timeout: false, cancelled: false,
    business: null, oracle: null, errorClass: null
  };
  let response;
  let text = "";
  let firstByteMono = null;
  let completedMono = null;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method, headers: requestHeaders, body,
      signal: AbortSignal.timeout(timeoutMs)
    });
    firstByteMono = performance.now();
    sample.firstByteAt = wall();
    const buffer = await response.arrayBuffer();
    completedMono = performance.now();
    sample.completedAt = wall();
    text = Buffer.from(buffer).toString("utf8").slice(0, 2_000_000);
    sample.status = response.status;
    sample.bodyBytes = buffer.byteLength;
    sample.firstByteMs = round(firstByteMono - sentMono);
    sample.clientMs = round(completedMono - sentMono);
    sample.totalMs = round(completedMono - scheduled);
    sample.contentType = response.headers.get("content-type");
  } catch (error) {
    completedMono = performance.now();
    sample.completedAt = wall();
    sample.clientMs = round(completedMono - sentMono);
    sample.totalMs = round(completedMono - scheduled);
    sample.timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    sample.errorClass = error?.name ?? "UnknownError";
    sample.outcome = sample.timeout ? "timeout" : "network_error";
    sample.business = null;
    recorder.record(sample);
    return { sample, body: null, response: null };
  }
  let parsed = null;
  if (text.trim() !== "") {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  sample.business = businessSummary(parsed);
  sample.businessCode = typeof parsed?.code === "string" ? parsed.code : null;
  if (!expectedStatus.includes(sample.status)) {
    sample.outcome = sample.status >= 500 ? "server_error" : "unexpected_status";
  } else if (typeof oracle === "function") {
    const result = oracle(parsed, { response, text });
    sample.oracle = result;
    sample.outcome = result.ok ? "success" : "oracle_failed";
  } else {
    sample.outcome = "success";
  }
  recorder.record(sample);
  return { sample, body: parsed, response };
}

const round = (value) => Math.round(value * 1000) / 1000;

/**
 * Runner 丢弃的到达 tick 也必须成为一条原始样本：只有这样才能进入 offered
 * 分母和 successRate，而不是只留在 task event 的计数器里。它从未发出，因此
 * sentAt/clientMs 为空，且必须带明确 dropReason。
 */
function droppedSample({ routeTemplate, method = "GET", traffic = "main", phase = null, scheduledAt, dropReason }) {
  return {
    kind: "http", runId, profile, dataset, scenario, phase, payloadLabel: null, traffic,
    routeTemplate, method,
    scheduledAt, sentAt: null, sendLagMs: null,
    status: null, businessCode: null, outcome: "runner_dropped",
    expectedStatus: [], bodyBytes: null, clientMs: null, totalMs: null,
    firstByteAt: null, completedAt: null, firstByteMs: null,
    timeout: false, cancelled: false, business: null, oracle: null, errorClass: null,
    dropReason
  };
}

function check(name, ok, expected = null, actual = null) {
  return { name, ok: Boolean(ok), expected, actual };
}

function oracleAll(checks) {
  return { ok: checks.every((item) => item.ok), checks };
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const validWorkoutId = () => manifest?.ids?.newestWorkoutId ?? null;
// 列表的“total”按可读 training_sessions 计：重复来源的 workout 行（is_canonical=0）
// 与软删除训练都不进列表；manifest 的 workouts_visible 是物理行数，不能直接当 total。
const totalWorkouts = () => Number(manifest?.rows?.training_sessions_active ?? manifest?.rows?.workouts_visible ?? 0);

async function scenarioS01() {
  const health = await request({
    routeTemplate: "/v1/health", path: "/v1/health", phase: "startup",
    oracle: (body) => oracleAll([
      check("status ok", body?.status === "ok", "ok", body?.status),
      check("databaseReady", body?.databaseReady === true, true, body?.databaseReady),
      check("serverId", body?.serverId === identity.serverId, identity.serverId, body?.serverId),
      check("datasetEpoch", body?.datasetEpoch === identity.datasetEpoch, identity.datasetEpoch, body?.datasetEpoch)
    ])
  });
  const handshake = await request({
    routeTemplate: "/v1/handshake", path: "/v1/handshake",
    oracle: (body) => oracleAll([
      check("apiVersion", body?.apiVersion === "v1", "v1", body?.apiVersion),
      check("serverId", body?.serverId === identity.serverId, identity.serverId, body?.serverId),
      check("athleteId", body?.athleteId === identity.athleteId, identity.athleteId, body?.athleteId),
      check("epoch", body?.datasetEpoch === identity.datasetEpoch, identity.datasetEpoch, body?.datasetEpoch)
    ])
  });
  const runtime = await request({
    routeTemplate: "/v1/runtime-status", path: "/v1/runtime-status",
    oracle: (body) => oracleAll([
      check("databaseReady", body?.databaseReady === true, true, body?.databaseReady),
      check("busy boolean", typeof body?.busy === "boolean", "boolean", typeof body?.busy)
    ])
  });
  return [health, handshake, runtime];
}

async function scenarioS02() {
  if (manifest === null) throw new Error("S02 requires --manifest");
  const newest = manifest.ids.newestWorkoutId;
  const oldest = manifest.ids.oldestWorkoutId;
  const total = totalWorkouts();
  const middleOffset = Math.max(0, Math.floor(total / 2 / 30) * 30);
  const lastOffset = Math.max(0, Math.floor((total - 1) / 30) * 30);
  const requests = [];
  requests.push(await request({
    routeTemplate: "/v1/dashboard", path: "/v1/dashboard",
    oracle: (body) => oracleAll([
      check("has latestWorkout", body?.latestWorkout != null, "object", body?.latestWorkout === null ? "null" : "object")
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/workouts", path: "/v1/workouts?limit=30&offset=0", phase: "page:first",
    oracle: (body) => oracleAll([
      check("items length", Array.isArray(body?.items) && body.items.length === Math.min(30, total), Math.min(30, total), body?.items?.length ?? null),
      check("newest first", body?.items?.[0]?.id === newest, newest, body?.items?.[0]?.id ?? null),
      check("descending", isDescending(body?.items ?? []), true, isDescending(body?.items ?? []))
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/workouts", path: `/v1/workouts?limit=30&offset=${middleOffset}`, phase: "page:middle",
    oracle: (body) => oracleAll([
      check("middle has items", Array.isArray(body?.items) && body.items.length > 0, ">0", body?.items?.length ?? null),
      check("total", body?.total === total, total, body?.total ?? null)
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/workouts", path: `/v1/workouts?limit=30&offset=${lastOffset}`, phase: "page:last",
    oracle: (body) => oracleAll([
      check("last has items", Array.isArray(body?.items) && body.items.length > 0, ">0", body?.items?.length ?? null),
      check("oldest last", body?.items?.at(-1)?.id === oldest, oldest, body?.items?.at(-1)?.id ?? null)
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/workouts/:id", path: `/v1/workouts/${newest}`,
    oracle: (body) => oracleAll([
      check("id", body?.workout?.id === newest, newest, body?.workout?.id ?? null),
      check("analysis status present", typeof body?.workout?.analysisPublishStatus === "string", "string", typeof body?.workout?.analysisPublishStatus)
    ])
  }));
  if (manifest.ids.deletedWorkoutId) {
    requests.push(await request({
      routeTemplate: "/v1/workouts/:id", path: `/v1/workouts/${manifest.ids.deletedWorkoutId}`,
      expectedStatus: [404], phase: "deleted:404",
      oracle: (body) => oracleAll([
        check("deleted is 404 not fake success", body?.message !== undefined || body?.code !== undefined, "error body", JSON.stringify(body).slice(0, 80))
      ])
    }));
  }
  requests.push(await request({
    routeTemplate: "/v1/mobile/today", path: "/v1/mobile/today",
    oracle: (body) => oracleAll([
      check("today object", body?.today != null, "object", typeof body?.today),
      check("timezone", typeof body?.timezone === "string", "string", typeof body?.timezone)
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/mobile/training-plan-state", path: "/v1/mobile/training-plan-state",
    oracle: (body) => oracleAll([
      check("contractVersion", body?.metadata?.contractVersion === 1, 1, body?.metadata?.contractVersion ?? null),
      check("serverId", body?.metadata?.serverId === identity.serverId, identity.serverId, body?.metadata?.serverId ?? null)
    ])
  }));
  return requests;
}

/** 合成数据里窗口内可能混入其它同类型样本；允许少量上浮，但不允许空集。 */
function withinSeriesSamples(actual, expected) {
  return Number.isInteger(actual) && actual >= expected && actual <= expected + 64;
}

function isDescending(items) {
  for (let index = 1; index < items.length; index += 1) {
    if (String(items[index - 1]?.startedAt) < String(items[index]?.startedAt)) return false;
  }
  return true;
}

async function scenarioS03() {
  if (manifest === null) throw new Error("S03 requires --manifest");
  const requests = [];
  for (const tier of ["small", "medium", "large"]) {
    const id = manifest.ids.series[tier];
    if (!id) continue;
    const expectedSamples = manifest.ids.seriesTiers?.[tier]?.heartRateSamples ?? null;
    requests.push(await request({
      routeTemplate: "/v1/health", path: "/v1/health", phase: `series:${tier}:health-before`
    }));
    const cold = await request({
      routeTemplate: "/v1/workouts/:id/series", path: `/v1/workouts/${id}/series`, phase: `series:${tier}:cold`,
      oracle: (body) => oracleAll([
        check("trainingSessionId", body?.trainingSessionId === id, id, body?.trainingSessionId ?? null),
        check("heartRate samples", expectedSamples === null || withinSeriesSamples(body?.series?.heartRate?.totalSamples, expectedSamples),
          expectedSamples, body?.series?.heartRate?.totalSamples ?? null),
        check("splits array", Array.isArray(body?.splits), "array", Array.isArray(body?.splits))
      ])
    });
    requests.push(cold);
    for (let hot = 0; hot < 3; hot += 1) {
      requests.push(await request({
        routeTemplate: "/v1/workouts/:id/series", path: `/v1/workouts/${id}/series`, phase: `series:${tier}:hot-${hot + 1}`,
        oracle: (body) => oracleAll([
          check("trainingSessionId", body?.trainingSessionId === id, id, body?.trainingSessionId ?? null),
          check("heartRate samples", expectedSamples === null || withinSeriesSamples(body?.series?.heartRate?.totalSamples, expectedSamples),
            expectedSamples, body?.series?.heartRate?.totalSamples ?? null)
        ])
      }));
      requests.push(await request({
        routeTemplate: "/v1/health", path: "/v1/health", phase: `series:${tier}:health-after-${hot + 1}`
      }));
    }
  }
  return requests;
}

async function scenarioS04() {
  const requests = [];
  requests.push(await request({
    routeTemplate: "/v1/data-summary", path: "/v1/data-summary",
    oracle: (body) => oracleAll([
      check("healthRecords", Number(body?.counts?.healthRecords ?? -1) >= Number(manifest?.rows?.health_records ?? 0),
        `>=${manifest?.rows?.health_records ?? 0}`, body?.counts?.healthRecords ?? null),
      check("workouts", Number(body?.counts?.workouts ?? -1) >= Number(manifest?.rows?.training_sessions_active ?? 0),
        `>=${manifest?.rows?.training_sessions_active ?? 0}`, body?.counts?.workouts ?? null)
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/data-audit", path: "/v1/data-audit",
    oracle: (body) => oracleAll([
      check("audit object", body !== null && typeof body === "object", "object", typeof body)
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/diagnostics", path: "/v1/diagnostics",
    oracle: (body) => oracleAll([
      check("diagnostics object", body !== null && typeof body === "object", "object", typeof body),
      check("generatedAt", typeof body?.generatedAt === "string", "string", typeof body?.generatedAt)
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/performance", path: "/v1/performance",
    oracle: (body) => oracleAll([
      check("eventLoopP95Ms number", typeof body?.eventLoopP95Ms === "number", "number", typeof body?.eventLoopP95Ms),
      check("requests number", typeof body?.requests === "number", "number", typeof body?.requests)
    ])
  }));
  return requests;
}

async function scenarioS10() {
  const requests = [];
  requests.push(await request({
    routeTemplate: "/v1/dashboard", path: "/v1/dashboard",
    oracle: (body) => oracleAll([
      check("active model published", body?.activeModel != null, "object", body?.activeModel == null ? "null" : "object")
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/model-runs", path: "/v1/model-runs",
    oracle: (body) => oracleAll([
      check("model runs present", Array.isArray(body?.runs) ? body.runs.length > 0 : Array.isArray(body) ? body.length > 0 : false,
        ">0", Array.isArray(body?.runs) ? body.runs.length : Array.isArray(body) ? body.length : 0)
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/workouts", path: "/v1/workouts?limit=100",
    oracle: (body) => {
      const items = body?.items ?? [];
      const published = items.filter((item) => item.analysisPublishStatus === "published").length;
      return oracleAll([
        check("published analyses", published > 0, ">0", published),
        check("no failed analysis", items.every((item) => item.analysisPublishStatus !== "failed"), true,
          items.filter((item) => item.analysisPublishStatus === "failed").length)
      ]);
    }
  }));
  requests.push(await request({
    routeTemplate: "/v1/data-summary", path: "/v1/data-summary",
    oracle: (body) => oracleAll([
      check("assessments > 0", Number(body?.counts?.assessments ?? 0) > 0, ">0", body?.counts?.assessments ?? 0)
    ])
  }));
  return requests;
}

async function scenarioS12() {
  const requests = [];
  const validation = clientTrainingCommands === "2";
  const commandHeaders = validation ? { "x-rai-client-training-commands": "2" } : {};
  requests.push(await request({
    routeTemplate: "/v1/handshake", path: "/v1/handshake", headers: commandHeaders,
    oracle: (body) => oracleAll([
      validation
        ? check("validation mode advertises command contract", body?.trainingPlanCommandContractVersion === 2,
          2, body?.trainingPlanCommandContractVersion ?? null)
        : check("default mode does not advertise command contract", body?.trainingPlanCommandContractVersion === undefined,
          "undefined", String(body?.trainingPlanCommandContractVersion))
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/mobile/workout-plan", path: "/v1/mobile/workout-plan",
    oracle: (body) => oracleAll([
      check("workout-plan object", body !== null && typeof body === "object", "object", typeof body)
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/mobile/training-plan-state", path: "/v1/mobile/training-plan-state",
    oracle: (body) => oracleAll([
      check("contractVersion 1", body?.metadata?.contractVersion === 1, 1, body?.metadata?.contractVersion ?? null)
    ])
  }));
  requests.push(await request({
    routeTemplate: "/v1/mobile/todaysession", path: "/v1/mobile/today",
    oracle: (body) => oracleAll([check("today", body?.today != null, "object", typeof body?.today)])
  }));
  if (!validation) return requests;

  // CLOUD-VALIDATION：证明声明的候选写能力真的可执行，而不是只读取。
  // preview 不落库；submit 才是持久写。两者都必须带客户端合同头，且 scope 与
  // API 身份一致；迁移夹具未就绪时这里会明确失败，而不是把只读当通过。
  const readState = () => request({
    routeTemplate: "/v1/mobile/training-plan-state", path: "/v1/mobile/training-plan-state",
    headers: { "x-rai-training-contract": "2", ...commandHeaders },
    oracle: (body) => oracleAll([
      check("v2 contractVersion", body?.contractVersion === 2, 2, body?.contractVersion ?? null),
      check("scope serverId", body?.scope?.serverId === identity.serverId, identity.serverId, body?.scope?.serverId ?? null),
      check("scope athleteId", body?.scope?.athleteId === identity.athleteId, identity.athleteId, body?.scope?.athleteId ?? null),
      check("scope datasetEpoch", body?.scope?.datasetEpoch === identity.datasetEpoch, identity.datasetEpoch,
        body?.scope?.datasetEpoch ?? null),
      check("stateRevision number", Number.isInteger(body?.stateRevision), "integer", body?.stateRevision ?? null)
    ])
  });
  const state = await readState();
  requests.push(state);
  const operationScope = state.body?.scope ?? {
    serverId: identity.serverId, athleteId: identity.athleteId, datasetEpoch: identity.datasetEpoch
  };
  const expectedStateRevision = state.body?.stateRevision;
  // 180 天后的本地日期，避免随运行日期变成过去。
  const raceDate = new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10);
  const raceGoal = { date: raceDate, distanceKm: 21.0975, goal: "time", targetTimeSeconds: 6300 };
  const preview = await request({
    routeTemplate: "/v1/mobile/training-plan/commands/preview",
    path: "/v1/mobile/training-plan/commands/preview", method: "POST", headers: commandHeaders,
    json: { contractVersion: 2, operationScope, action: "set_race_goal", expectedStateRevision, raceGoal },
    oracle: (body) => oracleAll([
      check("preview contractVersion", body?.contractVersion === 2, 2, body?.contractVersion ?? null),
      check("candidateId", typeof body?.candidateId === "string", "string", body?.candidateId ?? null),
      check("preview expectedStateRevision", body?.expectedStateRevision === expectedStateRevision,
        expectedStateRevision, body?.expectedStateRevision ?? null),
      check("preview requires plan refresh", body?.planRefreshRequired === true, true, body?.planRefreshRequired ?? null)
    ])
  });
  requests.push(preview);
  if (preview.sample.status === 200 && typeof preview.body?.candidateId === "string") {
    const operationId = randomUUID();
    const submit = await request({
      routeTemplate: "/v1/mobile/training-plan/commands",
      path: "/v1/mobile/training-plan/commands", method: "POST", headers: commandHeaders,
      json: {
        contractVersion: 2, operationId, operationScope, expectedStateRevision,
        candidateId: preview.body.candidateId, action: "set_race_goal", raceGoal
      },
      oracle: (body) => oracleAll([
        check("command contractVersion", body?.contractVersion === 2, 2, body?.contractVersion ?? null),
        check("operationId echo", body?.operationId === operationId, operationId, body?.operationId ?? null),
        check("stateRevision advanced", Number(body?.stateRevision) > Number(expectedStateRevision), ">stateRevision",
          body?.stateRevision ?? null),
        check("race goal persisted", body?.after?.raceGoal?.date === raceDate, raceDate,
          body?.after?.raceGoal?.date ?? null)
      ])
    });
    requests.push(submit);
    // 写后读回：同一份 v2 状态必须已经反映刚提交的目标。
    requests.push(await request({
      routeTemplate: "/v1/mobile/training-plan-state", path: "/v1/mobile/training-plan-state",
      headers: { "x-rai-training-contract": "2", ...commandHeaders },
      oracle: (body) => oracleAll([
        check("readback contractVersion", body?.contractVersion === 2, 2, body?.contractVersion ?? null),
        check("readback race goal", body?.raceGoal?.date === raceDate, raceDate, body?.raceGoal?.date ?? null)
      ])
    }));
  }
  return requests;
}

/** S13：固定到达率 open-loop 混合读；在途用可删除的 Set，主/health 各自调度。 */
async function scenarioS13() {
  const expectedHealthRecords = Number(manifest?.rows?.health_records ?? 0);
  const writeTarget = (tickIndex) => {
    const localDate = new Date(Date.UTC(2010, 0, 1) + Math.floor(tickIndex / 5) * 86_400_000)
      .toISOString().slice(0, 10);
    return {
      routeTemplate: "/v1/performance-entries", path: "/v1/performance-entries",
      method: "POST", json: { localDate, distance: "ten_k", durationSeconds: 2400 },
      writeReadback: true,
      oracle: (body) => oracleAll([
        check("entry persisted", typeof body?.id === "string", "id", body?.id ?? null),
        check("entry date", body?.localDate === localDate, localDate, body?.localDate ?? null)
      ])
    };
  };
  // S13 的每个读请求都必须有业务 oracle：HTTP 200 加 `{"status":"ok"}` 不是
  // 有效业务响应。池内路由检查身份/形状/非空结果，失败会进入 correctness。
  const pool = [
    {
      routeTemplate: "/v1/workouts", path: "/v1/workouts?limit=30&offset=0", weight: 25,
      oracle: (body) => oracleAll([
        check("workouts items array", Array.isArray(body?.items), "array", Array.isArray(body?.items)),
        check("workouts non-empty", Array.isArray(body?.items) && body.items.length > 0, ">0", body?.items?.length ?? null),
        check("workouts total", Number(body?.total) >= (body?.items?.length ?? 0), ">=items", body?.total ?? null),
        check("workouts descending", isDescending(body?.items ?? []), true, isDescending(body?.items ?? []))
      ])
    },
    {
      routeTemplate: "/v1/dashboard", path: "/v1/dashboard", weight: 20,
      oracle: (body) => oracleAll([
        check("dashboard latestWorkout", body?.latestWorkout != null, "object",
          body?.latestWorkout === null ? "null" : typeof body?.latestWorkout)
      ])
    },
    {
      routeTemplate: "/v1/mobile/today", path: "/v1/mobile/today", weight: 20,
      oracle: (body) => oracleAll([
        check("today object", body?.today != null, "object", typeof body?.today),
        check("today timezone", typeof body?.timezone === "string", "string", typeof body?.timezone)
      ])
    },
    {
      routeTemplate: "/v1/mobile/training-plan-state", path: "/v1/mobile/training-plan-state", weight: 15,
      oracle: (body) => oracleAll([
        check("plan contractVersion", body?.metadata?.contractVersion === 1, 1,
          body?.metadata?.contractVersion ?? null),
        check("plan serverId", body?.metadata?.serverId === identity.serverId, identity.serverId,
          body?.metadata?.serverId ?? null)
      ])
    },
    {
      routeTemplate: "/v1/data-summary", path: "/v1/data-summary", weight: 5,
      oracle: (body) => oracleAll([
        check("summary healthRecords number", typeof body?.counts?.healthRecords === "number", "number",
          typeof body?.counts?.healthRecords),
        check("summary healthRecords >= fixture", expectedHealthRecords === 0
          || Number(body?.counts?.healthRecords ?? -1) >= expectedHealthRecords, `>=${expectedHealthRecords}`,
        body?.counts?.healthRecords ?? null)
      ])
    }
  ];
  if (manifest?.ids?.series) {
    const seriesId = manifest.ids.series.small;
    pool.push({
      routeTemplate: "/v1/workouts/:id/series", path: `/v1/workouts/${seriesId}/series`, weight: 15,
      oracle: (body) => oracleAll([
        check("series trainingSessionId", body?.trainingSessionId === seriesId, seriesId,
          body?.trainingSessionId ?? null),
        check("series heartRate samples", Number(body?.series?.heartRate?.totalSamples ?? 0) > 0, ">0",
          body?.series?.heartRate?.totalSamples ?? null)
      ])
    });
  }
  const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
  const sequence = [];
  // 先构造确定性的加权序列：同一 seed/权重 = 同一请求顺序。
  const random = seededRandom(20261024);
  for (let index = 0; index < 100_000; index += 1) {
    let roll = random() * totalWeight;
    let chosen = pool[0];
    for (const item of pool) {
      roll -= item.weight;
      if (roll <= 0) { chosen = item; break; }
    }
    sequence.push(chosen);
  }

  const startedMono = performance.now();
  const startedWallMs = Date.parse(new Date().toISOString());
  const warmupEnd = startedMono + warmupMs;
  const end = startedMono + warmupMs + durationMs;
  const totalMs = warmupMs + durationMs;
  const interval = 1_000 / rate;
  const maxInFlight = Math.max(1, Number(readArg("--max-in-flight", "64")));
  // 并发上限策略：主请求最多 maxInFlight-1，health 保留 1 个槽位；合计永不超过 maxInFlight。
  const mainCap = Math.max(1, maxInFlight - 1);
  const healthCap = maxInFlight;

  const counters = {
    mainOffered: 0, mainSent: 0, mainCompleted: 0, mainDropped: 0, mainCancelled: 0, mainStillInFlight: 0,
    mainDroppedCapacity: 0, mainDroppedWindow: 0,
    healthOffered: 0, healthSent: 0, healthCompleted: 0, healthDropped: 0, healthCancelled: 0, healthStillInFlight: 0,
    healthDroppedCapacity: 0, healthDroppedWindow: 0,
    peakInFlight: 0, peakMainInFlight: 0, peakHealthInFlight: 0,
    http503: 0, timeout: 0, oracleFailure: 0,
    writeSent: 0, writeSuccessful: 0,
    writeReadbackSent: 0, writeReadbackCompleted: 0, writeReadbackSuccessful: 0, writeReadbackFailed: 0
  };
  const phaseCounters = {
    warmup: {
      mainOffered: 0, mainSent: 0, mainCompleted: 0, mainDropped: 0,
      healthOffered: 0, healthSent: 0, healthCompleted: 0, healthDropped: 0,
      writeReadbackSent: 0, writeReadbackSuccessful: 0
    },
    steady: {
      mainOffered: 0, mainSent: 0, mainCompleted: 0, mainDropped: 0,
      healthOffered: 0, healthSent: 0, healthCompleted: 0, healthDropped: 0,
      writeReadbackSent: 0, writeReadbackSuccessful: 0
    }
  };
  const inFlight = new Set();
  let stopping = false;
  let interruptedSignal = null;
  const onSignal = (signal) => { interruptedSignal = signal; stopping = true; };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const phaseAt = (mono) => (mono < warmupEnd ? "warmup" : "steady");
  const wallAt = (mono) => new Date(startedWallMs + (mono - startedMono)).toISOString();
  const healthTarget = {
    routeTemplate: "/v1/health", path: "/v1/health",
    oracle: (body) => oracleAll([
      check("health status", body?.status === "ok", "ok", body?.status ?? null),
      check("health databaseReady", body?.databaseReady === true, true, body?.databaseReady ?? null),
      check("health serverId", body?.serverId === identity.serverId, identity.serverId, body?.serverId ?? null)
    ])
  };

  function noteTerminal(prefix, sample, phase) {
    counters[`${prefix}Completed`] += 1;
    phaseCounters[phase][`${prefix}Completed`] += 1;
    if (sample.status === 503) counters.http503 += 1;
    if (sample.timeout === true) counters.timeout += 1;
    if (sample.outcome === "oracle_failed") counters.oracleFailure += 1;
    if (sample.routeTemplate === "/v1/performance-entries" && sample.outcome === "success") {
      counters.writeSuccessful += 1;
    }
  }

  /**
   * 写入后的持久化读回：POST 只证明服务端回了 200，不能证明条目真的可见。
   * 读回样本单独记为 traffic=write-readback；它不是一次新的到达，因此不进入
   * mainOffered/mainSent 分母，但失败会让 driver 非 0、G4 FAIL。
   */
  async function readBackWrite({ id, localDate, phase, scheduledMono }) {
    counters.writeReadbackSent += 1;
    phaseCounters[phase].writeReadbackSent += 1;
    const result = await request({
      routeTemplate: "/v1/performance-entries", path: "/v1/performance-entries",
      phase, traffic: "write-readback", scheduledMono, scheduledWall: wallAt(scheduledMono),
      oracle: (body) => {
        const entries = Array.isArray(body?.entries) ? body.entries : [];
        const found = entries.find((entry) => entry?.id === id);
        return oracleAll([
          check("readback entry id", found !== undefined, id, found?.id ?? null),
          check("readback entry date", found?.localDate === localDate, localDate, found?.localDate ?? null)
        ]);
      }
    });
    counters.writeReadbackCompleted += 1;
    if (result.sample.outcome === "success") {
      counters.writeReadbackSuccessful += 1;
      phaseCounters[phase].writeReadbackSuccessful += 1;
    } else {
      counters.writeReadbackFailed += 1;
    }
  }

  function recordDrop({ target, traffic, phase, scheduledMono, dropReason }) {
    recorder.record(droppedSample({
      routeTemplate: target.routeTemplate,
      method: target.method ?? "GET",
      traffic,
      phase,
      scheduledAt: wallAt(scheduledMono),
      dropReason
    }));
  }

  function send({ target, traffic, phase, scheduledMono }) {
    const prefix = traffic === "health" ? "health" : "main";
    const cap = traffic === "health" ? healthCap : mainCap;
    counters[`${prefix}Offered`] += 1;
    phaseCounters[phase][`${prefix}Offered`] += 1;
    if (stopping) {
      // 已投放但尚未发送的 tick：计入 dropped（不是静默跳过），并留下原始样本。
      counters[`${prefix}Dropped`] += 1;
      counters[`${prefix}DroppedWindow`] += 1;
      phaseCounters[phase][`${prefix}Dropped`] += 1;
      recordDrop({ target, traffic, phase, scheduledMono, dropReason: "stopping" });
      return;
    }
    if (inFlight.size >= cap) {
      counters[`${prefix}Dropped`] += 1;
      counters[`${prefix}DroppedCapacity`] += 1;
      phaseCounters[phase][`${prefix}Dropped`] += 1;
      recordDrop({ target, traffic, phase, scheduledMono, dropReason: "capacity" });
      return;
    }
    counters[`${prefix}Sent`] += 1;
    if (target.method === "POST") counters.writeSent += 1;
    phaseCounters[phase][`${prefix}Sent`] += 1;
    const promise = (async () => {
      const result = await request({
        ...target, phase, traffic, scheduledMono, scheduledWall: wallAt(scheduledMono)
      });
      noteTerminal(prefix, result.sample, phase);
      if (target.writeReadback === true && result.sample.outcome === "success"
          && typeof result.body?.id === "string") {
        await readBackWrite({
          id: result.body.id,
          localDate: target.json?.localDate ?? null,
          phase,
          scheduledMono
        });
      }
    })().catch(() => {
      // request() 已把超时/网络错误记录成样本；这里只保证在途集合一定收敛。
      counters[`${prefix}Completed`] += 1;
      phaseCounters[phase][`${prefix}Completed`] += 1;
    });
    inFlight.add(promise);
    counters.peakInFlight = Math.max(counters.peakInFlight, inFlight.size);
    const peakKey = traffic === "health" ? "peakHealthInFlight" : "peakMainInFlight";
    counters[peakKey] = Math.max(counters[peakKey], inFlight.size);
    void promise.finally(() => { inFlight.delete(promise); });
  }

  async function runMain() {
    let index = 0;
    while (!stopping && index * interval < totalMs) {
      const tick = startedMono + index * interval;
      const now = performance.now();
      if (tick > now) {
        await sleep(Math.min(tick - now, 25));
        continue;
      }
      const tickIndex = index;
      index += 1;
      const phase = phaseAt(tick);
      const target = tickIndex % 5 === 0 ? writeTarget(tickIndex) : sequence[tickIndex % sequence.length];
      if (now >= end) {
        // 到达时已过正式窗口：仍计入 offered，明确归为 runnerDropped(window)。
        counters.mainOffered += 1;
        phaseCounters[phase].mainOffered += 1;
        counters.mainDropped += 1;
        counters.mainDroppedWindow += 1;
        phaseCounters[phase].mainDropped += 1;
        recordDrop({ target, traffic: "main", phase, scheduledMono: tick, dropReason: "window" });
        continue;
      }
      send({ target, traffic: "main", phase, scheduledMono: tick });
    }
  }

  async function runHealth() {
    let index = 0;
    while (!stopping && index * 1_000 < totalMs) {
      const tick = startedMono + index * 1_000;
      const now = performance.now();
      if (tick > now) {
        await sleep(Math.min(tick - now, 100));
        continue;
      }
      index += 1;
      const phase = phaseAt(tick);
      if (now >= end) {
        counters.healthOffered += 1;
        phaseCounters[phase].healthOffered += 1;
        counters.healthDropped += 1;
        counters.healthDroppedWindow += 1;
        phaseCounters[phase].healthDropped += 1;
        recordDrop({
          target: { routeTemplate: "/v1/health" }, traffic: "health", phase,
          scheduledMono: tick, dropReason: "window"
        });
        continue;
      }
      send({ target: healthTarget, traffic: "health", phase, scheduledMono: tick });
    }
  }

  try {
    await Promise.all([runMain(), runHealth()]);
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  counters.mainStillInFlight = 0;
  counters.healthStillInFlight = 0;
  if (interruptedSignal !== null) driverInterrupted = interruptedSignal;

  const conservation = {
    main: counters.mainOffered === counters.mainSent + counters.mainDropped,
    health: counters.healthOffered === counters.healthSent + counters.healthDropped,
    mainSent: counters.mainSent === counters.mainCompleted + counters.mainCancelled + counters.mainStillInFlight,
    healthSent: counters.healthSent === counters.healthCompleted + counters.healthCancelled + counters.healthStillInFlight,
    combinedOffered: counters.mainOffered + counters.healthOffered
      === counters.mainSent + counters.healthSent + counters.mainDropped + counters.healthDropped
  };
  recorder.task({
    type: "s13_load_shape",
    rate, durationMs, warmupMs, maxInFlight, mainCap, healthCap,
    mainOffered: counters.mainOffered, mainSent: counters.mainSent, mainCompleted: counters.mainCompleted,
    mainDropped: counters.mainDropped, mainStillInFlight: counters.mainStillInFlight, mainCancelled: counters.mainCancelled,
    healthOffered: counters.healthOffered, healthSent: counters.healthSent, healthCompleted: counters.healthCompleted,
    healthDropped: counters.healthDropped, healthStillInFlight: counters.healthStillInFlight, healthCancelled: counters.healthCancelled,
    peakInFlight: counters.peakInFlight, peakMainInFlight: counters.peakMainInFlight, peakHealthInFlight: counters.peakHealthInFlight,
    http503: counters.http503, timeout: counters.timeout, oracleFailure: counters.oracleFailure,
    writeSent: counters.writeSent, writeSuccessful: counters.writeSuccessful,
    writeReadbackSent: counters.writeReadbackSent, writeReadbackCompleted: counters.writeReadbackCompleted,
    writeReadbackSuccessful: counters.writeReadbackSuccessful, writeReadbackFailed: counters.writeReadbackFailed,
    mainDroppedCapacity: counters.mainDroppedCapacity, mainDroppedWindow: counters.mainDroppedWindow,
    healthDroppedCapacity: counters.healthDroppedCapacity, healthDroppedWindow: counters.healthDroppedWindow,
    droppedCapacity: counters.mainDroppedCapacity, droppedWindow: counters.mainDroppedWindow,
    phaseCounters, conservation,
    incomplete: interruptedSignal !== null,
    // 兼容旧读法；新报告必须使用上面的拆分字段。
    offered: counters.mainOffered + counters.healthOffered,
    completed: counters.mainCompleted + counters.healthCompleted,
    dropped: counters.mainDropped + counters.healthDropped
  });
  return recorder.samples;
}

/** S14：series 过载探索。并发压到 worker 准入上限附近，观察拒绝合同与 /health。 */
async function scenarioS14() {
  if (manifest?.ids?.series?.large == null) throw new Error("S14 requires a series fixture");
  const id = manifest.ids.series.large;
  const concurrency = Number(readArg("--concurrency", "80"));
  const healthBefore = [];
  const healthProbe = setInterval(() => {
    void request({ routeTemplate: "/v1/health", path: "/v1/health", phase: "overload:health", traffic: "health" })
      .then((result) => healthBefore.push(result.sample));
  }, 100);
  const samples = await Promise.all(Array.from({ length: concurrency }, (_, index) =>
    request({
      routeTemplate: "/v1/workouts/:id/series", path: `/v1/workouts/${id}/series`,
      phase: `overload:${index}`, expectedStatus: [200, 503],
      oracle: (body, meta) => oracleAll([
        check("200 or explicit 503", [200, 503].includes(meta.response.status), "200|503", meta.response.status),
        ...(meta.response.status === 503 ? [check("overload code", body?.code === "series_read_overloaded", "series_read_overloaded", body?.code ?? null)] : [])
      ])
    }).then((result) => result.sample)
  ));
  clearInterval(healthProbe);
  await sleep(200);
  const overloaded = samples.filter((sample) => sample.status === 503).length;
  recorder.task({
    type: "s14_overload_shape", concurrency,
    succeeded: samples.length - overloaded, overloaded,
    healthSamples: healthBefore.length
  });
  return [...samples, ...healthBefore];
}

// ---------------------------------------------------------------------------
// 导入场景 S05–S09
// ---------------------------------------------------------------------------

async function uploadPayload(zipPath, batchId, { allowRejection = false, label = null } = {}) {
  const bytes = readFileSync(zipPath);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/zip" }), "apple-health-healthkit-phase6.zip");
  return request({
    routeTemplate: "/v1/imports/uploads", path: "/v1/imports/uploads", method: "POST", form,
    headers: { "x-rai-sync-batch": batchId }, expectedStatus: [200, 400, 413, 415, 422], payloadLabel: label,
    oracle: (body, meta) => oracleAll([
      allowRejection
        ? check("upload accepted or stable 4xx", meta.response.status === 200 || (meta.response.status >= 400 && meta.response.status < 500),
          "200|4xx", meta.response.status)
        : check("upload accepted", meta.response.status === 200, 200, meta.response.status),
      ...(meta.response.status >= 400 ? [check("stable error code", typeof body?.code === "string", "string", typeof body?.code)] : [])
    ])
  });
}

async function pollImportJob(jobId) {
  const deadline = Date.now() + Math.max(30_000, timeoutMs);
  let terminal = null;
  let polls = 0;
  while (Date.now() < deadline) {
    const poll = await request({
      routeTemplate: "/v1/import-jobs/:id", path: `/v1/import-jobs/${jobId}`, phase: "poll",
      expectedStatus: [200, 404],
      oracle: (body) => oracleAll([check("job visible", body !== null && typeof body === "object", "object", typeof body)])
    });
    polls += 1;
    if (poll.body === null) break;
    if (["succeeded", "failed", "cancelled"].includes(poll.body.status)) { terminal = poll; break; }
    await sleep(100);
  }
  if (terminal === null) {
    throw new Error(`import job ${jobId} did not reach a terminal state within budget (${polls} polls)`);
  }
  return { terminal, polls };
}

async function runImportJob(sourceId, batchId, { allowRefusal = false, label = null } = {}) {
  const inspect = await request({
    routeTemplate: "/v1/imports/inspect", path: "/v1/imports/inspect", method: "POST", json: { sourceId },
    expectedStatus: [200, 400, 409, 422], payloadLabel: label,
    oracle: (body, meta) => oracleAll([
      allowRefusal
        ? check("inspect ready|unchanged|stable refusal", meta.response.status === 200
          ? ["ready", "unchanged"].includes(body?.status)
          : (meta.response.status >= 400 && meta.response.status < 500 && typeof body?.code === "string"),
          "ready|unchanged|4xx", body?.status ?? body?.code ?? String(meta.response.status))
        : check("inspect ready|unchanged", meta.response.status === 200 && ["ready", "unchanged"].includes(body?.status),
          "ready|unchanged", body?.status ?? String(meta.response.status))
    ])
  });
  if (inspect.sample.status !== 200) return { inspect, job: null };
  // unchanged = 原字节/同身份重放，服务端明确回答“不需要再导入”，不得伪造成一个成功任务。
  if (inspect.body?.status === "unchanged") return { inspect, job: null };
  const created = await request({
    routeTemplate: "/v1/import-jobs", path: "/v1/import-jobs", method: "POST", json: { sourceId },
    expectedStatus: [202, 400, 409, 422], payloadLabel: label,
    oracle: (body, meta) => oracleAll([
      check("job accepted", meta.response.status === 202, 202, meta.response.status),
      check("job id", typeof body?.id === "string", "string", typeof body?.id)
    ])
  });
  if (created.sample.status !== 202) return { inspect, job: created };
  const jobId = created.body.id;
  recorder.task({ type: "import_job_created", batchId, sourceId, jobId, status: created.body.status, phase: created.body.phase });
  const { terminal, polls } = await pollImportJob(jobId);
  recorder.task({
    type: "import_job_terminal", batchId, sourceId, jobId, status: terminal.body.status,
    phase: terminal.body.phase, summary: terminal.body.summary ?? null,
    error: terminal.body.error ?? null, polls
  });
  return { inspect, job: terminal, jobId };
}

async function dataSummarySnapshot() {
  const result = await request({ routeTemplate: "/v1/data-summary", path: "/v1/data-summary" });
  return result.body?.counts ?? null;
}

async function scenarioS05() {
  const entries = manifest?.payloads?.filter((payload) => payload.kind === "record-only" && /小批|中批|近记录上限/.test(payload.label)) ?? [];
  if (entries.length !== 3) throw new Error("S05 requires small/medium/near-limit payloads in DX manifest");
  const before = await dataSummarySnapshot();
  const results = [];
  let previousHealthRecords = before?.healthRecords ?? 0;
  for (const [index, entry] of entries.entries()) {
    const batchId = `phase6-s05-${Date.now()}-${index}`;
    const upload = await uploadPayload(entry.path, batchId);
    if (upload.sample.status !== 200) { results.push(upload); continue; }
    const { inspect, job } = await runImportJob(upload.body.sourceId, batchId);
    const afterJob = await dataSummarySnapshot();
    const delta = (afterJob?.healthRecords ?? 0) - previousHealthRecords;
    previousHealthRecords = afterJob?.healthRecords ?? previousHealthRecords;
    const expectedRecords = [100, 2500, 4990][index];
    job.sample.oracle = oracleAll([
      check("job succeeded", job.body?.status === "succeeded", "succeeded", job.body?.status ?? null),
      check("facts inserted", delta === expectedRecords, expectedRecords, delta),
      check("analysis registered", ["queued", "not_required"].includes(job.body?.summary?.directSync?.analysisStatus),
        "queued|not_required", job.body?.summary?.directSync?.analysisStatus ?? null)
    ]);
    job.sample.outcome = job.sample.oracle.ok ? "success" : "oracle_failed";
    results.push(upload, inspect, job);
  }
  const after = await dataSummarySnapshot();
  recorder.task({ type: "s05_summary", before, after });
  return results;
}

async function scenarioS06() {
  const entry = manifest?.payloads?.find((payload) => payload.kind === "record-only" && /小批/.test(payload.label));
  if (!entry) throw new Error("S06 requires the small payload");
  const results = [];
  const before = await dataSummarySnapshot();
  const batchId = `phase6-s06-${Date.now()}`;
  const first = await runImportJob((await uploadPayload(entry.path, batchId)).body.sourceId, batchId);
  results.push(first.inspect, first.job);
  const afterFirst = await dataSummarySnapshot();
  // 同包重复（相同 batch id 的原字节重放）。上传层可能按批次身份返回已有 source；无论哪种都必须不再新增事实。
  const replayUpload = await uploadPayload(entry.path, batchId);
  results.push(replayUpload);
  if (replayUpload.sample.status === 200) {
    const replay = await runImportJob(replayUpload.body.sourceId, batchId);
    results.push(replay.inspect, replay.job);
  }
  const afterReplay = await dataSummarySnapshot();
  // 相同内容、不同上传身份：事实仍不得重复。
  const otherBatch = `${batchId}-other`;
  const otherUpload = await uploadPayload(entry.path, otherBatch);
  results.push(otherUpload);
  if (otherUpload.sample.status === 200) {
    const other = await runImportJob(otherUpload.body.sourceId, otherBatch);
    results.push(other.inspect, other.job ?? { synthetic: true, unchanged: true });
  }
  const afterOther = await dataSummarySnapshot();
  const noDuplicateHealthRecords = afterReplay.healthRecords === afterFirst.healthRecords
    && afterOther.healthRecords === afterFirst.healthRecords;
  const noDuplicateWorkouts = afterReplay.workouts === afterFirst.workouts
    && afterOther.workouts === afterFirst.workouts;
  const checks = [
    check("no duplicate health records", noDuplicateHealthRecords, "unchanged",
      { afterFirst: afterFirst?.healthRecords ?? null, afterReplay: afterReplay?.healthRecords ?? null,
        afterOther: afterOther?.healthRecords ?? null }),
    check("no duplicate workouts", noDuplicateWorkouts, "unchanged",
      { afterFirst: afterFirst?.workouts ?? null, afterReplay: afterReplay?.workouts ?? null,
        afterOther: afterOther?.workouts ?? null })
  ];
  recorder.task({
    type: "s06_duplicate_check", before, afterFirst, afterReplay, afterOther,
    noDuplicateHealthRecords, noDuplicateWorkouts, checks
  });
  // 重复事实不是“任务事件里的一行说明”：它必须进入 case 证据；失败时再进入
  // correctness.oracleFailures，driver 退出非 0、G4 FAIL。
  const caseResult = {
    caseId: "S06-DUPLICATE",
    label: "same bytes replay and same content with a different upload identity",
    expectation: "no additional health records or workouts",
    ok: checks.every((item) => item.ok),
    checks,
    observed: { before, afterFirst, afterReplay, afterOther, noDuplicateHealthRecords, noDuplicateWorkouts }
  };
  recorder.case(caseResult);
  if (!caseResult.ok) {
    caseFailures.push({
      routeTemplate: "/v1/imports/case",
      phase: `s06:${caseResult.caseId}`,
      status: null,
      outcome: "oracle_failed",
      businessCode: null,
      checks: checks.filter((item) => !item.ok)
    });
  }
  results.push({ synthetic: true, case: caseResult });
  return results;
}

async function scenarioS07() {
  const entry = manifest?.payloads?.find((payload) => payload.kind === "direct-sync" && /GPX 3 文件/.test(payload.label));
  if (!entry) throw new Error("S07 requires the direct-sync GPX payload");
  const before = await dataSummarySnapshot();
  const batchId = `phase6-s07-${Date.now()}`;
  const upload = await uploadPayload(entry.path, batchId);
  const results = [upload];
  if (upload.sample.status === 200) {
    const { inspect, job } = await runImportJob(upload.body.sourceId, batchId);
    results.push(inspect, job);
    job.sample.oracle = oracleAll([
      check("job succeeded", job.body?.status === "succeeded", "succeeded", job.body?.status ?? null),
      check("routes updated", Number(job.body?.summary?.routesUpdated ?? 0) >= 3, ">=3", job.body?.summary?.routesUpdated ?? 0),
      check("analysis queued", ["queued", "not_required"].includes(job.body?.summary?.directSync?.analysisStatus),
        "queued|not_required", job.body?.summary?.directSync?.analysisStatus ?? null)
    ]);
    job.sample.outcome = job.sample.oracle.ok ? "success" : "oracle_failed";
  }
  const after = await dataSummarySnapshot();
  recorder.task({ type: "s07_summary", before, after, routePointsDelta: (after?.routePoints ?? 0) - (before?.routePoints ?? 0) });
  return results;
}

async function scenarioS08() {
  // F2：每个载荷按冻结的结构化合同独立裁决。label 只用于展示；拒绝用例必须
  // 证明稳定 4xx/code、无 succeeded job、零事实增量。caseResult.ok=false 会
  // 进入 correctness.oracleFailures（driver 非 0、G4 FAIL）。
  const entries = (manifest?.payloads ?? []).filter((payload) => payload.s08 === true);
  if (entries.length === 0) throw new Error("S08 requires structured s08 payloads in the DX manifest");
  const results = [];
  for (const [index, entry] of entries.entries()) {
    const contract = entry.contract;
    if (contract === undefined || typeof contract !== "object") {
      throw new Error(`S08 payload ${entry.label ?? entry.name} has no structured contract`);
    }
    const before = await dataSummarySnapshot();
    const batchId = `phase6-s08-${Date.now()}-${index}`;
    const upload = await uploadPayload(entry.path, batchId, { allowRejection: true, label: entry.label });
    results.push(upload);
    let inspect = null;
    let created = null;
    let terminal = null;
    let jobId = null;
    if (upload.sample.status === 200) {
      inspect = await request({
        routeTemplate: "/v1/imports/inspect", path: "/v1/imports/inspect", method: "POST",
        json: { sourceId: upload.body.sourceId }, payloadLabel: entry.label,
        expectedStatus: [200, 400, 404, 409, 422]
      });
      results.push(inspect);
      if (inspect.sample.status === 200 && inspect.body?.status === "ready") {
        created = await request({
          routeTemplate: "/v1/import-jobs", path: "/v1/import-jobs", method: "POST",
          json: { sourceId: upload.body.sourceId }, payloadLabel: entry.label,
          expectedStatus: [202, 400, 409, 422]
        });
        results.push(created);
        if (created.sample.status === 202 && typeof created.body?.id === "string") {
          jobId = created.body.id;
          try {
            terminal = await pollImportJob(jobId);
            results.push(terminal.terminal);
          } catch (error) {
            terminal = null;
            recorder.task({ type: "s08_job_timeout", label: entry.label, jobId, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }
    const after = await dataSummarySnapshot();
    const delta = {
      healthRecords: Number(after?.healthRecords ?? 0) - Number(before?.healthRecords ?? 0),
      workouts: Number(after?.workouts ?? 0) - Number(before?.workouts ?? 0),
      routePoints: Number(after?.routePoints ?? 0) - Number(before?.routePoints ?? 0)
    };
    const jobStatus = terminal?.terminal?.body?.status ?? null;
    const rejection = upload.sample.status >= 400
      ? { stage: "upload", status: upload.sample.status, code: upload.sample.businessCode ?? null }
      : inspect !== null && inspect.sample.status >= 400
        ? { stage: "inspect", status: inspect.sample.status, code: inspect.sample.businessCode ?? null }
        : jobStatus === "failed" || jobStatus === "cancelled"
          ? { stage: "job", status: created?.sample?.status ?? null, code: terminal?.terminal?.body?.failureCode ?? null }
          : null;
    const observed = {
      uploadStatus: upload.sample.status, uploadCode: upload.sample.businessCode ?? null,
      inspectStatus: inspect?.sample?.status ?? null, inspectCode: inspect?.sample?.businessCode ?? null,
      inspectBodyStatus: inspect?.body?.status ?? null,
      jobCreated: created?.sample?.status === 202,
      jobId,
      jobStatus,
      jobFailureCode: terminal?.terminal?.body?.failureCode ?? null,
      lane: terminal?.terminal?.body?.performance?.lane?.directSource ?? null,
      laneOutcome: terminal?.terminal?.body?.performance?.lane?.outcome ?? null,
      factsDelta: delta,
      rejection
    };
    const checks = evaluateS08Contract(contract, observed);
    const caseResult = {
      caseId: `S08-${String(index + 1).padStart(2, "0")}`,
      label: entry.label ?? entry.name ?? null,
      expectation: contract.expectation,
      expectedLane: contract.expectedLane ?? null,
      ok: checks.every((item) => item.ok),
      checks,
      observed,
      contract
    };
    recorder.case(caseResult);
    if (!caseResult.ok) {
      caseFailures.push({
        routeTemplate: "/v1/imports/case",
        phase: `s08:${caseResult.caseId}`,
        status: observed.rejection?.status ?? null,
        outcome: "oracle_failed",
        businessCode: observed.rejection?.code ?? null,
        checks: checks.filter((item) => !item.ok)
      });
    }
    recorder.task({ type: "s08_case", ...caseResult });
  }
  recorder.task({ type: "s08_refusal_check", cases: recorder.cases, failures: caseFailures.length });
  results.push({ synthetic: true, cases: recorder.cases });
  return results;
}

/**
 * S09：导入 → 分析排队 → worker 执行 → 发布 → API 读可见。
 * 判据不是“任务结束”，而是 `/v1/workouts` 上出现该训练且 analysisPublishStatus=published。
 */
async function scenarioS09() {
  const entry = manifest?.payloads?.find((payload) => payload.kind === "workout");
  if (!entry) throw new Error("S09 requires the workout payload in the DX manifest");
  const batchId = `phase6-s09-${Date.now()}`;
  const upload = await uploadPayload(entry.path, batchId);
  const results = [upload];
  if (upload.sample.status !== 200) throw new Error(`S09 upload failed with ${upload.sample.status}`);
  const { inspect, job } = await runImportJob(upload.body.sourceId, batchId);
  results.push(inspect, job);
  if (job.body?.status !== "succeeded") throw new Error(`S09 job failed: ${job.body?.status}`);
  const analysisJobId = job.body?.summary?.analysisJobId ?? null;
  recorder.task({ type: "s09_analysis_registered", analysisJobId, status: job.body?.summary?.directSync?.analysisStatus ?? null });
  const deadline = Date.now() + Math.max(60_000, timeoutMs);
  let published = null;
  let runtime = null;
  while (Date.now() < deadline) {
    runtime = await request({ routeTemplate: "/v1/runtime-status", path: "/v1/runtime-status", phase: "analysis:poll" });
    const list = await request({
      routeTemplate: "/v1/workouts", path: "/v1/workouts?limit=100", phase: "read-visible:poll",
      oracle: (body) => oracleAll([check("list", Array.isArray(body?.items), "array", Array.isArray(body?.items))])
    });
    const candidate = (list.body?.items ?? []).find((item) => item.startedAt === "2026-02-01T01:00:00.000Z");
    // 事实先可见、分析后发布是合法窗口（read status=pending）；不能把“第一次看到 pending”
    // 当成失败，也不能把 pending 当成 published。只在终态或超时才裁决。
    if (candidate !== undefined && candidate.analysisPublishStatus === "failed") {
      throw new Error(`S09 analysis failed for workout ${candidate.id}`);
    }
    if (candidate !== undefined && candidate.analysisPublishStatus === "published" && candidate.analysisAvailable === true) {
      published = list;
      list.sample.oracle = oracleAll([
        check("analysis published", true, "published", candidate.analysisPublishStatus),
        check("analysis available", true, true, candidate.analysisAvailable)
      ]);
      list.sample.outcome = "success";
      recorder.task({
        type: "s09_read_visible", analysisJobId, workoutId: candidate.id,
        analysisPublishStatus: candidate.analysisPublishStatus, analysisAvailable: candidate.analysisAvailable,
        runtimeJobStatus: runtime.body?.recomputeJob?.status ?? null
      });
      results.push(list, runtime);
      break;
    }
    results.push(list, runtime);
    await sleep(250);
  }
  if (published === null) throw new Error("S09 timed out waiting for published analysis to become read-visible");
  return results;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const scenarios = {
  S01: scenarioS01, S02: scenarioS02, S03: scenarioS03, S04: scenarioS04,
  S05: scenarioS05, S06: scenarioS06, S07: scenarioS07, S08: scenarioS08, S09: scenarioS09,
  S10: scenarioS10, S12: scenarioS12, S13: scenarioS13, S14: scenarioS14
};

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const startedAt = new Date().toISOString();
let driverInterrupted = null;
let results;
try {
  const runner = scenarios[scenario];
  if (!runner) throw new Error(`unknown scenario: ${scenario}`);
  results = await runner();
  const samples = recorder.samples;
  // 任何非 success（含 unexpected_status / timeout / network_error）都算失败：
  // “状态码不在预期集合”绝不能因为没跑 oracle 就变成绿。
  const failures = samples.filter((sample) => sample.outcome !== "success");
  const outcomes = {};
  for (const sample of samples) outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
  const correctness = {
    scenario, runId, profile, dataset, startedAt, finishedAt: new Date().toISOString(),
    incomplete: driverInterrupted !== null,
    interruptedBy: driverInterrupted,
    requests: samples.length,
    outcomes,
    oracleFailures: [
      ...failures.map((sample) => ({
        routeTemplate: sample.routeTemplate, phase: sample.phase, status: sample.status,
        outcome: sample.outcome, businessCode: sample.businessCode,
        checks: (sample.oracle?.checks ?? []).filter((checkItem) => !checkItem.ok)
      })),
      ...caseFailures
    ],
    cases: recorder.cases,
    checks: samples.filter((sample) => sample.oracle).map((sample) => ({
      routeTemplate: sample.routeTemplate, phase: sample.phase, status: sample.status, ok: sample.oracle.ok
    }))
  };
  writeFileSync(join(outDir, "correctness", `${scenario}.json`), `${JSON.stringify(correctness, null, 2)}\n`);
  writeFileSync(join(outDir, "driver-summary.json"), `${JSON.stringify(correctness, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    scenario, requests: samples.length, outcomes,
    oracleFailures: correctness.oracleFailures.length,
    taskEvents: recorder.taskEvents.length
  }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
  if (caseFailures.length > 0) process.exitCode = 1;
  if (driverInterrupted !== null) process.exitCode = 3;
} catch (error) {
  const failed = {
    scenario, runId, profile, dataset, startedAt, finishedAt: new Date().toISOString(),
    fatal: error instanceof Error ? error.message : String(error),
    requests: recorder.samples.length,
    outcomes: recorder.samples.reduce((acc, sample) => {
      acc[sample.outcome] = (acc[sample.outcome] ?? 0) + 1; return acc;
    }, {})
  };
  writeFileSync(join(outDir, "correctness", `${scenario}.json`), `${JSON.stringify(failed, null, 2)}\n`);
  process.stderr.write(`phase6-driver: ${failed.fatal}\n`);
  process.exitCode = 2;
}
