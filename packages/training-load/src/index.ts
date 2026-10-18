import type {
  DailyTrainingMetric,
  SessionType,
  TrainingLoadSource,
  TrainingPeriodSummary,
  TrainingStatisticsGranularity,
  TrainingStatusCode,
  TrainingStatusExplanation,
  WorkoutTrainingLoad,
  WorkoutZoneSummary,
  TrainingLoadBreakdown
} from "@rai/contracts";
import { DATABASE_TIMEZONE, highIntensityHeartRateZones, localCalendarFormatter, type PhysState } from "@rai/contracts";
import { classifyReadinessPhysState } from "@rai/readiness";

export { type PhysState } from "@rai/contracts";

export function countNightsBelowSleepBaseline(
  slots: Array<{ asleepUnionMinutes: number | null } | null>,
  sleepBaselineMinutes: number | null
): number {
  if (sleepBaselineMinutes == null || sleepBaselineMinutes <= 0) return 0;
  return slots.filter((night) => night?.asleepUnionMinutes != null && night.asleepUnionMinutes < sleepBaselineMinutes * 0.8).length;
}

export function classifyPhysState(input: {
  sleepMinutes: number | null; sleepBaselineMinutes: number | null;
  hrvSdnnMs: number | null; hrvBaselineMs: number | null;
  rhrBpm: number | null; rhrBaselineBpm: number | null;
  nightsBelowSleepBaseline: number;
}): PhysState {
  return classifyReadinessPhysState(input);
}

export interface HeartRateSample { heartRate: number; durationSeconds: number; startOffsetSeconds?: number }
export interface WorkoutLoadInput {
  trainingSessionId: string;
  localDate: string;
  durationSeconds: number;
  distanceMeters?: number | null;
  heartRateSamples?: HeartRateSample[];
  heartRateCoverage?: number;
  averageHeartRate?: number | null;
  restingHeartRate?: number | null;
  observedMaxHeartRate?: number | null;
  rpe?: number | null;
  sessionType?: SessionType;
  elevationGainMeters?: number | null;
  sourceConfidence?: number;
  excluded?: boolean;
  zoneSummary?: WorkoutZoneSummary | null;
  loadBreakdown?: TrainingLoadBreakdown | null;
}

/** @deprecated Recovery scores are no longer consumed by training status. */
export interface RecoveryEvidence { localDate: string; value: number }
export interface DailyPhysEvidence { localDate: string; physState: PhysState }
export interface DailyMetricConfig {
  acuteHalfLifeDays: number;
  chronicHalfLifeDays: number;
  minimumHistoryDays: number;
  minimumWorkoutCount: number;
  minimumChronicLoad: number;
}

export const defaultDailyMetricConfig: DailyMetricConfig = {
  acuteHalfLifeDays: 7,
  chronicHalfLifeDays: 28,
  minimumHistoryDays: 21,
  minimumWorkoutCount: 6,
  minimumChronicLoad: 5
};

/** Session-type intensity factors shared with composite load (training-zones). */
export const SESSION_TYPE_INTENSITY: Record<SessionType, number> = {
  unknown: 0.48, recovery: 0.30, easy: 0.42, steady: 0.52,
  tempo: 0.70, interval: 0.80, long_run: 0.55, race: 0.86
};

/** RPE→intensity lookup (index 0 unused; RPE 1–10). Shared with composite load. */
export const RPE_INTENSITY = [0, 0.25, 0.30, 0.38, 0.45, 0.52, 0.60, 0.68, 0.76, 0.84, 0.90] as const;

/**
 * Banister TRIMP exponential coefficient.
 * Male default 1.92; female literature value is 1.67 when sex is known.
 * DailyZoneProfile does not yet carry sex — always use male until that field exists.
 */
export const TRIMP_EXPONENT_MALE = 1.92;
export const TRIMP_EXPONENT_FEMALE = 1.67;

const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value));
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

function uniqueHeartRateTimeline(samples: HeartRateSample[], durationSeconds: number): HeartRateSample[] {
  let sequentialOffset = 0;
  const intervals = samples.flatMap((sample, index) => {
    if (!finite(sample.heartRate) || !finite(sample.durationSeconds) || sample.durationSeconds <= 0) return [];
    const requestedStart = finite(sample.startOffsetSeconds) ? sample.startOffsetSeconds : sequentialOffset;
    const requestedEnd = requestedStart + sample.durationSeconds;
    sequentialOffset = Math.max(sequentialOffset, requestedEnd);
    const start = clamp(requestedStart, 0, durationSeconds);
    const end = clamp(requestedEnd, 0, durationSeconds);
    return end > start ? [{ sample, index, start, end }] : [];
  });
  const events = intervals.flatMap((item) => [
    { time: item.start, item, start: true }, { time: item.end, item, start: false }
  ]).sort((a, b) => a.time - b.time);
  const active: typeof intervals = [];
  const result: HeartRateSample[] = [];
  for (let cursor = 0; cursor < events.length;) {
    const start = events[cursor]!.time;
    do {
      const event = events[cursor++]!;
      let left = 0, right = active.length;
      while (left < right) {
        const middle = (left + right) >>> 1;
        if (active[middle]!.index < event.item.index) left = middle + 1;
        else right = middle;
      }
      if (event.start) active.splice(left, 0, event.item);
      else active.splice(left, 1);
    } while (cursor < events.length && events[cursor]!.time === start);
    const end = events[cursor]?.time;
    if (end === undefined || active.length === 0) continue;
    // Preserve input-order floating point addition for overlapping samples.
    // Non-overlapping streams now visit each value once rather than scan all N.
    result.push({
      heartRate: active.reduce((sum, item) => sum + item.sample.heartRate, 0) / active.length,
      durationSeconds: end - start,
      startOffsetSeconds: start
    });
  }
  return result;
}

