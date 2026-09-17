import type { MobilePlanExecutionDay } from "@rai/api-contracts";
import type { PlanHistoryRevision } from "./mobile-goals.js";

/** Read-time observations only. An import timestamp is not proof of complete day coverage. */
export function buildPlanExecution(
  today: string,
  history: PlanHistoryRevision[],
  actual: Array<{ localDate: string; distanceKm: number; workoutCount: number }>
): MobilePlanExecutionDay[] {
  const byDate = new Map(actual.map((day) => [day.localDate, day]));
  const revisions = [...history].filter((item) => Number.isFinite(Date.parse(item.changedAt)))
    .sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt) || b.revision - a.revision);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 7 + index);
    const localDate = date.toISOString().slice(0, 10);
    // Freeze at local midnight: later edits must not rewrite yesterday's obligations.
    // Same-day plans are deliberately not inferred until receipt-level reconciliation exists.
    const boundary = Date.parse(`${localDate}T00:00:00+08:00`);
    const revision = revisions.find((item) => Date.parse(item.changedAt) < boundary);
    const planned = revision?.weekPlan.find((day) => day.localDate === localDate);
    const observed = byDate.get(localDate);
    const distanceKm = observed?.distanceKm ?? 0;
    const workoutCount = observed?.workoutCount ?? 0;
    const plannedDistanceKm = planned?.distanceKm != null && Number.isFinite(planned.distanceKm)
      ? Math.max(0, planned.distanceKm) : null;
    return {
      localDate,
      planRevision: planned ? revision!.revision : null,
      plannedKind: planned?.kind ?? null,
      plannedDistanceKm,
      observedDistanceKm: distanceKm,
      observedWorkoutCount: workoutCount,
      distanceRatio: workoutCount > 0 && plannedDistanceKm != null && plannedDistanceKm > 0
        ? distanceKm / plannedDistanceKm : null,
      status: workoutCount > 0 ? "observed" : planned ? "pending" : "unknown"
    };
  });
}
