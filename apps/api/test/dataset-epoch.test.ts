import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RaiDatabase } from "@rai/storage-sqlite";
import { readDatasetEpoch, writeDatasetEpoch, writeDeletedDatasetEpoch } from "../src/dataset-epoch.js";
import { DatabaseMaintenance } from "../src/maintenance.js";

test("persisted epochs survive reopening while an explicit namespace change takes precedence", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-dataset-epoch-"));
  const path = join(root, "rai.sqlite");
  try {
    assert.equal(readDatasetEpoch(path, "configured"), "configured");
    const store = await RaiDatabase.open(path);
    assert.equal(readDatasetEpoch(path, "configured"), "configured");
    writeDatasetEpoch(store.database, "configured", "restored");
    store.close();
    assert.equal(readDatasetEpoch(path, "configured"), "restored");
    assert.equal(readDatasetEpoch(path, "explicit-new-namespace"), "explicit-new-namespace");
    const damaged = join(root, "damaged.sqlite");
    writeFileSync(damaged, "damaged database fixture");
    assert.equal(readDatasetEpoch(damaged, "configured"), "configured");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restore epoch commits with the replacement and rolls back with a rejected restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-restore-epoch-"));
  const path = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(path);
    writeDatasetEpoch(store.database, "configured", "original");
    store.close();
    const maintenance = new DatabaseMaintenance(path, root);
    const backup = await maintenance.createBackup("epoch-fixture");
    await assert.rejects(maintenance.restoreBackup(backup.name,
      () => { throw new Error("fixture pre-commit failure"); },
      database => writeDatasetEpoch(database, "configured", "rejected")), /fixture pre-commit failure/);
    assert.equal(readDatasetEpoch(path, "configured"), "original");
    await maintenance.restoreBackup(backup.name, undefined,
      database => writeDatasetEpoch(database, "configured", "restored"));
    assert.equal(readDatasetEpoch(path, "configured"), "restored");
    await maintenance.restoreBackup(backup.name, undefined,
      database => writeDatasetEpoch(database, "configured", "restored-again"));
    assert.equal(readDatasetEpoch(path, "configured"), "restored-again");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed epoch metadata cannot silently select stale receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-malformed-epoch-"));
  const path = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(path);
  try {
    writeDatasetEpoch(store.database, "configured", "restored");
    for (const value of ["{", "null", JSON.stringify({ configuredEpoch: "configured", epoch: "" })]) {
      store.database.prepare("UPDATE import_manifest SET value = ? WHERE key = 'rai.dataset-epoch'").run(value);
      assert.throws(() => readDatasetEpoch(path, "configured"));
    }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("deletion epochs survive an absent or rebuilt facts database without overriding a committed restore", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-deleted-epoch-"));
  const path = join(root, "rai.sqlite");
  try {
    let store = await RaiDatabase.open(path);
    writeDatasetEpoch(store.database, "configured", "before-delete");
    store.close();
    await new DatabaseMaintenance(path, root).deleteDatabase(() =>
      writeDeletedDatasetEpoch(path, "configured", "deleted"));
    assert.equal(readDatasetEpoch(path, "configured"), "deleted");
    assert.equal(readDatasetEpoch(path, "explicit-namespace"), "explicit-namespace");
    store = await RaiDatabase.open(path);
    store.close();
    assert.equal(readDatasetEpoch(path, "configured"), "deleted", "a fresh import has no old manifest epoch");
    store = await RaiDatabase.open(path);
    writeDatasetEpoch(store.database, "configured", "restored-after-delete");
    store.close();
    assert.equal(readDatasetEpoch(path, "configured"), "restored-after-delete");
    writeFileSync(path, "damaged rebuilt database");
    assert.equal(readDatasetEpoch(path, "configured"), "deleted", "recovery must not reuse the configured old namespace");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed durable epoch preparation never unlinks the facts database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-delete-epoch-failure-"));
  const path = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(path);
    writeDatasetEpoch(store.database, "configured", "original");
    store.close();
    let released = false;
    const maintenance = new DatabaseMaintenance(path, root, undefined, () => { released = true; });
    await assert.rejects(maintenance.deleteDatabase(() => { throw new Error("epoch preparation failed"); }),
      /epoch preparation failed/);
    assert.equal(readDatasetEpoch(path, "configured"), "original");
    assert.equal(released, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("damaged deletion metadata fails closed instead of reusing the default scope", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-deleted-epoch-corrupt-"));
  const path = join(root, "rai.sqlite");
  try {
    writeDeletedDatasetEpoch(path, "configured", "deleted");
    const database = new DatabaseSync(`${path}.dataset-epoch.sqlite`);
    try {
      database.exec("UPDATE dataset_epoch SET payload='null'");
    } finally { database.close(); }
    assert.throws(() => readDatasetEpoch(path, "configured"), /Invalid persisted dataset epoch/);
    writeFileSync(`${path}.dataset-epoch.sqlite`, "damaged epoch database");
    assert.throws(() => readDatasetEpoch(path, "configured"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