export function heartRateReserve(heartRate: number, restingHeartRate: number, observedMaxHeartRate: number): number | null {
  if (![heartRate, restingHeartRate, observedMaxHeartRate].every(Number.isFinite) || observedMaxHeartRate <= restingHeartRate) return null;
  return clamp((heartRate - restingHeartRate) / (observedMaxHeartRate - restingHeartRate));
}

export function trimpMinuteLoad(intensity: number, exponent: number = TRIMP_EXPONENT_MALE): number {
  if (!Number.isFinite(intensity)) throw new Error("intensity must be finite");
  const normalized = clamp(intensity);
  return normalized * Math.exp(exponent * normalized);
}

export function calculateWorkoutTrainingLoad(input: WorkoutLoadInput): WorkoutTrainingLoad | null {
  if (input.excluded || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) return null;
  const sessionType = input.sessionType ?? "unknown";
  const baseConfidence = clamp(input.sourceConfidence ?? 1);
  let source: TrainingLoadSource;
  let intensity: number;
  let load: number;
  let confidence: number;
  const validHrr = (hr: number): number | null => finite(input.restingHeartRate) && finite(input.observedMaxHeartRate)
    ? heartRateReserve(hr, input.restingHeartRate, input.observedMaxHeartRate) : null;
  const samples = uniqueHeartRateTimeline(input.loadBreakdown ? [] : input.heartRateSamples ?? [], input.durationSeconds)
    .map(sample => ({ ...sample, hrr: validHrr(sample.heartRate) }))
    .filter((sample): sample is HeartRateSample & { hrr: number } => sample.hrr !== null && finite(sample.durationSeconds) && sample.durationSeconds > 0);
  const sampleCoverage = samples.reduce((sum, sample) => sum + sample.durationSeconds, 0) / input.durationSeconds;
  const declaredCoverage = finite(input.heartRateCoverage) ? input.heartRateCoverage : sampleCoverage;
  const coverage = clamp(Math.min(declaredCoverage, sampleCoverage));
  if (coverage >= 0.7 && samples.length > 0) {
    source = "heart_rate_series";
    const coveredSeconds = samples.reduce((sum, sample) => sum + sample.durationSeconds, 0);
    const observedLoad = samples.reduce((sum, sample) => sum + sample.durationSeconds / 60 * trimpMinuteLoad(sample.hrr), 0);
    load = observedLoad * input.durationSeconds / coveredSeconds;
    intensity = samples.reduce((sum, sample) => sum + sample.hrr * sample.durationSeconds, 0) / coveredSeconds;
    confidence = 0.95 * baseConfidence * coverage;
  } else {
    const averageHrr = finite(input.averageHeartRate) ? validHrr(input.averageHeartRate) : null;
    if (averageHrr !== null) {
      source = "average_heart_rate"; intensity = averageHrr; confidence = 0.8 * baseConfidence;
    } else if (finite(input.rpe) && input.rpe >= 1 && input.rpe <= 10) {
      source = "rpe"; intensity = RPE_INTENSITY[Math.round(input.rpe)] ?? 0.48; confidence = 0.65 * baseConfidence;
    } else {
      source = "session_type"; intensity = SESSION_TYPE_INTENSITY[sessionType]; confidence = 0.4 * baseConfidence;
    }
    load = input.durationSeconds / 60 * trimpMinuteLoad(intensity);
  }
  const breakdown: TrainingLoadBreakdown = input.loadBreakdown ?? {
    rawHrrTrimp: source === "heart_rate_series" || source === "average_heart_rate" ? round(Math.max(0, load)) : null,
    internalLoad: source === "heart_rate_series" || source === "average_heart_rate" ? round(Math.max(0, load)) : null,
    paceLoad: null,
    distanceReferenceMeters: null,
    distanceExposureRatio: null,
    distanceFactor: 1,
    compositeLoad: round(Math.max(0, load)),
    compositeIntensity: round(intensity),
    heartRateConfidence: source === "heart_rate_series" || source === "average_heart_rate" ? round(clamp(confidence)) : 0,
    paceConfidence: 0
  };
  if (input.loadBreakdown) {
    source = "composite";
    intensity = breakdown.compositeIntensity;
    // Pure RPE/session fallbacks store Banister target confidences on one axis
    // with both modality loads null — use them as-is so the 0.6/0.4 blend does
    // not drag 0.65 → 0.39 or 0.4 → 0.24.
    if (breakdown.internalLoad === null && breakdown.paceLoad === null) {
      confidence = clamp(Math.max(breakdown.heartRateConfidence, breakdown.paceConfidence));
    } else {
      confidence = clamp(0.6 * breakdown.heartRateConfidence + 0.4 * breakdown.paceConfidence);
    }
  }
  return {
    trainingSessionId: input.trainingSessionId, localDate: input.localDate,
    distanceMeters: finite(input.distanceMeters) ? Math.max(0, input.distanceMeters) : null,
    durationSeconds: input.durationSeconds, load: breakdown.compositeLoad, intensity: round(intensity),
    source, confidence: round(clamp(confidence)), rpe: finite(input.rpe) ? clamp(input.rpe, 1, 10) : null,
    sessionType, averageHeartRate: finite(input.averageHeartRate) ? input.averageHeartRate : null,
    elevationGainMeters: finite(input.elevationGainMeters) ? Math.max(0, input.elevationGainMeters) : null,
    stimulusType: input.zoneSummary?.stimulusType ?? "unclassified",
    breakdown,
    explanations: [{ code: `load_source_${source}`, value: round(intensity), threshold: null }]
  };
}

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
const parseDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const addDays = (value: string, days: number): string => { const date = parseDate(value); date.setUTCDate(date.getUTCDate() + days); return isoDate(date); };
const dateDiff = (start: string, end: string): number => Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / 86_400_000);
const sumRange = (values: number[], end: number, length: number): number => values.slice(Math.max(0, end - length + 1), end + 1).reduce((a, b) => a + b, 0);
const percentile = (values: number[], fraction: number): number | null => {
  if (values.length === 0) return null; const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? null;
};

