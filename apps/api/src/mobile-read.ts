import { loadDatedReadiness } from "@rai/application";
import { decideVerdictFromSnapshots } from "./mobile-coach.js";
import type { DatabaseSync } from "node:sqlite";
import { readinessStateEvidence } from "@rai/readiness";

import { applyRacePlanPolicy } from "./weekly-plan-validate.js";
import { DEFAULT_WEEKLY_DISTANCE_KM } from "./mobile-goals.js";
import type {
  DashboardResponse,
  MobileCoverage,
  MobileGoalsResponse,
  MobileNextSession,
  MobilePlanAudit,
  MobilePlannedDay,
  MobilePlanSource,
  MobileRaceDistance,
  MobileSessionKind,
  MobileTodayResponse,
  MobileWorkoutPlanDay,
  MobileWorkoutPlanResponse,
  TrainingZonesCurrentResponse,
  WorkoutListItem
} from "@rai/api-contracts";
import { DATABASE_TIMEZONE, ISO_UTC_OFFSET, type DailyTrainingMetric } from "@rai/contracts";
import { SqliteRecoveryFactsReadRepository } from "@rai/storage-sqlite";
import { classifyPhysState, countNightsBelowSleepBaseline } from "@rai/training-load";
import { loadRaceReadiness } from "@rai/application";

import {
  assessRecovery,
  buildAbilityCard,
  buildInjuryFlags,
  buildPostRun,
  buildRaceCard,
  buildRecommendation,
  buildRecovery,
  buildWeekPlan,
  buildWeekStructure,
  calibrationMessage,
  decideDayPhase,
  decideNextSession,
  decideNextSessionDecision,
  projectCoachDecisionV2,
  decideVerdict,
  DEFAULT_EASY_DURATION_FLOOR,
  DEFAULT_QUALITY_SESSION_CAP,
  isEasySession,
  isQualitySession,
  lockState,
  plannedDayNumbers,
  resolveLockedNextSession,
  sessionRanges,
  type CoachInput,
  type CoachLatestWorkout,
  type CoachZonePrescription
} from "./mobile-coach.js";

interface ZoneExposureRow {
  zone: string;
  durationSeconds: number;
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[index] ?? null;
};

const shanghaiInstant = (date: string, hour: number): string =>
  new Date(`${date}T${String(hour).padStart(2, "0")}:00:00${ISO_UTC_OFFSET}`).toISOString();

const shiftDate = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const RACE_TARGETS: Record<MobileRaceDistance, { weeklyDistanceKm: number; longestRunKm: number }> = {
  five_k: { weeklyDistanceKm: 15, longestRunKm: 8 },
  ten_k: { weeklyDistanceKm: 25, longestRunKm: 12 },
  half_marathon: { weeklyDistanceKm: 35, longestRunKm: 18 }
};

/**
 * Says which night a recovery breakdown describes.
 *
 * A night that woke today is today's evidence. An older one is a reference the
 * app may still show, and prefixing it with "依据 X 的恢复数据" read as if X were
 * today's reading — the same mistake the sync status used to make by treating a
 * missing night as an expired dataset. An unassessable day adds no warning.
 */
const recoveryNote = (
  note: string,
  coverage: "none" | "partial" | "complete",
  latestNightDate: string | null
): string => {
  if (coverage !== "none") return latestNightDate ? `依据 ${latestNightDate} 的恢复数据；${note}` : note;
  if (latestNightDate) return `最近一次恢复记录是 ${latestNightDate}，未参与今日安排；${note}`;
  return note;
};

