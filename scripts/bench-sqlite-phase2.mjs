// 阶段 2 SQLite 查询/事务/连接基准（2026-10-21）。
//
//   node --import tsx scripts/bench-sqlite-phase2.mjs --root /tmp/rai-phase2-xxxx \
//     [--scenario all|d0|d1|d2|d3] [--rounds 5] [--iterations 200] [--json out.json]
//
// 纪律（对应 RAI_Phase2_SQLite_Implementation_Plan_2026-10-21.md WP2-0/1）：
//   · --root 必填且必须是仓库之外的绝对路径；脚本拒绝把仓库 var/ 当实验根。
//   · 所有数据库、WAL、备份只落在 --root 下；不读取也不写入仓库默认 rai.sqlite。
//   · 数据由固定 seed 生成；baseline / candidate-a / candidate-b 从同一份已 checkpoint
//     的不可变基线副本派生。
//   · 计时与 SQL 台账分开：计时默认关闭插桩；台账单独采集一次，避免观测开销混入收益。
//   · 本脚本只写合成数据，不连接生产库，不执行 VACUUM/ANALYZE/REINDEX。
//
// 输出：root/phase2-evidence.json（原始每轮样本 + 台账 + 计划 + 差分）、
//       root/phase2-manifest.json（数据集/源码/环境清单）。

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { RaiDatabase } from "../packages/storage-sqlite/src/database.ts";
import { SqliteSeriesReadRepository } from "../packages/storage-sqlite/src/read/series-read-repository.ts";
import { SqliteWorkoutReadRepository } from "../packages/storage-sqlite/src/read/workout-read-repository.ts";
import {
  HealthRecordDurationCache,
  readHealthRecordOverlap
} from "../packages/storage-sqlite/src/read/health-record-overlap-reads.ts";
import { RaiReadStore } from "../apps/api/src/data.ts";
import { ReadStoreManager } from "../apps/api/src/read-store-manager.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BASE_MS = Date.UTC(2023, 8, 1, 0, 0, 0);
const NOW_MS = Date.UTC(2026, 8, 1, 0, 0, 0);

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const ROOT = readArg("--root", null);
const SCENARIO = readArg("--scenario", "all");
if (!["all", "d0", "d1", "d2", "d3"].includes(SCENARIO)) {
  console.error(`phase2-bench: unknown --scenario ${SCENARIO}`);
  process.exit(2);
}
const ROUNDS = Number(readArg("--rounds", "5"));
const ITERATIONS = Number(readArg("--iterations", "200"));
const JSON_OUT = readArg("--json", null);
const SKIP_HEALTH_CANDIDATES = args.includes("--skip-health-candidates");

function fail(message) {
  console.error(`phase2-bench: ${message}`);
  process.exit(2);
}

