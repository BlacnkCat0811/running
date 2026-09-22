import type {
  MobilePlannedDay,
  MobileSessionKind,
  MobileSessionStructure,
  MobileWorkoutStep
} from "@rai/api-contracts";
import { MOBILE_SESSION_KINDS } from "@rai/contracts";

import {
  buildSessionStructure,
  INTERVAL_MAX_REPS,
  INTERVAL_REP_METERS,
  measureStructure,
  pacesFromZones,
  rebuildStructureUnderDayCeiling,
  roundKm,
  type CoachZonePrescription
} from "./mobile-coach.js";
import {
  DISTANCE_ROUNDING_KM,
  MAX_PLANNED_DISTANCE_KM,
  normalizeSessionStructure
} from "./session-structure.js";

/**
 * Guard rails for model-generated weekly plans.
 *
 * Three layers, in order:
 *   1. shape validation  - reject anything malformed or dated outside the window
 *   2. business clamping - volume ramp, quality cap, easy floor, pace bounds
 *   3. fallback          - handled by the caller, which uses the heuristic plan
 *
 * Nothing unvalidated may reach the goals store, and every adjustment is
 * reported so a generation can be audited after the fact.
 */

/** Derived from the shared list so a kind the API accepts cannot be rejected here. */
const SESSION_KINDS = new Set<MobileSessionKind>(MOBILE_SESSION_KINDS);

const QUALITY_KINDS = new Set<MobileSessionKind>(["tempo", "interval"]);
const EASY_KINDS = new Set<MobileSessionKind>(["easy", "recovery"]);

/** Flags that, when present, suppress quality sessions entirely. */
const QUALITY_BLOCKING_FLAGS = new Set(["volume_ramp", "load_ratio", "quality_cluster", "long_run_jump", "week_jump"]);

/** Rep ceiling and per-rep distance come from the coach so the two cannot drift. */
const MAX_INTERVAL_REPS = INTERVAL_MAX_REPS;
const INTERVAL_REP_KM = INTERVAL_REP_METERS / 1000;
export const VOLUME_CEILING_TOLERANCE = 1.05;
export const RAMP_LIMIT_FRACTION = 0.3;
/**
 * Floor under the ramp base, expressed as a share of the weekly goal.
 *
 * A week lost to injury or illness would otherwise cap the next week at a
 * fraction of a goal the runner has explicitly set: an 8 km week would hold a
 * 40 km goal down to 11 km, which reads as the app ignoring its own setting.
 * The base is therefore measured against at least this share of the goal.
 *
 * Deliberately below `1 / (1 + RAMP_LIMIT_FRACTION)` ≈ 0.769. At or above that
 * threshold the ramp ceiling can never fall under the goal, `Math.min` always
 * picks the goal, and the ramp silently becomes dead code.
 */
export const RAMP_BASE_FLOOR_FRACTION = 0.5;
const MIN_PLANNED_DISTANCE_KM = 1;
/**
 * Target distance for the shortest sensible easy session. Measured through
 * `buildSessionStructure` to get the floor of one easy day, which decides how
 * many easy days a tight weekly budget can pay for.
 */
const MIN_EASY_DISTANCE_KM = 2;

/**
 * Nominal weekly volume ceiling, shared by the model validator and the fallback
 * template so the two can never drift apart.
 *
 * The ceiling is the tighter of the weekly goal and last week's realised volume
 * plus `RAMP_LIMIT_FRACTION`, with a floor under the ramp base (see
 * `RAMP_BASE_FLOOR_FRACTION`). A missing or zero previous week means "no ramp
 * constraint", which must be expressed as `Infinity`: `Math.min(goal, null)`
 * coerces `null` to `0` and would collapse the whole week to nothing.
 *
 * Returned before `VOLUME_CEILING_TOLERANCE`. The validator needs the tolerance
 * because a model's per-day rounding can overshoot and it is the last line of
 * defence against a plan the runner has not earned; the fallback template does
 * not, because it re-measures its own week and closes any residual itself (see
 * `buildFallbackWeekPlan`). That is a property of the template, not an accident:
 * if the template ever starts trusting its arithmetic again, this comment and
 * the assertion in `weekly-plan.test.ts` are what will notice.
 */
export function weeklyPlanVolumeCeiling(
  weeklyDistanceKm: number,
  previousWeekDistanceKm: number | null | undefined
): number {
  const baseCeiling = Math.max(MIN_PLANNED_DISTANCE_KM, weeklyDistanceKm);
  const rampCeiling =
    previousWeekDistanceKm != null && previousWeekDistanceKm > 0
      ? Math.max(previousWeekDistanceKm, baseCeiling * RAMP_BASE_FLOOR_FRACTION) *
        (1 + RAMP_LIMIT_FRACTION)
      : Number.POSITIVE_INFINITY;
  return Math.min(baseCeiling, rampCeiling);
}

export interface WeeklyPlanValidationArgs {
  raw: string;
  allowedDates: string[];
  prescription: CoachZonePrescription | null;
  weeklyDistanceKm: number;
  qualitySessionCap: number;
  easyDurationFloorFraction: number;
  injuryFlagCodes: string[];
  /** When known, the ramp ceiling is capped at previous week + 30%. */
  previousWeekDistanceKm?: number | null;
}

