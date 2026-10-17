import type { DatabaseSync } from "node:sqlite";

import {
  DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
  dependencyCoverageHolds,
  isApplicationConsumableJob,
  selectInterveningBatches,
  type BatchGenerationFacts,
  type RecomputeJob,
  type RecomputeJobType,
  type RunStatus
} from "@rai/contracts";

import { appNow, opaqueId, parseJson } from "./utils.js";
import {
  isRetryableJobFailure,
  RETRYABLE_JOB_ATTEMPT_LIMIT,
  withDatabaseTransaction
} from "./transaction.js";
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

/**
 * 合并关联的三种状态（v42 `analysis_job_merges.state` 的 `CHECK` 取值）。
 *
 * 🔴 刻意**不是** `recompute_jobs.status` 的取值：v35 明令禁止放宽那个枚举（iOS 消费它），
 * 所以被覆盖任务的真实状态仍然是 `queued` —— "它被接管了"这件事只住在关联表里。
 */
export type AnalysisJobMergeState = "pending" | "published" | "released";

/** 一次覆盖任务最多并入多少条原任务。 */
export const ANALYSIS_JOB_MERGE_MAX_MEMBERS = 32;

/**
 * 参与同一次合并的原任务，登记时刻必须在**最早成员**的这个窗口内。
 *
 * 🔴 这是 B6 的"任务年龄上限"落地形态：不断前进的"最新代次"不能把一条覆盖任务的成员集
 * 无限向后拉（今天到达的批次不该和十分钟前排队的批次共用同一次合并 —— 后者的年龄已经
 * 不值得再等）。窗口之外的成员留给下一次合并，而**最早的那条**永远在成员集里，
 * 所以"最先排队的分析"一定会被调度到。
 */
export const ANALYSIS_JOB_MERGE_MAX_SPAN_MS = 120_000;

/**
 * 一条原任务最多被合并几次；达到上限即**不再参与合并**，必须单独执行。
 *
 * 🔴 这是 B6 的防饿死上限，也是"最小调度份额"的落实：覆盖任务可能因为"这一轮里最新代次
 * 又动了"而发布被拒（真实含义是**重排**，不是成功），如果没有这个上限，同一条原任务会被
 * 无限并进一个又一个覆盖任务、永远拿不到属于自己的那一次执行。达到上限之后它单跑，
 * 于是它一定会走到一个**真结论**（成功发布，或带着自己的真实失败原因失败）。
 */
export const ANALYSIS_JOB_MERGE_MAX_ATTEMPTS = 2;

/** 覆盖任务请求里记录"我代表了哪些原任务"的键（供核对；现有消费方都不读它）。 */
export const ANALYSIS_JOB_MERGE_REQUEST_KEY = "mergedFromJobIds";

