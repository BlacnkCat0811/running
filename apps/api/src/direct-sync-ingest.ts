import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  CONTRACT_VERSION, DATABASE_TIMEZONE, DIRECT_SYNC_ANALYSIS_REQUEST_MODE, localCalendarFormatter
} from "@rai/contracts";
import type { ImportJobResponse } from "@rai/api-contracts";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";
import {
  DATA_ONLY_MAX_RECORDS, NATIVE_VERSION, NIGHT_FEEDING_TYPE_VALUES,
  RecordDeltaNotEligibleError, canonicalizeNightsForWindow, canonicalizeRunningWorkouts,
  classifyDirectSyncPayload, identityAlgorithmFingerprint, importGpxRoutes,
  loadDirtyRangeInput,
  parseAppleHealthXml, parseHealthSyncManifest, planIncrementalAnalysisDirtyRange,
  type DirectSyncPayloadFacts, type HealthSyncManifest
} from "@rai/health-export-parser";

import { readImportReceiptInDatabase, writeImportReceiptInDatabase } from "./import-publication.js";
import { assertDirectSyncRequestShape } from "./direct-sync-plan.js";
import { importPayloadSha256 } from "./import-payload-identity.js";
import { digestHealthKitExportContent } from "./import-sources.js";

/**
 * 直连增量同步的**统一原始接收器**（`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §3 的
 * `DirectSyncIngestWorker`；落地设计见 `docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md` §2）。
 *
 * 与既有的 record-only 快通路（`data-only-import.ts`）的分工：
 *   - 那条车道的入口判据是**载荷形状**（`isDataOnlyRecordXml` + 非评分类型白名单），
 *     它结构上不可能触及分析，所以回执可以写 `not_required`；worker **先**试它。
 *   - 本模块是**一般车道**：接受 Workout / 评分类型 / 显式删除 / GPX，在**同一个主库事务**里
 *     写事实、账本、回执，并在需要分析时**同事务登记**分析任务（§4.2）。
 *     2026-10-13（步骤 2e）起它是**生产调用方**：worker 在快通路拒收后投递 `direct-sync` 任务，
 *     端到端证据见 `apps/api/test/import-worker-direct-sync.test.ts`。
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
 * 单批上界（§14.3 P01 的"每批 ≤ 5000 条"仍成立；xml 上界 2026-10-14 由 2 MiB 放宽为 8 MiB）。
 *
 * 🔴 放宽的原因（2026-10-14 实测）：收口版上线当天，手机全量回填批（xml 2,411,741 B /
 * route 34,009,725 B）被 `route_exceeds_bounds` + `xml_exceeds_bounds` 双拒 ——
 * iOS 分批预算（`DirectSyncBatchBudget`）只覆盖 xml/records、且可超尾页，
 * 沿用 record-only 车道的 2 MiB 会让**正常**回填批硬失败（收口后不再回退旧链路）。
 * 8 MiB 覆盖 iOS 依新 bounds 收敛的预算（8 × 0.9 MiB + 尾页余量）。
 * 超限的载荷**不做**分片（§5.2 的分片计划还没实现）—— 直接不合格、显式拒绝，
 * 而不是"先收一半"。
 */
export const DIRECT_SYNC_MAX_XML_BYTES = 8 * 1024 * 1024;
export const DIRECT_SYNC_MAX_RECORDS = DATA_ONLY_MAX_RECORDS;
/**
 * 路线上界是**临时值**（每批文件数与合计字节），口径按 §14.3 P05（轨迹点数与分块单独计量）。
 * ⚠️ 它们**不是**实测结论：P05 要求目标云机实测，本环境给不了。取这两个数的目的是
 * "输入目录里能有什么必须可枚举、可上界"，而不是性能结论；超过上界 ⇒ 不合格显式拒绝。
 *
 * 🔴 2026-10-14 放宽 32 → 64 MiB：手机路线回填批实测 62 文件 / 36.0 MB 磁盘
 * （服务端口径 58 文件 / 34,009,725 B），而 iOS 侧**没有** route 预算维度
 * （`DirectSyncBatchBudget` 只含 xml/records）⇒ 32 MiB 会把正常回填批硬拒。
 * 文件数上界 200 不变（实测 62）。
 */
export const DIRECT_SYNC_MAX_ROUTE_FILES = 200;
export const DIRECT_SYNC_MAX_ROUTE_BYTES = 64 * 1024 * 1024;

/**
 * 直连拒收的**稳定机器码**（观测版，2026-10-14 实施方案 §5.2 S1.1）。
 *
 * 为什么要有它：此前所有不合格路径都折成 `return null` ⇒ worker 只能看到"拒了"，
 * 看不到"为什么拒"，而后果是整个批走候选链路（线上 9.9–13.3 min，两次全库校验占 71.5–76.9%）。
 * 拒因进 `performance_json.lane.rejections` 与主线程日志。**阶段 1 只观测，不改控制流**：
 * 每一条都仍然回退候选链路（收口改为显式失败是阶段 3 的事）。
 */
