/**
 * Phase 1 lock-window acceptance benchmark, through the real HTTP entry point.
 *
 * Usage:
 *   RAI_PHASE1_MODE=baseline node --import tsx deliverables/phase1-main-thread-blocking/bench/noop-lock-bench.ts
 *   RAI_PHASE1_MODE=phase1-prefix node --import tsx ...
 *   RAI_PHASE1_MODE=repaired RAI_PHASE1_ENFORCE=1 node --import tsx ...
 *
 * `RAI_PHASE1_MODE` selects a persisted source snapshot (see snapshots/manifest.json).
 * It is not an output label: the API subprocess is spawned from that snapshot's
 * apps/api/src tree.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  benchRoot, cleanup, environmentInfo, p95, percentile, performanceSample, prepareDatabase, resetPerformanceWindow,
  runNoopImport, snapshotFingerprint, snapshotRoot, startApi, startLockHelper, startTraffic,
  summarizeTraffic, tempRoot, writeTrafficSamples, sleep,
  type BenchmarkMode, type BenchmarkOutput, type TrafficSample
} from "./http-harness.js";

const VALID_MODES = new Set<BenchmarkMode>(["baseline", "phase1-prefix", "repaired"]);
const mode = process.env.RAI_PHASE1_MODE as BenchmarkMode | undefined;
if (!mode || !VALID_MODES.has(mode)) {
  throw new Error("RAI_PHASE1_MODE must be one of baseline | phase1-prefix | repaired");
}
const rounds = positiveInteger(process.env.RAI_PHASE1_ROUNDS, 5);
const roundSeconds = positiveInteger(process.env.RAI_PHASE1_ROUND_SECONDS, 60);
const concurrency = positiveInteger(process.env.RAI_PHASE1_CONCURRENCY, 4);
const cyclesPerRound = positiveInteger(process.env.RAI_PHASE1_CYCLES_PER_ROUND, 1);
const enforce = process.env.RAI_PHASE1_ENFORCE === "1";
const outputPath = process.env.RAI_PHASE1_OUTPUT
  ?? join(benchRoot, "evidence", `http-lock-${mode}.json`);
const requestPath = outputPath.replace(/\.json$/, ".requests.ndjson.gz");
mkdirSync(dirname(outputPath), { recursive: true });

const experimentRoot = tempRoot("rai-phase1-http-lock-");
const runtimeRoot = join(experimentRoot, "runtime");
const databasePath = join(runtimeRoot, "var", "rai.sqlite");
const fixtureRoot = join(experimentRoot, "fixture");
const startedAt = new Date().toISOString();

const output: BenchmarkOutput = {
  schema: "rai-phase1-http-evidence-v1",
  mode,
  generatedAt: startedAt,
  source: {
    snapshotRoot: snapshotRoot(mode),
    fingerprintSha256: snapshotFingerprint(mode),
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: benchRoot }).toString().trim(),
    workingTreeDiffSha256: diffHash()
  },
  environment: environmentInfo(),
  config: {
    rounds, roundSeconds, concurrency, cyclesPerRound, lockHoldMs: 1200, enforce,
    entry: "HTTP upload -> inspect -> import-jobs -> poll",
    drainMs: 150
  },
  rounds: []
};

const allTraffic: TrafficSample[] = [];
const roundResults: Array<Record<string, unknown>> = [];
try {
  const { zipBuffer } = await prepareDatabase({ runtimeRoot, databasePath, fixtureRoot });
  const api = await startApi({ mode, experimentRoot, runtimeRoot, databasePath });
  const lock = await startLockHelper(databasePath);
  try {
    // Warm the resident ingest worker and let V8/SQLite settle before the
    // measured windows. Cold-start is reported separately by the resource
    // benchmark and must not leak into the lock-window max.
    await sleep(500);
    for (let warm = 0; warm < 3; warm += 1) {
      const result = await runNoopImport(api, zipBuffer, 900_000 + warm);
      if (result.status !== "succeeded") throw new Error(`warmup failed: ${JSON.stringify(result)}`);
    }
    await sleep(2_000);

    for (let round = 1; round <= rounds; round += 1) {
      let traffic: ReturnType<typeof startTraffic> | null = null;
      const jobs: Awaited<ReturnType<typeof runNoopImport>>[] = [];
      try {
        await resetPerformanceWindow(api);
        const before = await performanceSample(api);
        traffic = startTraffic(api, concurrency);
        const roundStart = Date.now();
        let cycle = 0;
        let lockWindow: Awaited<ReturnType<typeof performanceSample>> | null = null;
        while (cycle < cyclesPerRound && Date.now() - roundStart < roundSeconds * 1000) {
          const { released } = await lock.begin();
          traffic.setPhase("locked");
          const jobPromise = runNoopImport(api, zipBuffer, round * 10_000 + cycle);
          await released;
          traffic.setPhase("unlocked");
          // Measure the event loop across the actual BEGIN IMMEDIATE wait.
          // Reading it at lock release isolates the blocking window from
          // terminal-state writes/source cleanup after the worker owns commit.
          lockWindow = await performanceSample(api);
          const job = await jobPromise;
          if (job.status !== "succeeded") {
            throw new Error(`round ${round} cycle ${cycle}: no-op import failed: ${JSON.stringify(job)}`);
          }
          jobs.push(job);
          await waitForImportIdle(api);
          cycle += 1;
          await sleep(150);
        }
        // Keep the external generator running for the full round even though
        // the lock window itself is only 1.2 seconds.
        const remainingMs = roundStart + roundSeconds * 1000 - Date.now();
        if (remainingMs > 0) await sleep(remainingMs);
        const samples = await traffic.stop();
        traffic = null;
        allTraffic.push(...samples);
        const after = await performanceSample(api);
        const lockedTraffic = summarizeTraffic(samples, "locked");
        const unlockedTraffic = summarizeTraffic(samples, "unlocked");
        const lockedHealth = summarizeRoute(samples, "locked", "/v1/health");
        const lockedRead = summarizeRoute(samples, "locked", "/v1/dashboard");
        const result = {
          round,
          cycles: jobs.length,
          before,
          after,
          eventLoopMaxMs: after.eventLoopMaxMs,
          eventLoopP95Ms: after.eventLoopP95Ms,
          lockWindowEventLoopMaxMs: lockWindow?.eventLoopMaxMs ?? 0,
          lockWindowEventLoopP95Ms: lockWindow?.eventLoopP95Ms ?? 0,
          lockedTraffic,
          unlockedTraffic,
          lockedHealth,
          lockedRead,
          jobs: {
            count: jobs.length,
            p50Ms: percentile(jobs.map((job) => job.jobMs), 0.50),
            p95Ms: p95(jobs.map((job) => job.jobMs)),
            maxMs: Math.max(...jobs.map((job) => job.jobMs))
          }
        };
        roundResults.push(result);
        const threshold = {
          eventLoopMax: result.lockWindowEventLoopMaxMs <= 100,
          healthP95: result.lockedHealth.p95Ms <= 250,
          noNewServerErrors: result.lockedTraffic.serverErrors === 0
        };
        writeFileSync(outputPath, JSON.stringify({
          ...output, rounds: roundResults, liveRound: result, threshold
        }, null, 2));
        process.stderr.write(
          `[phase1-http-lock] ${mode} round ${round}/${rounds}: cycles=${jobs.length} `
          + `lockWindowMax=${result.lockWindowEventLoopMaxMs.toFixed(1)}ms fullRoundMax=${result.eventLoopMaxMs.toFixed(1)}ms `
          + `healthP95=${result.lockedHealth.p95Ms.toFixed(1)}ms `
          + `readP95=${result.lockedRead.p95Ms.toFixed(1)}ms lockedReq=${result.lockedTraffic.requests} `
          + `5xx=${result.lockedTraffic.serverErrors}\n`
        );
      } finally {
        if (traffic) await traffic.stop().catch(() => []);
      }
    }
  } finally {
    await lock.close().catch(() => {});
    await api.stop();
  }

  const threshold = {
    eventLoopMax: roundResults.every((round) => (round.lockWindowEventLoopMaxMs as number) <= 100),
    healthP95: roundResults.every((round) => (round.lockedHealth as { p95Ms: number }).p95Ms <= 250),
    noNewServerErrors: roundResults.every((round) => (round.lockedTraffic as { serverErrors: number }).serverErrors === 0)
  };
  const summary = {
    rounds: roundResults.length,
    cycles: roundResults.reduce((sum, round) => sum + (round.cycles as number), 0),
    lockWindowEventLoopMaxMs: {
      median: median(roundResults.map((round) => round.lockWindowEventLoopMaxMs as number)),
      worst: Math.max(...roundResults.map((round) => round.lockWindowEventLoopMaxMs as number))
    },
    fullRoundEventLoopMaxMs: {
      median: median(roundResults.map((round) => round.eventLoopMaxMs as number)),
      worst: Math.max(...roundResults.map((round) => round.eventLoopMaxMs as number))
    },
    lockedHealthP95Ms: {
      median: median(roundResults.map((round) => (round.lockedHealth as { p95Ms: number }).p95Ms)),
      worst: Math.max(...roundResults.map((round) => (round.lockedHealth as { p95Ms: number }).p95Ms))
    },
    lockedReadP95Ms: {
      median: median(roundResults.map((round) => (round.lockedRead as { p95Ms: number }).p95Ms)),
      worst: Math.max(...roundResults.map((round) => (round.lockedRead as { p95Ms: number }).p95Ms))
    },
    serverErrors: roundResults.reduce((sum, round) => sum + (round.lockedTraffic as { serverErrors: number }).serverErrors, 0),
    threshold,
    passed: Object.values(threshold).every(Boolean)
  };
  await writeTrafficSamples(requestPath, allTraffic);
  writeFileSync(outputPath, JSON.stringify({ ...output, rounds: roundResults, summary }, null, 2));
  process.stderr.write(`[phase1-http-lock] evidence written to ${outputPath}\n`);
  if (enforce && !summary.passed) throw new Error(`HTTP lock acceptance failed: ${JSON.stringify(threshold)}`);
} catch (error) {
  writeFileSync(outputPath, JSON.stringify({
    ...output,
    rounds: roundResults,
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  }, null, 2));
  throw error;
} finally {
  if (allTraffic.length > 0) await writeTrafficSamples(requestPath, allTraffic).catch(() => {});
  cleanup(experimentRoot);
}

function summarizeRoute(samples: TrafficSample[], phase: "locked" | "unlocked", route: TrafficSample["route"]) {
  const subset = samples.filter((sample) => sample.phase === phase && sample.route === route);
  return {
    requests: subset.length,
    errors: subset.filter((sample) => sample.status === 0 || sample.status >= 500).length,
    serverErrors: subset.filter((sample) => sample.status >= 500).length,
    p50Ms: percentile(subset.map((sample) => sample.ms), 0.50),
    p95Ms: p95(subset.map((sample) => sample.ms)),
    p99Ms: percentile(subset.map((sample) => sample.ms), 0.99),
    maxMs: subset.reduce((max, sample) => Math.max(max, sample.ms), 0)
  };
}

async function waitForImportIdle(api: Awaited<ReturnType<typeof startApi>>) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const sample = await performanceSample(api);
    if (!sample.importPending || Date.now() > deadline) return;
    await sleep(20);
  }
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`expected positive integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  return percentile(values, 0.5);
}

function diffHash(): string | null {
  try {
    const diff = execFileSync("git", ["diff", "--", "apps/api/src"], { cwd: benchRoot, maxBuffer: 1 << 28 }).toString();
    if (!diff) return null;
    return createHash("sha256").update(diff).digest("hex");
  } catch { return null; }
}
