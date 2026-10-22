import type { MobilePlanReceiptInput, MobileSessionStructure } from "@rai/api-contracts";

import { isValidLocalDate } from "./local-date.js";
import { digest, prescriptionDigest } from "./plan-digest.js";
import { PlanOperationError } from "./plan-publication.js";
import { normalizeSessionStructure } from "./session-structure.js";

/**
 * Identity a v2 plan receipt must belong to.
 *
 * Kept as a structural type so the route can pass the process-wide
 * `{ serverId, athleteId, datasetEpoch }` without importing server state.
 */
export interface PlanReceiptIdentity {
  serverId: string;
  athleteId: string;
  datasetEpoch: string;
}

/** The canonical structure that is safe to persist and to compare by identity. */
export interface NormalizedPlanReceiptV2 {
  structure: MobileSessionStructure;
}

const evidenceMismatch = (message: string): never => {
  throw new PlanOperationError("plan_receipt_evidence_mismatch", message, 422);
};

/**
 * Validates a contract-v2 plan receipt and returns its canonical structure.
 *
 * The wire format deliberately accepts two shapes for the same prescription:
 * a normalized structure (every optional key present, `null` where unknown)
 * and the shape Swift's synthesized `Codable` produces (nil optionals are
 * omitted). Both describe the same prescription, so both are valid input; the
 * *stored* identity is always the normalized one.
 *
 * This replaces a strict `digest(normalize(x)) === digest(x)` check: that
 * check rejected every real iOS receipt for sessions with a recovery step or
 * a nil warmup/cooldown, and crashed with a `TypeError` when `warmup` was
 * absent entirely (see `plan-digest.ts` step handling). Normalizing first
 * keeps the identity canonical without making the client's encoder part of
 * the contract.
 */
export function normalizePlanReceiptV2(
  body: MobilePlanReceiptInput,
  identity: PlanReceiptIdentity,
  nowMs: number = Date.now()
): NormalizedPlanReceiptV2 {
  const required = [
    body.scope, body.operationId, body.coherenceToken, body.workoutID, body.scheduledAt,
    body.verifiedAt, body.timezone, body.prescriptionDigest, body.lifecycleEvent, body.structure
  ];
  if (required.some((value) => value == null) || body.revision == null) {
    throw new PlanOperationError("plan_receipt_contract_mismatch", "新回执缺少必要核验字段。", 422);
  }
  if (!isValidLocalDate(body.localDate)) {
    throw new PlanOperationError("plan_receipt_date_invalid", "回执日期无效。", 422);
  }
  if (digest(body.scope) !== digest(identity)) {
    throw new PlanOperationError("plan_receipt_scope_mismatch", "回执属于其他服务或数据集。");
  }

  const scheduledAtMs = Date.parse(body.scheduledAt!);
  const verifiedAtMs = Date.parse(body.verifiedAt!);
  if (!Number.isFinite(scheduledAtMs) || !Number.isFinite(verifiedAtMs) || verifiedAtMs > nowMs + 300_000) {
    evidenceMismatch("回执日期或核验时刻无效。");
  }
  let scheduledDate: string;
  try {
    scheduledDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: body.timezone!, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date(scheduledAtMs));
  } catch {
    return evidenceMismatch("回执时区无效。");
  }
  if (scheduledDate !== body.localDate) {
    evidenceMismatch("回执日期与计划时刻不一致。");
  }

  const structure = normalizeSessionStructure(body.structure);
  if (!structure) {
    throw new PlanOperationError("plan_receipt_evidence_mismatch", "实际导出结构无法规范化。", 422);
  }
  if (prescriptionDigest(body.kind, structure) !== body.prescriptionDigest) {
    evidenceMismatch("实际导出摘要与回执不一致。");
  }
  return { structure };
}
