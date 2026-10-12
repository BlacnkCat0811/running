import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { CONTRACT_VERSION, DATABASE_TIMEZONE, DIRECT_SYNC_ANALYSIS_REQUEST_MODE } from "@rai/contracts";
import type { ImportJobResponse } from "@rai/api-contracts";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";
import {
  DATA_ONLY_MAX_RECORDS, DATA_ONLY_MAX_XML_BYTES, NATIVE_VERSION, RecordDeltaNotEligibleError,
  canonicalizeRunningWorkouts, classifyDirectSyncPayload, identityAlgorithmFingerprint, importGpxRoutes,
  parseAppleHealthXml, parseHealthSyncManifest, type DirectSyncPayloadFacts,
  type HealthSyncManifest
} from "@rai/health-export-parser";

import { readImportReceiptInDatabase, writeImportReceiptInDatabase } from "./import-publication.js";
import { assertDirectSyncRequestShape } from "./direct-sync-plan.js";
import { importPayloadSha256 } from "./import-payload-identity.js";
import { digestHealthKitRecordSnapshot } from "./import-sources.js";

/**
 * 直连增量同步的**统一原始接收器**（`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §3 的
 * `DirectSyncIngestWorker`；落地设计见 `docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md` §2）。
 *
 * 与既有的 record-only 快通路（`data-only-import.ts`）的分工：
 *   - 那条车道的入口判据是**载荷形状**（`isDataOnlyRecordXml` + 非评分类型白名单），
 *     它结构上不可能触及分析，所以回执可以写 `not_required`；它今天仍在生产里跑。
 *   - 本模块是**一般车道**：接受 Workout / 评分类型 / 显式删除 / GPX，在**同一个主库事务**里
 *     写事实、账本、回执，并在需要分析时**同事务登记**分析任务（§4.2）。
 *
 * 三条结构性的设计决定（每一条都有对应断言，改之前先读）：
 *
 * 1. **提交权归调用方**：`RaiDatabase.open({ transactionOwner: "caller" })` +
 *    `beginCallerTransaction()`；解析器用 `callerOwnedTransaction: true`（批次边界是 SAVEPOINT），
 *    路由用 `importGpxRoutes`（它的发布段自带 SAVEPOINT）。本模块**只在一处**提交。
 * 2. **写权限按"表属于哪一类"判定，不按载荷类别判定**：分类是**事后**结论（要等账本），
 *    而守卫必须在写入**之前**就位。所以守卫回答的是"本事务允许写哪些表"：
 *    原始事实/身份/账本/回执/任务交接允许，**派生分析与发布状态一律拒绝**。
 * 3. **默认必须分析**：`classifyDirectSyncPayload` 只在**证明了**本批什么都没碰到分析时
 *    才给 `record-only`；任何未知类型都要求分析（见该函数的注释）。
 */

/** 事务写到了派生分析/发布表时抛出的守卫标记。 */
export const DIRECT_SYNC_WRITE_GUARD = "rai_direct_sync_may_not_write_analysis_tables";

/**
 * 单批上界沿用 record-only 车道的常量（§14.3 P01：每批 ≤ 5000 条且 ≤ 2 MiB 归一化原始内容）。
 * 超限的载荷**不做**分片（§5.2 的分片计划还没实现）—— 直接不合格、回退旧链路，
 * 而不是"先收一半"。
 */
export const DIRECT_SYNC_MAX_XML_BYTES = DATA_ONLY_MAX_XML_BYTES;
export const DIRECT_SYNC_MAX_RECORDS = DATA_ONLY_MAX_RECORDS;
/**
 * 路线上界是**临时值**（每批文件数与合计字节），口径按 §14.3 P05（轨迹点数与分块单独计量）。
 * ⚠️ 它们**不是**实测结论：P05 要求目标云机实测，本环境给不了。取这两个数的目的是
 * "输入目录里能有什么必须可枚举、可上界"，而不是性能结论；超过上界 ⇒ 不合格回退旧链路。
 */
export const DIRECT_SYNC_MAX_ROUTE_FILES = 200;
export const DIRECT_SYNC_MAX_ROUTE_BYTES = 32 * 1024 * 1024;

