import assert from "node:assert/strict";
import {
  mkdirSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { RaiDatabase } from "../src/database.js";
import { retryTransientFileOperation } from "../src/file-operations.js";

test("API-owned candidate is updated without another whole-database clone or premature audit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-owned-"));
  const input = join(root, "export");
  const source = join(root, "rai.sqlite");
  const candidate = join(root, "rai.importing.fixture_owner.attempt-1.sqlite");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), `<HealthData>
    <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="500"/>
  </HealthData>`);
  const original = await RaiDatabase.open(source);
  original.setManifest("original_marker", "preserved");
  original.close();
  copyFileSync(source, candidate);
  const before = readFileSync(source);
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", resolve("packages/health-export-parser/src/cli.ts"),
      "incremental-import", "--input", input, "--database", candidate,
      "--owned-candidate", "fixture_owner", "--source-database", source,
      "--batch-id", "fixture_batch",
      "--report", root, "--json-report", join(root, "audit.json"),
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(source), before, "the active database is not the parser's write target");
    assert.equal(existsSync(join(root, "audit.json")), false);
    assert.equal(readdirSync(root).some((name) => name.includes(".replaced.") || name.includes(".importing.fixture_owner.attempt-1.sqlite.importing.")), false);
    const accepted = new (await import("node:sqlite")).DatabaseSync(candidate, { readOnly: true });
    try {
      assert.equal(accepted.prepare("SELECT COUNT(*) AS n FROM activity_summaries").get()!.n, 1);
      assert.equal(accepted.prepare("SELECT status FROM import_batches WHERE id='fixture_batch'").get()!.status, "succeeded");
      assert.equal(accepted.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
    } finally {
      accepted.close();
    }
    assert.ok(!existsSync(`${candidate}-wal`) || readFileSync(`${candidate}-wal`).length === 0,
      "the candidate must be self-contained before API publication");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned-candidate mode cannot write a live path or a hard-link alias of the live database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-owned-guard-"));
  const input = join(root, "export");
  const source = join(root, "rai.sqlite");
  const candidate = join(root, "rai.importing.fixture_owner.sqlite");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), "<HealthData/>");
  const original = await RaiDatabase.open(source);
  original.setManifest("original_marker", "guarded");
  original.close();
  linkSync(source, candidate);
  const before = readFileSync(source);
  try {
    for (const path of [source, candidate]) {
      const result = spawnSync(process.execPath, [
        "--import", "tsx", resolve("packages/health-export-parser/src/cli.ts"),
        "incremental-import", "--input", input, "--database", path,
        "--owned-candidate", "fixture_owner", "--source-database", source,
      ], { cwd: resolve("."), encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /private rai.importing|alias the active database/);
      assert.deepEqual(readFileSync(source), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed owned-candidate parse leaves the live database and existing audit untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-owned-failure-"));
  const input = join(root, "export");
  const source = join(root, "rai.sqlite");
  const candidate = join(root, "rai.importing.fixture_owner.sqlite");
  const report = join(root, "audit.md");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), "<HealthData><Record");
  writeFileSync(report, "previous generation");
  const original = await RaiDatabase.open(source);
  original.close();
  copyFileSync(source, candidate);
  const before = readFileSync(source);
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", resolve("packages/health-export-parser/src/cli.ts"),
      "incremental-import", "--input", input, "--database", candidate,
      "--owned-candidate", "fixture_owner", "--source-database", source,
      "--report", report,
    ], { cwd: resolve("."), encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(source), before);
    assert.equal(readFileSync(report, "utf8"), "previous generation");
    assert.equal(existsSync(candidate), true, "only the owning API may reclaim its disposable candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retries transient Windows file locks during database publication", async () => {
  let attempts = 0;
  await retryTransientFileOperation(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("locked") as NodeJS.ErrnoException;
      error.code = attempts === 1 ? "EBUSY" : "EPERM";
      throw error;
    }
  }, 4, 0);
  assert.equal(attempts, 3);

  const fatal = new Error("invalid") as NodeJS.ErrnoException;
  fatal.code = "EINVAL";
  await assert.rejects(
    retryTransientFileOperation(async () => { throw fatal; }, 4, 0),
    fatal
  );
});

