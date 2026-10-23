import { existsSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ImportJobResponse } from "@rai/api-contracts";
import { tryWalCheckpointTruncate } from "@rai/storage-sqlite";

interface Publication {
  id: string; databasePath: string; rollbackPath: string;
  originalExisted: boolean; phase: "prepared" | "committed";
}

/** Compare persisted publication paths by physical identity, not spelling. */
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

const receiptKey = (id: string): string => `rai.applied-import.${id}`;

export function readImportReceiptInDatabase(db: DatabaseSync, id: string): ImportJobResponse["summary"] | null {
  const row = db.prepare("SELECT value FROM import_manifest WHERE key = ?").get(receiptKey(id)) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as ImportJobResponse["summary"] : null;
}

/** No connection, COMMIT or checkpoint here: callers may own an atomic delta
 * transaction. Verify the receipt before that transaction can commit. */
export function writeImportReceiptInDatabase(
  db: DatabaseSync, id: string, summary: NonNullable<ImportJobResponse["summary"]>
): void {
  const value = JSON.stringify(summary);
  const result = db.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)").run(receiptKey(id), value);
  const row = db.prepare("SELECT value FROM import_manifest WHERE key = ?").get(receiptKey(id));
  if (Number(result.changes) !== 1 || row?.value !== value) throw new Error("Import receipt failed its pre-commit assertion");
}

export function readImportReceipt(path: string, id: string): ImportJobResponse["summary"] | null {
  if (!existsSync(path)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return readImportReceiptInDatabase(db, id);
  } catch { return null; }
  finally { db?.close(); }
}

/**
 * Validate a receipt read through the strict path.
 *
 * A row whose JSON parses to `null` (or to a non-object) is a damaged receipt,
 * not an absent one. Returning `null` there would let the recovery decision
 * treat "the database contains a receipt we cannot understand" as "the
 * transaction never committed" — exactly the ambiguity this path exists to
 * remove. The required fields are the long-lived subset shared by old and new
 * receipts; newer optional fields (`directSync`, `analysisJobId`, …) remain
 * optional.
 */
function parseStrictImportReceipt(value: string): NonNullable<ImportJobResponse["summary"]> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (error) {
    throw new Error("Import receipt is not valid JSON", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Import receipt is not an object");
  }
  const receipt = parsed as Record<string, unknown>;
  const modes = new Set(["unchanged", "incremental", "full"]);
  if (typeof receipt.importMode !== "string" || !modes.has(receipt.importMode)
      || !["insertedWorkouts", "updatedWorkouts", "removedWorkouts", "unchangedWorkouts",
        "routesUpdated", "featuresReused", "featuresRecomputed"].every((key) => Number.isInteger(receipt[key]))
      || typeof receipt.durationMs !== "number" || !Number.isFinite(receipt.durationMs)
      || (receipt.modelReplayFrom !== null && typeof receipt.modelReplayFrom !== "string")
      || (receipt.backupName !== null && typeof receipt.backupName !== "string")) {
    throw new Error("Import receipt is missing required fields or has invalid field types");
  }
  return parsed as NonNullable<ImportJobResponse["summary"]>;
}

/**
 * 提交结果不确定时的严格回执读取。
 *
 * `readImportReceipt` 的 "读不到 = null" 适合启动时的尽力恢复，但不能用来裁决
 * "worker 到底提交了没有"：数据库忙、损坏或权限错误时，把异常吞成 `null` 会把
 * 已提交的结果误报成未提交。这里只在**读取成功且确实没有该 job 回执**时返回 null；
 * 其余失败全部上抛，由调用方进入恢复阻断。
 *
 * 🔴 不使用 `existsSync(path) → null`：数据库缺失本身就是"无法核实"，必须让
 * `readOnly` 打开失败上抛。`readOnly` 保证失败时不会顺手创建一份空数据库。
 */
export function readImportReceiptStrict(path: string, id: string): NonNullable<ImportJobResponse["summary"]> | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const row = db.prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get(receiptKey(id)) as { value: string } | undefined;
    if (!row) return null;
    return parseStrictImportReceipt(row.value);
  } finally { db.close(); }
}

