// 无 UUID / 无 sync identifier 的记录身份把 `value`/`unit` 折进 stable id
// （`apple-health-parser.ts` 的 `buildRecord`）：**值更正**到达时是一个新实体，而
// `preserveAbsent` 增量从不把"载荷里没有"读成删除 ⇒ 旧行会永远留着，分析对同一时间窗
// 双计（2026-10-18 审查 P2-01，合成库复现：2 行互斥样本、账本只有 `inserted`）。
//
// 修复 = 接收端在**写完本批**之后按批做一次集合扫描，把"同自然键
// (type, source_name, start_at, end_at) 但 id 不同"的旧行按**既有删除语义**取代掉：
// 账本 `removed`（带 before 侧区间）+ 墓碑 + 删行 + 删代次。
//
// 本文件锁住四件事，缺一条修复就不完整：
//   1. legacy 增量：只剩新行、账本有 `removed`、墓碑挡住旧值回流；
//   2. 完整快照（非 incremental）行为不变（不取代）；
//   3. UUID 车道（`healthkitRecordIdentity`）的身份行不会被 legacy 更正删掉；
//   4. 同一批里两个"都是新实体"的值不互相删除（批内不猜谁对）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { loadDirtyRangeInput } from "../src/dirty-range-input.js";
import { planIncrementalAnalysisDirtyRange } from "../src/dirty-range.js";
import { RaiDatabase } from "../src/database.js";

const STEPS = "HKQuantityTypeIdentifierStepCount";
const HEART_RATE = "HKQuantityTypeIdentifierHeartRate";

interface RecordFixture {
  value: string;
  uuid?: string;
  start?: string;
  end?: string;
  type?: string;
  unit?: string;
}

function recordXml(fixture: RecordFixture): string {
  const start = fixture.start ?? "2026-01-01 09:00:00 +0800";
  const end = fixture.end ?? "2026-01-01 09:30:00 +0800";
  const uuid = fixture.uuid === undefined
    ? "" : `<MetadataEntry key="RAIHealthKitSampleUUID" value="${fixture.uuid}"/>`;
  return `<Record type="${fixture.type ?? STEPS}" sourceName="Watch" unit="${fixture.unit ?? "count"}"
    startDate="${start}" endDate="${end}" value="${fixture.value}">${uuid}</Record>`;
}

