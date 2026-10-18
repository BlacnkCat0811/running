import {
  READINESS_MODEL_VERSION,
  READINESS_RULE_SET_VERSION,
  type ModelLineageV2,
  type ReadinessAssessment,
  type ReadinessAssessmentResult,
  type ReadinessCoverage,
  type ReadinessSignal,
  type ReadinessSignalName,
  type ReadinessSnapshot,
  type ReadinessState,
  type ReadinessStateEvidence,
  type PhysState
} from "@rai/contracts";

// Rules extracted verbatim from the Coach verdict gates
// (`apps/api/src/mobile-coach.ts`). The point of this package is that recovery
// rules have exactly one home; preserving the numbers is what lets the first
// version land as a behaviour-preserving move rather than a redesign.
//
// They are heuristic. Keeping them is justified by behavioural compatibility,
// which is not the same as evidence that they are physiologically optimal or
// medically meaningful.
export const READINESS_SLEEP_RATIO_THRESHOLD = 0.75;
export const READINESS_HRV_RATIO_THRESHOLD = 0.85;
export const READINESS_RHR_RATIO_THRESHOLD = 1.03;
export const READINESS_SLEEP_STREAK_THRESHOLD = 3;

export function readinessStateEvidence(): ReadinessStateEvidence {
  return {
    method: "heuristic_rules",
    validationStatus: "not_empirically_validated",
    ruleSetVersion: READINESS_RULE_SET_VERSION,
    validationTarget: null,
    validationReportId: null
  };
}

export interface ReadinessInput {
  asOf: string;
  localDate: string;
  /** Local date the recovery evidence belongs to; `null` when unknown. */
  evidenceLocalDate: string | null;
  evidenceStatus: "unknown" | "partial" | "valid" | "stale";
  sleepMinutes: number | null;
  sleepBaselineMinutes: number | null;
  nightsBelowSleepBaseline: number;
  hrvMs: number | null;
  hrvBaselineMs: number | null;
  restingHeartRateBpm: number | null;
  restingHeartRateBaselineBpm: number | null;
  observedAt: string | null;
  availableAt: string | null;
}

/** `value / baseline`, requiring only a positive baseline — as the Coach did. */
const ratioValue = (value: number | null, baseline: number | null): number | null =>
  value !== null && baseline !== null && baseline > 0 ? value / baseline : null;

function classifyRecoveryFlags(
  coverage: ReadinessCoverage,
  sleepLow: boolean, hrvLow: boolean, restingHeartRateUp: boolean, sleepStreak: boolean
): ReadinessAssessment {
  return coverage === "none" ? "not_assessed"
    : sleepStreak || (sleepLow && hrvLow && restingHeartRateUp) ? "multiple_low_signals"
      : sleepLow || (hrvLow && restingHeartRateUp) ? "low_signal" : "no_low_signal";
}

function buildSignal(
  name: ReadinessSignalName,
  value: number | null,
  baseline: number | null,
  low: boolean,
  input: ReadinessInput
): ReadinessSignal {
  const ratio = ratioValue(value, baseline);
  // "missing" means the reading or its reference does not exist. A reading with
  // a non-positive reference cannot be compared, which is a weaker statement
  // than not having the reading at all.
  const quality = value === null || baseline === null ? "missing" : ratio === null ? "sparse" : "adequate";
  return {
    name,
    value,
    baseline,
    ratio,
    low,
    quality,
    observedAt: input.observedAt,
    availableAt: input.availableAt,
    evidenceLocalDate: input.evidenceLocalDate
  };
}

/**
 * Assess today's recovery from personal-baseline evidence.
 *
 * Coverage answers "could today be assessed at all"; `assessment` answers "what
 * does it say". They stay separate on purpose: a gap in coverage is not a
 * negative finding, and complete coverage is not a positive one.
 */
