import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface PublicationLockOwner {
  token: string;
  pid: number;
  kind: "api" | "cli";
  startedAt: string;
  processIdentity?: string | null;
}

/**
 * The platform lookups the liveness rule depends on: Linux reads `/proc`, Windows shells
 * out to powershell, everything else runs `ps`. Injecting them is what makes the rule
 * testable — a hardened sandbox denies all three (`operation not permitted: ps`), so the
 * *identity* branch below had no execution path on macOS at all: the integration case
 * could only skip. A probe that cannot read returns `null`, which the rule must read as
 * "cannot prove the owner is gone" — i.e. keep refusing, never reclaim on a guess.
 */
export interface ProcessProbe {
  identity(pid: number): string | null;
  startedAt(pid: number): number | null;
}

interface ExistingPublicationLock {
  owner: Partial<PublicationLockOwner> | null;
  legacyDirectory: boolean;
}

const INCOMPLETE_LOCK_GRACE_MS = 5_000;

function readProcessIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const value = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    if (process.platform === "win32") {
      const result = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
      ], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      const value = result.status === 0 ? result.stdout.trim() : "";
      return value ? `win32:${value}` : null;
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000
    });
    const value = result.status === 0 ? result.stdout.trim() : "";
    return value ? `${process.platform}:${value}` : null;
  } catch {
    return null;
  }
}

let cachedCurrentProcessIdentity: string | null | undefined;

function currentProcessIdentity(): string | null {
  if (cachedCurrentProcessIdentity === undefined) {
    cachedCurrentProcessIdentity = readProcessIdentity(process.pid);
  }
  return cachedCurrentProcessIdentity;
}

/** The production probe. `processIsAlive` defaults to it; tests inject their own. */
const platformProbe: ProcessProbe = {
  identity(pid: number) {
    // Own identity is cached: every acquisition writes it into the owner record, and the
    // probe shells out, so an uncached call would pay for it on each acquisition.
    return pid === process.pid ? currentProcessIdentity() : readProcessIdentity(pid);
  },
  startedAt: readProcessStartedAt
};

function readProcessStartedAt(pid: number): number | null {
  try {
    if (pid === process.pid) return Date.now() - process.uptime() * 1000;
    if (process.platform === "win32") {
      const result = spawnSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
      ], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      const parsed = Date.parse(result.status === 0 ? result.stdout.trim() : "");
      return Number.isFinite(parsed) ? parsed : null;
    }
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000
    });
    const parsed = Date.parse(result.status === 0 ? result.stdout.trim() : "");
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The whole "reclaim or refuse" rule for an existing lock. Exported so it can be pinned
 * with an injected probe on every platform, not only where `/proc` or `ps` happens to work.
 */
export function processIsAlive(
  owner: Partial<PublicationLockOwner>,
  probe: ProcessProbe = platformProbe
): boolean {
  const pid = owner.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (owner.processIdentity) {
    const currentIdentity = probe.identity(pid);
    return currentIdentity === null || currentIdentity === owner.processIdentity;
  }
  if (typeof owner.startedAt === "string") {
    const recordedAt = Date.parse(owner.startedAt);
    const processStartedAt = probe.startedAt(pid);
    if (Number.isFinite(recordedAt) && processStartedAt !== null && processStartedAt > recordedAt + 2_000) {
      return false;
    }
  }
  return true;
}

function readExistingLock(lockPath: string): ExistingPublicationLock {
  let legacyDirectory: boolean;
  try {
    legacyDirectory = statSync(lockPath).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { owner: null, legacyDirectory: false };
    }
    throw error;
  }
  try {
    const ownerPath = legacyDirectory ? resolve(lockPath, "owner.json") : lockPath;
    return {
      owner: JSON.parse(readFileSync(ownerPath, "utf8")) as Partial<PublicationLockOwner>,
      legacyDirectory
    };
  } catch {
    return { owner: null, legacyDirectory };
  }
}

