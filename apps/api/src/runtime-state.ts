import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ImportExecutionEngine, ImportJobPerformance, RemovalGuardDto } from "@rai/api-contracts";

export interface RuntimeImportSourceRow {
  id: string;
  kind: string;
  displayName: string;
  inputPath: string;
  originalPath: string;
  sourceSha256: string | null;
  idempotencyKey?: string | null;
  archiveSha256?: string | null;
  exportFileName: string;
  exportBytes: number;
  routeFileCount: number;
  modifiedAt: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface RuntimeImportJobRow {
  id: string;
  sourceId?: string;
  status: string;
  phase: string;
  message: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  inputPath: string;
  progress?: number;
  summary?: unknown;
  performance?: ImportJobPerformance;
  removalGuard?: RemovalGuardDto;
  preserveAbsent?: boolean;
  queue?: { scope: string; attempts: number; finalized: boolean; cancelRequested?: boolean; engine?: ImportExecutionEngine };
}

export class RuntimeStateStore {
  readonly path: string;

  constructor(runtimeRoot: string) {
    this.path = resolve(runtimeRoot, "var/runtime.sqlite");
    mkdirSync(dirname(this.path), { recursive: true });
    try {
      this.initialize();
    } catch (error) {
      if (!this.isCorruptDatabaseError(error) || !existsSync(this.path)) throw error;
      this.quarantineCorruptDatabase();
      this.initialize();
    }
  }

