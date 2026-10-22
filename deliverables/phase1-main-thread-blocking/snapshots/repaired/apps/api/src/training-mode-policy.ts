import type { MobileRaceDistance } from "@rai/api-contracts";

import { isValidLocalDate } from "./local-date.js";
import { digest } from "./plan-digest.js";
import { PERIODIZATION_MAXIMUM_WEEKS, periodizationWeeksToRace } from "./plan-periodization.js";

/**
 * One derived training mode, replacing the two independent coach switches.
 *
 * The product rule is one sentence: a complete, valid race goal whose date is not
 * yet past makes the plan a race plan; otherwise the same coach drafts an everyday
 * plan. There is no `coachEnabled`/`raceEnabled` pair, and this module never reads
 * the clock — every entry point passes the **Shanghai business date** it already
 * resolved (`coachLocalDate`), so a device timezone cannot move a race to another
 * day and a GET cannot silently re-derive a mode from a different "today".
 *
 * Everything here is pure: no storage, no HTTP, no candidate search. The command
 * reducer is the only place that decides whether a (possibly incomplete) editor
 * draft may change persisted state, and it returns the unchanged state on every
 * rejection so a caller cannot accidentally publish a half-applied configuration.
 *
 * Deliberately NOT decided here: the v2 snapshot/command wire fields and receipt
 * version (PR4), the taper dose policy for near races (G01 policy review), and the
 * migration source selection (PR3). A mode is also NOT an execution permission:
 * the run state, admission state, fact freshness and device coordination are
 * separate dimensions.
 */

export const TRAINING_MODE_POLICY_VERSION = "rai-training-mode-policy-v1";

export type PlannerMode = "coach" | "race";
export type RunState = "active" | "paused";
export type AdmissionState = "ready" | "needs_configuration" | "needs_confirmation";

/** A race shorter than this is recorded but flagged as insufficient preparation. */
export const RACE_GOAL_SHORT_PREPARATION_DAYS = 42;
/** Longest recordable race. Custom/ultra distances stay race goals, not daily runs. */
export const RACE_GOAL_MAXIMUM_DISTANCE_KM = 200;
/** 24 h is already far beyond a plausible target time and still bounds the payload. */
export const RACE_GOAL_MAXIMUM_TARGET_TIME_SECONDS = 24 * 60 * 60;

/** Only these distances have a periodization skeleton (50 m tolerance is generous). */
const SUPPORTED_DISTANCES: ReadonlyArray<{ distance: MobileRaceDistance; km: number }> = [
  { distance: "five_k", km: 5 },
  { distance: "ten_k", km: 10 },
  { distance: "half_marathon", km: 21.0975 }
];
const DISTANCE_MATCH_TOLERANCE_KM = 0.05;

// ---------------------------------------------------------------------------
// Race goal validation
// ---------------------------------------------------------------------------

export type RaceGoalRejectionReason =
  | "date_missing"
  | "distance_missing"
  | "date_invalid"
  | "distance_invalid"
  | "goal_kind_invalid"
  | "target_time_missing"
  | "target_time_invalid";

/**
 * Editor payload. `undefined`/`null` mean "not filled in yet" and are drafts; a
 * present but malformed value is invalid. The distinction matters because a draft
 * must not change the server-side mode while an invalid value must be rejected
 * without dropping the previously stored goal.
 */
export interface RaceGoalDraft {
  date?: string | null;
  distanceKm?: number | null;
  goal?: "finish" | "time" | null;
  targetTimeSeconds?: number | null;
}

export interface NormalizedRaceGoal {
  date: string;
  distanceKm: number;
  goal: "finish" | "time";
  targetTimeSeconds: number | null;
}

export type RaceGoalValidation =
  | { status: "valid"; goal: NormalizedRaceGoal }
  | { status: "draft"; reasons: RaceGoalRejectionReason[] }
  | { status: "invalid"; reasons: RaceGoalRejectionReason[] };

const INCOMPLETE_REASONS: readonly RaceGoalRejectionReason[] = ["date_missing", "distance_missing", "target_time_missing"];

/**
 * Validate the completeness and format of an editor draft.
 *
 * `finish` goals do not require a time (an optional one is ignored); `time` goals
 * do. Missing pieces are a draft (no side effect), malformed pieces are invalid
 * (rejected, old goal kept). Dates are strict calendar dates, not `Date.parse`
 * near-misses such as `2026-02-30`, because a shifted date moves the whole window.
 */