/**
 * 重启恢复的四态回执读取。
 *
 * `loadJobs()` 过去用宽松的 `readImportReceipt`：任何读取失败都被降级为 `null`，
 * 于是一个已经提交、但重启时数据库暂时不可读的作业会被当成“没有回执”，再按
 * cancelRequested / attempts 政策发布 cancelled / failed —— 这是猜测，不是事实。
 *
 * 这里把结果分成：
 *   · `found`：查询成功且回执行存在、通过严格解析 → 恢复原持久回执；
 *   · `confirmed_absent`：查询成功且回执行确实不存在 → 才可以走原有取消／重试政策；
 *   · `missing`：数据库文件不存在 → **不能**据此确认没有回执。已尝试提交的作业
 *     遇到主库暂时缺失时，提交结果仍未知；只有调用方用入队时持久化的“首次空库”
 *     证据（且作业从未进入可提交的 worker）才能另行裁决；
 *   · `unreadable`：打开、查询、JSON 或字段形状任一步失败 → 恢复阻断，不得裁决。
 *
 * 文件存在但损坏／零字节／缺 `import_manifest` 表都属于 `unreadable`。
 */
export type ImportReceiptRecoveryOutcome =
  | { state: "found"; receipt: NonNullable<ImportJobResponse["summary"]> }
  | { state: "confirmed_absent" }
  | { state: "missing"; error: Error }
  | { state: "unreadable"; error: Error };