/** 覆盖关系的一行（`GET /v1/jobs/:id` 沿它把进度报在原 id 上）。 */
export interface JobCoverageReport {
  coveredJobId: string;
  coveringJobId: string;
  state: AnalysisJobMergeState;
  /** 该原任务代表的那一批（`request.importBatchId`）。 */
  importBatchId: string;
  /** 它被合并过几次（B6 上限判据的账）。 */
  attempts: number;
  coveredDirtyFromAt: string | null;
  mergedDirtyFromAt: string | null;
  settledAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  /** 发布事务里落库的实际绑定摘要（同一覆盖任务的全部成员共享这一份）。 */
  bindingInputDigest: string | null;
  bindingCapturedDependencyGeneration: number | null;
  coveringModelRunId: string | null;
  /** 覆盖任务的行（`null` = 行已被清理）。 */
  covering: RecomputeJob | null;
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
    // 🔴 领取是**一个短事务**：许可必须覆盖 BEGIN…COMMIT，而不是被切成三段
    // （O07：`BEGIN IMMEDIATE` 与写语句、`COMMIT` 处在不同许可窗口时，事务开着而许可已空闲）。
    // 读出 `get()` 放在事务**之后**：读不需要写许可，也不该被算进事务耗时。
    const claimedId = withDatabaseTransaction(this.database, () => {
      // O06-B / WP-40：领取之前先把"兼容的排队批次"合并成**一条**覆盖任务。
      // 位置选在这里是判据的一部分：合并必须在**执行之前**发生（已经跑过的任务不能被
      // 偷换输入），而这是"执行"唯一的那道门。
      this.planCoveringJob();
      const row = this.database.prepare(`
        SELECT job.id FROM recompute_jobs job
        WHERE job.status = 'queued'
          ${this.coveredJobExclusionSql()}
        ORDER BY job.created_at, job.rowid
        LIMIT 1
      `).get() as unknown as { id: string } | undefined;
      if (!row) return null;
      this.database.prepare(`
        UPDATE recompute_jobs
        SET status = 'running', started_at = ?, progress_phase = 'claimed', error_json = NULL
        WHERE id = ? AND status = 'queued'
      `).run(appNow(), row.id);
      this.logEvent(row.id, "claimed", 0, 0, "Single worker claimed task");
      return row.id;
    });
    return claimedId === null ? null : this.get(claimedId);
  }

  /**
   * 已被覆盖**且覆盖任务尚未发布**的任务不得被独立领取。
   *
   * 🔴 为什么不靠 `created_at` 排序来躲开它们：覆盖任务的 `created_at` 取的是最早成员的
   * 时刻，而成员可能与它同毫秒登记（`strftime` 是毫秒精度）—— 那时 `ORDER BY created_at`
   * 会先取到成员行，于是"十条批次只算一份"当场退化成"十条各算一份"。把这个排除写成
   * 结构判据（而不是排序的巧合），是这条保证唯一的落脚点。
   */
  private coveredJobExclusionSql(): string {
    if (!this.mergeTableExists()) return "";
    return `AND NOT EXISTS (
      SELECT 1 FROM analysis_job_merges merge
      WHERE merge.covered_job_id = job.id AND merge.state = 'pending')`;
  }

  /**
   * 沿 v42 的合并关联，把某条任务的覆盖关系读出来（`GET /v1/jobs/:id` 的唯一入口）。
   *
   * `state` 的三个取值含义（也是调用方唯一该看的东西）：
   * - `pending`：覆盖任务还在队列里/正在跑。此时**沿原 id 报告覆盖任务的进度**，
   *   并且不把这条任务当成"已覆盖"；
   * - `published`：覆盖任务真的发布了（同一事务里结算），原任务已经是 `succeeded`；
   * - `released`：覆盖任务失败/取消/被重排过 —— 原任务回到队列，由下一次合并重新规划。
   */
  coveringReport(jobId: string): JobCoverageReport | null {
    if (!this.mergeTableExists()) return null;
    const row = this.database.prepare(`
      SELECT covered_job_id AS coveredJobId, covering_job_id AS coveringJobId, state,
             import_batch_id AS importBatchId, attempts,
             covered_dirty_from_at AS coveredDirtyFromAt, merged_dirty_from_at AS mergedDirtyFromAt,
             settled_at AS settledAt, released_at AS releasedAt, release_reason AS releaseReason,
             binding_input_digest AS bindingInputDigest,
             binding_captured_dependency_generation AS bindingCapturedDependencyGeneration,
             covering_model_run_id AS coveringModelRunId
      FROM analysis_job_merges WHERE covered_job_id = ?
    `).get(jobId) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      coveredJobId: String(row.coveredJobId),
      coveringJobId: String(row.coveringJobId),
      state: String(row.state) as AnalysisJobMergeState,
      importBatchId: String(row.importBatchId),
      attempts: Number(row.attempts),
      coveredDirtyFromAt: typeof row.coveredDirtyFromAt === "string" ? row.coveredDirtyFromAt : null,
      mergedDirtyFromAt: typeof row.mergedDirtyFromAt === "string" ? row.mergedDirtyFromAt : null,
      settledAt: typeof row.settledAt === "string" ? row.settledAt : null,
      releasedAt: typeof row.releasedAt === "string" ? row.releasedAt : null,
      releaseReason: typeof row.releaseReason === "string" ? row.releaseReason : null,
      bindingInputDigest: typeof row.bindingInputDigest === "string" ? row.bindingInputDigest : null,
      bindingCapturedDependencyGeneration:
        integerOrUndefined(row.bindingCapturedDependencyGeneration) ?? null,
      coveringModelRunId: typeof row.coveringModelRunId === "string" ? row.coveringModelRunId : null,
      covering: this.get(String(row.coveringJobId))
    };
  }

  requestCancellation(jobId: string): JobCancellationResult {
    return withDatabaseTransaction(this.database, (): JobCancellationResult => {
      const job = this.database.prepare("SELECT status FROM recompute_jobs WHERE id = ?")
        .get(jobId) as unknown as { status: string } | undefined;
      if (!job) return { outcome: "not_found" };
      if (job.status === "queued") {
        this.database.prepare(`
          UPDATE recompute_jobs
          SET status = 'cancelled', completed_at = ?, progress_phase = 'cancelled',
              cancel_requested = 0
          WHERE id = ? AND status = 'queued'
        `).run(appNow(), jobId);
        this.logEvent(jobId, "cancelled", 0, 0, "Queued task cancelled before execution");
        // 取消的若是覆盖任务 ⇒ 把它名下的被覆盖任务放回队列（否则它们会永远停在
        // "等待一个已经被取消的覆盖任务"上，既跑不了也报不出结论）。
        this.releaseCoveredJobs(jobId, "covering_job_cancelled");
        // 取消的若是一条**被覆盖**任务 ⇒ 释放它自己的关联行：它已经是终态，
        // 再挂着一行 `pending` 会让发布时的结算去改一条已被用户取消的任务。
        this.releaseCoveredJob(jobId, "covered_job_cancelled");
        return { outcome: "cancelled", status: "cancelled", cancelRequested: false };
      }
      if (job.status === "running") {
        this.database.prepare("UPDATE recompute_jobs SET cancel_requested = 1 WHERE id = ?").run(jobId);
        return { outcome: "cancellation_requested", status: "running", cancelRequested: true };
      }
      return { outcome: "terminal" };
    });
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
    return withDatabaseTransaction(this.database, () => {
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
      if (jobs.length === 0) return 0;
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
        // 🔴 只有**回到队列**那一档可以保留 `pending` 关联（覆盖任务会被重新领取并跑完）。
        // 取消与"没有消费者 ⇒ 终态失败"都必须释放：否则被覆盖任务会永远停在一个
        // 再也不会前进的覆盖任务后面（既跑不了，也查不到真结论）。
        if (cancelled) this.releaseCoveredJobs(job.id, "covering_job_recovered_cancelled");
        else if (!consumable) this.releaseCoveredJobs(job.id, "covering_job_recovered_failed");
      }
      return jobs.length;
    });
  }

  cancelIfRequested(jobId: string): boolean {
    return withDatabaseTransaction(this.database, () => {
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
      if (row?.status !== "running" || row.cancelRequested !== 1) return false;
      const changed = this.database.prepare(`
        UPDATE recompute_jobs
        SET status = 'cancelled', completed_at = ?, progress_phase = 'cancelled',
            cancel_requested = 0, error_json = NULL
        WHERE id = ? AND status = 'running' AND cancel_requested = 1
      `).run(appNow(), jobId);
      if (Number(changed.changes) !== 1) throw new Error("Recompute job changed while cancelling");
      this.logEvent(jobId, "cancelled", row.progressCurrent, row.progressTotal, "Task cancelled");
      this.releaseCoveredJobs(jobId, "covering_job_cancelled");
      return true;
    });
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
    // 🔴 发布**必须**与任务结算同事务（`beforeComplete` 里是 `verifyAndPoint` + 指针翻转），
    // 所以它也只能在**一个**许可窗口里 —— 中间换窗口就会露出"指针已动、结算未落"的缝。
    return withDatabaseTransaction(this.database, () => {
      const job = this.database.prepare(`
        SELECT status, cancel_requested AS cancelRequested
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as unknown as {
        status: string;
        cancelRequested: number;
      } | undefined;
      if (job?.status !== "running") return false;
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
        // 取消的覆盖任务没有发布任何东西 ⇒ 被覆盖任务回到队列（它们**不得**被结算）。
        this.releaseCoveredJobs(jobId, "covering_job_completed_cancelled");
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
      // 🔴 O06-B：被覆盖任务**只在覆盖任务真正发布之后**才结算 —— 而且必须在**同一个事务**里
      // （`beforeComplete` 已经跑完：绑定已写、指针已翻）。放在事务外就等于承认
      // "指针动了但成员还没结算"是一个可观测状态，那正是"旧结论当最新展示"的入口。
      this.settleCoveredJobs(jobId);
      return true;
    });
  }

  fail(jobId: string, error: unknown): void {
    const payload = this.errorPayload(error);
    withDatabaseTransaction(this.database, () => {
      const current = this.database.prepare(`
        SELECT status, cancel_requested AS cancelRequested,
               progress_current AS progressCurrent, progress_total AS progressTotal,
               feature_run_id AS featureRunId, model_run_id AS modelRunId,
               attempts
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as unknown as {
        status: string;
        cancelRequested: number;
        progressCurrent: number;
        progressTotal: number;
        featureRunId: string | null;
        modelRunId: string | null;
        attempts: number;
      } | undefined;
      if (current?.status !== "running") return;

      const now = appNow();
      // 半写就的 run 行无论如何都要结算：重排下一次会**新建**一套 run，
      // 留着 'running' 的孤儿行会让"这一轮到底算了什么"再也说不清。
      this.failAssociatedRuns(
        current.featureRunId,
        current.modelRunId,
        now,
        JSON.stringify(payload)
      );

      // 🔴 可重试的调度失败（O07 / D1：写许可等待超时）**不是**终态失败。
      // 把它结算成 `failed` 会让"许可恰好被别人占着"变成用户可见的失败任务；
      // 而"失败开放继续写"（旧行为）又会破坏单写者互斥。第三条路：回到队列、有界重试。
      // 上限必须存在 —— 否则"永远拿不到许可"会变成任务在队列里无限打转、用户看不到结论。
      if (
        isRetryableJobFailure(error)
        && current.cancelRequested !== 1
        && Number(current.attempts) + 1 < RETRYABLE_JOB_ATTEMPT_LIMIT
      ) {
        const requeued = this.database.prepare(`
          UPDATE recompute_jobs
          SET status = 'queued', started_at = NULL, completed_at = NULL,
              progress_phase = 'retry_pending', progress_current = 0, progress_total = 0,
              cancel_requested = 0, error_json = ?, attempts = attempts + 1
          WHERE id = ? AND status = 'running' AND cancel_requested = 0
        `).run(JSON.stringify(payload), jobId);
        if (Number(requeued.changes) !== 1) throw new Error("Recompute job changed while re-queueing");
        this.logEvent(
          jobId,
          "retry_pending",
          0,
          0,
          `Retryable scheduling failure (attempt ${Number(current.attempts) + 1}/${RETRYABLE_JOB_ATTEMPT_LIMIT}): ` +
            payload.message
        );
        return;
      }

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
      // 🔴 终态失败/取消**不得**结算被覆盖任务（那会把"分析没跑成"报成"已覆盖"）。
      // 关联行改成 `released`：原任务回到可领取状态，由下一次合并重新规划 ——
      // "失败"与"重排"在这里保留各自真实含义。
      this.releaseCoveredJobs(jobId, cancelled ? "covering_job_cancelled" : "covering_job_failed");
    });
  }

  /**
   * B03（2026-10-17）：**可重排的输入漂移** —— 把原任务从 `running` 退回 `queued`。
   *
   * ## 为什么不是新建一条后继任务
   *
   * `replanAfterInputDrift` 以前用 `enqueue("import", …)` 建一条新任务，然后原任务被
   * `runNextJob` 的 catch 送进 `fail` ⇒ 客户端手里那个 `analysisJobId` **永久是 failed**，
   * 而真正算完的是另一个 id；回执里的 id 与后来发生的事对不上，客户端也没有任何持久关联
   * 可以沿过去（复查的合成端到端：后继成功、原 job failed、覆盖关联不存在）。
   *
   * 退回队列保住三件事：原 id、原回执、原请求身份。重试次数与新计划写在 `request_json`
   * 里，不改写登记证据。
   *
   * 返回三态而不是 void：调用方必须能区分"已重排（不要抛错）"与"该如实失败"。
   */
  requeueForReplan(
    jobId: string,
    request: object,
    bindings: RecomputeJobBindings,
    reason: string
  ): "requeued" | "cancelled" | "not_running" {
    let outcome: "requeued" | "cancelled" | "not_running" = "not_running";
    withDatabaseTransaction(this.database, () => {
      const current = this.database.prepare(`
        SELECT status, cancel_requested AS cancelRequested,
               feature_run_id AS featureRunId, model_run_id AS modelRunId
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as unknown as {
        status: string;
        cancelRequested: number;
        featureRunId: string | null;
        modelRunId: string | null;
      } | undefined;
      if (current?.status !== "running") return;
      // 取消优先：用户已经要求停，就不要再把它放回队列（否则取消看起来"没生效"）。
      if (current.cancelRequested === 1) {
        outcome = "cancelled";
        return;
      }
      const now = appNow();
      // 这一轮半写就的 run 行必须结算：下一次领取会新建一套，孤儿 'running' 行会让
      // "这一轮到底算了什么"再也说不清（与 `fail` 同一处置）。
      this.failAssociatedRuns(
        current.featureRunId,
        current.modelRunId,
        now,
        JSON.stringify({ name: "InputDriftReplan", message: reason })
      );
      const changed = this.database.prepare(`
        UPDATE recompute_jobs
        SET status = 'queued', started_at = NULL, completed_at = NULL,
            progress_phase = 'replan_pending', progress_current = 0, progress_total = 0,
            cancel_requested = 0, error_json = NULL, attempts = attempts + 1,
            request_json = ?, target_raw_generation = ?, target_dependency_generation = ?,
            expected_incumbent_release_id = ?
        WHERE id = ? AND status = 'running' AND cancel_requested = 0
      `).run(
        JSON.stringify(request),
        bindings.targetRawGeneration ?? null,
        bindings.targetDependencyGeneration ?? null,
        bindings.expectedIncumbentReleaseId ?? null,
        jobId
      );
      if (Number(changed.changes) !== 1) {
        throw new Error("Recompute job changed while re-queueing for replan");
      }
      // 阶段名是**给客户端看的**：`GET /v1/jobs/:id` 在重排周期里应该看到 queued +
      // 明确阶段，而不是提前看到终态 failed。
      this.logEvent(jobId, "replan_pending", 0, 0, reason);
      outcome = "requeued";
    });
    return outcome;
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
    withDatabaseTransaction(this.database, () => {
      const current = this.database.prepare(`
        SELECT status, progress_current AS progressCurrent, progress_total AS progressTotal
        FROM recompute_jobs WHERE id = ?
      `).get(jobId) as unknown as {
        status: string;
        progressCurrent: number;
        progressTotal: number;
      } | undefined;
      if (current?.status !== "queued") return;
      const changed = this.database.prepare(`
        UPDATE recompute_jobs
        SET status = 'failed', completed_at = ?, progress_phase = 'failed',
            cancel_requested = 0, error_json = ?
        WHERE id = ? AND status = 'queued'
      `).run(appNow(), JSON.stringify(payload), jobId);
      if (Number(changed.changes) !== 1) throw new Error("Recompute job changed while failing queued task");
      this.logEvent(jobId, "failed", current.progressCurrent, current.progressTotal, "Task failed");
      // 队列里被整体判失败的覆盖任务同样没有发布任何东西 ⇒ 释放它名下的被覆盖任务。
      this.releaseCoveredJobs(jobId, "covering_job_failed_queued");
    });
  }

  /** v42 关联表是否存在（v42 之前/只读打开的库 ⇒ 一切合并行为**逐字节不发生**）。 */
  private mergeTableExists(): boolean {
    return Boolean(this.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_job_merges'"
    ).get());
  }

  /**
   * **生成覆盖任务**（O06-B 步骤 B1/B2）：把队首那组"真正可合并"的任务并成一条。
   *
   * ## 合并判据（四条，缺一不可）
   *
   * 1. `status='queued'` —— **已经跑过的任务不能偷换输入**。合并只发生在"执行之前"，
   *    而 `claimNext` 是执行唯一的那道门。
   * 2. `job_type='import'` + `request.mode='direct_sync_analysis'` —— 只有"更新**最新**分析"
   *    的直连任务参加。历史**固定截止点**任务（`full_recompute` 自己的 `asOf`）语义不同，
   *    合并它们等于偷换请求语义；它们一律走原路。
   * 3. 登记时就写了**两个目标代次**（v35 绑定列）。没有绑定的任务证明不了"这次发布包含
   *    它的 dirty 范围"（步骤 B5 的判据），因此**不合并**、单独执行。
   * 4. 同一个**合并键**：载荷里除"每批不同"的那几个键之外的部分（时区、feature/model 配置…）
   *    必须逐字相同。scope 由 `mode` 蕴含（应用消费者只登记 `scope='direct-sync'`）。
   *
   * 另外两条上限（B6，见 `ANALYSIS_JOB_MERGE_*` 常量）：成员数、成员时刻跨度；
   * 以及"被合并次数的上限"—— 达到上限的任务**必须单独执行**，不再参与合并。
   *
   * 返回生成/更新的覆盖任务 id；`null` = 这一次没有可合并的东西（一切照旧）。
   */
  private planCoveringJob(): string | null {
    if (!this.mergeTableExists()) return null;
    const candidates = this.database.prepare(`
      SELECT job.id AS id, job.created_at AS createdAt, job.dataset_version AS datasetVersion,
             job.request_json AS requestJson, job.dirty_json AS dirtyJson,
             job.target_raw_generation AS targetRaw,
             job.target_dependency_generation AS targetDependency,
             COALESCE(merge.attempts, 0) AS mergeAttempts
      FROM recompute_jobs job
      LEFT JOIN analysis_job_merges merge ON merge.covered_job_id = job.id
      WHERE job.status = 'queued' AND job.job_type = 'import'
        AND job.cancel_requested = 0
        AND job.target_raw_generation IS NOT NULL
        AND job.target_dependency_generation IS NOT NULL
        ${this.coveredJobExclusionSql()}
      ORDER BY job.created_at, job.rowid
    `).all() as unknown as Array<{
      id: string;
      createdAt: string;
      datasetVersion: string | null;
      requestJson: string | null;
      dirtyJson: string | null;
      targetRaw: number;
      targetDependency: number;
      mergeAttempts: number;
    }>;
    const mergeable = candidates
      .map((row) => this.asMergeCandidate(row))
      .filter((row): row is MergeCandidate => row !== null);
    const head = mergeable[0];
    // 队首那条已达合并次数上限 ⇒ 这一轮不合并：**它必须单独执行**（B6 的最小调度份额）。
    if (head === undefined || head.mergeAttempts >= ANALYSIS_JOB_MERGE_MAX_ATTEMPTS) return null;

    const headTime = Date.parse(head.createdAt);
    const members = mergeable
      .filter((row) => row.mergeKey === head.mergeKey)
      .filter((row) => row.mergeAttempts < ANALYSIS_JOB_MERGE_MAX_ATTEMPTS)
      .filter((row) => Date.parse(row.createdAt) - headTime <= ANALYSIS_JOB_MERGE_MAX_SPAN_MS)
      .slice(0, ANALYSIS_JOB_MERGE_MAX_MEMBERS);
    // 只有一条 ⇒ 没有"合并"这件事：不造覆盖任务（否则队列里会多出一条与它等价的空转任务）。
    if (members.length < 2) return null;

    const batchIds = members.map((row) => row.importBatchId);
    const evidence = this.selectEvidenceBatch(batchIds);
    // 🔴 无法证明"单批证据 ≡ 并集结论"时**不合并**：那样造出来的覆盖任务会让现有业务 gate
    // 看到比并集更宽松的证据（见 selectEvidenceBatch）。宁可少合并一次，不可错放一次。
    if (evidence === null) return null;

    const memberRaw = Math.max(...members.map((row) => row.targetRaw));
    const memberDependency = Math.max(...members.map((row) => row.targetDependency));
    // 目标 = "可一致读取的**最新**依赖代次"；同时**不得低于**任何成员的目标代次 ——
    // 否则覆盖任务承诺的范围反而比它替代的那些任务更小（计数器被重建过的库上会发生）。
    const generations = this.readGenerations() ?? { raw: memberRaw, dependency: memberDependency };
    const target = {
      raw: Math.max(generations.raw, memberRaw),
      dependency: Math.max(generations.dependency, memberDependency)
    };
    const plan = unionDirtyPlan(members);
    const coveringJobId = this.insertCoveringJob(members, plan, evidence, target);
    this.associateCoveredJobs(coveringJobId, members, evidence, plan);
    return coveringJobId;
  }

  /** 一条候选任务的规范化形态；不是"最新分析的直连任务"就返回 `null`（不参加合并）。 */
  private asMergeCandidate(row: {
    id: string;
    createdAt: string;
    datasetVersion: string | null;
    requestJson: string | null;
    dirtyJson: string | null;
    targetRaw: number;
    targetDependency: number;
    mergeAttempts: number;
  }): MergeCandidate | null {
    const request = parseJson<Record<string, unknown>>(row.requestJson, {});
    if (request.mode !== DIRECT_SYNC_ANALYSIS_REQUEST_MODE) return null;
    // 固定截止点（历史语义）一律不参加 —— 即使它混进了直连载荷形态。
    if (request.asOf !== undefined && request.asOf !== null) return null;
    const importBatchId = request.importBatchId;
    if (typeof importBatchId !== "string" || importBatchId.length === 0) return null;
    if (typeof request.timezoneIdentifier !== "string") return null;
    return {
      id: row.id,
      createdAt: row.createdAt,
      datasetVersion: row.datasetVersion,
      request,
      dirtyJson: row.dirtyJson,
      importBatchId,
      targetRaw: Number(row.targetRaw),
      targetDependency: Number(row.targetDependency),
      mergeAttempts: Number(row.mergeAttempts),
      mergeKey: mergeBindingKey(request)
    };
  }

  /**
   * 造覆盖任务行。
   *
   * `created_at` 取**最早成员**的时刻：覆盖任务因此排在"它替代的那一条"的队列位置上，
   * 队列顺序语义（先到先算）不被合并改坏。
   */
  private insertCoveringJob(
    members: readonly MergeCandidate[],
    plan: MergePlan,
    evidence: MergeEvidence,
    generations: { raw: number; dependency: number }
  ): string {
    const id = opaqueId("recompute_job");
    const head = members[0]!;
    const evaluatedAt = appNow();
    const request: Record<string, unknown> = {
      // R02 步骤 3：成员共同的**稳定语义字段**整体带进覆盖任务（时区、feature/model 配置、
      // 任何决定"算什么"的键）。合并键保证全体成员逐字一致；重建时丢字段会让覆盖任务
      // 掉回默认配置 —— 那是对同一批输入换了算法再发布。
      ...stableRequestFields(head.request),
      mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
      // 现有业务 gate（`sourceBackfillEvidence`）读的是**单数** `importBatchId`，
      // 选出来的那一个批次让它的结论与并集一致（见 selectEvidenceBatch）。
      importBatchId: evidence.batchId,
      // 并集本身也落进载荷：诊断与核对读它（消费方不读，行为不变）。
      importBatchIds: evidence.batchIds,
      evaluatedAt,
      timezoneIdentifier: head.request.timezoneIdentifier,
      [ANALYSIS_JOB_MERGE_REQUEST_KEY]: members.map((row) => row.id)
    };
    if (!plan.full && plan.dirtyFromAt !== null) {
      request.incrementalPlan = {
        mode: "partial",
        dirtyFromAt: plan.dirtyFromAt,
        domains: plan.domains
      };
    }
    const datasetVersion = this.manifestDatasetVersion() ?? head.datasetVersion;
    const incumbent = this.database.prepare(
      "SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1"
    ).get() as { modelRunId: string } | undefined;
    this.database.prepare(`
      INSERT INTO recompute_jobs (
        id, job_type, status, dataset_version, request_json, progress_phase,
        target_raw_generation, target_dependency_generation, expected_incumbent_release_id,
        dirty_json, created_at
      ) VALUES (?, 'import', 'queued', ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
      id,
      datasetVersion,
      JSON.stringify(request),
      generations.raw,
      generations.dependency,
      incumbent?.modelRunId ?? null,
      JSON.stringify({
        reasons: evidence.dirtyReasons,
        unknownRecordTypes: evidence.unknownRecordTypes,
        from: plan.full ? null : plan.dirtyFromAt,
        batchIds: evidence.batchIds,
        [ANALYSIS_JOB_MERGE_REQUEST_KEY]: members.map((row) => row.id)
      }),
      head.createdAt
    );
    this.logEvent(
      id,
      "queued",
      0,
      0,
      `Covering analysis task merged from ${members.length} queued tasks ` +
        `(dependency generation ${generations.dependency}; dirty ${plan.full ? "full" : `from ${plan.dirtyFromAt}`})`
    );
    return id;
  }

  /** 逐条建立"原任务 → 覆盖任务"的关联，并在**原任务**上留一条事件（它是被查询的那条）。 */
  private associateCoveredJobs(
    coveringJobId: string,
    members: readonly MergeCandidate[],
    evidence: MergeEvidence,
    plan: MergePlan
  ): void {
    const now = appNow();
    const upsert = this.database.prepare(`
      INSERT INTO analysis_job_merges (
        covered_job_id, covering_job_id, state, scope, import_batch_id,
        covered_dirty_from_at, merged_dirty_from_at,
        covered_target_raw_generation, covered_target_dependency_generation,
        union_batch_ids_json, evidence_json, attempts, created_at
      ) VALUES (?, ?, 'pending', 'direct-sync', ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(covered_job_id) DO UPDATE SET
        covering_job_id = excluded.covering_job_id,
        state = 'pending',
        import_batch_id = excluded.import_batch_id,
        covered_dirty_from_at = excluded.covered_dirty_from_at,
        merged_dirty_from_at = excluded.merged_dirty_from_at,
        covered_target_raw_generation = excluded.covered_target_raw_generation,
        covered_target_dependency_generation = excluded.covered_target_dependency_generation,
        union_batch_ids_json = excluded.union_batch_ids_json,
        evidence_json = excluded.evidence_json,
        attempts = analysis_job_merges.attempts + 1,
        created_at = excluded.created_at,
        settled_at = NULL, released_at = NULL, release_reason = NULL
    `);
    const evidenceJson = JSON.stringify({
      batchIds: evidence.batchIds,
      selectedEvidenceBatch: evidence.batchId,
      evidenceMatchesUnionVerdict: true,
      unionVerdict: evidence.unionVerdict,
      perBatch: evidence.perBatch
    });
    const unionJson = JSON.stringify(evidence.batchIds);
    for (const member of members) {
      upsert.run(
        member.id,
        coveringJobId,
        member.importBatchId,
        memberBoundaries(member.request)?.features ?? null,
        plan.full ? null : plan.dirtyFromAt,
        member.targetRaw,
        member.targetDependency,
        unionJson,
        evidenceJson,
        now
      );
      this.logEvent(
        member.id,
        "merged",
        0,
        0,
        `Task merged into covering analysis task ${coveringJobId} ` +
          `(${evidence.batchIds.length} batches; dirty ${plan.full ? "full" : `from ${plan.dirtyFromAt}`})`,
        now
      );
    }
  }

  /**
   * 结算被覆盖任务：**只在覆盖任务真的发布之后**（`complete()` 的事务里，`beforeComplete` 之后）。
   *
   * ## 判定（步骤 B5；R02 之后"覆盖"的判据是**执行证据**，不是"调度成员清单"）
   *
   * 逐条成员核验，全部成立才结算：
   * 1. 覆盖任务的发布绑定（若存在）证明输入快照**包含**该成员的目标代次
   *    （`captured_raw/dependency >= 成员登记代次`）；
   * 2. 覆盖任务的依赖覆盖证明**在发布时刻仍然成立**
   *    （`dependencyCoverageHolds`，与 `verifyAndPoint` 的 D4 判据同一份实现）：
   *    捕获之后没有任何批次动过分析输入；
   * 3. **并集 ⊆ 发布覆盖记录**（`analysis_job_coverage`）—— 每个成员的批次都必须真的
   *    在执行覆盖清单里。清单由**发布事务里的执行方**写下（`writeAnalysisInputBinding`
   *    写 `capture.mergedBatchIds`）。⛔ 结算在这里**只核验、不写表**：把调度成员写进
   *    覆盖表、再拿同一张表当"已经计算"的证明，是 R02 抓到的循环论证。
   * 4. 执行覆盖证据（v44 `executed_plan_json`）存在时，逐域核验**执行边界**
   *    不晚于成员登记边界（"执行范围确实覆盖了它登记的 dirty"）。该列缺失
   *    （v44 之前的绑定行）⇒ 退回旧判据：合并边界 ≤ 成员边界、且覆盖记录**没有并集之外的批次**。
   *    证据损坏（有值但解不开）⇒ 拒绝，绝不当作"没有证据"放行。
   *
   * 任一条不成立 ⇒ 关联改成 `released`（原任务留在队列，由下一次合并重新规划）。
   * 🔴 绝不因为"覆盖任务被创建了"就结算，也绝不把失败报成覆盖。
   */
  private settleCoveredJobs(coveringJobId: string): void {
    if (!this.mergeTableExists()) return;
    const members = this.database.prepare(`
      SELECT merge.covered_job_id AS coveredJobId, merge.import_batch_id AS importBatchId,
             merge.covered_dirty_from_at AS coveredDirtyFromAt,
             merge.merged_dirty_from_at AS mergedDirtyFromAt,
             merge.covered_target_raw_generation AS coveredTargetRaw,
             merge.covered_target_dependency_generation AS coveredTargetDependency,
             merge.union_batch_ids_json AS unionBatchIdsJson, merge.attempts,
             job.request_json AS coveredRequestJson
      FROM analysis_job_merges merge
      JOIN recompute_jobs job ON job.id = merge.covered_job_id
      WHERE merge.covering_job_id = ? AND merge.state = 'pending'
      ORDER BY merge.created_at, merge.covered_job_id
    `).all(coveringJobId) as unknown as Array<{
      coveredJobId: string;
      importBatchId: string;
      coveredDirtyFromAt: string | null;
      mergedDirtyFromAt: string | null;
      coveredTargetRaw: number;
      coveredTargetDependency: number;
      unionBatchIdsJson: string;
      attempts: number;
      coveredRequestJson: string | null;
    }>;
    if (members.length === 0) return;

    const covering = this.database.prepare(
      "SELECT feature_run_id AS featureRunId, model_run_id AS modelRunId, " +
        "target_dependency_generation AS targetDependency FROM recompute_jobs WHERE id = ?"
    ).get(coveringJobId) as {
      featureRunId: string | null; modelRunId: string | null; targetDependency: number | null;
    } | undefined;
    const binding = covering?.modelRunId === null || covering?.modelRunId === undefined
      ? undefined
      : this.database.prepare(`
          SELECT job_id AS jobId, captured_raw_generation AS capturedRaw,
                 captured_dependency_generation AS capturedDependency,
                 input_digest AS inputDigest, override_digest AS overrideDigest,
                 config_digest AS configDigest, timezone_identifier AS timezoneIdentifier,
                 executed_plan_json AS executedPlanJson
          FROM analysis_run_input_bindings WHERE run_id = ?
        `).get(covering.modelRunId) as {
          jobId: string; capturedRaw: number; capturedDependency: number; inputDigest: string;
          overrideDigest: string; configDigest: string; timezoneIdentifier: string;
          executedPlanJson: string | null;
        } | undefined;
    const coverageVerdict = binding === undefined ? null : this.dependencyCoverageVerdict(binding);
    const now = appNow();
    // 发布的**实际执行覆盖**批次：发布事务里由执行方写的、现有业务 gate／诊断读的那一张表。
    // 这里只读 —— 结算绝不改写它（"先写成员、再拿表当证明"正是 R02 的病灶）。
    const coveredBatches = new Set(
      (this.database.prepare(
        "SELECT import_batch_id AS batchId FROM analysis_job_coverage WHERE job_id = ?"
      ).all(coveringJobId) as unknown as Array<{ batchId: string }>).map((row) => row.batchId)
    );
    // 覆盖清单里的每个批次都必须是真实成功过的批次（执行方写的行同样要过这道；
    // 悬挂/伪造的批次 id 会让"清单 ⊇ 并集"变成空话）。
    const declaredBatches = [...coveredBatches];
    const declaredBatchesAllReal = declaredBatches.length === 0 || Number((this.database.prepare(`
      SELECT COUNT(*) AS n FROM import_batches
      WHERE status = 'succeeded' AND id IN (${declaredBatches.map(() => "?").join(", ")})
    `).get(...declaredBatches) as { n: number }).n) === declaredBatches.length;
    const executed = parseExecutedPlan(binding?.executedPlanJson ?? null);

    const settle = this.database.prepare(`
      UPDATE recompute_jobs
      SET status = 'succeeded', completed_at = ?, progress_phase = 'covered',
          progress_current = 1, progress_total = 1, cancel_requested = 0, error_json = NULL,
          feature_run_id = COALESCE(feature_run_id, ?), model_run_id = COALESCE(model_run_id, ?)
      WHERE id = ? AND status = 'queued'
    `);
    const markSettled = this.database.prepare(`
      UPDATE analysis_job_merges
      SET state = 'published', settled_at = ?, release_reason = NULL,
          binding_job_id = ?, binding_input_digest = ?, binding_override_digest = ?,
          binding_config_digest = ?, binding_timezone_identifier = ?,
          binding_captured_raw_generation = ?, binding_captured_dependency_generation = ?,
          covering_model_run_id = ?
      WHERE covered_job_id = ? AND state = 'pending'
    `);
    for (const member of members) {
      const reasons: string[] = [];
      if (coverageVerdict !== null && !coverageVerdict.holds) {
        reasons.push(`dependency_coverage_${coverageVerdict.reason}`);
      }
      if (binding !== undefined) {
        if (Number(binding.capturedRaw) < Number(member.coveredTargetRaw)) reasons.push("captured_raw_behind");
        if (Number(binding.capturedDependency) < Number(member.coveredTargetDependency)) {
          reasons.push("captured_dependency_behind");
        }
      }
      const union = new Set(parseJson<string[]>(member.unionBatchIdsJson, []));
      // 要求 3：并集的每个批次都必须真的在**实际执行覆盖**清单里（每个成员各自核验，
      // 于是"某个成员的批次没被记"不会被别的成员的成功掩盖）。
      if ([...union].some((batchId) => !coveredBatches.has(batchId))) {
        reasons.push("publication_missing_union_batch");
      }
      if (!coveredBatches.has(member.importBatchId)) reasons.push("publication_missing_covered_batch");
      if (executed === "invalid") {
        // 证据损坏 ≠ 证据缺失："解不开"必须拒绝，绝不当作"老行"退回宽松判据。
        reasons.push("executed_plan_evidence_invalid");
      } else if (typeof executed === "object") {
        // 要求 4（新证据路径）：**执行范围**必须覆盖成员登记的逐域边界。
        //
        // 🔴 B04：`mode: "rebuild"` 意味着这一版是**全量重算** —— 它的执行范围覆盖一切
        // 登记边界，逐域比较没有意义（旧代码要求 `executed.dirtyFromAt !== null` 才比，
        // 但 rebuild 现在显式写 `null`，语义从"未知"变成"覆盖一切"）。这条分支因此只核
        // 批次真实性与下面的 `mode: "partial"` 分支分开，绝不把 rebuild 当成"没证据"。
        const boundaries = executed.mode === "partial"
          ? memberBoundaries(parseJson<Record<string, unknown>>(member.coveredRequestJson, {}))
          : null;
        if (boundaries !== null) {
          for (const domain of ["features", "fitness", "readiness"] as const) {
            const executedBoundary = executed.domains[domain];
            // `null` 域 = 该域全算（覆盖一切边界），不构成"更晚"。
            if (executedBoundary !== null && executedBoundary > boundaries[domain]) {
              reasons.push(`executed_${domain}_range_later_than_covered`);
            }
          }
          if (executed.dirtyFromAt !== null && member.coveredDirtyFromAt !== null
              && executed.dirtyFromAt > member.coveredDirtyFromAt) {
            reasons.push("executed_dirty_range_later_than_covered");
          }
        }
        if (!declaredBatchesAllReal) reasons.push("publication_included_unknown_batches");
      } else {
        // 旧判据（v44 之前的绑定行 / 无绑定）：合并边界 ≤ 成员边界；且覆盖清单**不许**出现并集之外。
        if (
          member.mergedDirtyFromAt !== null
          && (member.coveredDirtyFromAt === null || member.mergedDirtyFromAt > member.coveredDirtyFromAt)
        ) {
          reasons.push("merged_dirty_range_later_than_covered");
        }
        if ([...coveredBatches].some((batchId) => !union.has(batchId))) {
          reasons.push("publication_included_unplanned_batches");
        }
      }
      if (reasons.length > 0) {
        this.releaseCoveredJob(member.coveredJobId, reasons.join(","), now);
        continue;
      }
      const changed = settle.run(
        now,
        covering?.featureRunId ?? null,
        covering?.modelRunId ?? null,
        member.coveredJobId
      );
      if (Number(changed.changes) !== 1) {
        // 成员在合并之后被取消/判失败 ⇒ 不是"已覆盖"，如实释放。
        this.releaseCoveredJob(member.coveredJobId, "covered_job_not_queued", now);
        continue;
      }
      markSettled.run(
        now,
        binding?.jobId ?? null,
        binding?.inputDigest ?? null,
        binding?.overrideDigest ?? null,
        binding?.configDigest ?? null,
        binding?.timezoneIdentifier ?? null,
        binding === undefined ? null : Number(binding.capturedRaw),
        binding === undefined ? null : Number(binding.capturedDependency),
        covering?.modelRunId ?? null,
        member.coveredJobId
      );
      this.logEvent(
        member.coveredJobId,
        "covered",
        1,
        1,
        `Covered by analysis task ${coveringJobId}: its publication captured ` +
          `${binding === undefined ? "a full recompute" : `dependency generation ${Number(binding.capturedDependency)}`}` +
          ` and includes batch ${member.importBatchId}`,
        now
      );
    }
  }

  /** 发布时刻的依赖覆盖证明（与 `verifyAndPoint` 的 D4 判据**同一份实现**、同样的输入装配）。 */
  private dependencyCoverageVerdict(binding: { capturedRaw: number; capturedDependency: number }): {
    holds: boolean;
    reason: string;
  } {
    const generations = this.readGenerations();
    if (generations === null) return { holds: false, reason: "generations_absent" };
    const batches = this.database.prepare(`
      SELECT id AS batchId, raw_generation AS rawGeneration,
             dependency_generation AS dependencyGeneration, dependency_bumped AS dependencyBumped
      FROM import_batches WHERE status = 'succeeded'
    `).all() as unknown as BatchGenerationFacts[];
    const verdict = dependencyCoverageHolds({
      capturedRawGeneration: Number(binding.capturedRaw),
      capturedDependencyGeneration: Number(binding.capturedDependency),
      currentRawGeneration: generations.raw,
      currentDependencyGeneration: generations.dependency,
      interveningBatches: selectInterveningBatches(batches, Number(binding.capturedRaw))
    });
    return { holds: verdict.holds, reason: verdict.reason };
  }

  /**
   * 选出**证据批**：喂给现有业务 gate 单数入参（`request.importBatchId`）的那一个批次。
   *
   * ## 为什么不是"随便挑一个"
   *
   * `sourceBackfillEvidence(importBatchId, …)` 只用**一个**批次算 `preservedAbsent` /
   * `removed*` / `earliestInsertedIsNewGlobalEarliest`，而这三项在发布 gate 里是**放行**
   * （`verifiedBackfill`）的依据。挑错方向会让并集里**别的**批次的删除被藏起来，
   * 于是"真的丢过数据"的漂移被当成纯回填放行 —— 恰恰是 B2 要防的错。
   *
   * 所以挑法是：**让单批证据的判定与并集的判定逐字相同**。
   * - 并集里有任何删除/墓碑 ⇒ 挑一个**有删除的**成员（它 `preservedAbsent=false`，
   *   并集也不可能放行）；
   * - 并集里一条删除都没有 ⇒ 挑**插入全局最早事实**的那一个成员（若存在），
   *   否则挑队首（两种情形下"最早事实"证据都是 false，与并集一致）。
   *
   * 判定不等价（例如账本缺口）时返回 `null` ⇒ 调用方**放弃合并**。宁可少合并一次，
   * 不可放行一次；本函数因此只会**更严格或等价**，不会比并集宽松。
   */
  private selectEvidenceBatch(batchIds: readonly string[]): MergeEvidence | null {
    if (batchIds.length === 0) return null;
    const footprint = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM import_entity_changes
          WHERE batch_id = ? AND entity_kind = 'record' AND change_type = 'removed') AS removedRecords,
        (SELECT COUNT(*) FROM import_entity_changes
          WHERE batch_id = ? AND entity_kind = 'workout' AND change_type = 'removed') AS removedWorkouts,
        (SELECT COUNT(*) FROM import_entity_changes
          WHERE batch_id = ? AND entity_kind = 'activity_summary' AND change_type = 'removed') AS removedActivitySummaries,
        (SELECT COUNT(*) FROM import_entity_tombstones WHERE batch_id = ?) AS tombstones
    `);
    const perBatch: Record<string, PerBatchEvidence> = {};
    for (const batchId of batchIds) {
      const row = footprint.get(batchId, batchId, batchId, batchId) as unknown as {
        removedRecords: number; removedWorkouts: number; removedActivitySummaries: number; tombstones: number;
      };
      perBatch[batchId] = {
        removedRecords: Number(row.removedRecords),
        removedWorkouts: Number(row.removedWorkouts),
        removedActivitySummaries: Number(row.removedActivitySummaries),
        tombstones: Number(row.tombstones)
      };
    }
    const deleting = batchIds.find((batchId) => !preservedAbsent(perBatch[batchId]!));
    // "这条批次插入了当前全局最早的事实" —— 与 `sourceBackfillEvidence` **同一口径**
    // （membership only，不做时间比较）。它决定并集能否拿到 `verifiedBackfill`。
    const earliest = this.database.prepare(`
      SELECT id FROM health_records
      WHERE start_at = (SELECT MIN(start_at) FROM health_records) LIMIT 1
    `).get() as { id: string } | undefined;
    let earliestInserter: string | undefined;
    if (earliest !== undefined) {
      const placeholders = batchIds.map(() => "?").join(", ");
      const row = this.database.prepare(`
        SELECT batch_id AS batchId FROM import_entity_changes
        WHERE entity_kind = 'record' AND change_type = 'inserted' AND entity_id = ?
          AND batch_id IN (${placeholders})
        LIMIT 1
      `).get(earliest.id, ...batchIds) as { batchId: string } | undefined;
      earliestInserter = row?.batchId;
    }
    const unionPreservedAbsent = batchIds.every((batchId) => preservedAbsent(perBatch[batchId]!));
    const unionVerdict = {
      preservedAbsent: unionPreservedAbsent,
      removedRecords: sum(batchIds, (id) => perBatch[id]!.removedRecords),
      removedWorkouts: sum(batchIds, (id) => perBatch[id]!.removedWorkouts),
      removedActivitySummaries: sum(batchIds, (id) => perBatch[id]!.removedActivitySummaries),
      earliestInsertedIsNewGlobalEarliest: earliestInserter !== undefined
    };
    const batchId = deleting ?? earliestInserter ?? batchIds[0]!;
    const selected = perBatch[batchId]!;
    const selectedVerdict = preservedAbsent(selected)
      && selected.removedRecords === 0 && selected.removedWorkouts === 0
      && selected.removedActivitySummaries === 0
      && batchId === earliestInserter;
    const unionWaiver = unionVerdict.preservedAbsent
      && unionVerdict.removedRecords === 0 && unionVerdict.removedWorkouts === 0
      && unionVerdict.removedActivitySummaries === 0
      && unionVerdict.earliestInsertedIsNewGlobalEarliest;
    if (selectedVerdict !== unionWaiver) return null;
    return {
      batchId,
      batchIds: [...batchIds],
      perBatch,
      unionVerdict: { ...unionVerdict, waiverAllowed: unionWaiver },
      dirtyReasons: this.unionDirtyReasons(batchIds),
      unknownRecordTypes: this.unionUnknownRecordTypes(batchIds)
    };
  }

  /** 成员的 `dirty_json.reasons` 的并集（现有任务登记路径写的诊断证据）。 */
  private unionDirtyReasons(batchIds: readonly string[]): string[] {
    return this.unionDirtyField(batchIds, "reasons");
  }

  private unionUnknownRecordTypes(batchIds: readonly string[]): string[] {
    return this.unionDirtyField(batchIds, "unknownRecordTypes");
  }

  private unionDirtyField(batchIds: readonly string[], field: string): string[] {
    const placeholders = batchIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT dirty_json AS dirtyJson FROM recompute_jobs
      WHERE id IN (${placeholders})
    `).all(...batchIds) as unknown as Array<{ dirtyJson: string | null }>;
    const values = new Set<string>();
    for (const row of rows) {
      const parsed = parseJson<Record<string, unknown>>(row.dirtyJson, {});
      const list = parsed[field];
      if (!Array.isArray(list)) continue;
      for (const item of list) if (typeof item === "string") values.add(item);
    }
    return [...values];
  }

  private readGenerations(): { raw: number; dependency: number } | null {
    const row = this.database.prepare(
      "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton = 1"
    ).get() as { raw: number; dependency: number } | undefined;
    const raw = integerOrUndefined(row?.raw);
    const dependency = integerOrUndefined(row?.dependency);
    return raw === undefined || dependency === undefined ? null : { raw, dependency };
  }

  private manifestDatasetVersion(): string | null {
    const row = this.database.prepare(
      "SELECT value FROM import_manifest WHERE key = 'dataset_version'"
    ).get() as { value: string } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  }

  /** 释放某条**覆盖任务**名下的全部 `pending` 关联（失败/取消/重排时调用）。 */
  private releaseCoveredJobs(coveringJobId: string, reason: string, now = appNow()): void {
    if (!this.mergeTableExists()) return;
    const rows = this.database.prepare(`
      SELECT covered_job_id AS coveredJobId FROM analysis_job_merges
      WHERE covering_job_id = ? AND state = 'pending'
    `).all(coveringJobId) as unknown as Array<{ coveredJobId: string }>;
    for (const row of rows) this.releaseCoveredJob(row.coveredJobId, reason, now);
  }

  /** 释放**一条**被覆盖任务的关联行；只在它仍是 `pending` 时生效。 */
  private releaseCoveredJob(coveredJobId: string, reason: string, now = appNow()): boolean {
    if (!this.mergeTableExists()) return false;
    const changed = this.database.prepare(`
      UPDATE analysis_job_merges
      SET state = 'released', released_at = ?, release_reason = ?
      WHERE covered_job_id = ? AND state = 'pending'
    `).run(now, reason, coveredJobId);
    if (Number(changed.changes) !== 1) return false;
    this.logEvent(
      coveredJobId,
      "replan",
      0,
      0,
      `Covering analysis task did not publish (${reason}); this task stays queued for re-planning`,
      now
    );
    return true;
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
    // v35 的三个绑定列（PR5 清单 18）。🔴 **可选字段只在列真的有值时才出现**：
    // v35 之前登记的历史任务这四列是 NULL（`ALTER TABLE ADD COLUMN` 的默认），
    // 于是它们解出 `undefined` —— 与"这条任务不承诺任何代次"是同一件事。
    // 写成 `?? null` 会把"没有绑定"和"绑定到 NULL"混成一个取值，
    // 而"这条任务有没有版本绑定"正是 S3 之后消费方要问的第一个问题。
    const targetRawGeneration = integerOrUndefined(row.target_raw_generation);
    const targetDependencyGeneration = integerOrUndefined(row.target_dependency_generation);
    // 先求值再展开（不直接在展开里调用）：两个 `? :` 各求值一次，读起来也不用数括号。
    const rawBinding = targetRawGeneration === undefined ? {} : { targetRawGeneration };
    const dependencyBinding = targetDependencyGeneration === undefined ? {} : { targetDependencyGeneration };
    const incumbentBinding = typeof row.expected_incumbent_release_id === "string"
      ? { expectedIncumbentReleaseId: row.expected_incumbent_release_id } : {};
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
      completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
      ...rawBinding,
      ...dependencyBinding,
      ...incumbentBinding
    };
  }
}

