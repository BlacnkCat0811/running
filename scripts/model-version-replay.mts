#!/usr/bin/env node
// Cross-version Fitness replay on one stored feature snapshot
// (docs/ALGORITHM.md §3.4 / §15.5 / §15.8).
//
// §3.4 requires the V2 release to replay the available history and to keep the V1 result
// runnable for comparison and rollback. The CA weighting ablation is NOT that comparison:
// its "v1_current" row re-runs the OLD WEIGHTS on the NEW engine, and the earlier V2
// implementation record says so explicitly. This script runs the FROZEN V1 ENGINE
// (`packages/scoring/src/legacy-v1`, copied verbatim from 62b4a97) against the CURRENT V2
// engine over exactly one stored feature snapshot, so the engine is the only variable.
//
// What this can and cannot show:
//  - It shows how far the two engines diverge on the same inputs (a call-scale comparison).
//  - It cannot certify accuracy: stored V3 rows carry no decoupling/environment evidence and
//    the local library has no confirmed race/test labels, so accuracy stays not_evaluable.
//
// Read-only with respect to the database.
//
// Usage:
//   node --import tsx scripts/model-version-replay.mts \
//     [--database var/rai.sqlite] [--out deliverables/MODEL_VERSION_REPLAY.json]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { canonicalSemanticJson, DATABASE_TIMEZONE, type SessionType, type WorkoutFeatureVector } from "@rai/contracts";
import { FEATURE_CONFIG_VERSION, decodeStoredFeature } from "@rai/features";
import { MODEL_EVAL_VERSION } from "@rai/model-eval";
import { PHYSIOLOGY_MODEL_VERSION } from "@rai/physiology";
import {
  MODEL_CONFIG_VERSION, SCORING_MODEL_VERSION, buildLegacyStratumHistory, createPersonalBaseline,
  defaultRaiModelConfig, hasCompletedCalibration, legacyV1, scoreFeature, sessionStratum,
  sortWorkoutFeaturesChronologically, trueAbilityAfterInactivity, updateTrueAbilityFromFeatureScore
} from "@rai/scoring";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const readArg = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
};

const databasePath = resolve(root, readArg("--database", "var/rai.sqlite"));
const outPath = resolve(root, readArg("--out", "deliverables/MODEL_VERSION_REPLAY.json"));
if (!existsSync(databasePath)) {
  process.stderr.write(`Database not found: ${databasePath}\n`);
  process.exit(1);
}

const handle = new DatabaseSync(databasePath, { readOnly: true });
let featureRunId: string | undefined;
let rows: Array<Record<string, unknown>>;
let schemaVersion: number | string | null = null;
let activeModelRunId: string | null = null;
try {
  const active = handle.prepare(`
    SELECT feature.id AS id
    FROM active_model_run active
    JOIN model_runs model ON model.id = active.model_run_id
    JOIN feature_runs feature ON feature.id = model.feature_run_id
    WHERE model.status = 'succeeded'
  `).get() as { id: string } | undefined;
  featureRunId = active?.id ?? (handle.prepare(
    "SELECT id FROM feature_runs WHERE status = 'succeeded' ORDER BY created_at DESC LIMIT 1"
  ).get() as { id: string } | undefined)?.id;
  if (!featureRunId) {
    process.stderr.write("No succeeded feature run to replay.\n");
    process.exit(1);
  }
  const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const migrationTable = tables.some((table) => table.name === "schema_migrations") ? "schema_migrations"
    : tables.some((table) => table.name === "migrations") ? "migrations" : null;
  if (migrationTable) {
    const state = handle.prepare(`SELECT MAX(version) AS version FROM ${migrationTable}`).get() as { version: number | string | null } | undefined;
    schemaVersion = state?.version ?? null;
  }
  activeModelRunId = (handle.prepare("SELECT model_run_id AS id FROM active_model_run").get() as { id: string } | undefined)?.id ?? null;
  rows = handle.prepare(`
    SELECT id, training_session_id, canonical_workout_id, workout_start_at, duration_seconds,
           distance_km, average_speed_mps, average_heart_rate_bpm, heart_rate_sample_count,
           heart_rate_coverage, route_point_count, route_quality, source_confidence,
           session_type, session_type_source, eligibility_status, quality_score,
           missing_reasons_json, features_json, provenance_json, computed_at
    FROM workout_features WHERE feature_run_id = ?
  `).all(featureRunId) as unknown as Array<Record<string, unknown>>;
} finally {
  handle.close();
}

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const features: WorkoutFeatureVector[] = rows.map((row) => decodeStoredFeature(
  String(row.features_json),
  {
    id: String(row.id), featureRunId: featureRunId!, trainingSessionId: String(row.training_session_id),
    canonicalWorkoutId: row.canonical_workout_id === null ? "" : String(row.canonical_workout_id),
    workoutStartAt: String(row.workout_start_at), durationSeconds: Number(row.duration_seconds),
    distanceKm: nullableNumber(row.distance_km), averageSpeedMetersPerSecond: nullableNumber(row.average_speed_mps),
    averageHeartRateBpm: nullableNumber(row.average_heart_rate_bpm),
    heartRateSampleCount: Number(row.heart_rate_sample_count ?? 0), heartRateCoverage: nullableNumber(row.heart_rate_coverage),
    routePointCount: Number(row.route_point_count ?? 0), routeQuality: nullableNumber(row.route_quality),
    sourceConfidence: Number(row.source_confidence ?? 0), sessionType: String(row.session_type) as SessionType,
    sessionTypeSource: String(row.session_type_source) as WorkoutFeatureVector["sessionTypeSource"],
    eligibilityStatus: String(row.eligibility_status) as WorkoutFeatureVector["eligibilityStatus"],
    qualityScore: Number(row.quality_score ?? 0),
    missingReasons: JSON.parse(String(row.missing_reasons_json ?? "[]")),
    signals: JSON.parse(String(row.features_json)),
    provenance: JSON.parse(String(row.provenance_json ?? "{}")), computedAt: String(row.computed_at)
  }
));