export function classifyTrainingStatus(input: {
  historyDays: number; workoutCount: number; chronicEwma: number; loadRatio: number | null;
  rampRate: number; recoveryEvidence: number | null; physState?: PhysState | undefined; strain: number | null; strainP90: number | null; daysSinceLastRun: number;
}, config = defaultDailyMetricConfig): { status: TrainingStatusCode; explanations: TrainingStatusExplanation[] } {
  const explanation = (code: string, value: number | null, threshold: number | null): TrainingStatusExplanation => ({ code, value, threshold });
  if (input.historyDays < config.minimumHistoryDays || input.workoutCount < config.minimumWorkoutCount || input.chronicEwma < config.minimumChronicLoad || input.loadRatio === null)
    return { status: "insufficient_data", explanations: [explanation("insufficient_training_history", input.historyDays, config.minimumHistoryDays)] };
  if (input.loadRatio > 1.5) return { status: "attention", explanations: [explanation("load_ratio_attention", input.loadRatio, 1.5)] };
  if (input.rampRate > 0.5) return { status: "attention", explanations: [explanation("ramp_rate_attention", input.rampRate, 0.5)] };
  if (input.physState === "depleted" && input.loadRatio >= 1.1)
    return { status: "attention", explanations: [explanation("depleted_phys_with_load", null, null)] };
  if (input.loadRatio > 1.3) return { status: "high_load", explanations: [explanation("load_ratio_high", input.loadRatio, 1.3)] };
  if (input.strain !== null && input.strainP90 !== null && input.strain > input.strainP90)
    return { status: "high_load", explanations: [explanation("strain_above_personal_p90", input.strain, input.strainP90)] };
  if (input.loadRatio < 0.7 || input.daysSinceLastRun >= 7)
    return { status: "recovery", explanations: [explanation(input.daysSinceLastRun >= 7 ? "seven_days_without_run" : "load_ratio_recovery", input.daysSinceLastRun >= 7 ? input.daysSinceLastRun : input.loadRatio, input.daysSinceLastRun >= 7 ? 7 : 0.7)] };
  if (input.loadRatio >= 0.9 && input.loadRatio <= 1.3 && input.physState !== "depleted" && input.rampRate >= 0)
    return { status: "effective_stimulus", explanations: [explanation("effective_load_range", input.loadRatio, 0.9)] };
  return { status: "maintaining", explanations: [explanation("load_maintaining", input.loadRatio, null)] };
}

/**
 * §9.4 `RecoveryDebt` 的正确命名。
 *
 * `max(0, ATL − CTL)` 是可以算的，但它的**单位仍是日 EWMA 负荷**，而且只是 ATL/CTL 的派生量：
 * 它不是睡眠债、不是真实生理恢复债、也不是新的独立证据。内部一律叫 `acuteLoadExcess`，
 * UI 文案写"短期负荷高于长期负荷"；若某处仍沿用 `RecoveryDebt`，必须同时注明这是**负荷代理**。
 */