export function assembleMobileCoach(args: {
  database: DatabaseSync;
  dashboard: DashboardResponse;
  latestMetric: DailyTrainingMetric | null;
  recentMetrics: DailyTrainingMetric[];
  zones: TrainingZonesCurrentResponse | null;
  recentWorkouts: WorkoutListItem[];
  week: MobileTodayResponse["week"];
  weekDaily: MobileTodayResponse["weekDaily"];
  today: string;
  latestDataDate: string | null;
  goals: Pick<
    MobileGoalsResponse,
    "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget" | "weekPlan" | "lockedSession"
  >;
  /** Per-metric record coverage, so the assessment can report the newest observation that exists. */
  coverage: MobileCoverage;
  fourWeekDistanceChangeFraction: number | null;
  previousWeekDistanceKm: number;
}): Pick<
  MobileTodayResponse,
  | "ability"
  | "calibration"
  | "verdict"
  | "nextSession"
  | "decision"
  | "recovery"
  | "recoveryAssessment"
  | "readinessSnapshot"
  | "recommendation"
  | "postRun"
  | "weekStructure"
  | "race"
  | "injuryFlags"
  | "weekPlan"
  | "phase"
  | "lock"
> {
  const { database, dashboard, latestMetric, recentMetrics, zones, recentWorkouts, week, weekDaily, today } = args;
  const latestWorkout = recentWorkouts[0] ?? dashboard.latestWorkout;
  const coachWorkout = latestWorkout
    ? loadLatestCoachWorkout(database, latestWorkout)
    : null;
  const weekSessions = loadWeekSessions(database, week.periodStart, week.periodEnd);
  const recoveryFacts = new SqliteRecoveryFactsReadRepository(database);
  // Keep sleep, overnight HRV and RHR on the same evidence date. Imports may
  // lag behind the wall clock; compare that evidence with its own prior baseline.
  const currentNight = recoveryFacts.loadRecentMainNights(today, 1, DATABASE_TIMEZONE)[0] ?? null;
  const recoveryDate = currentNight?.wakeDate ?? today;
  // Only a night that woke up today describes today. An older-but-recent night is
  // still reported as the historical reference (`recoveryDate`), but it must not
  // populate today's readings: `lastNightSleepMinutes` cannot carry a value from
  // an earlier night, and HRV/RHR are read from that night's own window.
  const nightIsToday = currentNight?.wakeDate === today;
  const factsBaseline = recoveryFacts.loadBaselines(shanghaiInstant(recoveryDate, 12), DATABASE_TIMEZONE);
  const currentHrv = nightIsToday && currentNight ? recoveryFacts.loadHrvDay(currentNight.wakeDate, DATABASE_TIMEZONE) : null;
  // The "three low nights" streak is anchored to today's calendar rather than to
  // the newest recorded night. Anchoring it to the newest night skipped gap days
  // silently, so three low nights spread over weeks were counted as one streak.
  const sleep = {
    lastNight: nightIsToday && currentNight ? currentNight.asleepUnionMinutes ?? null : null,
    baseline: factsBaseline.sleepMinutes,
    nightsBelow: countNightsBelowSleepBaseline(
      [0, 1, 2].map((offset) => recoveryFacts.loadCanonicalNight(shiftDate(today, -offset), DATABASE_TIMEZONE)),
      factsBaseline.sleepMinutes
    )
  };
  const hrv = { current: currentHrv?.hrvSdnnMs ?? null, baseline: factsBaseline.hrvSdnnMs };
  const rhrCurrent = nightIsToday
    ? recoveryFacts.loadRhrMedian(shanghaiInstant(today, 0), shanghaiInstant(shiftDate(today, 1), 0))
    : null;
  const rhr = { current: rhrCurrent, baseline: factsBaseline.rhrBpm };
  const recoveryEvidenceStatus: CoachInput["recoveryEvidenceStatus"] =
    currentNight == null
      ? "unknown"
      : !nightIsToday
        ? "stale"
        : sleep.lastNight != null && hrv.current != null && rhr.current != null
          ? "valid"
          : "partial";
  const physState = classifyPhysState({ sleepMinutes: sleep.lastNight, sleepBaselineMinutes: sleep.baseline, hrvSdnnMs: hrv.current, hrvBaselineMs: hrv.baseline, rhrBpm: rhr.current, rhrBaselineBpm: rhr.baseline, nightsBelowSleepBaseline: sleep.nightsBelow });
  const qualityDays = consecutiveQualityDays(weekSessions.recentByDate, args.latestDataDate ?? today);
  const asOf = `${(args.latestDataDate ?? today)}T16:00:00.000Z`;
  let readiness: { five_k?: number; ten_k?: number; half_marathon?: number } = {};
  try {
    readiness = loadRaceReadiness(database, asOf);
  } catch {
    readiness = {};
  }
  const raceDistance = args.goals.raceTarget?.distance ?? "ten_k";
  const raceTargetKm = RACE_TARGETS[raceDistance];
  const weeklyDistance8w = recentMetrics.slice(-56).reduce((sum, day) => sum + day.distanceMeters / 1000, 0) / 8;
  const longest8w = Math.max(0, ...recentMetrics.map((day) => day.distanceMeters / 1000), weekSessions.longestRunKm);
  const input: CoachInput = {
    today,
    latestDataDate: args.latestDataDate,
    recoveryEvidenceStatus,
    recoveryEvidenceDate: currentNight?.wakeDate ?? null,
    calibration: dashboard.calibration.status,
    eligibleSessions: dashboard.calibration.eligibleSessions,
    trueAbility: dashboard.latestSnapshot?.trueAbility ?? null,
    currentAbility: coachWorkout?.currentAbility ?? latestWorkout?.currentAbility ?? null,
    changeFrom7DaysAgo: dashboard.latestSnapshot?.changeFrom7DaysAgo ?? null,
    growthVelocityPerWeek: dashboard.latestSnapshot?.growthVelocityPerWeek ?? null,
    decayPoints: dashboard.latestSnapshot?.decayPoints ?? 0,
    snapshotDate: dashboard.latestSnapshot?.localDate ?? null,
    explanationCodes: dashboard.explanationCodes,
    trainingStatus: latestMetric?.trainingStatus ?? null,
    loadRatio: latestMetric?.loadRatio ?? null,
    rampRate: latestMetric?.rampRate ?? null,
    strain: latestMetric?.strain ?? null,
    strainP90: percentile(
      recentMetrics.map((item) => item.strain).filter((value): value is number => value != null),
      0.9
    ),
    monotony: latestMetric?.monotony ?? null,
    recoveryEvidence: latestMetric?.recoveryEvidence ?? null,
    lastNightSleepMinutes: sleep.lastNight,
    sleepBaselineMinutes: sleep.baseline,
    nightsBelowSleepBaseline: sleep.nightsBelow,
    morningHrvMs: hrv.current,
    hrvBaselineMs: hrv.baseline,
    restingHeartRateBpm: rhr.current,
    restingHeartRateBaselineBpm: rhr.baseline,
    consecutiveQualityDays: qualityDays.consecutive,
    daysSinceLastRun: qualityDays.daysSinceLastRun,
    daysSinceLastQuality: qualityDays.daysSinceLastQuality,
    weekDistanceKm: week.distanceKm,
    weekDurationSeconds: week.durationSeconds,
    weekEasyDurationSeconds: weekSessions.easyDurationSeconds,
    weekQualityCount: weekSessions.qualityCount,
    weeklyDistanceGoalKm: week.goalDistanceKm,
    easyDurationFloorFraction: args.goals.easyDurationFloorFraction ?? DEFAULT_EASY_DURATION_FLOOR,
    qualitySessionCap: args.goals.qualitySessionCap ?? DEFAULT_QUALITY_SESSION_CAP,
    fourWeekDistanceChangeFraction: args.fourWeekDistanceChangeFraction,
    previousWeekDistanceKm: args.previousWeekDistanceKm,
    currentWeekDistanceKm: week.distanceKm,
    longestRun8WeekKm: longest8w,
    latestLongRunKm: weekSessions.latestLongRunKm,
    intendedEasyCount: weekSessions.intendedEasyCount,
    easyEnoughCount: weekSessions.easyEnoughCount,
    latestWorkout: coachWorkout,
    zones: zonePrescription(zones),
    raceTarget: args.goals.raceTarget,
    raceShapeScore: readiness[raceDistance] ?? null,
    raceVolumeFraction: raceTargetKm.weeklyDistanceKm > 0
      ? Math.min(1, weeklyDistance8w / raceTargetKm.weeklyDistanceKm)
      : null,
    raceLongRunFraction: raceTargetKm.longestRunKm > 0
      ? Math.min(1, longest8w / raceTargetKm.longestRunKm)
      : null,
    weekDaily: weekDaily.map((day) => ({
      ...day,
      workoutId: weekSessions.firstWorkoutByDate.get(day.localDate) ?? null
    })),
    todayWorkoutCount: weekDaily.find((day) => day.localDate === today)?.workoutCount ?? 0,
    storedWeekPlan: args.goals.weekPlan ?? [],
    lockedSession: args.goals.lockedSession ?? null
  };

  const calibration: MobileTodayResponse["calibration"] = {
    status: dashboard.calibration.status,
    eligibleSessions: dashboard.calibration.eligibleSessions,
    eligibleDurationMinutes: dashboard.calibration.eligibleDurationMinutes,
    spanDays: dashboard.calibration.spanDays,
    highCoverageSessions: dashboard.calibration.highCoverageSessions,
    requirements: dashboard.calibration.requirements,
    message: calibrationMessage(
      dashboard.calibration.status,
      dashboard.calibration.eligibleSessions,
      dashboard.calibration.requirements.sessions
    )
  };
  // One assessment, two consumers: the verdict gates read it, and it is published
  // as `recoveryAssessment`. Computing it twice is how "what the app explains"
  // and "what the coach decided" drift apart.
  const v4 = database.prepare(`SELECT f.feature_schema_version AS schema FROM active_model_run a
    JOIN model_runs m ON m.id=a.model_run_id JOIN feature_runs f ON f.id=m.feature_run_id`).get()?.schema === "workout-feature-v4";
  const now = new Date().toISOString();
  const dated = v4 ? loadDatedReadiness(database, now, DATABASE_TIMEZONE) : null;
  if (dated) {
    // Presentation and decision consume the same eligible observations. A future,
    // stale or unknown-arrival reading may remain in history, never today's card.
    input.lastNightSleepMinutes = dated.signals.sleep.value;
    input.sleepBaselineMinutes = dated.signals.sleep.baseline;
    input.morningHrvMs = dated.signals.hrv.value;
    input.hrvBaselineMs = dated.signals.hrv.baseline;
    input.restingHeartRateBpm = dated.signals.rhr.value;
    input.restingHeartRateBaselineBpm = dated.signals.rhr.baseline;
    input.nightsBelowSleepBaseline = dated.sleepStreak ? 3 : 0;
  }
  const recoveryBreakdown = buildRecovery(input);
  const assessment = dated ? {
    coverage:dated.coverage,assessment:dated.assessment,reasonCodes:dated.reasonCodes,
    sleepRatio:dated.signals.sleep.ratio,hrvRatio:dated.signals.hrv.ratio,
    sleepLow:dated.signals.sleep.low,hrvLow:dated.signals.hrv.low,restingHeartRateUp:dated.signals.rhr.low,sleepStreak:dated.sleepStreak
  } : assessRecovery(input);
  const verdict = dated ? decideVerdictFromSnapshots(input,dated) : decideVerdict(input, assessment);
  // §13.3：处方与**它走了哪条分支**一起取回来 —— disposition 由决策自己报告，
  // 版本化输出据此投影，不去比较课型倒推（见 projectCoachDecisionV2 的说明）。
  const { session: computed, disposition } = decideNextSessionDecision(input, verdict);
  const nextSession = resolveLockedNextSession(computed, input.lockedSession, today, input.zones);
  const lock = lockState(input.lockedSession, today, verdict.tone);
  lock.candidate = computed;
  const planned = input.storedWeekPlan.find(day => day.localDate === today) ?? null;
  const prescriptionKey = (session: MobileNextSession) => JSON.stringify([session.kind, session.distanceKm, session.structure,
    session.paceSecondsPerKmLower, session.paceSecondsPerKmUpper, session.heartRateBpmLower, session.heartRateBpmUpper]);
  if (lock.present && prescriptionKey(computed) !== prescriptionKey(nextSession)) lock.relockSuggested = true;
  const todayWorkoutCount = input.todayWorkoutCount;
  const postRunWorkout = coachWorkout && coachWorkout.localDate === today ? coachWorkout : null;
  // The newest recovery observation that exists, even when it is not today's.
  const observationDates = [
    args.coverage.sleep.latestDate,
    args.coverage.hrv.latestDate,
    args.coverage.restingHeartRate.latestDate
  ].filter((value): value is string => value != null);
  return {
    ...(dated ? { readinessSnapshot: dated } : {}),
    ability: buildAbilityCard(input),
    calibration,
    verdict,
    nextSession,
    // §13.3：同一次决策的版本化投影。**旧字段一个没动** —— tone 与 verdict 同源，
    // action 来自 disposition，所以这不是第二套算法，也不进入 recommendationRevision
    // 的哈希（那份哈希只吃 verdict/nextSession/candidate）。
    decision: projectCoachDecisionV2({
      context: input,
      verdict,
      disposition,
      sessionKind: computed.kind,
      readiness: dated
    }),
    recovery: {
      ...recoveryBreakdown,
      note: recoveryNote(recoveryBreakdown.note, assessment.coverage, currentNight?.wakeDate ?? null),
      state: dated
        ? dated.state === "strained" ? "depleted" : dated.state === "caution" ? "reduced"
          : dated.coverage === "complete" && dated.state === "no_low_signal" ? "recovered" : "unknown"
        : physState === "recovered_phys" ? "recovered" : physState,
      hrvSampleCount: currentHrv?.sampleCount ?? 0
    },
    recoveryAssessment: {
      stateEvidence: readinessStateEvidence(),
      intendedUse: "training_guidance_not_diagnosis",
      targetDate: assessment.coverage === "none" ? null : today,
      coverage: assessment.coverage,
      assessment: assessment.assessment,
      reasonCodes: assessment.reasonCodes,
      lastObservationDate: observationDates.length === 0 ? null : observationDates.sort().at(-1)!
    },
    recommendation: {
      ...buildRecommendation(input, assessment, verdict),
      plannedKind: planned?.kind ?? null,
      effectiveKind: nextSession.kind,
      adjustmentReason: recommendationAdjustmentReason(planned, computed)
    },
    postRun: buildPostRun(
      postRunWorkout,
      input.trueAbility,
      today,
      nextSession.kind,
      verdict.tone
    ),
    weekStructure: buildWeekStructure(input),
    race: buildRaceCard(input),
    injuryFlags: buildInjuryFlags(input),
    weekPlan: buildWeekPlan(input, nextSession),
    phase: decideDayPhase({
      today,
      latestDataDate: args.latestDataDate,
      todayWorkoutCount,
      nextKind: nextSession.kind,
      lockPresent: lock.present
    }),
    lock
  };
}

