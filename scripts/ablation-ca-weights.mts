import { decodeStoredFeature } from "@rai/features";
#!/usr/bin/env node
// CA dimension-weight ablation for the V2-A change
// (RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md §6.1).
//
// §6.1 makes this report a release condition, not a nice-to-have: the weight PR is
// not accepted without it. It compares the candidate weightings on ONE fixed
// feature snapshot, so the only thing that differs between rows is the weighting.
//
// Read-only with respect to the database.
//
// Deliberate limitation, stated rather than hidden: this replay omits the
// inactivity decay that `replayModel` applies before each eligible workout. Decay
// depends only on dates and the running true ability, so it is identical for every
// candidate; it shifts absolute TA but cannot reorder the candidates. Coverage,
// CA distribution, update magnitudes and acceptance rates — the numbers §6.1 asks
// for — are unaffected.
//
// Usage:
//   node --import tsx scripts/ablation-ca-weights.mts \
//     [--database var/rai.sqlite] [--out deliverables/CA_WEIGHT_ABLATION.json]

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { SessionStratum, StratumHistory, WorkoutFeatureVector } from "@rai/contracts";
import {
  MODEL_CONFIG_VERSION,
  buildAdaptiveBaselineTimeline,
  buildLegacyStratumHistory,
  createPersonalBaseline,
  defaultRaiModelConfig,
  evaluateStratumComparability,
  hasCompletedCalibration,
  scoreFeature,
  sessionStratum,
  sortWorkoutFeaturesChronologically,
  updateTrueAbilityFromFeatureScore,
  trueAbilityAfterInactivity,
  type PersonalBaseline,
  type RaiModelConfig
} from "@rai/scoring";
import { localDateInTimeZone } from "@rai/training-load";
import { DATABASE_TIMEZONE } from "@rai/contracts";
import { buildLabelFunnel } from "@rai/application";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const readArg = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
};

const CANDIDATES: Record<string, RaiModelConfig["dimensionWeights"]> = {
  // Old control: exactly what shipped before the V2 change.
  v1_current: { efficiency: 0.375, pace: 0.3125, cardio: 0, stability: 0.1875, recovery: 0.125 },
  // §6.1 control group: recovery removed, literals untouched. CA renormalises over
  // what remains, which is what makes this 3/7, 5/14, 3/14.
  v2a: { efficiency: 0.375, pace: 0.3125, cardio: 0, stability: 0.1875, recovery: 0 },
  // §6.1 refinement candidate; not assumed to be better, only measured.
  v2b: { efficiency: 0.45, pace: 0.35, cardio: 0, stability: 0.2, recovery: 0 },
  drop_pace: { efficiency: 0.375, pace: 0, cardio: 0, stability: 0.1875, recovery: 0 },
  drop_efficiency: { efficiency: 0, pace: 0.3125, cardio: 0, stability: 0.1875, recovery: 0 },
  drop_stability: { efficiency: 0.375, pace: 0.3125, cardio: 0, stability: 0, recovery: 0 }
};

const databasePath = resolve(root, readArg("--database", "var/rai.sqlite"));
const outPath = resolve(root, readArg("--out", "deliverables/CA_WEIGHT_ABLATION.json"));
const comparabilityHistoryMode = readArg("--comparability-history", defaultRaiModelConfig.comparabilityHistoryMode);
if (comparabilityHistoryMode !== "legacy" && comparabilityHistoryMode !== "bounded") {
  throw new Error("--comparability-history must be legacy or bounded");
}
if (!existsSync(databasePath)) {
  process.stderr.write(`Database not found: ${databasePath}\n`);
  process.exit(1);
}

