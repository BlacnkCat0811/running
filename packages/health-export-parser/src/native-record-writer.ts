import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { CanonicalHealthRecord } from "@rai/contracts";
import type { RaiDatabase } from "./database.js";
import { NativeWorkerError, prepareNative, type NativeOptions } from "./native-worker.js";

/** Keep normalization and ID hashing in JS; send typed rows via a private DB,
 * not millions of JSON IPC messages. Rust owns the hot observation/upsert loop. */
export class NativeRecordWriter {
  private readonly path: string;
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private closed = false;
  private count = 0;
  constructor(directory: string, generation: string, batchId: string | undefined, incremental: boolean) {
    this.path = join(directory, "canonical.sqlite");
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-8192;
      CREATE TABLE apply_config (generation TEXT,batch_id TEXT,incremental INTEGER);
      CREATE TABLE canonical_records (
        sequence INTEGER PRIMARY KEY,id TEXT,type TEXT,source_name TEXT,source_category TEXT,source_version TEXT,
        device TEXT,unit TEXT,value_numeric REAL,value_text TEXT,start_at TEXT,end_at TEXT,created_at TEXT,
        metadata_json TEXT,raw_attributes_json TEXT,content_hash TEXT
      ); BEGIN`);
    this.db.prepare("INSERT INTO apply_config VALUES (?,?,?)").run(generation, batchId ?? null, incremental ? 1 : 0);
    this.insert = this.db.prepare("INSERT INTO canonical_records VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  }
  capture(record: CanonicalHealthRecord, category: string, attributes: Record<string, string>, hash: string): void {
    this.insert.run(record.id, record.type, record.sourceName, category, record.sourceVersion, record.device, record.unit,
      record.numericValue, record.textValue, record.startAt, record.endAt, record.createdAt,
      JSON.stringify(record.metadata), JSON.stringify(attributes), hash);
    this.count++;
    if (this.count % 4096 === 0) {
      const pages = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
      const size = this.db.prepare("PRAGMA page_size").get() as { page_size: number };
      if (pages.page_count * size.page_size > 8 * 1024 ** 3) throw new NativeWorkerError("resource_limit");
    }
  }
  async apply(store: RaiDatabase, options: NativeOptions): Promise<{ inserted: number; tombstoned: number }> {
    this.db.exec("COMMIT");
    this.close();
    if (this.count === 0) return { inserted: 0, tombstoned: 0 };
    const target = options.stagingDatabase;
    const main = (store.database.prepare("PRAGMA database_list").all() as { name: string; file: string }[])
      .find((row) => row.name === "main")?.file;
    const canonicalTarget = target ? realpathSync(target) : null;
    if (!canonicalTarget || !main || canonicalTarget !== realpathSync(main) || !/\.importing\.[a-f0-9-]{36}$/.test(canonicalTarget)) {
      throw new Error("Native record writes require a CLI-owned staging database");
    }
    const permit = randomBytes(32).toString("hex");
    store.setManifest("rai.native_import_permit", permit);
    store.flush();
    const result = await prepareNative("apply-records", this.path, { ...options, stagingDatabase: canonicalTarget, permit, fallback: "none" });
    if (!result) throw new Error("Native record writer did not return a result");
    try {
      if (result.result.observedRecords !== this.count) throw new Error("Native record count mismatch");
      return { inserted: result.result.insertedRecords!, tombstoned: result.result.tombstonedRecords! };
    } finally { await result.dispose(); }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
