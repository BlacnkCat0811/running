// 阶段 6 确定性合成夹具（D0–D3 / DX）。
//
// 设计口径（实施方案 §4.3 / W2）：
//   · 数据由真实生产迁移建表，再用固定 seed 插入；不硬编码迁移版本、不复制个人数据。
//   · 每套 manifest 记录**实际行数**（不是“约”）、文件/WAL 字节、页数、schema 与索引摘要、
//     有效查询 ID 与业务 oracle；同 seed 的逻辑摘要可复现。
//   · D1/D2/D3 不是“只复制一个健康类型”：含多来源重复、软删除训练、睡眠/HRV、
//     不同长度路线、时间空洞与派生训练会话。
//   · DX 是独立的边界输入集：合法/刚超限、损坏 ZIP、非法版本、GPX 文件数与 XML 字节边界。
//
// 用法：
//   node --import tsx scripts/phase6/fixtures.mjs --root <lab>/run-001 --dataset D2
//   node --import tsx scripts/phase6/fixtures.mjs --root <lab>/run-001 --dataset DX --payloads

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

import { CONTRACT_VERSION } from "@rai/contracts";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

import {
  assertInsideRoot,
  assertSafeExperimentRoot,
  createOwnedExperimentRoot
} from "./safety.mjs";

export const DATASETS = Object.freeze({
  D0: { records: 3, workouts: 1, years: 1, label: "空态 + 各业务最小合法样本" },
  D1: { records: 50_000, workouts: 100, years: 1, label: "工具冒烟、轻量读写与生命周期" },
  D2: { records: 500_000, workouts: 1_000, years: 5, label: "代表性基线" },
  D3: { records: 2_000_000, workouts: 5_000, years: 10, label: "历史增长与容量上界探索" },
  DX: { records: 0, workouts: 0, years: 0, label: "独立边界输入集" }
});

const AS_OF = "2026-10-24";
const DAY = 86_400_000;
const SOURCE_WATCH = "Watch";
const SOURCE_IPHONE = "iPhone";
const SOURCE_CATEGORY = "apple_health";

/** 确定性 PRNG（mulberry32）；同 seed + 同 spec = 同序列。 */
export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function isoAt(ms) {
  return new Date(ms).toISOString();
}

/** 按 dataset 生成“计划”中的稳定 ID；manifest 与 oracle 都从这里取。 */
export function datasetIdPlan(dataset) {
  const spec = DATASETS[dataset];
  if (!spec || dataset === "DX") return null;
  const workoutIds = Array.from({ length: spec.workouts }, (_, index) => `sess-${String(index).padStart(6, "0")}`);
  const series = dataset === "D0"
    ? { small: workoutIds[0], medium: workoutIds[0], large: workoutIds[0] }
    : { small: workoutIds[0], medium: workoutIds[1], large: workoutIds[2] };
  const deletedIndex = dataset === "D0" ? null : Math.max(1, Math.floor(spec.workouts / 2));
  const duplicateIndex = dataset === "D0" ? null : Math.max(1, Math.floor(spec.workouts / 3));
  return {
    workoutIds,
    series,
    deletedWorkoutId: deletedIndex === null ? null : workoutIds[deletedIndex],
    duplicateWorkoutId: duplicateIndex === null ? null : workoutIds[duplicateIndex]
  };
}

const insertRecordSql = `INSERT INTO health_records
  (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
   start_at, end_at, created_at, metadata_json, raw_attributes_json, available_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', ?)`;

const insertWorkoutSql = `INSERT INTO workouts
  (id, activity_type, source_name, source_category, source_version, device, start_at, end_at, created_at,
   duration_seconds, indoor, metadata_json, raw_attributes_json, canonical_group_id, is_canonical, deleted_at)
  VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, '1', ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`;

const insertStatisticSql = `INSERT INTO workout_statistics
  (workout_id, ordinal, type, start_at, end_at, unit, sum_value, average_value, minimum_value, maximum_value)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// activity_type 与 HealthKit 活动类型同名（`runningType = HKWorkoutActivityTypeRunning`）；
// 写成 "running" 会让 recompute 的 listActiveForFeatures 一条也选不中，特征/评估全为 0。
const insertSessionSql = `INSERT INTO training_sessions
  (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
  VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, ?, ?, ?)`;

const insertRouteSql = `INSERT INTO workout_routes
  (id, workout_id, source_name, source_category, source_version, start_at, end_at, created_at,
   relative_path, metadata_json, point_count, file_status)
  VALUES (?, ?, ?, ?, '1', ?, ?, ?, ?, '{}', ?, 'imported')`;

const insertRoutePointSql = `INSERT INTO route_points
  (route_id, sequence, timestamp, latitude, longitude, elevation_meters, speed_mps)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

