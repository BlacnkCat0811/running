import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RaiDatabase } from "@rai/storage-sqlite";

test("API exits 78 on pending migrations without changing the main database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-startup-policy-"));
  const path = join(root, "rai.sqlite");
  try {
    (await RaiDatabase.open(path, { createMigrationBackup: false })).close();
    const database = new DatabaseSync(path);
    database.exec("DELETE FROM schema_migrations WHERE version=22; PRAGMA journal_mode=DELETE");
    database.close();
    const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const before = hash();
    const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      env: { ...process.env, RAI_RUNTIME_ROOT: root, RAI_DATABASE: path, RAI_API_PORT: "0", RAI_LOG_LEVEL: "fatal" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      assert.equal(code, 78, output);
      assert.match(output, /data:migrate/);
      assert.match(output, /22/);
      assert.equal(hash(), before);
    } finally { clearTimeout(timer); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
