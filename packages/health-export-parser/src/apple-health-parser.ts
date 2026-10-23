import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

import type {
  CanonicalHealthRecord,
  CanonicalRouteReference,
  CanonicalWorkout,
  CanonicalWorkoutEvent,
  CanonicalWorkoutStatistic,
  MetadataMap
} from "@rai/contracts";
import { CONTRACT_VERSION } from "@rai/contracts";
import { SaxesParser, type SaxesTagPlain } from "saxes";

import { RaiDatabase, SEED_CONTENT_HASH } from "./database.js";
import { isCanonicalInstant } from "./dirty-range.js";
import { evaluateRemovalGuard, ImportRemovalGuardError } from "./import-guard.js";
import { prepareNative, type NativeOptions } from "./native-worker.js";
import { NativeRecordWriter } from "./native-record-writer.js";
import { validSampleUUID, type HealthKitRecordDeletion } from "./sync-manifest.js";
import { identityAlgorithmFingerprint } from "./identity-algorithm.js";
import { isDataOnlyRecordXml, RecordDeltaNotEligibleError } from "./record-delta-policy.js";
import {
  addMetadata,
  classifySource,
  durationToSeconds,
  lastMetadataValue,
  metadataBoolean,
  normalizeAppleDate,
  normalizeRelativePath,
  parseFiniteNumber,
  stableId
} from "./utils.js";

/**
 * B2 (runtime invariant, see docs/RUST_DATA_ENGINE.md): the record generation table
 * must not claim more rows than the worker itself reported writing.
 *
 * Deliberately an inequality. `apply_records` writes the current generation for every
 * non-tombstoned row it reads, but `import_entity_generations` is keyed by
 * `(entity_kind, entity_id)`, so a canonical payload that carries the same record id
 * twice legitimately yields fewer rows than `observed - tombstoned`. An equality check
 * would fire on real exports; "more rows than were written" cannot happen by accident.
 *
 * Reported as an issue rather than thrown: issues are the importer's triage channel
 * (`GET /v1/data-summary`), so this stays visible in production without failing an
 * otherwise usable import.
 */
function assertGenerationConservation(
  store: RaiDatabase,
  generation: string,
  written: { observed: number; tombstoned: number; inserted: number }
): void {
  const reported = written.observed - written.tombstoned;
  const row = store.database.prepare(
    "SELECT COUNT(*) AS n FROM import_entity_generations WHERE entity_kind = 'record' AND generation = ?"
  ).get(generation) as { n: number };
  if (row.n > reported) {
    store.insertIssue({
      severity: "error",
      code: "invariant.b2.generation_overcount",
      objectId: null,
      message: `record generation ${generation} holds ${row.n} rows but the worker reported writing `
        + `${reported} (observed=${written.observed}, tombstoned=${written.tombstoned})`
    });
  }
  if (written.inserted > written.observed || written.tombstoned > written.observed) {
    store.insertIssue({
      severity: "error",
      code: "invariant.b2.counter_bounds",
      objectId: null,
      message: `record counters exceed observed rows: inserted=${written.inserted} `
        + `tombstoned=${written.tombstoned} observed=${written.observed}`
    });
  }
}

interface RecordDraft {
  attributes: Record<string, string>;
  metadata: MetadataMap;
}

/**
 * P1-2（2026-10-18）：**未变记录轻路径**的判定（纯函数，单测入口）。
 *
 * ## 它回答什么
 *
 * "这条记录的内容摘要与库里已接受的完全相同、且没有任何墓碑 ⇒ 本批对它无事可做"。
 * 是则解析器跳过 `observeImportEntity` 的 UPSERT、`saveHealthKitRecordFact`、提交前回读
 * 断言与全部 JSON 序列化，只累计计数/清单。
 *
 * ## 为什么每一条前置条件都不能省
 *
 * - `preserveAbsentIncremental`：完整快照（非 preserve-absent）必须**逐行重写**，而且它的
 *   删除判定读的就是代次（`finalizeImportGeneration`）——跳过代次更新会被误判成删除。
 * - `!recordDelta`：直连 record-delta 车道自带事实/账本提交前断言与身份副作用（`deltaIdentities`、
 *   profile 增量），轻路径把那些断言一并跳掉；那条车道也不吃这份固定底（它本来就是有界的）。
 * - `hasSampleUuid`：`healthkit_record_facts` 以 `(type, uuid)` 为键；无 UUID 的记录没有可比摘要。
 * - `hasIdentityMapping`：`healthkit_record_sources` 没有映射 = 身份还没建立（新样本/旧库），
 *   跳过身份解析会把它留在"无映射"状态 ⇒ 必须走完整路径。
 * - `existingContentHash !== null && !== SEED_CONTENT_HASH`：`SEED_CONTENT_HASH` 是"只知其身份、
 *   不知其内容"的哨兵（v31 回填与冷启动种子），拿哨兵比内容永远不该相等，也不该被当成命中。
 * - 两个墓碑都为假：被删来源/被删实体必须走完整路径 —— 计数（`tombstonedCount`）、
 *   `carriedDeletedSources` 与"删除不因重传复活"的判定都在那里。
 *
 * 账本语义：完整路径在"未变"时同样**不写** `import_entity_changes`（`observeImportEntity` 只在
 * `!exists || updated` 时写），也不写 `health_records`；轻路径与它的产出因此逐项相同
 * （`inserted`/`updated`/`removed` 全为 0），差别只是省掉了写入与断言。
 */
export interface UnchangedRecordFastPathInput {
  preserveAbsentIncremental: boolean;
  recordDelta: boolean;
  hasSampleUuid: boolean;
  hasIdentityMapping: boolean;
  existingContentHash: string | null;
  contentHash: string;
  sourceDeleted: boolean;
  entityTombstoned: boolean;
}

export function isUnchangedRecordForIncrementalImport(input: UnchangedRecordFastPathInput): boolean {
  return input.preserveAbsentIncremental
    && !input.recordDelta
    && input.hasSampleUuid
    && input.hasIdentityMapping
    && input.existingContentHash !== null
    && input.existingContentHash !== SEED_CONTENT_HASH
    && input.existingContentHash === input.contentHash
    && !input.sourceDeleted
    && !input.entityTombstoned;
}