/** 序列目标在工作计划中的时长/点数；manifest 的 oracle 直接引用这些数字。 */
export const SERIES_TIERS = Object.freeze({
  small: { durationSeconds: 1_800, heartRateSamples: 1_800, routePoints: 100 },
  medium: { durationSeconds: 3_600, heartRateSamples: 3_600, routePoints: 500 },
  large: { durationSeconds: 7_200, heartRateSamples: 7_200, routePoints: 2_000 }
});

function planWorkout(random, index, spec, asOfMs) {
  const tier = index < 3 ? ["small", "medium", "large"][index] : null;
  const durationSeconds = tier === null ? 1_800 + Math.floor(random() * 3_600) : SERIES_TIERS[tier].durationSeconds;
  // 训练按时间升序铺满跨度；最后一条落在 asOf 前 4 天。
  const span = spec.years * 365 * DAY;
  const endAt = asOfMs - 4 * DAY - Math.floor(((spec.workouts - 1 - index) * span) / Math.max(1, spec.workouts));
  const startAt = endAt - durationSeconds * 1_000;
  const distanceKm = Math.round((3 + random() * 18) * 100) / 100;
  return { index, tier, durationSeconds, startAt, endAt, distanceKm };
}

function insertRecord(statement, row) {
  statement.run(
    row.id, row.type, row.sourceName, SOURCE_CATEGORY, "1", row.device ?? SOURCE_WATCH,
    row.unit, row.value ?? null, row.valueText ?? null,
    isoAt(row.startMs), isoAt(row.endMs), isoAt(row.endMs + 1_000), isoAt(row.startMs)
  );
}

function seedIdentity(database) {
  const put = database.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)");
  for (const [key, value] of [
    ["dataset_version", "phase6-synthetic"],
    ["parser_contract_version", CONTRACT_VERSION],
    ["parser_identity_algorithm", identityAlgorithmFingerprint()],
    ["import_completed_at", `${AS_OF}T00:00:00.000Z`]
  ]) put.run(key, value);
  database.prepare("INSERT OR REPLACE INTO profile (id, attributes_json) VALUES (1, ?)")
    .run(JSON.stringify({ synthetic: true, phase: 6, seedDataset: true }));
}

/**
 * 生成一套夹具数据库并返回 manifest。调用方必须已通过 safety 门禁；
 * 这里再做一次“输出路径在实验根内”的断言，避免独立 CLI 被误用。
 */