export function acuteLoadExcess(acuteEwma: number | null, chronicEwma: number | null): number | null {
  if (!finite(acuteEwma) || !finite(chronicEwma)) return null;
  return Math.max(0, acuteEwma - chronicEwma);
}

/** §9.5：把**数值指标**与**行动分类**分开。 */
export type LoadRisk = "unknown" | "nominal" | "high";

/**
 * 某次 `LoadAssessment` 的**唯一**依据。
 *
 * §9.4 明确"不得与 ATL、ACWR 三次分别投票提高风险"，所以这里是**单值**而不是一组布尔 ——
 * 想投三票在类型上就做不到。映射关系见 `LOAD_RISK_BASIS`。
 */
export type LoadRiskBasis =
  | "insufficient_history"
  | "acwr"
  | "ramp_rate"
  | "phys_state"
  | "strain_vs_p90"
  | "load_recovery"
  | "effective_range"
  | "maintaining";

/**
 * `classifyTrainingStatus` 可能返回的每个 explanation code 到依据的映射。
 * 有测试断言这张表**覆盖全部 code** —— 将来新增一条分支却忘记登记，测试先红，
 * 而不是悄悄落到 `maintaining`（那会把"没识别"说得像"正常"）。
 */
export const LOAD_RISK_BASIS: Record<string, LoadRiskBasis> = {
  insufficient_training_history: "insufficient_history",
  load_ratio_attention: "acwr",
  load_ratio_high: "acwr",
  ramp_rate_attention: "ramp_rate",
  depleted_phys_with_load: "phys_state",
  strain_above_personal_p90: "strain_vs_p90",
  seven_days_without_run: "load_recovery",
  load_ratio_recovery: "load_recovery",
  effective_load_range: "effective_range",
  load_maintaining: "maintaining"
};

export interface LoadAssessmentInput {
  historyDays: number;
  workoutCount: number;
  acuteEwma: number | null;
  chronicEwma: number;
  loadRatio: number | null;
  rampRate: number;
  physState?: PhysState | undefined;
  strain: number | null;
  strainP90: number | null;
  daysSinceLastRun: number;
}

export interface LoadAssessment {
  risk: LoadRisk;
  basis: LoadRiskBasis;
  /** 数值指标 —— 供展示与解释，**不参与投票**。 */
  indicators: {
    acuteEwma: number | null;
    chronicEwma: number;
    acwr: number | null;
    acuteLoadExcess: number | null;
    rampRate: number;
    strain: number | null;
    strainP90: number | null;
  };
  explanations: TrainingStatusExplanation[];
}

/**
 * §9.5：把数值指标与行动分类分开的**唯一**入口。
 *
 * 🔴 本版**不重新分类**：`risk` 与 `basis` 都是对 `classifyTrainingStatus` 现有判定的 1:1 映射，
 * 阈值一个没动、一条分支没加。§9.5 第 5 条要求"所有决策阈值先从现有规则兼容迁移，
 * 再在离线报告中比较变更影响" —— 把"孤立的 ACWR 升高是否该只判 `elevated` 而非 `high`"
 * 这类政策留给一次带测量的变更，不塞进本次迁移。
 */
export function assessLoad(
  input: LoadAssessmentInput,
  config = defaultDailyMetricConfig
): LoadAssessment {
  const classified = classifyTrainingStatus(
    {
      historyDays: input.historyDays,
      workoutCount: input.workoutCount,
      chronicEwma: input.chronicEwma,
      loadRatio: input.loadRatio,
      rampRate: input.rampRate,
      recoveryEvidence: null,
      physState: input.physState,
      strain: input.strain,
      strainP90: input.strainP90,
      daysSinceLastRun: input.daysSinceLastRun
    },
    config
  );
  const code = classified.explanations[0]?.code ?? "load_maintaining";
  const risk: LoadRisk =
    classified.status === "insufficient_data"
      ? "unknown"
      : classified.status === "attention" || classified.status === "high_load"
        ? "high"
        : "nominal";
  return {
    risk,
    basis: LOAD_RISK_BASIS[code] ?? "maintaining",
    indicators: {
      acuteEwma: finite(input.acuteEwma) ? input.acuteEwma : null,
      chronicEwma: input.chronicEwma,
      acwr: input.loadRatio,
      acuteLoadExcess: acuteLoadExcess(input.acuteEwma, input.chronicEwma),
      rampRate: input.rampRate,
      strain: input.strain,
      strainP90: input.strainP90
    },
    explanations: classified.explanations
  };
}

/**
 * The load model's own engine version. It belongs to this package: the domain
 * snapshots used to spell `"rai-training-load-v2.0.0"` as a literal in
 * `@rai/application`, so bumping this package could leave the snapshot lineage
 * pointing at an old version with no test failing.
 */
export const TRAINING_LOAD_MODEL_VERSION = "rai-training-load-v2.0.0" as const;

