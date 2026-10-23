// P1-1 / P2-7：旧删除 epoch 的读取裁决与删除日志的部署身份绑定。
//
// 这些用例只操作真实 SQLite 文件：主库用 `RaiDatabase.open` 建，侧车用与生产
// 相同的表结构写。它们钉住"主库无 epoch 行时不得静默回退 configuredEpoch"、
// "回填 compare-before-write"和"另一部署的记录不能签发许可"。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import {
  backfillDatasetEpochToMain, readDatasetEpoch, readDatasetEpochState, readDeletionOperation,
  type DatasetDeletionIdentity, type DatasetDeletionRecord
} from "../src/dataset-epoch.js";

const identity: DatasetDeletionIdentity = { serverId: "local", athleteId: "athlete_1" };
const at = "2026-10-23T00:00:00.000Z";

function deletionRecord(overrides: Partial<DatasetDeletionRecord> = {}): DatasetDeletionRecord {
  return {
    version: 3,
    deletionId: "deletion-1",
    configuredEpoch: "default",
    previousEpoch: "old-epoch",
    nextEpoch: "next-epoch",
    protectionSnapshot: "before-delete.sqlite",
    protectionKind: "backup",
    protectionFiles: [{ suffix: "", sizeBytes: 1, sha256: "a".repeat(64) }],
    serverId: identity.serverId,
    athleteId: identity.athleteId,
    runtimeInstanceId: "runtime_fixture",
    stage: "main_removed",
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

function writeSidecar(path: string, options: { epoch?: string; deletion?: DatasetDeletionRecord }): void {
  const db = new DatabaseSync(`${path}.dataset-epoch.sqlite`);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS dataset_epoch (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dataset_deletion (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)`);
    if (options.epoch !== undefined) {
      db.prepare("INSERT OR REPLACE INTO dataset_epoch VALUES (1, ?)")
        .run(JSON.stringify({ configuredEpoch: "default", epoch: options.epoch }));
    }
    if (options.deletion !== undefined) {
      db.prepare("INSERT OR REPLACE INTO dataset_deletion VALUES (1, ?)")
        .run(JSON.stringify(options.deletion));
    }
  } finally { db.close(); }
}

async function newMain(path: string): Promise<void> {
  const store = await RaiDatabase.open(path);
  store.close();
}

test("P1-1: a readable main database without an epoch row keeps the sidecar epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-epoch-legacy-"));
  const path = join(root, "rai.sqlite");
  try {
    await newMain(path);
    writeSidecar(path, { epoch: "deleted-legacy-epoch" });
    const state = readDatasetEpochState(path, "default", { strictConfigured: true, identity });
    assert.equal(state.epoch, "deleted-legacy-epoch");
    assert.equal(state.source, "deleted-sidecar");
    assert.equal(state.sidecarBackfillRequired, true);
    assert.equal(readDatasetEpoch(path, "default"), "deleted-legacy-epoch");

    // Backfill is compare-before-write and replayable.
    assert.equal(backfillDatasetEpochToMain(path, "default", "deleted-legacy-epoch"), "written");
    assert.equal(backfillDatasetEpochToMain(path, "default", "deleted-legacy-epoch"), "unchanged");
    const after = readDatasetEpochState(path, "default", { strictConfigured: true, identity });
    assert.equal(after.epoch, "deleted-legacy-epoch");
    assert.equal(after.source, "main");
    assert.notEqual(after.sidecarBackfillRequired, true);

    // A conflicting main value is an identity error, never an overwrite.
    assert.throws(
      () => backfillDatasetEpochToMain(path, "default", "another-epoch"),
      /identity conflict/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P1-1: a corrupt or mismatched sidecar blocks instead of falling back to configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-epoch-blocked-"));
  try {
    const noRows = join(root, "no-rows.sqlite");
    await newMain(noRows);
    writeSidecar(noRows, {});
    await assert.rejects(
      async () => readDatasetEpochState(noRows, "default", { strictConfigured: true, identity }),
      /no epoch row/i);

    const mismatched = join(root, "mismatched.sqlite");
    await newMain(mismatched);
    const db = new DatabaseSync(`${mismatched}.dataset-epoch.sqlite`);
    try {
      db.exec(`CREATE TABLE dataset_epoch (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)`);
      db.prepare("INSERT INTO dataset_epoch VALUES (1, ?)")
        .run(JSON.stringify({ configuredEpoch: "another-namespace", epoch: "foreign" }));
    } finally { db.close(); }
    await assert.rejects(
      async () => readDatasetEpochState(mismatched, "default", { strictConfigured: true, identity }),
      /belongs to configured epoch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P1-1: a main epoch row always wins and a deletion log is never overridden by the sidecar", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-epoch-main-"));
  const path = join(root, "rai.sqlite");
  try {
    await newMain(path);
    const store = await RaiDatabase.open(path);
    store.database.prepare("INSERT OR REPLACE INTO import_manifest (key,value) VALUES ('rai.dataset-epoch', ?)")
      .run(JSON.stringify({ configuredEpoch: "default", epoch: "main-epoch" }));
    store.close();
    writeSidecar(path, { epoch: "sidecar-epoch" });
    const state = readDatasetEpochState(path, "default", { strictConfigured: true, identity });
    assert.equal(state.epoch, "main-epoch");
    assert.equal(state.source, "main");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P2-7: a deletion record bound to another deployment cannot be read or used", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-epoch-identity-"));
  const path = join(root, "rai.sqlite");
  try {
    await newMain(path);
    writeSidecar(path, { epoch: "next-epoch", deletion: deletionRecord() });
    assert.throws(
      () => readDeletionOperation(path, "default", {
        strictConfigured: true, identity: { serverId: "other", athleteId: "athlete_1" }
      }),
      /belongs to deployment/);
    assert.throws(
      () => readDatasetEpochState(path, "default", {
        strictConfigured: true, identity: { serverId: "other", athleteId: "athlete_1" }
      }),
      /belongs to deployment/);
    const same = readDeletionOperation(path, "default", { strictConfigured: true, identity });
    assert.equal(same?.serverId, "local");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P2-7: legacy v2 deletion records remain readable but carry no deployment identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-epoch-v2-"));
  const path = join(root, "rai.sqlite");
  try {
    await newMain(path);
    const legacy = deletionRecord();
    const v2 = {
      version: 2, deletionId: legacy.deletionId, configuredEpoch: legacy.configuredEpoch,
      previousEpoch: legacy.previousEpoch, nextEpoch: legacy.nextEpoch,
      protectionSnapshot: legacy.protectionSnapshot, protectionKind: legacy.protectionKind,
      protectionFiles: legacy.protectionFiles, runtimeInstanceId: legacy.runtimeInstanceId,
      stage: legacy.stage, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt
    };
    writeSidecar(path, { epoch: "next-epoch", deletion: v2 as unknown as DatasetDeletionRecord });
    const record = readDeletionOperation(path, "default", { strictConfigured: true, identity });
    assert.equal(record?.version, 2);
    assert.equal(record?.serverId, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