export type IngestTableKind = "ingest" | "analysis";

export interface IngestTableDisposition {
  readonly table: string;
  /**
   * `ingest` = 本批的原始事实 / 身份映射 / 变更账本 / 回执 / 任务交接（可写）；
   * `analysis` = 派生分析结果、发布指针、门禁与用户输入（**拒绝写**）。
   */
  readonly kind: IngestTableKind;
  readonly why: string;
}

/**
 * 生产 DDL 里**每一张表**都必须在这里表态。
 *
 * 🔴 为什么不是"黑名单"：漏掉一张新的分析表，守卫就会**静默**放行 —— 而"没被守住"
 * 与"守住了"在报告里长得一模一样。所以这里反过来：没表态的表会让
 * {@link unclassifiedIngestTables} 非空，`installDirectSyncWriteGuards` 直接抛错（fail-closed），
 * 而不是默认放行。新增迁移时必须同批在下面写一行"它属于哪一类、为什么"。
 *
 * ⚠️ 判定口径是**读者怎么用它**，不是"它是不是算出来的"：
 *   - `canonical_nights` / `canonical_hrv_days` 也是派生的，但它们是**恢复事实**、
 *     读侧当输入用，且接收事务要按窗口局部重建它们（PR4 步骤 4）⇒ 归 `ingest`；
 *   - `workout_statistics` 由解析器从原始统计字段直接落库，属原始事实 ⇒ `ingest`；
 *   - `recompute_jobs` 是**任务交接**（§4.2 明令要与事实同事务），不是结果 ⇒ `ingest`；
 *   - `model_runs` / `feature_runs` / `ability_assessments` / `active_*` 是"已发布分析"
 *     ⇒ `analysis`，接收事务碰它们就等于把"原始已保存"和"分析已更新"两件事混成一件。
 */
