// 版本常量是**值**，不能与上面那组类型一起走 `import type`（否则它只是个类型名字，
// 编译期就在 `projectCoachDecisionV2` 里报 "cannot be used as a value"）。
import { COACH_MODEL_VERSION } from "@rai/api-contracts";
import type { CoachAction, CoachDecisionV2 } from "@rai/api-contracts";

import type {
  MobileAbilityCard,
  MobileCalibrationCard,
  MobileDayPhase,
  MobileInjuryFlag,
  MobileIntervalBlock,
  MobileLockedSession,
  MobileLockState,
  MobileNextSession,
  MobilePostRunVerdict,
  MobilePlannedDay,
  MobileRaceCard,
  MobileRaceTarget,
  MobileRecommendation,
  MobileRecoveryBreakdown,
  MobileSessionKind,
  MobileSessionStructure,
  MobileStepAlert,
  MobileStepGoal,
  MobileStimulusMatch,
  MobileTrigger,
  MobileVerdict,
  MobileWeekPlanDay,
  MobileWeekStructure,
  MobileWorkoutStep
} from "@rai/api-contracts";
import type { TrainingStatusCode } from "@rai/contracts";
import {
  READINESS_HRV_RATIO_THRESHOLD,
  READINESS_RHR_RATIO_THRESHOLD,
  READINESS_SLEEP_RATIO_THRESHOLD,
  READINESS_SLEEP_STREAK_THRESHOLD,
  assessReadiness
} from "@rai/readiness";

import { DISTANCE_ROUNDING_KM, MAX_PLANNED_DISTANCE_KM } from "./session-structure.js";

export const DEFAULT_EASY_DURATION_FLOOR = 0.7;
export const DEFAULT_QUALITY_SESSION_CAP = 2;

const QUALITY_SESSION_TYPES = new Set(["tempo", "interval", "race"]);
const QUALITY_STIMULI = new Set(["lactate_threshold", "vo2max", "anaerobic_endurance"]);
const EASY_SESSION_TYPES = new Set(["easy", "recovery"]);
const EASY_HR_ZONES = new Set(["recovery", "aerobic_base"]);

export const isQualitySession = (sessionType: string, _stimulusType?: string): boolean =>
  QUALITY_SESSION_TYPES.has(sessionType);

export const isEasySession = (sessionType: string): boolean => EASY_SESSION_TYPES.has(sessionType);

export interface CoachZonePrescription {
  easyPaceLower: number | null;
  easyPaceUpper: number | null;
  easyHrLower: number | null;
  easyHrUpper: number | null;
  thresholdPaceLower: number | null;
  thresholdPaceUpper: number | null;
  thresholdHrLower: number | null;
  thresholdHrUpper: number | null;
  intervalPaceLower: number | null;
  intervalPaceUpper: number | null;
}

export interface CoachLatestWorkout {
  id: string;
  startedAt: string;
  localDate: string;
  sessionType: string;
  stimulusType: string;
  indoor: boolean | null;
  currentAbility: number | null;
  trueAbilityAfter: number | null;
  trueAbilityDelta: number | null;
  updatedTrueAbility: boolean;
  explanationCodes: string[];
  missingReasons: string[];
  heartRateCoverage: number | null;
  easyHeartRateFraction: number | null;
  thresholdHeartRateFraction: number | null;
}

export interface CoachInput {
  today: string;
  latestDataDate: string | null;
  recoveryEvidenceStatus: "unknown" | "partial" | "valid" | "stale";
  recoveryEvidenceDate: string | null;
  calibration: MobileCalibrationCard["status"];
  eligibleSessions: number;
  trueAbility: number | null;
  currentAbility: number | null;
  changeFrom7DaysAgo: number | null;
  growthVelocityPerWeek: number | null;
  decayPoints: number;
  snapshotDate: string | null;
  explanationCodes: string[];
  trainingStatus: TrainingStatusCode | null;
  loadRatio: number | null;
  rampRate: number | null;
  strain: number | null;
  strainP90: number | null;
  monotony: number | null;
  recoveryEvidence: number | null;
  lastNightSleepMinutes: number | null;
  sleepBaselineMinutes: number | null;
  nightsBelowSleepBaseline: number;
  morningHrvMs: number | null;
  hrvBaselineMs: number | null;
  restingHeartRateBpm: number | null;
  restingHeartRateBaselineBpm: number | null;
  consecutiveQualityDays: number;
  daysSinceLastRun: number | null;
  daysSinceLastQuality: number | null;
  weekDistanceKm: number;
  weekDurationSeconds: number;
  weekEasyDurationSeconds: number;
  weekQualityCount: number;
  /** Weekly volume ceiling today's session must fit inside, km. Derived, never stored. */
  weeklyVolumeCeilingKm: number;
  easyDurationFloorFraction: number;
  qualitySessionCap: number;
  fourWeekDistanceChangeFraction: number | null;
  previousWeekDistanceKm: number;
  currentWeekDistanceKm: number;
  longestRun8WeekKm: number;
  latestLongRunKm: number | null;
  intendedEasyCount: number;
  easyEnoughCount: number;
  latestWorkout: CoachLatestWorkout | null;
  zones: CoachZonePrescription | null;
  raceTarget: MobileRaceTarget | null;
  raceShapeScore: number | null;
  raceVolumeFraction: number | null;
  raceLongRunFraction: number | null;
  weekDaily: Array<{ localDate: string; distanceKm: number; workoutCount: number; workoutId: string | null }>;
  todayWorkoutCount: number;
  storedWeekPlan: MobilePlannedDay[];
  lockedSession: MobileLockedSession | null;
}

/** Rounds to the 100 m the app displays, so a stored value cannot out-precise a measured one. */
export const roundKm = (value: number): number => Math.round(value * 10) / 10;

export function abilityExplanation(input: CoachInput): string {
  if (input.calibration !== "completed") {
    return "校准中：有效训练还不够，先看趋势，不要把当前数字当成精确能力。";
  }
  if (input.decayPoints > 0) {
    return `停跑衰减中（${roundKm(input.decayPoints)} 点），与训练表现导致的变化分开看。`;
  }
  if (input.currentAbility != null && input.trueAbility != null) {
    const delta = input.currentAbility - input.trueAbility;
    if (Math.abs(delta) < 1.5) return "这次发挥接近真实能力。";
    if (delta > 0) return "这次发挥高于真实能力，更像短期状态波动，不是能力已经跳升。";
    return "这次发挥低于真实能力，更像疲劳、睡眠或环境，而不是能力退步。";
  }
  if (input.changeFrom7DaysAgo != null && Math.abs(input.changeFrom7DaysAgo) >= 0.3) {
    return input.changeFrom7DaysAgo > 0
      ? `近 7 日真实能力 +${roundKm(input.changeFrom7DaysAgo)}。`
      : `近 7 日真实能力 ${roundKm(input.changeFrom7DaysAgo)}。`;
  }
  return "继续积累有效训练，真实能力变化会比单次发挥慢。";
}

export function buildAbilityCard(input: CoachInput): MobileAbilityCard {
  return {
    trueAbility: input.trueAbility,
    currentAbility: input.currentAbility,
    changeFrom7DaysAgo: input.changeFrom7DaysAgo,
    growthVelocityPerWeek: input.growthVelocityPerWeek,
    decayPoints: input.decayPoints,
    snapshotDate: input.snapshotDate,
    explanation: abilityExplanation(input)
  };
}

export function calibrationMessage(
  status: MobileCalibrationCard["status"],
  eligibleSessions: number,
  requiredSessions: number
): string {
  if (status === "completed") return "校准完成，真实能力可以当作主参考。";
  if (status === "not_started") return "还没有足够的有效跑步，先同步健康并完成几次带心率的户外跑。";
  return `校准中：已有 ${eligibleSessions} 次有效训练，大约还需要 ${Math.max(0, requiredSessions - eligibleSessions)} 次。`;
}

const trigger = (
  code: string,
  value: number | null,
  threshold: number | null,
  detail: string
): MobileTrigger => ({ code, value, threshold, detail });

/**
 * Aliases of the readiness domain rules, kept so existing importers keep
 * working. They are aliases on purpose: a second literal here would be exactly
 * the duplicated threshold the recovery-isolation design removes.
 */
export const RECOVERY_SLEEP_RATIO_THRESHOLD = READINESS_SLEEP_RATIO_THRESHOLD;
export const RECOVERY_HRV_RATIO_THRESHOLD = READINESS_HRV_RATIO_THRESHOLD;
export const RECOVERY_RHR_RATIO_THRESHOLD = READINESS_RHR_RATIO_THRESHOLD;
export const RECOVERY_SLEEP_STREAK_THRESHOLD = READINESS_SLEEP_STREAK_THRESHOLD;

/**
 * What today's recovery evidence supports.
 *
 * Coverage answers "could today be assessed at all" and `assessment` answers
 * "what does it say". They are separate on purpose: a gap in coverage is not a
 * negative assessment, and complete coverage is not a positive one. Every
 * consumer reads this one function — the verdict gates below and the
 * `recoveryAssessment` field the device renders — so what the app explains can
 * never disagree with what the coach actually did.
 */
