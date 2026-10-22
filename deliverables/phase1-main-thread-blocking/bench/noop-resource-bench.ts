/**
 * Phase 1 cold-start / 100-batch resource acceptance, through the real HTTP entry.
 *
 * `RAI_PHASE1_MODE` selects a persisted source snapshot; it is not a label.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  benchRoot, cleanup, countFiles, environmentInfo, p95, percentile, performanceSample,
  prepareDatabase, runNoopImport, snapshotFingerprint, snapshotRoot, startApi, tempRoot,
  type BenchmarkMode, type BenchmarkOutput
} from "./http-harness.js";

const VALID_MODES = new Set<BenchmarkMode>(["baseline", "phase1-prefix", "repaired"]);
const mode = process.env.RAI_PHASE1_MODE as BenchmarkMode | undefined;
if (!mode || !VALID_MODES.has(mode)) {
  throw new Error("RAI_PHASE1_MODE must be one of baseline | phase1-prefix | repaired");
}
const iterations = positiveInteger(process.env.RAI_PHASE1_ITERATIONS, 100);
const enforce = process.env.RAI_PHASE1_ENFORCE === "1";
const outputPath = process.env.RAI_PHASE1_OUTPUT
  ?? join(benchRoot, "evidence", `http-resource-${mode}.json`);
mkdirSync(dirname(outputPath), { recursive: true });

const experimentRoot = tempRoot("rai-phase1-http-resource-");
const runtimeRoot = join(experimentRoot, "runtime");
const databasePath = join(runtimeRoot, "var", "rai.sqlite");
const fixtureRoot = join(experimentRoot, "fixture");
const output: BenchmarkOutput = {
  schema: "rai-phase1-http-evidence-v1",
  mode,
  generatedAt: new Date().toISOString(),
  source: {
    snapshotRoot: snapshotRoot(mode),
    fingerprintSha256: snapshotFingerprint(mode),
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: benchRoot }).toString().trim(),
    workingTreeDiffSha256: diffHash()
  },
  environment: environmentInfo(),
  config: { iterations, enforce, entry: "HTTP upload -> inspect -> import-jobs -> poll" }
};

try {
  const { zipBuffer } = await prepareDatabase({ runtimeRoot, databasePath, fixtureRoot });
  const api = await startApi({ mode, experimentRoot, runtimeRoot, databasePath });
  try {
    const before = await performanceSample(api);
    // The first job is the cold-start observation; it is not hidden by a warmup.
    const cold = await runNoopImport(api, zipBuffer, 0);
    if (cold.status !== "succeeded") throw new Error(`cold-start import failed: ${JSON.stringify(cold)}`);
    const afterCold = await performanceSample(api);

    const durations: number[] = [];
    const rssSamples: Array<{ at: number; processRssBytes: number; eventLoopMaxMs: number }> = [];
    for (let index = 1; index <= iterations; index += 1) {
      const job = await runNoopImport(api, zipBuffer, index);
      if (job.status !== "succeeded") throw new Error(`batch ${index} failed: ${JSON.stringify(job)}`);
      durations.push(job.jobMs);
      if (index % 10 === 0) {
        const sample = await performanceSample(api);
        rssSamples.push({
          at: index, processRssBytes: sample.processRssBytes, eventLoopMaxMs: sample.eventLoopMaxMs
        });
      }
    }
    const final = await waitForPendingToClear(api);
    const varEntries = existsSync(join(runtimeRoot, "var")) ? readdirSync(join(runtimeRoot, "var")) : [];
    const tempFiles = varEntries.filter((name) =>
      /^(rai\.importing|native\.|data-audit\.)/.test(name));
    const summary = {
      coldStartMs: cold.jobMs,
      coldStartUploadMs: cold.uploadMs,
      coldStartCreateMs: cold.createMs,
      batches: durations.length,
      p50Ms: percentile(durations, 0.50),
      p95Ms: p95(durations),
      maxMs: Math.max(...durations),
      eventLoopMaxMs: final.eventLoopMaxMs,
      importPending: final.importPending,
      processRssBytesBefore: before.processRssBytes,
      processRssBytesAfterCold: afterCold.processRssBytes,
      processRssBytesFinal: final.processRssBytes,
      processMaxRssKiB: final.processMaxRssKiB,
      uploadTempFiles: tempFiles,
      runtimeVarFiles: countFiles(join(runtimeRoot, "var")),
      rssSamples,
      threshold: {
        pendingCleared: final.importPending === false,
        noTempFiles: tempFiles.length === 0,
        noServerErrors: final.serverErrors === 0
      }
    };
    writeFileSync(outputPath, JSON.stringify({ ...output, summary }, null, 2));
    process.stderr.write(
      `[phase1-http-resource] ${mode}: cold=${cold.jobMs.toFixed(1)}ms p50=${summary.p50Ms.toFixed(1)}ms `
      + `p95=${summary.p95Ms.toFixed(1)}ms max=${summary.maxMs.toFixed(1)}ms pending=${final.importPending} `
      + `temp=${tempFiles.length} rss=${(final.processRssBytes / 1024 / 1024).toFixed(1)}MiB\n`
    );
    if (enforce && !Object.values(summary.threshold).every(Boolean)) {
      throw new Error(`HTTP resource acceptance failed: ${JSON.stringify(summary.threshold)}`);
    }
  } finally {
    await api.stop();
  }
} finally {
  cleanup(experimentRoot);
}

async function waitForPendingToClear(api: Awaited<ReturnType<typeof startApi>>) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const sample = await performanceSample(api);
    if (!sample.importPending || Date.now() > deadline) return sample;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`expected positive integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function diffHash(): string | null {
  try {
    const diff = execFileSync("git", ["diff", "--", "apps/api/src"], { cwd: benchRoot, maxBuffer: 1 << 28 }).toString();
    if (!diff) return null;
    return createHash("sha256").update(diff).digest("hex");
  } catch { return null; }
}
