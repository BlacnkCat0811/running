import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ImportExecutionEngine, ImportJobPerformance, RemovalGuardDto } from "@rai/api-contracts";
import { isStructurallyReadable } from "@rai/storage-sqlite";

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
  queue?: {
    scope: string;
    attempts: number;
    finalized: boolean;
    cancelRequested?: boolean;
    engine?: ImportExecutionEngine;
    /**
     * 入队时主库不存在。**单独不足以**放行首次空库：必须同时持有
     * `firstEmptyEpoch` 且作用域账本仍证明“没有写者进入/数据集建立”。
     * 保留该字段只为旧作业可读与诊断。
     */
    databaseAbsentAtEnqueue?: boolean;
    /**
     * 入队时作用域账本的首空空库代次。作用域账本一旦记录写者进入或数据集
     * 建立，这个代次即作废；重启恢复只认账本，不再只信任务自己的标记。
     */
    firstEmptyEpoch?: number;
  };
}

/**
 * 作用域级的持久证据：首次空库许可的**唯一**来源。
 *
 * 状态机（单调，不可回退）：`unknown → pristine → writer_entered → established`。
 *
 * - `unknown`（无行，或显式记录为 unknown）：**未知**，不能自动变成 `pristine`。
 * - `pristine`：由受控的首次安装／数据集初始化流程写入的“尚未建库”许可。
 * - `writer_entered`：任何导入任务开始执行（可能写库）之前写入；许可永久失效。
 * - `established`：已有可读主库被观察到、worker 建库成功或维护恢复完成。
 *
 * 旧版 `runtime.sqlite` 没有该表／该 scope 行属于 unknown；迁移不得补写
 * “从未建库”的许可。仅凭主库文件不存在不能推断首次安装。
 */
export type ImportScopeState = "unknown" | "pristine" | "writer_entered" | "established" | "abandoned";

export interface ImportScopeEvidenceRow {
  scope: string;
  state: ImportScopeState;
  firstEmptyEpoch: number | null;
  pristineAt: string | null;
  permitSource: string | null;
  permitRevokedAt: string | null;
  writerEnteredAt: string | null;
  datasetEstablishedAt: string | null;
  detail: string | null;
}

/** One operator-approved "abandon this scope, create that epoch" operation. */
export interface ScopeAbandonmentRecord {
  id: string;
  oldScope: string;
  newScope: string;
  oldEpoch: string;
  newEpoch: string;
  operator: string;
  reason: string;
  createdAt: string;
}

export interface ScopeAbandonmentResult {
  evidence: ImportScopeEvidenceRow;
  abandonment: ScopeAbandonmentRecord;
  /** True when an existing operation was replayed instead of minting a new epoch. */
  replayed: boolean;
}

export class RuntimeStateStore {
  readonly path: string;
  private instanceIdValue = "";
  /**
   * P1-8: set when the constructor had to quarantine a corrupt ledger and
   * rebuild an empty one. A fresh-install decision must know this happened: an
   * empty ledger produced by quarantine is not proof that nothing ever existed.
   */
  quarantinedLedgerPath: string | null = null;

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

