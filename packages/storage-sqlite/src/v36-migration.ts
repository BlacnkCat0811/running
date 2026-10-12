import type { DatabaseSync } from "node:sqlite";

/**
 * 训练事实的**软删标记**（`docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md` D4.5）。
 *
 * 🔴 为什么必须软删，而不是继续物理 `DELETE FROM workouts`：
 * `workouts` 的外键链是 `workouts --CASCADE--> workout_routes --CASCADE--> route_versions
 * --CASCADE--> route_version_points`（`database.ts` 的 v1 建表 + `v35-migration.ts`）。
 * 2026-10-13 实测：删掉一个 workout 之后四张表**全部归零** —— 连那条已经
 * `status='complete'`、被 `published_route_version_id` 引用的路线版本内容也一起消失，
 * 而指针的 `NO ACTION` **拦不住级联**。那直接违反上位设计 §7「删除优先留 inactive/tombstone
 * 身份…不让 raw FK 级联删掉不可变 release 所需的证据和路线」。
 *
 * 语义：
 * - 只**新增可空列**，不修改任何历史迁移的 `up`（§14.2 A18）。老库补迁移后所有行都是
 *   `NULL`，与"没有删过任何东西"逐字等价。
 * - `deleted_at` 为空 = 该事实**此刻仍在**；非空 = 已删（值 = 删除发生的时刻）。
 *   读侧的**唯一**判据是 `packages/storage-sqlite/src/sql/fragments.ts` 的
 *   `workoutPresentConditionSql()`，不许在别处再写一遍字面 SQL。
 * - 为什么不用 `import_entity_tombstones` 当判据：墓碑会被 `prune-tombstones` 清理，
 *   用它做长期可见性判据会在清理之后**静默复活**已删训练。
 */
export function migrateModelV36(database: DatabaseSync): void {
  database.exec(`ALTER TABLE workouts ADD COLUMN deleted_at TEXT;`);
}