export function recommendationAdjustmentReason(
  planned: MobilePlannedDay | null,
  computed: MobileNextSession
): string | null {
  if (planned === null) return computed.reason;
  const plannedKey = JSON.stringify([planned.kind, planned.distanceKm, planned.structure ?? null]);
  const computedKey = JSON.stringify([computed.kind, computed.distanceKm, computed.structure]);
  return plannedKey === computedKey ? null : computed.reason;
}

export function zonePrescription(zones: TrainingZonesCurrentResponse | null): CoachZonePrescription | null {
  const profile = zones?.profile;
  if (!profile) return null;
  const easyPace = profile.paceBands.find((band) => band.zone === "easy");
  const thresholdPace = profile.paceBands.find((band) => band.zone === "lactate_threshold");
  const intervalPace = profile.paceBands.find((band) => band.zone === "anaerobic_endurance");
  const easyHr = profile.heartRateBands.find((band) => band.zone === "aerobic_base");
  const recoveryHr = profile.heartRateBands.find((band) => band.zone === "recovery");
  const thresholdHr = profile.heartRateBands.find((band) => band.zone === "lactate_threshold");
  return {
    easyPaceLower: easyPace?.lowerSecondsPerKm ?? null,
    easyPaceUpper: easyPace?.upperSecondsPerKm ?? null,
    easyHrLower: recoveryHr?.lowerBpm ?? easyHr?.lowerBpm ?? null,
    easyHrUpper: easyHr?.upperBpm ?? recoveryHr?.upperBpm ?? null,
    thresholdPaceLower: thresholdPace?.lowerSecondsPerKm ?? null,
    thresholdPaceUpper: thresholdPace?.upperSecondsPerKm ?? null,
    thresholdHrLower: thresholdHr?.lowerBpm ?? null,
    thresholdHrUpper: thresholdHr?.upperBpm ?? null,
    intervalPaceLower: intervalPace?.lowerSecondsPerKm ?? null,
    intervalPaceUpper: intervalPace?.upperSecondsPerKm ?? null
  };
}

