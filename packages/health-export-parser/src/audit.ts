import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { healthTypes, workoutTypes } from "@rai/contracts";

import { distanceToKilometers } from "./utils.js";

interface CountRow {
  count: number;
}

interface HeartRateEvidenceRow extends CountRow {
  firstAt: string | null;
  lastAt: string | null;
}

interface GroupedCountRow {
  key: string;
  count: number;
}

interface RunningRow {
  id: string;
  sourceCategory: string;
  startAt: string;
  durationSeconds: number;
  indoor: number | null;
  distanceValue: number | null;
  distanceUnit: string | null;
  heartRateStatisticCount: number;
  routeCount: number;
}

interface InventoryRow {
  entityType: string;
  itemCount: number;
  firstAt: string | null;
  lastAt: string | null;
  detailsJson: string;
}

type SqlValue = string | number | bigint | Uint8Array | null;

export interface DistributionSummary {
  minimum: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  maximum: number | null;
}

export interface DataAudit {
  generatedAt: string;
  datasetVersion: string | null;
  privacy: string;
  totals: {
    parsedRecords: number;
    uniqueRecords: number;
    exactDuplicateRecords: number;
    workouts: number;
    activitySummaries: number;
    routeFiles: number;
    routePoints: number;
    importIssues: number;
  };
  running: {
    rawWorkouts: number;
    canonicalWorkouts: number;
    duplicateGroups: number;
    excludedDuplicates: number;
    rawBySourceCategory: Record<string, number>;
    canonicalBySourceCategory: Record<string, number>;
    byYear: Record<string, number>;
    indoor: number;
    outdoor: number;
    indoorUnknown: number;
    withRoute: number;
    distanceKilometers: DistributionSummary;
    durationMinutes: DistributionSummary;
    paceMinutesPerKilometer: DistributionSummary;
  };
  readiness: {
    goldAppleWatchOutdoor: number;
    extendedCanonicalOutdoor: number;
    canonicalWithHeartRateEvidence: number;
    exclusionReasons: Record<string, number>;
  };
  workoutStatisticCoverage: Record<string, number>;
  relevantHealthRecords: Array<{
    type: string;
    count: number;
    firstMonth: string | null;
    lastMonth: string | null;
    units: string[];
    sourceCategories: string[];
  }>;
  conclusions: string[];
  limitations: string[];
}

const friendlyMetricNames: Record<string, string> = {
  [healthTypes.activeEnergy]: "active_energy",
  [healthTypes.distanceWalkingRunning]: "distance",
  [healthTypes.heartRate]: "heart_rate",
  [healthTypes.runningGroundContactTime]: "ground_contact_time",
  [healthTypes.runningPower]: "running_power",
  [healthTypes.runningSpeed]: "running_speed",
  [healthTypes.runningStrideLength]: "stride_length",
  [healthTypes.runningVerticalOscillation]: "vertical_oscillation",
  [healthTypes.stepCount]: "step_count"
};

const relevantRecordTypes = new Set<string>([
  healthTypes.activeEnergy,
  healthTypes.distanceWalkingRunning,
  healthTypes.heartRate,
  healthTypes.heartRateRecoveryOneMinute,
  healthTypes.hrvSdnn,
  healthTypes.physicalEffort,
  healthTypes.restingHeartRate,
  healthTypes.runningGroundContactTime,
  healthTypes.runningPower,
  healthTypes.runningSpeed,
  healthTypes.runningStrideLength,
  healthTypes.runningVerticalOscillation,
  healthTypes.sleepAnalysis,
  healthTypes.stepCount,
  healthTypes.vo2Max
]);

function scalarCount(database: DatabaseSync, sql: string, ...params: SqlValue[]): number {
  const row = database.prepare(sql).get(...params) as unknown as CountRow | undefined;
  return Number(row?.count ?? 0);
}

function groupedCounts(
  database: DatabaseSync,
  sql: string,
  ...params: SqlValue[]
): Record<string, number> {
  const rows = database.prepare(sql).all(...params) as unknown as GroupedCountRow[];
  return Object.fromEntries(rows.map((row) => [String(row.key), Number(row.count)]));
}

