import { existsSync, renameSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ImportJobResponse } from "@rai/api-contracts";

interface Publication {
  id: string; databasePath: string; rollbackPath: string;
  originalExisted: boolean; phase: "prepared" | "committed";
}
const receiptKey = (id: string): string => `rai.applied-import.${id}`;

export function readImportReceipt(path: string, id: string): ImportJobResponse["summary"] | null {
  if (!existsSync(path)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM import_manifest WHERE key = ?").get(receiptKey(id)) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as ImportJobResponse["summary"] : null;
  } catch { return null; }
  finally { db?.close(); }
}

export function writeImportReceipt(path: string, id: string, summary: NonNullable<ImportJobResponse["summary"]>): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
    db.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)").run(receiptKey(id), JSON.stringify(summary));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
}

/** Durable rename intent: a killed process must never silently lose the old DB. */
export class ImportPublicationJournal {
  readonly rolledBackIds = new Set<string>();
  private readonly path: string;
  constructor(private readonly databasePath: string, private readonly runtimeRoot: string) {
    this.path = resolve(runtimeRoot, "var/runtime.sqlite");
    this.use((db) => db.exec("CREATE TABLE IF NOT EXISTS import_publications (id TEXT PRIMARY KEY, payload TEXT NOT NULL)"));
  }
  private use<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
      return fn(db);
    } finally { db.close(); }
  }
  prepare(id: string, rollbackPath: string, originalExisted: boolean): void {
    this.save({ id, databasePath: resolve(this.databasePath), rollbackPath: resolve(rollbackPath), originalExisted, phase: "prepared" });
  }
  commit(id: string): void {
    const record = this.records().find((item) => item.id === id);
    if (!record) throw new Error("Import publication intent missing");
    this.save({ ...record, phase: "committed" });
  }
  clear(id: string): void { this.use((db) => db.prepare("DELETE FROM import_publications WHERE id = ?").run(id)); }
  has(id: string): boolean { return this.records().some((record) => record.id === id); }
  private save(value: Publication): void {
    this.use((db) => db.prepare("INSERT OR REPLACE INTO import_publications VALUES (?, ?)").run(value.id, JSON.stringify(value)));
  }
  private records(): Publication[] {
    return this.use((db) => (db.prepare("SELECT payload FROM import_publications").all() as { payload: string }[])
      .map((row) => JSON.parse(row.payload) as Publication));
  }
  recover(): boolean {
    let repaired = false;
    for (const record of this.records()) {
      // Corrupt metadata is a stop, not authority to remove arbitrary files.
      if (record.databasePath !== resolve(this.databasePath) ||
          dirname(record.rollbackPath) !== resolve(this.runtimeRoot, "var/backups") ||
          !record.rollbackPath.startsWith(resolve(this.runtimeRoot, "var/backups/rai.import-rollback.")) ||
          !["prepared", "committed"].includes(record.phase)) throw new Error("Invalid import publication journal");
      if (record.phase === "committed") {
        if (!readImportReceipt(this.databasePath, record.id)) throw new Error("Committed import receipt missing; manual recovery required");
        // Keep intent until runtime job acknowledgement is durable.
        continue;
      }
      if (existsSync(record.rollbackPath)) {
        if (existsSync(this.databasePath) && !readImportReceipt(this.databasePath, record.id)) {
          throw new Error("Unexpected active database during import recovery; manual recovery required");
        }
        const rollback = new DatabaseSync(record.rollbackPath, { readOnly: true });
        try {
          if ((rollback.prepare("PRAGMA quick_check").get() as { quick_check?: string })?.quick_check !== "ok") {
            throw new Error("Import rollback database failed integrity check");
          }
        } finally { rollback.close(); }
        for (const suffix of ["-wal", "-shm", ""]) rmSync(`${this.databasePath}${suffix}`, { force: true });
        renameSync(record.rollbackPath, this.databasePath);
        repaired = true;
      } else if (readImportReceipt(this.databasePath, record.id)) {
        if (record.originalExisted) throw new Error("Import rollback point missing; refusing unsafe recovery");
        for (const suffix of ["-wal", "-shm", ""]) rmSync(`${this.databasePath}${suffix}`, { force: true });
        repaired = true;
      } else if (record.originalExisted && !existsSync(this.databasePath)) {
        throw new Error("Import database and rollback point missing; manual recovery required");
      } else if (!record.originalExisted && existsSync(this.databasePath)) {
        throw new Error("Unexpected active database during initial import recovery; manual recovery required");
      }
      this.clear(record.id);
      this.rolledBackIds.add(record.id);
    }
    return repaired;
  }
}