export const WORKOUT_PLAN_WINDOW_DAYS = 7;

/**
 * Builds the executable week the device syncs into the system workout app.
 *
 * Today always comes from the coach (gate resolved, lock applied); later days
 * come from the persisted weekly plan. Numbers are always re-measured from the
 * structure — through the same helper `/v1/mobile/today` uses — so a
 * prescription can never contradict its own distance, and the two endpoints can
 * never contradict each other.
 */
export function assembleMobileWorkoutPlan(args: {
  raceTarget?: import("@rai/api-contracts").MobileRaceTarget | null;
  weeklyDistanceKm?: number;
  relockSuggested?: boolean;
  today: string;
  todaySession: MobileNextSession;
  todayCompleted: boolean;
  storedPlan: MobilePlannedDay[];
  zones: TrainingZonesCurrentResponse | null;
  audit: MobilePlanAudit | null;
  planRevision: number;
  windowDays?: number;
}): MobileWorkoutPlanResponse {
  const windowDays = Math.max(1, args.windowDays ?? WORKOUT_PLAN_WINDOW_DAYS);
  const prescription = zonePrescription(args.zones);
  const source: MobilePlanSource = args.audit?.generatedBy ?? "heuristic";
  const windowEnd = shiftDate(args.today, windowDays - 1);

  const days: MobileWorkoutPlanDay[] = [
    planDayFromSession(args.today, args.todaySession, prescription, source, !args.todayCompleted && !args.relockSuggested)
  ];

  for (const planned of applyRacePlanPolicy(args.storedPlan, args.raceTarget, args.weeklyDistanceKm ?? DEFAULT_WEEKLY_DISTANCE_KM, prescription)
    .filter((day) => day.localDate > args.today && day.localDate <= windowEnd)
    .sort((left, right) => left.localDate.localeCompare(right.localDate))) {
    const numbers = plannedDayNumbers(planned.kind, planned.structure, planned.distanceKm, prescription);
    days.push({
      localDate: planned.localDate,
      kind: planned.kind,
      title: sessionTitle(planned.kind),
      reason: planned.reason ?? "",
      distanceKm: numbers.distanceKm,
      durationMinutes: numbers.durationMinutes,
      ...sessionRanges(planned.kind, prescription),
      structure: numbers.structure,
      source,
      executable: numbers.structure != null && planned.kind !== "rest"
    });
  }

  // Keep the export window explicit; missing dates are not hidden or invented training.
  for (let offset = 1; offset < windowDays; offset++) {
    const localDate = shiftDate(args.today, offset);
    if (!days.some(day => day.localDate === localDate)) days.push({
      localDate, kind: "rest", title: "未生成", reason: "尚无课表，不安排训练。", distanceKm: null, durationMinutes: null,
      paceSecondsPerKmLower: null, paceSecondsPerKmUpper: null, heartRateBpmLower: null, heartRateBpmUpper: null,
      structure: null, source, executable: false
    });
  }
  days.sort((a, b) => a.localDate.localeCompare(b.localDate));
  return {
    windowStart: args.today,
    windowEnd,
    generatedAt: new Date().toISOString(),
    timezone: DATABASE_TIMEZONE,
    windowDays: days.length,
    planRevision: args.planRevision,
    audit: args.audit,
    days
  };
}

