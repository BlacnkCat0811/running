/**
 * P3-06（2026-10-22）：**完整业务产物投影 + 严格差分比较器**。
 *
 * 现有 `training-metric-domain-reuse.test.ts` 的 `readBusiness()` 只挑了几列
 * （features / loads / zones / profiles / daily / assessments 的各一部分），
 * 证明不了"业务产物逐字段等价"。本模块把 P3-06 要求的表全部投影成
 * `{table, keyFields, rows}`，再由同一个比较器做逐表／逐键／逐字段差分。
 *
 * ## 白名单纪律（只允许排除执行身份）
 *
 * - 表级查询**显式列列名**，不 `SELECT *`：新增业务列会以"unknown field"失败，
 *   不会被静默跳过。
 * - `model_domain_snapshots` 的 payload 递归比较，**只**删除执行身份键
 *   （run/row id、`computed_at`/`created_at`、`lineage.sourceRunId`）。
 *   `provenance_json` / `explanation_json` / `lineage` / checkpoint 状态等整块保留。
 * - `baselineEpochId` / `calibrationCohortHash` 一律比较**原始持久值**，不做语义替换；
 *   run 分区 feature id 只通过 `mapFeatureIdArrays` 映射回 training_session_id。
 * - 数值：整数严格相等；浮点先做有限性检查，再按
 *   `abs(a-b) <= 1e-9 * max(1, |a|, |b|)`。
 *
 * 本文件不是 `*.test.*`，不会被 runner 当作测试文件；它只被测试导入。
 */
import {
  REQUIRED_MODEL_DOMAINS, SqliteModelReleaseRepository, readFactReadView, semanticHash
} from "@rai/storage-sqlite";
import type { RaiDatabase } from "@rai/storage-sqlite";

export interface BusinessTableReference {
  /** Row field holding the target table's composite key (JSON array string). */
  readonly field: string;
  readonly table: string;
}

export interface BusinessTable {
  readonly name: string;
  readonly keyFields: readonly string[];
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /**
   * Referential integrity: every non-null value of `field` must resolve to a row of
   * `table` under `table.keyFields`. Broken references fail the comparison even when
   * both sides carry the same broken value.
   */
  readonly references?: readonly BusinessTableReference[];
}

export interface BusinessProjection {
  readonly tables: ReadonlyArray<BusinessTable>;
}

/**
 * P3-06 修订 / 复审 §3.4：**独立的**必需表名与列名规范。
 *
 * 投影自身的 SQL 已经显式列列名，但"SQL 写了 15 张表"与"这次运行真的产出了
 * 15 张表"是两件事：手工 7 表 fixture、某个装配分支漏掉新投影、或某张表在
 * 本 fixture 里意外为空，都会让比较器"比较了两份都缺同一张表"而假绿。
 * 生产 fixture 的投影必须先通过本规范，再进入差分比较。
 */
export const REQUIRED_BUSINESS_TABLES = [
  "workout_features",
  "workout_training_loads",
  "workout_zone_summaries",
  "daily_zone_profiles",
  "daily_training_metrics",
  "training_sessions",
  "ability_assessments",
  "daily_ability_snapshots",
  "model_runs",
  "model_v2_runs",
  "model_domain_snapshots",
  "model_release_bundles",
  "release_readable_state",
  "analysis_run_input_bindings",
  "analysis_job_coverage"
] as const;

/** Tables that must have at least one row for a production fixture. */
const REQUIRED_NON_EMPTY_TABLES: ReadonlySet<string> = new Set(
  REQUIRED_BUSINESS_TABLES.filter((name) =>
    name !== "analysis_run_input_bindings" && name !== "analysis_job_coverage")
);

/**
 * Column spec for the three projections added by the 2026-10-22 review.
 *
 * These tables were the ones silently missing from the old 12-table summary;
 * pinning their complete business column set is what makes "15 tables" a
 * checkable statement instead of a count in a report.
 */
export const REQUIRED_BUSINESS_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  training_sessions: [
    "activityType", "anchorDistanceKm", "anchorEndAt", "anchorStartAt",
    "canonicalWorkoutId", "status", "trainingSessionId"
  ],
  model_release_bundles: [
    "activated", "baseRunOrdinal", "createdAt", "datasetVersion", "evaluation",
    "runOrdinal", "snapshotDomains", "snapshotProjectionHash", "status"
  ],
  release_readable_state: [
    "activePublished", "activeReleaseOrdinal", "activeRunOrdinal", "analysisStatus",
    "bundleStatus", "freshness", "readableDomains", "singleton"
  ]
};

/**
 * Assert a **production** projection is the complete business-artifact set.
 *
 * Throws on a missing/extra table, an empty required table, duplicate keys, or a
 * column-set drift in one of the critical tables. The manual 7-table fixture in
 * the comparator's negative controls intentionally does not call this.
 */
