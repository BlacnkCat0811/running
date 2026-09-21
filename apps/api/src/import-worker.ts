import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { analyzeDatasetChange, type ImportDatasetChange } from "./import-dataset-analysis.js";

import type { ImportExecutionEngine, ImportJobResponse, ImportJobPerformance } from "@rai/api-contracts";
import { currentAbilityBaselineHash } from "@rai/application";
import {
  ImportRemovalGuardError,
  stageAuditFiles,
  type RemovalGuardPayload,
  type StagedAuditFiles,
  NATIVE_VERSION,
} from "@rai/health-export-parser";
import { ImportPerformanceTracker } from "./import-performance.js";
import { resolvePreserveAbsent } from "./import-sources.js";
import { backupPolicyFromEnvironment, DatabaseMaintenance } from "./maintenance.js";
import { RuntimeStateStore } from "./runtime-state.js";

import { ImportPublicationJournal, readImportReceipt, writeImportReceipt } from "./import-publication.js";
import type { TaskAdmission } from "./task-admission.js";
import { terminateProcessTree, waitForShutdown } from "./worker-process.js";

/** Client-visible import failure text; full diagnostics stay in server logs only. */
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

export const predictionModelWorkerRetryDelay = (consecutiveFailures: number): number =>
  Math.min(30_000, 1_000 * (2 ** Math.max(0, consecutiveFailures - 1)));

interface MutableImportJob extends ImportJobResponse {
  inputPath: string;
  preserveAbsent?: boolean;
  removalGuard?: RemovalGuardPayload;
  onTerminal?: (succeeded: boolean, durable: boolean) => void | Promise<void>;
  queue?: { scope: string; attempts: number; finalized: boolean; cancelRequested?: boolean; engine?: ImportExecutionEngine };
}

