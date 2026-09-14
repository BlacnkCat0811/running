import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { RaiDatabase } from "../src/database.js";

const INDEXES = [
  "idx_workout_routes_workout_point_count",
  "idx_workout_group_members_workout"
];

function indexNames(database: DatabaseSync): string[] {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?)")
      .all(...INDEXES) as unknown as Array<{ name: string }>
  ).map((row) => row.name).sort();
}

// 训练列表的 has_route / route 过滤器是 `EXISTS (... workout_id = w.id ...)`：
// 没有这两个索引时，SQLite 每次执行都要临时构建 AUTOMATIC PARTIAL COVERING INDEX
// （实测 EXPLAIN QUERY PLAN），workout_group_members 更是直接 SCAN。
test("migration adds the workout route and group member lookup indexes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-route-index-migration-"));
  try {
    const path = join(root, "rai.sqlite");
    const current = await RaiDatabase.open(path, { createMigrationBackup: false });
    assert.deepEqual(indexNames(current.database), [...INDEXES].sort());
    current.close();

    // 回退到迁移前状态：删掉版本记录并丢弃索引，确认迁移可重放且幂等。
    const legacy = new DatabaseSync(path);
    for (const name of INDEXES) legacy.exec(`DROP INDEX IF EXISTS ${name}`);
    legacy.exec("DELETE FROM schema_migrations WHERE version = 21");
    legacy.close();

    const migrated = await RaiDatabase.open(path, { createMigrationBackup: false });
    try {
      assert.deepEqual(indexNames(migrated.database), [...INDEXES].sort());
      const applied = migrated.database
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 21")
        .get() as unknown as { count: number };
      assert.equal(applied.count, 1);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
