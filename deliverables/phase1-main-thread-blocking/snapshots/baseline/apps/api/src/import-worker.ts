import { CONTRACT_VERSION, DATABASE_TIMEZONE } from "@rai/contracts";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { analyzeDatasetChange, type ImportDatasetChange } from "./import-dataset-analysis.js";
import { computeImportPayloadSha256, readDatabaseImportIdentity, readImportIdentityInDatabase } from "./import-payload-identity.js";

import type {
  ImportExecutionEngine, ImportJobPerformance, ImportJobResponse, ImportLaneRejection, ImportLaneTelemetry, ImportStage
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
import {
  databaseReadable, IMPORT_LANE_ATTEMPTS,
  type ImportDatabaseTask, type ImportLaneTimings, type ImportLanesOutcome,
  type IngestWorkerMessage, type IngestWorkerReadyMessage, type IngestWorkerReply
} from "./import-database-tasks.js";
import { type DirectSyncRejection } from "./direct-sync-ingest.js";
import { planDirectSyncLane } from "./direct-sync-plan.js";
import { resolvePreserveAbsent } from "./import-sources.js";
import { backupPolicyFromEnvironment, DatabaseMaintenance } from "./maintenance.js";
import { RuntimeStateStore } from "./runtime-state.js";

import { ImportPublicationJournal, readImportReceipt, writeImportReceipt, writeImportReceiptInDatabase } from "./import-publication.js";
import type { TaskAdmission } from "./task-admission.js";
import { waitForShutdown } from "./worker-process.js";

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

/**
 * 公开层白名单的**编译期穷尽守卫**（2026-10-15 审查 A2）：
 * `ImportJobPerformance` 新增字段而没登记到这里 ⇒ `tsc` 立刻失败，
 * 不会等到"键被 `publicPerformance` 静默丢弃"在线上发生。
 * 运行期对偶在 `worker.test.ts`（"全键保留 + 拷贝隔离"用例）。
 */
export const PUBLIC_PERFORMANCE_KEYS = {
  validationMode: true,
  totalMs: true,
  stagesMs: true,
  computeStagesMs: true,
  lane: true
} satisfies Record<keyof ImportJobPerformance, true>;

/**
 * 两条导入车道的**下发顺序**（WP-41 / O12 第一阶段：两条车道在同一个任务 Worker 内执行）。
 *
 * 🔴 为什么顺序是一份显式数据：`data-only` 的入口判据（记录白名单 + 基线合同戳）比统一
 * 接收器**更严**，必须先被尝试；反过来那两道闸门就失去意义。写死成 worker 里的语句顺序
 * 时，"顺序被改动"只留下一次 diff。现在是主线程下发、worker 侧 `assertLanePlan` **校验**
 * （只接受这一份，fail-closed）—— 为了少起线程而先跑宽车道在结构上做不到。
 *
 * 这份清单同时是"两条车道**真的**有调用方"的源码级证据：`data-only` 在前、`direct-sync`
 * 在后（`direct-sync-analysis-registration.test.ts` 的源码守卫读的就是这里）。
 */
export const IMPORT_LANE_SEQUENCE = [
  { operation: "data-only" },
  { operation: "direct-sync" }
] as const;

/** 下发的车道序列（字符串形态）—— 与 {@link IMPORT_LANE_SEQUENCE} 同源，不手抄第二份。 */
export const importLaneAttempts = () => IMPORT_LANE_SEQUENCE.map((lane) => lane.operation);

// 🔴 加载期一致性的第二道：本地清单必须与 worker 侧允许的顺序**逐项**相同。两边任何一处
// 被改（例如有人为了"省一次尝试"把 direct-sync 提前），这里立刻抛错，而不是等到某一批
// 载荷悄悄走了宽车道。
if (IMPORT_LANE_SEQUENCE.length !== IMPORT_LANE_ATTEMPTS.length
    || IMPORT_LANE_SEQUENCE.some((lane, index) => lane.operation !== IMPORT_LANE_ATTEMPTS[index])) {
  throw new Error("Import lane plan drifted from the worker-side allowed sequence");
}

/**
 * 常驻 ingest Worker 的句柄（WP-41 / O12 第二阶段）。
 *
 * `pending` 按 **taskId** 索引：线程复用了，回复就必须能对上"是哪一批" ——
 * 否则一次丢失/错配的回复会把 A 批的结论记到 B 批头上。崩溃或某批抛错时，
 * 未决任务**逐个** reject（绝不当成"没跑"静默放过），线程随后被替换。
 */
interface ResidentIngestWorker {
  thread: Worker;
  /** 线程内 tsx 注册 + 模块加载完成（第一条 `ready` 消息）。 */
  ready: Promise<void>;
  /** 启动耗时（`new Worker` → `ready`）：spawn + tsx 注册 + 模块加载。 */
  startupMs: number;
  startError: Error | null;
  retired: boolean;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; stage: string; startedAt: number }>;
  /**
   * 当前安装着的 `message` 监听器 —— **只在有任务在飞时存在**。
   *
   * 🔴 为什么监听器要跟着任务装上/卸下：`Worker` 上的 `message` 监听器会**引用住**那个
   * `MessagePort`，即使 `unref()` 过也一样（Node v22 实测：`unref()` 之后进程仍不退出）。
   * 于是"常驻线程"会把整个进程钉在事件循环里 —— 任何一条忘记 `close()` 的路径都会让
   * 进程永远退不出去。装上/卸下之后语义正好是我们想要的：**有任务在飞 ⇒ 线程保活进程；
   * 空闲的常驻线程 ⇒ 不再是进程存活的原因**。
   */
  listener: ((message: IngestWorkerMessage) => void) | null;
}