export type DirectSyncRejectionReason =
  | "missing_required_files"
  | "input_tree_not_allowed"
  | "route_exceeds_bounds"
  | "xml_exceeds_bounds"
  | "manifest_exceeds_bounds"
  | "missing_record_identity"
  | "deletions_exceed_bounds"
  | "database_not_found"
  | "payload_identity_invalid"
  | "pending_migrations"
  | "identity_not_eligible"
  | "baseline_rebuild_required"
  | "batch_without_receipt"
  | "write_guard_triggered";

/** 拒收发生在哪一步（排查用；与 reason 正交）。 */
export type DirectSyncRejectionStage = "read" | "prepare" | "identity" | "transaction";

/**
 * 直连车道的拒收记录。
 *
 * 🔴 `directSyncRejected: true` 是**判别位**，不是装饰：本对象跨 worker 线程边界
 * （`import-database-thread.ts` 的 postMessage 走结构化克隆），类实例的原型链会被剥掉 ——
 * 用 `instanceof` 判别在接收端恒为假（假守卫），所以用数据字段判别（`isDirectSyncRejection`）。
 */
export interface DirectSyncRejection {
  readonly directSyncRejected: true;
  readonly reason: DirectSyncRejectionReason;
  readonly stage: DirectSyncRejectionStage;
  readonly detail?: string;
  readonly actual?: Readonly<Record<string, number>>;
  readonly bounds?: Readonly<Record<string, number>>;
}

/** 判别本对象是不是一条拒收记录（跨线程安全：只看数据字段，不看原型）。 */
export function isDirectSyncRejection(value: unknown): value is DirectSyncRejection {
  return typeof value === "object" && value !== null
    && (value as { directSyncRejected?: unknown }).directSyncRejected === true;
}

function rejectDirect(
  reason: DirectSyncRejectionReason, stage: DirectSyncRejectionStage,
  extra: { detail?: string; actual?: Record<string, number>; bounds?: Record<string, number> } = {}
): DirectSyncRejection {
  return { directSyncRejected: true, reason, stage, ...extra };
}

/**
 * 事务内的直连拒收（先滚事务、再由 catch 转成 rejection 记录返回；对外**不抛**）。
 * 与"真错误"（抛给调用方让整批失败）区分 —— 与阶段 1 之前 `RecordDeltaNotEligibleError`
 * 被 catch 转成 `null` 的路径**逐条等价**，只是现在把理由带出来。
 */
class DirectSyncIngestRejected extends Error {
  constructor(readonly rejection: DirectSyncRejection) {
    super(rejection.detail ?? rejection.reason);
    this.name = "DirectSyncIngestRejected";
  }
}

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
  // O06-A / WP-22（v39）：输入绑定与覆盖证明是**发布事务**的产物（与指针翻转同一事务）。
  // 接收事务里没有任何合法的写入理由 —— 归 analysis 一侧即被写守卫挡住，
  // 这正是"接收端不许顺手改发布证据"的表达。
  { table: "analysis_run_input_bindings", kind: "analysis", why: "分析输入绑定（发布事务写入）" },
  { table: "analysis_job_coverage", kind: "analysis", why: "分析覆盖证明（发布事务写入）" },
  // O09 / WP-32（v41）：负荷／分区／日级的带版本 checkpoint。它是**分析侧**的滚动状态，
  // 只在分析写入窗口里落库，接收事务里没有任何合法写入理由。
  //
  // 🔴 这一行不是装饰：本守卫是**失败关闭**的 —— 库里出现一张没表过态的新表，
  // **每一次**直连接收都会被整体拒绝（`write_guard_triggered`）。所以新迁移加表时必须
  // 同批在这里表态，否则坏的不是"新功能"，而是**整条同步车道**
  // （2026-10-16 实测：v41 加表未表态期间，三条直连用例整批红，而根因在另一个包里）。
  { table: "training_metric_checkpoints", kind: "analysis", why: "训练指标域 checkpoint（分析写入）" },
  // O06-B / WP-40（v42）：原任务 → 覆盖任务的合并关联。与 `analysis_job_coverage` 同类：
  // 只在分析车道的短事务里写入，接收事务里没有任何合法写入理由。
  { table: "analysis_job_merges", kind: "analysis", why: "原任务→覆盖任务的合并关联（分析侧写入）" },
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

/**
 * 直连接收的**成功**结果形状。
 *
 * 观测版（阶段 1）起它不再含 `null` 变体：拒收回退由 `applyDirectSyncImport` 的联合返回
 * 类型（`DirectSyncImportResult | DirectSyncRejection`）携带，且**带稳定拒因码**。
 */
export type DirectSyncImportResult = {
  summary: NonNullable<ImportJobResponse["summary"]>;
  replayed: boolean;
  payloadClass: "record-only" | "analysis-required";
};

interface PreparedPayload {
  xmlPath: string;
  xmlText: string;
  manifest: HealthSyncManifest;
}

/** `preparePayload` 的判别联合：成功带载荷，失败带**带码**的拒收记录（观测版）。 */
type PrepareOutcome = { ok: true; payload: PreparedPayload } | { ok: false; rejection: DirectSyncRejection };

