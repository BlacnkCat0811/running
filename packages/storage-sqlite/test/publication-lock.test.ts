import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DatabasePathIdentityError,
  acquireDatabasePublicationLock,
  processIsAlive,
  resolveDatabasePathIdentity,
  type ProcessProbe
} from "../src/index.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const STORAGE_ENTRY = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;

function createFixtureDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE fixture_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO fixture_rows (id, value) VALUES (1, 'unchanged')").run();
  } finally {
    database.close();
  }
}

function fixtureRows(databasePath: string): unknown[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT id, value FROM fixture_rows ORDER BY id").all();
  } finally {
    database.close();
  }
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function lockPathFor(databasePath: string): string {
  return `${realpathSync(databasePath)}.import.lock`;
}

function readLockOwner(lockPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
}

function assertFixtureUnchanged(databasePath: string, hashBefore: string, rowsBefore: unknown[]): void {
  assert.equal(fileSha256(databasePath), hashBefore, "a refused lock must not change the database file");
  assert.deepEqual(fixtureRows(databasePath), rowsBefore, "a refused lock must not change database rows");
}

function runLockChild(databasePath: string, kind: "api" | "cli" = "cli") {
  const script = [
    `import { acquireDatabasePublicationLock } from ${JSON.stringify(STORAGE_ENTRY)};`,
    `acquireDatabasePublicationLock(process.argv[1], ${JSON.stringify(kind)});`
  ].join("\n");
  return spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval", script, databasePath
  ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 });
}

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
  if (process.platform !== "win32") {
    assert.equal(processIsAlive({ pid: 1 }, probe), true,
      "EPERM means the process exists but is not ours — still alive");
  }
});

// 阶段 4（R1）：锁身份必须是物理库，而不是调用方拼写的词法路径。以下用例全部
// 使用真实子进程争锁；别名/硬链接/悬空链接在身份解析阶段就拒绝，不依赖 `ps`。

