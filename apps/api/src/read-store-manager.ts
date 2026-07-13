import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { RaiReadStore } from "./data.js";

export class ReadStoreManager {
  private store: RaiReadStore | null = null;
  private activeLeases = 0;
  private replacing = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly databasePath: string) {}

  use<T>(callback: (store: RaiReadStore) => T): T {
    this.acquire();
    try {
      if (!existsSync(this.databasePath)) {
        this.closeStore();
        throw new Error("本地 RAI 数据库不存在，请先导入 Apple Health 数据");
      }
      this.store ??= new RaiReadStore(this.databasePath);
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
      if (!existsSync(this.databasePath)) throw new Error("本地 RAI 数据库不存在，请先导入 Apple Health 数据");
      const database = new DatabaseSync(this.databasePath, { readOnly: true });
      try { return callback(database); } finally { database.close(); }
    } finally {
      this.release();
    }
  }

  async useDatabaseAsync<T>(callback: (database: import("node:sqlite").DatabaseSync) => Promise<T>): Promise<T> {
    this.acquire();
    try {
      if (!existsSync(this.databasePath)) throw new Error("本地 RAI 数据库不存在，请先导入 Apple Health 数据");
      const database = new DatabaseSync(this.databasePath, { readOnly: true });
      try { return await callback(database); } finally { database.close(); }
    } finally {
      this.release();
    }
  }

  async beginReplace(): Promise<void> {
    this.replacing = true;
    if (this.activeLeases > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }
    this.closeStore();
  }

  endReplace(): void {
    this.replacing = false;
  }

  private acquire(): void {
    if (this.replacing) throw new Error("本地数据库正在切换，请稍后重试");
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