export function readImportReceiptForRecovery(path: string, id: string): ImportReceiptRecoveryOutcome {
  if (!existsSync(path)) {
    // 只报告事实（文件缺失），不在这里裁决提交结果。
    return { state: "missing", error: new Error("Import database file is missing") };
  }
  try {
    const receipt = readImportReceiptStrict(path, id);
    return receipt === null
      ? { state: "confirmed_absent" }
      : { state: "found", receipt };
  } catch (error) {
    return {
      state: "unreadable",
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}

/**
 * A rollback point is only useful if we can prove it is a complete SQLite
 * database. Opening read-only avoids creating anything beside an operator's
 * only recovery copy; `quick_check` catches truncated/corrupt files before we
 * replace the active path with them.
 */
function rollbackDatabaseProblem(path: string): string | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return check?.quick_check === "ok" ? null : "Import rollback database failed integrity check";
  } catch (error) {
    return `Import rollback database is not readable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    db?.close();
  }
}

export function writeImportReceipt(path: string, id: string, summary: NonNullable<ImportJobResponse["summary"]>): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
    writeImportReceiptInDatabase(db, id, summary);
    // 回执已经在上面 COMMIT。checkpoint 只是维护动作：忙（长读事务钉住快照）时
    // 允许延后，不能把“已提交、checkpoint 未完成”误报成事务未提交。
    // 必须完成的恢复/换库路径走 runWalCheckpointTruncate（busy 即失败）。
    tryWalCheckpointTruncate(db);
  } finally { db.close(); }
}

/** Durable rename intent: a killed process must never silently lose the old DB. */
export class ImportPublicationJournal {
  readonly rolledBackIds = new Set<string>();
  private readonly path: string;
  constructor(private readonly databasePath: string, private readonly runtimeRoot: string) {
    this.path = resolve(runtimeRoot, "var/runtime.sqlite");
    this.use((db) => db.exec(`CREATE TABLE IF NOT EXISTS import_publications (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS import_publication_supersessions (
        id TEXT PRIMARY KEY, restored_epoch TEXT NOT NULL, reason TEXT NOT NULL, superseded_at TEXT NOT NULL)`));
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

  /**
   * Mark every pre-restore publication intent as superseded by an explicit,
   * committed backup restore.
   *
   * This is only called **after** the database replacement committed and the
   * final epoch/scope ledger is durable. The supersession row and the intent
   * removal happen in one `runtime.sqlite` transaction: a crash either leaves
   * the intent (and a replayable restore) or the durable record — never an
   * unexplained intent that a restart would mistake for a current-database
   * publication conflict.
   *
   * Returns the number of intents that were superseded.
   */
  supersedeWithRestore(restoredEpoch: string, reason = "explicit_backup_restore"): number {
    const at = new Date().toISOString();
    return this.use((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const ids = (db.prepare("SELECT id FROM import_publications ORDER BY id").all() as { id: string }[])
          .map((row) => row.id);
        const record = db.prepare(`INSERT OR REPLACE INTO import_publication_supersessions
          (id, restored_epoch, reason, superseded_at) VALUES (?, ?, ?, ?)`);
        const remove = db.prepare("DELETE FROM import_publications WHERE id = ?");
        for (const id of ids) {
          record.run(id, restoredEpoch, reason, at);
          remove.run(id);
        }
        db.exec("COMMIT");
        return ids.length;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* 可能已 COMMIT */ }
        throw error;
      }
    });
  }

  /** Durable supersession records (id → restore epoch); used by recovery/tests. */
  supersessions(): Array<{ id: string; restoredEpoch: string; reason: string; supersededAt: string }> {
    return this.use((db) => (db.prepare(`SELECT id, restored_epoch AS restoredEpoch, reason,
      superseded_at AS supersededAt FROM import_publication_supersessions ORDER BY id`).all() as
      Array<{ id: string; restoredEpoch: string; reason: string; supersededAt: string }>));
  }

  private supersededIds(): Set<string> {
    return new Set(this.use((db) => (db.prepare("SELECT id FROM import_publication_supersessions").all() as
      { id: string }[]).map((row) => row.id)));
  }
  private save(value: Publication): void {
    this.use((db) => db.prepare("INSERT OR REPLACE INTO import_publications VALUES (?, ?)").run(value.id, JSON.stringify(value)));
  }
  private records(): Publication[] {
    return this.use((db) => (db.prepare("SELECT payload FROM import_publications").all() as { payload: string }[])
      .map((row) => JSON.parse(row.payload) as Publication));
  }
  /**
   * P1-6: recover publication intents **without** turning a temporarily
   * unreadable/missing main database into "the receipt is gone".
   *
   * Returns a structured result instead of throwing for recoverable states:
   *   - `repaired`  : a prepared intent was rolled back;
   *   - `blocked`   : intents that must stay in the journal until an operator
   *                   restores or inspects the main database;
   *   - `fatal`     : a committed intent whose receipt is provably absent —
   *                   the journal and database genuinely disagree.
   *
   * Only journal metadata corruption (wrong path identity, unknown phase)
   * throws: that is not a dataset state we may guess about.
   */
  recover(): ImportPublicationRecoveryResult {
    let repaired = false;
    let superseded = 0;
    const blocked: ImportPublicationRecoveryBlock[] = [];
    const supersededIds = this.supersededIds();
    for (const record of this.records()) {
      // An explicit restore already adjudicated this intent: its old database
      // bytes are gone by operator decision, not by an unexplained rename.
      // Restart must NOT turn it into a current-database commit conflict.
      if (supersededIds.has(record.id)) {
        this.clear(record.id);
        superseded += 1;
        continue;
      }
      // Corrupt metadata is a stop, not authority to remove arbitrary files.
      const databasePhysical = physicalPath(this.databasePath);
      const rollbackRoot = physicalPath(resolve(this.runtimeRoot, "var/backups"));
      if (physicalPath(record.databasePath) !== databasePhysical ||
          dirname(physicalPath(record.rollbackPath)) !== rollbackRoot ||
          !physicalPath(record.rollbackPath).startsWith(join(rollbackRoot, "rai.import-rollback.")) ||
          !["prepared", "committed"].includes(record.phase)) throw new Error("Invalid import publication journal");
      if (record.phase === "committed") {
        // A committed intent means the facts transaction committed. Only a
        // successful query that finds no receipt may contradict it.
        const outcome = readImportReceiptForRecovery(this.databasePath, record.id);
        if (outcome.state === "found") {
          // Keep the intent until the runtime job acknowledgement is durable.
          continue;
        }
        if (outcome.state === "confirmed_absent") {
          blocked.push({
            id: record.id, phase: record.phase, state: "confirmed_absent",
            detail: "Committed import receipt is absent from a readable database; manual recovery required"
          });
          continue;
        }
        blocked.push({
          id: record.id, phase: record.phase, state: outcome.state,
          detail: outcome.error.message
        });
        continue;
      }
      if (existsSync(record.rollbackPath)) {
        const outcome = readImportReceiptForRecovery(this.databasePath, record.id);
        if (outcome.state !== "found" && outcome.state !== "missing") {
          // Only a successfully read receipt proves the candidate rename, and
          // a readable database without one is ambiguous (it may be the
          // untouched original or an unrelated database). Never replace it or
          // delete the rollback point on that ambiguity.
          blocked.push({
            id: record.id, phase: record.phase, state: "unreadable",
            detail: outcome.state === "confirmed_absent"
              ? "Prepared import has an active database without a receipt; manual recovery required"
              : `Import recovery cannot inspect the active database: ${outcome.error.message}`
          });
          continue;
        }
        if (!record.originalExisted) {
          // An initial import never moves an original database into the
          // rollback path. A file there is not ours to install, regardless of
          // whether the active database currently exposes a receipt: a
          // stale/foreign rollback must never replace live bytes.
          blocked.push({
            id: record.id, phase: record.phase, state: "unreadable",
            detail: "Prepared initial import has an unexpected rollback point; manual recovery required"
          });
          continue;
        }
        const rollbackProblem = rollbackDatabaseProblem(record.rollbackPath);
        if (rollbackProblem !== null) {
          blocked.push({
            id: record.id, phase: record.phase, state: "unreadable",
            detail: rollbackProblem
          });
          continue;
        }
        // Two prepared-phase crash windows are normal and both restore the old
        // database: (a) candidate installed and receipt committed before the
        // journal could record `committed` (outcome=found); (b) old database
        // already moved aside while the candidate is not installed yet
        // (outcome=missing). In (b) the main path being absent is the expected
        // mid-rename state, not evidence that recovery must stop.
        for (const suffix of ["-wal", "-shm", ""]) rmSync(`${this.databasePath}${suffix}`, { force: true });
        renameSync(record.rollbackPath, this.databasePath);
        repaired = true;
      } else {
        const outcome = readImportReceiptForRecovery(this.databasePath, record.id);
        if (outcome.state === "found") {
          if (record.originalExisted) {
            blocked.push({
              id: record.id, phase: record.phase, state: "missing",
              detail: "Import rollback point missing; refusing unsafe recovery"
            });
            continue;
          }
          for (const suffix of ["-wal", "-shm", ""]) rmSync(`${this.databasePath}${suffix}`, { force: true });
          repaired = true;
        } else if (outcome.state === "confirmed_absent") {
          if (record.originalExisted && !existsSync(this.databasePath)) {
            blocked.push({
              id: record.id, phase: record.phase, state: "missing",
              detail: "Import database and rollback point missing; manual recovery required"
            });
            continue;
          }
          if (!record.originalExisted && existsSync(this.databasePath)) {
            blocked.push({
              id: record.id, phase: record.phase, state: "unreadable",
              detail: "Unexpected active database during initial import recovery; manual recovery required"
            });
            continue;
          }
        } else {
          blocked.push({
            id: record.id, phase: record.phase, state: outcome.state,
            detail: outcome.error.message
          });
          continue;
        }
      }
      this.clear(record.id);
      this.rolledBackIds.add(record.id);
    }
    return { repaired, blocked, superseded };
  }
}

export type ImportPublicationRecoveryBlockState = "missing" | "unreadable" | "confirmed_absent";

export interface ImportPublicationRecoveryBlock {
  id: string;
  phase: "prepared" | "committed";
  state: ImportPublicationRecoveryBlockState;
  detail: string;
}

export interface ImportPublicationRecoveryResult {
  repaired: boolean;
  blocked: ImportPublicationRecoveryBlock[];
  /** Intents discarded because a durable explicit-restore supersession exists. */
  superseded: number;
}