export interface WeeklyPlanValidationResult {
  days: MobilePlannedDay[];
  rejected: string[];
  clamped: string[];
}

/** Tolerates code fences and surrounding prose, which models add despite instructions. */
export function parsePlanJson(raw: string): unknown {
  const trimmed = raw.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "")
    : trimmed;
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function measuredDay(
  day: MobilePlannedDay,
  prescription: CoachZonePrescription | null
): { distanceKm: number; durationSeconds: number } | null {
  if (!day.structure) return null;
  return measureStructure(day.structure, day.kind, pacesFromZones(prescription));
}

/** Enforces the pace floor for every work step so a plan can never prescribe a faster target. */
function clampStepPaces(
  day: MobilePlannedDay,
  prescription: CoachZonePrescription | null,
  clamped: string[]
): MobilePlannedDay {
  if (!day.structure || !prescription) return day;
  const floor =
    day.kind === "interval"
      ? prescription.intervalPaceLower
      : day.kind === "tempo"
        ? prescription.thresholdPaceLower
        : prescription.easyPaceLower;
  if (floor == null) return day;

  let changed = false;
  const clampAlert = (step: NonNullable<MobileSessionStructure["warmup"]>) => {
    const alert = step.alert;
    if (!alert || alert.kind !== "pace") return step;
    const lower = alert.lower == null ? null : Math.max(alert.lower, floor);
    const upper = alert.upper == null ? null : Math.max(alert.upper, floor);
    if (lower !== alert.lower || upper !== alert.upper) {
      changed = true;
      return { ...step, alert: { ...alert, lower, upper } };
    }
    return step;
  };

  const structure: MobileSessionStructure = {
    warmup: day.structure.warmup ? clampAlert(day.structure.warmup) : null,
    blocks: day.structure.blocks.map((block) => ({
      iterations: block.iterations,
      steps: block.steps.map((step) => clampAlert(step))
    })),
    cooldown: day.structure.cooldown ? clampAlert(day.structure.cooldown) : null
  };
  if (!changed) return day;
  clamped.push(`${day.localDate} 配速目标被收回到允许区间`);
  return { ...day, structure };
}

function clampIntervalReps(day: MobilePlannedDay, clamped: string[]): MobilePlannedDay {
  if (!day.structure || day.kind !== "interval") return day;
  let changed = false;
  const blocks = day.structure.blocks.map((block) => {
    if (block.iterations <= MAX_INTERVAL_REPS) return block;
    changed = true;
    return { ...block, iterations: MAX_INTERVAL_REPS };
  });
  if (!changed) return day;
  clamped.push(`${day.localDate} 间歇组数超过 ${MAX_INTERVAL_REPS}，已截断`);
  return { ...day, structure: { ...day.structure, blocks } };
}

function demoteToEasy(day: MobilePlannedDay, prescription: CoachZonePrescription | null): MobilePlannedDay {
  const measured = measuredDay(day, prescription);
  const asked = measured && measured.distanceKm > 0 ? measured.distanceKm : day.distanceKm;
  // Clamped like every other request for a structure: the demoted day is rebuilt
  // from this number, and a request at the cap measures just above it.
  const target = asked == null ? null : Math.min(MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM, asked);
  const structure = buildSessionStructure("easy", prescription, { targetDistanceKm: target ?? null });
  // Re-measured and rounded like every other exit in this file. The value is
  // persisted, summed into the weekly total and shown in the app, so passing the
  // raw measurement through printed `7.838461538461538` on a degraded day while
  // the day before it read a plain `7.8`.
  const remeasured = structure ? measureStructure(structure, "easy", pacesFromZones(prescription)).distanceKm : 0;
  return {
    localDate: day.localDate,
    kind: "easy",
    distanceKm: remeasured > 0 ? roundKm(remeasured) : target == null ? null : roundKm(target),
    structure,
    reason: day.reason ?? null
  };
}

/**
 * What a day costs the week.
 *
 * Normally the distance measured off its own structure. A structure can legally
 * carry no measurable distance at all — `{"type":"open"}` is a goal the model is
 * invited to emit, and a day may omit its warm-up and cool-down — and then the
 * stored number is the only size the day has. Reading only the measurement left
 * such days costing *nothing*, so a week of them measured 0 km and sailed past
 * the ceiling it is measured against (seven 49 km days were stored against a
 * 42 km ceiling, silently). The stored number is what the runner sees and what
 * the week's total is summed from, so it is what the ceiling has to bind.
 */
function daySizeKm(day: MobilePlannedDay, prescription: CoachZonePrescription | null): number {
  const measured = measuredDay(day, prescription);
  if (measured && measured.distanceKm > 0) return measured.distanceKm;
  return day.distanceKm ?? 0;
}