  /**
   * Stable identity of this runtime ledger **file instance**.
   *
   * A corrupt ledger is quarantined and rebuilt; the new file gets a new id, so a
   * deletion record bound to the old ledger can never be silently replayed on an
   * empty replacement. This is deliberately not derived from the path or hostname.
   */
  runtimeInstanceId(): string {
    if (this.instanceIdValue === "") throw new Error("Runtime state store is not initialized");
    return this.instanceIdValue;
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


/**
 * 作用域账本读取；`null` = 该 scope 从未被持久观察过（`unknown`）。
 *
 * 读取失败（包括 corruption 隔离后重建出的空账本）同样返回 null；调用方必须
 * 把 null 当作“无法证明”，不能当作“从未建库”。
 */
  scopeEvidence(scope: string): ImportScopeEvidenceRow | null {
    return this.withCorruptionRecovery(() => this.readScopeEvidence(scope));
  }

  private readScopeEvidence(scope: string): ImportScopeEvidenceRow | null {
    const db = this.open();
    try {
      return (db.prepare(`SELECT scope, state, first_empty_epoch AS firstEmptyEpoch,
        pristine_at AS pristineAt, permit_source AS permitSource,
        permit_revoked_at AS permitRevokedAt,
        writer_entered_at AS writerEnteredAt, dataset_established_at AS datasetEstablishedAt,
        detail FROM import_scope_evidence WHERE scope = ?`).get(scope) as ImportScopeEvidenceRow | undefined) ?? null;
    } finally { db.close(); }
  }

  /**
   * 受控首次初始化写入的 `pristine` 许可。
   *
   * 只能由显式的安装／数据集初始化流程调用（CLI `data:init-scope`，或
   * 显式删除成功后为新 scope 建立许可）。**不会**在入队、启动或发现主库缺失时
   * 被自动调用；已有任何行（包括 unknown）时拒绝写入 —— 许可一旦失效不得复活。
   */
  establishPristineScope(scope: string, source: string, at = new Date().toISOString()): ImportScopeEvidenceRow {
    return this.withCorruptionRecovery(() => {
      const db = this.open();
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const existing = db.prepare("SELECT 1 FROM import_scope_evidence WHERE scope = ?").get(scope);
          if (existing !== undefined) {
            db.exec("COMMIT");
            throw new Error(`Import scope already has persistent evidence; refusing a new pristine permit: ${scope}`);
          }
          db.prepare(`INSERT INTO import_scope_evidence
            (scope, state, first_empty_epoch, pristine_at, permit_source)
            VALUES (?, 'pristine', 1, ?, ?)`).run(scope, at, source);
          db.exec("COMMIT");
          return {
            scope, state: "pristine" as const, firstEmptyEpoch: 1, pristineAt: at,
            permitSource: source, permitRevokedAt: null, writerEnteredAt: null,
            datasetEstablishedAt: null, detail: null
          };
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* COMMIT 后抛出的“已有证据”不需要回滚 */ }
          throw error;
        }
      } finally { db.close(); }
    });
  }

  /**
   * 受控删库操作写入的 `pristine` 许可（幂等：同一 deletionId 的重放算成功）。
   *
   * 与 {@link establishPristineScope} 的区别不是“更宽松”，而是**身份绑定**：
   * 只有 `permit_source` 精确等于 `explicit_database_delete:<deletionId>` 的行才被
   * 视为同一操作的重放；任何其他既有证据（包括旧 scope、已进入写者、已建立数据集）
   * 都拒绝，绝不复活或覆盖。
   */
  establishDeletionPermit(scope: string, deletionId: string, at = new Date().toISOString()): ImportScopeEvidenceRow {
    const source = `explicit_database_delete:${deletionId}`;
    return this.withCorruptionRecovery(() => {
      const db = this.open();
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const existing = db.prepare(`SELECT scope, state, first_empty_epoch AS firstEmptyEpoch,
            pristine_at AS pristineAt, permit_source AS permitSource,
            permit_revoked_at AS permitRevokedAt, writer_entered_at AS writerEnteredAt,
            dataset_established_at AS datasetEstablishedAt, detail
            FROM import_scope_evidence WHERE scope = ?`).get(scope) as ImportScopeEvidenceRow | undefined;
          if (existing !== undefined) {
            const replay = existing.state === "pristine"
              && existing.permitSource === source
              && existing.permitRevokedAt === null
              && existing.writerEnteredAt === null
              && existing.datasetEstablishedAt === null;
            // 启动裁决在“prepared/main_removed + 主库缺失”时会先把该 scope 标成
            // unknown 以阻断自动建库。那是我方留下的**恢复标记**，不是写者证据
            // （没有 writerEnteredAt / datasetEstablishedAt / permitSource）。
            // 运维用同一 deletionId 显式恢复时可以把它替换成该操作的许可；
            // 任何真实历史证据仍然拒绝。
            const recoveryMarker = existing.state === "unknown"
              && existing.permitSource === null
              && existing.permitRevokedAt === null
              && existing.writerEnteredAt === null
              && existing.datasetEstablishedAt === null
              && (existing.detail?.startsWith("startup deletion recovery:") ?? false);
            if (replay) {
              db.exec("COMMIT");
              return existing;
            }
            if (!recoveryMarker) {
              db.exec("COMMIT");
              throw new Error(
                `Import scope already has persistent evidence incompatible with deletion ${deletionId}: ${scope}`);
            }
            db.prepare(`UPDATE import_scope_evidence
              SET state='pristine', first_empty_epoch=1, pristine_at=?, permit_source=?,
                  permit_revoked_at=NULL, writer_entered_at=NULL, dataset_established_at=NULL, detail=NULL
              WHERE scope=?`).run(at, source, scope);
            db.exec("COMMIT");
            return {
              scope, state: "pristine" as const, firstEmptyEpoch: 1, pristineAt: at,
              permitSource: source, permitRevokedAt: null, writerEnteredAt: null,
              datasetEstablishedAt: null, detail: null
            };
          }
          db.prepare(`INSERT INTO import_scope_evidence
            (scope, state, first_empty_epoch, pristine_at, permit_source)
            VALUES (?, 'pristine', 1, ?, ?)`).run(scope, at, source);
          db.exec("COMMIT");
          return {
            scope, state: "pristine" as const, firstEmptyEpoch: 1, pristineAt: at,
            permitSource: source, permitRevokedAt: null, writerEnteredAt: null,
            datasetEstablishedAt: null, detail: null
          };
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* COMMIT 后的身份冲突不需要回滚 */ }
          throw error;
        }
      } finally { db.close(); }
    });
  }


  /**
   * P2-3：按 `deletionId + scope` 精确撤销一张尚未消费的删库许可。
   *
   * 收口顺序的唯一目的：先让许可失效，再关闭删除日志/回切 epoch。任何一步
   * 强杀后重启，最坏也只是“许可已撤销、日志仍开着”，下一次启动重新裁决；
   * 绝不会出现“日志已回滚、许可仍可消费”。
   *
   * 只有 `permit_source` 精确匹配该 deletionId 且尚未撤销的 pristine 行会被
   * 修改。其他证据（已进入写者、已建立、其他 deletion）原样返回 false。
   */
  revokeDeletionPermit(scope: string, deletionId: string, at = new Date().toISOString()): boolean {
    const source = `explicit_database_delete:${deletionId}`;
    return this.withCorruptionRecovery(() => {
      const db = this.open();
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const existing = db.prepare(`SELECT state, permit_source AS permitSource,
            permit_revoked_at AS permitRevokedAt, writer_entered_at AS writerEnteredAt,
            dataset_established_at AS datasetEstablishedAt
            FROM import_scope_evidence WHERE scope = ?`).get(scope) as {
            state: ImportScopeState; permitSource: string | null; permitRevokedAt: string | null;
            writerEnteredAt: string | null; datasetEstablishedAt: string | null;
          } | undefined;
          const revocable = existing !== undefined
            && existing.state === "pristine"
            && existing.permitSource === source
            && existing.permitRevokedAt === null
            && existing.writerEnteredAt === null
            && existing.datasetEstablishedAt === null;
          if (!revocable) {
            db.exec("COMMIT");
            return false;
          }
          db.prepare(`UPDATE import_scope_evidence
            SET permit_revoked_at = ?, detail = ?
            WHERE scope = ? AND permit_source = ? AND permit_revoked_at IS NULL`)
            .run(at, `permit revoked by deletion rollback ${deletionId}`, scope, source);
          db.exec("COMMIT");
          return true;
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* 可能已 COMMIT */ }
          throw error;
        }
      } finally { db.close(); }
    });
  }

  /**
   * 入队时的首次空库许可读取（**只读**，绝不创建）。
   *
   * 返回 `null` 表示该 scope 是 unknown、许可已被写者进入/数据集建立/显式撤销，
   * 或账本读不出来 —— 这些都按“无法证明首次空库”处理。
   */
  firstEmptyPermit(scope: string): ImportScopeEvidenceRow | null {
    const evidence = this.scopeEvidence(scope);
    if (evidence === null) return null;
    if (evidence.state !== "pristine") return null;
    if (evidence.writerEnteredAt !== null || evidence.datasetEstablishedAt !== null) return null;
    if (evidence.permitRevokedAt !== null) return null;
    if (evidence.firstEmptyEpoch === null) return null;
    return evidence;
  }

  /**
   * 写者进入作用域：必须在任何可能写主库的动作**之前**持久化。
   * 失败时调用方必须拒绝继续执行（无法证明的写入不允许发生）。
   */
  markScopeWriterEntered(scope: string, at: string): ImportScopeEvidenceRow {
    return this.withCorruptionRecovery(() => this.upsertScopeTransition(scope, "writer_entered", at, null));
  }

  /** 数据集建立：worker 创建主库、观察到已有主库或维护恢复完成时写入。 */
  markScopeDatasetEstablished(scope: string, at: string): ImportScopeEvidenceRow {
    return this.withCorruptionRecovery(() => this.upsertScopeTransition(scope, "established", at, null));
  }

  /**
   * 启动时观察到“主库存在但不可读”：持久记为 unknown（阻断自动建库）并撤销
   * 可能存在的 pristine 许可。已有的 writer/dataset 时间戳保留为诊断证据，不会被抹掉；
   * 后续可读观察会重新登记 established。
   */
  markScopeDatabaseUnreadable(scope: string, at: string, detail: string): ImportScopeEvidenceRow {
    return this.withCorruptionRecovery(() => this.upsertScopeTransition(scope, "unknown", at, detail));
  }

  /**
   * 启动登记（必须在 ImportWorker 构造 / loadJobs / resume 之前调用）。
   *
   * - 主库存在且结构可读 ⇒ `established`（旧库升级后第一次观察就登记）。
   * - 主库存在但不可读 ⇒ `unknown`，阻断自动建库。
   * - 主库缺失 ⇒ 保持现状：没有行仍是 unknown；已有 pristine 许可保留。
   *
   * 绝不因为“文件不在”写 pristine。
   */
  registerStartupDatabaseObservation(scope: string, databasePath: string): ImportScopeEvidenceRow {
    const at = new Date().toISOString();
    const existing = this.scopeEvidence(scope);
    // An abandoned scope is terminal. Observing a main file (for example a
    // stale/foreign copy) must never re-establish it; recovery requires an
    // explicit backup restore or a new epoch.
    if (existing?.state === "abandoned") return existing;
    if (existsSync(databasePath)) {
      if (isStructurallyReadable(databasePath)) return this.markScopeDatasetEstablished(scope, at);
      return this.markScopeDatabaseUnreadable(scope, at, "startup: main database exists but is not structurally readable");
    }
    return existing ?? {
      scope, state: "unknown", firstEmptyEpoch: null, pristineAt: null, permitSource: null,
      permitRevokedAt: null, writerEnteredAt: null, datasetEstablishedAt: null,
      detail: "startup: main database is absent and no trusted pristine permit exists"
    };
  }

  /**
   * 状态转移的唯一写入口。
   *
   * 正常路径单调前进：`writer_entered` 不会把 `established` 降级；`established`
   * 可以覆盖 `pristine`/`writer_entered`。显式“主库不可读”观察可把状态置为
   * `unknown` 以阻断自动建库，但已有的 writer/dataset 时间戳保留为诊断证据。
   */
  private upsertScopeTransition(
    scope: string, target: "unknown" | "writer_entered" | "established", at: string, detail: string | null
  ): ImportScopeEvidenceRow {
    const db = this.open();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare(`SELECT scope, state, first_empty_epoch AS firstEmptyEpoch,
          pristine_at AS pristineAt, permit_source AS permitSource,
          permit_revoked_at AS permitRevokedAt, writer_entered_at AS writerEnteredAt,
          dataset_established_at AS datasetEstablishedAt, detail
          FROM import_scope_evidence WHERE scope = ?`).get(scope) as ImportScopeEvidenceRow | undefined;
        const current = existing?.state ?? "unknown";
        if (current === "abandoned") {
          // `abandoned` is terminal: only a new explicit epoch may replace it.
          // Do not let a startup observation or a late import resurrect it.
          db.exec("COMMIT");
          throw new Error(`Import scope ${scope} was abandoned and cannot transition to ${target}`);
        }
        let nextState: ImportScopeState;
        if (target === "established") {
          nextState = "established";
        } else if (target === "writer_entered") {
          nextState = current === "established" ? "established" : "writer_entered";
        } else {
          // 显式不可读观察一律标记 unknown（阻断自动建库）；已有的 writer/dataset
          // 时间戳保留为诊断证据，但不参与 pristine 许可判定。
          nextState = "unknown";
        }
        const writerEnteredAt = target === "writer_entered" || target === "established"
          ? existing?.writerEnteredAt ?? at
          : existing?.writerEnteredAt ?? null;
        const datasetEstablishedAt = target === "established"
          ? existing?.datasetEstablishedAt ?? at
          : existing?.datasetEstablishedAt ?? null;
        const permitRevokedAt = existing?.permitRevokedAt
          ?? (existing?.state === "pristine" ? at : null);
        db.prepare(`INSERT INTO import_scope_evidence
          (scope, state, first_empty_epoch, pristine_at, permit_source, permit_revoked_at,
           writer_entered_at, dataset_established_at, detail)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope) DO UPDATE SET
            state=excluded.state,
            first_empty_epoch=excluded.first_empty_epoch,
            pristine_at=excluded.pristine_at,
            permit_source=excluded.permit_source,
            permit_revoked_at=excluded.permit_revoked_at,
            writer_entered_at=excluded.writer_entered_at,
            dataset_established_at=excluded.dataset_established_at,
            detail=COALESCE(excluded.detail, import_scope_evidence.detail)`)
          .run(scope, nextState, existing?.firstEmptyEpoch ?? 0, existing?.pristineAt ?? null,
            existing?.permitSource ?? null, permitRevokedAt, writerEnteredAt, datasetEstablishedAt, detail);
        db.exec("COMMIT");
        return {
          scope, state: nextState,
          firstEmptyEpoch: existing?.firstEmptyEpoch ?? 0,
          pristineAt: existing?.pristineAt ?? null,
          permitSource: existing?.permitSource ?? null,
          permitRevokedAt, writerEnteredAt, datasetEstablishedAt,
          detail: detail ?? existing?.detail ?? null
        };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* 可能已 COMMIT */ }
        throw error;
      }
    } finally { db.close(); }
  }

  jobs(limit = 20): RuntimeImportJobRow[] {
    return this.withCorruptionRecovery(() => this.readJobs(limit));
  }

  latestJobForSource(sourceId: string, scope?: string): RuntimeImportJobRow | null {
    return this.withCorruptionRecovery(() => this.readJobs(1, sourceId, undefined, scope).at(-1) ?? null);
  }

  job(id: string): RuntimeImportJobRow | null {
    return this.withCorruptionRecovery(() => this.readJobs(1, undefined, id).at(-1) ?? null);
  }

  private readJobs(limit: number, sourceId?: string, id?: string, scope?: string): RuntimeImportJobRow[] {
    const db = this.open();
    try {
      const rows = db.prepare(`SELECT id, source_id AS sourceId, status, phase, message, created_at AS createdAt,
        completed_at AS completedAt, error, input_path AS inputPath, progress, summary_json AS summaryJson,
        removal_guard_json AS removalGuardJson, performance_json AS performanceJson, execution_json AS executionJson
        FROM import_jobs ${id !== undefined ? "WHERE id = ?" : sourceId === undefined ? `WHERE status IN ('queued', 'running') OR json_extract(execution_json, '$.queue.finalized') = 0 OR sequence_number IN
          (SELECT sequence_number FROM import_jobs ORDER BY sequence_number DESC LIMIT ?)
        ORDER BY sequence_number DESC` : `WHERE source_id = ? ${scope === undefined ? "" : "AND json_extract(execution_json, '$.queue.scope') = ?"} ORDER BY sequence_number DESC LIMIT 1`}`)
        .all(...(sourceId !== undefined && scope !== undefined ? [sourceId, scope] : [id ?? sourceId ?? limit])) as unknown as Array<RuntimeImportJobRow & {
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
        CREATE TABLE IF NOT EXISTS import_scope_evidence (
          scope TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          first_empty_epoch INTEGER,
          pristine_at TEXT,
          permit_source TEXT,
          permit_revoked_at TEXT,
          writer_entered_at TEXT,
          dataset_established_at TEXT,
          detail TEXT
        );
        CREATE TABLE IF NOT EXISTS import_sources (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT NOT NULL,
          input_path TEXT NOT NULL, original_path TEXT NOT NULL, source_sha256 TEXT,
          idempotency_key TEXT UNIQUE,
          export_file_name TEXT NOT NULL, export_bytes INTEGER NOT NULL,
          route_file_count INTEGER NOT NULL, modified_at TEXT NOT NULL,
          created_at TEXT NOT NULL, last_used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS scope_abandonments (
          id TEXT PRIMARY KEY,
          old_scope TEXT NOT NULL,
          new_scope TEXT NOT NULL,
          old_epoch TEXT NOT NULL,
          new_epoch TEXT NOT NULL,
          operator TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_scope_abandonments_old ON scope_abandonments(old_scope);
        CREATE INDEX IF NOT EXISTS idx_import_sources_last_used ON import_sources(last_used_at DESC);
        CREATE INDEX IF NOT EXISTS idx_import_sources_sha ON import_sources(source_sha256);
        CREATE TABLE IF NOT EXISTS import_jobs (
          sequence_number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          source_id TEXT, status TEXT NOT NULL, phase TEXT NOT NULL, message TEXT NOT NULL,
          created_at TEXT NOT NULL, completed_at TEXT, error TEXT,
          input_path TEXT NOT NULL, progress REAL, summary_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_import_jobs_created ON import_jobs(created_at DESC);`);
      // 每个旧 scope 只允许一次放弃操作：重试必须复用同一条记录，绝不能生成
      // 第二个 epoch / 第二张 pristine 许可。已有重复历史行时拒绝自动迁移，
      // 给出可运维诊断，而不是静默挑一行。
      const duplicateAbandonments = db.prepare(`SELECT old_scope AS oldScope, COUNT(*) AS count
        FROM scope_abandonments GROUP BY old_scope HAVING COUNT(*) > 1`).all() as
        Array<{ oldScope: string; count: number }>;
      if (duplicateAbandonments.length > 0) {
        throw new Error(
          "Runtime ledger contains duplicate scope_abandonments rows; refusing automatic migration. "
          + "Resolve the conflicting history manually first: "
          + duplicateAbandonments.map((row) => `${row.oldScope} (${row.count} rows)`).join(", "));
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_abandonments_old_unique ON scope_abandonments(old_scope)");
      // 账本实例身份：只在文件第一次初始化时生成一次；损坏隔离重建会得到新 id。
      // 删库操作记录绑定它，空账本因此不能被解释为“从未有写者进入”。
      db.prepare("INSERT INTO runtime_meta (key, value) VALUES ('rai.runtime-instance-id', ?) ON CONFLICT(key) DO NOTHING")
        .run(`runtime_${randomUUID()}`);
      const instance = db.prepare("SELECT value FROM runtime_meta WHERE key='rai.runtime-instance-id'")
        .get() as { value: string } | undefined;
      if (!instance || typeof instance.value !== "string" || instance.value.trim() === "") {
        throw new Error("Runtime state ledger has no stable instance identity");
      }
      this.instanceIdValue = instance.value;
      // 旧版（阶段 3 复审前）的 import_scope_evidence 只有 first_empty_epoch /
      // writer_entered_at / dataset_established_at。迁移**只**保留已发生的写者/数据集
      // 证据；旧的“入队即写 first_empty_epoch=1”不是可信首空许可，一律降为 unknown。
      // 绝不把“没有行”补写成 pristine。
      const scopeColumns = db.prepare("PRAGMA table_info(import_scope_evidence)").all() as unknown as Array<{ name: string }>;
      const scopeColumnNames = new Set(scopeColumns.map(({ name }) => name));
      for (const [name, type] of [
        ["state", "TEXT NOT NULL DEFAULT 'unknown'"],
        ["pristine_at", "TEXT"], ["permit_source", "TEXT"], ["permit_revoked_at", "TEXT"], ["detail", "TEXT"]
      ] as const) {
        if (!scopeColumnNames.has(name)) db.exec(`ALTER TABLE import_scope_evidence ADD COLUMN ${name} ${type}`);
      }
      // Only a legacy table without `state` needs this one-time migration.
      // On a current table, unknown + historical timestamps is an intentional
      // recovery block. Re-running this UPDATE at every constructor would undo
      // markScopeDatabaseUnreadable on the next RuntimeStateStore instance.
      if (!scopeColumnNames.has("state")) {
        db.exec(`UPDATE import_scope_evidence SET state = CASE
          WHEN dataset_established_at IS NOT NULL THEN 'established'
          WHEN writer_entered_at IS NOT NULL THEN 'writer_entered'
          ELSE 'unknown' END
          WHERE state = 'unknown' AND (dataset_established_at IS NOT NULL OR writer_entered_at IS NOT NULL)`);
      }
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
      const target = `${this.path}.corrupt-${quarantineId}${suffix}`;
      renameSync(source, target);
      if (suffix === "") this.quarantinedLedgerPath = target;
    }
  }

  /**
   * P1-5: abandon a `writer_entered` scope and mint one permit for a **brand
   * new** epoch.
   *
   * This is the only way out of "the first writer's durable barrier was written
   * but the main database was never created". It deliberately does not revive
   * the old permit: the old row becomes `abandoned`, the operator's reason and
   * identity are recorded in `scope_abandonments`, and a new scope gets a
   * single `pristine` permit. The old job/receipt state is left untouched (it
   * may have committed; only an operator can decide that).
   */
  abandonWriterEnteredScope(input: {
    oldScope: string; oldEpoch: string; operator: string; reason: string;
    at?: string;
    /** Test/ops override only; production omits both so one UUID is minted once. */
    newScope?: string; newEpoch?: string;
  }): ScopeAbandonmentResult {
    const at = input.at ?? new Date().toISOString();
    const source = `operator_abandon_and_new_epoch:${input.oldEpoch}`;
    return this.withCorruptionRecovery(() => {
      const db = this.open();
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const existingOperation = this.readAbandonmentIn(db, input.oldScope);
          if (existingOperation !== null) {
            // Crash between "ledger committed" and "sidecar written": the retry
            // must reuse the persisted new epoch, never mint a second one.
            this.assertAbandonmentReplayableInDb(db, existingOperation, input, source);
            const evidence = this.readScopeEvidenceIn(db, existingOperation.newScope);
            if (evidence === null) {
              throw new Error(`Abandonment ${existingOperation.id} is missing its new-scope permit`);
            }
            db.exec("COMMIT");
            return { evidence, abandonment: existingOperation, replayed: true };
          }
          const existing = this.readScopeEvidenceIn(db, input.oldScope);
          const abandonable = existing !== null
            && existing.writerEnteredAt !== null
            && existing.datasetEstablishedAt === null
            && (existing.state === "writer_entered"
              || (existing.state === "abandoned"
                && (existing.detail?.startsWith("abandoned by operator ") ?? false)));
          if (!abandonable) {
            db.exec("COMMIT");
            throw new Error(
              `Import scope ${input.oldScope} has no writer-entered / not-established evidence; `
              + "refusing to abandon it as an interrupted first install");
          }
          const newEpoch = input.newEpoch ?? randomUUID();
          const newScope = input.newScope ?? (() => {
            try {
              const parsed = JSON.parse(input.oldScope) as unknown;
              if (Array.isArray(parsed) && parsed.length >= 3) {
                return JSON.stringify([parsed[0], parsed[1], newEpoch]);
              }
            } catch { /* not a structured scope */ }
            throw new Error(
              "The old scope is not a structured [serverId, athleteId, epoch] value; "
              + "the caller must pass an explicit new scope");
          })();
          if (newScope === input.oldScope) {
            throw new Error("Abandoning a scope must create a different new scope");
          }
          const newScopeExists = this.readScopeEvidenceIn(db, newScope);
          if (newScopeExists !== null) {
            db.exec("COMMIT");
            throw new Error(`The new import scope already has persistent evidence: ${newScope}`);
          }
          const operationId = randomUUID();
          db.prepare(`UPDATE import_scope_evidence
            SET state='abandoned', permit_revoked_at=COALESCE(permit_revoked_at, ?), detail=?
            WHERE scope = ?`).run(at, `abandoned by operator ${input.operator}: ${input.reason}`, input.oldScope);
          db.prepare(`INSERT INTO import_scope_evidence
            (scope, state, first_empty_epoch, pristine_at, permit_source, detail)
            VALUES (?, 'pristine', 1, ?, ?, ?)`)
            .run(newScope, at, source, `created by abandoning ${input.oldEpoch}`);
          db.prepare(`INSERT INTO scope_abandonments
            (id, old_scope, new_scope, old_epoch, new_epoch, operator, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(operationId, input.oldScope, newScope, input.oldEpoch, newEpoch,
              input.operator, input.reason, at);
          db.exec("COMMIT");
          return {
            evidence: {
              scope: newScope, state: "pristine" as const, firstEmptyEpoch: 1, pristineAt: at,
              permitSource: source, permitRevokedAt: null, writerEnteredAt: null,
              datasetEstablishedAt: null, detail: null
            },
            abandonment: {
              id: operationId, oldScope: input.oldScope, newScope, oldEpoch: input.oldEpoch,
              newEpoch, operator: input.operator, reason: input.reason, createdAt: at
            },
            replayed: false
          };
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* 可能已 COMMIT */ }
          throw error;
        }
      } finally { db.close(); }
    });
  }

  /** Read one abandonment operation by its old scope (unique by construction). */
  abandonmentFor(oldScope: string): ScopeAbandonmentRecord | null {
    return this.withCorruptionRecovery(() => {
      const db = this.open();
      try { return this.readAbandonmentIn(db, oldScope); } finally { db.close(); }
    });
  }

  private readAbandonmentIn(db: DatabaseSync, oldScope: string): ScopeAbandonmentRecord | null {
    return (db.prepare(`SELECT id, old_scope AS oldScope, new_scope AS newScope,
      old_epoch AS oldEpoch, new_epoch AS newEpoch, operator, reason, created_at AS createdAt
      FROM scope_abandonments WHERE old_scope = ?`).get(oldScope) as ScopeAbandonmentRecord | undefined) ?? null;
  }

  private readScopeEvidenceIn(db: DatabaseSync, scope: string): ImportScopeEvidenceRow | null {
    return (db.prepare(`SELECT scope, state, first_empty_epoch AS firstEmptyEpoch,
      pristine_at AS pristineAt, permit_source AS permitSource,
      permit_revoked_at AS permitRevokedAt, writer_entered_at AS writerEnteredAt,
      dataset_established_at AS datasetEstablishedAt, detail
      FROM import_scope_evidence WHERE scope = ?`).get(scope) as ImportScopeEvidenceRow | undefined) ?? null;
  }

  /**
   * A replay is valid only when every persistent fact points at the *same*
   * operation: old epoch, old scope state, the new permit's source and its
   * untouched state, and the operator's stated reason. Anything else is a
   * conflict for manual review — never a reason to pick one row silently.
   */
  /**
   * Re-check an existing abandonment before a caller performs any remaining
   * side effect. The CLI retry path must use this: finishing the sidecar on a
   * stale/missing new-epoch permit would leave the configured epoch pointing
   * at a scope that can never import.
   */
  assertAbandonmentReplayable(operation: ScopeAbandonmentRecord, input: {
    oldEpoch: string; operator: string; reason: string;
  }): void {
    this.withCorruptionRecovery(() => {
      const db = this.open();
      try {
        this.assertAbandonmentReplayableInDb(db, operation, {
          oldScope: operation.oldScope,
          oldEpoch: input.oldEpoch,
          operator: input.operator,
          reason: input.reason
        }, `operator_abandon_and_new_epoch:${input.oldEpoch}`);
      } finally {
        db.close();
      }
    });
  }

  private assertAbandonmentReplayableInDb(
    db: DatabaseSync,
    operation: ScopeAbandonmentRecord,
    input: { oldScope: string; oldEpoch: string; operator: string; reason: string },
    source: string
  ): void {
    this.assertAbandonmentOperationInDb(db, operation, input);
    const permit = this.readScopeEvidenceIn(db, operation.newScope);
    if (permit === null || permit.state !== "pristine" || permit.permitSource !== source
        || permit.permitRevokedAt !== null || permit.writerEnteredAt !== null
        || permit.datasetEstablishedAt !== null) {
      throw new Error(
        `Abandonment ${operation.id} is not replayable: its new permit is missing, consumed or revoked`);
    }
  }

  /**
   * A retry whose sidecar already points at the recorded replacement epoch is
   * an *already completed* operation, not a step-two replay. The one-shot
   * permit may therefore be legitimately consumed (`writer_entered` /
   * `established`), but it must still belong to this operation and must not
   * have been revoked without being consumed.
   */
  assertAbandonmentCompleted(operation: ScopeAbandonmentRecord, input: {
    oldEpoch: string; operator: string; reason: string;
  }): void {
    this.withCorruptionRecovery(() => {
      const db = this.open();
      try {
        this.assertAbandonmentOperationInDb(db, operation, {
          oldScope: operation.oldScope,
          oldEpoch: input.oldEpoch,
          operator: input.operator,
          reason: input.reason
        });
        const permit = this.readScopeEvidenceIn(db, operation.newScope);
        const source = `operator_abandon_and_new_epoch:${input.oldEpoch}`;
        if (permit === null || permit.permitSource !== source) {
          throw new Error(`Abandonment ${operation.id} has no matching new-scope permit`);
        }
        const pristine = permit.state === "pristine"
          && permit.firstEmptyEpoch !== null
          && permit.permitRevokedAt === null
          && permit.writerEnteredAt === null
          && permit.datasetEstablishedAt === null;
        const consumed = permit.firstEmptyEpoch !== null
          && (permit.state === "writer_entered" || permit.state === "established")
          && (permit.writerEnteredAt !== null || permit.datasetEstablishedAt !== null);
        if (!pristine && !consumed) {
          throw new Error(
            `Abandonment ${operation.id} is not completed: its new permit is missing, revoked or in an unknown state`);
        }
      } finally {
        db.close();
      }
    });
  }

  /** Shared operation identity checks for both replay and completed paths. */
  private assertAbandonmentOperationInDb(
    db: DatabaseSync,
    operation: ScopeAbandonmentRecord,
    input: { oldScope: string; oldEpoch: string; operator: string; reason: string }
  ): void {
    if (operation.oldEpoch !== input.oldEpoch) {
      throw new Error(
        `Abandonment for ${input.oldScope} already exists for epoch ${JSON.stringify(operation.oldEpoch)}; `
        + `retry requested ${JSON.stringify(input.oldEpoch)}. Manual review required.`);
    }
    if (operation.operator !== input.operator || operation.reason !== input.reason) {
      throw new Error(
        `Abandonment ${operation.id} was recorded by ${JSON.stringify(operation.operator)} with a different reason; `
        + "the retry's operator statement is incompatible. Manual review required.");
    }
    const oldEvidence = this.readScopeEvidenceIn(db, operation.oldScope);
    if (oldEvidence === null || oldEvidence.state !== "abandoned"
        || !(oldEvidence.detail?.startsWith("abandoned by operator ") ?? false)) {
      throw new Error(`Abandonment ${operation.id} does not match the old scope's abandoned state`);
    }
  }

  /** True when an operator explicitly abandoned this scope (P1-5). */
  isScopeAbandoned(scope: string): boolean {
    return this.withCorruptionRecovery(() => {
      const db = this.open();
      try {
        return db.prepare("SELECT 1 FROM scope_abandonments WHERE old_scope = ?").get(scope) !== undefined;
      } finally { db.close(); }
    });
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
