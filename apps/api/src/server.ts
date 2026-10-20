import { workoutExportQuerySchema, workoutSummaryExport } from "./workout-summary-export.js";
import { workoutDateWindow } from "./workout-date-window.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type {
  HandshakeResponse,
  HealthResponse,
  LockMobileSessionInput,
  MobileSessionKind,
  MobileSessionStructure,
  MobileWeeklyPlanGenerationResponse,
  ModelSnapshotsResponse,
  OverrideWorkoutInput,
  PredictionModelRun,
  RecomputeJobCancellationResponse,
  SyncCoverageResponse,
  TrainPredictionModelRequest,
  TrainingStatisticsGranularity,
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
import { ModelRunActivationError, PendingMigrationsError, SqliteModelReleaseRepository, RaiDatabase, SqliteModelRunRepository, acquireDatabasePublicationLock, recordModelReleaseRefusal } from "@rai/storage-sqlite";
import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";

import { RestoreRecoveryRequiredError } from "./restore-journal.js";
import { apiErrorPayload, ClientRequestError, retryAfterSeconds } from "./api-error.js";
import { readDatasetEpoch, writeDatasetEpoch, writeDeletedDatasetEpoch } from "./dataset-epoch.js";
import { CommandQueue, applyMutationCommand } from "./command-queue.js";
import { DATABASE_TIMEZONE, localCalendarFormatter } from "@rai/contracts";
import { RaiReadStore, mobileLocalDate } from "./data.js";
import { createImportSourceManager } from "./import-sources.js";
import { finalizeImportSource } from "./import-source-finalization.js";
import {
  DIRECT_SYNC_MAX_RECORDS, DIRECT_SYNC_MAX_ROUTE_BYTES, DIRECT_SYNC_MAX_ROUTE_FILES, DIRECT_SYNC_MAX_XML_BYTES
} from "./direct-sync-ingest.js";
import {
  constantTimeTokenEquals,
  installLocalRequestSecurity,
  isTrustedDevelopmentOrigin,
  unsafeMethods
} from "./local-request-security.js";
import { DatabaseMaintenance, backupPolicyFromEnvironment } from "./maintenance.js";
import {
  PerformanceEntryValidationError,
  PrivacyZoneRevisionConflictError,
  PrivacyZoneValidationError,
  type PerformanceEntryDistance
} from "@rai/storage-sqlite";
import { MobileGoalsRevisionConflictError, MobileGoalsStore, WeeklyPlanConfirmationRequiredError, planDayWithLock, type PlanMergeOptions } from "./mobile-goals.js";
import { mobileLockRejection, mobileRefreshOutcome } from "./mobile-sync.js";
import { MutationConflictError, MutationCoordinator } from "./mutation-coordinator.js";
import { DatabaseNotReadyError, ReadStoreManager } from "./read-store-manager.js";
import { registerCommandRoutes } from "./routes/command-routes.js";
import { registerImportRoutes } from "./routes/import-routes.js";
import { RuntimeTelemetry } from "./runtime-telemetry.js";
// systemd readiness/watchdog（2026-10-18 事故复盘 P1）：无 NOTIFY_SOCKET 时 no-op。
import { createSystemdNotifier } from "./systemd-notify.js";
import { importEngine, nativeFallback, nativeWorkerAvailability, NATIVE_VERSION } from "@rai/health-export-parser";
import { installMutationLifetime } from "./request-mutation-lifetime.js";
import {
  backupParamsSchema,
  deleteBodySchema,
  identifierParamsSchema,
  mobileLockBodySchema,
  mobilePlanSyncedBodySchema,
  modelComparisonQuerySchema,
  openapiDocument,
  overrideBodySchema,
  predictionModelIdParamsSchema,
  predictionModelTrainBodySchema,
  predictionQuerySchema,
  performanceEntryBodySchema,
  privacyZonesBodySchema,
  recoveryTrendQuerySchema,
  restoreBodySchema,
  syncCoverageQuerySchema,
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
import { generateWeeklyPlan, mergePlanWindow, overwriteWarning, shouldGenerateWeeklyPlan } from "./weekly-plan-service.js";
import { CoachLoopRuntime, coachLoopReceiptManaged, type CoachRuntimeReceipt } from "./coach-loop-runtime.js";
import { registerCoachLoopRoutes } from "./coach-loop-routes.js";
import { createTrainingPlanCommandHandlers, createTrainingPlanStateRoute } from "./training-plan-routes.js";
import { TrainingPlanCommandService, legacyRaceTargetMirror, trainingPlanCommandError } from "./training-plan-commands.js";
import { TrainingPlanCoordinator } from "./training-plan-coordinator.js";
import type { TrainingPlanRefreshRequest } from "@rai/api-contracts";
import { PlanPublicationService, PlanOperationError } from "./plan-publication.js";
import { prescriptionDigest } from "./plan-digest.js";
import { normalizePlanReceiptV2 } from "./plan-receipt.js";
import { planReadGuard, readStableSnapshot } from "./plan-read-consistency.js";
import type { MobilePlanReceiptInput } from "@rai/api-contracts";
import type { MobilePlanOperationScope } from "@rai/api-contracts";
import { planOperationScopeSchema } from "./schemas.js";
import { isValidLocalDate } from "./local-date.js";
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
// 单批上传的 ZIP 上界（S3.6 收口：4 GiB → 64 MiB）。
// 分批后（iOS 阶段 2）单批 ZIP 上界 = XML ≤2 MiB + routes ≤32 MiB + 包壳，64 MiB 有 ≥1.9× 余量；
// 旧值在 50 GB 盘上构成真实威胁（一个异常包就能吃光解压预算）。生产 env 若显式设置该键需同步改。
const maxImportZipBytes = Number(process.env.RAI_IMPORT_MAX_ZIP_BYTES ?? 64 * 1024 ** 2);
const importExecutionEngine = { name: importEngine(), fallback: nativeFallback(), version: NATIVE_VERSION };
if (importExecutionEngine.name === "rust" && importExecutionEngine.fallback === "none") {
  // 产物过期与缺失同等严重：旧 worker 与当前 TypeScript 语义不一致（parity 修复之前构建的
  // 二进制会把错误结果写进真实健康库）。只有"源码树不存在"（打包部署）才不判过期。
  const artifact = nativeWorkerAvailability();
  if (!artifact.ready) {
    throw new Error(
      `Rust worker is unavailable: ${artifact.reason ?? "unknown"}. `
        + "Run npm run rust:build or configure RAI_RUST_BINARY before enabling Rust."
    );
  }
}
const serverId = process.env.RAI_SERVER_ID?.trim() || "local";
const athleteId = process.env.RAI_ATHLETE_ID?.trim() || "athlete_1";
const configuredDatasetEpoch = process.env.RAI_DATASET_EPOCH?.trim() || "default";
let datasetEpoch = configuredDatasetEpoch;
let restoringDatabase = false;
const assertDatasetAccepting = (): void => {
  if (restoringDatabase) throw new ClientRequestError("database_restore_in_progress", "数据库正在恢复或删除，请完成后重试", 409);
};
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
 * Empty by default, which keeps the token gate on everything. The mode was
 * introduced for the (now retired) browser SPA; keeping the switch is a
 * deployment choice, not a code default.
 * Nginx forwards `Host: tpandmr.xyz` (no port), so that is the spelling to use.
 */
const publicReadHosts = new Set((process.env.RAI_PUBLIC_HOSTS ?? "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean));
if (!Number.isFinite(maxImportZipBytes) || maxImportZipBytes <= 0) {
  throw new Error("RAI_IMPORT_MAX_ZIP_BYTES must be a positive number");
}
const dataOnlyFastPathSetting = process.env.RAI_IMPORT_DATA_ONLY_FAST_PATH ?? "1";
if (!["0", "1"].includes(dataOnlyFastPathSetting)) throw new Error("RAI_IMPORT_DATA_ONLY_FAST_PATH must be 0 or 1");
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
// Local-first product: keep the API out of third-party iframes and guard
// against content-type sniffing. frame-ancestors does not constrain any
// resource loading, so this cannot break native clients.
app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", "frame-ancestors 'none'");
});
await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    // Native clients send no Origin. Browser origins are accepted only when
    // explicitly configured, or when they point at this API's own loopback port.
    callback(null, configuredOrigins.has(origin) || isTrustedDevelopmentOrigin(origin, {
      apiPort: port
    }));
  }
});
await app.register(multipart, {
  limits: { files: 1, fileSize: maxImportZipBytes }
});
// 写方法集合由 `local-request-security.ts` 单一导出（2026-10-15 审查 D-🔡6：
// 准入守卫与鉴权 hook 必须对"什么算写"保持同一口径，两处各写一份迟早分叉）。
/**
 * Read routes an unauthenticated client may call, once the request arrives on
 * a host named in `RAI_PUBLIC_HOSTS` (empty by default, in code and in the
 * deployment template alike).
 *
 * This set used to be much wider: the retired browser SPA opened without a token
 * and rendered every view, so dashboard, workouts, trends, training statistics,
 * prediction/model and the iOS-only `/v1/mobile/*` aggregates were all readable
 * anonymously once an operator opted in. The Web SPA was retired on 2026-10-17
 * (DECISIONS D17) and no client reads those routes without a Bearer token any
 * more, so keeping them here only preserved a privacy surface nobody needed
 * (review P3-13): an operator following the deployment template would have
 * published health, location and plan aggregates to the internet, while the
 * same data on sibling routes (`/v1/mobile/training-plan-state`,
 * `/v1/mobile/run-coach`, `/v1/workouts/:id/share-card`, `/v1/privacy-zones`)
 * stayed token-gated.
 *
 * What stays: liveness and capability negotiation, with no health samples,
 * coordinates, plans or files —
 *   GET /v1/health          whether the service and its database are ready
 *   GET /v1/handshake       server/dataset identity plus contract versions
 *   GET /v1/runtime-status  busy flags the client polls before a write
 *
 * Everything else — including every `/v1/mobile/*` aggregate — is listed in
 * `tokenRequiredReadRoutes` below. `server-runtime.test.ts` fails if a mounted
 * `/v1/` GET appears in neither set, so a new read route has to be classified on
 * purpose instead of inheriting whichever default the author did not think about.
 */
