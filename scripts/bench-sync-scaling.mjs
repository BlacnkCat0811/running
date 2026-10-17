// 同步与计算扩展性基准（第三轮，2026-10-17）。
//
//   node --import tsx scripts/bench-sync-scaling.mjs [--json out.json] [--baseline base.json]
//
// 只建**合成库**（不复制生产/本地健康库），量的是仓库里真正跑的实现：
//   · canonicalize/no-dirty   每批没有任何训练变更时的规范化成本
//   · canonicalize/one-dirty  1 条变更 + N 条历史时的规范化成本
//   · daily/<days>            日指标从首日算到 throughDate（纯函数）
//   · gpx/<files>-of-<routes> 小批 GPX 的路线解析 + bundle 摘要
//
// 输出 p50/p95/max + runs；`--baseline` 打印倍率。性能判据一律"同条件新旧对比"，
// 本脚本不设通过阈值 —— 换机器/换时刻请以当次输出为准。
//
// ⚠️ 每次运行的采样数由场景**显式给定**（大库只跑 1–3 次），这样修复前后是同口径：
// 跑得慢的场景不能"为了 p95 好看"临时加次数。

import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { healthTypes, workoutTypes } from "@rai/contracts";
import { RaiDatabase } from "../packages/storage-sqlite/src/database.ts";
import { canonicalizeRunningWorkouts } from "../packages/health-export-parser/src/canonicalize.ts";
import { importGpxRoutes } from "../packages/health-export-parser/src/gpx-parser.ts";
import { buildDailyTrainingMetrics } from "../packages/training-load/src/index.ts";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const OUT_PATH = readArg("--json", null);
const BASELINE_PATH = readArg("--baseline", null);

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const baseInstant = Date.UTC(2019, 0, 1, 0, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    runs: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? null,
    min: sorted[0] ?? null,
    mean: sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length)
  };
}

function fmt(value) {
  if (value === null || !Number.isFinite(value)) return "—";
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function report(label, summary) {
  console.log(
    `${label.padEnd(36)} p50 ${fmt(summary.p50).padStart(8)} ms   `
    + `p95 ${fmt(summary.p95).padStart(8)} ms   max ${fmt(summary.max).padStart(8)} ms   (n=${summary.runs})`
  );
}

/** 采样：显式 warmups + runs；不做自适应（前后必须同口径）。 */
function measure(label, run, options) {
  const warmups = options.warmups;
  const runs = options.runs;
  for (let index = 0; index < warmups; index += 1) run();
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  const summary = summarize(samples);
  report(label, summary);
  return summary;
}

async function withDatabase(work) {
  const directory = mkdtempSync(join(tmpdir(), "rai-bench-"));
  const path = join(directory, "rai.sqlite");
  const store = await RaiDatabase.open(path, { createMigrationBackup: false });
  try {
    return await work(store, directory);
  } finally {
    store.close();
    // 基准的产物是可丢弃的：清理失败（沙箱删除策略 / 只读临时卷）不得把一次测量变成失败。
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // 留给 `var/bench-tmp` 的后续清理。
    }
  }
}

/**
 * 造 n 条跑步：每条都带距离统计（`distanceValue`/`unit` 走两次标量子查询），
 * 一半带心率统计（`heartRateStatisticCount`）。间隔 1 天，互相不构成重复。
 */
function seedWorkouts(store, n, options = {}) {
  const insertWorkout = store.database.prepare(`
    INSERT INTO workouts (
      id, activity_type, source_name, source_category, source_version, device,
      start_at, end_at, duration_seconds, metadata_json, raw_attributes_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}')
  `);
  const insertStat = store.database.prepare(`
    INSERT INTO workout_statistics (
      workout_id, ordinal, type, start_at, end_at, unit, sum_value,
      average_value, minimum_value, maximum_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `);
  const insertRoute = store.database.prepare(`
    INSERT INTO workout_routes (
      id, workout_id, source_name, source_category, start_at, end_at,
      relative_path, metadata_json, point_count, file_status
    ) VALUES (?, ?, 'bench', ?, ?, ?, ?, '{}', ?, 'imported')
  `);
  const insertFingerprint = store.database.prepare(`
    INSERT INTO route_file_fingerprints (
      relative_path, size_bytes, modified_at_ms, sha256, route_id, point_count, imported_at
    ) VALUES (?, 1000, 0, ?, ?, ?, ?)
  `);

  store.database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < n; index += 1) {
      const startedAt = baseInstant + index * DAY_MS + 7 * HOUR_MS;
      const endedAt = startedAt + 45 * 60_000;
      const id = `bench-workout-${index}`;
      insertWorkout.run(
        id,
        workoutTypes.running,
        `bench-source-${index % 3}`,
        ["apple_watch", "coros", "connect"][index % 3],
        "1",
        index % 2 === 0 ? "Watch" : null,
        iso(startedAt),
        iso(endedAt),
        45 * 60
      );
      insertStat.run(
        id, 0, healthTypes.distanceWalkingRunning, iso(startedAt), iso(endedAt), "m", 10_000
      );
      if (index % 2 === 0) {
        insertStat.run(id, 1, healthTypes.heartRate, iso(startedAt), iso(endedAt), "count/min", 150);
      }
      if (options.routes === true) {
        const relativePath = `workout-routes/bench-${index}.gpx`;
        insertRoute.run(
          `bench-route-${index}`, id, "apple_watch", iso(startedAt), iso(endedAt),
          relativePath, 500
        );
        insertFingerprint.run(
          relativePath, `sha-${index}`, `bench-route-${index}`, 500, iso(startedAt)
        );
      }
    }
    store.database.exec("COMMIT");
  } catch (error) {
    store.database.exec("ROLLBACK");
    throw error;
  }
}