export const INGEST_TABLE_DISPOSITIONS: readonly IngestTableDisposition[] = [
  { table: "health_records", kind: "ingest", why: "原始记录事实" },
  { table: "healthkit_record_facts", kind: "ingest", why: "v2 记录身份与来源快照" },
  { table: "healthkit_record_sources", kind: "ingest", why: "UUID → record 身份映射" },
  { table: "healthkit_record_aliases", kind: "ingest", why: "UUID 别名映射" },
  { table: "workouts", kind: "ingest", why: "原始训练事实" },
  { table: "workout_events", kind: "ingest", why: "训练事件（原始）" },
  { table: "workout_statistics", kind: "ingest", why: "导出里的聚合统计字段（原始）" },
  { table: "activity_summaries", kind: "ingest", why: "活动环摘要（原始）" },
  { table: "training_sessions", kind: "ingest", why: "训练会话语义身份，读侧的事实侧" },
  { table: "workout_groups", kind: "ingest", why: "会话分组身份（稳定 ID）" },
  { table: "workout_group_members", kind: "ingest", why: "会话分组成员" },
  { table: "workout_routes", kind: "ingest", why: "路线当前发布指针（事实）" },
  { table: "route_points", kind: "ingest", why: "过渡期双写的当前路线点（PR5 退役）" },
  { table: "route_versions", kind: "ingest", why: "路线版本（未完成版本对读侧不可见）" },
  { table: "route_version_points", kind: "ingest", why: "路线版本的点" },
  { table: "route_file_fingerprints", kind: "ingest", why: "本批 GPX 文件指纹" },
  { table: "import_batches", kind: "ingest", why: "本批头与结果" },
  { table: "import_batch_files", kind: "ingest", why: "本批文件清单" },
  { table: "import_batch_partitions", kind: "ingest", why: "大包分片计划（§5.2）" },
  { table: "import_entity_changes", kind: "ingest", why: "本批 before/after 变更账目" },
  { table: "import_entity_generations", kind: "ingest", why: "逐实体批次代次 token" },
  { table: "import_entity_tombstones", kind: "ingest", why: "实体删除墓碑" },
  { table: "import_source_tombstones", kind: "ingest", why: "来源删除墓碑" },
  { table: "import_fact_history", kind: "ingest", why: "稀疏事实历史（旧值）" },
  { table: "import_generations", kind: "ingest", why: "raw/dependency 版本计数器" },
  { table: "import_issues", kind: "ingest", why: "本批问题清单" },
  { table: "import_manifest", kind: "ingest", why: "清单键值与持久回执" },
  { table: "entity_inventory", kind: "ingest", why: "导出清单盘点（原始）" },
  { table: "profile", kind: "ingest", why: "导出里的个人属性（原始）" },
  { table: "canonical_nights", kind: "ingest", why: "恢复事实：按窗口局部重建（步骤 4），读侧当输入" },
  { table: "canonical_hrv_days", kind: "ingest", why: "恢复事实：按窗口局部重建（步骤 4）" },
  { table: "recompute_jobs", kind: "ingest", why: "分析任务交接（§4.2 要求与事实同事务）" },
  { table: "recompute_job_events", kind: "ingest", why: "任务事件流（登记的副产品）" },

  { table: "feature_runs", kind: "analysis", why: "特征运行（候选分析）" },
  { table: "workout_features", kind: "analysis", why: "逐训练特征向量" },
  { table: "model_runs", kind: "analysis", why: "模型运行（候选分析）" },
  { table: "model_v2_runs", kind: "analysis", why: "V2 谱系" },
  { table: "model_release_bundles", kind: "analysis", why: "发布包与快照哈希" },
  { table: "model_release_refusals", kind: "analysis", why: "发布拒绝记录" },
  { table: "model_validation_gates", kind: "analysis", why: "发布门禁证据" },
  { table: "model_checkpoints", kind: "analysis", why: "重算 checkpoint" },
  { table: "model_domain_snapshots", kind: "analysis", why: "域快照" },
  { table: "ability_assessments", kind: "analysis", why: "能力评估（已发布分析）" },
  { table: "daily_ability_snapshots", kind: "analysis", why: "逐日能力快照" },
  { table: "training_metric_runs", kind: "analysis", why: "训练指标运行" },
  { table: "daily_training_metrics", kind: "analysis", why: "逐日训练指标" },
  { table: "workout_training_loads", kind: "analysis", why: "逐训练负荷（读侧由此派生）" },
  { table: "workout_zone_summaries", kind: "analysis", why: "逐训练分区摘要" },
  { table: "daily_zone_profiles", kind: "analysis", why: "逐日分区剖面" },
  { table: "active_model_run", kind: "analysis", why: "活跃发布指针" },
  { table: "active_model_release", kind: "analysis", why: "V2 活跃发布指针" },
  { table: "active_prediction_model", kind: "analysis", why: "活跃预测模型指针" },
  { table: "baseline_rebase_reviews", kind: "analysis", why: "基准确立复核" },
  { table: "recompute_validations", kind: "analysis", why: "重算校验记录" },
  { table: "prediction_model_runs", kind: "analysis", why: "预测模型运行" },
  { table: "prediction_model_events", kind: "analysis", why: "预测模型事件" },
  { table: "prediction_label_state", kind: "analysis", why: "预测标签状态" },
  { table: "prediction_calibration_artifacts", kind: "analysis", why: "预测校准产物" },
  { table: "coach_prediction_summaries", kind: "analysis", why: "教练预测摘要" },
  { table: "coach_fact_operations", kind: "analysis", why: "教练事实操作账目" },
  { table: "coach_feedback_revisions", kind: "analysis", why: "教练反馈修订" },
  { table: "workout_overrides", kind: "analysis", why: "用户输入（不在接收事务里改）" },
  { table: "performance_entries", kind: "analysis", why: "用户录入成绩（不在接收事务里改）" },
  { table: "privacy_zones", kind: "analysis", why: "用户设置" },
  { table: "privacy_zone_revisions", kind: "analysis", why: "用户设置修订" },
  { table: "training_zone_profile_settings", kind: "analysis", why: "用户设置" },
  { table: "schema_migrations", kind: "analysis", why: "迁移账本，接收事务永远不写" }
];