/**
 * Stable reasons a database path cannot be given a publication-lock identity.
 *
 * Every one of them is a refusal: the caller must not fall back to the lexical
 * path, because a lexical name is not a physical database.
 */
export type DatabasePathIdentityErrorCode =
  | "database_path_dangling_symlink"
  | "database_path_symlink_loop"
  | "database_path_not_regular_file"
  | "database_path_hard_link"
  | "database_path_unresolvable";

export class DatabasePathIdentityError extends Error {
  readonly code: DatabasePathIdentityErrorCode;
  readonly databasePath: string;

  constructor(
    code: DatabasePathIdentityErrorCode,
    databasePath: string,
    detail: string,
    options?: { cause?: unknown }
  ) {
    super(`Cannot derive a publication lock identity for ${databasePath}: ${detail}`, options);
    this.name = "DatabasePathIdentityError";
    this.code = code;
    this.databasePath = databasePath;
  }
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identityError(
  code: DatabasePathIdentityErrorCode,
  databasePath: string,
  detail: string,
  cause?: unknown
): DatabasePathIdentityError {
  return new DatabasePathIdentityError(
    code,
    databasePath,
    detail,
    cause === undefined ? undefined : { cause }
  );
}

function realPathOf(target: string, databasePath: string): string {
  try {
    return realpathSync.native(target);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ELOOP") {
      throw identityError(
        "database_path_symlink_loop",
        databasePath,
        `symbolic link loop while resolving ${target} (ELOOP)`,
        error
      );
    }
    throw identityError(
      "database_path_unresolvable",
      databasePath,
      `the real path of ${target} cannot be resolved (${code ?? "unknown error"}): ${errorDetail(error)}`,
      error
    );
  }
}

/**
 * The resolved path must be a plain, single-name regular file. A database kept
 * under two hard-link names has two path identities (`realpath` keeps the name
 * it was called with), so publication locking cannot represent it with one lock
 * file. Refuse explicitly instead of silently protecting only one of the names.
 */
function assertSingleNameRegularFile(realPath: string, databasePath: string): string {
  let linkEntry: Stats;
  try {
    linkEntry = lstatSync(realPath);
  } catch (error) {
    throw identityError(
      "database_path_unresolvable",
      databasePath,
      `the resolved path ${realPath} cannot be inspected: ${errorDetail(error)}`,
      error
    );
  }
  if (!linkEntry.isFile()) {
    throw identityError(
      "database_path_not_regular_file",
      databasePath,
      `the resolved target ${realPath} is not a regular file`
    );
  }
  let target: Stats;
  try {
    target = statSync(realPath);
  } catch (error) {
    throw identityError(
      "database_path_unresolvable",
      databasePath,
      `the resolved target ${realPath} cannot be inspected: ${errorDetail(error)}`,
      error
    );
  }
  if (!target.isFile()) {
    throw identityError(
      "database_path_not_regular_file",
      databasePath,
      `the resolved target ${realPath} is not a regular file`
    );
  }
  if (target.nlink > 1) {
    throw identityError(
      "database_path_hard_link",
      databasePath,
      `the resolved database file ${realPath} has ${target.nlink} hard links; `
        + "hard-linked database files are not supported for publication locking"
    );
  }
  return realPath;
}

/**
 * A missing database (first install) is identified by the real path of its
 * deepest existing ancestor plus the remaining components. This is what makes
 * two parent-directory aliases with no database file yet converge on one lock.
 */
