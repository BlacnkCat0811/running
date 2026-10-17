import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { CanonicalHealthRecord } from "@rai/contracts";
import type { RaiDatabase } from "./database.js";
import { NativeWorkerError, prepareNative, type NativeOptions } from "./native-worker.js";

export interface NativeApplyOutcome {
  inserted: number;
  tombstoned: number;
  /** Rows the worker READ from `canonical_records` (before tombstone filtering). */
  observed: number;
}

/**
 * 输入 spool 的字节上限。与 `crates/rai-data-worker` 的 `SPOOL_LIMIT` 同值 —— 两侧**不共享代码**，
 * 各自守各自的 spool：Rust 那条在 XML 解码循环里量它自己写的 spool，这条量 TS 写的
 * `canonical.sqlite`。同一批里两者可以同时生效，互不读取。
 */
export const SPOOL_LIMIT_BYTES = 8 * 1024 ** 3;

/**
 * 每多少行做一次体积检查。
 *
 * 原值 4096：按平均记录大小估算，"超界不被察觉"的窗口最大可到 4096 条记录的空间（约 4–40 MiB）。
 * 512 把窗口压到 1/8；代价是每 512 行一次 `PRAGMA page_count`（100 万行 ⇒ 1953 次，不是 1953 万次）。
 * `page_size` 不再每次都查 —— 它对已存在的库文件是不变量（改它要 VACUUM 重排），见构造函数。
 */
const SPOOL_LIMIT_CHECK_INTERVAL = 512;

/** Keep normalization and ID hashing in JS; send typed rows via a private DB,
 * not millions of JSON IPC messages. Rust owns the hot observation/upsert loop. */