/** 解析路径的真实目标；路径尚不存在时，解析最近的存在祖先再拼回后缀。 */
function realTarget(path) {
  let current = resolve(path);
  const suffix = [];
  while (!existsSync(current)) {
    suffix.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const real = realpathSync(current);
  return resolve(real, ...suffix);
}

function pathContains(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

if (ROOT === null) fail("--root is required (an absolute path outside the repository)");
if (!isAbsolute(ROOT)) fail("--root must be absolute");
const root = resolve(ROOT);
if (root === "/" || root.length < 6) fail(`refusing unsafe experiment root: ${root}`);
const repoReal = realpathSync(REPO_ROOT);
const repoDefaultData = resolve(repoReal, "var");
const rootTarget = realTarget(root);
if (rootTarget === repoReal || rootTarget.startsWith(`${repoReal}${sep}`)) {
  fail(`experiment root must be outside the repository (real target ${rootTarget})`);
}
if (rootTarget === repoDefaultData || rootTarget.startsWith(`${repoDefaultData}${sep}`)) {
  fail("experiment root must not contain the repository default data directory");
}
// Reject a parent of the repository (e.g. /Users/ta), not only the repository
// itself: otherwise repo files appear to be inside the experiment root.
if (pathContains(rootTarget, repoReal)) {
  fail(`experiment root must not contain the repository: ${rootTarget} contains ${repoReal}`);
}
if (root.split(sep).filter(Boolean).length < 2) fail(`experiment root is too shallow: ${root}`);
if (existsSync(root) && lstatSync(root).isSymbolicLink()) fail(`refusing symlinked experiment root: ${root}`);
mkdirSync(root, { recursive: true });
const rootReal = realpathSync(root);
if (rootReal !== rootTarget) fail(`experiment root changed while resolving: ${rootTarget} -> ${rootReal}`);
if (rootReal === repoReal || rootReal.startsWith(`${repoReal}${sep}`) || pathContains(rootReal, repoReal)) {
  fail(`experiment root is not a disposable directory outside the repository: ${rootReal}`);
}

/** 断言目标仍位于实验根内（防路径穿越、符号链接逃逸/误写）。 */
function insideRoot(target) {
  const resolved = resolve(target);
  const real = realTarget(resolved);
  const rel = relative(rootReal, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    fail(`refusing path outside experiment root: ${resolved} (real ${real})`);
  }
  if (pathContains(repoReal, real)) {
    fail(`refusing path inside the repository: ${resolved} (real ${real})`);
  }
  if (existsSync(resolved)) {
    if (lstatSync(resolved).isSymbolicLink()) fail(`refusing symlinked path inside experiment root: ${resolved}`);
    const targetReal = realpathSync(resolved);
    if (pathContains(repoReal, targetReal)) {
      fail(`refusing path inside the repository: ${resolved} -> ${targetReal}`);
    }
    const targetRel = relative(rootReal, targetReal);
    if (targetRel.startsWith("..") || isAbsolute(targetRel)) {
      fail(`path escapes experiment root through a symlink: ${resolved} -> ${targetReal}`);
    }
  }
  return resolved;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  const hash = createHash("sha256");
  const buffer = readFileSync(path);
  hash.update(buffer);
  return hash.digest("hex");
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarize(samples) {
  if (samples.length === 0) return { samples: 0, p50: null, p95: null, max: null, min: null, mean: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
    min: sorted[0],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 规范化 SQL 文本用于台账聚合（只折叠空白，不改写语义）。 */
function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

/**
 * 只为台账服务的 DatabaseSync 代理：包装 prepare/exec，记录真实 SQL、参数、返回行数和耗时。
 * 计时基准**不启用**它（见 traceEnabled 开关），所以观测开销不会计入收益。
 */
function createTracingDatabase(real, ledger, role = "read") {
  let enabled = true;
  const record = (sql, params, rows, startedAt, error) => {
    if (!enabled) return;
    const endedAt = performance.now();
    ledger.push({
      role,
      sql: normalizeSql(sql),
      sqlHash: sha256(normalizeSql(sql)),
      params: params.map((value) => (typeof value === "string" && value.length > 120 ? `${value.slice(0, 117)}...` : value)),
      rows,
      ms: endedAt - startedAt,
      error: error === undefined ? null : String(error?.message ?? error)
    });
  };
  const wrapStatement = (statement, sql) => ({
    all: (...params) => {
      const startedAt = performance.now();
      try {
        const rows = statement.all(...params);
        record(sql, params, rows.length, startedAt);
        return rows;
      } catch (error) {
        record(sql, params, null, startedAt, error);
        throw error;
      }
    },
    get: (...params) => {
      const startedAt = performance.now();
      try {
        const row = statement.get(...params);
        record(sql, params, row === undefined ? 0 : 1, startedAt);
        return row;
      } catch (error) {
        record(sql, params, null, startedAt, error);
        throw error;
      }
    },
    run: (...params) => {
      const startedAt = performance.now();
      try {
        const result = statement.run(...params);
        record(sql, params, null, startedAt);
        return result;
      } catch (error) {
        record(sql, params, null, startedAt, error);
        throw error;
      }
    }
  });
  const proxy = new Proxy(real, {
    get(target, property) {
      if (property === "prepare") return (sql) => wrapStatement(target.prepare(sql), sql);
      if (property === "exec") return (sql) => {
        const startedAt = performance.now();
        try {
          const result = target.exec(sql);
          record(sql, [], null, startedAt);
          return result;
        } catch (error) {
          record(sql, [], null, startedAt, error);
          throw error;
        }
      };
      if (property === "setTraceEnabled") return (value) => { enabled = value; };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return proxy;
}

function queryPlan(database, sql, params = []) {
  try {
    return database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => String(row.detail ?? ""));
  } catch (error) {
    return [`EXPLAIN failed: ${String(error?.message ?? error)}`];
  }
}

function indexList(database) {
  return database
    .prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .all()
    .map((row) => ({ name: row.name, table: row.tbl_name, sql: normalizeSql(row.sql) }));
}

function tableCounts(database) {
  const tables = ["health_records", "workouts", "training_sessions", "workout_features", "ability_assessments", "workout_routes"];
  return Object.fromEntries(tables.map((table) => [
    table,
    Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0)
  ]));
}

function sqliteInfo(database) {
  const version = database.prepare("SELECT sqlite_version() AS version").get()?.version;
  const compile = database.prepare("PRAGMA compile_options").all().map((row) => row.compile_options);
  const journal = database.prepare("PRAGMA journal_mode").get()?.journal_mode;
  const synchronous = database.prepare("PRAGMA synchronous").get()?.synchronous;
  const busy = database.prepare("PRAGMA busy_timeout").get()?.timeout;
  const pageSize = database.prepare("PRAGMA page_size").get()?.page_size;
  const pageCount = database.prepare("PRAGMA page_count").get()?.page_count;
  const freelist = database.prepare("PRAGMA freelist_count").get()?.freelist_count;
  const stat1 = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name IN ('sqlite_stat1','sqlite_stat4')").get();
  return { version, compile, journal, synchronous, busyTimeout: busy, pageSize, pageCount, freelist, hasStat1: Number(stat1?.count ?? 0) > 0 };
}

function fileSizes(path) {
  const sizes = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${path}${suffix}`;
    sizes[suffix || "main"] = existsSync(target) ? statSync(target).size : 0;
  }
  sizes.total = Object.values(sizes).reduce((sum, value) => sum + value, 0);
  return sizes;
}

// ---------------------------------------------------------------------------
// 数据集生成
// ---------------------------------------------------------------------------

const HEALTH_TYPES = {
  heartRate: "HKQuantityTypeIdentifierHeartRate",
  stepCount: "HKQuantityTypeIdentifierStepCount",
  speed: "HKQuantityTypeIdentifierRunningSpeed",
  power: "HKQuantityTypeIdentifierRunningPower",
  stride: "HKQuantityTypeIdentifierRunningStrideLength",
  verticalOscillation: "HKQuantityTypeIdentifierRunningVerticalOscillation",
  groundContact: "HKQuantityTypeIdentifierRunningGroundContactTime"
};
const TYPE_UNITS = {
  [HEALTH_TYPES.heartRate]: "count/min",
  [HEALTH_TYPES.stepCount]: "count",
  [HEALTH_TYPES.speed]: "km/hr",
  [HEALTH_TYPES.power]: "W",
  [HEALTH_TYPES.stride]: "m",
  [HEALTH_TYPES.verticalOscillation]: "cm",
  [HEALTH_TYPES.groundContact]: "ms"
};

const SCALES = {
  d0: { workouts: 3, healthRecords: 24, label: "D0 语义边界" },
  d1: { workouts: 100, healthRecords: 50_000, label: "D1 小库" },
  d2: { workouts: 1_000, healthRecords: 500_000, label: "D2 代表规模" },
  d3: { workouts: 5_000, healthRecords: 2_000_000, label: "D3 放大规模" }
};

async function createEmptyDatabase(path) {
  const created = await RaiDatabase.open(path, { createMigrationBackup: false });
  created.close();
}

function prepareBulk(database) {
  return {
    health: database.prepare(`
      INSERT INTO health_records
        (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}')
    `),
    workout: database.prepare(`
      INSERT INTO workouts
        (id, activity_type, source_name, source_category, start_at, end_at, duration_seconds, indoor,
         metadata_json, raw_attributes_json, is_canonical, deleted_at)
      VALUES (?, 'running', ?, ?, ?, ?, ?, ?, '{}', '{}', 1, ?)
    `),
    session: database.prepare(`
      INSERT INTO training_sessions
        (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
      VALUES (?, 'running', ?, ?, ?, ?, 'active')
    `),
    route: database.prepare(`
      INSERT INTO workout_routes
        (id, workout_id, source_name, source_category, start_at, end_at, metadata_json, point_count, file_status)
      VALUES (?, ?, ?, 'apple_watch', ?, ?, '{}', ?, 'imported')
    `)
  };
}

function insertSemanticDataset(database) {
  const bulk = prepareBulk(database);
  database.exec("BEGIN");
  try {
    const start = iso(BASE_MS);
    const end = iso(BASE_MS + HOUR_MS);
    bulk.workout.run("w-pending", "Apple Watch", "apple_watch", start, end, 3600, 0, null);
    bulk.session.run("s-pending", start, end, 10.1, "w-pending");
    bulk.workout.run("w-old", "Apple Watch", "apple_watch", iso(BASE_MS + DAY_MS), iso(BASE_MS + DAY_MS + HOUR_MS), 3600, 0, null);
    bulk.session.run("s-old", iso(BASE_MS + DAY_MS), iso(BASE_MS + DAY_MS + HOUR_MS), 10.2, "w-old");
    bulk.workout.run("w-deleted", "RQ Run", "third_party", iso(BASE_MS + 2 * DAY_MS), iso(BASE_MS + 2 * DAY_MS + HOUR_MS), 3600, 1, iso(BASE_MS + 3 * DAY_MS));
    bulk.session.run("s-deleted", iso(BASE_MS + 2 * DAY_MS), iso(BASE_MS + 2 * DAY_MS + HOUR_MS), 10.3, "w-deleted");
    bulk.route.run("r-old", "w-old", "Apple Watch", iso(BASE_MS + DAY_MS), iso(BASE_MS + DAY_MS + HOUR_MS), 100);

    database.prepare(`INSERT INTO feature_runs
      (id, dataset_version, canonical_contract_version, feature_schema_version, feature_config_json,
       feature_config_hash, status, created_at, completed_at)
      VALUES ('d0-fr', 'd0', 'v1', 'v1', '{}', 'hash', 'succeeded', ?, ?)`).run(iso(BASE_MS), iso(BASE_MS));
    database.prepare(`INSERT INTO model_runs
      (id, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
       evaluated_at, status, created_at, completed_at)
      VALUES ('d0-mr', 'd0-fr', 'd0', 'd0-model', '{}', 'hash', ?, 'succeeded', ?, ?)`)
      .run(iso(BASE_MS), iso(BASE_MS), iso(BASE_MS));
    database.prepare("INSERT INTO active_model_run (singleton, model_run_id, activated_at) VALUES (1, 'd0-mr', ?)")
      .run(iso(BASE_MS));
    database.prepare(`INSERT INTO workout_features
      (id, feature_run_id, training_session_id, canonical_workout_id, workout_start_at, duration_seconds,
       distance_km, average_speed_mps, average_heart_rate_bpm, heart_rate_sample_count, heart_rate_coverage,
       route_point_count, route_quality, source_confidence, session_type, session_type_source,
       eligibility_status, quality_score, missing_reasons_json, features_json, provenance_json, computed_at)
      VALUES ('d0-f', 'd0-fr', 's-old', 'w-old', ?, 3600, 10.2, 3.1, 145, 700, 0.9,
              100, 0.9, 0.9, 'easy', 'auto', 'eligible', 0.8, '[]', '{}', '{}', ?)`)
      .run(iso(BASE_MS + DAY_MS), iso(BASE_MS + DAY_MS));
    database.prepare(`INSERT INTO ability_assessments
      (id, model_run_id, feature_id, training_session_id, sequence_number, assessment_status,
       current_ability, confidence, effective_weights_json, confidence_factors_json,
       true_ability_delta, updated_true_ability, explanation_codes_json, explanation_json, assessed_at)
      VALUES ('d0-a', 'd0-mr', 'd0-f', 's-old', 1, 'eligible', 42, 0.7, '{}', '{}', 0.1, 1, '[]', '{}', ?)`)
      .run(iso(BASE_MS + DAY_MS));

    // D0 的样本必须落在 `w-old` 的查询窗口内；否则差分只是在比较两个空序列。
    // 窗口 = [BASE_MS + DAY_MS, BASE_MS + DAY_MS + HOUR_MS)，右端按闭区间读。
    const denseStart = BASE_MS + DAY_MS;
    const denseEnd = denseStart + HOUR_MS;
    const hr = HEALTH_TYPES.heartRate;
    // 用负偏移文本：其文本序早于同 instant 的 UTC 边界，仍能进入相交读的候选区间。
    const offsetText = (ms) => `${new Date(ms - 5 * HOUR_MS).toISOString().slice(0, 19)}-05:00`;
    const rows = [
      [iso(denseStart + 290_000), iso(denseStart + 295_000), 135, "count/min"], // 最早行，确定单位
      [iso(denseStart + 310_000), iso(denseStart + 320_000), 140, "count/min"],
      [iso(denseStart + 310_000), iso(denseStart + 320_000), 140, "count/min"], // 完全重复
      [iso(denseStart + 310_000), iso(denseStart + 320_000), 141, "count/min"], // 并列时间、不同值
      [iso(denseStart + 310_000), iso(denseStart + 320_000), 141, "bpm"],       // 并列时间、不同单位
      [iso(denseStart + 320_000), iso(denseStart + 330_000), 150, "count/min"],
      [iso(denseStart + 320_000), iso(denseStart + 335_000), 150, "count/min"], // 同起点不同终点
      [iso(denseStart + 340_000), iso(denseStart + 350_000), null, "count/min"],
      [iso(denseStart + 350_000), iso(denseStart + 360_000), 190, "count/min"],
      [iso(denseStart + 360_000), iso(denseStart + 370_000), 190, "count/min"], // 并列峰值
      [offsetText(denseStart + 380_000), offsetText(denseStart + 390_000), 160, "count/min"], // 偏移文本
      [iso(denseEnd), iso(denseEnd + 10_000), 170, "count/min"], // 窗口右端（序列包含、区间零长丢弃）
      [iso(denseStart - 10_000), iso(denseStart + 20_000), 130, "count/min"] // 跨窗口起点
    ];
    rows.forEach(([recordStart, recordEnd, value, unit], index) => {
      bulk.health.run(`hr-${index}`, hr, "Apple Watch", "apple_watch", unit, value, recordStart, recordEnd);
    });
    const speed = HEALTH_TYPES.speed;
    bulk.health.run("speed-0", speed, "Apple Watch", "apple_watch", "km/hr", 11.2,
      iso(denseStart + 300_000), iso(denseStart + 310_000));
    bulk.health.run("speed-1", speed, "Apple Watch", "apple_watch", "m/s", 3.1,
      iso(denseStart + 310_000), iso(denseStart + 320_000));
    const steps = HEALTH_TYPES.stepCount;
    bulk.health.run("step-0", steps, "Apple Watch", "apple_watch", "count", 10,
      iso(denseStart + 400_000), iso(denseStart + 405_000));
    bulk.health.run("step-1", steps, "Apple Watch", "apple_watch", "count", 20,
      iso(denseStart + 410_000), iso(denseStart + 415_000));
    bulk.health.run("step-2", steps, "Apple Watch", "apple_watch", "count", 30,
      iso(denseStart + 420_000), iso(denseStart + 425_000));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertScaleDataset(database, scale, seed) {
  const random = mulberry32(seed);
  const bulk = prepareBulk(database);
  const workoutCount = scale.workouts;
  const targetRecords = scale.healthRecords;
  const workoutSpan = NOW_MS - BASE_MS;
  const workoutStep = Math.floor(workoutSpan / Math.max(1, workoutCount));
  const workoutDuration = HOUR_MS;
  // 约 80% 健康记录落在训练窗口内；其余作为全天背景（步数为主），逼近真实倾斜。
  const workoutBudget = Math.floor(targetRecords * 0.8);
  const backgroundBudget = targetRecords - workoutBudget;
  const basePerWorkout = Math.floor(workoutBudget / Math.max(1, workoutCount));
  const denseEvery = 50;
  const denseExtra = 0; // 稠密窗口用同一预算，不额外膨胀总量

  const workoutRows = [];
  for (let index = 0; index < workoutCount; index += 1) {
    const startedAt = BASE_MS + index * workoutStep;
    const sourceName = index % 7 === 0 ? "RQ Run" : index % 13 === 0 ? "Garmin" : "Apple Watch";
    const sourceCategory = sourceName === "Apple Watch" ? "apple_watch" : "third_party";
    const indoor = index % 7 === 0 ? 1 : index % 11 === 0 ? null : 0;
    const deleted = index % 100 === 99 ? iso(startedAt + 2 * DAY_MS) : null;
    const id = `w${index}`;
    const sessionId = `s${index}`;
    bulk.workout.run(id, sourceName, sourceCategory, iso(startedAt), iso(startedAt + workoutDuration), workoutDuration / 1000, indoor, deleted);
    bulk.session.run(sessionId, iso(startedAt), iso(startedAt + workoutDuration), 10 + (index % 50) / 10, id);
    if (index % 20 !== 0) {
      bulk.route.run(`r${index}`, id, sourceName, iso(startedAt), iso(startedAt + workoutDuration), 500);
    }
    workoutRows.push({ index, id, sessionId, startedAt, sourceName, sourceCategory, indoor, deleted, dense: index % denseEvery === 0 });
  }

  const featureRunId = "fr1";
  const modelRunId = "mr1";
  const metricRunId = "tmr1";
  database.exec("BEGIN");
  try {
    database.prepare(`INSERT INTO feature_runs
      (id, dataset_version, canonical_contract_version, feature_schema_version, feature_config_json,
       feature_config_hash, status, created_at, completed_at)
      VALUES (?, 'phase2', 'v1', 'v1', '{}', 'hash', 'succeeded', ?, ?)`)
      .run(featureRunId, iso(BASE_MS), iso(BASE_MS));
    database.prepare(`INSERT INTO model_runs
      (id, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
       evaluated_at, status, created_at, completed_at)
      VALUES (?, ?, 'phase2', 'phase2-model', '{}', 'hash', ?, 'succeeded', ?, ?)`)
      .run(modelRunId, featureRunId, iso(BASE_MS), iso(BASE_MS), iso(BASE_MS));
    database.prepare("INSERT INTO active_model_run (singleton, model_run_id, activated_at) VALUES (1, ?, ?)")
      .run(modelRunId, iso(BASE_MS));
    database.prepare(`INSERT INTO training_metric_runs
      (id, model_run_id, algorithm_version, config_json, config_hash, timezone_identifier,
       evaluated_at, status, created_at, completed_at)
      VALUES (?, ?, 'v1', '{}', 'hash', 'Asia/Shanghai', ?, 'succeeded', ?, ?)`)
      .run(metricRunId, modelRunId, iso(BASE_MS), iso(BASE_MS), iso(BASE_MS));
    database.prepare(`INSERT INTO daily_zone_profiles
      (id, training_metric_run_id, local_date, timezone_identifier, effective_at,
       resting_heart_rate_bpm, maximum_heart_rate_bpm, threshold_pace_seconds_per_km,
       heart_rate_source, pace_source, heart_rate_confidence, pace_confidence, profile_status,
       heart_rate_bands_json, pace_bands_json, evidence_json, created_at)
      VALUES ('dzp1', ?, '2023-09-01', 'Asia/Shanghai', ?, 50, 190, 300,
              'automatic', 'automatic', 0.9, 0.9, 'stable', '[]', '[]', '{}', ?)`)
      .run(metricRunId, iso(BASE_MS), iso(BASE_MS));

    const insertFeature = database.prepare(`INSERT INTO workout_features
      (id, feature_run_id, training_session_id, canonical_workout_id, workout_start_at, duration_seconds,
       distance_km, average_speed_mps, average_heart_rate_bpm, heart_rate_sample_count, heart_rate_coverage,
       route_point_count, route_quality, source_confidence, session_type, session_type_source,
       eligibility_status, quality_score, missing_reasons_json, features_json, provenance_json, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, '[]', '{}', '{}', ?)`);
    const insertAssessment = database.prepare(`INSERT INTO ability_assessments
      (id, model_run_id, feature_id, training_session_id, sequence_number, assessment_status,
       current_ability, confidence, effective_weights_json, confidence_factors_json,
       true_ability_delta, updated_true_ability, explanation_codes_json, explanation_json, assessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', ?, 1, '[]', '{}', ?)`);
    const insertZone = database.prepare(`INSERT INTO workout_zone_summaries
      (id, training_metric_run_id, training_session_id, feature_id, zone_profile_id, stimulus_type,
       secondary_stimulus_types_json, stimulus_confidence, heart_rate_coverage, pace_coverage,
       heart_rate_exposure_json, pace_exposure_json, stimulus_scores_json, explanation_codes_json, computed_at)
      VALUES (?, ?, ?, ?, 'dzp1', ?, '[]', ?, ?, ?, '{}', '{}', '{}', '[]', ?)`);
    const stimulusTypes = ["recovery", "aerobic_base", "marathon_pace", "lactate_threshold", "vo2max", "anaerobic_endurance", "unclassified"];
    const eligibility = ["eligible", "eligible", "eligible", "trial", "excluded"];

    for (const row of workoutRows) {
      if (row.index % 10 === 0) continue; // 10% pending：事实已提交、分析未发布
      const featureId = `f${row.index}`;
      const status = eligibility[row.index % eligibility.length];
      insertFeature.run(featureId, featureRunId, row.sessionId, row.id, iso(row.startedAt),
        workoutDuration / 1000, 10 + (row.index % 50) / 10, 3.2, 145, 700, 0.9,
        row.index % 20 === 0 ? 0 : 500, 0.9, 0.9, row.index % 3 === 0 ? "interval" : "easy",
        status, 0.7 + (row.index % 30) / 100, iso(row.startedAt));
      insertAssessment.run(`a${row.index}`, modelRunId, featureId, row.sessionId, row.index + 1,
        status === "excluded" ? "excluded" : status === "trial" ? "trial" : "eligible",
        40 + (row.index % 20), 0.55 + (row.index % 40) / 100, (row.index % 10) / 100,
        iso(row.startedAt));
      insertZone.run(`z${row.index}`, metricRunId, row.sessionId, featureId,
        stimulusTypes[row.index % stimulusTypes.length], 0.7, 0.9, 0.8, iso(row.startedAt));
    }

    const insertHealth = bulk.health;
    const typeMix = [
      [HEALTH_TYPES.heartRate, 0.5, "count/min"],
      [HEALTH_TYPES.speed, 0.15, "km/hr"],
      [HEALTH_TYPES.power, 0.1, "W"],
      [HEALTH_TYPES.stepCount, 0.08, "count"],
      [HEALTH_TYPES.stride, 0.06, "m"],
      [HEALTH_TYPES.verticalOscillation, 0.06, "cm"],
      [HEALTH_TYPES.groundContact, 0.05, "ms"]
    ];
    let recordId = 0;
    for (const row of workoutRows) {
      const dense = row.dense;
      const perWorkout = dense ? basePerWorkout + denseExtra : basePerWorkout;
      const intervalMs = Math.max(1, Math.floor((workoutDuration - 1000) / Math.max(1, perWorkout)));
      for (let sample = 0; sample < perWorkout; sample += 1) {
        const roll = random();
        let cumulative = 0;
        let chosen = typeMix[0];
        for (const candidate of typeMix) {
          cumulative += candidate[1];
          if (roll <= cumulative) { chosen = candidate; break; }
        }
        const [type, , unit] = chosen;
        const startedAt = row.startedAt + 1000 + sample * intervalMs;
        const value = type === HEALTH_TYPES.heartRate ? 120 + (sample % 60)
          : type === HEALTH_TYPES.stepCount ? 10 + (sample % 20)
            : type === HEALTH_TYPES.speed ? 9 + (sample % 50) / 10
              : type === HEALTH_TYPES.power ? 180 + (sample % 80)
                : type === HEALTH_TYPES.stride ? 0.9 + (sample % 20) / 100
                  : type === HEALTH_TYPES.verticalOscillation ? 7 + (sample % 30) / 10
                    : 220 + (sample % 60);
        insertHealth.run(`h${recordId}`, type, row.sourceName, row.sourceCategory, unit,
          Math.round(value * 100) / 100, iso(startedAt), iso(startedAt + Math.min(30_000, intervalMs)));
        recordId += 1;
      }
    }
    // 稠密窗口：让一小部分训练拥有 >1200 个 HR 样本，覆盖 599/600/601 与高密度边界。
    let denseExtraRows = 0;
    for (const row of workoutRows.filter((item) => item.dense).slice(0, 12)) {
      for (let sample = 0; sample < 1200; sample += 1) {
        const startedAt = row.startedAt + 1000 + sample * 3000;
        insertHealth.run(`hd${recordId}`, HEALTH_TYPES.heartRate, row.sourceName, row.sourceCategory,
          "count/min", 125 + (sample % 55), iso(startedAt), iso(startedAt + 3000));
        recordId += 1;
        denseExtraRows += 1;
      }
      // 同窗口的其它指标，制造同 source 多 type 的混合密度。
      for (let sample = 0; sample < 300; sample += 1) {
        const startedAt = row.startedAt + 2000 + sample * 12_000;
        insertHealth.run(`hs${recordId}`, HEALTH_TYPES.speed, row.sourceName, row.sourceCategory,
          "km/hr", 9 + (sample % 40) / 10, iso(startedAt), iso(startedAt + 10_000));
        recordId += 1;
        denseExtraRows += 1;
      }
    }

    // 背景记录：主要来自 Apple Watch 的步数/心率，覆盖全天，制造 source 倾斜。
    const backgroundInterval = Math.max(1, Math.floor(workoutSpan / Math.max(1, backgroundBudget)));
    for (let sample = 0; sample < backgroundBudget; sample += 1) {
      const startedAt = BASE_MS + sample * backgroundInterval;
      const isStep = sample % 10 < 7;
      const type = isStep ? HEALTH_TYPES.stepCount : HEALTH_TYPES.heartRate;
      const sourceName = sample % 9 === 0 ? "RQ Run" : "Apple Watch";
      insertHealth.run(`hb${recordId}`, type, sourceName, sourceName === "Apple Watch" ? "apple_watch" : "third_party",
        isStep ? "count" : "count/min", isStep ? 20 + (sample % 30) : 70 + (sample % 40),
        iso(startedAt), iso(startedAt + 60_000));
      recordId += 1;
    }
    database.exec("COMMIT");
    return { workoutRows, recordCount: recordId, denseExtraRows, typeMix };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function buildDataset(name, scaleKey, seed) {
  const scale = SCALES[scaleKey];
  const dir = insideRoot(join(root, "datasets", name));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rai.sqlite");
  if (existsSync(path)) rmSync(path, { force: true });
  await createEmptyDatabase(path);
  // 基准基线固定为阶段 2 起点 v46：当前工作树已经包含候选 v47 索引，
  // 因此从同一迁移链生成的基线副本要显式退回 v46 的真实 DDL（索引不存在、
  // 账本无 47 行），而不是用“删一行账本”冒充旧 schema。
  {
    const baseline = new DatabaseSync(path);
    try {
      baseline.exec("DROP INDEX IF EXISTS idx_ability_assessments_session");
      baseline.exec("DELETE FROM schema_migrations WHERE version = 47");
    } finally { baseline.close(); }
  }
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("PRAGMA synchronous = OFF");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  let metadata;
  try {
    if (scaleKey === "d0") {
      insertSemanticDataset(database);
      metadata = { workoutRows: [], recordCount: 18 };
    } else {
      metadata = insertScaleDataset(database, scale, seed);
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  const manifest = {
    name,
    scale: scaleKey,
    schemaVersion: 46,
    label: scale.label,
    seed,
    path,
    bytes: fileSizes(path),
    sha256: sha256File(path),
    counts: tableCounts(new DatabaseSync(path, { readOnly: true })),
    sqlite: (() => { const db = new DatabaseSync(path, { readOnly: true }); const info = sqliteInfo(db); db.close(); return info; })(),
    indexes: (() => { const db = new DatabaseSync(path, { readOnly: true }); const list = indexList(db); db.close(); return list; })(),
    workoutSampleIds: (scaleKey === "d0"
      ? [{ id: "w-old", dense: true }]
      : metadata.workoutRows?.filter((row) => row.dense).slice(0, 12).map((row) => row.id) ?? []).map((row) => row.id),
    sampleWorkoutIds: scaleKey === "d0" ? ["w-old"] : metadata.workoutRows?.slice(0, 5).map((row) => row.id) ?? [],
    workoutWindows: (scaleKey === "d0"
      ? [{ id: "w-old", sessionId: "s-old", startedAt: BASE_MS + DAY_MS, sourceName: "Apple Watch" }]
      : metadata.workoutRows?.slice(0, 5) ?? []).map((row) => ({
      id: row.id, sessionId: row.sessionId, startedAt: iso(row.startedAt), endedAt: iso(row.startedAt + HOUR_MS), sourceName: row.sourceName
    })),
    denseWindow: (() => {
      const row = scaleKey === "d0"
        ? { id: "w-old", sessionId: "s-old", startedAt: BASE_MS + DAY_MS, sourceName: "Apple Watch" }
        : metadata.workoutRows?.find((item) => item.dense);
      return row ? { id: row.id, sessionId: row.sessionId, startedAt: iso(row.startedAt), endedAt: iso(row.startedAt + HOUR_MS), sourceName: row.sourceName } : null;
    })(),
    recordCount: metadata.recordCount,
    denseExtraRows: metadata.denseExtraRows ?? 0,
    createdAt: new Date().toISOString()
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---------------------------------------------------------------------------
// 基准测量
// ---------------------------------------------------------------------------

function measureOnce(database, workload, iterations, warmup) {
  const samples = [];
  const rows = [];
  for (let warm = 0; warm < warmup; warm += 1) workload.run(database);
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const value = workload.run(database);
    samples.push(performance.now() - startedAt);
    if (index === 0) rows.push(value);
  }
  return { samples, firstResult: rows[0] };
}

function runRounds(database, workload, rounds, iterations, warmup) {
  const perRound = [];
  for (let round = 0; round < rounds; round += 1) {
    perRound.push(measureOnce(database, workload, iterations, warmup).samples);
  }
  const all = perRound.flat();
  return {
    rounds: perRound.map((samples) => summarize(samples)),
    summary: summarize(all),
    perRoundSamples: perRound
  };
}

function cloneBaseline(manifest, targetName) {
  const dir = insideRoot(join(root, "datasets", targetName));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rai.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${manifest.path}${suffix}`;
    if (existsSync(from)) copyFileSync(from, `${path}${suffix}`);
  }
  return path;
}

function createIndexCopy(manifest, targetName, ddl, indexName) {
  const path = cloneBaseline(manifest, targetName);
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    const startedAt = performance.now();
    database.exec(ddl);
    const buildMs = performance.now() - startedAt;
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const size = fileSizes(path);
    const indexes = indexList(database);
    return { path, buildMs, size, indexes, indexName };
  } finally {
    database.close();
  }
}

function querySet(manifest) {
  const dense = manifest.denseWindow ?? manifest.workoutWindows[0];
  const regular = manifest.workoutWindows[0];
  return { dense, regular };
}

function createWorkloads(manifest) {
  const { dense, regular } = querySet(manifest);
  return {
    "metricSeries.heartRate.dense": {
      family: "workout-series",
      run: (db) => new SqliteSeriesReadRepository(db)
        .metricSeries(HEALTH_TYPES.heartRate, "count/min", dense.startedAt, dense.endedAt, dense.sourceName),
      sql: `SELECT ... metricSeries heartRate`
    },
    "metricSeries.speed.dense": {
      family: "workout-series",
      run: (db) => new SqliteSeriesReadRepository(db)
        .metricSeries(HEALTH_TYPES.speed, "km/hr", dense.startedAt, dense.endedAt, dense.sourceName)
    },
    "metricSeries.heartRate.regular": {
      family: "workout-series",
      run: (db) => new SqliteSeriesReadRepository(db)
        .metricSeries(HEALTH_TYPES.heartRate, "count/min", regular.startedAt, regular.endedAt, regular.sourceName)
    },
    "metricSeries.stepCount.broad": {
      family: "workout-series",
      run: (db) => new SqliteSeriesReadRepository(db)
        .metricSeries(HEALTH_TYPES.stepCount, "count", iso(BASE_MS), iso(NOW_MS), "Apple Watch")
    },
    "metricIntervals.heartRate": {
      family: "overlap",
      run: (db) => new SqliteSeriesReadRepository(db)
        .metricIntervals(HEALTH_TYPES.heartRate, dense.sourceName, dense.startedAt, dense.endedAt)
    },
    "workouts.list.limit30": {
      family: "workouts",
      run: (db) => new SqliteWorkoutReadRepository(db).list("", [], 30, 0)
    },
    "workouts.list.offset1000": {
      family: "workouts",
      run: (db) => new SqliteWorkoutReadRepository(db).list("", [], 30, 1000)
    },
    "workouts.count": {
      family: "workouts",
      run: (db) => new SqliteWorkoutReadRepository(db).count("", [])
    },
    "workouts.list.status": {
      family: "workouts",
      run: (db) => {
        const repository = new SqliteWorkoutReadRepository(db);
        const filter = repository.buildListFilter({ status: "eligible" });
        return { items: repository.list(filter.where, filter.params, 30, 0), total: repository.count(filter.where, filter.params) };
      }
    },
    "workouts.list.route": {
      family: "workouts",
      run: (db) => {
        const repository = new SqliteWorkoutReadRepository(db);
        const filter = repository.buildListFilter({ route: "available", days: 365 });
        return { items: repository.list(filter.where, filter.params, 30, 0), total: repository.count(filter.where, filter.params) };
      }
    }
  };
}

function measureDataset(manifest, label, options = {}) {
  const database = new DatabaseSync(manifest.path, { readOnly: true });
  database.exec("PRAGMA busy_timeout = 5000");
  const workloads = createWorkloads(manifest);
  const selected = options.workloadNames === undefined
    ? Object.keys(workloads)
    : options.workloadNames.filter((name) => workloads[name] !== undefined);
  const measurements = {};
  try {
    for (const name of selected) {
      const workload = workloads[name];
      const probeStartedAt = performance.now();
      workload.run(database);
      const probeMs = performance.now() - probeStartedAt;
      const budget = probeMs > 250 ? 10 : probeMs > 25 ? 30 : probeMs > 5 ? 80 : ITERATIONS;
      const iterations = name.startsWith("workouts.") ? Math.min(budget, 120) : budget;
      const warmup = probeMs > 250 ? 2 : probeMs > 25 ? 5 : 20;
      measurements[name] = runRounds(database, workload, ROUNDS, iterations, warmup);
    }
  } finally {
    database.close();
  }
  return { label, measurements };
}

function captureLedger(manifest) {
  const database = new DatabaseSync(manifest.path, { readOnly: true });
  const ledger = [];
  const traced = createTracingDatabase(database, ledger, "read");
  const workloads = createWorkloads(manifest);
  try {
    for (const [name, workload] of Object.entries(workloads)) {
      workload.run(traced);
    }
  } finally {
    database.close();
  }
  const bySql = new Map();
  for (const entry of ledger) {
    const current = bySql.get(entry.sqlHash) ?? {
      sqlHash: entry.sqlHash, sql: entry.sql, calls: 0, totalMs: 0, maxMs: 0, rows: 0, roles: new Set(), params: entry.params
    };
    current.calls += 1;
    current.totalMs += entry.ms;
    current.maxMs = Math.max(current.maxMs, entry.ms);
    current.rows += entry.rows ?? 0;
    current.roles.add(entry.role);
    bySql.set(entry.sqlHash, current);
  }
  const aggregated = [...bySql.values()]
    .map((entry) => ({ ...entry, roles: [...entry.roles] }))
    .sort((left, right) => right.totalMs - left.totalMs);
  return { entries: ledger, aggregated };
}

function plansFor(manifest) {
  const database = new DatabaseSync(manifest.path, { readOnly: true });
  const { dense } = querySet(manifest);
  const plans = {};
  try {
    const metricSql = `
      WITH deduplicated AS (
        SELECT DISTINCT start_at, end_at, value_numeric, unit
        FROM health_records
        WHERE type = ? AND source_name = ? AND start_at >= ? AND start_at <= ? AND value_numeric IS NOT NULL
      ), numbered AS (
        SELECT start_at, end_at, value_numeric, unit,
          ROW_NUMBER() OVER (ORDER BY start_at) AS sample_number,
          COUNT(*) OVER () AS total_samples,
          FIRST_VALUE(unit) OVER (ORDER BY start_at) AS first_unit,
          ROW_NUMBER() OVER (ORDER BY value_numeric DESC, start_at) AS peak_rank
        FROM deduplicated
      )
      SELECT start_at, end_at, value_numeric, unit, total_samples, first_unit
      FROM numbered
      WHERE (sample_number - 1) % MAX(1, (total_samples + 598) / 599) = 0
        OR sample_number = total_samples
        OR peak_rank = 1
      ORDER BY sample_number`;
    plans["metricSeries.heartRate.dense"] = queryPlan(database, metricSql,
      [HEALTH_TYPES.heartRate, dense.sourceName, dense.startedAt, dense.endedAt]);
    plans["metricSeries.stepCount.broad"] = queryPlan(database, metricSql,
      [HEALTH_TYPES.stepCount, "Apple Watch", iso(BASE_MS), iso(NOW_MS)]);
    const overlap = readHealthRecordOverlap(database, {
      type: HEALTH_TYPES.heartRate, sourceName: dense.sourceName,
      startedAt: dense.startedAt, endedAt: dense.endedAt,
      columns: ["start_at", "end_at", "value_numeric", "unit"]
    }, { cache: new HealthRecordDurationCache() });
    plans["metricIntervals.heartRate"] = { shape: overlap.shape, rows: overlap.rows.length };
    plans["facts.analysisMarker"] = queryPlan(database,
      "SELECT 1 FROM active_ability_assessments presence WHERE presence.training_session_id = ?", ["s0"]);
    plans["workouts.pendingAnalysisCount"] = queryPlan(database, `
      SELECT COUNT(*) AS n FROM training_sessions session
      JOIN workouts workout ON workout.id = session.canonical_workout_id AND workout.deleted_at IS NULL
      WHERE session.status = 'active' AND NOT EXISTS (
        SELECT 1 FROM active_ability_assessments presence WHERE presence.training_session_id = session.id)`);
  } finally {
    database.close();
  }
  return plans;
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

/**
 * D0 的样本窗口必须与 `denseWindow` 对齐；这里把“非空、峰值、单位、时间边界”
 * 变成显式断言，而不是只看 baseline/candidate 是否都返回同样的空数组。
 */
function observeD0(manifest) {
  const dense = querySet(manifest).dense;
  if (!dense) throw new Error("D0 has no dense window");
  const database = new DatabaseSync(manifest.path, { readOnly: true });
  try {
    const workloads = createWorkloads(manifest);
    const heartRate = workloads["metricSeries.heartRate.dense"].run(database);
    const speed = workloads["metricSeries.speed.dense"].run(database);
    const stepCount = workloads["metricSeries.stepCount.broad"].run(database);
    const intervals = workloads["metricIntervals.heartRate"].run(database);
    const seriesFacts = (value) => ({
      unit: value?.unit ?? null,
      totalSamples: value?.totalSamples ?? null,
      pointCount: Array.isArray(value?.points) ? value.points.length : null,
      values: Array.isArray(value?.points) ? value.points.map((point) => point.value) : []
    });
    return {
      window: { startedAt: dense.startedAt, endedAt: dense.endedAt, sourceName: dense.sourceName },
      heartRate: seriesFacts(heartRate),
      speed: seriesFacts(speed),
      stepCount: seriesFacts(stepCount),
      intervals: {
        rows: Array.isArray(intervals) ? intervals.length : null,
        values: Array.isArray(intervals) ? intervals.map((interval) => interval.value) : [],
        intervals: Array.isArray(intervals) ? intervals : []
      }
    };
  } finally {
    database.close();
  }
}

function assertD0(manifest) {
  const observed = observeD0(manifest);
  const checks = [];
  const check = (name, expected, actual, pass = canonicalJson(expected) === canonicalJson(actual)) => {
    checks.push({ name, expected, actual, pass });
  };
  const sorted = (values) => [...values].sort((left, right) => left - right);
  const countValue = (values, value) => values.filter((item) => item === value).length;
  const windowStart = Date.parse(observed.window.startedAt);
  const windowEnd = Date.parse(observed.window.endedAt);

  const hr = observed.heartRate;
  check("heartRate.nonEmpty", true, (hr.totalSamples ?? 0) > 0);
  check("heartRate.totalSamples", 9, hr.totalSamples);
  check("heartRate.unit", "count/min", hr.unit);
  check("heartRate.pointCount", 9, hr.pointCount);
  check("heartRate.sortedValues", [135, 140, 141, 141, 150, 150, 170, 190, 190], sorted(hr.values));
  check("heartRate.offsetTextExcluded", 0, countValue(hr.values, 160));
  check("heartRate.peak", 190, Math.max(...hr.values));
  check("heartRate.peakTieIncluded", 2, countValue(hr.values, 190));
  check("heartRate.exactDuplicateCollapsed", 1, countValue(hr.values, 140));
  check("heartRate.unitVariantRetained", 2, countValue(hr.values, 141));
  check("heartRate.rightEdgeIncluded", 1, countValue(hr.values, 170));
  check("heartRate.crossStartExcluded", 0, countValue(hr.values, 130));
  check("heartRate.nullExcluded", false, hr.values.some((value) => value === 0 || !Number.isFinite(value)));

  const speed = observed.speed;
  check("speed.nonEmpty", true, (speed.totalSamples ?? 0) > 0);
  check("speed.totalSamples", 2, speed.totalSamples);
  check("speed.unit", "km/hr", speed.unit);
  check("speed.sortedValues", [3.1, 11.2], sorted(speed.values));

  const steps = observed.stepCount;
  check("stepCount.nonEmpty", true, (steps.totalSamples ?? 0) > 0);
  check("stepCount.totalSamples", 3, steps.totalSamples);
  check("stepCount.unit", "count", steps.unit);
  check("stepCount.max", 30, Math.max(...steps.values));

  const intervals = observed.intervals;
  check("intervals.nonEmpty", true, (intervals.rows ?? 0) > 0);
  check("intervals.rows", 10, intervals.rows);
  check("intervals.peakTie", 2, countValue(intervals.values, 190));
  check("intervals.exactDuplicateCollapsed", 1, countValue(intervals.values, 140));
  check("intervals.unitVariantRetained", 2, countValue(intervals.values, 141));
  check("intervals.sameStartDifferentEnd", 2, countValue(intervals.values, 150));
  const tied150 = intervals.intervals.filter((interval) => interval.value === 150);
  check("intervals.sameStartDifferentEndShape", true,
    tied150.length === 2 && tied150[0].startMs === tied150[1].startMs && tied150[0].endMs !== tied150[1].endMs);
  const crossing = intervals.intervals.filter((interval) => interval.value === 130);
  check("intervals.crossStartClipped", true,
    crossing.length === 1 && crossing[0].startMs === windowStart && crossing[0].endMs === windowStart + 20_000);
  const offset = intervals.intervals.filter((interval) => interval.value === 160);
  check("intervals.offsetTextParsed", true,
    offset.length === 1 && offset[0].startMs === Date.parse(observed.window.startedAt) + 380_000);
  check("intervals.rightEdgeAbsent", 0, countValue(intervals.values, 170));
  check("intervals.bounds", true,
    intervals.intervals.every((interval) => interval.startMs >= windowStart
      && interval.endMs <= windowEnd && interval.endMs > interval.startMs));
  check("intervals.nullExcluded", false, intervals.values.includes(0));
  check("intervals.finiteValues", true, intervals.values.every((value) => Number.isFinite(value)));

  return {
    window: observed.window,
    observations: {
      heartRate: hr,
      speed,
      stepCount: steps,
      intervals: { rows: intervals.rows, values: intervals.values }
    },
    checks,
    ok: checks.every((item) => item.pass)
  };
}

function valueShape(value) {
  if (Array.isArray(value)) return { kind: "array", rows: value.length };
  if (Array.isArray(value?.items)) return { kind: "list", rows: value.items.length, total: value.total ?? null };
  if (typeof value?.totalSamples === "number") {
    return {
      kind: "metric-series",
      rows: Array.isArray(value.points) ? value.points.length : 0,
      totalSamples: value.totalSamples,
      unit: value.unit ?? null
    };
  }
  return { kind: value === null ? "null" : typeof value };
}

function runDifferential(manifestA, manifestB, options = {}) {
  const results = {};
  const workloads = createWorkloads(manifestA);
  const dbA = new DatabaseSync(manifestA.path, { readOnly: true });
  const dbB = new DatabaseSync(manifestB.path, { readOnly: true });
  try {
    for (const [name, workload] of Object.entries(workloads)) {
      const a = workload.run(dbA);
      const b = workload.run(dbB);
      results[name] = {
        equal: canonicalJson(a) === canonicalJson(b),
        aHash: sha256(canonicalJson(a)),
        bHash: sha256(canonicalJson(b)),
        aRows: Array.isArray(a) ? a.length : Array.isArray(a?.items) ? a.items.length : null,
        aShape: valueShape(a),
        bShape: valueShape(b)
      };
    }
    // 完整列表 DTO（含 currentFacts / publishedAnalysis 附加块）与审计响应。
    if (options.storeLevel === false) return results;
    const storeA = new RaiReadStore(manifestA.path);
    const storeB = new RaiReadStore(manifestB.path);
    try {
      const listA = storeA.workoutsWithViews({ limit: 30, offset: 0 });
      const listB = storeB.workoutsWithViews({ limit: 30, offset: 0 });
      results["store.workoutsWithViews"] = {
        equal: canonicalJson(listA) === canonicalJson(listB),
        aHash: sha256(canonicalJson(listA)), bHash: sha256(canonicalJson(listB)), aRows: listA.items.length
      };
      const summaryA = storeA.dataSummary();
      const summaryB = storeB.dataSummary();
      delete summaryA.databaseBytes;
      delete summaryB.databaseBytes;
      results["store.dataSummary"] = {
        equal: canonicalJson(summaryA) === canonicalJson(summaryB),
        aHash: sha256(canonicalJson(summaryA)), bHash: sha256(canonicalJson(summaryB))
      };
      const auditA = storeA.dataAudit();
      const auditB = storeB.dataAudit();
      results["store.dataAudit"] = {
        equal: canonicalJson(auditA) === canonicalJson(auditB),
        aHash: sha256(canonicalJson(auditA)), bHash: sha256(canonicalJson(auditB))
      };
    } finally {
      storeA.close();
      storeB.close();
    }
  } finally {
    dbA.close();
    dbB.close();
  }
  return results;
}

function measureAuditAndConnection(manifest) {
  const store = new RaiReadStore(manifest.path);
  const manager = new ReadStoreManager(manifest.path);
  const result = {};
  try {
    // 冷缓存：每次新建 store（真实首读）；热缓存：同一 store 再读；外部提交后首读：另一连接写一条记录。
    const coldSummary = [];
    for (let index = 0; index < 10; index += 1) {
      const fresh = new RaiReadStore(manifest.path);
      const startedAt = performance.now();
      fresh.dataSummary();
      coldSummary.push(performance.now() - startedAt);
      fresh.close();
    }
    result["audit.dataSummary.cold"] = summarize(coldSummary);
    result["audit.dataSummary.warm"] = runRounds(null, { run: () => store.dataSummary() }, ROUNDS, 60, 5);
    const coldAudit = [];
    for (let index = 0; index < 5; index += 1) {
      const fresh = new RaiReadStore(manifest.path);
      const startedAt = performance.now();
      fresh.dataAudit();
      coldAudit.push(performance.now() - startedAt);
      fresh.close();
    }
    result["audit.dataAudit.cold"] = summarize(coldAudit);
    result["audit.dataAudit.warm"] = runRounds(null, { run: () => store.dataAudit() }, Math.min(ROUNDS, 3), 40, 3);
    // 外部提交后首读：写连接插入一条 health_record，data_version 推进，缓存失效。
    const writer = new DatabaseSync(manifest.path);
    writer.exec("PRAGMA busy_timeout = 5000");
    const insert = writer.prepare(`INSERT INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
      VALUES (?, 'HKQuantityTypeIdentifierHeartRate', 'Apple Watch', 'apple_watch', 'count/min', 150, ?, ?, '{}', '{}')`);
    result["audit.dataSummary.afterCommit"] = runRounds(null, {
      run: () => {
        insert.run(`phase2-${Date.now()}-${Math.random()}`, iso(NOW_MS + 1000), iso(NOW_MS + 2000));
        return store.dataSummary();
      }
    }, 3, 10, 0);
    writer.close();
    // 连接生命周期：缓存 use() vs 每次新建只读连接。
    result["connection.cachedUse"] = runRounds(null, { run: () => manager.use((current) => current.dataVersion()) }, ROUNDS, 200, 10);
    result["connection.useDatabase"] = runRounds(null, { run: () => manager.useDatabase((db) => db.prepare("SELECT 1 AS value").get()) }, ROUNDS, 100, 5);
    result["endpoint.workouts.limit30"] = runRounds(null, { run: () => store.workouts({ limit: 30, offset: 0 }) }, ROUNDS, 60, 5);
    result["endpoint.workoutsWithViews.limit30"] = runRounds(null, { run: () => store.workoutsWithViews({ limit: 30, offset: 0 }) }, ROUNDS, 60, 5);
    const dense = querySet(manifest).dense;
    if (dense) {
      result["endpoint.workoutSeries.dense"] = runRounds(null, { run: () => store.workoutSeries(dense.sessionId) }, Math.min(ROUNDS, 3), 20, 2);
    }
  } finally {
    store.close();
    manager.close();
  }
  return result;
}

function measureOverlapCache(manifest) {
  const { dense } = querySet(manifest);
  const database = new DatabaseSync(manifest.path);
  database.exec("PRAGMA busy_timeout = 5000");
  const cache = new HealthRecordDurationCache();
  const query = {
    type: HEALTH_TYPES.heartRate, sourceName: dense.sourceName,
    startedAt: dense.startedAt, endedAt: dense.endedAt,
    columns: ["start_at", "end_at", "value_numeric", "unit"]
  };
  const result = {};
  try {
    result["overlap.coldStats"] = runRounds(database, {
      run: (db) => readHealthRecordOverlap(db, query, { cache: new HealthRecordDurationCache() })
    }, ROUNDS, 10, 0);
    result["overlap.warm"] = runRounds(database, {
      run: (db) => readHealthRecordOverlap(db, query, { cache })
    }, ROUNDS, 100, 5);
    const manifestWriter = new DatabaseSync(manifest.path);
    manifestWriter.exec("PRAGMA busy_timeout = 5000");
    const noopWrite = manifestWriter.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES ('phase2_noop_receipt', ?)");
    result["overlap.afterNoopReceipt"] = runRounds(database, {
      run: (db) => {
        noopWrite.run(iso(NOW_MS + 10_000));
        return readHealthRecordOverlap(db, query, { cache });
      }
    }, 3, 10, 0);
    manifestWriter.close();
    const writer = new DatabaseSync(manifest.path);
    writer.exec("PRAGMA busy_timeout = 5000");
    const insert = writer.prepare(`INSERT INTO health_records
      (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
      VALUES (?, 'HKQuantityTypeIdentifierHeartRate', ?, 'apple_watch', 'count/min', 151, ?, ?, '{}', '{}')`);
    result["overlap.afterCommit"] = runRounds(database, {
      run: (db) => {
        insert.run(`overlap-${Date.now()}-${Math.random()}`, dense.sourceName, iso(NOW_MS + 5000), iso(NOW_MS + 6000));
        return readHealthRecordOverlap(db, query, { cache });
      }
    }, 3, 20, 0);
    writer.close();
  } finally { database.close(); }
  return result;
}

function measureIndexEndpoint(manifest) {
  const store = new RaiReadStore(manifest.path);
  const result = {};
  try {
    const endpointProbe = performance.now();
    store.workoutsWithViews({ limit: 30, offset: 0 });
    const endpointMs = performance.now() - endpointProbe;
    const endpointIterations = endpointMs > 100 ? 20 : endpointMs > 25 ? 30 : 50;
    result["endpoint.workouts"] = runRounds(null, { run: () => store.workouts({ limit: 30, offset: 0 }) }, ROUNDS, endpointIterations, 5);
    result["endpoint.workoutsWithViews"] = runRounds(null, { run: () => store.workoutsWithViews({ limit: 30, offset: 0 }) }, ROUNDS, endpointIterations, 5);
    const dense = querySet(manifest).dense;
    if (dense) result["endpoint.workoutSeries.dense"] = runRounds(null, { run: () => store.workoutSeries(dense.sessionId) }, Math.min(ROUNDS, 3), 20, 2);
  } finally { store.close(); }
  return result;
}

function openBenchmarkWriter(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    const journalBefore = String(database.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "");
    if (journalBefore.toLowerCase() !== "wal") database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    const pragmas = {
      foreignKeys: Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? -1),
      journalMode: String(database.prepare("PRAGMA journal_mode").get()?.journal_mode ?? ""),
      synchronous: Number(database.prepare("PRAGMA synchronous").get()?.synchronous ?? -1),
      busyTimeout: Number(database.prepare("PRAGMA busy_timeout").get()?.timeout ?? -1)
    };
    if (pragmas.foreignKeys !== 1 || pragmas.journalMode.toLowerCase() !== "wal" || pragmas.synchronous !== 1) {
      throw new Error(`write benchmark pragmas do not match the production write path: ${JSON.stringify(pragmas)}`);
    }
    return { database, pragmas };
  } catch (error) {
    database.close();
    throw error;
  }
}

function measureTransaction(database, rowsPerTransaction, insertRows) {
  const samples = [];
  for (let round = 0; round < 5; round += 1) {
    const startedAt = performance.now();
    database.exec("BEGIN IMMEDIATE");
    const begunAt = performance.now();
    insertRows(round);
    const insertedAt = performance.now();
    database.exec("COMMIT");
    const committedAt = performance.now();
    samples.push({
      totalMs: committedAt - startedAt,
      beginMs: begunAt - startedAt,
      insertMs: insertedAt - begunAt,
      commitMs: committedAt - insertedAt
    });
  }
  return {
    rowsPerTransaction,
    transaction: summarize(samples.map((sample) => sample.totalMs)),
    begin: summarize(samples.map((sample) => sample.beginMs)),
    insert: summarize(samples.map((sample) => sample.insertMs)),
    commit: summarize(samples.map((sample) => sample.commitMs)),
    samples
  };
}

function measureAbilityInsertCost(path) {
  const { database, pragmas } = openBenchmarkWriter(path);
  const baseModelRun = database.prepare(
    "SELECT id, feature_run_id FROM model_runs WHERE status = 'succeeded' ORDER BY id LIMIT 1"
  ).get();
  if (!baseModelRun) {
    database.close();
    return { skipped: true, reason: "no succeeded model run to anchor assessment writes", pragmas };
  }
  const anchors = database.prepare(`
    SELECT feature.id AS feature_id, feature.training_session_id AS session_id
    FROM workout_features feature
    JOIN training_sessions session ON session.id = feature.training_session_id
    ORDER BY feature.id
    LIMIT 500
  `).all();
  if (anchors.length === 0) {
    database.close();
    return { skipped: true, reason: "no feature/session pairs available", pragmas };
  }
  const cloneModelRun = database.prepare(`
    INSERT INTO model_runs
      (id, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
       evaluated_at, status, created_at, completed_at)
    SELECT ?, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
           evaluated_at, status, created_at, completed_at
    FROM model_runs WHERE id = ?
  `);
  const insert = database.prepare(`INSERT INTO ability_assessments
    (id, model_run_id, feature_id, training_session_id, sequence_number, assessment_status,
     confidence, effective_weights_json, confidence_factors_json, updated_true_ability,
     explanation_codes_json, explanation_json, assessed_at)
    VALUES (?, ?, ?, ?, ?, 'eligible', 0.7, '{}', '{}', 1, '[]', '{}', ?)`);
  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const result = measureTransaction(database, anchors.length, (round) => {
      const modelRunId = `write-model-${runId}-${round}`;
      cloneModelRun.run(modelRunId, baseModelRun.id);
      for (const [index, anchor] of anchors.entries()) {
        insert.run(`write-a-${runId}-${round}-${index}`, modelRunId, anchor.feature_id,
          anchor.session_id, 10_000 + index, iso(NOW_MS));
      }
    });
    return { ...result, pragmas, anchorModelRun: baseModelRun.id };
  } finally { database.close(); }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const meta = {
  startedAt: new Date().toISOString(),
  userCwd: process.cwd(),
  node: process.version,
  platform: `${platform()} ${release()} ${arch()}`,
  cpu: cpus().map((cpu) => cpu.model).slice(0, 1)[0],
  cores: cpus().length,
  sqlite: process.versions.sqlite,
  isolation: {
    rootReal: (() => { try { return realpathSync(root); } catch { return root; } })(),
    repoReal: (() => { try { return realpathSync(REPO_ROOT); } catch { return REPO_ROOT; } })(),
    repoVarReal: (() => { try { return realpathSync(join(REPO_ROOT, "var")); } catch { return join(REPO_ROOT, "var"); } })()
  },
  gitHead: (() => {
    try {
      const head = readFileSync(join(REPO_ROOT, ".git", "HEAD"), "utf8").trim();
      if (head.startsWith("ref: ")) return readFileSync(join(REPO_ROOT, ".git", head.slice(5)), "utf8").trim();
      return head;
    } catch { return null; }
  })(),
  root,
  scenario: SCENARIO,
  rounds: ROUNDS,
  iterations: ITERATIONS
};

const selected = SCENARIO === "all" ? ["d0", "d1", "d2", "d3"] : [SCENARIO];
const output = {
  meta,
  manifests: {},
  measurements: {},
  indexExperiment: {},
  differential: {},
  assertions: {},
  plans: {},
  ledger: {},
  failures: [],
  skippedCandidates: {
    healthIndexes: SKIP_HEALTH_CANDIDATES ? ["narrow", "cover"] : [],
    reason: SKIP_HEALTH_CANDIDATES ? "--skip-health-candidates" : null
  }
};
try {
  for (const key of selected) {
    const manifest = await buildDataset(key, key, 20261021);
    output.manifests[key] = manifest;
    console.error(`[phase2] built ${key}: ${manifest.counts.health_records} health rows, ${manifest.counts.workouts} workouts, ${(manifest.bytes.total / 1024 / 1024).toFixed(1)} MiB`);
    if (key !== "d0") {
      output.measurements[key] = measureDataset(manifest, key);
      output.plans[key] = plansFor(manifest);
      output.ledger[key] = captureLedger(manifest);
      output.auditAndConnection = { ...(output.auditAndConnection ?? {}), [key]: measureAuditAndConnection(manifest) };
      output.overlapCache = { ...(output.overlapCache ?? {}), [key]: measureOverlapCache(manifest) };
    }
  }

  const experimentKeys = selected.filter((key) => key === "d1" || key === "d2" || key === "d3");
  for (const key of experimentKeys) {
    const baseline = output.manifests[key];
    const narrow = SKIP_HEALTH_CANDIDATES ? null : createIndexCopy(baseline, `${key}-candidate-a`,
      "CREATE INDEX idx_health_records_type_source_start ON health_records(type, source_name, start_at)", "idx_health_records_type_source_start");
    const cover = SKIP_HEALTH_CANDIDATES ? null : createIndexCopy(baseline, `${key}-candidate-b`,
      "CREATE INDEX idx_health_records_type_source_series ON health_records(type, source_name, start_at, end_at, value_numeric, unit)", "idx_health_records_type_source_series");
    const ability = createIndexCopy(baseline, `${key}-candidate-c`,
      "CREATE INDEX idx_ability_assessments_session ON ability_assessments(training_session_id, model_run_id)", "idx_ability_assessments_session");
    output.indexExperiment[key] = {
      narrow: narrow === null ? null : { buildMs: narrow.buildMs, bytes: narrow.size, indexCount: narrow.indexes.length },
      cover: cover === null ? null : { buildMs: cover.buildMs, bytes: cover.size, indexCount: cover.indexes.length },
      ability: { buildMs: ability.buildMs, bytes: ability.size, indexCount: ability.indexes.length }
    };
    const baselineMeasurements = output.measurements[key]?.measurements ?? measureDataset(baseline, `${key}-baseline`).measurements;
    output.measurements[key] = { label: key, measurements: baselineMeasurements };
    output.indexExperiment[key].measurements = {
      baseline: baselineMeasurements,
      narrow: narrow === null ? null : measureDataset({ ...baseline, path: narrow.path }, `${key}-narrow`, {
        workloadNames: ["metricSeries.heartRate.dense", "metricSeries.speed.dense", "metricSeries.heartRate.regular", "metricSeries.stepCount.broad", "metricIntervals.heartRate"]
      }).measurements,
      cover: cover === null ? null : measureDataset({ ...baseline, path: cover.path }, `${key}-cover`, {
        workloadNames: ["metricSeries.heartRate.dense", "metricSeries.speed.dense", "metricSeries.heartRate.regular", "metricSeries.stepCount.broad", "metricIntervals.heartRate"]
      }).measurements,
      ability: measureDataset({ ...baseline, path: ability.path }, `${key}-ability`, { workloadNames: [] }).measurements
    };
    output.indexExperiment[key].endpoints = {
      baseline: measureIndexEndpoint(baseline),
      narrow: narrow === null ? null : measureIndexEndpoint({ ...baseline, path: narrow.path }),
      cover: cover === null ? null : measureIndexEndpoint({ ...baseline, path: cover.path }),
      ability: measureIndexEndpoint({ ...baseline, path: ability.path })
    };
    output.indexExperiment[key].plans = {
      baseline: output.plans[key] ?? plansFor(baseline),
      narrow: narrow === null ? null : plansFor({ ...baseline, path: narrow.path }),
      cover: cover === null ? null : plansFor({ ...baseline, path: cover.path }),
      ability: plansFor({ ...baseline, path: ability.path })
    };
    output.differential[key] = {
      narrow: narrow === null ? null : runDifferential(baseline, { ...baseline, path: narrow.path }),
      cover: cover === null ? null : runDifferential(baseline, { ...baseline, path: cover.path }),
      ability: runDifferential(baseline, { ...baseline, path: ability.path })
    };
    output.indexExperiment[key].writeCost = {
      baseline: measureInsertCost(baseline.path),
      narrow: narrow === null ? null : measureInsertCost(narrow.path),
      cover: cover === null ? null : measureInsertCost(cover.path),
      baselineAssessments: measureAbilityInsertCost(baseline.path),
      abilityAssessments: measureAbilityInsertCost(ability.path)
    };
  }

  if (selected.includes("d0")) {
    const baseline = output.manifests.d0;
    const narrow = createIndexCopy(baseline, "d0-candidate-a",
      "CREATE INDEX idx_health_records_type_source_start ON health_records(type, source_name, start_at)", "idx_health_records_type_source_start");
    const cover = createIndexCopy(baseline, "d0-candidate-b",
      "CREATE INDEX idx_health_records_type_source_series ON health_records(type, source_name, start_at, end_at, value_numeric, unit)", "idx_health_records_type_source_series");
    const ability = createIndexCopy(baseline, "d0-candidate-c",
      "CREATE INDEX idx_ability_assessments_session ON ability_assessments(training_session_id, model_run_id)", "idx_ability_assessments_session");
    output.differential.d0 = {
      narrow: runDifferential(baseline, { ...baseline, path: narrow.path }, { storeLevel: false }),
      cover: runDifferential(baseline, { ...baseline, path: cover.path }, { storeLevel: false }),
      ability: runDifferential(baseline, { ...baseline, path: ability.path })
    };
    output.assertions = {
      d0: {
        baseline: assertD0(baseline),
        narrow: assertD0({ ...baseline, path: narrow.path }),
        cover: assertD0({ ...baseline, path: cover.path }),
        ability: assertD0({ ...baseline, path: ability.path })
      }
    };
  }
} catch (error) {
  output.error = String(error?.stack ?? error);
  output.failures.push({ scope: "main", name: "exception", detail: output.error });
  console.error(error);
}

function collectFailures(evidence, expectedScenarios) {
  const failures = [...evidence.failures];
  const skipped = new Set(evidence.skippedCandidates?.healthIndexes ?? []);
  for (const key of expectedScenarios) {
    if (!evidence.manifests[key]) {
      failures.push({ scope: "scenario", name: key, detail: "selected scenario produced no manifest" });
    }
  }
  for (const [key, variants] of Object.entries(evidence.differential)) {
    for (const [variant, results] of Object.entries(variants)) {
      if (results === null && skipped.has(variant)) continue;
      if (!results || Object.keys(results).length === 0) {
        failures.push({ scope: "differential", name: `${key}.${variant}`, detail: "no comparison entries" });
        continue;
      }
      for (const [name, result] of Object.entries(results)) {
        if (result.equal !== true) {
          failures.push({
            scope: "differential",
            name: `${key}.${variant}.${name}`,
            detail: "baseline and candidate differ",
            expected: result.aHash,
            actual: result.bHash
          });
        }
        const shape = result.aShape;
        if (/^(metricSeries|metricIntervals)\./.test(name)
          && ((shape?.kind === "metric-series" && shape.totalSamples === 0)
            || (shape?.kind === "array" && shape.rows === 0))) {
          failures.push({
            scope: "differential",
            name: `${key}.${variant}.${name}`,
            detail: "comparison used an empty sequence; non-empty assertion required",
            actual: shape
          });
        }
      }
    }
  }
  for (const [candidate, result] of Object.entries(evidence.assertions?.d0 ?? {})) {
    for (const check of result.checks ?? []) {
      if (!check.pass) {
        failures.push({
          scope: "assertion",
          name: `d0.${candidate}.${check.name}`,
          detail: "D0 expectation failed",
          expected: check.expected,
          actual: check.actual
        });
      }
    }
  }
  return failures;
}

function measureInsertCost(path) {
  const { database, pragmas } = openBenchmarkWriter(path);
  const insert = database.prepare(`INSERT INTO health_records
    (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
    VALUES (?, 'HKQuantityTypeIdentifierHeartRate', 'Apple Watch', 'apple_watch', 'count/min', 150, ?, ?, '{}', '{}')`);
  const runId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    return {
      ...measureTransaction(database, 1000, (round) => {
        const base = NOW_MS + round * 3_600_000;
        for (let index = 0; index < 1000; index += 1) {
          insert.run(`write-${runId}-${round}-${index}`, iso(base + index * 1000), iso(base + index * 1000 + 500));
        }
      }),
      pragmas
    };
  } finally {
    database.close();
  }
}

output.meta.finishedAt = new Date().toISOString();
output.failures = collectFailures(output, selected);
output.verdict = {
  ok: output.failures.length === 0,
  failureCount: output.failures.length
};
const outputPath = JSON_OUT === null ? join(root, "phase2-evidence.json") : resolve(JSON_OUT);
writeFileSync(outputPath, JSON.stringify(output, null, 2));
if (!output.verdict.ok) {
  console.error(`[phase2] ${output.failures.length} acceptance failure(s); evidence written to ${outputPath}`);
  for (const failure of output.failures) console.error(`  - ${failure.scope}:${failure.name} ${failure.detail ?? ""}`);
  process.exitCode = 1;
} else {
  console.error(`[phase2] all acceptance checks passed; evidence written to ${outputPath}`);
}