/** 生产 DDL 里出现、但**没有**在上表表态的表名。空数组表示清单自洽。 */
export function unclassifiedIngestTables(tables: readonly string[]): string[] {
  const declared = new Set(INGEST_TABLE_DISPOSITIONS.map((row) => row.table));
  return tables.filter((table) => !declared.has(table));
}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * 安装本模块的写守卫。
 *
 * 1. **未表态的表直接抛错**（fail-closed）：新迁移加了表而没人声明它属于哪一类时，
 *    我们不假装知道它能不能写。
 * 2. `analysis` 类表装 `BEFORE INSERT/UPDATE/DELETE` 的 TEMP 触发器 ⇒ `RAISE(ABORT, ...)`。
 *    TEMP 触发器只影响本连接、不落 schema、不影响别的读者。
 * 3. 事实写入**全程记账**（`rai_direct_sync_writes`）：提交前逐条核对"写进去的每个实体
 *    在账本里都有对应条目"。没有这条，"账目齐全"只是声称。
 */
export function installDirectSyncWriteGuards(db: DatabaseSync): void {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name: string }>).map((row) => row.name);
  const unclassified = unclassifiedIngestTables(tables);
  if (unclassified.length > 0) {
    throw new Error(
      `${DIRECT_SYNC_WRITE_GUARD}: 这些表还没有在 INGEST_TABLE_DISPOSITIONS 里表态：` +
      `${unclassified.join(", ")} —— 接收事务不知道该不该允许写它们，所以拒绝继续`
    );
  }
  for (const { table, kind } of INGEST_TABLE_DISPOSITIONS) {
    if (kind !== "analysis" || !tables.includes(table)) continue;
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      db.exec(`CREATE TEMP TRIGGER ${quoted(`rai_direct_sync_${table}_${event}`)}
        BEFORE ${event} ON main.${quoted(table)}
        BEGIN SELECT RAISE(ABORT, '${DIRECT_SYNC_WRITE_GUARD}'); END`);
    }
  }
  db.exec(`CREATE TEMP TABLE rai_direct_sync_writes (
    entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL, removed INTEGER NOT NULL,
    PRIMARY KEY (entity_kind, entity_id))`);
  for (const [table, kind] of [["health_records", "record"], ["workouts", "workout"]] as const) {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      // 🔴 UPDATE 有**两种**语义：普通更正 vs **软删标记**（v36 把物理删除改成了
      // `deleted_at` 标记）。写进 `workouts` 的那条语句是 UPDATE，但账本里它必须是 `removed`。
      // 判据直接用 `deleted_at`（与读侧同源的列），所以"软删"这件事在三种事件下都能被正确分类；
      // 漏掉这一条会让**每一次删除批次**在提交前被自己的守卫拒掉（实测就是这条先红）。
      const removed = event === "DELETE" ? "1"
        : event === "UPDATE" && table === "workouts" ? "(NEW.deleted_at IS NOT NULL)" : "0";
      db.exec(`CREATE TEMP TRIGGER ${quoted(`rai_direct_sync_track_${kind}_${event}`)}
        AFTER ${event} ON main.${quoted(table)} BEGIN
          INSERT OR REPLACE INTO rai_direct_sync_writes VALUES
            ('${kind}', ${event === "DELETE" ? "OLD" : "NEW"}.id, ${removed});
        END`);
    }
  }
}

export interface DirectSyncImportInput {
  databasePath: string;
  inputPath: string;
  jobId: string;
  payloadSha256: string;
  startedAtMs: number;
}

export type DirectSyncImportResult = {
  summary: NonNullable<ImportJobResponse["summary"]>;
  replayed: boolean;
  payloadClass: "record-only" | "analysis-required";
} | null;

interface PreparedPayload {
  xmlPath: string;
  xmlText: string;
  manifest: HealthSyncManifest;
}

/**
 * 输入目录里**允许存在**的东西：导出 XML、sync-manifest.json、以及 GPX（可在子目录里，
 * 例如 `workout-routes/`）。别的任何文件/目录类型一律不合格 ——
 * "输入目录里还能有什么"必须是可枚举的，否则载荷校验就退化成"看着像就行"。
 */
