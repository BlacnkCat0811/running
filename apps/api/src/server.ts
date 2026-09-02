import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type {
  ImportJobRequest,
  OverrideWorkoutInput,
  PredictionModelRun,
  RecomputeJobCancellationResponse,
  TrainPredictionModelRequest,
  UpdateMobileGoalsInput,
  UpdateTrainingZoneProfileInput,
  TrainingStatisticsGranularity
} from "@rai/api-contracts";
import {
  MINIMUM_LABELS_PER_DISTANCE,
  MINIMUM_PREDICTION_LABELS,
  PredictionAbilityBaselineUnavailableError,
  PredictionModelActivationCompatibilityError,
  PredictionModelService,
  PredictionTrainingInProgressError,
  PredictionTrainingInputError,
  PredictionTrainingPreconditionError,
  RaiApplicationService,
  TrainingZoneProfileRevisionConflictError,
  TrainingZoneProfileValidationError,
  buildPredictionReportAsync
} from "@rai/application";
import { acquireDatabasePublicationLock, RaiDatabase } from "@rai/storage-sqlite";
import Fastify from "fastify";

import { apiErrorPayload } from "./api-error.js";
import { RaiReadStore } from "./data.js";
import { backupPolicyFromEnvironment, DatabaseMaintenance } from "./maintenance.js";
import {
  ImportArchiveTooLargeError,
  createImportSourceManager,
  ImportSourceNotFoundError
} from "./import-sources.js";
import { MutationConflictError, MutationCoordinator } from "./mutation-coordinator.js";
import { MobileGoalsStore } from "./mobile-goals.js";
import {
  installLocalRequestSecurity,
  isTrustedDevelopmentOrigin
} from "./local-request-security.js";
import { DatabaseNotReadyError, ReadStoreManager } from "./read-store-manager.js";
import {
  backupParamsSchema,
  deleteBodySchema,
  identifierParamsSchema,
  importJobBodySchema,
  importSourceBodySchema,
  mobileGoalsBodySchema,
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
import { needsFullTrainingZoneBackfill, readTrainingZoneWorkoutSetCounts } from "./training-zone-backfill.js";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeRoot = resolve(process.env.RAI_RUNTIME_ROOT ?? projectRoot);
const databasePath = resolve(process.env.RAI_DATABASE ?? resolve(projectRoot, "var/rai.sqlite"));
const predictionArtifactRoot = resolve(runtimeRoot, "var", "model-artifacts", "prediction");
const port = Number(process.env.RAI_API_PORT ?? 8787);
const host = process.env.RAI_API_HOST ?? "127.0.0.1";
const apiToken = process.env.RAI_API_TOKEN?.trim() || undefined;
const maxImportZipBytes = Number(process.env.RAI_IMPORT_MAX_ZIP_BYTES ?? 4 * 1024 ** 3);
if (!Number.isFinite(maxImportZipBytes) || maxImportZipBytes <= 0) {
  throw new Error("RAI_IMPORT_MAX_ZIP_BYTES must be a positive number");
}
const releaseDatabasePublicationLock = acquireDatabasePublicationLock(databasePath, "api");
let publicationLockReleased = false;
const releasePublicationLock = (): void => {
  if (publicationLockReleased) return;
  publicationLockReleased = true;
  releaseDatabasePublicationLock();
};
process.once("exit", releasePublicationLock);

const app = Fastify({
  logger: { level: process.env.RAI_LOG_LEVEL ?? "info" },
  ajv: { customOptions: { removeAdditional: false } }
});
const parsedWebPort = Number(process.env.RAI_WEB_PORT ?? 5173);
const webPort = Number.isFinite(parsedWebPort) && parsedWebPort > 0 ? parsedWebPort : 5173;
const allowPrivateLanWebPort = process.env.RAI_ALLOW_LAN_DEV === "1" ? webPort : undefined;
const developmentOrigins = new Set([
  `http://127.0.0.1:${webPort}`,
  `http://localhost:${webPort}`
]);
await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, isTrustedDevelopmentOrigin(origin, {
      apiPort: port,
      developmentOrigins,
      ...(allowPrivateLanWebPort == null ? {} : { allowPrivateLanWebPort })
    }));
  }
});
await app.register(multipart, {
  limits: { files: 1, fileSize: maxImportZipBytes }
});
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Upload streams and discover are long/IO-only; they must not hold the mutation lock.
// Import job start still acquires the coordinator for the job lifecycle.
const metadataOnlyMutationRoutes = new Set([
  "/v1/import-sources/discover",
  "/v1/imports/uploads",
  "/v1/mobile/goals"
]);
const databaseRequiredMutationRoutes = new Set([
  "/v1/workouts/:id/override",
  "/v1/training-zones/profile",
  "/v1/prediction-models/train",
  "/v1/prediction-models/:id/cancel",
  "/v1/prediction-models/:id/activate",
  "/v1/model-runs",
  "/v1/model-runs/:id/activate",
  "/v1/jobs/:id/cancel",
  "/v1/backups",
  "/v1/database"
]);
const mutationCoordinator = new MutationCoordinator();
const mutationReleases = new WeakMap<object, () => void>();
const localRequestSecurityOptions = {
  apiPort: port,
  ...(apiToken ? { apiToken } : {}),
  developmentOrigins,
  ...(allowPrivateLanWebPort == null ? {} : { allowPrivateLanWebPort })
};
installLocalRequestSecurity(app, localRequestSecurityOptions);
app.addHook("preHandler", async (request, reply) => {
  const routeUrl = request.routeOptions.url;
  if (!unsafeMethods.has(request.method) || (routeUrl !== undefined && metadataOnlyMutationRoutes.has(routeUrl))) return;
  if (routeUrl !== undefined && databaseRequiredMutationRoutes.has(routeUrl) && !existsSync(databasePath)) {
    return reply.code(409).send({
      code: "database_not_ready",
      message: "本地 RAI 数据库尚未就绪，请先导入或恢复数据"
    });
  }
  const release = mutationCoordinator.acquire(`${request.method} ${routeUrl ?? request.url}`);
  mutationReleases.set(request, release);
});
const releaseMutation = (request: object): void => {
  mutationReleases.get(request)?.();
  mutationReleases.delete(request);
};
const takeMutationRelease = (request: object): (() => void) => {
  const release = mutationReleases.get(request);
  if (!release) throw new Error("Mutation lock is not held by this request");
  mutationReleases.delete(request);
  return release;
};
app.addHook("onError", async (request) => releaseMutation(request));
app.addHook("onRequestAbort", async (request) => releaseMutation(request));
app.addHook("onResponse", async (request) => releaseMutation(request));
const webDist = resolve(projectRoot, "apps/web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false });
}

