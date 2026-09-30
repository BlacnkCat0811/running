import type { SessionStratum, StratumHistory, WorkoutFeatureVector } from "@rai/contracts";
import { sessionStratum } from "./index.js";
import { createPersonalBaseline, sortWorkoutFeaturesChronologically, type PersonalBaseline } from "./model.js";

export const BASELINE_POLICY_VERSION = "rai-baseline-policy-v2" as const;
export const defaultAdaptiveBaselinePolicy = {
  lookbackDays: 28,
  extendedLookbackDays: 42,
  minimumIndependentSessions: 6,
  minimumSpanDays: 14
};
export type AdaptiveBaselinePolicy = typeof defaultAdaptiveBaselinePolicy;

export interface AdaptiveBaselineEvidence {
  baseline: PersonalBaseline | null;
  history: StratumHistory;
  stratum: SessionStratum;
  windowDays: number;
  extended: boolean;
  referenceThroughAt: string | null;
  featureIds: string[];
  status: "available" | "insufficient_evidence";
}

/**
 * Only prior, eligible, independent sessions in the same stratum. No all-history
 * fallback: absence of recent evidence must not be hidden by a years-old run.
 * Shared by live replay and offline ablation so census and learning cannot drift.
 */
export function adaptiveBaselineAt(
  features: readonly WorkoutFeatureVector[],
  current: WorkoutFeatureVector,
  policy: AdaptiveBaselinePolicy = defaultAdaptiveBaselinePolicy
): AdaptiveBaselineEvidence {
  for (const value of Object.values(policy)) {
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid adaptive baseline policy");
  }
  if (policy.lookbackDays <= 0 || policy.extendedLookbackDays < policy.lookbackDays ||
      !Number.isInteger(policy.minimumIndependentSessions) || policy.minimumIndependentSessions < 1) {
    throw new Error("Invalid adaptive baseline windows or session count");
  }
  const asOf = Date.parse(current.workoutStartAt);
  if (!Number.isFinite(asOf)) throw new Error("Invalid baseline asOf");
  const stratum = sessionStratum(current.sessionType);
  const all = sortWorkoutFeaturesChronologically([...features]).filter((row) =>
    row.trainingSessionId !== current.trainingSessionId &&
    Date.parse(row.workoutStartAt) < asOf &&
    Date.parse(row.workoutStartAt) + row.durationSeconds * 1_000 <= asOf &&
    row.eligibilityStatus === "eligible" && sessionStratum(row.sessionType) === stratum
  );
  const inWindow = (days: number) => {
    const sessions = new Map<string, WorkoutFeatureVector>();
    for (const row of all) {
      if (Date.parse(row.workoutStartAt) >= asOf - days * 86_400_000 &&
          !sessions.has(row.trainingSessionId)) sessions.set(row.trainingSessionId, row);
    }
    const rows = [...sessions.values()];
    const first = rows[0], last = rows.at(-1);
    const history = {
      independentSessions: rows.length,
      spanDays: first && last ? (Date.parse(last.workoutStartAt) - Date.parse(first.workoutStartAt)) / 86_400_000 : 0
    };
    const sufficient = history.independentSessions >= policy.minimumIndependentSessions &&
      history.spanDays >= policy.minimumSpanDays;
    return { rows, history, sufficient };
  };
  let windowDays = policy.lookbackDays;
  let selected = inWindow(windowDays);
  if (!selected.sufficient) {
    windowDays = policy.extendedLookbackDays;
    selected = inWindow(windowDays);
  }
  const baseline = selected.sufficient ? createPersonalBaseline(selected.rows) : null;
  if (baseline !== null) {
    // This is the Fitness reference, not a second recovery/cardio model.
    delete baseline.dimensions.recovery;
    delete baseline.dimensions.cardio;
  }
  return {
    baseline,
    history: selected.history, stratum, windowDays,
    extended: windowDays !== policy.lookbackDays,
    referenceThroughAt: selected.rows.at(-1)?.workoutStartAt ?? null,
    featureIds: selected.rows.map((row) => row.id),
    status: selected.sufficient ? "available" : "insufficient_evidence"
  };
}

