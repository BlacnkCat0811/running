import {
  RECOVERY_TIME_POLICY_VERSION,
  type DailyTrainingMetric,
  type RecoveryTimeEstimate,
  type SessionType,
  type TrainingFormStatus,
  type TrainingLoadTimelineDay
} from "@rai/contracts";

/**
 * Training form and recovery time (docs/ALGORITHM.md §9.6).
 *
 * Both are derived from the **same composite load** §9 already computes, and both
 * are load proxies:
 *
 * - `form` is `chronicEwma − acuteEwma`. Its unit is daily-EWMA load, not a
 *   physiological state; `formRatio` exists because absolute load units are not
 *   comparable between athletes or across a training history of different scale.
 * - recovery time extrapolates from the last session's load. It is not a measured
 *   recovery state, carries `isLoadProxy: true`, and never overrides Readiness,
 *   the plan, or `TrainingStatusCode` (§9.5 / L03 — one raised signal must not
 *   silently rewrite everything else).
 *
 * Read-time only: persisted `daily_training_metrics` rows are untouched, so no
 * model-run scale changes and the transition gate sees exactly the same numbers
 * it saw before.
 */

export { RECOVERY_TIME_POLICY_VERSION, TRAINING_FORM_POLICY_VERSION } from "@rai/contracts";

/**
 * Form bands, expressed on `formRatio`.
 *
 * These are conventional load-management bands (the same ±10 %/±25 %/±30 % regions
 * coaches use around a TSB-style curve), chosen as named constants so a change is
 * a visible policy decision rather than a tweak inside a comparison. They are
 * **not** validated against outcomes here, and `docs/ALGORITHM.md` says so.
 */
export interface TrainingFormConfig {
  readonly transitionAbove: number;
  readonly freshAbove: number;
  readonly neutralAbove: number;
  readonly loadedAbove: number;
}

export const defaultTrainingFormConfig: TrainingFormConfig = {
  transitionAbove: 0.25,
  freshAbove: 0.05,
  neutralAbove: -0.1,
  loadedAbove: -0.3
};

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function classifyTrainingForm(formRatio: number | null, config: TrainingFormConfig = defaultTrainingFormConfig): TrainingFormStatus {
  if (!finite(formRatio)) return "insufficient_data";
  if (formRatio > config.transitionAbove) return "transition";
  if (formRatio > config.freshAbove) return "fresh";
  if (formRatio > config.neutralAbove) return "neutral";
  if (formRatio > config.loadedAbove) return "loaded";
  return "overreached";
}

/**
 * Adds the form curve to persisted daily metrics at read time.
 *
 * `form` is null — and the status `insufficient_data` — until both EWMAs are
 * meaningful. A chronic load of zero cannot produce a ratio, and inventing one
 * would render as "neutral" on an empty history.
 */
export function withTrainingForm(
  days: readonly DailyTrainingMetric[],
  config: TrainingFormConfig = defaultTrainingFormConfig
): TrainingLoadTimelineDay[] {
  return days.map((day) => {
    const acute = finite(day.acuteEwma) ? day.acuteEwma : null;
    const chronic = finite(day.chronicEwma) ? day.chronicEwma : null;
    if (acute === null || chronic === null || chronic <= 0) {
      return { ...day, form: null, formRatio: null, formStatus: "insufficient_data" as const };
    }
    const form = chronic - acute;
    const ratio = form / chronic;
    return {
      ...day,
      form: Math.round(form * 100) / 100,
      formRatio: Math.round(ratio * 1000) / 1000,
      formStatus: classifyTrainingForm(ratio, config)
    };
  });
}

// -----------------------------------------------------------------------------
// Recovery time
// -----------------------------------------------------------------------------

/**
 * Base hours until a quality session is supported again, per session type.
 *
 * These are **policy constants**, not measurements. They are deliberately on the
 * conservative side and are scaled by how large the session was relative to the
 * athlete's own chronic load, so the same session type is not treated identically
 * for a 40 km/week and a 120 km/week runner.
 */
export const RECOVERY_BASE_HOURS: Record<SessionType, number> = {
  unknown: 18,
  recovery: 8,
  easy: 12,
  steady: 18,
  long_run: 36,
  tempo: 30,
  interval: 42,
  race: 72
};

export interface RecoveryTimeConfig {
  readonly maximumHours: number;
  readonly minimumRelativeLoad: number;
  readonly maximumRelativeLoad: number;
  /** Multiplier applied when today's Readiness is `strained` / `caution`. */
  readonly strainedMultiplier: number;
  readonly cautionMultiplier: number;
}

