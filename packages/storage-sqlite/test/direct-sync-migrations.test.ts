// v34 / v35 的结构判据（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §3.1 / §3.2）。
//
// 这里不重复 `migration-policy.test.ts` 的"每个迁移都冻结了 / 冻结值没漂移"两条门禁，
// 只钉住**这批 DDL 自身的不变量**：约束真的在生效、列真的加上了、老库补迁移不丢行。
//
// 🔴 为什么"约束真的在生效"必须单独断言：`CHECK` / `UNIQUE` / `REFERENCES` 写错时
// SQLite **不报错**，只是不再拒绝非法行。那种情况下 schema 看起来完全正确，
// 直到某天真的写进一条坏数据。所以每条约束都要有一次**期望被拒绝**的写入。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PendingMigrationsError, RaiDatabase } from "../src/database.js";

async function withDatabase(run: (path: string) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), "rai-direct-sync-migration-"));
  try { await run(join(root, "rai.sqlite")); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
}

function tableNames(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((row) => row.name));
}

test("v34 建出稀疏历史与代次计数器，并给当前行加上版本列", async () => {
  await withDatabase(async (path) => {
    (await RaiDatabase.open(path)).close();
    const db = new DatabaseSync(path);
    try {
      const tables = tableNames(db);
      assert.ok(tables.has("import_fact_history"));
      assert.ok(tables.has("import_generations"));

      assert.deepEqual([...columns(db, "import_fact_history")].sort(), [
        "available_at", "content_hash", "effective_at", "entity_id", "entity_kind",
        "payload_json", "superseded_at", "valid_from_generation", "valid_to_generation"
      ]);
      assert.ok(columns(db, "health_records").has("valid_from_generation"));
      assert.ok(columns(db, "workouts").has("valid_from_generation"));

      // 计数器是单行且从 0 起 —— 初始态必须是**确定的**，不能靠"没有行"来表示未开始。
      assert.deepEqual(db.prepare("SELECT singleton, raw_generation, dependency_generation FROM import_generations").all()
        .map((row) => ({ ...row })), [{ singleton: 1, raw_generation: 0, dependency_generation: 0 }]);
      assert.throws(() => db.exec("INSERT INTO import_generations (singleton, raw_generation, dependency_generation) VALUES (2, 0, 0)"),
        /CHECK|UNIQUE|PRIMARY KEY/);
    } finally { db.close(); }
  });
});

test("v34 约束真的在生效：entity_kind 白名单与版本区间都不接受非法值", async () => {
  await withDatabase(async (path) => {
    (await RaiDatabase.open(path)).close();
    const db = new DatabaseSync(path);
    try {
      // 设计 §3.1：路线不走这张表（`import_entity_generations` 的 CHECK 加不了 'route'）——
      // 用一次**期望被拒绝**的写入把这个边界钉死，而不是靠注释。
      assert.throws(() => db.exec(`INSERT INTO import_fact_history
        (entity_kind, entity_id, valid_from_generation, content_hash, payload_json)
        VALUES ('route', 'x', 1, 'h', '{}')`), /CHECK/);
      assert.throws(() => db.exec(`INSERT INTO import_fact_history
        (entity_kind, entity_id, valid_from_generation, valid_to_generation, content_hash, payload_json)
        VALUES ('record', 'x', 5, 5, 'h', '{}')`), /CHECK/);
      assert.throws(() => db.exec(`INSERT INTO import_fact_history
        (entity_kind, entity_id, valid_from_generation, valid_to_generation, content_hash, payload_json)
        VALUES ('record', 'x', 5, 4, 'h', '{}')`), /CHECK/);

      // 合法形状必须写得进去，否则上面三条可能只是因为表坏了才拒绝。
      db.exec(`INSERT INTO import_fact_history
        (entity_kind, entity_id, valid_from_generation, valid_to_generation, content_hash, payload_json)
        VALUES ('record', 'x', 5, NULL, 'h', '{}'),
               ('record', 'y', 1, 5, 'h', '{}')`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM import_fact_history").get()!.n, 2);
    } finally { db.close(); }
  });
});

test("v35 建出路线版本与分片表，并给 workout_routes / recompute_jobs 加可空绑定列", async () => {
  await withDatabase(async (path) => {
    (await RaiDatabase.open(path)).close();
    const db = new DatabaseSync(path);
    try {
      const tables = tableNames(db);
      for (const table of ["route_versions", "route_version_points", "import_batch_partitions"]) {
        assert.ok(tables.has(table), `缺少表 ${table}`);
      }
      assert.ok(columns(db, "workout_routes").has("published_route_version_id"));
      for (const column of ["target_raw_generation", "target_dependency_generation",
        "expected_incumbent_release_id", "dirty_json"]) {
        assert.ok(columns(db, "recompute_jobs").has(column), `recompute_jobs 缺少列 ${column}`);
      }
      // ⛔ 不许放宽 job_type 的 CHECK：非法类型必须仍被拒绝。
      assert.throws(() => db.exec(`INSERT INTO recompute_jobs
        (id, job_type, status, request_json, progress_phase) VALUES ('j','bogus','queued','{}','p')`), /CHECK/);

      // 分片表的"同一父批同一内容不重复写入"必须真的生效。
      db.exec(`INSERT INTO import_batch_partitions
        (parent_batch_id, partition_contract, chunk_index, chunk_hash, status)
        VALUES ('p','c',0,'h0','committed');
        INSERT INTO import_batch_partitions
        (parent_batch_id, partition_contract, chunk_index, chunk_hash, status)
        VALUES ('p','c',1,'h1','pending')`);
      assert.throws(() => db.exec(`INSERT INTO import_batch_partitions
        (parent_batch_id, partition_contract, chunk_index, chunk_hash, status)
        VALUES ('p','c',2,'h1','pending')`), /UNIQUE/);
      assert.throws(() => db.exec(`INSERT INTO import_batch_partitions
        (parent_batch_id, partition_contract, chunk_index, chunk_hash, status)
        VALUES ('p','c',0,'h9','pending')`), /UNIQUE|PRIMARY KEY/);
      // 未完成的路线版本不能是任意字符串。
      assert.throws(() => db.exec(`INSERT INTO route_versions (id, route_id, content_sha256, point_count, status)
        VALUES ('v','missing','h',0,'half')`), /CHECK/);
    } finally { db.close(); }
  });
});

test("v35 的路线版本外键与未发布语义：pending 版本不改变 workout_routes 的可见指针", async () => {
  await withDatabase(async (path) => {
    (await RaiDatabase.open(path)).close();
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(`INSERT INTO workouts (id, activity_type, source_name, source_category, start_at, end_at,
        duration_seconds, metadata_json, raw_attributes_json) VALUES
        ('w','HKWorkoutActivityTypeRunning','Watch','active','2026-01-01T00:00:00.000Z','2026-01-01T00:10:00.000Z',
         600,'{}','{}')`);
      db.exec(`INSERT INTO workout_routes (id, workout_id, source_category, metadata_json) VALUES
        ('r','w','active','{}')`);
      db.exec(`INSERT INTO route_versions (id, route_id, content_sha256, point_count, status) VALUES
        ('v1','r','h1',0,'pending'), ('v2','r','h2',0,'complete')`);

      // 指针仍为空 ⇒ 未完成的新版本对读侧不可见（"不发布半条路线"）。
      assert.equal(db.prepare("SELECT published_route_version_id AS p FROM workout_routes WHERE id='r'").get()!.p, null);
      db.exec("UPDATE workout_routes SET published_route_version_id='v2' WHERE id='r'");
      assert.equal(db.prepare("SELECT published_route_version_id AS p FROM workout_routes WHERE id='r'").get()!.p, "v2");

      // 指向不存在的版本必须被外键拒绝。
      assert.throws(() => db.exec("UPDATE workout_routes SET published_route_version_id='nope' WHERE id='r'"),
        /FOREIGN KEY/);

      // 🔴 被指针引用的版本**删不掉**（外键默认 NO ACTION）。这是刻意的，不是遗漏：
      // 若用 `ON DELETE SET NULL`，删版本会**静默取消发布**当前路线，客户端看到路线消失却查不到原因。
      // 拒绝比静默好 —— 修剪版本的正确顺序是"先移指针、再删版本"，这一步由调用方显式做。
      assert.throws(() => db.exec("DELETE FROM route_versions WHERE id='v2'"), /FOREIGN KEY/);
      db.exec("UPDATE workout_routes SET published_route_version_id=NULL WHERE id='r'");
      db.exec("DELETE FROM route_versions WHERE id='v2'");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM route_versions WHERE id='v2'").get()!.n, 0);
    } finally { db.close(); }
  });
});

