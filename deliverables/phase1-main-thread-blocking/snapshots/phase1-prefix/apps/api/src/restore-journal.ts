import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RestoreIntent {
  target: string;
  staging: string;
  snapshot: string | null;
  snapshotIsQuarantine: boolean;
  phase: "prepared" | "installed" | "committed";
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

/** Separate from runtime.sqlite: corruption recovery must never discard this intent. */
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
    return this.use((db) => {
      const row = db.prepare("SELECT payload FROM restore_intent WHERE id=1").get() as { payload: string } | undefined;
      if (!row) return null;
      const value = JSON.parse(row.payload) as RestoreIntent;
      const snapshotRoot = resolve(this.runtimeRoot, value?.snapshotIsQuarantine ? "var/quarantine" : "var/backups");
      if (!value || typeof value !== "object" || typeof value.staging !== "string" ||
          typeof value.snapshotIsQuarantine !== "boolean" || value.target !== resolve(this.target) ||
          !value.staging.startsWith(`${resolve(this.target)}.restoring.`) ||
          dirname(value.staging) !== dirname(resolve(this.target)) ||
          (value.snapshot !== null && (typeof value.snapshot !== "string" || dirname(value.snapshot) !== snapshotRoot)) ||
          !["prepared", "installed", "committed"].includes(value.phase)) {
        throw new RestoreRecoveryRequiredError("Invalid restore journal; manual recovery required");
      }
      return value;
    });
  }

  write(value: RestoreIntent): void {
    this.use((db) => db.prepare("INSERT OR REPLACE INTO restore_intent VALUES (1, ?)").run(JSON.stringify(value)));
  }

  clear(): void {
    this.use((db) => db.exec("DELETE FROM restore_intent WHERE id=1"));
  }
}