const readStores = new ReadStoreManager(databasePath);
const mobileGoalsStore = new MobileGoalsStore(runtimeRoot);
let observeWorkerDatabaseError: (error: unknown) => void = () => {};
const recomputeWorker = new RecomputeWorker(databasePath, (error) => observeWorkerDatabaseError(error));
const importSources = createImportSourceManager(runtimeRoot, projectRoot, maxImportZipBytes);
await importSources.cleanupAbandonedUploads().catch((error) => {
  app.log.warn(error, "Failed to clean abandoned import uploads during startup");
});
const importWorker = new ImportWorker(
  databasePath,
  projectRoot,
  runtimeRoot,
  () => readStores.beginReplace(),
  () => readStores.endReplace(),
  (error) => observeWorkerDatabaseError(error)
);
await importSources.cleanupAbandonedUploads(
  Date.now(), undefined, importWorker.activeInputPaths()
).catch((error) => {
  app.log.warn(error, "Failed to clean uploads after interrupted import recovery");
});
const uploadCleanupTimer = setInterval(() => {
  void importSources.cleanupAbandonedUploads(
    Date.now(), undefined, importWorker.activeInputPaths()
  ).catch((error) => app.log.warn(error, "Failed to clean expired import uploads"));
}, 60 * 60_000);
uploadCleanupTimer.unref();
const predictionModelWorker = new PredictionModelWorker(
  databasePath,
  projectRoot,
  runtimeRoot,
  undefined,
  (error) => observeWorkerDatabaseError(error)
);
const maintenance = new DatabaseMaintenance(
  databasePath,
  runtimeRoot,
  () => readStores.beginReplace(),
  () => readStores.endReplace(),
  undefined,
  undefined,
  undefined,
  backupPolicyFromEnvironment()
);
let closing = false;
let trainingZoneBackfillPromise: Promise<void> | null = null;
app.addHook("onClose", async () => {
  closing = true;
  clearInterval(uploadCleanupTimer);
  const results = await Promise.allSettled([
    trainingZoneBackfillPromise ?? Promise.resolve(),
    importWorker.close(),
    recomputeWorker.close(),
    predictionModelWorker.close()
  ]);
  try {
    readStores.close();
  } finally {
    try {
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, "Failed to close API background resources");
    } finally {
      process.off("exit", releasePublicationLock);
      releasePublicationLock();
    }
  }
});

