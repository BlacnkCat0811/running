#!/usr/bin/env node
/**
 * PR3 operator CLI: dry-run/apply of the unified training-state data migration.
 *
 * This tool is deliberately not wired into anything:
 *
 * - it opens **only** the control database passed with `--control-db`; it never
 *   opens the health database (`var/rai.sqlite`) and never imports the server;
 * - the default is `--dry-run`: a read-only connection, no schema change, no row
 *   write, no `-wal`/`-shm` created by a business write;
 * - `--apply` is explicit and additionally requires the exact `sourceDigest`
 *   printed by a previous dry run (`--expect-source-digest`), so a source that
 *   changed between review and apply is refused rather than migrated;
 * - the store refuses to overwrite a different migration result (see
 *   `training-plan-store.ts`), and replaying the same source digest is a no-op.
 *
 * Mode rules are not re-implemented here: the derived mode comes from
 * `resolveTrainingMode` in `training-mode-policy.ts`, and a paused/ended source
 * is represented as paused by the classifier, never as active.
 *
 * Usage:
 *   node --import tsx scripts/migrate-training-planner.mts \
 *     --control-db var/rai-control.sqlite \
 *     --server-id local --athlete-id athlete_1 --dataset-epoch default \
 *     [--business-date 2026-10-20] [--apply --expect-source-digest <sha256>]
 *
 * Output is one JSON document on stdout; exit code 0 means "dry run completed"
 * or "applied/replayed", 1 means "refused / conflict / error".
 */

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

import { parseArgs } from "node:util";

import { coachLocalDate } from "../apps/api/src/coach-loop-facts.js";
import { isValidLocalDate } from "../apps/api/src/local-date.js";
import {
  TrainingPlanStore,
  classifyTrainingPlanMigration,
  ensureTrainingPlanSchema,
  readTrainingPlanMigrationSources,
  trainingPlanScopeKey,
  type TrainingPlanMigrationClassification,
  type TrainingPlanMigrationResult
} from "../apps/api/src/training-plan-store.js";
import { resolveTrainingMode } from "../apps/api/src/training-mode-policy.js";
import { digest } from "../apps/api/src/plan-digest.js";
import type { MobilePlanOperationScope } from "@rai/api-contracts";

interface CliError {
  code: string;
  message: string;
}

const USAGE = `用法（从仓库根目录运行；默认 dry-run，不写任何数据）:
  node --import tsx scripts/migrate-training-planner.mts \\
    --control-db <控制库路径> \\
    --server-id <id> --athlete-id <id> --dataset-epoch <epoch> \\
    [--business-date YYYY-MM-DD] \\
    [--apply --expect-source-digest <sha256>]

参数:
  --control-db            必填；只打开这个控制 SQLite 文件，从不打开主健康库
  --server-id             必填；scope 的 serverId
  --athlete-id            必填；scope 的 athleteId
  --dataset-epoch         必填；scope 的 datasetEpoch
  --business-date         可选；派生日/赛事模式的上海业务日期，默认今天
  --apply                 显式写入；默认只有 dry-run
  --expect-source-digest  与 --apply 一起必填；必须等于 dry-run 打印的 sourceDigest
  --help                  打印本说明
`;

function parseArguments(argv: string[]): { values: ReturnType<typeof parseArgs>["values"] } {
  return parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      "control-db": { type: "string" },
      "server-id": { type: "string" },
      "athlete-id": { type: "string" },
      "dataset-epoch": { type: "string" },
      "business-date": { type: "string" },
      "apply": { type: "boolean", default: false },
      "expect-source-digest": { type: "string" },
      "help": { type: "boolean", default: false }
    }
  });
}

function requireString(values: Record<string, unknown>, name: string): string {
  const value = values[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliFailure("invalid_arguments", `--${name} 必填且不能为空`);
  }
  return value.trim();
}

class CliFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CliFailure";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new CliFailure(code, message);
}

