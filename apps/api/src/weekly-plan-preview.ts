import { randomUUID } from "node:crypto";
import type { MobileWeeklyPlanGenerationResponse, MobileWeeklyPlanPreviewResponse } from "@rai/api-contracts";

/** Bounded, process-local previews: restarting expires them rather than replaying stale prescriptions. */
export class WeeklyPlanPreviews {
  private readonly entries = new Map<string, { value: MobileWeeklyPlanPreviewResponse; fingerprint: string; committed?: MobileWeeklyPlanGenerationResponse }>();
  constructor(private readonly now: () => number = Date.now) {}
  clear(): void { this.entries.clear(); }
  create(value: Omit<MobileWeeklyPlanPreviewResponse, "candidateId" | "expiresAt">, fingerprint: string): MobileWeeklyPlanPreviewResponse {
    for (const [id, item] of this.entries) if (Date.parse(item.value.expiresAt) <= this.now()) this.entries.delete(id);
    while (this.entries.size >= 8) this.entries.delete(this.entries.keys().next().value!);
    const preview = { ...value, candidateId: randomUUID(), expiresAt: new Date(this.now() + 15 * 60_000).toISOString() };
    this.entries.set(preview.candidateId, { value: preview, fingerprint });
    return preview;
  }
  confirm(id: string, revision: number, fingerprint: string, write: (preview: MobileWeeklyPlanPreviewResponse) => MobileWeeklyPlanGenerationResponse, remember = true): MobileWeeklyPlanGenerationResponse {
    const item = this.entries.get(id);
    if (!item || Date.parse(item.value.expiresAt) <= this.now()) throw new PlanPreviewError("预览已过期，请重新生成；原课表未变更。");
    if (item.value.revision !== revision) throw new PlanPreviewError("预览版本不匹配，请重新生成。");
    if (item.committed) return item.committed; // A lost acknowledgement must not create a second revision.
    if (item.fingerprint !== fingerprint) throw new PlanPreviewError("目标、训练数据或日期已变化，请重新预览。原课表未变更。");
    const result = write(item.value);
    if (remember) item.committed = result;
    return result;
  }
}
export class PlanPreviewError extends Error { readonly code = "plan_preview_stale"; readonly statusCode = 409; }