export interface RecoveryAssessment {
  /** `none` means nothing was assessable today, not that today looks bad. */
  coverage: "none" | "partial" | "complete";
  assessment: "not_assessed" | "no_low_signal" | "low_signal" | "multiple_low_signals";
  reasonCodes: string[];
  sleepRatio: number | null;
  hrvRatio: number | null;
  sleepLow: boolean;
  hrvLow: boolean;
  restingHeartRateUp: boolean;
  sleepStreak: boolean;
}

/**
 * API-compatible wrapper over the readiness domain rules.
 *
 * Deliberately thin: the thresholds, the freshness rule and the assessment logic
 * live in `@rai/readiness`, and this function must not grow a second copy of any
 * of them. `RecoveryAssessment` keeps its shape so the mobile payload is
 * unchanged, and every consumer still reads exactly one assessment.
 *
 * `asOf`/`localDate` are only carried through for the snapshot shape; the
 * mobile payload does not expose them, so the coach's local date is enough here.
 */
export function assessRecovery(input: CoachInput): RecoveryAssessment {
  const readiness = assessReadiness({
    asOf: input.today,
    localDate: input.today,
    evidenceLocalDate: input.recoveryEvidenceDate,
    evidenceStatus: input.recoveryEvidenceStatus,
    sleepMinutes: input.lastNightSleepMinutes,
    sleepBaselineMinutes: input.sleepBaselineMinutes,
    nightsBelowSleepBaseline: input.nightsBelowSleepBaseline,
    hrvMs: input.morningHrvMs,
    hrvBaselineMs: input.hrvBaselineMs,
    restingHeartRateBpm: input.restingHeartRateBpm,
    restingHeartRateBaselineBpm: input.restingHeartRateBaselineBpm,
    observedAt: null,
    availableAt: null
  });
  return {
    coverage: readiness.coverage,
    assessment: readiness.assessment,
    reasonCodes: readiness.reasonCodes,
    sleepRatio: readiness.signals.sleep.ratio,
    hrvRatio: readiness.signals.hrv.ratio,
    sleepLow: readiness.signals.sleep.low,
    hrvLow: readiness.signals.hrv.low,
    restingHeartRateUp: readiness.signals.rhr.low,
    sleepStreak: readiness.sleepStreak
  };
}

export function decideVerdict(input: CoachInput, assessed?: RecoveryAssessment): MobileVerdict {
  const triggers: MobileTrigger[] = [];
  // Recovery may only modify TODAY's arrangement when its evidence belongs to
  // today. A recent run or import cannot make historical (or undated) recovery
  // evidence current, and a missing night is a coverage gap — never negative
  // evidence against the athlete.
  //
  // Read off `assessRecovery` rather than recomputed here: the same assessment
  // is published as `recoveryAssessment`, and two copies of "what did recovery
  // say" is exactly how the app ends up explaining a decision the coach did not
  // make. The caller may hand in an assessment it already holds.
  const recovery = assessed ?? assessRecovery(input);
  const currentRecovery = recovery.coverage !== "none";
  const stale = !currentRecovery;
  const recoveryComplete = recovery.coverage === "complete";
  // Narrowed once: the branch conditions are boolean, but the trigger values
  // need the ratio itself.
  const sleepLowRatio = recovery.sleepLow ? recovery.sleepRatio : null;
  const hrvLowRatio = recovery.hrvLow ? recovery.hrvRatio : null;
  let tone: MobileVerdict["tone"] = "yellow";
  let title = "只宜有氧";
  let reason = "默认轻松跑。数据不足时不安排质量课。";

  const taper = isTaper(input);
  // §9.5: the load verdict comes from the single classification, not from a second ACWR test.
  // The removed `loadRatio > 1.3` clause could not change the outcome for any row produced by
  // `buildDailyTrainingMetrics`: a ratio above 1.3 makes `classifyTrainingStatus` return
  // `high_load` before any nominal branch, and the gate-closed case is `insufficient_data`,
  // which is handled by the branch above. So this is a deduplication, not a behaviour change —
  // pinned by the sweep test in `@rai/training-load`.
  const highLoad = input.trainingStatus === "attention" || input.trainingStatus === "high_load";
  const easyDurationFraction =
    input.weekDurationSeconds > 0 ? input.weekEasyDurationSeconds / input.weekDurationSeconds : null;

  if (input.calibration !== "completed" || input.trainingStatus === "insufficient_data") {
    tone = "yellow";
    title = "只宜有氧";
    reason = "有效训练或负荷历史还不够，今天按轻松跑处理。";
    triggers.push(trigger("insufficient_data", input.eligibleSessions, 8, reason));
  } else if (highLoad) {
    tone = "red";
    title = "宜休息或轻松";
    reason = "负荷偏高，今天不要排质量课。";
    if (input.trainingStatus === "attention" || input.trainingStatus === "high_load") {
      triggers.push(trigger("training_status", null, null, "近期负荷需要关注恢复"));
    }
    if (input.loadRatio != null && input.loadRatio > 1.3) {
      triggers.push(trigger("load_ratio", roundKm(input.loadRatio), 1.3, `急性/慢性负荷比 ${roundKm(input.loadRatio)}`));
    }
  } else if (currentRecovery && recovery.sleepStreak) {
    tone = "red";
    title = "宜休息";
    reason = "连续三夜睡眠低于基线，今天休息。";
    triggers.push(trigger("sleep_streak", input.nightsBelowSleepBaseline, RECOVERY_SLEEP_STREAK_THRESHOLD, reason));
  } else if (currentRecovery && sleepLowRatio != null && hrvLowRatio != null && recovery.restingHeartRateUp) {
    tone = "red";
    title = "宜休息或轻松";
    reason = "睡眠、HRV 和静息心率同时变差。";
    triggers.push(trigger("sleep", roundKm(sleepLowRatio), RECOVERY_SLEEP_RATIO_THRESHOLD, `睡眠为基线的 ${Math.round(sleepLowRatio * 100)}%`));
    triggers.push(trigger("hrv", roundKm(hrvLowRatio), RECOVERY_HRV_RATIO_THRESHOLD, `HRV 为基线的 ${Math.round(hrvLowRatio * 100)}%`));
  } else if (currentRecovery && (sleepLowRatio != null || (hrvLowRatio != null && recovery.restingHeartRateUp))) {
    tone = "yellow";
    title = "只宜有氧";
    reason = "恢复信号偏低，先跑轻松，不要上强度。";
    if (sleepLowRatio != null) {
      triggers.push(trigger("sleep", roundKm(sleepLowRatio), RECOVERY_SLEEP_RATIO_THRESHOLD, `睡眠为基线的 ${Math.round(sleepLowRatio * 100)}%`));
    }
    if (hrvLowRatio != null) {
      triggers.push(trigger("hrv", roundKm(hrvLowRatio), RECOVERY_HRV_RATIO_THRESHOLD, `HRV 为基线的 ${Math.round(hrvLowRatio * 100)}%`));
    }
  } else if (input.consecutiveQualityDays >= 2) {
    tone = "red";
    title = "宜休息或轻松";
    reason = "已经连续两天质量课，今天必须轻松或休息。";
    triggers.push(trigger("consecutive_quality", input.consecutiveQualityDays, 2, reason));
  } else if (taper) {
    tone = "yellow";
    title = "减量期有氧";
    reason = "比赛临近，量降下来，强度只保留短促开腿。";
    triggers.push(trigger("taper", input.raceTarget ? daysUntil(input.today, input.raceTarget.date) : null, 14, reason));
  } else if (
    easyDurationFraction != null &&
    easyDurationFraction < input.easyDurationFloorFraction &&
    input.weekDurationSeconds > 0
  ) {
    tone = "yellow";
    title = "只宜有氧";
    reason = `本周轻松时长只占 ${Math.round(easyDurationFraction * 100)}%，低于 ${Math.round(input.easyDurationFloorFraction * 100)}% 下限。`;
    triggers.push(trigger("easy_floor", roundKm(easyDurationFraction), input.easyDurationFloorFraction, reason));
  } else if (input.trainingStatus === "recovery" && (input.daysSinceLastRun ?? 0) >= 2) {
    tone = "yellow";
    title = "恢复跑";
    reason = "处于恢复阶段且停跑超过一天，先恢复跑再恢复量。";
    triggers.push(trigger("recovery_status", input.daysSinceLastRun, 2, reason));
  } else if (
    (input.trainingStatus === "effective_stimulus" || input.trainingStatus === "maintaining") &&
    (input.daysSinceLastQuality ?? 99) >= 2 &&
    input.weekQualityCount < input.qualitySessionCap &&
    (easyDurationFraction == null || easyDurationFraction >= input.easyDurationFloorFraction)
  ) {
    // The base arrangement is decided by load, plan and quality spacing alone.
    // Recovery can only veto it, in the branches above: a missing or partial
    // recovery record neither cancels nor downgrades it — it merely removes the
    // recovery input, and the wording must not claim recovery approved anything.
    tone = "green";
    title = "可质量课";
    reason = !currentRecovery
      ? "按近期训练负荷与计划安排；未结合今日恢复监测。"
      : recoveryComplete
        ? "负荷与恢复允许一次质量刺激。"
        : "按近期训练负荷与计划安排；今日恢复证据不完整，未参与判断。";
    triggers.push(trigger("quality_window", input.daysSinceLastQuality, 2, reason));
  } else {
    tone = "yellow";
    title = "只宜有氧";
    reason = "今天按轻松跑安排，把有氧底铺好。";
  }

  if (!currentRecovery) {
    triggers.push(trigger("recovery_evidence_absent", null, null, "今日无可用恢复记录，本次安排未结合今日恢复监测，也未据此降级。"));
  } else if (!recoveryComplete) {
    triggers.push(trigger("recovery_evidence_partial", null, null, "今日恢复指标或个人基线不完整，仅部分证据参与判断。"));
  }
  const reasonCodes = triggers.map((item) => item.code);
  return { tone, title, reason, triggers, stale, reasonCodes };
}

