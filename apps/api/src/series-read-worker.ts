import { statSync } from "node:fs";
import { Worker } from "node:worker_threads";

import type { WorkoutSeriesResponse } from "@rai/api-contracts";

import type { PlanCandidateDay } from "./workout-segments.js";

interface PendingRequest {
  resolve: (value: WorkoutSeriesResponse | null) => void;
  reject: (error: Error) => void;
}

interface WorkerErrorMessage {
  kind?: "business" | "worker";
  message?: string;
}

interface WorkerState {
  readonly generation: number;
  readonly worker: Worker;
  readonly inode: number;
  readonly pending: Map<number, PendingRequest>;
  readonly ready: Promise<void>;
  readonly resolveReady: () => void;
  readonly rejectReady: (error: Error) => void;
  readySettled: boolean;
  failed: Error | null;
  retired: boolean;
}

export interface SeriesReadWorkerOptions {
  /** Bounded wait for a new worker to open its read-only connection. */
  readonly startupTimeoutMs?: number;
  /** Test seam: lets a regression test hold one generation open while a new one starts. */
  readonly createWorker?: (path: string) => Worker;
}

/** Admission overload: the caller must retry instead of falling back to a main-thread read. */
export class SeriesReadOverloadedError extends Error {
  readonly code = "series_read_overloaded";
  readonly statusCode = 503;

  constructor(message = "训练时间序列读取繁忙，请稍后重试") {
    super(message);
    this.name = "SeriesReadOverloadedError";
  }
}

/** Worker startup/crash/exit: safe to serve this request from the synchronous fallback. */
export class SeriesReadWorkerUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SeriesReadWorkerUnavailableError";
  }
}

/** A business/query exception thrown inside the worker must not be replayed synchronously. */
export class SeriesReadBusinessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SeriesReadBusinessError";
  }
}

export type SeriesReadFailureAction = "overloaded" | "fallback" | "propagate";

/**
 * The route's only failure policy. Keeping the three classes distinct prevents
 * an overload or a business exception from being mistaken for "worker is down".
 */
export function seriesReadFailureAction(error: unknown): SeriesReadFailureAction {
  if (error instanceof SeriesReadOverloadedError) return "overloaded";
  if (error instanceof SeriesReadWorkerUnavailableError) return "fallback";
  return "propagate";
}

/**
 * One worker and one read-only `RaiReadStore` for `/series`.
 *
 * The route holds a `ReadStoreManager` lease while awaiting a response, so a
 * database replacement cannot land mid-request. If the file inode changes
 * between requests, `request()` tears the worker down and starts a fresh one,
 * which reopens the new file. A worker failure is surfaced to the route, which
 * falls back to the synchronous store path (availability over latency).
 *
 * Every event, readiness promise and pending request belongs to one generation.
 * A superseded worker may exit after its replacement has already accepted new
 * work; that late event must only settle the old generation's requests.
 *
 * Admission is reserved before waiting for startup, so `maxPending` also bounds
 * the requests that are still waiting for a worker to become ready. The wait
 * itself is bounded; overload is a retryable 503, not a synchronous fallback.
 */
export class SeriesReadWorker {
  private workerState: WorkerState | null = null;
  private starting: Promise<WorkerState> | null = null;
  private nextRequestId = 1;
  private admitted = 0;
  private nextGeneration = 1;
  private closed = false;
  private readonly startupTimeoutMs: number;
  private readonly createWorker: (path: string) => Worker;