function resolveMissingDatabaseIdentity(unresolvedPath: string, databasePath: string): string {
  const remaining = [basename(unresolvedPath)];
  let current = dirname(unresolvedPath);
  for (;;) {
    let entry: Stats;
    try {
      entry = lstatSync(current);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") {
        const parent = dirname(current);
        if (parent === current) {
          throw identityError(
            "database_path_unresolvable",
            databasePath,
            `no existing ancestor of ${unresolvedPath} could be resolved`,
            error
          );
        }
        remaining.unshift(basename(current));
        current = parent;
        continue;
      }
      if (code === "ELOOP") {
        throw identityError(
          "database_path_symlink_loop",
          databasePath,
          `symbolic link loop while resolving an ancestor of ${unresolvedPath} (ELOOP)`,
          error
        );
      }
      throw identityError(
        "database_path_unresolvable",
        databasePath,
        `existing ancestor ${current} cannot be inspected (${code ?? "unknown error"}): ${errorDetail(error)}`,
        error
      );
    }

    if (entry.isSymbolicLink()) {
      let target: Stats;
      try {
        target = statSync(current);
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ENOENT") {
          throw identityError(
            "database_path_dangling_symlink",
            databasePath,
            `the ancestor ${current} is a dangling symbolic link; refusing to derive a lock identity`,
            error
          );
        }
        if (code === "ELOOP") {
          throw identityError(
            "database_path_symlink_loop",
            databasePath,
            `symbolic link loop while resolving ancestor ${current} (ELOOP)`,
            error
          );
        }
        throw identityError(
          "database_path_unresolvable",
          databasePath,
          `the symbolic-link ancestor ${current} cannot be resolved (${code ?? "unknown error"}): ${errorDetail(error)}`,
          error
        );
      }
      if (!target.isDirectory()) {
        throw identityError(
          "database_path_unresolvable",
          databasePath,
          `existing path component ${current} is not a directory`
        );
      }
    } else if (!entry.isDirectory()) {
      throw identityError(
        "database_path_unresolvable",
        databasePath,
        `existing path component ${current} is not a directory`
      );
    }

    const realAncestor = realPathOf(current, databasePath);
    return join(realAncestor, ...remaining);
  }
}

/**
 * Resolve the one physical identity used for both the lock file name and the
 * API's main-vs-control comparison.
 *
 * - An existing database resolves to its real (symlink-free) file path.
 * - A missing database resolves to `realpath(deepest existing ancestor)` plus
 *   the remaining components, so first installs through directory aliases share
 *   one identity.
 * - Dangling links, loops, unreadable paths, non-regular targets and hard links
 *   are refusals. There is deliberately no lexical fallback.
 *
 * The identity is a path, never an inode: replacing the database file keeps the
 * same `<identity>.import.lock` and therefore the same cross-process lock.
 */
export function resolveDatabasePathIdentity(databasePath: string): string {
  if (typeof databasePath !== "string" || databasePath.trim().length === 0) {
    throw identityError("database_path_unresolvable", String(databasePath), "the database path is empty");
  }

  // Resolve first, without any lexical `resolve()` in front: the native call
  // lets the OS follow symlinks and `..` in filesystem order. `realpathSync`
  // (the JS implementation) normalizes `..` lexically and can therefore name a
  // different file when an earlier component is a symlink.
  let realPath: string;
  try {
    realPath = realpathSync.native(databasePath);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ELOOP") {
      throw identityError(
        "database_path_symlink_loop",
        databasePath,
        `symbolic link loop while resolving ${databasePath} (ELOOP)`,
        error
      );
    }
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw identityError(
        "database_path_unresolvable",
        databasePath,
        `the database path cannot be resolved (${code ?? "unknown error"}): ${errorDetail(error)}`,
        error
      );
    }

    // The path is absent. Distinguish a dangling final symlink (refuse) from a
    // genuinely missing database whose existing ancestors still give an identity.
    let entry: Stats;
    try {
      entry = lstatSync(databasePath);
    } catch (lstatError) {
      const lstatCode = errnoCode(lstatError);
      if (lstatCode === "ENOENT" || lstatCode === "ENOTDIR") {
        return resolveMissingDatabaseIdentity(databasePath, databasePath);
      }
      if (lstatCode === "ELOOP") {
        throw identityError(
          "database_path_symlink_loop",
          databasePath,
          `symbolic link loop while resolving ${databasePath} (ELOOP)`,
          lstatError
        );
      }
      throw identityError(
        "database_path_unresolvable",
        databasePath,
        `the database path cannot be inspected (${lstatCode ?? "unknown error"}): ${errorDetail(lstatError)}`,
        lstatError
      );
    }
    if (entry.isSymbolicLink()) {
      throw identityError(
        "database_path_dangling_symlink",
        databasePath,
        `the database path ${databasePath} is a dangling symbolic link; refusing to derive a lock identity`,
        error
      );
    }
    throw identityError(
      "database_path_unresolvable",
      databasePath,
      `the database path ${databasePath} cannot be resolved to a regular file`,
      error
    );
  }

  return assertSingleNameRegularFile(realPath, databasePath);
}

