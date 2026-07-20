import assert from "node:assert/strict";
import {
  mkdirSync,
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