/**
 * §9.2 `LoadVectorV2`：现有 `TrainingLoadBreakdown` 的**扩展**，不是替代品。
 *
 * 三条硬约束（都写成断言）：
 * - `compositeLoad` **原样透传**，不重算 ⇒ "只增向量"阶段保持 golden parity（§9.6）；
 * - **没有第二个 totalLoad**：距离、心率负荷、配速负荷不得再被任意加权成一个新总数；
 * - 机械负荷在**没有经过验证的映射**时一律 `null`，只展示距离/爬升原始暴露。
 */
export const LOAD_VECTOR_V2_VERSION = "rai-load-vector-v2" as const;

export interface LoadVectorV2 {
  rawHrrTrimp: number | null;
  internalLoad: number | null;
  paceLoad: number | null;
  compositeLoad: number;
  /** 时间量，不是"另一种 TRIMP"。 */
  activeDurationMinutes: number;
  distanceMeters: number | null;
  elevationGainMeters: number | null;
  highIntensityMinutes: number | null;
  mechanicalLoad: number | null;
  mechanicalModelVersion: string | null;
  /** §9.2「`highIntensityMinutes` 要注明分区体系」：null 表示该值不可用。 */
  highIntensityZoneSystem: string | null;
  /** §9.2「可用覆盖」：说明为什么某个分量是 null。 */
  reasonCodes: string[];
  source: string;
  confidence: number;
}

/**
 * 高档分钟数要求的心率覆盖下限。低于它**宁可为 `null`**，也不把部分覆盖外推成整段
 * （§9.6：partial HR coverage 不能复制整段时长使负荷翻倍）。
 */
export const HIGH_INTENSITY_MINIMUM_HEART_RATE_COVERAGE = 0.5;

/** 供 §9.2 的 `mechanicalModelVersion` 使用：目前没有经过验证的机械负荷映射。 */
export const MECHANICAL_LOAD_MODEL_VERSION: string | null = null;

export function buildLoadVectorV2(input: {
  load: WorkoutTrainingLoad;
  zoneSummary?: Pick<WorkoutZoneSummary, "zoneProfileId" | "heartRateCoverage" | "heartRateExposure"> | null;
}): LoadVectorV2 {
  const { load } = input;
  const breakdown = load.breakdown;
  const zoneSummary = input.zoneSummary ?? null;
  const reasonCodes: string[] = ["mechanical_load_not_modeled"];

  let highIntensityMinutes: number | null = null;
  let highIntensityZoneSystem: string | null = null;
  if (zoneSummary === null) {
    reasonCodes.push("zone_summary_absent");
  } else if (!finite(zoneSummary.heartRateCoverage) || zoneSummary.heartRateCoverage < HIGH_INTENSITY_MINIMUM_HEART_RATE_COVERAGE) {
    reasonCodes.push("heart_rate_coverage_below_threshold");
  } else {
    const seconds = zoneSummary.heartRateExposure
      .filter((item) => (highIntensityHeartRateZones as readonly string[]).includes(item.zone))
      .reduce((sum, item) => sum + item.durationSeconds, 0);
    highIntensityMinutes = seconds / 60;
    highIntensityZoneSystem = zoneSummary.zoneProfileId;
  }

  return {
    rawHrrTrimp: breakdown.rawHrrTrimp,
    internalLoad: breakdown.internalLoad,
    paceLoad: breakdown.paceLoad,
    // Passed through untouched: the vector adds exposure, it does not re-derive the load.
    compositeLoad: load.load,
    activeDurationMinutes: load.durationSeconds / 60,
    distanceMeters: load.distanceMeters,
    elevationGainMeters: load.elevationGainMeters,
    highIntensityMinutes,
    mechanicalLoad: null,
    mechanicalModelVersion: MECHANICAL_LOAD_MODEL_VERSION,
    highIntensityZoneSystem,
    reasonCodes,
    source: load.source,
    confidence: load.confidence
  };
}