test("publication lock: competing process on the direct path exits non-zero and leaves the owner intact", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-lock-direct-identity-"));
  const databasePath = join(root, "rai.sqlite");
  try {
    createFixtureDatabase(databasePath);
    const lockPath = lockPathFor(databasePath);
    const hashBefore = fileSha256(databasePath);
    const rowsBefore = fixtureRows(databasePath);
    const release = acquireDatabasePublicationLock(databasePath, "api");
    try {
      const ownerBefore = readLockOwner(lockPath);
      assert.equal(ownerBefore.pid, process.pid);
      const child = runLockChild(databasePath, "cli");
      assert.notEqual(child.status, 0, "the competing process must exit non-zero");
      assert.match(child.stderr, /Another api process is using/);
      assert.deepEqual(readLockOwner(lockPath), ownerBefore, "the owner record must not be replaced");
      assertFixtureUnchanged(databasePath, hashBefore, rowsBefore);
    } finally {
      release();
    }
    assert.equal(existsSync(lockPath), false);
    const retry = acquireDatabasePublicationLock(databasePath, "cli");
    try {
      assert.equal(readLockOwner(lockPath).kind, "cli");
    } finally {
      retry();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock: a file symlink cannot take a second lock in either direction", (context) => {
  if (process.platform === "win32") {
    context.skip("creating symbolic links needs privileges on this Windows host");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "rai-lock-file-symlink-"));
  const databasePath = join(root, "rai.sqlite");
  const aliasPath = join(root, "alias.sqlite");
  try {
    createFixtureDatabase(databasePath);
    symlinkSync("rai.sqlite", aliasPath);
    const lockPath = lockPathFor(databasePath);
    const hashBefore = fileSha256(databasePath);
    const rowsBefore = fixtureRows(databasePath);

    // Direction 1: lock held on the real path, alias tries to acquire.
    const releaseReal = acquireDatabasePublicationLock(databasePath, "api");
    try {
      const ownerBefore = readLockOwner(lockPath);
      const child = runLockChild(aliasPath, "cli");
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /Another api process is using/);
      assert.deepEqual(readLockOwner(lockPath), ownerBefore);
      assertFixtureUnchanged(databasePath, hashBefore, rowsBefore);
    } finally {
      releaseReal();
    }

    // Direction 2: lock held through the alias, real path tries to acquire.
    const releaseAlias = acquireDatabasePublicationLock(aliasPath, "api");
    try {
      const ownerBefore = readLockOwner(lockPath);
      const child = runLockChild(databasePath, "cli");
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /Another api process is using/);
      assert.deepEqual(readLockOwner(lockPath), ownerBefore);
      assertFixtureUnchanged(databasePath, hashBefore, rowsBefore);
    } finally {
      releaseAlias();
    }

    const retry = acquireDatabasePublicationLock(aliasPath, "cli");
    try {
      assert.equal(readLockOwner(lockPath).kind, "cli");
    } finally {
      retry();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock: a parent-directory symlink shares the physical lock identity", (context) => {
  if (process.platform === "win32") {
    context.skip("creating directory symbolic links needs privileges on this Windows host");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "rai-lock-dir-symlink-"));
  const realDirectory = join(root, "real");
  const aliasDirectory = join(root, "alias");
  const databasePath = join(realDirectory, "rai.sqlite");
  try {
    mkdirSync(realDirectory, { recursive: true });
    createFixtureDatabase(databasePath);
    symlinkSync(realDirectory, aliasDirectory, "dir");
    const aliasDatabasePath = join(aliasDirectory, "rai.sqlite");
    const lockPath = lockPathFor(databasePath);
    const hashBefore = fileSha256(databasePath);
    const rowsBefore = fixtureRows(databasePath);

    const release = acquireDatabasePublicationLock(databasePath, "api");
    try {
      const ownerBefore = readLockOwner(lockPath);
      const child = runLockChild(aliasDatabasePath, "cli");
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /Another api process is using/);
      assert.deepEqual(readLockOwner(lockPath), ownerBefore);
      assertFixtureUnchanged(databasePath, hashBefore, rowsBefore);
    } finally {
      release();
    }

    const retry = acquireDatabasePublicationLock(aliasDatabasePath, "cli");
    try {
      assert.equal(readLockOwner(lockPath).kind, "cli");
    } finally {
      retry();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock: a symlink followed by .. resolves in filesystem order, not lexically", (context) => {
  if (process.platform === "win32") {
    context.skip("creating symbolic links needs privileges on this Windows host");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "rai-lock-symlink-dotdot-"));
  const realDirectory = join(root, "real");
  const innerDirectory = join(realDirectory, "inner");
  const aliasDirectory = join(root, "alias");
  try {
    mkdirSync(innerDirectory, { recursive: true });
    createFixtureDatabase(join(realDirectory, "rai.sqlite"));
    symlinkSync(innerDirectory, aliasDirectory, "dir");
    const pathThroughSymlinkAndDotDot = `${aliasDirectory}/../rai.sqlite`;
    assert.equal(
      resolveDatabasePathIdentity(pathThroughSymlinkAndDotDot),
      realpathSync.native(join(realDirectory, "rai.sqlite")),
      "link/.. must resolve through the link target, not by lexical normalization"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock: first install through two parent aliases has one missing-database identity", (context) => {
  if (process.platform === "win32") {
    context.skip("creating directory symbolic links needs privileges on this Windows host");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "rai-lock-missing-db-alias-"));
  const realDirectory = join(root, "real");
  const aliasA = join(root, "alias-a");
  const aliasB = join(root, "alias-b");
  try {
    mkdirSync(realDirectory, { recursive: true });
    symlinkSync(realDirectory, aliasA, "dir");
    symlinkSync(realDirectory, aliasB, "dir");
    const databaseA = join(aliasA, "var", "rai.sqlite");
    const databaseB = join(aliasB, "var", "rai.sqlite");
    const identity = join(realpathSync(realDirectory), "var", "rai.sqlite");
    const lockPath = `${identity}.import.lock`;

    const release = acquireDatabasePublicationLock(databaseA, "api");
    try {
      assert.equal(existsSync(identity), false, "acquiring a first-install lock must not create the database");
      assert.equal(existsSync(lockPath), true);
      const ownerBefore = readLockOwner(lockPath);
      const child = runLockChild(databaseB, "cli");
      assert.notEqual(child.status, 0, "the second alias must not acquire the first-install lock");
      assert.match(child.stderr, /Another api process is using/);
      assert.deepEqual(readLockOwner(lockPath), ownerBefore);
      assert.equal(existsSync(identity), false);
    } finally {
      release();
    }
    assert.equal(existsSync(lockPath), false);

    const retry = acquireDatabasePublicationLock(databaseB, "cli");
    try {
      assert.equal(readLockOwner(lockPath).kind, "cli");
      assert.equal(existsSync(identity), false);
    } finally {
      retry();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock: a hard-linked database is rejected with a stable hard-link error", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-lock-hard-link-"));
  const databasePath = join(root, "rai.sqlite");
  const hardLinkPath = join(root, "hard-link.sqlite");
  try {
    createFixtureDatabase(databasePath);
    const release = acquireDatabasePublicationLock(databasePath, "api");
    try {
      const lockPath = lockPathFor(databasePath);
      const ownerBefore = readLockOwner(lockPath);
      linkSync(databasePath, hardLinkPath);
      const hashBefore = fileSha256(databasePath);
      const rowsBefore = fixtureRows(databasePath);

      assert.throws(
        () => resolveDatabasePathIdentity(hardLinkPath),
        (error: unknown) => error instanceof DatabasePathIdentityError
          && error.code === "database_path_hard_link",
        "the identity function must reject nlink > 1"
      );
      assert.throws(() => acquireDatabasePublicationLock(databasePath, "cli"), /hard link/);

      const child = runLockChild(hardLinkPath, "cli");
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /hard link/);
      assert.deepEqual(readLockOwner(lockPath), ownerBefore);
      assertFixtureUnchanged(databasePath, hashBefore, rowsBefore);
    } finally {
      release();
    }
    unlinkSync(hardLinkPath);
    const retry = acquireDatabasePublicationLock(databasePath, "cli");
    try {
      assert.equal(readLockOwner(lockPathFor(databasePath)).kind, "cli");
    } finally {
      retry();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock: a dangling symlink is refused without reclaiming a lexical lock", (context) => {
  if (process.platform === "win32") {
    context.skip("creating symbolic links needs privileges on this Windows host");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "rai-lock-dangling-"));
  const danglingPath = join(root, "dangling.sqlite");
  const missingTarget = join(root, "missing.sqlite");
  const lexicalLockPath = `${missingTarget}.import.lock`;
  try {
    symlinkSync("missing.sqlite", danglingPath);
    writeFileSync(lexicalLockPath, JSON.stringify({
      token: "must-not-be-reclaimed",
      pid: 2_147_483_647,
      kind: "api",
      startedAt: "2020-01-01T00:00:00.000Z"
    }));
    const ownerBefore = readFileSync(lexicalLockPath, "utf8");

    assert.throws(
      () => resolveDatabasePathIdentity(danglingPath),
      (error: unknown) => error instanceof DatabasePathIdentityError
        && error.code === "database_path_dangling_symlink"
    );
    const child = runLockChild(danglingPath, "cli");
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /dangling symbolic link/);
    assert.equal(readFileSync(lexicalLockPath, "utf8"), ownerBefore,
      "a dangling alias must not fall back to and reclaim the lexical path's lock");
    assert.equal(existsSync(missingTarget), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock: a symlink loop is refused without reclaiming a lexical lock", (context) => {
  if (process.platform === "win32") {
    context.skip("creating symbolic links needs privileges on this Windows host");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "rai-lock-symlink-loop-"));
  const loopA = join(root, "loop-a.sqlite");
  const loopB = join(root, "loop-b.sqlite");
  const lexicalLockPath = `${loopA}.import.lock`;
  try {
    symlinkSync("loop-b.sqlite", loopA);
    symlinkSync("loop-a.sqlite", loopB);
    writeFileSync(lexicalLockPath, JSON.stringify({
      token: "must-not-be-reclaimed",
      pid: 2_147_483_647,
      kind: "api",
      startedAt: "2020-01-01T00:00:00.000Z"
    }));
    const ownerBefore = readFileSync(lexicalLockPath, "utf8");

    assert.throws(
      () => resolveDatabasePathIdentity(loopA),
      (error: unknown) => error instanceof DatabasePathIdentityError
        && error.code === "database_path_symlink_loop"
    );
    const child = runLockChild(loopA, "cli");
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /symbolic link loop/);
    assert.equal(readFileSync(lexicalLockPath, "utf8"), ownerBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock: a directory is not a database identity", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-lock-not-regular-"));
  const directoryPath = join(root, "database-as-directory");
  try {
    mkdirSync(directoryPath);
    assert.throws(
      () => resolveDatabasePathIdentity(directoryPath),
      (error: unknown) => error instanceof DatabasePathIdentityError
        && error.code === "database_path_not_regular_file"
    );
    assert.equal(existsSync(`${directoryPath}.import.lock`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication lock: identity stays on the same lock path across database file replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-lock-file-replacement-"));
  const databasePath = join(root, "rai.sqlite");
  const replacementPath = join(root, "replacement.sqlite");
  try {
    createFixtureDatabase(databasePath);
    const lockPath = lockPathFor(databasePath);
    const release = acquireDatabasePublicationLock(databasePath, "api");
    try {
      const ownerBefore = readLockOwner(lockPath);
      createFixtureDatabase(replacementPath);
      renameSync(replacementPath, databasePath);
      assert.equal(existsSync(lockPath), true, "file replacement must not move the lock");
      assert.deepEqual(readLockOwner(lockPath), ownerBefore);
      assert.equal(resolveDatabasePathIdentity(databasePath), realpathSync(databasePath));
    } finally {
      release();
    }
    const retry = acquireDatabasePublicationLock(databasePath, "cli");
    try {
      assert.equal(readLockOwner(lockPath).kind, "cli");
    } finally {
      retry();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
