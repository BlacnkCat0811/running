import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { healthTypes } from "@rai/contracts";

import {
  isUnchangedRecordForIncrementalImport,
  parseAppleHealthXml,
  type UnchangedRecordFastPathInput
} from "../src/index.js";
import { RaiDatabase, SEED_CONTENT_HASH } from "../src/database.js";

/**
 * P1-2（2026-10-18）：重复记录的**前置轻路径**回归。
 *
 * ## 守的是什么
 *
 * 直连同步的载荷 95.89% 是服务端已有的记录（6 批 27,000 条 / 有效新增 1,111 条）。
 * 修复前每条重复记录仍走完整管线：`observeImportEntity` 的 UPSERT + `saveHealthKitRecordFact`
 * 的 2× JSON 序列化（`INSERT OR REPLACE` 还带来删+插写放大）+ 全部热路径语句，
 * 实测固定底 4.4 s/批。生产库的写放大指纹：`healthkit_record_facts` 行数 534,723
 * vs `MAX(sequence)` 1,231,215。
 *
 * ## 判据（不是"跑通了"）
 *
 * 1. 同一 XML 连续导入两次：第二次 `inserted=0`、`unchanged = recordCount`、
 *    `health_records`/`healthkit_record_facts` 行数不变、`MAX(sequence)` **不增长**、
 *    `import_entity_generations` 不重写、第二批次账本为空行；
 * 2. 内容真的变了必须走完整路径：账本 `updated`、fact 原地 UPDATE（`MAX(sequence)` 仍不增）、
 *    行内容与 `available_at` 刷新；
 * 3. 墓碑存在时**不得**走轻路径（否则删除会被重传绕过）；
 * 4. 轻路径与完整路径的产出账本一致（`inserted/updated/removed` 语义不变）。
 */

const UUID_A = "00000000-0000-0000-0000-0000000000a1";
const UUID_B = "00000000-0000-0000-0000-0000000000b2";
const HR = healthTypes.heartRate;
const AT = "2026-02-09 08:10:00 +0800";

/** 一条 v2 心率记录（带 `RAIHealthKitSampleUUID`，与直连车道同形）。 */
function record(uuid: string, value: number, at = AT): string {
  return `<Record type="${HR}" sourceName="Fixture Apple Watch" sourceVersion="1" unit="count/min"
    startDate="${at}" endDate="${at}" value="${value}">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/>
  </Record>`;
}