test("CLI replacement keeps the original database when a post-parse stage fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-atomic-"));
  const input = join(root, "export");
  const databasePath = join(root, "rai.sqlite");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), `<HealthData>
    <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="500"/>
  </HealthData>`);
  const original = await RaiDatabase.open(databasePath);
  original.setManifest("original_marker", "preserved");
  original.close();

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx",
        resolve("packages/health-export-parser/src/cli.ts"),
        "import", "--input", input, "--database", databasePath, "--replace",
        "--report", root, "--json-report", join(root, "audit.json")
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );
    assert.notEqual(result.status, 0, result.stdout);
    const preserved = await RaiDatabase.open(databasePath);
    try {
      const marker = preserved.database.prepare(`
        SELECT value FROM import_manifest WHERE key = 'original_marker'
      `).get() as unknown as { value: string };
      assert.equal(marker.value, "preserved");
      const summaries = preserved.database.prepare(`
        SELECT COUNT(*) AS count FROM activity_summaries
      `).get() as unknown as { count: number };
      assert.equal(summaries.count, 0);
    } finally {
      preserved.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI publishes database and audit reports from one generation and retains the displaced database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-publish-"));
  const input = join(root, "export");
  const databasePath = join(root, "rai.sqlite");
  const markdownPath = join(root, "audit.md");
  const jsonPath = join(root, "audit.json");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), `<HealthData>
    <ActivitySummary dateComponents="2026-01-02" activeEnergyBurned="500"/>
  </HealthData>`);
  const original = await RaiDatabase.open(databasePath);
  original.setManifest("original_marker", "preserved-in-displaced");
  original.close();

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx",
        resolve("packages/health-export-parser/src/cli.ts"),
        "import", "--input", input, "--database", databasePath, "--replace",
        "--report", markdownPath, "--json-report", jsonPath
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);

    const active = await RaiDatabase.open(databasePath);
    let datasetVersion: string;
    try {
      datasetVersion = (active.database.prepare(`
        SELECT value FROM import_manifest WHERE key = 'dataset_version'
      `).get() as unknown as { value: string }).value;
      const summaries = active.database.prepare(`
        SELECT COUNT(*) AS count FROM activity_summaries
      `).get() as unknown as { count: number };
      assert.equal(summaries.count, 1);
    } finally {
      active.close();
    }

    const jsonAudit = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      datasetVersion: string;
    };
    assert.equal(jsonAudit.datasetVersion, datasetVersion);
    assert.match(readFileSync(markdownPath, "utf8"), new RegExp(datasetVersion));

    const displacedName = readdirSync(root).find((name) =>
      name.startsWith("rai.sqlite.replaced.")
    );
    assert.ok(displacedName);
    const displaced = await RaiDatabase.open(join(root, displacedName));
    try {
      const marker = displaced.database.prepare(`
        SELECT value FROM import_manifest WHERE key = 'original_marker'
      `).get() as unknown as { value: string };
      assert.equal(marker.value, "preserved-in-displaced");
    } finally {
      displaced.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI refuses a concurrent publisher before changing the active database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-lock-"));
  const input = join(root, "export");
  const databasePath = join(root, "rai.sqlite");
  mkdirSync(input);
  mkdirSync(`${databasePath}.import.lock`);
  writeFileSync(
    join(`${databasePath}.import.lock`, "owner.json"),
    JSON.stringify({ token: "active-test", pid: process.pid, kind: "cli", startedAt: new Date().toISOString() })
  );
  writeFileSync(join(input, "export.xml"), "<HealthData/>");
  const original = await RaiDatabase.open(databasePath);
  original.setManifest("original_marker", "locked");
  original.close();

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--import", "tsx",
        resolve("packages/health-export-parser/src/cli.ts"),
        "import", "--input", input, "--database", databasePath, "--replace",
        "--report", join(root, "audit.md"), "--json-report", join(root, "audit.json")
      ],
      { cwd: resolve("."), encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Another cli process is using/);
    const preserved = await RaiDatabase.open(databasePath);
    try {
      const marker = preserved.database.prepare(`
        SELECT value FROM import_manifest WHERE key = 'original_marker'
      `).get() as unknown as { value: string };
      assert.equal(marker.value, "locked");
    } finally {
      preserved.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