const recoverDatabaseJobs = async (recoverPredictionLeases = false): Promise<void> => {
  if (!existsSync(databasePath)) return;
  const migrationStore = await RaiDatabase.open(databasePath);
  try {
    new RaiApplicationService(migrationStore).recoverInterruptedJobs();
    if (recoverPredictionLeases) {
      // A restored database is an offline snapshot, so any persisted worker lease is stale.
      new PredictionModelService(migrationStore, predictionArtifactRoot).recoverAllLeases();
    }
  } finally {
    migrationStore.close();
  }
};

let databaseReadyAtStartup = true;
try {
  await recoverDatabaseJobs();
} catch (error) {
  databaseReadyAtStartup = false;
  app.log.error(error, "Database startup recovery failed; maintenance restore remains available");
}
let databaseRecoveryRequired = !databaseReadyAtStartup;
let readinessCache: boolean | null = null;
const invalidateDatabaseReadiness = (): void => { readinessCache = null; };

const databaseIsReady = (): boolean => {
  if (readStores.isReplacing || !existsSync(databasePath) || databaseRecoveryRequired) return false;
  try {
    if (readinessCache !== null) return readinessCache;
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      // Do not run PRAGMA quick_check / foreign_key_check here. Both scan the
      // full file and block the HTTP thread for minutes on a multi-GB export.
      // Unreadable files still throw; startup recovery and observeMainDatabaseError
      // flip recovery_required when SQLite reports corruption on a real query.
      const required = database.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'schema_migrations', 'health_records', 'workouts', 'recompute_jobs',
          'prediction_model_runs'
        )
      `).get() as { count: number };
      const ready = required.count === 5;
      readinessCache = ready;
      if (!ready) databaseRecoveryRequired = true;
      return ready;
    } finally {
      database.close();
    }
  } catch {
    databaseRecoveryRequired = true;
    return false;
  }
};

const observeMainDatabaseError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  if (!/file is not a database|database disk image is malformed|database.*corrupt/i.test(message)) return;
  databaseRecoveryRequired = true;
  invalidateDatabaseReadiness();
};
observeWorkerDatabaseError = observeMainDatabaseError;

const openMainDatabase = async (): Promise<RaiDatabase> => {
  try {
    return await RaiDatabase.open(databasePath);
  } catch (error) {
    observeMainDatabaseError(error);
    throw error;
  }
};

const withReadStore = <T>(callback: (store: RaiReadStore) => T): T => {
  try {
    return readStores.use(callback);
  } catch (error) {
    observeMainDatabaseError(error);
    throw error;
  }
};

const withReadDatabase = <T>(callback: (database: DatabaseSync) => T): T => {
  try {
    return readStores.useDatabase(callback);
  } catch (error) {
    observeMainDatabaseError(error);
    throw error;
  }
};

const withReadDatabaseAsync = async <T>(
  callback: (database: DatabaseSync) => Promise<T>
): Promise<T> => {
  try {
    return await readStores.useDatabaseAsync(callback);
  } catch (error) {
    observeMainDatabaseError(error);
    throw error;
  }
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

/**
 * Full busy snapshot for HTTP main-DB writers.
 * Prefer durable job tables over worker `isRunning` (which includes a short
 * pre-timer `scheduled` window after schedule() and would false-positive 409s).
 */
const isDatabaseWriteBusy = (): boolean =>
  importWorker.isRunning ||
  hasActiveRecomputeJob() ||
  hasActivePredictionModelJob();

const isDatabaseRestoreBusy = (): boolean => {
  if (importWorker.isRunning || recomputeWorker.isRunning || predictionModelWorker.isRunning) return true;
  try {
    return hasActiveRecomputeJob() || hasActivePredictionModelJob();
  } catch {
    // A damaged or pre-schema database is exactly when restore must stay usable.
    return false;
  }
};

/** Hide host filesystem paths from public prediction API responses. */
const publicPredictionRun = (run: PredictionModelRun): PredictionModelRun => ({
  ...run,
  artifactPath: run.artifactPath ? basename(run.artifactPath) : null
});

const localToday = (): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

const checkTrainingZoneBackfill = async (): Promise<void> => {
  if (closing) return;
  let release: (() => void) | null = null;
  try {
    release = mutationCoordinator.acquire("training zone backfill");
  } catch (error) {
    if (error instanceof MutationConflictError) return;
    throw error;
  }
  try {
    if (
      !existsSync(databasePath) || importWorker.isRunning || recomputeWorker.isRunning ||
      predictionModelWorker.isRunning || hasActiveRecomputeJob() || hasActivePredictionModelJob()
    ) return;
    const store = await openMainDatabase();
    let queued = false;
    try {
      if (closing) return;
      const active = store.database.prepare("SELECT 1 FROM active_model_run WHERE singleton = 1").get();
      if (!active) return;
      const workoutSetCounts = readTrainingZoneWorkoutSetCounts(store.database);
      const counts = store.database.prepare(`
        SELECT
          (SELECT MAX(local_date) FROM active_daily_zone_profiles) AS latest_profile_date,
          (
            SELECT metric.algorithm_version
            FROM training_metric_runs metric
            JOIN active_model_run active ON active.model_run_id = metric.model_run_id
            WHERE metric.status = 'succeeded'
            ORDER BY metric.completed_at DESC, metric.created_at DESC
            LIMIT 1
          ) AS active_algorithm_version,
          (
            SELECT feature.feature_schema_version
            FROM active_model_run active
            JOIN model_runs model ON model.id = active.model_run_id
            JOIN feature_runs feature ON feature.id = model.feature_run_id
            WHERE active.singleton = 1
          ) AS active_feature_schema_version
      `).get() as unknown as {
        latest_profile_date: string | null;
        active_algorithm_version: string | null;
        active_feature_schema_version: string | null;
      };
      const service = new RaiApplicationService(store);
      if (needsFullTrainingZoneBackfill({
        activeAlgorithmVersion: counts.active_algorithm_version,
        activeFeatureSchemaVersion: counts.active_feature_schema_version,
        missingSummaryCount: workoutSetCounts.missingSummaryCount,
        orphanSummaryCount: workoutSetCounts.orphanSummaryCount
      })) {
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
    if (queued && !closing) recomputeWorker.schedule();
  } finally {
    release();
  }
};

const ensureTrainingZoneBackfill = (): Promise<void> => {
  if (closing) return Promise.resolve();
  if (trainingZoneBackfillPromise) return trainingZoneBackfillPromise;
  const promise = checkTrainingZoneBackfill().finally(() => {
    if (trainingZoneBackfillPromise === promise) trainingZoneBackfillPromise = null;
  });
  trainingZoneBackfillPromise = promise;
  return promise;
};

if (databaseReadyAtStartup) {
  await ensureTrainingZoneBackfill();
  recomputeWorker.schedule();
  predictionModelWorker.schedule();
}
const zoneRefreshTimer = setInterval(() => {
  if (closing) return;
  void ensureTrainingZoneBackfill().catch((error) => {
    app.log.error(error, "Training zone backfill check failed");
  });
}, 5 * 60_000);
zoneRefreshTimer.unref();
app.addHook("onClose", async () => {
  clearInterval(zoneRefreshTimer);
});

app.get("/v1/health", async () => {
  const databaseReady = databaseIsReady();
  return {
    status: databaseReady ? "ok" : "recovery_required",
    databaseReady,
    localOnly: true,
    now: new Date().toISOString()
  };
});
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
  const databaseReady = databaseIsReady();
  const recomputeJob = databaseReady
    ? withReadStore((store) => store.jobs(1)[0] ?? null)
    : null;
  const predictionModelJobActive = databaseReady && hasActivePredictionModelJob();
  const predictionModelJob = databaseReady
    ? withReadDatabase((database) =>
        new PredictionModelService(
          { database },
          predictionArtifactRoot
        ).list(1)[0] ?? null
      )
    : null;
  const importJob = importWorker.latest();
  return {
    databaseReady,
    busy:
      importWorker.isRunning ||
      recomputeWorker.isRunning ||
      predictionModelWorker.isRunning ||
      predictionModelJobActive ||
      recomputeJob?.status === "queued" ||
      recomputeJob?.status === "running",
    recomputeJob,
    importJob,
    predictionModelJob: predictionModelJob ? publicPredictionRun(predictionModelJob) : null
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
    // Prefer 404 for unknown sessions even when other jobs are running.
    // Use training_sessions existence (not full detail DTO) — overrides are valid
    // before features/assessments exist.
    const sessionExists = existsSync(databasePath) && withReadDatabase((database) =>
      Boolean(database.prepare("SELECT 1 FROM training_sessions WHERE id = ?").get(request.params.id))
    );
    if (!sessionExists) {
      return reply.code(404).send({ code: "request_error", message: "未找到该训练记录" });
    }
    if (isDatabaseWriteBusy()) {
      return reply.code(409).send({ message: "任务执行期间不能修改训练覆盖" });
    }
    const store = await openMainDatabase();
    try {
      const service = new RaiApplicationService(store);
      const { overrideId, jobId } = service.appendWorkoutOverride({
        trainingSessionId: request.params.id,
        eligibilityOverride: request.body.eligibilityOverride,
        statisticsParticipation: request.body.statisticsParticipation,
        sessionType: request.body.sessionType,
        performanceProtocol: request.body.performanceProtocol,
        rpe: request.body.rpe,
        conditionTags: request.body.conditionTags,
        note: request.body.note
      });
      recomputeWorker.schedule();
      return { overrideId, jobId };
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

app.get("/v1/mobile/today", async () => {
  // Goals live in a plain file and do not depend on database readiness.
  const goal = mobileGoalsStore.read().weeklyDistanceKm;
  return withReadStore((store) => store.mobileToday(goal));
});

app.get("/v1/mobile/statistics", async () => withReadStore((store) => store.mobileStatistics()));

app.get("/v1/mobile/trends", async () => withReadStore((store) => store.mobileTrends()));

app.get("/v1/mobile/goals", async () => mobileGoalsStore.read());

app.put<{ Body: UpdateMobileGoalsInput }>(
  "/v1/mobile/goals",
  { schema: { body: mobileGoalsBodySchema } },
  async (request) => mobileGoalsStore.write(request.body)
);

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
    if (isDatabaseWriteBusy()) {
      return reply.code(409).send({ message: "任务执行期间不能修改训练分区设置" });
    }
    const store = await openMainDatabase();
    try {
      const settings = new RaiApplicationService(store).appendTrainingZoneProfileSettings(request.body);
      return settings;
    } catch (error) {
      if (error instanceof TrainingZoneProfileRevisionConflictError) {
        return reply.code(409).send({ code: error.code, message: error.message });
      }
      if (error instanceof TrainingZoneProfileValidationError) {
        return reply.code(400).send({ code: error.code, message: error.message });
      }
      throw error;
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
  if (!databaseIsReady()) throw new DatabaseNotReadyError();
  return withReadDatabase((database) => ({
    runs: new PredictionModelService(
      { database },
      predictionArtifactRoot
    ).list().map(publicPredictionRun)
  }));
});

app.get<{ Params: { id: string } }>(
  "/v1/prediction-models/:id",
  { schema: { params: predictionModelIdParamsSchema } },
  async (request, reply) => {
    if (!databaseIsReady()) throw new DatabaseNotReadyError();
    return withReadDatabase((database) => {
      const service = new PredictionModelService(
        { database },
        predictionArtifactRoot
      );
      const run = service.get(request.params.id);
      if (!run) {
        return reply.code(404).send({ message: "未找到预测模型运行" });
      }
      return {
        run: publicPredictionRun(run),
        events: service.events(request.params.id)
      };
    });
  }
);

app.post<{ Body: TrainPredictionModelRequest }>(
  "/v1/prediction-models/train",
  { schema: { body: predictionModelTrainBodySchema } },
  async (request, reply) => {
    if (isDatabaseWriteBusy()) {
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
    const store = await openMainDatabase();
    try {
      const service = new PredictionModelService(store, predictionArtifactRoot);
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
        if (error instanceof PredictionAbilityBaselineUnavailableError) {
          return reply.code(409).send({ code: error.code, message: error.message });
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
    const store = await openMainDatabase();
    try {
      const service = new PredictionModelService(store, predictionArtifactRoot);
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
    if (isDatabaseWriteBusy()) {
      return reply.code(409).send({ message: "任务执行期间不能切换 active Prediction Model" });
    }
    const store = await openMainDatabase();
    try {
      const service = new PredictionModelService(store, predictionArtifactRoot);
      const run = service.get(request.params.id);
      if (!run) return reply.code(404).send({ message: "未找到预测模型运行" });
      if (run.status !== "succeeded") {
        return reply.code(409).send({ message: "只能激活验证成功的预测模型" });
      }
      try {
        service.activate(request.params.id);
      } catch (error) {
        if (error instanceof PredictionModelActivationCompatibilityError) {
          return reply.code(409).send({
            code: error.code,
            message: error.message,
            reasons: error.reasons
          });
        }
        throw error;
      }
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
  if (isDatabaseWriteBusy()) {
    return reply.code(409).send({ message: "任务执行期间不能创建模型运行" });
  }
  const store = await openMainDatabase();
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
  if (isDatabaseWriteBusy()) {
    return reply.code(409).send({ message: "任务执行期间不能切换 active Model Run" });
  }
  const store = await openMainDatabase();
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
      // Ability model switch invalidates residual baselines; clear active CatBoost (R3-9).
      store.database.exec("DELETE FROM active_prediction_model");
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
  const store = await openMainDatabase();
  try {
    const cancellation = new RaiApplicationService(store).requestJobCancellation(request.params.id);
    if (cancellation.outcome === "not_found") {
      return reply.code(404).send({ message: "未找到任务" });
    }
    if (cancellation.outcome === "terminal") {
      return reply.code(409).send({ message: "已完成的任务不能取消" });
    }
    const response: RecomputeJobCancellationResponse = {
      cancelRequested: cancellation.cancelRequested,
      status: cancellation.status
    };
    return response;
  } finally {
    store.close();
  }
});

app.post<{ Body: ImportJobRequest }>(
  "/v1/import-jobs",
  { schema: { body: importJobBodySchema } },
  async (request, reply) => {
  const { sourceId } = request.body;
  if (isDatabaseRestoreBusy()) {
    return reply.code(409).send({ message: "模型任务执行期间不能开始导入" });
  }
  const source = await importSources.get(sourceId);
  if (!source) return reply.code(404).send({ message: "未找到导入来源" });
  const release = takeMutationRelease(request);
  try {
    return importWorker.create(source.inputPath, async (succeeded, durable) => {
      try {
        if (succeeded && durable) {
          databaseRecoveryRequired = false;
          invalidateDatabaseReadiness();
        }
        if (durable && source.kind === "upload") await importSources.cleanupUpload(sourceId);
        else if (durable && succeeded) await importSources.markUsed(sourceId);
      } finally {
        release();
      }
    }, sourceId);
  } catch (error) {
    if (source.kind === "upload") {
      await importSources.cleanupUpload(sourceId).catch((cleanupError) => {
        app.log.warn(cleanupError, "Failed to clean upload after import job creation failed");
      });
    }
    release();
    throw error;
  }
  }
);

app.post("/v1/imports/uploads", async (request, reply) => {
  const file = await request.file();
  if (!file) return reply.code(400).send({ message: "请选择 Apple 健康导出 ZIP" });
  if (file.mimetype !== "application/zip" && file.mimetype !== "application/x-zip-compressed" && !file.filename.toLowerCase().endsWith(".zip")) {
    return reply.code(415).send({ message: "只支持 ZIP 文件" });
  }
  const inspection = await importSources.saveUpload(file.file, file.filename).catch((error: unknown) => {
    if (file.file.truncated) throw new ImportArchiveTooLargeError("ZIP 文件超过大小限制");
    throw error;
  });
  if (file.file.truncated) {
    await importSources.cleanupUpload(inspection.sourceId);
    throw new ImportArchiveTooLargeError("ZIP 文件超过大小限制");
  }
  const source = await importSources.get(inspection.sourceId);
  const sizeBytes = source ? (await (await import("node:fs/promises")).stat(source.originalPath)).size : inspection.exportBytes;
  return {
    sourceId: inspection.sourceId,
    uploadId: inspection.sourceId,
    fileName: file.filename,
    sizeBytes
  };
});

app.post<{ Body: { sourceId: string } }>("/v1/imports/inspect", { schema: { body: importSourceBodySchema } }, async (request, reply) => {
  try { return await importSources.inspect(request.body.sourceId); }
  catch (error) {
    if (error instanceof ImportSourceNotFoundError) return reply.code(404).send({ message: error.message });
    throw error;
  }
});

app.delete<{ Params: { id: string } }>(
  "/v1/import-sources/:id",
  { schema: { params: identifierParamsSchema } },
  async (request, reply) => {
    if (!await importSources.cleanupUpload(request.params.id, importWorker.activeInputPaths())) {
      return reply.code(404).send({ message: "未找到可清理的上传来源" });
    }
    return { deleted: true };
  }
);

app.post("/v1/import-sources/discover", async () => ({ sources: await importSources.discover() }));

app.get("/v1/import-sources/recent", async () => ({ sources: await importSources.recent() }));

app.get("/v1/import-jobs/active", async () => {
  const job = importWorker.latest();
  return job && ["queued", "running"].includes(job.status) ? job : null;
});

app.get("/v1/import-jobs/latest", async () => importWorker.latest());

app.get<{ Params: { id: string } }>("/v1/import-jobs/:id", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  const job = importWorker.get(request.params.id);
  if (!job) return reply.code(404).send({ message: "未找到导入任务" });
  return job;
});

app.get("/v1/backups", async () => maintenance.listBackups());

app.post("/v1/backups", async (_request, reply) => {
  if (isDatabaseWriteBusy()) {
    return reply.code(409).send({ message: "任务执行期间不能创建备份" });
  }
  return maintenance.createBackup();
});

app.get<{ Params: { name: string } }>("/v1/backups/:name", { schema: { params: backupParamsSchema } }, async (request, reply) => {
  try {
    const stream = await maintenance.backupStream(request.params.name);
    reply.header("content-type", "application/x-sqlite3");
    reply.header("content-disposition", `attachment; filename="${request.params.name}"`);
    return reply.send(stream);
  } catch (error) {
    const message = error instanceof Error ? error.message : "备份文件无效";
    return reply.code(message.includes("无效") ? 400 : 404).send({ message });
  }
});

app.delete<{ Params: { name: string } }>("/v1/backups/:name", { schema: { params: backupParamsSchema } }, async (request, reply) => {
  if (isDatabaseWriteBusy()) {
    return reply.code(409).send({ message: "任务执行期间不能删除备份" });
  }
  return { deleted: true, backup: await maintenance.deleteBackup(request.params.name) };
});

app.post<{ Params: { name: string }; Body: { confirmation: string } }>(
  "/v1/backups/:name/restore",
  { schema: { params: backupParamsSchema, body: restoreBodySchema } },
  async (request, reply) => {
    if (request.body.confirmation !== "恢复此备份") {
      return reply.code(400).send({ message: "确认文字不匹配" });
    }
    if (isDatabaseRestoreBusy()) {
      return reply.code(409).send({ message: "任务执行期间不能恢复数据库" });
    }
    const result = await maintenance.restoreBackup(
      request.params.name,
      () => recoverDatabaseJobs(true)
    );
    databaseRecoveryRequired = false;
    invalidateDatabaseReadiness();
    recomputeWorker.schedule();
    predictionModelWorker.schedule();
    return { restored: true, restoredBackup: result.restored, safetyBackup: result.safetyBackup };
  }
);

app.delete<{ Body: { confirmation: string } }>("/v1/database", { schema: { body: deleteBodySchema } }, async (request, reply) => {
  if (request.body?.confirmation !== "删除我的 RAI 数据") {
    return reply.code(400).send({ message: "确认文字不匹配" });
  }
  if (isDatabaseRestoreBusy()) {
    return reply.code(409).send({ message: "任务执行期间不能删除数据库" });
  }
  const backupInfo = await maintenance.deleteDatabase();
  databaseRecoveryRequired = true;
  invalidateDatabaseReadiness();
  return backupInfo.restorable === false
    ? { deleted: true, preservation: { kind: "quarantine" as const, snapshot: backupInfo } }
    : { deleted: true, preservation: { kind: "backup" as const, backup: backupInfo } };
});

if (existsSync(webDist)) {
  app.get("/*", async (_request, reply) => reply.sendFile("index.html"));
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const payload = apiErrorPayload(error);
  void reply.code(payload.status).send(payload.body);
});

await app.listen({ host, port });
const address = app.server.address();
if (!address || typeof address === "string") {
  throw new Error("API did not bind to a TCP port");
}
localRequestSecurityOptions.apiPort = address.port;
if (process.send) process.send({ type: "rai:ready", port: address.port });
let shutdownPromise: Promise<void> | null = null;
const shutdown = (signal: NodeJS.Signals | "IPC"): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    app.log.info({ signal }, "Shutting down local API");
    try {
      await app.close();
    } catch (error) {
      app.log.error(error, "Local API shutdown failed");
      process.exitCode = 1;
    } finally {
      if (process.connected) process.disconnect();
    }
  })();
  return shutdownPromise;
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.on("message", (message: unknown) => {
  if (message === "rai:shutdown") void shutdown("IPC");
});
app.log.info({ databasePath, runtimeRoot, url: `http://${host}:${address.port}` }, "RAI local API ready");