function scaleDistances(days: MobilePlannedDay[], factor: number, prescription: CoachZonePrescription | null): MobilePlannedDay[] {
  return days.map((day) => {
    if (day.kind === "rest") return day;
    const current = daySizeKm(day, prescription);
    if (current <= 0) return day;
    const target = Math.max(
      MIN_PLANNED_DISTANCE_KM,
      Math.min(MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM, roundKm(current * factor))
    );
    if (day.kind === "interval") {
      // Reps are re-derived from the same 800 m rep the coach prescribes.
      const reps = Math.max(2, Math.min(MAX_INTERVAL_REPS, Math.round(target / INTERVAL_REP_KM)));
      const structure = buildSessionStructure("interval", prescription, { reps });
      // The stored hint is re-measured too, so it cannot contradict the structure
      // it travels with.
      const measuredAfter = structure ? measureStructure(structure, "interval", pacesFromZones(prescription)) : null;
      if (!measuredAfter || measuredAfter.distanceKm >= current) return day;
      return { ...day, distanceKm: roundKm(measuredAfter.distanceKm), structure };
    }
    const structure = buildSessionStructure(day.kind, prescription, { targetDistanceKm: target });
    // Measured, not assigned: `target` is what the week asked for, and
    // `buildSessionStructure` floors its work step and rounds to 100 m — so the
    // number the app persists has to be read back off the structure, exactly as
    // it is for the interval branch above. This is also what gives a structure
    // with no measurable distance one: the rebuilt day is dosed by distance.
    const remeasured = structure ? measureStructure(structure, day.kind, pacesFromZones(prescription)).distanceKm : 0;
    // A shrink pass may never enlarge a day. `buildSessionStructure` ignores
    // `targetDistanceKm` for tempo and interval — they are dosed by reps and work
    // interval — so re-cutting a small tempo day can come back *bigger* than the
    // day it was meant to trim, and the audit line would then claim a reduction
    // that never happened.
    if (remeasured <= 0 || remeasured >= current) return day;
    return { ...day, distanceKm: roundKm(remeasured), structure };
  });
}

/** Total distance of a week, before the per-day 100 m rounding. */
function weekSizeOf(days: MobilePlannedDay[], prescription: CoachZonePrescription | null): number {
  return days.reduce((sum, day) => sum + daySizeKm(day, prescription), 0);
}

/** The same total in the values that get persisted — what the runner sees. */
function storedTotalOf(days: MobilePlannedDay[]): number {
  return days.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
}

/**
 * Whether every step of a structure is dosed.
 *
 * An `open` goal runs until the runner stops the watch, so no number describes
 * the session it belongs to. A structure containing one is only partly
 * measurable, and the part that is measured understates the run: warm-up and
 * cool-down alone measure 1.54 km, which is what a day built on
 * `{warmup, blocks:[{steps:[{goal:{type:"open"}}]}], cooldown}` would store while
 * the watch ran an unbounded work block on top.
 */
function isFullyDosed(structure: MobileSessionStructure): boolean {
  const steps: Array<MobileWorkoutStep | null> = [
    structure.warmup,
    ...structure.blocks.flatMap((block) => block.steps),
    structure.cooldown
  ];
  return steps.every((step) => step == null || step.goal.type !== "open");
}

/**
 * Shrinks a week to the ceiling while keeping as much running as it can.
 *
 * A single proportional pass is not enough: `buildSessionStructure` rounds each
 * work step to 100 m and refuses to rebuild a day *larger* than the one it was
 * asked to trim, so the week's total is a *step function* of the factor and a
 * pass can come back with the total it went in with. The old loop gave up at
 * that point and left the residue to the session-dropping pass below — which
 * answered 0.37 km of rounding on a 42 km week by deleting a 7.8 km tempo.
 *
 * The total is monotone in the factor (a day can only get shorter as the factor
 * falls), so the largest factor that still fits is found by bisection. A residue
 * the 100 m grid cannot resolve then costs nothing, while a week that genuinely
 * cannot pay still bottoms out and is handed to the dropping pass.
 *
 * When even the floor is over the ceiling — a budget below what the coach's own
 * structures cost — the floor is returned: nothing smaller exists, and the
 * caller reports the shortfall instead of inventing a session.
 */
function fitWeekToCeiling(
  days: MobilePlannedDay[],
  ceilingKm: number,
  prescription: CoachZonePrescription | null
): MobilePlannedDay[] {
  // Both readings have to fit, exactly as the caller's own gate requires. Sizing
  // this pass on the measurement alone left a week whose *stored* total was over
  // the ceiling untouched — seven days at 5.7 km measured 39.67 against a 39.70
  // ceiling while storing 39.90 — and the 0.2 km residue then cost a whole
  // session to the dropping pass below, which is the disproportion this pass
  // exists to prevent.
  const sizeOf = (list: MobilePlannedDay[]): number =>
    Math.max(weekSizeOf(list, prescription), storedTotalOf(list));
  if (sizeOf(days) <= ceilingKm + 1e-6) return days;
  let low = 0;
  let high = 1;
  let best: MobilePlannedDay[] | null = null;
  for (let step = 0; step < 12; step += 1) {
    const factor = (low + high) / 2;
    const candidate = scaleDistances(days, factor, prescription);
    if (sizeOf(candidate) <= ceilingKm + 1e-6) {
      best = candidate;
      low = factor;
    } else {
      high = factor;
    }
  }
  return best ?? scaleDistances(days, 0, prescription);
}