export function buildDailyTrainingMetrics(loads: readonly WorkoutTrainingLoad[], throughDate: string, physEvidence: readonly DailyPhysEvidence[] = [], config = defaultDailyMetricConfig): DailyTrainingMetric[] {
  if (loads.length === 0) return [];
  const sorted = [...loads].sort((a, b) => a.localDate.localeCompare(b.localDate));
  const start = sorted[0]!.localDate; if (throughDate < start) return [];
  const days = Array.from({ length: dateDiff(start, throughDate) + 1 }, (_, index) => addDays(start, index));
  const byDate = new Map<string, WorkoutTrainingLoad[]>();
  for (const load of sorted) byDate.set(load.localDate, [...(byDate.get(load.localDate) ?? []), load]);
  const dailyLoads: number[] = []; const results: DailyTrainingMetric[] = [];
  // 🔴 生理证据按日期索引，且**保留首次出现**（与原 `physEvidence.find(...)` 的语义一致）。
  // 原来每天一次线性 `find` ⇒ O(天数 × 证据条数)。
  const physStateByDate = new Map<string, PhysState>();
  for (const item of physEvidence) {
    if (!physStateByDate.has(item.localDate)) physStateByDate.set(item.localDate, item.physState);
  }
  const acuteAlpha = 1 - Math.exp(-Math.LN2 / config.acuteHalfLifeDays); const chronicAlpha = 1 - Math.exp(-Math.LN2 / config.chronicHalfLifeDays);
  // The series starts on the first observed workout day. Seed both EWMAs from
  // that observation so the absent pre-history is not interpreted as zero load.
  let acute: number | null = null, chronic: number | null = null, workouts = 0, lastRunIndex = -1;
  for (let index = 0; index < days.length; index++) {
    const localDate = days[index]!; const items = byDate.get(localDate) ?? [];
    const load = items.reduce((sum, item) => sum + item.load, 0); dailyLoads.push(load);
    acute = acute === null ? load : acuteAlpha * load + (1 - acuteAlpha) * acute;
    chronic = chronic === null ? load : chronicAlpha * load + (1 - chronicAlpha) * chronic;
    workouts += items.length; if (items.length > 0) lastRunIndex = index;
    const current7dLoad = sumRange(dailyLoads, index, 7); const previous7dLoad = dailyLoads.slice(Math.max(0, index - 13), Math.max(0, index - 6)).reduce((a, b) => a + b, 0);
    const floor = Math.max(10, chronic * 7 * 0.25); const rampRate = (current7dLoad - previous7dLoad) / Math.max(previous7dLoad, floor);
    const seven = dailyLoads.slice(Math.max(0, index - 6), index + 1); const mean = seven.reduce((a, b) => a + b, 0) / seven.length;
    const variance = seven.reduce((sum, value) => sum + (value - mean) ** 2, 0) / seven.length;
    const monotony = mean > 0 ? Math.min(5, variance === 0 ? 5 : mean / Math.sqrt(variance)) : null; const strain = monotony === null ? null : current7dLoad * monotony;
    const physState = physStateByDate.get(localDate);
    // Recovery evidence is intentionally retired. Training status consumes the
    // factual daily physiological state; the legacy column remains nullable for
    // schema/API compatibility only.
    const recoveryEvidence = null;
    const loadRatio = index + 1 >= config.minimumHistoryDays && workouts >= config.minimumWorkoutCount && chronic >= config.minimumChronicLoad ? acute / chronic : null;
    // 🔴 56 天回看用**下标窗口**，不再逐行 `dateDiff` 过滤（那是 O(天数²)，10 年 ≈ 7 秒）。
    // 等价性：`days` 由 `addDays` 逐日生成、`results[j].localDate === days[j]` ⇒
    // `dateDiff(days[j], days[index]) === index - j`，所以"差 ≤56 天"就是 `j ≥ index-56`。
    const historicalStrains = results.slice(Math.max(0, index - 56), index).map(item => item.strain).filter(finite);
    const classified = classifyTrainingStatus({ historyDays: index + 1, workoutCount: workouts, chronicEwma: chronic, loadRatio, rampRate, recoveryEvidence, physState, strain, strainP90: index >= 55 ? percentile(historicalStrains, 0.9) : null, daysSinceLastRun: lastRunIndex < 0 ? index + 1 : index - lastRunIndex }, config);
    const duration = items.reduce((sum, item) => sum + item.durationSeconds, 0);
    results.push({ localDate, distanceMeters: items.reduce((sum, item) => sum + (item.distanceMeters ?? 0), 0), durationSeconds: duration, workoutCount: items.length,
      load: round(load), current7dLoad: round(current7dLoad), previous7dLoad: round(previous7dLoad), acuteEwma: round(acute), chronicEwma: round(chronic), loadRatio: loadRatio === null ? null : round(loadRatio), rampRate: round(rampRate), monotony: monotony === null ? null : round(monotony), strain: strain === null ? null : round(strain), recoveryEvidence: recoveryEvidence === null ? null : round(recoveryEvidence), trainingStatus: classified.status, statusExplanations: classified.explanations,
      loadConfidence: items.length ? round(items.reduce((sum, item) => sum + item.confidence * item.load, 0) / Math.max(load, Number.EPSILON)) : null });
  }
  return results;
}

