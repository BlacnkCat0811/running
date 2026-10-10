import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

const project = resolve(import.meta.dirname, "../../..");

test("recompute CLI emits a caught business failure before staging database cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-cli-"));
  const path = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(path);
  // Exercise the real runNextJob catch/fail path, not an uncaught CLI exception.
  store.database.exec(`
    CREATE TRIGGER fixture_recompute_failure BEFORE INSERT ON feature_runs
    BEGIN SELECT RAISE(ABORT, 'fixture full-history recompute failure'); END;
  `);
  store.close();
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "packages/application/src/cli.ts", "recompute",
      "--database", path, "--evaluated-at", "2026-10-10T00:00:00.000Z"
    ], { cwd: project, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout) as { status: string; error: { message: string } };
    assert.equal(output.status, "failed");
    assert.match(output.error.message, /fixture full-history recompute failure/);
    const diagnostic = JSON.parse(result.stderr.split("\n").find((line) => line.startsWith("{"))!) as {
      status: string; error: { message: string };
    };
    assert.equal(diagnostic.status, "failed");
    assert.equal(diagnostic.error.message, output.error.message);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("successful recompute CLI still emits a successful JSON result", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-recompute-cli-ok-"));
  const path = join(root, "rai.sqlite");
  (await RaiDatabase.open(path)).close();
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "packages/application/src/cli.ts", "recompute",
      "--database", path, "--evaluated-at", "2026-10-10T00:00:00.000Z"
    ], { cwd: project, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { status: string; error: unknown };
    assert.equal(output.status, "succeeded");
    assert.equal(output.error, null);
    assert.doesNotMatch(result.stderr, /"status":"failed"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