export interface ImportQueueOptions {
  engine?: ImportExecutionEngine;
  scope: string;
  admission: TaskAdmission;
  maxPending?: number;
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
    if (repaired && existsSync(databasePath) && this.isReadableDatabase(databasePath)) {
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
      .filter((candidate) => candidate.sourceId === sourceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    const stored = job ?? this.state.latestJobForSource(sourceId) as MutableImportJob | null;
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
    const finalMarkdownReport = resolve(this.runtimeRoot, "docs/DATA_AUDIT.md");
    const finalJsonReport = resolve(this.runtimeRoot, "var/reports/data-audit.json");
    let currentBackupPath: string | null = null;
    let auditPublication: StagedAuditFiles | null = null;
    let terminalSucceeded = false;
    let publishTerminalState: (() => void) | null = null;
    try {
      job.status = "running";
      this.persistJobs();
      await mkdir(nativeSpoolRoot, { recursive: true });
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
      await this.removeDatabaseFiles(stagingDatabase);
      this.assertNotClosing();
      currentBackupPath = await timing.measure("backup", () => this.createCurrentBackup(job.id));
      this.assertNotClosing();
      if (currentBackupPath) {
        const backupPath = currentBackupPath;
        await timing.measure("stagingCopy", () => copyFile(backupPath, stagingDatabase));
      }
      this.assertNotClosing();
      job.phase = "import";
      job.message = currentBackupPath
        ? "正在临时数据库中增量同步 Apple Health 数据"
        : "正在临时数据库中解析 Apple Health 导出文件";
      this.persistJobs();
      await timing.measure("parseImport", () => this.command([
        "--import",
        "tsx",
        "packages/health-export-parser/src/cli.ts",
        currentBackupPath ? "incremental-import" : "import",
        "--input",
        job.inputPath,
        "--database",
        stagingDatabase,
        ...engineArgs,
        "--report",
        stagedMarkdownReport,
        "--json-report",
        stagedJsonReport,
        // 报告最终发布成 `docs/DATA_AUDIT.md`，描述的是**主库**；但 CLI 眼里只有暂存
        // 副本（上面 `--database stagingDatabase`）。显式告诉它数据源，否则报告头部会
        // 写 `var/rai.importing.<jobId>.sqlite` —— 读者会以为数字来自一个临时文件。
        "--source-database",
        this.databasePath,
        ...(currentBackupPath ? ["--batch-id", job.id] : ["--replace"]),
        // Absence-as-deletion is opt-in, so the CLI needs to be told explicitly
        // when a payload declared itself a complete snapshot. A falsy flag means
        // "not preserving", matching how the parser reads the same option.
        ...(currentBackupPath
          ? [job.preserveAbsent ? "--preserve-absent" : "--replace-absent"]
          : [])
      ]));
      this.assertNotClosing();
      job.phase = "analyze";
      job.message = "正在确定受影响的数据范围";
      this.persistJobs();
      const change = await timing.measure("changeAnalysis", () => currentBackupPath
        ? this.queueOptions
          ? this.analyzeInThread(stagingDatabase, currentBackupPath, job)
          : this.analyzeDatasetChange(stagingDatabase, currentBackupPath, job.id, job.preserveAbsent)
        : {
            mode: "full" as const,
            dirtyFromAt: null,
            insertedWorkouts: this.countRows(stagingDatabase, "training_sessions"),
            updatedWorkouts: 0,
            removedWorkouts: 0,
            unchangedWorkouts: 0,
            routesUpdated: this.countRows(stagingDatabase, "workout_routes")
          });
      this.assertNotClosing();
      if (change.mode === "unchanged") {
        job.phase = "activate"; // terminal decision is now irreversible, including no-op imports
        terminalSucceeded = true;
        publishTerminalState = () => {
          job.status = "succeeded";
          job.phase = "completed";
          job.message = "导出文件中没有影响分析的新数据";
          job.completedAt = new Date().toISOString();
          job.summary = {
            importMode: "unchanged",
            ...change,
            featuresReused: 0,
            featuresRecomputed: 0,
            modelReplayFrom: null,
            durationMs: Date.now() - startedAtMs,
            backupName: currentBackupPath ? currentBackupPath.split(/[\\/]/).at(-1) ?? null : null
          };
        };
        return;
      }
      let featureSummary = { reused: 0, recomputed: 0 };
      if (change.mode !== "data-only") {
        // Incremental staging starts from an online backup, so overrides and immutable
        // histories already remain attached to their stable training-session identities.
        job.phase = "recompute";
        job.message = "导入完成，正在重算 RAI 时间线";
        this.persistJobs();
        const incremental = change.mode === "incremental" && change.dirtyFromAt;
        await timing.measure("recompute", () => this.command([
          "--import",
          "tsx",
          "packages/application/src/cli.ts",
          "recompute",
          "--database",
          stagingDatabase,
          ...engineArgs,
          "--timezone",
          "Asia/Shanghai",
          ...(this.recomputeEvaluatedAt ? ["--evaluated-at", this.recomputeEvaluatedAt] : []),
          ...(incremental ? ["--dirty-from", incremental] : [])
        ]));
        this.assertNotClosing();
        featureSummary = this.latestFeatureRunSummary(stagingDatabase);
      }
      job.phase = "activate";
      job.message = change.mode === "data-only"
        ? "导入完成，正在保存无需重算的数据"
        : "验证完成，正在切换本地数据库";
      this.persistJobs();
      if (this.queueOptions) {
        writeImportReceipt(stagingDatabase, job.id, {
          recomputeReasons: change.recomputeReasons ?? [],
          importMode: change.mode === "data-only" ? "incremental" : change.mode,
          insertedWorkouts: change.insertedWorkouts, updatedWorkouts: change.updatedWorkouts,
          removedWorkouts: change.removedWorkouts, unchangedWorkouts: change.unchangedWorkouts,
          routesUpdated: change.routesUpdated, featuresReused: featureSummary.reused,
          featuresRecomputed: featureSummary.recomputed,
          modelReplayFrom: change.mode === "incremental" ? change.dirtyFromAt : null,
          durationMs: Date.now() - startedAtMs,
          backupName: currentBackupPath ? basename(currentBackupPath) : null
        });
      }
      auditPublication = await timing.measure("activation", () => this.stageAuditReports(
        stagingDatabase,
        finalMarkdownReport,
        finalJsonReport,
      ));
      const publication = auditPublication;
      await timing.measure("activation", async () => {
        await this.activateDatabase(
          stagingDatabase,
          job.id,
          currentBackupPath,
          () => publication.commit(),
        );
        publication.finalize();
      });
      terminalSucceeded = true;
      publishTerminalState = () => {
        job.status = "succeeded";
        job.phase = "completed";
        job.message = change.mode === "data-only" ? "导入完成，分析数据没有变化" : "导入与模型重算完成";
        job.completedAt = new Date().toISOString();
        job.summary = {
          recomputeReasons: change.recomputeReasons ?? [],
          importMode: change.mode === "data-only" ? "incremental" : change.mode,
          insertedWorkouts: change.insertedWorkouts,
          updatedWorkouts: change.updatedWorkouts,
          removedWorkouts: change.removedWorkouts,
          unchangedWorkouts: change.unchangedWorkouts,
          routesUpdated: change.routesUpdated,
          featuresReused: featureSummary.reused,
          featuresRecomputed: featureSummary.recomputed,
          modelReplayFrom: change.mode === "incremental" ? change.dirtyFromAt : null,
          durationMs: Date.now() - startedAtMs,
          backupName: currentBackupPath ? currentBackupPath.split(/[\\/]/).at(-1) ?? null : null
        };
      };
    } catch (error) {
      this.onDatabaseError(error);
      let failure: unknown = error;
      try {
        auditPublication?.rollback();
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          "Import failed and audit report publication could not be rolled back",
        );
      }
      terminalSucceeded = false;
      const removalGuard = findRemovalGuardError(failure);
      publishTerminalState = () => {
        const detail = failure instanceof Error
          ? (failure.stack ?? failure.message)
          : String(failure);
        // Keep full diagnostics in server logs only; never return child stderr or paths to clients.
        console.error(`Import job ${job.id} failed: ${detail}`);
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
        job.error = resume || this.cancelRequested ? null : removalGuard ? removalGuard.userMessage : PUBLIC_IMPORT_FAILURE_ERROR;
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
            ,native: { ...this.nativeStats }
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
  ): StagedAuditFiles {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return stageAuditFiles(database, markdownPath, jsonPath);
    } finally {
      database.close();
    }
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

  private async createCurrentBackup(jobId: string): Promise<string | null> {
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
    if (!this.isReadableDatabase(this.databasePath)) {
      this.onDatabaseError(new Error("Main database is corrupt or failed its integrity check"));
      await maintenance.preserveCorruptDatabase(`before-web-import-${jobId}-corrupt`);
      return null;
    }
    await maintenance.ensureBackupCapacity();
    const backupPath = resolve(backupDirectory, `rai.before-web-import.${jobId}.sqlite`);
    const stagingBackupPath = `${backupPath}.partial-${randomUUID()}`;
    const currentDatabase = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      await this.backupDatabase(currentDatabase, stagingBackupPath);
      await rename(stagingBackupPath, backupPath);
    } catch (error) {
      try {
        await this.cleanupPartialBackup(stagingBackupPath);
      } catch (cleanupError) {
        if (error && typeof error === "object") {
          try {
            (error as { cleanupError?: unknown }).cleanupError = cleanupError;
          } catch { /* Preserve the original backup error even when it is immutable. */ }
        }
      }
      throw error;
    } finally {
      currentDatabase.close();
    }
    try {
      await maintenance.enforceBackupPolicy(basename(backupPath));
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`Import backup retention cleanup failed after backup was published: ${message}\n`);
    }
    return backupPath;
  }