/**
 * Rebuilds a day whose size exceeds the single-day ceiling.
 *
 * The cap is not cosmetic: the weekly goal is accepted up to 500 km, so a
 * three-day week can otherwise prescribe a single 167 km easy run, and a
 * model-supplied structure may contain steps far larger than any runner's day.
 * The day is rebuilt by `rebuildStructureUnderDayCeiling` — the same rebuild the
 * store's `capStructureToDayCeiling` uses, so the ceiling has one definition —
 * and measured again rather than the number alone being trimmed, so the day
 * still describes what the watch will execute.
 *
 * A day is kept even when the rebuild lands over the ceiling, unlike the store's
 * version, which drops the structure: this function's output is a week of days,
 * and removing one would silently change the plan's shape. The branch is
 * unreachable today (`buildSessionStructure` returns `null` only for `rest`, and
 * a rest day is size 0, returned above), so the two contracts are kept distinct
 * rather than merged.
 */
function capDayDistance(
  day: MobilePlannedDay,
  prescription: CoachZonePrescription | null,
  clamped: string[]
): MobilePlannedDay {
  const measured = measuredDay(day, prescription);
  const size = daySizeKm(day, prescription);
  if (size <= MAX_PLANNED_DISTANCE_KM) return day;
  const structure = rebuildStructureUnderDayCeiling(day.kind, prescription);
  const remeasured = structure ? measureStructure(structure, day.kind, pacesFromZones(prescription)).distanceKm : 0;
  const stored = remeasured > 0 ? roundKm(remeasured) : day.distanceKm;
  // Every rewrite of a prescription is reported; a plan that silently shrank
  // would look like the model's own idea on the audit screen. The over-limit
  // figure is printed unrounded — `roundKm(80.038)` is `80`, which read as
  // "80km 超过 80km 上限" — and comes from the day's own size, so a day whose
  // structure measures nothing is capped on the number it stores.
  clamped.push(
    `${day.localDate} 单日跑量 ${(measured && measured.distanceKm > 0 ? measured.distanceKm : size).toFixed(2)}km 超过 ${MAX_PLANNED_DISTANCE_KM}km 上限，已缩到 ${stored}km`
  );
  return { ...day, distanceKm: stored, structure };
}

function easyDurationFraction(days: MobilePlannedDay[], prescription: CoachZonePrescription | null): number | null {
  let easy = 0;
  let total = 0;
  for (const day of days) {
    const measured = measuredDay(day, prescription);
    if (!measured || measured.durationSeconds <= 0) continue;
    total += measured.durationSeconds;
    if (EASY_KINDS.has(day.kind)) easy += measured.durationSeconds;
  }
  if (total <= 0) return null;
  return easy / total;
}