const sample = features[0];
if (!sample || typeof sample.signals?.efficiencyRaw === "undefined") {
  process.stderr.write("Stored feature signals do not match the expected shape; refusing to report.\n");
  process.exit(1);
}

const sorted = sortWorkoutFeaturesChronologically(features);
const config = defaultRaiModelConfig;
const histories = buildLegacyStratumHistory(sorted);

interface EngineResult {
  version: string;
  calibrationCount: number;
  updates: number;
  finalTrueAbility: number | null;
  /** Coverage has to be reported next to the deltas: comparing only the intersection would
   * hide the case where one engine simply scored fewer sessions than the other. */
  caObservations: number;
  taObservations: number;
  statusCounts: Record<string, number>;
  perSession: Array<{ sessionId: string; date: string; stratum: string; sessionType: string; status: string; ca: number | null; ta: number | null; updated: boolean }>;
}

function runEngine(engine: "v1" | "v2"): EngineResult {
  const isLegacy = engine === "v1";
  const calibration: WorkoutFeatureVector[] = [];
  for (const feature of sorted) {
    if (feature.eligibilityStatus !== "eligible") continue;
    calibration.push(feature);
    if (isLegacy ? legacyV1.hasCompletedCalibration(calibration) : hasCompletedCalibration(calibration, config)) break;
  }
  const mature = isLegacy ? legacyV1.hasCompletedCalibration(calibration) : hasCompletedCalibration(calibration, config);
  const baseline = mature ? (isLegacy ? legacyV1.createPersonalBaseline(calibration) : createPersonalBaseline(calibration)) : null;
  const complete = baseline
    ? Math.max(...sorted.map((feature, index) => baseline.calibrationFeatureIds.includes(feature.id) ? index : -1))
    : Infinity;

  let trueAbility = 50;
  let eligibleCount = 0;
  let pending = 0;
  let updates = 0;
  let lastDate: string | null = null;
  let lastTrueAbility = 50;
  const perSession: EngineResult["perSession"] = [];

  sorted.forEach((feature, index) => {
    const date = feature.workoutStartAt.slice(0, 10);
    if (feature.eligibilityStatus === "excluded" || index <= complete || !baseline) {
      perSession.push({ sessionId: feature.trainingSessionId, date, stratum: sessionStratum(feature.sessionType),
        sessionType: feature.sessionType, status: feature.eligibilityStatus === "excluded" ? "excluded" : "calibrating",
        ca: null, ta: null, updated: false });
      return;
    }
    if (lastDate !== null) {
      const days = (Date.parse(date) - Date.parse(lastDate)) / 86_400_000;
      trueAbility = (isLegacy ? legacyV1.trueAbilityAfterInactivity : trueAbilityAfterInactivity)(lastTrueAbility, days);
    }
    const maturity = Math.max(0.25, Math.min(1, (eligibleCount + 1) / 12));
    if (isLegacy) {
      const score = legacyV1.scoreFeature(feature, baseline, maturity);
      const update = legacyV1.updateTrueAbilityFromFeatureScore(trueAbility, eligibleCount, score);
      trueAbility = update.nextTrueAbility;
      if (update.updated) updates += 1;
      if (score.status === "eligible") { eligibleCount += 1; lastDate = date; lastTrueAbility = trueAbility; }
      perSession.push({ sessionId: feature.trainingSessionId, date, stratum: sessionStratum(feature.sessionType),
        sessionType: feature.sessionType, status: score.status, ca: score.currentAbility, ta: trueAbility, updated: update.updated });
      return;
    }
    const score = scoreFeature(feature, baseline, maturity, histories[index] ?? null, config);
    const update = updateTrueAbilityFromFeatureScore(trueAbility, eligibleCount, score, config, pending);
    pending = update.pendingNegativeConfirmations;
    trueAbility = update.nextTrueAbility;
    if (update.updated) updates += 1;
    if (score.status === "eligible") { eligibleCount += 1; lastDate = date; lastTrueAbility = trueAbility; }
    perSession.push({ sessionId: feature.trainingSessionId, date, stratum: sessionStratum(feature.sessionType),
      sessionType: feature.sessionType, status: score.status, ca: score.currentAbility, ta: trueAbility, updated: update.updated });
  });

  const statusCounts: Record<string, number> = {};
  for (const entry of perSession) statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
  return {
    version: isLegacy ? "rai-v1.0.0-dev@62b4a97" : SCORING_MODEL_VERSION,
    calibrationCount: calibration.length, updates, finalTrueAbility: baseline ? trueAbility : null,
    caObservations: perSession.filter((entry) => entry.ca !== null).length,
    taObservations: perSession.filter((entry) => entry.ta !== null).length,
    statusCounts, perSession
  };
}