/**
 * 绑定列的取值归一：列不存在 / 为 NULL / 不是整数 ⇒ `undefined`（"没有绑定"）。
 *
 * 刻意**不**回落成 `0`：`0` 是一个合法的代次（v34 的初始值），
 * 把"没有绑定"读成"绑定到代次 0"会让 `targetDependencyGeneration === 0` 的任务
 * 与老任务无法区分 —— 而 D2 的 `analysisStatus` 派生正是按这个字段筛任务的。
 */
function integerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** 一条可合并候选的规范化形态（见 `asMergeCandidate`）。 */
interface MergeCandidate {
  id: string;
  createdAt: string;
  datasetVersion: string | null;
  request: Record<string, unknown>;
  dirtyJson: string | null;
  importBatchId: string;
  targetRaw: number;
  targetDependency: number;
  mergeAttempts: number;
  /** 同键才可合并（见 `mergeBindingKey`）。 */
  mergeKey: string;
}

/** 合并后的执行计划：`full` ⇒ 不写 `incrementalPlan`（全量重算）。 */
interface MergePlan {
  full: boolean;
  dirtyFromAt: string | null;
  domains: { features: string | null; fitness: string | null; readiness: string | null };
  boundaries: { features: string; fitness: string; readiness: string } | null;
}

/** 单批的删除足迹（与 `sourceBackfillEvidence` 逐列同名同口径）。 */
interface PerBatchEvidence {
  removedRecords: number;
  removedWorkouts: number;
  removedActivitySummaries: number;
  tombstones: number;
}