/**
 * Why today's arrangement reads the way it does.
 *
 * Derived from the verdict's own reason codes rather than re-derived from the
 * inputs: the branch that fired *is* the decision, and re-testing its conditions
 * here is how an explanation drifts away from what was decided.
 *
 * `recoveryAdjustment` is the axis the device needs. `no_evidence` means recovery
 * was not consulted — neither an approval nor a downgrade — and it is the only
 * reading of "we have no recovery data" that is not a judgement about the runner.
 */
export function buildRecommendation(
  input: CoachInput,
  recovery: RecoveryAssessment,
  verdict: MobileVerdict
): MobileRecommendation {
  const codes = verdict.reasonCodes ?? [];
  const basis: MobileRecommendation["basis"] =
    codes.includes("insufficient_data")
      ? "insufficient_training_history"
      : codes.includes("training_status") || codes.includes("load_ratio")
        ? "high_load"
        : "training_load_and_plan";
  // Every recovery branch pushes at least one of these codes and they all run
  // before the load-shape branches, so seeing one means recovery set the tone.
  const recoveryDecided = codes.includes("sleep_streak") || codes.includes("sleep") || codes.includes("hrv");
  const recoveryAdjustment: MobileRecommendation["recoveryAdjustment"] = recoveryDecided
    ? "veto"
    : recovery.coverage === "none"
      ? "no_evidence"
      : "none";

  const uncertaintyReasons: string[] = [];
  if (recovery.coverage === "partial") {
    uncertaintyReasons.push("今日恢复证据不完整，只有部分指标参与判断。");
  }
  if (input.latestDataDate == null) {
    uncertaintyReasons.push("还没有导入训练数据。");
  } else if (input.latestDataDate < input.today) {
    uncertaintyReasons.push(`训练数据截至 ${input.latestDataDate}，尚未包含今天。`);
  }
  if (input.calibration !== "completed") {
    uncertaintyReasons.push("能力校准尚未完成，当前能力值先看趋势。");
  }
  if (input.trainingStatus === "insufficient_data") {
    uncertaintyReasons.push("负荷历史不足，训练状态未参与判断。");
  }

  return {
    basis,
    recoveryAdjustment,
    uncertaintyReasons,
    reasonCodes: [
      basis,
      ...(recoveryAdjustment === "no_evidence" ? ["recovery_not_consulted"] : []),
      ...(recoveryAdjustment === "veto" ? ["recovery_downgraded"] : [])
    ]
  };
}

/** Interval sessions are prescribed by distance: N repeats of 800 m. */
export const INTERVAL_REP_METERS = 800;
const INTERVAL_RECOVERY_SECONDS = 120;
/** Exported so the plan validator clamps against the same rep window the coach builds from. */
export const INTERVAL_MIN_REPS = 4;
export const INTERVAL_MAX_REPS = 8;
const QUALITY_WARMUP_MINUTES = 10;
const QUALITY_COOLDOWN_MINUTES = 10;
const EASY_WARMUP_MINUTES = 5;
const EASY_COOLDOWN_MINUTES = 5;
const TEMPO_BLOCK_REPS = 3;
const TEMPO_WORK_SECONDS = 8 * 60;
const TEMPO_RECOVERY_SECONDS = 120;
const MIN_WORK_DISTANCE_KM = 1;
const FALLBACK_EASY_SECONDS_PER_KM = 360;
const FALLBACK_THRESHOLD_SECONDS_PER_KM = 270;
const FALLBACK_INTERVAL_SECONDS_PER_KM = 240;

export interface StructurePaces {
  easySecondsPerKm: number;
  thresholdSecondsPerKm: number;
  intervalSecondsPerKm: number;
}

/** Pace assumptions used to convert between time goals and distance goals. */
export function pacesFromZones(zones: CoachZonePrescription | null): StructurePaces {
  return {
    easySecondsPerKm: zones?.easyPaceUpper ?? zones?.easyPaceLower ?? FALLBACK_EASY_SECONDS_PER_KM,
    thresholdSecondsPerKm: zones?.thresholdPaceUpper ?? zones?.thresholdPaceLower ?? FALLBACK_THRESHOLD_SECONDS_PER_KM,
    intervalSecondsPerKm: zones?.intervalPaceUpper ?? zones?.intervalPaceLower ?? FALLBACK_INTERVAL_SECONDS_PER_KM
  };
}

/** Work-step pace per session kind; warmup/recovery/cooldown always use easy pace. */
export function workSecondsPerKm(kind: MobileSessionKind, paces: StructurePaces): number {
  if (kind === "interval") return paces.intervalSecondsPerKm;
  if (kind === "tempo") return paces.thresholdSecondsPerKm;
  return paces.easySecondsPerKm;
}

function stepSecondsPerKm(step: MobileWorkoutStep, workPace: number, paces: StructurePaces): number {
  return step.purpose === "work" ? workPace : paces.easySecondsPerKm;
}

/**
 * Session-level ranges per kind. Single source of truth for the
 * kind -> zone mapping; the device layer must never re-derive this.
 */
export function sessionRanges(
  kind: MobileSessionKind,
  zones: CoachZonePrescription | null
): { paceSecondsPerKmLower: number | null; paceSecondsPerKmUpper: number | null; heartRateBpmLower: number | null; heartRateBpmUpper: number | null } {
  if (kind === "interval") {
    return {
      paceSecondsPerKmLower: zones?.intervalPaceLower ?? null,
      paceSecondsPerKmUpper: zones?.intervalPaceUpper ?? null,
      heartRateBpmLower: zones?.thresholdHrLower ?? null,
      heartRateBpmUpper: zones?.thresholdHrUpper ?? null
    };
  }
  if (kind === "tempo") {
    return {
      paceSecondsPerKmLower: zones?.thresholdPaceLower ?? null,
      paceSecondsPerKmUpper: zones?.thresholdPaceUpper ?? null,
      heartRateBpmLower: zones?.thresholdHrLower ?? null,
      heartRateBpmUpper: zones?.thresholdHrUpper ?? null
    };
  }
  return {
    paceSecondsPerKmLower: zones?.easyPaceLower ?? null,
    paceSecondsPerKmUpper: zones?.easyPaceUpper ?? null,
    heartRateBpmLower: zones?.easyHrLower ?? null,
    heartRateBpmUpper: zones?.easyHrUpper ?? null
  };
}

/**
 * Authoritative structure measurement shared by coach generation and plan
 * validation, so both agree on the executable distance and duration.
 */
export function measureStructure(
  structure: MobileSessionStructure,
  kind: MobileSessionKind,
  paces: StructurePaces
): { distanceKm: number; durationSeconds: number } {
  const workPace = workSecondsPerKm(kind, paces);
  const steps: MobileWorkoutStep[] = [
    ...(structure.warmup ? [structure.warmup] : []),
    ...structure.blocks.flatMap((block) =>
      Array.from({ length: Math.max(1, block.iterations) }, () => block.steps).flat()
    ),
    ...(structure.cooldown ? [structure.cooldown] : [])
  ];
  let distanceKm = 0;
  let durationSeconds = 0;
  for (const step of steps) {
    const pace = stepSecondsPerKm(step, workPace, paces);
    if (step.goal.type === "distance") {
      const km = step.goal.meters / 1000;
      distanceKm += km;
      durationSeconds += km * pace;
    } else if (step.goal.type === "time") {
      durationSeconds += step.goal.seconds;
      distanceKm += step.goal.seconds / pace;
    }
  }
  return { distanceKm, durationSeconds };
}

/**
 * Authoritative numbers for a *stored* plan day.
 *
 * A planned day is defined by its structure: the structure is what the watch
 * executes and every number shown is measured from it. Two endpoints render the
 * same stored rows — `/v1/mobile/today` and `/v1/mobile/workout-plan` — so they
 * must derive them through this one function. Echoing a stored distance in one
 * and measuring the structure in the other is exactly how the same day ends up
 * with two different distances on screen.
 *
 * A day with no stored structure is measured too, from the structure its
 * distance hint would build, so a hint-only day cannot disagree either.
 */
