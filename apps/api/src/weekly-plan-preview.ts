import { randomUUID } from "node:crypto";
import type { MobileWeeklyPlanGenerationResponse, MobileWeeklyPlanPreviewResponse } from "@rai/api-contracts";

/**
 * Upper bound on live process-local previews.
 *
 * The documented contract is "15 minutes" (docs/IOS_TRAINING_PLAN_STATE_V1.md
 * §发布操作): a preview that has not expired must stay confirmable. The old
 * code capped the map at 8 entries and evicted the oldest unconditionally, so
 * the 9th preview silently made the 1st one "expired" minutes after it was
 * created. Capacity is now a memory backstop far above any real interaction
 * pattern (preview → confirm is one round trip) and it only ever evicts when
 * more than `MAX_PREVIEWS` **still-live** candidates exist; expiry remains the
 * reason a candidate stops being confirmable.
 */
const MAX_PREVIEWS = 64;

/** Bounded, process-local previews: restarting expires them rather than replaying stale prescriptions. */
export class WeeklyPlanPreviews {
  private readonly entries = new Map<string, { value: MobileWeeklyPlanPreviewResponse; fingerprint: string; committed?: MobileWeeklyPlanGenerationResponse }>();
  constructor(private readonly now: () => number = Date.now, private readonly capacity: number = MAX_PREVIEWS) {}
  clear(): void { this.entries.clear(); }
  create(value: Omit<MobileWeeklyPlanPreviewResponse, "candidateId" | "expiresAt">, fingerprint: string): MobileWeeklyPlanPreviewResponse {
    for (const [id, item] of this.entries) if (Date.parse(item.value.expiresAt) <= this.now()) this.entries.delete(id);
    const preview = { ...value, candidateId: randomUUID(), expiresAt: new Date(this.now() + 15 * 60_000).toISOString() };
    this.entries.set(preview.candidateId, { value: preview, fingerprint });
    // Memory backstop only: a leaked loop of previews must not grow without a
    // bound, but no candidate is dropped before its lease while capacity is
    // available. When the cap is exceeded, only the oldest live entry goes.
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return preview;
  }
  /**
   * Confirms a candidate and remembers its published result.
   *
   * The result is always remembered, even for callers that pass
   * `remember = false` (kept only as a source-compatibility parameter): a lost
   * acknowledgement of a confirm that carried an `operationId` used to leave no
   * in-memory result, so a retry with a fresh operation key recomputed the
   * fingerprint against the already-advanced revision and reported
   * "目标已变化" instead of returning what was published.
   */
  confirm(
    id: string,
    revision: number,
    fingerprint: string,
    write: (preview: MobileWeeklyPlanPreviewResponse) => MobileWeeklyPlanGenerationResponse,
    _remember = true
  ): MobileWeeklyPlanGenerationResponse {
    const item = this.entries.get(id);
    if (!item || Date.parse(item.value.expiresAt) <= this.now()) throw new PlanPreviewError("预览已过期，请重新生成；原课表未变更。");
    if (item.value.revision !== revision) throw new PlanPreviewError("预览版本不匹配，请重新生成。");
    if (item.committed) return item.committed; // A lost acknowledgement must not create a second revision.
    if (item.fingerprint !== fingerprint) throw new PlanPreviewError("目标、训练数据或日期已变化，请重新预览。原课表未变更。");
    const result = write(item.value);
    item.committed = result;
    return result;
  }
}
export class PlanPreviewError extends Error { readonly code = "plan_preview_stale"; readonly statusCode = 409; }