  private async backupDatabase(database: DatabaseSync, destination: string): Promise<void> {
    await backup(database, destination);
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
    const originalReadable = originalExisted && this.isReadableDatabase(this.databasePath);
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
        if (originalReadable) this.checkpointDatabase(this.databasePath);
        await this.removeDatabaseSidecarsWithRetry(this.databasePath);
        await this.moveDatabaseFile(this.databasePath, rollbackPath);
        originalMoved = true;
      }
      this.assertNotClosing();
      await mkdir(dirname(this.databasePath), { recursive: true });
      await this.installDatabase(stagingDatabase, this.databasePath);
      if (!this.isReadableDatabase(this.databasePath)) {
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
          this.checkpointDatabase(this.databasePath);
          await this.removeDatabaseSidecarsWithRetry(this.databasePath);
          await this.removeDatabaseFileWithRetry(this.databasePath);
        } catch (cleanupError) {
          errors.push(cleanupError);
        }
      }
      const activeReadable = this.isReadableDatabase(this.databasePath);
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
    const activeReadable = activeExists && this.isReadableDatabase(this.databasePath);
    if (activeReadable) {
      try {
        this.checkpointDatabase(this.databasePath);
        await this.removeDatabaseSidecarsWithRetry(this.databasePath);
        await this.moveDatabaseFile(rollbackPath, this.databasePath);
      } catch (error) {
        errors.push(error);
      }
    } else {
      if (activeExists) {
        try {
          try { this.checkpointDatabase(this.databasePath); } catch { /* Candidate is already unreadable. */ }
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
    if (!this.isReadableDatabase(this.databasePath)) {
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
      if (!this.isReadableDatabase(stagingPath)) {
        throw new Error("Online import backup is not readable before restoration");
      }
      await this.moveDatabaseFile(stagingPath, this.databasePath);
      if (!this.isReadableDatabase(this.databasePath)) {
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

  private checkpointDatabase(path: string): void {
    const database = new DatabaseSync(path);
    applyBusyTimeout(database);
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
  }

  private isReadableDatabase(path: string): boolean {
    if (!existsSync(path)) return false;
    try {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        return (database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined)?.quick_check === "ok";
      } finally {
        database.close();
      }
    } catch {
      return false;
    }
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
      let errorOutput = "";
      let removalGuard: ImportRemovalGuardError | null = null;
      child.on("message", (message: unknown) => {
        if (typeof message === "object" && message !== null) {
          const item = message as { type?: string; code?: string; operation?: string; actual?: string; durationMs?: number; peakRssKiB?: number };
          if (item.type === "rai:native-failure" && ["unavailable", "invalid_protocol"].includes(item.code ?? "")) this.nativeFailure = item.code!;
          if (item.type === "rai:native-engine" && ["health", "gpx", "aggregate", "apply-records"].includes(item.operation ?? "") &&
              ["rust", "typescript"].includes(item.actual ?? "") && typeof item.durationMs === "number" &&
              Number.isFinite(item.durationMs) && item.durationMs >= 0) {
            const previous = this.nativeStats[item.operation!] ?? { rustCalls: 0, typescriptFallbacks: 0, wallMs: 0, peakRssKiB: 0 };
            if (item.actual === "rust") previous.rustCalls++; else previous.typescriptFallbacks++;
            previous.wallMs += item.durationMs;
            if (typeof item.peakRssKiB === "number" && Number.isFinite(item.peakRssKiB)) previous.peakRssKiB = Math.max(previous.peakRssKiB, item.peakRssKiB);
            this.nativeStats[item.operation!] = previous;
          }
        }
        if (typeof message === "object" && message !== null) {
          const payload = message as { type?: string; stage?: string; durationMs?: number; processMaxRssKiB?: number };
          if (payload.type === "rai:compute-performance" &&
              ["features", "trainingMetrics", "modelReplay",
                "parse_health_xml", "import_gpx_routes", "canonicalize_workouts",
                "canonicalize_nights", "stage_audit_files"].includes(payload.stage ?? "") &&
              typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs) && payload.durationMs >= 0) {
            this.computeStagesMs[payload.stage!] = (this.computeStagesMs[payload.stage!] ?? 0) + payload.durationMs;
            if (typeof payload.processMaxRssKiB === "number" && Number.isFinite(payload.processMaxRssKiB)) {
              this.computeProcessMaxRssKiB = Math.max(this.computeProcessMaxRssKiB, payload.processMaxRssKiB);
            }
          }
        }
        if (ImportRemovalGuardError.fromPayload(message)) {
          removalGuard = ImportRemovalGuardError.fromPayload(message) ?? removalGuard;
          // Acknowledge receipt before the child disconnects so the guard
          // cannot be lost between IPC delivery and the close event.
          if (child.connected) child.send({ type: "rai:removal-guard-ack" });
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        errorOutput = `${errorOutput}${chunk.toString()}`.slice(-4000);
      });
      child.on("error", (error) => {
        if (this.activeChild === child) this.activeChild = null;
        reject(error);
      });
      child.on("close", (code) => {
        if (this.activeChild === child) this.activeChild = null;
        if (code === 0) resolvePromise();
        else reject(removalGuard ?? new Error(errorOutput.trim() || `导入进程退出，代码 ${String(code)}`));
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
