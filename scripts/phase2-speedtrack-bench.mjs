// 阶段 2 follow-up C：重复 speedTrack 构建的子步骤基准（真实 SQL/调用计数 + 配对块）。
// legacy = 旧组装：speedTrack + measureSegments + workoutSplits 各构建一次；
// shared = 请求局部 provider：一次构建，measureSegmentsWithTrack / workoutSplitsWithTrack 复用。
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { SqliteSeriesReadRepository } from "../packages/storage-sqlite/src/read/series-read-repository.ts";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const dbPath = readArg("--db");
const out = readArg("--json");
if (!dbPath || !out || !isAbsolute(out)) {
  console.error("usage: phase2-speedtrack-bench.mjs --db <sqlite> --json <absolute-out> [--sessions 5] [--blocks 5] [--iterations 20]");
  process.exit(2);
}
const sessionCount = Number(readArg("--sessions", "5"));
const blocks = Number(readArg("--blocks", "5"));
const iterations = Number(readArg("--iterations", "20"));
if (!Number.isInteger(sessionCount) || sessionCount < 1 || !Number.isInteger(blocks) || blocks < 2 || !Number.isInteger(iterations) || iterations < 1) {
  console.error("invalid --sessions/--blocks/--iterations");
  process.exit(2);
}
const percentile = (sorted, ratio) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
const summarize = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  };
};

const database = new DatabaseSync(resolve(dbPath), { readOnly: true });
let sessions;
try {
  sessions = database.prepare(`
    SELECT session.id, session.anchor_start_at AS startedAt, session.anchor_end_at AS endedAt,
           session.anchor_distance_km AS distanceKm, workout.source_name AS sourceName
    FROM training_sessions session JOIN workouts workout ON workout.id = session.canonical_workout_id
    WHERE session.status = 'active' AND session.anchor_distance_km > 0
    ORDER BY session.anchor_start_at, session.id LIMIT ?
  `).all(sessionCount);
} catch (error) {
  database.close();
  throw error;
}

const repository = new SqliteSeriesReadRepository(database);
let speedBuilds = 0;
const originalMetricIntervals = repository.metricIntervals.bind(repository);
repository.metricIntervals = (type, sourceName, startedAt, endedAt, transform) => {
  if (type === "HKQuantityTypeIdentifierRunningSpeed") speedBuilds += 1;
  return originalMetricIntervals(type, sourceName, startedAt, endedAt, transform);
};

const runLegacy = (session) => {
  const track = repository.speedTrack(session.startedAt, session.endedAt, session.sourceName, session.distanceKm);
  const boundaries = [Date.parse(session.startedAt), Date.parse(session.endedAt)];
  const segments = repository.measureSegments(session.startedAt, session.endedAt, session.sourceName, session.distanceKm, boundaries);
  const splits = repository.workoutSplits(session.startedAt, session.endedAt, session.sourceName, session.distanceKm);
  return { track: track !== null, segments, splits };
};
const runShared = (session) => {
  const provider = repository.speedTrackProvider(session.startedAt, session.endedAt, session.sourceName, session.distanceKm);
  const track = provider.get();
  const boundaries = [Date.parse(session.startedAt), Date.parse(session.endedAt)];
  const segments = repository.measureSegmentsWithTrack(track, session.startedAt, session.endedAt, session.sourceName, boundaries);
  const splits = repository.workoutSplitsWithTrack(track, session.startedAt, session.endedAt, session.sourceName);
  return { track: track !== null, segments, splits };
};

const result = { database: resolve(dbPath), sessions, blocks, iterations, blockResults: [], overall: {}, equivalence: true, speedBuilds: {} };
try {
  for (const session of sessions) {
    const legacy = runLegacy(session);
    const shared = runShared(session);
    if (JSON.stringify(legacy) !== JSON.stringify(shared)) result.equivalence = false;
  }
  for (let block = 0; block < blocks; block += 1) {
    const legacySamples = [];
    const sharedSamples = [];
    let legacyBuilds = 0;
    let sharedBuilds = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const session = sessions[(block + iteration) % sessions.length];
      const order = iteration % 2 === 0 ? ["legacy", "shared"] : ["shared", "legacy"];
      for (const mode of order) {
        speedBuilds = 0;
        const startedAt = performance.now();
        (mode === "legacy" ? runLegacy : runShared)(session);
        const ms = performance.now() - startedAt;
        if (mode === "legacy") { legacySamples.push(ms); legacyBuilds += speedBuilds; }
        else { sharedSamples.push(ms); sharedBuilds += speedBuilds; }
      }
    }
    result.blockResults.push({
      block,
      legacy: summarize(legacySamples),
      shared: summarize(sharedSamples),
      legacySpeedBuilds: legacyBuilds,
      sharedSpeedBuilds: sharedBuilds
    });
  }
  // 整体使用各块 p95 的中位数，并保留块级判定（不混合原始样本）。
  const improvements = result.blockResults.map((block) => {
    const ms = block.legacy.p95 - block.shared.p95;
    const percent = (ms / block.legacy.p95) * 100;
    return { block: block.block, legacyP95: block.legacy.p95, sharedP95: block.shared.p95, ms, percent, pass: ms >= 5 || percent >= 20 };
  });
  result.improvements = improvements;
  result.overall = {
    blocks: improvements.length,
    passingBlocks: improvements.filter((item) => item.pass).length,
    medianMs: [...improvements.map((item) => item.ms)].sort((a, b) => a - b)[Math.floor(improvements.length / 2)],
    medianPercent: [...improvements.map((item) => item.percent)].sort((a, b) => a - b)[Math.floor(improvements.length / 2)]
  };
  result.buildCountsConsistent = result.blockResults.every((block) => block.sharedSpeedBuilds === iterations && block.legacySpeedBuilds === iterations * 3);
  result.verdict = {
    ok: result.equivalence && result.overall.passingBlocks >= 4 && result.buildCountsConsistent,
    failures: [
      ...(result.equivalence ? [] : ["legacy/shared outputs differ"]),
      ...(result.overall.passingBlocks >= 4 ? [] : ["fewer than 4 of 5 blocks improved"]),
      ...(result.buildCountsConsistent ? [] : ["speed build count is not 3 -> 1"])
    ]
  };
} catch (error) {
  result.verdict = { ok: false, failures: [String(error?.stack ?? error)] };
} finally {
  database.close();
}
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ verdict: result.verdict, overall: result.overall, improvements: result.improvements, buildCounts: result.blockResults.map((block) => [block.legacySpeedBuilds, block.sharedSpeedBuilds]) }, null, 2));
if (!result.verdict.ok) process.exitCode = 1;
