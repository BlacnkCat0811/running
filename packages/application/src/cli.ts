import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { RecomputePlan } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

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
      "Usage: data:recompute -- --database <sqlite> [--evaluated-at <ISO>] [--timezone <IANA>]\n" +
        "   or: data:refresh-snapshots -- --database <sqlite>"
    );
  }
  const databasePath = resolve(optionValue(args, "--database", "var/rai.sqlite"));
  if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  const evaluatedAt = optionValue(args, "--evaluated-at", new Date().toISOString());
  const timezoneIdentifier = optionValue(args, "--timezone", "Asia/Shanghai");
  const dirtyFromAt = optionValue(args, "--dirty-from", "");
  const validationMode = args.includes("--shadow-validate") ? "shadow" as const : "off" as const;
  const store = await RaiDatabase.open(databasePath);
  try {
    const service = new RaiApplicationService(store);
    const incrementalPlan: RecomputePlan | null = dirtyFromAt
      ? {
          mode: "partial",
          dirtySessionIds: [],
          dirtyFromAt,
          reasons: ["import_dataset_diff"]
        }
      : null;
    const jobId = command === "recompute"
      ? incrementalPlan
        ? service.enqueueIncrementalRecompute(incrementalPlan, { evaluatedAt, timezoneIdentifier, validationMode })
        : service.enqueueFullRecompute({ evaluatedAt, timezoneIdentifier, validationMode })
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
    if (completed.status !== "succeeded") process.exitCode = 1;
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
