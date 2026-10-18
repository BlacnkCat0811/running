import { RaiDatabase } from "@rai/storage-sqlite";

import { RaiReadStore } from "./data.js";
import { readSnapshotFileIdentity, type SnapshotFileIdentity } from "./plan-read-consistency.js";
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
  /**
   * File identity last observed for the cached store. Only the **inode** decides
   * whether the cached connection must be reopened (review P3-4): a cached
   * read-only connection keeps its inode, so a replacement (rename) invalidates
   * it. `mtime` is refreshed but does not reopen — SQLite WAL checkpoints update
   * the main file's mtime while the cached connection already sees the newest
   * committed snapshot on the next read.
   */
  private openedIdentity: SnapshotFileIdentity | null = null;
  /** Diagnostic/test counter: RaiReadStore instances opened (cold opens + replacements). */
  private openCount = 0;
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

  /**
   * Total number of `RaiReadStore` connections this manager has opened.
   *
   * Diagnostic/test only: production code paths do not branch on it. It is the
   * observable for "did the cached store get rebuilt because of a WAL checkpoint
   * mtime change" (it must not) versus "because the file was replaced" (it must).
   */
  get storeOpenCount(): number {
    return this.openCount;
  }

  use<T>(callback: (store: RaiReadStore) => T): T {
    this.acquire();
    try {
      const identity = readSnapshotFileIdentity(this.databasePath);
      if (identity === null) {
        this.closeStore();
        throw new DatabaseNotReadyError();
      }
      // A cached connection keeps the inode it opened. If the file at the path
      // has been replaced (import publication, restore, out-of-band swap) the
      // connection would keep serving the stale, unlinked inode forever. Reopen
      // **only on inode change**; the read lease is held, so a coordinated
      // publisher (`beginReplace`) cannot swap the file under this check.
      //
      // mtime alone must not reopen: every WAL checkpoint touches the main file,
      // and rebuilding the store (open + repository wiring) on each checkpoint is
      // pure latency with no consistency benefit — the cached connection reads
      // the newest committed WAL snapshot on its next query.
      if (this.store !== null && (this.openedIdentity === null || this.openedIdentity.ino !== identity.ino)) {
        this.closeStore();
      }
      if (this.store === null) {
        this.store = new RaiReadStore(this.databasePath, this.refreshOutcome);
        this.openCount += 1;
        // Bind to the file that was actually opened: if a swap landed between
        // the stat above and the constructor, the next request notices the
        // inode mismatch and reopens instead of silently using the old inode.
        const opened = readSnapshotFileIdentity(this.databasePath);
        if (opened === null) {
          this.closeStore();
          throw new DatabaseNotReadyError();
        }
        this.openedIdentity = opened;
      } else {
        // Same inode: remember the newest mtime for diagnostics only.
        this.openedIdentity = identity;
      }
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
      const identity = readSnapshotFileIdentity(this.databasePath);
      if (identity === null) throw new DatabaseNotReadyError();
      const database = RaiDatabase.openReadonly(this.databasePath);
      try {
        assertNotReplacedDuringOpen(this.databasePath, identity);
        return callback(database);
      } finally { database.close(); }
    } finally {
      this.release();
    }
  }

  async useDatabaseAsync<T>(callback: (database: import("node:sqlite").DatabaseSync) => Promise<T>): Promise<T> {
    this.acquire();
    try {
      const identity = readSnapshotFileIdentity(this.databasePath);
      if (identity === null) throw new DatabaseNotReadyError();
      const database = RaiDatabase.openReadonly(this.databasePath);
      try {
        assertNotReplacedDuringOpen(this.databasePath, identity);
        return await callback(database);
      } finally { database.close(); }
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
    this.openedIdentity = null;
  }

  /* Kept synchronous for Fastify shutdown, where no request leases remain. */
  close(): void {
    this.replacing = true;
    this.closeStore();
  }


}

/**
 * Detects a file swap that landed between the pre-open stat and the open.
 * Only `ino` is compared here: a WAL checkpoint may legitimately update the main
 * file's mtime while a writer is active, and that does not invalidate the fresh
 * read-only connection.
 */
function assertNotReplacedDuringOpen(path: string, beforeOpen: SnapshotFileIdentity): void {
  const afterOpen = readSnapshotFileIdentity(path);
  if (afterOpen === null || afterOpen.ino !== beforeOpen.ino) throw new DatabaseNotReadyError();
}