export function plannedDayNumbers(
  kind: MobileSessionKind,
  storedStructure: MobileSessionStructure | null | undefined,
  distanceHint: number | null | undefined,
  prescription: CoachZonePrescription | null
): { structure: MobileSessionStructure | null; distanceKm: number | null; durationMinutes: number | null } {
  if (kind === "rest") return { structure: null, distanceKm: null, durationMinutes: null };
  const structure =
    storedStructure ??
    buildSessionStructure(kind, prescription, {
      targetDistanceKm: distanceHint != null && distanceHint > 0 ? distanceHint : null
    });
  if (!structure) return { structure: null, distanceKm: null, durationMinutes: null };
  const measured = measureStructure(structure, kind, pacesFromZones(prescription));
  return {
    structure,
    distanceKm: roundKm(measured.distanceKm),
    durationMinutes: Math.round(measured.durationSeconds / 60)
  };
}

/** At most one alert per step (WorkoutKit limit), chosen per session kind. */
function sessionAlert(kind: MobileSessionKind, zones: CoachZonePrescription | null): MobileStepAlert | null {
  if (!zones) return null;
  if (kind === "interval") {
    return zones.intervalPaceLower == null && zones.intervalPaceUpper == null
      ? null
      : { kind: "pace", lower: zones.intervalPaceLower, upper: zones.intervalPaceUpper };
  }
  if (kind === "tempo") {
    return zones.thresholdPaceLower == null && zones.thresholdPaceUpper == null
      ? null
      : { kind: "pace", lower: zones.thresholdPaceLower, upper: zones.thresholdPaceUpper };
  }
  if (kind === "long_run") {
    return zones.easyHrLower == null && zones.easyHrUpper == null
      ? null
      : { kind: "heart_rate", lower: zones.easyHrLower, upper: zones.easyHrUpper };
  }
  return zones.easyPaceLower == null && zones.easyPaceUpper == null
    ? null
    : { kind: "pace", lower: zones.easyPaceLower, upper: zones.easyPaceUpper };
}

function easyHeartRateAlert(zones: CoachZonePrescription | null): MobileStepAlert | null {
  if (!zones || (zones.easyHrLower == null && zones.easyHrUpper == null)) return null;
  return { kind: "heart_rate", lower: zones.easyHrLower, upper: zones.easyHrUpper };
}

function timeStep(purpose: "warmup" | "cooldown", minutes: number, zones: CoachZonePrescription | null): MobileWorkoutStep {
  return {
    purpose,
    goal: { type: "time", seconds: Math.round(minutes * 60) },
    alert: easyHeartRateAlert(zones)
  };
}

function workStep(goal: MobileStepGoal, alert: MobileStepAlert | null): MobileWorkoutStep {
  return { purpose: "work", goal, alert };
}

function recoveryStep(seconds: number): MobileWorkoutStep {
  return { purpose: "recovery", goal: { type: "time", seconds }, alert: null };
}

/** Reps grow with time since the last quality session, and are capped when fatigued. */
export function intervalReps(input: CoachInput): number {
  const base = INTERVAL_MIN_REPS + Math.floor(Math.max(0, input.daysSinceLastQuality ?? 0) / 5);
  const capped = Math.min(INTERVAL_MAX_REPS, Math.max(INTERVAL_MIN_REPS, base));
  const fatigued =
    (input.strain != null && input.strainP90 != null && input.strain > input.strainP90) ||
    (input.loadRatio != null && input.loadRatio > 1.5);
  return fatigued ? INTERVAL_MIN_REPS : capped;
}

/**
 * Builds the structured breakdown for a session. Continuous sessions are given a
 * 5 minute warmup/cooldown and the work step is trimmed so the measured total
 * still matches the requested target distance.
 */
export function buildSessionStructure(
  kind: MobileSessionKind,
  zones: CoachZonePrescription | null,
  options: { targetDistanceKm?: number | null; reps?: number } = {}
): MobileSessionStructure | null {
  if (kind === "rest") return null;
  const paces = pacesFromZones(zones);
  const alert = sessionAlert(kind, zones);

  if (kind === "interval") {
    const reps = Math.max(1, Math.round(options.reps ?? INTERVAL_MIN_REPS));
    const blocks: MobileIntervalBlock[] = [
      {
        iterations: reps,
        steps: [
          workStep({ type: "distance", meters: INTERVAL_REP_METERS }, alert),
          recoveryStep(INTERVAL_RECOVERY_SECONDS)
        ]
      }
    ];
    return {
      warmup: timeStep("warmup", QUALITY_WARMUP_MINUTES, zones),
      blocks,
      cooldown: timeStep("cooldown", QUALITY_COOLDOWN_MINUTES, zones)
    };
  }

  if (kind === "tempo") {
    const blocks: MobileIntervalBlock[] = [
      {
        iterations: TEMPO_BLOCK_REPS,
        steps: [
          workStep({ type: "time", seconds: TEMPO_WORK_SECONDS }, alert),
          recoveryStep(TEMPO_RECOVERY_SECONDS)
        ]
      }
    ];
    return {
      warmup: timeStep("warmup", QUALITY_WARMUP_MINUTES, zones),
      blocks,
      cooldown: timeStep("cooldown", QUALITY_COOLDOWN_MINUTES, zones)
    };
  }

  const warmup = timeStep("warmup", EASY_WARMUP_MINUTES, zones);
  const cooldown = timeStep("cooldown", EASY_COOLDOWN_MINUTES, zones);
  const overhead = measureStructure({ warmup, blocks: [], cooldown }, kind, paces).distanceKm;
  const target = options.targetDistanceKm ?? null;
  const workKm = target == null ? null : Math.max(MIN_WORK_DISTANCE_KM, roundKm(target - overhead));
  const goal: MobileStepGoal = workKm == null ? { type: "open" } : { type: "distance", meters: Math.round(workKm * 1000) };
  return { warmup, blocks: [{ iterations: 1, steps: [workStep(goal, alert)] }], cooldown };
}

/**
 * Holds a structure to the single-day distance ceiling, rebuilding it when the
 * structure's own measurement is over.
 *
 * `normalizeSessionStructure` bounds every *field* a client may send: one step
 * carries at most `MAX_STEP_METERS`, one block at most `MAX_BLOCK_ITERATIONS`
 * repetitions. Nothing bounds the total, so a payload that satisfies all of them
 * — a single 20-rep block of 100 km work steps — measures 2000 km. The plan
 * validator caps supplied structures (`capDayDistance`); a structure arriving
 * over `PUT /v1/mobile/goals` or `POST /v1/mobile/lock` reaches the same store,
 * the same two plan endpoints and the same workout bridge, so it is held to the
 * same ceiling here.
 *
 * Rebuilt rather than renumbered: the structure is what the watch is asked to
 * run, so trimming the distance beside it would leave the oversized
 * prescription in place. `null` is returned when even a rebuilt structure cannot
 * be expressed under the ceiling — the caller then keeps the day without a
 * structure, which keeps it off the watch instead of putting a 2000 km session
 * on it.
 */
/**
 * The single rebuild every layer performs when a structure measures over the
 * single-day ceiling.
 *
 * An interval is dosed by its rep count and every other kind by its work step's
 * target distance, and both ask for `MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM`
 * rather than the ceiling itself: `buildSessionStructure` rounds its work step to
 * 100 m, so a request *at* the ceiling measures up to half a step above it.
 *
 * Shared rather than repeated. The plan validator and the client-facing store
 * hold the same ceiling, and two copies of this arithmetic is exactly how their
 * lever floors drifted apart — one bounded an interval at a literal 2 reps while
 * the other used `INTERVAL_MIN_REPS`. One definition means the ceiling can only
 * be changed in one place.
 *
 * Only the *rebuild* is shared. What a caller does with a structure that cannot
 * be brought under the ceiling stays its own policy: the validator keeps the day
 * (its contract is a week of days, so dropping one would change the plan's
 * shape) while `capStructureToDayCeiling` returns `null` so the session never
 * reaches the watch. Neither branch is reachable today — `buildSessionStructure`
 * returns `null` only for `rest`, whose size is 0 — so the two contracts are kept
 * distinct rather than merged.
 */
export function rebuildStructureUnderDayCeiling(
  kind: MobileSessionKind,
  zones: CoachZonePrescription | null
): MobileSessionStructure | null {
  if (kind === "rest") return null;
  const cap = MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM;
  return buildSessionStructure(
    kind,
    zones,
    kind === "interval"
      ? {
          reps: Math.max(
            INTERVAL_MIN_REPS,
            Math.min(INTERVAL_MAX_REPS, Math.round(cap / (INTERVAL_REP_METERS / 1000)))
          )
        }
      : { targetDistanceKm: cap }
  );
}

export function capStructureToDayCeiling(
  structure: MobileSessionStructure,
  kind: MobileSessionKind,
  zones: CoachZonePrescription | null
): MobileSessionStructure | null {
  const measured = measureStructure(structure, kind, pacesFromZones(zones)).distanceKm;
  if (measured <= MAX_PLANNED_DISTANCE_KM) return structure;
  if (kind === "rest") return null;
  const rebuilt = rebuildStructureUnderDayCeiling(kind, zones);
  if (!rebuilt) return null;
  const remeasured = measureStructure(rebuilt, kind, pacesFromZones(zones)).distanceKm;
  // A tempo block is a fixed number of threshold reps and ignores
  // `targetDistanceKm`, so a rebuild can come back over the ceiling. Keeping it
  // would put the oversized prescription back on the watch, which is the one
  // outcome this function exists to prevent.
  return remeasured > MAX_PLANNED_DISTANCE_KM ? null : rebuilt;
}