const handle = new DatabaseSync(databasePath, { readOnly: true });
const featureRunRow = handle.prepare(`
  SELECT feature.id AS id
  FROM active_model_run active
  JOIN model_runs model ON model.id = active.model_run_id
  JOIN feature_runs feature ON feature.id = model.feature_run_id
  WHERE model.status = 'succeeded'
`).get() as { id: string } | undefined;
const featureRunId = featureRunRow?.id ?? (handle.prepare(
  "SELECT id FROM feature_runs WHERE status = 'succeeded' ORDER BY created_at DESC LIMIT 1"
).get() as { id: string } | undefined)?.id;
if (!featureRunId) {
  process.stderr.write("No succeeded feature run to ablate over.\n");
  process.exit(1);
}
// `features_json` holds only the signals object; every other field is its own
// column. The vector has to be rebuilt from both halves.
const rows = handle.prepare(`
  SELECT id, training_session_id, canonical_workout_id, workout_start_at, duration_seconds,
         distance_km, average_speed_mps, average_heart_rate_bpm, heart_rate_sample_count,
         heart_rate_coverage, route_point_count, route_quality, source_confidence,
         session_type, session_type_source, eligibility_status, quality_score,
         missing_reasons_json, features_json, provenance_json, computed_at
  FROM workout_features WHERE feature_run_id = ?
`).all(featureRunId) as Array<Record<string, unknown>>;
const labelFunnel = buildLabelFunnel(handle, new Date().toISOString());
handle.close();

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const features = rows.map((row) => decodeStoredFeature(String(row.features_json), ({
  id: String(row.id),
  featureRunId,
  trainingSessionId: String(row.training_session_id),
  canonicalWorkoutId: row.canonical_workout_id === null ? null : String(row.canonical_workout_id),
  workoutStartAt: String(row.workout_start_at),
  durationSeconds: Number(row.duration_seconds),
  distanceKm: nullableNumber(row.distance_km),
  averageSpeedMetersPerSecond: nullableNumber(row.average_speed_mps),
  averageHeartRateBpm: nullableNumber(row.average_heart_rate_bpm),
  heartRateSampleCount: Number(row.heart_rate_sample_count ?? 0),
  heartRateCoverage: nullableNumber(row.heart_rate_coverage),
  routePointCount: Number(row.route_point_count ?? 0),
  routeQuality: nullableNumber(row.route_quality),
  sourceConfidence: Number(row.source_confidence ?? 0),
  sessionType: String(row.session_type),
  sessionTypeSource: String(row.session_type_source),
  eligibilityStatus: String(row.eligibility_status),
  qualityScore: Number(row.quality_score ?? 0),
  missingReasons: JSON.parse(String(row.missing_reasons_json ?? "[]")) as string[],
  signals: JSON.parse(String(row.features_json)),
  provenance: JSON.parse(String(row.provenance_json ?? "{}")),
  computedAt: String(row.computed_at)
}) as unknown as WorkoutFeatureVector));

// A silent shape change would make every downstream number meaningless, so fail
// loudly instead of reporting a confident zero.
const sample = features[0];
if (!sample || typeof sample.signals?.efficiencyRaw === "undefined") {
  process.stderr.write("Stored feature signals do not match the expected shape; refusing to report.\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------
const percentile = (sorted: number[], fraction: number): number | null => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)));
  return sorted[index] ?? null;
};
const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
const stdev = (values: number[]): number | null => {
  const average = mean(values);
  if (average === null || values.length < 2) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};
const rank = (values: number[]): number[] => {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j += 1;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[order[k]!.index] = shared;
    i = j + 1;
  }
  return ranks;
};
const pearson = (left: number[], right: number[]): number | null => {
  if (left.length < 3) return null;
  const lMean = mean(left);
  const rMean = mean(right);
  if (lMean === null || rMean === null) return null;
  let num = 0;
  let lSq = 0;
  let rSq = 0;
  for (let i = 0; i < left.length; i += 1) {
    const dl = left[i]! - lMean;
    const dr = right[i]! - rMean;
    num += dl * dr;
    lSq += dl * dl;
    rSq += dr * dr;
  }
  const denominator = Math.sqrt(lSq * rSq);
  return denominator === 0 ? null : num / denominator;
};
const spearman = (left: number[], right: number[]): number | null =>
  pearson(rank(left), rank(right));

