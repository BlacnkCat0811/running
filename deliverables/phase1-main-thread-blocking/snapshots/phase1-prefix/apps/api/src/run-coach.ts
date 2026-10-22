import type { MobileGoalsResponse, MobilePlannedDay, MobileRaceTarget, MobileRunCoachConfidence, MobileRunCoachPlan, MobileRunCoachResponse } from "@rai/api-contracts";
import type { RaiReadStore } from "./data.js";
import { WEAK_PREPARATION_NOTE, WEAK_PREPARATION_SCORE } from "./mobile-coach.js";
import { weeklyPlanDates } from "./weekly-plan-service.js";
import { runCoachDaysBetween, runCoachEndDate, runCoachIsTraining, runCoachPhase, runCoachRaceTarget, runCoachShiftDate, runCoachWeekday } from "./run-coach-policy.js";
import { weeklyCapacity } from "./weekly-capacity.js";
import { unsupportedRaceExecutionProtection } from "./race-plan-policy.js";

type Inputs = ReturnType<RaiReadStore["mobileWeeklyPlanInputs"]>;

/**
 * Weekly budget the coach may spend this week — **one number, two consumers**.
 *
 * It is published as `weeklyCapacityKm` and is the same quantity the unified refresh
 * path spends when it sizes the week, so the screen and the sessions cannot disagree.
 * It is the smaller of
 *
 *   1. `weeklyCapacity`'s baseline — race target trimmed by phase, then by the +30%
 *      ramp guard over the last four weeks; and
 *   2. this week's periodisation band `upper`, **taken from the today payload itself** —
 *      the exact number the today page prints for the same week.
 *
 * The band is the tighter of the two whenever recorded volume is small, and it has to
 * be the one that binds: decision 1 keeps the cold-start plan at ~5 km, and the screen
 * must show the number the plan was actually built from. Before this, the read path
 * published an already-ramped capacity that had never been phase-trimmed while the
 * generator used a *third* formula — three numbers, one screen.
 */
export function runCoachWeeklyBudget(plan: MobileRunCoachPlan, inputs: Inputs): number {
  const today = inputs.today.today.localDate;
  const capacityKm = weeklyCapacity({ today, raceTarget: runCoachRaceTarget(plan), runCoach: plan,
    recentWeeklyKm: inputs.recentWeeklyKm, previousWeekDistanceKm: inputs.previousWeekDistanceKm }).baselineKm;
  // Read the band out of the payload the today page renders rather than recomputing it from
  // the phase: same phase, same rounding, same `MAXIMUM_WEEKLY_KM` clamp, one number. It used
  // to recompute, and the recomputation was the phase's other algorithm — which is how 33 km
  // got published beside a 31.5 km band for the same week on a 5K plan.
  const pageBand = inputs.today.periodization?.current?.volumeBandKm.upper ?? null;
  return pageBand === null ? capacityKm : Math.min(capacityKm, pageBand);
}

/** Preparation score → confidence band. **Policy constants, not fitted** (same footing as `PHASE_VOLUME`). */
export const COACH_CONFIDENCE_HIGH_FLOOR = 70;
export const COACH_CONFIDENCE_MODERATE_FLOOR = 40;
export const COACH_PREPARATION_STALE_AFTER_DAYS = 56;

/**
 * Every `note` must carry this sentence. The prep score is a weighted share of training
 * targets met, so a runner who is well prepared for a distance can still miss a goal
 * time — and a runner who is not can still beat it. Without the disclaimer the number
 * reads as a probability, which is the one thing it is not.
 */
export const NOT_A_GOAL_PROBABILITY = "这是备赛准备度，不是达标概率。";

/** The evidence the confidence value is allowed to read. Structural, so no DB handle and no second query. */
export interface CoachConfidenceEvidence {
  values: Partial<Record<MobileRaceTarget["distance"], number>>;
  components: Partial<Record<MobileRaceTarget["distance"], {
    volumePreparedness: number;
    longRunExposure: number;
    frequency: number;
    targetExposure: number;
    recency: number;
  }>>;
  evidenceLevel: "insufficient" | "developing" | "established";
  /** Latest training fact used by the assessment, if any. */
  dataThroughAt?: string | null;
}

function preparationEvidenceIsStale(dataThroughAt: string | null | undefined, currentDate: string): boolean {
  if (!dataThroughAt) return false;
  const current = Date.parse(`${currentDate}T00:00:00Z`);
  const through = Date.parse(dataThroughAt);
  return Number.isFinite(current) && Number.isFinite(through) &&
    current - through > COACH_PREPARATION_STALE_AFTER_DAYS * 86_400_000;
}

/**
 * Confidence value v1 — the pure mapping, no clock and no database.
 *
 * Split out from `buildCoachConfidence` so the gates and the banding can be mutated
 * one at a time: hitting an exact `0.8` prep score end-to-end means building a fixture
 * that happens to land on it, which makes the assertions brittle in a way that hides
 * the thing they are supposed to catch.
 *
 * Returns `null` when there is no race programme at all (no plan, or a fitness goal).
 * Otherwise always an object, and an unmet gate is reported as
 * `status: "insufficient_data"` with `value: null` — never as a `0`.
 */
