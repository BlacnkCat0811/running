import type {
  MobileAbilityCard,
  MobileCalibrationCard,
  MobileDayPhase,
  MobileInjuryFlag,
  MobileLockedSession,
  MobileLockState,
  MobileNextSession,
  MobilePostRunVerdict,
  MobileRaceCard,
  MobileRaceTarget,
  MobileRecoveryBreakdown,
  MobileSessionKind,
  MobileStimulusMatch,
  MobileTrigger,
  MobileVerdict,
  MobileWeekPlanDay,
  MobileWeekStructure
} from "@rai/api-contracts";
import type { TrainingStatusCode } from "@rai/contracts";

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
  recoveryEvidenceStatus?: "unknown" | "partial" | "valid" | "stale";
  recoveryEvidenceDate?: string | null;
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
  weeklyDistanceGoalKm: number | null;
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
  storedWeekPlan: Array<{ localDate: string; kind: MobileSessionKind; distanceKm: number | null }>;
  lockedSession: MobileLockedSession | null;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

export function abilityExplanation(input: CoachInput): string {
  if (input.calibration !== "completed") {
    return "校准中：有效训练还不够，先看趋势，不要把当前数字当成精确能力。";
  }
  if (input.decayPoints > 0) {
    return `停跑衰减中（${round1(input.decayPoints)} 点），与训练表现导致的变化分开看。`;
  }
  if (input.currentAbility != null && input.trueAbility != null) {
    const delta = input.currentAbility - input.trueAbility;
    if (Math.abs(delta) < 1.5) return "这次发挥接近真实能力。";
    if (delta > 0) return "这次发挥高于真实能力，更像短期状态波动，不是能力已经跳升。";
    return "这次发挥低于真实能力，更像疲劳、睡眠或环境，而不是能力退步。";
  }
  if (input.changeFrom7DaysAgo != null && Math.abs(input.changeFrom7DaysAgo) >= 0.3) {
    return input.changeFrom7DaysAgo > 0
      ? `近 7 日真实能力 +${round1(input.changeFrom7DaysAgo)}。`
      : `近 7 日真实能力 ${round1(input.changeFrom7DaysAgo)}。`;
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

export function decideVerdict(input: CoachInput): MobileVerdict {
  const triggers: MobileTrigger[] = [];
  // Judge the available evidence, independently of the workout/import date.
  const recoveryUnavailable = input.lastNightSleepMinutes == null ||
    input.morningHrvMs == null || input.restingHeartRateBpm == null ||
    input.sleepBaselineMinutes == null || input.sleepBaselineMinutes <= 0 ||
    input.hrvBaselineMs == null || input.hrvBaselineMs <= 0 ||
    input.restingHeartRateBaselineBpm == null || input.restingHeartRateBaselineBpm <= 0;
  let tone: MobileVerdict["tone"] = "yellow";
  let title = "只宜有氧";
  let reason = "默认轻松跑。数据不足时不安排质量课。";

  const sleepRatio =
    input.lastNightSleepMinutes != null && input.sleepBaselineMinutes != null && input.sleepBaselineMinutes > 0
      ? input.lastNightSleepMinutes / input.sleepBaselineMinutes
      : null;
  const hrvRatio =
    input.morningHrvMs != null && input.hrvBaselineMs != null && input.hrvBaselineMs > 0
      ? input.morningHrvMs / input.hrvBaselineMs
      : null;
  const rhrUp =
    input.restingHeartRateBpm != null &&
    input.restingHeartRateBaselineBpm != null &&
    input.restingHeartRateBpm > input.restingHeartRateBaselineBpm * 1.03;
  const taper = isTaper(input);
  const highLoad =
    input.trainingStatus === "attention" ||
    input.trainingStatus === "high_load" ||
    (input.loadRatio != null && input.loadRatio > 1.3);
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
      triggers.push(trigger("load_ratio", round1(input.loadRatio), 1.3, `急性/慢性负荷比 ${round1(input.loadRatio)}`));
    }
  } else if (input.nightsBelowSleepBaseline >= 3) {
    tone = "red";
    title = "宜休息";
    reason = "连续三夜睡眠低于基线，今天休息。";
    triggers.push(trigger("sleep_streak", input.nightsBelowSleepBaseline, 3, reason));
  } else if (sleepRatio != null && sleepRatio < 0.75 && hrvRatio != null && hrvRatio < 0.85 && rhrUp) {
    tone = "red";
    title = "宜休息或轻松";
    reason = "睡眠、HRV 和静息心率同时变差。";
    triggers.push(trigger("sleep", round1(sleepRatio), 0.75, `睡眠为基线的 ${Math.round(sleepRatio * 100)}%`));
    triggers.push(trigger("hrv", round1(hrvRatio), 0.85, `HRV 为基线的 ${Math.round(hrvRatio * 100)}%`));
  } else if (
    (sleepRatio != null && sleepRatio < 0.75) ||
    (hrvRatio != null && hrvRatio < 0.85 && rhrUp)
  ) {
    tone = "yellow";
    title = "只宜有氧";
    reason = "恢复信号偏低，先跑轻松，不要上强度。";
    if (sleepRatio != null && sleepRatio < 0.75) {
      triggers.push(trigger("sleep", round1(sleepRatio), 0.75, `睡眠为基线的 ${Math.round(sleepRatio * 100)}%`));
    }
    if (hrvRatio != null && hrvRatio < 0.85) {
      triggers.push(trigger("hrv", round1(hrvRatio), 0.85, `HRV 为基线的 ${Math.round(hrvRatio * 100)}%`));
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
    triggers.push(trigger("easy_floor", round1(easyDurationFraction), input.easyDurationFloorFraction, reason));
  } else if (input.trainingStatus === "recovery" && (input.daysSinceLastRun ?? 0) >= 2) {
    tone = "yellow";
    title = "恢复跑";
    reason = "处于恢复阶段且停跑超过一天，先恢复跑再恢复量。";
    triggers.push(trigger("recovery_status", input.daysSinceLastRun, 2, reason));
  } else if (recoveryUnavailable) {
    tone = "yellow";
    title = "只宜有氧";
    reason = "睡眠、HRV、静息心率或个人基线不完整，先轻松跑或休息。";
    triggers.push(trigger("recovery_evidence_missing", null, null, reason));
  } else if (
    (input.trainingStatus === "effective_stimulus" || input.trainingStatus === "maintaining") &&
    (input.daysSinceLastQuality ?? 99) >= 2 &&
    input.weekQualityCount < input.qualitySessionCap &&
    (easyDurationFraction == null || easyDurationFraction >= input.easyDurationFloorFraction)
  ) {
    tone = "green";
    title = "可质量课";
    reason = "负荷与恢复允许一次质量刺激。";
    triggers.push(trigger("quality_window", input.daysSinceLastQuality, 2, reason));
  } else {
    tone = "yellow";
    title = "只宜有氧";
    reason = "今天按轻松跑安排，把有氧底铺好。";
  }

  const reasonCodes = triggers.map((item) => item.code);
  return { tone, title, reason, triggers, stale: false, reasonCodes };
}

export function decideNextSession(input: CoachInput, verdict: MobileVerdict): MobileNextSession {
  const remainingKm =
    input.weeklyDistanceGoalKm == null ? null : Math.max(0, input.weeklyDistanceGoalKm - input.weekDistanceKm);
  const remainingDays = Math.max(1, daysInclusive(input.today, weekEnd(input.today)));
  const perDayKm = remainingKm == null ? 8 : Math.max(4, Math.min(14, remainingKm / remainingDays));
  const zones = input.zones;
  const taper = isTaper(input);

  if (verdict.tone === "red") {
    const hardRest =
      input.nightsBelowSleepBaseline >= 3 ||
      input.trainingStatus === "attention" ||
      input.todayWorkoutCount > 0;
    if (hardRest) {
      return session("rest", "今天的动作：休息", verdict.reason, null, null, null, null, null, null);
    }
    return session(
      "recovery",
      "恢复跑",
      verdict.reason,
      Math.min(8, round1(perDayKm * 0.7)),
      40,
      zones?.easyPaceLower ?? null,
      zones?.easyPaceUpper ?? null,
      zones?.easyHrLower ?? null,
      zones?.easyHrUpper ?? null
    );
  }

  if (taper) {
    const cap = input.longestRun8WeekKm > 0 ? input.longestRun8WeekKm * 0.85 : 10;
    return session(
      "easy",
      "减量轻松跑",
      "比赛临近：量降下来，不再拉新的最长距离。",
      round1(Math.min(cap, perDayKm * 0.7)),
      40,
      zones?.easyPaceLower ?? null,
      zones?.easyPaceUpper ?? null,
      zones?.easyHrLower ?? null,
      zones?.easyHrUpper ?? null
    );
  }

  if (verdict.tone === "green") {
    const sinceQuality = input.daysSinceLastQuality;
    const kind: MobileSessionKind = sinceQuality != null && sinceQuality >= 5 ? "interval" : "tempo";
    const title = kind === "interval" ? "间歇 / VO₂" : "节奏 / 阈值";
    return session(
      kind,
      title,
      verdict.reason,
      kind === "interval" ? 8 : 10,
      kind === "interval" ? 50 : 55,
      kind === "interval" ? zones?.intervalPaceLower ?? null : zones?.thresholdPaceLower ?? null,
      kind === "interval" ? zones?.intervalPaceUpper ?? null : zones?.thresholdPaceUpper ?? null,
      zones?.thresholdHrLower ?? null,
      zones?.thresholdHrUpper ?? null
    );
  }

  if (verdict.title.includes("恢复")) {
    return session(
      "recovery",
      "恢复跑",
      verdict.reason,
      Math.min(8, round1(perDayKm)),
      40,
      zones?.easyPaceLower ?? null,
      zones?.easyPaceUpper ?? null,
      zones?.easyHrLower ?? null,
      zones?.easyHrUpper ?? null
    );
  }

  return session(
    "easy",
    "轻松跑",
    verdict.reason,
    round1(Math.min(12, perDayKm)),
    50,
    zones?.easyPaceLower ?? null,
    zones?.easyPaceUpper ?? null,
    zones?.easyHrLower ?? null,
    zones?.easyHrUpper ?? null
  );
}

function session(
  kind: MobileSessionKind,
  title: string,
  reason: string,
  distanceKm: number | null,
  durationMinutes: number | null,
  paceLower: number | null,
  paceUpper: number | null,
  hrLower: number | null,
  hrUpper: number | null
): MobileNextSession {
  return {
    kind,
    title,
    reason,
    distanceKm,
    durationMinutes,
    paceSecondsPerKmLower: paceLower,
    paceSecondsPerKmUpper: paceUpper,
    heartRateBpmLower: hrLower,
    heartRateBpmUpper: hrUpper
  };
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
  return {
    score: null,
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
        : `本次${workout.trueAbilityDelta >= 0 ? "上调" : "下调"}真实能力 ${round1(Math.abs(workout.trueAbilityDelta))} 点。`
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
    },
    remainingDistanceKm:
      input.weeklyDistanceGoalKm == null ? null : Math.max(0, input.weeklyDistanceGoalKm - input.weekDistanceKm)
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
      detail: `rampRate ${round1(input.rampRate)}，阈值 0.5。`
    });
  }
  if (input.loadRatio != null && input.loadRatio > 1.5) {
    flags.push({
      code: "load_ratio",
      title: "急性负荷过高",
      detail: `急性/慢性负荷比 ${round1(input.loadRatio)}，阈值 1.5。`
    });
  }
  if (input.strain != null && input.strainP90 != null && input.strain > input.strainP90) {
    flags.push({
      code: "strain",
      title: "训练应激偏高",
      detail: `当前应激 ${round1(input.strain)}，高于近 56 日 90 分位 ${round1(input.strainP90)}。`
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
      detail: `最近长跑 ${round1(input.latestLongRunKm)} km，超过 8 周最长距离 20%。`
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
      detail: `单调性 ${round1(input.monotony)}，每天刺激太像。`
    });
  }
  return flags;
}

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
      note: "还没有目标赛事。设一个日期和距离后，首页会给出倒计时和专项形态。"
    };
  }
  const days = daysUntil(input.today, target.date);
  const taper = days != null && days >= 0 && days <= 14;
  const distanceLabel = target.distance === "five_k" ? "5 公里" : target.distance === "ten_k" ? "10 公里" : "半程马拉松";
  let note = days == null
    ? `${distanceLabel}目标已过期。`
    : `距 ${distanceLabel} 还有 ${days} 天。`;
  if (input.raceShapeScore != null && input.raceShapeScore < 0.55) {
    note += " 专项形态还不够：缺的是这条距离的周量和长课，不是再加 VO₂。";
  } else if (taper) {
    note += " 进入减量：量降 20–40%，不再拉新的最长距离。";
  } else if (input.raceShapeScore != null) {
    note += ` 专项形态 ${Math.round(input.raceShapeScore * 100)}%。能力够不等于这条距离练够。`;
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
        workoutCount: day.workoutCount
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
        workoutCount: 0
      };
    }
    if (day.localDate === input.today) {
      return {
        localDate: day.localDate,
        kind: next.kind,
        title: next.title,
        planned: true,
        completedWorkoutId: null,
        distanceKm: next.distanceKm ?? 0,
        workoutCount: 0
      };
    }
    const saved = stored.get(day.localDate);
    if (saved) {
      return {
        localDate: day.localDate,
        kind: saved.kind,
        title: sessionTitle(saved.kind),
        planned: true,
        completedWorkoutId: null,
        distanceKm: saved.distanceKm ?? 0,
        workoutCount: 0
      };
    }
    return {
      localDate: day.localDate,
      kind: "easy",
      title: "轻松跑（建议）",
      planned: true,
      completedWorkoutId: null,
      distanceKm: 0,
      workoutCount: 0
    };
  });
}

export function resolveLockedNextSession(
  computed: MobileNextSession,
  locked: MobileLockedSession | null,
  today: string
): MobileNextSession {
  if (locked && locked.localDate === today) return { ...locked.session, reason: computed.reason };
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