// ---------------------------------------------------------------------------
// One replay per candidate over the SAME feature set
// ---------------------------------------------------------------------------
const sorted = sortWorkoutFeaturesChronologically(features);

// Use the live bounded-window assembler; never re-implement comparability history here.
const adaptiveBaselines = buildAdaptiveBaselineTimeline(sorted);
const stratumHistoryByIndex = comparabilityHistoryMode === "bounded"
  ? adaptiveBaselines.map((item) => item.history) : buildLegacyStratumHistory(sorted);

interface CandidateOutcome {
  acceptanceByGroup: Record<string, {
    opportunitiesPositive: number; opportunitiesNegative: number;
    acceptedPositive: number; acceptedNegative: number; unscorable: number;
  }>;
  candidate: string;
  dimensionWeights: RaiModelConfig["dimensionWeights"];
  calibrationSessions: number;
  attempted: number;
  eligible: number;
  trial: number;
  calibrating: number;
  excluded: number;
  scorableRate: number | null;
  currentAbility: { mean: number | null; stdev: number | null; p05: number | null; p50: number | null; p95: number | null; saturationRate: number | null };
  /** §6.5/§6.6: how much of the configured evidence the scored workouts carried. */
  dimensionCoverage: { mean: number | null; fullCoverageRate: number | null };
  trueAbility: { final: number; updated: number; meanAbsoluteDelta: number | null; maxAbsoluteDelta: number | null };
  acceptance: { positiveCandidates: number; positiveAccepted: number; negativeCandidates: number; negativeAccepted: number; noLearningTarget: number };
  effectiveWeights: Record<string, number> | null;
}

