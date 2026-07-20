import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

interface PublicationLockOwner {
  token: string;
  pid: number;
  kind: "api" | "cli";
  startedAt: string;
  processIdentity?: string | null;
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

function processIsAlive(owner: Partial<PublicationLockOwner>): boolean {
  const pid = owner.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (owner.processIdentity) {
    const currentIdentity = pid === process.pid ? currentProcessIdentity() : readProcessIdentity(pid);
    return currentIdentity === null || currentIdentity === owner.processIdentity;
  }
  if (typeof owner.startedAt === "string") {
    const recordedAt = Date.parse(owner.startedAt);
    const processStartedAt = readProcessStartedAt(pid);
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

export function acquireDatabasePublicationLock(
  databasePath: string,
  kind: PublicationLockOwner["kind"]
): () => void {
  const target = resolve(databasePath);
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