/**
 * 输入目录里**允许存在**的东西，与导入器**真正会读**的东西**逐项对齐**：
 *   - 顶层：`export.xml`（或 `导出.xml`）+ `sync-manifest.json`；
 *   - `workout-routes/` 下的 `.gpx`（可再分子目录）。
 *
 * 🔴 为什么必须"对齐"而不是"宽松一点"：载荷身份摘要（下一条）只覆盖
 * XML + manifest + `workout-routes/**`，导入器（`allGpxRelativePaths`）也只走这一个目录。
 * 允许别的 GPX 位置会造出"被允许、但不进摘要、也不会被导入"的文件 ——
 * 那种文件既没被证明无害，也没被证明被读过，正好是"看着像就行"的退化形态。
 *
 * 观测版差异：返回值从 `boolean` 改为带码结果，把"输入集合不合法"与"路由超上界"
 * 分开（后者带 `actual`/`bounds`，供 iOS 端收敛拆批预算）。**判定顺序与判据逐条等价。**
 */
function inputTreeCheck(root: string, relative = "", seen = { files: 0, bytes: 0 }): InputTreeOutcome {
  const atTopLevel = relative === "";
  const insideRoutes = relative === "workout-routes" || relative.startsWith("workout-routes/");
  for (const entry of readdirSync(atTopLevel ? root : join(root, relative), { withFileTypes: true })) {
    const name = entry.name;
    const child = atTopLevel ? name : `${relative}/${name}`;
    if (entry.isDirectory()) {
      if (!(atTopLevel && name === "workout-routes") && !insideRoutes) {
        return { ok: false, rejection: rejectDirect("input_tree_not_allowed", "prepare",
          { detail: `unexpected_directory:${child}` }) };
      }
      const nested = inputTreeCheck(root, child, seen);
      if (!nested.ok) return nested;
      continue;
    }
    if (!entry.isFile()) {
      return { ok: false, rejection: rejectDirect("input_tree_not_allowed", "prepare",
        { detail: `not_a_regular_file:${child}` }) };
    }
    if (atTopLevel && ["export.xml", "导出.xml", "sync-manifest.json"].includes(name)) continue;
    if (!insideRoutes || !/\.gpx$/i.test(name)) {
      return { ok: false, rejection: rejectDirect("input_tree_not_allowed", "prepare",
        { detail: `unexpected_file:${child}` }) };
    }
    seen.files += 1;
    seen.bytes += statSync(join(root, relative, name)).size;
    if (seen.files > DIRECT_SYNC_MAX_ROUTE_FILES || seen.bytes > DIRECT_SYNC_MAX_ROUTE_BYTES) {
      return { ok: false, rejection: rejectDirect("route_exceeds_bounds", "prepare", {
        actual: { routeFiles: seen.files, routeBytes: seen.bytes },
        bounds: { maxRouteFiles: DIRECT_SYNC_MAX_ROUTE_FILES, maxRouteBytes: DIRECT_SYNC_MAX_ROUTE_BYTES }
      }) };
    }
  }
  return { ok: true };
}

type InputTreeOutcome = { ok: true } | { ok: false; rejection: DirectSyncRejection };

/** `preparePayload` 的失败出口（拒绝原因 + 观测字段一次成型）。 */
const refuse = (
  reason: DirectSyncRejectionReason, stage: DirectSyncRejectionStage,
  extra: { detail?: string; actual?: Record<string, number>; bounds?: Record<string, number> } = {}
): PrepareOutcome => ({ ok: false, rejection: rejectDirect(reason, stage, extra) });

/**
 * 直连载荷的**预检**（不读 XML 全文做摘要复核）：目录形状 / 上界 / v2 身份 / 删除配额。
 *
 * 两个消费点**共用同一份判据**（单一来源）：
 *   - `applyDirectSyncImport`（worker 兜底；收口后不合规 = 显式失败 + 稳定码）；
 *   - `POST /v1/imports/inspect`（S3.1 的同步预检：不合规 ⇒ 400 + 稳定码 + bounds/actual，
 *     **不建 job、零副作用**；客户端可据此拆批）。
 * 拆成独立函数而不是"两处各写一份"：判据漂移的方向是"inspect 放过的载荷在 worker 又被拒"
 * （用户看到"检查通过后失败"）或反方向（前端拆批规则与后端不一致），两种都很难排查。
 */
