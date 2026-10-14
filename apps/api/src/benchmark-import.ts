import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { ImportWorker } from "./import-worker.js";
import { MutationCoordinator } from "./mutation-coordinator.js";
import { TaskAdmissionScheduler } from "./task-admission.js";
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
  console.log(JSON.stringify({ dryRun: true, runsPerEngine: runs, engines,
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
    const results: Array<{ engine: string; trial: number; job: ImportJobResponse; equivalence: ReturnType<typeof importEquivalence> }> = [];
    for (let trial = 1; trial <= runs; trial++) {
      // Alternate engine order to reduce systematic warm-cache bias.
      for (const engine of trial % 2 ? engines : [...engines].reverse()) {
        if (cancelled) throw new Error("Benchmark cancelled");
        const runtime = await mkdtemp(join(root, "trial-"));
        const isolated = join(runtime, "rai.sqlite");
        await copyFile(baseline, isolated);
        // 排队构造（2026-10-14）：`planDirectSyncLane` 第一条要求 `job.queue && queueOptions`，
        // 无队列直跑会被 `not_queued` 拒收（旧候选回退已删，拒收即显式失败）。
        // admission 用测试同款的最小调度器（本工具是隔离样机，无服务器级资源管理）。
        worker = new ImportWorker(isolated, projectRoot, runtime, undefined, undefined, undefined, {
          scope: "benchmark",
          admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
        }, evaluatedAt, {
          name: engine, version: NATIVE_VERSION, fallback: "none"
        });
        const job = worker.create(resolve(input));
        const deadline = Date.now() + 60 * 60_000;
        // `isRunning` 只覆盖"正在执行"；排队模式下 create→scheduleNext 之间有一瞬 `false`
        // ⇒ 用 `hasPending`（与 import-worker-direct-sync.test.ts 的 `wait` 同判据）。
        while (worker.hasPending) {
          if (cancelled || Date.now() > deadline) { await worker.close(); throw new Error("Benchmark cancelled or timed out"); }
          await new Promise((done) => setTimeout(done, 200));
        }
        const finished = worker.get(job.id)!;
        results.push({ engine, trial, job: finished, equivalence: importEquivalence(isolated) });
        await worker.close(); worker = undefined;
      }
    }
    const reference = results.find((item) => item.engine === "typescript" && item.job.status === "succeeded");
    const successfulRust = results.filter((item) => item.engine === "rust" && item.job.status === "succeeded").length;
    const mismatches = reference ? results.filter((item) =>
      item.job.status === "succeeded" && JSON.stringify(item.equivalence) !== JSON.stringify(reference.equivalence)
    ).map(({ engine, trial }) => ({ engine, trial })) : [];
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
