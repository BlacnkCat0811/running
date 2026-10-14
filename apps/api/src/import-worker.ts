import { CONTRACT_VERSION, DATABASE_TIMEZONE } from "@rai/contracts";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { analyzeDatasetChange, type ImportDatasetChange } from "./import-dataset-analysis.js";
import {
  computeImportPayloadSha256,
  readDatabaseImportIdentity,
  readDatasetVersion,
  writeImportPayloadAnchor
} from "./import-payload-identity.js";

import type {
  ImportExecutionEngine, ImportJobResponse, ImportJobPerformance, ImportLaneRejection, ImportLaneTelemetry, ImportStage
} from "@rai/api-contracts";
import { currentAbilityBaselineHash } from "@rai/application";
import {
  ImportRemovalGuardError,
  identityAlgorithmFingerprint,
  stageAuditFiles,
  stageBuiltAuditFiles,
  type DataAudit,
  type RemovalGuardPayload,
  type StagedAuditFiles,
  NATIVE_VERSION,
} from "@rai/health-export-parser";
import { isStructurallyReadable, RaiDatabase } from "@rai/storage-sqlite";
import { ImportPerformanceTracker } from "./import-performance.js";
import { databaseReadable, type ImportDatabaseTask } from "./import-database-tasks.js";
import { dataOnlyBaselineContract, type DataOnlyImportResult } from "./data-only-import.js";
import { isDirectSyncRejection, type DirectSyncImportResult, type DirectSyncRejection } from "./direct-sync-ingest.js";
import { planDirectSyncLane } from "./direct-sync-plan.js";
import { resolvePreserveAbsent } from "./import-sources.js";
import { backupPolicyFromEnvironment, DatabaseMaintenance } from "./maintenance.js";
import { RuntimeStateStore } from "./runtime-state.js";

import { ImportPublicationJournal, readImportReceipt, writeImportReceipt } from "./import-publication.js";
import type { TaskAdmission } from "./task-admission.js";
import { terminateProcessTree, waitForShutdown } from "./worker-process.js";

/** Client-visible failure text; diagnostics stay in server logs and internal runtime state. */
export const PUBLIC_IMPORT_FAILURE_ERROR = "导入失败，请查看服务日志";

export class ImportJobEnqueuePersistenceError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Failed to persist import job", { cause });
    this.name = "ImportJobEnqueuePersistenceError";
  }
}

export function createImportJobId(now = Date.now()): string {
  return `web_import_${now.toString(36)}_${randomUUID()}`;
}

/**
 * Finds a removal-guard failure anywhere in an error chain. The guard message is
 * authored for the operator and carries no paths or stack details, so it is the
 * one import failure safe to return to a client verbatim.
 */
function findRemovalGuardError(error: unknown): ImportRemovalGuardError | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ImportRemovalGuardError) return current;
    if (current instanceof AggregateError) queue.push(...current.errors);
    else if (current instanceof Error && current.cause !== undefined) queue.push(current.cause);
  }
  return null;
}

const applyBusyTimeout = (database: DatabaseSync, milliseconds = 5000): void => {
  database.exec(`PRAGMA busy_timeout = ${milliseconds}`);
};

/**
 * 收口后（S3.1/S3.3）直连车道的**显式拒绝**：不再回退候选链路，而是让作业带稳定码失败。
 *
 * `reasons` 是稳定机器码序列（lane 否决原因或 `DirectSyncRejection.reason`）；
 * `rejection` 在带观测字段（actual/bounds）时一并携带。落点：`job.failureCode`（客户端处置）
 * 与主线程日志（观测）。
 */
class ImportLaneRefusal extends Error {
  constructor(
    readonly reasons: readonly string[],
    readonly rejection?: DirectSyncRejection
  ) {
    super(`Direct sync refused: ${reasons.join(",")}`);
    this.name = "ImportLaneRefusal";
  }

  /** 对外的稳定错误码（客户端可分支处置；见 `ImportJobResponse.failureCode`）。 */
  get failureCode(): string {
    return laneRefusalFailure(this.reasons[0] ?? "direct_sync_unavailable").code;
  }

  /** 对外的**受控中文**文案（不含内部诊断；用户可见文案的用词纪律）。 */
  get userMessage(): string {
    return laneRefusalFailure(this.reasons[0] ?? "direct_sync_unavailable").message;
  }
}

/**
 * 拒因 → `{ code, message }` 的**唯一映射表**（lane 否决原因 + direct-sync 拒收码共用）。
 *
 * 为什么集中一张表：这些码是 iOS 处置分支（拆批 / 退避 / 报维护）的输入契约，
 * 散在调用点会让"某个码改了而客户端分支没跟"变成静默错误。
 */
export function laneRefusalFailure(reason: string): { code: string; message: string } {
  switch (reason) {
    case "fast_path_disabled":
      return { code: "direct_sync_unavailable", message: "同步入口已暂停（服务端关闭了直连数据通路），请联系维护者" };
    case "engine_version_mismatch":
    case "no_existing_database":
      return { code: "direct_sync_unavailable", message: "服务端直连通道暂不可用，请稍后重试或联系维护者" };
    case "not_queued":
      return { code: "direct_sync_internal_integrity", message: "导入失败，请查看服务日志" };
    case "payload_is_a_complete_snapshot":
      return { code: "direct_sync_full_snapshot_unsupported", message: "该导出是完整快照形态，直连通道不接受；请改用增量同步" };
    case "payload_identity_unavailable":
      return { code: "direct_sync_input_not_allowed", message: "无法复核导出文件身份，请重新导出后重试" };
    case "xml_exceeds_bounds":
    case "manifest_exceeds_bounds":
    case "deletions_exceed_bounds":
    case "route_exceeds_bounds":
      return { code: "direct_sync_payload_exceeds_bounds", message: "本批超出服务端单批上限，请减小单批数据量后重传" };
    case "missing_required_files":
    case "input_tree_not_allowed":
    case "missing_record_identity":
    case "payload_identity_invalid":
      return { code: "direct_sync_input_not_allowed", message: "导出内容不符合直连通道要求，请重新导出后重试" };
    case "baseline_rebuild_required":
      return { code: "direct_sync_baseline_rebuild_required", message: "服务端数据代际与当前版本不符，需维护者重建基线后重试" };
    case "identity_not_eligible":
      return { code: "direct_sync_unavailable", message: "服务端数据基线尚未就绪，请稍后重试" };
    case "pending_migrations":
    case "database_not_found":
      return { code: "direct_sync_unavailable", message: "服务端数据库未就绪，请联系维护者" };
    case "batch_without_receipt":
    case "write_guard_triggered":
      return { code: "direct_sync_internal_integrity", message: "导入失败，请查看服务日志" };
    default:
      // `engine_<name>` 等前缀式否决与未知码：统一归"不可用"（退避重试是安全方向）。
      return { code: "direct_sync_unavailable", message: "直连通道当前不可用，请稍后重试" };
  }
}

export const predictionModelWorkerRetryDelay = (consecutiveFailures: number): number =>
  Math.min(30_000, 1_000 * (2 ** Math.max(0, consecutiveFailures - 1)));

interface MutableImportJob extends ImportJobResponse {
  inputPath: string;
  preserveAbsent?: boolean;
  removalGuard?: RemovalGuardPayload;
  onTerminal?: (succeeded: boolean, durable: boolean) => void | Promise<void>;
  queue?: { scope: string; attempts: number; finalized: boolean; cancelRequested?: boolean; engine?: ImportExecutionEngine };
}

/**
 * A pre-flight hit: the payload is provably the one behind the current database,
 * so applying it again cannot change anything.
 *
 * `unchangedWorkouts` is read from the database rather than measured by a diff —
 * a no-op import leaves every existing session exactly as it is, so the database's
 * own count *is* the number of unchanged sessions. Reporting `0` there would be a
 * different (and false) claim: "this database has no sessions".
 */
interface PayloadPreflight {
  sha256: string;
  datasetVersion: string;
  unchangedWorkouts: number;
}

/**
 * `rai:compute-performance` 的 stage 名格式：字母开头，后接字母/数字/下划线。
 *
 * 🔴 这里曾经是一份**硬编码白名单**（`features` / `trainingMetrics` / `modelReplay` /
 * `parse_health_xml` / `import_gpx_routes` / `canonicalize_workouts` / `canonicalize_nights` /
 * `stage_audit_files`）。2026-09-21 在 `packages/health-export-parser/src/cli.ts` 里新增了
 * 7 个 `timedStage` 埋点后，线上 `computeStagesMs` **一个都没出现、且零报错** ——
 * 发送端改了、接收端白名单没改，新埋点被静默丢弃。
 *
 * 而 `computeStagesMs` 的契约本身就是**开放字典**（`packages/api-contracts/src/index.ts`
 * 的 `Record<string, number>` + `apps/api/src/schemas.ts` 的
 * `additionalProperties: { type: "number" }`）—— 白名单与契约不一致。
 * 改成格式校验：去掉「每加一个埋点就要改两处」的隐藏耦合，同时仍限制子进程
 * 不能往 `performance_json` 里注入任意键。
 */
export const COMPUTE_STAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/** 解析一条 `rai:compute-performance` 消息；不合法返回 `null`。导出以便单测。 */
export function parseComputeStageMessage(message: unknown): {
  stage: string;
  durationMs: number;
  processMaxRssKiB: number | null;
} | null {
  if (typeof message !== "object" || message === null) return null;
  const payload = message as { type?: unknown; stage?: unknown; durationMs?: unknown; processMaxRssKiB?: unknown };
  if (payload.type !== "rai:compute-performance") return null;
  if (typeof payload.stage !== "string" || !COMPUTE_STAGE_NAME_PATTERN.test(payload.stage)) return null;
  if (typeof payload.durationMs !== "number" || !Number.isFinite(payload.durationMs) || payload.durationMs < 0) return null;
  return {
    stage: payload.stage,
    durationMs: payload.durationMs,
    processMaxRssKiB: typeof payload.processMaxRssKiB === "number" && Number.isFinite(payload.processMaxRssKiB) && payload.processMaxRssKiB >= 0
      ? payload.processMaxRssKiB
      : null
  };
}

/**
 * `rai:native-engine` 的 operation 名格式：小写字母开头，后接小写字母/数字/连字符。
 *
 * 🔴 这里曾经是一份**硬编码白名单**（`["health","gpx","aggregate","apply-records"]`）——
 * 它与上面 `computeStagesMs` 那次是**同一个坑的下一处**：Rust 侧新增一个 operation 时，
 * 发送端（`packages/health-export-parser/src/native-worker.ts` 的 `NATIVE_OPERATIONS`）、
 * Rust 二进制、CLI 都得改，而这份白名单是**唯一改了也不报错**的一处 ——
 * 新 operation 的 `rustCalls` / `wallMs` / `peakRssKiB` 会被静默吃掉，
 * `performance.native` 里就是没有它，`/v1/data-summary` 的 `issues` 也照旧是 `[]`。
 *
 * 而 `native` 的契约本身就是**开放字典**（`packages/api-contracts/src/index.ts` 的
 * `Record<string, { rustCalls; typescriptFallbacks; wallMs; peakRssKiB }>` +
 * `apps/api/src/schemas.ts` 的 `additionalProperties: {...}`）—— 白名单与契约不一致。
 * 改成格式校验：去掉「每加一个 operation 就要改两处」的隐藏耦合，同时仍限制子进程
 * 不能往 `performance_json` 里注入任意键。
 *
 * ⚠️ 紧邻的 `rai:native-failure` 那份 `["unavailable","invalid_protocol"]` **不属此类**：
 * 它是**语义判定表**（哪些 code 意味着"引擎不可用、必须拦住回退"），改它会改变行为，
 * 所以刻意保留为显式判定，不做格式校验。
 */
