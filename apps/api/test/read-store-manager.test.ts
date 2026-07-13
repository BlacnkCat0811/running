import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ReadStoreManager } from "../src/read-store-manager.js";

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