export function assertCompleteBusinessProjection(
  projection: BusinessProjection, context = "business projection"
): void {
  const names = projection.tables.map((table) => table.name);
  const unique = new Set(names);
  if (unique.size !== names.length) {
    throw new Error(`${context}: duplicate table in projection`);
  }
  const missing = REQUIRED_BUSINESS_TABLES.filter((name) => !unique.has(name));
  const extra = names.filter((name) => !(REQUIRED_BUSINESS_TABLES as readonly string[]).includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${context}: business projection table set is incomplete; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`);
  }
  for (const table of projection.tables) {
    if (REQUIRED_NON_EMPTY_TABLES.has(table.name) && table.rows.length === 0) {
      throw new Error(`${context}: required table ${table.name} is empty`);
    }
    const seen = new Set<string>();
    for (const row of table.rows) {
      const key = describeKey(table, row);
      if (seen.has(key)) throw new Error(`${context}: duplicate key in ${table.name}: ${key}`);
      seen.add(key);
    }
    const requiredColumns = REQUIRED_BUSINESS_COLUMNS[table.name];
    if (requiredColumns !== undefined) {
      for (const row of table.rows) {
        const actual = Object.keys(row).sort();
        const expected = [...requiredColumns].sort();
        if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
          throw new Error(
            `${context}: ${table.name} column set drifted; expected=[${expected.join(", ")}] actual=[${actual.join(", ")}]`);
        }
        for (const column of requiredColumns) {
          if (row[column] === undefined) {
            throw new Error(`${context}: ${table.name} is missing column ${column}`);
          }
        }
      }
    }
  }
}

export type BusinessDiffKind =
  | "missing_table"
  | "extra_table"
  | "duplicate_key"
  | "missing_row"
  | "extra_row"
  | "missing_field"
  | "unknown_field"
  | "value"
  | "non_finite"
  | "dangling_reference";

export interface BusinessDiff {
  readonly table: string;
  readonly key: string;
  readonly field: string;
  readonly kind: BusinessDiffKind;
  readonly message: string;
}

/**
 * 执行身份键：run/row-scoped ids 与纯执行时间戳。
 *
 * 这些键**只**在 `model_domain_snapshots` 的递归 payload 中删除。业务时间
 * （`asOf`、`evaluatedAt`、`localDate`、`assessedAt`、`effectiveAt`、`dataThroughAt`）
 * 一律保留；`id` 在这里是 run 分区的行 id（ability_assessments / daily_* 的
 * `deterministicId(... modelRunId ...)`），不是业务身份。
 */
const EXECUTION_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "feature_id",
  "model_run_id",
  "training_metric_run_id",
  "feature_run_id",
  "parent_feature_run_id",
  "parent_model_run_id",
  "computed_at",
  "created_at",
  "sourceRunId"
]);

/** Recursively drop only execution identity keys; arrays keep their order. */
export function stripExecutionIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripExecutionIdentity(item));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (EXECUTION_IDENTITY_KEYS.has(key)) continue;
    output[key] = stripExecutionIdentity(child);
  }
  return output;
}

/**
 * 把任意嵌套值里出现的**原始 run id 字符串**替换成稳定的逻辑序号。
 * 只用于 evaluation_json 这类可能回显 incumbent/candidate id 的报告体；
 * 未命中的字符串原样保留。两个库的 run id 不同，但插入顺序相同。
 */
export function replaceRunIds(
  value: unknown,
  runOrdinalById: ReadonlyMap<string, number>
): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceRunIds(item, runOrdinalById));
  if (typeof value === "string") {
    const ordinal = runOrdinalById.get(value);
    return ordinal === undefined ? value : `run:${ordinal}`;
  }
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = replaceRunIds(child, runOrdinalById);
  }
  return output;
}

/**
 * 关系映射（plan §7.2）：`explanation_json.adaptiveBaseline` 与 checkpoint baseline 里
 * 保存的是 **run 分区 feature id**（`featureIds` / `calibrationFeatureIds`）。它们不是
 * 可比较的业务值，但业务含义是"哪些训练构成基线" —— 因此映射为稳定的
 * `training_session_id`，而不是删掉整块 explanation。
 *
 * 无法解析的 id 直接抛错（悬空引用不能被静默跳过）。
 */
const FEATURE_ID_ARRAY_KEYS: ReadonlySet<string> = new Set(["featureIds", "calibrationFeatureIds"]);

export function mapFeatureIdArrays(
  value: unknown,
  featureToSession: ReadonlyMap<string, string>,
  path = "explanation"
): unknown {
  if (Array.isArray(value)) return value.map((item, index) => mapFeatureIdArrays(item, featureToSession, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FEATURE_ID_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      output[key] = child.map((featureId, index) => {
        if (typeof featureId !== "string") throw new Error(`${path}.${key}[${index}]: feature id is not a string`);
        const session = featureToSession.get(featureId);
        if (session === undefined) throw new Error(`${path}.${key}[${index}]: feature id ${featureId} does not resolve`);
        return session;
      });
      continue;
    }
    output[key] = mapFeatureIdArrays(child, featureToSession, `${path}.${key}`);
  }
  return output;
}

/**
 * 关系映射：`load_vector.highIntensityZoneSystem` 与 `zone_coherence.zoneProfileId`
 * 是 run 分区的 `daily_zone_profiles.id`。业务含义是"引用哪一天的分区档案"，
 * 因此映射为该档案的稳定 `local_date`；无法解析的引用直接抛错。
 */
export function mapZoneProfileIds(
  value: unknown,
  profileToLocalDate: ReadonlyMap<string, string>,
  path = "payload"
): unknown {
  if (Array.isArray(value)) return value.map((item, index) => mapZoneProfileIds(item, profileToLocalDate, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "highIntensityZoneSystem" || key === "zoneProfileId") {
      if (child === null) { output[key] = null; continue; }
      if (typeof child !== "string") throw new Error(`${path}.${key}: expected zone profile id string`);
      const localDate = profileToLocalDate.get(child);
      if (localDate === undefined) throw new Error(`${path}.${key}: zone profile ${child} does not resolve`);
      output[key] = localDate;
      continue;
    }
    output[key] = mapZoneProfileIds(child, profileToLocalDate, `${path}.${key}`);
  }
  return output;
}

/**
 * 快照 payload 来自 `SELECT *`，JSON 列以**字符串**形态嵌在对象里（例如
 * `daily_training_metrics.explanation_json`、`ability_assessments.explanation_json`）。
 * 递归比较前必须按 JSON 解析，否则会把"JSON 文本不同但语义相同"当成差异，
 * 也会让关系映射看不到 `featureIds`。只解析以 `_json` 结尾的字符串列，
 * 其他字符串（解释码数组已 stringify 的情况除外）保持原文。
 */
export function parseJsonColumnsDeep(value: unknown, path = "payload"): unknown {
  if (Array.isArray(value)) return value.map((item, index) => parseJsonColumnsDeep(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    output[key] = typeof child === "string" && key.endsWith("_json")
      ? parseJsonColumnsDeep(parseJsonColumn(child, childPath), childPath)
      : parseJsonColumnsDeep(child, childPath);
  }
  return output;
}

/** Parse a JSON column. Invalid JSON is a hard failure, never a skipped field. */
export function parseJsonColumn(value: unknown, path: string): unknown {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${path}: expected JSON text, got ${typeof value}`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function activeModelRunId(store: RaiDatabase): string {
  const row = store.database.prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1").get();
  if (!row) throw new Error("no active model run");
  return String((row as { id: string }).id);
}

function activeMetricRunId(store: RaiDatabase, modelRunId: string): string {
  const row = store.database.prepare(
    "SELECT id FROM training_metric_runs WHERE model_run_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1"
  ).get(modelRunId);
  if (!row) throw new Error("no succeeded training metric run for the active model run");
  return String((row as { id: string }).id);
}

function assessmentKey(trainingSessionId: string, sequenceNumber: number): string {
  return JSON.stringify([trainingSessionId, sequenceNumber]);
}

function rowKey(table: BusinessTable, row: Record<string, unknown>): string | null {
  const values: unknown[] = [];
  for (const field of table.keyFields) {
    if (!(field in row)) return null;
    values.push(row[field]);
  }
  return JSON.stringify(values);
}

function allOf<T>(db: RaiDatabase["database"], sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function getOf<T>(db: RaiDatabase["database"], sql: string, ...params: Array<string | number | null>): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

/**
 * 读取 active run 的完整业务投影。
 *
 * 所有表都按稳定业务键排序（比较器还会再次排序，不依赖 SQL 顺序碰巧一致）。
 */
export function readBusinessProjection(store: RaiDatabase): BusinessProjection {
  const db = store.database;
  const modelRunId = activeModelRunId(store);
  const metricRunId = activeMetricRunId(store, modelRunId);
  const zoneProfileDateById = new Map<string, string>();
  // 全局映射：复用路径会原样搬父 run 的 `load_vector`/`zone_coherence` 快照，
  // 其中的 zoneProfileId 仍指向父 run 的分区行（与 feature id 同理）。id 全局唯一，
  // 映射到稳定的 local_date 后即可比较业务含义。
  for (const row of allOf<{ id: string; localDate: string }>(db,
    "SELECT id, local_date AS localDate FROM daily_zone_profiles")) {
    zoneProfileDateById.set(String(row.id), String(row.localDate));
  }

  // ---- workout_features：除 id / feature_run_id / computed_at 外的全部业务列 ----
  const featureRows = allOf<Record<string, unknown>>(db, `
    SELECT f.training_session_id AS trainingSessionId,
           f.canonical_workout_id AS canonicalWorkoutId,
           f.workout_start_at AS workoutStartAt,
           f.duration_seconds AS durationSeconds,
           f.distance_km AS distanceKm,
           f.average_speed_mps AS averageSpeedMps,
           f.average_heart_rate_bpm AS averageHeartRateBpm,
           f.heart_rate_sample_count AS heartRateSampleCount,
           f.heart_rate_coverage AS heartRateCoverage,
           f.route_point_count AS routePointCount,
           f.route_quality AS routeQuality,
           f.source_confidence AS sourceConfidence,
           f.session_type AS sessionType,
           f.session_type_source AS sessionTypeSource,
           f.eligibility_status AS eligibilityStatus,
           f.quality_score AS qualityScore,
           f.missing_reasons_json AS missingReasonsJson,
           f.features_json AS featuresJson,
           f.provenance_json AS provenanceJson
    FROM workout_features f
    JOIN model_runs m ON m.feature_run_id = f.feature_run_id
    WHERE m.id = ?
    ORDER BY f.training_session_id`, modelRunId).map((row) => {
    const { missingReasonsJson, featuresJson, provenanceJson, ...business } = row;
    const session = String(row.trainingSessionId);
    return {
      ...business,
      missingReasons: parseJsonColumn(missingReasonsJson, `workout_features[${session}].missing_reasons_json`),
      features: parseJsonColumn(featuresJson, `workout_features[${session}].features_json`),
      provenance: parseJsonColumn(provenanceJson, `workout_features[${session}].provenance_json`)
    };
  });

  // ---- workout_training_loads：全部业务列（run 分区 id / 执行时间戳除外） ----
  const loadRows = allOf<Record<string, unknown>>(db, `
    SELECT l.training_session_id AS trainingSessionId,
           l.local_date AS localDate,
           l.timezone_identifier AS timezoneIdentifier,
           l.distance_km AS distanceKm,
           l.duration_seconds AS durationSeconds,
           l.training_load AS trainingLoad,
           l.intensity,
           l.load_source AS loadSource,
           l.confidence,
           l.heart_rate_coverage AS heartRateCoverage,
           l.average_heart_rate_bpm AS averageHeartRateBpm,
           l.elevation_gain_meters AS elevationGainMeters,
           l.rpe,
           l.session_type AS sessionType,
           l.explanation_codes_json AS explanationCodesJson,
           l.provenance_json AS provenanceJson,
           l.zone_profile_id AS zoneProfileId,
           l.stimulus_type AS stimulusType,
           l.raw_hrr_trimp AS rawHrrTrimp,
           l.internal_load AS internalLoad,
           l.pace_load AS paceLoad,
           l.distance_reference_meters AS distanceReferenceMeters,
           l.distance_exposure_ratio AS distanceExposureRatio,
           l.distance_factor AS distanceFactor,
           l.heart_rate_load_confidence AS heartRateLoadConfidence,
           l.pace_load_confidence AS paceLoadConfidence
    FROM workout_training_loads l
    WHERE l.training_metric_run_id = ?
    ORDER BY l.training_session_id`, metricRunId).map((row) => {
    const { explanationCodesJson, provenanceJson, zoneProfileId, ...business } = row;
    const session = String(row.trainingSessionId);
    const zoneDate = zoneProfileId === null ? null : zoneProfileDateById.get(String(zoneProfileId));
    if (zoneProfileId !== null && zoneDate === undefined) {
      throw new Error(`workout_training_loads[${session}]: zone_profile_id ${String(zoneProfileId)} does not resolve`);
    }
    return {
      ...business,
      explanationCodes: parseJsonColumn(explanationCodesJson, `workout_training_loads[${session}].explanation_codes_json`),
      provenance: parseJsonColumn(provenanceJson, `workout_training_loads[${session}].provenance_json`),
      zoneProfileDate: zoneDate ?? null
    };
  });

  // ---- workout_zone_summaries：全部业务列（关系映射 zoneProfileId -> localDate） ----
  const zoneSummaryRows = allOf<Record<string, unknown>>(db, `
    SELECT z.training_session_id AS trainingSessionId,
           z.zone_profile_id AS zoneProfileId,
           z.stimulus_type AS stimulusType,
           z.secondary_stimulus_types_json AS secondaryStimulusTypesJson,
           z.stimulus_confidence AS stimulusConfidence,
           z.heart_rate_coverage AS heartRateCoverage,
           z.pace_coverage AS paceCoverage,
           z.heart_rate_exposure_json AS heartRateExposureJson,
           z.pace_exposure_json AS paceExposureJson,
           z.stimulus_scores_json AS stimulusScoresJson,
           z.explanation_codes_json AS explanationCodesJson
    FROM workout_zone_summaries z
    WHERE z.training_metric_run_id = ?
    ORDER BY z.training_session_id`, metricRunId).map((row) => {
    const zoneDate = zoneProfileDateById.get(String(row.zoneProfileId));
    if (zoneDate === undefined) throw new Error(`workout_zone_summaries[${String(row.trainingSessionId)}]: zone_profile_id does not resolve`);
    const session = String(row.trainingSessionId);
    return {
      trainingSessionId: row.trainingSessionId,
      zoneProfileDate: zoneDate,
      stimulusType: row.stimulusType,
      secondaryStimulusTypes: parseJsonColumn(row.secondaryStimulusTypesJson, `workout_zone_summaries[${session}].secondary_stimulus_types_json`),
      stimulusConfidence: row.stimulusConfidence,
      heartRateCoverage: row.heartRateCoverage,
      paceCoverage: row.paceCoverage,
      heartRateExposure: parseJsonColumn(row.heartRateExposureJson, `workout_zone_summaries[${session}].heart_rate_exposure_json`),
      paceExposure: parseJsonColumn(row.paceExposureJson, `workout_zone_summaries[${session}].pace_exposure_json`),
      stimulusScores: parseJsonColumn(row.stimulusScoresJson, `workout_zone_summaries[${session}].stimulus_scores_json`),
      explanationCodes: parseJsonColumn(row.explanationCodesJson, `workout_zone_summaries[${session}].explanation_codes_json`)
    };
  });

  // ---- daily_zone_profiles：全部业务列（id / run id / created_at 除外） ----
  const dailyZoneRows = allOf<Record<string, unknown>>(db, `
    SELECT p.local_date AS localDate,
           p.timezone_identifier AS timezoneIdentifier,
           p.effective_at AS effectiveAt,
           p.data_through_at AS dataThroughAt,
           p.resting_heart_rate_bpm AS restingHeartRateBpm,
           p.maximum_heart_rate_bpm AS maximumHeartRateBpm,
           p.threshold_pace_seconds_per_km AS thresholdPaceSecondsPerKm,
           p.heart_rate_source AS heartRateSource,
           p.pace_source AS paceSource,
           p.heart_rate_confidence AS heartRateConfidence,
           p.pace_confidence AS paceConfidence,
           p.profile_status AS profileStatus,
           p.heart_rate_bands_json AS heartRateBandsJson,
           p.pace_bands_json AS paceBandsJson,
           p.evidence_json AS evidenceJson
    FROM daily_zone_profiles p
    WHERE p.training_metric_run_id = ?
    ORDER BY p.local_date`, metricRunId).map((row) => ({
    localDate: row.localDate,
    timezoneIdentifier: row.timezoneIdentifier,
    effectiveAt: row.effectiveAt,
    dataThroughAt: row.dataThroughAt,
    restingHeartRateBpm: row.restingHeartRateBpm,
    maximumHeartRateBpm: row.maximumHeartRateBpm,
    thresholdPaceSecondsPerKm: row.thresholdPaceSecondsPerKm,
    heartRateSource: row.heartRateSource,
    paceSource: row.paceSource,
    heartRateConfidence: row.heartRateConfidence,
    paceConfidence: row.paceConfidence,
    profileStatus: row.profileStatus,
    heartRateBands: parseJsonColumn(row.heartRateBandsJson, `daily_zone_profiles[${String(row.localDate)}].heart_rate_bands_json`),
    paceBands: parseJsonColumn(row.paceBandsJson, `daily_zone_profiles[${String(row.localDate)}].pace_bands_json`),
    evidence: parseJsonColumn(row.evidenceJson, `daily_zone_profiles[${String(row.localDate)}].evidence_json`)
  }));

  // ---- daily_training_metrics：全部业务列（id / run id / computed_at 除外） ----
  const dailyLoadRows = allOf<Record<string, unknown>>(db, `
    SELECT d.local_date AS localDate,
           d.timezone_identifier AS timezoneIdentifier,
           d.distance_km AS distanceKm,
           d.duration_seconds AS durationSeconds,
           d.workout_count AS workoutCount,
           d.daily_load AS dailyLoad,
           d.current_7d_load AS current7dLoad,
           d.previous_7d_load AS previous7dLoad,
           d.acute_ewma AS acuteEwma,
           d.chronic_ewma AS chronicEwma,
           d.load_ratio AS loadRatio,
           d.ramp_rate AS rampRate,
           d.monotony,
           d.strain,
           d.recovery_evidence AS recoveryEvidence,
           d.history_days AS historyDays,
           d.load_workout_count AS loadWorkoutCount,
           d.training_status AS trainingStatus,
           d.confidence,
           d.explanation_codes_json AS explanationCodesJson,
           d.explanation_json AS explanationJson
    FROM daily_training_metrics d
    WHERE d.training_metric_run_id = ?
    ORDER BY d.local_date`, metricRunId).map((row) => {
    const date = String(row.localDate);
    return {
      localDate: row.localDate,
      timezoneIdentifier: row.timezoneIdentifier,
      distanceKm: row.distanceKm,
      durationSeconds: row.durationSeconds,
      workoutCount: row.workoutCount,
      dailyLoad: row.dailyLoad,
      current7dLoad: row.current7dLoad,
      previous7dLoad: row.previous7dLoad,
      acuteEwma: row.acuteEwma,
      chronicEwma: row.chronicEwma,
      loadRatio: row.loadRatio,
      rampRate: row.rampRate,
      monotony: row.monotony,
      strain: row.strain,
      recoveryEvidence: row.recoveryEvidence,
      historyDays: row.historyDays,
      loadWorkoutCount: row.loadWorkoutCount,
      trainingStatus: row.trainingStatus,
      confidence: row.confidence,
      explanationCodes: parseJsonColumn(row.explanationCodesJson, `daily_training_metrics[${date}].explanation_codes_json`),
      explanation: parseJsonColumn(row.explanationJson, `daily_training_metrics[${date}].explanation_json`)
    };
  });

  // ---- training_sessions：稳定业务身份 + 全部业务列（created_at/updated_at 是执行时间） ----
  const trainingSessionRows = allOf<Record<string, unknown>>(db, `
    SELECT s.id AS trainingSessionId,
           s.activity_type AS activityType,
           s.anchor_start_at AS anchorStartAt,
           s.anchor_end_at AS anchorEndAt,
           s.anchor_distance_km AS anchorDistanceKm,
           s.canonical_workout_id AS canonicalWorkoutId,
           s.status
    FROM training_sessions s
    ORDER BY s.id`);

  // ---- ability_assessments：除 id / model_run_id / feature_id 外的全部业务列 ----
  const featureSessionById = new Map<string, string>();
  for (const row of allOf<{ id: string; sessionId: string }>(db,
    "SELECT id, training_session_id AS sessionId FROM workout_features WHERE feature_run_id = (SELECT feature_run_id FROM model_runs WHERE id = ?)",
    modelRunId)) {
    featureSessionById.set(String(row.id), String(row.sessionId));
  }
  /**
   * `summary_json.baseline.calibrationFeatureIds` 是 **run 分区 feature id**；resume
   * 路径在修复后必须已重映射到当前 run（见 `resumeModelReplay`），但历史 checkpoint /
   * 跨 run 证据仍可能持有父 run 的 id。这里通过全局 `workout_features.id` 映射回稳定的
   * training_session_id（feature id 内嵌 featureRunId，全局唯一），比较 session 集合，
   * 而不是要求两个 run 的 id 相等。hash 字段本身不做映射。
   */
  const featureSessionByIdGlobal = new Map<string, string>();
  for (const row of allOf<{ id: string; sessionId: string }>(db,
    "SELECT id, training_session_id AS sessionId FROM workout_features")) {
    featureSessionByIdGlobal.set(String(row.id), String(row.sessionId));
  }
  const assessmentRaw = allOf<Record<string, unknown>>(db, `
    SELECT a.id AS rowId,
           a.feature_id AS featureId,
           a.training_session_id AS trainingSessionId,
           a.sequence_number AS sequenceNumber,
           a.assessment_status AS assessmentStatus,
           a.current_ability AS currentAbility,
           a.efficiency_score AS efficiencyScore,
           a.pace_score AS paceScore,
           a.cardio_score AS cardioScore,
           a.stability_score AS stabilityScore,
           a.recovery_score AS recoveryScore,
           a.effective_weights_json AS effectiveWeightsJson,
           a.confidence,
           a.confidence_factors_json AS confidenceFactorsJson,
           a.workout_contribution AS workoutContribution,
           a.evidence_strength AS evidenceStrength,
           a.direction_factor AS directionFactor,
           a.growth_resistance AS growthResistance,
           a.true_ability_before AS trueAbilityBefore,
           a.true_ability_after AS trueAbilityAfter,
           a.true_ability_delta AS trueAbilityDelta,
           a.updated_true_ability AS updatedTrueAbility,
           a.explanation_codes_json AS explanationCodesJson,
           a.explanation_json AS explanationJson,
           a.assessed_at AS assessedAt
    FROM ability_assessments a
    WHERE a.model_run_id = ?
    ORDER BY a.sequence_number`, modelRunId);
  const assessmentByRowId = new Map<string, { trainingSessionId: string; sequenceNumber: number }>();
  const assessmentRows = assessmentRaw.map((row) => {
    const trainingSessionId = String(row.trainingSessionId);
    const sequenceNumber = Number(row.sequenceNumber);
    const featureSession = featureSessionById.get(String(row.featureId));
    if (featureSession === undefined) {
      throw new Error(`ability_assessments[${trainingSessionId}/${sequenceNumber}]: feature_id does not resolve to this run's features`);
    }
    if (featureSession !== trainingSessionId) {
      throw new Error(`ability_assessments[${trainingSessionId}/${sequenceNumber}]: feature_id resolves to session ${featureSession}`);
    }
    assessmentByRowId.set(String(row.rowId), { trainingSessionId, sequenceNumber });
    return {
      trainingSessionId,
      sequenceNumber,
      assessmentStatus: row.assessmentStatus,
      currentAbility: row.currentAbility,
      efficiencyScore: row.efficiencyScore,
      paceScore: row.paceScore,
      cardioScore: row.cardioScore,
      stabilityScore: row.stabilityScore,
      recoveryScore: row.recoveryScore,
      effectiveWeights: parseJsonColumn(row.effectiveWeightsJson, `ability_assessments[${trainingSessionId}/${sequenceNumber}].effective_weights_json`),
      confidence: row.confidence,
      confidenceFactors: parseJsonColumn(row.confidenceFactorsJson, `ability_assessments[${trainingSessionId}/${sequenceNumber}].confidence_factors_json`),
      workoutContribution: row.workoutContribution,
      evidenceStrength: row.evidenceStrength,
      directionFactor: row.directionFactor,
      growthResistance: row.growthResistance,
      trueAbilityBefore: row.trueAbilityBefore,
      trueAbilityAfter: row.trueAbilityAfter,
      trueAbilityDelta: row.trueAbilityDelta,
      updatedTrueAbility: Number(row.updatedTrueAbility) === 1,
      explanationCodes: parseJsonColumn(row.explanationCodesJson, `ability_assessments[${trainingSessionId}/${sequenceNumber}].explanation_codes_json`),
      explanation: mapFeatureIdArrays(
        parseJsonColumn(row.explanationJson, `ability_assessments[${trainingSessionId}/${sequenceNumber}].explanation_json`),
        featureSessionByIdGlobal,
        `ability_assessments[${trainingSessionId}/${sequenceNumber}].explanation_json`
      ),
      featureTrainingSessionId: featureSession,
      assessedAt: row.assessedAt
    };
  });

  // ---- daily_ability_snapshots：last_assessment_id 映射到 session+sequence ----
  const dailyRows = allOf<Record<string, unknown>>(db, `
    SELECT d.local_date AS localDate,
           d.timezone_identifier AS timezoneIdentifier,
           d.true_ability AS trueAbility,
           d.decay_points AS decayPoints,
           d.growth_velocity_per_week AS growthVelocityPerWeek,
           d.snapshot_status AS snapshotStatus,
           d.last_assessment_id AS lastAssessmentId,
           d.baseline_epoch_id AS baselineEpochId
    FROM daily_ability_snapshots d
    WHERE d.model_run_id = ?
    ORDER BY d.local_date`, modelRunId).map((row) => {
    let lastAssessmentRef: string | null = null;
    if (row.lastAssessmentId !== null) {
      const resolved = assessmentByRowId.get(String(row.lastAssessmentId));
      if (resolved === undefined) {
        throw new Error(`daily_ability_snapshots[${String(row.localDate)}]: last_assessment_id ${String(row.lastAssessmentId)} does not resolve`);
      }
      lastAssessmentRef = assessmentKey(resolved.trainingSessionId, resolved.sequenceNumber);
    }
    return {
      localDate: row.localDate,
      timezoneIdentifier: row.timezoneIdentifier,
      trueAbility: row.trueAbility,
      decayPoints: row.decayPoints,
      growthVelocityPerWeek: row.growthVelocityPerWeek,
      snapshotStatus: row.snapshotStatus,
      lastAssessmentRef,
      baselineEpochId: row.baselineEpochId
    };
  });

  // ---- model_runs + summary_json（business content; reuse counters are telemetry） ----
  const modelRun = getOf<Record<string, unknown>>(db, `
    SELECT m.model_version AS modelVersion,
           m.model_config_json AS modelConfigJson,
           m.model_config_hash AS modelConfigHash,
           m.dataset_version AS datasetVersion,
           m.evaluated_at AS evaluatedAt,
           m.summary_json AS summaryJson,
           f.feature_config_json AS featureConfigJson,
           f.feature_config_hash AS featureConfigHash,
           f.feature_schema_version AS featureSchemaVersion,
           f.canonical_contract_version AS canonicalContractVersion
    FROM model_runs m
    JOIN feature_runs f ON f.id = m.feature_run_id
    WHERE m.id = ?`, modelRunId);
  if (modelRun === undefined) throw new Error("active model run row disappeared");
  const summary = parseJsonColumn(modelRun.summaryJson, "model_runs.summary_json") as {
    featureCount?: unknown;
    calibrationFeatureCount?: unknown;
    baseline?: {
      calibrationFeatureIds?: unknown;
      calibrationStartAt?: unknown;
      calibrationEndAt?: unknown;
      dimensions?: unknown;
    } | null;
    reusedAssessmentCount?: unknown;
  } | null;
  const calibrationSessions = Array.isArray(summary?.baseline?.calibrationFeatureIds)
    ? summary.baseline.calibrationFeatureIds.map((featureId) => {
      const session = featureSessionByIdGlobal.get(String(featureId));
      if (session === undefined) throw new Error(`model_runs.summary_json.baseline.calibrationFeatureIds: ${String(featureId)} does not resolve`);
      return session;
    })
    : null;
  const modelConfig = parseJsonColumn(modelRun.modelConfigJson, "model_runs.model_config_json") as Record<string, unknown>;
  const featureConfig = parseJsonColumn(modelRun.featureConfigJson, "feature_runs.feature_config_json");
  const modelRunRow = {
    singleton: "active",
    modelVersion: modelRun.modelVersion,
    modelConfig,
    modelConfigHash: modelRun.modelConfigHash,
    datasetVersion: modelRun.datasetVersion,
    evaluatedAt: modelRun.evaluatedAt,
    summary: summary === null ? null : {
      featureCount: summary.featureCount,
      calibrationFeatureCount: summary.calibrationFeatureCount,
      // `baseline.calibrationFeatureIds` are run-scoped feature ids; compare the
      // resolved training sessions instead. `reusedAssessmentCount` is omitted on
      // purpose: it is reuse telemetry (A resumes, B recomputes) and is asserted
      // separately as a reuse>0 proof, not as business output.
      calibrationSessions,
      calibrationStartAt: summary.baseline?.calibrationStartAt ?? null,
      calibrationEndAt: summary.baseline?.calibrationEndAt ?? null,
      dimensions: summary.baseline?.dimensions ?? null
    },
    featureRun: {
      featureConfig,
      featureConfigHash: modelRun.featureConfigHash,
      featureSchemaVersion: modelRun.featureSchemaVersion,
      canonicalContractVersion: modelRun.canonicalContractVersion
    }
  };

  /**
   * `fitnessEpochId` / `calibrationCohortHash` 是**原始持久值**，这里不做任何语义
   * 替换：增量 A 与全量 B 必须在这些字段上逐字节相等。run 分区 feature id 的
   * 关系映射只作用于 `featureIds` / `calibrationFeatureIds`（见 `mapFeatureIdArrays`），
   * hash 本身必须保持 raw；`model_v2_runs.lineage_hash` 的自证仍然执行。
   */
  const assessmentRowsBusiness = assessmentRows;
  // daily 行的 epoch 字段同样直接比较原始持久值。
  const dailyRowsBusiness = dailyRows;

  // ---- model_v2_runs：hash 自证 + lineage 业务内容（只去掉 sourceRunId） ----
  const lineageRow = getOf<Record<string, unknown>>(db, `
    SELECT engine_version AS engineVersion, config_version AS configVersion,
           lineage_json AS lineageJson, lineage_hash AS lineageHash
    FROM model_v2_runs WHERE model_run_id = ?`, modelRunId);
  if (lineageRow === undefined) throw new Error("model_v2_runs lineage row missing");
  const lineage = parseJsonColumn(lineageRow.lineageJson, "model_v2_runs.lineage_json");
  if (semanticHash(lineage) !== lineageRow.lineageHash) {
    throw new Error("model_v2_runs.lineage_hash does not verify its own lineage_json");
  }

  // ---- model_domain_snapshots：5 个域的封存 payload，递归比较 ----
  const releases = new SqliteModelReleaseRepository(db);
  const projectSnapshotRows = (rows: ReturnType<SqliteModelReleaseRepository["snapshots"]>) => rows.map((row) => ({
    domain: row.domain,
    snapshotKey: row.key,
    asOf: row.asOf,
    payload: stripExecutionIdentity(mapZoneProfileIds(mapFeatureIdArrays(
      parseJsonColumnsDeep(row.payload, `model_domain_snapshots[${row.domain}/${row.key}]`),
      featureSessionByIdGlobal,
      `model_domain_snapshots[${row.domain}/${row.key}]`
    ), zoneProfileDateById, `model_domain_snapshots[${row.domain}/${row.key}]`))
  }));
  const snapshots = releases.snapshots(modelRunId);
  const domains = new Set(snapshots.map((row) => row.domain));
  for (const domain of REQUIRED_MODEL_DOMAINS) {
    if (!domains.has(domain)) throw new Error(`model_domain_snapshots: required domain ${domain} is missing`);
  }
  const snapshotRows = projectSnapshotRows(snapshots);

  // ---- 发布投影：bundle / evaluation / active 指针 / 可读状态 ----
  // run id 是执行身份，A/B 两个库必然不同；用稳定的插入序号做逻辑身份。
  const runOrder = allOf<{ id: string }>(db, "SELECT id FROM model_runs ORDER BY rowid");
  const runOrdinalById = new Map(runOrder.map((row, index) => [String(row.id), index + 1] as const));
  const ordinalOf = (id: unknown, context: string): number => {
    const ordinal = runOrdinalById.get(String(id));
    if (ordinal === undefined) throw new Error(`${context}: run id ${String(id)} is not in model_runs`);
    return ordinal;
  };
  const bundleRows = allOf<Record<string, unknown>>(db, `
    SELECT model_run_id AS modelRunId, base_model_run_id AS baseModelRunId,
           dataset_version AS datasetVersion, snapshot_hash AS snapshotHash,
           evaluation_json AS evaluationJson, status, created_at AS createdAt,
           activated_at AS activatedAt
    FROM model_release_bundles ORDER BY rowid`).map((row) => {
    const runId = String(row.modelRunId);
    const projectedSnapshots = projectSnapshotRows(releases.snapshots(runId));
    const evaluation = replaceRunIds(
      stripExecutionIdentity(parseJsonColumnsDeep(
        parseJsonColumn(row.evaluationJson, `model_release_bundles[${runId}].evaluation_json`),
        `model_release_bundles[${runId}].evaluation_json`
      )),
      runOrdinalById
    );
    return {
      runOrdinal: ordinalOf(runId, "model_release_bundles.model_run_id"),
      baseRunOrdinal: row.baseModelRunId === null ? null : ordinalOf(row.baseModelRunId, "model_release_bundles.base_model_run_id"),
      datasetVersion: row.datasetVersion,
      status: row.status,
      // 原始 snapshot_hash 覆盖 run 分区行 id ⇒ 两库不可直接比；投影哈希用
      // 去掉执行身份后的同一组封存 payload 重新计算，bundle 自证仍由 releases.snapshots() 完成。
      snapshotProjectionHash: semanticHash(projectedSnapshots),
      snapshotDomains: projectedSnapshots.map((snapshot) =>
        `${String(snapshot.domain)}/${String(snapshot.snapshotKey)}@${String(snapshot.asOf)}`),
      evaluation,
      createdAt: row.createdAt,
      // `activated_at` 是**执行墙钟**（两个独立库不可能同毫秒）；发布事实用布尔值比较。
      activated: row.activatedAt !== null
    };
  });
  const activeRun = getOf<{ id: string; activatedAt: string | null }>(db,
    "SELECT model_run_id AS id, activated_at AS activatedAt FROM active_model_run WHERE singleton = 1");
  const activeRelease = getOf<{ id: string }>(db,
    "SELECT model_run_id AS id FROM active_model_release WHERE singleton = 1");
  const factView = readFactReadView(db, { factRows: 100, analysisRows: 100 });
  const activeBundle = bundleRows.find((row) =>
    activeRun !== undefined && row.runOrdinal === ordinalOf(activeRun.id, "active_model_run.model_run_id"));
  const readableStateRows = activeRun === undefined ? [] : [{
    singleton: "active",
    activeRunOrdinal: ordinalOf(activeRun.id, "active_model_run.model_run_id"),
    activeReleaseOrdinal: activeRelease === undefined ? null : ordinalOf(activeRelease.id, "active_model_release.model_run_id"),
    activePublished: activeRun.activatedAt !== null,
    bundleStatus: activeBundle?.status ?? null,
    readableDomains: activeBundle?.snapshotDomains ?? [],
    analysisStatus: factView.analysisStatus,
    freshness: {
      stale: factView.freshness.stale,
      reason: factView.freshness.reason,
      versions: {
        facts: factView.freshness.versions.facts,
        analysis: factView.freshness.versions.analysis,
        releaseOrdinal: factView.freshness.versions.releaseId === null
          ? null
          : ordinalOf(factView.freshness.versions.releaseId, "freshness.versions.releaseId")
      }
    }
  }];

  // ---- 输入绑定/覆盖（v39）：只在直连车道写；CLI 全量为空表 ----  ----
  const binding = getOf<Record<string, unknown>>(db, `
    SELECT job_id AS jobId, scope, dataset_version AS datasetVersion,
           captured_raw_generation AS capturedRawGeneration,
           captured_dependency_generation AS capturedDependencyGeneration,
           target_raw_generation AS targetRawGeneration,
           target_dependency_generation AS targetDependencyGeneration,
           timezone_identifier AS timezoneIdentifier,
           override_digest AS overrideDigest, config_digest AS configDigest,
           cutoff_at AS cutoffAt
    FROM analysis_run_input_bindings WHERE run_id = ?`, modelRunId);
  // `input_digest` / `executed_plan_json` / incumbent / job / run ids are excluded:
  // they contain run-scoped identities or the incremental-vs-rebuild execution strategy,
  // not the business input. `executed_plan_json` is asserted separately by the direct-lane
  // test (partial vs rebuild) so it cannot silently disappear.
  const bindingRows = binding === undefined ? [] : [{
    singleton: "binding",
    scope: binding.scope,
    datasetVersion: binding.datasetVersion,
    capturedRawGeneration: binding.capturedRawGeneration,
    capturedDependencyGeneration: binding.capturedDependencyGeneration,
    targetRawGeneration: binding.targetRawGeneration,
    targetDependencyGeneration: binding.targetDependencyGeneration,
    timezoneIdentifier: binding.timezoneIdentifier,
    overrideDigest: binding.overrideDigest,
    configDigest: binding.configDigest,
    cutoffAt: binding.cutoffAt
  }];
  const coverageRows = binding === undefined ? [] : allOf<Record<string, unknown>>(db, `
    SELECT import_batch_id AS importBatchId,
           dependency_generation_from AS dependencyGenerationFrom,
           dependency_generation_to AS dependencyGenerationTo
    FROM analysis_job_coverage WHERE job_id = ?
    ORDER BY import_batch_id`, String(binding.jobId));

  return {
    tables: [
      { name: "workout_features", keyFields: ["trainingSessionId"], rows: featureRows },
      { name: "workout_training_loads", keyFields: ["trainingSessionId"], rows: loadRows },
      { name: "workout_zone_summaries", keyFields: ["trainingSessionId"], rows: zoneSummaryRows },
      { name: "daily_zone_profiles", keyFields: ["localDate"], rows: dailyZoneRows },
      { name: "daily_training_metrics", keyFields: ["localDate"], rows: dailyLoadRows },
      { name: "training_sessions", keyFields: ["trainingSessionId"], rows: trainingSessionRows },
      {
        name: "ability_assessments",
        keyFields: ["trainingSessionId", "sequenceNumber"],
        rows: assessmentRowsBusiness
      },
      {
        name: "daily_ability_snapshots",
        keyFields: ["localDate"],
        rows: dailyRowsBusiness,
        references: [{ field: "lastAssessmentRef", table: "ability_assessments" }]
      },
      { name: "model_runs", keyFields: ["singleton"], rows: [modelRunRow] },
      {
        name: "model_v2_runs",
        keyFields: ["singleton"],
        rows: [{
          singleton: "lineage",
          engineVersion: lineageRow.engineVersion,
          configVersion: lineageRow.configVersion,
          // 只去掉 `sourceRunId`（run 执行身份）；其余 lineage 字段（datasetVersion、
          // factsSnapshotHash、overrideSnapshotHash、版本/配置/hash、时区、asOf、
          // dataThroughAt）全部保留比较。baselineEpochId / calibrationCohortHash 保持原始值。
          lineage: stripExecutionIdentity(lineage)
        }]
      },
      { name: "model_domain_snapshots", keyFields: ["domain", "snapshotKey"], rows: snapshotRows },
      { name: "model_release_bundles", keyFields: ["runOrdinal"], rows: bundleRows },
      { name: "release_readable_state", keyFields: ["singleton"], rows: readableStateRows },
      { name: "analysis_run_input_bindings", keyFields: ["singleton"], rows: bindingRows },
      { name: "analysis_job_coverage", keyFields: ["importBatchId"], rows: coverageRows }
    ]
  };
}

/** Textual key used in diff reports. */
export function describeKey(table: BusinessTable, row: Record<string, unknown>): string {
  return table.keyFields.map((field) => `${field}=${JSON.stringify(row[field] ?? null)}`).join("|");
}

function compareValue(
  sink: BusinessDiff[],
  table: string,
  key: string,
  field: string,
  actual: unknown,
  expected: unknown
): void {
  const push = (kind: BusinessDiffKind, message: string): void => {
    sink.push({ table, key, field, kind, message });
  };
  if (actual === undefined) {
    push("missing_field", `missing field ${field} (expected ${JSON.stringify(expected)})`);
    return;
  }
  if (expected === undefined) {
    push("unknown_field", `unknown output field ${field} (actual ${JSON.stringify(actual)})`);
    return;
  }
  if (actual === null || expected === null) {
    if (actual !== expected) push("value", `${field}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
    return;
  }
  const actualIsNumber = typeof actual === "number";
  const expectedIsNumber = typeof expected === "number";
  if (actualIsNumber || expectedIsNumber) {
    if (!actualIsNumber || !expectedIsNumber) {
      push("value", `${field}: type ${typeof actual} !== ${typeof expected}`);
      return;
    }
    if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
      push("non_finite", `${field}: non-finite value ${String(actual)} / ${String(expected)}`);
      return;
    }
    if (Number.isInteger(actual) && Number.isInteger(expected)) {
      if (actual !== expected) push("value", `${field}: ${String(actual)} !== ${String(expected)} (integer must be exact)`);
      return;
    }
    if (Math.abs(actual - expected) > 1e-9 * Math.max(1, Math.abs(actual), Math.abs(expected))) {
      push("value", `${field}: ${String(actual)} vs ${String(expected)} exceeds 1e-9 relative tolerance`);
    }
    return;
  }
  if (typeof actual !== typeof expected) {
    push("value", `${field}: type ${typeof actual} !== ${typeof expected}`);
    return;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      push("value", `${field}: array vs non-array`);
      return;
    }
    if (actual.length !== expected.length) {
      push("value", `${field}: array length ${actual.length} !== ${expected.length}`);
    }
    for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
      compareValue(sink, table, key, `${field}[${index}]`, actual[index], expected[index]);
    }
    return;
  }
  if (typeof actual === "object") {
    const actualObject = actual as Record<string, unknown>;
    const expectedObject = expected as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(actualObject), ...Object.keys(expectedObject)])].sort();
    for (const child of keys) {
      compareValue(sink, table, key, `${field}.${child}`, actualObject[child], expectedObject[child]);
    }
    return;
  }
  if (actual !== expected) push("value", `${field}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

function validateReferences(
  sink: BusinessDiff[],
  table: BusinessTable,
  rows: ReadonlyArray<Record<string, unknown>>,
  tablesByName: ReadonlyMap<string, BusinessTable>
): void {
  for (const reference of table.references ?? []) {
    const target = tablesByName.get(reference.table);
    if (target === undefined) {
      sink.push({
        table: table.name, key: "*", field: reference.field, kind: "missing_table",
        message: `reference target table ${reference.table} is absent`
      });
      continue;
    }
    const targetKeys = new Set<string>();
    for (const targetRow of target.rows) {
      const key = rowKey(target, targetRow);
      if (key !== null) targetKeys.add(key);
    }
    for (const row of rows) {
      const value = row[reference.field];
      if (value === null || value === undefined) continue;
      if (typeof value !== "string" || !targetKeys.has(value)) {
        sink.push({
          table: table.name,
          key: describeKey(table, row),
          field: reference.field,
          kind: "dangling_reference",
          message: `${reference.field}=${JSON.stringify(value)} does not resolve in ${reference.table}`
        });
      }
    }
  }
}

/**
 * 逐表／逐键／逐字段比较。返回**全部**差异（调用方负责格式化/断言）。
 *
 * 行集合严格相等：缺行、多行、重复键、未知字段都是差异，不是一个"跳过"。
 */
export function compareBusinessProjections(actual: BusinessProjection, expected: BusinessProjection): BusinessDiff[] {
  const diffs: BusinessDiff[] = [];
  const actualTables = new Map(actual.tables.map((table) => [table.name, table]));
  const expectedTables = new Map(expected.tables.map((table) => [table.name, table]));
  if (actualTables.size !== actual.tables.length) diffs.push({
    table: "*", key: "*", field: "*", kind: "duplicate_key", message: "duplicate table names in actual projection"
  });
  if (expectedTables.size !== expected.tables.length) diffs.push({
    table: "*", key: "*", field: "*", kind: "duplicate_key", message: "duplicate table names in expected projection"
  });
  for (const name of [...new Set([...actualTables.keys(), ...expectedTables.keys()])].sort()) {
    const actualTable = actualTables.get(name);
    const expectedTable = expectedTables.get(name);
    if (actualTable === undefined) {
      diffs.push({ table: name, key: "*", field: "*", kind: "missing_table", message: `missing table ${name}` });
      continue;
    }
    if (expectedTable === undefined) {
      diffs.push({ table: name, key: "*", field: "*", kind: "extra_table", message: `unknown output table ${name}` });
      continue;
    }
    if (actualTable.keyFields.join("\u0001") !== expectedTable.keyFields.join("\u0001")) {
      diffs.push({
        table: name, key: "*", field: "*", kind: "value",
        message: `key fields ${actualTable.keyFields.join(",")} !== ${expectedTable.keyFields.join(",")}`
      });
      continue;
    }
    const actualRows = new Map<string, Record<string, unknown>>();
    for (const row of actualTable.rows) {
      const key = rowKey(actualTable, row);
      if (key === null) {
        diffs.push({ table: name, key: "*", field: "*", kind: "value", message: "row is missing a declared key field" });
        continue;
      }
      if (actualRows.has(key)) {
        diffs.push({ table: name, key, field: "*", kind: "duplicate_key", message: `duplicate row key ${key} in actual` });
        continue;
      }
      actualRows.set(key, row);
    }
    const expectedRows = new Map<string, Record<string, unknown>>();
    for (const row of expectedTable.rows) {
      const key = rowKey(expectedTable, row);
      if (key === null) {
        diffs.push({ table: name, key: "*", field: "*", kind: "value", message: "row is missing a declared key field" });
        continue;
      }
      if (expectedRows.has(key)) {
        diffs.push({ table: name, key, field: "*", kind: "duplicate_key", message: `duplicate row key ${key} in expected` });
        continue;
      }
      expectedRows.set(key, row);
    }
    for (const key of [...new Set([...actualRows.keys(), ...expectedRows.keys()])].sort()) {
      const actualRow = actualRows.get(key);
      const expectedRow = expectedRows.get(key);
      if (actualRow === undefined) {
        diffs.push({ table: name, key, field: "*", kind: "missing_row", message: `missing row ${key}` });
        continue;
      }
      if (expectedRow === undefined) {
        diffs.push({ table: name, key, field: "*", kind: "extra_row", message: `extra row ${key}` });
        continue;
      }
      const fields = [...new Set([...Object.keys(actualRow), ...Object.keys(expectedRow)])].sort();
      for (const field of fields) {
        compareValue(diffs, name, key, field, actualRow[field], expectedRow[field]);
      }
    }
    validateReferences(diffs, actualTable, actualTable.rows, actualTables);
    validateReferences(diffs, expectedTable, expectedTable.rows, expectedTables);
  }
  return diffs;
}

export function formatBusinessDiffs(diffs: readonly BusinessDiff[], limit = 60): string {
  const lines = diffs.slice(0, limit).map((diff) =>
    `${diff.table}[${diff.key}].${diff.field}: ${diff.kind}: ${diff.message}`);
  if (diffs.length > limit) lines.push(`... ${diffs.length - limit} more differences`);
  return lines.join("\n");
}

/** Throws with a per-table/per-key/per-field report when any difference exists. */
export function assertBusinessEquivalent(actual: BusinessProjection, expected: BusinessProjection, context = "business projection"): void {
  const diffs = compareBusinessProjections(actual, expected);
  if (diffs.length > 0) {
    throw new Error(`${context}: ${diffs.length} business difference(s)\n${formatBusinessDiffs(diffs)}`);
  }
}

export interface ProjectionTableStats {
  readonly rows: number;
  readonly columns: ReadonlyArray<string>;
  readonly leafValues: number;
}

function countLeaves(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countLeaves(item), 0);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>((sum, child) => sum + countLeaves(child), 0);
  }
  return 1;
}

/** Evidence helper: row counts, top-level columns and leaf values per table. */
export function projectionStats(projection: BusinessProjection): Record<string, ProjectionTableStats> {
  const stats: Record<string, ProjectionTableStats> = {};
  for (const table of projection.tables) {
    const columns = new Set<string>();
    let leafValues = 0;
    for (const row of table.rows) {
      for (const field of Object.keys(row)) columns.add(field);
      leafValues += countLeaves(row);
    }
    stats[table.name] = { rows: table.rows.length, columns: [...columns].sort(), leafValues };
  }
  return stats;
}