function seedGpxFiles(directory, count, pointsPerFile) {
  mkdirSync(join(directory, "workout-routes"), { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const points = Array.from({ length: pointsPerFile }, (_, pointIndex) => {
      const at = baseInstant + index * DAY_MS + pointIndex * 1_000;
      return `<trkpt lat="${23 + pointIndex / 100000}" lon="${113 + pointIndex / 100000}">`
        + `<ele>${10 + pointIndex / 100}</ele><time>${iso(at)}</time>`
        + `<hAcc>5</hAcc><vAcc>5</vAcc></trkpt>`;
    }).join("\n    ");
    const document = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RAI">\n`
      + `  <trk><name>bench</name><trkseg>\n    ${points}\n  </trkseg></trk>\n</gpx>\n`;
    writeFileSync(join(directory, "workout-routes", `bench-${index}.gpx`), document, "utf8");
  }
}

function seedDailyLoads(days) {
  const loads = [];
  for (let index = 0; index < days; index += 1) {
    const localDate = iso(baseInstant + index * DAY_MS).slice(0, 10);
    if (index % 7 === 3) continue; // 真实数据有空洞：不是每天都训练。
    loads.push({
      trainingSessionId: `session-${index}`,
      localDate,
      distanceMeters: 10_000,
      durationSeconds: 2_700,
      load: 60 + (index % 11) * 3,
      intensity: 0.6,
      source: "heart_rate",
      confidence: 0.9,
      rpe: null,
      sessionType: "easy",
      averageHeartRate: 145,
      elevationGainMeters: 20,
      stimulusType: "aerobic_base",
      breakdown: {
        rawHrrTrimp: 50,
        internalLoad: 60,
        paceLoad: 55,
        distanceReferenceMeters: 10_000,
        distanceExposureRatio: 1,
        distanceFactor: 1,
        compositeLoad: 60,
        compositeIntensity: 0.6,
        heartRateConfidence: 0.9,
        paceConfidence: 0.8
      },
      explanations: []
    });
  }
  return loads;
}

const results = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${platform()}/${arch()}`,
  cpu: cpus()[0]?.model ?? "unknown",
  scenarios: {}
};

// ---- canonicalize：1k 跑 10 次，5k 跑 3 次，10k 只跑 1 次（修复前每次约 20s）----
for (const [size, warmups, runs] of [[1_000, 1, 10], [5_000, 1, 3], [10_000, 1, 1]]) {
  await withDatabase(async (store) => {
    seedWorkouts(store, size);
    canonicalizeRunningWorkouts(store.database); // 建组与会话：基准测的是"已有历史后的增量"
    const dirtyAt = iso(baseInstant + Math.floor(size / 2) * DAY_MS + 7 * HOUR_MS);
    results.scenarios[`canonicalize/no-dirty/${size}`] = measure(
      `canonicalize no-dirty n=${size}`,
      () => canonicalizeRunningWorkouts(store.database, { dirtyWorkoutTimes: [] }),
      { warmups, runs }
    );
    results.scenarios[`canonicalize/one-dirty/${size}`] = measure(
      `canonicalize one-dirty n=${size}`,
      () => canonicalizeRunningWorkouts(store.database, { dirtyWorkoutTimes: [dirtyAt] }),
      { warmups, runs }
    );
  });
}

// ---- 日指标：365 天跑 30 次，3650 天跑 3 次 ----
for (const [days, warmups, runs] of [[365, 3, 30], [3_650, 1, 3]]) {
  const loads = seedDailyLoads(days);
  const throughDate = iso(baseInstant + (days - 1) * DAY_MS).slice(0, 10);
  results.scenarios[`daily/${days}`] = measure(
    `daily metrics days=${days}`,
    () => buildDailyTrainingMetrics(loads, throughDate),
    { warmups, runs }
  );
}

// ---- GPX：50 个本批文件，全库 1k / 5k 条路线 ----
for (const [routeCount, files] of [[1_000, 50], [5_000, 50]]) {
  await withDatabase(async (store, directory) => {
    seedWorkouts(store, routeCount, { routes: true });
    seedGpxFiles(directory, files, 200);
    const samples = [];
    for (let index = 0; index < 1; index += 1) {
      await importGpxRoutes(directory, store, { preserveAbsent: true });
    }
    for (let index = 0; index < 10; index += 1) {
      const started = performance.now();
      await importGpxRoutes(directory, store, { preserveAbsent: true });
      samples.push(performance.now() - started);
    }
    const summary = summarize(samples);
    results.scenarios[`gpx/${files}-of-${routeCount}`] = summary;
    report(`gpx ${files} files / ${routeCount} routes`, summary);
  });
}

console.log("");
if (OUT_PATH !== null) {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  console.log(`saved: ${OUT_PATH}`);
}

if (BASELINE_PATH !== null) {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  console.log("");
  console.log("scenario".padEnd(36) + "baseline p50".padEnd(16) + "current p50".padEnd(15) + "speedup");
  for (const [name, current] of Object.entries(results.scenarios)) {
    const before = baseline.scenarios?.[name];
    if (before === undefined || before.p50 === null || current.p50 === null) continue;
    console.log(
      name.padEnd(36)
      + `${fmt(before.p50)} ms`.padEnd(16)
      + `${fmt(current.p50)} ms`.padEnd(15)
      + `${(before.p50 / current.p50).toFixed(2)}x`
    );
  }
}