export function coachConfidenceFromPreparation(args: {
  hasRaceProgramme: boolean;
  /** The distance the programme is actually built around, or null for an unsupported one. */
  distance: MobileRaceTarget["distance"] | null;
  preparation: CoachConfidenceEvidence | null;
  calibrationCompleted: boolean;
  currentDate?: string;
}): MobileRunCoachConfidence | null {
  if (!args.hasRaceProgramme) return null;
  // Gate 1 (decision 4): only distances with a prediction chain have a convention.
  // A custom distance gets a plain "no such chain here", never a 0 and never an empty ring.
  if (args.distance === null) {
    return { status: "insufficient_data", value: null, band: null, basis: null, components: null,
      evidenceLevel: null, reasonCodes: ["unsupported_distance"],
      note: `该比赛距离不在成绩预测链内，因此没有备赛准备度。训练仍受跑量与恢复闸门约束。${NOT_A_GOAL_PROBABILITY}` };
  }
  if (args.currentDate && preparationEvidenceIsStale(args.preparation?.dataThroughAt, args.currentDate)) {
    const through = args.preparation?.dataThroughAt?.slice(0, 10) ?? "未知日期";
    return { status: "insufficient_data", value: null, band: null, basis: null, components: null,
      evidenceLevel: null, reasonCodes: ["preparation_stale"],
      note: `最近训练记录截至 ${through}，已超过 8 周，无法评估当前备赛准备度。${NOT_A_GOAL_PROBABILITY}` };
  }
  const score = args.preparation?.values[args.distance] ?? null;
  // Gate 2: no usable training facts. Say what is missing instead of asserting zero.
  if (score === null) {
    return { status: "insufficient_data", value: null, band: null, basis: null, components: null,
      evidenceLevel: null, reasonCodes: ["preparation_insufficient_evidence"],
      note: `还没有可用的训练记录，无法评估这条距离的备赛准备度。${NOT_A_GOAL_PROBABILITY}` };
  }
  const components = args.preparation?.components[args.distance] ?? null;
  const value = Math.round(score * 100);
  let band: NonNullable<MobileRunCoachConfidence["band"]> = value >= COACH_CONFIDENCE_HIGH_FLOOR ? "high"
    : value >= COACH_CONFIDENCE_MODERATE_FLOOR ? "moderate" : "low";
  const reasonCodes = ["preparation_basis"];
  // Gate 3: "high" is a claim about labelled performance, so it cannot be made while
  // calibration is unfinished. Cap rather than withhold: the number is still the prep score.
  if (!args.calibrationCompleted && band === "high") {
    band = "moderate";
    reasonCodes.push("calibration_incomplete_caps_band");
  }
  let note = `备赛准备度 ${value}%。${NOT_A_GOAL_PROBABILITY}`;
  if (score < WEAK_PREPARATION_SCORE) note += WEAK_PREPARATION_NOTE;
  return { status: "available", value, band, basis: "preparation",
    components: components === null ? null : { volume: components.volumePreparedness, longRun: components.longRunExposure,
      frequency: components.frequency, exposure: components.targetExposure, recency: components.recency },
    evidenceLevel: args.preparation?.evidenceLevel ?? null, reasonCodes, note };
}

/**
 * Adapter for the route. Reads only what `mobileWeeklyPlanInputs` already computed, so
 * the coach route stays synchronous — the race-time prediction chain is async and
 * expensive, and pulling it in here would turn a 200 ms read into a recompute.
 */
export function buildCoachConfidence(plan: MobileRunCoachPlan | null, inputs: Inputs): MobileRunCoachConfidence | null {
  return coachConfidenceFromPreparation({
    hasRaceProgramme: plan !== null && plan.goal !== "fitness",
    distance: plan === null ? null : runCoachRaceTarget(plan)?.distance ?? null,
    preparation: inputs.preparation,
    calibrationCompleted: inputs.today.calibration.status === "completed",
    currentDate: inputs.today.today.localDate
  });
}

export const RUN_COACH_REASONS = {
  programme_stopped: "教练计划未在进行。",
  not_a_running_day: "非可跑步日。",
  no_session_scheduled: "未来7日窗口未排课。",
  race_day: "比赛日留白；不等于比赛已完成。",
  post_race_recovery: "比赛后恢复。",
  pre_race_taper: "赛前减量。"
} as const;

/**
 * Why a **selected running weekday** inside the programme window carries no session.
 *
 * Facts and their codes only; no motive. A day can lose its session to the weekly budget,
 * to the ramp guard, or to the pre-race policy, and the read path genuinely cannot tell
 * those apart from the stored plan — so the fallback code says exactly that much and the
 * detail reports the observable counts instead of inventing a cause.
 */
export type RunCoachUnplannedReason = MobileRunCoachResponse["unplannedDays"][number]["code"];

