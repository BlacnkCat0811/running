import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiReadStore } from "../src/data.js";
import {
  DatabaseNotReadyError,
  DatabaseReplaceTimeoutError,
  ReadStoreManager
} from "../src/read-store-manager.js";

const percentile = (samples: number[], p: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
};

const seedMarkerDatabase = (path: string, marker: string, wal = false): void => {
  const database = new DatabaseSync(path);
  if (wal) database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE marker (value TEXT)");
  database.prepare("INSERT INTO marker VALUES (?)").run(marker);
  database.close();
};

test("reports missing and replacing databases as stable 409 states", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-read-state-"));
  const path = join(root, "missing.sqlite");
  const manager = new ReadStoreManager(path);
  try {
    assert.throws(
      () => manager.useDatabase(() => undefined),
      (error: unknown) => error instanceof DatabaseNotReadyError && error.statusCode === 409 && error.code === "database_not_ready"
    );
    await manager.beginReplace();
    assert.throws(
      () => manager.useDatabase(() => undefined),
      (error: unknown) => error instanceof DatabaseReplaceTimeoutError && error.statusCode === 409 && error.code === "database_busy"
    );
    manager.endReplace();
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a concurrent database replacement owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-read-concurrent-replace-"));
  const manager = new ReadStoreManager(join(root, "rai.sqlite"));
  try {
    await manager.beginReplace();
    await assert.rejects(
      manager.beginReplace(),
      (error: unknown) => error instanceof DatabaseReplaceTimeoutError && error.code === "database_busy"
    );
    assert.throws(() => manager.useDatabase(() => undefined), DatabaseReplaceTimeoutError);
    manager.endReplace();
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("database replacement waits for asynchronous read leases and blocks new reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-read-lease-"));
  const path = join(root, "rai.sqlite");
  const seed = new DatabaseSync(path);
  seed.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('active')");
  seed.close();
  const manager = new ReadStoreManager(path);
  let releaseRead!: () => void;
  const hold = new Promise<void>((resolve) => { releaseRead = resolve; });
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  try {
    const read = manager.useDatabaseAsync(async (database) => {
      assert.equal((database.prepare("SELECT value FROM marker").get() as { value: string }).value, "active");
      readStarted();
      await hold;
    });
    await started;
    let replacementReady = false;
    const replacement = manager.beginReplace().then(() => { replacementReady = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replacementReady, false);
    assert.throws(() => manager.useDatabase(() => undefined), /正在切换/);
    releaseRead();
    await read;
    await replacement;
    assert.equal(replacementReady, true);
    manager.endReplace();
    assert.equal((manager.useDatabase((database) => database.prepare("SELECT COUNT(*) AS count FROM marker").get()) as { count: number }).count, 1);
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("beginReplace times out when read leases do not drain", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-read-lease-timeout-"));
  const path = join(root, "rai.sqlite");
  const seed = new DatabaseSync(path);
  seed.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('active')");
  seed.close();
  const manager = new ReadStoreManager(path);
  let releaseRead!: () => void;
  const hold = new Promise<void>((resolve) => { releaseRead = resolve; });
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  try {
    const read = manager.useDatabaseAsync(async () => {
      readStarted();
      await hold;
    });
    await started;
    await assert.rejects(
      manager.beginReplace(50),
      (error: unknown) =>
        error instanceof DatabaseReplaceTimeoutError &&
        error.statusCode === 409 &&
        error.code === "database_busy"
    );
    // After timeout, new reads must be allowed again.
    assert.equal(
      (manager.useDatabase((database) => database.prepare("SELECT COUNT(*) AS count FROM marker").get()) as { count: number }).count,
      1
    );
    releaseRead();
    await read;
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3-4: the cached read store reopens when the database file is replaced", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-read-inode-"));
  const path = join(root, "rai.sqlite");
  const replacement = join(root, "replacement.sqlite");
  const seed = (target: string, marker: string) => {
    const database = new DatabaseSync(target);
    database.exec("CREATE TABLE marker (value TEXT)");
    database.prepare("INSERT INTO marker VALUES (?)").run(marker);
    database.close();
  };
  seed(path, "old-inode");
  const manager = new ReadStoreManager(path);
  const marker = (): string => manager.use((store) =>
    (store as unknown as { database: DatabaseSync }).database.prepare("SELECT value FROM marker").get()!.value as string);
  try {
    assert.equal(marker(), "old-inode", "first read opens the original file");
    assert.equal(manager.storeOpenCount, 1, "the first read is the only cold open so far");
    // Replace the file the way a publication/restore does: new inode at the same
    // path. A cached connection would keep serving the unlinked old inode.
    seed(replacement, "new-inode");
    renameSync(replacement, path);
    assert.equal(marker(), "new-inode", "the next read must reopen the new file instead of the pinned inode");
    assert.equal(manager.storeOpenCount, 2, "a replacement (inode change) must rebuild the cached store");
    assert.equal(marker(), "new-inode", "the reopened store is reused while the identity stays the same");
    assert.equal(manager.storeOpenCount, 2, "same-inode reads reuse the open connection");
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3-4+: utimes-only mtime change must not reopen the cached read store", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-read-mtime-"));
  const path = join(root, "rai.sqlite");
  seedMarkerDatabase(path, "same-inode");
  const manager = new ReadStoreManager(path);
  const marker = (): string => manager.use((store) =>
    (store as unknown as { database: DatabaseSync }).database.prepare("SELECT value FROM marker").get()!.value as string);
  try {
    assert.equal(marker(), "same-inode");
    assert.equal(manager.storeOpenCount, 1);
    const ino = statSync(path).ino;
    utimesSync(path, new Date(), new Date(Date.now() + 60_000));
    assert.equal(statSync(path).ino, ino, "utimes must not change the inode");
    assert.equal(marker(), "same-inode", "data stays readable after an mtime-only change");
    assert.equal(manager.storeOpenCount, 1, "an mtime-only change (no inode change) must NOT reopen the store");
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3-4+: a WAL checkpoint (mtime change, same inode) keeps the connection and still sees new commits", t => {
  const root = mkdtempSync(join(tmpdir(), "rai-read-wal-"));
  const path = join(root, "rai.sqlite");
  seedMarkerDatabase(path, "before", true);
  const manager = new ReadStoreManager(path);
  const marker = (): string => manager.use((store) =>
    (store as unknown as { database: DatabaseSync }).database.prepare("SELECT value FROM marker").get()!.value as string);
  try {
    assert.equal(marker(), "before");
    assert.equal(manager.storeOpenCount, 1);
    const inoBefore = statSync(path).ino;
    const mtimeBefore = statSync(path).mtimeMs;
    // Another connection commits and then checkpoints the WAL into the main file.
    // That updates the main file's mtime while the inode stays the same.
    const writer = new DatabaseSync(path);
    try {
      writer.prepare("UPDATE marker SET value = ?").run("after-checkpoint");
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { writer.close(); }
    const inoAfter = statSync(path).ino;
    const mtimeAfter = statSync(path).mtimeMs;
    assert.equal(inoAfter, inoBefore, "WAL checkpoint keeps the same inode");
    assert.equal(marker(), "after-checkpoint", "a cached WAL connection must observe the newly committed value");
    assert.equal(manager.storeOpenCount, 1, "a WAL checkpoint (mtime change, same inode) must NOT reopen the store");
    t.diagnostic(`WAL checkpoint: ino=${inoAfter} mtime ${mtimeBefore.toFixed(3)} -> ${mtimeAfter.toFixed(3)} ms, storeOpenCount=${manager.storeOpenCount}`);
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("latency: cold open vs same-inode mtime path (p50/p95, diagnostic)", t => {
  const root = mkdtempSync(join(tmpdir(), "rai-read-latency-"));
  const path = join(root, "rai.sqlite");
  seedMarkerDatabase(path, "latency");
  const manager = new ReadStoreManager(path);
  const cold: number[] = [];
  const useAfterMtime: number[] = [];
  try {
    for (let index = 0; index < 30; index += 1) {
      const started = performance.now();
      const store = new RaiReadStore(path);
      store.close();
      cold.push(performance.now() - started);
    }
    assert.equal(manager.storeOpenCount, 0, "cold opens above bypassed the manager");
    manager.use(() => undefined);
    for (let index = 0; index < 200; index += 1) {
      utimesSync(path, new Date(), new Date(Date.now() + index * 1_000));
      const started = performance.now();
      manager.use(() => undefined);
      useAfterMtime.push(performance.now() - started);
    }
    const coldP50 = percentile(cold, 0.5), coldP95 = percentile(cold, 0.95);
    const mtimeP50 = percentile(useAfterMtime, 0.5), mtimeP95 = percentile(useAfterMtime, 0.95);
    t.diagnostic(`cold RaiReadStore open n=30 p50=${coldP50.toFixed(3)}ms p95=${coldP95.toFixed(3)}ms`);
    t.diagnostic(`same-inode mtime path n=200 p50=${mtimeP50.toFixed(3)}ms p95=${mtimeP95.toFixed(3)}ms`);
    assert.equal(manager.storeOpenCount, 1, "200 mtime-only changes must not trigger a single reopen");
    assert.ok(coldP95 < 100, `cold open p95 ${coldP95.toFixed(3)}ms should stay below 100ms`);
    assert.ok(mtimeP95 < 10, `same-inode path p95 ${mtimeP95.toFixed(3)}ms should be far below a cold open`);
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dataVersionFingerprint identifies the cached snapshot: foreign commits and replacement both change it", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-read-fingerprint-"));
  const path = join(root, "rai.sqlite");
  const replacement = join(root, "replacement.sqlite");
  seedMarkerDatabase(path, "first");
  const manager = new ReadStoreManager(path);
  try {
    const before = manager.dataVersionFingerprint();
    assert.match(before, /^\d+:-?\d+$/, "指纹形如 <inode>:<data_version>");
    // 另一个连接提交（导入/直连增量/重算发布）→ 同一文件、同一 inode，但
    // data_version 前进；coach-loop memo 必须因此立即失效。
    const writer = new DatabaseSync(path);
    try {
      writer.prepare("INSERT INTO marker VALUES (?)").run("second");
    } finally { writer.close(); }
    const afterCommit = manager.dataVersionFingerprint();
    assert.notEqual(afterCommit, before, "外部写者提交后指纹必须变化");

    // 发布/恢复换文件：读连接会被重开，inode 变化必须让 memo 失效。
    seedMarkerDatabase(replacement, "replaced");
    renameSync(replacement, path);
    const afterReplace = manager.dataVersionFingerprint();
    assert.notEqual(afterReplace, afterCommit, "文件替换后指纹必须变化");
    assert.equal(manager.storeOpenCount, 2, "换文件后读连接被重开");
  } finally {
    manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});