export function latestAcuteChronicLoadRatio(
  loads: WorkoutTrainingLoad[],
  throughDate: string,
  config = defaultDailyMetricConfig
): number | null {
  if (loads.length === 0) return null;
  const sorted = [...loads].sort((a, b) => a.localDate.localeCompare(b.localDate));
  const start = sorted[0]!.localDate;
  if (throughDate < start) return null;

  const byDate = new Map<string, { load: number; workouts: number }>();
  for (const item of sorted) {
    if (item.localDate > throughDate) continue;
    const current = byDate.get(item.localDate) ?? { load: 0, workouts: 0 };
    current.load += item.load;
    current.workouts += 1;
    byDate.set(item.localDate, current);
  }

  const acuteAlpha = 1 - Math.exp(-Math.LN2 / config.acuteHalfLifeDays);
  const chronicAlpha = 1 - Math.exp(-Math.LN2 / config.chronicHalfLifeDays);
  let acute: number | null = null;
  let chronic: number | null = null;
  let workouts = 0;
  const dayCount = dateDiff(start, throughDate) + 1;
  for (let index = 0; index < dayCount; index += 1) {
    const daily = byDate.get(addDays(start, index)) ?? { load: 0, workouts: 0 };
    acute = acute === null ? daily.load : acuteAlpha * daily.load + (1 - acuteAlpha) * acute;
    chronic = chronic === null ? daily.load : chronicAlpha * daily.load + (1 - chronicAlpha) * chronic;
    workouts += daily.workouts;
  }
  if (
    acute === null || chronic === null || dayCount < config.minimumHistoryDays ||
    workouts < config.minimumWorkoutCount || chronic < config.minimumChronicLoad
  ) return null;
  return round(acute / chronic);
}

export function localDateInTimeZone(instant: string | Date, timeZone: string = DATABASE_TIMEZONE): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (!Number.isFinite(date.getTime())) throw new Error("instant must be a valid date");
  const parts = localCalendarFormatter(timeZone, "day").formatToParts(date);
  const get = (type: string): string => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function periodBounds(localDate: string, granularity: TrainingStatisticsGranularity): { start: string; end: string } {
  const date = parseDate(localDate);
  if (granularity === "week") { const weekday = date.getUTCDay(); const start = addDays(localDate, -(weekday === 0 ? 6 : weekday - 1)); return { start, end: addDays(start, 6) }; }
  if (granularity === "month") { const start = `${localDate.slice(0, 7)}-01`; const next = parseDate(start); next.setUTCMonth(next.getUTCMonth() + 1); return { start, end: addDays(isoDate(next), -1) }; }
  return { start: `${localDate.slice(0, 4)}-01-01`, end: `${localDate.slice(0, 4)}-12-31` };
}

const change = (current: number, previous: number): number | null => previous === 0 ? null : round((current - previous) / previous);
export function aggregateTrainingPeriod(loads: WorkoutTrainingLoad[], start: string, end: string, granularity: TrainingStatisticsGranularity | "rolling", asOfDate = end, comparisonLoads?: WorkoutTrainingLoad[]): TrainingPeriodSummary {
  const selected = loads.filter(item => item.localDate >= start && item.localDate <= end); const totalDistance = selected.reduce((sum, item) => sum + (item.distanceMeters ?? 0), 0);
  const totalDuration = selected.reduce((sum, item) => sum + item.durationSeconds, 0); const totalLoad = selected.reduce((sum, item) => sum + item.load, 0);
  const heartRateDuration = selected.filter(item => item.averageHeartRate !== null).reduce((sum, item) => sum + item.durationSeconds, 0);
  const summary = { distance: totalDistance, duration: totalDuration, count: selected.length, load: totalLoad };
  const previous = comparisonLoads ? { distance: comparisonLoads.reduce((s, x) => s + (x.distanceMeters ?? 0), 0), duration: comparisonLoads.reduce((s, x) => s + x.durationSeconds, 0), count: comparisonLoads.length, load: comparisonLoads.reduce((s, x) => s + x.load, 0) } : null;
  const types = [...new Set(selected.map(item => item.sessionType))].sort();
  const stimuli = [...new Set(selected.map(item => item.stimulusType))].sort();
  return { granularity, periodStart: start, periodEnd: end, isComplete: asOfDate >= end, distanceMeters: round(totalDistance), durationSeconds: round(totalDuration), workoutCount: selected.length, totalLoad: round(totalLoad),
    elevationGainMeters: round(selected.reduce((sum, item) => sum + (item.elevationGainMeters ?? 0), 0)), longestRunMeters: round(Math.max(0, ...selected.map(item => item.distanceMeters ?? 0))),
    averagePaceSecondsPerKm: totalDistance > 0 ? round(totalDuration / (totalDistance / 1000)) : null,
    averageHeartRate: heartRateDuration > 0 ? round(selected.reduce((sum, item) => sum + (item.averageHeartRate ?? 0) * item.durationSeconds, 0) / heartRateDuration) : null,
    dataCompleteness: selected.length ? round(selected.filter(item => item.distanceMeters !== null && item.durationSeconds > 0).length / selected.length) : 0,
    loadConfidence: totalLoad > 0 ? round(selected.reduce((sum, item) => sum + item.confidence * item.load, 0) / totalLoad) : null,
    typeDistribution: types.map(sessionType => { const group = selected.filter(item => item.sessionType === sessionType); return { sessionType, workoutCount: group.length, distanceMeters: round(group.reduce((s, x) => s + (x.distanceMeters ?? 0), 0)), load: round(group.reduce((s, x) => s + x.load, 0)) }; }),
    stimulusDistribution: stimuli.map(stimulusType => { const group = selected.filter(item => item.stimulusType === stimulusType); return { stimulusType, workoutCount: group.length, distanceMeters: round(group.reduce((s, x) => s + (x.distanceMeters ?? 0), 0)), load: round(group.reduce((s, x) => s + x.load, 0)) }; }),
    comparison: previous ? { distanceChangeFraction: change(summary.distance, previous.distance), durationChangeFraction: change(summary.duration, previous.duration), workoutCountChangeFraction: change(summary.count, previous.count), loadChangeFraction: change(summary.load, previous.load) } : null };
}