function runCandidate(name: string, dimensionWeights: RaiModelConfig["dimensionWeights"]): CandidateOutcome {
  const config: RaiModelConfig = { ...defaultRaiModelConfig, dimensionWeights, comparabilityHistoryMode };

  // Same calibration-prefix rule as `replayModel`.
  const calibrationFeatures: WorkoutFeatureVector[] = [];
  for (const feature of sorted) {
    if (feature.eligibilityStatus !== "eligible") continue;
    calibrationFeatures.push(feature);
    if (hasCompletedCalibration(calibrationFeatures, config)) break;
  }
  const baseline: PersonalBaseline | null = hasCompletedCalibration(calibrationFeatures, config)
    ? createPersonalBaseline(calibrationFeatures)
    : null;
  const calibrationIds = new Set(baseline?.calibrationFeatureIds ?? []);
  const completionIndex = baseline
    ? Math.max(...sorted.map((feature, index) => (calibrationIds.has(feature.id) ? index : -1)), -1)
    : Number.POSITIVE_INFINITY;

  let trueAbility = 50;
  let eligibleWorkoutCount = 0;
  let trial = 0;
  let calibrating = 0;
  let excluded = 0;
  let eligible = 0;
  let attempted = 0;
  const abilities: number[] = [];
  const deltas: number[] = [];
  const coverages: number[] = [];
  let noLearningTarget = 0;
  // §6.9 confirmation buffer. Without carrying it the report would reset on every
  // workout and no negative could ever be confirmed — the numbers would describe a
  // policy that does not exist.
  let pendingNegativeConfirmations = 0;
  let positiveCandidates = 0;
  let positiveAccepted = 0;
  let negativeCandidates = 0;
  let negativeAccepted = 0;
  // §6.9 asks the new gate to be judged against the residual distribution, not on its
  // own: a low negative acceptance rate is fine if a decline is still learned once it is
  // real. These two record how much history that took. Without them a ratchet and a
  // working gate look identical in the acceptance rate.
  let firstNegativeAcceptanceAtAttempt: number | null = null;
  let negativeOpportunitiesToFirstAcceptance: number | null = null;
  let effectiveWeights: Record<string, number> | null = null;
  let lastEligibleDate: string | null = null;
  let lastEligibleAbility = 50;
  const acceptanceByGroup: CandidateOutcome["acceptanceByGroup"] = {};

  for (const [index, feature] of sorted.entries()) {
    if (feature.eligibilityStatus === "excluded") {
      excluded += 1;
      continue;
    }
    if (!baseline || index <= completionIndex) {
      calibrating += 1;
      continue;
    }
    attempted += 1;
    const localDate = localDateInTimeZone(feature.workoutStartAt, DATABASE_TIMEZONE);
    if (lastEligibleDate !== null) trueAbility = trueAbilityAfterInactivity(
      lastEligibleAbility, (Date.parse(localDate) - Date.parse(lastEligibleDate)) / 86_400_000
    );
    const calibrationMaturity = Math.min(1, Math.max(0.25, (eligibleWorkoutCount + 1) / 12));
    const score = scoreFeature(
      feature,
      baseline,
      calibrationMaturity,
      stratumHistoryByIndex[index] ?? null,
      config
    );
    if (score.currentAbility === null) {
      trial += 1;
      continue;
    }
    eligible += 1;
    abilities.push(score.currentAbility);
    coverages.push(score.dimensionCoverage);
    if (effectiveWeights === null) {
      effectiveWeights = Object.fromEntries(
        Object.entries(score.effectiveWeights).map(([key, value]) => [key, Number((value ?? 0).toFixed(6))])
      );
    }
    // §6.6: opportunities are counted on the learning target, not the display
    // estimate. A workout with no learning target is not an opportunity at all, so
    // it is reported separately rather than folded into either denominator.
    //
    // Acceptance is "the gate let it through", decided by whether the update was
    // actually applied. Judging it from the gate inputs alone would count a
    // negative that is still waiting for its confirmation as accepted, and the
    // report would then describe a policy more permissive than the one running.
    const learning = score.learningObservation;
    const before = trueAbility;
    const update = updateTrueAbilityFromFeatureScore(
      trueAbility,
      eligibleWorkoutCount,
      score,
      config,
      pendingNegativeConfirmations
    );
    pendingNegativeConfirmations = update.pendingNegativeConfirmations;
    trueAbility = update.nextTrueAbility;
    const groupKeys = [
      `stratum:${score.stratum}`,
      `session:${feature.sessionType}`,
      `source:${String(feature.provenance.sourceCategory ?? "unknown")}`,
      "environment:unavailable_in_stored_v3_features"
    ];
    for (const key of groupKeys) {
      const group = acceptanceByGroup[key] ??= {
        opportunitiesPositive: 0, opportunitiesNegative: 0,
        acceptedPositive: 0, acceptedNegative: 0, unscorable: 0
      };
      if (learning === null) group.unscorable++;
      else if (learning > before) {
        group.opportunitiesPositive++;
        if (update.updated) group.acceptedPositive++;
      } else if (learning < before) {
        group.opportunitiesNegative++;
        if (update.updated) group.acceptedNegative++;
      }
    }

    if (learning === null) {
      noLearningTarget += 1;
    } else if (learning > before) {
      positiveCandidates += 1;
      if (update.updated) positiveAccepted += 1;
    } else if (learning < before) {
      negativeCandidates += 1;
      if (update.updated) {
        negativeAccepted += 1;
        if (firstNegativeAcceptanceAtAttempt === null) {
          firstNegativeAcceptanceAtAttempt = attempted;
          negativeOpportunitiesToFirstAcceptance = negativeCandidates;
        }
      }
    }

    if (update.updated) {
      deltas.push(Math.abs(trueAbility - before));
    }
    if (score.status === "eligible") {
      eligibleWorkoutCount += 1;
      lastEligibleDate = localDate;
      lastEligibleAbility = trueAbility;
    }
  }

  const sortedAbilities = [...abilities].sort((a, b) => a - b);
  const saturated = abilities.filter((value) => value <= 0.001 || value >= 99.999).length;
  return {
    acceptanceByGroup,
    candidate: name,
    dimensionWeights,
    calibrationSessions: calibrationFeatures.length,
    attempted,
    eligible,
    trial,
    calibrating,
    excluded,
    scorableRate: attempted === 0 ? null : eligible / attempted,
    currentAbility: {
      mean: mean(abilities),
      stdev: stdev(abilities),
      p05: percentile(sortedAbilities, 0.05),
      p50: percentile(sortedAbilities, 0.5),
      p95: percentile(sortedAbilities, 0.95),
      saturationRate: abilities.length === 0 ? null : saturated / abilities.length
    },
    trueAbility: {
      final: trueAbility,
      updated: deltas.length,
      meanAbsoluteDelta: mean(deltas),
      maxAbsoluteDelta: deltas.length === 0 ? null : Math.max(...deltas)
    },
    dimensionCoverage: {
      mean: mean(coverages),
      fullCoverageRate: coverages.length === 0 ? null : coverages.filter((value) => value >= 1).length / coverages.length
    },
    acceptance: {
      positiveCandidates,
      positiveAccepted,
      negativeCandidates,
      negativeAccepted,
      noLearningTarget,
      negativeOpportunitiesToFirstAcceptance,
      firstNegativeAcceptanceAtAttempt
    },
    effectiveWeights
  };
}

