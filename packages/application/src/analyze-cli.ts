import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

type FeatureStatus = "eligible" | "trial" | "excluded";
type AssessmentStatus = FeatureStatus | "calibrating";
type Dimension = "efficiency" | "pace" | "cardio" | "stability" | "recovery";

interface ModelRow {
  id: string;
  featureRunId: string;
  modelVersion: string;
  modelConfigJson: string;
  summaryJson: string | null;
}

interface DistributionRow {
  trainingSessionId: string;
  featureStatus: FeatureStatus;
  assessmentStatus: AssessmentStatus;
  currentAbility: number | null;
  trueAbilityBefore: number | null;
  trueAbilityAfter: number | null;
  trueAbilityDelta: number | null;
  confidence: number;
  efficiency: number | null;
  pace: number | null;
  cardio: number | null;
  stability: number | null;
  recovery: number | null;
  gold: number;
}

interface SnapshotRow {
  localDate: string;
  trueAbility: number | null;
  decayPoints: number;
  growthVelocityPerWeek: number | null;
  snapshotStatus: string;
}

const featureStatuses: FeatureStatus[] = ["eligible", "trial", "excluded"];
const assessmentStatuses: AssessmentStatus[] = ["calibrating", ...featureStatuses];
const dimensions: Dimension[] = ["efficiency", "pace", "cardio", "stability", "recovery"];

function optionValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function optionalValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return value !== null && Number.isFinite(value);
}

