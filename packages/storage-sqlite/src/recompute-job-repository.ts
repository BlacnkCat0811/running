import type { DatabaseSync } from "node:sqlite";

import { isApplicationConsumableJob, type RecomputeJob, type RecomputeJobType, type RunStatus } from "@rai/contracts";

import { appNow, opaqueId, parseJson } from "./utils.js";
// Recompute job lifecycle SQL lives only in @rai/storage-sqlite.

export type JobCancellationResult =
  | { outcome: "not_found" }
  | { outcome: "terminal" }
  | {
      outcome: "cancelled" | "cancellation_requested";
      status: "cancelled" | "running";
      cancelRequested: boolean;
    };

/**
 * v35 给 `recompute_jobs` 加的四个分析任务绑定列（`docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md` §3.2）。
 *
 * 每个字段都是可选的：**不传就是 NULL**，与 v35 之前的历史行逐列相同。这里**只写列**，
 * 不碰 `job_type` / `status` 的 `CHECK`（v35 文件头明令禁止放宽）—— 登记一个分析任务
 * 仍然是登记一个 `'import'` 类型、`'queued'` 状态的任务。
 */
export interface RecomputeJobBindings {
  /** 本批落库后，事实应达到的 raw 代次（`import_generations.raw_generation`）。 */
  targetRawGeneration?: number;
  /** 本批落库后，依赖（评分输入）应达到的代次（`import_generations.dependency_generation`）。 */
  targetDependencyGeneration?: number;
  /** 登记时预期的 incumbent release；消费者据此检测"登记之后分析基准被换掉"。 */
  expectedIncumbentReleaseId?: string;
  /** 本批弄脏的分析输入（会被 `JSON.stringify` 成 `dirty_json`）。 */
  dirty?: unknown;
}

export class RecomputeJobRepository {
  constructor(private readonly database: DatabaseSync) {}

  /**
   * 登记一个任务。{@link RecomputeJobBindings} 可选：**不传时执行与历史逐字节相同的 SQL**，
   * 四个 v35 绑定列保持 NULL。传了才会把对应列追加到 `INSERT` 里（只追加给定的列，
   * 未给的仍为 NULL）。
   *
   * 本方法**不自开事务**（裸 `INSERT` + `logEvent`），所以它可以被放进调用方持有的
   * 同一个主库事务里落库（§4.2）。⛔ 不要在这里加 `BEGIN`。
   */
  enqueue(
    jobType: RecomputeJobType,
    datasetVersion: string | null,
    request: object,
    bindings?: RecomputeJobBindings
  ): string {
    const id = opaqueId("recompute_job");
    const bindingColumns: string[] = [];
    const bindingValues: Array<number | string> = [];
    if (bindings?.targetRawGeneration !== undefined) {
      bindingColumns.push("target_raw_generation");
      bindingValues.push(bindings.targetRawGeneration);
    }
    if (bindings?.targetDependencyGeneration !== undefined) {
      bindingColumns.push("target_dependency_generation");
      bindingValues.push(bindings.targetDependencyGeneration);
    }
    if (bindings?.expectedIncumbentReleaseId !== undefined) {
      bindingColumns.push("expected_incumbent_release_id");
      bindingValues.push(bindings.expectedIncumbentReleaseId);
    }
    if (bindings?.dirty !== undefined) {
      bindingColumns.push("dirty_json");
      bindingValues.push(JSON.stringify(bindings.dirty));
    }
    if (bindingColumns.length === 0) {
      // 历史路径原样保留 —— 保证"不传绑定参数时行为与今天逐列相同"是可复核的事实，
      // 而不是"新 SQL 恰好算出了同样的值"。
      this.database.prepare(`
        INSERT INTO recompute_jobs (
          id, job_type, status, dataset_version, request_json, progress_phase
        ) VALUES (?, ?, 'queued', ?, ?, 'queued')
      `).run(id, jobType, datasetVersion, JSON.stringify(request));
    } else {
      this.database.prepare(`
        INSERT INTO recompute_jobs (
          id, job_type, status, dataset_version, request_json, progress_phase, ${bindingColumns.join(", ")}
        ) VALUES (?, ?, 'queued', ?, ?, 'queued', ${bindingColumns.map(() => "?").join(", ")})
      `).run(id, jobType, datasetVersion, JSON.stringify(request), ...bindingValues);
    }
    this.logEvent(id, "queued", 0, 0, "Task queued");
    return id;
  }