/**
 * Session factory. Distance and duration are derived from the structure so the
 * displayed numbers can never contradict the prescription.
 */
function structuredSession(
  kind: MobileSessionKind,
  title: string,
  reason: string,
  zones: CoachZonePrescription | null,
  paceLower: number | null,
  paceUpper: number | null,
  hrLower: number | null,
  hrUpper: number | null,
  options: { targetDistanceKm?: number | null; reps?: number } = {}
): MobileNextSession {
  const structure = buildSessionStructure(kind, zones, options);
  const measured = structure ? measureStructure(structure, kind, pacesFromZones(zones)) : null;
  return {
    kind,
    title,
    reason,
    distanceKm: measured ? roundKm(measured.distanceKm) : null,
    durationMinutes: measured ? Math.round(measured.durationSeconds / 60) : null,
    paceSecondsPerKmLower: paceLower,
    paceSecondsPerKmUpper: paceUpper,
    heartRateBpmLower: hrLower,
    heartRateBpmUpper: hrUpper,
    structure
  };
}

export function decideNextSession(input: CoachInput, verdict: MobileVerdict): MobileNextSession {
  return decideNextSessionDecision(input, verdict).session;
}

/**
 * §13.3：决策**自己报告**它走了哪条分支。
 *
 * 为什么不从外面推断：`action` 若靠比较"计划课型 vs 最终课型"倒推，就变成了对决策的
 * 二次解释 —— 而 `decidePlannedSession` 有多条会产出**相同 kind** 的路径
 * （计划被原样保留、被 taper 缩短、被周预算缩减），kind 相同并不代表动作相同。
 * 分支在哪一步被选中，就由那一步如实报告；投影只做翻译，不做判断。
 */
export type CoachPlanDisposition =
  | "no_stored_plan"
  | "kept_stored_plan"
  | "stored_rest_kept"
  | "race_day_blank"
  | "downgraded_quality"
  | "downgraded_taper"
  | "downgraded_red_tone"
  | "budget_limited"
  | "budget_exhausted";

export function decideNextSessionDecision(
  input: CoachInput,
  verdict: MobileVerdict
): { session: MobileNextSession; disposition: CoachPlanDisposition } {
  const resolved = decidePlannedSession(input, verdict);
  if (resolved.session.kind === "rest") return resolved;
  const remaining = Math.max(0, input.weeklyVolumeCeilingKm - input.weekDistanceKm);
  if ((resolved.session.distanceKm ?? 0) <= remaining + 0.05) return resolved;
  if (remaining <= 0) {
    return {
      session: structuredSession("rest", "本周预算已完成", "已导入跑量达到周目标，不再追加训练。", input.zones, null, null, null, null),
      disposition: "budget_exhausted"
    };
  }
  const structure = buildSessionStructure("easy", input.zones, { targetDistanceKm: remaining });
  const numbers = plannedDayNumbers("easy", structure, remaining, input.zones);
  if ((numbers.distanceKm ?? 0) > remaining + 0.05) {
    return {
      session: structuredSession("rest", "保留恢复", "剩余跑量不足以安排完整课表，不追加训练。", input.zones, null, null, null, null),
      disposition: "budget_exhausted"
    };
  }
  return {
    session: { ...resolved.session, ...numbers, kind: "easy", title: "预算内轻松跑", reason: "按本自然周剩余跑量缩减今日处方。",
      paceSecondsPerKmLower: input.zones?.easyPaceLower ?? null, paceSecondsPerKmUpper: input.zones?.easyPaceUpper ?? null,
      heartRateBpmLower: input.zones?.easyHrLower ?? null, heartRateBpmUpper: input.zones?.easyHrUpper ?? null },
    disposition: "budget_limited"
  };
}

function decidePlannedSession(
  input: CoachInput,
  verdict: MobileVerdict
): { session: MobileNextSession; disposition: CoachPlanDisposition } {
  const planned = input.storedWeekPlan.find(day => day.localDate === input.today);
  // An explicit rest is never upgraded because the runner looks ready.
  if (planned?.kind === "rest" || input.raceTarget?.date === input.today) {
    const raceDay = input.raceTarget?.date === input.today;
    return {
      session: structuredSession("rest", raceDay ? "比赛日留白" : "计划休息",
        raceDay ? "比赛当天不追加训练；是否参赛及比赛完成以实际记录为准。" : (planned?.reason ?? "遵循已保存的休息安排。"),
        input.zones, null, null, null, null),
      disposition: raceDay ? "race_day_blank" : "stored_rest_kept"
    };
  }
  const fallback = decideUnplannedSession(input, verdict);
  if (!planned) return { ...fallback, disposition: "no_stored_plan" };
  if (verdict.tone === "red") return { ...fallback, disposition: "downgraded_red_tone" };
  const quality = planned.kind === "tempo" || planned.kind === "interval";
  if (quality && verdict.tone !== "green") {
    return { ...fallback, session: { ...fallback.session, reason: `原计划为${sessionTitle(planned.kind)}；${fallback.session.reason}` },
      disposition: "downgraded_quality" };
  }
  if (isTaper(input)) {
    if (planned.kind === "long_run" || quality || (planned.distanceKm ?? 0) > (fallback.session.distanceKm ?? 0)) {
      return { ...fallback, disposition: "downgraded_taper" };
    }
  }
  const numbers = plannedDayNumbers(planned.kind, planned.structure, planned.distanceKm, input.zones);
  const easy = !quality;
  return { disposition: "kept_stored_plan", session: {
    kind: planned.kind, title: sessionTitle(planned.kind), reason: planned.reason ?? "遵循已保存课表；实时恢复与负荷门控仍然生效。",
    ...numbers,
    paceSecondsPerKmLower: easy ? input.zones?.easyPaceLower ?? null : planned.kind === "interval" ? input.zones?.intervalPaceLower ?? null : input.zones?.thresholdPaceLower ?? null,
    paceSecondsPerKmUpper: easy ? input.zones?.easyPaceUpper ?? null : planned.kind === "interval" ? input.zones?.intervalPaceUpper ?? null : input.zones?.thresholdPaceUpper ?? null,
    heartRateBpmLower: easy ? input.zones?.easyHrLower ?? null : input.zones?.thresholdHrLower ?? null,
    heartRateBpmUpper: easy ? input.zones?.easyHrUpper ?? null : input.zones?.thresholdHrUpper ?? null
  } };
}

/**
 * 无计划日的处方。**函数体保持原样** —— 这里只把它改名并包一层报告分支的 wrapper，
 * 避免在"接线"这一步顺手改动处方的任何数值。
 */
function decideUnplannedSession(
  input: CoachInput,
  verdict: MobileVerdict
): { session: MobileNextSession; disposition: CoachPlanDisposition } {
  return { session: prescribeUnplannedSession(input, verdict), disposition: "no_stored_plan" };
}

function prescribeUnplannedSession(input: CoachInput, verdict: MobileVerdict): MobileNextSession {
  const remainingKm = Math.max(0, input.weeklyVolumeCeilingKm - input.weekDistanceKm);
  const remainingDays = Math.max(1, daysInclusive(input.today, weekEnd(input.today)));
  const perDayKm = Math.max(4, Math.min(14, remainingKm / remainingDays));
  const zones = input.zones;
  const taper = isTaper(input);

  if (verdict.tone === "red") {
    const hardRest =
      input.nightsBelowSleepBaseline >= 3 ||
      input.trainingStatus === "attention" ||
      input.todayWorkoutCount > 0;
    if (hardRest) {
      return structuredSession("rest", "今天的动作：休息", verdict.reason, zones, null, null, null, null);
    }
    return structuredSession(
      "recovery",
      "恢复跑",
      verdict.reason,
      zones,
      zones?.easyPaceLower ?? null,
      zones?.easyPaceUpper ?? null,
      zones?.easyHrLower ?? null,
      zones?.easyHrUpper ?? null,
      { targetDistanceKm: Math.min(8, roundKm(perDayKm * 0.7)) }
    );
  }

  if (taper) {
    const cap = input.longestRun8WeekKm > 0 ? input.longestRun8WeekKm * 0.85 : 10;
    return structuredSession(
      "easy",
      "减量轻松跑",
      "比赛临近：量降下来，不再拉新的最长距离。",
      zones,
      zones?.easyPaceLower ?? null,
      zones?.easyPaceUpper ?? null,
      zones?.easyHrLower ?? null,
      zones?.easyHrUpper ?? null,
      { targetDistanceKm: roundKm(Math.min(cap, perDayKm * 0.7)) }
    );
  }

  if (verdict.tone === "green") {
    const sinceQuality = input.daysSinceLastQuality;
    const kind: MobileSessionKind = sinceQuality != null && sinceQuality >= 5 ? "interval" : "tempo";
    const title = kind === "interval" ? "间歇 / VO₂" : "节奏 / 阈值";
    return structuredSession(
      kind,
      title,
      verdict.reason,
      zones,
      kind === "interval" ? zones?.intervalPaceLower ?? null : zones?.thresholdPaceLower ?? null,
      kind === "interval" ? zones?.intervalPaceUpper ?? null : zones?.thresholdPaceUpper ?? null,
      zones?.thresholdHrLower ?? null,
      zones?.thresholdHrUpper ?? null,
      kind === "interval" ? { reps: intervalReps(input) } : {}
    );
  }

  if (verdict.title.includes("恢复")) {
    return structuredSession(
      "recovery",
      "恢复跑",
      verdict.reason,
      zones,
      zones?.easyPaceLower ?? null,
      zones?.easyPaceUpper ?? null,
      zones?.easyHrLower ?? null,
      zones?.easyHrUpper ?? null,
      { targetDistanceKm: Math.min(8, roundKm(perDayKm)) }
    );
  }

  return structuredSession(
    "easy",
    "轻松跑",
    verdict.reason,
    zones,
    zones?.easyPaceLower ?? null,
    zones?.easyPaceUpper ?? null,
    zones?.easyHrLower ?? null,
    zones?.easyHrUpper ?? null,
    { targetDistanceKm: roundKm(Math.min(12, perDayKm)) }
  );
}