export function buildAdaptiveBaselineTimeline(
  features: readonly WorkoutFeatureVector[],
  policy: AdaptiveBaselinePolicy = defaultAdaptiveBaselinePolicy
): AdaptiveBaselineEvidence[] {
  const ordered = sortWorkoutFeaturesChronologically([...features]);
  const windows = new Map<SessionStratum, WorkoutFeatureVector[]>();
  return ordered.map((current) => {
    const stratum = sessionStratum(current.sessionType);
    const cutoff = Date.parse(current.workoutStartAt) - policy.extendedLookbackDays * 86_400_000;
    const prior = (windows.get(stratum) ?? []).filter((row) => Date.parse(row.workoutStartAt) >= cutoff);
    const result = adaptiveBaselineAt(prior, current, policy);
    if (current.eligibilityStatus === "eligible") prior.push(current);
    windows.set(stratum, prior);
    return result;
  });
}

/** Explicit incumbent fallback while the bounded candidate remains unapproved. */
export function buildLegacyStratumHistory(features: readonly WorkoutFeatureVector[]): StratumHistory[] {
  const state = new Map<SessionStratum, { sessions: Set<string>; firstAt: string }>();
  return sortWorkoutFeaturesChronologically([...features]).map((row) => {
    const stratum = sessionStratum(row.sessionType);
    const prior = state.get(stratum);
    const result = prior ? {
      independentSessions: prior.sessions.size,
      spanDays: (Date.parse(row.workoutStartAt) - Date.parse(prior.firstAt)) / 86_400_000
    } : { independentSessions: 0, spanDays: 0 };
    if (prior) prior.sessions.add(row.trainingSessionId);
    else state.set(stratum, { sessions: new Set([row.trainingSessionId]), firstAt: row.workoutStartAt });
    return result;
  });
}

export const defaultRebasePolicy = {
  reviewEveryDays: 28, minimumEpochDays: 90, minimumIndependentSessions: 12,
  saturationFraction: 0.2, consecutiveReviews: 2
};

/** A review creates a request, never modifies the epoch or TA by itself. */
export function reviewBaselineRebase(input: {
  asOf: string; epochStartedAt: string; lastReviewedAt: string | null;
  independentSessions: number; saturatedFraction: number; precedingSaturatedReviews: number;
}, policy = defaultRebasePolicy) {
  for (const n of Object.values(policy)) {
    if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid rebase policy");
  }
  if (policy.saturationFraction > 1 ||
      !Number.isInteger(policy.minimumIndependentSessions) || !Number.isInteger(policy.consecutiveReviews)) {
    throw new Error("Invalid rebase evidence policy");
  }
  const now = Date.parse(input.asOf), epoch = Date.parse(input.epochStartedAt);
  const last = input.lastReviewedAt === null ? null : Date.parse(input.lastReviewedAt);
  if (!Number.isFinite(now) || !Number.isFinite(epoch) || epoch > now ||
      (last !== null && (!Number.isFinite(last) || last > now)) ||
      !Number.isInteger(input.independentSessions) || input.independentSessions < 0 ||
      !Number.isFinite(input.saturatedFraction) || input.saturatedFraction < 0 || input.saturatedFraction > 1 ||
      !Number.isInteger(input.precedingSaturatedReviews) || input.precedingSaturatedReviews < 0) {
    throw new Error("Invalid rebase evidence");
  }
  const base = { autoRebase: false as const, policyVersion: BASELINE_POLICY_VERSION };
  if (last !== null && now - last < policy.reviewEveryDays * 86_400_000) {
    return { ...base, status: "not_due" as const, saturatedReviews: input.precedingSaturatedReviews };
  }
  if (now - epoch < policy.minimumEpochDays * 86_400_000) {
    return { ...base, status: "epoch_cooldown" as const, saturatedReviews: 0 };
  }
  if (input.independentSessions < policy.minimumIndependentSessions) {
    return { ...base, status: "insufficient_evidence" as const, saturatedReviews: 0 };
  }
  const saturatedReviews = input.saturatedFraction >= policy.saturationFraction
    ? input.precedingSaturatedReviews + 1 : 0;
  return {
    ...base, status: saturatedReviews >= policy.consecutiveReviews ? "candidate_requested" as const : "keep_epoch" as const,
    saturatedReviews
  };
}