interface RouteDraft {
  attributes: Record<string, string>;
  metadata: MetadataMap;
  relativePath: string | null;
}

interface WorkoutDraft {
  attributes: Record<string, string>;
  metadata: MetadataMap;
  statistics: CanonicalWorkoutStatistic[];
  events: CanonicalWorkoutEvent[];
  routes: RouteDraft[];
}

interface InventoryItem {
  count: number;
  firstAt: string | null;
  lastAt: string | null;
  units: Set<string>;
  sourceCategories: Set<string>;
}

export interface AppleHealthParseResult {
  recordCount: number;
  workoutCount: number;
  activitySummaryCount: number;
  issueCount: number;
  insertedRecordCount?: number;
  insertedWorkoutCount?: number;
  removedRecordCount?: number;
  removedWorkoutCount?: number;
  /**
   * 旧值被"值更正"取代掉的 legacy 记录数（仅 `preserveAbsent` 增量车道，
   * 见 `RaiDatabase.supersedeLegacyRecordCorrections`）。也计入 `removedRecordCount`。
   */
  supersededRecordCount?: number;
  /** 被取代旧行的 `start_at`：调用方据此把删除窗口并入脏范围下界。 */
  supersededRecordTimes?: string[];
  /** Entities the payload carried but that stayed deleted via a tombstone. */
  tombstonedCount?: number;
  /**
   * P1-2（2026-10-18）：未变记录的**轻路径**命中数（内容摘要与既有 fact 相同、无墓碑 ⇒
   * 不写行/不写 facts/不 UPSERT 代次，只计数）。同一份载荷重复导入时它 = 记录总数。
   * 计入 `recordCount`，**不计入** `insertedRecordCount`。
   */
  unchangedRecordCount?: number;
  dirtyWorkoutTimes?: string[];
}

export interface ParseProgress {
  bytesRead: number;
  totalBytes: number;
  recordCount: number;
  workoutCount: number;
}

/**
 * One explicit `<WorkoutRoute>` declaration, normalized exactly like the
 * stored `workout_routes.relative_path`, including declarations whose ownership
 * is unchanged. The direct-sync receiver uses the complete declaration set to
 * reject a batch that assigns one path to two different parents regardless of
 * XML order; the write-time observer alone cannot see an unchanged declaration.
 */
export interface ExplicitRouteDeclaration {
  workoutId: string;
  relativePath: string;
  /** True when the parent workout is tombstoned/deleted by this batch. */
  tombstoned: boolean;
}

export interface AppleHealthParseOptions {
  fileSize: number;
  native?: NativeOptions;
  onProgress?: (progress: ParseProgress) => void;
  incremental?: {
    generation: string;
    batchId?: string;
    preserveAbsent?: boolean;
    /**
     * When `preserveAbsent` is false the payload is asserted to be a complete
     * snapshot. Set this to false only to bypass the removal guard that refuses
     * to delete a large share of the database on a partial payload.
     */
    guardAbsentRemoval?: boolean;
  };
  atomic?: boolean;
  /**
   * 解析器进入**调用方持有**的写事务（PR4 步骤 2b，见 `docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md` §2.2）。
   *
   * 语义（每一条都有对应断言，不是约定）：
   * - 要求的 store 是 `RaiDatabase.open(..., { transactionOwner: "caller" })`，且调用方已经
   *   `beginCallerTransaction()`；解析器**不** `BEGIN`、**不** `COMMIT`、**不** `ROLLBACK`。
   * - 本批边界用 `store.savepoint(...)` / `releaseSavepoint` 表达，**不产生新的提交点**：
   *   解析失败只撤掉自己那一段，调用方可以继续做完别的事再决定提交或回滚。
   * - 解析器也不调用 `flush()` / `rollback()` —— caller 模式下它们会抛错（对外保证：
   *   组件不得自提交），而失败路径上的抛错会**把真因换掉**。
   *
   * 🔴 与 `recordDelta` **互斥**：后者自带"parser 持有 BEGIN/COMMIT"的语义与 record-only 资格判定，
   * 两个一起传就是两种事务所有权同时成立。冲突直接抛错，而不是让其中一方静默生效。
   * 🔴 与 `atomic: false` 同样互斥：那个值的意思是"按对象数自行 flush 提交"，与"提交权归调用方"相反。
   */
  callerOwnedTransaction?: boolean;
  /** Explicit HealthKit deletion events. Absence never implies deletion. */
  deletedWorkoutIds?: readonly string[];
  deletedRecords?: readonly HealthKitRecordDeletion[];
  healthKitRecordIdentity?: boolean;
  /**
   * Called once for every explicit `WorkoutRoute` with a `FileReference` path,
   * after the parent workout identity is known and before that workout is
   * inserted. Callers must only collect in memory.
   */
  onRouteDeclaration?: (declaration: ExplicitRouteDeclaration) => void;
  /**
   * v46 / P2-2：本批记录写入 `health_records.available_at` 的值（**到达服务端的时刻**，
   * ISO 规范时刻）。省略时取解析**开始时刻**（`new Date().toISOString()`）。
   *
   * 传它的两个实际用途：①测试确定性（同一份 XML 两次导入得到可断言的可得时间）；
   * ②接收端若已知"这批到达"的权威时刻（上传完成时刻），可以写它而不是解析时的钟。
   * 更新行会**刷新**该值；内容未变的重复到达走轻路径，不重写行，因此不污染首次可得时间。
   */
  availableAt?: string;
  /** Narrow live-DB transaction path. The parser owns BEGIN/COMMIT; callbacks
   * must only use this connection and cannot commit or flush independently. */
  recordDelta?: {
    xmlText: string;
    onBegin(): void;
    beforeCommit(result: AppleHealthParseResult, xmlSha256: string): void;
  };
}

/** `callerOwnedTransaction` 用的 SAVEPOINT 名。名字固定且唯一：泄漏时提交会被拒（`commitCallerTransaction` 会点名它）。 */
export const CALLER_OWNED_PARSE_SAVEPOINT = "rai_parse_batch";

