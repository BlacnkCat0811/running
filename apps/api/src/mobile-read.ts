import type { DatabaseSync } from "node:sqlite";

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
import { DATABASE_TIMEZONE, ISO_UTC_OFFSET, healthTypes, localCalendarFormatter, type DailyTrainingMetric } from "@rai/contracts";
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

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : sorted[mid];
  return value ?? null;
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
  | "recovery"
  | "recoveryAssessment"
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
  const recoveryBreakdown = buildRecovery(input);
  // One assessment, two consumers: the verdict gates read it, and it is published
  // as `recoveryAssessment`. Computing it twice is how "what the app explains"
  // and "what the coach decided" drift apart.
  const assessment = assessRecovery(input);
  const verdict = decideVerdict(input, assessment);
  const computed = decideNextSession(input, verdict);
  const nextSession = resolveLockedNextSession(computed, input.lockedSession, today, input.zones);
  const lock = lockState(input.lockedSession, today, verdict.tone);
  const todayWorkoutCount = input.todayWorkoutCount;
  const postRunWorkout = coachWorkout && coachWorkout.localDate === today ? coachWorkout : null;
  // The newest recovery observation that exists, even when it is not today's.
  const observationDates = [
    args.coverage.sleep.latestDate,
    args.coverage.hrv.latestDate,
    args.coverage.restingHeartRate.latestDate
  ].filter((value): value is string => value != null);
  return {
    ability: buildAbilityCard(input),
    calibration,
    verdict,
    nextSession,
    recovery: {
      ...recoveryBreakdown,
      note: recoveryNote(recoveryBreakdown.note, assessment.coverage, currentNight?.wakeDate ?? null),
      state: physState === "recovered_phys" ? "recovered" : physState,
      hrvSampleCount: currentHrv?.sampleCount ?? 0
    },
    recoveryAssessment: {
      targetDate: assessment.coverage === "none" ? null : today,
      coverage: assessment.coverage,
      assessment: assessment.assessment,
      reasonCodes: assessment.reasonCodes,
      lastObservationDate: observationDates.length === 0 ? null : observationDates.sort().at(-1)!
    },
    recommendation: buildRecommendation(input, assessment, verdict),
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
    planDayFromSession(args.today, args.todaySession, prescription, source, !args.todayCompleted)
  ];

  for (const planned of args.storedPlan
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

  return {
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

function loadSleepWindow(database: DatabaseSync, today: string): {
  lastNight: number | null;
  baseline: number | null;
  nightsBelow: number;
} {
  const start = shanghaiInstant(shiftDate(today, -28), 18);
  const end = shanghaiInstant(today, 14);
  const rows = database.prepare(`
    SELECT start_at AS startAt, end_at AS endAt, value_text AS valueText
    FROM health_records
    WHERE type = ? AND start_at >= ? AND start_at < ?
  `).all(healthTypes.sleepAnalysis, start, end) as unknown as Array<{
    startAt: string;
    endAt: string;
    valueText: string | null;
  }>;
  const byNight = new Map<string, number>();
  for (const row of rows) {
    if (!row.valueText?.includes("Asleep")) continue;
    const minutes = Math.max(0, (Date.parse(row.endAt) - Date.parse(row.startAt)) / 60_000);
    const night = localCalendarFormatter(DATABASE_TIMEZONE, "day").format(new Date(Date.parse(row.startAt) + 6 * 3600_000));
    byNight.set(night, (byNight.get(night) ?? 0) + minutes);
  }
  const lastNight = byNight.get(today) ?? byNight.get(shiftDate(today, -1)) ?? null;
  const baselineValues = [...byNight.entries()]
    .filter(([date]) => date !== today)
    .map(([, minutes]) => minutes);
  const baseline = median(baselineValues);
  const recentNights = [0, 1, 2].map((offset) => byNight.get(shiftDate(today, -offset)));
  const nightsBelow = recentNights.filter(
    (value) => value != null && baseline != null && value < baseline * 0.8
  ).length;
  return { lastNight, baseline, nightsBelow };
}

function loadMetricWindow(
  database: DatabaseSync,
  type: string,
  today: string,
  startHour: number,
  endHour: number
): { current: number | null; baseline: number | null } {
  const currentStart = shanghaiInstant(today, startHour);
  const currentEnd = shanghaiInstant(today, endHour);
  const baselineStart = shanghaiInstant(shiftDate(today, -28), 0);
  const current = median(metricValues(database, type, currentStart, currentEnd));
  const baseline = median(metricValues(database, type, baselineStart, currentStart));
  return { current, baseline };
}

function metricValues(database: DatabaseSync, type: string, start: string, end: string): number[] {
  const rows = database.prepare(`
    SELECT value_numeric AS value
    FROM health_records
    WHERE type = ? AND value_numeric IS NOT NULL AND start_at >= ? AND start_at < ?
  `).all(type, start, end) as unknown as Array<{ value: number }>;
  return rows.map((row) => row.value).filter((value) => Number.isFinite(value));
}

function nullable(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
