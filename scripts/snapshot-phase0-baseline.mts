#!/usr/bin/env node
// Phase 0 baseline snapshot.
//
// Fixes "code + config + data" as of the current commit so a later V2 candidate
// can be compared against a reproducible V1 reference
// (docs/ALGORITHM.md §17.1).
//
// Read-only with respect to the database: it reports the schema version and row
// counts and never writes to `var/rai.sqlite`. Opening it read-only also avoids
// leaving `-wal` / `-shm` sidecars behind.
//
// Usage:
//   node --import tsx scripts/snapshot-phase0-baseline.mts \
//     [--database var/rai.sqlite] [--out deliverables/PHASE0_BASELINE.json]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  CATBOOST_PREDICTION_MODEL_VERSION,
  CONTRACT_VERSION,
  FEATURE_SCHEMA_VERSION,
  PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
  TRAINING_LOAD_CONFIG_VERSION,
  TRAINING_ZONE_CONFIG_VERSION
} from "@rai/contracts";
import { FEATURE_CONFIG_VERSION } from "@rai/features";
import { PHYSIOLOGY_MODEL_VERSION } from "@rai/physiology";
import { MODEL_CONFIG_VERSION, SCORING_MODEL_VERSION, defaultRaiModelConfig } from "@rai/scoring";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const readArg = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
};

const configHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Mirrors `configHash` in packages/application/src/utils.ts so the recorded hash
// is comparable with the one stored on model_runs.model_config_hash.
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const databasePath = resolve(root, readArg("--database", "var/rai.sqlite"));
const outPath = resolve(root, readArg("--out", "deliverables/PHASE0_BASELINE.json"));

const database: Record<string, unknown> = { path: databasePath, present: existsSync(databasePath) };
if (existsSync(databasePath)) {
  const handle = new DatabaseSync(databasePath, { readOnly: true });
  const scalar = (sql: string): unknown => {
    try {
      const row = handle.prepare(sql).get() as Record<string, unknown> | undefined;
      return row ? Object.values(row)[0] ?? null : null;
    } catch (error) {
      // A missing table is data about the baseline, not a crash.
      return { error: String(error instanceof Error ? error.message : error).slice(0, 120) };
    }
  };
  database.schemaMigrationMax = scalar("SELECT MAX(version) FROM schema_migrations");
  database.activeTrainingSessions = scalar("SELECT COUNT(*) FROM training_sessions");
  database.modelRuns = scalar("SELECT COUNT(*) FROM model_runs");
  database.predictionModelRuns = scalar("SELECT COUNT(*) FROM prediction_model_runs");
  database.activeModelRun = scalar(
    "SELECT model_version FROM model_runs WHERE id IN (SELECT model_run_id FROM active_model_run)"
  );
  database.activeFeatureSchema = scalar(
    "SELECT feature_schema_version FROM feature_runs WHERE id IN (SELECT feature_run_id FROM active_model_run active JOIN model_runs model ON model.id = active.model_run_id)"
  );
  // `performance_protocol` lives on `workout_overrides`, not on
  // `training_sessions`; prediction-data.ts resolves it with a column-existence
  // guard, and so does this query.
  database.labelOverrides = scalar(
    "SELECT COUNT(*) FROM workout_overrides WHERE performance_protocol IS NOT NULL"
  );
  handle.close();
}

const snapshot = {
  snapshotVersion: "rai-phase0-baseline-v1",
  generatedAt: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"),
  commitSubject: git("log", "-1", "--pretty=%s"),
  workingTree: {
    dirty: git("status", "--porcelain").length > 0,
    entries: git("status", "--porcelain").split("\n").filter(Boolean)
  },
  versions: {
    contract: CONTRACT_VERSION,
    featureSchema: FEATURE_SCHEMA_VERSION,
    featureConfig: FEATURE_CONFIG_VERSION,
    modelConfig: MODEL_CONFIG_VERSION,
    scoringEngine: SCORING_MODEL_VERSION,
    physiology: PHYSIOLOGY_MODEL_VERSION,
    predictionResidualFeatureSchema: PREDICTION_RESIDUAL_FEATURE_SCHEMA_VERSION,
    catboostPredictionModel: CATBOOST_PREDICTION_MODEL_VERSION,
    trainingLoadConfig: TRAINING_LOAD_CONFIG_VERSION,
    trainingZoneConfig: TRAINING_ZONE_CONFIG_VERSION
  },
  scoring: {
    modelConfigHash: configHash({ version: MODEL_CONFIG_VERSION, config: defaultRaiModelConfig }),
    dimensionWeights: defaultRaiModelConfig.dimensionWeights,
    calibrationMinimumSessions: defaultRaiModelConfig.calibrationMinimumSessions,
    calibrationMinimumSpanDays: defaultRaiModelConfig.calibrationMinimumSpanDays,
    minimumAvailableWeight: defaultRaiModelConfig.minimumAvailableWeight,
    minimumConfidenceForTrueAbility: defaultRaiModelConfig.minimumConfidenceForTrueAbility
  },
  database
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
process.stderr.write(`\nWrote ${outPath}\n`);