function planDayFromSession(
  localDate: string,
  session: MobileNextSession,
  prescription: CoachZonePrescription | null,
  source: MobilePlanSource,
  executable: boolean
): MobileWorkoutPlanDay {
  const numbers = plannedDayNumbers(session.kind, session.structure, session.distanceKm, prescription);
  return {
    localDate,
    kind: session.kind,
    title: session.title,
    reason: session.reason,
    distanceKm: numbers.distanceKm,
    durationMinutes: numbers.durationMinutes,
    paceSecondsPerKmLower: session.paceSecondsPerKmLower,
    paceSecondsPerKmUpper: session.paceSecondsPerKmUpper,
    heartRateBpmLower: session.heartRateBpmLower,
    heartRateBpmUpper: session.heartRateBpmUpper,
    structure: numbers.structure,
    source,
    executable: executable && numbers.structure != null && session.kind !== "rest"
  };
}

function sessionTitle(kind: MobileSessionKind): string {
  switch (kind) {
    case "rest": return "休息";
    case "recovery": return "恢复跑";
    case "easy": return "轻松跑";
    case "long_run": return "长距离";
    case "tempo": return "节奏 / 阈值";
    case "interval": return "间歇 / VO₂";
    default: return kind;
  }
}

function loadLatestCoachWorkout(database: DatabaseSync, workout: WorkoutListItem): CoachLatestWorkout {
  const row = database.prepare(`
    SELECT
      a.updated_true_ability,
      a.true_ability_after,
      a.true_ability_delta,
      a.current_ability,
      a.explanation_codes_json,
      f.missing_reasons_json,
      f.heart_rate_coverage,
      zs.heart_rate_exposure_json,
      load.local_date
    FROM active_ability_assessments a
    JOIN workout_features f ON f.id = a.feature_id
    JOIN active_workout_training_loads load ON load.training_session_id = a.training_session_id
    LEFT JOIN active_workout_zone_summaries zs ON zs.training_session_id = a.training_session_id
    WHERE a.training_session_id = ?
  `).get(workout.id) as Record<string, unknown> | undefined;
  const exposures = parseJson<ZoneExposureRow[]>(row?.heart_rate_exposure_json, []);
  const total = exposures.reduce((sum, item) => sum + Number(item.durationSeconds ?? 0), 0);
  const fraction = (zones: Set<string>): number | null => {
    if (total <= 0) return null;
    const seconds = exposures
      .filter((item) => zones.has(item.zone))
      .reduce((sum, item) => sum + Number(item.durationSeconds ?? 0), 0);
    return seconds / total;
  };
  return {
    id: workout.id,
    startedAt: workout.startedAt,
    localDate: row?.local_date != null ? String(row.local_date) : workout.startedAt.slice(0, 10),
    sessionType: workout.sessionType,
    stimulusType: workout.stimulusType,
    indoor: workout.indoor,
    currentAbility: nullable(row?.current_ability) ?? workout.currentAbility,
    trueAbilityAfter: nullable(row?.true_ability_after),
    trueAbilityDelta: nullable(row?.true_ability_delta) ?? workout.trueAbilityDelta,
    updatedTrueAbility: Number(row?.updated_true_ability ?? 0) === 1,
    explanationCodes: parseJson<string[]>(row?.explanation_codes_json, workout.missingReasons),
    missingReasons: parseJson<string[]>(row?.missing_reasons_json, workout.missingReasons),
    heartRateCoverage: nullable(row?.heart_rate_coverage),
    easyHeartRateFraction: fraction(new Set(["recovery", "aerobic_base"])),
    thresholdHeartRateFraction: fraction(new Set(["lactate_threshold", "anaerobic"]))
  };
}