export function buildRecovery(input: CoachInput): MobileRecoveryBreakdown {
  const parts: string[] = [];
  if (input.lastNightSleepMinutes != null && input.sleepBaselineMinutes != null) {
    const ratio = input.lastNightSleepMinutes / Math.max(1, input.sleepBaselineMinutes);
    parts.push(`睡眠 ${Math.round(input.lastNightSleepMinutes)} 分钟，基线的 ${Math.round(ratio * 100)}%`);
  } else if (input.lastNightSleepMinutes != null) {
    parts.push(`睡眠 ${Math.round(input.lastNightSleepMinutes)} 分钟`);
  }
  if (input.morningHrvMs != null && input.hrvBaselineMs != null) {
    const ratio = input.morningHrvMs / Math.max(1, input.hrvBaselineMs);
    parts.push(`HRV ${Math.round(input.morningHrvMs)} ms，基线的 ${Math.round(ratio * 100)}%`);
  }
  if (input.restingHeartRateBpm != null && input.restingHeartRateBaselineBpm != null) {
    const delta = input.restingHeartRateBpm - input.restingHeartRateBaselineBpm;
    parts.push(`静息心率 ${Math.round(input.restingHeartRateBpm)}，较基线 ${delta >= 0 ? "+" : ""}${Math.round(delta)}`);
  }
  if (input.morningHrvMs != null && input.hrvBaselineMs == null) {
    parts.push(`HRV ${Math.round(input.morningHrvMs)} ms，个人基线尚未建立`);
  }
  if (input.restingHeartRateBpm != null && input.restingHeartRateBaselineBpm == null) {
    parts.push(`静息心率 ${Math.round(input.restingHeartRateBpm)} bpm，个人基线尚未建立`);
  }
  if (parts.length === 0) {
    parts.push("还没有可用的恢复样本，恢复状态暂不可用。");
  }
  const components = [
    input.lastNightSleepMinutes != null && input.sleepBaselineMinutes != null
      ? Math.min(1, Math.max(0, input.lastNightSleepMinutes / Math.max(1, input.sleepBaselineMinutes)))
      : null,
    input.morningHrvMs != null && input.hrvBaselineMs != null && input.hrvBaselineMs > 0
      ? Math.min(1, Math.max(0, input.morningHrvMs / input.hrvBaselineMs))
      : null,
    input.restingHeartRateBpm != null && input.restingHeartRateBaselineBpm != null
      ? Math.min(1, Math.max(0, 1 - Math.max(0, input.restingHeartRateBpm - input.restingHeartRateBaselineBpm) / 12))
      : null
  ].filter((value): value is number => value !== null);
  const score = input.recoveryEvidenceDate === input.today &&
    input.recoveryEvidenceStatus !== "stale" &&
    input.recoveryEvidenceStatus !== "unknown" &&
    components.length > 0
    ? Math.round(components.reduce((sum, value) => sum + value, 0) / components.length * 100)
    : null;
  return {
    score,
    lastNightSleepMinutes: input.lastNightSleepMinutes,
    sleepBaselineMinutes: input.sleepBaselineMinutes,
    morningHrvMs: input.morningHrvMs,
    hrvBaselineMs: input.hrvBaselineMs,
    restingHeartRateBpm: input.restingHeartRateBpm,
    restingHeartRateBaselineBpm: input.restingHeartRateBaselineBpm,
    note: parts.join("；")
  };
}

export function stimulusMatch(workout: CoachLatestWorkout): MobileStimulusMatch {
  const easyFraction = workout.easyHeartRateFraction;
  const thresholdFraction = workout.thresholdHeartRateFraction;
  if (isEasySession(workout.sessionType)) {
    if (easyFraction == null) return "unknown";
    if (easyFraction >= 0.8) return "aligned";
    if ((thresholdFraction ?? 0) > 0.2) return "too_hard";
    return "too_hard";
  }
  if (isQualitySession(workout.sessionType)) {
    if ((thresholdFraction ?? 0) >= 0.15 || QUALITY_STIMULI.has(workout.stimulusType)) return "aligned";
    if ((thresholdFraction ?? 0) < 0.15) return "too_easy";
    return "unknown";
  }
  if (workout.sessionType === "long_run") {
    if (easyFraction == null) return "unknown";
    return easyFraction >= 0.7 ? "aligned" : "too_hard";
  }
  return "unknown";
}

export function buildPostRun(
  workout: CoachLatestWorkout | null,
  trueAbility: number | null,
  today: string,
  plannedKind: MobileSessionKind | null,
  verdictTone: MobileVerdict["tone"] | null
): MobilePostRunVerdict | null {
  if (!workout || workout.localDate !== today) return null;
  const match = stimulusMatch(workout);
  const details: string[] = [];
  if (workout.indoor) {
    details.push("室内跑计入负荷，但不更新真实能力。跑步机配速不可比。");
  }
  if (plannedKind && plannedKind !== "rest" && !sessionKindMatches(plannedKind, workout.sessionType)) {
    details.push(`对照锁定课：计划是${plannedKind}，实际标记为${workout.sessionType}。`);
  }
  if (verdictTone === "red" && isQualitySession(workout.sessionType)) {
    details.push("今天闸门不允许质量刺激，这堂课不算完成处方。");
  }
  if (match === "too_hard" && isEasySession(workout.sessionType)) {
    details.push("这堂轻松跑偏快，有氧底时间不够，不能当成恢复课。");
  } else if (match === "aligned" && isEasySession(workout.sessionType)) {
    details.push("轻松跑留在轻松区，对真实能力贡献小是正常的。");
  } else if (match === "aligned") {
    details.push(`刺激类型 ${workout.stimulusType} 与课型一致。`);
  } else if (match === "too_easy") {
    details.push("质量课在目标区的时间不够。");
  }
  if (workout.updatedTrueAbility) {
    details.push(
      workout.trueAbilityDelta == null
        ? "本次更新了真实能力。"
        : `本次${workout.trueAbilityDelta >= 0 ? "上调" : "下调"}真实能力 ${roundKm(Math.abs(workout.trueAbilityDelta))} 点。`
    );
  } else {
    details.push("本次没有更新真实能力（试算、室内、低置信或已被排除）。");
  }
  for (const code of workout.explanationCodes.slice(0, 2)) {
    details.push(code);
  }
  const headline = postRunHeadline(workout, match, trueAbility);
  return {
    workoutId: workout.id,
    startedAt: workout.startedAt,
    sessionType: workout.sessionType,
    stimulusType: workout.stimulusType,
    stimulusMatch: match,
    indoor: workout.indoor,
    updatedTrueAbility: workout.updatedTrueAbility,
    trueAbilityDelta: workout.trueAbilityDelta,
    currentAbility: workout.currentAbility,
    trueAbilityAfter: workout.trueAbilityAfter,
    headline,
    details
  };
}

function postRunHeadline(
  workout: CoachLatestWorkout,
  match: MobileStimulusMatch,
  trueAbility: number | null
): string {
  if (workout.indoor) return "室内课已计入负荷，不进入真实能力。";
  if (match === "too_hard" && isEasySession(workout.sessionType)) return "轻松日不够轻松。";
  if (workout.currentAbility != null && trueAbility != null) {
    const delta = workout.currentAbility - trueAbility;
    if (delta <= -2) return "即时跑力明显低于真实能力，更像状态波动。";
    if (delta >= 2) return "即时跑力高于真实能力，先看成当天状态。";
  }
  if (workout.updatedTrueAbility) return "这堂课进入了真实能力更新。";
  return "这堂课已记录，对长期能力影响有限。";
}

