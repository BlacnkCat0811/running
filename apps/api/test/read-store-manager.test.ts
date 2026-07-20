import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DatabaseNotReadyError,
  DatabaseReplaceTimeoutError,
  ReadStoreManager
} from "../src/read-store-manager.js";

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