export function buildCalendarPeriodSummary(
  loads: WorkoutTrainingLoad[],
  asOfDate: string,
  granularity: TrainingStatisticsGranularity
): TrainingPeriodSummary {
  const current = periodBounds(asOfDate, granularity);
  const elapsedDays = dateDiff(current.start, asOfDate);
  const previousAnchor = addDays(current.start, -1);
  const previous = periodBounds(previousAnchor, granularity);
  const previousComparisonEnd = addDays(previous.start, Math.min(elapsedDays, dateDiff(previous.start, previous.end)));
  const previousLoads = loads.filter(item => item.localDate >= previous.start && item.localDate <= previousComparisonEnd);
  return aggregateTrainingPeriod(loads, current.start, current.end, granularity, asOfDate, previousLoads);
}

export function buildRollingPeriodSummary(loads: WorkoutTrainingLoad[], asOfDate: string, days: number): TrainingPeriodSummary {
  if (!Number.isInteger(days) || days <= 0) throw new Error("days must be a positive integer");
  const start = addDays(asOfDate, -(days - 1));
  const previousEnd = addDays(start, -1);
  const previousStart = addDays(previousEnd, -(days - 1));
  return aggregateTrainingPeriod(
    loads,
    start,
    asOfDate,
    "rolling",
    asOfDate,
    loads.filter(item => item.localDate >= previousStart && item.localDate <= previousEnd)
  );
}

/** V2: ACWR is context, never an independent high-risk vote. */
export function assessLoadV2(input: LoadAssessmentInput): LoadAssessment {
  const observed = assessLoad(input);
  if (observed.risk === "unknown") return observed;
  const independent = assessLoad({ ...input, loadRatio: 1 });
  return {
    ...independent, indicators: observed.indicators,
    explanations: [...independent.explanations,
      ...(input.loadRatio !== null && input.loadRatio > 1.3
        ? [{ code: "acwr_reference_only", value: input.loadRatio, threshold: 1.3 }] : [])]
  };
}

export function buildDailyTrainingMetricsV2(loads: readonly WorkoutTrainingLoad[], throughDate: string,
  physEvidence: readonly DailyPhysEvidence[] = [], config = defaultDailyMetricConfig): DailyTrainingMetric[] {
  const days = buildDailyTrainingMetrics(loads, throughDate, physEvidence, config);
  // 与基础实现同一条纪律：生理证据按日期索引（首次出现为准），不要在每日回调里线性 find。
  const physStateByDate = new Map<string, PhysState>();
  for (const item of physEvidence) {
    if (!physStateByDate.has(item.localDate)) physStateByDate.set(item.localDate, item.physState);
  }
  let workouts = 0, lastRun = -1;
  return days.map((day,index)=>{
    workouts += day.workoutCount;
    if (day.workoutCount > 0) lastRun = index;
    const strainValues=days.slice(Math.max(0,index-56),index).flatMap((row)=>row.strain===null?[]:[row.strain]);
    const assessment=assessLoadV2({historyDays:index+1,workoutCount:workouts,acuteEwma:day.acuteEwma,
      chronicEwma:day.chronicEwma,loadRatio:day.loadRatio,rampRate:day.rampRate,strain:day.strain,
      strainP90:index>=55?percentile(strainValues,0.9):null,
      daysSinceLastRun:lastRun<0?index+1:index-lastRun,physState:physStateByDate.get(day.localDate)});
    return {...day,trainingStatus:assessment.risk==="unknown"?"insufficient_data":assessment.risk==="high"?"attention":
      day.trainingStatus==="attention"||day.trainingStatus==="high_load"?"maintaining":day.trainingStatus,
      statusExplanations:assessment.explanations};
  });
}

// §9.6 状态曲线与恢复时间：读时派生，不写回持久化日指标。
export {
  TRAINING_FORM_POLICY_VERSION,
  RECOVERY_TIME_POLICY_VERSION,
  RECOVERY_BASE_HOURS,
  defaultRecoveryTimeConfig,
  defaultTrainingFormConfig,
  classifyTrainingForm,
  estimateRecoveryTime,
  withTrainingForm,
  type RecentLoadInput,
  type RecoveryTimeConfig,
  type RecoveryTimeInput,
  type TrainingFormConfig
} from "./form.js";