const xmlWith = (...records: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><HealthData locale="zh_CN">${records.join("")}</HealthData>`;

interface Counts {
  rows: number;
  facts: number;
  factSequence: number;
  generations: number;
  ledger: number;
}

function counts(store: RaiDatabase): Counts {
  const row = store.database.prepare(`
    SELECT (SELECT COUNT(*) FROM health_records) AS rows,
           (SELECT COUNT(*) FROM healthkit_record_facts) AS facts,
           (SELECT COALESCE(MAX(sequence), 0) FROM healthkit_record_facts) AS factSequence,
           (SELECT COUNT(*) FROM import_entity_generations WHERE entity_kind = 'record') AS generations,
           (SELECT COUNT(*) FROM import_entity_changes WHERE entity_kind = 'record') AS ledger
  `).get() as unknown as Counts;
  return {
    rows: Number(row.rows), facts: Number(row.facts),
    factSequence: Number(row.factSequence), generations: Number(row.generations), ledger: Number(row.ledger)
  };
}

async function fixture(run: (ctx: {
  store: RaiDatabase;
  load: (xml: string, options?: {
    availableAt?: string;
    deleted?: { type: string; uuid: string }[];
    incremental?: boolean;
  }) => Promise<Awaited<ReturnType<typeof parseAppleHealthXml>>>;
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-unchanged-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  const path = join(root, "export.xml");
  let batchSequence = 0;
  const load: (xml: string, options?: {
    availableAt?: string;
    deleted?: { type: string; uuid: string }[];
    incremental?: boolean;
  }) => Promise<Awaited<ReturnType<typeof parseAppleHealthXml>>> = async (xml, options = {}) => {
    const incremental = options.incremental !== false;
    let batch: string | undefined;
    if (incremental) {
      batch = `batch_${++batchSequence}`;
      store.database.prepare(`INSERT OR IGNORE INTO import_batches
        (id, xml_sha256, status, import_mode) VALUES (?, 'test', 'running', 'incremental')`).run(batch);
    }
    writeFileSync(path, xml);
    return parseAppleHealthXml(path, store, {
      fileSize: statSync(path).size,
      healthKitRecordIdentity: true,
      deletedRecords: options.deleted ?? [],
      ...(options.availableAt === undefined ? {} : { availableAt: options.availableAt }),
      ...(incremental
        ? { incremental: { generation: batch!, batchId: batch!, preserveAbsent: true } }
        : {})
    });
  };
  try {
    await run({ store, load });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const T1 = "2026-02-09T01:00:00.000Z";
const T2 = "2026-02-09T02:00:00.000Z";
const T3 = "2026-02-09T03:00:00.000Z";

test("同一 XML 连续导入两次：第二次全部走轻路径，行数/写增长/账本都不动", async () => {
  await fixture(async ({ store, load }) => {
    const xml = xmlWith(record(UUID_A, 140), record(UUID_B, 152));
    const first = await load(xml, { availableAt: T1 });
    assert.equal(first.insertedRecordCount, 2);
    assert.equal(first.unchangedRecordCount, 0, "首次导入没有可比的既有摘要");
    const afterFirst = counts(store);
    assert.deepEqual(afterFirst, { rows: 2, facts: 2, factSequence: 2, generations: 2, ledger: 2 });
    const availableAtAfterFirst = store.database.prepare(
      "SELECT id, available_at AS availableAt FROM health_records ORDER BY id"
    ).all() as Array<{ id: string; availableAt: string }>;
    assert.deepEqual(availableAtAfterFirst.map((row) => row.availableAt), [T1, T1],
      "首次导入写到达服务端的时刻（P2-2）");

    const second = await load(xml, { availableAt: T2 });
    // 🔴 唯一验收判据（报告 §6.2 P1-2）：账本/回执语义与完整路径逐项相同。
    assert.equal(second.recordCount, 2);
    assert.equal(second.insertedRecordCount, 0, "重复记录不得算 inserted");
    assert.equal(second.unchangedRecordCount, 2, "两条都应命中轻路径");
    assert.equal(second.removedRecordCount, 0);
    assert.equal(second.tombstonedCount, 0);
    const afterSecond = counts(store);
    assert.deepEqual(afterSecond, afterFirst, "行数、facts 写增长（MAX(sequence)）、代次行都必须不变");
    const secondLedger = store.database.prepare(
      "SELECT COUNT(*) AS n FROM import_entity_changes WHERE batch_id = ?"
    ).get(`batch_${2}`) as { n: number };
    assert.equal(Number(secondLedger.n), 0, "未变记录不进账本（与完整路径同口径）");
    const availableAtAfterSecond = store.database.prepare(
      "SELECT id, available_at AS availableAt FROM health_records ORDER BY id"
    ).all() as Array<{ id: string; availableAt: string }>;
    assert.deepEqual(availableAtAfterSecond.map((row) => row.availableAt), [T1, T1],
      "轻路径不重写行 ⇒ 首次可得时间不被重复上传污染");
  });
});

test("内容真的变了：走完整路径（账本 updated、fact 原地更新、sequence 不增、available_at 刷新）", async () => {
  await fixture(async ({ store, load }) => {
    const original = xmlWith(record(UUID_A, 140), record(UUID_B, 152));
    await load(original, { availableAt: T1 });
    const before = counts(store);
    const changed = await load(xmlWith(record(UUID_A, 141), record(UUID_B, 152)), { availableAt: T3 });
    assert.equal(changed.insertedRecordCount, 0);
    assert.equal(changed.unchangedRecordCount, 1, "只有内容未变的那条走轻路径");
    assert.equal(
      (store.database.prepare(
        "SELECT change_type AS kind FROM import_entity_changes WHERE batch_id = ? AND entity_kind = 'record'"
      ).get(`batch_${2}`) as { kind: string } | undefined)?.kind,
      "updated",
      "内容变更必须写账本 updated（editing 语义）"
    );
    const after = counts(store);
    assert.equal(after.rows, before.rows);
    assert.equal(after.facts, before.facts);
    // P1-2 的写放大小验收：内容变更也是**原地 UPDATE**，不再删+插 ⇒ sequence 不增长。
    assert.equal(after.factSequence, before.factSequence,
      "healthkit_record_facts 必须原地更新；删+插会让 MAX(sequence) 每批虚增（生产实证 123.1 万 vs 53.5 万）");
    const rows = store.database.prepare(
      "SELECT value_numeric AS value, available_at AS availableAt FROM health_records ORDER BY value_numeric"
    ).all() as Array<{ value: number; availableAt: string }>;
    assert.deepEqual(rows.map((row) => row.value), [141, 152]);
    assert.deepEqual(rows.map((row) => row.availableAt), [T3, T1],
      "更新行刷新可得时间；未变行保持首次可得时间");
  });
});

test("墓碑存在时不得走轻路径：删除后重传同一 XML 不会复活，也不冒充 unchanged", async () => {
  await fixture(async ({ store, load }) => {
    const xml = xmlWith(record(UUID_A, 140), record(UUID_B, 152));
    await load(xml, { availableAt: T1 });
    const deleted = await load(xmlWith(), { availableAt: T1, deleted: [{ type: HR, uuid: UUID_A }] });
    assert.equal(deleted.removedRecordCount, 1);
    assert.equal(counts(store).rows, 1, "删除后只剩 B");

    const replay = await load(xml, { availableAt: T2 });
    // A 被墓碑挡住 ⇒ 必须走完整路径（tombstoned 计数在那里）；B 仍然未变 ⇒ 轻路径。
    assert.equal(replay.tombstonedCount, 1);
    assert.equal(replay.unchangedRecordCount, 1);
    assert.equal(replay.insertedRecordCount, 0);
    assert.equal(replay.recordCount, 2);
    assert.equal(counts(store).rows, 1, "重传不得让被删记录复活");
  });
});

test("完整快照（非 preserve-absent 增量）不做轻路径：必须逐行重写", async () => {
  await fixture(async ({ store, load }) => {
    const xml = xmlWith(record(UUID_A, 140), record(UUID_B, 152));
    const incremental = await load(xml, { availableAt: T1 });
    assert.equal(incremental.insertedRecordCount, 2);
    const full = await load(xml, { availableAt: T2, incremental: false });
    assert.equal(full.unchangedRecordCount, 0,
      "完整快照的删除判定读代次；跳过代次更新会被误判成删除 —— 所以没有轻路径");
    assert.equal(full.insertedRecordCount, 2, "非增量导入按既有语义把每行算 inserted");
    const available = store.database.prepare(
      "SELECT available_at AS availableAt FROM health_records ORDER BY id"
    ).all() as Array<{ availableAt: string }>;
    assert.deepEqual(available.map((row) => row.availableAt), [T2, T2], "完整快照重写行 ⇒ 刷新可得时间");
  });
});

test("availableAt 不是规范 ISO 时刻 ⇒ 解析前拒绝（不写脏 available_at）", async () => {
  await fixture(async ({ store, load }) => {
    await assert.rejects(load(xmlWith(record(UUID_A, 140)), { availableAt: "not-a-time" }),
      /availableAt must be a canonical ISO instant/);
    assert.equal(counts(store).rows, 0, "校验在任何写入之前");
  });
});

test("轻路径纯函数：每一条前置条件都必须成立", () => {
  const base: UnchangedRecordFastPathInput = {
    preserveAbsentIncremental: true,
    recordDelta: false,
    hasSampleUuid: true,
    hasIdentityMapping: true,
    existingContentHash: "record_content_same",
    contentHash: "record_content_same",
    sourceDeleted: false,
    entityTombstoned: false
  };
  assert.equal(isUnchangedRecordForIncrementalImport(base), true, "全部条件满足");
  const rejections: Array<[string, Partial<UnchangedRecordFastPathInput>]> = [
    ["非 preserve-absent 完整快照", { preserveAbsentIncremental: false }],
    ["recordDelta 车道", { recordDelta: true }],
    ["没有 UUID（无 facts 键）", { hasSampleUuid: false }],
    ["身份映射未建立", { hasIdentityMapping: false }],
    ["无可比摘要", { existingContentHash: null }],
    ["seed 哨兵不是内容摘要", { existingContentHash: SEED_CONTENT_HASH, contentHash: SEED_CONTENT_HASH }],
    ["内容摘要不同", { existingContentHash: "record_content_other" }],
    ["来源删除墓碑", { sourceDeleted: true }],
    ["实体删除墓碑", { entityTombstoned: true }]
  ];
  for (const [name, override] of rejections) {
    assert.equal(isUnchangedRecordForIncrementalImport({ ...base, ...override }), false, name);
  }
});