export async function generateDataset({ root, dataset, seed = 20261024, asOf = AS_OF } = {}) {
  if (!(dataset in DATASETS)) throw new Error(`unknown dataset: ${String(dataset)}`);
  const checked = assertSafeExperimentRoot(root);
  const realRoot = checked.realRoot;
  if (dataset === "DX") {
    const payloadDir = join(realRoot, "payloads");
    mkdirSync(payloadDir, { recursive: true });
    const payloads = buildPayloads(payloadDir);
    const manifest = {
      schemaVersion: 1, dataset, seed, asOf, generatedAt: new Date().toISOString(),
      note: "DX 只生成输入文件，不建立业务库", payloadRoot: payloadDir, payloads
    };
    const manifestPath = join(realRoot, "datasets", "DX", "manifest.json");
    mkdirSync(join(realRoot, "datasets", "DX"), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }
  const spec = DATASETS[dataset];
  const datasetDir = join(realRoot, "datasets", dataset);
  const databasePath = join(datasetDir, "rai.sqlite");
  if (existsSync(databasePath)) throw new Error(`fixture refuses to overwrite existing database: ${databasePath}`);
  mkdirSync(datasetDir, { recursive: true });
  assertInsideRoot(realRoot, databasePath, { label: "fixture database", allowMissing: true });

  const store = await RaiDatabase.open(databasePath, { migrationPolicy: "apply", createMigrationBackup: false });
  const database = store.database;
  const random = createRandom(seed);
  const asOfMs = Date.parse(`${asOf}T00:00:00.000Z`);
  const ids = datasetIdPlan(dataset);
  const workouts = Array.from({ length: spec.workouts }, (_, index) => planWorkout(random, index, spec, asOfMs));

  const insertRecordStatement = database.prepare(insertRecordSql);
  const insertWorkout = database.prepare(insertWorkoutSql);
  const insertStatistic = database.prepare(insertStatisticSql);
  const insertSession = database.prepare(insertSessionSql);
  const insertRoute = database.prepare(insertRouteSql);
  const insertRoutePoint = database.prepare(insertRoutePointSql);

  database.exec("BEGIN IMMEDIATE");
  let recordIndex = 0;
  let routePointTotal = 0;
  let statisticTotal = 0;
  let sessionTotal = 0;
  let routeTotal = 0;
  try {
    seedIdentity(database);
    // 1) 训练事实与会话（先写父行，健康样本/路线随后引用）。
    for (const workout of workouts) {
      const deleted = ids.deletedWorkoutId !== null
        && workout.index === Number(ids.deletedWorkoutId.split("-").pop());
      const sourceName = workout.index % 7 === 0 ? SOURCE_IPHONE : SOURCE_WATCH;
      const startIso = isoAt(workout.startAt);
      const endIso = isoAt(workout.endAt);
      insertWorkout.run(
        `wo-${String(workout.index).padStart(6, "0")}`, sourceName, SOURCE_CATEGORY, sourceName,
        startIso, endIso, isoAt(workout.endAt + 60_000), workout.durationSeconds,
        workout.index % 5 === 0 ? 1 : 0,
        JSON.stringify({ synthetic: true, distanceKm: workout.distanceKm, energyKilocalories: Math.round(workout.distanceKm * 62) }),
        null, 1, deleted ? isoAt(asOfMs - DAY) : null
      );
      insertSession.run(
        ids.workoutIds[workout.index], startIso, endIso, workout.distanceKm,
        `wo-${String(workout.index).padStart(6, "0")}`, deleted ? "inactive" : "active"
      );
      sessionTotal += 1;
      insertStatistic.run(`wo-${String(workout.index).padStart(6, "0")}`, 0,
        "HKQuantityTypeIdentifierDistanceWalkingRunning", startIso, endIso, "km", workout.distanceKm, null, null, null);
      insertStatistic.run(`wo-${String(workout.index).padStart(6, "0")}`, 1,
        "HKQuantityTypeIdentifierHeartRate", startIso, endIso, "count/min", null,
        Math.round(138 + (workout.index % 17)), null, null);
      statisticTotal += 2;

      // 多来源重复：同一训练的第二来源行，不建立会话（防止重复计数）。
      if (ids.duplicateWorkoutId !== null && workout.index === Number(ids.duplicateWorkoutId.split("-").pop())) {
        insertWorkout.run(
          `wo-dup-${String(workout.index).padStart(6, "0")}`, SOURCE_IPHONE, SOURCE_CATEGORY, SOURCE_IPHONE,
          startIso, endIso, isoAt(workout.endAt + 120_000), workout.durationSeconds, 0,
          JSON.stringify({ synthetic: true, duplicateOf: `wo-${String(workout.index).padStart(6, "0")}` }),
          `wo-${String(workout.index).padStart(6, "0")}`, 0, null
        );
      }
    }

    // 2) 路线：固定目标小/中/大 + 其余每 25 条一条；长短不一。
    for (const workout of workouts) {
      const tier = workout.tier;
      const shouldRoute = tier !== null || workout.index % 25 === 0;
      if (!shouldRoute) continue;
      if (ids.deletedWorkoutId !== null && workout.index === Number(ids.deletedWorkoutId.split("-").pop())) continue;
      const points = dataset === "D0" ? 10
        : tier === null ? 40 + (workout.index % 180) : SERIES_TIERS[tier].routePoints;
      const routeId = `route-${String(workout.index).padStart(6, "0")}`;
      insertRoute.run(routeId, `wo-${String(workout.index).padStart(6, "0")}`, SOURCE_WATCH, SOURCE_CATEGORY,
        isoAt(workout.startAt), isoAt(workout.endAt), isoAt(workout.endAt + 60_000),
        `workout-routes/${routeId}.gpx`, points);
      const stepMs = Math.max(1_000, Math.floor((workout.endAt - workout.startAt) / points));
      for (let point = 0; point < points; point += 1) {
        insertRoutePoint.run(routeId, point, isoAt(workout.startAt + point * stepMs),
          23.1 + workout.index * 0.001 + point * 1e-4, 113.3 + workout.index * 0.001 + point * 1e-4,
          5 + point * 0.05, workout.distanceKm * 1000 / workout.durationSeconds);
      }
      routePointTotal += points;
      routeTotal += 1;
    }

    // 3) 健康记录：按类型分布铺满日期跨度；序列目标额外补每秒样本。
    const types = [
      { type: "HKQuantityTypeIdentifierStepCount", unit: "count", share: 0.62, min: 10, max: 300 },
      { type: "HKQuantityTypeIdentifierHeartRate", unit: "count/min", share: 0.16, min: 80, max: 175 },
      { type: "HKQuantityTypeIdentifierRunningSpeed", unit: "km/hr", share: 0.07, min: 7, max: 15 },
      { type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", unit: "ms", share: 0.05, min: 18, max: 90 },
      { type: "HKQuantityTypeIdentifierRespiratoryRate", unit: "count/min", share: 0.05, min: 10, max: 22 },
      { type: "HKQuantityTypeIdentifierRestingHeartRate", unit: "count/min", share: 0.05, min: 45, max: 70 }
    ];
    const spanMs = spec.years * 365 * DAY;
    const startMs = asOfMs - spanMs;
    // 时间空洞：D2/D3 跳过第 7 个月，防止“均匀铺满”掩盖空洞查询。
    const gapStart = startMs + Math.floor(spanMs * 0.55);
    const gapEnd = gapStart + 30 * DAY;
    for (let index = 0; index < spec.records; index += 1) {
      const roll = random();
      let cumulative = 0;
      let chosen = types[0];
      for (const candidate of types) {
        cumulative += candidate.share;
        if (roll <= cumulative) { chosen = candidate; break; }
      }
      let at = startMs + Math.floor(random() * (spanMs - 300_000));
      if (at >= gapStart && at < gapEnd) at += 31 * DAY;
      const value = Math.round((chosen.min + random() * (chosen.max - chosen.min)) * 10) / 10;
      const interval = chosen.type === "HKQuantityTypeIdentifierStepCount" ? 60_000 : 5_000;
      insertRecord(insertRecordStatement, {
        id: `rec-${String(index).padStart(8, "0")}`,
        type: chosen.type,
        sourceName: index % 11 === 0 ? SOURCE_IPHONE : SOURCE_WATCH,
        unit: chosen.unit,
        value,
        startMs: at,
        endMs: at + interval - 1_000
      });
      recordIndex += 1;
      // 多来源重复：每条 97 号样本再写一条不同 id / iPhone 来源。
      if (index % 97 === 0) {
        insertRecord(insertRecordStatement, {
          id: `rec-dup-${String(index).padStart(8, "0")}`,
          type: chosen.type, sourceName: SOURCE_IPHONE, unit: chosen.unit, value,
          startMs: at, endMs: at + interval - 1_000
        });
        recordIndex += 1;
      }
    }

    // 4) 睡眠：跨夜分类记录，供依赖/覆盖查询；不属于任何训练。
    const sleepCount = dataset === "D0" ? 1 : Math.max(30, Math.floor(spec.records / 5_000));
    for (let night = 0; night < sleepCount; night += 1) {
      const end = asOfMs - 3 * DAY - night * 3 * DAY;
      const start = end - 7 * 3_600_000;
      insertRecord(insertRecordStatement, {
        id: `sleep-${String(night).padStart(6, "0")}`,
        type: "HKCategoryTypeIdentifierSleepAnalysis", sourceName: SOURCE_WATCH, unit: null,
        valueText: night % 4 === 0 ? "HKCategoryValueSleepAnalysisAwake" : "HKCategoryValueSleepAnalysisAsleepCore",
        startMs: start, endMs: end
      });
      recordIndex += 1;
    }

    // 5) 三个序列目标的每秒心率/速度（series 路径必须真的走窗口函数，而不是空查）。
    //    D0 是“最小合法样本”，只给一条 30 样本序列；D1–D3 才铺满三档。
    for (const tier of ["small", "medium", "large"]) {
      if (dataset === "D0" && tier !== "small") continue;
      const workout = workouts[Number(ids.series[tier].split("-").pop())];
      // 必须与 workout 的 source_name 完全一致：series 的 metricSeries 以 (type, source_name)
      // 过滤；源名对不上时接口照样 200，但序列是空的（正是“空查假成功”的形态）。
      const seriesSource = workout.index % 7 === 0 ? SOURCE_IPHONE : SOURCE_WATCH;
      const limit = dataset === "D0" ? 30 : SERIES_TIERS[tier].heartRateSamples;
      const speedKmh = workout.distanceKm / (workout.durationSeconds / 3_600);
      for (let sample = 0; sample < limit; sample += 1) {
        const at = workout.startAt + sample * 1_000;
        insertRecord(insertRecordStatement, {
          id: `hr-${tier}-${String(sample).padStart(6, "0")}`,
          type: "HKQuantityTypeIdentifierHeartRate", sourceName: seriesSource, unit: "count/min",
          value: 135 + (sample % 23), startMs: at, endMs: at + 999
        });
        recordIndex += 1;
        if (sample % 5 === 0) {
          insertRecord(insertRecordStatement, {
            id: `sp-${tier}-${String(sample).padStart(6, "0")}`,
            type: "HKQuantityTypeIdentifierRunningSpeed", sourceName: seriesSource, unit: "km/hr",
            value: Math.max(1, speedKmh + (sample % 17 - 8) * 0.02), startMs: at, endMs: at + 999
          });
          recordIndex += 1;
        }
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始错误 */ }
    throw error;
  }

  const counts = readFixtureCounts(database);
  const migrationVersion = Number(database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()?.version ?? 0);
  const pageCount = Number(database.prepare("PRAGMA page_count").get()?.page_count ?? 0);
  const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size ?? 0);
  const schemaObjects = database.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','index','view') ORDER BY type, name").all()
    .map((row) => `${row.type}:${row.name}`);
  try { database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* 非 WAL 模式没有 checkpoint */ }
  store.close();
  // 冷备夹具不能带活跃 WAL/SHM：runner 的 F1 预检会拒绝非空 sidecar。
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) rmSync(sidecar, { force: true });

  const databaseBytes = statSync(databasePath).size;
  const databaseSha256 = createHash("sha256").update(readFileSync(databasePath)).digest("hex");
  const digestInput = JSON.stringify({
    dataset, seed, counts,
    sample: databaseSampleDigest(databasePath),
    ids: ids.workoutIds.slice(0, 3)
  });
  const manifest = {
    schemaVersion: 1,
    dataset,
    seed: Number(seed),
    asOf,
    generatedAt: new Date().toISOString(),
    spec,
    rows: counts,
    bytes: { database: databaseBytes, databaseSha256 },
    schema: {
      migrationVersion,
      pageCount,
      pageSize,
      objects: schemaObjects.length,
      objectNames: schemaObjects
    },
    ids: {
      ...ids,
      seriesTiers: dataset === "D0"
        ? { small: { durationSeconds: 1_800, heartRateSamples: 30, routePoints: 10 } }
        : SERIES_TIERS,
      newestWorkoutId: (() => {
        const row = databasePathRead(databasePath, "SELECT ts.id AS id FROM training_sessions ts JOIN workouts w ON w.id = ts.canonical_workout_id WHERE w.deleted_at IS NULL ORDER BY w.start_at DESC LIMIT 1");
        return row?.id ?? null;
      })(),
      oldestWorkoutId: (() => {
        const row = databasePathRead(databasePath, "SELECT ts.id AS id FROM training_sessions ts JOIN workouts w ON w.id = ts.canonical_workout_id WHERE w.deleted_at IS NULL ORDER BY w.start_at ASC LIMIT 1");
        return row?.id ?? null;
      })()
    },
    digest: createHash("sha256").update(digestInput).digest("hex")
  };
  writeFileSync(join(datasetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readFixtureCounts(database) {
  const scalar = (sql) => Number(database.prepare(sql).get()?.count ?? 0);
  return {
    health_records: scalar("SELECT COUNT(*) AS count FROM health_records"),
    health_records_distinct: scalar("SELECT COUNT(DISTINCT type) AS count FROM health_records"),
    workouts: scalar("SELECT COUNT(*) AS count FROM workouts"),
    workouts_visible: scalar("SELECT COUNT(*) AS count FROM workouts WHERE deleted_at IS NULL"),
    workouts_deleted: scalar("SELECT COUNT(*) AS count FROM workouts WHERE deleted_at IS NOT NULL"),
    training_sessions: scalar("SELECT COUNT(*) AS count FROM training_sessions"),
    training_sessions_active: scalar("SELECT COUNT(*) AS count FROM training_sessions WHERE status = 'active'"),
    workout_routes: scalar("SELECT COUNT(*) AS count FROM workout_routes"),
    route_points: scalar("SELECT COUNT(*) AS count FROM route_points"),
    workout_statistics: scalar("SELECT COUNT(*) AS count FROM workout_statistics"),
    ability_assessments: scalar("SELECT COUNT(*) AS count FROM ability_assessments")
  };
}

function databasePathRead(path, sql) {
  // 夹具已关闭写连接；这里用只读连接做 manifest 的稳定查询，不参与生成。
  return readOnlyQuery(path, sql);
}

function readOnlyQuery(path, sql) {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return database.prepare(sql).get() ?? null; } finally { database.close(); }
}

function databaseSampleDigest(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT COUNT(*) AS records,
        COALESCE(ROUND(SUM(value_numeric), 3), 0) AS value_sum,
        MIN(start_at) AS first_at, MAX(start_at) AS last_at,
        (SELECT COUNT(*) FROM workouts) AS workouts
      FROM health_records`).get();
    return row;
  } finally { database.close(); }
}

// ---------------------------------------------------------------------------
// DX：边界载荷（真 ZIP，不是假文件；文件名带 apple-health-healthkit token）
// ---------------------------------------------------------------------------

const u16 = (value) => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; };
const u32 = (value) => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; };

export function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const nameData = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data);
    const useDeflate = compressed.length > 0 && compressed.length < entry.data.length;
    const stored = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(stored.length), u32(entry.data.length), u16(nameData.length), u16(0), nameData, stored
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(stored.length), u32(entry.data.length), u16(nameData.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(localOffset), nameData
    ]);
    locals.push(local);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0),
    u16(entries.length), u16(entries.length), u32(centralBytes.length), u32(localOffset), u16(0)
  ]);
  return Buffer.concat([...locals, centralBytes, end]);
}

const pad2 = (value) => String(value).padStart(2, "0");
export function sampleInstant(index, baseMs = Date.UTC(2026, 0, 1)) {
  const moment = new Date(baseMs + index * 1_000);
  return `${moment.getUTCFullYear()}-${pad2(moment.getUTCMonth() + 1)}-${pad2(moment.getUTCDate())} ` +
    `${pad2(moment.getUTCHours())}:${pad2(moment.getUTCMinutes())}:${pad2(moment.getUTCSeconds())} +0000`;
}

function recordXml(index, options = {}) {
  const type = options.type ?? "HKQuantityTypeIdentifierStepCount";
  const baseMs = options.baseMs ?? Date.UTC(2026, 0, 1);
  const uuidIndex = index + (options.uuidOffset ?? 0);
  const padding = options.padLength ? `<MetadataEntry key="fixturePadding" value="${"x".repeat(options.padLength)}"/>` : "";
  return `<Record type="${type}" sourceName="Watch" unit="count" value="10" startDate="${sampleInstant(index, baseMs)}" endDate="${sampleInstant(index, baseMs)}">` +
    `<MetadataEntry key="RAIHealthKitSampleUUID" value="00000000-0000-4000-8000-${uuidIndex.toString(16).padStart(12, "0")}"/>${padding}</Record>`;
}

function healthData(records) {
  return `<HealthData locale="en_US">${records.join("")}</HealthData>`;
}

export const syncManifest = (overrides = {}) => JSON.stringify({
  version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: [], ...overrides
});

function healthKitZip(xml, manifest = syncManifest(), entries = []) {
  return storedZip([
    { name: "export.xml", data: Buffer.from(xml, "utf8") },
    { name: "sync-manifest.json", data: Buffer.from(manifest, "utf8") },
    ...entries
  ]);
}

const gpx = (points = 3, tag = "a") => `<gpx><trk><trkseg>${Array.from({ length: points }, (_, index) =>
  `<trkpt lat="23.1${index}" lon="113.3${index}"><ele>12.5</ele><time>2026-01-02T08:00:0${index}Z</time></trkpt>`
).join("")}</trkseg></trk></gpx>`;

const workoutWithRoute = (references) => `<Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch"
  duration="30" durationUnit="min" startDate="2026-01-02 08:00:00 +0000" endDate="2026-01-02 08:30:00 +0000">
  <MetadataEntry key="RAIHealthKitWorkoutUUID" value="00000000-0000-4000-8000-0000000000aa"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
  ${references.map((path) => `<WorkoutRoute><FileReference path="/${path}"/></WorkoutRoute>`).join("")}
</Workout>`;

/**
 * 生成 DX 载荷并返回 manifest 数组（含预期结果，供 S05–S08 oracle 使用）。
 * 不写业务库；文件全部落在 payloadDir。
 */
export function buildPayloads(payloadDir) {
  mkdirSync(payloadDir, { recursive: true });
  const write = (name, data) => {
    const path = join(payloadDir, name);
    writeFileSync(path, data);
    return { name, path, bytes: statSync(path).size, sha256: createHash("sha256").update(data).digest("hex") };
  };
  const payloads = [];
  const add = (descriptor, data) => {
    const name = descriptor.name ?? `${String(payloads.length + 1).padStart(2, "0")}-${descriptor.kind}.zip`;
    payloads.push({ ...descriptor, name, ...write(name, data) });
  };

  // S08 的结构化合同：driver 只读这里的字段做机器裁决，label 只用于展示。
  // `expectedLane` 记录“实际应进入哪条车道”，而不是把车道误判成拒绝。
  const contract = (fields) => ({
    expectation: "accepted", expectedLane: null, allowJob: true,
    allowedRejectionStages: [], expectedHttpStatus: [200], expectedCode: null,
    expectedFacts: { healthRecords: null, workouts: null, routePoints: null },
    required: true, ...fields
  });

  add({
    kind: "record-only", label: "小批 100 条", expected: "accepted; data_only or direct lane",
    contract: contract({ expectedLane: "data-only", expectedFacts: { healthRecords: 100, workouts: 0, routePoints: 0 } })
  },
  healthKitZip(healthData(Array.from({ length: 100 }, (_, index) => recordXml(index, { baseMs: Date.UTC(2026, 0, 1, 0, 0, 0) })))));
  add({
    kind: "record-only", label: "中批 2500 条", expected: "accepted",
    contract: contract({ expectedLane: "data-only", expectedFacts: { healthRecords: 2_500, workouts: 0, routePoints: 0 } })
  },
  healthKitZip(healthData(Array.from({ length: 2_500 }, (_, index) => recordXml(index, {
    baseMs: Date.UTC(2026, 0, 2, 0, 0, 0), uuidOffset: 100_000
  })))));
  add({
    kind: "record-only", label: "近记录上限 4990 条", expected: "accepted at boundary",
    contract: contract({ expectedLane: "data-only", expectedFacts: { healthRecords: 4_990, workouts: 0, routePoints: 0 } })
  },
  healthKitZip(healthData(Array.from({ length: 4_990 }, (_, index) => recordXml(index, {
    baseMs: Date.UTC(2026, 0, 3, 0, 0, 0), uuidOffset: 200_000
  })))));
  // 🔴 产品合同（docs/IOS_NATIVE_API_CONTRACT.md:67 / packages/api-contracts:223-229）：
  // `directSyncBounds.maxRecords` 在直连车道只约束删除配额，不约束 XML <Record> 条数。
  // data-only 快通路拒绝 5001 条后由 direct-sync 合法接收；这是车道边界，不是缺陷。
  add({
    kind: "record-only", s08: true, label: "超记录上限 5001 条", expected: "data-only refused; direct-sync accepts 5001 per contract",
    contract: contract({
      expectation: "accepted", expectedLane: "direct-sync",
      expectedFacts: { healthRecords: 5_001, workouts: 0, routePoints: 0 },
      note: "data-only 上限 5000；direct-sync 的 maxRecords 只限删除配额"
    })
  },
  healthKitZip(healthData(Array.from({ length: 5_001 }, (_, index) => recordXml(index, {
    baseMs: Date.UTC(2026, 0, 4, 0, 0, 0), uuidOffset: 300_000
  })))));
  add({
    kind: "record-only", s08: true, label: "XML 字节超 2 MiB（合法 5000 条，仍 < 8 MiB）", expected: "data-only lane refused; direct-sync accepts within 8 MiB",
    contract: contract({
      expectation: "accepted", expectedLane: "direct-sync",
      expectedFacts: { healthRecords: 5_000, workouts: 0, routePoints: 0 }
    })
  },
  healthKitZip(healthData(Array.from({ length: 5_000 }, (_, index) => recordXml(index, {
    baseMs: Date.UTC(2026, 0, 5, 0, 0, 0), uuidOffset: 400_000, padLength: 360
  })))));
  add({
    kind: "record-only", s08: true, label: "非法 manifest 版本", expected: "refused: manifest contract",
    contract: contract({
      expectation: "refused", expectedLane: null, allowJob: false,
      allowedRejectionStages: ["inspect"], expectedHttpStatus: [400],
      expectedCode: "import_manifest_invalid",
      expectedFacts: { healthRecords: 0, workouts: 0, routePoints: 0 }
    })
  },
  healthKitZip(healthData([recordXml(0)]), JSON.stringify({ version: 99, sourceScope: "healthkit" })));
  add({
    kind: "record-only", s08: true, label: "损坏 ZIP", expected: "refused: archive invalid",
    contract: contract({
      expectation: "refused", expectedLane: null, allowJob: false,
      allowedRejectionStages: ["upload"], expectedHttpStatus: [400],
      expectedCode: "invalid_import_archive",
      expectedFacts: { healthRecords: 0, workouts: 0, routePoints: 0 }
    })
  },
  Buffer.concat([Buffer.from("PK\u0003\u0004", "binary"), Buffer.from("not a real zip payload")]));
  add({
    kind: "record-only", s08: true, label: "非法记录类型", expected: "observational until product contract",
    contract: contract({
      expectation: "observational", expectedLane: null, allowJob: true,
      allowedRejectionStages: ["upload", "inspect", "job"],
      expectedHttpStatus: [200, 400], expectedCode: null,
      expectedFacts: { healthRecords: null, workouts: null, routePoints: null },
      note: "未知 HealthKit 类型保持观测，不自动要求拒绝，也不从必需测试列表消失"
    })
  },
  healthKitZip(healthData([recordXml(0, { type: "HKQuantityTypeIdentifierNotARealType" })])));
  add({
    kind: "workout", label: "单训练 + 50 记录", expected: "accepted; analysis queued -> published read-visible",
    contract: contract({ expectedLane: "direct-sync", expectedFacts: { healthRecords: 50, workouts: 1, routePoints: null } })
  },
  healthKitZip(healthData([
    ...Array.from({ length: 50 }, (_, index) => recordXml(index)),
    `<Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch" duration="30" durationUnit="min" startDate="2026-02-01 01:00:00 +0000" endDate="2026-02-01 01:30:00 +0000"><MetadataEntry key="RAIHealthKitWorkoutUUID" value="00000000-0000-4000-8000-00000000aaaa"/><WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/></Workout>`
  ])));
  add({
    kind: "direct-sync", label: "GPX 3 文件 / 3 点", expected: "accepted; route ledger + readable points",
    contract: contract({ expectedLane: "direct-sync", expectedFacts: { healthRecords: 1, workouts: 1, routePoints: 9 } })
  },
  healthKitZip(
    healthData([recordXml(0), workoutWithRoute(["workout-routes/route-a.gpx", "workout-routes/route-b.gpx", "workout-routes/route-c.gpx"])]),
    syncManifest(), ["a", "b", "c"].map((tag) => ({ name: `workout-routes/route-${tag}.gpx`, data: Buffer.from(gpx(3, tag), "utf8") }))
  ));
  const manyRoutes = Array.from({ length: 201 }, (_, index) => ({ name: `workout-routes/route-${index}.gpx`, data: Buffer.from(gpx(3), "utf8") }));
  add({
    kind: "direct-sync", s08: true, label: "GPX 201 文件（超 200）", expected: "refused: max 200 route files",
    contract: contract({
      expectation: "refused", expectedLane: null, allowJob: false,
      allowedRejectionStages: ["inspect"], expectedHttpStatus: [400],
      expectedCode: "direct_sync_payload_exceeds_bounds",
      expectedFacts: { healthRecords: 0, workouts: 0, routePoints: 0 }
    })
  },
  healthKitZip(healthData([recordXml(0), workoutWithRoute([manyRoutes[0].name])]), syncManifest(), manyRoutes));
  add({
    kind: "direct-sync", s08: true, label: "direct-sync XML 超 8 MiB（合法 5000 条）", expected: "refused: max 8 MiB XML",
    contract: contract({
      expectation: "refused", expectedLane: null, allowJob: false,
      allowedRejectionStages: ["inspect"], expectedHttpStatus: [400],
      expectedCode: "direct_sync_payload_exceeds_bounds",
      expectedFacts: { healthRecords: 0, workouts: 0, routePoints: 0 }
    })
  },
  healthKitZip(healthData(Array.from({ length: 5_000 }, (_, index) => recordXml(index, {
    baseMs: Date.UTC(2026, 0, 6, 0, 0, 0), uuidOffset: 500_000, padLength: 1_650
  })))));
  return payloads;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { seed: 20261024, dataset: null, root: null, payloads: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") args.root = argv[++index];
    else if (argument === "--dataset") args.dataset = argv[++index];
    else if (argument === "--seed") args.seed = Number(argv[++index]);
    else if (argument === "--payloads") args.payloads = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!args.root) throw new Error("--root is required");
  if (!args.dataset || !(args.dataset in DATASETS)) throw new Error(`--dataset must be one of ${Object.keys(DATASETS).join(", ")}`);
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const checked = assertSafeExperimentRoot(args.root);
    if (!existsSync(checked.root)) createOwnedExperimentRoot(checked.root, { runId: `fixture-${args.dataset}` });
    const manifest = await generateDataset({ root: checked.root, dataset: args.dataset, seed: args.seed });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`phase6-fixtures: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