export function preflightDirectSyncPayload(inputPath: string):
  | { ok: true; xmlPath: string; manifest: HealthSyncManifest }
  | { ok: false; rejection: DirectSyncRejection } {
  // 🔴 输入目录整体缺失 ⇒ 受控拒收，不让 ENOENT 冒泡成 500。
  // 正常流程不会走到这里（inspect 路由对"已导入"来源已在上一层跳过本函数），
  // 这是 worker 兜底与异常态（目录被外部删除）的防线。
  if (!existsSync(inputPath)) {
    return { ok: false, rejection: rejectDirect("missing_required_files", "prepare",
      { detail: "input_path_missing" }) };
  }
  const entries = readdirSync(inputPath);
  const xmlName = entries.includes("export.xml") ? "export.xml" : "导出.xml";
  if (!entries.includes(xmlName) || !entries.includes("sync-manifest.json")) {
    return { ok: false, rejection: rejectDirect("missing_required_files", "prepare",
      { detail: `entries:${entries.slice(0, 8).join("|")}` }) };
  }
  const tree = inputTreeCheck(inputPath);
  if (!tree.ok) return { ok: false, rejection: tree.rejection };
  const xmlPath = join(inputPath, xmlName);
  const manifestPath = join(inputPath, "sync-manifest.json");
  const xmlFileBytes = statSync(xmlPath).size;
  if (xmlFileBytes > DIRECT_SYNC_MAX_XML_BYTES) {
    return { ok: false, rejection: rejectDirect("xml_exceeds_bounds", "prepare",
      { actual: { xmlBytes: xmlFileBytes }, bounds: { maxXmlBytes: DIRECT_SYNC_MAX_XML_BYTES } }) };
  }
  const manifestFileBytes = statSync(manifestPath).size;
  if (manifestFileBytes > DIRECT_SYNC_MAX_XML_BYTES) {
    // 🔴 键名必须是 `maxManifestBytes`，不是 `maxXmlBytes`（P3a，2026-10-14）。
    // `actual` 报的是 `manifestBytes`，`bounds` 却曾报 `maxXmlBytes` ⇒ 同一个对象的两半
    // 在说两件事，排查时无法区分"manifest 超了"还是"xml 超了"。
    // 上界常量**共用**（`DIRECT_SYNC_MAX_XML_BYTES`）是**刻意的**：manifest 与 export.xml
    // 是同一批里的两个自述文件，各自都要能装进同一个壳上界。共用常量 ≠ 共用键名。
    return { ok: false, rejection: rejectDirect("manifest_exceeds_bounds", "prepare",
      { actual: { manifestBytes: manifestFileBytes }, bounds: { maxManifestBytes: DIRECT_SYNC_MAX_XML_BYTES } }) };
  }
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifestTextBytes = Buffer.byteLength(manifestText);
  if (manifestTextBytes > DIRECT_SYNC_MAX_XML_BYTES) {
    // 同上（P3a）：键名报的是**被量的那个量**，与 `actual.manifestBytes` 对齐。
    return { ok: false, rejection: rejectDirect("manifest_exceeds_bounds", "prepare",
      { actual: { manifestBytes: manifestTextBytes }, bounds: { maxManifestBytes: DIRECT_SYNC_MAX_XML_BYTES } }) };
  }
  const manifest = parseHealthSyncManifest(manifestText);
  // v2 身份是这条车道的前提：没有 UUID 映射就无法保证"同一实体"（§7 的稳定身份）。
  if (!manifest.recordIdentity) {
    return { ok: false, rejection: rejectDirect("missing_record_identity", "prepare",
      { detail: "manifest.recordIdentity 缺失" }) };
  }
  const deletions = manifest.deletedRecords.length + manifest.deletedWorkoutIds.length;
  if (deletions > DIRECT_SYNC_MAX_RECORDS) {
    return { ok: false, rejection: rejectDirect("deletions_exceed_bounds", "prepare",
      { actual: { deletions }, bounds: { maxRecords: DIRECT_SYNC_MAX_RECORDS } }) };
  }
  return { ok: true, xmlPath, manifest };
}

/**
 * 事务之外的本批准备：预检 + 载荷身份复核（§4.1）。
 *
 * 观测版：每一条"不合格"都带稳定机器码返回（`PrepareOutcome`），不再折成裸 `null`。
 * 判定顺序、判据、以及"载荷已变更"的**硬失败**语义与之前逐条等价。
 */
async function preparePayload(input: DirectSyncImportInput): Promise<PrepareOutcome> {
  const preflight = preflightDirectSyncPayload(input.inputPath);
  if (!preflight.ok) return { ok: false, rejection: preflight.rejection };
  const xmlText = readFileSync(preflight.xmlPath, "utf8");
  const xmlBytes = Buffer.byteLength(xmlText);
  if (xmlBytes > DIRECT_SYNC_MAX_XML_BYTES) {
    return refuse("xml_exceeds_bounds", "prepare",
      { actual: { xmlBytes }, bounds: { maxXmlBytes: DIRECT_SYNC_MAX_XML_BYTES } });
  }
  // 🔴 必须与**准入时**（worker 的 `computeImportPayloadSha256`）用**同一个**摘要函数：
  // 两者都折进 `workout-routes/**` 的路由内容。2026-10-13 实测的缺陷：这里曾经只算
  // XML+manifest（`digestHealthKitRecordSnapshot`），于是任何**带 GPX** 的载荷都会在
  // "载荷已变更"这句错误结论上**硬失败**（不是回退）—— 而 GPX 正是这条车道要接的类型之一。
  // 代价：多读一遍 XML 与路由文件（上界 8 MiB + 64 MiB，见上面的常量），换来"同一件事只有一处算法"。
  const capturedSha256 = importPayloadSha256(await digestHealthKitExportContent(input.inputPath), {
    preserveAbsent: true, contractVersion: CONTRACT_VERSION,
    engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint()
  });
  if (capturedSha256 !== input.payloadSha256) throw new Error("Direct sync payload changed after admission");
  return { ok: true, payload: { xmlPath: preflight.xmlPath, xmlText, manifest: preflight.manifest } };
}

