import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { CanonicalHealthRecord } from "@rai/contracts";
import { healthTypes } from "@rai/contracts";

import { FROZEN_MIGRATION_CHECKSUMS, RaiDatabase } from "../src/database.js";

/**
 * P1-2 / P2-2（2026-10-18）：`healthkit_record_facts` 的写放大修复与
 * `health_records.available_at`（迁移 v46）。
 *
 * ## P1-2 守的是什么
 *
 * 生产实测：`healthkit_record_facts` 行数 534,723 vs `MAX(sequence)` 1,231,215
 * —— `INSERT OR REPLACE` 在内容**没变**时也删旧行+插新行，AUTOINCREMENT 主键被无意义推进。
 * 本文件的判据不是"写进去了"，而是：
 *
 * 1. 同内容重复写：行数 1、`MAX(sequence)` **不增长**、载荷不变；
 * 2. 内容变了：**原地 UPDATE**（行数仍 1、`MAX(sequence)` 仍不增长）、载荷与摘要刷新；
 * 3. 点查（`healthKitRecordFactLookup`）能分辨"没有 fact / 没有身份映射 / 两种墓碑"——
 *    解析器的轻路径**只**在全部安全条件成立时走（`record-unchanged-fast-path.test.ts`）。
 *
 * ## P2-2 守的是什么
 *
 * v46 给 `health_records` 加可空的 `available_at`（到达服务端时刻）：新行写值、更新行刷新、
 * 未变行保留首次可得时间；**旧行保持 NULL 且不回填**（事件时间不能冒充可得时间，
 * DATA_PIPELINE §3）。迁移重放路径用「删列 + 删 schema_migrations 行」造真老库。
 */

const UUID = "00000000-0000-0000-0000-0000000000c3";
const HR = healthTypes.heartRate;

function record(overrides: Partial<CanonicalHealthRecord> = {}): CanonicalHealthRecord {
  return {
    id: "record_availability_fixture", type: HR, sourceName: "Fixture Apple Watch",
    sourceVersion: "1", device: "Watch", unit: "count/min", numericValue: 140, textValue: null,
    startAt: "2026-02-09T00:10:00.000Z", endAt: "2026-02-09T00:10:00.000Z",
    createdAt: "2026-02-09T00:11:00.000Z", metadata: { RAIHealthKitSampleUUID: [UUID] },
    ...overrides
  };
}