function openControlDatabase(path: string, readOnly: boolean): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly, timeout: 2_000 });
  } catch (error) {
    fail("control_database_unavailable",
      `无法${readOnly ? "只读打开" : "打开"}控制库 ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function reportBase(classification: TrainingPlanMigrationClassification,
  businessDate: string, scope: MobilePlanOperationScope): Record<string, unknown> {
  const derivedMode = resolveTrainingMode({ raceGoal: classification.raceGoal, businessDate });
  return {
    ok: true,
    scope,
    scopeKey: classification.scope,
    businessDate,
    migrationVersion: classification.migrationVersion,
    source: classification.kind,
    sourceStatus: classification.sourceStatus,
    runState: classification.runState,
    derivedMode,
    raceGoal: classification.raceGoal,
    publicRaceTarget: classification.publicRaceTarget,
    goalsRevision: classification.goalsRevision,
    existingRevision: classification.existingRevision,
    sourceDigest: classification.sourceDigest,
    conflicts: classification.conflicts,
    notes: classification.notes,
    applyAllowed: classification.applyAllowed
  };
}

function appliedReport(result: TrainingPlanMigrationResult, store: TrainingPlanStore,
  scopeKey: string): Record<string, unknown> {
  if (result.status === "conflict") {
    return {
      ok: false,
      applied: null,
      conflict: {
        reason: result.reason,
        currentRevision: result.currentRevision,
        currentSourceDigest: result.currentSourceDigest
      }
    };
  }
  const readBack = store.read(scopeKey);
  return {
    ok: true,
    applied: {
      status: result.status,
      revision: result.revision,
      stateDigest: digest(result.state),
      readBackRevision: readBack?.revision ?? null
    }
  };
}

function main(argv: string[]): number {
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }
  let values: Record<string, unknown>;
  try {
    values = parseArguments(argv).values as Record<string, unknown>;
  } catch (error) {
    return emitFailure("invalid_arguments", error instanceof Error ? error.message : String(error), null);
  }
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    const controlDb = resolve(requireString(values, "control-db"));
    const identity: MobilePlanOperationScope = {
      serverId: requireString(values, "server-id"),
      athleteId: requireString(values, "athlete-id"),
      datasetEpoch: requireString(values, "dataset-epoch")
    };
    const businessDate = values["business-date"] === undefined
      ? coachLocalDate(new Date().toISOString())
      : requireString(values, "business-date");
    if (!isValidLocalDate(businessDate)) fail("invalid_arguments", `--business-date 不是真实的 YYYY-MM-DD 日期: ${businessDate}`);
    const apply = values.apply === true;
    const expectedDigest = typeof values["expect-source-digest"] === "string" ? values["expect-source-digest"] : null;

    const database = openControlDatabase(controlDb, !apply);
    try {
      const scopeKey = trainingPlanScopeKey(identity);
      const sources = readTrainingPlanMigrationSources(database, identity);
      const classification = classifyTrainingPlanMigration({
        scope: identity,
        sources,
        businessDate,
        now: new Date().toISOString()
      });
      const report = reportBase(classification, businessDate, identity);
      if (!apply) {
        process.stdout.write(`${JSON.stringify({ ...report, mode: "dry-run" }, null, 2)}\n`);
        return 0;
      }

      const applyReport = { ...report, mode: "apply" };
      if (expectedDigest === null) {
        return emitFailure("expect_source_digest_required",
          "--apply 必须带 --expect-source-digest，且等于 dry-run 打印的 sourceDigest", applyReport);
      }
      if (expectedDigest !== classification.sourceDigest) {
        return emitFailure("source_digest_mismatch",
          `--expect-source-digest 与当前来源不符（期望 ${expectedDigest}，实际 ${classification.sourceDigest}），未写入任何数据`,
          { ...applyReport, expectedSourceDigest: expectedDigest });
      }
      if (!classification.applyAllowed || classification.state === null) {
        return emitFailure("migration_conflicts",
          "来源存在冲突或无效载荷，拒绝写入；请先按 conflicts/notes 处理数据", applyReport);
      }

      // Schema creation is idempotent and happens only after every read-only
      // refusal above, so a refused apply never writes a table.
      ensureTrainingPlanSchema(database);
      const store = new TrainingPlanStore(database);
      const result = store.applyMigration({
        scope: scopeKey,
        expectedAbsentOrRevision: classification.existingRevision,
        sourceDigest: classification.sourceDigest,
        state: classification.state
      });
      const applied = appliedReport(result, store, scopeKey);
      process.stdout.write(`${JSON.stringify({ ...report, ...applied, mode: "apply" }, null, 2)}\n`);
      return applied.ok === true ? 0 : 1;
    } finally {
      database.close();
    }
  } catch (error) {
    if (error instanceof CliFailure) return emitFailure(error.code, error.message, null);
    return emitFailure("internal_error", error instanceof Error ? error.message : String(error), null);
  }
}

function emitFailure(code: string, message: string, context: Record<string, unknown> | null): number {
  // Context first: a success-shaped report is passed in for readability, but the
  // failure verdict must win over its `ok`/`mode` fields.
  const payload: Record<string, unknown> = {
    ...(context ?? {}),
    ok: false,
    mode: (context?.mode as string | undefined) ?? "error",
    error: { code, message } satisfies CliError
  };
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