/** 本地日期（`DATABASE_TIMEZONE`）——与读侧同一口径。 */
const localDateOf = (instant: number): string =>
  localCalendarFormatter(DATABASE_TIMEZONE, "day").format(new Date(instant));

const shiftLocalDate = (localDate: string, days: number): string => {
  const shifted = new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
};

/**
 * 本批触及的**夜**窗口（本地日期闭区间）。`null` = 本批一条喂夜的记录都没碰。
 *
 * 有界性的来源：窗口只由**本批账目**里的时间戳算出（不是全表扫描），并向外各放宽一天
 * 以覆盖跨夜（睡眠段常常跨过午夜）。
 *
 * 删除的处理：被删的 `health_records` 行已经不存在，时间只能取自账本
 * （`import_entity_changes.effective_at` = 删除前那条记录的起点），而"删的是不是喂夜类型"
 * 只能取自 manifest 的**类型化删除**（v2 才有类型）。只要本批有喂夜类型的删除，就把本批
 * **全部** record 删除的时刻并进窗口 —— 宁可窗口宽一点（仍然有界），也不要漏掉一个夜。
 *
 * O10（WP-31）步骤 4 —— **不相邻的时期不再被一个全局 min/max 跨度连起来**：
 * 一批同时更正 1 月初与 12 月末两条睡眠段时，旧实现返回一个覆盖全年的 `[1/1-1d, 12/31+1d]`，
 * 于是中间 **约 11 个月**的夜被整体 `DELETE` + 重建。那些夜与这批变更毫无关系：结果虽然相同
 * （同样的输入段 ⇒ 同样的行），代价却是无界的，而且会把中间那些行的到达时间快照也做一遍。
 * 现在先按**本地日期连续段**分组，每个连续段各自 ±1 天 padding，再归并重叠/相接的时期。
 *
 * 等价性（单时期情形）：受影响本地日期**连续**时，分组结果只有一个连续段，padding 后正好是
 * `[min-1, max+1]` —— 与旧实现的返回值**逐字相同**。`from`/`to` 仍然返回这个总跨度
 * （= 第一个时期的 `from` / 最后一个时期的 `to`），所以回执里的窗口字段语义一个字节都没变；
 * 真正被重建的是 `periods`，它是总跨度的一个子集。`earliestInstant` 同样逐字不变。
 */
function nightWindow(
  db: DatabaseSync,
  batchId: string,
  manifest: HealthSyncManifest
): {
  /** 总跨度（= 第一个时期的 `from` … 最后一个时期的 `to`）：回执展示用，与旧实现逐字相同。 */
  from: string;
  to: string;
  /** 真正要重建的时期：本地日期闭区间、各自 ±1 天 padding、**互不重叠也不相接**。 */
  periods: Array<{ from: string; to: string }>;
  earliestInstant: string;
} | null {
  const types = NIGHT_FEEDING_TYPE_VALUES as readonly string[];
  const placeholders = types.map(() => "?").join(",");
  const written = db.prepare(`
    SELECT record.start_at AS startAt, record.end_at AS endAt,
      change.previous_effective_at AS previousAt, change.previous_end_at AS previousEndAt
    FROM import_entity_changes change
    JOIN health_records record ON record.id = change.entity_id
    WHERE change.batch_id = ? AND change.entity_kind = 'record'
      AND (record.type IN (${placeholders}) OR change.previous_type IN (${placeholders}))
  `).all(batchId, ...types, ...types) as Array<{
    startAt: string | null; endAt: string | null;
    previousAt: string | null; previousEndAt: string | null;
  }>;
  const deletesNightType = manifest.deletedRecords.some((row) => types.includes(row.type));
  const removed = deletesNightType ? db.prepare(`
    SELECT effective_at AS effectiveAt FROM import_entity_changes
    WHERE batch_id = ? AND entity_kind = 'record' AND change_type = 'removed'
  `).all(batchId) as Array<{ effectiveAt: string | null }> : [];
  const instants: number[] = [];
  for (const row of [...written, ...removed.map((row) => ({
    startAt: row.effectiveAt, endAt: row.effectiveAt, previousAt: null, previousEndAt: null
  }))]) {
    // R7（2026-10-15）：更新前的旧范围（previous_*）一并进窗口——记录从 A 日移到 B 日时，
    // A 日的旧夜必须被重建/清掉（否则残留，R7 的实证）。current 与 previous 取**并集**，
    // 宽出来的部分由 ±1 天 padding 与"窗口外逐字节不变"的金丝雀兜住。
    for (const value of [row.startAt, row.endAt, row.previousAt, row.previousEndAt]) {
      if (typeof value !== "string") continue;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) instants.push(parsed);
    }
  }
  if (instants.length === 0) return null;
  const dates = instants.map(localDateOf).sort();
  // 连续段分组：`YYYY-MM-DD` 的字典序 == 日历序，所以"下一个受影响日期正好是上一段末日的次日"
  // 才并进同一段。相隔多日的两个日期落在不同段 —— 中间那些日期**没有任何本批变更**。
  const runs: Array<{ from: string; to: string }> = [];
  for (const date of dates) {
    const last = runs.at(-1);
    if (last !== undefined && date <= shiftLocalDate(last.to, 1)) { if (date > last.to) last.to = date; continue; }
    runs.push({ from: date, to: date });
  }
  // 每个连续段各自 ±1 天 padding，再归并重叠/相接的时期（两个相隔一天的连续段，padding 后会相接）。
  const periods: Array<{ from: string; to: string }> = [];
  for (const run of runs) {
    const from = shiftLocalDate(run.from, -1); const to = shiftLocalDate(run.to, 1);
    const last = periods.at(-1);
    if (last !== undefined && from <= shiftLocalDate(last.to, 1)) { if (to > last.to) last.to = to; continue; }
    periods.push({ from, to });
  }
  // O04（WP-20）：最早触及时刻一并回传 —— 它是恢复（canonical 夜）维的脏下界贡献，
  // 直接取 instants 的 min（UTC 毫秒）转 ISO，不经本地日期往返（无时区再解释风险）。
  return {
    // 总跨度 = 首时期的 from … 末时期的 to：与旧的 `[min-1, max+1]` 恒等（见函数头注释）。
    from: periods[0]!.from,
    to: periods.at(-1)!.to,
    periods,
    earliestInstant: new Date(Math.min(...instants)).toISOString()
  };
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