function loadWeekSessions(database: DatabaseSync, start: string, end: string): {
  easyDurationSeconds: number;
  qualityCount: number;
  intendedEasyCount: number;
  easyEnoughCount: number;
  longestRunKm: number;
  latestLongRunKm: number | null;
  firstWorkoutByDate: Map<string, string>;
  recentByDate: Map<string, { sessionType: string; stimulusType: string }>;
} {
  const rows = database.prepare(`
    SELECT
      load.training_session_id,
      load.local_date,
      load.session_type,
      load.stimulus_type,
      load.distance_km,
      load.duration_seconds,
      zs.heart_rate_exposure_json
    FROM active_workout_training_loads load
    LEFT JOIN active_workout_zone_summaries zs ON zs.training_session_id = load.training_session_id
    WHERE load.local_date >= date(?, '-21 days') AND load.local_date <= ?
    ORDER BY load.local_date, load.training_session_id
  `).all(start, end) as unknown as Array<Record<string, unknown>>;

  let easyDurationSeconds = 0;
  let qualityCount = 0;
  let intendedEasyCount = 0;
  let easyEnoughCount = 0;
  let longestRunKm = 0;
  let latestLongRunKm: number | null = null;
  const firstWorkoutByDate = new Map<string, string>();
  const recentByDate = new Map<string, { sessionType: string; stimulusType: string }>();

  for (const row of rows) {
    const localDate = String(row.local_date);
    const sessionType = String(row.session_type ?? "unknown");
    const stimulusType = String(row.stimulus_type ?? "unclassified");
    const distanceKm = Number(row.distance_km ?? 0);
    recentByDate.set(localDate, { sessionType, stimulusType });
    if (localDate >= start && localDate <= end && !firstWorkoutByDate.has(localDate)) {
      firstWorkoutByDate.set(localDate, String(row.training_session_id));
    }
    longestRunKm = Math.max(longestRunKm, distanceKm);
    if (sessionType === "long_run" || distanceKm >= 15) latestLongRunKm = distanceKm;
    if (localDate < start || localDate > end) continue;
    if (isQualitySession(sessionType, stimulusType)) qualityCount += 1;
    const duration = Number(row.duration_seconds ?? 0);
    const exposures = parseJson<ZoneExposureRow[]>(row.heart_rate_exposure_json, []);
    const total = exposures.reduce((sum, item) => sum + Number(item.durationSeconds ?? 0), 0);
    const easySeconds = exposures
      .filter((item) => item.zone === "recovery" || item.zone === "aerobic_base")
      .reduce((sum, item) => sum + Number(item.durationSeconds ?? 0), 0);
    if (total > 0) easyDurationSeconds += easySeconds;
    else if (isEasySession(sessionType)) easyDurationSeconds += duration;
    if (isEasySession(sessionType)) {
      intendedEasyCount += 1;
      if (total > 0 ? easySeconds / total >= 0.8 : true) easyEnoughCount += 1;
    }
  }

  return {
    easyDurationSeconds,
    qualityCount,
    intendedEasyCount,
    easyEnoughCount,
    longestRunKm,
    latestLongRunKm,
    firstWorkoutByDate,
    recentByDate
  };
}

function consecutiveQualityDays(
  byDate: Map<string, { sessionType: string; stimulusType: string }>,
  asOf: string
): { consecutive: number; daysSinceLastRun: number | null; daysSinceLastQuality: number | null } {
  let consecutive = 0;
  let seenRun = false;
  let streakAlive = true;
  let daysSinceLastRun: number | null = null;
  let daysSinceLastQuality: number | null = null;
  for (let offset = 0; offset < 21; offset += 1) {
    const date = shiftDate(asOf, -offset);
    const session = byDate.get(date);
    if (!session) {
      if (seenRun) streakAlive = false;
      continue;
    }
    seenRun = true;
    if (daysSinceLastRun == null) daysSinceLastRun = offset;
    const quality = isQualitySession(session.sessionType);
    if (quality && daysSinceLastQuality == null) daysSinceLastQuality = offset;
    if (streakAlive && quality) consecutive += 1;
    else streakAlive = false;
  }
  return { consecutive, daysSinceLastRun, daysSinceLastQuality };
}

function nullable(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