export function validateRaceGoal(input: RaceGoalDraft): RaceGoalValidation {
  const reasons: RaceGoalRejectionReason[] = [];
  const date = input.date ?? null;
  const distanceKm = input.distanceKm ?? null;
  // The wire payload is untyped JSON: compare as string before narrowing.
  const goal = String(input.goal ?? "finish");
  const targetTimeSeconds = input.targetTimeSeconds ?? null;

  if (date === null || date === "") reasons.push("date_missing");
  else if (!isValidLocalDate(date)) reasons.push("date_invalid");

  if (distanceKm === null) reasons.push("distance_missing");
  else if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > RACE_GOAL_MAXIMUM_DISTANCE_KM) {
    reasons.push("distance_invalid");
  }

  if (goal !== "finish" && goal !== "time") reasons.push("goal_kind_invalid");

  if (goal === "time") {
    if (targetTimeSeconds === null) reasons.push("target_time_missing");
    else if (!Number.isInteger(targetTimeSeconds) || targetTimeSeconds <= 0 ||
      targetTimeSeconds > RACE_GOAL_MAXIMUM_TARGET_TIME_SECONDS) {
      reasons.push("target_time_invalid");
    }
  }

  if (reasons.length === 0) {
    const normalizedGoal: "finish" | "time" = goal === "time" ? "time" : "finish";
    return {
      status: "valid",
      goal: {
        date: date!,
        distanceKm: distanceKm!,
        goal: normalizedGoal,
        targetTimeSeconds: normalizedGoal === "time" ? targetTimeSeconds : null
      }
    };
  }
  // Incomplete and malformed are both side-effect free, but only incomplete is a
  // draft the editor may keep editing; a malformed value is a rejection.
  return INCOMPLETE_REASONS.some((reason) => reasons.includes(reason))
    ? { status: "draft", reasons }
    : { status: "invalid", reasons };
}

/** Standard-distance mapping, `null` for custom distances that keep their identity. */
export function raceDistanceFor(distanceKm: number): MobileRaceDistance | null {
  const standard = SUPPORTED_DISTANCES.find((entry) => Math.abs(entry.km - distanceKm) <= DISTANCE_MATCH_TOLERANCE_KM);
  return standard?.distance ?? null;
}

export interface RaceGoal {
  id: string;
  date: string;
  distanceKm: number;
  goal: "finish" | "time";
  targetTimeSeconds: number | null;
}

// ---------------------------------------------------------------------------
// Mode resolution
// ---------------------------------------------------------------------------

export type TrainingModeReason = "no_race_goal" | "race_goal_upcoming" | "race_day" | "race_goal_passed";

export interface TrainingModeResolution {
  mode: PlannerMode;
  reason: TrainingModeReason;
  /** Negative once the race date is behind the business date; `null` with no goal. */
  daysToRace: number | null;
}

function requireLocalDate(value: string, field: string): string {
  if (!isValidLocalDate(value)) throw new Error(`${field} must be a strict local date (YYYY-MM-DD)`);
  return value;
}

