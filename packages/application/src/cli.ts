import { DATABASE_TIMEZONE } from "@rai/contracts";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { RecomputePlan } from "@rai/health-export-parser";
import { importEngine, nativeFallback, nativeElevationGains, NATIVE_VERSION } from "@rai/health-export-parser";
import { RaiDatabase, acquireDatabasePublicationLock } from "@rai/storage-sqlite";

import { RaiApplicationService } from "./service.js";

function optionValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "recompute" && command !== "refresh-snapshots") {
    throw new Error(
      "Usage: data:recompute -- --database <sqlite> [--evaluated-at <ISO>] [--timezone <IANA>] [--import-batch <id>]\n" +
        "   or: data:refresh-snapshots -- --database <sqlite>"
    );
  }
  const databasePath = resolve(optionValue(args, "--database", "var/rai.sqlite"));
  if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  const evaluatedAt = optionValue(args, "--evaluated-at", new Date().toISOString());
  const timezoneIdentifier = optionValue(args, "--timezone", DATABASE_TIMEZONE);
  const dirtyFromAt = optionValue(args, "--dirty-from", "");
  const importBatchId = optionValue(args, "--import-batch", "");
  const elevationGains = await nativeElevationGains(databasePath, {
    spoolRoot: resolve(optionValue(args, "--native-spool-root", dirname(databasePath))),
    engine: importEngine(optionValue(args, "--engine", "typescript")),
    fallback: nativeFallback(optionValue(args, "--native-fallback", "none")),
    version: optionValue(args, "--native-version", NATIVE_VERSION)
  });
  // S3.7：在打开库**之前**获取发布锁 —— 与 server（`"api"`）、parser CLI / migrate-cli /
  // model-v2-cli（`"cli"`）同一个跨进程互斥原语。拿不到就明确拒绝（main 的 catch 会把
  // "Another ... process is using ..." 打到 stderr 并 exit 1）。
  //
  // 为什么必须有：API 运行中裸写主库会让两条进程各自持连接写同一个 WAL 库，
  // 而账本/游标的全部假设（单写者、批次边界、提交前回读）都建立在互斥之上。
  // 历史形态是"服务端在跑，运维手敲 data:recompute 直接写主库"——没有任何东西拦它。
  const releasePublicationLock = acquireDatabasePublicationLock(databasePath, "cli");
  const store = await RaiDatabase.open(databasePath);
  try {
    const service = new RaiApplicationService(store, "owned", elevationGains);
    const incrementalPlan: RecomputePlan | null = dirtyFromAt
      ? {
          mode: "partial",
          dirtySessionIds: [],
          dirtyFromAt,
          reasons: ["import_dataset_diff"]
        }
      : null;
    const recomputeOptions = { evaluatedAt, timezoneIdentifier, ...(importBatchId ? { importBatchId } : {}) };
    const jobId = command === "recompute"
      ? incrementalPlan
        ? service.enqueueIncrementalRecompute(incrementalPlan, recomputeOptions)
        : service.enqueueFullRecompute(recomputeOptions)
      : service.enqueueSnapshotRefresh({ evaluatedAt, timezoneIdentifier });
    if (jobId === null) throw new Error("Incremental recompute unexpectedly produced no task");
    const completed = service.runNextJob();
    if (!completed || completed.id !== jobId) {
      throw new Error("Expected the single worker to execute the newly queued task");
    }
    console.log(
      JSON.stringify(
        {
          id: completed.id,
          type: completed.jobType,
          status: completed.status,
          error: completed.error,
          featureRunId: completed.featureRunId,
          modelRunId: completed.modelRunId,
          progress: {
            phase: completed.progressPhase,
            current: completed.progressCurrent,
            total: completed.progressTotal
          }
        },
        null,
        2
      )
    );
    if (completed.status !== "succeeded") {
      // runNextJob records business failures instead of throwing. Emit that
      // record before the import worker rolls back and deletes the staging DB.
      console.error(JSON.stringify({
        id: completed.id,
        type: completed.jobType,
        status: completed.status,
        error: completed.error ?? { message: "Application task did not succeed" }
      }));
      process.exitCode = 1;
    }
  } finally {
    store.close();
    releasePublicationLock();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