function quantile(sorted: number[], probability: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return null;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function distribution(values: number[]): DistributionSummary {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    minimum: sorted.at(0) ?? null,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    maximum: sorted.at(-1) ?? null
  };
}

function roundDistribution(summary: DistributionSummary): DistributionSummary {
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [
      key,
      value === null ? null : Math.round(value * 100) / 100
    ])
  ) as unknown as DistributionSummary;
}

function loadCanonicalRunningRows(database: DatabaseSync): RunningRow[] {
  return database
    .prepare(`
      SELECT
        w.id,
        w.source_category AS sourceCategory,
        w.start_at AS startAt,
        w.duration_seconds AS durationSeconds,
        w.indoor,
        (
          SELECT ws.sum_value FROM workout_statistics ws
          WHERE ws.workout_id = w.id AND ws.type = ?
          ORDER BY ws.ordinal LIMIT 1
        ) AS distanceValue,
        (
          SELECT ws.unit FROM workout_statistics ws
          WHERE ws.workout_id = w.id AND ws.type = ?
          ORDER BY ws.ordinal LIMIT 1
        ) AS distanceUnit,
        (
          SELECT COUNT(*) FROM workout_statistics ws
          WHERE ws.workout_id = w.id AND ws.type = ?
        ) AS heartRateStatisticCount,
        (SELECT COUNT(*) FROM workout_routes wr WHERE wr.workout_id = w.id) AS routeCount
      FROM workouts w
      WHERE w.activity_type = ? AND w.is_canonical = 1
      ORDER BY w.start_at
    `)
    .all(
      healthTypes.distanceWalkingRunning,
      healthTypes.distanceWalkingRunning,
      healthTypes.heartRate,
      workoutTypes.running
    ) as unknown as RunningRow[];
}

function hasHeartRateEvidence(
  database: DatabaseSync,
  workout: RunningRow
): boolean {
  if (workout.heartRateStatisticCount > 0) return true;
  const row = database
    .prepare(
      `
        SELECT
          COUNT(*) AS count,
          MIN(hr.start_at) AS firstAt,
          MAX(hr.end_at) AS lastAt
        FROM health_records hr
        JOIN workouts w ON w.id = ?
        WHERE hr.type = ?
          AND (
            hr.source_name = w.source_name
            OR (
              NOT EXISTS (
                SELECT 1 FROM health_records same
                WHERE same.type = hr.type
                  AND same.source_name = w.source_name
                  AND same.start_at <= w.end_at
                  AND same.end_at >= w.start_at
              )
              AND hr.source_category IN ('apple_watch', 'apple_phone', 'coros', 'huawei', 'connect', 'other')
            )
          )
          AND hr.start_at <= w.end_at
          AND hr.end_at >= w.start_at
      `
    )
    .get(workout.id, healthTypes.heartRate) as unknown as
    | HeartRateEvidenceRow
    | undefined;
  const sampleCount = Number(row?.count ?? 0);
  if (sampleCount < 10 || !row?.firstAt || !row.lastAt) return false;

  const workoutDuration = Math.max(1, workout.durationSeconds);
  const sampleSpan = Math.max(0, Date.parse(row.lastAt) - Date.parse(row.firstAt)) / 1000;
  const spanCoverage = sampleSpan / workoutDuration;
  const samplesPerMinute = sampleCount / (workoutDuration / 60);
  return spanCoverage >= 0.7 && samplesPerMinute >= 0.5;
}

function manifestNumber(database: DatabaseSync, key: string): number {
  const row = database
    .prepare("SELECT value FROM import_manifest WHERE key = ?")
    .get(key) as unknown as { value: string } | undefined;
  const value = Number(row?.value);
  return Number.isFinite(value) ? value : 0;
}

function formatNumber(value: number | null, suffix = ""): string {
  return value === null ? "-" : `${value.toFixed(2)}${suffix}`;
}

function sourceTable(values: Record<string, number>): string {
  return Object.entries(values)
    .sort((left, right) => right[1] - left[1])
    .map(([source, count]) => `| ${source} | ${count} |`)
    .join("\n");
}