export function validateWeeklyPlan(args: WeeklyPlanValidationArgs): WeeklyPlanValidationResult {
  const rejected: string[] = [];
  const clamped: string[] = [];
  const paces = pacesFromZones(args.prescription);
  const parsed = parsePlanJson(args.raw);
  const rawDays = parsed && typeof parsed === "object" ? (parsed as { days?: unknown }).days : null;
  if (!Array.isArray(rawDays)) {
    return { days: [], rejected: ["响应不是包含 days 数组的 JSON"], clamped };
  }

  const allowed = new Set(args.allowedDates);
  const seen = new Set<string>();
  let days: MobilePlannedDay[] = [];

  for (const entry of rawDays) {
    if (!entry || typeof entry !== "object") {
      rejected.push("存在非对象条目");
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const localDate = typeof raw.localDate === "string" ? raw.localDate : "";
    if (!allowed.has(localDate)) {
      // Guards against hallucinated dates such as past days or dates beyond the window.
      rejected.push(`日期 ${localDate || "(缺失)"} 不在允许窗口内`);
      continue;
    }
    if (seen.has(localDate)) {
      rejected.push(`日期 ${localDate} 重复`);
      continue;
    }
    const kind = raw.kind;
    if (typeof kind !== "string" || !SESSION_KINDS.has(kind as MobileSessionKind)) {
      rejected.push(`日期 ${localDate} 的训练类型无效`);
      continue;
    }
    seen.add(localDate);
    const sessionKind = kind as MobileSessionKind;

    if (sessionKind === "rest") {
      days.push({ localDate, kind: "rest", distanceKm: null, structure: null, reason: typeof raw.reason === "string" ? raw.reason.slice(0, 400) : null });
      continue;
    }

    const distanceHint =
      typeof raw.distanceKm === "number" && Number.isFinite(raw.distanceKm) && raw.distanceKm > 0
        ? raw.distanceKm
        : null;
    if (distanceHint != null && distanceHint > MAX_PLANNED_DISTANCE_KM) {
      // The hint only sizes the structure, but the model's own prescription is
      // still being rewritten: a silent cut would look like the model's idea on
      // the audit screen, and the day is reported with the number that survived.
      clamped.push(
        `${localDate} 模型请求 ${roundKm(distanceHint)}km 超过 ${MAX_PLANNED_DISTANCE_KM}km 单日上限，已按上限排课`
      );
    }
    const cappedHint = distanceHint == null ? null : Math.min(MAX_PLANNED_DISTANCE_KM, distanceHint);
    // A structure the app cannot size is not a structure it can store. `open` is
    // a goal the model is invited to emit, and it means "run until the watch is
    // stopped", so a day built on one has no distance the app can show or sum:
    // the number beside it could only be the model's own declaration, which is
    // exactly what the re-measure below exists to prevent. Such a day is treated
    // like one with no structure at all and rebuilt from the same hint, so the
    // prescription and the number describe each other. Reported, because the
    // model's own shape is being replaced.
    const parsed = normalizeSessionStructure(raw.structure);
    const sized = parsed ? isFullyDosed(parsed) : false;
    if (parsed && !sized) {
      clamped.push(
        `${localDate} 课表结构含开放式工作段，无法估算距离，已按 ${roundKm(cappedHint ?? MIN_PLANNED_DISTANCE_KM)}km 重建`
      );
    }
    const structure =
      (sized ? parsed : null) ??
      buildSessionStructure(sessionKind, args.prescription, { targetDistanceKm: cappedHint });
    if (!structure) {
      rejected.push(`日期 ${localDate} 未能形成有效课表结构`);
      continue;
    }
    const day = clampIntervalReps(
      {
        localDate,
        kind: sessionKind,
        distanceKm: cappedHint,
        structure,
        reason: typeof raw.reason === "string" ? raw.reason.slice(0, 400) : null
      },
      clamped
    );
    // The model's distance is only a build hint; the stored value is re-measured
    // from the structure **after** clamping (capping interval reps shrinks the
    // session, so measuring first would overstate it). This value is persisted,
    // shown in the app and summed into the user-facing weekly total, while the
    // watch executes the structure — the two must never disagree.
    const measuredKm = day.structure ? measureStructure(day.structure, sessionKind, paces).distanceKm : 0;
    // Capped last: `clampIntervalReps` already brings intervals under the cap,
    // and an oversized model-supplied structure is rebuilt at the cap here so
    // the stored day never describes a run the app would refuse to show.
    days.push(
      capDayDistance(
        { ...day, distanceKm: measuredKm > 0 ? roundKm(measuredKm) : cappedHint },
        args.prescription,
        clamped
      )
    );
  }

  days.sort((left, right) => left.localDate.localeCompare(right.localDate));

  // --- intensity containment ------------------------------------------------
  const blocking = args.injuryFlagCodes.filter((code) => QUALITY_BLOCKING_FLAGS.has(code));
  if (blocking.length > 0) {
    const before = days.filter((day) => QUALITY_KINDS.has(day.kind)).length;
    if (before > 0) {
      days = days.map((day) => (QUALITY_KINDS.has(day.kind) ? demoteToEasy(day, args.prescription) : day));
      clamped.push(`存在负荷/伤病旗标（${blocking.join("、")}），已取消 ${before} 堂质量课`);
    }
  }

  const cap = Math.max(0, Math.min(4, Math.round(args.qualitySessionCap)));
  let qualityDates = days.filter((day) => QUALITY_KINDS.has(day.kind)).map((day) => day.localDate);
  if (qualityDates.length > cap) {
    // Keep the earliest sessions; the rest fall back to easy running.
    const drop = new Set(qualityDates.slice(cap));
    days = days.map((day) => (drop.has(day.localDate) ? demoteToEasy(day, args.prescription) : day));
    clamped.push(`质量课数量超过上限 ${cap}，已降级 ${drop.size} 堂`);
    qualityDates = days.filter((day) => QUALITY_KINDS.has(day.kind)).map((day) => day.localDate);
  }

  // --- easy duration floor --------------------------------------------------
  if (qualityDates.length > 0) {
    let guard = 0;
    while (guard < 4) {
      const fraction = easyDurationFraction(days, args.prescription);
      if (fraction == null || fraction >= args.easyDurationFloorFraction) break;
      const lastQuality = days.filter((day) => QUALITY_KINDS.has(day.kind)).at(-1);
      if (!lastQuality) break;
      days = days.map((day) => (day.localDate === lastQuality.localDate ? demoteToEasy(day, args.prescription) : day));
      clamped.push(`轻松时段占比低于下限，已降级 ${lastQuality.localDate} 的质量课`);
      guard += 1;
    }
  }

  // --- pace containment -----------------------------------------------------
  days = days.map((day) => clampStepPaces(day, args.prescription, clamped));

  // --- per-day ceiling ------------------------------------------------------
  // Enforced again here, and not only where each day was first built: demotion
  // rebuilds a day from its measured size, so a quality day just under the cap
  // could come back just over it. This is the last pass before the totals below
  // are computed, which keeps the warnings quoting the same numbers that get
  // stored.
  days = days.map((day) => capDayDistance(day, args.prescription, clamped));

  // --- volume ceiling -------------------------------------------------------
  const totalDistance = (list: MobilePlannedDay[]): number => weekSizeOf(list, args.prescription);
  // The same total in the values that get persisted. `totalDistance` uses the
  // measured size before the per-day 100 m rounding, so the two differ by up to
  // ~0.05 km per day; the warning has to quote the number the runner will
  // actually see.
  const storedDistance = (list: MobilePlannedDay[]): number =>
    list.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  // The week has to fit in *both* readings: a plan can measure under the ceiling
  // while the numbers the app stores and sums sit above it, and the runner only
  // ever sees the stored ones.
  const weekTotal = (list: MobilePlannedDay[]): number =>
    Math.max(totalDistance(list), storedDistance(list));
  const ceiling =
    weeklyPlanVolumeCeiling(args.weeklyDistanceKm, args.previousWeekDistanceKm) *
    VOLUME_CEILING_TOLERANCE;
  // Gated on what the week *costs*, not on what it measures: a plan whose
  // structures carry no measurable distance (an `open` work goal, a day without
  // warm-up or cool-down) measured 0 km, so the whole block below was skipped and
  // seven 49 km days were stored against a 42 km ceiling with no warning at all.
  if (weekTotal(days) > ceiling + 1e-6) {
    const before = storedDistance(days);
    // Sizes as the model prescribed, before the pass below touches anything.
    const asPrescribed = new Map<string, number>();
    for (const day of days) asPrescribed.set(day.localDate, daySizeKm(day, args.prescription));
    // Scaled to the largest fitting factor rather than by one proportional pass,
    // so a residue on the 100 m grid is not mistaken for a week that is over
    // budget (see `fitWeekToCeiling`).
    days = fitWeekToCeiling(days, ceiling, args.prescription);
    // A quality session larger than the whole allowed week cannot belong to that
    // week, so it is re-cut as an easy run — but only when the ceiling has no
    // *better* lever on it, and only when the re-cut makes the week smaller.
    //
    // The scaler is the better lever. `buildSessionStructure` ignores
    // `targetDistanceKm` for a tempo block — it is a fixed number of threshold
    // reps — so a tempo day cannot be made to fit by scaling at all, while an
    // interval *is* dosed by the pass above (its rep count is the lever) and an
    // easy run by its distance. A day the scaler already shortened is therefore a
    // scaled day, not an unaffordable one. In the degenerate zone, though — the
    // ceiling below even the shortest sensible easy run — nothing can fit, and
    // the day is demoted anyway rather than left at several times the week.
    const minEasyStructure = buildSessionStructure("easy", args.prescription, {
      targetDistanceKm: MIN_EASY_DISTANCE_KM
    });
    const minEasyKm = minEasyStructure
      ? measureStructure(minEasyStructure, "easy", pacesFromZones(args.prescription)).distanceKm
      : MIN_EASY_DISTANCE_KM;
    let demoted = 0;
    for (let pass = 0; pass < 3 && weekTotal(days) > ceiling + 1e-6; pass += 1) {
      const oversized = days
        .filter((day) => {
          if (!QUALITY_KINDS.has(day.kind) || (day.distanceKm ?? 0) <= ceiling) return false;
          if (minEasyKm <= ceiling) return true;
          return daySizeKm(day, args.prescription) >= (asPrescribed.get(day.localDate) ?? 0) - 1e-6;
        })
        .sort((left, right) => (right.distanceKm ?? 0) - (left.distanceKm ?? 0))[0];
      if (!oversized) break;
      const entry = weekTotal(days);
      const candidate = days.slice();
      // `demoteToEasy` rebuilds the day from the size it already has, and an
      // interval at its two-rep floor (5.29 km) is *shorter* than an easy run
      // rebuilt from that number (5.34 km), so the "obvious" demotion can be the
      // wrong move; the progress test below is what rejects it.
      candidate[days.indexOf(oversized)] = demoteToEasy(oversized, args.prescription);
      const scaled = fitWeekToCeiling(candidate, ceiling, args.prescription);
      const next = weekTotal(scaled) < weekTotal(candidate) - 1e-6 ? scaled : candidate;
      // No progress at all: another pass would demote the next session for nothing.
      if (weekTotal(next) >= entry - 1e-6) break;
      days = next;
      demoted += 1;
    }
    if (demoted > 0) {
      clamped.push(`周跑量预算不足以支撑 ${demoted} 堂质量课，已降为轻松跑`);
    }

    // Scaling cannot go below what a session *is*: warmup, cooldown and a minimum
    // work step are irreducible, so a budget smaller than one session leaves the
    // loops above with nothing left to take. The ceiling is the safety property —
    // it decides how much of the model's plan survives — so days are dropped
    // instead of the week being kept over budget, the same reasoning the
    // deterministic template uses when it leaves a day unpaid rather than
    // shrinking it past its minimum. Without this a 10 km goal accepted seven
    // 2.5 km days, three times the week it was measured against.
    //
    // The most expensive session goes first, so the one that survives is the
    // cheapest the week can run: keeping whichever happened to sit earliest left
    // a 5.3 km interval in a week that could have afforded a 2.5 km easy run.
    // One session is retained — a week with no running at all is not a plan — and
    // when the ceiling is below even that floor the warning below says so.
    const cheapestKm = days.reduce(
      (min, day) => (day.kind === "rest" ? min : Math.min(min, daySizeKm(day, args.prescription))),
      Number.POSITIVE_INFINITY
    );
    const limit = Number.isFinite(cheapestKm) ? Math.max(ceiling, cheapestKm) : ceiling;
    const byCost = days
      .map((day, index) => ({ day, index }))
      .filter((entry) => entry.day.kind !== "rest")
      .sort(
        (left, right) =>
          daySizeKm(right.day, args.prescription) - daySizeKm(left.day, args.prescription)
      );
    let remaining = byCost.length;
    let dropped = 0;
    for (const entry of byCost) {
      if (remaining <= 1 || weekTotal(days) <= limit + 1e-6) break;
      days[entry.index] = {
        localDate: entry.day.localDate,
        kind: "rest",
        distanceKm: null,
        structure: null,
        reason: entry.day.reason ?? null
      };
      remaining -= 1;
      dropped += 1;
    }
    const displayed = storedDistance(days);
    // The week can end above the ceiling — the ceiling is below what the coach's
    // own shortest sessions cost — and then the line has to say so. "已缩减至
    // 5.3km" beside "超过上限 4.2km" reads as compliance with a number that is
    // itself over the limit, so the residual is named instead.
    const stillOver = displayed > ceiling + 1e-6 || weekTotal(days) > ceiling + 1e-6;
    if (before - displayed > 1e-6) {
      clamped.push(
        `周总跑量 ${roundKm(before)}km 超过上限 ${roundKm(ceiling)}km，已缩减至 ${roundKm(displayed)}km` +
          (stillOver ? "（已到结构下限，仍高于上限）" : "")
      );
    } else {
      // Nothing could be taken: the session is already at the floor the coach
      // prescribes, and the floor — not the ceiling — is then the tightest limit
      // the system has. Saying "已缩减" here would claim a reduction that never
      // happened.
      clamped.push(`周总跑量 ${roundKm(displayed)}km 超过上限 ${roundKm(ceiling)}km，已到结构下限，无法再减`);
    }
    if (dropped > 0) {
      clamped.push(`周跑量预算不足以支撑 ${dropped} 堂课，已改为休息`);
    }
  }

  return { days, rejected, clamped };
}

/**
 * Deterministic plan used when the model is unavailable or its output cannot be
 * salvaged.
 *
 * Sized from one budget — the tighter of the weekly goal and the ramp ceiling —
 * in this order: quality structures first (the coach fixes them, so their cost
 * is known and comes out of the budget before anything else), then as many easy
 * days as the remainder can actually pay for. Days the budget cannot cover
 * become rest days rather than shrinking past the structure's irreducible
 * minimum, so a week too small for quality work is easy-only and never over
 * budget.
 */
export function buildFallbackWeekPlan(args: {
  easyDurationFloorFraction?: number;
  allowedDates: string[];
  prescription: CoachZonePrescription | null;
  weeklyDistanceKm: number;
  qualitySessionCap: number;
  injuryFlagCodes: string[];
  /** Omit or pass null for "no known previous week", i.e. no ramp constraint. */
  previousWeekDistanceKm?: number | null;
}): MobilePlannedDay[] {
  const dates = [...args.allowedDates];
  if (dates.length === 0) return [];
  const paces = pacesFromZones(args.prescription);
  const blocking = args.injuryFlagCodes.some((code) => QUALITY_BLOCKING_FLAGS.has(code));
  const reason = "模型不可用，按保守模板安排";
  const restReason = "周跑量预算不足，安排休息";
  const ceiling = weeklyPlanVolumeCeiling(args.weeklyDistanceKm, args.previousWeekDistanceKm);

  // An easy session has an irreducible minimum: the warmup/cooldown pair plus
  // `MIN_WORK_DISTANCE_KM` of work. Measure it rather than assuming it, so the
  // day count below follows the structure the runner will actually execute.
  const minEasyStructure = buildSessionStructure("easy", args.prescription, {
    targetDistanceKm: MIN_EASY_DISTANCE_KM
  });
  const minEasyKm = minEasyStructure
    ? Math.max(roundKm(measureStructure(minEasyStructure, "easy", paces).distanceKm), MIN_EASY_DISTANCE_KM)
    : MIN_EASY_DISTANCE_KM;

  const cap = blocking ? 0 : Math.max(0, Math.min(2, Math.round(args.qualitySessionCap)));
  // Same slots as before: interval mid-week, tempo on the last day.
  const candidates: Array<{ index: number; kind: MobileSessionKind }> = [];
  if (cap >= 2 && dates.length > 1) {
    candidates.push({ index: 2, kind: "interval" }, { index: dates.length - 1, kind: "tempo" });
  } else if (cap === 1) {
    candidates.push({ index: 2, kind: "interval" });
  }

  const quality = new Map<number, MobilePlannedDay>();
  let qualityKm = 0;
  for (const candidate of candidates) {
    const localDate = dates[candidate.index];
    if (localDate === undefined || quality.has(candidate.index)) continue;
    const structure = buildSessionStructure(candidate.kind, args.prescription, {});
    if (!structure) continue;
    const measuredKm = roundKm(measureStructure(structure, candidate.kind, paces).distanceKm);
    // Always leave one easy session's worth of budget: a quality day that cannot
    // be paid for is dropped instead of pushing the week over the ceiling.
    if (qualityKm + measuredKm > ceiling - minEasyKm) continue;
    qualityKm += measuredKm;
    quality.set(candidate.index, {
      localDate,
      kind: candidate.kind,
      distanceKm: measuredKm,
      structure,
      reason
    });
  }

  const freeIndexes = dates.map((_, index) => index).filter((index) => !quality.has(index));
  const remainingKm = Math.max(0, ceiling - qualityKm);

  const assemble = (plan: Map<number, number>): MobilePlannedDay[] =>
    dates.map((localDate, index) => {
      const planned = quality.get(index);
      if (planned) return planned;
      const targetKm = plan.get(index);
      if (targetKm === undefined) {
        return { localDate, kind: "rest" as MobileSessionKind, distanceKm: null, structure: null, reason: restReason };
      }
      // Re-clamped here as well as at the call site, because `assemble` is the
      // one place every easy day is built: the weekly goal is accepted up to
      // 500 km, and a budget that large would otherwise be spent on a single day.
      // The margin over the cap mirrors `capDayDistance`: a request at the cap
      // measures slightly above it once the work step is rounded.
      const requestedKm = Math.min(MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM, targetKm);
      const structure = buildSessionStructure("easy", args.prescription, { targetDistanceKm: requestedKm });
      const measuredKm = structure ? measureStructure(structure, "easy", paces).distanceKm : 0;
      return {
        localDate,
        kind: "easy" as MobileSessionKind,
        distanceKm: measuredKm > 0 ? roundKm(measuredKm) : requestedKm,
        structure,
        reason
      };
    });
  const measuredTotal = (list: MobilePlannedDay[]): number =>
    list.reduce(
      (sum, day) => sum + (day.structure ? measureStructure(day.structure, day.kind, paces).distanceKm : 0),
      0
    );
  // The same week in the numbers that get persisted and summed on screen.
  // `assemble` rounds every day to the 100 m the UI shows, so each day can sit up
  // to 50 m above what it measures and seven of them can carry the *stored* week
  // past a ceiling the measured week meets. Both totals have to fit.
  const storedTotal = (list: MobilePlannedDay[]): number =>
    list.reduce((sum, day) => sum + (day.distanceKm ?? 0), 0);
  const weekTotal = (list: MobilePlannedDay[]): number => Math.max(measuredTotal(list), storedTotal(list));

  /**
   * Pulls a set of easy targets back inside the ceiling.
   *
   * A target is a request, not a promise: `buildSessionStructure` rounds its work
   * step to 100 m and floors it at the shortest meaningful session, so the
   * *measured* week can sit a few hundred metres above the total the arithmetic
   * promised — invisible to the per-day budget that produced it. Re-cut against
   * the measured week, taking 100 m from every easy day that can still give one
   * up so the week stays evenly spread.
   *
   * It never drops a day: when the structures bottom out and the week still does
   * not fit, the caller starts over with one fewer session, which re-spreads the
   * same budget over bigger days instead of leaving the week half empty.
   */
  const trimToCeiling = (input: Map<number, number>): Map<number, number> => {
    const targets = new Map(input);
    for (let pass = 0; pass < 8; pass += 1) {
      const total = weekTotal(assemble(targets));
      if (total <= ceiling + 1e-6) break;
      const cut = new Map(targets);
      let reducible = 0;
      for (const [index, current] of targets) {
        const next = roundKm(current - 0.1);
        if (next < MIN_EASY_DISTANCE_KM) continue;
        cut.set(index, next);
        reducible += 1;
      }
      if (reducible === 0) break;
      // A cut absorbed by the structure's minimum buys nothing; stop instead of
      // spinning through the remaining passes.
      if (weekTotal(assemble(cut)) >= total - 1e-9) break;
      targets.clear();
      for (const [index, target] of cut) targets.set(index, target);
    }
    return targets;
  };

  // The day count is an upper bound, not a decision. It is derived from the
  // budget in targets while the week is measured in structures, and a day cannot
  // shrink below `minEasyKm` — so a week that cannot pay for its last session
  // ends up with fewer, properly sized sessions rather than an over-budget one.
  // No easy day at all is a valid answer: the ceiling is the safety property, and
  // a goal smaller than the shortest easy session cannot pay for one.
  const maxEasyCount =
    freeIndexes.length > 0 ? Math.min(freeIndexes.length, Math.floor(remainingKm / minEasyKm)) : 0;
  let plan = assemble(new Map());
  for (let easyCount = maxEasyCount; easyCount >= 0; easyCount -= 1) {
    // Spread the easy days across the week instead of bunching them at the front,
    // so a reduced week still looks like a training week.
    const slots: number[] = [];
    for (let slot = 0; slot < easyCount; slot += 1) {
      const ratio = easyCount === 1 ? 0 : slot / (easyCount - 1);
      const position = Math.min(freeIndexes.length - 1, Math.round(ratio * (freeIndexes.length - 1)));
      const index = freeIndexes[position];
      if (index !== undefined) slots.push(index);
    }
    const perEasyKm =
      easyCount > 0
        ? roundKm(Math.min(MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM, remainingKm / easyCount))
        : null;
    const targets = new Map<number, number>();
    let allocatedKm = 0;
    slots.forEach((index, position) => {
      const isLast = position === slots.length - 1;
      // The last day absorbs the residual so the nominally budgeted total lands
      // on the ceiling rather than a rounding step above it.
      const target = isLast
        ? roundKm(
            Math.min(
              MAX_PLANNED_DISTANCE_KM - DISTANCE_ROUNDING_KM,
              Math.max(MIN_EASY_DISTANCE_KM, remainingKm - allocatedKm)
            )
          )
        : (perEasyKm ?? MIN_EASY_DISTANCE_KM);
      allocatedKm += target;
      targets.set(index, target);
    });
    plan = assemble(trimToCeiling(targets));
    if (weekTotal(plan) <= ceiling + 1e-6) break;
  }
  const fraction = easyDurationFraction(plan, args.prescription);
  if (cap > 0 && fraction !== null && fraction < (args.easyDurationFloorFraction ?? 0.7)) {
    // Rebuild the entire budget with fewer quality sessions: replacing only a
    // label would leave the old hard structure, and demotion can increase size.
    return buildFallbackWeekPlan({ ...args, qualitySessionCap: cap - 1 });
  }
  return plan;
}
