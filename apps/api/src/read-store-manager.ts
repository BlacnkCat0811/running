import { existsSync } from "node:fs";

import { RaiDatabase } from "@rai/storage-sqlite";

import { RaiReadStore } from "./data.js";
import type { MobileRefreshOutcome } from "./mobile-sync.js";

/** Default wait for read leases to drain before database file replacement. */
export const BEGIN_REPLACE_TIMEOUT_MS = 20_000;

export class DatabaseReplaceTimeoutError extends Error {
  readonly statusCode = 409;
  readonly code = "database_busy";

  constructor(message = "本地数据库正在切换，请稍后重试") {
    super(message);
    this.name = "DatabaseReplaceTimeoutError";
  }
}

export class DatabaseNotReadyError extends Error {
  readonly statusCode = 409;
  readonly code = "database_not_ready";

  constructor(message = "本地 RAI 数据库不存在，请先导入 Apple Health 数据") {
    super(message);
    this.name = "DatabaseNotReadyError";
  }
}

export class ReadStoreManager {
  private store: RaiReadStore | null = null;
  private activeLeases = 0;
  private replacing = false;
  private readonly idleWaiters = new Set<() => void>();

  /**
   * @param refreshOutcome The import worker's own record of the newest refresh.
   *   Read lazily so the store sees the current attempt rather than whatever was
   *   known when the pool was created, and optional so a caller with no worker
   *   still gets an honest `never`/`ok` reading instead of a guess.
   */
  constructor(
    private readonly databasePath: string,
    private readonly refreshOutcome: () => MobileRefreshOutcome | null = () => null
  ) {}

  get isReplacing(): boolean {
    return this.replacing;
  }

  use<T>(callback: (store: RaiReadStore) => T): T {
    this.acquire();
    try {
      if (!existsSync(this.databasePath)) {
        this.closeStore();
        throw new DatabaseNotReadyError();
      }
      this.store ??= new RaiReadStore(this.databasePath, this.refreshOutcome);
      return callback(this.store);
    } finally {
      this.release();
    }
  }

  async lease<T>(callback: () => Promise<T>): Promise<T> {
    this.acquire();
    try { return await callback(); }
    finally { this.release(); }
  }

  useDatabase<T>(callback: (database: import("node:sqlite").DatabaseSync) => T): T {
    this.acquire();
    try {
      if (!existsSync(this.databasePath)) throw new DatabaseNotReadyError();
      const database = RaiDatabase.openReadonly(this.databasePath);
      try { return callback(database); } finally { database.close(); }
    } finally {
      this.release();
    }
  }

  async useDatabaseAsync<T>(callback: (database: import("node:sqlite").DatabaseSync) => Promise<T>): Promise<T> {
    this.acquire();
    try {
      if (!existsSync(this.databasePath)) throw new DatabaseNotReadyError();
      const database = RaiDatabase.openReadonly(this.databasePath);
      try { return await callback(database); } finally { database.close(); }
    } finally {
      this.release();
    }
  }

  async beginReplace(timeoutMs = BEGIN_REPLACE_TIMEOUT_MS): Promise<void> {
    if (this.replacing) throw new DatabaseReplaceTimeoutError();
    this.replacing = true;
    try {
      if (this.activeLeases > 0) {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const waiter = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            this.idleWaiters.delete(waiter);
            this.replacing = false;
            reject(new DatabaseReplaceTimeoutError());
          }, timeoutMs);
          this.idleWaiters.add(waiter);
        });
      }
      this.closeStore();
    } catch (error) {
      this.replacing = false;
      throw error;
    }
  }

  endReplace(): void {
    this.replacing = false;
  }

  private acquire(): void {
    if (this.replacing) throw new DatabaseReplaceTimeoutError();
    this.activeLeases += 1;
  }

  private release(): void {
    this.activeLeases -= 1;
    if (this.activeLeases === 0) {
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  private closeStore(): void {
    this.store?.close();
    this.store = null;
  }

  /* Kept synchronous for Fastify shutdown, where no request leases remain. */
  close(): void {
    this.replacing = true;
    this.closeStore();
  }

  invalidate(): void {
    this.store?.invalidateCache();
  }

}