/**
 * 身份状态的**三态**（S3.2 / D3）：空库就地初始化 vs 代际不符 vs 现状。
 *
 * 为什么需要三态：收口前"空库"走候选链路（首包 = 整库备份 + CLI 全量导入），而
 * **全新部署**（首次同步）本来就走那条路径 —— 收口后若把"空库"也判成不合格，
 * 首包会硬失败（同步停摆，且没有任何路径能初始化它）。
 *
 * 判据：
 *   - `eligible`：四要素齐备且与当前构建一致（现状路径）；
 *   - `bootstrap`：四要素**全缺**（从未有完成过的导入）⇒ 允许首包**就地初始化**
 *     （解析器会写 contract/algorithm、接收器写 dataset_version/import_completed_at ——
 *     四要素在一批之内齐备；`preserveAbsent` 恒 true，墓碑/缺席删除不进这条路径）；
 *   - `baseline_rebuild`：**有身份痕迹**但代际不符或部分缺失 —— 数据在、代际变了，
 *     混用两代身份有风险，必须由运维显式处置（CLI 全量重建 / 回退服务端版本），
 *     不是客户端能自动修的。
 */
export function classifyIdentityEligibility(state: Map<string, string>): "eligible" | "bootstrap" | "baseline_rebuild" {
  if (eligibleIdentity(state)) return "eligible";
  const anyTrace = state.get("dataset_version") || state.get("import_completed_at")
    || state.get("parser_contract_version") || state.get("parser_identity_algorithm");
  return anyTrace ? "baseline_rebuild" : "bootstrap";
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

/**
 * O04（WP-20）：直连车道的脏范围**输入装配**（账本 JOIN 视图 + 全表训练）。
 *
 * 与旧 `dirtyFromAt()`（只取账本时刻 min，删除）的差异：这里把每条账本行规范化成
 * "新旧两侧的完整区间视图"（新行 = 对当前表的 JOIN；旧行 = 账本 v37 `previous_*` 列）
 * 并附上 route 变更的合成条目 —— 纯函数 `planIncrementalAnalysisDirtyRange` 据此
 * 做区间并集与**相交训练回退**（记录时间更正不再错复用旧特征）。
 */
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
 * 执行一批直连接收。
 *
 * 返回值是判别联合：成功 = `DirectSyncImportResult`；拒收 = `DirectSyncRejection`
 * （带稳定机器码，拒绝之前调用方事务已经整体回滚 —— 永远不是"收了一半"）。
 * 调用方用 `isDirectSyncRejection` 判别（**不要**用 `instanceof`：本对象跨 worker
 * 线程边界，原型链会被结构化克隆剥掉）。
 */
export async function applyDirectSyncImport(input: DirectSyncImportInput): Promise<DirectSyncImportResult | DirectSyncRejection> {
  assertDirectSyncRequestShape(input);
  if (!existsSync(input.databasePath)) {
    return rejectDirect("database_not_found", "read", { detail: "主库文件不存在" });
  }
  if (!/^[a-f0-9]{64}$/.test(input.payloadSha256)) {
    return rejectDirect("payload_identity_invalid", "read", { detail: "payloadSha256 不是 64 位十六进制" });
  }
  // 输入目录的存在性与结构由 `preparePayload` → `preflightDirectSyncPayload` 统一判定
  // （单一来源；原先这里有一次**只读不用**的 `readdirSync`，对缺失目录会抛 ENOENT ⇒ 500）。
  const prepared = await preparePayload(input);
  if (!prepared.ok) return prepared.rejection;
  const payload = prepared.payload;
  const probe = RaiDatabase.openReadonly(input.databasePath);
  try {
    const eligibility = classifyIdentityEligibility(identityState(probe));
    if (eligibility === "baseline_rebuild") {
      // S3.2/D3：**有身份痕迹**但与当前契约/身份算法代际不符 —— 运维显式处置，
      // 客户端不能自动修（混用两代身份有风险）。`bootstrap`（四项全缺）从下面放行。
      return rejectDirect("baseline_rebuild_required", "identity",
        { detail: "主库有身份痕迹但与当前契约/身份算法不符；需运维全量重建（CLI）或回退服务端版本" });
    }
    if (RaiDatabase.pendingMigrations(input.databasePath).length) {
      return rejectDirect("pending_migrations", "identity", { detail: "主库有待应用的迁移" });
    }
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
    const eligibility = classifyIdentityEligibility(state);
    if (eligibility === "baseline_rebuild") {
      throw new DirectSyncIngestRejected(rejectDirect("baseline_rebuild_required", "transaction",
        { detail: "identity state changed before BEGIN（代际不符）" }));
    }
    // S3.2/D3：`bootstrap`（空库首包）没有前驱 dataset_version —— 用固定引导符。
    // 它是"这份库由谁生出来的"链条第一环，必须是**稳定**字面量（同一载荷重放要得出同一版本号）。
    const previousVersion = state.get("dataset_version") ?? "bootstrap";
    if (db.prepare("SELECT 1 FROM import_batches WHERE id=?").get(input.jobId)) {
      throw new DirectSyncIngestRejected(rejectDirect("batch_without_receipt", "transaction",
        { detail: "existing batch has no completed receipt" }));
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

    // 恢复事实的**局部**重建（PR4 步骤 4）：只重建本批真正碰到的**夜**。
    // 窗口外的 canonical 行必须逐字节不变 —— 这是 `canonicalizeNightsForWindow` 的绝对担保，
    // 也是 §14.1「全表 canonical 删除/重建」在直连车道上仍为 0 的判据。
    //
    // O10（WP-31）步骤 4：`nightWindow` 现在返回**互不相邻的多个时期**（本批同时更正相隔多日的
    // 两夜时，中间那些夜不该被碰）。逐时期各跑一次窗口重建并相加计数 —— 时期已归并（不重叠、
    // 不相接），所以既不会重复计数，也不会重复重建同一天；跨时期也不存在"窗口外被改"，
    // 因为每次调用的 DELETE 与到达时间快照都限制在它自己的 `[from, to]` 内。
    const nightRange = nightWindow(db, input.jobId, payload.manifest);
    const canonicalNights = nightRange === null ? null : nightRange.periods.reduce(
      (totals, period) => {
        const counts = canonicalizeNightsForWindow(db, DATABASE_TIMEZONE, period.from, period.to,
          { callerOwnedTransaction: true });
        return {
          mainCount: totals.mainCount + counts.mainCount,
          napCount: totals.napCount + counts.napCount,
          hrvCount: totals.hrvCount + counts.hrvCount
        };
      },
      { mainCount: 0, napCount: 0, hrvCount: 0 }
    );

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
      // O04（WP-20）：脏范围 = 账本区间并集 + **相交训练回退** + 路线变更 + 恢复边界。
      // `full` 或边界未知 ⇒ 不写 `incrementalPlan`（分析侧全量重算；安全档）。
      // WP-22：装配实现下沉到 `@rai/health-export-parser`，与消费端（输入读取器）共用同一份 ——
      // 登记端按"本批"装配，消费端按"未覆盖的若干批"装配，口径必须只有一个。
      const dirtyRange = planIncrementalAnalysisDirtyRange(loadDirtyRangeInput(
        db, [input.jobId], routeDirtyTimes,
        nightRange === null ? [] : [nightRange.earliestInstant]
      ));
      const dirty = dirtyRange.full ? null : dirtyRange.dirtyFromAt;
      analysisJobId = new RecomputeJobRepository(db).enqueue(
        "import", datasetVersion,
        {
          mode: DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
          importBatchId: input.jobId,
          evaluatedAt: now,
          timezoneIdentifier: DATABASE_TIMEZONE,
          ...(dirty === null ? {} : {
            incrementalPlan: { mode: "partial" as const, dirtyFromAt: dirty, domains: dirtyRange.domains }
          })
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
      // 口径（2026-10-15，P3-e）：该字段 = 从库读的**会话总数**（历史语义、对外回执字段，勿按
      // "本批未变化数"解读）。no-op 路径下它恰好等于"未变更数"——那是该场景的事实
      // （`import-worker.ts` 的 PayloadPreflight 注释），不是本字段的定义。表为百行级，
      // 此 COUNT 不进热路径（10-15 库量快照：workouts 287）。
      unchangedWorkouts: Number(db.prepare("SELECT COUNT(*) AS n FROM training_sessions").get()!.n),
      routesUpdated: routes.importedRouteCount,
      featuresReused: 0, featuresRecomputed: 0, modelReplayFrom: null,
      durationMs: Date.now() - input.startedAtMs, backupName: null,
      // 🔴 canonical 的**模式必须落进持久化产物**（§14.1 的"还要记录 SQL、任务阶段和文件操作"）。
      // `"full"` 在直连车道上永远不该出现：那条路径是整表删除+重建，禁止操作清单里点名的就是它。
      canonicalNights: canonicalNights === null
        ? { mode: "none" as const }
        : {
            mode: "window" as const, from: nightRange!.from, to: nightRange!.to,
            mainCount: canonicalNights.mainCount, napCount: canonicalNights.napCount,
            hrvCount: canonicalNights.hrvCount
          },
      directSync: {
        ingestStatus: "committed",
        // 🔴 本批需要分析时这里必须是 `queued`：任务**已经在同一个事务里**登记完了。
        // 写 `published` 会是假话（分析还没跑），写 `not_required` 更是（§9.1）。
        analysisStatus: analysisRequired ? "queued" : "not_required",
        receiptId: input.jobId,
        dependencyGeneration: String(generations.dependency),
        publishedReleaseId: null,
        parentBatchId: null
      },
      // 🔴 回执里放**分析任务 id**（`null` = 本批不登记分析）。它不是"分析状态"的更新通道
      // —— 回执仍然是**写入时刻的凭证**，本字段写进去之后一辈子不变（§8.5：消费者不得改写它）。
      // 它存在的唯一理由是：`analysisStatus` 是 COMMIT 快照（上面恒为 `queued`），而分析跑完之后
      // 只有 `GET /v1/jobs/:id` 知道终态。没有这个 id，客户端**没有任何办法**问到那一批分析的结果，
      // 于是 §10.3 的「分析已更新」/「…分析更新失败，可重试分析」在真机上永远不可达。
      // 与 `import_batches.summary_json.analysisJobId` 是**同一个值**（下面 batchSummary 用它）：
      // 批次账本与用户可见回执必须同源，否则"回执说 queued、账本指向另一个任务"没人能发现。
      analysisJobId
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
    // WP-22（v39）：批次**自己**声明它把两个计数器推到了哪里、以及有没有推依赖代次。
    // 没有这三列，"raw-only 批次"只能靠推理猜；有了它，发布判据才能靠证据判
    // （证明"候选之后进来的批次都没动过分析输入"）。
    db.prepare(`UPDATE import_batches SET xml_sha256=?, status='succeeded',
      dataset_version=?, summary_json=?, completed_at=?,
      raw_generation=?, dependency_generation=?, dependency_bumped=? WHERE id=?`)
      .run(xmlSha256, datasetVersion, batchSummary, now,
        Number(generations.raw), Number(generations.dependency), analysisRequired ? 1 : 0,
        input.jobId);
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
    // WP-22（v39）回读断言：批次必须真的声明了它把两个计数器推到了哪里。
    // 这条与 receipt 断言**并列**而不是合并：回执说的是"写完了"，这里说的是
    // "发布判据将来读到的代次足迹确实是这一批的" —— 两者可以各自独立地坏。
    const batchBinding = db.prepare(`SELECT status, raw_generation AS raw,
      dependency_generation AS dependency, dependency_bumped AS bumped
      FROM import_batches WHERE id=?`).get(input.jobId) as
      { status: string; raw: number | null; dependency: number | null; bumped: number | null } | undefined;
    if (!batchBinding || batchBinding.status !== "succeeded"
        || Number(batchBinding.raw) !== Number(generations.raw)
        || Number(batchBinding.dependency) !== Number(generations.dependency)
        || Number(batchBinding.bumped) !== (analysisRequired ? 1 : 0)) {
      throw new Error("Direct sync batch generation binding failed its pre-commit assertion");
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
    if (error instanceof DirectSyncIngestRejected) return error.rejection;
    // 解析器（`parseAppleHealthXml`）内部也抛这个类型：缺基线、批次代次不齐等。
    if (error instanceof RecordDeltaNotEligibleError) {
      return rejectDirect("identity_not_eligible", "transaction", { detail: error.message });
    }
    // 写守卫触发 = **编程错误**（接收事务里出现了不该出现的表）。观测版仍按既有语义回退候选，
    // 但把 detail 带出来；收口版（阶段 3）会把这条改成 500 内部完整性错误、不再回退。
    if (error instanceof Error && error.message.includes(DIRECT_SYNC_WRITE_GUARD)) {
      return rejectDirect("write_guard_triggered", "transaction", { detail: error.message.slice(0, 300) });
    }
    throw error;
  } finally {
    store.close();
  }
}

function hashOf(previousVersion: string, payloadSha256: string): string {
  return createHash("sha256").update(previousVersion).update("\0").update(payloadSha256).digest("hex").slice(0, 32);
}
