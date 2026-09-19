import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { acquireDatabasePublicationLock, processIsAlive, type ProcessProbe } from "../src/index.js";

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

test("publication lock rejects PID reuse when the process identity differs", (context) => {
  const root = mkdtempSync(join(tmpdir(), "rai-reused-pid-lock-"));
  const databasePath = join(root, "rai.sqlite");
  const lockPath = `${databasePath}.import.lock`;
  writeFileSync(lockPath, JSON.stringify({
    token: "reused-pid", pid: process.pid, kind: "cli",
    startedAt: "2020-01-01T00:00:00.000Z", processIdentity: "different-process"
  }));
  // This scenario needs the platform process-identity probe: /proc on Linux,
  // powershell on Windows, `ps` elsewhere. When the probe is unavailable the
  // lock implementation fail-safely treats the owner as alive (and rejects),
  // so the reclaim path cannot be exercised; skip instead of failing.
  const probe = ((): boolean => {
    if (process.platform === "linux") return true;
    if (process.platform === "win32") {
      const result = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "(Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')"
      ], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      return result.status === 0 && result.stdout.trim().length > 0;
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
      encoding: "utf8",
      timeout: 5_000
    });
    return result.status === 0 && result.stdout.trim().length > 0;
  })();
  if (!probe) {
    context.skip("process identity probing is unavailable in this environment");
    return;
  }
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

// The three cases below pin `processIsAlive` — the whole "reclaim or refuse" decision —
// with an injected probe. They exist because the two integration cases above can only
// reach the *identity* branch where the platform probe works (`/proc`, powershell, `ps`),
// and a hardened sandbox denies all three; there, the case above skips and the identity
// branch had no execution path at all. The consequence is concrete: the API holds this
// lock for its entire lifetime (`server.ts` acquires it at startup and releases it on
// exit), which is exactly what stops a CLI import from running against a database the API
// is already using — so declaring a live owner "stale" would let an import rewrite rows
// under a serving API, including mid-restore. That rule is worth pinning everywhere, not
// only where the probe happens to answer.
function probeOf(identity: string | null, startedAt: number | null = null): ProcessProbe {
  return { identity: () => identity, startedAt: () => startedAt };
}

test("publication lock reclaims a reused PID only when the identity proves it", () => {
  const owner = { pid: process.pid, processIdentity: "macos:Mon Sep 15 10:00:00 2025" };
  assert.equal(processIsAlive(owner, probeOf("macos:Mon Sep 15 10:00:00 2025")), true,
    "an unchanged identity means the recorded owner is still the running process");
  assert.equal(processIsAlive(owner, probeOf("macos:Tue Sep 16 09:00:00 2025")), false,
    "a different identity means the PID was reused and the lock may be reclaimed");
  assert.equal(processIsAlive(owner, probeOf(null)), true,
    "a probe that cannot read is not evidence the owner is gone, so refuse");
});

test("publication lock falls back to startedAt only when no identity was recorded", () => {
  const recordedAt = Date.parse("2025-09-15T10:00:00.000Z");
  const owner = { pid: process.pid, startedAt: "2025-09-15T10:00:00.000Z" };
  assert.equal(processIsAlive(owner, probeOf("linux:irrelevant", recordedAt + 60_000)), false,
    "a process that started a minute later cannot be the recorded owner");
  assert.equal(processIsAlive(owner, probeOf("linux:irrelevant", recordedAt + 1_000)), true,
    "a start time inside the 2s skew window is not evidence of reuse");
  assert.equal(processIsAlive(owner, probeOf("linux:irrelevant", recordedAt - 60_000)), true,
    "an earlier start time still matches the recorded owner");
  assert.equal(processIsAlive(owner, probeOf("linux:irrelevant", null)), true,
    "without a start time the owner cannot be proven gone, so refuse");
  assert.equal(processIsAlive(
    { pid: process.pid, startedAt: "2025-09-15T10:00:00.000Z", processIdentity: "macos:x" },
    probeOf("macos:x", recordedAt + 60_000)
  ), true, "a recorded identity decides the question; startedAt must not override it");
});

test("publication lock refuses a malformed owner and treats EPERM as alive", () => {
  const probe = probeOf(null);
  assert.equal(processIsAlive({}, probe), false, "a missing pid cannot be reclaimed");
  assert.equal(processIsAlive({ pid: 0 }, probe), false);
  assert.equal(processIsAlive({ pid: -1 }, probe), false);
  assert.equal(processIsAlive({ pid: 1.5 }, probe), false, "a non-integer pid is not a process");
  assert.equal(processIsAlive({ pid: 1 }, probe), true,
    "EPERM means the process exists but is not ours — still alive");
});