export function buildAudit(database: DatabaseSync): DataAudit {
  const canonicalRows = loadCanonicalRunningRows(database);
  const distanceValues: number[] = [];
  const durationValues: number[] = [];
  const paceValues: number[] = [];
  const exclusionReasons: Record<string, number> = {};
  let withHeartRateEvidence = 0;
  let extendedCanonicalOutdoor = 0;
  let goldAppleWatchOutdoor = 0;

  for (const row of canonicalRows) {
    const distance = distanceToKilometers(row.distanceValue, row.distanceUnit);
    const durationMinutes = row.durationSeconds / 60;
    const hasHeartRate = hasHeartRateEvidence(database, row);
    const pace = distance !== null && distance > 0 ? durationMinutes / distance : null;

    if (distance !== null) distanceValues.push(distance);
    durationValues.push(durationMinutes);
    if (pace !== null) paceValues.push(pace);
    if (hasHeartRate) withHeartRateEvidence += 1;

    const reasons: string[] = [];
    if (distance === null) reasons.push("missing_distance");
    else if (distance < 1) reasons.push("distance_below_1km");
    if (row.durationSeconds < 480) reasons.push("duration_below_8min");
    if (!hasHeartRate) reasons.push("insufficient_heart_rate");
    if (row.indoor === 1) reasons.push("indoor_workout");
    if (row.indoor === null) reasons.push("indoor_status_unknown");
    if (pace !== null && (pace < 2.5 || pace > 15)) reasons.push("implausible_average_pace");

    for (const reason of reasons) {
      exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
    }

    const coreReady =
      distance !== null &&
      distance >= 1 &&
      row.durationSeconds >= 480 &&
      hasHeartRate &&
      row.indoor === 0 &&
      pace !== null &&
      pace >= 2.5 &&
      pace <= 15;
    if (coreReady) {
      extendedCanonicalOutdoor += 1;
      if (row.sourceCategory === "apple_watch") goldAppleWatchOutdoor += 1;
    }
  }

  const statisticRows = database
    .prepare(`
      SELECT ws.type AS key, COUNT(DISTINCT ws.workout_id) AS count
      FROM workout_statistics ws
      JOIN workouts w ON w.id = ws.workout_id
      WHERE w.activity_type = ? AND w.is_canonical = 1
      GROUP BY ws.type
      ORDER BY count DESC
    `)
    .all(workoutTypes.running) as unknown as GroupedCountRow[];
  const statisticCoverage = Object.fromEntries(
    statisticRows.map((row) => [friendlyMetricNames[row.key] ?? row.key, Number(row.count)])
  );

  const inventoryRows = database
    .prepare(`
      SELECT
        entity_type AS entityType,
        item_count AS itemCount,
        first_at AS firstAt,
        last_at AS lastAt,
        details_json AS detailsJson
      FROM entity_inventory
      WHERE entity_kind = 'record'
      ORDER BY item_count DESC
    `)
    .all() as unknown as InventoryRow[];
  const relevantHealthRecords = inventoryRows
    .filter((row) => relevantRecordTypes.has(row.entityType))
    .map((row) => {
      const details = JSON.parse(row.detailsJson) as {
        units?: string[];
        sourceCategories?: string[];
      };
      return {
        type: friendlyMetricNames[row.entityType] ?? row.entityType,
        count: Number(row.itemCount),
        firstMonth: row.firstAt?.slice(0, 7) ?? null,
        lastMonth: row.lastAt?.slice(0, 7) ?? null,
        units: details.units ?? [],
        sourceCategories: details.sourceCategories ?? []
      };
    });

  const rawCount = scalarCount(
    database,
    "SELECT COUNT(*) AS count FROM workouts WHERE activity_type = ?",
    workoutTypes.running
  );
  const canonicalCount = canonicalRows.length;
  const duplicateGroups = scalarCount(
    database,
    "SELECT COUNT(*) AS count FROM workout_groups WHERE member_count > 1"
  );
  const routeFiles = scalarCount(database, "SELECT COUNT(*) AS count FROM workout_routes");
  const parsedRecords = manifestNumber(database, "record_count");
  const uniqueRecords = scalarCount(
    database,
    "SELECT COUNT(*) AS count FROM health_records"
  );

  return {
    generatedAt: new Date().toISOString(),
    datasetVersion: (database.prepare(
      "SELECT value FROM import_manifest WHERE key = 'dataset_version'"
    ).get() as unknown as { value: string } | undefined)?.value ?? null,
    privacy:
      "This report contains aggregate counts only. Raw source names, health values, timestamps, and coordinates are intentionally omitted.",
    totals: {
      parsedRecords,
      uniqueRecords,
      exactDuplicateRecords: Math.max(0, parsedRecords - uniqueRecords),
      workouts: scalarCount(database, "SELECT COUNT(*) AS count FROM workouts"),
      activitySummaries: scalarCount(
        database,
        "SELECT COUNT(*) AS count FROM activity_summaries"
      ),
      routeFiles,
      routePoints: scalarCount(database, "SELECT COUNT(*) AS count FROM route_points"),
      importIssues: scalarCount(database, "SELECT COUNT(*) AS count FROM import_issues")
    },
    running: {
      rawWorkouts: rawCount,
      canonicalWorkouts: canonicalCount,
      duplicateGroups,
      excludedDuplicates: rawCount - canonicalCount,
      rawBySourceCategory: groupedCounts(
        database,
        `SELECT source_category AS key, COUNT(*) AS count
         FROM workouts WHERE activity_type = ? GROUP BY source_category`,
        workoutTypes.running
      ),
      canonicalBySourceCategory: groupedCounts(
        database,
        `SELECT source_category AS key, COUNT(*) AS count
         FROM workouts WHERE activity_type = ? AND is_canonical = 1
         GROUP BY source_category`,
        workoutTypes.running
      ),
      byYear: groupedCounts(
        database,
        `SELECT substr(start_at, 1, 4) AS key, COUNT(*) AS count
         FROM workouts WHERE activity_type = ? AND is_canonical = 1
         GROUP BY substr(start_at, 1, 4) ORDER BY key`,
        workoutTypes.running
      ),
      indoor: scalarCount(
        database,
        "SELECT COUNT(*) AS count FROM workouts WHERE activity_type = ? AND is_canonical = 1 AND indoor = 1",
        workoutTypes.running
      ),
      outdoor: scalarCount(
        database,
        "SELECT COUNT(*) AS count FROM workouts WHERE activity_type = ? AND is_canonical = 1 AND indoor = 0",
        workoutTypes.running
      ),
      indoorUnknown: scalarCount(
        database,
        "SELECT COUNT(*) AS count FROM workouts WHERE activity_type = ? AND is_canonical = 1 AND indoor IS NULL",
        workoutTypes.running
      ),
      withRoute: scalarCount(
        database,
        `SELECT COUNT(DISTINCT w.id) AS count FROM workouts w
         JOIN workout_routes wr ON wr.workout_id = w.id
         WHERE w.activity_type = ? AND w.is_canonical = 1 AND wr.file_status = 'imported'`,
        workoutTypes.running
      ),
      distanceKilometers: roundDistribution(distribution(distanceValues)),
      durationMinutes: roundDistribution(distribution(durationValues)),
      paceMinutesPerKilometer: roundDistribution(distribution(paceValues))
    },
    readiness: {
      goldAppleWatchOutdoor,
      extendedCanonicalOutdoor,
      canonicalWithHeartRateEvidence: withHeartRateEvidence,
      exclusionReasons
    },
    workoutStatisticCoverage: statisticCoverage,
    relevantHealthRecords,
    conclusions: [
      `导出中共有 ${rawCount} 条 Running Workout，经保守的时间重叠和距离匹配后形成 ${canonicalCount} 个 canonical 跑步组。`,
      `${goldAppleWatchOutdoor} 次 canonical Apple Watch 户外跑同时满足距离、时长、心率和合理配速条件，可作为最高质量的初始验证队列。`,
      `${extendedCanonicalOutdoor} 次跨来源 canonical 户外跑满足同一组核心条件，可作为扩展验证队列，但必须控制来源偏差。`,
      "Apple Watch 跑步拥有最完整的路线和跑姿指标；旧设备及第三方记录不能在没有来源置信度的情况下与其等价混合。",
      "睡眠、静息心率和 HRV 均存在，但时间覆盖不完全；恢复维度缺失时必须重分配权重，不能默认填入 50 分。"
    ],
    limitations: [
      "Apple Health XML does not expose the same object associations available to live HealthKit queries. Time-series-to-workout links are inferred by source and time overlap.",
      "Near-duplicate grouping is conservative and must remain reviewable; no raw workout is deleted.",
      "Indoor/outdoor metadata is missing for some imported sources. Unknown is kept separate from outdoor.",
      "ECG CSV files and export_cda.xml are intentionally out of scope for running ability scoring.",
      "No medical inference is made from heart-rate or recovery records."
    ]
  };
}

