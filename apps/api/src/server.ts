import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type {
  ImportJobRequest,
  OverrideWorkoutInput,
  TrainPredictionModelRequest,
  UpdateTrainingZoneProfileInput,
  TrainingStatisticsGranularity
} from "@rai/api-contracts";
import {
  MINIMUM_LABELS_PER_DISTANCE,
  MINIMUM_PREDICTION_LABELS,
  PredictionModelService,
  PredictionTrainingInProgressError,
  PredictionTrainingInputError,
  PredictionTrainingPreconditionError,
  RaiApplicationService,
  buildPredictionReportAsync
} from "@rai/application";
import { RaiDatabase } from "@rai/health-export-parser";
import Fastify from "fastify";

import { RaiReadStore } from "./data.js";
import { DatabaseMaintenance } from "./maintenance.js";
import { ImportSourceManager } from "./import-sources.js";
import { MutationCoordinator } from "./mutation-coordinator.js";
import { installLocalRequestSecurity } from "./local-request-security.js";
import { ReadStoreManager } from "./read-store-manager.js";
import {
  backupParamsSchema,
  deleteBodySchema,
  identifierParamsSchema,
  importJobBodySchema,
  importSourceBodySchema,
  modelComparisonQuerySchema,
  openapiDocument,
  overrideBodySchema,
  predictionQuerySchema,
  predictionModelIdParamsSchema,
  predictionModelTrainBodySchema,
  restoreBodySchema,
  trendQuerySchema,
  trainingLoadQuerySchema,
  trainingZoneProfileBodySchema,
  trainingZonesHistoryQuerySchema,
  trainingStatisticsHistoryQuerySchema,
  workoutListQuerySchema
} from "./schemas.js";
import { ImportWorker, PredictionModelWorker, RecomputeWorker } from "./worker.js";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeRoot = resolve(process.env.RAI_RUNTIME_ROOT ?? projectRoot);
const databasePath = resolve(process.env.RAI_DATABASE ?? resolve(projectRoot, "var/rai.sqlite"));
const port = Number(process.env.RAI_API_PORT ?? 8787);
const host = "127.0.0.1";

const app = Fastify({
  logger: { level: process.env.RAI_LOG_LEVEL ?? "info" },
  ajv: { customOptions: { removeAdditional: false } }
});
await app.register(cors, { origin: ["http://127.0.0.1:5173", "http://localhost:5173"] });
await app.register(multipart, {
  limits: { files: 1, fileSize: Number(process.env.RAI_IMPORT_MAX_ZIP_BYTES ?? 4 * 1024 ** 3) }
});
const developmentOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const mutationCoordinator = new MutationCoordinator();
const mutationReleases = new WeakMap<object, () => void>();
installLocalRequestSecurity(app, { apiPort: port, developmentOrigins });
app.addHook("preHandler", async (request) => {
  if (!unsafeMethods.has(request.method)) return;
  const release = mutationCoordinator.acquire(`${request.method} ${request.routeOptions.url}`);
  mutationReleases.set(request, release);
});
const releaseMutation = (request: object): void => {
  mutationReleases.get(request)?.();
  mutationReleases.delete(request);
};
app.addHook("onError", async (request) => releaseMutation(request));
app.addHook("onRequestAbort", async (request) => releaseMutation(request));
app.addHook("onResponse", async (request) => releaseMutation(request));
const webDist = resolve(projectRoot, "apps/web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false });
}

const readStores = new ReadStoreManager(databasePath);
const recomputeWorker = new RecomputeWorker(databasePath);
const importWorker = new ImportWorker(databasePath, projectRoot, runtimeRoot, () => readStores.beginReplace(), () => readStores.endReplace());
const importSources = new ImportSourceManager(runtimeRoot, projectRoot);
const predictionModelWorker = new PredictionModelWorker(databasePath, projectRoot, runtimeRoot);
const maintenance = new DatabaseMaintenance(databasePath, runtimeRoot, () => readStores.beginReplace(), () => readStores.endReplace());
app.addHook("onClose", async () => readStores.close());

if (existsSync(databasePath)) {
  const migrationStore = await RaiDatabase.open(databasePath);
  new RaiApplicationService(migrationStore).recoverInterruptedJobs();
  migrationStore.close();
}