  get(id: string): RecomputeJob | null {
    const row = this.database.prepare("SELECT * FROM recompute_jobs WHERE id = ?").get(id) as unknown as
      | Record<string, unknown>
      | undefined;
    return row ? this.map(row) : null;
  }

  /** True when a queued or claimed task exists; callers use it to skip idle work. */
  hasPending(): boolean {
    return Boolean(this.database.prepare(
      "SELECT 1 FROM recompute_jobs WHERE status IN ('queued', 'running') LIMIT 1"
    ).get());
  }

  claimNext(): RecomputeJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT id FROM recompute_jobs
        WHERE status = 'queued'
        ORDER BY created_at, rowid
        LIMIT 1
      `).get() as unknown as { id: string } | undefined;
      if (!row) {
        this.database.exec("COMMIT");
        return null;
      }
      this.database.prepare(`
        UPDATE recompute_jobs
        SET status = 'running', started_at = ?, progress_phase = 'claimed'
        WHERE id = ? AND status = 'queued'
      `).run(appNow(), row.id);
      this.logEvent(row.id, "claimed", 0, 0, "Single worker claimed task");
      this.database.exec("COMMIT");
      return this.get(row.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  requestCancellation(jobId: string): JobCancellationResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const job = this.database.prepare("SELECT status FROM recompute_jobs WHERE id = ?")
        .get(jobId) as unknown as { status: string } | undefined;
      if (!job) {
        this.database.exec("COMMIT");
        return { outcome: "not_found" };
      }
      if (job.status === "queued") {
        this.database.prepare(`
          UPDATE recompute_jobs
          SET status = 'cancelled', completed_at = ?, progress_phase = 'cancelled',
              cancel_requested = 0
          WHERE id = ? AND status = 'queued'
        `).run(appNow(), jobId);
        this.logEvent(jobId, "cancelled", 0, 0, "Queued task cancelled before execution");
        this.database.exec("COMMIT");
        return { outcome: "cancelled", status: "cancelled", cancelRequested: false };
      }
      if (job.status === "running") {
        this.database.prepare("UPDATE recompute_jobs SET cancel_requested = 1 WHERE id = ?").run(jobId);
        this.database.exec("COMMIT");
        return { outcome: "cancellation_requested", status: "running", cancelRequested: true };
      }
      this.database.exec("COMMIT");
      return { outcome: "terminal" };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recoverInterrupted(): number {
    const now = appNow();
    const failure = JSON.stringify({
      name: "InterruptedRecompute",
      message: "Local API restarted before the recompute completed"
    });
    // 🔴 外部所有者类型（CLI 导入）的中断原因必须**中立且准确**。
    // 复用上面那条 recompute 文案会写出假话：那条导入任务不是 recompute，
    // 真因是**拥有它的那个进程崩了**，与"API 重启"无关。
    // （这正是本次修复要消除的"用户看到错误原因"，只是下沉到了文案层 ——
    //  由一条测试钉住文案，所以文案本身也是判据，不能随手复用。）
    const externalInterrupted = JSON.stringify({
      name: "InterruptedExternalJob",
      message: "Job was interrupted before its owning process completed it"
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const jobs = this.database.prepare(`
        SELECT id, job_type AS jobType, request_json AS requestJson,
          feature_run_id AS featureRunId, model_run_id AS modelRunId,
          cancel_requested AS cancelRequested
        FROM recompute_jobs WHERE status = 'running' ORDER BY created_at
      `).all() as unknown as Array<{
        id: string;
        jobType: string;
        requestJson: string | null;
        featureRunId: string | null;
        modelRunId: string | null;
        cancelRequested: number;
      }>;
      if (jobs.length === 0) {
        this.database.exec("COMMIT");
        return 0;
      }
      for (const job of jobs) {
        this.failAssociatedRuns(job.featureRunId, job.modelRunId, now, failure);
        const cancelled = job.cancelRequested === 1;
        // 🔴 恢复必须按"**谁能执行**"分派，而不是按"是不是 running"，**也不能只按 job_type**。
        // `'import'` 是两个所有者共用的类型名：CLI 导入进程写它，直连车道登记的分析任务也写它
        // （v35 不允许放宽 `job_type` 的 CHECK，见 `payload-scoped` 的说明）。所以判据是
        // `(job_type, 载荷 mode)` 的合取 —— `isApplicationConsumableJob` 是这条判据的**唯一**实现，
        // 消费端读同一个函数，两边不可能分叉。
        // 不属于应用消费者的任务如果被放回 `queued`，唯一那个消费者会领走它并
        // 以"不支持的作业类型/载荷"置为失败，同时**原始的中断原因被这里清掉** —— 用户看到一条
        // 原因错误的失败任务。它们没有别的消费者，中断即终态：判为失败并保留中断原因。
        const consumable = isApplicationConsumableJob(job.jobType, job.requestJson);
        // 非取消的中断：可消费类型带上 recompute 文案，外部所有者类型带上中立文案。
        const interruptedReason = consumable || cancelled ? failure : externalInterrupted;
        const changed = this.database.prepare(`
          UPDATE recompute_jobs
          SET status = ?, started_at = NULL, completed_at = ?, progress_phase = ?,
              progress_current = 0, progress_total = 0, cancel_requested = 0, error_json = ?
          WHERE id = ? AND status = 'running' AND cancel_requested = ?
        `).run(
          cancelled ? "cancelled" : consumable ? "queued" : "failed",
          cancelled || !consumable ? now : null,
          cancelled ? "cancelled" : consumable ? "recovered" : "interrupted",
          cancelled || !consumable ? interruptedReason : null,
          job.id,
          job.cancelRequested
        );
        if (Number(changed.changes) !== 1) {
          throw new Error(`Recompute job ${job.id} changed while recovering`);
        }
        this.logEvent(
          job.id,
          cancelled ? "cancelled" : consumable ? "recovered" : "failed",
          0,
          0,
          cancelled
            ? "Interrupted task was cancelled"
            : consumable
              ? "Interrupted task returned to the queue"
              : "Interrupted task has no consumer for its job type and payload; marked failed instead of re-queued",
          now
        );
      }
      this.database.exec("COMMIT");
      return jobs.length;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  cancelIfRequested(jobId: string): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT status, cancel_requested AS cancelRequested,
          progress_current AS progressCurrent, progress_total AS progressTotal
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as unknown as {
        status: string;
        cancelRequested: number;
        progressCurrent: number;
        progressTotal: number;
      } | undefined;
      if (row?.status !== "running" || row.cancelRequested !== 1) {
        this.database.exec("COMMIT");
        return false;
      }
      const changed = this.database.prepare(`
        UPDATE recompute_jobs
        SET status = 'cancelled', completed_at = ?, progress_phase = 'cancelled',
            cancel_requested = 0, error_json = NULL
        WHERE id = ? AND status = 'running' AND cancel_requested = 1
      `).run(appNow(), jobId);
      if (Number(changed.changes) !== 1) throw new Error("Recompute job changed while cancelling");
      this.logEvent(jobId, "cancelled", row.progressCurrent, row.progressTotal, "Task cancelled");
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  setRunIds(jobId: string, featureRunId: string | null, modelRunId: string | null): void {
    this.database.prepare(`
      UPDATE recompute_jobs
      SET feature_run_id = COALESCE(?, feature_run_id),
          model_run_id = COALESCE(?, model_run_id)
      WHERE id = ?
    `).run(featureRunId, modelRunId, jobId);
  }

  updateProgress(jobId: string, phase: string, current: number, total: number, message: string): void {
    this.database.prepare(`
      UPDATE recompute_jobs
      SET progress_phase = ?, progress_current = ?, progress_total = ?
      WHERE id = ?
    `).run(phase, current, total, jobId);
    this.logEvent(jobId, phase, current, total, message);
  }

  complete(
    jobId: string,
    phase: string,
    current: number,
    total: number,
    message: string,
    beforeComplete?: () => void
  ): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const job = this.database.prepare(`
        SELECT status, cancel_requested AS cancelRequested
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as unknown as {
        status: string;
        cancelRequested: number;
      } | undefined;
      if (job?.status !== "running") {
        this.database.exec("COMMIT");
        return false;
      }
      if (job.cancelRequested === 1) {
        const progress = this.database.prepare(`
          SELECT progress_current AS progressCurrent, progress_total AS progressTotal
          FROM recompute_jobs WHERE id = ?
        `).get(jobId) as unknown as { progressCurrent: number; progressTotal: number };
        const changed = this.database.prepare(`
          UPDATE recompute_jobs
          SET status = 'cancelled', completed_at = ?, progress_phase = 'cancelled',
              cancel_requested = 0, error_json = NULL
          WHERE id = ? AND status = 'running' AND cancel_requested = 1
        `).run(appNow(), jobId);
        if (Number(changed.changes) !== 1) throw new Error("Recompute job changed while completing cancellation");
        this.logEvent(
          jobId,
          "cancelled",
          progress.progressCurrent,
          progress.progressTotal,
          "Task cancelled"
        );
        this.database.exec("COMMIT");
        return false;
      }
      beforeComplete?.();
      const changed = this.database.prepare(`
        UPDATE recompute_jobs
        SET status = 'succeeded', completed_at = ?, progress_phase = ?,
            progress_current = ?, progress_total = ?, cancel_requested = 0
        WHERE id = ? AND status = 'running' AND cancel_requested = 0
      `).run(appNow(), phase, current, total, jobId);
      if (Number(changed.changes) !== 1) throw new Error("Recompute job changed while completing");
      this.logEvent(jobId, phase, current, total, message);
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  fail(jobId: string, error: unknown): void {
    const payload = this.errorPayload(error);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare(`
        SELECT status, cancel_requested AS cancelRequested,
               progress_current AS progressCurrent, progress_total AS progressTotal,
               feature_run_id AS featureRunId, model_run_id AS modelRunId
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as unknown as {
        status: string;
        cancelRequested: number;
        progressCurrent: number;
        progressTotal: number;
        featureRunId: string | null;
        modelRunId: string | null;
      } | undefined;
      if (current?.status !== "running") {
        this.database.exec("COMMIT");
        return;
      }

      const now = appNow();
      this.failAssociatedRuns(
        current.featureRunId,
        current.modelRunId,
        now,
        JSON.stringify(payload)
      );
      const cancelled = current.cancelRequested === 1;
      const phase = cancelled ? "cancelled" : "failed";
      const changed = this.database.prepare(`
        UPDATE recompute_jobs
        SET status = ?, completed_at = ?, progress_phase = ?, cancel_requested = 0,
            error_json = ?
        WHERE id = ? AND status = 'running' AND cancel_requested = ?
      `).run(
        cancelled ? "cancelled" : "failed",
        now,
        phase,
        cancelled ? null : JSON.stringify(payload),
        jobId,
        current.cancelRequested
      );
      if (Number(changed.changes) !== 1) throw new Error("Recompute job changed while failing");
      this.logEvent(
        jobId,
        phase,
        current.progressCurrent,
        current.progressTotal,
        cancelled ? "Task cancelled" : "Task failed"
      );
      this.database.exec("COMMIT");
    } catch (transactionError) {
      this.database.exec("ROLLBACK");
      throw transactionError;
    }
  }

  failOutstanding(error: unknown): number {
    const jobs = this.database.prepare(`
      SELECT id, status FROM recompute_jobs
      WHERE status IN ('queued', 'running')
      ORDER BY created_at, rowid
    `).all() as unknown as Array<{ id: string; status: string }>;
    for (const job of jobs) {
      if (job.status === "running") this.fail(job.id, error);
      else this.failQueued(job.id, error);
    }
    return jobs.length;
  }

  logEvent(
    jobId: string,
    phase: string,
    current: number,
    total: number,
    message: string,
    createdAt?: string
  ): void {
    this.database.prepare(`
      INSERT INTO recompute_job_events (
        id, job_id, phase, progress_current, progress_total, message${createdAt ? ", created_at" : ""}
      ) VALUES (?, ?, ?, ?, ?, ?${createdAt ? ", ?" : ""})
    `).run(opaqueId("recompute_job_event"), jobId, phase, current, total, message, ...(createdAt ? [createdAt] : []));
  }

  list(limit = 30, activeOnly = false): RecomputeJob[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM recompute_jobs
        ${activeOnly ? "WHERE status IN ('queued', 'running')" : ""}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(limit) as unknown as Record<string, unknown>[];
    return rows.map((row) => this.map(row));
  }

  listEvents(jobId: string): Array<Record<string, unknown>> {
    return this.database
      .prepare("SELECT * FROM recompute_job_events WHERE job_id = ? ORDER BY created_at, id")
      .all(jobId) as unknown as Array<Record<string, unknown>>;
  }

  private failQueued(jobId: string, error: unknown): void {
    const payload = this.errorPayload(error);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare(`
        SELECT status, progress_current AS progressCurrent, progress_total AS progressTotal
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as unknown as {
        status: string;
        progressCurrent: number;
        progressTotal: number;
      } | undefined;
      if (current?.status !== "queued") {
        this.database.exec("COMMIT");
        return;
      }
      const changed = this.database.prepare(`
        UPDATE recompute_jobs
        SET status = 'failed', completed_at = ?, progress_phase = 'failed',
            cancel_requested = 0, error_json = ?
        WHERE id = ? AND status = 'queued'
      `).run(appNow(), JSON.stringify(payload), jobId);
      if (Number(changed.changes) !== 1) throw new Error("Recompute job changed while failing queued task");
      this.logEvent(jobId, "failed", current.progressCurrent, current.progressTotal, "Task failed");
      this.database.exec("COMMIT");
    } catch (transactionError) {
      this.database.exec("ROLLBACK");
      throw transactionError;
    }
  }