export class ImportWorker {
  private readonly jobs = new Map<string, MutableImportJob>();
  private readonly jobStatePath: string;
  private readonly state: RuntimeStateStore;
  private running = false;
  private closing = false;
  private timer: NodeJS.Timeout | null = null;
  private runPromise: Promise<void> | null = null;
  private activeAnalysis: Worker | null = null;
  private activeJob: MutableImportJob | null = null;
  private cancelRequested = false;
  private readonly publicationJournal: ImportPublicationJournal | undefined;
  private computeStagesMs: Record<string, number> = {};
  private recoveryBlocked = false;
  /** 常驻 ingest Worker（WP-41 第二阶段）：懒创建、跨批复用、崩溃或任务抛错后替换。 */
  private ingest: ResidentIngestWorker | null = null;
  private ingestSequence = 0;
  private readonly ingestStats = {
    started: 0, tasks: 0, retired: 0, targetResets: 0, startupMs: 0, lastRssKiB: 0, maxRssKiB: 0
  };
  /** 载荷身份计算次数（观测面：O12 步骤 2 的"少算一遍"必须能被测量，而不是被声称）。 */
  private readonly payloadIdentityStats = { computations: 0 };

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
      // 🔴 取消要真的让这一批**停下写**：常驻 ingest 线程正跑着这条车道（可能已经进了
      // 事务），所以整条线程作废（在飞任务被 reject ⇒ 走 catch 的持久回执恢复路径），
      // 而不是只把一个标志位交给它。下一次任务会拿到一条**新**线程。
      const resident = this.ingest;
      if (resident && resident.pending.size > 0) {
        this.retireIngestWorker(resident, new Error("Import cancelled"));
      } else {
        await this.activeAnalysis?.terminate();
      }
      return "requested";
    }
    const previous = { status: job.status, phase: job.phase, message: job.message, completedAt: job.completedAt };
    Object.assign(job, { status: "cancelled", phase: "cancelled", message: "导入已取消", completedAt: new Date().toISOString() });
    try { this.persistJobs(); } catch (error) { Object.assign(job, previous); throw error; }
    await this.runTerminalCallbackWithRetry(job, false, true);
    return "cancelled";
  }

  private scheduleNext(delay = 20): void {
    if (!this.queueOptions || this.closing || this.recoveryBlocked || this.timer || this.runPromise) return;
    const job = [...this.jobs.values()].find((item) => item.queue && !item.queue.finalized &&
      item.queue.scope === this.queueOptions!.scope &&
      (item.status === "queued" || ["succeeded", "failed", "cancelled"].includes(item.status)));
    if (!job) { this.queueOptions.admission.withdraw(); return; }
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
      // 🔴 关闭时必须让**常驻** ingest 线程也停下：从前线程是"一个任务一条"，
      // 任务结束它就没了；常驻之后没有任何别的路径会回收它 ⇒ 这里显式退休。
      const resident = this.ingest;
      if (resident) {
        const stopped = resident.thread.terminate();
        this.retireIngestWorker(resident, new Error("Import worker closing"));
        await stopped;
      } else {
        await this.activeAnalysis?.terminate();
      }
    } catch (error) {
      terminationError = error;
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
    // Pre-upgrade queued jobs have no engine stamp and must stay TypeScript.
    const engine = job.queue
      ? job.queue.engine ?? { name: "typescript" as const, version: NATIVE_VERSION, fallback: "none" as const }
      : this.executionEngine;
    const attempt = job.queue ? `.attempt-${job.queue.attempts}` : "";
    const nativeSpoolRoot = resolve(this.runtimeRoot, "var", `native.${job.id}${attempt}`);
    this.computeStagesMs = {};
    // WP-41 / O12 步骤 7：**等待许可**也单独计时。
    // 这一段是"入队 → 真正开始执行"的等待：主线程在 `scheduleNext` 里先取 admission
    // 的单写者许可、拿到了才调用 `run()`，所以它就是"这一批排队等许可等了多久"（含退避）。
    // ⛔ 它与 `import_worker_startup`（起线程）和 `import_lanes_transaction`（车道执行）
    // 是**互不重叠**的三段，账本上分开记，才能看出成本究竟在排队还是在启动。
    const queuedAtMs = Date.parse(job.createdAt);
    if (Number.isFinite(queuedAtMs)) {
      this.recordComputeStage("import_admission_wait", Math.max(0, Date.now() - queuedAtMs));
    }
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
      // 🔴 WP-41（O12 步骤 2）：载荷身份**算一次就够了**，别把预检算出来的那个丢掉。
      // 从前 `detectUnchangedPayload` 未命中（= 正常的增量批）时已经把整棵输入树读过一遍
      // 却把结果扔了，然后下面派发车道时再算第二遍。现在它把算出来的值从 `onDigest` 交回，
      // 未命中也能复用（返回值形状**不变**：`import-payload-preflight.test.ts` 直接调它）。
      const preflight = await timing.measure("changeAnalysis", () =>
        this.detectUnchangedPayload(job, engine, (digest) => { payloadSha256 = digest; }));
      this.assertNotClosing();
      if (preflight) {
        // R2（2026-10-15）：no-op 也必须落**可持久查询的回执**（见 `writeNoopReceipt` 的注释）。
        // 旧行为只写内存 summary ⇒ 已建立 job 的客户端分支 `.hold(no_receipt)` 永久循环。
        const noopSummary = this.writeNoopReceipt(job, preflight, startedAtMs);
        if (noopSummary) {
          fastPathAttempted = true; // 回执已持久提交：回复丢失时由 catch / 下轮从回执恢复同一结论
          laneTelemetry = { outcome: "unchanged", reasons: [] };
          job.phase = "activate"; // terminal decision is now irreversible, including no-op imports
          terminalSucceeded = true;
          publishTerminalState = () => {
            job.status = "succeeded";
            job.phase = "completed";
            job.message = "导出文件与上次已导入的内容完全一致，未重新解析";
            job.completedAt = new Date().toISOString();
            job.summary = noopSummary;
          };
          return;
        }
        // 重验失败：两次检查之间另一批导入推进了 datasetVersion（anchor 已失效）。
        // 此刻的载荷不再"可证明不变"，一律落回正式车道——不写回执、不短路。
        process.stderr.write(`No-op preflight invalidated for ${job.id}: baseline moved before receipt could commit\n`);
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
        // 🔴 复用准入时算出的载荷身份（`??=`）：上面 `detectUnchangedPayload` 用的是
        // **同一个函数、同一份上下文**，算出来就是同一个值 —— 未命中的增量批从前在这里
        // 又要付一遍整棵输入树的摘要。复用**更早**的那个值还更保守：目录若在两次之间被
        // 改过，车道的**内容**摘要复核会直接失败（"payload changed after admission"），
        // 而不是拿一份新摘要悄悄放行。⛔ 这**不是**用 mtime/大小替代内容摘要：
        // 两条车道仍然各自复核它们真正要写的那份内容。
        payloadSha256 ??= await this.payloadSha256(job, engine);
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
          // 🔴 WP-41 / O12 第一阶段：两条车道现在在**同一个任务 Worker** 内按
          // `IMPORT_LANE_SEQUENCE` 顺序执行。从前这里是两次 `databaseTask` ——
          // 先 record-only、它拒收后再投递统一接收器 ⇒ **一个载荷两次 `new Worker`**
          // （两次 tsx 注册与模块加载）。顺序与闸门逐条不变：record-only 在前，
          // 它的严格资格判定（白名单 + 基线合同戳）、表写守卫与载荷身份复核一条都没动；
          // worker 侧 `assertLanePlan` 只接受这一份顺序，接受了别的就拒绝执行。
          //
          // ⚠️ 中间态文案：从前 record-only 拒收后会先把 `job.message` 改成
          // "正在按增量事务保存原始事实并登记分析" 再投递第二条车道。两段现在是一次
          // 投递，所以中途改文案的位置没有了 —— 终态文案仍由 `publishTerminalState`
          // 逐条分别给出（两条车道的措辞都保留）。
          const lanes = await this.databaseTask<ImportLanesOutcome>({
            operation: "import-lanes", input: {
              databasePath: this.databasePath, inputPath: job.inputPath, jobId: job.id,
              payloadSha256: payloadSha256!, startedAtMs, laneAttempts: importLaneAttempts()
            }
          });
          // 阶段账本：两条车道的净耗时由线程内测量并回传（线程启动/tsx 注册单独记在
          // `computeStagesMs.import_worker_startup`，见 `databaseTask`），所以
          // `dataOnlyApply` / `directSyncApply` 不再各自包含一次线程启动。
          this.recordLaneTimings(timing, lanes.timings);
          if (lanes.kind === "applied" && lanes.lane === "data-only") {
            const fast = lanes.result;
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
          if (lanes.kind === "applied") {
            const direct = lanes.result;
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
          const direct = lanes.rejection;
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
        // G4（2026-10-15）：执行器不可用时的挂起重试机制（原 waitForEngine 逻辑与
        // waitingEngine 挂起相位）随 CLI 子进程链路退场（其唯一写入端是已删的
        // command() IPC 回调）；closing 时的优雅恢复（resume）保留。
        const resume = Boolean(this.queueOptions && this.closing && job.queue && !this.cancelRequested);
        job.status = resume ? "queued" : this.cancelRequested ? "cancelled" : "failed";
        job.phase = resume ? "queued" : this.cancelRequested ? "cancelled" : "failed";
        job.message = resume ? "服务停止，重启后继续导入" : this.cancelRequested ? "导入已取消" : "导入失败，原始导出文件未被修改";
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

  /** 常驻 ingest Worker 的观测面：启动次数（每起一条线程算一次）、任务数、换库次数与 RSS。 */
  ingestWorkerStats(): {
    started: number; tasks: number; retired: number; targetResets: number;
    startupMs: number; lastRssKiB: number; maxRssKiB: number;
  } {
    return { ...this.ingestStats };
  }

  /**
   * 载荷身份（`computeImportPayloadSha256`：会把**整棵输入树**读一遍）在本 worker 生命周期
   * 内的**实际计算次数**。
   *
   * 🔴 为什么需要这个计数：O12 步骤 2 要求"把重复的摘要计算折叠掉"，而"折叠掉了"是一种
   * 关于**次数**的声明 —— 没有计数就只能靠读代码相信它。有了它，测试可以直接断言
   * "预检未命中的增量批只算 1 次"（从前是 2 次：预检 1 次 + 车道派发前重算 1 次）。
   * ⛔ 它数的是**主线程**的这一遍；两条车道各自的内容摘要复核不在其中，也不该被折叠。
   */
  payloadIdentityComputations(): number {
    return this.payloadIdentityStats.computations;
  }

  /**
   * 惰性创建常驻 ingest Worker。
   *
   * 🔴 为什么"常驻"是这次改动的重点：线程的固定成本（tsx 注册 + 模块加载）与线程的
   * **用途**无关，每批新建一次就是每批付一遍。所以线程只在第一次真正需要时创建，
   * 之后每批只发一条消息；它的启动耗时被单独记进 `computeStagesMs.import_worker_startup`，
   * 于是"省下来的启动成本"是**测出来的**，不是声称的。
   *
   * 线程**不**在空闲时创建：没有任务就没有线程（与 `RecomputeWorker` 的空队列早退同款纪律）。
   *
   * ⚠️ `unref()` + 监听器随手任务装卸：常驻线程**不得单独把进程留在事件循环里**。
   * 线程常驻之后，"创建它的那个对象没有被收掉"（例如某条测试路径提前抛错、跳过了
   * `close()`）会让整个进程在跑完之后永远退不出去 —— 那是拿一个资源泄漏去换启动成本。
   * 而 `unref()` **单独并不够**：`message` 监听器会引用住 `MessagePort`（Node v22 实测，
   * 只 `unref()` 进程照样不退出），所以监听器跟着任务装上、任务结算时卸下（见
   * {@link armIngestListener} / {@link disarmIngestListener}）。语义因此正好是想要的：
   * 有任务在飞 ⇒ 线程保活；空闲 ⇒ 常驻线程不再是进程存活的原因。
   * 最坏情况（进程在任务中途退出）也只是未提交事务回滚、作业重启后从持久回执/队列恢复。
   */
  private ensureIngestWorker(): ResidentIngestWorker {
    const existing = this.ingest;
    if (existing && !existing.retired) return existing;
    const startedAt = performance.now();
    const thread = new Worker(new URL("./import-database-bootstrap.mjs", import.meta.url));
    thread.unref();
    const resident: ResidentIngestWorker = {
      thread, ready: Promise.resolve(), startupMs: 0, startError: null, retired: false,
      pending: new Map(), listener: null
    };
    this.ingest = resident;
    this.ingestStats.started += 1;
    resident.ready = new Promise<void>((resolveReady, rejectReady) => {
      thread.once("message", (message: IngestWorkerMessage) => {
        if (message.kind !== "ready") return;
        const ready = message as IngestWorkerReadyMessage;
        const startupMs = performance.now() - startedAt;
        resident.startupMs = startupMs;
        this.ingestStats.startupMs += startupMs;
        this.recordComputeStage("import_worker_startup", startupMs);
        resolveReady();
      });
      thread.once("error", (error: Error) => {
        resident.startError = error;
        rejectReady(error);
      });
    });
    // 🔴 崩溃必须按 taskId 逐个归因并**替换线程**：静默地让在飞的任务悬着，
    // 会把"这一批到底写没写"变成没人知道的事（导入成功与否仍由持久回执裁决）。
    thread.once("error", (error: Error) => { this.retireIngestWorker(resident, error); });
    thread.once("exit", (code: number) => {
      if (!resident.retired) {
        this.retireIngestWorker(resident, new Error(`Ingest worker thread exited with code ${code}`));
      }
    });
    return resident;
  }

  /** 装上结果监听器（并把线程 ref 回事件循环）：只在**投递任务之前**调用。 */
  private armIngestListener(resident: ResidentIngestWorker): void {
    if (resident.listener) return;
    resident.thread.ref();
    const listener = (message: IngestWorkerMessage): void => {
      if (message.kind === "result") this.settleIngestReply(resident, message);
    };
    resident.listener = listener;
    resident.thread.on("message", listener);
  }

  /**
   * 卸下结果监听器并 `unref()`：**没有任务在飞时**必须调用。
   * 少这一步，空闲的常驻线程就会把进程钉在事件循环里（见 `ensureIngestWorker` 的注释）。
   */
  private disarmIngestListener(resident: ResidentIngestWorker): void {
    const listener = resident.listener;
    if (!listener) return;
    resident.listener = null;
    resident.thread.off("message", listener);
    resident.thread.unref();
  }

  /** 一条任务回复：按 taskId 结算，并在失败时按约定替换线程。 */
  private settleIngestReply(resident: ResidentIngestWorker, message: IngestWorkerReply): void {
    const waiting = resident.pending.get(message.taskId);
    this.ingestStats.lastRssKiB = message.rssKiB;
    this.ingestStats.maxRssKiB = Math.max(this.ingestStats.maxRssKiB, message.rssKiB);
    this.ingestStats.targetResets = message.targetResets;
    if (!waiting) {
      // 已经因崩溃/取消结算过的任务：迟到的回复不得再触发任何副作用。
      process.stderr.write(`Ingest worker reply for unknown task ${message.taskId} ignored\n`);
      return;
    }
    resident.pending.delete(message.taskId);
    this.ingestStats.tasks += 1;
    this.recordComputeStage(waiting.stage, performance.now() - waiting.startedAt);
    if (resident.pending.size === 0) {
      if (this.activeAnalysis === resident.thread) this.activeAnalysis = null;
      // 没有任务在飞了 ⇒ 卸下监听器，让空闲的常驻线程不再保活进程。
      this.disarmIngestListener(resident);
    }
    if (message.ok) {
      waiting.resolve(message.value);
      return;
    }
    // 🔴 任务抛错 ⇒ 这一批失败（按 taskId 归因），并且**整条线程不再复用**：
    // 上一批可能留下半开的连接或锁，换一条线程比赌它干净便宜。
    const failure = new Error(`${message.error} (ingest task ${message.taskId})`);
    this.retireIngestWorker(resident, failure);
    waiting.reject(failure);
  }

  /** 线程作废：拒绝在飞任务、清空 pending、终止线程。可重入（第一次生效）。 */
  private retireIngestWorker(resident: ResidentIngestWorker, error: Error): void {
    if (resident.retired) return;
    resident.retired = true;
    if (this.ingest === resident) this.ingest = null;
    if (this.activeAnalysis === resident.thread) this.activeAnalysis = null;
    this.ingestStats.retired += 1;
    for (const [taskId, waiting] of resident.pending) {
      this.recordComputeStage(waiting.stage, performance.now() - waiting.startedAt);
      waiting.reject(new Error(`${error.message} (ingest task ${taskId} did not complete)`));
    }
    resident.pending.clear();
    this.disarmIngestListener(resident);
    void resident.thread.terminate().catch(() => { /* 线程可能已经退出 */ });
  }

  private recordComputeStage(stage: string, milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) return;
    this.computeStagesMs[stage] = (this.computeStagesMs[stage] ?? 0) + Math.max(0, milliseconds);
  }

  /**
   * 把 worker 线程内测得的**两条车道**耗时落进阶段账本（WP-41 / O12 步骤 7）。
   *
   * 为什么不让主线程自己围着 `databaseTask` 计时：两条车道现在在**一次**投递里跑完，
   * 主线程只能看到"任务整体"，那正是从前把两次尝试糊成一个数字的形态。线程内的时间戳
   * 才是"每条车道自己花了多久"，且不含线程启动与 IPC。
   * 没跑过的车道**不落键**：`undefined` 与 `0` 必须能分辨（"跳过"不是"跑了 0 ms"）。
   */
  private recordLaneTimings(timing: ImportPerformanceTracker, timings: ImportLaneTimings): void {
    timing.record("dataOnlyApply", timings.laneMs["data-only"] ?? 0);
    timing.record("directSyncApply", timings.laneMs["direct-sync"] ?? 0);
    // P2-3（2026-10-18 同步诊断）：直连接收器内部的四段耗时。它们进
    // `computeStagesMs`（开放键，schema 是 additionalProperties: number），**不**进
    // `stagesMs` 的闭集枚举 —— 后者是公开契约的一部分，不能为一个诊断数字扩它。
    // `recordComputeStage` 会过滤非有限值；这里不做 `?? 0`：不存在的键不该被写成 0。
    for (const [stage, milliseconds] of Object.entries(timings.directSyncStagesMs ?? {})) {
      this.recordComputeStage(stage, milliseconds);
    }
  }

  /** A Promise wrapper around synchronous SQL is not sufficient: own the
   * SQLite connection on a separate thread, and propagate termination as a
   * task failure, never as evidence that a healthy database is corrupt. */
  private async databaseTask<T>(task: ImportDatabaseTask, stage = task.operation === "verify"
    ? "database_quick_check" : task.operation === "audit" ? "final_audit_build"
      : task.operation === "import-lanes" ? "import_lanes_transaction" : "database_checkpoint"): Promise<T> {
    // 🔴 两轮：只在"线程恰好在我们投递之前作废"（崩溃、取消、任务抛错后退休）时重试一次。
    // `ensureIngestWorker()` → `await ready` 之间有 await，线程可能在那一刻退休；投递本身
    // 是同步的，所以过了下面那道检查就不可能再插进一次退休。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resident = this.ensureIngestWorker();
      await resident.ready;
      if (resident.retired) continue;
      const taskId = this.ingestSequence += 1;
      return new Promise<T>((resolveResult, reject) => {
        resident.pending.set(taskId, {
          resolve: resolveResult as (value: unknown) => void, reject, stage, startedAt: performance.now()
        });
        this.activeAnalysis = resident.thread;
        // 🔴 先装监听器再投递：任务在飞 ⇒ 线程 ref 回来（进程保活、回复不丢）；
        // 任务结算时卸下（见 `disarmIngestListener`）。
        this.armIngestListener(resident);
        resident.thread.postMessage({ kind: "task", taskId, task });
      });
    }
    throw new Error("Ingest worker unavailable: the resident thread was retired before dispatch");
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
   * 🔴 2026-10-15（P3-d）语义订正：本注释曾写 "A payload that cannot be read is *not* a
   * pre-flight failure … Failing here would turn an optimisation into a new way to fail an
   * import." —— 那是收口（S3.1）**之前**的行为。现在直连段调用方把 `null` 升级为
   * `ImportLaneRefusal(["payload_identity_unavailable"])` 的**带码终态失败**，这是刻意的
   * 语义变更（"算不出摘要 ⇒ 静默回退旧链路"的路径随候选链路一并删除）。照旧注释"改回
   * 静默回退"会重新打开 S3.1 关掉的缺口。本方法自身分工不变：只报告状态、不下处置判断。
   */
  private async payloadSha256(job: MutableImportJob, engine: ImportExecutionEngine): Promise<string | null> {
    this.payloadIdentityStats.computations += 1;
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
   *
   * 🔴 WP-41（O12 步骤 2）：**算出来的摘要**从 `onDigest` 交回调用方，返回值形状不变。
   * 从前未命中时（= 正常的增量批）摘要被就地丢弃，调用方随后再算一遍整棵输入树；
   * 现在未命中也能把它交给车道派发复用。两条车道仍然各自复核内容摘要 —— 少算的
   * 只是**主线程这一遍重复**，不是任何一道校验。
   * ⚠️ 返回值刻意保持 `PayloadPreflight | null`（而不是包一层结果对象）：
   * `import-payload-preflight.test.ts` 直接调用本方法并断言"未命中就是 `null`"，
   * 那是**既有的**判据，不该为了省一遍摘要而改掉它的形状。
   */
  private async detectUnchangedPayload(
    job: MutableImportJob,
    engine: ImportExecutionEngine,
    /** 可选出口：本方法**真的算了**摘要时把它交回（命中与未命中都给；没算则不调用）。 */
    onDigest?: (sha256: string | null) => void
  ): Promise<PayloadPreflight | null> {
    if (job.preserveAbsent !== true) return null;
    const identity = readDatabaseImportIdentity(this.databasePath);
    if (!identity?.anchor || identity.datasetVersion === null) return null;
    if (identity.datasetVersion !== identity.anchor.datasetVersion) return null;
    const sha256 = await this.payloadSha256(job, engine);
    onDigest?.(sha256);
    if (sha256 === null || sha256 !== identity.anchor.sha256) return null;
    return {
      sha256,
      datasetVersion: identity.datasetVersion,
      unchangedWorkouts: this.countTrainingSessions()
    };
  }

  /**
   * R2（2026-10-15）：无变化成功的**持久回执**。
   *
   * 为什么必须有：客户端对"已建立 job"的批次要求 `summary.directSync` 形式的
   * committed 回执才推进游标（`DirectSyncCursorPolicy.decision` 的 `.hold(no_receipt)`）。
   * 旧的 unchanged 早退只在内存里写 summary、没有任何持久回执 ⇒ 客户端每轮恢复都读到
   * 同一份无回执的成功响应 ⇒ 永久循环（同内容并发来源、不经 inspect 直接建 job 的通道可达）。
   *
   * 事务纪律与重验：写回执在**一个短写事务**里完成，且在**同一事务内**重验
   * 「库仍对应本载荷」——判据与 `detectUnchangedPayload` 逐条一致（anchor 存在、
   * datasetVersion 未变、sha256 相等）。任何一个不成立 ⇒ 返回 `null`（调用方落回
   * 正式车道）：两次检查之间任何导入都会推进 datasetVersion，让 anchor 失效。
   *
   * 回执形状（`packages/contracts/src/direct-sync.ts` 的 `DirectSyncReceipt`）：
   *   - `ingestStatus: "committed"` —— 事实层的结论：本批没有要写入的新事实，
   *     "服务端已确认当前库与此载荷一致"；
   *   - `analysisStatus: "not_required"` —— 本批**没有**登记分析任务：内容与已导入
   *     完全一致 ⇒ 结构上不影响分析（§9.1）。**绝不**复用/伪造其它批次的 `published`；
   *   - 三个"没有值"的字段一律 `null`（合同：本批不影响分析 / 未发布 / 未分片）。
   *
   * 失败面：写库异常向上抛（基础设施故障 ⇒ job 失败；重试幂等——每轮开头的
   * `readImportReceipt` 或再次走到这里都会收敛到同一结论）。
   */
  private writeNoopReceipt(
    job: MutableImportJob,
    preflight: PayloadPreflight,
    startedAtMs: number
  ): ImportJobResponse["summary"] | null {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.databasePath);
      database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
      database.exec("BEGIN IMMEDIATE");
      const identity = readImportIdentityInDatabase(database);
      const verified = identity.anchor !== null
        && identity.datasetVersion !== null
        && identity.datasetVersion === identity.anchor.datasetVersion
        && identity.anchor.sha256 === preflight.sha256;
      if (!verified) {
        database.exec("ROLLBACK");
        return null;
      }
      const summary: NonNullable<ImportJobResponse["summary"]> = {
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
        backupName: null,
        directSync: {
          ingestStatus: "committed",
          receiptId: job.id,
          analysisStatus: "not_required",
          dependencyGeneration: null,
          publishedReleaseId: null,
          parentBatchId: null
        }
      };
      writeImportReceiptInDatabase(database, job.id, summary);
      database.exec("COMMIT");
      return summary;
    } catch (error) {
      try { database?.exec("ROLLBACK"); } catch { /* 事务可能未开启或已结束 */ }
      throw error;
    } finally {
      database?.close();
    }
  }

  /** Sessions in the live database; `0` when it cannot be read, never a thrown error. */
  private countTrainingSessions(): number {
    try {
      return this.countRows(this.databasePath, "training_sessions");
    } catch {
      return 0;
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

  private assertNotClosing(): void {
    if (this.closing) throw new Error("Import worker is shutting down");
    if (this.cancelRequested) throw new Error("Import cancelled");
  }

  /**
   * `performance` 的公开层白名单（2026-10-15）：只放**仍在使用**的键。
   *
   * `native` / `computeProcessMaxRssKiB` 随 CLI 子进程链路退役、写入端已删除，
   * 但历史持久化行（`performance_json`）里仍带着残留键 —— 此前注释声称"会被响应
   * schema（additionalProperties: false）剥掉"，部署实测**不剥**（运行时没有 response
   * schema 层，OpenAPI 文档的 additionalProperties 不参与序列化）。现在在公开出口
   * 统一剥掉；数据层（库与内存 job）保持原样、不重写历史行。
   *
   * 🔴 新增公开键必须显式加进来（并同步 `PUBLIC_PERFORMANCE_KEYS`（编译期穷尽守卫）、
   * `ImportJobPerformance` 与 `schemas.ts` 的响应描述）；不在这里的键不会出现在任何
   * job 响应里。
   *
   * 2026-10-15（审查 A-🔡4）：嵌套对象做浅拷贝 —— 公开返回值与内存 job 不共享可变
   * 引用，调用方原地改返回值不会污染后续读取（运行期守卫见 `worker.test.ts`）。
   */
  private publicPerformance(performance: ImportJobPerformance): ImportJobPerformance {
    return {
      validationMode: performance.validationMode,
      totalMs: performance.totalMs,
      stagesMs: { ...performance.stagesMs },
      ...(performance.computeStagesMs === undefined ? {} : { computeStagesMs: { ...performance.computeStagesMs } }),
      ...(performance.lane === undefined ? {} : {
        lane: {
          ...performance.lane,
          reasons: [...performance.lane.reasons],
          ...(performance.lane.rejections === undefined ? {} : { rejections: [...performance.lane.rejections] })
        }
      })
    };
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
      // `== null` 同时挡 `undefined` 与历史 JSON 迁移可能带来的 `null`（否则白名单读取会抛错）。
      ,...(job.performance == null ? {} : { performance: this.publicPerformance(job.performance) })
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
