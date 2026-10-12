import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildAudit, type DataAudit } from "@rai/health-export-parser";
import type { DataOnlyImportInput } from "./data-only-import.js";
import type { DirectSyncImportInput } from "./direct-sync-ingest.js";

export type ImportDatabaseTask =
  | { operation: "verify"; path: string }
  | { operation: "audit"; path: string }
  | { operation: "checkpoint"; path: string }
  | { operation: "data-only"; input: DataOnlyImportInput }
  | { operation: "direct-sync"; input: DirectSyncImportInput };

/** Startup recovery also uses this; normal imports execute it in a Worker. */
export function databaseReadable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare("PRAGMA quick_check").get()?.quick_check === "ok";
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

export function buildImportAudit(path: string): DataAudit {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return buildAudit(database);
  } finally {
    database.close();
  }
}

export function checkpointImportDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result?.busy !== 0) throw new Error("Import database checkpoint is busy");
  } finally {
    database.close();
  }
}