export function renderAuditMarkdown(audit: DataAudit): string {
  const relevantRows = audit.relevantHealthRecords
    .map(
      (item) =>
        `| ${item.type} | ${item.count} | ${item.firstMonth ?? "-"} | ${item.lastMonth ?? "-"} | ${item.units.join(", ") || "-"} |`
    )
    .join("\n");
  const coverageRows = Object.entries(audit.workoutStatisticCoverage)
    .sort((left, right) => right[1] - left[1])
    .map(([metric, count]) => `| ${metric} | ${count} |`)
    .join("\n");
  const reasonRows = Object.entries(audit.readiness.exclusionReasons)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join("\n");

  return `# Apple 健康导出数据审计

> 生成时间：${audit.generatedAt}  
> 数据集版本：${audit.datasetVersion ?? "-"}  
> 隐私：本报告只包含聚合统计，不包含原始来源名称、健康值、精确时间或路线坐标。

## 1. 数据总览

| 对象 | 数量 |
|---|---:|
| 解析到的 Health records | ${audit.totals.parsedRecords} |
| 稳定 ID 去重后的 Health records | ${audit.totals.uniqueRecords} |
| 完全相同的 record 副本 | ${audit.totals.exactDuplicateRecords} |
| Workouts | ${audit.totals.workouts} |
| Activity summaries | ${audit.totals.activitySummaries} |
| GPX routes | ${audit.totals.routeFiles} |
| GPX points | ${audit.totals.routePoints} |
| Import issues | ${audit.totals.importIssues} |

## 2. 跑步数据

| 指标 | 数值 |
|---|---:|
| 原始 Running Workout | ${audit.running.rawWorkouts} |
| 去重后的 canonical 跑步 | ${audit.running.canonicalWorkouts} |
| 重复组 | ${audit.running.duplicateGroups} |
| 排除的重复副本 | ${audit.running.excludedDuplicates} |
| 户外 | ${audit.running.outdoor} |
| 室内 | ${audit.running.indoor} |
| 室内/户外未知 | ${audit.running.indoorUnknown} |
| 有可用路线 | ${audit.running.withRoute} |

### 原始来源类别

| 来源类别 | 数量 |
|---|---:|
${sourceTable(audit.running.rawBySourceCategory)}

### canonical 来源类别

| 来源类别 | 数量 |
|---|---:|
${sourceTable(audit.running.canonicalBySourceCategory)}

### 数值分布

| 指标 | 最小 | P25 | 中位数 | P75 | 最大 |
|---|---:|---:|---:|---:|---:|
| 距离 km | ${formatNumber(audit.running.distanceKilometers.minimum)} | ${formatNumber(audit.running.distanceKilometers.p25)} | ${formatNumber(audit.running.distanceKilometers.median)} | ${formatNumber(audit.running.distanceKilometers.p75)} | ${formatNumber(audit.running.distanceKilometers.maximum)} |
| 时长 min | ${formatNumber(audit.running.durationMinutes.minimum)} | ${formatNumber(audit.running.durationMinutes.p25)} | ${formatNumber(audit.running.durationMinutes.median)} | ${formatNumber(audit.running.durationMinutes.p75)} | ${formatNumber(audit.running.durationMinutes.maximum)} |
| 原始平均配速 min/km | ${formatNumber(audit.running.paceMinutesPerKilometer.minimum)} | ${formatNumber(audit.running.paceMinutesPerKilometer.p25)} | ${formatNumber(audit.running.paceMinutesPerKilometer.median)} | ${formatNumber(audit.running.paceMinutesPerKilometer.p75)} | ${formatNumber(audit.running.paceMinutesPerKilometer.maximum)} |

## 3. 模型可用性

| 队列 | 数量 | 用途 |
|---|---:|---|
| Gold：Apple Watch 户外 + 距离/时长/心率合格 | ${audit.readiness.goldAppleWatchOutdoor} | 初始高质量校准与公式验证 |
| Extended：全部来源 canonical 户外 + 核心数据合格 | ${audit.readiness.extendedCanonicalOutdoor} | 扩展样本、来源偏差分析 |
| canonical 且存在心率证据 | ${audit.readiness.canonicalWithHeartRateEvidence} | 心率效率可计算性检查 |

### 当前排除原因（可重叠）

| 原因 | 数量 |
|---|---:|
${reasonRows || "| 无 | 0 |"}

## 4. WorkoutStatistics 覆盖

| 指标 | canonical 跑步数 |
|---|---:|
${coverageRows}

## 5. 相关 Health Records

| 类型 | 数量 | 最早月份 | 最晚月份 | 单位 |
|---|---:|---|---|---|
${relevantRows}

## 6. 结论

${audit.conclusions.map((item) => `- ${item}`).join("\n")}

## 7. 限制

${audit.limitations.map((item) => `- ${item}`).join("\n")}
`;
}

