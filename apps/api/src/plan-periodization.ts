import type { MobileRaceDistance, MobileRaceTarget } from "@rai/api-contracts";

/**
 * Race-driven multi-week periodisation (docs/ALGORITHM.md §20).
 *
 * The coach used to reason one week at a time: `race-plan-policy` knew a 14-day
 * taper window and nothing else, so a half-marathon eight weeks out and a parkrun
 * next Saturday produced the same weekly structure. This module is the missing
 * skeleton — phases, volume bands, long-run caps and quality doses derived from the
 * race date — and it is **deterministic and read-time**: no LLM, nothing persisted.
 *
 * Two consequences of being read-time, both deliberate:
 *
 * 1. changing the race date immediately changes the whole skeleton, with no stale
 *    window to reconcile;
 * 2. the skeleton never *is* the plan. It is the envelope the weekly generation and
 *    its validator are held to; the week itself is still drafted, previewed and
 *    confirmed by the runner.
 *
 * Bands are policy constants for 5K/10K/half-marathon only. They are not fitted to
 * outcomes, so nothing here claims they are optimal — only that a plan outside them
 * is not what the coach intended to prescribe.
 */

export const PERIODIZATION_POLICY_VERSION = "rai-periodization-v2" as const;
export const PERIODIZATION_MAXIMUM_WEEKS = 24;

export type PeriodizationPhase = "base" | "build" | "peak" | "taper" | "race_week" | "past";

export interface PeriodizationWeek {
  /** Monday of the week, local date. */
  weekStart: string;
  phase: PeriodizationPhase;
  /** Whole weeks between this week's Monday and the race week (race week = 0). */
  weeksToRace: number;
  volumeBandKm: { lower: number; upper: number };
  longRunCapKm: number;
  /** Quality sessions this week should contain (tempo/interval/race). */
  qualityDose: number;
  note: string;
}

export interface Periodization {
  policyVersion: typeof PERIODIZATION_POLICY_VERSION;
  /** The day this skeleton was computed for. */
  generatedFor: string;
  raceDate: string | null;
  distance: MobileRaceDistance | null;
  weeks: PeriodizationWeek[];
  current: PeriodizationWeek | null;
  reasonCodes: string[];
}

/**
 * Phase boundaries in whole weeks before the race — **the only place a build length is
 * written down**.
 *
 * A half marathon needs the longest build; a 5K is mostly sharpening. The numbers
 * are policy, and the test suite pins the boundaries so a change is a visible
 * decision rather than a drifting constant.
 *
 * Exported so a regression can assert the boundary *table* instead of a copy of it.
 * `runCoachPhase` delegates here (2026-10-07); before that it carried its own flat
 * `taper + 5` build window, which gave a 5K plan five weeks of build and a half
 * marathon four — the wrong direction — and moved inside a natural week.
 */
export const PHASE_BOUNDARIES: Record<MobileRaceDistance, { build: number; taper: number }> = {
  five_k: { build: 2, taper: 1 },
  ten_k: { build: 3, taper: 2 },
  half_marathon: { build: 4, taper: 2 }
};

/** Volume bands as a fraction of the athlete's own recent weekly volume. */
const PHASE_VOLUME: Record<PeriodizationPhase, { lower: number; upper: number }> = {
  base: { lower: 0.9, upper: 1.05 },
  build: { lower: 0.95, upper: 1.1 },
  peak: { lower: 0.9, upper: 1.05 },
  taper: { lower: 0.55, upper: 0.75 },
  race_week: { lower: 0.4, upper: 0.6 },
  past: { lower: 0.5, upper: 0.9 }
};

/** Long-run share of the week, and the absolute ceiling per target distance. */
const PHASE_LONG_RUN_SHARE: Record<PeriodizationPhase, number> = {
  base: 0.32,
  build: 0.38,
  peak: 0.38,
  taper: 0.3,
  race_week: 0.25,
  past: 0.3
};

const DISTANCE_LONG_RUN_CAP_KM: Record<MobileRaceDistance, number> = {
  five_k: 14,
  ten_k: 18,
  half_marathon: 28
};

const QUALITY_DOSE: Record<PeriodizationPhase, number> = {
  base: 1,
  build: 2,
  peak: 2,
  taper: 1,
  race_week: 1,
  past: 1
};

