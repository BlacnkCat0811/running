import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface RestoreIntentBase {
  target: string;
  staging: string;
  snapshot: string | null;
  snapshotIsQuarantine: boolean;
  phase: "prepared" | "installed" | "committed";
}

/**
 * The original, unbound journal format. It can still roll back a **pre-commit**
 * interruption, but a `committed` intent from this format carries no planned
 * epoch or deletion binding and therefore cannot finalize a restore by itself.
 */
export interface LegacyRestoreIntent extends RestoreIntentBase {}

/**
 * A crash-replayable explicit restore intent.
 *
 * It is written before the main database is replaced and binds the operation
 * to the deletion journal it supersedes, the exact backup bytes it was
 * authorized to install, and the epoch that will be written into the restored
 * database. `mainSha256` is recorded after the replacement is checkpointed and
 * fsynced; startup compares it with the actual bytes before finalizing.
 */
export interface BoundRestoreIntent extends RestoreIntentBase {
  version: 2;
  configuredEpoch: string;
  serverId: string;
  athleteId: string;
  /** `null` for an ordinary backup restore outside a deletion recovery. */
  deletionId: string | null;
  backupName: string;
  backupSha256: string;
  backupSizeBytes: number;
  plannedEpoch: string;
  /** Required once `phase === "committed"`. */
  mainSha256?: string;
}

export type RestoreIntent = LegacyRestoreIntent | BoundRestoreIntent;

export function isBoundRestoreIntent(intent: RestoreIntent): intent is BoundRestoreIntent {
  return "version" in intent && intent.version === 2;
}

export class RestoreRecoveryRequiredError extends AggregateError {
  constructor(message: string, options?: ErrorOptions) {
    const cause = options?.cause;
    super(cause instanceof AggregateError ? cause.errors : cause ? [cause] : [], message, options);
    this.name = "RestoreRecoveryRequiredError";
  }
  readonly statusCode = 503;
  readonly code = "restore_recovery_required";
}

const SHA256 = /^[0-9a-f]{64}$/;
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Separate from runtime.sqlite: corruption recovery must never discard this intent. */

/** Compare restore-intent paths by physical identity, not lexical spelling. */
function physicalPath(path: string): string {
  const absolute = resolve(path);
  const suffix: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || dirname(current) === current) {
        return absolute;
      }
      suffix.unshift(basename(current));
      current = dirname(current);
    }
  }
}

export class RestoreJournal {
  private readonly path: string;
  constructor(private readonly target: string, private readonly runtimeRoot: string) {
    this.path = `${resolve(target)}.restore-journal.sqlite`;
  }

  private use<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS restore_intent (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)");
      return operation(db);
    } finally { db.close(); }
  }

  read(): RestoreIntent | null {
    if (!existsSync(this.path)) return null;
    let db: DatabaseSync;
    try {
      // Read-only: a missing/truncated journal is evidence of an interrupted
      // restore, not permission to silently create a fresh empty journal.
      db = new DatabaseSync(this.path, { readOnly: true });
    } catch (error) {
      throw new RestoreRecoveryRequiredError(
        "Restore journal is unreadable; manual recovery required", { cause: error });
    }
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const table = db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='restore_intent'"
      ).get() as { present: number } | undefined;
      if (table === undefined) {
        throw new RestoreRecoveryRequiredError(
          "Restore journal is missing its restore_intent table; manual recovery required");
      }
      const row = db.prepare("SELECT payload FROM restore_intent WHERE id=1").get() as { payload: string } | undefined;
      if (!row) return null;
      let value: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.payload) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("intent is not an object");
        }
        value = parsed as Record<string, unknown>;
      } catch {
        throw new RestoreRecoveryRequiredError("Invalid restore journal; manual recovery required");
      }
      const targetPhysical = physicalPath(this.target);
      const snapshotRoot = physicalPath(resolve(this.runtimeRoot, value.snapshotIsQuarantine === true ? "var/quarantine" : "var/backups"));
      if (typeof value.target !== "string" || physicalPath(value.target) !== targetPhysical ||
          typeof value.staging !== "string" ||
          typeof value.snapshotIsQuarantine !== "boolean" ||
          !physicalPath(value.staging).startsWith(`${targetPhysical}.restoring.`) ||
          dirname(physicalPath(value.staging)) !== dirname(targetPhysical) ||
          (value.snapshot !== null && (typeof value.snapshot !== "string" || dirname(physicalPath(value.snapshot)) !== snapshotRoot)) ||
          !["prepared", "installed", "committed"].includes(String(value.phase))) {
        throw new RestoreRecoveryRequiredError("Invalid restore journal; manual recovery required");
      }
      if ("version" in value) {
        if (value.version !== 2 ||
            !isNonEmptyString(value.configuredEpoch) ||
            !isNonEmptyString(value.serverId) ||
            !isNonEmptyString(value.athleteId) ||
            !(value.deletionId === null || isNonEmptyString(value.deletionId)) ||
            !isNonEmptyString(value.backupName) ||
            basename(value.backupName) !== value.backupName ||
            !value.backupName.endsWith(".sqlite") ||
            typeof value.backupSha256 !== "string" || !SHA256.test(value.backupSha256) ||
            !Number.isSafeInteger(value.backupSizeBytes) || (value.backupSizeBytes as number) < 0 ||
            !isNonEmptyString(value.plannedEpoch) ||
            (value.mainSha256 !== undefined && (typeof value.mainSha256 !== "string" || !SHA256.test(value.mainSha256))) ||
            (value.phase === "committed" && (typeof value.mainSha256 !== "string" || !SHA256.test(value.mainSha256)))) {
          throw new RestoreRecoveryRequiredError("Invalid restore journal; manual recovery required");
        }
      }
      return value as unknown as RestoreIntent;
    } finally {
      db.close();
    }
  }

  write(value: RestoreIntent): void {
    this.use((db) => db.prepare("INSERT OR REPLACE INTO restore_intent VALUES (1, ?)").run(JSON.stringify(value)));
  }

  clear(): void {
    this.use((db) => db.exec("DELETE FROM restore_intent WHERE id=1"));
  }
}