function attributesOf(tag: SaxesTagPlain): Record<string, string> {
  return Object.fromEntries(Object.entries(tag.attributes).map(([key, value]) => [key, String(value)]));
}

function localName(name: string): string {
  return name.includes(":") ? (name.split(":").at(-1) ?? name) : name;
}

function updateInventory(
  inventory: Map<string, InventoryItem>,
  type: string,
  startAt: string | null,
  unit: string | null,
  sourceCategory: string
): void {
  const item = inventory.get(type) ?? {
    count: 0,
    firstAt: null,
    lastAt: null,
    units: new Set<string>(),
    sourceCategories: new Set<string>()
  };
  item.count += 1;
  if (startAt) {
    item.firstAt = item.firstAt === null || startAt < item.firstAt ? startAt : item.firstAt;
    item.lastAt = item.lastAt === null || startAt > item.lastAt ? startAt : item.lastAt;
  }
  if (unit) item.units.add(unit);
  item.sourceCategories.add(sourceCategory);
  inventory.set(type, item);
}

function buildRecord(draft: RecordDraft): CanonicalHealthRecord | null {
  const attributes = draft.attributes;
  const type = attributes.type;
  const sourceName = attributes.sourceName ?? "unknown";
  const startAt = normalizeAppleDate(attributes.startDate);
  const endAt = normalizeAppleDate(attributes.endDate);
  if (!type || !startAt || !endAt) return null;

  const numericValue = parseFiniteNumber(attributes.value);
  const syncIdentifier = lastMetadataValue(
    draft.metadata,
    "HKMetadataKeySyncIdentifier"
  );
  // Device is metadata, not identity: Apple Health can export the same sample
  // once with a device attribute and once without it.
  const id = syncIdentifier
    ? stableId("record", [type, sourceName, syncIdentifier])
    : stableId("record", [
        type,
        sourceName,
        startAt,
        endAt,
        attributes.value ?? null,
        attributes.unit ?? null
      ]);

  return {
    id,
    type,
    sourceName,
    sourceVersion: attributes.sourceVersion ?? null,
    device: attributes.device ?? null,
    unit: attributes.unit ?? null,
    numericValue,
    textValue: numericValue === null ? (attributes.value ?? null) : null,
    startAt,
    endAt,
    createdAt: normalizeAppleDate(attributes.creationDate),
    metadata: draft.metadata
  };
}

/** Only used by the live transaction path. A trigger that silently ignores or
 * rewrites a write must fail before the receipt/COMMIT, not report acceptance. */
function assertRecordDeltaFact(
  store: RaiDatabase, expected: CanonicalHealthRecord, category: string, attributes: Record<string, string>
): void {
  const row = store.database.prepare(`SELECT id,type,source_name AS sourceName,source_version AS sourceVersion,
    device,unit,value_numeric AS numericValue,value_text AS textValue,start_at AS startAt,end_at AS endAt,
    created_at AS createdAt,metadata_json AS metadata,source_category AS category,raw_attributes_json AS attributes
    FROM health_records WHERE id=?`).get(expected.id);
  if (!row) throw new Error("Record delta fact failed its pre-commit assertion");
  const { category: actualCategory, attributes: actualAttributes, ...actual } = row;
  actual.metadata = JSON.parse(String(actual.metadata));
  if (actualCategory !== category ||
      stableId("fact", [actual]) !== stableId("fact", [expected]) ||
      stableId("attributes", [JSON.parse(String(actualAttributes))]) !== stableId("attributes", [attributes])) {
    throw new Error("Record delta fact failed its pre-commit assertion");
  }
}

function buildWorkout(draft: WorkoutDraft): CanonicalWorkout | null {
  const attributes = draft.attributes;
  const activityType = attributes.workoutActivityType;
  const sourceName = attributes.sourceName ?? "unknown";
  const startAt = normalizeAppleDate(attributes.startDate);
  const endAt = normalizeAppleDate(attributes.endDate);
  if (!activityType || !startAt || !endAt) return null;

  const durationSeconds =
    durationToSeconds(attributes.duration, attributes.durationUnit) ??
    Math.max(0, (Date.parse(endAt) - Date.parse(startAt)) / 1000);
  const syncIdentifier = lastMetadataValue(
    draft.metadata,
    "HKMetadataKeySyncIdentifier"
  );
  // Identity fields only (PARSER_DESIGN §4.4). Statistics/events/routes and duration
  // belong in the content hash so duration corrections keep the same workout id.
  const id = syncIdentifier
    ? stableId("workout", [activityType, sourceName, syncIdentifier])
    : stableId("workout", [
        activityType,
        sourceName,
        startAt,
        endAt,
        attributes.device ?? null
      ]);

  const routes: CanonicalRouteReference[] = draft.routes.map((route) => ({
    id: stableId("route", [id, route.relativePath ?? route.attributes.startDate ?? "route"]),
    sourceName: route.attributes.sourceName ?? null,
    sourceVersion: route.attributes.sourceVersion ?? null,
    startAt: normalizeAppleDate(route.attributes.startDate),
    endAt: normalizeAppleDate(route.attributes.endDate),
    createdAt: normalizeAppleDate(route.attributes.creationDate),
    relativePath: route.relativePath,
    metadata: route.metadata
  }));

  return {
    id,
    activityType,
    sourceName,
    sourceVersion: attributes.sourceVersion ?? null,
    device: attributes.device ?? null,
    startAt,
    endAt,
    createdAt: normalizeAppleDate(attributes.creationDate),
    durationSeconds,
    indoor: metadataBoolean(draft.metadata, "HKIndoorWorkout"),
    metadata: draft.metadata,
    statistics: draft.statistics,
    events: draft.events,
    routes
  };
}