/**
 * The rows that make the coach page look self-contradictory: runnable weekdays with
 * nothing on them. Returned so the screen can explain the gap instead of leaving the
 * runner to guess whether the plan broke.
 */
export function runCoachUnplannedDays(plan: MobileRunCoachPlan | null, inputs: Inputs,
  days: readonly MobilePlannedDay[]): MobileRunCoachResponse["unplannedDays"] {
  if (!plan) return [];
  const today = inputs.today.today.localDate;
  const end = runCoachEndDate(plan);
  const window = weeklyPlanDates(today);
  const windowEnd = window.at(-1) ?? today;
  const currentWindow = days.filter(day => day.localDate >= today && day.localDate <= windowEnd);
  const programmeWindow = currentWindow.filter(day => day.localDate <= end &&
    (plan.raceDate == null || day.localDate < plan.raceDate));
  const scheduled = programmeWindow.filter(day => day.kind !== "rest").length;
  const runnable = programmeWindow.filter(day => plan.runningDays.includes(runCoachWeekday(day.localDate))).length;
  return programmeWindow.flatMap(day => {
    const isRunnable = plan.runningDays.includes(runCoachWeekday(day.localDate));
    // Only running days, only inside the current rolling window, only while it is actually running.
    // Race day and everything after it already carry their own reason on the day itself.
    if (day.kind !== "rest" || !isRunnable || !runCoachIsTraining(plan, today)) return [];
    const taper = plan.raceDate != null && runCoachRaceTarget(plan) === null &&
      unsupportedRaceExecutionProtection(day.localDate, plan.raceDate).preRace;
    return [{ localDate: day.localDate,
      code: (taper ? "pre_race_taper" : "no_session_scheduled") as RunCoachUnplannedReason,
      detail: taper ? RUN_COACH_REASONS.pre_race_taper
        : `未来7日窗口 ${runnable} 个可跑步日，排入 ${scheduled} 次训练。` }];
  });
}

export function runCoachResponse(goals: MobileGoalsResponse, inputs: Inputs): MobileRunCoachResponse {
  const plan = goals.runCoach ?? null;
  const today = inputs.today.today.localDate;
  const notices: string[] = [];
  const phases: MobileRunCoachResponse["phases"] = [];
  if (plan) {
    for (let date = plan.startedOn; date <= runCoachEndDate(plan); date = runCoachShiftDate(date, 1)) {
      const phase = runCoachPhase(date, plan);
      if (phase === null) continue;
      const last = phases.at(-1);
      if (last?.phase === phase) { last.endsOn = date; last.current ||= date === today; }
      else phases.push({ phase, startsOn: date, endsOn: date, current: date === today });
    }
  }
  if (plan && plan.goal !== "fitness" && !runCoachRaceTarget(plan)) notices.push("该比赛距离暂无经过校准的成绩预测；训练仍受跑量和恢复闸门约束。");
  if (plan?.targetType === "heart_rate" && inputs.prescription?.easyHrUpper == null) notices.push("心率分区尚未建立，暂不下发心率目标。");
  if (inputs.today.calibration.status !== "completed") notices.push("校准未完成，暂以轻松训练建立基础。");
  if (plan && runCoachEndDate(plan) < today) notices.push("训练周期已结束；这不代表已完成比赛或达到目标。");
  const strength = plan?.strengthTraining && runCoachIsTraining(plan, today) && !inputs.today.injuryFlags.length && inputs.today.verdict.tone !== "red" ?
    goals.weekPlan.filter(day => day.localDate >= today && ["easy", "recovery"].includes(day.kind)).filter((_, index) => index % 2 === 0).slice(0, 2).map(day => ({
      localDate: day.localDate, durationMinutes: 15, exercises: [{ name: "提踵", dose: "2 组 × 12 次" }, { name: "臀桥", dose: "2 组 × 12 次" }, { name: "鸟狗式", dose: "每侧 2 组 × 8 次" }, { name: "侧平板支撑", dose: "每侧 2 组 × 20 秒" }]
    })) : [];
  // `weeklyCapacityKm` is the week's *spendable budget*, not the raw ramp ceiling: it is
  // the same number `buildRunCoachWeek` sized the sessions with. The two diverged before
  // (36.75 published vs 31.5 used) and the today page shows a third derivation of the same
  // week — see `runCoachWeeklyBudget`.
  return { revision: goals.revision, plan, phase: plan ? runCoachPhase(today, plan) : null,
    daysToRace: plan?.raceDate ? Math.max(0, runCoachDaysBetween(today, plan.raceDate)) : null,
    elapsedWeeks: plan ? Math.max(0, Math.floor(runCoachDaysBetween(plan.startedOn, today) / 7)) : 0,
    weeklyCapacityKm: plan ? runCoachWeeklyBudget(plan, inputs) : inputs.weeklyVolumeBaselineKm,
    unplannedDays: runCoachUnplannedDays(plan, inputs, goals.weekPlan),
    confidence: buildCoachConfidence(plan, inputs),
    notices, phases, strength };
}