const v1 = runEngine("v1");
const v2 = runEngine("v2");

const percentile = (sortedValues: number[], fraction: number): number | null =>
  sortedValues.length === 0 ? null : sortedValues[Math.min(sortedValues.length - 1, Math.max(0, Math.floor(sortedValues.length * fraction)))] ?? null;
const summarize = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    p50: percentile(ordered, 0.5), p95: percentile(ordered, 0.95), max: ordered[ordered.length - 1] ?? null
  };
};

const pairs = v1.perSession.map((entry, index) => ({ v1: entry, v2: v2.perSession[index]! }))
  .filter((pair) => pair.v1.sessionId === pair.v2.sessionId);
if (pairs.length !== v1.perSession.length || pairs.length !== v2.perSession.length) {
  throw new Error("Engine timelines are not aligned; refusing to compute deltas");
}
const caDeltas = pairs.filter((pair) => pair.v1.ca !== null && pair.v2.ca !== null)
  .map((pair) => Math.abs(pair.v2.ca! - pair.v1.ca!));
const taDeltas = pairs.filter((pair) => pair.v1.ta !== null && pair.v2.ta !== null)
  .map((pair) => Math.abs(pair.v2.ta! - pair.v1.ta!));
const statusChanged = pairs.filter((pair) => pair.v1.status !== pair.v2.status).length;

/** §14.5 keeps these thresholds as the existing release gate; reuse them, do not restate them. */
const gateThresholds = { caMeanAbsoluteDelta: 8, caP95AbsoluteDelta: 15, finalTrueAbilityAbsoluteDelta: 10, statusChangeRate: 0.10 };
const caMean = summarize(caDeltas).mean;
const caP95 = summarize(caDeltas).p95;
const finalDelta = v1.finalTrueAbility === null || v2.finalTrueAbility === null
  ? null : Math.abs(v2.finalTrueAbility - v1.finalTrueAbility);
const statusChangeRate = pairs.length ? statusChanged / pairs.length : null;

const byStratum: Record<string, { sessions: number; caComparable: number; statusChanged: number; caMeanAbsoluteDelta: number | null }> = {};
for (const pair of pairs) {
  const bucket = byStratum[pair.v1.stratum] ??= { sessions: 0, caComparable: 0, statusChanged: 0, caMeanAbsoluteDelta: null };
  bucket.sessions += 1;
  if (pair.v1.status !== pair.v2.status) bucket.statusChanged += 1;
  if (pair.v1.ca !== null && pair.v2.ca !== null) {
    const previous = bucket.caMeanAbsoluteDelta ?? 0;
    bucket.caComparable += 1;
    bucket.caMeanAbsoluteDelta = (previous * (bucket.caComparable - 1) + Math.abs(pair.v2.ca - pair.v1.ca)) / bucket.caComparable;
  }
}

const repoRevision = (() => {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); }
  catch { return null; }
})();