export async function parseAppleHealthXml(
  xmlPath: string,
  store: RaiDatabase,
  options: AppleHealthParseOptions
): Promise<AppleHealthParseResult> {
  // 🔴 事务所有权是**一次性判定**：两种所有权同时成立时直接抛错，
  // 而不是让其中一方静默生效（那会造出"以为调用方持有、其实解析器提交了"的批次）。
  const callerOwned = options.callerOwnedTransaction === true;
  if (callerOwned && options.recordDelta) {
    throw new Error(
      "callerOwnedTransaction and recordDelta are mutually exclusive: the record-delta lane " +
      "owns BEGIN/COMMIT itself, while callerOwnedTransaction hands ownership to the caller"
    );
  }
  if (callerOwned && options.atomic === false) {
    throw new Error(
      'callerOwnedTransaction requires the default atomic mode: atomic: false means "commit every ' +
      'N objects", which contradicts "the caller owns the only commit point"'
    );
  }
  // The native worker writes only a disposable spool before the import transaction starts.
  if (options.recordDelta && (options.atomic === false || !options.healthKitRecordIdentity
      || !options.incremental?.preserveAbsent || !isDataOnlyRecordXml(options.recordDelta.xmlText))) {
    throw new RecordDeltaNotEligibleError("not a bounded preserve-absent v2 record-only batch");
  }
  const native = options.recordDelta ? null : await prepareNative("health", xmlPath, options.native ?? {});
  const deletedWorkoutIdSet = new Set(options.deletedWorkoutIds ?? []);
  // v46 / P2-2：本批的**到达服务端时刻**（`health_records.available_at`）。
  // 显式 option 优先（测试确定性 / 接收端已知上传完成时刻），否则取解析开始时刻。
  // 在**任何写入之前**校验：坏值不能落进 available_at —— 那列是"何时可得"的唯一证据，
  // 写脏了就无法与事件时间区分（DATA_PIPELINE §3）。
  const availableAt = options.availableAt ?? new Date().toISOString();
  if (!isCanonicalInstant(availableAt)) {
    throw new Error("availableAt must be a canonical ISO instant (e.g. 2026-10-18T12:34:56.000Z)");
  }
  // 调用方持有模式下，本批边界是一个 SAVEPOINT（不产生提交点）。
  // 失败路径**只**撤这一段，调用方仍可继续做完别的事再决定提交或整体回滚。
  let callerSavepointOpen = false;
  const abandonCallerSavepoint = (): void => {
    if (!callerSavepointOpen) return;
    callerSavepointOpen = false;
    try {
      store.rollbackSavepoint(CALLER_OWNED_PARSE_SAVEPOINT);
    } catch {
      // 🔴 收尾失败**不得**换掉真因（F4 的教训：`catch` 里的 rollback 抛错会让调用方
      // 只看到收尾错误）。泄漏的 savepoint 也不构成静默提交风险 ——
      // 调用方的 `commitCallerTransaction()` 会因为栈非空而**拒绝提交**并点名它。
    }
  };
  let nativeRecords: NativeRecordWriter | undefined;
  try {
  const atomic = options.atomic !== false;
  if (callerOwned) {
    store.savepoint(CALLER_OWNED_PARSE_SAVEPOINT);
    callerSavepointOpen = true;
  } else if (atomic) store.beginAtomicImport();
  options.recordDelta?.onBegin();
  const entityGeneration = options.incremental?.generation ?? "full-import";
  const hasRecordAliases = store.hasHealthKitRecordAliases();
  if (native && !options.healthKitRecordIdentity && !hasRecordAliases
    && options.atomic === false && options.native?.stagingDatabase) {
    nativeRecords = new NativeRecordWriter(native.directory, entityGeneration, options.incremental?.batchId, Boolean(options.incremental));
  }
  // 🔴 补种与删除判定必须由**同一个**判据驱动。
  // 它们原本分成两处各写一份条件：补种看 `!recordDelta`，删除判定看 `!preserveAbsent`。
  // 今天两者恰好等价，但"两处独立条件"意味着只改一处就能造出两种坏法：
  //   · 补种了却不判删除 ⇒ 每次增量白做一次整库 `INSERT OR IGNORE ... SELECT`
  //     （文档 §1.1 明确要取消的阶段）；
  //   · 判删除却没补种 ⇒ 上一批盖的代次全部相对本批"陈旧" ⇒ **误判整库删除**。
  // 所以三处（补种 / 删除闸门 / finalize）都从这一个判据取值。
  //
  // 🔴 但"问题清单的重建"**不是**这三处之一：它与代次无关，只与"这是一次导入"有关。
  // 它原先藏在 `seedImportGenerations` 里（那个方法无条件 `DELETE FROM import_issues`），
  // 一旦"增量不补种"，它就被静默丢掉了 ⇒ `import_issues` 跨批累积（见下面的 `else` 分支）。
  const incremental = options.incremental;
  const removalDetection = Boolean(incremental && !incremental.preserveAbsent);
  // 直连（recordDelta）恒为增量载荷，结构上不可能触达删除判定。上面的资格检查已经强制
  // `preserveAbsent`，这里再断言一次：将来谁放宽了那条资格检查，会立刻在这里红，
  // 而不是悄悄变成误判整库删除。抛的仍是不合格错误 —— 调用方按"不算本车道"处理（回退旧链路）。
  if (options.recordDelta && removalDetection) {
    throw new RecordDeltaNotEligibleError("direct delta lane must not enable absence-as-deletion");
  }
  if (removalDetection && incremental) {
    store.seedImportGenerations(incremental.generation);
  } else if (incremental && !options.recordDelta) {
    // preserve-absent 增量（旧链路的 `incremental-import`）**不补种**：那是整库
    // `INSERT OR IGNORE ... SELECT`，而 `finalizeImportGeneration` 在这条路径上直接早退、
    // 根本不读代次，所以它是无用功（设计 §2.3 / §1.1）。
    // 但"本批问题清单"仍必须按批重建 —— 它先前是 `seedImportGenerations` 的**副产品**，
    // 不补种就丢了它。补种与清问题清单是**两件独立的事**，各自都要显式调用。
    // ⚠️ `!options.recordDelta` 是必须的：直连车道不做整库重建，主库既有问题不归它管。
    store.clearImportIssues();
  }
  store.markHealthKitRecordDeletions(options.deletedRecords ?? [], options.incremental?.batchId);
  let currentRecord: RecordDraft | null = null;
  let currentWorkout: WorkoutDraft | null = null;
  let currentWorkoutEvent: CanonicalWorkoutEvent | null = null;
  let currentRoute: RouteDraft | null = null;
  let recordCount = 0;
  let workoutCount = 0;
  let activitySummaryCount = 0;
  let issueCount = 0;
  let insertedRecordCount = 0;
  let insertedWorkoutCount = 0;
  /** P1-2：未变记录轻路径命中数（见 `isUnchangedRecordForIncrementalImport`）。 */
  let unchangedRecordCount = 0;
  // Entities the payload still carries but that a tombstone keeps deleted.
  let tombstonedCount = 0;
  const insertedWorkoutTimes: string[] = [];
  let bytesRead = 0;
  let lastProgressAt = 0;
  const recordInventory = new Map<string, InventoryItem>();
  const workoutInventory = new Map<string, InventoryItem>();
  const sourceHash = createHash("sha256");
  const carriedDeletedSources: HealthKitRecordDeletion[] = [];
  const deltaIdentities = new Map<string, { type: string; uuid: string; id: string; aliases: Set<string> }>();

  const parser = new SaxesParser({ xmlns: false });

  const openTag = (tag: { name: string; attributes: Record<string, string> }) => {
    const name = localName(tag.name);
    const attributes = tag.attributes;

    switch (name) {
      case "Me":
        if (options.incremental?.preserveAbsent) {
          store.setProfile(attributes, { merge: true });
        } else {
          store.setProfile(attributes);
        }
        break;
      case "ExportDate":
        if (attributes.value) store.setManifest("health_export_date", attributes.value);
        break;
      case "Record":
        currentRecord = { attributes, metadata: {} };
        break;
      case "Workout":
        currentWorkout = {
          attributes,
          metadata: {},
          statistics: [],
          events: [],
          routes: []
        };
        break;
      case "WorkoutStatistics":
        if (currentWorkout) {
          currentWorkout.statistics.push({
            type: attributes.type ?? "unknown",
            startAt: normalizeAppleDate(attributes.startDate),
            endAt: normalizeAppleDate(attributes.endDate),
            unit: attributes.unit ?? null,
            sum: parseFiniteNumber(attributes.sum),
            average: parseFiniteNumber(attributes.average),
            minimum: parseFiniteNumber(attributes.minimum),
            maximum: parseFiniteNumber(attributes.maximum)
          });
        }
        break;
      case "WorkoutEvent":
        if (currentWorkout) {
          currentWorkoutEvent = {
            type: attributes.type ?? "unknown",
            date: normalizeAppleDate(attributes.date),
            durationSeconds: durationToSeconds(
              attributes.duration,
              attributes.durationUnit
            ),
            metadata: {}
          };
          currentWorkout.events.push(currentWorkoutEvent);
        }
        break;
      case "WorkoutRoute":
        if (currentWorkout) {
          currentRoute = { attributes, metadata: {}, relativePath: null };
        }
        break;
      case "FileReference":
        if (currentRoute && attributes.path) {
          currentRoute.relativePath = normalizeRelativePath(attributes.path);
        }
        break;
      case "MetadataEntry":
        if (currentRoute) {
          addMetadata(currentRoute.metadata, attributes.key, attributes.value);
        } else if (currentWorkoutEvent) {
          addMetadata(currentWorkoutEvent.metadata, attributes.key, attributes.value);
        } else if (currentRecord) {
          addMetadata(currentRecord.metadata, attributes.key, attributes.value);
        } else if (currentWorkout) {
          addMetadata(currentWorkout.metadata, attributes.key, attributes.value);
        }
        break;
      case "ActivitySummary":
        if (!options.incremental) {
          store.insertActivitySummary(attributes);
        } else {
          const normalized = Object.fromEntries(
            Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))
          );
          const contentHash = createHash("sha256")
            .update(JSON.stringify(normalized))
            .digest("hex");
          const observation = store.observeImportEntity(
            "activity_summary",
            attributes.dateComponents ?? stableId("activity_summary", [attributes]),
            options.incremental.generation,
            normalizeAppleDate(attributes.dateComponents),
            options.incremental.batchId,
            contentHash
          );
          if (observation.tombstoned) tombstonedCount += 1;
          else if (observation.inserted || observation.updated) store.insertActivitySummary(attributes);
        }
        activitySummaryCount += 1;
        break;
    }
  };

  const closeTag = (tag: { name: string }) => {
    const name = localName(tag.name);

    if (name === "WorkoutEvent") {
      currentWorkoutEvent = null;
    } else if (name === "Record" && currentRecord) {
      const record = buildRecord(currentRecord);
      if (record) {
        let uuid = options.healthKitRecordIdentity
          ? lastMetadataValue(record.metadata, "RAIHealthKitSampleUUID") : null;
        if (options.healthKitRecordIdentity && (!uuid || !validSampleUUID(uuid))) {
          throw new Error("HealthKit v2 record is missing a valid sample UUID");
        }
        // P1-2（2026-10-18）：**未变记录前置跳过**（热路径：直连车道 95%+ 的载荷是重复数据）。
        //
        // 位置刻意在身份解析**之前**：命中时连 `resolveHealthKitRecordId` 的
        // sources/aliases 写入（INSERT OR IGNORE）也一并省掉 —— 那些映射在首次导入时
        // 已经写好，内容没变就没有要补的东西。判据全在纯函数
        // `isUnchangedRecordForIncrementalImport` 里（单测入口），这里只负责取事实。
        //
        // 账本语义不变：完整路径在"未变"时同样不写 `import_entity_changes`、不写
        // `health_records`、不 `saveHealthKitRecordFact`；差别只是不 UPSERT 代次、
        // 不跑提交前回读断言、不做 JSON 序列化。
        const contentHash = stableId("record_content", [currentRecord.attributes, currentRecord.metadata]);
        if (uuid && options.incremental?.preserveAbsent && !options.recordDelta) {
          const existingFact = store.healthKitRecordFactLookup(record.type, uuid);
          if (existingFact !== null && isUnchangedRecordForIncrementalImport({
            preserveAbsentIncremental: true,
            recordDelta: false,
            hasSampleUuid: true,
            hasIdentityMapping: existingFact.recordId !== null,
            existingContentHash: existingFact.contentHash,
            contentHash,
            sourceDeleted: existingFact.sourceDeleted,
            entityTombstoned: existingFact.entityTombstoned
          })) {
            unchangedRecordCount += 1;
            updateInventory(recordInventory, record.type, record.startAt, record.unit,
              classifySource(record.sourceName, record.device, record.metadata));
            recordCount += 1;
            currentRecord = null;
            return;
          }
        }
        const sourceIdentifiers: string[] = [];
        const candidateId = record.id;
        const legacyId = uuid || hasRecordAliases
          ? stableId("record", [record.type, record.sourceName, record.startAt, record.endAt,
            currentRecord.attributes.value ?? null, record.unit])
          : candidateId;
        let aliasDeleted = false;
        if (!uuid && hasRecordAliases) {
          const identity = store.resolveHealthKitRecordXmlIdentity(candidateId, legacyId);
          record.id = identity.id;
          aliasDeleted = identity.tombstoned;
          if (identity.source?.type === record.type) {
            uuid = identity.source.uuid;
            record.metadata.RAIHealthKitSampleUUID = [uuid];
          }
        }
        if (uuid) {
          record.id = store.resolveHealthKitRecordId(record.type, uuid, candidateId, legacyId);
          sourceIdentifiers.push(store.healthKitRecordSourceIdentifier(record.type, uuid));
          if (options.recordDelta) {
            const mapped = store.database.prepare("SELECT record_id FROM healthkit_record_sources WHERE sample_type=? AND sample_uuid=?")
              .get(record.type, uuid.toLowerCase());
            const aliases = new Set([candidateId, legacyId]);
            if (mapped?.record_id !== record.id || [...aliases].some(alias =>
              !store.database.prepare("SELECT 1 FROM healthkit_record_aliases WHERE alias_id=? AND sample_type=? AND sample_uuid=?")
                .get(alias, record.type, uuid!.toLowerCase()))) {
              throw new Error("Record delta UUID identity failed its pre-commit assertion");
            }
            const key = `${record.type}\0${uuid.toLowerCase()}`;
            const previous = deltaIdentities.get(key);
            deltaIdentities.set(key, { type: record.type, uuid: uuid.toLowerCase(), id: record.id,
              aliases: new Set([...(previous?.aliases ?? []), ...aliases]) });
          }
        }
        const category = classifySource(record.sourceName, record.device, record.metadata);
        // `contentHash` 已在上面算过（轻路径判定要用；同一对输入的确定性摘要，不重算）。
        if (options.recordDelta) {
          const existing = store.database.prepare("SELECT 1 FROM health_records WHERE id = ?").get(record.id);
          const known = store.database.prepare(`SELECT content_hash AS hash FROM import_entity_generations
            WHERE entity_kind = 'record' AND entity_id = ?`).get(record.id) as { hash: string } | undefined;
          if (existing && (!known || known.hash === SEED_CONTENT_HASH)) {
            throw new RecordDeltaNotEligibleError("legacy record needs content-hash initialization");
          }
        }
        // Native v1 apply understands canonical-ID tombstones, not source UUIDs.
        // Keep v2 and UUID-less alias resolution on the shared TS write path
        // even when Rust supplies XML parsing.
        if (nativeRecords && !uuid) {
          nativeRecords.capture(record, category, currentRecord.attributes, contentHash);
        } else {
          const observation = aliasDeleted ? { inserted: false, updated: false, tombstoned: true } : store.observeImportEntity(
            "record", record.id, entityGeneration, record.startAt,
            options.incremental?.batchId, contentHash, sourceIdentifiers
          );
          const shouldWrite = !observation.tombstoned
            && (!options.incremental || observation.inserted || observation.updated);
          if (uuid && !observation.tombstoned) {
            store.saveHealthKitRecordFact(record, uuid, category, currentRecord.attributes, contentHash);
            if (options.recordDelta) {
              const fact = store.database.prepare(`SELECT record_json,source_category,raw_attributes_json,content_hash
                FROM healthkit_record_facts WHERE sample_type=? AND sample_uuid=?`).get(record.type, uuid.toLowerCase());
              if (fact?.record_json !== JSON.stringify(record) || fact.source_category !== category
                  || fact.raw_attributes_json !== JSON.stringify(currentRecord.attributes) || fact.content_hash !== contentHash) {
                throw new Error("Record delta UUID fact failed its pre-commit assertion");
              }
            }
          }
          if (shouldWrite) {
            store.insertRecord(record, category, currentRecord.attributes, { availableAt });
            if (options.recordDelta) {
              assertRecordDeltaFact(store, record, category, currentRecord.attributes);
              const change = store.database.prepare(`SELECT change_type,content_hash FROM import_entity_changes
                WHERE batch_id=? AND entity_kind='record' AND entity_id=?`).get(options.incremental!.batchId!, record.id);
              if (!change || change.content_hash !== contentHash ||
                  change.change_type !== (observation.inserted ? "inserted" : "updated")) {
                throw new Error("Record delta change ledger failed its pre-commit assertion");
              }
            }
            if (!options.incremental || observation.inserted) insertedRecordCount += 1;
          }
          if (observation.tombstoned) {
            tombstonedCount += 1;
            if (uuid && store.isHealthKitRecordSourceDeleted(record.type, uuid)) {
              carriedDeletedSources.push({ type: record.type, uuid });
            }
          }
        }
        updateInventory(
          recordInventory,
          record.type,
          record.startAt,
          record.unit,
          category
        );
        recordCount += 1;
      } else {
        if (options.recordDelta) throw new RecordDeltaNotEligibleError("invalid record");
        store.insertIssue({
          severity: "warning",
          code: "INVALID_RECORD",
          objectId: null,
          message: "A Health record was skipped because required type or date fields were invalid."
        });
        issueCount += 1;
      }
      currentRecord = null;
    } else if (name === "WorkoutRoute" && currentRoute && currentWorkout) {
      currentWorkout.routes.push(currentRoute);
      currentRoute = null;
    } else if (name === "Workout" && currentWorkout) {
      const workout = buildWorkout(currentWorkout);
      if (workout) {
        const category = classifySource(workout.sourceName, workout.device, workout.metadata);
        const contentHash = stableId("workout_content", [
          currentWorkout.attributes, currentWorkout.metadata, currentWorkout.statistics,
          currentWorkout.events, currentWorkout.routes
        ]);
        const observation = store.observeImportEntity(
          "workout", workout.id, entityGeneration, workout.startAt,
          options.incremental?.batchId, contentHash,
          ["HKMetadataKeySyncIdentifier", "RAIHealthKitWorkoutUUID"]
            .map((key) => lastMetadataValue(workout.metadata, key))
            .filter((value): value is string => Boolean(value))
        );
        // P2: collect every explicit route declaration, including workouts
        // whose generated content is unchanged (those never call insertWorkout
        // and therefore never reach the write-time ownership observer). Carry
        // the tombstone flag so a deleted parent cannot claim a path.
        const workoutIdentifiers = [
          ...(workout.metadata.HKMetadataKeySyncIdentifier ?? []),
          ...(workout.metadata.RAIHealthKitWorkoutUUID ?? [])
        ];
        const tombstonedByBatch = workoutIdentifiers.some((value) => deletedWorkoutIdSet.has(value));
        for (const route of workout.routes) {
          if (route.relativePath) {
            options.onRouteDeclaration?.({
              workoutId: workout.id,
              relativePath: route.relativePath,
              tombstoned: observation.tombstoned || tombstonedByBatch
            });
          }
        }
        const shouldWrite = !observation.tombstoned && !tombstonedByBatch
          && (!options.incremental || observation.inserted || observation.updated);
        if (shouldWrite) {
          store.insertWorkout(
            workout,
            category,
            currentWorkout.attributes,
            options.incremental?.preserveAbsent ? { preserveAbsent: true } : undefined
          );
          if (!options.incremental || observation.inserted) insertedWorkoutCount += 1;
          insertedWorkoutTimes.push(workout.startAt);
        }
        if (observation.tombstoned) tombstonedCount += 1;
        updateInventory(
          workoutInventory,
          workout.activityType,
          workout.startAt,
          null,
          category
        );
        workoutCount += 1;
      } else {
        store.insertIssue({
          severity: "warning",
          code: "INVALID_WORKOUT",
          objectId: null,
          message: "A workout was skipped because required activity or date fields were invalid."
        });
        issueCount += 1;
      }
      currentWorkout = null;
      currentWorkoutEvent = null;
      currentRoute = null;
    }
  };

  parser.on("opentag", (tag) => openTag({ name: tag.name, attributes: attributesOf(tag) }));
  parser.on("closetag", closeTag);
  parser.on("error", (error) => {
    throw error;
  });

  try {
    if (options.recordDelta) {
      const text = options.recordDelta.xmlText;
      sourceHash.update(text, "utf8");
      parser.write(text).close();
    } else if (native) {
        for (const row of native.database.prepare("SELECT kind, payload FROM xml_units ORDER BY sequence").iterate() as Iterable<{ kind: string; payload: string }>) {
          const value = JSON.parse(row.payload);
          if (row.kind === "record") {
            // Keep JavaScript normalization/JSON.stringify as the single identity
            // contract. Native parsing never guesses equivalent cross-language IDs.
            currentRecord = { attributes: attributesOf({ attributes: value.attributes } as SaxesTagPlain), metadata: {} };
            for (const entry of value.metadata as Array<{ key?: string; value?: string }>) {
              addMetadata(currentRecord.metadata, entry.key, entry.value);
            }
            closeTag({ name: "Record" });
          } else {
            for (const [kind, name, attributes] of value as Array<[string, string, Record<string, string>]>) {
              if (kind === "open") openTag({ name, attributes: attributesOf({ attributes } as SaxesTagPlain) });
              else closeTag({ name });
            }
          }
        }
        options.onProgress?.({ bytesRead: native.result.inputBytes!, totalBytes: options.fileSize, recordCount, workoutCount });
    } else {
      const stream = createReadStream(xmlPath, { encoding: "utf8" });
      for await (const chunk of stream) {
        const text = String(chunk);
        sourceHash.update(text, "utf8");
        bytesRead += Buffer.byteLength(text, "utf8");
        parser.write(text);
        if (options.onProgress && bytesRead - lastProgressAt >= 16 * 1024 * 1024) {
          lastProgressAt = bytesRead;
          options.onProgress({
            bytesRead,
            totalBytes: options.fileSize,
            recordCount,
            workoutCount
          });
        }
      }
      parser.close();
    }

    let explicitDeletionTimes: string[] = [];

    if (nativeRecords) {
      const written = await nativeRecords.apply(store, options.native!);
      insertedRecordCount += written.inserted;
      tombstonedCount += written.tombstoned;
      assertGenerationConservation(store, entityGeneration, written);
    }

    // 🔴 无 UUID / 无 sync identifier 的记录身份把 value/unit 折进 id：**值更正**
    // 到达时是一个新实体，而 preserve-absent 增量从不把"载荷里没有"读成删除 ⇒ 旧行会
    // 永远留着，分析对同一时间窗双计（实测复现：/tmp 合成库 2 行、账本只有 inserted）。
    // 这里在**写完之后**按批做一次集合扫描，把旧实体按删除语义取代掉。
    //
    // 位置刻意放在 `nativeRecords.apply` 之后：Rust 只负责解码/写入记录，身份与取代
    // 判决仍由 TS 合同决定；两种引擎因此走**同一段**父进程代码，TS↔Rust 不会在这里分叉。
    //
    // 只在 `preserveAbsent` 增量车道调用：完整快照（非 incremental / replace）由
    // `finalizeImportGeneration` 自己删陈旧实体（这里先删会让删除闸门的预览少算）；
    // 直连 `recordDelta`（UUID 车道，caller 事务）不调用 —— 它的记录由
    // `healthkit_record_sources` 拥有，本方法也会跳过，但不该在它的账本语义里加写入。
    const superseded = incremental && incremental.preserveAbsent && !options.recordDelta && incremental.batchId
      ? store.supersedeLegacyRecordCorrections(incremental.batchId)
      : { removed: 0, removedIds: [] as string[], removedTimes: [] as string[] };

    if (!options.incremental?.preserveAbsent) {
      for (const [type, item] of recordInventory) {
        store.upsertInventory("record", type, item.count, item.firstAt, item.lastAt, {
          units: [...item.units].sort(),
          sourceCategories: [...item.sourceCategories].sort()
        });
      }
      for (const [type, item] of workoutInventory) {
        store.upsertInventory("workout", type, item.count, item.firstAt, item.lastAt, {
          sourceCategories: [...item.sourceCategories].sort()
        });
      }
      store.setManifest("record_count", String(recordCount));
      store.setManifest("workout_count", String(workoutCount));
      store.setManifest("activity_summary_count", String(activitySummaryCount));
    }
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
    const xmlSha256 = native?.result.sha256 ?? sourceHash.digest("hex");
    store.setManifest("source_xml_sha256", xmlSha256);
    if (
      removalDetection
      && incremental
      && incremental.guardAbsentRemoval !== false
    ) {
      const preview = store.previewGenerationRemoval(incremental.generation);
      const existingEntities = store.countImportableEntities();
      const evaluation = evaluateRemovalGuard(preview, existingEntities);
      if (evaluation.exceeded) {
        throw new ImportRemovalGuardError(
          preview,
          existingEntities,
          evaluation.allowedRemovals
        );
      }
    }
    const finalized = incremental
      ? store.finalizeImportGeneration(
        incremental.generation,
        incremental.batchId,
        removalDetection ? undefined : { preserveAbsent: true }
      )
      : { removedRecords: 0, removedWorkouts: 0, dirtyWorkoutTimes: [] as string[] };
    const recordDeletions = [...(options.deletedRecords ?? []), ...carriedDeletedSources];
    const removedHealthKitRecords = recordDeletions.length
      ? store.removeHealthKitRecords(recordDeletions, options.incremental?.batchId, entityGeneration,
        options.recordDelta ? { currentBatchOnly: true } : undefined) : 0;
    if (options.deletedWorkoutIds?.length) {
      explicitDeletionTimes = store.removeWorkoutsBySyncIdentifiers(options.deletedWorkoutIds, options.incremental?.batchId);
    }
    const result: AppleHealthParseResult = {
      recordCount, workoutCount, activitySummaryCount, issueCount,
      insertedRecordCount, insertedWorkoutCount,
      removedRecordCount: finalized.removedRecords + removedHealthKitRecords + superseded.removed,
      removedWorkoutCount: finalized.removedWorkouts,
      tombstonedCount,
      // P1-2：重复载荷的规模证据（轻路径命中数）。计入 recordCount，不计入 inserted。
      unchangedRecordCount,
      // 旧值被取代掉的时刻（`start_at`）：调用方把它并进脏范围下界，删除所在窗口
      // 必须重算 —— 账本 `previous_*` 也写了同一区间，两条消费路径同源。
      supersededRecordCount: superseded.removed,
      supersededRecordTimes: superseded.removedTimes,
      dirtyWorkoutTimes: [...insertedWorkoutTimes, ...explicitDeletionTimes, ...finalized.dirtyWorkoutTimes]
    };
    options.recordDelta?.beforeCommit(result, xmlSha256);
    if (options.recordDelta) {
      for (const expected of deltaIdentities.values()) {
        if (store.database.prepare("SELECT record_id FROM healthkit_record_sources WHERE sample_type=? AND sample_uuid=?")
          .get(expected.type, expected.uuid)?.record_id !== expected.id || [...expected.aliases].some(alias =>
            !store.database.prepare("SELECT 1 FROM healthkit_record_aliases WHERE alias_id=? AND sample_type=? AND sample_uuid=?")
              .get(alias, expected.type, expected.uuid))) {
          throw new Error("Record delta UUID identity failed its pre-commit assertion");
        }
      }
      for (const { type, uuid } of recordDeletions) {
        if (!store.isHealthKitRecordSourceDeleted(type, uuid)) {
          throw new Error("Record delta tombstone failed its pre-commit assertion");
        }
      }
      for (const change of store.database.prepare(`SELECT entity_id,change_type,content_hash FROM import_entity_changes
        WHERE batch_id=? AND entity_kind='record'`).all(options.incremental!.batchId!)) {
        const row = store.database.prepare("SELECT type,metadata_json FROM health_records WHERE id=?").get(String(change.entity_id));
        if (change.change_type === "removed") {
          if (row) throw new Error("Record delta deletion failed its pre-commit assertion");
        } else {
          const metadata = row ? JSON.parse(String(row.metadata_json)) as MetadataMap : {};
          const owner = lastMetadataValue(metadata, "RAIHealthKitSampleUUID");
          const fact = owner && row ? store.database.prepare(`SELECT record_json,source_category,raw_attributes_json,content_hash
            FROM healthkit_record_facts WHERE sample_type=? AND sample_uuid=?`).get(String(row.type), owner.toLowerCase()) : undefined;
          if (!fact || fact.content_hash !== change.content_hash) throw new Error("Record delta change ledger failed its pre-commit assertion");
          assertRecordDeltaFact(store, JSON.parse(String(fact.record_json)), String(fact.source_category),
            JSON.parse(String(fact.raw_attributes_json)));
        }
      }
    }
    if (callerOwned) {
      // 成功路径：释放这一段（并入调用方的事务），**不提交**。release 出错要响亮 ——
      // 那说明栈不干净（例如别的组件泄漏了 savepoint），静默继续会让调用方以为本批已并入。
      store.releaseSavepoint(CALLER_OWNED_PARSE_SAVEPOINT);
      callerSavepointOpen = false;
    } else if (atomic) store.commitAtomicImport();
    else store.flush();
    return result;
  } catch (error) {
    if (callerOwned) abandonCallerSavepoint();
    else if (atomic) store.rollbackAtomicImport();
    else store.rollback();
    throw error;
  }

  return { recordCount, workoutCount, activitySummaryCount, issueCount };
  } catch (error) {
    // Early failures (including onBegin) must also roll back. In the live delta
    // path a close() after an uncaught initialization error must never commit.
    if (callerOwned) abandonCallerSavepoint();
    else if (options.atomic !== false) store.rollbackAtomicImport();
    else store.rollback();
    throw error;
  } finally { nativeRecords?.close(); await native?.dispose(); }
}