interface MergeEvidence {
  batchId: string;
  batchIds: string[];
  perBatch: Record<string, PerBatchEvidence>;
  unionVerdict: {
    preservedAbsent: boolean;
    removedRecords: number;
    removedWorkouts: number;
    removedActivitySummaries: number;
    earliestInsertedIsNewGlobalEarliest: boolean;
    waiverAllowed: boolean;
  };
  dirtyReasons: string[];
  unknownRecordTypes: string[];
}

/**
 * 合并键：载荷里**除"每批必然不同"的键之外**的部分，规范化成一条字符串。
 *
 * 进键的是"算什么"（时区、feature/model 配置、以及未来任何新增的语义键）；
 * 出键的是"这一批是谁/什么时候"（`importBatchId`/`evaluatedAt`）与**执行期才决定**的
 * `incrementalPlan`（并集计划由成员边界算出，见 `unionDirtyPlan`）。
 *
 * 🔴 这条判据必须是**白名单式**的：新加一个语义键而忘了进键，会让"不同配置的两条任务"
 * 被并成一次计算 —— 那正是"配置变更必须拒绝旧候选"的反面。所以默认**进键**，
 * 只有下面这份显式清单里的键才被排除。
 */
const MERGE_VOLATILE_REQUEST_KEYS = new Set([
  "importBatchId",
  "importBatchIds",
  "evaluatedAt",
  "incrementalPlan",
  ANALYSIS_JOB_MERGE_REQUEST_KEY
]);

