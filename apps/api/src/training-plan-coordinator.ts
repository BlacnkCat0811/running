import { digest } from "./plan-digest.js";
import { trainingPlanContextDigest } from "./training-mode-policy.js";
import type { TrainingPlanStateRow } from "./training-plan-store.js";

/**
 * PR4 remaining: the single automatic refresh decision.
 *
 * Before this module there were two independent automatic paths: the legacy hourly
 * `ensureWeeklyPlan` (which must not run while a unified state exists) and the
 * manual refresh command. This module is the **only** place that decides "the
 * migrated configuration needs a new plan now", and the only caller of refresh on a
 * timer. It is pure about the decision and stateful only for single-flight:
 *
 * - a paused configuration is never refreshed (pause revokes execution);
 * - a scope without a unified state is not this coordinator's business (legacy path);
 * - a plan with no context digest (migrated from a legacy plan) is refreshed once,
 *   because until it is, the unified read reports `plan.current: false`;
 * - a plan whose context digest no longer matches the configuration, or whose week
 *   no longer covers the business date, is refreshed;
 * - the operation id is derived from `(scope, reason, businessDate, stateRevision)`,
 *   so repeated ticks replay the stored result instead of publishing twice.
 *
 * The coordinator never generates inline: `refresh` is the PR4-3/PR4-4 command path
 * (generate outside the transaction, commit inside, re-verify the fingerprint).
 */

export type RefreshReason = "plan_missing" | "config_changed" | "business_date_changed";

export type RefreshDecision =
  | { needed: true; reason: RefreshReason }
  | { needed: false; reason: "not_migrated" | "paused" | "current" };

const WEEK_DAYS = 7;

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function refreshDecision(row: TrainingPlanStateRow | null, businessDate: string): RefreshDecision {
  if (row === null) return { needed: false, reason: "not_migrated" };
  const state = row.state;
  if (state.runState !== "active") return { needed: false, reason: "paused" };
  if (state.planContextDigest === null) return { needed: true, reason: "plan_missing" };
  const contextDigest = trainingPlanContextDigest({ raceGoal: state.raceGoal, runState: state.runState });
  if (state.planContextDigest !== contextDigest) return { needed: true, reason: "config_changed" };
  const windowEnd = shiftDate(businessDate, WEEK_DAYS - 1);
  const coversToday = (state.weekPlan ?? []).some((day) => day.localDate >= businessDate && day.localDate <= windowEnd);
  if (!coversToday) return { needed: true, reason: "business_date_changed" };
  return { needed: false, reason: "current" };
}

/** Deterministic, replay-safe operation key for an automatic refresh. */
export function coordinatorOperationId(input: {
  scopeKey: string;
  reason: RefreshReason;
  businessDate: string;
  stateRevision: number;
}): string {
  return `auto-${digest({
    kind: "training-plan-refresh",
    scopeKey: input.scopeKey,
    reason: input.reason,
    businessDate: input.businessDate,
    stateRevision: input.stateRevision
  }).slice(0, 40)}`;
}

export interface TrainingPlanCoordinatorDeps {
  scopeKey: () => string;
  readState: () => TrainingPlanStateRow | null;
  /** Runs the unified refresh command with the derived operation id. */
  refresh: (input: { operationId: string; reason: RefreshReason; businessDate: string; stateRevision: number }) => Promise<unknown>;
  businessDate: () => string;
  /** Optional observer for tests/telemetry; never used for decisions. */
  onDecision?: (decision: RefreshDecision | { needed: true; reason: RefreshReason; operationId: string; ran: boolean }) => void;
}

export class TrainingPlanCoordinator {
  private running = false;

  constructor(private readonly deps: TrainingPlanCoordinatorDeps) {}

  /**
   * One coordinator tick: decide, then run at most one refresh. Concurrent ticks
   * return immediately (`ran: false`) instead of stacking; the next tick re-decides
   * from the committed state, so a skipped tick is not a lost refresh.
   */
  async tick(): Promise<{ ran: boolean; reason: RefreshDecision["reason"] }> {
    if (this.running) return { ran: false, reason: "current" };
    const row = this.deps.readState();
    const businessDate = this.deps.businessDate();
    const decision = refreshDecision(row, businessDate);
    if (!decision.needed) {
      this.deps.onDecision?.(decision);
      return { ran: false, reason: decision.reason };
    }
    this.running = true;
    try {
      const operationId = coordinatorOperationId({
        scopeKey: this.deps.scopeKey(),
        reason: decision.reason,
        businessDate,
        stateRevision: row!.revision
      });
      await this.deps.refresh({ operationId, reason: decision.reason, businessDate, stateRevision: row!.revision });
      this.deps.onDecision?.({ needed: true, reason: decision.reason, operationId, ran: true });
      return { ran: true, reason: decision.reason };
    } finally {
      this.running = false;
    }
  }
}