const outcomes = Object.entries(CANDIDATES).map(([name, weights]) => runCandidate(name, weights));

// ---------------------------------------------------------------------------
// Raw-signal redundancy. Feature-level, independent of the weights, which is why
// it is reported once. Normalized signals do not exist yet (V4 features).
// ---------------------------------------------------------------------------
const signalPairs: Array<[string, (feature: WorkoutFeatureVector) => number | null]> = [
  ["efficiency", (feature) => feature.signals.efficiencyRaw],
  ["pace", (feature) => feature.signals.paceRawMetersPerSecond],
  ["stability", (feature) => feature.signals.stabilityRaw],
  ["recovery", (feature) => feature.signals.recoveryRaw]
];
const correlations: Array<{ left: string; right: string; samples: number; pearson: number | null; spearman: number | null }> = [];
for (let i = 0; i < signalPairs.length; i += 1) {
  for (let j = i + 1; j < signalPairs.length; j += 1) {
    const [leftName, leftRead] = signalPairs[i]!;
    const [rightName, rightRead] = signalPairs[j]!;
    const left: number[] = [];
    const right: number[] = [];
    for (const feature of sorted) {
      if (feature.eligibilityStatus !== "eligible") continue;
      const l = leftRead(feature);
      const r = rightRead(feature);
      if (l === null || r === null || !Number.isFinite(l) || !Number.isFinite(r)) continue;
      left.push(l);
      right.push(r);
    }
    correlations.push({
      left: leftName,
      right: rightName,
      samples: left.length,
      pearson: pearson(left, right),
      spearman: spearman(left, right)
    });
  }
}

// §6.2 requires the replay to report, per bucket: independent session count, span
// and comparability rate, plus the refusal reasons. This is that ledger — without it
// a low comparability rate would be indistinguishable from a broken stratum design.
const policy = defaultRaiModelConfig.comparabilityPolicy;
const stratumCensus = [...new Set(sorted.map((item) => sessionStratum(item.sessionType)))].map((stratum) => {
  const indices = sorted
    .map((item, index) => (sessionStratum(item.sessionType) === stratum ? index : -1))
    .filter((index) => index >= 0);
  const histories = indices.map((index) => stratumHistoryByIndex[index]!);
  // Ask the production rule rather than re-deriving the threshold here: a ledger that
  // recomputes "comparable" itself can disagree with the engine it is meant to explain
  // and still look authoritative.
  const verdicts = histories.map((history) =>
    evaluateStratumComparability({ stratum, history, policy })
  );
  const comparable = verdicts.filter((verdict) => verdict.status === "comparable").length;
  const reasonCounts = new Map<string, number>();
  for (const verdict of verdicts) {
    for (const reason of verdict.reasonCodes) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  return {
    stratum,
    workouts: indices.length,
    eligibleWorkouts: indices.filter((index) => sorted[index]!.eligibilityStatus === "eligible").length,
    maximumIndependentSessions: histories.reduce((max, history) => Math.max(max, history.independentSessions), 0),
    maximumSpanDays: Number(histories.reduce((max, history) => Math.max(max, history.spanDays), 0).toFixed(1)),
    comparableRate: histories.length === 0 ? null : comparable / histories.length,
    // Actual refusal counts, not the full list of reasons the rule could emit.
    refusalReasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count)
  };
});