export function writeAuditFiles(
  database: DatabaseSync,
  markdownPath: string,
  jsonPath: string
): DataAudit {
  const staged = stageAuditFiles(database, markdownPath, jsonPath);
  staged.commit();
  staged.finalize();
  return staged.audit;
}

export interface StagedAuditFiles {
  audit: DataAudit;
  commit(): void;
  rollback(): void;
  finalize(): void;
  discard(): void;
}

function writeDurableFile(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
  const descriptor = openSync(path, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function stageAuditFiles(
  database: DatabaseSync,
  markdownPath: string,
  jsonPath: string
): StagedAuditFiles {
  const audit = buildAudit(database);
  for (const path of [markdownPath, jsonPath]) {
    if (existsSync(path) && !statSync(path).isFile()) {
      throw new Error(`Audit output is not a file: ${path}`);
    }
  }
  mkdirSync(dirname(markdownPath), { recursive: true });
  mkdirSync(dirname(jsonPath), { recursive: true });
  const generation = randomUUID();
  const files = [
    {
      target: markdownPath,
      temporary: `${markdownPath}.pending.${generation}`,
      previous: `${markdownPath}.replaced.${generation}`,
      contents: renderAuditMarkdown(audit)
    },
    {
      target: jsonPath,
      temporary: `${jsonPath}.pending.${generation}`,
      previous: `${jsonPath}.replaced.${generation}`,
      contents: `${JSON.stringify(audit, null, 2)}\n`
    }
  ];
  for (const file of files) writeDurableFile(file.temporary, file.contents);
  let state: "prepared" | "published" | "settled" = "prepared";
  const displaced: typeof files = [];
  const published: typeof files = [];

  return {
    audit,
    commit() {
      if (state !== "prepared") throw new Error("Audit files are not prepared for publication");
      try {
        for (const file of files) {
          if (existsSync(file.target)) {
            renameSync(file.target, file.previous);
            displaced.push(file);
          }
          renameSync(file.temporary, file.target);
          published.push(file);
        }
      } catch (error) {
        for (const file of published.reverse()) {
          if (existsSync(file.target)) rmSync(file.target, { force: true });
        }
        for (const file of displaced.reverse()) {
          if (existsSync(file.previous)) renameSync(file.previous, file.target);
        }
        for (const file of files) {
          if (existsSync(file.temporary)) rmSync(file.temporary, { force: true });
        }
        state = "settled";
        throw error;
      }
      state = "published";
    },
    rollback() {
      if (state === "settled") return;
      if (state === "prepared") {
        for (const file of files) rmSync(file.temporary, { force: true });
        state = "settled";
        return;
      }
      for (const file of [...files].reverse()) {
        if (existsSync(file.target)) rmSync(file.target, { force: true });
        if (existsSync(file.previous)) renameSync(file.previous, file.target);
      }
      state = "settled";
    },
    finalize() {
      if (state !== "published") throw new Error("Audit files are not published");
      for (const file of displaced) {
        try {
          rmSync(file.previous, { force: true });
        } catch {
          // The published pair is complete; retain an undeletable old generation.
        }
      }
      state = "settled";
    },
    discard() {
      this.rollback();
    }
  };
}
