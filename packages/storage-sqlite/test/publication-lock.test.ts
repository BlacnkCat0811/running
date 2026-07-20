import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { acquireDatabasePublicationLock } from "../src/index.js";

test("publication lock owns its lifecycle and rejects a live owner", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-publication-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  try {
    const release = acquireDatabasePublicationLock(databasePath, "api");
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; kind: string };
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.kind, "api");
    assert.throws(() => acquireDatabasePublicationLock(databasePath, "cli"), /Another api process is using/);
    release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock replaces a stale owner", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-stale-publication-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  writeFileSync(lockPath, JSON.stringify({
    token: "stale",
    pid: 2_147_483_647,
    kind: "cli",
    startedAt: "2020-01-01T00:00:00.000Z"
  }));
  try {
    const release = acquireDatabasePublicationLock(databasePath, "api");
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string; pid: number };
    assert.notEqual(owner.token, "stale");
    assert.equal(owner.pid, process.pid);
    assert.equal(existsSync(`${lockPath}.stale.a03f2386ae06b211`), true);
    release();
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock is rejected by a competing process", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cross-process-publication-lock-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    const release = acquireDatabasePublicationLock(databasePath, "api");
    const script = `
      import { acquireDatabasePublicationLock } from "./packages/storage-sqlite/src/index.ts";
      try {
        acquireDatabasePublicationLock(process.argv[1], "cli");
        process.exitCode = 2;
      } catch (error) {
        console.error(error.message);
      }
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, databasePath], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(child.status, 0);
    assert.match(child.stderr, /Another api process is using/);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock does not remove an incompletely written lock file", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-incomplete-publication-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  writeFileSync(lockPath, "", "utf8");
  try {
    assert.throws(
      () => acquireDatabasePublicationLock(databasePath, "api"),
      /is acquiring the publication lock/
    );
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock reclaims an abandoned incomplete lock after the safety grace period", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-abandoned-incomplete-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  writeFileSync(lockPath, "", "utf8");
  utimesSync(lockPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
  try {
    const release = acquireDatabasePublicationLock(databasePath, "api");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
    assert.equal(
      readdirSync(root).some((name) => name.includes(".stale.incomplete.")),
      true
    );
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock never replaces an existing empty legacy directory", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-empty-legacy-publication-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  mkdirSync(lockPath);
  try {
    assert.throws(
      () => acquireDatabasePublicationLock(databasePath, "cli"),
      /publication lock/
    );
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock resumes stale recovery after an empty tombstone interruption", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-interrupted-stale-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  writeFileSync(lockPath, JSON.stringify({
    token: "stale", pid: 2_147_483_647, kind: "cli", startedAt: "2020-01-01T00:00:00.000Z"
  }));
  mkdirSync(`${lockPath}.stale.a03f2386ae06b211`);
  try {
    const release = acquireDatabasePublicationLock(databasePath, "api");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock recovers a stale legacy directory", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-stale-legacy-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
    token: "legacy-stale", pid: 2_147_483_647, kind: "cli", startedAt: "2020-01-01T00:00:00.000Z"
  }));
  try {
    const release = acquireDatabasePublicationLock(databasePath, "api");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock rejects PID reuse when the process identity differs", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-reused-pid-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  writeFileSync(lockPath, JSON.stringify({
    token: "reused-pid", pid: process.pid, kind: "cli",
    startedAt: "2020-01-01T00:00:00.000Z", processIdentity: "different-process"
  }));
  try {
    const release = acquireDatabasePublicationLock(databasePath, "api");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock detects PID reuse for a legacy owner from startedAt", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-legacy-reused-pid-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
    token: "legacy-reused-pid", pid: process.pid, kind: "cli", startedAt: "2020-01-01T00:00:00.000Z"
  }));
  try {
    const release = acquireDatabasePublicationLock(databasePath, "api");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