function inputTreeAllowed(root: string, relative = "", seen = { files: 0, bytes: 0 }): boolean {
  for (const entry of readdirSync(relative === "" ? root : join(root, relative), { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (!inputTreeAllowed(root, relative === "" ? name : `${relative}/${name}`, seen)) return false;
      continue;
    }
    if (!entry.isFile()) return false;
    if (relative === "" && ["export.xml", "导出.xml", "sync-manifest.json"].includes(name)) continue;
    if (!/\.gpx$/i.test(name)) return false;
    seen.files += 1;
    seen.bytes += statSync(join(root, relative, name)).size;
    if (seen.files > DIRECT_SYNC_MAX_ROUTE_FILES || seen.bytes > DIRECT_SYNC_MAX_ROUTE_BYTES) return false;
  }
  return true;
}

/** 事务之外的本批准备：路径安全、类型/配额、payload identity（§4.1）。 */
function preparePayload(input: DirectSyncImportInput): PreparedPayload | null {
  const entries = readdirSync(input.inputPath);
  const xmlName = entries.includes("export.xml") ? "export.xml" : "导出.xml";
  if (!entries.includes(xmlName) || !entries.includes("sync-manifest.json")) return null;
  if (!inputTreeAllowed(input.inputPath)) return null;
  const xmlPath = join(input.inputPath, xmlName);
  const manifestPath = join(input.inputPath, "sync-manifest.json");
  if (statSync(xmlPath).size > DIRECT_SYNC_MAX_XML_BYTES
      || statSync(manifestPath).size > DIRECT_SYNC_MAX_XML_BYTES) return null;
  const manifestText = readFileSync(manifestPath, "utf8");
  if (Buffer.byteLength(manifestText) > DIRECT_SYNC_MAX_XML_BYTES) return null;
  const manifest = parseHealthSyncManifest(manifestText);
  // v2 身份是这条车道的前提：没有 UUID 映射就无法保证"同一实体"（§7 的稳定身份）。
  if (!manifest.recordIdentity) return null;
  if (manifest.deletedRecords.length + manifest.deletedWorkoutIds.length > DIRECT_SYNC_MAX_RECORDS) return null;
  const xmlText = readFileSync(xmlPath, "utf8");
  if (Buffer.byteLength(xmlText) > DIRECT_SYNC_MAX_XML_BYTES) return null;
  const capturedSha256 = importPayloadSha256(digestHealthKitRecordSnapshot(xmlText, manifestText), {
    preserveAbsent: true, contractVersion: CONTRACT_VERSION,
    engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint()
  });
  if (capturedSha256 !== input.payloadSha256) throw new Error("Direct sync payload changed after admission");
  return { xmlPath, xmlText, manifest };
}

/** 库里已有的清单状态；决定这条车道能不能接（§4.3：**不**要求快通路资格 stamp）。 */
function identityState(db: DatabaseSync): Map<string, string> {
  return new Map((db.prepare(`SELECT key,value FROM import_manifest
    WHERE key IN ('dataset_version','parser_contract_version','parser_identity_algorithm','import_completed_at')`)
    .all() as { key: string; value: string }[]).map(({ key, value }) => [key, value]));
}

function eligibleIdentity(state: Map<string, string>): boolean {
  return Boolean(state.get("dataset_version") && state.get("import_completed_at")
    && state.get("parser_contract_version") === CONTRACT_VERSION
    && state.get("parser_identity_algorithm") === identityAlgorithmFingerprint());
}

/** 本批事实的分类输入。**来源是账本**，不是第二遍 XML 扫描（见设计文档 §7.1 修订一）。 */
function ledgerFacts(db: DatabaseSync, batchId: string, manifest: HealthSyncManifest, routeChanges: number): DirectSyncPayloadFacts {
  const recordTypes = (db.prepare(`
    SELECT DISTINCT record.type AS type FROM import_entity_changes change
    JOIN health_records record ON record.id = change.entity_id
    WHERE change.batch_id = ? AND change.entity_kind = 'record'
  `).all(batchId) as Array<{ type: string }>).map((row) => row.type);
  const kinds = new Set((db.prepare(
    "SELECT DISTINCT entity_kind AS kind FROM import_entity_changes WHERE batch_id = ?"
  ).all(batchId) as Array<{ kind: string }>).map((row) => row.kind));
  return {
    recordTypes: [...recordTypes, ...manifest.deletedRecords.map((row) => row.type)],
    hasWorkout: kinds.has("workout") || manifest.deletedWorkoutIds.length > 0,
    hasRoute: routeChanges > 0,
    deletedRecordCount: manifest.deletedRecords.length,
    deletedWorkoutCount: manifest.deletedWorkoutIds.length
  };
}

/** `dirtyFromAt` = 本批账目里最早的 `effective_at`；出现缺失/非法时刻就退回全量（fail-safe）。 */
function dirtyFromAt(db: DatabaseSync, batchId: string): string | null {
  const rows = db.prepare(
    "SELECT effective_at AS effectiveAt FROM import_entity_changes WHERE batch_id = ?"
  ).all(batchId) as Array<{ effectiveAt: string | null }>;
  let earliest: string | null = null;
  for (const row of rows) {
    const value = row.effectiveAt;
    if (typeof value !== "string" || !/^\d{4}-/.test(value) || !Number.isFinite(Date.parse(value))) return null;
    if (earliest === null || value < earliest) earliest = value;
  }
  return earliest;
}

function countWorkoutChanges(db: DatabaseSync, batchId: string): Record<"inserted" | "updated" | "removed", number> {
  const rows = db.prepare(`SELECT change_type AS kind, COUNT(*) AS count FROM import_entity_changes
    WHERE batch_id = ? AND entity_kind = 'workout' GROUP BY change_type`).all(batchId) as
    Array<{ kind: string; count: number }>;
  const byKind = new Map(rows.map((row) => [row.kind, Number(row.count)]));
  return {
    inserted: byKind.get("inserted") ?? 0,
    updated: byKind.get("updated") ?? 0,
    removed: byKind.get("removed") ?? 0
  };
}

/**
 * 执行一批直连接收。`null` 是**证明过的回退**（不合格或分析登记不可用且本批需要分析），
 * 永远不是"收了一半"：返回 null 之前调用方事务已经整体回滚。
 */
export async function applyDirectSyncImport(input: DirectSyncImportInput): Promise<DirectSyncImportResult> {
  assertDirectSyncRequestShape(input);
  if (!existsSync(input.databasePath) || !/^[a-f0-9]{64}$/.test(input.payloadSha256)) return null;
  const entries = readdirSync(input.inputPath);
  const payload = preparePayload(input);
  if (!payload) return null;
  const probe = RaiDatabase.openReadonly(input.databasePath);
  try {
    if (!eligibleIdentity(identityState(probe)) || RaiDatabase.pendingMigrations(input.databasePath).length) return null;
  } finally {
    probe.close();
  }

  const store = await RaiDatabase.open(input.databasePath, { transactionOwner: "caller" });
  const db = store.database;
  try {
    installDirectSyncWriteGuards(db);
    const replayed = readImportReceiptInDatabase(db, input.jobId);
    if (replayed) {
      const batch = db.prepare("SELECT summary_json FROM import_batches WHERE id=?").get(input.jobId);
      if (!batch || JSON.parse(String(batch.summary_json)).payloadSha256 !== input.payloadSha256) {
        throw new Error("Direct sync batch id was reused with different content");
      }
      const stored = db.prepare("SELECT value FROM import_manifest WHERE key='direct_sync_payload_class'").get();
      return {
        summary: replayed, replayed: true,
        payloadClass: String((stored as { value?: string } | undefined)?.value ?? "analysis-required") as
          "record-only" | "analysis-required"
      };
    }

    // Acknowledgement must survive power loss, not only a graceful process exit.
    // 🔴 必须在 BEGIN **之前**：SQLite 拒绝在事务里改安全级别（实测报
    // "Safety level may not be changed inside a transaction"）—— 放在 BEGIN 之后
    // 会让**每一批**都在开事务后立刻失败。
    db.exec("PRAGMA synchronous=FULL");
    store.beginCallerTransaction();
    const state = identityState(db);
    if (!eligibleIdentity(state)) throw new RecordDeltaNotEligibleError("identity state changed before BEGIN");
    const previousVersion = state.get("dataset_version")!;
    if (db.prepare("SELECT 1 FROM import_batches WHERE id=?").get(input.jobId)) {
      throw new RecordDeltaNotEligibleError("existing batch has no completed receipt");
    }
    const entityGeneration = `delta:${input.jobId}`;
    db.prepare(`INSERT INTO import_batches
      (id,xml_sha256,status,import_mode,previous_dataset_version,summary_json)
      VALUES (?,'pending','running','incremental',?,'{}')`).run(input.jobId, previousVersion);

    const parsed = await parseAppleHealthXml(payload.xmlPath, store, {
      fileSize: Buffer.byteLength(payload.xmlText),
      healthKitRecordIdentity: true,
      deletedRecords: payload.manifest.deletedRecords,
      deletedWorkoutIds: payload.manifest.deletedWorkoutIds,
      callerOwnedTransaction: true,
      incremental: { generation: entityGeneration, batchId: input.jobId, preserveAbsent: true }
    });
    const routes = await importGpxRoutes(input.inputPath, store, { preserveAbsent: true });
    // 训练会话的**局部**规范化：只处理本批弄脏的训练时刻（解析器给的 dirtyWorkoutTimes
    // + 本批改过的路线所属训练）。不做全量重建（§8.2）。
    const routeDirtyTimes = (routes.changedRouteIds ?? []).flatMap((routeId) => {
      const row = db.prepare(`SELECT workout.start_at AS startAt FROM workout_routes route
        JOIN workouts workout ON workout.id = route.workout_id WHERE route.id = ?`)
        .get(routeId) as { startAt: string } | undefined;
      return row ? [row.startAt] : [];
    });
    canonicalizeRunningWorkouts(db, {
      dirtyWorkoutTimes: [...(parsed.dirtyWorkoutTimes ?? []), ...routeDirtyTimes]
    }, { callerOwnedTransaction: true });

    const facts = ledgerFacts(db, input.jobId, payload.manifest, routes.changedRouteIds?.length ?? routes.importedRouteCount);
    const classification = classifyDirectSyncPayload(facts);
    const analysisRequired = classification.payloadClass === "analysis-required";

    // 代次：raw 每个批次都递增；dependency 只在**本批影响分析**时递增（§9.2 的第一条）。
    db.prepare(`UPDATE import_generations SET raw_generation = raw_generation + 1,
      dependency_generation = dependency_generation + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE singleton = 1`).run(analysisRequired ? 1 : 0);
    const generations = db.prepare(
      "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton = 1"
    ).get() as { raw: number; dependency: number };

    const now = new Date().toISOString();
    const datasetVersion = `dataset_delta_${hashOf(previousVersion, input.payloadSha256)}`;
    let analysisJobId: string | null = null;
    if (analysisRequired) {
      const incumbent = db.prepare("SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1")
        .get() as { modelRunId: string } | undefined;
      const dirty = dirtyFromAt(db, input.jobId);
      analysisJobId = new RecomputeJobRepository(db).enqueue(
        "import", datasetVersion,
        {
          mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
          importBatchId: input.jobId,
          evaluatedAt: now,
          timezoneIdentifier: DATABASE_TIMEZONE,
          ...(dirty === null ? {} : { incrementalPlan: { mode: "partial" as const, dirtyFromAt: dirty } })
        },
        {
          targetRawGeneration: Number(generations.raw),
          targetDependencyGeneration: Number(generations.dependency),
          ...(incumbent === undefined ? {} : { expectedIncumbentReleaseId: incumbent.modelRunId }),
          dirty: { reasons: classification.reasons, unknownRecordTypes: classification.unknownRecordTypes, from: dirty }
        }
      );
    }

    const changes = countWorkoutChanges(db, input.jobId);
    const summary: NonNullable<ImportJobResponse["summary"]> = {
      recomputeReasons: classification.reasons.length > 0
        ? [...classification.reasons]
        : ["data_only_transaction"],
      importMode: "incremental",
      insertedWorkouts: changes.inserted, updatedWorkouts: changes.updated, removedWorkouts: changes.removed,
      unchangedWorkouts: Number(db.prepare("SELECT COUNT(*) AS n FROM training_sessions").get()!.n),
      routesUpdated: routes.importedRouteCount,
      featuresReused: 0, featuresRecomputed: 0, modelReplayFrom: null,
      durationMs: Date.now() - input.startedAtMs, backupName: null,
      directSync: {
        ingestStatus: "committed",
        // 🔴 本批需要分析时这里必须是 `queued`：任务**已经在同一个事务里**登记完了。
        // 写 `published` 会是假话（分析还没跑），写 `not_required` 更是（§9.1）。
        analysisStatus: analysisRequired ? "queued" : "not_required",
        receiptId: input.jobId,
        dependencyGeneration: String(generations.dependency),
        publishedReleaseId: null,
        parentBatchId: null
      }
    };
    const metadata: Record<string, string> = {
      dataset_version: datasetVersion,
      source_xml_name: basename(payload.xmlPath),
      source_xml_bytes: String(Buffer.byteLength(payload.xmlText)),
      import_started_at: new Date(input.startedAtMs).toISOString(),
      import_completed_at: now,
      direct_sync_payload_class: classification.payloadClass,
      source_payload_anchor: JSON.stringify({ sha256: input.payloadSha256, datasetVersion })
    };
    for (const [key, value] of Object.entries(metadata)) store.setManifest(key, value);
    const xmlSha256 = String((db.prepare("SELECT value FROM import_manifest WHERE key='source_xml_sha256'").get() as
      { value: string } | undefined)?.value ?? "");
    if (!/^[a-f0-9]{64}$/.test(xmlSha256)) throw new Error("Direct sync batch has no source XML hash");
    const batchSummary = JSON.stringify({
      payloadSha256: input.payloadSha256, changes, xml: parsed, routes,
      classification: { payloadClass: classification.payloadClass, reasons: classification.reasons },
      analysisJobId, publication: "transactional-direct-sync"
    });
    db.prepare(`UPDATE import_batches SET xml_sha256=?, status='succeeded',
      dataset_version=?, summary_json=?, completed_at=? WHERE id=?`)
      .run(xmlSha256, datasetVersion, batchSummary, now, input.jobId);
    writeImportReceiptInDatabase(db, input.jobId, summary);

    // 提交前回读：账目齐全、任务真在、回执真的落库（§4.2 的"回读必要的事实"）。
    const unledgered = db.prepare(`SELECT mutation.entity_id FROM temp.rai_direct_sync_writes mutation
      LEFT JOIN import_entity_changes change ON change.batch_id=? AND change.entity_kind=mutation.entity_kind
        AND change.entity_id=mutation.entity_id
      WHERE change.entity_id IS NULL
        OR (mutation.removed=1 AND change.change_type<>'removed')
        OR (mutation.removed=0 AND change.change_type NOT IN ('inserted','updated')) LIMIT 1`).get(input.jobId);
    if (unledgered) throw new Error("Direct sync write has no matching atomic change ledger");
    if (analysisRequired) {
      const job = db.prepare("SELECT job_type AS jobType, status, target_dependency_generation AS dependency, request_json AS request FROM recompute_jobs WHERE id=?")
        .get(analysisJobId) as { jobType: string; status: string; dependency: number; request: string } | undefined;
      if (!job || job.jobType !== "import" || job.status !== "queued"
          || Number(job.dependency) !== Number(generations.dependency)
          || JSON.parse(job.request).mode !== DIRECT_SYNC_ANALYSIS_REQUEST_MODE) {
        throw new Error("Direct sync analysis job failed its pre-commit assertion");
      }
    } else if (analysisJobId !== null) {
      throw new Error("Direct sync batch registered an analysis job while claiming not_required");
    }
    const receipt = readImportReceiptInDatabase(db, input.jobId);
    if (!receipt || receipt.directSync?.analysisStatus !== summary.directSync?.analysisStatus
        || receipt.directSync?.ingestStatus !== "committed") {
      throw new Error("Direct sync receipt failed its pre-commit assertion");
    }
    store.commitCallerTransaction();
    return { summary, replayed: false, payloadClass: classification.payloadClass };
  } catch (error) {
    store.rollbackCallerTransaction();
    if (error instanceof RecordDeltaNotEligibleError ||
        (error instanceof Error && error.message.includes(DIRECT_SYNC_WRITE_GUARD))) return null;
    throw error;
  } finally {
    store.close();
  }
}

function hashOf(previousVersion: string, payloadSha256: string): string {
  return createHash("sha256").update(previousVersion).update("\0").update(payloadSha256).digest("hex").slice(0, 32);
}