export class NativeRecordWriter {
  private readonly path: string;
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly batchId: string | undefined;
  private readonly incremental: boolean;
  /** 见 `SPOOL_LIMIT_BYTES`；构造参数可覆盖，**仅用于测试**。 */
  private readonly spoolLimitBytes: number;
  /** `page_size` 是库文件的不变量，只在构造时读一次；会变的是 `page_count`。 */
  private readonly pageSizeBytes: number;
  private closed = false;
  private count = 0;
  /** B1: folded over every captured row; finalized at most once by `inputDigest()`. */
  private readonly digest = createHash("sha256");
  private digestHex: string | null = null;
  /** False when the installed worker predates B1; the import still proceeds. */
  private digestAvailable = true;
  constructor(
    directory: string, generation: string, batchId: string | undefined, incremental: boolean,
    /**
     * 只给测试用（参数名带 `test` 前缀）：把上限降到可触发的量级，才能在不造 8 GiB 数据的前提下
     * 证明这条守卫真的会响。⛔ 生产不许从这里接配置/环境变量 —— 一个误配就能打死全部导入。
     */
    testOptions: { spoolLimitBytes?: number } = {}
  ) {
    this.path = join(directory, "canonical.sqlite");
    this.batchId = batchId;
    this.incremental = incremental;
    this.spoolLimitBytes = testOptions.spoolLimitBytes ?? SPOOL_LIMIT_BYTES;
    this.db = new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-8192;
      CREATE TABLE apply_config (generation TEXT,batch_id TEXT,incremental INTEGER);
      CREATE TABLE canonical_records (
        sequence INTEGER PRIMARY KEY,id TEXT,type TEXT,source_name TEXT,source_category TEXT,source_version TEXT,
        device TEXT,unit TEXT,value_numeric REAL,value_text TEXT,start_at TEXT,end_at TEXT,created_at TEXT,
        metadata_json TEXT,raw_attributes_json TEXT,content_hash TEXT
      ); BEGIN`);
    // 页大小在建库时定死（改它要 VACUUM 重排），所以读一次就够；随写入变化的是 page_count。
    this.pageSizeBytes = (this.db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    this.db.prepare("INSERT INTO apply_config VALUES (?,?,?)").run(generation, batchId ?? null, incremental ? 1 : 0);
    this.insert = this.db.prepare("INSERT INTO canonical_records VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  }
  capture(record: CanonicalHealthRecord, category: string, attributes: Record<string, string>, hash: string): void {
    this.insert.run(record.id, record.type, record.sourceName, category, record.sourceVersion, record.device, record.unit,
      record.numericValue, record.textValue, record.startAt, record.endAt, record.createdAt,
      JSON.stringify(record.metadata), JSON.stringify(attributes), hash);
    this.count++;
    // B1 (runtime invariant, see docs/RUST_DATA_ENGINE.md): this sequence must be
    // byte-identical to the fold in crates/rai-data-worker `apply_records` — same
    // 1-based ordinal, same "|" separators, same trailing newline. The ordinal (not
    // `sequence`) is used because the worker never SELECTs `sequence`; both sides
    // count every row, so both are gap-free.
    this.digest.update(`${this.count}|${record.id}|${hash}\n`);
    if (this.count % SPOOL_LIMIT_CHECK_INTERVAL === 0) {
      const pages = this.db.prepare("PRAGMA page_count").get() as { page_count: number };
      if (pages.page_count * this.pageSizeBytes > this.spoolLimitBytes) {
        throw new NativeWorkerError("resource_limit");
      }
    }
  }
  /** `createHash` can only be finalized once, and B3 replays the apply step. */
  private inputDigest(): string {
    this.digestHex ??= this.digest.digest("hex");
    return this.digestHex;
  }
  /** Change-ledger rows this batch contributed; 0 when no batch id (i.e. `--replace`). */
  private ledgerCount(store: RaiDatabase): number {
    if (!this.batchId) return 0;
    const row = store.database
      .prepare("SELECT COUNT(*) AS n FROM import_entity_changes WHERE batch_id = ?")
      .get(this.batchId) as { n: number };
    return row.n;
  }
  private async runApply(store: RaiDatabase, target: string, options: NativeOptions):
    Promise<{ inserted: number; tombstoned: number; observed: number; digest: string | undefined }> {
    // The one-shot permit is a write barrier for identity, not an ordering nonce: it
    // is re-armed before every apply so a replay is authenticated the same way.
    const permit = randomBytes(32).toString("hex");
    store.setManifest("rai.native_import_permit", permit);
    // 同上：按所有权提交（caller 模式下由调用方提交）。native apply 必须**先**让 permit 可见，
    // 所以这一段在 store 模式下确实要提交 —— `flushIfOwned` 保留了那个语义。
    store.flushIfOwned();
    const result = await prepareNative("apply-records", this.path, {
      ...options, stagingDatabase: target, permit, fallback: "none"
    });
    if (!result) throw new Error("Native record writer did not return a result");
    try {
      if (result.result.observedRecords !== this.count) throw new Error("Native record count mismatch");
      const digest = result.result.canonicalDigest;
      if (digest === undefined) {
        // Older worker binary: B1 cannot run. Recorded by `apply()`, not thrown here.
        this.digestAvailable = false;
      } else if (digest !== this.inputDigest()) {
        throw new Error(
          `Native input digest mismatch: rust=${digest} ts=${this.inputDigest()} rows=${this.count}`
        );
      }
      return {
        inserted: result.result.insertedRecords!,
        tombstoned: result.result.tombstonedRecords!,
        observed: result.result.observedRecords!,
        digest
      };
    } finally { await result.dispose(); }
  }
  /**
   * B3 (runtime invariant): replaying the identical apply must change nothing.
   *
   * Runs for INCREMENTAL batches ONLY, and that scoping is load-bearing rather than an
   * optimization. Under `--replace` the check has no signal left to give:
   *   - `tombstoned` is a read-side count, identical on both passes by construction;
   *   - `inserted` counts rows the worker WROTE, and under `--replace` it writes every
   *     row again (`if !incremental || !exists || updated` in the worker), so the second
   *     pass legitimately reports the full row count;
   *   - the change ledger is not written at all without a batch id (`if let Some(batch)`),
   *     so its delta is `0 === 0` — the earlier claim that it was a "mode-independent
   *     assertion" was wrong.
   * What remains is `observed` plus the B1 digest, i.e. input-side properties B1 already
   * proves. Paying a full second write pass for that is a pure loss, so `apply()` does
   * not call this for replace imports.
   *
   * Runs IN PLACE against the same candidate rather than a copy. That is deliberate:
   * the only way this reports non-idempotence is when the candidate is already
   * unusable, and the importer discards the candidate wholesale on any failure
   * (`import-worker.ts` → `removeDatabaseFiles(stagingDatabase)`), so a second-pass
   * write can never cost us a recovery point we would otherwise have kept.
   */
  private async assertIdempotent(store: RaiDatabase, target: string, options: NativeOptions, observed: number): Promise<void> {
    const before = this.ledgerCount(store);
    const replay = await this.runApply(store, target, { ...options, purpose: "replay" });
    if (replay.observed !== observed) {
      throw new Error("Native replay read a different input set than the first apply");
    }
    if (replay.digest !== undefined && replay.digest !== this.inputDigest()) {
      throw new Error("Native replay hashed a different input set than the first apply");
    }
    const after = this.ledgerCount(store);
    if (after !== before) {
      throw new Error(`Native apply is not idempotent: change ledger grew by ${after - before}`);
    }
    // `tombstoned` is deliberately NOT asserted: it counts rows the worker SKIPPED, and a
    // skipped row is skipped identically on the second pass. A non-zero value is therefore
    // expected — and asserting zero would fail the import precisely when the payload
    // reintroduces a previously deleted record, which is a legal input. `inserted` counts
    // rows the worker actually WROTE, so zero on replay is the real idempotence signal.
    // (`this.incremental` is implied: `apply()` only calls this for incremental batches.)
    if (replay.inserted !== 0) {
      throw new Error(`Native apply is not idempotent: inserted=${replay.inserted}`);
    }
  }
  /**
   * B4 (runtime invariant): re-read a bounded sample of the canonical input and compare
   * the columns the candidate actually stores.
   *
   * B1 proves what was READ and B3 proves the write is deterministic — neither can see a
   * systematic divergence where both sides agree on totals (e.g. `SEED_CONTENT_HASH`
   * drifting out of sync between languages). This is the only cheap check that looks at
   * CONTENT, and it is the replacement for coverage the removed shadow comparison never
   * actually provided for the write path.
   *
   * The comparison is exact, not approximate: every compared column is a function of the
   * same `(attributes, metadata)` pair that `contentHash` hashes
   * (`apple-health-parser.ts:429`), so an unwritten row is only unwritten because the
   * stored row already holds byte-identical content. A mismatch therefore means the write
   * path diverged — it cannot mean "the worker chose not to rewrite".
   *
   * It samples, so it can prove the PRESENCE of a divergence but never its absence. Rows
   * the candidate does not hold are skipped: they may legitimately be tombstones, and the
   * tombstone decision belongs to the worker, not to this process.
   *
   * Mounted here rather than in the API (`import-dataset-analysis.ts`) because the
   * canonical spool is deleted by the importer once the CLI exits.
   */
  private assertSampleMatches(store: RaiDatabase, sampleSize = 64): void {
    const columns = [
      "type", "source_name", "source_category", "source_version", "device", "unit",
      "value_numeric", "value_text", "start_at", "end_at", "created_at",
      "metadata_json", "raw_attributes_json"
    ] as const;
    const canonical = new DatabaseSync(this.path, { readOnly: true });
    try {
      // `DESC` plus the id de-duplication below are load-bearing, not cosmetic. Record ids
      // are derived from `[type, sourceName, startAt, endAt, value, unit]`, deliberately
      // excluding `device` (`apple-health-parser.ts:191` — Apple exports the same sample
      // with and without it), so one id CAN appear several times in a single spool and the
      // worker's upsert keeps the LAST occurrence. Because the window is the tail, any
      // occurrence later than the window start is itself inside the window, so the highest
      // sequence seen for an id in `DESC` order IS that id's final write. Dropping repeat
      // ids therefore samples rows the worker must have written verbatim; sampling the head
      // (or keeping repeats) would compare superseded rows and report divergences that are
      // not there.
      const rows = canonical
        .prepare(`SELECT id, ${columns.join(",")} FROM canonical_records ORDER BY sequence DESC LIMIT ?`)
        .all(sampleSize) as Array<Record<string, unknown> & { id: string }>;
      const seen = new Set<string>();
      const sample: typeof rows = [];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        sample.push(row);
      }
      const stored = store.database.prepare(`SELECT ${columns.join(",")} FROM health_records WHERE id = ?`);
      const lineage = store.database.prepare(
        "SELECT content_hash FROM import_entity_generations WHERE entity_kind = 'record' AND entity_id = ?"
      );
      const divergences: string[] = [];
      let sampled = 0;
      let compared = 0;
      for (const row of sample) {
        sampled++;
        const actual = stored.get(row.id) as Record<string, unknown> | undefined;
        if (!actual) continue;
        compared++;
        for (const column of columns) {
          if (actual[column] !== row[column]) divergences.push(`${row.id}.${column}`);
        }
        if (!lineage.get(row.id)) divergences.push(`${row.id}.generation-row-missing`);
      }
      // A zero-compared sample is NOT a pass. Without this guard the loop above reports
      // nothing and the check "succeeds" while having looked at no row at all — the
      // empty-assertion shape this file has already been burned by. Reported as an issue
      // rather than thrown, matching B2: an import whose candidate legitimately holds
      // only tombstoned rows must still succeed, but it must not look verified.
      if (compared === 0) {
        store.insertIssue({
          severity: "warning",
          code: "invariant.b4.no_rows_compared",
          objectId: this.batchId ?? null,
          message: `B4 compared 0 of ${sampled} sampled canonical row(s): none of them is held by `
            + "the candidate database (all sampled ids are tombstoned, or the candidate is empty). "
            + "The write-path content check is inactive for this import."
        });
      }
      if (divergences.length) {
        const shown = divergences.slice(0, 8).join(", ");
        const rest = divergences.length > 8 ? ` (+${divergences.length - 8} more)` : "";
        throw new Error(`Native write diverged from the canonical input on sampled rows: ${shown}${rest}`);
      }
    } finally { canonical.close(); }
  }
  async apply(store: RaiDatabase, options: NativeOptions): Promise<NativeApplyOutcome> {
    this.db.exec("COMMIT");
    this.close();
    if (this.count === 0) return { inserted: 0, tombstoned: 0, observed: 0 };
    const target = options.stagingDatabase;
    const main = (store.database.prepare("PRAGMA database_list").all() as { name: string; file: string }[])
      .find((row) => row.name === "main")?.file;
    const canonicalTarget = target ? realpathSync(target) : null;
    if (!canonicalTarget || !main || canonicalTarget !== realpathSync(main) || !/\.importing\.[a-f0-9-]{36}$/.test(canonicalTarget)) {
      throw new Error("Native record writes require a CLI-owned staging database");
    }
    const first = await this.runApply(store, canonicalTarget, options);
    if (!this.digestAvailable) {
      store.insertIssue({
        severity: "warning",
        code: "invariant.b1.digest_unavailable",
        objectId: this.batchId ?? null,
        message: "the installed native worker did not report an input-conservation digest, so B1 is "
          + "inactive for this import. Install the worker binary built from this revision."
      });
    }
    // Replace imports skip B3 entirely — it has no signal left under `--replace` and the
    // replay would rewrite every row; see `assertIdempotent` for the full argument.
    if (this.incremental) await this.assertIdempotent(store, canonicalTarget, options, first.observed);
    this.assertSampleMatches(store);
    return { inserted: first.inserted, tombstoned: first.tombstoned, observed: first.observed };
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