  migrateLegacySources(path: string): void {
    if (!existsSync(path)) return;
    let parsed: { version?: number; sources?: RuntimeImportSourceRow[] };
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as typeof parsed;
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.sources)) return;
    this.migrateOnce("legacy_sources_json_v1", (db) => {
      for (const source of parsed.sources ?? []) this.upsertSourceIn(db, source);
    });
  }

  migrateLegacyJobs(path: string): void {
    if (!existsSync(path)) return;
    let parsed: RuntimeImportJobRow[];
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeImportJobRow[];
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (!Array.isArray(parsed)) return;
    this.migrateOnce("legacy_import_jobs_json_v1", (db) => {
      for (const job of parsed.slice(-20)) {
        if (job && typeof job.id === "string" && typeof job.inputPath === "string") {
          this.upsertJobIn(db, job);
        }
      }
    });
  }

  sources(): RuntimeImportSourceRow[] {
    return this.withCorruptionRecovery(() => this.readSources());
  }

  source(id: string): RuntimeImportSourceRow | null {
    return this.withCorruptionRecovery(() => this.readSource(
      "WHERE id = ?",
      [id]
    ));
  }

  sourceByIdempotencyKey(idempotencyKey: string): RuntimeImportSourceRow | null {
    return this.withCorruptionRecovery(() => this.readSource(
      "WHERE idempotency_key = ?",
      [idempotencyKey]
    ));
  }

  mostRecentlyUsedSourceBySha(sourceSha256: string, excludingId: string): RuntimeImportSourceRow | null {
    return this.withCorruptionRecovery(() => this.readSource(
      "WHERE source_sha256 = ? AND id <> ? AND last_used_at IS NOT NULL ORDER BY last_used_at DESC LIMIT 1",
      [sourceSha256, excludingId]
    ));
  }

  private readSource(whereClause: string, parameters: string[]): RuntimeImportSourceRow | null {
    const db = this.open();
    try {
      return (db.prepare(`SELECT id, kind, display_name AS displayName, input_path AS inputPath,
        original_path AS originalPath, source_sha256 AS sourceSha256,
        idempotency_key AS idempotencyKey, archive_sha256 AS archiveSha256,
        export_file_name AS exportFileName, export_bytes AS exportBytes,
        route_file_count AS routeFileCount, modified_at AS modifiedAt,
        created_at AS createdAt, last_used_at AS lastUsedAt
        FROM import_sources ${whereClause}`).get(...parameters) as unknown as RuntimeImportSourceRow | undefined) ?? null;
    } finally { db.close(); }
  }

  private readSources(): RuntimeImportSourceRow[] {
    const db = this.open();
    try {
      return db.prepare(`SELECT id, kind, display_name AS displayName, input_path AS inputPath,
        original_path AS originalPath, source_sha256 AS sourceSha256,
        idempotency_key AS idempotencyKey, archive_sha256 AS archiveSha256,
        export_file_name AS exportFileName, export_bytes AS exportBytes,
        route_file_count AS routeFileCount, modified_at AS modifiedAt,
        created_at AS createdAt, last_used_at AS lastUsedAt
        FROM import_sources ORDER BY created_at, id`).all() as unknown as RuntimeImportSourceRow[];
    } finally { db.close(); }
  }

  upsertSource(source: RuntimeImportSourceRow): void {
    this.withCorruptionRecovery(() => this.writeSource(source));
  }

  private writeSource(source: RuntimeImportSourceRow): void {
    const db = this.open();
    try {
      this.upsertSourceIn(db, source);
    } finally { db.close(); }
  }

  private upsertSourceIn(db: DatabaseSync, source: RuntimeImportSourceRow): void {
    db.prepare(`INSERT INTO import_sources (id, kind, display_name, input_path, original_path,
        source_sha256, idempotency_key, export_file_name, export_bytes, route_file_count, modified_at, created_at, last_used_at, archive_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, display_name=excluded.display_name,
        input_path=excluded.input_path, original_path=excluded.original_path,
        source_sha256=excluded.source_sha256, idempotency_key=COALESCE(excluded.idempotency_key, import_sources.idempotency_key),
        archive_sha256=COALESCE(excluded.archive_sha256, import_sources.archive_sha256),
        export_file_name=excluded.export_file_name,
        export_bytes=excluded.export_bytes, route_file_count=excluded.route_file_count,
        modified_at=excluded.modified_at,
        last_used_at=CASE
          WHEN import_sources.last_used_at IS NULL THEN excluded.last_used_at
          WHEN excluded.last_used_at IS NULL THEN import_sources.last_used_at
          WHEN excluded.last_used_at > import_sources.last_used_at THEN excluded.last_used_at
          ELSE import_sources.last_used_at
        END`).run(
        source.id, source.kind, source.displayName, source.inputPath, source.originalPath,
        source.sourceSha256, source.idempotencyKey ?? null, source.exportFileName, source.exportBytes, source.routeFileCount,
        source.modifiedAt, source.createdAt, source.lastUsedAt, source.archiveSha256 ?? null
      );
  }

  deleteSource(id: string): void {
    this.withCorruptionRecovery(() => this.removeSource(id));
  }

  markSourceUsed(id: string, usedAt: string): void {
    this.withCorruptionRecovery(() => this.updateSourceUsedAt(id, usedAt));
  }

  private updateSourceUsedAt(id: string, usedAt: string): void {
    const db = this.open();
    try {
      db.prepare(`UPDATE import_sources SET last_used_at = CASE
        WHEN last_used_at IS NULL OR last_used_at < ? THEN ?
        ELSE last_used_at
      END WHERE id = ?`).run(usedAt, usedAt, id);
    } finally { db.close(); }
  }

  private removeSource(id: string): void {
    const db = this.open();
    try { db.prepare("DELETE FROM import_sources WHERE id = ?").run(id); }
    finally { db.close(); }
  }

  jobs(limit = 20): RuntimeImportJobRow[] {
    return this.withCorruptionRecovery(() => this.readJobs(limit));
  }

  latestJobForSource(sourceId: string): RuntimeImportJobRow | null {
    return this.withCorruptionRecovery(() => this.readJobs(1, sourceId).at(-1) ?? null);
  }

  job(id: string): RuntimeImportJobRow | null {
    return this.withCorruptionRecovery(() => this.readJobs(1, undefined, id).at(-1) ?? null);
  }

  private readJobs(limit: number, sourceId?: string, id?: string): RuntimeImportJobRow[] {
    const db = this.open();
    try {
      const rows = db.prepare(`SELECT id, source_id AS sourceId, status, phase, message, created_at AS createdAt,
        completed_at AS completedAt, error, input_path AS inputPath, progress, summary_json AS summaryJson,
        removal_guard_json AS removalGuardJson, performance_json AS performanceJson, execution_json AS executionJson
        FROM import_jobs ${id !== undefined ? "WHERE id = ?" : sourceId === undefined ? `WHERE status IN ('queued', 'running') OR json_extract(execution_json, '$.queue.finalized') = 0 OR sequence_number IN
          (SELECT sequence_number FROM import_jobs ORDER BY sequence_number DESC LIMIT ?)
        ORDER BY sequence_number DESC` : "WHERE source_id = ? ORDER BY sequence_number DESC LIMIT 1"}`).all(id ?? sourceId ?? limit) as unknown as Array<RuntimeImportJobRow & {
          sourceId: string | null;
          summaryJson: string | null;
          removalGuardJson: string | null;
          performanceJson: string | null;
          executionJson: string | null;
        }>;
      return rows.reverse().map(({ sourceId, summaryJson, removalGuardJson, performanceJson, executionJson, progress, ...row }) => ({
        ...row,
        ...(sourceId === null ? {} : { sourceId }),
        ...(progress === null || progress === undefined ? {} : { progress }),
        ...(summaryJson ? { summary: JSON.parse(summaryJson) } : {}),
        ...(performanceJson ? { performance: JSON.parse(performanceJson) } : {}),
        ...(executionJson ? JSON.parse(executionJson) as Pick<RuntimeImportJobRow, "queue" | "preserveAbsent"> : {}),
        ...(removalGuardJson ? { removalGuard: JSON.parse(removalGuardJson) } : {})
      }));
    } finally { db.close(); }
  }

  upsertJob(job: RuntimeImportJobRow): void {
    this.withCorruptionRecovery(() => this.writeJob(job));
  }

  /** A final acknowledgement must not leave a stale committed publication intent. */
  finalizeImportJob(job: RuntimeImportJobRow): void {
    const db = this.open();
    try {
      db.exec("PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
      try {
        this.upsertJobIn(db, job);
        db.prepare("DELETE FROM import_publications WHERE id = ?").run(job.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally { db.close(); }
  }

  private writeJob(job: RuntimeImportJobRow): void {
    const db = this.open();
    try {
      this.upsertJobIn(db, job);
    } finally { db.close(); }
  }

  private upsertJobIn(db: DatabaseSync, job: RuntimeImportJobRow): void {
    db.prepare(`INSERT INTO import_jobs (id, source_id, status, phase, message, created_at, completed_at,
        error, input_path, progress, summary_json, removal_guard_json, performance_json, execution_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id, status=excluded.status, phase=excluded.phase,
        message=excluded.message, completed_at=excluded.completed_at, error=excluded.error,
        input_path=excluded.input_path, progress=excluded.progress, summary_json=excluded.summary_json,
        removal_guard_json=excluded.removal_guard_json, performance_json=excluded.performance_json,
        execution_json=excluded.execution_json`).run(
        job.id, job.sourceId ?? null, job.status, job.phase, job.message, job.createdAt, job.completedAt,
        job.error, job.inputPath, job.progress ?? null, job.summary === undefined ? null : JSON.stringify(job.summary),
        job.removalGuard === undefined ? null : JSON.stringify(job.removalGuard),
        job.performance === undefined ? null : JSON.stringify(job.performance),
        JSON.stringify({ ...(job.preserveAbsent === undefined ? {} : { preserveAbsent: job.preserveAbsent }),
          ...(job.queue === undefined ? {} : { queue: job.queue }) })
      );
  }

  private initialize(): void {
    const db = this.open();
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS import_sources (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL,
          input_path TEXT NOT NULL, original_path TEXT NOT NULL, source_sha256 TEXT,
          idempotency_key TEXT UNIQUE,
          export_file_name TEXT NOT NULL, export_bytes INTEGER NOT NULL,
          route_file_count INTEGER NOT NULL, modified_at TEXT NOT NULL,
          created_at TEXT NOT NULL, last_used_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_import_sources_last_used ON import_sources(last_used_at DESC);
        CREATE INDEX IF NOT EXISTS idx_import_sources_sha ON import_sources(source_sha256);
        CREATE TABLE IF NOT EXISTS import_jobs (
          sequence_number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          source_id TEXT, status TEXT NOT NULL, phase TEXT NOT NULL, message TEXT NOT NULL,
          created_at TEXT NOT NULL, completed_at TEXT, error TEXT,
          input_path TEXT NOT NULL, progress REAL, summary_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_import_jobs_created ON import_jobs(created_at DESC);`);
      const jobColumns = db.prepare("PRAGMA table_info(import_jobs)").all() as unknown as Array<{ name: string }>;
      if (!jobColumns.some(({ name }) => name === "source_id")) {
        db.exec("ALTER TABLE import_jobs ADD COLUMN source_id TEXT");
      }
      if (!jobColumns.some(({ name }) => name === "removal_guard_json")) {
        db.exec("ALTER TABLE import_jobs ADD COLUMN removal_guard_json TEXT");
      }
      if (!jobColumns.some(({ name }) => name === "performance_json")) {
        db.exec("ALTER TABLE import_jobs ADD COLUMN performance_json TEXT");
      }
      if (!jobColumns.some(({ name }) => name === "execution_json")) {
        db.exec("ALTER TABLE import_jobs ADD COLUMN execution_json TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_import_jobs_source ON import_jobs(source_id, sequence_number DESC)");
      const sourceColumns = db.prepare("PRAGMA table_info(import_sources)").all() as unknown as Array<{ name: string }>;
      if (!sourceColumns.some(({ name }) => name === "archive_sha256")) {
        db.exec("ALTER TABLE import_sources ADD COLUMN archive_sha256 TEXT");
      }
      if (!sourceColumns.some(({ name }) => name === "idempotency_key")) {
        db.exec("ALTER TABLE import_sources ADD COLUMN idempotency_key TEXT");
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_import_sources_idempotency ON import_sources(idempotency_key)");
      }
    } finally { db.close(); }
  }

  private migrateOnce(key: string, migration: (db: DatabaseSync) => void): void {
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT 1 FROM runtime_meta WHERE key = ?").get(key)) {
          db.exec("COMMIT");
          return;
        }
        migration(db);
        db.prepare("INSERT INTO runtime_meta (key, value) VALUES (?, ?)").run(key, new Date().toISOString());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally { db.close(); }
  }

  private open(): DatabaseSync {
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private isCorruptDatabaseError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /file is not a database|database disk image is malformed|database.*corrupt/i.test(message);
  }

  private quarantineCorruptDatabase(): void {
    const quarantineId = `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.${randomUUID().slice(0, 8)}`;
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${this.path}${suffix}`;
      if (!existsSync(source)) continue;
      renameSync(source, `${this.path}.corrupt-${quarantineId}${suffix}`);
    }
  }

  private withCorruptionRecovery<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (!this.isCorruptDatabaseError(error) || !existsSync(this.path)) throw error;
      this.quarantineCorruptDatabase();
      this.initialize();
      return operation();
    }
  }
}
