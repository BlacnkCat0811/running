import type { DatabaseSync } from "node:sqlite";

import type { RecomputeJob, RecomputeJobType, RunStatus } from "@rai/contracts";

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

export class RecomputeJobRepository {
  constructor(private readonly database: DatabaseSync) {}

  enqueue(jobType: RecomputeJobType, datasetVersion: string | null, request: object): string {
    const id = opaqueId("recompute_job");
    this.database.prepare(`
      INSERT INTO recompute_jobs (
        id, job_type, status, dataset_version, request_json, progress_phase
      ) VALUES (?, ?, 'queued', ?, ?, 'queued')
    `).run(id, jobType, datasetVersion, JSON.stringify(request));
    this.logEvent(id, "queued", 0, 0, "Task queued");
    return id;
  }

  get(id: string): RecomputeJob | null {
    const row = this.database.prepare("SELECT * FROM recompute_jobs WHERE id = ?").get(id) as unknown as
      | Record<string, unknown>
      | undefined;
    return row ? this.map(row) : null;
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
    const jobs = this.database.prepare(`
      SELECT id, feature_run_id AS featureRunId, model_run_id AS modelRunId,
        cancel_requested AS cancelRequested
      FROM recompute_jobs WHERE status = 'running' ORDER BY created_at
    `).all() as unknown as Array<{
      id: string;
      featureRunId: string | null;
      modelRunId: string | null;
      cancelRequested: number;
    }>;
    if (jobs.length === 0) return 0;
    const now = appNow();
    const failure = JSON.stringify({
      name: "InterruptedRecompute",
      message: "Local API restarted before the recompute completed"
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const job of jobs) {
        if (job.featureRunId) {
          this.database.prepare(`
            UPDATE feature_runs SET status = 'failed', completed_at = ?, failure_json = ?
            WHERE id = ? AND status = 'running'
          `).run(now, failure, job.featureRunId);
        }
        if (job.modelRunId) {
          this.database.prepare(`
            UPDATE training_metric_runs SET status = 'failed', completed_at = ?, failure_json = ?
            WHERE model_run_id = ? AND status = 'running'
          `).run(now, failure, job.modelRunId);
          this.database.prepare(`
            UPDATE model_runs SET status = 'failed', completed_at = ?, failure_json = ?
            WHERE id = ? AND status = 'running'
          `).run(now, failure, job.modelRunId);
        }
        const cancelled = job.cancelRequested === 1;
        this.database.prepare(`
          UPDATE recompute_jobs
          SET status = ?, started_at = NULL, completed_at = ?, progress_phase = ?,
              progress_current = 0, progress_total = 0, cancel_requested = 0,
              error_json = ?
          WHERE id = ?
        `).run(
          cancelled ? "cancelled" : "queued",
          cancelled ? now : null,
          cancelled ? "cancelled" : "recovered",
          cancelled ? failure : null,
          job.id
        );
        this.logEvent(
          job.id,
          cancelled ? "cancelled" : "recovered",
          0,
          0,
          cancelled ? "Interrupted task was cancelled" : "Interrupted task returned to the queue",
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
    const row = this.database.prepare(
      "SELECT cancel_requested AS cancelRequested FROM recompute_jobs WHERE id = ?"
    ).get(jobId) as unknown as { cancelRequested: number } | undefined;
    if (row?.cancelRequested !== 1) return false;
    this.database.prepare(`
      UPDATE recompute_jobs
      SET status = 'cancelled', completed_at = ?, progress_phase = 'cancelled',
          cancel_requested = 0
      WHERE id = ?
    `).run(appNow(), jobId);
    return true;
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

  complete(jobId: string, phase: string, current: number, total: number, message: string): void {
    this.database.prepare(`
      UPDATE recompute_jobs
      SET status = 'succeeded', completed_at = ?, progress_phase = ?,
          progress_current = ?, progress_total = ?
      WHERE id = ?
    `).run(appNow(), phase, current, total, jobId);
    this.logEvent(jobId, phase, current, total, message);
  }

  fail(jobId: string, error: unknown): void {
    const current = this.get(jobId);
    if (current?.status === "cancelled") {
      this.logEvent(jobId, "cancelled", current.progressCurrent, current.progressTotal, "Task cancelled");
      return;
    }
    const payload = {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error"
    };
    this.database.prepare(`
      UPDATE recompute_jobs
      SET status = 'failed', completed_at = ?, error_json = ?
      WHERE id = ?
    `).run(appNow(), JSON.stringify(payload), jobId);
    this.logEvent(jobId, "failed", 0, 0, "Task failed");
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