export const NATIVE_OPERATION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** 解析一条 `rai:native-engine` 消息；不合法返回 `null`。导出以便单测。 */
export function parseNativeEngineMessage(message: unknown): {
  operation: string;
  actual: "rust" | "typescript";
  durationMs: number;
  peakRssKiB: number | null;
} | null {
  if (typeof message !== "object" || message === null) return null;
  const payload = message as { type?: unknown; operation?: unknown; actual?: unknown; durationMs?: unknown; peakRssKiB?: unknown };
  if (payload.type !== "rai:native-engine") return null;
  if (typeof payload.operation !== "string" || !NATIVE_OPERATION_NAME_PATTERN.test(payload.operation)) return null;
  if (payload.actual !== "rust" && payload.actual !== "typescript") return null;
  if (typeof payload.durationMs !== "number" || !Number.isFinite(payload.durationMs) || payload.durationMs < 0) return null;
  // 与 `parseComputeStageMessage` 对齐：单个可选字段非法只降级成"没上报"，不整条丢弃。
  return {
    operation: payload.operation,
    actual: payload.actual,
    durationMs: payload.durationMs,
    peakRssKiB: typeof payload.peakRssKiB === "number" && Number.isFinite(payload.peakRssKiB) && payload.peakRssKiB >= 0
      ? payload.peakRssKiB
      : null
  };
}

export interface ImportQueueOptions {
  engine?: ImportExecutionEngine;
  /** Roll back to the candidate-publication path without changing sync identity. */
  dataOnlyFastPath?: boolean;
  scope: string;
  admission: TaskAdmission;
  maxPending?: number;
  assertAccepting?: () => void;
  onRecoveryRequired?: () => void;
  onTerminal?: (job: ImportJobResponse, succeeded: boolean, durable: boolean) => void | Promise<void>;
}

export class ImportQueueFullError extends Error {
  readonly statusCode = 429;
  readonly code = "import_queue_full";
  constructor() { super("导入队列已满，请等待现有任务完成后再提交"); }
}

export interface ImportWorkerSource {
  kind?: string | null;
  displayName?: string | null;
  originalPath?: string | null;
}

export class ImportWorker {
  private readonly jobs = new Map<string, MutableImportJob>();
  private readonly jobStatePath: string;
  private readonly state: RuntimeStateStore;
  private running = false;
  private closing = false;
  private timer: NodeJS.Timeout | null = null;
  private runPromise: Promise<void> | null = null;
  private activeChild: ChildProcess | null = null;
  private activeAnalysis: Worker | null = null;
  private activeJob: MutableImportJob | null = null;
  private cancelRequested = false;
  private readonly publicationJournal: ImportPublicationJournal | undefined;
  private computeStagesMs: Record<string, number> = {};
  private computeProcessMaxRssKiB = 0;
  private recoveryBlocked = false;
  private engineBlockedJobId: string | null = null;
  private nativeFailure: string | null = null;
  private nativeStats: NonNullable<ImportJobPerformance["native"]> = {};

