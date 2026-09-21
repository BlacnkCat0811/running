import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import type {
  HandshakeResponse,
  HealthResponse,
  LockMobileSessionInput,
  MobileSessionKind,
  MobileSessionStructure,
  MobileWeeklyPlanGenerationResponse,
  OverrideWorkoutInput,
  PredictionModelRun,
  RecomputeJobCancellationResponse,
  TrainPredictionModelRequest,
  TrainingStatisticsGranularity,
  UpdateMobileGoalsInput,
  UpdateTrainingZoneProfileInput
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
import { ModelRunActivationError, PendingMigrationsError, RaiDatabase, SqliteModelRunRepository, acquireDatabasePublicationLock } from "@rai/storage-sqlite";
import Fastify from "fastify";

import { apiErrorPayload } from "./api-error.js";
import { CommandQueue, applyMutationCommand } from "./command-queue.js";
import { RaiReadStore, mobileLocalDate } from "./data.js";
import { createImportSourceManager } from "./import-sources.js";
import { finalizeImportSource } from "./import-source-finalization.js";
import {
  installLocalRequestSecurity,
  isTrustedDevelopmentOrigin
} from "./local-request-security.js";
import { DatabaseMaintenance, backupPolicyFromEnvironment } from "./maintenance.js";
import { MobileGoalsRevisionConflictError, MobileGoalsStore, type PlanMergeOptions } from "./mobile-goals.js";
import { mobileLockRejection, mobileRefreshOutcome } from "./mobile-sync.js";
import { MutationConflictError, MutationCoordinator } from "./mutation-coordinator.js";
import { DatabaseNotReadyError, ReadStoreManager } from "./read-store-manager.js";
import { registerCommandRoutes } from "./routes/command-routes.js";
import { registerImportRoutes } from "./routes/import-routes.js";
import { RuntimeTelemetry } from "./runtime-telemetry.js";
import { importEngine, nativeFallback, nativeBinary, NATIVE_VERSION } from "@rai/health-export-parser";
import { installMutationLifetime } from "./request-mutation-lifetime.js";
import {
  backupParamsSchema,
  deleteBodySchema,
  identifierParamsSchema,
  mobileGoalsBodySchema,
  mobileLockBodySchema,
  mobilePlanSyncedBodySchema,
  mobileWeeklyPlanGenerateBodySchema,
  modelComparisonQuerySchema,
  openapiDocument,
  overrideBodySchema,
  predictionModelIdParamsSchema,
  predictionModelTrainBodySchema,
  predictionQuerySchema,
  recoveryTrendQuerySchema,
  restoreBodySchema,
  trainingLoadQuerySchema,
  trainingStatisticsHistoryQuerySchema,
  trainingZoneProfileBodySchema,
  trainingZonesHistoryQuerySchema,
  trendQuerySchema,
  workoutListQuerySchema
} from "./schemas.js";
import { TaskAdmissionScheduler } from "./task-admission.js";
import { needsFullTrainingZoneBackfill, readTrainingZoneWorkoutSetCounts } from "./training-zone-backfill.js";
import { TryAcquireGate } from "./try-acquire-gate.js";
import { generateWeeklyPlan, overwriteWarning, weeklyPlanDates } from "./weekly-plan-service.js";
import {
  ImportWorker,
  PredictionModelWorker,
  RecomputeWorker
} from "./worker.js";
import { assemblePlanCandidates, type PlanCandidateDay } from "./workout-segments.js";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeRoot = resolve(process.env.RAI_RUNTIME_ROOT ?? projectRoot);
const databasePath = resolve(process.env.RAI_DATABASE ?? resolve(projectRoot, "var/rai.sqlite"));
const controlDatabasePath = resolve(process.env.RAI_CONTROL_DATABASE ?? resolve(runtimeRoot, "var/rai-control.sqlite"));
const predictionArtifactRoot = resolve(runtimeRoot, "var", "model-artifacts", "prediction");
const port = Number(process.env.RAI_API_PORT ?? 8787);
const host = process.env.RAI_API_HOST ?? "127.0.0.1";
const apiToken = process.env.RAI_API_TOKEN?.trim() || undefined;
const maxImportZipBytes = Number(process.env.RAI_IMPORT_MAX_ZIP_BYTES ?? 4 * 1024 ** 3);
const importExecutionEngine = { name: importEngine(), fallback: nativeFallback(), version: NATIVE_VERSION };
if (importExecutionEngine.name === "rust" && importExecutionEngine.fallback === "none" && !existsSync(nativeBinary())) {
  throw new Error("Rust worker is missing. Run npm run rust:build or configure RAI_RUST_BINARY before enabling Rust.");
}
const serverId = process.env.RAI_SERVER_ID?.trim() || "local";
const athleteId = process.env.RAI_ATHLETE_ID?.trim() || "athlete_1";
const datasetEpoch = process.env.RAI_DATASET_EPOCH?.trim() || "default";
const syncProtocolVersion = 1;
const scopeSyncBatchId = (batchId: string): string => createHash("sha256")
  .update([serverId, athleteId, datasetEpoch, batchId].join("\0"))
  .digest("hex");
const configuredOrigins = new Set((process.env.RAI_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean));
const allowAuthenticatedRemote = process.env.RAI_ALLOW_REMOTE_TOKEN_AUTH === "1";
/**
 * Hosts allowed to read the public routes below without a token.
 *
 * Empty by default, which keeps the token gate on everything: opening the Web
 * SPA to anonymous browsers is a deployment decision, not a code default.
 * Nginx forwards `Host: tpandmr.xyz` (no port), so that is the spelling to use.
 */
const publicReadHosts = new Set((process.env.RAI_PUBLIC_HOSTS ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean));
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
// Every route this process mounts, recorded as Fastify resolves it.
//
// `schemas.test.ts` has to enumerate the mountings by reading this file as text,
// and text cannot be made airtight: `const a = app; a.post(...)`,
// `(app as any).post(...)` and a route module whose plugin argument is the
// idiomatic `fastify` all mount a write route with no token that scan
// recognises. The hook is the interpreter's own answer, and it is written to
// `RAI_ROUTE_DUMP` when that names a file — which lets the runtime test compare
// the resolved table against the classification registries below, and doubles
// as an ops aid (`RAI_ROUTE_DUMP=/tmp/routes.json systemctl restart rai-api`).
// Registered before any route so nothing can be mounted before it is watching.
const mountedRoutes: Array<{ method: string; url: string }> = [];
app.addHook("onRoute", (routeOptions) => {
  const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
  for (const method of methods) mountedRoutes.push({ method, url: routeOptions.url });
});
// Local-first product: keep the SPA and API out of third-party iframes and
// guard against content-type sniffing. frame-ancestors does not constrain any
// resource loading, so this cannot break the app itself.
app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", "frame-ancestors 'none'");
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
    callback(null, configuredOrigins.has(origin) || isTrustedDevelopmentOrigin(origin, {
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
/**
 * Read routes an unauthenticated browser may call, once the request arrives on
 * a host named in `RAI_PUBLIC_HOSTS`.
 *
 * The Web SPA is meant to open without a token and render every view; the API
 * keeps the write surface shut. Two entries here are load-bearing rather than
 * incidental: `/v1/health` decides whether pages render at all, and
 * `/v1/runtime-status` is polled by `GlobalTaskStatus` from every page — leave
 * it out and the whole app grows a "reconnecting" banner instead of showing
 * data.
 *
 * Deliberately absent, and each for a reason that would not survive a review
 * that only asked "is it a GET?":
 *   GET /v1/backups/:name        streams the raw SQLite file — the entire dataset
 *   GET /v1/import-sources/*     returns ImportSource.inputPath / .originalPath,
 *                                which is a map of the server's filesystem
 *   GET /v1/diagnostics          server-side job, model and issue internals
 *   GET /v1/openapi.json         the full route table
 *   GET /v1/backups              backup inventory
 *   GET /v1/import-jobs/*        import pipeline state
 *   GET /v1/jobs, /v1/jobs/:id   recompute job events
 *
 * Read routes that stay token-gated are named in `tokenRequiredReadRoutes`
 * below; `server-runtime.test.ts` fails if a mounted `/v1/` GET appears in
 * neither set, so a new read route has to be classified on purpose instead of
 * inheriting whichever default the author did not think about.
 */
const publicReadRoutes = new Set([
  "/v1/health",
  "/v1/handshake",
  "/v1/dashboard",
  "/v1/data-summary",
  "/v1/data-audit",
  "/v1/runtime-status",
  "/v1/workouts",
  "/v1/workouts/:id",
  "/v1/workouts/:id/series",
  "/v1/trends",
  "/v1/recovery-trends",
  "/v1/training-statistics/overview",
  "/v1/training-statistics/history",
  "/v1/training-statistics/load",
  "/v1/training-zones/current",
  "/v1/training-zones/history",
  "/v1/predictions",
  "/v1/prediction-models",
  "/v1/prediction-models/:id",
  "/v1/model-runs",
  "/v1/model-runs/compare",
  "/v1/mobile/today",
  "/v1/mobile/workout-plan",
  "/v1/mobile/statistics",
  "/v1/mobile/trends",
  "/v1/mobile/goals"
]);
/**
 * Read routes that keep requiring the token. See the comment above.
 */
const tokenRequiredReadRoutes = new Set([
  "/v1/performance",
  "/v1/commands/:id",
  "/v1/openapi.json",
  "/v1/diagnostics",
  "/v1/backups",
  "/v1/backups/:name",
  "/v1/import-sources/recent",
  "/v1/import-jobs/active",
  "/v1/import-jobs/latest",
  "/v1/import-jobs/:id",
  "/v1/jobs",
  "/v1/jobs/:id"
]);
// Upload streams and discover are long/IO-only; they must not hold the mutation lock.
// Submission only persists intent; executors acquire the shared writer lease.
const metadataOnlyMutationRoutes = new Set([
  "/v1/commands",
  "/v1/commands/:id/cancel",
  "/v1/import-jobs",
  "/v1/import-jobs/:id/cancel",
  // Inspection only reads runtime source metadata, never the main database.
  "/v1/imports/inspect",
  "/v1/import-sources/discover",
  "/v1/imports/uploads",
  "/v1/mobile/goals",
  "/v1/mobile/lock",
  "/v1/mobile/workout-plan/generate",
  "/v1/mobile/workout-plan/synced"
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
/**
 * Write routes that take the mutation lock and are allowed to run without a
 * database.
 *
 * These are the routes that *create* or *repair* the store — importing, and
 * restoring or deleting a backup — so gating them on `existsSync(databasePath)`
 * would lock the runner out of recovery. They were previously absent from both
 * registries, which left no way to tell a deliberate omission from a forgotten
 * one; naming them is what lets `schemas.test.ts` require **every** write route
 * to be classified in exactly one of the three sets.
 *
 * Declarative: the default branch of the `preHandler` hook below already takes
 * the lock and skips the readiness gate, so this set does not change behaviour.
 */
export const lockOnlyMutationRoutes = new Set([
  "/v1/import-sources/:id",
  "/v1/backups/:name",
  "/v1/backups/:name/restore"
]);
const mutationCoordinator = new MutationCoordinator();
const sourceMutations = new MutationCoordinator();
const taskAdmission = new TaskAdmissionScheduler(mutationCoordinator);
const telemetry = new RuntimeTelemetry();
const requestStarts = new WeakMap<object, number>();
app.addHook("onRequest", async (request) => { requestStarts.set(request, performance.now()); });
app.addHook("onResponse", async (request, reply) => {
  const start = requestStarts.get(request);
  if (start !== undefined) telemetry.record(performance.now() - start, reply.statusCode);
});
app.addHook("onClose", async () => telemetry.close());
const mutationReleases = new WeakMap<object, () => void>();
const localRequestSecurityOptions = {
  apiPort: port,
  ...(apiToken ? { apiToken } : {}),
  developmentOrigins,
  allowAuthenticatedRemote,
  trustedOrigins: configuredOrigins,
  ...(allowPrivateLanWebPort == null ? {} : { allowPrivateLanWebPort }),
  // Both halves are needed for anonymous reads to work at all, so they travel
  // together: routes without hosts passes nothing through, hosts without routes
  // match no path.
  ...(publicReadHosts.size > 0 ? { publicReadRoutes, publicReadHosts } : {})
};
installLocalRequestSecurity(app, localRequestSecurityOptions);
app.addHook("preHandler", async (request, reply) => {
  const routeUrl = request.routeOptions.url;
  if (!unsafeMethods.has(request.method) || (routeUrl !== undefined && metadataOnlyMutationRoutes.has(routeUrl))) return;
  if (taskAdmission.isBlocked && routeUrl !== undefined && databaseRequiredMutationRoutes.has(routeUrl)) {
    return reply.code(409).send({ code: "publication_recovery_required", message: "数据库发布需要恢复，请先重启服务检查恢复结果" });
  }
  if (routeUrl !== undefined && databaseRequiredMutationRoutes.has(routeUrl) && !existsSync(databasePath)) {
    return reply.code(409).send({
      code: "database_not_ready",
      message: "本地 RAI 数据库尚未就绪，请先导入或恢复数据"
    });
  }
  // Control-row cancellation pins out the next import until its handler finishes.
  const controlOwner = routeUrl === "/v1/jobs/:id/cancel" ? "recompute" :
    routeUrl === "/v1/prediction-models/:id/cancel" ? "prediction" : null;
  const controlRelease = controlOwner ? taskAdmission.acquireControl(controlOwner) : null;
  if (controlRelease) { mutationReleases.set(request, controlRelease); return; }
  const release = await mutationCoordinator.acquireWhenAvailable(`${request.method} ${routeUrl ?? request.url}`);
  if (request.raw.aborted || reply.raw.destroyed) { release(); reply.hijack(); return; }
  if (routeUrl !== undefined && databaseRequiredMutationRoutes.has(routeUrl)) {
    // The state may have changed during the bounded lease wait.
    if (taskAdmission.isBlocked || !existsSync(databasePath)) {
      release();
      return reply.code(409).send({ code: "database_not_ready", message: "数据库尚未就绪，请先完成恢复" });
    }
  }
  mutationReleases.set(request, release);
});
const releaseMutation = (request: object): void => {
  mutationReleases.get(request)?.();
  mutationReleases.delete(request);
};
app.addHook("onError", async (request) => releaseMutation(request));
installMutationLifetime(app, releaseMutation);
const webDist = resolve(projectRoot, "apps/web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false });
}

// Both annotated: `readStores` asks the import worker for the newest refresh and
// the worker asks the store pool to drain before it swaps the database file, so
// inference would chase its own tail through the two initializers.
const readStores: ReadStoreManager = new ReadStoreManager(databasePath, () => mobileRefreshOutcome(importWorker.latest()));
const mobileGoalsStore = new MobileGoalsStore(runtimeRoot, controlDatabasePath);
let observeWorkerDatabaseError: (error: unknown) => void = () => {};
const recomputeWorker = new RecomputeWorker(databasePath, (error) => observeWorkerDatabaseError(error), taskAdmission.owner("recompute"));
const importSources = createImportSourceManager(runtimeRoot, projectRoot, maxImportZipBytes);
await importSources.cleanupAbandonedUploads().catch((error) => {
  app.log.warn(error, "Failed to clean abandoned import uploads during startup");
});
const importWorker: ImportWorker = new ImportWorker(
  databasePath,
  projectRoot,
  runtimeRoot,
  () => readStores.beginReplace(),
  () => readStores.endReplace(),
  (error) => observeWorkerDatabaseError(error),
  {
    scope: JSON.stringify([serverId, athleteId, datasetEpoch]),
    admission: taskAdmission.owner("import"),
    engine: importExecutionEngine,
    onRecoveryRequired: () => {
      databaseRecoveryRequired = true;
      invalidateDatabaseReadiness();
      taskAdmission.blockUntilRestart("import_publication_recovery_required");
    },
    onTerminal: async (job, succeeded, durable) => {
      if (succeeded && durable) {
        databaseRecoveryRequired = false;
        invalidateDatabaseReadiness();
      }
      await finalizeImportSource(importSources, sourceMutations, importWorker, job, succeeded, durable);
    }
  }
);
await importSources.cleanupAbandonedUploads(
  Date.now(), undefined, importWorker.activeInputPaths()
).catch((error) => {
  app.log.warn(error, "Failed to clean uploads after interrupted import recovery");
});
const uploadCleanupTimer = setInterval(() => {
  let release: () => void;
  try { release = sourceMutations.acquire("expired upload cleanup"); }
  catch { return; }
  void importSources.cleanupAbandonedUploads(
    Date.now(), undefined, importWorker.activeInputPaths()
  ).catch((error) => app.log.warn(error, "Failed to clean expired import uploads")).finally(release);
}, 60 * 60_000);
uploadCleanupTimer.unref();
const predictionModelWorker = new PredictionModelWorker(
  databasePath,
  projectRoot,
  runtimeRoot,
  undefined,
  (error) => observeWorkerDatabaseError(error),
  taskAdmission.owner("prediction")
);
const commandQueue = new CommandQueue(
  runtimeRoot, JSON.stringify([serverId, athleteId, datasetEpoch]), taskAdmission.owner("command"),
  (command) => applyMutationCommand(databasePath, predictionArtifactRoot, command),
  () => { invalidateDatabaseReadiness(); recomputeWorker.schedule(); predictionModelWorker.schedule(); }
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
    commandQueue.close(),
    trainingZoneBackfillPromise ?? Promise.resolve(),
    importWorker.close(),
    recomputeWorker.close(),
    predictionModelWorker.close()
  ]);
  try {
    readStores.close();
    mobileGoalsStore.close();
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
  const migrationStore = await RaiDatabase.open(databasePath, { migrationPolicy: "refuse" });
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
  if (error instanceof PendingMigrationsError) {
    app.log.fatal({ versions: error.versions, names: error.names }, error.message);
    process.exit(78);
  }
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
    // Startup recovery above performs the strict whole-database validation.
    // Request-scoped writers refuse migrations, check checksums and keep
    // foreign_keys=ON, but avoid repeating a full foreign_key_check when the
    // schema is already current. Pending migrations must be applied offline.
    return await RaiDatabase.open(databasePath, {
      migrationPolicy: "refuse",
      foreignKeyValidation: databaseRecoveryRequired ? "always" : "after-migration"
    });
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
  // Terminal imports still pin the receipt DB until final acknowledgement.
  if (taskAdmission.hasActiveControls || commandQueue.hasPending || importWorker.hasPending || recomputeWorker.isRunning || predictionModelWorker.isRunning) return true;
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
  if (closing || taskAdmission.isBlocked) return;
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
importWorker.resume();
commandQueue.resume();
const zoneRefreshTimer = setInterval(() => {
  if (closing) return;
  void ensureTrainingZoneBackfill().catch((error) => {
    app.log.error(error, "Training zone backfill check failed");
  });
}, 5 * 60_000);
zoneRefreshTimer.unref();

/**
 * Reclaims abandoned database copies: `.replaced.` rollback points and
 * `.importing.` staging files left by a process that was killed before its
 * `finally` ran.
 *
 * `ensureBackupCapacity` already reclaims them, but only when a backup or a web
 * import happens — so a machine that stops doing either keeps every leftover
 * forever, each one a full copy of the database, sitting next to the live one
 * where no retention policy looks. The reclaimer keeps anything younger than
 * 24 h, so running it on a timer cannot race an in-flight import.
 */
async function sweepAbandonedDatabases(): Promise<void> {
  try {
    const nativeRemoved = await importWorker.reclaimAbandonedNativeSpools();
    if (nativeRemoved) app.log.info({ nativeRemoved }, "Reclaimed abandoned native spools");
    const reclaimed = await maintenance.reclaimDisplacedDatabases();
    if (reclaimed.removed > 0) {
      app.log.info(reclaimed, "Reclaimed abandoned database copies");
    }
  } catch (error) {
    app.log.warn(error, "Abandoned database reclamation failed");
  }
}

const abandonedDatabaseSweepTimer = setInterval(() => {
  if (closing) return;
  void sweepAbandonedDatabases();
}, 24 * 60 * 60_000);
abandonedDatabaseSweepTimer.unref();
// A restart is exactly when a killed process's leftovers are most likely to be
// sitting there, and making them wait a full day would be worse than the bug.
const abandonedDatabaseSweepKickoff = setTimeout(() => {
  if (closing) return;
  void sweepAbandonedDatabases();
}, 60_000);
abandonedDatabaseSweepKickoff.unref();

app.addHook("onClose", async () => {
  clearInterval(zoneRefreshTimer);
  clearInterval(abandonedDatabaseSweepTimer);
  clearTimeout(abandonedDatabaseSweepKickoff);
});

/**
 * Weekly plan refresh. Runs hourly so that a Monday generation which fails is
 * retried the same day, and never regenerates once the week is already planned.
 */
async function ensureWeeklyPlan(): Promise<void> {
  const today = mobileLocalDate();
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  if (weekday !== 1) return;
  if (weeklyPlanDates(today).length === 0) return;
  const goals = mobileGoalsStore.read();
  if (goals.weekPlan.some((day) => day.localDate === today)) return;
  await runWeeklyPlanGeneration(goals.revision);
}

const weeklyPlanTimer = setInterval(() => {
  if (closing) return;
  void ensureWeeklyPlan().catch((error) => {
    app.log.error(error, "Weekly plan generation failed");
  });
}, 60 * 60_000);
weeklyPlanTimer.unref();
// The hourly tick alone means a service restarted on a Monday morning would not
// plan that week until an hour later, so probe once shortly after boot too.
const weeklyPlanKickoff = setTimeout(() => {
  if (closing) return;
  void ensureWeeklyPlan().catch((error) => {
    app.log.error(error, "Weekly plan generation failed");
  });
}, 60_000);
weeklyPlanKickoff.unref();
app.addHook("onClose", async () => {
  clearInterval(weeklyPlanTimer);
  clearTimeout(weeklyPlanKickoff);
});

app.get("/v1/health", async (): Promise<HealthResponse> => {
  const databaseReady = databaseIsReady();
  return {
    status: databaseReady ? "ok" : "recovery_required",
    databaseReady,
    localOnly: process.env.RAI_DEPLOYMENT_MODE !== "cloud",
    serverId,
    athleteId,
    datasetEpoch,
    syncProtocolVersion,
    now: new Date().toISOString()
  };
});
app.get("/v1/handshake", async (): Promise<HandshakeResponse> => ({
  serverId,
  athleteId,
  datasetEpoch,
  syncProtocolVersion,
  apiVersion: "v1"
}));
app.get("/v1/openapi.json", async () => openapiDocument);
app.get("/v1/performance", async () => ({
  ...telemetry.snapshot(), admission: taskAdmission.snapshot(),
  importPending: importWorker.hasPending, commandPending: commandQueue.hasPending
}));

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
  const importJob = importWorker.active() ?? importWorker.latest();
  return {
    databaseReady,
    busy:
      commandQueue.hasPending ||
      importWorker.hasPending ||
      recomputeWorker.isRunning ||
      predictionModelWorker.isRunning ||
      predictionModelJobActive ||
      recomputeJob?.status === "queued" ||
      recomputeJob?.status === "running",
    recomputeJob,
    importJob,
    taskAdmission: taskAdmission.snapshot(),
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

/**
 * Plan days that could explain a run, for the detail page's segment panel.
 *
 * Which days count as candidates, and the order they are read in, is
 * `assemblePlanCandidates`' job — this only supplies what the store has. The
 * split exists so the precedence rules (push receipt, then the newest revision
 * that answers for a date, rest days included) can be tested as a pure function.
 */
const PLAN_PUSH_HISTORY_DAYS = 90;

const planSegmentCandidates = (): PlanCandidateDay[] => {
  const since = new Date(Date.now() - PLAN_PUSH_HISTORY_DAYS * 86_400_000).toISOString();
  return assemblePlanCandidates(mobileGoalsStore.planPushes(since), mobileGoalsStore.planHistory());
};

app.get<{ Params: { id: string } }>("/v1/workouts/:id/series", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  const series = withReadStore((store) => store.workoutSeries(request.params.id, planSegmentCandidates()));
  if (!series) return reply.code(404).send({ message: "未找到该训练的时间序列" });
  return series;
});

app.post<{ Body: { localDate: string; kind: MobileSessionKind; revision?: number; structure?: MobileSessionStructure | null } }>(
  "/v1/mobile/workout-plan/synced",
  { schema: { body: mobilePlanSyncedBodySchema } },
  async (request) => {
    const pushedAt = new Date().toISOString();
    mobileGoalsStore.recordPlanPush({
      localDate: request.body.localDate,
      kind: request.body.kind,
      revision: request.body.revision ?? 0,
      structure: request.body.structure ?? null,
      pushedAt
    });
    return { recordedAt: pushedAt };
  }
);

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
  const goals = mobileGoalsStore.read();
  return withReadStore((store) => store.mobileToday(goals.weeklyDistanceKm, goals, mobileGoalsStore.planHistory(200)));
});

// Executable week handed to the WorkoutKit bridge. Read-only: it never mutates
// goals, so it is deliberately absent from the mutation route registries below.
app.get("/v1/mobile/workout-plan", async () => {
  const goals = mobileGoalsStore.read();
  return withReadStore((store) => store.mobileWorkoutPlan(goals.weeklyDistanceKm, goals));
});

/**
 * Generates the next week of training and persists it into goals.weekPlan.
 * A generation that cannot be validated falls back to the heuristic template,
 * so this endpoint never leaves the week without a plan.
 */
async function runWeeklyPlanGeneration(expectedRevision?: number): Promise<MobileWeeklyPlanGenerationResponse> {
  const goals = mobileGoalsStore.read();
  if (expectedRevision != null && expectedRevision !== goals.revision) {
    throw new MobileGoalsRevisionConflictError(goals.revision);
  }
  const inputs = withReadStore((store) => store.mobileWeeklyPlanInputs(goals.weeklyDistanceKm, goals, mobileGoalsStore.planHistory(200)));
  const result = await generateWeeklyPlan({
    today: inputs.today,
    goals,
    prescription: inputs.prescription,
    // Caps the generated week at last week's volume + 30%, so a model that
    // ignores the prompt cannot prescribe a ramp the runner has not earned.
    previousWeekDistanceKm: inputs.previousWeekDistanceKm
  });
  // An empty result means the date window itself could not be built, not that
  // the runner should have a blank week. Writing it would erase the stored plan,
  // so the existing week is kept and the caller is told why.
  if (result.days.length === 0) {
    return {
      generatedAt: result.audit.generatedAt ?? new Date().toISOString(),
      revision: goals.revision,
      audit: result.audit,
      days: [],
      warnings: [...result.warnings, "未能算出有效的日期窗口，已保留既有课表"]
    };
  }
  // Prepended, not appended: this warns that stored work is being replaced, and
  // the model-validation notes can fill the list ahead of it otherwise.
  const overwrite = overwriteWarning(goals.weekPlan, result.days);
  const warnings = overwrite ? [overwrite, ...result.warnings] : result.warnings;
  const written = mobileGoalsStore.write(
    {
      expectedRevision: goals.revision,
      weeklyDistanceKm: goals.weeklyDistanceKm,
      weekPlan: result.days,
      weekPlanAudit: result.audit
    },
    // The generator already measured these days against this same prescription;
    // re-measuring is idempotent and keeps every write on one path.
    { prescription: inputs.prescription }
  );
  return {
    generatedAt: result.audit.generatedAt ?? new Date().toISOString(),
    revision: written.revision,
    audit: result.audit,
    days: result.days,
    warnings
  };
}

const weeklyPlanGenerationGate = new TryAcquireGate();

app.post<{ Body: { expectedRevision?: number } }>(
  "/v1/mobile/workout-plan/generate",
  { schema: { body: mobileWeeklyPlanGenerateBodySchema } },
  async (request, reply) => {
    const release = weeklyPlanGenerationGate.tryAcquire();
    if (!release) {
      return reply.code(409).send({
        code: "weekly_plan_generation_busy",
        message: "课表正在生成，请稍后重试"
      });
    }
    try {
      return await runWeeklyPlanGeneration(request.body?.expectedRevision);
    } catch (error) {
      if (error instanceof MobileGoalsRevisionConflictError) {
        return reply.code(409).send({ code: error.code, message: error.message, currentRevision: error.currentRevision });
      }
      throw error;
    } finally {
      release();
    }
  }
);

app.get("/v1/mobile/statistics", async () => withReadStore((store) => store.mobileStatistics()));

app.get("/v1/mobile/trends", async () => withReadStore((store) => store.mobileTrends()));
app.get<{ Querystring: { days?: string } }>(
  "/v1/recovery-trends",
  { schema: { querystring: recoveryTrendQuerySchema } },
  async (request) => withReadStore((store) => store.recoveryTrends(Math.min(Math.max(Number(request.query.days ?? 28), 1), 365)))
);

/**
 * The zone profile every plan response is measured against.
 *
 * The key is omitted — not set to `null` — when the read database is not
 * available, which tells the goals store to echo what is stored rather than
 * measure with paces the runner may not use.
 */
const planPrescription = (): PlanMergeOptions =>
  databaseIsReady() ? { prescription: withReadStore((store) => store.mobilePlanPrescription()) } : {};

app.get("/v1/mobile/goals", async () => mobileGoalsStore.read(planPrescription()));

app.put<{ Body: UpdateMobileGoalsInput }>(
  "/v1/mobile/goals",
  { schema: { body: mobileGoalsBodySchema } },
  async (request, reply) => {
    try {
      // Re-measured with the live zone prescription so a distance typed into
      // the goals editor cannot outlive the structure it contradicts. The key
      // is omitted — not set to null — when the read database is unavailable:
      // there are no zones and no plan views in that state, and `null` would
      // silently substitute the default paces for the runner's own.
      return mobileGoalsStore.write(request.body, planPrescription());
    } catch (error) {
      if (error instanceof MobileGoalsRevisionConflictError) {
        return reply.code(409).send({ code: error.code, message: error.message, currentRevision: error.currentRevision });
      }
      throw error;
    }
  }
);

app.post<{ Body: LockMobileSessionInput }>(
  "/v1/mobile/lock",
  { schema: { body: mobileLockBodySchema } },
  async (request, reply) => {
    const goals = mobileGoalsStore.read();
    const ignoreLock = request.body.action === "relock";
    const snapshot = withReadStore((store) => store.mobileToday(goals.weeklyDistanceKm, {
      ...goals,
      lockedSession: ignoreLock ? null : goals.lockedSession
    }));
    const rejection = mobileLockRejection({
      syncStatus: snapshot.sync.status,
      recommendationRevision: snapshot.recommendationRevision,
      expectedRevision: request.body.expectedRevision
    });
    if (rejection) return reply.code(409).send(rejection);
    if (request.body.action === "lock" && snapshot.lock.present) {
      return mobileGoalsStore.read(planPrescription());
    }
    return mobileGoalsStore.lockSession(
      {
        localDate: snapshot.today.localDate,
        session: snapshot.nextSession,
        verdictTone: snapshot.verdict.tone,
        lockedAt: new Date().toISOString()
      },
      planPrescription()
    );
  }
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
    store.database.exec("BEGIN IMMEDIATE");
    try {
      new SqliteModelRunRepository(store.database).activateSucceeded(request.params.id, new Date().toISOString());
      store.database.exec("COMMIT");
    } catch (error) {
      try { store.database.exec("ROLLBACK"); } catch { /* preserve the activation error */ }
      if (error instanceof ModelRunActivationError) {
        if (error.code === "not_found") return reply.code(404).send({ message: "未找到模型运行" });
        if (error.code === "not_succeeded") return reply.code(409).send({ message: "只能激活成功的模型运行" });
        if (error.code === "missing_metrics") return reply.code(409).send({ message: "该模型运行没有成功的运动统计结果，不能激活" });
        return reply.code(409).send({ message: "该模型运行未通过模型版本门禁，不能激活" });
      }
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

registerImportRoutes(app, { importWorker, importSources, sourceMutations, scopeSyncBatchId });
registerCommandRoutes(app, commandQueue);

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
  if (payload.status === 429) reply.header("Retry-After", "5");
  void reply.code(payload.status).send(payload.body);
});

// The mounted route table, written only when `RAI_ROUTE_DUMP` names a file.
//
// Fastify is the only authority on what was actually mounted: an alias, a cast,
// or a plugin parameter named `fastify` all mount a route without leaving a
// token a source scan recognises. `server-runtime.test.ts` compares this dump
// against the classification registries, so "every write route is classified"
// is decided by the router rather than by a regex.
const routeDumpPath = process.env.RAI_ROUTE_DUMP?.trim();
if (routeDumpPath) {
  await app.ready();
  await writeFile(routeDumpPath, JSON.stringify(mountedRoutes, null, 2), "utf8");
}

await app.listen({ host, port });
const address = app.server.address();
if (!address || typeof address === "string") {
  throw new Error("API did not bind to a TCP port");
}
localRequestSecurityOptions.apiPort = address.port;
if (process.send) process.send({ type: "rai:ready", port: address.port });
// Logged so "the config is live" is answerable from the journal instead of
// inferred from a 200: an unset RAI_PUBLIC_HOSTS means every /v1 route still
// demands the token, which is indistinguishable from a working anonymous read
// if you only look at the browser.
app.log.info(
  { publicReadHosts: [...publicReadHosts], publicReadRoutes: publicReadRoutes.size, tokenRequiredReadRoutes: tokenRequiredReadRoutes.size },
  publicReadHosts.size > 0
    ? "Anonymous read enabled for the listed hosts; writes still require the token"
    : "Anonymous read disabled: every /v1 route requires the token"
);
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