export function buildWeekStructure(input: CoachInput): MobileWeekStructure {
  const easyDurationFraction =
    input.weekDurationSeconds > 0 ? input.weekEasyDurationSeconds / input.weekDurationSeconds : null;
  const honestyFraction =
    input.intendedEasyCount > 0 ? input.easyEnoughCount / input.intendedEasyCount : null;
  let note = "本周还没有标记为轻松/恢复的课。";
  if (input.intendedEasyCount > 0) {
    note =
      honestyFraction != null && honestyFraction >= 0.7
        ? `计划轻松的 ${input.intendedEasyCount} 堂里，有 ${input.easyEnoughCount} 堂留在轻松区。`
        : `计划轻松的 ${input.intendedEasyCount} 堂里，只有 ${input.easyEnoughCount} 堂真正轻松。`;
  }
  return {
    easyDurationFraction,
    easyDurationFloorFraction: input.easyDurationFloorFraction,
    qualitySessionCount: input.weekQualityCount,
    qualitySessionCap: input.qualitySessionCap,
    easyHonesty: {
      intendedEasyCount: input.intendedEasyCount,
      easyEnoughCount: input.easyEnoughCount,
      honestyFraction,
      note
    }
  };
}

export function buildInjuryFlags(input: CoachInput): MobileInjuryFlag[] {
  const flags: MobileInjuryFlag[] = [];
  if (input.fourWeekDistanceChangeFraction != null && input.fourWeekDistanceChangeFraction > 0.3) {
    flags.push({
      code: "volume_ramp",
      title: "跑量增幅偏快",
      detail: `近 4 周跑量较前 4 周 +${Math.round(input.fourWeekDistanceChangeFraction * 100)}%，超过 30%。`
    });
  }
  if (input.previousWeekDistanceKm > 0 && input.currentWeekDistanceKm > input.previousWeekDistanceKm * 1.5) {
    flags.push({
      code: "week_jump",
      title: "单周跑量跳升",
      detail: `本周跑量较上周 +${Math.round((input.currentWeekDistanceKm / input.previousWeekDistanceKm - 1) * 100)}%。`
    });
  }
  if (input.rampRate != null && input.rampRate > 0.5) {
    flags.push({
      code: "ramp_rate",
      title: "负荷爬升过快",
      detail: `rampRate ${roundKm(input.rampRate)}，阈值 0.5。`
    });
  }
  if (input.loadRatio != null && input.loadRatio > 1.5) {
    flags.push({
      code: "load_ratio",
      title: "急性负荷过高",
      detail: `急性/慢性负荷比 ${roundKm(input.loadRatio)}，阈值 1.5。`
    });
  }
  if (input.strain != null && input.strainP90 != null && input.strain > input.strainP90) {
    flags.push({
      code: "strain",
      title: "训练应激偏高",
      detail: `当前应激 ${roundKm(input.strain)}，高于近 56 日 90 分位 ${roundKm(input.strainP90)}。`
    });
  }
  if (input.consecutiveQualityDays >= 2) {
    flags.push({
      code: "quality_cluster",
      title: "质量课扎堆",
      detail: `连续 ${input.consecutiveQualityDays} 天质量刺激。`
    });
  }
  if (
    input.latestLongRunKm != null &&
    input.longestRun8WeekKm > 0 &&
    input.latestLongRunKm > input.longestRun8WeekKm * 1.2
  ) {
    flags.push({
      code: "long_run_jump",
      title: "长跑突然加量",
      detail: `最近长跑 ${roundKm(input.latestLongRunKm)} km，超过 8 周最长距离 20%。`
    });
  }
  if (input.nightsBelowSleepBaseline >= 3) {
    flags.push({
      code: "sleep_streak",
      title: "连续睡眠偏低",
      detail: "近 3 夜睡眠低于个人基线。"
    });
  }
  if (input.monotony != null && input.monotony >= 2) {
    flags.push({
      code: "monotony",
      title: "训练过于单调",
      detail: `单调性 ${roundKm(input.monotony)}，每天刺激太像。`
    });
  }
  return flags;
}

/**
 * Prep score below which the card explains *what is missing* instead of implying
 * "train harder". Shared with the coach confidence value so the two surfaces cannot
 * drift into different thresholds for the same sentence.
 */
export const WEAK_PREPARATION_SCORE = 0.55;
/** The single wording for a weak prep score; used by the race card and the coach. */
export const WEAK_PREPARATION_NOTE = "缺的是这条距离的周量和长课，不是再加 VO₂。";

export function buildRaceCard(input: CoachInput): MobileRaceCard {
  const target = input.raceTarget;
  if (!target) {
    return {
      target: null,
      daysUntil: null,
      taper: false,
      shapeScore: input.raceShapeScore,
      volumeFraction: input.raceVolumeFraction,
      longRunFraction: input.raceLongRunFraction,
      note: "还没有目标赛事，请在计划页设置比赛日期和距离。当前准备度默认按 10 公里计算。"
    };
  }
  const days = daysUntil(input.today, target.date);
  const taper = days != null && days >= 0 && days <= 14;
  const distanceLabel = target.distance === "five_k" ? "5 公里" : target.distance === "ten_k" ? "10 公里" : "半程马拉松";
  let note = days == null || days < 0
    ? `${distanceLabel}目标已过期。`
    : `距 ${distanceLabel} 还有 ${days} 天。`;
  if (input.raceShapeScore != null && input.raceShapeScore < WEAK_PREPARATION_SCORE) {
    note += ` 赛事准备度还不足：${WEAK_PREPARATION_NOTE}`;
  } else if (taper) {
    note += " 进入减量：量降 20–40%，不再拉新的最长距离。";
  } else if (input.raceShapeScore != null) {
    note += ` 赛事准备度 ${Math.round(input.raceShapeScore * 100)}%。能力够不等于这条距离练够。`;
  }
  return {
    target,
    daysUntil: days,
    taper,
    shapeScore: input.raceShapeScore,
    volumeFraction: input.raceVolumeFraction,
    longRunFraction: input.raceLongRunFraction,
    note
  };
}

export function buildWeekPlan(input: CoachInput, next: MobileNextSession): MobileWeekPlanDay[] {
  const stored = new Map(input.storedWeekPlan.map((item) => [item.localDate, item]));
  return input.weekDaily.map((day) => {
    if (day.workoutCount > 0) {
      return {
        localDate: day.localDate,
        kind: "completed" as const,
        title: "已完成",
        planned: false,
        completedWorkoutId: day.workoutId,
        distanceKm: day.distanceKm,
        workoutCount: day.workoutCount,
        structure: null
      };
    }
    if (day.localDate < input.today) {
      return {
        localDate: day.localDate,
        kind: "rest",
        title: "休息",
        planned: true,
        completedWorkoutId: null,
        distanceKm: 0,
        workoutCount: 0,
        structure: null
      };
    }
    if (day.localDate === input.today) {
      // Measured, like every other row: today's card and the executable week
      // both render this day, and a locked snapshot can carry a distance that
      // its own structure does not describe (or none at all).
      const numbers = plannedDayNumbers(next.kind, next.structure, next.distanceKm, input.zones);
      return {
        localDate: day.localDate,
        kind: next.kind,
        title: next.title,
        planned: true,
        completedWorkoutId: null,
        distanceKm: numbers.distanceKm ?? 0,
        workoutCount: 0,
        structure: numbers.structure
      };
    }
    const saved = stored.get(day.localDate);
    if (saved) {
      // Measured, not echoed: `/v1/mobile/workout-plan` renders the same stored
      // day, and the two must not disagree about how far it is. Capped as well,
      // because this store is read without a prescription — a structure written
      // before the ceiling bound the write would otherwise reach the week card at
      // full size.
      const bounded =
        saved.structure == null ? null : capStructureToDayCeiling(saved.structure, saved.kind, input.zones);
      const numbers = plannedDayNumbers(saved.kind, bounded, saved.distanceKm, input.zones);
      return {
        localDate: day.localDate,
        kind: saved.kind,
        title: sessionTitle(saved.kind),
        planned: true,
        completedWorkoutId: null,
        distanceKm: numbers.distanceKm ?? 0,
        workoutCount: 0,
        structure: numbers.structure
      };
    }
    return {
      localDate: day.localDate,
      kind: "easy",
      title: "轻松跑（建议）",
      planned: true,
      completedWorkoutId: null,
      distanceKm: 0,
      workoutCount: 0,
      structure: null
    };
  });
}

export function resolveLockedNextSession(
  computed: MobileNextSession,
  locked: MobileLockedSession | null,
  today: string,
  prescription: CoachZonePrescription | null
): MobileNextSession {
  if (locked && locked.localDate === today) {
    // Snapshots persisted before structured sessions existed have no `structure`
    // — and a snapshot written with a distance but no structure would otherwise
    // be the one number in the app that nothing measures. `/v1/mobile/today`
    // returns this session as `nextSession`, so the lock is re-measured here
    // rather than trusted.
    //
    // The reason comes from the snapshot too. Mixing a fresh rationale into a
    // frozen session described a different workout whenever the verdict had
    // turned since the lock; `lockState` already reports that the verdict is
    // stale and suggests a re-lock.
    // Capped like a stored plan day: a snapshot persisted before the ceiling
    // bound the write would otherwise put its oversized prescription back on the
    // watch the moment it is read.
    const bounded =
      locked.session.structure == null
        ? null
        : capStructureToDayCeiling(locked.session.structure, locked.session.kind, prescription);
    const numbers = plannedDayNumbers(
      locked.session.kind,
      bounded,
      locked.session.distanceKm,
      prescription
    );
    return {
      ...locked.session,
      distanceKm: numbers.distanceKm,
      durationMinutes: numbers.durationMinutes,
      structure: numbers.structure
    };
  }
  return computed;
}