async function withStore(run: (store: RaiDatabase, path: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-availability-"));
  const path = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(path, { createMigrationBackup: false });
  try {
    await run(store, path);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function factStats(store: RaiDatabase): { rows: number; maxSequence: number; hash: string; recordJson: string } {
  return store.database.prepare(`SELECT COUNT(*) AS rows, COALESCE(MAX(sequence), 0) AS maxSequence,
      MAX(content_hash) AS hash, MAX(record_json) AS recordJson FROM healthkit_record_facts`).get() as unknown as
    { rows: number; maxSequence: number; hash: string; recordJson: string };
}

test("v46：health_records.available_at 可空、冻结校验和已登记、迁移对旧行不回填", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-v46-"));
  const path = join(root, "rai.sqlite");
  try {
    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    // 造一个"v45 现场"：删掉 v46 的列与账本行，并留一条旧事实行（没有可得时间）。
    const previous = new DatabaseSync(path);
    previous.exec(`
      ALTER TABLE health_records DROP COLUMN available_at;
      DELETE FROM schema_migrations WHERE version = 46;
      INSERT INTO health_records
        (id, type, source_name, source_category, unit, value_numeric, start_at, end_at,
         metadata_json, raw_attributes_json)
      VALUES ('rec_v45','HKQuantityTypeIdentifierHeartRate','Watch','apple_watch','count/min',140,
        '2026-02-09T00:10:00.000Z','2026-02-09T00:10:00.000Z','{}','{}');
    `);
    previous.close();

    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const column = (db.prepare("PRAGMA table_info(health_records)").all() as Array<{
        name: string; notnull: number; dflt_value: string | null;
      }>).find((row) => row.name === "available_at");
      assert.ok(column, "v46 必须给 health_records 加 available_at 列");
      assert.equal(column.notnull, 0, "可空：旧行没有可信的到达时刻");
      assert.equal(column.dflt_value, null, "没有默认值（默认值会伪造可得时间）");
      const frozen = db.prepare("SELECT checksum FROM schema_migrations WHERE version = 46").get() as
        { checksum: string } | undefined;
      assert.equal(frozen?.checksum, FROZEN_MIGRATION_CHECKSUMS[46],
        "迁移账本写的是冻结值（跨执行通道稳定）");
      const oldRow = db.prepare(
        "SELECT available_at AS availableAt FROM health_records WHERE id = 'rec_v45'"
      ).get() as { availableAt: string | null };
      assert.equal(oldRow.availableAt, null, "旧行保持 NULL：不得用 start_at/created_at 回填");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v46：新行写 available_at、更新行刷新、未提供时保留原值", async () => {
  await withStore(async (store) => {
    const T1 = "2026-02-09T01:00:00.000Z";
    const T2 = "2026-02-09T02:00:00.000Z";
    store.insertRecord(record(), "apple_watch", { value: "140" }, { availableAt: T1 });
    store.flush();
    const readAvailable = (): string | null => (store.database.prepare(
      "SELECT available_at AS availableAt FROM health_records WHERE id = ?"
    ).get(record().id) as { availableAt: string | null }).availableAt;
    assert.equal(readAvailable(), T1, "新行写到达时刻");

    // 老调用点（不带 option）更新同一行：不得用 NULL 抹掉已知的可得时间。
    store.insertRecord(record({ numericValue: 141 }), "apple_watch", { value: "141" });
    store.flush();
    assert.equal(readAvailable(), T1, "省略 availableAt ⇒ 保留原值");
    assert.equal((store.database.prepare(
      "SELECT value_numeric AS value FROM health_records WHERE id = ?"
    ).get(record().id) as { value: number }).value, 141, "其余列照常更新");

    // 内容变更的再次到达：刷新可得时间。
    store.insertRecord(record({ numericValue: 142 }), "apple_watch", { value: "142" }, { availableAt: T2 });
    store.flush();
    assert.equal(readAvailable(), T2, "更新行刷新可得时间");
  });
});

test("P1-2：saveHealthKitRecordFact 同内容重复写不增长 sequence；内容变更原地更新", async () => {
  await withStore(async (store) => {
    const attributes = { value: "140", unit: "count/min" };
    const first = record();
    store.saveHealthKitRecordFact(first, UUID, "apple_watch", attributes, "hash_v1");
    store.flush();
    let stats = factStats(store);
    assert.equal(stats.rows, 1);
    assert.equal(stats.maxSequence, 1);
    assert.equal(stats.hash, "hash_v1");

    // 同内容再来一次（4,500 条重复批里每一条都会走到这里）：不得删+插。
    store.saveHealthKitRecordFact(first, UUID, "apple_watch", attributes, "hash_v1");
    store.flush();
    stats = factStats(store);
    assert.equal(stats.rows, 1);
    assert.equal(stats.maxSequence, 1, "内容未变 ⇒ 不写任何行（AUTOINCREMENT 不推进）");
    assert.equal(stats.hash, "hash_v1");

    // 内容变了：原地 UPDATE（同样不推进 sequence）。
    const changed = record({ numericValue: 155 });
    store.saveHealthKitRecordFact(changed, UUID, "apple_watch", { ...attributes, value: "155" }, "hash_v2");
    store.flush();
    stats = factStats(store);
    assert.equal(stats.rows, 1);
    assert.equal(stats.maxSequence, 1, "更新走 ON CONFLICT DO UPDATE，不是删+插");
    assert.equal(stats.hash, "hash_v2");
    assert.match(stats.recordJson, /155/, "载荷随内容刷新（摘要相同才会跳过写）");
    assert.equal((store.database.prepare(
      "SELECT sample_uuid AS uuid FROM healthkit_record_facts"
    ).get() as { uuid: string }).uuid, UUID.toLowerCase(), "UUID 归一到小写（与既有键一致）");
  });
});

test("P1-2：healthKitRecordFactLookup 分辨无 fact / 无映射 / 两种墓碑", async () => {
  await withStore(async (store) => {
    assert.equal(store.healthKitRecordFactLookup(HR, UUID), null, "没有 fact 行 ⇒ null（走完整路径）");

    const rec = record();
    const canonicalId = store.resolveHealthKitRecordId(HR, UUID, "candidate", "legacy");
    store.insertRecord({ ...rec, id: canonicalId }, "apple_watch", {});
    store.saveHealthKitRecordFact({ ...rec, id: canonicalId }, UUID, "apple_watch", {}, "hash_fact");
    store.flush();
    const live = store.healthKitRecordFactLookup(HR, UUID);
    assert.ok(live);
    assert.equal(live.contentHash, "hash_fact");
    assert.equal(live.recordId, canonicalId, "身份映射存在（轻路径要求）");
    assert.equal(live.sourceDeleted, false);
    assert.equal(live.entityTombstoned, false);

    store.recordEntityTombstones("record", [canonicalId]);
    store.flush();
    assert.equal(store.healthKitRecordFactLookup(HR, UUID)?.entityTombstoned, true,
      "实体墓碑必须可观测（否则轻路径会绕过删除）");

    store.markHealthKitRecordDeletions([{ type: HR, uuid: UUID }]);
    store.flush();
    const afterSourceDeletion = store.healthKitRecordFactLookup(HR, UUID);
    assert.equal(afterSourceDeletion?.sourceDeleted, true, "来源墓碑必须可观测");
    assert.equal(afterSourceDeletion?.entityTombstoned, true);
  });
});