/** Whole calendar days from `from` to `to`; both must be strict local dates. */
export function daysBetweenLocalDates(from: string, to: string): number {
  requireLocalDate(from, "from");
  requireLocalDate(to, "to");
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The single mode derivation.
 *
 * Throws on an invalid stored date instead of returning `coach`: treating an
 * unparsable goal as "no race" would silently switch a user out of their race
 * plan, so unusable history has to surface as a migration/configuration conflict
 * at the call site.
 *
 * A race date equal to the business date is still `race` (a race-day event, not a
 * normal rest day); a date already past falls back to `coach` for new scheduling
 * without inventing a "finished the race" fact.
 */
export function resolveTrainingMode(input: {
  raceGoal: Pick<RaceGoal, "date"> | null;
  businessDate: string;
}): TrainingModeResolution {
  const businessDate = requireLocalDate(input.businessDate, "businessDate");
  if (input.raceGoal === null) return { mode: "coach", reason: "no_race_goal", daysToRace: null };
  const raceDate = requireLocalDate(input.raceGoal.date, "raceGoal.date");
  const daysToRace = daysBetweenLocalDates(businessDate, raceDate);
  if (daysToRace < 0) return { mode: "coach", reason: "race_goal_passed", daysToRace };
  if (daysToRace === 0) return { mode: "race", reason: "race_day", daysToRace };
  return { mode: "race", reason: "race_goal_upcoming", daysToRace };
}

// ---------------------------------------------------------------------------
// Support level (evaluation result, never a switch)
// ---------------------------------------------------------------------------

export type RaceHorizon = "within_horizon" | "beyond_horizon";
export type RacePreparation = "ready" | "short";

export interface RaceGoalSupport {
  /** `null` means a custom distance: the race is kept, the skeleton is limited. */
  distance: MobileRaceDistance | null;
  support: "standard" | "limited";
  horizon: RaceHorizon;
  preparation: RacePreparation;
  weeksToRace: number;
  daysToRace: number;
  reasonCodes: string[];
}

/**
 * How much of the standard skeleton this race can be expressed with.
 *
 * This is a *display/evaluation* answer. It must never be read as "no race mode":
 * a near race, a custom distance and a race beyond the 24-week skeleton are all
 * still races. The horizon test reuses `periodizationWeeksToRace` so there is one
 * week alignment, not a second one that could disagree inside a natural week.
 *
 * Only meaningful for a race the resolver still treats as current (`daysToRace >= 0`);
 * a past goal resolves to `coach` and its support level describes history.
 */
export function raceGoalSupport(
  raceGoal: Pick<RaceGoal, "date" | "distanceKm">,
  businessDate: string
): RaceGoalSupport {
  const daysToRace = daysBetweenLocalDates(requireLocalDate(businessDate, "businessDate"), requireLocalDate(raceGoal.date, "raceGoal.date"));
  const distance = raceDistanceFor(raceGoal.distanceKm);
  const weeksToRace = periodizationWeeksToRace(businessDate, raceGoal.date);
  const horizon: RaceHorizon = weeksToRace > PERIODIZATION_MAXIMUM_WEEKS ? "beyond_horizon" : "within_horizon";
  const preparation: RacePreparation = daysToRace < RACE_GOAL_SHORT_PREPARATION_DAYS ? "short" : "ready";
  const reasonCodes: string[] = [];
  if (distance === null) reasonCodes.push("race_distance_custom");
  if (preparation === "short") reasonCodes.push("race_preparation_short");
  if (horizon === "beyond_horizon") reasonCodes.push("race_beyond_periodization_horizon");
  return {
    distance,
    support: distance === null ? "limited" : "standard",
    horizon,
    preparation,
    weeksToRace,
    daysToRace,
    reasonCodes
  };
}

/**
 * Identity of the configuration a published plan was generated for.
 *
 * PR4-2 publishes configuration and plan in separate steps (the plan regenerator
 * lands next), so a snapshot must be able to say "the plan is for an older
 * configuration". This digest covers every input that changes what the plan means:
 * the mode policy version, the derived mode, the race goal identity and the run
 * state. It deliberately does NOT cover facts (a new run does not change intent).
 */
export function trainingPlanContextDigest(state: {
  raceGoal: RaceGoal | null;
  runState: RunState;
}): string {
  return digest({
    policyVersion: TRAINING_MODE_POLICY_VERSION,
    mode: state.raceGoal === null ? "coach" : "race",
    raceGoal: state.raceGoal === null ? null : {
      id: state.raceGoal.id,
      date: state.raceGoal.date,
      distanceKm: state.raceGoal.distanceKm,
      goal: state.raceGoal.goal,
      targetTimeSeconds: state.raceGoal.targetTimeSeconds
    },
    runState: state.runState
  });
}

// ---------------------------------------------------------------------------
// Configuration commands
// ---------------------------------------------------------------------------

/**
 * The only writable training configuration. `mode` is absent on purpose: it is
 * derived from `raceGoal` and the business date, so it cannot drift from them.
 */
export interface TrainingConfigurationState {
  raceGoal: RaceGoal | null;
  runState: RunState;
  /** A complete preference set is an admission prerequisite, not a mode switch. */
  preferencesComplete: boolean;
}

export function admissionStateFor(state: TrainingConfigurationState): AdmissionState {
  return state.preferencesComplete ? "ready" : "needs_configuration";
}

export type TrainingConfigurationCommand =
  | { type: "set_race_goal"; draft: RaceGoalDraft }
  | { type: "clear_race_goal" }
  | { type: "pause" }
  | { type: "resume" };

export type TrainingConfigurationChange =
  | "race_goal_set"
  | "race_goal_updated"
  | "race_goal_replaced"
  | "race_goal_cleared"
  | "paused"
  | "resumed"
  | "none";

export type GoalIdentityChange = "unset" | "kept" | "replaced" | "cleared" | "unchanged";

export interface TrainingConfigurationDecision {
  accepted: boolean;
  /** `null` when accepted; `draft`/`invalid` mirrors `validateRaceGoal`. */
  rejection: "draft" | "invalid" | null;
  /** Unchanged on rejection; a caller must publish only when `accepted`. */
  state: TrainingConfigurationState;
  mode: TrainingModeResolution;
  change: TrainingConfigurationChange;
  goalIdentity: GoalIdentityChange;
  /** Validation detail for a rejected `set_race_goal`; empty when accepted. */
  reasons: RaceGoalRejectionReason[];
}

/**
 * Apply one editor command to the configuration.
 *
 * Rules this pins (product rules P05–P07/P10 and §4.3):
 * - saving, changing or clearing a race goal never ends a trainer, it only changes
 *   the derived mode;
 * - a draft or invalid goal changes nothing at all (no "half saved" goal);
 * - changing only the target time keeps the race identity; changing the date or the
 *   distance replaces it, and the replacement id is supplied by the server;
 * - pause survives goal edits; only an explicit `resume` re-enables training.
 */
export function applyTrainingConfigurationCommand(input: {
  state: TrainingConfigurationState;
  command: TrainingConfigurationCommand;
  businessDate: string;
  /** Server-allocated id used when a new race identity is required. */
  newGoalId?: string | null;
}): TrainingConfigurationDecision {
  const { state, command, businessDate } = input;
  const modeOf = (next: TrainingConfigurationState): TrainingModeResolution =>
    resolveTrainingMode({ raceGoal: next.raceGoal, businessDate });
  const unchanged = (change: TrainingConfigurationChange, goalIdentity: GoalIdentityChange): TrainingConfigurationDecision => ({
    accepted: true, rejection: null, state, mode: modeOf(state), change, goalIdentity, reasons: []
  });
  const rejected = (validation: Extract<RaceGoalValidation, { status: "draft" | "invalid" }>): TrainingConfigurationDecision => ({
    accepted: false, rejection: validation.status, state, mode: modeOf(state), change: "none",
    goalIdentity: "unchanged", reasons: validation.reasons
  });

  if (command.type === "pause") {
    if (state.runState === "paused") return unchanged("none", "unchanged");
    return { accepted: true, rejection: null, state: { ...state, runState: "paused" }, mode: modeOf(state),
      change: "paused", goalIdentity: "unchanged", reasons: [] };
  }
  if (command.type === "resume") {
    if (state.runState === "active") return unchanged("none", "unchanged");
    return { accepted: true, rejection: null, state: { ...state, runState: "active" }, mode: modeOf(state),
      change: "resumed", goalIdentity: "unchanged", reasons: [] };
  }
  if (command.type === "clear_race_goal") {
    if (state.raceGoal === null) return unchanged("none", "unchanged");
    const next = { ...state, raceGoal: null };
    return { accepted: true, rejection: null, state: next, mode: modeOf(next),
      change: "race_goal_cleared", goalIdentity: "cleared", reasons: [] };
  }

  const validation = validateRaceGoal(command.draft);
  if (validation.status !== "valid") return rejected(validation);
  const goal = validation.goal;
  const current = state.raceGoal;
  const sameIdentity = current !== null && current.date === goal.date && current.distanceKm === goal.distanceKm;
  if (sameIdentity) {
    const next: TrainingConfigurationState = { ...state, raceGoal: { ...current, ...goal, id: current.id } };
    return { accepted: true, rejection: null, state: next, mode: modeOf(next),
      change: "race_goal_updated", goalIdentity: "kept", reasons: [] };
  }
  const newGoalId = input.newGoalId ?? null;
  if (newGoalId === null || newGoalId.length === 0) {
    // Fail closed instead of reusing the old id for a different race.
    throw new Error("newGoalId is required when a race goal is created or its date/distance changes");
  }
  const next: TrainingConfigurationState = { ...state, raceGoal: { ...goal, id: newGoalId } };
  return {
    accepted: true,
    rejection: null,
    state: next,
    mode: modeOf(next),
    change: current === null ? "race_goal_set" : "race_goal_replaced",
    goalIdentity: current === null ? "unset" : "replaced",
    reasons: []
  };
}