  private failAssociatedRuns(
    featureRunId: string | null,
    modelRunId: string | null,
    now: string,
    failure: string
  ): void {
    if (featureRunId) {
      this.database.prepare(`
        UPDATE feature_runs SET status = 'failed', completed_at = ?, failure_json = ?
        WHERE id = ? AND status = 'running'
      `).run(now, failure, featureRunId);
    }
    if (modelRunId) {
      this.database.prepare(`
        UPDATE training_metric_runs SET status = 'failed', completed_at = ?, failure_json = ?
        WHERE model_run_id = ? AND status = 'running'
      `).run(now, failure, modelRunId);
      this.database.prepare(`
        UPDATE model_runs SET status = 'failed', completed_at = ?, failure_json = ?
        WHERE id = ? AND status = 'running'
      `).run(now, failure, modelRunId);
    }
  }

  private errorPayload(error: unknown): { message: string; name: string } {
    return {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error"
    };
  }

  private map(row: Record<string, unknown>): RecomputeJob {
    return {
      id: String(row.id),
      jobType: String(row.job_type) as RecomputeJobType,
      status: String(row.status) as RunStatus,
      datasetVersion: typeof row.dataset_version === "string" ? row.dataset_version : null,
      featureRunId: typeof row.feature_run_id === "string" ? row.feature_run_id : null,
      modelRunId: typeof row.model_run_id === "string" ? row.model_run_id : null,
      request: parseJson(String(row.request_json), {}),
      progressPhase: String(row.progress_phase),
      progressCurrent: Number(row.progress_current),
      progressTotal: Number(row.progress_total),
      cancelRequested: Number(row.cancel_requested) === 1,
      error: parseJson<Record<string, unknown> | null>(
        typeof row.error_json === "string" ? row.error_json : null,
        null
      ),
      createdAt: String(row.created_at),
      startedAt: typeof row.started_at === "string" ? row.started_at : null,
      completedAt: typeof row.completed_at === "string" ? row.completed_at : null
    };
  }
}
