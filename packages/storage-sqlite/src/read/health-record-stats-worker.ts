import { Worker } from "node:worker_threads";

import type { DatabaseSync } from "node:sqlite";

import {
  healthRecordDurationCache,
  readHealthRecordOverlapDatabaseState,
  type HealthRecordDurationCache,
  type HealthRecordOverlapDatabaseState,
  type HealthRecordOverlapStats
} from "./health-record-overlap-reads.js";

const WORKER_URL = new URL("./health-record-stats-worker-thread.mjs", import.meta.url);
const WARM_TYPES = [
  "HKQuantityTypeIdentifierHeartRate",
  "HKQuantityTypeIdentifierRunningSpeed",
  "HKQuantityTypeIdentifierStepCount"
] as const;

interface PendingJob {
  type: string;
  state: HealthRecordOverlapDatabaseState;
}

interface WorkerSlot {
  readonly worker: Worker;
  inFlight: PendingJob | null;
}

export type HealthRecordStatsWorkerFactory = (path: string) => Worker;

/**
 * Request-external rebuild for {@link HealthRecordDurationCache}.
 *
 * The minimal B trial (no rebuild) makes every mid/old window pay the adaptive
 * scan after any commit. This worker keeps the bounded hot path recoverable
 * without blocking the API main thread: a miss only enqueues a job; the worker's
 * own read-only connection computes the type stats; the result is installed only
 * when the main connection's captured `(data_version, total_changes)` is still
 * current. A commit/replacement in between discards the result.
 *
 * One worker (and one read-only connection) per store; queue deduplicates types;
 * `close()` terminates it. It never writes and never holds a read lease past the
 * store's lifetime.
 */
export class HealthRecordOverlapStatsWorker {
  private workerSlot: WorkerSlot | null = null;
  private readonly queue: PendingJob[] = [];
  private closed = false;
  private readonly unsubscribe: () => void;
  private readonly createWorker: HealthRecordStatsWorkerFactory;

  constructor(
    private readonly path: string,
    private readonly database: DatabaseSync,
    private readonly cache: HealthRecordDurationCache = healthRecordDurationCache,
    createWorker: HealthRecordStatsWorkerFactory = (databasePath) => new Worker(
      WORKER_URL,
      { workerData: { path: databasePath } }
    )
  ) {
    this.createWorker = createWorker;
    this.unsubscribe = cache.onMiss(database, (_db, type, state) => {
      this.request(type, state);
    });
  }

  /** Schedule the series hot types after a miss; harmless if already queued. */
  request(type: string, state: HealthRecordOverlapDatabaseState): void {
    if (this.closed) return;
    if (this.workerSlot?.inFlight?.type === type) return;
    if (this.queue.some((job) => job.type === type)) return;
    this.queue.push({ type, state });
    this.pump();
  }

  /** Optional explicit warm-up (used by tests/diagnostics, not on the request path). */
  warm(type: string): void {
    if (this.closed) return;
    this.request(type, readHealthRecordOverlapDatabaseState(this.database));
  }

  close(): void {
    this.closed = true;
    this.unsubscribe();
    const slot = this.workerSlot;
    this.workerSlot = null;
    if (slot !== null) {
      slot.inFlight = null;
      try { slot.worker.postMessage({ close: true }); } catch { /* already gone */ }
      void slot.worker.terminate().catch(() => { /* already gone */ });
    }
  }

  private ensureWorker(): WorkerSlot | null {
    if (this.workerSlot !== null) return this.workerSlot;
    if (this.closed) return null;
    const worker = this.createWorker(this.path);
    const slot: WorkerSlot = { worker, inFlight: null };
    worker.on("message", (message: { type?: unknown; stats?: HealthRecordOverlapStats; error?: unknown }) => {
      // A late message from a superseded worker belongs to that worker only.
      if (this.workerSlot !== slot) return;
      const job = slot.inFlight;
      slot.inFlight = null;
      if (!this.closed && job !== null && message?.type === job.type && message.stats !== undefined) {
        try {
          this.cache.prime(this.database, job.type, job.state, message.stats);
        } catch { /* the store may have been closed while the worker was finishing */ }
      }
      this.pump();
    });
    worker.on("error", () => {
      // Clear only this slot. `pump()` may synchronously create a replacement;
      // the old worker's following `exit` event must not clear its inFlight.
      if (this.workerSlot === slot) this.workerSlot = null;
      slot.inFlight = null;
      this.pump();
    });
    worker.on("exit", () => {
      if (this.workerSlot === slot) this.workerSlot = null;
      slot.inFlight = null;
      this.pump();
    });
    this.workerSlot = slot;
    return slot;
  }

  private pump(): void {
    if (this.closed) return;
    if (this.workerSlot !== null && this.workerSlot.inFlight !== null) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    let slot: WorkerSlot | null;
    try {
      slot = this.ensureWorker();
    } catch {
      this.queue.unshift(job);
      this.workerSlot = null;
      return;
    }
    if (slot === null) return;
    slot.inFlight = job;
    try { slot.worker.postMessage({ type: job.type }); }
    catch {
      slot.inFlight = null;
      if (this.workerSlot === slot) this.workerSlot = null;
      this.pump();
    }
  }
}

/** Warm the three overlap types for a store (diagnostics; never blocks the request). */
export function warmHealthRecordOverlapStats(worker: HealthRecordOverlapStatsWorker): void {
  for (const type of WARM_TYPES) worker.warm(type);
}