  constructor(
    private readonly databasePath: string,
    private readonly projectRoot: string,
    private readonly runtimeRoot = projectRoot,
    private readonly beforeActivate: () => void | Promise<void> = () => {},
    private readonly afterActivate: () => void | Promise<void> = () => {},
    private readonly onDatabaseError: (error: unknown) => void = () => {},
    private readonly queueOptions?: ImportQueueOptions,
    private readonly recomputeEvaluatedAt?: string,
    private readonly executionEngine: ImportExecutionEngine = { name: "typescript", version: NATIVE_VERSION, fallback: "none" }
  ) {
    this.jobStatePath = resolve(runtimeRoot, "var/import-jobs.json");
    this.state = new RuntimeStateStore(runtimeRoot);
    this.publicationJournal = queueOptions ? new ImportPublicationJournal(databasePath, runtimeRoot) : undefined;
    const repaired = this.publicationJournal?.recover();
    if (repaired && existsSync(databasePath) && databaseReadable(databasePath)) {
      const audit = this.stageAuditReports(databasePath, resolve(runtimeRoot, "docs/DATA_AUDIT.md"), resolve(runtimeRoot, "var/reports/data-audit.json"));
      audit.commit();
      audit.finalize();
    }
    this.state.migrateLegacyJobs(this.jobStatePath);
    this.loadJobs();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get hasPending(): boolean {
    // Terminal status is visible before source cleanup and the publication
    // acknowledgement finish. Maintenance must not replace their receipt DB.
    return this.running || [...this.jobs.values()].some((job) =>
      ["queued", "running"].includes(job.status) || Boolean(job.queue && !job.queue.finalized));
  }

  active(): ImportJobResponse | null {
    const job = this.activeJob && ["queued", "running"].includes(this.activeJob.status)
      ? this.activeJob : [...this.jobs.values()].find((item) => ["queued", "running"].includes(item.status));
    return job ? this.publicJob(job) : null;
  }

  /** Explicit startup after database readiness and request dependencies exist. */
  resume(): void { this.scheduleNext(); }

  /** Called under the exclusive restore lease, after all imports are finalized. */
  setScope(scope: string): void { if (this.queueOptions) this.queueOptions.scope = scope; }

  async cancel(id: string): Promise<"not_found" | "terminal" | "publishing" | "cancelled" | "requested"> {
    const job = this.jobs.get(id);
    if (!job) return "not_found";
    if (!["queued", "running"].includes(job.status)) return "terminal";
    if (job.phase === "activate") return "publishing";
    if (job === this.activeJob && job.status === "running") {
      if (job.queue) {
        job.queue.cancelRequested = true;
        try { this.persistJobs(); } catch (error) { delete job.queue.cancelRequested; throw error; }
      }
      this.cancelRequested = true;
      if (this.activeChild) await terminateProcessTree(this.activeChild);
      await this.activeAnalysis?.terminate();
      return "requested";
    }
    const previous = { status: job.status, phase: job.phase, message: job.message, completedAt: job.completedAt };
    Object.assign(job, { status: "cancelled", phase: "cancelled", message: "导入已取消", completedAt: new Date().toISOString() });
    try { this.persistJobs(); } catch (error) { Object.assign(job, previous); throw error; }
    await this.runTerminalCallbackWithRetry(job, false, true);
    if (this.engineBlockedJobId === id) { this.engineBlockedJobId = null; this.scheduleNext(); }
    return "cancelled";
  }

  private scheduleNext(delay = 20): void {
    if (!this.queueOptions || this.closing || this.recoveryBlocked || this.timer || this.runPromise) return;
    const job = [...this.jobs.values()].find((item) => item.queue && !item.queue.finalized &&
      item.queue.scope === this.queueOptions!.scope &&
      (item.status === "queued" || ["succeeded", "failed", "cancelled"].includes(item.status)));
    if (!job) { this.queueOptions.admission.withdraw(); return; }
    if (job.id === this.engineBlockedJobId) { this.queueOptions.admission.withdraw(); return; }
    this.timer = setTimeout(() => {
      this.timer = null;
      const release = this.queueOptions!.admission.acquire();
      if (!release) { this.scheduleNext(250); return; }
      this.running = true;
      this.activeJob = job;
      this.cancelRequested = false;
      const execute = async () => {
        if (job.status === "queued") {
          job.queue!.attempts += 1;
          await this.run(job);
        } else {
          await this.persistJobsWithRetry();
          await this.runTerminalCallbackWithRetry(job, job.status === "succeeded", true);
        }
      };
      const promise = execute().catch((error) => {
        process.stderr.write(`Import queue execution failed: ${String(error)}\n`);
      }).finally(() => {
        this.running = false;
        this.activeJob = null;
        this.runPromise = null;
        release();
        this.scheduleNext(250);
      });
      this.runPromise = promise;
    }, delay);
    this.timer.unref();
  }

  create(
    inputPathValue: string,
    onTerminal?: (succeeded: boolean, durable: boolean) => void | Promise<void>,
    sourceId?: string,
    source?: ImportWorkerSource
  ): ImportJobResponse {
    if (this.closing) throw new Error("导入服务正在关闭");
    this.queueOptions?.assertAccepting?.();
    if (sourceId) {
      const existing = this.findBySourceId(sourceId);
      if (existing && ["queued", "running", "succeeded"].includes(existing.status)) return existing;
    }
    if (!this.queueOptions && this.running) throw new Error("已有导入任务正在执行");
    if (this.queueOptions && [...this.jobs.values()].filter((job) =>
      ["queued", "running"].includes(job.status)).length >= (this.queueOptions.maxPending ?? 8)) {
      throw new ImportQueueFullError();
    }
    const inputPath = resolve(inputPathValue);
    if (!existsSync(inputPath) || !statSync(inputPath).isDirectory()) {
      throw new Error("Apple Health 导出目录不存在");
    }
    if (!existsSync(resolve(inputPath, "export.xml")) && !existsSync(resolve(inputPath, "导出.xml"))) {
      throw new Error("目录中未找到 export.xml 或导出.xml");
    }
    const id = createImportJobId();
    // Absence-as-deletion is opt-in via the client's sync manifest; an archive
    // filename is only consulted when no manifest is present.
    const snapshot = resolvePreserveAbsent(inputPath, source ?? {});
    const preserveAbsent = snapshot.preserveAbsent;
    const job: MutableImportJob = {
      id,
      status: "queued",
      phase: "queued",
      message: "导入任务已排队",
      createdAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      inputPath,
      ...(this.queueOptions ? { queue: { scope: this.queueOptions.scope, attempts: 0, finalized: false, engine: this.queueOptions.engine ?? this.executionEngine } } : {}),
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(preserveAbsent ? { preserveAbsent: true } : {})
    };
    if (onTerminal) job.onTerminal = onTerminal;
    this.jobs.set(id, job);
    try {
      this.persistJobs();
    } catch (error) {
      // Persistence is the enqueue commit point. Do not publish a queued job
      // that cannot survive a restart, and do not run terminal cleanup for work
      // that was never successfully accepted.
      if (this.jobs.get(id) === job) this.jobs.delete(id);
      throw new ImportJobEnqueuePersistenceError(error);
    }
    if (this.queueOptions) {
      this.scheduleNext();
      return this.publicJob(job);
    }
    this.running = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      const promise = this.run(job).catch((error) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`Import worker failed unexpectedly: ${message}\n`);
      });
      this.runPromise = promise;
      void promise.finally(() => {
        if (this.runPromise === promise) this.runPromise = null;
      });
    }, 20);
    this.timer.unref();
    return this.publicJob(job);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.queueOptions?.admission.withdraw();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.queueOptions && this.running && !this.runPromise) {
      const job = [...this.jobs.values()].at(-1);
      if (job && ["queued", "running"].includes(job.status)) {
        job.status = "failed";
        job.phase = "interrupted";
        job.message = "导入因本地服务关闭而中断，可重新提交导入";
        job.error = PUBLIC_IMPORT_FAILURE_ERROR;
        job.completedAt = new Date().toISOString();
        let durable = false;
        let persistenceError: unknown;
        try {
          await this.persistJobsWithRetry();
          durable = true;
        } catch (error) {
          persistenceError = error;
        }
        try { await this.runTerminalCallbackWithRetry(job, false, durable); }
        catch { /* Terminal cleanup is best-effort during shutdown. */ }
        this.running = false;
        if (persistenceError) throw persistenceError;
      }
      this.running = false;
    }
    let terminationError: unknown;
    try {
      await this.activeAnalysis?.terminate();
      if (this.activeChild) await terminateProcessTree(this.activeChild);
    } catch (error) {
      terminationError = error;
      this.activeChild?.kill("SIGKILL");
    } finally {
      if (terminationError) await waitForShutdown(this.runPromise, 3_000);
      else await this.runPromise;
    }
    if (terminationError) throw terminationError;
  }

  get(id: string): ImportJobResponse | null {
    const job = this.jobs.get(id) ?? this.state.job(id) as MutableImportJob | null;
    return job ? this.publicJob(job) : null;
  }

  findBySourceId(sourceId: string): ImportJobResponse | null {
    const job = [...this.jobs.values()]
      .filter((candidate) => candidate.sourceId === sourceId &&
        (!this.queueOptions || candidate.queue?.scope === this.queueOptions.scope))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    const stored = job ?? this.state.latestJobForSource(sourceId, this.queueOptions?.scope) as MutableImportJob | null;
    return stored ? this.publicJob(stored) : null;
  }

  latest(): ImportJobResponse | null {
    const jobs = [...this.jobs.values()];
    const job = jobs.at(-1);
    return job ? this.publicJob(job) : null;
  }

  private async run(job: MutableImportJob): Promise<void> {
    this.nativeFailure = null;
    this.nativeStats = {};
    // Pre-upgrade queued jobs have no engine stamp and must stay TypeScript.
    const engine = job.queue
      ? job.queue.engine ?? { name: "typescript" as const, version: NATIVE_VERSION, fallback: "none" as const }
      : this.executionEngine;
    const attempt = job.queue ? `.attempt-${job.queue.attempts}` : "";
    const nativeSpoolRoot = resolve(this.runtimeRoot, "var", `native.${job.id}${attempt}`);
    const engineArgs = ["--engine", engine.name, "--native-version", engine.version, "--native-fallback", engine.fallback,
      "--native-spool-root", nativeSpoolRoot];
    this.computeStagesMs = {};
    this.computeProcessMaxRssKiB = 0;
    const startedAtMs = Date.now();
    const timing = new ImportPerformanceTracker();
    const stagingDatabase = resolve(this.runtimeRoot, "var", `rai.importing.${job.id}${attempt}.sqlite`);
    const stagedMarkdownReport = resolve(this.runtimeRoot, "var", `data-audit.${job.id}${attempt}.md`);
    const stagedJsonReport = resolve(this.runtimeRoot, "var", `data-audit.${job.id}${attempt}.json`);
    // S3.3：`finalMarkdownReport` / `finalJsonReport` / `currentBackupPath` 的声明随候选链路一起删除
    // （审计报告发布与项目备份只服务那条链路；保留的方法仍在类上，供阶段 5 隔离退役）。
    let terminalSucceeded = false;
    let publishTerminalState: (() => void) | null = null;
    let fastPathAttempted = false;
    // 观测（阶段 1，实施方案 §5.2 S1.3）：车道决策与拒因。
    // `null` = 该路径不适用（重放 / 恢复），`performance_json` 不写 `lane` 键。
    // 落点：finally 的 `job.performance` + 拒收发生时的主线程 stderr 日志（D5：
    // worker 线程内不打日志，统一在 databaseTask 返回处落 —— parentPort 的聚合不可靠）。
    let laneTelemetry: ImportLaneTelemetry | null = null;
    const laneRejections: ImportLaneRejection[] = [];
    try {
      job.status = "running";
      this.persistJobs();
      await mkdir(nativeSpoolRoot, { recursive: true });
      // 2026-10-14（S3.2/S3.3 补全）：**导入入口负责创建/修复存储** —— 这是既有的、被测试钉住的
      // 契约：`metadataOnlyMutationRoutes` 的注册注释写明 importing / restore / delete 三类路由
      // 不得被 existsSync 门挡住（否则恢复路径被锁死），deploy/README-UBUNTU.md 的显式迁移契约
      // 同样写着"缺失主库仍保留首次导入/维护入口"。
      // 候选链路时代这件事由"从新库开始"的候选导入顺手完成；收口后车道判定要求库已存在
      // （`no_existing_database` 是**防御性**分支），所以在这里补上等价动作：
      //   · 只处理"文件不存在"——创建一份全新迁移库（等价于运维的 `data:migrate`）；
      //   · 已存在但待迁移/损坏的库**绝不**在这里动（那是运维的显式流程：启动退出 78 / 隔离）。
      // 首包随后走 S3.2 的三态：四项身份全缺 ⇒ 就地初始化。
      if (!existsSync(this.databasePath)) {
        process.stderr.write(`Main database missing; creating a fresh database before import ${job.id}.\n`);
        (await RaiDatabase.open(this.databasePath)).close();
      }
      const receipt = this.queueOptions ? readImportReceipt(this.databasePath, job.id) : null;
      if (receipt) {
        terminalSucceeded = true;
        publishTerminalState = () => {
          job.status = "succeeded"; job.phase = "completed"; job.error = null;
          job.summary = receipt; job.message = "已恢复完成的导入，无需重复计算";
          job.completedAt = new Date().toISOString();
        };
        return;
      }
      // 🔴 载荷级早退必须在**备份之前**。下面的 `backup` → `stagingCopy` →
      // `parseImport` → `changeAnalysis` 是 O(主库) 的：线上 506 MB 的库，
      // 即使最终判定 `unchanged`（不换主库、不重算），这四步也已经全跑过一遍。
      // 判据只读**载荷**（大小与库无关），所以这一条命中时可以把整条链路整段跳过。
      // 判据的安全边界见 `import-payload-identity.ts` 的模块注释：锚点绑定
      // `dataset_version`，任何后续导入都会让它失效。
      let payloadSha256: string | null = null;
      const preflight = await timing.measure("changeAnalysis", async () => {
        const result = await this.detectUnchangedPayload(job, engine);
        if (result) payloadSha256 = result.sha256;
        return result;
      });
      this.assertNotClosing();
      if (preflight) {
        laneTelemetry = { outcome: "unchanged", reasons: [] };
        job.phase = "activate"; // terminal decision is now irreversible, including no-op imports
        terminalSucceeded = true;
        publishTerminalState = () => {
          job.status = "succeeded";
          job.phase = "completed";
          job.message = "导出文件与上次已导入的内容完全一致，未重新解析";
          job.completedAt = new Date().toISOString();
          job.summary = {
            recomputeReasons: ["payload_identity_unchanged"],
            importMode: "unchanged",
            insertedWorkouts: 0,
            updatedWorkouts: 0,
            removedWorkouts: 0,
            unchangedWorkouts: preflight.unchangedWorkouts,
            routesUpdated: 0,
            featuresReused: 0,
            featuresRecomputed: 0,
            modelReplayFrom: null,
            durationMs: Date.now() - startedAtMs,
            // 这一条路径根本没有生成备份，所以这里恒为 null，不是"备份失败"。
            backupName: null
          };
        };
        return;
      }
      // 车道判定抽成纯函数（`direct-sync-plan.ts`）：旧候选链路与直连链路的分歧只在这一个地方，
      // 每条否决原因都可单测。这里的取值与原内联六条件**逐条等价**。
      const lane = planDirectSyncLane({
        queued: Boolean(job.queue && this.queueOptions),
        fastPathEnabled: this.queueOptions?.dataOnlyFastPath !== false,
        engine,
        nativeVersion: NATIVE_VERSION,
        preserveAbsent: job.preserveAbsent === true,
        databaseExists: existsSync(this.databasePath)
      });
      // 观测（阶段 1，S1.3）：车道判定先落 telemetry（默认 fallback；直连成功时被就地覆盖）。
      laneTelemetry = { outcome: "fallback", reasons: [...lane.reasons], rejections: laneRejections };
      if (lane.lane === "legacy") {
        // S3.1/D1 收口：车道判定否决 ⇒ **显式失败**（语义从"退回候选"变为"暂停同步入口"）。
        // 日志（阶段 1 观测面）保留 —— 失败原因仍要能 grep 到。
        process.stderr.write(`Direct sync lane rejected for ${job.id}: ${lane.reasons.join(",")}\n`);
        throw new ImportLaneRefusal(lane.reasons);
      }
      if (lane.lane === "direct") {
        payloadSha256 = await this.payloadSha256(job, engine);
        this.assertNotClosing();
        if (payloadSha256 === null) {
          // S3.1 收口：载荷摘要算不出来（输入不可读）⇒ 显式失败（带码），不再是回退理由。
          laneRejections.push({ source: "preflight", reason: "payload_identity_unavailable", stage: "read",
            detail: "computeImportPayloadSha256 失败：同一载荷无法复核身份" });
          throw new ImportLaneRefusal(["payload_identity_unavailable"]);
        } else {
          job.phase = "activate";
          job.message = "正在按增量事务保存原始健康记录";
          this.persistJobs();
          fastPathAttempted = true;
          const fast = await timing.measure("dataOnlyApply", () => this.databaseTask<DataOnlyImportResult>({
            operation: "data-only", input: {
              databasePath: this.databasePath, inputPath: job.inputPath, jobId: job.id,
              payloadSha256: payloadSha256!, startedAtMs
            }
          }));
          if (fast) {
            terminalSucceeded = true;
            laneTelemetry = { outcome: "direct", directSource: "data-only", reasons: [], rejections: laneRejections };
            publishTerminalState = () => {
              job.status = "succeeded"; job.phase = "completed"; job.error = null;
              job.summary = fast.summary; job.completedAt = new Date().toISOString();
              job.message = fast.replayed ? "已恢复完成的增量事务，无需重复入库"
                : "原始健康记录已增量保存，无需重算或切换数据库";
            };
            return;
          }
          laneRejections.push({ source: "data-only", reason: "fast_path_rejected", stage: "read",
            detail: "载荷不是 record-only 白名单形状，或缺快通路基线戳" });
          process.stderr.write(`Fast path rejected for ${job.id}: continuing to the direct-sync receiver\n`);
          // 🔴 record-only 快通路**拒收**（载荷不只是白名单里的记录增量，或缺少基线戳）。
          // 2e 之前这个分叉直接掉回旧候选链路 —— 那意味着为一个 Workout 载荷做整库备份、
          // 校验、切换数据库。现在先走**统一接收器**（PR4 步骤 2c：事实 + 路线 + 登记同事务）：
          // 它接受 Workout / 评分类型 / 显式删除 / GPX，并由账本决定要不要登记分析任务。
          // ⚠️ 这里**不能**改成"先统一接收器、再 record-only"：record-only 车道的入口判据
          // 比本车道更严（白名单 + 基线合同戳），把它放在后面会让它的两条闸门失去意义。
          this.assertNotClosing();
          job.message = "正在按增量事务保存原始事实并登记分析";
          this.persistJobs();
          const direct = await timing.measure("directSyncApply", () =>
            this.databaseTask<DirectSyncImportResult | DirectSyncRejection>({
              operation: "direct-sync", input: {
                databasePath: this.databasePath, inputPath: job.inputPath, jobId: job.id,
                payloadSha256: payloadSha256!, startedAtMs
              }
            }));
          if (!isDirectSyncRejection(direct)) {
            terminalSucceeded = true;
            laneTelemetry = { outcome: "direct", directSource: "direct-sync", reasons: [], rejections: laneRejections };
            publishTerminalState = () => {
              const analysisQueued = direct.summary.directSync?.analysisStatus === "queued";
              job.status = "succeeded"; job.phase = "completed"; job.error = null;
              job.summary = direct.summary; job.completedAt = new Date().toISOString();
              // 回执的 `analysisStatus` 是**唯一**的判据，不看车道、不看载荷形状：
              // `queued` ⇒ 同事务里真的登记了分析任务（提交前断言守着）；`not_required` ⇒ 没有。
              job.message = direct.replayed ? "已恢复完成的增量事务，无需重复入库"
                : analysisQueued ? "原始事实已增量保存，分析任务已登记，正在重算"
                : "原始事实已增量保存，无需重算或切换数据库";
            };
            return;
          }
          laneRejections.push({
            source: "direct-sync", reason: direct.reason, stage: direct.stage,
            ...(direct.detail === undefined ? {} : { detail: direct.detail }),
            ...(direct.actual === undefined ? {} : { actual: { ...direct.actual } }),
            ...(direct.bounds === undefined ? {} : { bounds: { ...direct.bounds } })
          });
          process.stderr.write(`Direct sync rejected for ${job.id}: ${direct.reason} (stage=${direct.stage})`
            + `${direct.actual === undefined ? "" : ` actual=${JSON.stringify(direct.actual)}`}`
            + `${direct.bounds === undefined ? "" : ` bounds=${JSON.stringify(direct.bounds)}`}\n`);
          // S3.3 收口：两条直连车道都不合格 ⇒ **显式失败**（带稳定码），不再回退候选链路。
          // 上面那条 `Direct sync rejected` 日志（阶段 1 观测面）继续保留。
          // `fastPathAttempted` 保持 true 到 catch —— 若此前确有一批走直连车道**提交**过、
          // 只是回执没送到，catch 会先试 `readImportReceipt` 恢复成功（判据不变）。
          throw new ImportLaneRefusal([direct.reason], direct);
        }
      }
      // S3.3：旧候选链路（整库备份 → 暂存副本 → CLI 导入 → 重算 → 文件换库）的**调用链已删除**。
      // 保留的方法（createCurrentBackup / activateDatabase / prepareAuditReports / …）只服务
      // 阶段 5 的隔离退役；运行期不再有任何路径到达它们。删除依据：iOS 分批版（阶段 2）
      // 把回退率降到 0 之后，这条链路只剩成本没有功能 —— 它的两次全库 quick_check 占
      // 单次成本 71.5–76.9%（线上实测整批 9.9–13.3 min）。
    } catch (error) {
      // The SQLite commit may have completed just before a worker lost its
      // reply or shutdown interrupted the parent. Never report a committed
      // delta as failed: its receipt is in the SAME transaction as its facts.
      const committedDelta = fastPathAttempted ? readImportReceipt(this.databasePath, job.id) : null;
      if (committedDelta) {
        terminalSucceeded = true;
        publishTerminalState = () => {
          job.status = "succeeded"; job.phase = "completed"; job.error = null;
          job.summary = committedDelta; job.completedAt = new Date().toISOString();
          job.message = "增量事务已提交，已从持久回执恢复成功结果";
        };
        process.stderr.write(`Recovered committed data-only import ${job.id} after its worker reply was lost.\n`);
        return;
      }
      if (error instanceof ImportLaneRefusal) {
        // S3.1 收口：直连拒绝 = **终态失败**（带稳定码 + 受控文案），不是回退信号。
        // 不经过 `onDatabaseError`（它不是数据库错误）、不碰 removalGuard 链。
        terminalSucceeded = false;
        console.error(`Import job ${job.id} refused by the direct-sync lane: ${error.reasons.join(",")}`
          + `${error.rejection === undefined ? "" : ` detail=${JSON.stringify(error.rejection)}`}`);
        publishTerminalState = () => {
          if (this.cancelRequested) {
            // 取消优先（与既有 catch 同源语义）：用户主动停下的一批不该被报成"被拒"。
            job.status = "cancelled"; job.phase = "cancelled";
            job.message = "导入已取消"; job.error = null; job.completedAt = new Date().toISOString();
            return;
          }
          job.status = "failed"; job.phase = "failed";
          job.message = error.userMessage;
          // 内部诊断（`publicJob` 会把 job.error 替换成通用文案；客户端拿到的机器面是 failureCode）。
          job.error = `${error.failureCode}:${error.reasons.join(",")}`;
          job.failureCode = error.failureCode;
          job.completedAt = new Date().toISOString();
        };
        return;
      }
      this.onDatabaseError(error);
      // S3.3：`auditPublication` 的 rollback 随候选链路删除 —— 审计报告发布只由那条链路
      // 产生（`prepareAuditReports` 仍在类上，供阶段 5 隔离退役）。
      const failure: unknown = error;
      terminalSucceeded = false;
      const removalGuard = findRemovalGuardError(failure);
      const detail = failure instanceof Error
        ? (failure.stack ?? failure.message)
        : String(failure);
      // Log while the staging database still exists. Terminal state is persisted
      // after cleanup, but a cleanup interruption must not erase the journal clue.
      console.error(`Import job ${job.id} failed: ${detail}`);
      publishTerminalState = () => {
        // publicJob must never expose these internal diagnostics.
        const waitForEngine = Boolean(job.queue && ["unavailable", "invalid_protocol"].includes(this.nativeFailure ?? ""));
        const resume = Boolean(waitForEngine || (this.queueOptions && this.closing && job.queue && !this.cancelRequested));
        if (waitForEngine) {
          this.engineBlockedJobId = job.id;
          job.queue!.attempts = Math.max(0, job.queue!.attempts - 1);
        }
        job.status = resume ? "queued" : this.cancelRequested ? "cancelled" : "failed";
        job.phase = resume ? "queued" : this.cancelRequested ? "cancelled" : "failed";
        job.message = resume ? "服务停止，重启后继续导入" : this.cancelRequested ? "导入已取消" : "导入失败，原始导出文件未被修改";
        if (waitForEngine) { job.phase = "waiting_engine"; job.message = "原任务的 Rust 执行器不可用，请安装匹配版本后重启服务"; }
        // The guard refusal is a deliberate safety stop, not an opaque crash, so
        // the operator is told exactly what was about to be deleted and why.
        job.error = resume || this.cancelRequested ? null : removalGuard ? removalGuard.userMessage : detail;
        if (removalGuard) job.removalGuard = removalGuard.toPayload();
        job.completedAt = resume ? null : new Date().toISOString();
      };
    } finally {
      try {
        await timing.measure("cleanup", () => Promise.all([
          rm(nativeSpoolRoot, { recursive: true, force: true }),
          this.removeDatabaseFiles(stagingDatabase),
          // Only on the committed path: after a failure the displaced database may
          // be the only usable recovery point, so it must survive for an operator.
          ...(terminalSucceeded ? [this.reclaimDisplacedImportDatabases(stagingDatabase)] : []),
          rm(stagedMarkdownReport, { force: true }),
          rm(stagedJsonReport, { force: true }),
        ]));
      } catch (error) {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`Failed to clean up import staging database: ${message}\n`);
      } finally {
        let terminalStatePersisted = false;
        try {
          job.performance = {
            ...timing.snapshot(),
            computeStagesMs: { ...this.computeStagesMs },
            computeProcessMaxRssKiB: this.computeProcessMaxRssKiB
            ,native: { ...this.nativeStats },
            ...(laneTelemetry === null ? {} : { lane: laneTelemetry })
          };
          publishTerminalState?.();
          if (publishTerminalState) {
            await this.persistJobsWithRetry();
            terminalStatePersisted = true;
          }
        } catch (error) {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          process.stderr.write(`Failed to persist terminal import state for ${job.id}: ${message}\n`);
        } finally {
          try {
            await this.runTerminalCallbackWithRetry(job, terminalSucceeded, terminalStatePersisted);
          } catch (error) {
            const message = error instanceof Error ? error.stack ?? error.message : String(error);
            process.stderr.write(`Failed to finalize import source for ${job.id}: ${message}\n`);
          } finally {
            this.running = false;
          }
        }
      }
    }
  }

  private async persistJobsWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        this.persistJobs();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw lastError;
  }

  private async runTerminalCallbackWithRetry(
    job: MutableImportJob,
    succeeded: boolean,
    durable: boolean
  ): Promise<void> {
    if (job.status === "queued") return;
    if (!succeeded && this.publicationJournal?.has(job.id)) {
      // Rollback did not finish. Keep both the journal and the uploaded input;
      // running another writer here could destroy the only recovery point.
      this.recoveryBlocked = true;
      this.queueOptions?.onRecoveryRequired?.();
      throw new Error("Import publication needs recovery; writers paused until service restart");
    }
    if (!job.onTerminal && !this.queueOptions && !job.queue) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await job.onTerminal?.(succeeded, durable);
        await this.queueOptions?.onTerminal?.(this.publicJob(job), succeeded, durable);
        if (durable && job.queue) {
          job.queue.finalized = true;
          const { onTerminal: _onTerminal, ...record } = job;
          try { this.state.finalizeImportJob(record); }
          catch (error) { job.queue.finalized = false; throw error; }
        }
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw lastError;
  }

  private stageAuditReports(
    databasePath: string,
    markdownPath: string,
    jsonPath: string,
    preparedAudit?: DataAudit,
  ): StagedAuditFiles {
    if (preparedAudit) return stageBuiltAuditFiles(preparedAudit, markdownPath, jsonPath);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return stageAuditFiles(database, markdownPath, jsonPath);
    } finally {
      database.close();
    }
  }

  private async prepareAuditReports(databasePath: string, markdownPath: string, jsonPath: string): Promise<StagedAuditFiles> {
    const audit = await this.databaseTask<DataAudit>({ operation: "audit", path: databasePath });
    this.assertNotClosing();
    return this.stageAuditReports(databasePath, markdownPath, jsonPath, audit);
  }

  /** A Promise wrapper around synchronous SQL is not sufficient: own the
   * SQLite connection on a separate thread, and propagate termination as a
   * task failure, never as evidence that a healthy database is corrupt. */
  private databaseTask<T>(task: ImportDatabaseTask, stage = task.operation === "verify"
    ? "database_quick_check" : task.operation === "audit" ? "final_audit_build"
      : task.operation === "data-only" ? "data_only_transaction"
        : task.operation === "direct-sync" ? "direct_sync_transaction" : "database_checkpoint"): Promise<T> {
    const started = performance.now();
    return new Promise<T>((resolveResult, reject) => {
      const thread = new Worker(new URL("./import-database-bootstrap.mjs", import.meta.url), { workerData: task });
      this.activeAnalysis = thread;
      let received = false;
      let result: T;
      thread.once("message", (value: T) => { result = value; received = true; });
      thread.once("error", reject);
      thread.once("exit", (code) => {
        if (this.activeAnalysis === thread) this.activeAnalysis = null;
        this.computeStagesMs[stage] = (this.computeStagesMs[stage] ?? 0) + performance.now() - started;
        if (code === 0 && received) resolveResult(result);
        else reject(new Error(`Import database ${task.operation} interrupted`));
      });
    });
  }

  private countRows(databasePath: string, table: string): number {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    } finally { database.close(); }
  }

  private latestFeatureRunSummary(databasePath: string): { reused: number; recomputed: number } {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare(`
        SELECT feature.reused_feature_count AS reused, feature.recomputed_feature_count AS recomputed
        FROM active_model_run active
        JOIN model_runs model ON model.id=active.model_run_id
        JOIN feature_runs feature ON feature.id=model.feature_run_id
        WHERE active.singleton=1
      `).get() as unknown as { reused: number; recomputed: number } | undefined;
      return { reused: Number(row?.reused ?? 0), recomputed: Number(row?.recomputed ?? 0) };
    } finally { database.close(); }
  }

  private analyzeDatasetChange(stagingPath: string, previousPath: string, batchId?: string, preserveAbsent?: boolean): ImportDatasetChange {
    return analyzeDatasetChange(stagingPath, previousPath, batchId, preserveAbsent);
  }

  /**
   * Payload identity of an import's input, or `null` when it cannot be computed.
   *
   * A payload that cannot be read is *not* a pre-flight failure: the import itself
   * will report the real problem with a proper message. Failing here would turn an
   * optimisation into a new way to fail an import.
   */
  private async payloadSha256(job: MutableImportJob, engine: ImportExecutionEngine): Promise<string | null> {
    try {
      return await computeImportPayloadSha256(job.inputPath, {
        preserveAbsent: job.preserveAbsent === true,
        contractVersion: CONTRACT_VERSION,
        // `<name>@<version>`: the engine decides what gets written, so an upgraded
        // native binary must move the digest even though its *name* did not.
        engine: `${engine.name}@${engine.version}`,
        // Folding the identity algorithm in makes "the derived ids would come out
        // different now" self-correcting: the anchor misses by itself and the full
        // path runs. Without this the anchor keeps hitting and the new algorithm
        // never reaches the database.
        identityAlgorithm: identityAlgorithmFingerprint()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Payload identity unavailable for ${job.id}: ${message}\n`);
      return null;
    }
  }

  /**
   * Decides whether this import can be answered without touching the database's
   * bulk. Returns `null` — always the safe answer — unless every one of the
   * following holds:
   *
   * 1. The payload does not declare absence-as-deletion. A deleting payload
   *    (complete snapshot) that is replayed after *another* source imported would
   *    remove that other source's rows, so identical bytes are not a no-op.
   * 2. The database carries an anchor, and the `dataset_version` it carries now is
   *    still the one the anchor was recorded against. This is what catches "another
   *    import happened in between" — including a deletion-only sync that removed a
   *    row this payload still carries and would therefore resurrect.
   * 3. The payload's identity equals the anchor's.
   *
   * Note on `createCurrentBackup`: that step also runs `PRAGMA quick_check`, and a
   * hit here skips it. That is deliberate, not an oversight — the check exists to
   * gate a *write* ("do not build a new database on top of a corrupt one"), and this
   * path performs no write and produces no backup. A real import still runs it, and
   * a structurally unreadable database fails step 2 and takes the full path anyway.
   */
  private async detectUnchangedPayload(
    job: MutableImportJob,
    engine: ImportExecutionEngine
  ): Promise<PayloadPreflight | null> {
    if (job.preserveAbsent !== true) return null;
    const identity = readDatabaseImportIdentity(this.databasePath);
    if (!identity?.anchor || identity.datasetVersion === null) return null;
    if (identity.datasetVersion !== identity.anchor.datasetVersion) return null;
    const sha256 = await this.payloadSha256(job, engine);
    if (sha256 === null || sha256 !== identity.anchor.sha256) return null;
    return {
      sha256,
      datasetVersion: identity.datasetVersion,
      unchangedWorkouts: this.countTrainingSessions()
    };
  }

  /** Sessions in the live database; `0` when it cannot be read, never a thrown error. */
  private countTrainingSessions(): number {
    try {
      return this.countRows(this.databasePath, "training_sessions");
    } catch {
      return 0;
    }
  }

  /**
   * Records the payload identity for the database that is about to become live.
   *
   * Best-effort by design: the anchor is an optimisation, so a failure to write it
   * must not fail an import that has already succeeded. It is logged rather than
   * swallowed so that a persistently failing anchor stays visible.
   */
  private recordPayloadAnchor(databasePath: string, sha256: string | null): void {
    if (sha256 === null) return;
    const datasetVersion = readDatasetVersion(databasePath);
    if (datasetVersion === null) return;
    try {
      writeImportPayloadAnchor(databasePath, { sha256, datasetVersion });
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Recording the payload anchor failed: ${message}\n`);
    }
  }

  private analyzeInThread(staging: string, previous: string, job: MutableImportJob): Promise<ImportDatasetChange> {
    this.assertNotClosing();
    return new Promise((resolveResult, reject) => {
      const thread = new Worker(new URL("./import-analysis-bootstrap.mjs", import.meta.url), {
        workerData: { staging, previous, batchId: job.id, preserveAbsent: job.preserveAbsent }
      });
      this.activeAnalysis = thread;
      let result: ImportDatasetChange | undefined;
      thread.once("message", (value: ImportDatasetChange) => { result = value; });
      thread.once("error", reject);
      thread.once("exit", (code) => {
        if (this.activeAnalysis === thread) this.activeAnalysis = null;
        if (code === 0 && result) resolveResult(result);
        else reject(new Error("Import change analysis interrupted"));
      });
    });
  }

  private async createCurrentBackup(jobId: string, timing?: ImportPerformanceTracker): Promise<string | null> {
    if (!existsSync(this.databasePath)) return null;
    const backupDirectory = resolve(this.runtimeRoot, "var/backups");
    await mkdir(backupDirectory, { recursive: true });
    const maintenance = new DatabaseMaintenance(
      this.databasePath,
      this.runtimeRoot,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      backupPolicyFromEnvironment()
    );
    // 🔴 顺序：`ensureBackupCapacity` → `backup` → `quick_check`。
    // `backup()` 会按页顺序把这份 506 MB 的库读一遍，页缓存因此变热，紧随其后的
    // `PRAGMA quick_check` 就从**冷态**掉到**热态**（云机真机受控实测，drop_caches 造冷：
    // qc 冷 11,993 ms / 顺序读全库 1,201 ms / 随后 qc 热 260 ms）。
    // 旧顺序是「先 qc 再 backup」，等于让这次唯一的全库扫描白付冷态的钱。
    // 先例见 `maintenance.ts:213-217`（`deleteDatabase` 同样是先 `createBackup`、失败才判可读性）。
    // 🔴 判定精度**没有**放宽：用的还是同一个 `quick_check`，只是挪到备份之后跑；
    // 发布时机也不变 —— 它没通过时 `stagingBackupPath` 直接丢弃，绝不 rename 成正式名。
    await this.measureStage(timing, "backupCapacity", () => maintenance.ensureBackupCapacity());
    const backupPath = resolve(backupDirectory, `rai.before-web-import.${jobId}.sqlite`);
    const stagingBackupPath = `${backupPath}.partial-${randomUUID()}`;
    const currentDatabase = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      try {
        await this.measureStage(timing, "backupCopy", () => this.backupDatabase(currentDatabase, stagingBackupPath));
      } catch (error) {
        // 备份失败之后才知道「是不是主库坏了」：能读 ⇒ 失败来自环境（盘满 / 权限 / EIO），
        // 清掉残片后原样上抛；不能读 ⇒ 备份失败是预期结果，改走隔离。
        if (await this.verifyBackupSource(stagingBackupPath, timing)) {
          await this.attachCleanupFailure(stagingBackupPath, error);
          throw error;
        }
        return await this.quarantineCorruptDatabase(jobId, maintenance, stagingBackupPath);
      }
      // 副本已写完但尚未发布。主库真损坏时（坏页没被 `backup()` 读到，例如落在 freelist），
      // 由这一步拦下：丢弃刚写好的副本、改走隔离，正式备份名从此不会出现。
      if (!(await this.verifyBackupSource(stagingBackupPath, timing))) {
        return await this.quarantineCorruptDatabase(jobId, maintenance, stagingBackupPath);
      }
      try {
        await rename(stagingBackupPath, backupPath);
      } catch (error) {
        await this.attachCleanupFailure(stagingBackupPath, error);
        throw error;
      }
    } finally {
      currentDatabase.close();
    }
    try {
      // 保留策略清理与开头的容量检查同属「容量管理」，合并记在 `backupCapacity`：
      // 两段在时间上互斥，命名相同只会让该值等于两者之和，**不会**重复计时（Σ 仍 ≤ totalMs）。
      await this.measureStage(timing, "backupCapacity", () => maintenance.enforceBackupPolicy(basename(backupPath)));
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Import backup retention cleanup failed after backup was published: ${message}\n`);
    }
    return backupPath;
  }

  private async verifyBackupSource(partialPath: string, timing?: ImportPerformanceTracker): Promise<boolean> {
    try {
      return await this.measureStage(timing, "backupVerify", () => this.isReadableDatabase(this.databasePath));
    } catch (error) {
      // A terminated verifier is not proof of corruption. Fail the attempt,
      // reclaim its partial backup, but never quarantine a healthy live DB.
      await this.attachCleanupFailure(partialPath, error);
      throw error;
    }
  }

  /**
   * 可选阶段计时。`activateDatabase` 的兜底路径（`existingBackupPath === undefined`）没有 tracker，
   * 那时直接执行、不落账。⚠️ 各阶段名的**时间区间必须互斥**：
   * `worker.test.ts` 断言 `totalMs >= ΣstagesMs`，重叠会让那条断言失去意义。
   */
  private async measureStage<T>(
    timing: ImportPerformanceTracker | undefined,
    stage: ImportStage,
    operation: () => T | Promise<T>
  ): Promise<T> {
    return timing ? await timing.measure(stage, operation) : await operation();
  }

  private async backupDatabase(database: DatabaseSync, destination: string): Promise<void> {
    await backup(database, destination);
  }

  /**
   * 主库确认损坏时统一走这条路：丢掉这次写了一半或刚写好的备份副本、上报一次数据库错误、
   * 再把损坏的主库整体保留到 `var/quarantine/`。
   * 返回 `null` 让调用方退回「全新导入」分支（不做增量同步，CLI 走 `--replace`）。
   */
  private async quarantineCorruptDatabase(
    jobId: string,
    maintenance: DatabaseMaintenance,
    partialBackupPath: string
  ): Promise<null> {
    try {
      await this.cleanupPartialBackup(partialBackupPath);
    } catch (cleanupError) {
      // 清不掉残片不能挡住隔离 —— 隔离才是这条路径的目的。残片不以 `.sqlite` 结尾，
      // 不会被任何保留策略当成正式备份，所以这里降级成一行 stderr 即可。
      const message = cleanupError instanceof Error ? cleanupError.stack ?? cleanupError.message : String(cleanupError);
      process.stderr.write(`Discarding the partial import backup of a corrupt database failed: ${message}\n`);
    }
    this.onDatabaseError(new Error("Main database is corrupt or failed its integrity check"));
    await maintenance.preserveCorruptDatabase(`before-web-import-${jobId}-corrupt`);
    return null;
  }

  /**
   * 备份失败时清掉残片，并把清理错误挂到原始错误上 —— 主因始终是备份失败本身。
   */
  private async attachCleanupFailure(path: string, error: unknown): Promise<void> {
    try {
      await this.cleanupPartialBackup(path);
    } catch (cleanupError) {
      if (error && typeof error === "object") {
        try {
          (error as { cleanupError?: unknown }).cleanupError = cleanupError;
        } catch { /* Preserve the original backup error even when it is immutable. */ }
      }
    }
  }

  private async cleanupPartialBackup(path: string): Promise<void> {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.removePartialBackupFile(path);
        return;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (!["EBUSY", "EPERM", "EACCES"].includes(code) || attempt === attempts) throw error;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
  }

  private async removePartialBackupFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  private preserveHistoricalState(stagingDatabase: string, previousDatabase: string): void {
    const database = new DatabaseSync(stagingDatabase);
    applyBusyTimeout(database);
    let attached = false;
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.prepare("ATTACH DATABASE ? AS previous").run(previousDatabase);
      attached = true;
      database.exec("BEGIN IMMEDIATE");
      this.stabilizeTrainingSessionIds(database);
      const activeAbilityBaselineHash = currentAbilityBaselineHash(database);
      const previousPredictionColumns = new Set(
        (database.prepare("PRAGMA previous.table_info(prediction_model_runs)").all() as Array<{ name: string }>)
          .map((column) => column.name)
      );
      // v24 的列：`previous` 可能是 v23 及更早的库，直接引用新列会 SQL 报错，
      // 所以先按旧列集拷贝，再在源库确实有该列时回填（加法式，不改既有语句）。
      const previousSnapshotHasEpoch = new Set(
        (database.prepare("PRAGMA previous.table_info(daily_ability_snapshots)").all() as Array<{ name: string }>)
          .map((column) => column.name)
      ).has("baseline_epoch_id");
      database.exec(`
        INSERT OR IGNORE INTO feature_runs
        SELECT * FROM previous.feature_runs;

        INSERT OR IGNORE INTO workout_overrides (
          id, training_session_id, revision, eligibility_override, session_type,
          rpe, condition_tags_json, note, created_at, performance_protocol,
          statistics_participation
        )
        SELECT
          historical.id,
          historical.training_session_id,
          historical.revision,
          historical.eligibility_override,
          historical.session_type,
          historical.rpe,
          historical.condition_tags_json,
          historical.note,
          historical.created_at,
          historical.performance_protocol,
          historical.statistics_participation
        FROM previous.workout_overrides historical
        WHERE EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        );

        INSERT OR IGNORE INTO workout_features
        SELECT historical.*
        FROM previous.workout_features historical
        WHERE EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        );

        INSERT OR IGNORE INTO model_runs
        SELECT historical.*
        FROM previous.model_runs historical
        WHERE EXISTS (
          SELECT 1 FROM feature_runs current_feature_run
          WHERE current_feature_run.id = historical.feature_run_id
        ) AND (
          SELECT COUNT(*) FROM previous.workout_features previous_feature
          WHERE previous_feature.feature_run_id = historical.feature_run_id
        ) = (
          SELECT COUNT(*) FROM workout_features current_feature
          WHERE current_feature.feature_run_id = historical.feature_run_id
        );

        INSERT OR IGNORE INTO ability_assessments
        SELECT historical.*
        FROM previous.ability_assessments historical
        WHERE EXISTS (
          SELECT 1 FROM model_runs current_model
          WHERE current_model.id = historical.model_run_id
        ) AND EXISTS (
          SELECT 1 FROM workout_features current_feature
          WHERE current_feature.id = historical.feature_id
        ) AND EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        );

        INSERT OR IGNORE INTO daily_ability_snapshots (
          id, model_run_id, local_date, timezone_identifier, true_ability,
          decay_points, growth_velocity_per_week, last_assessment_id,
          snapshot_status, computed_at
        )
        SELECT
          historical.id,
          historical.model_run_id,
          historical.local_date,
          historical.timezone_identifier,
          historical.true_ability,
          historical.decay_points,
          historical.growth_velocity_per_week,
          CASE
            WHEN historical.last_assessment_id IS NULL THEN NULL
            WHEN EXISTS (
              SELECT 1 FROM ability_assessments current_assessment
              WHERE current_assessment.id = historical.last_assessment_id
            ) THEN historical.last_assessment_id
            ELSE NULL
          END,
          historical.snapshot_status,
          historical.computed_at
        FROM previous.daily_ability_snapshots historical
        WHERE EXISTS (
          SELECT 1 FROM model_runs current_model
          WHERE current_model.id = historical.model_run_id
        );

        ${previousSnapshotHasEpoch ? `
        UPDATE daily_ability_snapshots SET baseline_epoch_id = (
          SELECT historical.baseline_epoch_id FROM previous.daily_ability_snapshots historical
          WHERE historical.id = daily_ability_snapshots.id
        )
        WHERE baseline_epoch_id IS NULL
          AND EXISTS (
            SELECT 1 FROM previous.daily_ability_snapshots historical
            WHERE historical.id = daily_ability_snapshots.id
              AND historical.baseline_epoch_id IS NOT NULL
          );` : ""}

        INSERT OR IGNORE INTO training_metric_runs
        SELECT historical.*
        FROM previous.training_metric_runs historical
        WHERE EXISTS (
          SELECT 1 FROM model_runs current_model
          WHERE current_model.id = historical.model_run_id
        );

        INSERT OR IGNORE INTO training_zone_profile_settings
        SELECT historical.*
        FROM previous.training_zone_profile_settings historical;

        INSERT OR IGNORE INTO daily_zone_profiles
        SELECT historical.*
        FROM previous.daily_zone_profiles historical
        WHERE EXISTS (
          SELECT 1 FROM training_metric_runs current_metric_run
          WHERE current_metric_run.id = historical.training_metric_run_id
        );

        INSERT OR IGNORE INTO workout_training_loads
        SELECT historical.*
        FROM previous.workout_training_loads historical
        WHERE EXISTS (
          SELECT 1 FROM training_metric_runs current_metric_run
          WHERE current_metric_run.id = historical.training_metric_run_id
        ) AND EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        ) AND (
          historical.feature_id IS NULL OR EXISTS (
            SELECT 1 FROM workout_features current_feature
            WHERE current_feature.id = historical.feature_id
          )
        );

        INSERT OR IGNORE INTO daily_training_metrics
        SELECT historical.*
        FROM previous.daily_training_metrics historical
        WHERE EXISTS (
          SELECT 1 FROM training_metric_runs current_metric_run
          WHERE current_metric_run.id = historical.training_metric_run_id
        );

        INSERT OR IGNORE INTO workout_zone_summaries
        SELECT historical.*
        FROM previous.workout_zone_summaries historical
        WHERE EXISTS (
          SELECT 1 FROM training_metric_runs current_metric_run
          WHERE current_metric_run.id = historical.training_metric_run_id
        ) AND EXISTS (
          SELECT 1 FROM training_sessions current_session
          WHERE current_session.id = historical.training_session_id
        ) AND EXISTS (
          SELECT 1 FROM workout_features current_feature
          WHERE current_feature.id = historical.feature_id
        ) AND EXISTS (
          SELECT 1 FROM daily_zone_profiles current_profile
          WHERE current_profile.id = historical.zone_profile_id
        );

        INSERT OR IGNORE INTO recompute_jobs
        SELECT historical.*
        FROM previous.recompute_jobs historical
        WHERE historical.status IN ('succeeded', 'failed', 'cancelled')
          AND (historical.feature_run_id IS NULL OR EXISTS (
            SELECT 1 FROM feature_runs current_feature_run
            WHERE current_feature_run.id = historical.feature_run_id
          ))
          AND (historical.model_run_id IS NULL OR EXISTS (
            SELECT 1 FROM model_runs current_model
            WHERE current_model.id = historical.model_run_id
          ));

        INSERT OR IGNORE INTO recompute_job_events
        SELECT historical.*
        FROM previous.recompute_job_events historical
        WHERE EXISTS (
          SELECT 1 FROM recompute_jobs current_job
          WHERE current_job.id = historical.job_id
        );

      `);
      database.exec(`
        INSERT OR IGNORE INTO prediction_model_runs (
          id, algorithm, model_version, feature_schema_version, feature_schema_hash,
          training_data_hash, training_data_through_at, hyperparameters_json, request_json,
          status, label_count, label_count_by_distance_json, holdout_prediction_count,
          metrics_json, supported_distances_json, artifact_path, artifact_sha256,
          cancel_requested, failure_json, created_at, started_at, completed_at, activated_at,
          worker_token, heartbeat_at, attempt_count, ability_baseline_hash
        )
        SELECT
          historical.id, historical.algorithm, historical.model_version,
          historical.feature_schema_version, historical.feature_schema_hash,
          historical.training_data_hash, historical.training_data_through_at,
          historical.hyperparameters_json, historical.request_json, historical.status,
          historical.label_count, historical.label_count_by_distance_json,
          historical.holdout_prediction_count, historical.metrics_json,
          historical.supported_distances_json, historical.artifact_path,
          historical.artifact_sha256, historical.cancel_requested, historical.failure_json,
          historical.created_at, historical.started_at, historical.completed_at,
          historical.activated_at, historical.worker_token, historical.heartbeat_at,
          historical.attempt_count,
          ${previousPredictionColumns.has("ability_baseline_hash") ? "historical.ability_baseline_hash" : "NULL"}
        FROM previous.prediction_model_runs historical
        WHERE historical.status IN ('succeeded', 'rejected', 'failed', 'cancelled');

        INSERT OR IGNORE INTO prediction_model_events
        SELECT historical.*
        FROM previous.prediction_model_events historical
        WHERE EXISTS (
          SELECT 1 FROM prediction_model_runs current_run
          WHERE current_run.id = historical.prediction_model_run_id
        );
      `);
      if (previousPredictionColumns.has("ability_baseline_hash")) {
        database.prepare(`
          INSERT OR REPLACE INTO active_prediction_model
          SELECT historical.*
          FROM previous.active_prediction_model historical
          JOIN previous.prediction_model_runs historical_run
            ON historical_run.id = historical.prediction_model_run_id
          JOIN prediction_model_runs current_run
            ON current_run.id = historical.prediction_model_run_id
          WHERE current_run.status = 'succeeded'
            AND historical_run.ability_baseline_hash IS NOT NULL
            AND historical_run.ability_baseline_hash = ?
            AND current_run.ability_baseline_hash = ?
        `).run(activeAbilityBaselineHash, activeAbilityBaselineHash);
      }
      const violations = database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error("历史派生数据迁移后外键校验失败");
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* No active transaction. */ }
      throw error;
    } finally {
      if (attached) {
        try { database.exec("DETACH DATABASE previous"); } catch { /* Database is closing. */ }
      }
      database.close();
    }
  }

  activeInputPaths(excludingJobId?: string): string[] {
    return [...this.jobs.values()]
      .filter((job) => job.id !== excludingJobId)
      .filter((job) => ["queued", "running"].includes(job.status) || Boolean(job.queue && !job.queue.finalized))
      .map((job) => job.inputPath);
  }

  async reclaimAbandonedNativeSpools(now = Date.now()): Promise<number> {
    const root = resolve(this.runtimeRoot, "var");
    if (!existsSync(root)) return 0;
    const protectedIds = [...this.jobs.values()].filter((job) =>
      ["queued", "running"].includes(job.status) || job === this.activeJob).map((job) => job.id);
    let removed = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^native\.web_import_[a-z0-9]+_[a-f0-9-]{36}(?:\.attempt-\d+)?$/i.test(entry.name)) continue;
      if (protectedIds.some((id) => entry.name === `native.${id}` || entry.name.startsWith(`native.${id}.attempt-`))) continue;
      const path = resolve(root, entry.name);
      if (now - statSync(path).mtimeMs < 24 * 60 * 60_000) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  private stabilizeTrainingSessionIds(database: DatabaseSync): void {
    type SessionIdentityRow = {
      id: string;
      activityType: string;
      anchorStartAt: string;
      anchorEndAt: string;
      anchorDistanceKm: number | null;
    };
    const current = database.prepare(`
      SELECT id, activity_type AS activityType, anchor_start_at AS anchorStartAt,
        anchor_end_at AS anchorEndAt, anchor_distance_km AS anchorDistanceKm
      FROM training_sessions ORDER BY anchor_start_at
    `).all() as unknown as SessionIdentityRow[];
    const previous = database.prepare(`
      SELECT id, activity_type AS activityType, anchor_start_at AS anchorStartAt,
        anchor_end_at AS anchorEndAt, anchor_distance_km AS anchorDistanceKm
      FROM previous.training_sessions WHERE status <> 'inactive' ORDER BY anchor_start_at
    `).all() as unknown as SessionIdentityRow[];
    const currentIds = new Set(current.map((session) => session.id));
    const previousIds = new Set(previous.map((session) => session.id));
    const usedPreviousIds = new Set(current.filter((session) => previousIds.has(session.id)).map((session) => session.id));
    const matches = (candidate: SessionIdentityRow, historical: SessionIdentityRow): boolean => {
      if (candidate.activityType !== historical.activityType) return false;
      const candidateStart = Date.parse(candidate.anchorStartAt);
      const candidateEnd = Date.parse(candidate.anchorEndAt);
      const historicalStart = Date.parse(historical.anchorStartAt);
      const historicalEnd = Date.parse(historical.anchorEndAt);
      if (![candidateStart, candidateEnd, historicalStart, historicalEnd].every(Number.isFinite)) return false;
      if (Math.abs(candidateStart - historicalStart) > 120_000) return false;
      const overlap = Math.max(0, Math.min(candidateEnd, historicalEnd) - Math.max(candidateStart, historicalStart));
      const shorterDuration = Math.max(1, Math.min(candidateEnd - candidateStart, historicalEnd - historicalStart));
      if (overlap / shorterDuration < 0.85) return false;
      if (candidate.anchorDistanceKm !== null && historical.anchorDistanceKm !== null) {
        const tolerance = Math.max(0.2, 0.03 * Math.max(candidate.anchorDistanceKm, historical.anchorDistanceKm));
        return Math.abs(candidate.anchorDistanceKm - historical.anchorDistanceKm) <= tolerance;
      }
      return Math.abs((candidateEnd - candidateStart) - (historicalEnd - historicalStart)) <= Math.max(
        120_000,
        0.05 * Math.max(candidateEnd - candidateStart, historicalEnd - historicalStart)
      );
    };
    const insertSession = database.prepare(`
      INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status, created_at, updated_at
      )
      SELECT ?, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status, created_at, updated_at
      FROM training_sessions WHERE id = ?
    `);
    const groupIds = database.prepare(
      "SELECT id FROM workout_groups WHERE training_session_id = ?"
    );
    const clearGroups = database.prepare(
      "UPDATE workout_groups SET training_session_id = NULL WHERE training_session_id = ?"
    );
    const restoreGroup = database.prepare(
      "UPDATE workout_groups SET training_session_id = ? WHERE id = ?"
    );
    const removeSession = database.prepare("DELETE FROM training_sessions WHERE id = ?");
    const insertIssue = database.prepare(`
      INSERT INTO import_issues (severity, code, object_id, message)
      VALUES ('warning', 'AMBIGUOUS_TRAINING_SESSION_MATCH', ?, ?)
    `);
    for (const session of current) {
      if (previous.some((historical) => historical.id === session.id)) {
        usedPreviousIds.add(session.id);
        continue;
      }
      const candidates = previous.filter(
        (historical) => !usedPreviousIds.has(historical.id) && !currentIds.has(historical.id) && matches(session, historical)
      );
      if (candidates.length > 1) {
        insertIssue.run(session.id, "Imported training session matched more than one historical session; identity was not changed.");
        continue;
      }
      const historical = candidates[0];
      if (!historical) continue;
      const groups = groupIds.all(session.id) as unknown as Array<{ id: string }>;
      clearGroups.run(session.id);
      insertSession.run(historical.id, session.id);
      for (const group of groups) restoreGroup.run(historical.id, group.id);
      removeSession.run(session.id);
      usedPreviousIds.add(historical.id);
    }
  }

  private async activateDatabase(
    stagingDatabase: string,
    jobId: string,
    existingBackupPath?: string | null,
    beforeCommit: () => void | Promise<void> = () => {},
  ): Promise<void> {
    if (!existsSync(stagingDatabase)) throw new Error("临时数据库未生成");
    // undefined means activation owns the backup step; null means the caller
    // already handled the active database and no usable backup was produced.
    const backupPath = existingBackupPath === undefined
      ? await this.createCurrentBackup(jobId)
      : existingBackupPath;
    const rollbackDirectory = resolve(this.runtimeRoot, "var/backups");
    const rollbackPath = resolve(rollbackDirectory, `rai.import-rollback.${randomUUID()}.sqlite`);
    await mkdir(rollbackDirectory, { recursive: true });
    this.assertNotClosing();
    let gateEntered = false;
    try {
      await this.beforeActivate();
      gateEntered = true;
    } catch (error) {
      throw error;
    }

    const originalExisted = existsSync(this.databasePath);
    // 这里原本是 `isReadableDatabase`（一次 506 MB 的全库 `PRAGMA quick_check`，真机冷态
    // 实测 12.1 s）。而在同一轮导入的 `createCurrentBackup` 里，对这份主库已经跑过一次；
    // 且它的结果只用来决定「要不要 checkpoint」与回滚路径判断，不需要逐页校验。
    // 发布后的那道强校验（`installDatabase` 之后的 `isReadableDatabase`）保持不动，
    // 页内损坏仍会在那里被拦下并触发回滚。
    const originalReadable = originalExisted && isStructurallyReadable(this.databasePath);
    if (originalExisted && !originalReadable) {
      this.onDatabaseError(new Error("Main database is corrupt or failed its integrity check"));
    }
    let originalMoved = false;
    let committed = false;
    let commitBoundaryEntered = false;
    try {
      this.publicationJournal?.prepare(jobId, rollbackPath, originalExisted);
      this.assertNotClosing();
      if (originalExisted) {
        if (originalReadable) await this.checkpointDatabase(this.databasePath, "activation_checkpoint");
        await this.removeDatabaseSidecarsWithRetry(this.databasePath);
        await this.moveDatabaseFile(this.databasePath, rollbackPath);
        originalMoved = true;
      }
      this.assertNotClosing();
      await mkdir(dirname(this.databasePath), { recursive: true });
      await this.installDatabase(stagingDatabase, this.databasePath);
      if (!(await this.isReadableDatabase(this.databasePath, "activation_verify"))) {
        throw new Error("Imported database is not readable after activation");
      }
      commitBoundaryEntered = true;
      await beforeCommit();
      this.publicationJournal?.commit(jobId);
      await this.releaseActivateGate();
      gateEntered = false;
      committed = true;
    } catch (error) {
      const errors: unknown[] = [error];
      if (originalMoved) {
        errors.push(...await this.restoreImportDatabase(rollbackPath, backupPath));
      } else if (!originalExisted && commitBoundaryEntered) {
        try {
          await this.checkpointDatabase(this.databasePath);
          await this.removeDatabaseSidecarsWithRetry(this.databasePath);
          await this.removeDatabaseFileWithRetry(this.databasePath);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      const activeReadable = await this.isReadableDatabase(this.databasePath);
      if (gateEntered && (activeReadable || (originalExisted && !originalReadable && existsSync(this.databasePath)))) {
        try {
          await this.releaseActivateGate();
          gateEntered = false;
        } catch (releaseError) {
          errors.push(releaseError);
        }
      }
      // Only forget intent if rollback demonstrably completed.
      if (this.publicationJournal && errors.length === 1) {
        const rollbackConfirmed = originalExisted
          ? activeReadable && !readImportReceipt(this.databasePath, jobId)
          : !existsSync(this.databasePath);
        if (rollbackConfirmed) this.publicationJournal.clear(jobId);
      }
      throw errors.length === 1
        ? error
        : new AggregateError(errors, "Import activation failed and required recovery actions also failed");
    } finally {
      if (committed && originalMoved) {
        // The rollback point is a full copy of the database and it lives in
        // `var/backups/`, so leaving it behind wastes a whole database's worth of
        // space and counts against `enforceBackupPolicy`, squeezing out real
        // backups. A locked file (EBUSY/EPERM) is not worth failing a committed
        // import over, but it must not be silent either.
        try {
          await this.removeDatabaseFileWithRetry(rollbackPath);
        } catch (cleanupError) {
          const message = cleanupError instanceof Error
            ? cleanupError.stack ?? cleanupError.message
            : String(cleanupError);
          process.stderr.write(`Failed to remove the import rollback point after commit: ${message}\n`);
        }
      }
    }
  }

  private async restoreImportDatabase(rollbackPath: string, backupPath: string | null): Promise<unknown[]> {
    const errors: unknown[] = [];
    const activeExists = existsSync(this.databasePath);
    const activeReadable = activeExists && await this.isReadableDatabase(this.databasePath);
    if (activeReadable) {
      try {
        await this.checkpointDatabase(this.databasePath);
        await this.removeDatabaseSidecarsWithRetry(this.databasePath);
        await this.moveDatabaseFile(rollbackPath, this.databasePath);
      } catch (error) {
        errors.push(error);
      }
    } else {
      if (activeExists) {
        try {
          try { await this.checkpointDatabase(this.databasePath); } catch { /* Candidate is already unreadable. */ }
          await this.removeDatabaseSidecarsWithRetry(this.databasePath);
          await this.removeDatabaseFileWithRetry(this.databasePath);
        } catch (error) {
          errors.push(error);
        }
      }
      if (!existsSync(this.databasePath)) {
        try {
          await this.moveDatabaseFile(rollbackPath, this.databasePath);
        } catch (rollbackError) {
          errors.push(rollbackError);
          if (backupPath && existsSync(backupPath)) {
            errors.push(...await this.restoreOnlineBackup(backupPath));
          }
        }
      }
    }
    if (!(await this.isReadableDatabase(this.databasePath))) {
      errors.push(new Error("Import rollback did not restore a readable active database"));
    }
    return errors;
  }

  private async restoreOnlineBackup(backupPath: string): Promise<unknown[]> {
    const errors: unknown[] = [];
    const stagingPath = `${this.databasePath}.import-backup-restore.${randomUUID()}`;
    let installed = false;
    try {
      await this.copyDatabaseFile(backupPath, stagingPath);
      if (!(await this.isReadableDatabase(stagingPath))) {
        throw new Error("Online import backup is not readable before restoration");
      }
      await this.moveDatabaseFile(stagingPath, this.databasePath);
      if (!(await this.isReadableDatabase(this.databasePath))) {
        throw new Error("Online import backup is not readable after restoration");
      }
      installed = true;
    } catch (error) {
      errors.push(error);
      for (const candidate of [
        `${this.databasePath}-shm`,
        `${this.databasePath}-wal`,
        this.databasePath
      ]) {
        try {
          await this.removeDatabaseFileWithRetry(candidate);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
    } finally {
      for (const candidate of [stagingPath, `${stagingPath}-shm`, `${stagingPath}-wal`]) {
        try {
          await this.removeDatabaseFileWithRetry(candidate);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
    }
    if (!installed && existsSync(this.databasePath)) {
      errors.push(new Error("Failed online import backup restoration exposed an active database file"));
    }
    return errors;
  }

  private checkpointDatabase(path: string, stage = "database_checkpoint"): Promise<void> {
    return this.databaseTask<void>({ operation: "checkpoint", path }, stage);
  }

  private isReadableDatabase(path: string, stage = "database_quick_check"): Promise<boolean> {
    if (!existsSync(path)) return Promise.resolve(false);
    return this.databaseTask<boolean>({ operation: "verify", path }, stage);
  }

  private async releaseActivateGate(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.afterActivate();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    throw lastError;
  }

  private async removeDatabaseSidecarsWithRetry(path: string): Promise<void> {
    await this.removeDatabaseFileWithRetry(`${path}-shm`);
    await this.removeDatabaseFileWithRetry(`${path}-wal`);
  }

  private async removeDatabaseFileWithRetry(path: string): Promise<void> {
    const attempts = 20;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.removeDatabaseFile(path);
        return;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (!["EBUSY", "EPERM", "EACCES"].includes(code) || attempt === attempts) throw error;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
  }

  private async installDatabase(source: string, destination: string): Promise<void> {
    await rename(source, destination);
  }

  private async moveDatabaseFile(source: string, destination: string): Promise<void> {
    await rename(source, destination);
  }

  private async copyDatabaseFile(source: string, destination: string): Promise<void> {
    await copyFile(source, destination);
  }

  private async removeDatabaseFile(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  private async removeDatabaseFiles(path: string): Promise<void> {
    for (const candidate of [path, `${path}-shm`, `${path}-wal`]) {
      await rm(candidate, { force: true });
    }
  }

  /**
   * Reclaims the rename-aside rollback points the CLI produced for this import
   * (`<stagingDatabase>.replaced.<uuid>`).
   *
   * `packages/health-export-parser/src/cli.ts` intentionally retains the displaced
   * database, and the worker cannot unilaterally revoke that contract. But this
   * worker already wrote `var/backups/rai.before-web-import.<jobId>.sqlite` before
   * the import started, so its own rollback point is redundant once the import has
   * committed. Leaving it behind costs a full database copy per web import
   * (2026-09-15: 89 files / 36 GB accumulated online, taking a 50 GB disk to 98%).
   */
  private async reclaimDisplacedImportDatabases(stagingDatabase: string): Promise<void> {
    const directory = dirname(stagingDatabase);
    if (!existsSync(directory)) return;
    const prefix = `${basename(stagingDatabase)}.replaced.`;
    const names = (await readdir(directory)).filter((name) => name.startsWith(prefix));
    await Promise.all(names.map((name) => this.removeDatabaseFiles(resolve(directory, name))));
  }

  private command(args: string[]): Promise<void> {
    if (this.closing) return Promise.reject(new Error("Import worker is shutting down"));
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: this.projectRoot,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      });
      this.activeChild = child;
      if (this.closing) void terminateProcessTree(child).catch(reject);
      // Drain BOTH pipes, including successful commands. Keeping only bounded
      // tails prevents a large export from filling a pipe or the API heap.
      const outputLimit = 16_384;
      let errorOutput = "";
      let standardOutput = "";
      let removalGuard: ImportRemovalGuardError | null = null;
      child.on("message", (message: unknown) => {
        if (typeof message === "object" && message !== null) {
          const failure = message as { type?: unknown; code?: unknown };
          // 刻意保留的**语义判定表**（不是过滤名单）：哪些 code 意味着"引擎不可用、必须拦住回退"。
          if (failure.type === "rai:native-failure" && typeof failure.code === "string" &&
              ["unavailable", "invalid_protocol"].includes(failure.code)) this.nativeFailure = failure.code;
          // 白名单已移除：operation 名走格式校验（见 `parseNativeEngineMessage` 的文档）。
          const nativeMetric = parseNativeEngineMessage(message);
          if (nativeMetric) {
            const previous = this.nativeStats[nativeMetric.operation] ?? { rustCalls: 0, typescriptFallbacks: 0, wallMs: 0, peakRssKiB: 0 };
            if (nativeMetric.actual === "rust") previous.rustCalls++; else previous.typescriptFallbacks++;
            previous.wallMs += nativeMetric.durationMs;
            if (nativeMetric.peakRssKiB !== null) previous.peakRssKiB = Math.max(previous.peakRssKiB, nativeMetric.peakRssKiB);
            this.nativeStats[nativeMetric.operation] = previous;
          }
        }
        // 白名单已移除：stage 名走格式校验（见 `parseComputeStageMessage` 的文档）。
        const computeStage = parseComputeStageMessage(message);
        if (computeStage) {
          this.computeStagesMs[computeStage.stage] = (this.computeStagesMs[computeStage.stage] ?? 0) + computeStage.durationMs;
          if (computeStage.processMaxRssKiB !== null) {
            this.computeProcessMaxRssKiB = Math.max(this.computeProcessMaxRssKiB, computeStage.processMaxRssKiB);
          }
        }
        if (ImportRemovalGuardError.fromPayload(message)) {
          removalGuard = ImportRemovalGuardError.fromPayload(message) ?? removalGuard;
          // Acknowledge receipt before the child disconnects so the guard
          // cannot be lost between IPC delivery and the close event.
          if (child.connected) child.send({ type: "rai:removal-guard-ack" });
        }
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        standardOutput = `${standardOutput}${chunk}`.slice(-outputLimit);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        errorOutput = `${errorOutput}${chunk}`.slice(-outputLimit);
      });
      child.on("error", (error) => {
        if (this.activeChild === child) this.activeChild = null;
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (this.activeChild === child) this.activeChild = null;
        if (code === 0) resolvePromise();
        else reject(removalGuard ?? new Error([
          `Import subprocess failed (code=${String(code)}, signal=${signal ?? "none"})`,
          ...(errorOutput.trim() ? [`stderr:\n${errorOutput.trim()}`] : []),
          ...(standardOutput.trim() ? [`stdout:\n${standardOutput.trim()}`] : [])
        ].join("\n")));
      });
    });
  }

  private assertNotClosing(): void {
    if (this.closing) throw new Error("Import worker is shutting down");
    if (this.cancelRequested) throw new Error("Import cancelled");
  }

  private publicJob(job: MutableImportJob): ImportJobResponse {
    const removalGuard = job.status === "failed"
      ? ImportRemovalGuardError.fromPayload(job.removalGuard) : null;
    const publicError = job.error === null || job.error === undefined
      ? job.error
      : removalGuard?.userMessage ?? PUBLIC_IMPORT_FAILURE_ERROR;
    return {
      id: job.id,
      ...(job.queue?.engine ? { executionEngine: job.queue.engine } : {}),
      ...(job.sourceId === undefined ? {} : { sourceId: job.sourceId }),
      status: job.status,
      phase: job.phase,
      message: job.message,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: publicError
      // 稳定失败码**可以**进公开层（它是机器面，不是诊断）：iOS 据此拆批/退避/报维护（I4）。
      ,...(job.failureCode === undefined ? {} : { failureCode: job.failureCode })
      ,...(job.progress === undefined ? {} : { progress: job.progress })
      ,...(job.summary === undefined ? {} : { summary: job.summary })
      ,...(job.performance === undefined ? {} : { performance: job.performance })
      ,...(job.status === "queued" && job.queue ? {
        queuePosition: [...this.jobs.values()].filter((item) => ["queued", "running"].includes(item.status)).indexOf(job) + 1,
        waitingReason: "writer_busy" as const
      } : {})
    };
  }

  private loadJobs(): void {
    try {
      const parsed = this.state.jobs(20) as MutableImportJob[];
      for (const value of parsed) {
        if (!value || typeof value.id !== "string" || typeof value.inputPath !== "string") continue;
        if (this.publicationJournal?.rolledBackIds.has(value.id) && value.queue?.scope === this.queueOptions?.scope) {
          value.status = "queued";
        }
        const receipt = this.queueOptions && value.queue?.scope === this.queueOptions.scope
          ? readImportReceipt(this.databasePath, value.id) : null;
        if (receipt && ["queued", "running"].includes(value.status)) {
          value.status = "succeeded"; value.phase = "completed"; value.error = null;
          value.summary = receipt; value.completedAt = new Date().toISOString();
          value.message = "已恢复完成的导入";
        } else if (value.queue?.cancelRequested && ["queued", "running"].includes(value.status)) {
          value.status = "cancelled"; value.phase = "cancelled"; value.error = null;
          value.message = "导入已取消"; value.completedAt = new Date().toISOString();
        } else if (this.queueOptions && value.queue && ["queued", "running"].includes(value.status) &&
            value.queue.scope === this.queueOptions.scope && value.queue.attempts < 3) {
          value.status = "queued";
          value.phase = "queued";
          value.error = null;
          value.message = "正在恢复已接受的导入任务";
        } else if (["queued", "running"].includes(value.status)) {
          value.status = "failed";
          value.phase = "interrupted";
          value.message = "上次导入因本地服务重启而中断，可重新提交导入";
          value.error = PUBLIC_IMPORT_FAILURE_ERROR;
          value.completedAt = new Date().toISOString();
          if (value.queue && value.queue.scope !== this.queueOptions?.scope) value.queue.finalized = true;
        }
        this.jobs.set(value.id, value);
      }
      this.persistJobs();
    } catch (error) {
      if (this.queueOptions) throw error;
      // Corrupt task metadata must not block the local API or the health database.
    }
  }

  private persistJobs(): void {
    const all = [...this.jobs.values()];
    const jobs = [...new Set([...all.slice(-20), ...all.filter((job) =>
      ["queued", "running"].includes(job.status) || (job.queue && !job.queue.finalized))])];
    for (const { onTerminal: _onTerminal, ...job } of jobs) this.state.upsertJob(job);
  }
}
