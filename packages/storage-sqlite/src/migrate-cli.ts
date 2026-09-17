import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { RaiDatabase } from "./database.js";
import { acquireDatabasePublicationLock } from "./publication-lock.js";

try {
  const { values } = parseArgs({ options: {
    database: { type: "string" }, apply: { type: "boolean", default: false }
  } });
  // Require an explicit target so an environment/cwd mistake cannot migrate the wrong database.
  if (!values.database) throw new Error("Usage: npm run data:migrate -- --database PATH [--apply]");
  const path = resolve(values.database);
  const inspect = () => {
    const pending = RaiDatabase.pendingMigrations(path);
    if (!existsSync(path)) return { version: 0, counts: {}, pending };
    const database = RaiDatabase.openReadonly(path);
    try {
      const has = (name: string) => database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      const version = has("schema_migrations")
        ? database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()?.version : 0;
      const counts = Object.fromEntries(["workouts", "route_points", "health_records"].map((name) => [name,
        has(name) ? database.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get()?.count : 0
      ]));
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
      const store = await RaiDatabase.open(path, { migrationPolicy: "apply" });
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