export function decideDayPhase(input: {
  today: string;
  latestDataDate: string | null;
  todayWorkoutCount: number;
  nextKind: MobileSessionKind;
  lockPresent: boolean;
}): MobileDayPhase {
  if (input.todayWorkoutCount > 0) return "post_run";
  if (input.latestDataDate == null || input.latestDataDate < input.today) return "need_sync";
  if (input.nextKind === "rest" && input.lockPresent) return "rest_done";
  if (input.lockPresent) return "locked";
  return "morning_open";
}

export function lockState(
  locked: MobileLockedSession | null,
  today: string,
  currentTone: MobileVerdict["tone"]
): MobileLockState {
  if (!locked || locked.localDate !== today) {
    return { present: false, relockSuggested: false, lockedAt: null };
  }
  return {
    present: true,
    relockSuggested: locked.verdictTone === "green" && currentTone === "red",
    lockedAt: locked.lockedAt
  };
}

function sessionKindMatches(planned: MobileSessionKind, actual: string): boolean {
  if (planned === actual) return true;
  if (planned === "easy" && actual === "recovery") return true;
  if (planned === "recovery" && actual === "easy") return true;
  if (planned === "tempo" && actual === "interval") return true;
  return false;
}

function sessionTitle(kind: MobileSessionKind): string {
  switch (kind) {
    case "rest": return "休息";
    case "recovery": return "恢复跑";
    case "easy": return "轻松跑";
    case "long_run": return "长距离";
    case "tempo": return "节奏跑";
    case "interval": return "间歇跑";
  }
}

function isTaper(input: CoachInput): boolean {
  if (!input.raceTarget) return false;
  const days = daysUntil(input.today, input.raceTarget.date);
  return days != null && days >= 0 && days <= 14;
}

function daysUntil(today: string, target: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return null;
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

function daysInclusive(start: string, end: string): number {
  return Math.max(1, daysUntil(start, end)! + 1);
}

function weekEnd(today: string): string {
  const value = new Date(`${today}T00:00:00Z`);
  const mondayOffset = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - mondayOffset + 6);
  return value.toISOString().slice(0, 10);
}

/** V2 decision entry: recovery readings are not part of the decision contract. */
export function decideVerdictFromSnapshots(context: Omit<CoachInput,
  "lastNightSleepMinutes"|"sleepBaselineMinutes"|"morningHrvMs"|"hrvBaselineMs"|
  "restingHeartRateBpm"|"restingHeartRateBaselineBpm"|"nightsBelowSleepBaseline"|
  "recoveryEvidenceDate"|"recoveryEvidenceStatus">,
  readiness: import("@rai/contracts").ReadinessAssessmentResult): MobileVerdict {
  const assessment:RecoveryAssessment={coverage:readiness.coverage,assessment:readiness.assessment,
    reasonCodes:readiness.reasonCodes,sleepRatio:readiness.signals.sleep.ratio,hrvRatio:readiness.signals.hrv.ratio,
    sleepLow:readiness.signals.sleep.low,hrvLow:readiness.signals.hrv.low,
    restingHeartRateUp:readiness.signals.rhr.low,sleepStreak:readiness.sleepStreak};
  return decideVerdict({...context,lastNightSleepMinutes:null,sleepBaselineMinutes:null,morningHrvMs:null,hrvBaselineMs:null,
    restingHeartRateBpm:null,restingHeartRateBaselineBpm:null,nightsBelowSleepBaseline:0,
    recoveryEvidenceDate:readiness.localDate,recoveryEvidenceStatus:readiness.coverage==="none"?"unknown":"valid"},assessment);
}

/**
 * §13.3：把**同一次决策**投影成版本化输出。**纯翻译，不重算。**
 *
 * - `tone` / `reasons` 直接取自 `MobileVerdict`（reasons 就是它的 triggers）。
 * - `action` 来自决策自己报告的 `disposition`，不是比较课型倒推出来的。
 * - `inputSnapshotIds` 只放**真实存在**的身份：readiness 快照的
 *   `modelVersion`/`asOf`、它的 rule set、以及 fitness 快照日期。
 *   取不到的类别直接不出现 —— 不写空串占位，也不编 id。
 *
 * `action` 为 null 的判据见 `CoachDecisionV2.action` 的注释：六值枚举表达不了
 * "今天没有计划"。
 */
export function projectCoachDecisionV2(input: {
  context: CoachInput;
  verdict: MobileVerdict;
  disposition: CoachPlanDisposition;
  sessionKind: MobileSessionKind;
  readiness: import("@rai/contracts").ReadinessAssessmentResult | null;
  bundleId?: string | null;
}): CoachDecisionV2 {
  const { context, verdict, disposition, sessionKind, readiness } = input;
  const codes = verdict.reasonCodes ?? [];
  // 「今天有没有已保存的计划」是**事实**，不是从 action 反推出来的结论。
  // 独立审计用 829,440 组输入扫描发现：只按 disposition 判断会让"比赛日留白 + 无计划"
  // 走进 keep_plan 却又不带 no_stored_plan_today，与本文档写下的判据自相矛盾。
  const hasStoredPlan = context.storedWeekPlan.some((day) => day.localDate === context.today);
  // 证据不足在两个地方出现：reason code 与（狭义的）动作。审计指出把 collect_evidence
  // 放在最前面会吞掉一切（483,840/829,440，含 161,280 个"比赛日留白"），
  // 对比赛日说"去收集证据"是错的指令。所以它只在**唯一原因是证据不足**时才成为动作；
  // 其余情形它留在 reasons 里当正交标志。
  const evidenceOnly = codes.length > 0 && codes.every((code) => code === "insufficient_data");

  const action: CoachAction | null = (() => {
    switch (disposition) {
      case "no_stored_plan":
        // 六值枚举里没有"今天没有计划"：既没有可保留的，也没有可降阶的。
        return evidenceOnly ? "collect_evidence" : null;
      case "kept_stored_plan":
      case "stored_rest_kept":
        return "keep_plan";
      case "race_day_blank":
        // 比赛日本身就是承诺；即使没有周计划也不是"无计划"。
        return "keep_plan";
      case "downgraded_quality":
        // 按**最终处方**选词，而不是一律 reduce_intensity。
        // 扫描（829,440 组）显示非 green 时不会产出 tempo/interval，所以"其余一律
        // reduce_intensity"实际只落在 long_run 上 —— 而长跑被砍掉的是**量**，不是强度。
        if (sessionKind === "easy" || sessionKind === "recovery") return "easy_only";
        if (sessionKind === "rest") return "rest";
        if (sessionKind === "long_run") return "reduce_duration";
        return "reduce_intensity";
      case "downgraded_taper":
        // 注：taper 与预算钳制砍的都是**距离/量**。六值枚举里没有 reduce_volume，
        // 这里用最接近的 reduce_duration，并把这条局限记在 §13.3 的说明里，
        // 不另造一个方案没授权的枚举值。
        return "reduce_duration";
      case "downgraded_red_tone":
        return sessionKind === "rest" ? "rest" : "easy_only";
      case "budget_limited":
        return "reduce_duration";
      case "budget_exhausted":
        // 审计指出这里原先一律 reduce_duration，但该分支可能直接给出休息
        // （"本周预算已完成"/"保留恢复"）—— 处方式是休息时说要"缩短时长"是错的。
        return sessionKind === "rest" ? "rest" : "reduce_duration";
    }
  })();

  const reasons = [
    // 「今天有没有已保存的计划」是**事实**，所以它对每一种 disposition 都如实出现，
    // 包括比赛日：比赛日没有周计划时同样要说出"没有已保存的计划"，
    // 否则读的人会以为 keep_plan 是因为保住了一份并不存在的计划。
    ...(hasStoredPlan
      ? []
      : [{ code: "no_stored_plan_today", params: { localDate: context.today } }]),
    { code: `plan_disposition_${disposition}`, params: { sessionKind } },
    ...(evidenceOnly && action !== "collect_evidence"
      ? [{ code: "evidence_insufficient_not_actionable", params: { codeCount: codes.length } }]
      : []),
    ...verdict.triggers.map((item) => ({
      code: item.code,
      params: { value: item.value, threshold: item.threshold }
    }))
  ];

  const inputSnapshotIds: string[] = [];
  if (readiness !== null) {
    inputSnapshotIds.push(`readiness:${readiness.modelVersion}@${readiness.asOf}`);
    inputSnapshotIds.push(`readiness_ruleset:${readiness.stateEvidence.ruleSetVersion}`);
  }
  if (context.snapshotDate !== null) inputSnapshotIds.push(`fitness:${context.snapshotDate}`);

  return {
    version: COACH_MODEL_VERSION,
    // 没有发布记录时给一个**显式占位**，而不是编造一个看起来像 id 的字符串。
    bundleId: input.bundleId ?? "no_active_release_bundle",
    tone: verdict.tone,
    action,
    reasons,
    inputSnapshotIds
  };
}