function exportXml(records: readonly RecordFixture[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<h:HealthData xmlns:h="fixture"><ExportDate value="2026-01-02 00:00:00 +0800"/>
${records.map(recordXml).join("\n")}
</h:HealthData>`;
}

interface StepRow {
  id: string;
  value: number;
  startAt: string;
}

function stepRows(store: RaiDatabase, type: string = STEPS): StepRow[] {
  return store.database.prepare(`
    SELECT id, value_numeric AS value, start_at AS startAt FROM health_records
    WHERE type = ? ORDER BY id
  `).all(type) as unknown as StepRow[];
}

function beginBatch(store: RaiDatabase, batchId: string): void {
  store.database.exec(`INSERT INTO import_batches (id,xml_sha256,status,import_mode,summary_json)
    VALUES ('${batchId}','pending','running','incremental','{}')`);
}

function ledgerRows(store: RaiDatabase, batchId: string): Array<{
  id: string; kind: string; previousAt: string | null; previousEnd: string | null; previousType: string | null;
}> {
  return store.database.prepare(`
    SELECT entity_id AS id, change_type AS kind, previous_effective_at AS previousAt,
      previous_end_at AS previousEnd, previous_type AS previousType
    FROM import_entity_changes WHERE batch_id = ? AND entity_kind = 'record'
    ORDER BY change_type, entity_id
  `).all(batchId) as unknown as Array<{
    id: string; kind: string; previousAt: string | null; previousEnd: string | null; previousType: string | null;
  }>;
}

function tombstoned(store: RaiDatabase, id: string): boolean {
  return store.database.prepare(
    "SELECT 1 FROM import_entity_tombstones WHERE entity_kind = 'record' AND entity_id = ?"
  ).get(id) !== undefined;
}

async function withStore(
  run: (store: RaiDatabase, xmlPath: string) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-record-supersede-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    await run(store, join(root, "export.xml"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function write(xmlPath: string, records: readonly RecordFixture[]): number {
  writeFileSync(xmlPath, exportXml(records));
  return statSync(xmlPath).size;
}

test("preserve-absent 增量：值更正取代旧行，账本/墓碑/脏窗口齐全，旧值不回流", async () => {
  await withStore(async (store, xmlPath) => {
    await parseAppleHealthXml(xmlPath, store, { fileSize: write(xmlPath, [{ value: "2000" }]), atomic: false });
    store.flush();
    const before = stepRows(store);
    assert.equal(before.length, 1);
    const oldId = before[0]!.id;

    beginBatch(store, "correct-1");
    const result = await parseAppleHealthXml(xmlPath, store, {
      fileSize: write(xmlPath, [{ value: "2100" }]), atomic: false,
      incremental: { generation: "correct", batchId: "correct-1", preserveAbsent: true }
    });
    store.flush();

    const after = stepRows(store);
    assert.equal(after.length, 1, "旧值必须被取代，而不是与新值并存（双计就是这条要挡的缺陷）");
    assert.notEqual(after[0]!.id, oldId, "值参与身份 ⇒ 新值必然是新 id");
    assert.equal(after[0]!.value, 2100);
    assert.equal(store.database.prepare("SELECT 1 FROM health_records WHERE id = ?").get(oldId), undefined,
      "旧行必须物理删除：分析直接读 health_records，留着就还会被算进去");
    assert.equal(store.database.prepare(
      "SELECT 1 FROM import_entity_generations WHERE entity_kind = 'record' AND entity_id = ?"
    ).get(oldId), undefined, "旧代次不得留下（否则它看起来是陈旧但仍然存在的实体）");

    assert.equal(result.supersededRecordCount, 1);
    assert.equal(result.removedRecordCount, 1);
    assert.deepEqual(result.supersededRecordTimes, [before[0]!.startAt]);

    const ledger = ledgerRows(store, "correct-1");
    assert.equal(ledger.length, 2, "一条 inserted（新值）+ 一条 removed（旧值）");
    const removed = ledger.find((row) => row.kind === "removed");
    assert.ok(removed, "账本必须有 removed 条目 —— 没有它脏范围看不见这次替换");
    assert.equal(removed.id, oldId);
    // before 侧区间：`loadDirtyRangeInput` 对 removed 记录的旧侧正是取这三列。
    assert.equal(removed.previousType, STEPS);
    assert.equal(removed.previousAt, before[0]!.startAt);
    assert.ok(removed.previousEnd !== null && removed.previousEnd > removed.previousAt!);
    assert.equal(tombstoned(store, oldId), true, "墓碑必须落下：旧载荷/旧档案不能把旧值带回来");

    // 旧值回流：同一份（值更正之前的）载荷再来一次，不得复活旧行。
    beginBatch(store, "correct-2");
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: write(xmlPath, [{ value: "2000" }]), atomic: false,
      incremental: { generation: "stale", batchId: "correct-2", preserveAbsent: true }
    });
    store.flush();
    const replayed = stepRows(store);
    assert.equal(replayed.length, 1, "旧值被墓碑挡住，不得复活");
    assert.equal(replayed[0]!.value, 2100);
    assert.equal(ledgerRows(store, "correct-2").length, 0, "被墓碑挡住的实体不写账本");
  });
});

test("完整快照（非 incremental）不取代旧行：行为与修复前一致", async () => {
  await withStore(async (store, xmlPath) => {
    await parseAppleHealthXml(xmlPath, store, { fileSize: write(xmlPath, [{ value: "2000" }]), atomic: false });
    store.flush();
    await parseAppleHealthXml(xmlPath, store, { fileSize: write(xmlPath, [{ value: "2100" }]), atomic: false });
    store.flush();
    // 非增量车道从不把"载荷里没有"读成删除（完整快照由 replace/最终清理负责），
    // 这里刻意不改它的语义，只锁住"没有新的删除副作用"。
    assert.equal(stepRows(store).length, 2);
  });
});

test("UUID 车道的身份行不会被 legacy 值更正删掉", async () => {
  await withStore(async (store, xmlPath) => {
    // 先由 UUID 车道写入更正后的值：`healthkit_record_sources` 拥有这条记录。
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: write(xmlPath, [{ value: "2100", uuid: "11111111-2222-3333-4444-555555555555" }]),
      atomic: false, healthKitRecordIdentity: true
    });
    store.flush();
    const uuidRows = stepRows(store);
    assert.equal(uuidRows.length, 1);
    const authoritativeId = uuidRows[0]!.id;
    assert.equal(store.database.prepare(
      "SELECT 1 FROM healthkit_record_sources WHERE record_id = ?"
    ).get(authoritativeId) !== undefined, true, "前置：UUID 车道必须登记了来源映射");

    // 再由 legacy 增量送来**旧值**：自然键相同、id 不同 —— 旧行会被写入，但取代扫描
    // 必须跳过 UUID 拥有的那一行（权威身份的清理由 UUID 车道负责，不能在这里删）。
    beginBatch(store, "legacy-1");
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: write(xmlPath, [{ value: "2000" }]), atomic: false,
      incremental: { generation: "legacy", batchId: "legacy-1", preserveAbsent: true }
    });
    store.flush();

    assert.equal(store.database.prepare("SELECT 1 FROM health_records WHERE id = ?").get(authoritativeId) !== undefined,
      true, "UUID 车道的行不得被 legacy 取代扫描删除");
    assert.equal(tombstoned(store, authoritativeId), false, "也不得被挂上普通删除墓碑");
    const removed = ledgerRows(store, "legacy-1").filter((row) => row.kind === "removed");
    assert.deepEqual(removed, [], "账本里不得出现对 UUID 身份行的 removed");
    assert.equal(stepRows(store).length, 2, "两条身份并存是混合车道的既有事实；这里只禁止误删");
  });
});

test("同一批里两个新值不互相取代：批内不猜哪个值是对的", async () => {
  await withStore(async (store, xmlPath) => {
    beginBatch(store, "ambiguous-1");
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: write(xmlPath, [{ value: "2000" }, { value: "2100" }]), atomic: false,
      incremental: { generation: "ambiguous", batchId: "ambiguous-1", preserveAbsent: true }
    });
    store.flush();

    assert.equal(stepRows(store).length, 2, "同一批写下的两个实体都不该被对方删掉");
    assert.deepEqual(ledgerRows(store, "ambiguous-1").map((row) => row.kind).sort(),
      ["inserted", "inserted"]);
  });
});

test("被取代旧行的窗口进入脏范围：不是「有变更但无边界 ⇒ 全量」", async () => {
  await withStore(async (store, xmlPath) => {
    // 用**评分型**记录（心率）才能进 `planIncrementalAnalysisDirtyRange` 的区间语义；
    // 步数这类非评分记录按设计不影响分析。
    const first = await parseAppleHealthXml(xmlPath, store, {
      fileSize: write(xmlPath, [{ value: "150", type: HEART_RATE, unit: "count/min" }]), atomic: false
    });
    assert.equal(first.recordCount, 1);
    store.flush();
    const oldStart = stepRows(store, HEART_RATE)[0]!.startAt;

    beginBatch(store, "scoring-correct");
    const result = await parseAppleHealthXml(xmlPath, store, {
      fileSize: write(xmlPath, [{ value: "155", type: HEART_RATE, unit: "count/min" }]), atomic: false,
      incremental: { generation: "scoring", batchId: "scoring-correct", preserveAbsent: true }
    });
    store.flush();
    assert.equal(result.supersededRecordCount, 1);

    // 消费端（WP-22 `loadDirtyRangeInput`）按账本 `previous_*` 取 removed 记录的旧侧区间。
    const plan = planIncrementalAnalysisDirtyRange(
      loadDirtyRangeInput(store.database, ["scoring-correct"], [], [])
    );
    assert.equal(plan.full, false, "记录-only 的更正不能被读成「边界未知 ⇒ 全量」");
    assert.equal(plan.dirtyFromAt, oldStart, "脏下界必须覆盖被删旧行所在窗口");
    assert.ok(plan.reasons.includes("bounded_health_change"), `reasons=${plan.reasons.join(",")}`);
  });
});