/**
 * 载荷里**稳定**的语义字段（除易变键之外的全部）。
 *
 * 两个用途共用这一份实现：
 * - `mergeBindingKey` 用它算"同一次合并"的键；
 * - `insertCoveringJob` 把它整体带进覆盖任务 —— 重建请求时**不得**丢掉成员的
 *   语义字段（时区、feature/model 配置…）；丢掉会让覆盖任务掉回默认配置，
 *   等于对一批"声明了非默认配置"的输入换了个算法再发布。
 */
function stableRequestFields(request: Record<string, unknown>): Record<string, unknown> {
  const stable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (MERGE_VOLATILE_REQUEST_KEYS.has(key)) continue;
    stable[key] = value;
  }
  return stable;
}

function mergeBindingKey(request: Record<string, unknown>): string {
  return canonicalJson(stableRequestFields(request));
}

/** 稳定序列化（键排序）：同样的载荷永远得到同样的键，不受属性顺序影响。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 一条成员任务**登记时**的脏边界（`null` = 它本来就是全量）。
 *
 * 分域缺项时回落该成员自己的 `features` 边界（与 pipeline 的
 * `plan.domains ? plan.domains.features : plan.dirtyFromAt` 同口径的保守取法）。
 */
function memberBoundaries(
  request: Record<string, unknown>
): { features: string; fitness: string; readiness: string } | null {
  const plan = request.incrementalPlan as
    | { mode?: unknown; dirtyFromAt?: unknown; domains?: { features?: unknown; fitness?: unknown; readiness?: unknown } }
    | undefined;
  if (plan === undefined || plan === null || plan.mode !== "partial") return null;
  const features = typeof plan.dirtyFromAt === "string" ? plan.dirtyFromAt : undefined;
  if (features === undefined || features.length === 0) return null;
  const domains = plan.domains;
  const pick = (value: unknown): string => (typeof value === "string" && value.length > 0 ? value : features);
  return {
    features: domains === undefined ? features : pick(domains.features),
    fitness: domains === undefined ? features : pick(domains.fitness),
    readiness: domains === undefined ? features : pick(domains.readiness)
  };
}