  constructor(
    private readonly path: string,
    private readonly maxPending = 64,
    options: SeriesReadWorkerOptions = {}
  ) {
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new RangeError("series read worker maxPending must be a positive integer");
    }
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.createWorker = options.createWorker ?? ((databasePath) => new Worker(
      new URL("./series-read-worker.mjs", import.meta.url),
      { workerData: { path: databasePath } }
    ));
  }

  async request(id: string, candidates: PlanCandidateDay[]): Promise<WorkoutSeriesResponse | null> {
    if (this.closed) throw new SeriesReadWorkerUnavailableError("series read worker is closed");
    // Reserve before `await ensure()`: during startup `pending.size` is still 0,
    // so counting only dispatched messages lets every caller into the queue.
    if (this.admitted >= this.maxPending) throw new SeriesReadOverloadedError();
    this.admitted += 1;
    try {
      const state = await this.ensure();
      if (this.closed || state.retired || this.workerState !== state) {
        throw new SeriesReadWorkerUnavailableError("series read worker was replaced before the request started");
      }
      const requestId = this.nextRequestId++;
      return await new Promise<WorkoutSeriesResponse | null>((resolve, reject) => {
        state.pending.set(requestId, { resolve, reject });
        try {
          state.worker.postMessage({ requestId, id, candidates });
        } catch (error) {
          this.failState(state, new SeriesReadWorkerUnavailableError(
            "series read worker could not accept the request",
            { cause: error }
          ));
        }
      });
    } finally {
      this.admitted -= 1;
    }
  }

  close(): void {
    this.closed = true;
    const state = this.workerState;
    if (state !== null) {
      this.failState(state, new SeriesReadWorkerUnavailableError("series read worker closed"));
    }
  }

  /** Diagnostic/test counter: requests reserved but not completed (includes startup waiters). */
  get admittedCount(): number {
    return this.admitted;
  }

  private async ensure(): Promise<WorkerState> {
    if (this.closed) throw new SeriesReadWorkerUnavailableError("series read worker is closed");
    let inode: number;
    try {
      inode = statSync(this.path).ino;
    } catch (error) {
      throw new SeriesReadWorkerUnavailableError("series read worker database is unavailable", { cause: error });
    }

    const current = this.workerState;
    if (current !== null && current.inode === inode && current.failed === null) {
      await this.awaitReady(current);
      if (this.closed || current.retired || this.workerState !== current) {
        throw new SeriesReadWorkerUnavailableError("series read worker was replaced while starting");
      }
      return current;
    }

    // Coalesce simultaneous cold requests onto one worker creation.
    if (this.starting !== null) {
      await this.starting;
      return this.ensure();
    }

    const starting = this.start(inode);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async start(inode: number): Promise<WorkerState> {
    this.retireCurrent(new SeriesReadWorkerUnavailableError("series read worker replaced by a newer database generation"));
    let state: WorkerState;
    try {
      state = this.createState(inode);
    } catch (error) {
      throw new SeriesReadWorkerUnavailableError("series read worker could not be created", { cause: error });
    }
    this.workerState = state;
    try {
      await this.awaitReady(state);
      return state;
    } catch (error) {
      const unavailable = error instanceof SeriesReadWorkerUnavailableError
        ? error
        : new SeriesReadWorkerUnavailableError("series read worker failed to start", { cause: error });
      this.failState(state, unavailable);
      throw unavailable;
    }
  }

  private createState(inode: number): WorkerState {
    const worker = this.createWorker(this.path);
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const state: WorkerState = {
      generation: this.nextGeneration++,
      worker,
      inode,
      pending: new Map(),
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      failed: null,
      retired: false
    };

    worker.on("message", (message: {
      type?: string;
      requestId?: number;
      series?: WorkoutSeriesResponse | null;
      error?: WorkerErrorMessage;
    }) => {
      if (state.retired) return;
      if (message?.type === "ready") {
        if (state.readySettled) return;
        state.readySettled = true;
        state.resolveReady();
        return;
      }
      if (typeof message?.requestId !== "number") return;
      const pending = state.pending.get(message.requestId);
      if (pending === undefined) return;
      state.pending.delete(message.requestId);
      if (message.error !== undefined) {
        if (message.error.kind === "business") {
          pending.reject(new SeriesReadBusinessError(String(message.error.message ?? "series read failed")));
        } else {
          pending.reject(new SeriesReadWorkerUnavailableError(
            String(message.error.message ?? "series read worker failed")
          ));
        }
        return;
      }
      pending.resolve(message.series ?? null);
    });
    worker.on("error", (error) => {
      this.failState(state, new SeriesReadWorkerUnavailableError(
        `series read worker failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      ));
    });
    worker.on("exit", (code) => {
      this.failState(state, new SeriesReadWorkerUnavailableError(
        `series read worker exited with ${code ?? "unknown"}`
      ));
    });
    return state;
  }

  private async awaitReady(state: WorkerState): Promise<void> {
    if (state.failed !== null) throw state.failed;
    if (state.readySettled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        state.ready,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new SeriesReadWorkerUnavailableError(
            `series read worker did not become ready within ${this.startupTimeoutMs}ms`
          )), this.startupTimeoutMs);
        })
      ]);
    } catch (error) {
      const unavailable = error instanceof SeriesReadWorkerUnavailableError
        ? error
        : new SeriesReadWorkerUnavailableError("series read worker failed to start", { cause: error });
      this.failState(state, unavailable);
      throw unavailable;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private retireCurrent(error: Error): void {
    const current = this.workerState;
    if (current !== null) this.failState(current, error);
  }

  /** Settle only this generation; a late event from it must never touch its successor. */
  private failState(state: WorkerState, error: Error): void {
    if (state.failed !== null) return;
    state.failed = error;
    state.retired = true;
    if (!state.readySettled) {
      state.readySettled = true;
      state.rejectReady(error);
    }
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
    if (this.workerState === state) this.workerState = null;
    try { state.worker.postMessage({ close: true }); } catch { /* already gone */ }
    void state.worker.terminate().catch(() => { /* already gone */ });
  }
}