export const defaultRecoveryTimeConfig: RecoveryTimeConfig = {
  maximumHours: 96,
  minimumRelativeLoad: 0.5,
  maximumRelativeLoad: 3,
  strainedMultiplier: 1.25,
  cautionMultiplier: 1.1
};

export interface RecentLoadInput {
  trainingSessionId: string;
  localDate: string;
  endedAt: string;
  load: number;
  sessionType: SessionType;
  confidence: number;
}

export interface RecoveryTimeInput {
  now: Date;
  /** Most recent sessions first or unordered; only ones already finished are used. */
  recentLoads: readonly RecentLoadInput[];
  chronicEwma: number | null;
  physState?: "no_low_signal" | "caution" | "strained" | "not_assessed" | undefined;
  config?: RecoveryTimeConfig;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/**
 * Load-proxy recovery estimate.
 *
 * Deliberately reports `insufficient_data` instead of 0 when there is no finished
 * session or no chronic context: "we do not know" and "you are recovered" are
 * different statements, and only one of them is supportable from an empty store.
 */
export function estimateRecoveryTime(input: RecoveryTimeInput): RecoveryTimeEstimate {
  const config = input.config ?? defaultRecoveryTimeConfig;
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("estimateRecoveryTime requires a finite now");

  const finished = input.recentLoads
    .filter((item) => finite(item.load) && item.load > 0 && Number.isFinite(Date.parse(item.endedAt)))
    .filter((item) => Date.parse(item.endedAt) <= nowMs)
    .sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt));
  const latest = finished[0];
  if (!latest) {
    return {
      policyVersion: RECOVERY_TIME_POLICY_VERSION,
      status: "insufficient_data",
      remainingHours: null,
      readyAt: null,
      anchor: null,
      basisCodes: ["no_finished_session_with_load"],
      isLoadProxy: true,
      confidence: null
    };
  }

  const chronic = input.chronicEwma;
  if (!finite(chronic) || chronic <= 0) {
    return {
      policyVersion: RECOVERY_TIME_POLICY_VERSION,
      status: "insufficient_data",
      remainingHours: null,
      readyAt: null,
      anchor: {
        trainingSessionId: latest.trainingSessionId,
        localDate: latest.localDate,
        endedAt: latest.endedAt,
        load: latest.load,
        sessionType: latest.sessionType
      },
      basisCodes: ["no_chronic_load_context"],
      isLoadProxy: true,
      confidence: null
    };
  }

  const basisCodes: string[] = ["load_proxy_not_measurement"];
  const relative = clamp(latest.load / chronic, config.minimumRelativeLoad, config.maximumRelativeLoad);
  if (relative >= config.maximumRelativeLoad) basisCodes.push("relative_load_capped");
  let hours = RECOVERY_BASE_HOURS[latest.sessionType] * relative;

  if (input.physState === "strained") {
    hours *= config.strainedMultiplier;
    basisCodes.push("readiness_strained_multiplier");
  } else if (input.physState === "caution") {
    hours *= config.cautionMultiplier;
    basisCodes.push("readiness_caution_multiplier");
  }
  if (hours > config.maximumHours) {
    hours = config.maximumHours;
    basisCodes.push("recovery_capped_at_maximum");
  }

  // A later session inside the window restarts the clock; the estimate is the
  // latest one, not the sum. Their loads already accumulate through the EWMA.
  const elapsedHours = (nowMs - Date.parse(latest.endedAt)) / 3_600_000;
  const remainingHours = Math.max(0, hours - elapsedHours);
  if (remainingHours === 0) basisCodes.push("recovery_window_elapsed");
  if (latest.confidence < 0.5) basisCodes.push("low_load_confidence");

  return {
    policyVersion: RECOVERY_TIME_POLICY_VERSION,
    status: "available",
    remainingHours: Math.round(remainingHours * 10) / 10,
    readyAt: new Date(nowMs + remainingHours * 3_600_000).toISOString(),
    anchor: {
      trainingSessionId: latest.trainingSessionId,
      localDate: latest.localDate,
      endedAt: latest.endedAt,
      load: latest.load,
      sessionType: latest.sessionType
    },
    basisCodes,
    isLoadProxy: true,
    confidence: Math.round(latest.confidence * 100) / 100
  };
}