const report = {
  reportVersion: "rai-ca-weight-ablation-v1",
  stratumCensus,
  generatedAt: new Date().toISOString(),
  modelConfigVersion: MODEL_CONFIG_VERSION,
  comparabilityHistoryMode,
  databasePath,
  featureRunId,
  featureCount: sorted.length,
  labeledOutcomeCount: labelFunnel.usableOutcomeCount,
  // §6.1 requires an accuracy ranking to be reported as not evaluable without
  // labels. Local labeled outcomes are zero, so this is the honest state.
  accuracyComparison: "not_evaluable",
  accuracyComparisonReason: labelFunnel.usableOutcomeCount === 0
    ? "no labeled race/test outcomes in this database; see the walk-forward report"
    : "this is a behavioural ablation, not an independent external-label accuracy evaluation",
  limitation:
    "Uses stored pre-V2 features, not a new V4 extraction. Replays production inactivity decay and eligible-session counting. v1_current is only a V1-weight control under the current engine, NOT an executable replay of the old engine. Environment is unavailable in these stored features.",
  candidateNotes: [
    "The comparabilityHistoryMode field declares whether this is the incumbent history policy or the bounded candidate. v11 uses fractional weight coverage. This is not the earlier v9/v10 single-factor experiment. Acceptance denominators change as TA changes; compare counts as well as rates.",
    "Ablations remove one Fitness dimension without reintroducing Recovery. minimumAvailableWeight is a fraction of configured weights, so deleting a dimension does not make an otherwise complete candidate fail just because its unnormalised weights sum to less than 0.65.",
    "acceptance denominators are the independent candidate opportunities taken before the gates decide. Every gate is implemented and applied: §6.7 evidence reliability, §6.2 stratum comparability, and the §6.9 K-consecutive negative confirmation. A high rate therefore means the gates rarely bind on this data, not that they are missing. A negative candidate counted as accepted is one whose update was actually applied — a residual deferred by the confirmation count is not acceptance.",
    "In bounded mode the per-stratum census uses eligible independent sessions inside the 28/42-day window; legacy mode intentionally preserves the incumbent cumulative history policy. acceptanceByGroup reports opportunity counts by stratum, session and source category. Weather remains explicitly unavailable; these counts do not prove real decline-detection accuracy."
  ],
  outcomes,
  correlations,
  correlationsByStratum: [...new Set(sorted.map((item) => sessionStratum(item.sessionType)))].map((stratum) => ({
    stratum,
    pairs: signalPairs.flatMap(([leftName, leftRead], i) => signalPairs.slice(i + 1).map(([rightName, rightRead]) => {
      const pairs = sorted.filter((item) => item.eligibilityStatus === "eligible" &&
        sessionStratum(item.sessionType) === stratum).flatMap((item) => {
        const l = leftRead(item), r = rightRead(item);
        return l !== null && r !== null && Number.isFinite(l) && Number.isFinite(r) ? [[l, r] as const] : [];
      });
      const left = pairs.map(([l]) => l), right = pairs.map(([, r]) => r);
      return { left: leftName, right: rightName, samples: pairs.length,
        pearson: pearson(left, right), spearman: spearman(left, right) };
    }))
  })),
  normalizedCorrelations: { status: "not_evaluable", reason: "stored_v3_features_have_no_normalized_signals" }
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(`\nWrote ${outPath}\n`);