export function assessReadiness(input: ReadinessInput): ReadinessAssessmentResult {
  const sleepRatio = ratioValue(input.sleepMinutes, input.sleepBaselineMinutes);
  const hrvRatio = ratioValue(input.hrvMs, input.hrvBaselineMs);

  const sleepLow = sleepRatio !== null && sleepRatio < READINESS_SLEEP_RATIO_THRESHOLD;
  const hrvLow = hrvRatio !== null && hrvRatio < READINESS_HRV_RATIO_THRESHOLD;
  // Compared directly rather than through a ratio: the Coach rule fires on a
  // raised absolute resting heart rate, and a non-positive baseline must not
  // silently disable it.
  const restingHeartRateUp =
    input.restingHeartRateBpm !== null &&
    input.restingHeartRateBaselineBpm !== null &&
    input.restingHeartRateBpm > input.restingHeartRateBaselineBpm * READINESS_RHR_RATIO_THRESHOLD;
  const sleepStreak = input.nightsBelowSleepBaseline >= READINESS_SLEEP_STREAK_THRESHOLD;

  // Evidence is today's only when it woke up today. An older night is something
  // the app may show, never an input to today's arrangement.
  const datedToday =
    input.evidenceLocalDate === input.localDate &&
    input.evidenceStatus !== "stale" &&
    input.evidenceStatus !== "unknown";

  // A reading counts only when its own baseline exists: a value with nothing to
  // compare against explains nothing, and must not inflate coverage.
  const measured =
    Number(ratioValue(input.sleepMinutes, input.sleepBaselineMinutes) !== null) +
    Number(ratioValue(input.hrvMs, input.hrvBaselineMs) !== null) +
    Number(ratioValue(input.restingHeartRateBpm, input.restingHeartRateBaselineBpm) !== null);

  const coverage: ReadinessCoverage =
    !datedToday || measured === 0 ? "none" : measured === 3 ? "complete" : "partial";

  const assessment = classifyRecoveryFlags(coverage, sleepLow, hrvLow, restingHeartRateUp, sleepStreak);

  const reasonCodes: string[] =
    assessment === "not_assessed"
      ? ["not_assessed"]
      : assessment === "no_low_signal"
        ? ["no_low_signal"]
        : sleepStreak
          ? ["sleep_streak"]
          : [
              ...(sleepLow ? ["sleep"] : []),
              ...(hrvLow ? ["hrv"] : []),
              ...(restingHeartRateUp ? ["resting_heart_rate"] : [])
            ];

  return {
    modelVersion: READINESS_MODEL_VERSION,
    asOf: input.asOf,
    localDate: input.localDate,
    coverage,
    assessment,
    state: toReadinessState(assessment),
    stateEvidence: readinessStateEvidence(),
    intendedUse: "training_guidance_not_diagnosis",
    // First version: `state` drives the Coach. A 0-100 recovery number would
    // present an uncalibrated heuristic as a measurement.
    score: null,
    scoreStatus: "not_calibrated",
    signals: {
      sleep: buildSignal("sleep", input.sleepMinutes, input.sleepBaselineMinutes, sleepLow, input),
      hrv: buildSignal("hrv", input.hrvMs, input.hrvBaselineMs, hrvLow, input),
      rhr: buildSignal("rhr", input.restingHeartRateBpm, input.restingHeartRateBaselineBpm, restingHeartRateUp, input)
    },
    sleepStreak,
    reasonCodes
  };
}

/** Attach the provenance envelope. Assembly owns lineage, not the rules. */
export function withReadinessLineage(
  result: ReadinessAssessmentResult,
  lineage: ModelLineageV2
): ReadinessSnapshot {
  return { ...result, lineage };
}

function toReadinessState(assessment: ReadinessAssessment): ReadinessState {
  switch (assessment) {
    case "not_assessed":
      return "not_assessed";
    case "no_low_signal":
      return "no_low_signal";
    case "low_signal":
      return "caution";
    case "multiple_low_signals":
      return "strained";
  }
}