export function acquireDatabasePublicationLock(
  databasePath: string,
  kind: PublicationLockOwner["kind"]
): () => void {
  // The lock name is the physical identity, not the caller's lexical spelling.
  // This is what stops `<db>` and a symlink to `<db>` from acquiring two locks.
  const target = resolveDatabasePathIdentity(databasePath);
  const lockPath = `${target}.import.lock`;
  const token = randomUUID();
  const owner: PublicationLockOwner = {
    token,
    pid: process.pid,
    kind,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    processIdentity: currentProcessIdentity()
  };
  mkdirSync(dirname(target), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidatePath = `${lockPath}.candidate.${token}`;
    try {
      writeFileSync(candidatePath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      try {
        // Hard-link publication is atomic and never exposes a partially written
        // owner record at the shared lock path.
        linkSync(candidatePath, lockPath);
      } finally {
        unlinkSync(candidatePath);
      }
    } catch (error) {
      try { if (existsSync(candidatePath)) unlinkSync(candidatePath); } catch { /* Best-effort candidate cleanup. */ }
      if (!existsSync(lockPath)) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const existing = readExistingLock(lockPath);
      if (!existsSync(lockPath)) continue;
      if (existing.owner?.pid && processIsAlive(existing.owner)) {
        throw new Error(`Another ${existing.owner.kind ?? "database"} process is using ${target}`);
      }
      if (typeof existing.owner?.token !== "string" || existing.owner.token.length === 0) {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs < INCOMPLETE_LOCK_GRACE_MS) {
          throw new Error(`Another database process is acquiring the publication lock for ${target}`);
        }
        const incompleteTombstone = `${lockPath}.stale.incomplete.${randomUUID()}`;
        try {
          renameSync(lockPath, incompleteTombstone);
        } catch {
          continue;
        }
        continue;
      }

      const staleId = createHash("sha256").update(existing.owner.token).digest("hex").slice(0, 16);
      const tombstonePath = `${lockPath}.stale.${staleId}`;
      if (existing.legacyDirectory) {
        try {
          renameSync(lockPath, tombstonePath);
        } catch {
          continue;
        }
        continue;
      }
      try {
        mkdirSync(tombstonePath);
      } catch {
        try {
          const reclaimed = JSON.parse(
            readFileSync(resolve(tombstonePath, "owner.json"), "utf8")
          ) as Partial<PublicationLockOwner>;
          if (reclaimed.token === existing.owner.token) continue;
        } catch {
          // An empty tombstone is a recoverable interruption before the stale lock was moved.
        }
      }
      try {
        renameSync(lockPath, resolve(tombstonePath, "owner.json"));
      } catch {
        continue;
      }
      // The tombstone is durable replay protection for processes that observed the old token late.
      continue;
    }

    return () => {
      try {
        if (statSync(lockPath).isDirectory()) return;
        const current = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<PublicationLockOwner>;
        if (current.token === token) unlinkSync(lockPath);
      } catch {
        // A missing or replaced lock is not owned by this process anymore.
      }
    };
  }
  throw new Error(`Unable to acquire database publication lock for ${target}`);
}
