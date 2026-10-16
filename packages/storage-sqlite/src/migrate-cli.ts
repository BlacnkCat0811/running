import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { RaiDatabase } from "./database.js";
import { acquireDatabasePublicationLock } from "./publication-lock.js";
import { SqliteRoutePointReader } from "./read/route-point-reader.js";

try {
  const { values } = parseArgs({ options: {
    database: { type: "string" }, apply: { type: "boolean", default: false },
    backup: { type: "boolean", default: true },
    "no-backup": { type: "boolean", default: false }
  } });
  // Require an explicit target so an environment/cwd mistake cannot migrate the wrong database.
  if (!values.database) throw new Error("Usage: npm run data:migrate -- --database PATH [--apply]");
  const path = resolve(values.database);
  const inspect = () => {
    const pending = RaiDatabase.pendingMigrations(path);
    if (!existsSync(path)) return { version: 0, counts: {}, pending };
    const database = RaiDatabase.openReadonly(path);
    try {
      const has = (name: string, type = "table") =>
        database.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?").get(type, name);
      const version = has("schema_migrations")
        ? database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()?.version : 0;
      const counts: Record<string, unknown> = Object.fromEntries(["workouts", "health_records"].map((name) => [name,
        has(name) ? database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()?.count : 0
      ]));
      // 🔴 路线点数按**可读**那份数（v43 的 `readable_route_points` 视图 = 唯一的路线点入口）。
      // 直接数 `route_points` 表在 O11 之后会**少报**：已发布路线的点搬到了版本表里，
      // 旧表只剩指针为 NULL 的老路线。这个数字是给 `--apply` 前后对照用的，口径必须是
      // "这个库现在有多少条轨迹点"，而不是"某一张实现表里有多少行"。
      // 库还没跑到 v43 时视图不存在，退回旧表（那时的旧表就是全部）。
      counts.route_points = has("readable_route_points", "view")
        ? new SqliteRoutePointReader(database).countReadablePoints()
        : has("route_points") ? database.prepare("SELECT COUNT(*) AS count FROM route_points").get()?.count : 0;
      return { version, counts, pending };
    } finally { database.close(); }
  };
  if (!values.apply) {
    console.log(JSON.stringify({ mode: "dry-run", database: path, ...inspect() }, null, 2));
  } else {
    mkdirSync(dirname(path), { recursive: true });
    const release = acquireDatabasePublicationLock(path, "cli");
    try {
      const started = performance.now();
      const before = inspect();
      const store = await RaiDatabase.open(path, {
        migrationPolicy: "apply",
        createMigrationBackup: values["no-backup"] ? false : (values.backup ?? true)
      });
      try {
        const violations = store.database.prepare("PRAGMA foreign_key_check").all();
        if (violations.length) throw new Error(`foreign_key_check: ${violations.length} violations`);
      } finally { store.close(); }
      console.log(JSON.stringify({
        status: before.pending.length ? "migrated" : "already current",
        database: path, before, after: inspect(), foreignKeyCheck: "ok",
        elapsedMs: Math.round(performance.now() - started)
      }, null, 2));
    } finally { release(); }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