/** Explicit compatibility policy: recent background is not today's readiness. */
export function legacyRecoveryBackground(input: {
  sleepMinutes: number | null; sleepBaselineMinutes: number | null;
  hrvMs: number | null; hrvBaselineMs: number | null;
  rhrBpm: number | null; rhrBaselineBpm: number | null;
}): number | null {
  const values: number[] = [];
  const clamp = (n: number): number => Math.min(1, Math.max(0, n));
  const sleep = ratioValue(input.sleepMinutes, input.sleepBaselineMinutes);
  const hrv = ratioValue(input.hrvMs, input.hrvBaselineMs);
  if (sleep !== null) values.push(clamp(sleep));
  if (input.rhrBpm !== null && input.rhrBaselineBpm !== null) {
    values.push(clamp(1 - Math.max(0, input.rhrBpm - input.rhrBaselineBpm) / 12));
  }
  if (hrv !== null) values.push(clamp(hrv));
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Recovery evidence must be finite");
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Same low-signal rules, with the historical positive-evidence mapping. */
export function classifyReadinessPhysState(input: {
  sleepMinutes: number | null; sleepBaselineMinutes: number | null;
  hrvSdnnMs: number | null; hrvBaselineMs: number | null;
  rhrBpm: number | null; rhrBaselineBpm: number | null;
  nightsBelowSleepBaseline: number;
}): PhysState {
  // This adapter owns no clock and invents no observation/arrival timestamp.
  const sleep = ratioValue(input.sleepMinutes, input.sleepBaselineMinutes);
  const hrv = ratioValue(input.hrvSdnnMs, input.hrvBaselineMs);
  const rhr = ratioValue(input.rhrBpm, input.rhrBaselineBpm);
  const assessment = classifyRecoveryFlags(
    sleep === null && hrv === null && rhr === null ? "none" : "partial",
    sleep !== null && sleep < READINESS_SLEEP_RATIO_THRESHOLD,
    hrv !== null && hrv < READINESS_HRV_RATIO_THRESHOLD,
    rhr !== null && rhr > READINESS_RHR_RATIO_THRESHOLD,
    input.nightsBelowSleepBaseline >= READINESS_SLEEP_STREAK_THRESHOLD
  );
  return physiologicalState(assessment,sleep,hrv,rhr);
}

function physiologicalState(assessment:ReadinessAssessment,sleep:number|null,hrv:number|null,rhr:number|null):PhysState {
  if (assessment === "not_assessed") return "unknown";
  if (assessment === "multiple_low_signals") return "depleted";
  if (assessment === "low_signal") return "reduced";
  return (sleep !== null && sleep >= 0.9) ||
    (hrv !== null && hrv >= 0.9) ||
    (rhr !== null && rhr <= 1) ? "recovered_phys" : "unknown";
}

/** The load domain consumes the exact already-dated assessment, never re-reads recovery facts. */
export function physStateFromReadiness(assessment:ReadinessAssessmentResult):PhysState {
  return physiologicalState(assessment.assessment,assessment.signals.sleep.ratio,assessment.signals.hrv.ratio,assessment.signals.rhr.ratio);
}

export interface DatedRecoverySignal {
  availabilitySource?: "canonical_computation" | "dataset_publication_upper_bound" | "unknown";
  value: number | null;
  baseline: number | null;
  observedAt: string | null;
  availableAt: string | null;
  localDate: string | null;
}

/**
 * Strict V2 entry point. Each signal must independently belong to today and have
 * been available by asOf. Unknown arrival times are not fabricated from event time.
 */
export function assessDatedReadiness(input: {
  asOf: string; localDate: string;
  signals: Record<ReadinessSignalName, DatedRecoverySignal>;
  /** Consecutive dates are proved here, rather than accepting a precomputed count. */
  nights: Array<DatedRecoverySignal>;
}): ReadinessAssessmentResult {
  const asOf = Date.parse(input.asOf);
  if (!Number.isFinite(asOf) || !/^\d{4}-\d{2}-\d{2}$/.test(input.localDate) ||
      new Date(`${input.localDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.localDate) {
    throw new Error("Readiness requires a valid asOf and local date");
  }
  const available = (signal: DatedRecoverySignal): boolean => {
    for (const n of [signal.value, signal.baseline]) {
      if (n !== null && (!Number.isFinite(n) || n <= 0)) return false;
    }
    const observed = signal.observedAt === null ? NaN : Date.parse(signal.observedAt);
    const arrived = signal.availableAt === null ? NaN : Date.parse(signal.availableAt);
    return signal.value !== null && signal.baseline !== null &&
      Number.isFinite(observed) && Number.isFinite(arrived) &&
      observed <= asOf && arrived <= asOf && arrived >= observed;
  };
  const fresh = (name: ReadinessSignalName): boolean =>
    input.signals[name].localDate === input.localDate && available(input.signals[name]);
  const current = (name: ReadinessSignalName): number | null =>
    fresh(name) ? input.signals[name].value : null;
  const nights = new Map<string, DatedRecoverySignal>();
  for (const night of input.nights) {
    if (night.localDate === null) continue;
    if (nights.has(night.localDate)) throw new Error("Readiness nights must be canonical and unique per date");
    nights.set(night.localDate, night);
  }
  let streak = 0;
  for (let offset = 0; offset < input.nights.length; offset++) {
    const date = new Date(Date.parse(`${input.localDate}T00:00:00Z`) - offset * 86_400_000)
      .toISOString().slice(0, 10);
    const night = nights.get(date);
    // "差的一夜" must mean the *same* thing as the single-night rule: below
    // `READINESS_SLEEP_RATIO_THRESHOLD`. A night at 0.78 is not a low night by the
    // rule above, so it cannot be one third of a "three consecutive low nights"
    // either — the old 0.8 literal here made the assessment contradict its own
    // `signals.sleep.low`. One threshold, one source.
    if (!night || !available(night) || night.value! / night.baseline! >= READINESS_SLEEP_RATIO_THRESHOLD) break;
    streak++;
  }
  const result = assessReadiness({
    asOf: input.asOf, localDate: input.localDate,
    evidenceLocalDate: input.localDate, evidenceStatus: "valid",
    sleepMinutes: current("sleep"), sleepBaselineMinutes: input.signals.sleep.baseline,
    hrvMs: current("hrv"), hrvBaselineMs: input.signals.hrv.baseline,
    restingHeartRateBpm: current("rhr"), restingHeartRateBaselineBpm: input.signals.rhr.baseline,
    nightsBelowSleepBaseline: streak, observedAt: null, availableAt: null
  });
  for (const name of ["sleep", "hrv", "rhr"] as const) {
    const source = input.signals[name];
    result.signals[name] = {
      ...result.signals[name],
      observedAt: source.observedAt,
      availableAt: source.availableAt,
      evidenceLocalDate: source.localDate
      ,availabilitySource: source.availabilitySource ?? "unknown"
    };
    if (!fresh(name)) result.reasonCodes.push(`${name}_unavailable_at_assessment`);
  }
  return result;
}