/**
 * 解析发布事务写下的执行覆盖证据（v44 `executed_plan_json`）。
 *
 * 三态（区分本身是判据："损坏当作缺失"必须被拒绝）：
 * - `"absent"`：绑定行没有这份证据（v44 之前的行 / 无绑定）⇒ 调用方退回旧判据；
 * - `"invalid"`：有值但解不开 / 形状不对 ⇒ 调用方**拒绝**（绝不按"没证据"放行）；
 * - 其余：执行计划（`dirtyFromAt` 与逐域边界，`null` 域 = 该域全算、覆盖一切边界）。
 */
function parseExecutedPlan(json: string | null):
  | "absent"
  | "invalid"
  | {
      mode: "partial" | "rebuild";
      dirtyFromAt: string | null;
      domains: { features: string | null; fitness: string | null; readiness: string | null };
    } {
  if (json === null) return "absent";
  try {
    const parsed = JSON.parse(json) as {
      version?: unknown;
      mode?: unknown;
      dirtyFromAt?: unknown;
      domains?: { features?: unknown; fitness?: unknown; readiness?: unknown };
    } | null;
    if (parsed === null || typeof parsed !== "object") return "invalid";
    const pick = (value: unknown): string | null =>
      value === null || value === undefined || typeof value !== "string" || value.length === 0
        ? null
        : value;
    const dirtyFromAt = pick(parsed.dirtyFromAt);
    const domains = {
      features: pick(parsed.domains?.features),
      fitness: pick(parsed.domains?.fitness),
      readiness: pick(parsed.domains?.readiness)
    };
    // 旧形状（v44 首版，无 version/mode）：按边界推断模式。全空 = 旧版全量（覆盖一切），
    // 否则按 `partial` 逐域核验 —— 两种解释都不比原判据宽松。
    if (parsed.version === undefined && parsed.mode === undefined) {
      const rebuild = dirtyFromAt === null && domains.features === null
        && domains.fitness === null && domains.readiness === null;
      return { mode: rebuild ? "rebuild" : "partial", dirtyFromAt, domains };
    }
    // 🔴 B04：版本或模式不认识 ⇒ **失败关闭**。缺字段不能被解释成"该域全部算过"。
    if (parsed.version !== 1) return "invalid";
    if (parsed.mode !== "partial" && parsed.mode !== "rebuild") return "invalid";
    if (parsed.mode === "rebuild") {
      // `rebuild` 的边界必须为空。带了具体边界说明生产端与判据已经分叉 —— 不猜哪一边对。
      if (dirtyFromAt !== null || domains.features !== null
          || domains.fitness !== null || domains.readiness !== null) {
        return "invalid";
      }
      return {
        mode: "rebuild",
        dirtyFromAt: null,
        domains: { features: null, fitness: null, readiness: null }
      };
    }
    return { mode: "partial", dirtyFromAt, domains };
  } catch {
    return "invalid";
  }
}

