import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CanonicalHealthRecord } from "@rai/contracts";

/**
 * Keep v30 canonical IDs and tombstones. Source facts must never be inferred
 * from another UUID's last write to a shared canonical row.
 *
 * ⚠️ 回填 `healthkit_record_facts.content_hash` 时用的是
 * `import_entity_generations.content_hash ?? row.id`（见下方 `fact.run(...)`）。
 * **那个回落值不是内容摘要，是"只知其身份"的哨兵** —— `row.id` 是
 * `record_<sha256(identity)[:32]>`，与 `observeImportEntity` 期望的内容哈希
 * 属于两个取值空间。
 *
 * 为什么可以这样：该列只有**一个**消费方 —— `RaiDatabase.removeHealthKitRecords`
 * 里读 `f.content_hash` 并从共享行重建存活来源的那一处。判定是
 * `previous.contentHash !== contentHash`，所以回落值唯一可观测的后果是
 * **该记录在迁移后第一次真实导入时多报一次 `updated`**（多一次幂等重算），
 * 不会丢数据、不会让删除漏掉。
 *
 * 为什么**不改**：`migrateModelV31` 本身被冻结在 `FROZEN_MIGRATION_CHECKSUMS`（`up` 就是
 * 这个函数对象，改函数体即改校验和），而换成真摘要要么依赖 parser 的 `stableId`、
 * 要么把 `SEED_CONTENT_HASH` 搬到共享层（现在它在 `database.ts`，直接引用会成环）。
 * 收益只是省掉那一次多余重算 ⇒ 不成比例。
 *
 * 🔴 现状边界（**未被测试覆盖**）：`v31-migration.test.ts` 只覆盖了**有** generation 行
 * 的路径（断言 `content_hash` 等于既有的 `old-content-hash`），`?? row.id` 这条回落
 * 分支没有判据。谁要改它，必须同时：①重算 v31 冻结校验和；②给回落分支补判据；
 * ③在"从 v30 备份导入"的路径上复跑一遍。
 */
export function migrateModelV31(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE healthkit_record_aliases (
      alias_id TEXT NOT NULL,
      sample_type TEXT NOT NULL,
      sample_uuid TEXT NOT NULL,
      PRIMARY KEY (alias_id, sample_type, sample_uuid)
    );
    CREATE TABLE healthkit_record_facts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_type TEXT NOT NULL,
      sample_uuid TEXT NOT NULL,
      record_json TEXT NOT NULL,
      source_category TEXT NOT NULL,
      raw_attributes_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      UNIQUE (sample_type, sample_uuid)
    );
  `);
  const aliases = database.prepare("INSERT OR IGNORE INTO healthkit_record_aliases VALUES (?, ?, ?)");
  const fact = database.prepare(`
    INSERT INTO healthkit_record_facts
      (sample_type, sample_uuid, record_json, source_category, raw_attributes_json, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const sources = database.prepare(`
    SELECT sample_type AS type, sample_uuid AS uuid FROM healthkit_record_sources WHERE record_id = ?
  `);
  const rows = database.prepare(`
    SELECT r.*, g.content_hash FROM health_records r
    JOIN (SELECT DISTINCT record_id FROM healthkit_record_sources) s ON s.record_id = r.id
    LEFT JOIN import_entity_generations g ON g.entity_kind = 'record' AND g.entity_id = r.id
  `).iterate() as Iterable<{
    id: string; type: string; source_name: string; source_category: string; source_version: string | null;
    device: string | null; unit: string | null; value_numeric: number | null; value_text: string | null;
    start_at: string; end_at: string; created_at: string | null;
    metadata_json: string; raw_attributes_json: string; content_hash: string | null;
  }>;
  // The XML formulas hash flat primitive arrays; no parser dependency or change
  // to existing IDs. Keep this copy frozen with the migration.
  const xmlId = (parts: unknown[]): string =>
    `record_${createHash("sha256").update("record\0").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
  for (const row of rows) {
    let metadata: CanonicalHealthRecord["metadata"], attributes: Record<string, string>;
    try {
      metadata = JSON.parse(row.metadata_json);
      attributes = JSON.parse(row.raw_attributes_json);
      if (!metadata || !attributes) continue;
    } catch { continue; }
    const mapped = sources.all(row.id) as { type: string; uuid: string }[];
    const uuidValues = metadata.RAIHealthKitSampleUUID;
    const uuidValue = Array.isArray(uuidValues) ? uuidValues.at(-1) : undefined;
    const uuid = typeof uuidValue === "string" ? uuidValue.toLowerCase() : undefined;
    const owner = uuid ? mapped.find((source) => source.type === row.type && source.uuid === uuid)
      : mapped.length === 1 ? mapped[0] : undefined;
    if (!owner) continue;
    const record: CanonicalHealthRecord = {
      id: row.id, type: row.type, sourceName: row.source_name, sourceVersion: row.source_version,
      device: row.device, unit: row.unit, numericValue: row.value_numeric, textValue: row.value_text,
      startAt: row.start_at, endAt: row.end_at, createdAt: row.created_at, metadata
    };
    const legacy = xmlId([row.type, row.source_name, row.start_at, row.end_at, attributes.value ?? null, row.unit]);
    const syncIds = metadata.HKMetadataKeySyncIdentifier;
    const syncId = Array.isArray(syncIds) ? syncIds.at(-1) : undefined;
    for (const alias of [legacy, ...(syncId ? [xmlId([row.type, row.source_name, syncId])] : [])]) {
      aliases.run(alias, owner.type, owner.uuid);
    }
    fact.run(owner.type, owner.uuid, JSON.stringify(record), row.source_category, row.raw_attributes_json,
      row.content_hash ?? row.id);
  }
}
