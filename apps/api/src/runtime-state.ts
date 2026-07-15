import { existsSync, readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RuntimeImportSourceRow {
  id: string;
  kind: string;
  displayName: string;
  inputPath: string;
  originalPath: string;
  sourceSha256: string | null;
  exportFileName: string;
  exportBytes: number;
  routeFileCount: number;
  modifiedAt: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface RuntimeImportJobRow {
  id: string;
  status: string;
  phase: string;
  message: string;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
  inputPath: string;
  progress?: number;
  summary?: unknown;
}

export class RuntimeStateStore {
  readonly path: string;

  constructor(runtimeRoot: string) {
    this.path = resolve(runtimeRoot, "var/runtime.sqlite");
    mkdirSync(dirname(this.path), { recursive: true });
    this.initialize();
  }

  migrateLegacySources(path: string): void {
    this.migrateOnce("legacy_sources_json_v1", () => {
      if (!existsSync(path)) return;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: number; sources?: RuntimeImportSourceRow[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.sources)) return;
      for (const source of parsed.sources) this.upsertSource(source);
    });
  }

  migrateLegacyJobs(path: string): void {
    this.migrateOnce("legacy_import_jobs_json_v1", () => {
      if (!existsSync(path)) return;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeImportJobRow[];
      if (!Array.isArray(parsed)) return;
      for (const job of parsed.slice(-20)) {
        if (job && typeof job.id === "string" && typeof job.inputPath === "string") this.upsertJob(job);
      }
    });
  }

  sources(): RuntimeImportSourceRow[] {
    const db = this.open();
    try {
      return db.prepare(`SELECT id, kind, display_name AS displayName, input_path AS inputPath,
        original_path AS originalPath, source_sha256 AS sourceSha256,
        export_file_name AS exportFileName, export_bytes AS exportBytes,
        route_file_count AS routeFileCount, modified_at AS modifiedAt,
        created_at AS createdAt, last_used_at AS lastUsedAt
        FROM import_sources ORDER BY created_at, id`).all() as unknown as RuntimeImportSourceRow[];
    } finally { db.close(); }
  }

  upsertSource(source: RuntimeImportSourceRow): void {
    const db = this.open();
    try {
      db.prepare(`INSERT INTO import_sources (id, kind, display_name, input_path, original_path,
        source_sha256, export_file_name, export_bytes, route_file_count, modified_at, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, display_name=excluded.display_name,
        input_path=excluded.input_path, original_path=excluded.original_path,
        source_sha256=excluded.source_sha256, export_file_name=excluded.export_file_name,
        export_bytes=excluded.export_bytes, route_file_count=excluded.route_file_count,
        modified_at=excluded.modified_at,
        last_used_at=CASE
          WHEN import_sources.last_used_at IS NULL THEN excluded.last_used_at
          WHEN excluded.last_used_at IS NULL THEN import_sources.last_used_at
          WHEN excluded.last_used_at > import_sources.last_used_at THEN excluded.last_used_at
          ELSE import_sources.last_used_at
        END`).run(
        source.id, source.kind, source.displayName, source.inputPath, source.originalPath,
        source.sourceSha256, source.exportFileName, source.exportBytes, source.routeFileCount,
        source.modifiedAt, source.createdAt, source.lastUsedAt
      );
    } finally { db.close(); }
  }

  deleteSource(id: string): void {
    const db = this.open();
    try { db.prepare("DELETE FROM import_sources WHERE id = ?").run(id); }
    finally { db.close(); }
  }

  jobs(limit = 20): RuntimeImportJobRow[] {
    const db = this.open();
    try {
      const rows = db.prepare(`SELECT id, status, phase, message, created_at AS createdAt,
        completed_at AS completedAt, error, input_path AS inputPath, progress, summary_json AS summaryJson
        FROM import_jobs ORDER BY sequence_number DESC LIMIT ?`).all(limit) as unknown as Array<RuntimeImportJobRow & { summaryJson: string | null }>;
      return rows.reverse().map(({ summaryJson, progress, ...row }) => ({
        ...row,
        ...(progress === null || progress === undefined ? {} : { progress }),
        ...(summaryJson ? { summary: JSON.parse(summaryJson) } : {})
      }));
    } finally { db.close(); }
  }

  upsertJob(job: RuntimeImportJobRow): void {
    const db = this.open();
    try {
      db.prepare(`INSERT INTO import_jobs (id, status, phase, message, created_at, completed_at,
        error, input_path, progress, summary_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, phase=excluded.phase,
        message=excluded.message, completed_at=excluded.completed_at, error=excluded.error,
        input_path=excluded.input_path, progress=excluded.progress, summary_json=excluded.summary_json`).run(
        job.id, job.status, job.phase, job.message, job.createdAt, job.completedAt,
        job.error, job.inputPath, job.progress ?? null, job.summary === undefined ? null : JSON.stringify(job.summary)
      );
    } finally { db.close(); }
  }

  private initialize(): void {
    const db = this.open();
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS import_sources (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL,
          input_path TEXT NOT NULL, original_path TEXT NOT NULL, source_sha256 TEXT,
          export_file_name TEXT NOT NULL, export_bytes INTEGER NOT NULL,
          route_file_count INTEGER NOT NULL, modified_at TEXT NOT NULL,
          created_at TEXT NOT NULL, last_used_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_import_sources_last_used ON import_sources(last_used_at DESC);
        CREATE INDEX IF NOT EXISTS idx_import_sources_sha ON import_sources(source_sha256);
        CREATE TABLE IF NOT EXISTS import_jobs (
          sequence_number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL, phase TEXT NOT NULL, message TEXT NOT NULL,
          created_at TEXT NOT NULL, completed_at TEXT, error TEXT,
          input_path TEXT NOT NULL, progress REAL, summary_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_import_jobs_created ON import_jobs(created_at DESC);`);
    } finally { db.close(); }
  }

  private migrateOnce(key: string, migration: () => void): void {
    const db = this.open();
    try {
      if (db.prepare("SELECT 1 FROM runtime_meta WHERE key = ?").get(key)) return;
    } finally { db.close(); }
    try { migration(); } catch { /* Invalid legacy state must not block startup. */ }
    const marker = this.open();
    try { marker.prepare("INSERT OR IGNORE INTO runtime_meta (key, value) VALUES (?, ?)").run(key, new Date().toISOString()); }
    finally { marker.close(); }
  }

  private open(): DatabaseSync {
    const db = new DatabaseSync(this.path);
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  }
}