/**
 * 并集计划：**任一成员是全量 ⇒ 并集全量**（它的边界不可知，只重算一部分就会错复用）；
 * 否则逐域取**最早的**边界（B2 的"dirty 边界取所有成员的最早值"）。
 *
 * 早边界一定覆盖晚边界：一条成员任务的边界就是它自己那批变更时刻回退后的下界，
 * 取 min 之后覆盖"所有成员的变更时刻"，所以删除/来源更正证据也随之取到并集
 * （删除只有旧侧区间，已在该成员的边界里）。
 */
function unionDirtyPlan(members: readonly MergeCandidate[]): MergePlan {
  const boundaries = members.map((member) => memberBoundaries(member.request));
  if (boundaries.some((value) => value === null)) {
    return {
      full: true,
      dirtyFromAt: null,
      domains: { features: null, fitness: null, readiness: null },
      boundaries: null
    };
  }
  const known = boundaries as Array<{ features: string; fitness: string; readiness: string }>;
  const earliest = (key: "features" | "fitness" | "readiness"): string =>
    known.map((value) => value[key]).reduce((left, right) => (left <= right ? left : right));
  const domains = {
    features: earliest("features"),
    fitness: earliest("fitness"),
    readiness: earliest("readiness")
  };
  return {
    full: false,
    // 顶层 `dirtyFromAt` 与登记路径同口径（= features 边界）；真正的分域边界在 `domains` 里。
    dirtyFromAt: domains.features,
    domains,
    boundaries: domains
  };
}

function preservedAbsent(evidence: PerBatchEvidence): boolean {
  return evidence.removedRecords === 0 && evidence.removedWorkouts === 0
    && evidence.removedActivitySummaries === 0 && evidence.tombstones === 0;
}

function sum(batchIds: readonly string[], pick: (batchId: string) => number): number {
  return batchIds.reduce((total, batchId) => total + pick(batchId), 0);
}