const publicReadRoutes = new Set([
  "/v1/health",
  "/v1/handshake",
  "/v1/runtime-status"
]);
/**
 * Read routes that require the Bearer token. See the comment above.
 *
 * Every route that used to be anonymously readable for the retired Web SPA is
 * here now; the entries are grouped by surface only for readability. Anything
 * that answers with health samples, route geometry, plan state, account
 * identity, filesystem paths or the route table itself must stay in this set.
 */
const tokenRequiredReadRoutes = new Set([
  // Plans, goals and coach surfaces (incl. the iOS-only aggregates).
  "/v1/mobile/today",
  "/v1/mobile/workout-plan",
  "/v1/mobile/training-plan-state",
  "/v1/mobile/goals",
  "/v1/mobile/statistics",
  "/v1/mobile/trends",
  "/v1/mobile/run-coach",
  "/v1/mobile/plan-operations/:id",
  "/v1/mobile/coach-loop",
  "/v1/mobile/coach-execution",
  // Workouts and training facts (route geometry, zone history, exports).
  "/v1/dashboard",
  "/v1/data-summary",
  "/v1/data-audit",
  "/v1/workouts",
  "/v1/workouts/:id",
  "/v1/workouts/:id/series",
  // 事实/分析到齐程度（P0-3）：回答「这条训练齐了没有」，与详情同级的健康数据读取面。
  "/v1/workouts/:id/freshness",
  "/v1/trends",
  "/v1/recovery-trends",
  "/v1/training-statistics/overview",
  "/v1/training-statistics/history",
  "/v1/training-statistics/load",
  "/v1/training-zones/current",
  "/v1/training-zones/history",
  "/v1/exports/workout-summary",
  // 分享卡带轨迹几何（哪怕已在服务端裁剪），隐私区本身更是家/公司坐标：两者都不进匿名读。
  "/v1/workouts/:id/share-card",
  "/v1/privacy-zones",
  "/v1/performance-entries",
  "/v1/label-funnel",
  // Models, predictions and job/import administration.
  "/v1/predictions",
  "/v1/prediction-models",
  "/v1/prediction-models/:id",
  "/v1/model-runs",
  "/v1/model-snapshots",
  "/v1/model-runs/compare",
  "/v1/jobs",
  "/v1/jobs/:id",
  "/v1/commands/:id",
  "/v1/import-sources/recent",
  "/v1/import-jobs/active",
  "/v1/import-jobs/latest",
  "/v1/import-jobs/:id",
  // 同步覆盖探测（P1-1）：只读的原始事实覆盖区间，供客户端避免重传已知历史。
  "/v1/sync/coverage",
  // Server internals: raw database, backup inventory, diagnostics, route table.
  "/v1/backups",
  "/v1/backups/:name",
  "/v1/diagnostics",
  "/v1/openapi.json",
  "/v1/performance"
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
  "/v1/mobile/run-coach",
  "/v1/mobile/lock",
  "/v1/mobile/workout-plan/generate",
  "/v1/mobile/workout-plan/preview",
  "/v1/mobile/workout-plan/confirm",
  "/v1/mobile/workout-plan/synced",
  // Unified training-plan contract: preview writes nothing, submit writes only the
  // control store (unified state + legacy goals mirror).
  "/v1/mobile/training-plan/commands/preview",
  "/v1/mobile/training-plan/commands"
]);
const databaseRequiredMutationRoutes = new Set([
  "/v1/mobile/coach-loop",
  "/v1/mobile/coach-loop/synced",
  "/v1/mobile/coach-feedback",
  "/v1/mobile/coach-prediction-refresh",
  // Reads main-database facts to generate the candidate plan, then commits the plan
  // and the unified state together.
  "/v1/mobile/training-plan/commands/refresh",
  "/v1/workouts/:id/override",
  "/v1/training-zones/profile",
  "/v1/privacy-zones",
  "/v1/performance-entries",
  "/v1/performance-entries/:id",
  "/v1/prediction-models/train",
  "/v1/prediction-models/:id/cancel",
  "/v1/prediction-models/:id/activate",
  "/v1/model-runs",
  "/v1/model-runs/:id/activate",
  "/v1/jobs/:id/cancel",
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
 * `POST /v1/backups` is here for the same reason even though it writes nothing
 * any more: it only answers the retired-capability 410, and classifying it as
 * database-required made the readiness gate answer `409 database_not_ready`
 * first on a fresh install / after `DELETE /v1/database`, hiding the designed
 * maintenance message from exactly the operator who needs it (review P3-18).
 * `DELETE /v1/backups/:name` (same retired family) was already here.
 *
 * Declarative: the default branch of the `preHandler` hook below already takes
 * the lock and skips the readiness gate, so this set does not change behaviour.
 */
export const lockOnlyMutationRoutes = new Set([
  "/v1/import-sources/:id",
  "/v1/backups",
  "/v1/backups/:name",
  "/v1/backups/:name/restore"
]);

/**
 * Routes retired by product decision (2026-10-20). They stay mounted so the
 * route-table/OpenAPI audits keep enumerating them and a stale client gets a
 * machine-readable answer instead of a 404, but no handler may reach the old
 * implementation: each one answers 410 `legacy_surface_retired` with the
 * replacement surface.
 *
 * Kept as one set because three separate boundaries must agree: the mounted
 * route list, the managed-dataset 409 gate below (retirement wins over "this
 * dataset is managed"), and `legacy-surface-retirement.test.ts`. A retired
 * route is not a write any more, so it lives in `metadataOnlyMutationRoutes`
 * for the source/route-table classification checks (no mutation lock, no
 * database-readiness gate, no import/restore side effects).
 */
export const retiredLegacyRoutes = new Set([
  "/v1/mobile/goals",
  "/v1/mobile/run-coach",
  "/v1/mobile/workout-plan/confirm",
  "/v1/mobile/workout-plan/generate",
  "/v1/mobile/workout-plan/preview"
]);

/**
 * One shape for every retirement: the old surface is gone, the replacement is a
 * real route, and the answer is 410 rather than 404 so a stale client can tell
 * "removed on purpose" from "wrong URL/version".
 */
function retiredLegacySurface(replacement: string) {
  return (_request: FastifyRequest, reply: FastifyReply) => reply.code(410).send({
    code: "legacy_surface_retired",
    message: `该旧接口已退役，不再执行旧协议；请改用 ${replacement}。`,
    replacement
  });
}
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
// Plan and goals reads are safety-relevant snapshots, not cacheable
// representations: an intermediary that reuses one after a publication would
// show a plan the client is about to overwrite. `/training-plan-state`,
// `/coach-loop` and `/coach-execution` already set this header in their
// handlers; this hook covers the rest of the mobile surface (today,
// workout-plan, goals, run-coach, lock, plan-operations, ...) in one place
// (review P3-1).
app.addHook("onSend", async (request, reply, payload) => {
  if (request.routeOptions.url?.startsWith("/v1/mobile/")) {
    reply.header("Cache-Control", "no-store");
  }
  return payload;
});
const mutationReleases = new WeakMap<object, () => void>();
const localRequestSecurityOptions = {
  apiPort: port,
  ...(apiToken ? { apiToken } : {}),
  allowAuthenticatedRemote,
  trustedOrigins: configuredOrigins,
  // Both halves are needed for anonymous reads to work at all, so they travel
  // together: routes without hosts passes nothing through, hosts without routes
  // match no path.
  ...(publicReadHosts.size > 0 ? { publicReadRoutes, publicReadHosts } : {})
};
installLocalRequestSecurity(app, localRequestSecurityOptions);
app.addHook("preHandler", async (request, reply) => {
  const routeUrl = request.routeOptions.url;
  if (routeUrl?.startsWith("/v1/mobile/") &&
    // Retirement answers 410 for every dataset: a managed / ended / recovering
    // dataset must not turn a deliberately-removed surface into a different 409.
    !(routeUrl !== undefined && retiredLegacyRoutes.has(routeUrl)) &&
    !["/v1/mobile/coach-loop", "/v1/mobile/coach-loop/synced", "/v1/mobile/coach-execution", "/v1/mobile/coach-feedback",
      "/v1/mobile/coach-prediction-refresh", "/v1/mobile/plan-operations/:id"].includes(routeUrl)) {
    const managed = coachLoopManaged();
    if (managed &&
      ["/v1/mobile/today","/v1/mobile/training-plan-state","/v1/mobile/workout-plan","/v1/mobile/lock"]
        .some(prefix => routeUrl === prefix || routeUrl.startsWith(`${prefix}/`))) {
      return reply.code(409).send({ code: "coach_loop_contract_required",
        message: "当前课表由新版教练合同管理，请使用 /v1/mobile/coach-loop；旧协议不能执行追加课。" });
    }
  }
  if (unsafeMethods.has(request.method) || routeUrl === "/v1/handshake") assertDatasetAccepting();
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

// Both annotated: `readStores` asks the import worker for the newest refresh and
// the worker asks the store pool to drain before it swaps the database file, so
// inference would chase its own tail through the two initializers.
// Recovery runs before workers can open the main database or schedule writes.
await new DatabaseMaintenance(databasePath, runtimeRoot).recoverInterruptedRestore();
datasetEpoch = readDatasetEpoch(databasePath, configuredDatasetEpoch);
const readStores: ReadStoreManager = new ReadStoreManager(databasePath, () => mobileRefreshOutcome(importWorker.latest()));
const mobileGoalsStore = new MobileGoalsStore(runtimeRoot, controlDatabasePath);
/**
 * Single source for "this dataset is managed by the coach-loop contract".
 *
 * Both the legacy-route gate and the handshake capability advertisement use it:
 * when this is true the old plan reads answer 409 by design, so advertising
 * `planSnapshotContractVersion` at the same time would tell a client to call a
 * route that cannot succeed (review P3-3).
 *
 * The receipt row is append-only and `end` never deletes it (F06), so the
 * presence of a receipt only proves the dataset *once* opted in. Management is
 * therefore status-aware: an ended receipt releases the legacy reads and the
 * snapshot capability again, while a missing/malformed settings payload stays
 * managed (fail closed). The predicate itself is a pure helper in
 * `coach-loop-runtime.ts` so this decision is unit-testable without a server.
 */
const coachLoopManaged = (): boolean =>
  coachLoopReceiptManaged(mobileGoalsStore.coachLoopState<CoachRuntimeReceipt>(JSON.stringify({ serverId, athleteId, datasetEpoch })));
const planPublication = new PlanPublicationService(mobileGoalsStore, () => JSON.stringify([serverId, athleteId, datasetEpoch]),
  () => ({ serverId, athleteId, datasetEpoch }));
mobileGoalsStore.retireLegacyModelPlan(mobileLocalDate());
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
    assertAccepting: assertDatasetAccepting,
    admission: taskAdmission.owner("import"),
    engine: importExecutionEngine,
    dataOnlyFastPath: dataOnlyFastPathSetting === "1",
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
      // 🔴 直连车道**唯一**的唤醒点（2026-10-13 线上首爆）。`direct-sync-ingest.ts` 在同一个
      // 主库事务里登记了 `recompute_jobs` 行，但它**不再 spawn CLI** —— 旧链路是靠那个子进程
      // 内联 `runNextJob()` 自我消化的（`packages/application/src/model-v2-cli.ts`），
      // 快车道把这个消费者一并去掉了。少了这一句，任务永远停在 `queued`，
      // 而 `isDatabaseWriteBusy()` 把 `queued` 算作忙 ⇒ 所有写端点永久 409，
      // 被 409 就走不到后面的 `schedule()` ⇒ 无自愈路径。
      // ⚠️ 放在**终态回调**里而不是某条成功分支里：失败路径同样可能留下已登记的任务。
      recomputeWorker.schedule();
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
const changeDatasetEpoch = (epoch: string): void => {
  datasetEpoch = epoch;
  const scope = JSON.stringify([serverId, athleteId, datasetEpoch]);
  commandQueue.setScope(scope);
  importWorker.setScope(scope);
};
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
  if (restoringDatabase || readStores.isReplacing || !existsSync(databasePath) || databaseRecoveryRequired) return false;
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
  assertDatasetAccepting();
  try {
    return readStores.use(callback);
  } catch (error) {
    observeMainDatabaseError(error);
    throw error;
  }
};

const withReadDatabase = <T>(callback: (database: DatabaseSync) => T): T => {
  assertDatasetAccepting();
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
  assertDatasetAccepting();
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

const localToday = (): string => localCalendarFormatter(DATABASE_TIMEZONE, "day").format(new Date());

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
          timezoneIdentifier: DATABASE_TIMEZONE
        });
        queued = true;
      } else if (counts.latest_profile_date === null || counts.latest_profile_date < localToday()) {
        service.enqueueSnapshotRefresh({
          evaluatedAt: new Date().toISOString(),
          timezoneIdentifier: DATABASE_TIMEZONE
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
 * 🔴 兜底巡检（2026-10-13 线上首爆后加）。`recompute_jobs` 的**登记方**散布在 worker 线程与
 * 各条 HTTP 车道上，**唤醒方**却只有本文件里那少数几处 `schedule()` —— 漏一处，
 * 任务就永远 `queued`，而 `isDatabaseWriteBusy()` 把 `queued` 算作忙 ⇒ **所有写端点 409**，
 * 且被 409 就走不到后面的 `schedule()` ⇒ 没有自愈路径（实测：一条卡住的任务让 11 个写端点全 409）。
 *
 * 周期 60 s 的取舍：空闲时 `wakeIfPending()` 只做一次只读 `SELECT`（`hasPending()`），
 * **不 spawn worker 线程**，所以稳态成本约等于零；而"漏唤醒"从"必须重启服务"降到"最多等一分钟"。
 */
const recomputePollTimer = setInterval(() => {
  if (closing) return;
  recomputeWorker.wakeIfPending();
}, 60_000);
recomputePollTimer.unref();

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
  // Managed means an ACTIVE/PAUSED coach-loop, not "a receipt exists": an ended
  // programme must hand the legacy weekly generator back (F06). The status-aware
  // predicate is shared with the route gate so the two cannot disagree.
  if (coachLoopManaged()) return;
  // A migrated scope is refreshed by the one unified coordinator (PR4 remaining):
  // the decision lives in training-plan-coordinator.ts, the write goes through the
  // same refresh command (generate outside the transaction, commit inside).
  if (mobileGoalsStore.trainingPlanStateRow(JSON.stringify([serverId, athleteId, datasetEpoch])) !== null) {
    await trainingPlanCoordinator.tick();
    return;
  }
  const today = mobileLocalDate();
  const goals = mobileGoalsStore.read();
  if (!shouldGenerateWeeklyPlan(today, goals)) return;
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
  apiVersion: "v1",
  healthKitRecordSyncVersion: 2,
  planReceiptMetadata: true,
  // A managed dataset answers the legacy plan reads with 409 by design, so the
  // capability is omitted instead of advertising a route the same handshake
  // document cannot fulfil (review P3-3). The coach-loop capability below stays
  // set, which is what a client in this state must use.
  ...(coachLoopManaged() ? {} : { planSnapshotContractVersion: 1 }),
  coachLoopContractVersion: 1,
  ...(mobileGoalsStore.supportsPublicationOperations ? { planPublicationContractVersion: 1 } : {}),
  planReceiptContractVersion: 2,
  factsAnalysisContractVersion: 1,
  // PR5 D1.4 的两块视图能力位。🔴 **刻意另取一个名字**：`factsAnalysisContractVersion`
  // 已经被"直连原始回执"（`summary.directSync` 的 ingestStatus/analysisStatus）占用，
  // 两者可以各自演进 —— 回执是**写入时刻的凭证**，两块视图是**读侧的行视图**，
  // 共用一个数字会让"服务端升级了哪一侧"变成猜。
  // 范式见 PR5 §1.2 锚点 20：可选版本字段宣告，客户端 `guard == 1` 之后才去读
  // `currentFacts`/`publishedAnalysis`，否则退回旧字段（旧字段语义没变，所以退回是安全的）。
  factsAnalysisViewContractVersion: 1,
  // 2026-10-18（P1-1，同步诊断）：覆盖探测能力位。1 = 支持 `GET /v1/sync/coverage`。
  // 老服务端省略该键 ⇒ 客户端必须回落"照常重放"，不能假设服务端已覆盖。
  syncCoverageVersion: 1,
  // 观测阶段 1（S1.2）：直连单批上界随握手暴露，客户端（iOS 分批版）据此收敛拆批预算。
  // 数值**单一来源** = `direct-sync-ingest.ts` 的顶层常量 —— 不要在这里写数字字面量，
  // 两处各写一份数字，收口时必然有一处漂移。
  directSyncBounds: {
    maxXmlBytes: DIRECT_SYNC_MAX_XML_BYTES,
    maxRecords: DIRECT_SYNC_MAX_RECORDS,
    maxRouteFiles: DIRECT_SYNC_MAX_ROUTE_FILES,
    maxRouteBytes: DIRECT_SYNC_MAX_ROUTE_BYTES
  }
}));
/**
 * 同步覆盖探测（P1-1，2026-10-18 同步诊断）。
 *
 * 回答"服务端每个记录类型已知覆盖到哪儿"，只用于让客户端**避免重传**已有历史。
 * 不是"完整"证明：覆盖区间内可以有空洞，客户端不得据此清除本地游标或跳过真正的待办。
 * `datasetEpoch` 复用 handshake 的权威值 —— 数据集更换后旧 epoch 的覆盖结论立即作废。
 */
app.get<{ Querystring: { types?: string } }>("/v1/sync/coverage",
  { schema: { querystring: syncCoverageQuerySchema } }, async (request): Promise<SyncCoverageResponse> => {
    const types = request.query.types?.split(",").map((type) => type.trim()).filter(Boolean);
    return { datasetEpoch, types: withReadStore((store) => store.syncCoverage(types)) };
  });
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

app.get<{ Querystring: { localDate?: string; limit?: string; offset?: string; status?: string; sessionType?: string; stimulusType?: string; participation?: string; environment?: string; days?: string; sourceGroup?: string; confidence?: string; route?: string } }>(
  "/v1/workouts",
  { schema: { querystring: workoutListQuerySchema } },
  async (request) =>
    withReadStore((store) =>
      store.workoutsWithViews({
        ...(request.query.localDate ? workoutDateWindow(request.query.localDate, request.query.localDate) : {}),
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

// Never part of anonymous public reads, even when the public dashboard is enabled.
app.get<{ Querystring: { from: string; through: string } }>("/v1/exports/workout-summary",
  { schema: { querystring: workoutExportQuerySchema } }, async (request, reply) => {
    if (!apiToken || !constantTimeTokenEquals(request.headers.authorization, `Bearer ${apiToken}`)) {
      return reply.code(401).send({ code: "export_auth_required", message: "请配置访问令牌并连接后导出" });
    }
    reply.header("Cache-Control", "no-store");
    return withReadStore(store => workoutSummaryExport(request.query.from, request.query.through, query => store.workoutExportSnapshot(query)));
  });

app.get<{ Params: { id: string } }>("/v1/workouts/:id", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  const includeRoute = apiToken
    ? constantTimeTokenEquals(request.headers.authorization, `Bearer ${apiToken}`)
    : process.env.RAI_ALLOW_ANONYMOUS_ROUTES === "1";
  reply.header("Cache-Control", "no-store");
  const detail = withReadStore((store) => store.workout(request.params.id, { includeRoute }));
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

/**
 * 训练的**事实/分析到齐程度**（P0-3，2026-10-18 同步诊断）。
 *
 * 只读、无派生评分；与详情端点同级：事实在 ⇒ 200，事实不在（或已删）⇒ 404。
 * 客户端据此在详情页显示「分析中 / 手表数据仍在传输」，而不是把"还没到"读成"设备没有"。
 * 鉴权与参数 schema 与 `/v1/workouts/:id` 完全一致（同一个 `identifierParamsSchema`）。
 */
app.get<{ Params: { id: string } }>("/v1/workouts/:id/freshness",
  { schema: { params: identifierParamsSchema } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const freshness = withReadStore((store) => store.workoutFreshness(request.params.id));
    if (!freshness) return reply.code(404).send({ message: "未找到该训练记录" });
    return freshness;
  });

/**
 * Share card: numbers plus the **already trimmed** route (docs/DECISIONS.md D9).
 *
 * Token-required, unlike the other workout reads: the payload carries route
 * geometry, and the credentials that may see raw coordinates should not be the
 * ones rendering a card that was supposed to hide them.
 */
/**
 * Type alias rather than an inline generic: `schemas.test.ts` parses route
 * registrations with `(?:<[^<>]*>)?`, so a nested `Array<{…}>` makes the route
 * invisible to the gate that checks every mounted route is documented.
 */
/** Alias, not an inline generic: see the note on `PrivacyZonesBody`. */
type PerformanceEntryBody = {
  localDate: string;
  distance: PerformanceEntryDistance;
  durationSeconds: number;
  note?: string | null;
  trainingSessionId?: string | null;
};

type PrivacyZonesBody = {
  revision: number;
  stateToken: string;
  zones: Array<{
    id: string;
    label: string;
    centerLatitude: number;
    centerLongitude: number;
    radiusMeters: number;
    createdAt: string;
  }>;
};

app.get<{ Params: { id: string } }>("/v1/workouts/:id/share-card", { schema: { params: identifierParamsSchema } }, async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  if (!apiToken || !constantTimeTokenEquals(request.headers.authorization, `Bearer ${apiToken}`)) {
    return reply.code(401).send({ message: "请配置访问令牌并连接后生成分享卡片" });
  }
  const card = withReadStore((store) => store.workoutShareCard(request.params.id));
  if (!card) return reply.code(404).send({ message: "未找到该训练记录" });
  return card;
});

app.get("/v1/privacy-zones", async (request, reply) => {
  reply.header("Cache-Control", "no-store");
  if (!apiToken || !constantTimeTokenEquals(request.headers.authorization, `Bearer ${apiToken}`)) {
    return reply.code(401).send({ message: "请配置访问令牌并连接后读取隐私区" });
  }
  return withReadStore((store) => store.privacyZones());
});

/**
 * §12.10 manually entered race results.
 *
 * Token-gated both ways: the payload is a race history (dates, places in time), and a
 * write here changes what future predictions are calibrated on.
 */
app.get("/v1/performance-entries", async () => withReadStore((store) => ({ entries: store.performanceEntries() })));

/**
 * §12.11 label funnel and progress toward the personal tier.
 *
 * Token-gated: it is a count of the runner's confirmed races. It reports progress and
 * *why* the floors are unmet; it never produces an interval, because a band needs
 * held-out residuals this read path does not have.
 */
app.get("/v1/label-funnel", async () => withReadStore((store) => store.labelProgress()));

app.post<{ Body: PerformanceEntryBody }>(
  "/v1/performance-entries",
  { schema: { body: performanceEntryBodySchema } },
  async (request, reply) => {
    if (isDatabaseWriteBusy()) {
      return reply.code(409).send({ message: "任务执行期间不能录入成绩" });
    }
    const store = await openMainDatabase();
    try {
      return new RaiApplicationService(store).appendPerformanceEntry({
        localDate: request.body.localDate,
        distance: request.body.distance,
        durationSeconds: request.body.durationSeconds,
        trainingSessionId: request.body.trainingSessionId ?? null,
        note: request.body.note ?? null
      });
    } catch (error) {
      if (error instanceof PerformanceEntryValidationError) {
        return reply.code(400).send({ code: error.code, message: error.message });
      }
      throw error;
    } finally {
      store.close();
    }
  }
);

app.delete<{ Params: { id: string } }>(
  "/v1/performance-entries/:id",
  { schema: { params: identifierParamsSchema } },
  async (request, reply) => {
    if (isDatabaseWriteBusy()) {
      return reply.code(409).send({ message: "任务执行期间不能撤销成绩" });
    }
    const store = await openMainDatabase();
    try {
      const revoked = new RaiApplicationService(store).revokePerformanceEntry(request.params.id);
      if (!revoked) return reply.code(404).send({ message: "未找到该成绩条目，或它已被撤销" });
      return { revoked: true, id: request.params.id };
    } finally {
      store.close();
    }
  }
);

app.put<{ Body: PrivacyZonesBody }>(
  "/v1/privacy-zones",
  { schema: { body: privacyZonesBodySchema } },
  async (request, reply) => {
    if (isDatabaseWriteBusy()) {
      return reply.code(409).send({ message: "任务执行期间不能修改隐私区" });
    }
    const store = await openMainDatabase();
    try {
      return new RaiApplicationService(store).replacePrivacyZones(request.body.zones, request.body.revision, request.body.stateToken);
    } catch (error) {
      if (error instanceof PrivacyZoneRevisionConflictError) {
        return reply.code(409).send({ code: error.code, message: error.message, actualRevision: error.actualRevision });
      }
      if (error instanceof PrivacyZoneValidationError) {
        return reply.code(400).send({ code: error.code, message: error.message });
      }
      throw error;
    } finally {
      store.close();
    }
  }
);

/**
 * Device-side plan receipt registration.
 *
 * `matchesCurrent` and the receipt row are computed/written inside one control
 * write transaction, so a publication cannot commit in between and leave the
 * receipt claiming membership of a revision that had already been replaced
 * (review P2-2). Computing that snapshot (`trainingPlanState`) costs a full plan
 * read inside the transaction; that is deliberate and bounded (P3-15): measured
 * p50 ≈ 15.7 ms / p95 ≈ 26.4 ms on a ~42.6k-row synthetic library, and the store
 * hides its own `pending_since` while this transaction is open
 * (`publicationGuardState`), so the guarded reads of *other* requests are what
 * pay the cost — they retry three times and then answer a retryable 503 with
 * `Retry-After: 1`, which is the client's documented semantic. Sleeping between
 * those retries was considered and rejected: it would extend this write-lock
 * hold instead of shortening the read path (see `plan-read-consistency.ts`).
 */
app.post<{ Body: MobilePlanReceiptInput }>(
  "/v1/mobile/workout-plan/synced",
  { schema: { body: mobilePlanSyncedBodySchema } },
  async (request) => {
    const pushedAt = new Date().toISOString();
    const body = request.body;
    if (!isValidLocalDate(body.localDate)) throw new PlanOperationError("plan_receipt_date_invalid", "回执日期无效。", 422);
    // The stored identity is always the canonical structure. Accepting both the
    // normalized wire shape and Swift's nil-omitting shape is deliberate; see
    // `plan-receipt.ts` for why the old strict canonical check rejected real
    // receipts (and crashed with a TypeError on a missing warmup).
    let structure = body.structure ?? null;
    if (body.contractVersion === 2) {
      structure = normalizePlanReceiptV2(body, { serverId, athleteId, datasetEpoch }).structure;
    } else if (body.operationId || body.scope || body.coherenceToken || body.verifiedAt || body.timezone || body.prescriptionDigest || body.lifecycleEvent) {
      throw new PlanOperationError("plan_receipt_contract_mismatch", "新增字段需要回执契约版本 2。", 422);
    }
    // Compute `matchesCurrent` and write the receipt inside one control-database
    // write transaction. Previously the snapshot was read outside the write and
    // a publication could commit in between, so the recorded receipt could claim
    // membership of a revision that had already been replaced (review P2-2).
    // Holding the same transaction also makes the `planPushIsActive` answer in
    // the response describe the state the receipt was registered against.
    const outcome = mobileGoalsStore.withPublicationTransaction(() => {
      let matchesCurrent: boolean | undefined;
      if (body.contractVersion === 2) {
        const current = withReadStore(store => store.trainingPlanState(mobileGoalsStore, () => ({ serverId, athleteId, datasetEpoch })));
        const expected = current.workoutPlan.days.find(day => day.localDate === body.localDate && day.executable);
        // The generic channel used to accept any self-declared `verified`
        // receipt (review P3-7). `operationId` is the *client's* schedule
        // journal id, not a key in `mobile_plan_operations`, so the right
        // evidence rule is the one the coach channel already applies: the
        // revision must be a real published prescription whose day carries this
        // kind and digest. Two representations are legitimate:
        //  - the stored goals history (what was published), and
        //  - the current effective day when the receipt cites the current
        //    revision, because `/v1/mobile/workout-plan` applies the ramp and
        //    quality caps and the client exports *that* constrained structure.
        // Comparing canonical digests also absorbs the wire-shape difference
        // (Swift omits nil keys; `structure` above is already normalized).
        if (body.lifecycleEvent === "verified") {
          const canonicalDigest = prescriptionDigest(body.kind, structure);
          const history = mobileGoalsStore.planHistory(200).find(row => row.revision === body.revision);
          const historicalDay = history ? planDayWithLock(history, body.localDate) : undefined;
          const historicalMatch = historicalDay?.kind === body.kind &&
            prescriptionDigest(historicalDay.kind, historicalDay.structure ?? null) === canonicalDigest;
          const effectiveMatch = body.revision === current.metadata.goalsRevision && expected?.kind === body.kind &&
            prescriptionDigest(expected.kind, expected.structure ?? null) === canonicalDigest;
          if (!historicalMatch && !effectiveMatch) {
            throw new PlanOperationError("plan_receipt_unknown_prescription",
              "回执必须关联真实发布过的处方与授权。", 422);
          }
        }
        matchesCurrent = body.lifecycleEvent === "verified" && body.revision === current.metadata.goalsRevision &&
          body.coherenceToken === current.metadata.coherenceToken && expected?.kind === body.kind &&
          prescriptionDigest(expected.kind, expected.structure) === body.prescriptionDigest;
      }
      const recordedAt = mobileGoalsStore.recordPlanPush({
        ...body,
        ...(body.contractVersion === 2 ? { idempotencyKey: body.idempotencyKey ?? `${body.workoutID}:${body.lifecycleEvent}` } : {}),
        localDate: body.localDate,
        kind: body.kind,
        revision: body.revision ?? 0,
        structure,
        pushedAt,
        ...(matchesCurrent === undefined ? {} : { matchesCurrent }),
        ...(body.workoutID !== undefined ? { workoutID: body.workoutID } : {}),
        ...(body.scheduledAt !== undefined ? { scheduledAt: body.scheduledAt } : {}),
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
        ...(body.exportNotes !== undefined ? { exportNotes: body.exportNotes } : {})
      });
      return {
        recordedAt,
        matchesCurrent: matchesCurrent === undefined ? undefined
          : matchesCurrent && mobileGoalsStore.planPushIsActive(body.workoutID!, body.scheduledAt!)
      };
    });
    return { recordedAt: outcome.recordedAt,
      ...(outcome.matchesCurrent === undefined ? {} : { matchesCurrent: outcome.matchesCurrent }),
      informationLevel: body.contractVersion === 2 ? "verifiedClient" : "legacy" };
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
        ...(request.body.expectedRevision !== undefined ? { expectedRevision: request.body.expectedRevision } : {}),
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

/**
 * A plan read that combines the control store (goals/history) with the facts
 * store (recovery, workouts, views).
 *
 * `/v1/mobile/today` and `/v1/mobile/workout-plan` used to read goals/history
 * once and then build the response from the main database in a separate
 * transaction. A control write landing in between (another device's goals
 * update, a coach publication) produced a mixed plan — old goals measured
 * against new facts — with no signal to the client. Going through
 * `readStableSnapshot` discards such an attempt and retries, and exhaustion is a
 * retryable 503 (`Retry-After: 1`) instead of a mixed snapshot (review P3-01).
 * The response body is unchanged; only the consistency guarantee is new.
 */
const stablePlanRead = <Control, Result>(
  readControl: () => Control,
  build: (control: Control) => Result
): Result => {
  // Reads inside the store's own publication transaction see a hidden
  // `pending_since` but the live epoch (`publicationGuardState`), so this cannot
  // fail closed on itself and still detects a foreign publication (P3-03).
  const readGuard = planReadGuard(mobileGoalsStore);
  // `exactOptionalPropertyTypes`: omit the key (rather than pass `undefined`)
  // when the store has no guard, which is the documented digest-only fallback.
  return readStableSnapshot({
    readControl,
    build,
    changedError: () => new PlanOperationError("plan_snapshot_changed",
      "训练计划在读取期间更新，请重读完整快照。", 503),
    ...(readGuard ? { readGuard } : {})
  });
};

app.get("/v1/mobile/today", async () => stablePlanRead(
  () => ({ goals: mobileGoalsStore.read(), history: mobileGoalsStore.planHistory(200) }),
  // `mobileTodayWithViews` 而不是 `mobileToday`：两块视图（PR5 S4）必须与今天/周的数字
  // 落在**同一个**读事务里（C1）。旧字段的取值由 `mobileToday` 原样返回，一个字都不动。
  (control) => withReadStore((store) => store.mobileTodayWithViews(control.goals, control.history))
));

// PR4-1: one path, two wire contracts. `X-RAI-Training-Contract: 2` answers the
// migrated unified state; every other request keeps the v1 payload unchanged.
// v1 reads stay on the stable-snapshot path; v2 reads only the control store and
// never migrates, publishes or falls back to a different contract.
app.get("/v1/mobile/training-plan-state", createTrainingPlanStateRoute({
  identity: () => ({ serverId, athleteId, datasetEpoch }),
  businessDate: () => mobileLocalDate(),
  readUnifiedState: scopeKey => mobileGoalsStore.trainingPlanStateRow(scopeKey),
  readGoalsRevision: () => mobileGoalsStore.read().revision,
  legacy: () => withReadStore(store => store.trainingPlanState(mobileGoalsStore, () => ({ serverId, athleteId, datasetEpoch })))
}));

app.get<{ Params: { id: string } }>("/v1/mobile/plan-operations/:id", { schema: { params: identifierParamsSchema } },
  async request => planPublication.result(request.params.id));

// PR4-2: configuration commands over the unified state. The publication service
// runs each action inside the control-database publication transaction, so the
// unified state write, its history row, the legacy goals mirror and the operation
// result commit or roll back together. The published plan is not regenerated in
// this slice; both responses say `planRefreshRequired: true`.
const trainingPlanCommands = (() => {
  const service = new TrainingPlanCommandService(mobileGoalsStore,
    () => JSON.stringify([serverId, athleteId, datasetEpoch]),
    () => ({ serverId, athleteId, datasetEpoch }),
    () => mobileLocalDate());
  // One candidate generator for both the single-command path (PR4-4) and the
  // refresh path: read the stable snapshot, generate outside the control write
  // transaction, return the fingerprint that the commit re-verifies.
  /**
   * Cross-store barrier (PR4 remaining): generation reads the main database, the
   * commit writes the control database. There is no cross-file transaction, so the
   * fingerprint includes the main database's `data_version`: an import/restore that
   * completes between generation and commit changes it and the operation is
   * rejected instead of pairing new facts with a plan generated from the old ones.
   */
  const mainDataVersion = () => readStores.dataVersionFingerprint();
  const generationFingerprint = () => `${weeklyPlanSnapshot().fingerprint}:${mainDataVersion()}`;
  const prepareTrainingPlan = async (state: import("./training-plan-store.js").TrainingPlanState) => {
    const { goals, inputs, fingerprint } = weeklyPlanSnapshot();
    const mirror = legacyRaceTargetMirror(state);
    const result = await generateWeeklyPlan({
      today: inputs.today,
      goals: { ...goals, runCoach: null, raceTarget: mirror === undefined ? null : mirror },
      prescription: inputs.prescription,
      weeklyVolumeBaselineKm: inputs.weeklyVolumeBaselineKm,
      recentWeeklyKm: inputs.recentWeeklyKm,
      previousWeekDistanceKm: inputs.previousWeekDistanceKm
    });
    if (!result.days.length) {
      throw new PlanOperationError("training_plan_empty", "未生成有效课表；原计划保持不变。", 422);
    }
    return { days: result.days, audit: result.audit, warnings: result.warnings,
      prescription: inputs.prescription, fingerprint: `${fingerprint}:${mainDataVersion()}` };
  };
  const planDeps = { prepare: prepareTrainingPlan, fingerprint: generationFingerprint };
  const handlers = createTrainingPlanCommandHandlers(service, planDeps);
  return {
    preview: async (request: FastifyRequest, reply: FastifyReply) => handlers.preview(request, reply),
    submit: async (request: FastifyRequest, reply: FastifyReply) => handlers.submit(request, reply),
    // PR4-3: generate outside the control write transaction, then commit the plan
    // and the unified state together after re-verifying the frozen input fingerprint.
    refresh: async (body: TrainingPlanRefreshRequest) => service.refresh(body, planDeps)
  };
})();
/** PR4 remaining: the only automatic path for a migrated scope. */
const trainingPlanCoordinator = new TrainingPlanCoordinator({
  scopeKey: () => JSON.stringify([serverId, athleteId, datasetEpoch]),
  readState: () => mobileGoalsStore.trainingPlanStateRow(JSON.stringify([serverId, athleteId, datasetEpoch])),
  businessDate: () => mobileLocalDate(),
  refresh: input => trainingPlanCommands.refresh({
    contractVersion: 2,
    operationId: input.operationId,
    operationScope: { serverId, athleteId, datasetEpoch },
    expectedStateRevision: input.stateRevision
  })
});

app.post("/v1/mobile/training-plan/commands/preview", trainingPlanCommands.preview);
app.post("/v1/mobile/training-plan/commands", trainingPlanCommands.submit);
app.post("/v1/mobile/training-plan/commands/refresh", async (request, reply) => {
  const release = weeklyPlanGenerationGate.tryAcquire();
  if (!release) {
    return reply.code(409).send({ code: "weekly_plan_generation_busy", message: "课表正在生成，请稍后重试" });
  }
  try {
    return await trainingPlanCommands.refresh(request.body as TrainingPlanRefreshRequest);
  } catch (error) {
    const mapped = trainingPlanCommandError(error);
    return reply.code(mapped.statusCode).send({ code: mapped.code, message: mapped.message });
  } finally {
    release();
  }
});

// Retired by product decision (2026-10-20): reads were the legacy adaptive
// coach response, writes the legacy start/update/refresh/pause/resume/end
// command. The replacement is the unified v2 read plus the configuration
// command endpoints; both stay mounted and answer 410 so a stale client gets a
// machine-readable retirement instead of a 404.
app.get("/v1/mobile/run-coach", retiredLegacySurface("/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands"));
app.post("/v1/mobile/run-coach", retiredLegacySurface("/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands"));

const coachLoopRuntime = new CoachLoopRuntime(mobileGoalsStore, () => ({ serverId, athleteId, datasetEpoch }),
  (goals, history) => withReadStore(store => store.coachLoopFacts(goals, history, { athleteId, datasetEpoch })),
  () => !isDatabaseWriteBusy(),
  // GET coach-loop 的短 TTL memo（2026-10-18 事故复盘 P1）：主库 data_version 指纹
  // 让导入/直连增量/换文件立即失效；内部控制流仍走 read()，永不复用缓存。
  { mainDataVersion: () => readStores.dataVersionFingerprint() });
registerCoachLoopRoutes({ app, runtime: coachLoopRuntime, identity: () => ({ serverId, athleteId, datasetEpoch }), openMainDatabase });

// Executable week handed to the WorkoutKit bridge. Read-only: it never mutates
// goals, so it is deliberately absent from the mutation route registries below.
// It takes the same stable-snapshot path as `/v1/mobile/today`: the week is
// measured from goals/history while the facts come from the main database, and a
// control write in between must not produce a mixed week (review P3-01).
app.get("/v1/mobile/workout-plan", async () => stablePlanRead(
  () => ({ goals: mobileGoalsStore.read() }),
  (control) => withReadStore((store) => store.mobileWorkoutPlan(control.goals))
));

/** Legacy and Monday-only deterministic generation, without bypassing migration confirmation. */
async function runWeeklyPlanGeneration(expectedRevision?: number): Promise<MobileWeeklyPlanGenerationResponse> {
  // Ended programmes no longer own the schedule; active/paused ones still do.
  if (coachLoopManaged()) throw new PlanOperationError("weekly_plan_generation_blocked", "新版教练由显式刷新命令管理，旧生成器不能覆盖课表。");
  const generationEpoch = datasetEpoch;
  const goals = mobileGoalsStore.read();
  if (goals.runCoach?.status === "active" || goals.runCoach?.status === "paused") throw new PlanOperationError("weekly_plan_generation_blocked", "自适应教练管理当前课表，请在教练计划中调整偏好。");
  if (expectedRevision != null && expectedRevision !== goals.revision) {
    throw new MobileGoalsRevisionConflictError(goals.revision);
  }
  if (goals.weekPlanReplanRequired) throw new WeeklyPlanConfirmationRequiredError();
  const generationGoals = { ...goals, runCoach: null };
  const inputs = withReadStore((store) => store.mobileWeeklyPlanInputs(generationGoals, mobileGoalsStore.planHistory(200)));
  const result = await generateWeeklyPlan({
    today: inputs.today,
    goals: generationGoals,
    prescription: inputs.prescription,
    // Both numbers come from the read store, so a generated week and the today
    // payload scale the same bands and obey the same ceiling.
    weeklyVolumeBaselineKm: inputs.weeklyVolumeBaselineKm,
    recentWeeklyKm: inputs.recentWeeklyKm,
    previousWeekDistanceKm: inputs.previousWeekDistanceKm
  });
  if (restoringDatabase || generationEpoch !== datasetEpoch) throw new PlanOperationError("weekly_plan_generation_stale", "数据集已在生成期间更换，请重新生成；原课表未修改。");
  // A goal CAS alone cannot detect imported training or changed zones.
  const latestGoals = mobileGoalsStore.read();
  if (latestGoals.revision !== goals.revision) throw new MobileGoalsRevisionConflictError(latestGoals.revision);
  const latestInputs = withReadStore(store => store.mobileWeeklyPlanInputs(latestGoals));
  if (latestInputs.today.recommendationRevision !== inputs.today.recommendationRevision ||
      JSON.stringify(latestInputs.prescription) !== JSON.stringify(inputs.prescription) ||
      latestInputs.previousWeekDistanceKm !== inputs.previousWeekDistanceKm ||
      JSON.stringify(latestInputs.today.week) !== JSON.stringify(inputs.today.week)) {
    throw new PlanOperationError("weekly_plan_generation_stale", "训练数据已在生成期间变化，请重新生成；原课表未修改。");
  }
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
  // Replacement warnings take precedence over the coach's adjustment notes.
  const overwrite = overwriteWarning(goals.weekPlan, result.days);
  const warnings = overwrite ? [overwrite, ...result.warnings] : result.warnings;
  const written = mobileGoalsStore.write(
    {
      expectedRevision: goals.revision,
      weekPlan: mergePlanWindow(goals.weekPlan, result.days, inputs.today.today.localDate),
      weekPlanAudit: result.audit
    },
    // The generator already measured these days against this same prescription;
    // re-measuring is idempotent and keeps every write on one path.
    { prescription: inputs.prescription, ...(goals.runCoach?.status === "ended" ? { runCoach: null } : {}) }
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

function weeklyPlanSnapshot() {
  const goals = mobileGoalsStore.read(planPrescription());
  const effectiveGoals = goals.runCoach?.status === "ended" ? { ...goals, runCoach: null } : goals;
  const inputs = withReadStore(store => store.mobileWeeklyPlanInputs(effectiveGoals, mobileGoalsStore.planHistory(200)));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    scope: [serverId, athleteId, datasetEpoch], goals,
    recommendation: inputs.today.recommendationRevision,
    date: inputs.today.today.localDate, week: inputs.today.week,
    sync: inputs.today.sync.lastSuccessAt, prescription: inputs.prescription,
    previousWeek: inputs.previousWeekDistanceKm
  })).digest("hex");
  return { goals, inputs, fingerprint };
}

// Preview/confirm/generate are retired by product decision (2026-10-20). The
// preview/confirm candidate machinery was process-local + a second plan write
// path; the unified command endpoints own candidate generation and the atomic
// plan/state commit now. These mounts stay for route-table and OpenAPI audits.
app.post("/v1/mobile/workout-plan/preview", retiredLegacySurface("/v1/mobile/training-plan/commands/preview"));
app.post("/v1/mobile/workout-plan/confirm", retiredLegacySurface("/v1/mobile/training-plan/commands"));
app.post("/v1/mobile/workout-plan/generate", retiredLegacySurface("/v1/mobile/training-plan/commands/refresh"));

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

// Goals read/write is retired by product decision (2026-10-20). The unified
// training-plan state is the read surface and configuration changes go through
// the contract-v2 command endpoints; the store API stays internal.
app.get("/v1/mobile/goals", retiredLegacySurface("/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands"));
app.put("/v1/mobile/goals", retiredLegacySurface("/v1/mobile/training-plan-state and /v1/mobile/training-plan/commands"));

app.post<{ Body: LockMobileSessionInput }>(
  "/v1/mobile/lock",
  { schema: { body: mobileLockBodySchema } },
  async (request, reply) => {
    try {
      return planPublication.publish("lock", request.body, () => {
      const goals = mobileGoalsStore.read();
      const ignoreLock = request.body.action === "relock";
      const snapshot = withReadStore((store) => store.mobileToday(goals));
      const rejection = mobileLockRejection({
        syncStatus: snapshot.sync.status,
        recommendationRevision: snapshot.recommendationRevision,
        expectedRevision: request.body.expectedRevision
      });
      if (rejection) throw new PlanOperationError(rejection.code, rejection.message);
      if (request.body.action === "lock" && snapshot.lock.present) {
        return mobileGoalsStore.read(planPrescription());
      }
      return mobileGoalsStore.lockSession(
        {
          localDate: snapshot.today.localDate,
          session: ignoreLock ? snapshot.lock.candidate ?? snapshot.nextSession : snapshot.nextSession,
          verdictTone: snapshot.verdict.tone,
          lockedAt: new Date().toISOString()
        },
        planPrescription()
      );
      });
    } catch (error) {
      // A stale expectedRevision is an ordinary concurrency outcome, not a
      // server fault. Without this, `MobileGoalsRevisionConflictError` used to
      // leave `/lock` with a 500 and the client with a pending publication it
      // could never clear by replaying the same payload.
      if (error instanceof MobileGoalsRevisionConflictError) {
        return reply.code(409).send({ code: error.code, message: error.message, currentRevision: error.currentRevision });
      }
      throw error;
    }
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
  mode?: "neutral_potential" | "current_prepared" | "race_day_scenario";
  targetDate?: string;
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
      ...(request.query.mode === undefined ? {} : { mode: request.query.mode }),
      ...(request.query.targetDate === undefined ? {} : { targetDate: request.query.targetDate }),
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

app.get<{Querystring:{runId?:string}}>("/v1/model-snapshots", {
  schema:{querystring:{type:"object",additionalProperties:false,properties:{runId:{type:"string",minLength:1,maxLength:200,pattern:"^[A-Za-z0-9_-]+$"}}}}
}, async (request) => withReadDatabase((database): ModelSnapshotsResponse => {
  const active=database.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton=1").get()?.id;
  const runId=request.query.runId??active;
  if(typeof runId!=="string")return {status:"not_published",runId:null,snapshots:[]};
  const model=database.prepare(`SELECT m.status AS status,m.evaluated_at AS asOf,f.feature_schema_version AS schema FROM model_runs m
    JOIN feature_runs f ON f.id=m.feature_run_id WHERE m.id=?`).get(runId) as
    {status:string;asOf:string;schema:string}|undefined;
  if(!model)return {status:"not_found",runId,snapshots:[]};
  if(model.schema!=="workout-feature-v4")return {status:"legacy",runId,active:runId===active,asOf:model.asOf,snapshots:[{
    domain:"fitness",key:"summary",asOf:model.asOf,payload:{
      assessments:database.prepare("SELECT * FROM ability_assessments WHERE model_run_id=? ORDER BY sequence_number").all(runId),
      daily:database.prepare("SELECT local_date,true_ability,snapshot_status FROM daily_ability_snapshots WHERE model_run_id=? ORDER BY local_date").all(runId)
    }
  }]};
  const snapshots=new SqliteModelReleaseRepository(database).snapshots(runId);
  return {status:model.status==="succeeded"?"available":"candidate",runId,active:runId===active,asOf:model.asOf,snapshots};
}));

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
        const runId = service.enqueue({ asOf, scope: request.body?.scope ?? "population" });
        predictionModelWorker.schedule();
        return { runId, status: "queued" as const };
      } catch (error) {
        if (error instanceof PredictionTrainingPreconditionError) {
          return reply.code(422).send({
            code: error.code,
            // The refusal quotes the floors it actually applied: a personal request
            // that fails must not be told it needs the population's 50 labels.
            scope: error.preflight.scope,
            required: error.preflight.requiredLabels,
            available: error.preflight.available,
            requiredPerDistance: error.preflight.requiredLabelsPerDistance,
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
      timezoneIdentifier: DATABASE_TIMEZONE
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
      // 审计行必须在 ROLLBACK **之后**写：仓库里的写会被这次回滚（以及外层事务）一起撤掉。
      if (error instanceof ModelRunActivationError && error.refusal) {
        recordModelReleaseRefusal(store.database, {
          modelRunId: request.params.id, ...error.refusal, detectedAt: new Date().toISOString()
        });
      }
      if (error instanceof ModelRunActivationError) {
        if (error.code === "not_found") return reply.code(404).send({ message: "未找到模型运行" });
        if (error.code === "not_succeeded") return reply.code(409).send({ message: "只能激活成功的模型运行" });
        if (error.code === "missing_metrics") return reply.code(409).send({ message: "该模型运行没有成功的运动统计结果，不能激活" });
        if (error.code === "release_gate") return reply.code(409).send({ message: `该模型运行未通过 V2 发布校验：${error.message}` });
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

// §11「项目退出备份责任」：应用不再**创建**备份。这条路由保留挂载（旧调用方拿到的是
// 明确维护提示，而不是 404 —— 404 会让人以为路径写错了），但不再走
// `maintenance.createBackup()`：创建、容量检查与保留策略轮换一并退场。
// 同时不再需要 `isDatabaseWriteBusy()` 那道 409 闸门 —— 一个不碰数据库的请求
// 没有"任务执行期间不能做"的理由，留着只会暗示它仍然会写。
//
// ⚠️ 为什么是 410 而不是 501：`apiErrorPayload` 会把**所有** 5xx 的 message 压成
// "本地服务处理请求失败"，用 501 就等于把下面这段运维提示吞掉 —— 那正是 §11
// 禁止的"静默失败"。410 Gone 的语义（该能力已被永久移除）在这里也更准确：
// 不是服务坏了，是这份责任已经移交给运维。
app.post("/v1/backups", async (_request, _reply) => {
  throw new ClientRequestError("backup_creation_retired",
    "应用不再创建备份。请在维护窗口前由运维自行完成一致性备份；"
    + "活跃 WAL 库不能只 cp rai.sqlite，须用 SQLite 一致性备份 API 或存储快照，"
    + "见 docs/SQLITE_DIRECT_SYNC_DESIGN.md §11.1", 410);
});

/**
 * Download one existing backup (the recovery capability half; the app itself no
 * longer creates or deletes backups).
 *
 * `Cache-Control: no-store`: this is the entire health database, so no
 * intermediary may keep a copy even though the route is token-gated. The
 * `filename` is built from the validated parameter (`backupParamsSchema` only
 * admits `<basename>.sqlite`) and additionally reduced to characters that are
 * legal and unambiguous inside a quoted header value (review P3-20) — the schema
 * allows quotes and semicolons, which would otherwise break `Content-Disposition`.
 */
const backupDownloadFileName = (name: string): string =>
  name.replace(/[^A-Za-z0-9._@+-]/g, "_");

app.get<{ Params: { name: string } }>("/v1/backups/:name", { schema: { params: backupParamsSchema } }, async (request, reply) => {
  const stream = await maintenance.backupStream(request.params.name);
  reply.header("Cache-Control", "no-store");
  reply.header("content-type", "application/x-sqlite3");
  reply.header("content-disposition", `attachment; filename="${backupDownloadFileName(request.params.name)}"`);
  return reply.send(stream);
});

// 删除交付给运维：应用不替运维决定备份的保留/归档/删除（§11「不扫描它们作自动清理」，
// §14.2 A15「不创建、验证、轮换或删除备份」）。因此这条路由连文件都不碰 ——
// 已存在的备份字节不变，是最强的"不删除"证据。
app.delete<{ Params: { name: string } }>("/v1/backups/:name", { schema: { params: backupParamsSchema } }, async (_request, _reply) => {
  throw new ClientRequestError("backup_deletion_retired",
    "应用不再删除备份文件。是否保留、归档或删除由服务器运维决定；"
    + "已有备份不会被应用删除，见 docs/SQLITE_DIRECT_SYNC_DESIGN.md §11", 410);
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
    restoringDatabase = true;
    try {
      const restoredEpoch = randomUUID();
      const result = await maintenance.restoreBackup(
        request.params.name,
        () => recoverDatabaseJobs(true),
        database => writeDatasetEpoch(database, configuredDatasetEpoch, restoredEpoch)
      );
      changeDatasetEpoch(restoredEpoch);
      databaseRecoveryRequired = false;
      invalidateDatabaseReadiness();
      recomputeWorker.schedule();
      predictionModelWorker.schedule();
      return { restored: true, restoredBackup: result.restored, safetyBackup: result.safetyBackup };
    } finally { restoringDatabase = false; }
  }
);

app.delete<{ Body: { confirmation: string } }>("/v1/database", { schema: { body: deleteBodySchema } }, async (request, reply) => {
  if (request.body?.confirmation !== "删除我的 RAI 数据") {
    return reply.code(400).send({ message: "确认文字不匹配" });
  }
  if (isDatabaseRestoreBusy()) {
    return reply.code(409).send({ message: "任务执行期间不能删除数据库" });
  }
  restoringDatabase = true;
  const previousEpoch = datasetEpoch;
  const deletedEpoch = randomUUID();
  let epochPrepared = false;
  try {
    const backupInfo = await maintenance.deleteDatabase(() => {
      // Persist before unlink: a crash with no facts DB must not recover old receipts.
      writeDeletedDatasetEpoch(databasePath, configuredDatasetEpoch, deletedEpoch);
      epochPrepared = true;
    });
    changeDatasetEpoch(deletedEpoch);
    databaseRecoveryRequired = true;
    invalidateDatabaseReadiness();
    return backupInfo.restorable === false
      ? { deleted: true, preservation: { kind: "quarantine" as const, snapshot: backupInfo } }
      : { deleted: true, preservation: { kind: "backup" as const, backup: backupInfo } };
  } catch (error) {
    if (epochPrepared) {
      if (!existsSync(databasePath)) {
        changeDatasetEpoch(deletedEpoch);
        throw new RestoreRecoveryRequiredError("Database deletion failed without restoring the facts database", { cause: error });
      }
      try { writeDeletedDatasetEpoch(databasePath, configuredDatasetEpoch, previousEpoch); }
      catch (rollbackError) {
        throw new RestoreRecoveryRequiredError("Database deletion scope rollback failed", { cause: new AggregateError([error, rollbackError]) });
      }
    }
    throw error;
  } finally { restoringDatabase = false; }
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  if (error instanceof RestoreRecoveryRequiredError) {
    databaseRecoveryRequired = true;
    invalidateDatabaseReadiness();
    taskAdmission.blockUntilRestart(error.code);
  }
  const payload = apiErrorPayload(error);
  // Snapshot-changed errors are transient by construction; the helper keeps the
  // exact code list in one unit-tested place (review P2-6).
  const retryAfter = retryAfterSeconds(payload);
  if (retryAfter !== null) reply.header("Retry-After", retryAfter);
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

// systemd watchdog（2026-10-18 事故复盘 P1）：listen 后发 READY=1，之后每 40s 心跳。
// 无 NOTIFY_SOCKET（本地/测试）时全部 no-op，因此这里不需要环境判断。
const systemdNotifier = createSystemdNotifier({ log: app.log });
await app.listen({ host, port });
const address = app.server.address();
if (!address || typeof address === "string") {
  throw new Error("API did not bind to a TCP port");
}
localRequestSecurityOptions.apiPort = address.port;
if (process.send) process.send({ type: "rai:ready", port: address.port });
systemdNotifier.ready();
systemdNotifier.startWatchdog();
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
    // STOPPING=1 让 systemd 立刻知道是正常关闭（不会按失败重启）；
    // 心跳定时器也要停，别在关闭窗口里继续发消息。
    systemdNotifier.stopping();
    try {
      await app.close();
    } catch (error) {
      app.log.error(error, "Local API shutdown failed");
      process.exitCode = 1;
    } finally {
      systemdNotifier.stop();
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