function quantile(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return null;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function round(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

function distribution(values: Array<number | null>): Record<string, number | null> {
  const finite = values.filter(isFiniteNumber);
  return {
    count: finite.length,
    minimum: round(quantile(finite, 0)),
    p10: round(quantile(finite, 0.1)),
    p50: round(quantile(finite, 0.5)),
    p90: round(quantile(finite, 0.9)),
    maximum: round(quantile(finite, 1)),
    atOrBelow5: finite.filter((value) => value <= 5).length,
    atOrAbove95: finite.filter((value) => value >= 95).length
  };
}

function countByStatus<T extends string>(rows: DistributionRow[], key: "featureStatus" | "assessmentStatus", statuses: T[]): Record<T, number> {
  return Object.fromEntries(
    statuses.map((status) => [status, rows.filter((row) => row[key] === status).length])
  ) as Record<T, number>;
}

function modelRow(database: DatabaseSync, modelRunId: string): ModelRow {
  const row = database
    .prepare(`
      SELECT
        id,
        feature_run_id AS featureRunId,
        model_version AS modelVersion,
        model_config_json AS modelConfigJson,
        summary_json AS summaryJson
      FROM model_runs
      WHERE id = ?
    `)
    .get(modelRunId) as unknown as ModelRow | undefined;
  if (!row) throw new Error(`Unknown model run: ${modelRunId}`);
  return row;
}

function rowsForModel(database: DatabaseSync, model: ModelRow): DistributionRow[] {
  return database
    .prepare(`
      SELECT
        feature.training_session_id AS trainingSessionId,
        feature.eligibility_status AS featureStatus,
        assessment.assessment_status AS assessmentStatus,
        assessment.current_ability AS currentAbility,
        assessment.true_ability_before AS trueAbilityBefore,
        assessment.true_ability_after AS trueAbilityAfter,
        assessment.true_ability_delta AS trueAbilityDelta,
        assessment.confidence,
        assessment.efficiency_score AS efficiency,
        assessment.pace_score AS pace,
        assessment.cardio_score AS cardio,
        assessment.stability_score AS stability,
        assessment.recovery_score AS recovery,
        CASE WHEN EXISTS (
          SELECT 1
          FROM workout_groups groupLink
          JOIN workout_group_members member ON member.group_id = groupLink.id
          JOIN workouts source ON source.id = member.workout_id
          WHERE groupLink.training_session_id = feature.training_session_id
            AND source.source_category = 'apple_watch'
            AND source.indoor = 0
        ) THEN 1 ELSE 0 END AS gold
      FROM workout_features feature
      JOIN ability_assessments assessment
        ON assessment.feature_id = feature.id
       AND assessment.model_run_id = ?
      WHERE feature.feature_run_id = ?
      ORDER BY assessment.sequence_number
    `)
    .all(model.id, model.featureRunId) as unknown as DistributionRow[];
}

function cohortSummary(rows: DistributionRow[]): Record<string, unknown> {
  return {
    trainingSessionCount: rows.length,
    featureStatus: countByStatus(rows, "featureStatus", featureStatuses),
    assessmentStatus: countByStatus(rows, "assessmentStatus", assessmentStatuses),
    currentAbility: distribution(rows.map((row) => row.currentAbility)),
    trueAbilityAfter: distribution(rows.map((row) => row.trueAbilityAfter)),
    trueAbilityDelta: distribution(rows.map((row) => row.trueAbilityDelta)),
    confidence: distribution(rows.map((row) => row.confidence)),
    dimensions: Object.fromEntries(
      dimensions.map((dimension) => [dimension, distribution(rows.map((row) => row[dimension]))])
    )
  };
}

function calibrationSummary(summaryJson: string | null): Record<string, number | null> {
  if (summaryJson === null) return { featureCount: null, spanDays: null };
  const parsed = JSON.parse(summaryJson) as {
    calibrationFeatureCount?: unknown;
    baseline?: { calibrationStartAt?: unknown; calibrationEndAt?: unknown } | null;
  };
  const startAt = parsed.baseline?.calibrationStartAt;
  const endAt = parsed.baseline?.calibrationEndAt;
  const spanDays =
    typeof startAt === "string" && typeof endAt === "string"
      ? (Date.parse(endAt) - Date.parse(startAt)) / 86_400_000
      : null;
  return {
    featureCount:
      typeof parsed.calibrationFeatureCount === "number" ? parsed.calibrationFeatureCount : null,
    spanDays: round(spanDays)
  };
}

function summarizeModel(database: DatabaseSync, modelRunId: string): Record<string, unknown> {
  const model = modelRow(database, modelRunId);
  const rows = rowsForModel(database, model);
  const goldRows = rows.filter((row) => row.gold === 1);
  const latestSnapshot = database
    .prepare(`
      SELECT
        local_date AS localDate,
        true_ability AS trueAbility,
        decay_points AS decayPoints,
        growth_velocity_per_week AS growthVelocityPerWeek,
        snapshot_status AS snapshotStatus
      FROM daily_ability_snapshots
      WHERE model_run_id = ?
      ORDER BY local_date DESC
      LIMIT 1
    `)
    .get(modelRunId) as unknown as SnapshotRow | undefined;

  return {
    modelRunId,
    modelVersion: model.modelVersion,
    modelConfig: JSON.parse(model.modelConfigJson),
    calibration: calibrationSummary(model.summaryJson),
    all: cohortSummary(rows),
    gold: cohortSummary(goldRows),
    latestSnapshot: latestSnapshot
      ? {
          localDate: latestSnapshot.localDate,
          trueAbility: round(latestSnapshot.trueAbility),
          decayPoints: round(latestSnapshot.decayPoints),
          growthVelocityPerWeek: round(latestSnapshot.growthVelocityPerWeek),
          snapshotStatus: latestSnapshot.snapshotStatus
        }
      : null
  };
}

function currentAbilityChange(
  database: DatabaseSync,
  baselineModelRunId: string,
  candidateModelRunId: string
): Record<string, number | null> {
  const baseline = database
    .prepare(`
      SELECT training_session_id AS trainingSessionId, current_ability AS currentAbility
      FROM ability_assessments
      WHERE model_run_id = ?
    `)
    .all(baselineModelRunId) as unknown as Array<{
      trainingSessionId: string;
      currentAbility: number | null;
    }>;
  const baselineBySession = new Map(
    baseline
      .filter((row) => isFiniteNumber(row.currentAbility))
      .map((row) => [row.trainingSessionId, row.currentAbility])
  );
  const candidate = database
    .prepare(`
      SELECT training_session_id AS trainingSessionId, current_ability AS currentAbility
      FROM ability_assessments
      WHERE model_run_id = ?
    `)
    .all(candidateModelRunId) as unknown as Array<{
      trainingSessionId: string;
      currentAbility: number | null;
    }>;
  const changes = candidate.flatMap((row) => {
    const previous = baselineBySession.get(row.trainingSessionId);
    return isFiniteNumber(previous) && isFiniteNumber(row.currentAbility)
      ? [row.currentAbility - previous]
      : [];
  });
  return distribution(changes);
}

function activeModelRunId(database: DatabaseSync): string {
  const row = database
    .prepare("SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1")
    .get() as unknown as { modelRunId: string } | undefined;
  if (!row) throw new Error("No active model run");
  return row.modelRunId;
}

function main(): void {
  const args = process.argv.slice(2);
  const databasePath = resolve(optionValue(args, "--database", "var/rai.sqlite"));
  if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const modelRunId = optionalValue(args, "--model-run") ?? activeModelRunId(database);
    const compareWith = optionalValue(args, "--compare-with");
    const result: Record<string, unknown> = {
      reportVersion: "rai-distribution-report-v1",
      model: summarizeModel(database, modelRunId)
    };
    if (compareWith !== null) {
      result.comparison = {
        baselineModelRunId: compareWith,
        currentAbilityChange: currentAbilityChange(database, compareWith, modelRunId)
      };
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    database.close();
  }
}

main();
