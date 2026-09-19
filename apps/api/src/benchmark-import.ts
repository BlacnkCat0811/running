import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { ImportWorker } from "./import-worker.js";
import type { ImportJobResponse } from "@rai/api-contracts";
import { importEngine, NATIVE_VERSION } from "@rai/health-export-parser";
import { importEquivalence } from "./import-equivalence.js";

const args = process.argv.slice(2);
const option = (key: string): string | undefined => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
const database = option("--database");
const input = option("--input");
const output = option("--output");
const runs = Number(option("--runs") ?? 3);
const engines = (option("--engine") ?? "typescript").split(",").map((value) => importEngine(value));
if (!database || !input || !output || !Number.isInteger(runs) || runs < 1 || runs > 7) {
  throw new Error("Usage: npm run data:benchmark -- --database BASELINE --input EXPORT_DIR --output NEW_JSON [--runs 1..7] [--execute]");
}
if (!existsSync(database) || !existsSync(input)) throw new Error("Baseline database and export directory must exist");
if (existsSync(output)) throw new Error("Output already exists; refusing to overwrite");
if (!args.includes("--execute")) {
  console.log(JSON.stringify({ dryRun: true, runsPerMode: runs, engines, modes: ["shadow", "off"],
    note: "One consistent readonly baseline snapshot, restored before EVERY trial. No live activation. Add --execute to run." }, null, 2));
} else {
  const root = await mkdtemp(join(option("--work-dir") ?? process.env.RAI_RUNTIME_ROOT ?? tmpdir(), "rai-import-benchmark-"));
  const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const baseline = join(root, "baseline.sqlite");
  const source = new DatabaseSync(resolve(database), { readOnly: true });
  let worker: ImportWorker | undefined;
  let cancelled = false;
  const cancel = (): void => { cancelled = true; void worker?.close(); };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    try { await backup(source, baseline); } finally { source.close(); }
    const evaluatedAt = new Date().toISOString();
    const results: Array<{ engine: string; mode: string; trial: number; job: ImportJobResponse; equivalence: ReturnType<typeof importEquivalence> }> = [];
    for (let trial = 1; trial <= runs; trial++) {
      // Alternate order to reduce systematic warm-cache bias between modes.
      for (const mode of trial % 2 ? ["shadow", "off"] as const : ["off", "shadow"] as const) {
        for (const engine of trial % 2 ? engines : [...engines].reverse()) {
        if (cancelled) throw new Error("Benchmark cancelled");
        const runtime = await mkdtemp(join(root, "trial-"));
        const isolated = join(runtime, "rai.sqlite");
        await copyFile(baseline, isolated);
        worker = new ImportWorker(isolated, projectRoot, runtime, undefined, undefined, undefined, mode, undefined, evaluatedAt, {
          name: engine, version: NATIVE_VERSION, fallback: "none"
        });
        const job = worker.create(resolve(input));
        const deadline = Date.now() + 60 * 60_000;
        while (worker.isRunning) {
          if (cancelled || Date.now() > deadline) { await worker.close(); throw new Error("Benchmark cancelled or timed out"); }
          await new Promise((done) => setTimeout(done, 200));
        }
        const finished = worker.get(job.id)!;
        results.push({ engine, mode, trial, job: finished, equivalence: importEquivalence(isolated) });
        await worker.close(); worker = undefined;
      }
      }
    }
    const reference = results.find((item) => item.engine === "typescript" && item.job.status === "succeeded");
    const successfulRust = results.filter((item) => item.engine === "rust" && item.job.status === "succeeded").length;
    const mismatches = reference ? results.filter((item) =>
      item.job.status === "succeeded" && JSON.stringify(item.equivalence) !== JSON.stringify(reference.equivalence)
    ).map(({ engine, mode, trial }) => ({ engine, mode, trial })) : [];
    await writeFile(resolve(output), JSON.stringify({
      schemaVersion: 1, createdAt: new Date().toISOString(), evaluatedAt,
      node: process.version, platform: process.platform, arch: process.arch,
      note: "Each trial uses the SAME captured baseline. Disk caches are not flushed. No upload/FRP timing included.",
      results, parity: {
        checked: Boolean(reference && successfulRust > 0),
        complete: results.every((item) => item.job.status === "succeeded"),
        mismatches
      }
    }, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`Wrote ${results.length} isolated trials to ${resolve(output)}`);
    if (mismatches.length || results.some(({ job }) => job.status !== "succeeded")) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    await worker?.close();
    await rm(root, { recursive: true, force: true });
  }
}