const report = {
  version: "rai-version-replay-report-v1",
  generatedBy: "scripts/model-version-replay.mts",
  replayMode: "event_time_reconstruction",
  accuracyStatus: "not_evaluable" as const,
  accuracyNote: "Same-input engine comparison. Stored V3 rows carry no decoupling/environment evidence and the local library has no confirmed race/test labels, so this cannot certify accuracy.",
  scope: "Scoring-engine comparison (CA/TA) over ONE frozen stored-feature snapshot. Feature extraction and environment normalization are held fixed because the stored rows predate V4, so this is not a feature-version replay.",
  source: {
    databasePath: databasePath.slice(root.length + 1), featureRunId, repoRevision,
    schemaVersion, activeModelRunId, timezoneIdentifier: DATABASE_TIMEZONE,
    featureSnapshotSha256: createHash("sha256").update(canonicalSemanticJson(features)).digest("hex")
  },
  versionMatrix: {
    scoringEngine: SCORING_MODEL_VERSION, frozenBaselineEngine: "rai-v1.0.0-dev@62b4a97",
    modelConfigVersion: MODEL_CONFIG_VERSION, featureConfigVersion: FEATURE_CONFIG_VERSION,
    physiologyModelVersion: PHYSIOLOGY_MODEL_VERSION, modelEvalVersion: MODEL_EVAL_VERSION,
    comparabilityHistoryMode: config.comparabilityHistoryMode
  },
  cohort: {
    storedFeatures: features.length,
    eligible: features.filter((feature) => feature.eligibilityStatus === "eligible").length,
    trial: features.filter((feature) => feature.eligibilityStatus === "trial").length,
    excluded: features.filter((feature) => feature.eligibilityStatus === "excluded").length,
    legacySchemaRows: features.filter((feature) => feature.provenance.featureSchemaVersion !== "workout-feature-v4").length,
    /** §3.3 check on real data. Counted from the marker this code path stamps, not from the
     * default of the classifier, so removing the marker changes this number. */
    legacyReadsMarked: features.filter((feature) => feature.missingReasons.includes("unavailable_in_legacy_feature")).length,
    v1CalibrationCount: v1.calibrationCount, v2CalibrationCount: v2.calibrationCount
  },
  engines: {
    v1: { version: v1.version, updates: v1.updates, finalTrueAbility: v1.finalTrueAbility,
      caObservations: v1.caObservations, taObservations: v1.taObservations, statusCounts: v1.statusCounts },
    v2: { version: v2.version, updates: v2.updates, finalTrueAbility: v2.finalTrueAbility,
      caObservations: v2.caObservations, taObservations: v2.taObservations, statusCounts: v2.statusCounts }
  },
  divergence: {
    sessionsCompared: pairs.length,
    caComparableSessions: caDeltas.length,
    /** A coverage gap between the engines would make the delta distributions below
     * non-comparable, so it is stated as its own number instead of being implied. */
    coverageDelta: { ca: v2.caObservations - v1.caObservations, ta: v2.taObservations - v1.taObservations },
    caAbsoluteDelta: summarize(caDeltas), trueAbilityAbsoluteDelta: summarize(taDeltas),
    finalTrueAbilityAbsoluteDelta: finalDelta, statusChanged, statusChangeRate,
    byStratum
  },
  releaseGate: {
    name: "rai-shadow-gate-v1",
    thresholds: gateThresholds,
    caMeanAbsoluteDelta: { value: caMean, passed: caMean === null ? null : caMean <= gateThresholds.caMeanAbsoluteDelta },
    caP95AbsoluteDelta: { value: caP95, passed: caP95 === null ? null : caP95 <= gateThresholds.caP95AbsoluteDelta },
    finalTrueAbilityAbsoluteDelta: { value: finalDelta, passed: finalDelta === null ? null : finalDelta <= gateThresholds.finalTrueAbilityAbsoluteDelta },
    statusChangeRate: { value: statusChangeRate, passed: statusChangeRate === null ? null : statusChangeRate <= gateThresholds.statusChangeRate },
    note: "Gate acceptance is a release condition, not an accuracy claim. A not_evaluable accuracy status above still blocks any precision activation."
  },
  notEvaluable: [
    "external_label_accuracy",
    "interval_calibration",
    "negative_acceptance_truthfulness",
    "as_known_then_replay (stored rows have no arrival ledger)"
  ],
  reproduce: `node --import tsx scripts/model-version-replay.mts --database ${databasePath.slice(root.length + 1)} --out ${outPath.slice(root.length + 1)}`
};

const output = JSON.stringify(report, null, 2) + "\n";
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, output);
process.stdout.write(output);
