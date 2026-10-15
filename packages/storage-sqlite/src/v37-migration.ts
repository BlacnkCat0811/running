import type { DatabaseSync } from "node:sqlite";

/**
 * 账本的**更新前范围**（R7，`deliverables/IOS_SYNC_INGEST_REVIEW_OPTIMIZATION_2026-10-15.md`）。
 *
 * 🔴 为什么需要它：`observeImportEntity` 把 `effective_at` **覆盖**成新值，账本只记"新时刻"。
 * 一条记录从 A 日移到 B 日时，`nightWindow` 的 JOIN 只看到 B 日 ⇒ **A 日的派生夜残留**
 * （R7 的实证）。更新前保存旧 `type/start/end` 三项之后，夜窗口与 dirty 边界可以取
 * **新旧范围的并集**，旧夜才有机会被重建/清掉。
 *
 * 语义：
 * - 只**新增可空列**、不修改任何历史迁移的 `up`（§14.2 A18）。老库补迁移后所有行都是
 *   `NULL` —— 与"没有旧范围可记"逐字等价（`updated` 且旧行可取时才写值）。
 * - `previous_effective_at` = 更新前那条记录的 `start_at`（R7 的主症状）；`previous_end_at`
 *   = 更新前的 `end_at`；`previous_type` = 更新前的 `type`（跨类型移动时夜归属会变）。
 * - 与"补齐列不回填"的既有纪律（`valid_from_generation` 那一类：NULL 表示"自古以来可见"）
 *   不冲突：这里是**账本的审计字段**，NULL 就是"没有这个事实"，回填才是无中生有。
 */
export function migrateModelV37(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE import_entity_changes ADD COLUMN previous_effective_at TEXT;
    ALTER TABLE import_entity_changes ADD COLUMN previous_end_at TEXT;
    ALTER TABLE import_entity_changes ADD COLUMN previous_type TEXT;
  `);
}