const PHASE_NOTES: Record<PeriodizationPhase, string> = {
  base: "打基础：以轻松跑累积量，质量课保持一次。",
  build: "专项期：量最大，质量课两次，长距离逐步拉长。",
  peak: "强化期：维持量的同时提高质量课强度，不再加量。",
  taper: "减量期：量降到常态的一半左右，保留少量质量刺激。",
  race_week: "比赛周：只保留短促刺激，赛前 2 天完全轻松。",
  past: "比赛已过：按恢复与下一次目标重新开始。"
};

export const MINIMUM_BAND_KM = 5;
const MAXIMUM_WEEKLY_KM = 200;

const isLocalDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

/** Monday of the ISO week containing `date`. */
export function periodizationWeekStart(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

const shiftDate = (date: string, days: number): string => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

function phaseFor(weeksToRace: number, distance: MobileRaceDistance): PeriodizationPhase {
  if (weeksToRace < 0) return "past";
  const boundaries = PHASE_BOUNDARIES[distance];
  if (weeksToRace === 0) return "race_week";
  if (weeksToRace <= boundaries.taper) return "taper";
  if (weeksToRace === boundaries.taper + 1) return "peak";
  if (weeksToRace <= boundaries.taper + 1 + boundaries.build) return "build";
  return "base";
}

/**
 * Whole weeks, aligned to the natural week, between `today`'s week and the race's week —
 * negative once the race week is behind us.
 *
 * The single alignment. `buildPeriodization` and `periodizationPhaseFor` both read it, so
 * there is exactly one answer to "how many weeks out is this race"; deriving it from raw day
 * differences instead is what let one natural week report two different phases.
 */
export function periodizationWeeksToRace(today: string, raceDate: string): number {
  const raceWeekStart = periodizationWeekStart(raceDate);
  const currentWeekStart = periodizationWeekStart(today);
  return Math.round(
    (Date.parse(`${raceWeekStart}T00:00:00Z`) - Date.parse(`${currentWeekStart}T00:00:00Z`)) / (7 * 86_400_000)
  );
}

/**
 * Phase of the natural week `today` falls in, for **any** horizon.
 *
 * `buildPeriodization` deliberately stops at `PERIODIZATION_MAXIMUM_WEEKS` and produces no
 * `current` week past it, because that skeleton is what the today page renders. A *phase* is
 * still defined out there, and `past` — a race already run — has to stay reachable, so
 * callers that ask "which phase is this week" rather than "which row of the skeleton" come
 * here. Same boundary table, same alignment, no window.
 *
 * Throws on an unparseable date rather than guessing: every caller holds a validated plan.
 */
export function periodizationPhaseFor(today: string, raceTarget: Pick<MobileRaceTarget, "date" | "distance">): PeriodizationPhase {
  if (!isLocalDate(today) || !isLocalDate(raceTarget.date)) {
    throw new Error("periodizationPhaseFor requires local dates for today and the race");
  }
  return phaseFor(periodizationWeeksToRace(today, raceTarget.date), raceTarget.distance);
}

/** The quality dose the phase allows, as a ceiling the validator can use. */
export function periodizationQualityCap(phase: PeriodizationPhase): number {
  return QUALITY_DOSE[phase];
}

/** Volume fraction of the athlete's own recent week that the phase permits. */
export function periodizationVolumeFraction(phase: PeriodizationPhase): number {
  return PHASE_VOLUME[phase].upper;
}

/**
 * The `upper` of one phase's volume band, in km — the number the today page shows.
 *
 * Extracted from `buildPeriodization`'s loop so the coach can *spend* against the
 * same band instead of recomputing it. It used to recompute: the coach capped its
 * week at `max(5, recent) × fraction` and the band capped at `max(5, recent × fraction)`,
 * which differ whenever recent volume sits below the 5 km floor — and the subtraction
 * was published as `weeklyCapacityKm`, i.e. a third number on the same screen. The
 * floor has to stay *outside* the multiplication; that is the whole difference.
 */
export function periodizationVolumeBandKm(phase: PeriodizationPhase, recentWeeklyKm: number): number {
  const weekly = Number.isFinite(recentWeeklyKm) ? Math.max(0, recentWeeklyKm) : 0;
  const baseline = weekly > 0 ? weekly : PHASE_VOLUME.base.lower * MINIMUM_BAND_KM;
  return Math.max(MINIMUM_BAND_KM, Math.round(baseline * PHASE_VOLUME[phase].upper * 10) / 10);
}

/**
 * The phase of the week a fresh plan covers, or null when there is no race target.
 *
 * One line for the callers that only need "which phase is this week", so a plan
 * generator cannot accidentally use a different window than the skeleton does.
 */
export function currentPeriodizationWeek(input: {
  today: string;
  raceTarget: Pick<MobileRaceTarget, "date" | "distance"> | null | undefined;
  recentWeeklyKm: number;
}): PeriodizationWeek | null {
  return buildPeriodization(input).current;
}

export function buildPeriodization(input: {
  today: string;
  raceTarget: Pick<MobileRaceTarget, "date" | "distance"> | null | undefined;
  /** The athlete's recent weekly volume, in km. */
  recentWeeklyKm: number;
}): Periodization {
  const reasonCodes: string[] = [];
  if (!isLocalDate(input.today)) throw new Error("buildPeriodization requires a local date for today");
  const race = input.raceTarget;
  const weekly = Number.isFinite(input.recentWeeklyKm)
    ? Math.min(MAXIMUM_WEEKLY_KM, Math.max(0, input.recentWeeklyKm))
    : 0;
  if (weekly <= 0) reasonCodes.push("no_recent_weekly_volume");
  if (!race || !isLocalDate(race.date)) {
    return {
      policyVersion: PERIODIZATION_POLICY_VERSION,
      generatedFor: input.today,
      raceDate: null,
      distance: null,
      weeks: [],
      current: null,
      reasonCodes: [...reasonCodes, "no_race_target"]
    };
  }

  const raceWeekStart = periodizationWeekStart(race.date);
  const currentWeekStart = periodizationWeekStart(input.today);
  const weeksToRace = periodizationWeeksToRace(input.today, race.date);
  if (weeksToRace > PERIODIZATION_MAXIMUM_WEEKS) {
    reasonCodes.push("race_beyond_maximum_horizon");
  }
  if (weeksToRace < 0) reasonCodes.push("race_in_the_past");

  const baseline = weekly > 0 ? weekly : PHASE_VOLUME.base.lower * MINIMUM_BAND_KM;
  // The skeleton is forward-looking: weeks already behind us are not part of it, and
  // a race in the past produces no skeleton at all (the loop does not run).
  // The horizon counts the race week itself: 24 weeks means 24 rows, not 25.
  const firstOffset = Math.max(0, weeksToRace - (PERIODIZATION_MAXIMUM_WEEKS - 1));

  const weeks: PeriodizationWeek[] = [];
  for (let offset = firstOffset; offset <= weeksToRace; offset += 1) {
    // `offset` counts *up* to the race week; the phase is a function of how many weeks
    // are left. Passing the offset instead put `race_week` on the week furthest from the
    // race and `base` on the race itself — the phase *counts* were still right, which is
    // exactly how a transposed assignment survives a test that only counts.
    const weekStart = shiftDate(raceWeekStart, -7 * (weeksToRace - offset));
    if (weekStart < currentWeekStart) continue;
    const weeksToRaceForWeek = weeksToRace - offset;
    const phase = phaseFor(weeksToRaceForWeek, race.distance);
    const band = PHASE_VOLUME[phase];
    const volumeBandKm = {
      lower: Math.max(MINIMUM_BAND_KM, Math.round(baseline * band.lower * 10) / 10),
      upper: periodizationVolumeBandKm(phase, baseline)
    };
    const longRunCapKm = Math.min(
      DISTANCE_LONG_RUN_CAP_KM[race.distance],
      Math.max(
        MINIMUM_BAND_KM,
        Math.round(volumeBandKm.upper * PHASE_LONG_RUN_SHARE[phase] * 10) / 10
      )
    );
    weeks.push({
      weekStart,
      phase,
      weeksToRace: weeksToRaceForWeek,
      volumeBandKm,
      longRunCapKm,
      qualityDose: QUALITY_DOSE[phase],
      note: PHASE_NOTES[phase]
    });
  }

  const current = weeks.find((week) => week.weekStart === currentWeekStart) ?? null;
  if (current === null && weeks.length > 0) reasonCodes.push("current_week_outside_window");
  return {
    policyVersion: PERIODIZATION_POLICY_VERSION,
    generatedFor: input.today,
    raceDate: race.date,
    distance: race.distance,
    weeks,
    current,
    reasonCodes
  };
}