test("老库补迁移：数据一行不少，且补完后 refuse 模式才放行", async () => {
  await withDatabase(async (path) => {
    (await RaiDatabase.open(path)).close();
    // 造一个"只迁移到 v33"的库：删掉 v34/v35 的产物、账本行与新增列。
    // ⚠️ 必须连**列**一起去掉。只删账本行会留下真实 v33 库没有的列，重跑 v34 会撞
    // "duplicate column name" —— 那不是真老库，是造出来的假现场。
    const previous = new DatabaseSync(path);
    previous.exec(`
      DROP TABLE import_fact_history;
      DROP TABLE import_generations;
      DROP TABLE route_versions;
      DROP TABLE route_version_points;
      DROP TABLE import_batch_partitions;
      ALTER TABLE health_records DROP COLUMN valid_from_generation;
      ALTER TABLE workouts DROP COLUMN valid_from_generation;
      ALTER TABLE workout_routes DROP COLUMN published_route_version_id;
      ALTER TABLE recompute_jobs DROP COLUMN target_raw_generation;
      ALTER TABLE recompute_jobs DROP COLUMN target_dependency_generation;
      ALTER TABLE recompute_jobs DROP COLUMN expected_incumbent_release_id;
      ALTER TABLE recompute_jobs DROP COLUMN dirty_json;
      DELETE FROM schema_migrations WHERE version IN (34, 35);
      INSERT INTO workouts (id, activity_type, source_name, source_category, start_at, end_at,
        duration_seconds, metadata_json, raw_attributes_json) VALUES
        ('w-old','HKWorkoutActivityTypeRunning','Watch','active','2026-01-01T00:00:00.000Z',
         '2026-01-01T00:10:00.000Z',600,'{}','{}');
      INSERT INTO health_records (id, type, source_name, source_category, unit, value_numeric, start_at, end_at,
        metadata_json, raw_attributes_json) VALUES
        ('rec-old','HKQuantityTypeIdentifierStepCount','Watch','active','count',10,
         '2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z','{}','{}');
    `);
    previous.close();

    await assert.rejects(RaiDatabase.open(path, { migrationPolicy: "refuse" }), (error: unknown) => {
      assert.ok(error instanceof PendingMigrationsError);
      assert.deepEqual(error.versions, [34, 35]);
      return true;
    });

    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workouts").get()!.n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_records").get()!.n, 1);
      // 补齐的列对既有行是 NULL —— 不回填、不猜版本。
      assert.equal(db.prepare("SELECT valid_from_generation AS v FROM health_records WHERE id='rec-old'").get()!.v, null);
      assert.equal(db.prepare("SELECT valid_from_generation AS v FROM workouts WHERE id='w-old'").get()!.v, null);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
    (await RaiDatabase.open(path, { migrationPolicy: "refuse" })).close();
  });
});