const withReadStore = <T>(callback: (store: RaiReadStore) => T): T => {
  return readStores.use(callback);
};

const withReadDatabase = <T>(callback: (database: DatabaseSync) => T): T => {
  return readStores.useDatabase(callback);
};

const withReadDatabaseAsync = async <T>(
  callback: (database: DatabaseSync) => Promise<T>
): Promise<T> => {
  return readStores.useDatabaseAsync(callback);
};

const hasActivePredictionModelJob = (): boolean => existsSync(databasePath) &&
  withReadDatabase((database) => Boolean(database.prepare(`
    SELECT 1 FROM prediction_model_runs
    WHERE status IN ('queued', 'running', 'validating') LIMIT 1
  `).get()));

const hasActiveRecomputeJob = (): boolean => existsSync(databasePath) &&
  withReadDatabase((database) => Boolean(database.prepare(`
    SELECT 1 FROM recompute_jobs
    WHERE status IN ('queued', 'running') LIMIT 1
  `).get()));

const localToday = (): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

const ensureTrainingZoneBackfill = async (): Promise<void> => {
  if (
    !existsSync(databasePath) || importWorker.isRunning || recomputeWorker.isRunning ||
    predictionModelWorker.isRunning || hasActiveRecomputeJob() || hasActivePredictionModelJob()
  ) return;
  const store = await RaiDatabase.open(databasePath);
  let queued = false;
  try {
    const active = store.database.prepare("SELECT 1 FROM active_model_run WHERE singleton = 1").get();
    if (!active) return;
    const counts = store.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM active_workout_training_loads) AS load_count,
        (SELECT COUNT(*) FROM active_workout_zone_summaries) AS summary_count,
        (SELECT MAX(local_date) FROM active_daily_zone_profiles) AS latest_profile_date
    `).get() as unknown as { load_count: number; summary_count: number; latest_profile_date: string | null };
    const service = new RaiApplicationService(store);
    if (Number(counts.load_count) > Number(counts.summary_count)) {
      service.enqueueFullRecompute({
        evaluatedAt: new Date().toISOString(),
        timezoneIdentifier: "Asia/Shanghai"
      });
      queued = true;
    } else if (counts.latest_profile_date === null || counts.latest_profile_date < localToday()) {
      service.enqueueSnapshotRefresh({
        evaluatedAt: new Date().toISOString(),
        timezoneIdentifier: "Asia/Shanghai"
      });
      queued = true;
    }
  } finally {
    store.close();
  }
  if (queued) recomputeWorker.schedule();
};

await ensureTrainingZoneBackfill();
recomputeWorker.schedule();
predictionModelWorker.schedule();
const zoneRefreshTimer = setInterval(() => void ensureTrainingZoneBackfill(), 5 * 60_000);
zoneRefreshTimer.unref();
app.addHook("onClose", async () => clearInterval(zoneRefreshTimer));

app.get("/v1/health", async () => ({
  status: "ok",
  databaseReady: existsSync(databasePath),
  localOnly: true,
  now: new Date().toISOString()
}));
app.get("/v1/openapi.json", async () => openapiDocument);

app.get("/v1/dashboard", async () => withReadStore((store) => store.dashboard()));
app.get("/v1/data-summary", async () => withReadStore((store) => store.dataSummary()));
app.get("/v1/data-audit", async () => withReadStore((store) => store.dataAudit()));
app.get("/v1/diagnostics", async (_request, reply) => {
  const diagnostics = withReadStore((store) => store.diagnostics());
  reply.header("content-type", "application/json; charset=utf-8");
  reply.header("content-disposition", `attachment; filename="rai-diagnostics-${diagnostics.generatedAt.slice(0, 10)}.json"`);
  return diagnostics;
});
app.get("/v1/runtime-status", async () => {
  const recomputeJob = existsSync(databasePath)
    ? withReadStore((store) => store.jobs(1)[0] ?? null)
    : null;
  const importJob = importWorker.latest();
  return {
    databaseReady: existsSync(databasePath),
    busy:
      importWorker.isRunning ||
      recomputeWorker.isRunning ||
      predictionModelWorker.isRunning ||
      recomputeJob?.status === "queued" ||
      recomputeJob?.status === "running",
    recomputeJob,
    importJob
  };
});

app.get<{ Querystring: { limit?: string; offset?: string; status?: string; sessionType?: string; stimulusType?: string; participation?: string; environment?: string; days?: string; sourceGroup?: string; confidence?: string; route?: string } }>(
  "/v1/workouts",
  { schema: { querystring: workoutListQuerySchema } },
  async (request) =>
    withReadStore((store) =>
      store.workouts({
        limit: Math.min(Math.max(Number(request.query.limit ?? 30), 1), 100),
        offset: Math.max(Number(request.query.offset ?? 0), 0),
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.sessionType ? { sessionType: request.query.sessionType } : {}),
        ...(request.query.stimulusType ? { stimulusType: request.query.stimulusType } : {}),
        ...(request.query.participation ? { participation: request.query.participation } : {}),
        ...(request.query.environment ? { environment: request.query.environment } : {}),
        ...(request.query.days ? { days: Number(request.query.days) } : {}),
        ...(request.query.sourceGroup ? { sourceGroup: request.query.sourceGroup } : {}),
        ...(request.query.confidence ? { confidence: request.query.confidence } : {}),
        ...(request.query.route ? { route: request.query.route } : {})
      })
    )
);

app.get<{ Params: { id: string } }>("/v1/workouts/:id", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  const detail = withReadStore((store) => store.workout(request.params.id));
  if (!detail) return reply.code(404).send({ message: "未找到该训练记录" });
  return detail;
});

app.get<{ Params: { id: string } }>("/v1/workouts/:id/series", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  const series = withReadStore((store) => store.workoutSeries(request.params.id));
  if (!series) return reply.code(404).send({ message: "未找到该训练的时间序列" });
  return series;
});

app.patch<{ Params: { id: string }; Body: OverrideWorkoutInput }>(
  "/v1/workouts/:id/override",
  { schema: { params: identifierParamsSchema, body: overrideBodySchema } },
  async (request, reply) => {
    if (importWorker.isRunning || predictionModelWorker.isRunning || hasActivePredictionModelJob()) {
      return reply.code(409).send({ message: "导入或预测模型训练期间不能修改训练覆盖" });
    }
    const store = await RaiDatabase.open(databasePath);
    try {
      const service = new RaiApplicationService(store);
      const overrideId = service.appendWorkoutOverride({
        trainingSessionId: request.params.id,
        eligibilityOverride: request.body.eligibilityOverride,
        statisticsParticipation: request.body.statisticsParticipation,
        sessionType: request.body.sessionType,
        performanceProtocol: request.body.performanceProtocol,
        rpe: request.body.rpe,
        conditionTags: request.body.conditionTags,
        note: request.body.note
      });
      const queued = store.database
        .prepare("SELECT id FROM recompute_jobs WHERE status = 'queued' ORDER BY created_at DESC LIMIT 1")
        .get() as { id: string } | undefined;
      recomputeWorker.schedule();
      return { overrideId, jobId: queued?.id ?? null };
    } finally {
      store.close();
    }
  }
);

app.get<{ Querystring: { days?: string } }>("/v1/trends", { schema: { querystring: trendQuerySchema } }, async (request) =>
  withReadStore((store) => store.trends(Math.min(Math.max(Number(request.query.days ?? 84), 7), 4000)))
);

app.get("/v1/training-statistics/overview", async () =>
  withReadStore((store) => store.trainingStatisticsOverview())
);

app.get<{ Querystring: { granularity: TrainingStatisticsGranularity; limit?: string } }>(
  "/v1/training-statistics/history",
  { schema: { querystring: trainingStatisticsHistoryQuerySchema } },
  async (request) => withReadStore((store) => store.trainingStatisticsHistory(
    request.query.granularity,
    Math.min(Math.max(Number(request.query.limit ?? (request.query.granularity === "week" ? 12 : request.query.granularity === "month" ? 12 : 50)), 1), request.query.granularity === "week" ? 52 : 100)
  ))
);

app.get<{ Querystring: { days?: string } }>(
  "/v1/training-statistics/load",
  { schema: { querystring: trainingLoadQuerySchema } },
  async (request) => withReadStore((store) => store.trainingLoadTimeline(
    Math.min(Math.max(Number(request.query.days ?? 180), 7), 4000)
  ))
);

app.get("/v1/training-zones/current", async (_request, reply) => {
  const current = withReadStore((store) => store.trainingZonesCurrent());
  if (!current) return reply.code(404).send({ message: "尚未生成训练分区，请先完成一次重新计算" });
  return current;
});

app.get<{ Querystring: { days?: string } }>(
  "/v1/training-zones/history",
  { schema: { querystring: trainingZonesHistoryQuerySchema } },
  async (request) => withReadStore((store) => store.trainingZonesHistory(
    Math.min(Math.max(Number(request.query.days ?? 90), 7), 3650)
  ))
);

app.patch<{ Body: UpdateTrainingZoneProfileInput }>(
  "/v1/training-zones/profile",
  { schema: { body: trainingZoneProfileBodySchema } },
  async (request, reply) => {
    if (
      importWorker.isRunning || recomputeWorker.isRunning || predictionModelWorker.isRunning ||
      hasActiveRecomputeJob() || hasActivePredictionModelJob()
    ) {
      return reply.code(409).send({ message: "任务执行期间不能修改训练分区设置" });
    }
    const store = await RaiDatabase.open(databasePath);
    try {
      const settings = new RaiApplicationService(store).appendTrainingZoneProfileSettings(request.body);
      return settings;
    } catch (error) {
      const message = error instanceof Error ? error.message : "训练分区设置无效";
      if (message.includes("revision conflict")) return reply.code(409).send({ message });
      return reply.code(400).send({ message });
    } finally {
      store.close();
    }
  }
);

interface PredictionQuery {
  temperatureC?: number;
  humidityPercent?: number;
  elevationGain5k?: number;
  elevationGain10k?: number;
  elevationGainHalfMarathon?: number;
}

app.get<{ Querystring: PredictionQuery }>(
  "/v1/predictions",
  { schema: { querystring: predictionQuerySchema } },
  async (request) => {
    const elevationGainMeters = {
      ...(request.query.elevationGain5k === undefined
        ? {}
        : { five_k: request.query.elevationGain5k }),
      ...(request.query.elevationGain10k === undefined
        ? {}
        : { ten_k: request.query.elevationGain10k }),
      ...(request.query.elevationGainHalfMarathon === undefined
        ? {}
        : { half_marathon: request.query.elevationGainHalfMarathon })
    };
    return withReadDatabaseAsync((database) => buildPredictionReportAsync(database, {
      ...(request.query.temperatureC === undefined
        ? {}
        : { temperatureC: request.query.temperatureC }),
      ...(request.query.humidityPercent === undefined
        ? {}
        : { humidityPercent: request.query.humidityPercent }),
      ...(Object.keys(elevationGainMeters).length === 0 ? {} : { elevationGainMeters })
    }));
  }
);

app.get("/v1/prediction-models", async () => {
  if (!existsSync(databasePath)) throw new Error("本地 RAI 数据库不存在，请先导入 Apple Health 数据");
  return readStores.lease(async () => {
    const store = await RaiDatabase.open(databasePath);
    try { return { runs: new PredictionModelService(store).list() }; }
    finally { store.close(); }
  });
});

app.get<{ Params: { id: string } }>(
  "/v1/prediction-models/:id",
  { schema: { params: predictionModelIdParamsSchema } },
  async (request, reply) => {
    if (!existsSync(databasePath)) throw new Error("本地 RAI 数据库不存在，请先导入 Apple Health 数据");
    return readStores.lease(async () => {
      const store = await RaiDatabase.open(databasePath);
      try {
        const service = new PredictionModelService(store);
        const run = service.get(request.params.id);
        if (!run) return reply.code(404).send({ message: "未找到预测模型运行" });
        return { run, events: service.events(request.params.id) };
      } finally { store.close(); }
    });
  }
);

app.post<{ Body: TrainPredictionModelRequest }>(
  "/v1/prediction-models/train",
  { schema: { body: predictionModelTrainBodySchema } },
  async (request, reply) => {
    if (
      importWorker.isRunning || recomputeWorker.isRunning || hasActiveRecomputeJob()
    ) {
      return reply.code(409).send({ message: "导入或重算期间不能开始预测模型训练" });
    }
    const asOf = request.body?.asOf
      ? new Date(request.body.asOf).toISOString()
      : new Date().toISOString();
    if (!existsSync(databasePath)) {
      return reply.code(409).send({
        code: "database_not_ready",
        message: "请先导入 Apple Health 数据，再训练预测模型"
      });
    }
    const store = await RaiDatabase.open(databasePath);
    try {
      const service = new PredictionModelService(store);
      try {
        const runId = service.enqueue({ asOf });
        predictionModelWorker.schedule();
        return { runId, status: "queued" as const };
      } catch (error) {
        if (error instanceof PredictionTrainingPreconditionError) {
          return reply.code(422).send({
            code: error.code,
            required: MINIMUM_PREDICTION_LABELS,
            available: error.preflight.available,
            requiredPerDistance: MINIMUM_LABELS_PER_DISTANCE,
            availableByDistance: error.preflight.availableByDistance,
            message: error.message
          });
        }
        if (error instanceof PredictionTrainingInProgressError) {
          return reply.code(409).send({
            code: error.code,
            existingRunId: error.existingRunId,
            message: error.message
          });
        }
        if (error instanceof PredictionTrainingInputError) {
          return reply.code(400).send({ code: error.code, message: error.message });
        }
        throw error;
      }
    } finally {
      store.close();
    }
  }
);

app.post<{ Params: { id: string } }>(
  "/v1/prediction-models/:id/cancel",
  { schema: { params: predictionModelIdParamsSchema } },
  async (request, reply) => {
    const store = await RaiDatabase.open(databasePath);
    try {
      const service = new PredictionModelService(store);
      if (!service.get(request.params.id)) {
        return reply.code(404).send({ message: "未找到预测模型运行" });
      }
      const cancellation = service.requestCancellation(request.params.id);
      if (cancellation === "terminal") {
        return reply.code(409).send({
          code: "prediction_model_already_terminal",
          message: "已完成的预测模型运行不能取消"
        });
      }
      return {
        cancelRequested: cancellation === "requested",
        status: cancellation === "requested" ? "cancelling" : "cancelled"
      };
    } finally {
      store.close();
    }
  }
);

app.post<{ Params: { id: string } }>(
  "/v1/prediction-models/:id/activate",
  { schema: { params: predictionModelIdParamsSchema } },
  async (request, reply) => {
    if (
      importWorker.isRunning || recomputeWorker.isRunning || predictionModelWorker.isRunning ||
      hasActiveRecomputeJob() || hasActivePredictionModelJob()
    ) {
      return reply.code(409).send({ message: "任务执行期间不能切换 active Prediction Model" });
    }
    const store = await RaiDatabase.open(databasePath);
    try {
      const service = new PredictionModelService(store);
      const run = service.get(request.params.id);
      if (!run) return reply.code(404).send({ message: "未找到预测模型运行" });
      if (run.status !== "succeeded") {
        return reply.code(409).send({ message: "只能激活验证成功的预测模型" });
      }
      service.activate(request.params.id);
      return { activePredictionModelRunId: request.params.id };
    } finally {
      store.close();
    }
  }
);

app.get("/v1/model-runs", async () => withReadStore((store) => store.modelRuns()));

app.get<{ Querystring: { base: string; candidate: string } }>(
  "/v1/model-runs/compare",
  { schema: { querystring: modelComparisonQuerySchema } },
  async (request, reply) => {
    const comparison = withReadStore((store) =>
      store.compareModelRuns(request.query.base, request.query.candidate)
    );
    if (!comparison) return reply.code(404).send({ message: "未找到待比较的模型运行" });
    return comparison;
  }
);

app.post("/v1/model-runs", async (_request, reply) => {
  if (importWorker.isRunning || predictionModelWorker.isRunning || hasActivePredictionModelJob()) {
    return reply.code(409).send({ message: "导入或预测模型训练期间不能创建模型运行" });
  }
  const store = await RaiDatabase.open(databasePath);
  try {
    const jobId = new RaiApplicationService(store).enqueueFullRecompute({
      evaluatedAt: new Date().toISOString(),
      timezoneIdentifier: "Asia/Shanghai"
    });
    recomputeWorker.schedule();
    return { jobId };
  } finally {
    store.close();
  }
});

app.post<{ Params: { id: string } }>("/v1/model-runs/:id/activate", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  if (
    importWorker.isRunning || recomputeWorker.isRunning || predictionModelWorker.isRunning ||
    hasActiveRecomputeJob() || hasActivePredictionModelJob()
  ) {
    return reply.code(409).send({ message: "任务执行期间不能切换 active Model Run" });
  }
  const store = await RaiDatabase.open(databasePath);
  try {
    const row = store.database
      .prepare(`
        SELECT model.status,
          EXISTS (
            SELECT 1 FROM training_metric_runs metric
            WHERE metric.model_run_id = model.id AND metric.status = 'succeeded'
          ) AS has_succeeded_training_metrics
        FROM model_runs model
        WHERE model.id = ?
      `)
      .get(request.params.id) as { status: string; has_succeeded_training_metrics: number } | undefined;
    if (!row) return reply.code(404).send({ message: "未找到模型运行" });
    if (row.status !== "succeeded") return reply.code(409).send({ message: "只能激活成功的模型运行" });
    if (row.has_succeeded_training_metrics !== 1) {
      return reply.code(409).send({ message: "该模型运行没有成功的运动统计结果，不能激活" });
    }
    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database
        .prepare(`
          INSERT INTO active_model_run (singleton, model_run_id, activated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET model_run_id = excluded.model_run_id,
            activated_at = excluded.activated_at
        `)
        .run(request.params.id, new Date().toISOString());
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    return { activeModelRunId: request.params.id };
  } finally {
    store.close();
  }
});

app.get("/v1/jobs", async () => withReadStore((store) => store.jobs()));

app.get<{ Params: { id: string } }>("/v1/jobs/:id", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  const job = withReadStore((store) => store.job(request.params.id));
  if (!job) return reply.code(404).send({ message: "未找到任务" });
  return job;
});

app.post<{ Params: { id: string } }>("/v1/jobs/:id/cancel", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  const store = await RaiDatabase.open(databasePath);
  try {
    const cancellation = new RaiApplicationService(store).requestJobCancellation(request.params.id);
    if (cancellation === "not_found") {
      return reply.code(404).send({ message: "未找到任务" });
    }
    if (cancellation === "terminal") {
      return reply.code(409).send({ message: "已完成的任务不能取消" });
    }
    return { cancelled: true };
  } finally {
    store.close();
  }
});

type CreateImportJobBody = ImportJobRequest | { sourceId: string };

app.post<{ Body: CreateImportJobBody }>(
  "/v1/import-jobs",
  { schema: { body: importJobBodySchema } },
  async (request, reply) => {
  const sourceId = "sourceId" in request.body ? request.body.sourceId : null;
  if (!sourceId && !("confirmReplace" in request.body && request.body.confirmReplace)) {
    return reply.code(400).send({ message: "目录导入会重建本地数据库，请先确认" });
  }
  if (
    recomputeWorker.isRunning || predictionModelWorker.isRunning ||
    hasActiveRecomputeJob() || hasActivePredictionModelJob()
  ) {
    return reply.code(409).send({ message: "模型任务执行期间不能开始导入" });
  }
  if (sourceId) {
    const source = await importSources.get(sourceId);
    if (!source) return reply.code(404).send({ message: "未找到导入来源" });
    return importWorker.create(source.inputPath, async (succeeded) => {
      if (succeeded) await importSources.markUsed(sourceId);
      if (source.kind === "upload") await importSources.cleanupUpload(sourceId);
    });
  }
  return importWorker.create((request.body as ImportJobRequest).inputPath);
  }
);

app.post("/v1/imports/uploads", async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.code(400).send({ message: "请选择 Apple 健康导出 ZIP" });
  if (file.mimetype !== "application/zip" && file.mimetype !== "application/x-zip-compressed" && !file.filename.toLowerCase().endsWith(".zip")) {
    return reply.code(415).send({ message: "只支持 ZIP 文件" });
  }
  try {
    const inspection = await importSources.saveUpload(file.file, file.filename);
    const source = await importSources.get(inspection.sourceId);
    const sizeBytes = source ? (await (await import("node:fs/promises")).stat(source.originalPath)).size : inspection.exportBytes;
    return {
      sourceId: inspection.sourceId,
      uploadId: inspection.sourceId,
      fileName: file.filename,
      sizeBytes
    };
  } catch (error) {
    return reply.code(400).send({ message: error instanceof Error ? error.message : "ZIP 处理失败" });
  }
});

app.post<{ Body: { sourceId: string } }>("/v1/imports/inspect", { schema: { body: importSourceBodySchema } }, async (request, reply) => {
  try { return await importSources.inspect(request.body.sourceId); }
  catch (error) { return reply.code(404).send({ message: error instanceof Error ? error.message : "未找到导入来源" }); }
});

app.get("/v1/import-sources/discover", async () => ({ sources: await importSources.discover() }));

app.get("/v1/import-sources/recent", async () => ({ sources: await importSources.recent() }));

app.get("/v1/import-jobs/active", async () => {
  const job = importWorker.latest();
  return job && ["queued", "running"].includes(job.status) ? job : null;
});

app.get<{ Params: { id: string } }>("/v1/import-jobs/:id", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  const job = importWorker.get(request.params.id);
  if (!job) return reply.code(404).send({ message: "未找到导入任务" });
  return job;
});

app.get("/v1/backups", async () => maintenance.listBackups());

app.post("/v1/backups", async (_request, reply) => {
  if (importWorker.isRunning || recomputeWorker.isRunning || predictionModelWorker.isRunning) {
    return reply.code(409).send({ message: "任务执行期间不能创建备份" });
  }
  return maintenance.createBackup();
});

app.get<{ Params: { name: string } }>("/v1/backups/:name", { schema: { params: backupParamsSchema } }, async (request, reply) => {
  try {
    const stream = maintenance.backupStream(request.params.name);
    reply.header("content-type", "application/x-sqlite3");
    reply.header("content-disposition", `attachment; filename="${request.params.name}"`);
    return reply.send(stream);
  } catch (error) {
    const message = error instanceof Error ? error.message : "备份文件无效";
    return reply.code(message.includes("无效") ? 400 : 404).send({ message });
  }
});

app.post<{ Params: { name: string }; Body: { confirmation: string } }>(
  "/v1/backups/:name/restore",
  { schema: { params: backupParamsSchema, body: restoreBodySchema } },
  async (request, reply) => {
    if (request.body.confirmation !== "恢复此备份") {
      return reply.code(400).send({ message: "确认文字不匹配" });
    }
    if (
      importWorker.isRunning || recomputeWorker.isRunning || predictionModelWorker.isRunning ||
      hasActiveRecomputeJob() || hasActivePredictionModelJob()
    ) {
      return reply.code(409).send({ message: "任务执行期间不能恢复数据库" });
    }
    const result = await maintenance.restoreBackup(request.params.name);
    return { restored: true, restoredBackup: result.restored, safetyBackup: result.safetyBackup };
  }
);

app.delete<{ Body: { confirmation: string } }>("/v1/database", { schema: { body: deleteBodySchema } }, async (request, reply) => {
  if (request.body?.confirmation !== "删除我的 RAI 数据") {
    return reply.code(400).send({ message: "确认文字不匹配" });
  }
  if (
    importWorker.isRunning || recomputeWorker.isRunning || predictionModelWorker.isRunning ||
    hasActiveRecomputeJob() || hasActivePredictionModelJob()
  ) {
    return reply.code(409).send({ message: "任务执行期间不能删除数据库" });
  }
  const backupInfo = await maintenance.deleteDatabase();
  return { deleted: true, backup: backupInfo };
});

if (existsSync(webDist)) {
  app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const providedStatus = (error as { statusCode?: unknown }).statusCode;
  const status = typeof providedStatus === "number"
    ? providedStatus
    : message.includes("不存在") || message.includes("未找到") ? 404 : 500;
  const safeMessage = status >= 500 ? "本地服务处理请求失败" : message;
  void reply.code(status).send({
    code: status >= 500 ? "internal_error" : "request_error",
    message: safeMessage
  });
});

await app.listen({ host, port });
app.log.info({ databasePath, runtimeRoot, url: `http://${host}:${port}` }, "RAI local API ready");
