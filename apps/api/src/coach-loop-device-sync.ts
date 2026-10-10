import type { CoachLoopDeviceReceipt, CoachLoopRuntimeResponse, MobilePlanOperationScope } from "@rai/api-contracts";
import { planDayWithLock, type MobileGoalsStore } from "./mobile-goals.js";
import { PlanOperationError } from "./plan-publication.js";
import { digest, prescriptionDigest } from "./plan-digest.js";
import { normalizeSessionStructure } from "./session-structure.js";
import { coachLocalDate } from "./coach-loop-facts.js";
import { DATABASE_TIMEZONE } from "@rai/contracts";

/** Registers evidence only. No device side effects, no new training authority. */
export function recordCoachLoopDeviceReceipt(
  store: MobileGoalsStore, scope: MobilePlanOperationScope, read: () => CoachLoopRuntimeResponse,
  body: CoachLoopDeviceReceipt, publicationReady: () => boolean
) {
  const fail = (code: string, message: string, status = 409): never => { throw new PlanOperationError(code, message, status); };
  if (body.contractVersion !== 2 || body.coachLoop?.contractVersion !== 1 || !body.scope ||
    !body.operationId || !body.coherenceToken || !body.workoutID || !body.scheduledAt || !body.verifiedAt ||
    body.timezone !== DATABASE_TIMEZONE || !body.prescriptionDigest || !body.lifecycleEvent || !body.structure ||
    body.revision == null || !body.idempotencyKey)
    fail("coach_receipt_contract_mismatch", "新版排期回执缺少核验字段。", 422);
  if (digest(body.scope) !== digest(scope)) fail("plan_receipt_scope_mismatch", "回执属于其他服务或数据集。");
  if (!Number.isFinite(Date.parse(body.verifiedAt!)) || Date.parse(body.verifiedAt!) > Date.now() + 300_000 ||
    coachLocalDate(body.scheduledAt!) !== body.localDate ||
    prescriptionDigest(body.kind, body.structure!) !== body.prescriptionDigest ||
    digest(normalizeSessionStructure(body.structure)) !== digest(body.structure))
    fail("coach_receipt_evidence_mismatch", "实际导出结构、日期或核验时刻不一致。", 422);
  const matchesCurrent = (current: CoachLoopRuntimeResponse) => {
    const duplicateActive = store.activePlanPushes().some(push =>
      push.localDate === body.localDate && push.workoutID && push.scheduledAt &&
      (push.workoutID !== body.workoutID || push.scheduledAt !== body.scheduledAt) &&
      store.planPushIsActive(push.workoutID, push.scheduledAt));
    return body.lifecycleEvent === "verified" && publicationReady() &&
      !duplicateActive && current.settings?.status === "active" && !current.refreshRequired &&
      body.revision === current.revision && body.coherenceToken === current.executionToken &&
      body.coachLoop.policyHash === current.policyHash && body.localDate === current.today.day.localDate &&
      current.today.executable && current.today.day.kind === body.kind &&
      body.coachLoop.decisionRef === current.today.decisionRef &&
      prescriptionDigest(current.today.day.kind, current.today.day.structure ?? null) === body.prescriptionDigest;
  };
  // Hold the control-db write lock through revalidation and receipt insertion.
  // recordPlanPush participates in this transaction rather than nesting one.
  const result = store.publicationOperation(JSON.stringify(scope), `coach-sync:${body.idempotencyKey}`, "coach-loop-synced", body, () => {
    const original = store.planPushForSystemEntry(body.workoutID!, body.scheduledAt!);
    if (body.lifecycleEvent !== "verified" && (!original || digest(original.scope) !== digest(scope) ||
      original.prescriptionDigest !== body.prescriptionDigest || digest(original.coachLoop) !== digest(body.coachLoop)))
      fail("coach_receipt_unknown_schedule", "不能撤销未登记或内容不匹配的排期。");
    const current = read();
    const history = store.planHistory(200).find(row => row.revision === body.revision);
    const historicalDay = history ? planDayWithLock(history, body.localDate) : undefined;
    const knownPublication = store.coachLoopReceipts<import("./coach-loop-runtime.js").CoachRuntimeReceipt>(JSON.stringify(scope))
      .some(receipt => receipt.policyHash === body.coachLoop.policyHash && receipt.goalsRevision === body.revision &&
        (body.coachLoop.decisionRef === null || receipt.reservations.some(slot =>
          slot.decisionRef === body.coachLoop.decisionRef && slot.localDate === body.localDate &&
          slot.prescriptionDigest === body.prescriptionDigest)));
    if (body.lifecycleEvent === "verified" && (!knownPublication || historicalDay?.kind !== body.kind ||
      prescriptionDigest(historicalDay.kind, historicalDay.structure ?? null) !== body.prescriptionDigest))
      fail("coach_receipt_unknown_prescription", "回执必须关联真实发布过的处方与授权。");
    // Stale verified schedules are retained as historical device evidence and
    // occupancy, but explicitly never certified as the current executable plan.
    const recordedAt = store.recordPlanPush({ ...body, revision: body.revision!,
      structure: body.structure!, pushedAt: new Date().toISOString(), matchesCurrent: matchesCurrent(current) });
    return { recordedAt, informationLevel: "verifiedClient" };
  });
  // Operation idempotency preserves the original immutable receipt, not an
  // eternal execution lease. Recompute this read-only conclusion even when
  // publicationOperation returned a previously committed result.
  return { ...result, matchesCurrent: matchesCurrent(read()) && store.planPushIsActive(body.workoutID!, body.scheduledAt!) };
}
