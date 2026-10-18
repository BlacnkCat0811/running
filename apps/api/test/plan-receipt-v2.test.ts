import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MobilePlanReceiptInput, MobileSessionStructure } from "@rai/api-contracts";

import { MobileGoalsStore } from "../src/mobile-goals.js";
import { digest, prescriptionDigest } from "../src/plan-digest.js";
import { normalizePlanReceiptV2 } from "../src/plan-receipt.js";

const NOW = Date.parse("2026-10-08T04:00:00.000Z");
const IDENTITY = { serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" };

/**
 * The shape Swift's synthesized Codable actually puts on the wire for a session
 * whose warmup/cooldown and step alert are nil: the keys are omitted entirely.
 * This exact shape used to fail the route's strict canonical check (422) or
 * crash `prescriptionDigest` (500) — see review report P1-1.
 */
const swiftShapedStructure = {
  blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 4000 } }] }]
} as unknown as MobileSessionStructure;

function receipt(overrides: Partial<MobilePlanReceiptInput> = {}): MobilePlanReceiptInput {
  return {
    contractVersion: 2,
    localDate: "2026-10-09",
    kind: "easy",
    revision: 12,
    structure: swiftShapedStructure,
    workoutID: "00000000-0000-4000-8000-000000000001",
    scheduledAt: "2026-10-09T07:00:00+08:00",
    idempotencyKey: "00000000-0000-4000-8000-000000000001:verified",
    scope: { ...IDENTITY },
    operationId: "11111111-1111-4111-8111-111111111111",
    coherenceToken: "a".repeat(64),
    verifiedAt: "2026-10-08T04:00:00.000Z",
    timezone: "Asia/Shanghai",
    prescriptionDigest: prescriptionDigest("easy", swiftShapedStructure),
    lifecycleEvent: "verified",
    ...overrides
  };
}

function thrown(run: () => unknown): { code?: string; statusCode?: number; message?: string } {
  try {
    run();
  } catch (error) {
    return error as { code?: string; statusCode?: number; message?: string };
  }
  throw new Error("expected the call to throw");
}

test("Swift's omitted-nil structure is accepted and canonicalized, not 422/500", () => {
  const normalized = normalizePlanReceiptV2(receipt(), IDENTITY, NOW).structure;
  assert.deepEqual(normalized, {
    warmup: null,
    blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 4000 }, alert: null }] }],
    cooldown: null
  });
  // The old strict check compared these two digests and rejected the world the
  // iOS client actually sends.
  assert.notEqual(digest(normalized), digest(swiftShapedStructure));
  assert.equal(prescriptionDigest("easy", normalized), receipt().prescriptionDigest);
  // An already-normalized wire shape is accepted too: identity is idempotent.
  const second = normalizePlanReceiptV2(receipt({ structure: normalized }), IDENTITY, NOW).structure;
  assert.deepEqual(second, normalized);
});

test("prescriptionDigest tolerates a missing warmup/cooldown key instead of throwing", () => {
  assert.doesNotThrow(() => prescriptionDigest("easy", swiftShapedStructure));
  const blockOnly = { blocks: swiftShapedStructure.blocks } as unknown as MobileSessionStructure;
  assert.doesNotThrow(() => prescriptionDigest("easy", blockOnly));
  assert.equal(prescriptionDigest("easy", swiftShapedStructure), prescriptionDigest("easy", blockOnly));
});

test("a digest that does not match the canonical structure is rejected as 422 evidence mismatch", () => {
  const error = thrown(() => normalizePlanReceiptV2(receipt({ prescriptionDigest: "0".repeat(64) }), IDENTITY, NOW));
  assert.equal(error.code, "plan_receipt_evidence_mismatch");
  assert.equal(error.statusCode, 422);
});

test("a receipt for another dataset is rejected as 409 scope mismatch", () => {
  const error = thrown(() => normalizePlanReceiptV2(receipt({
    scope: { ...IDENTITY, datasetEpoch: "other-epoch" }
  }), IDENTITY, NOW));
  assert.equal(error.code, "plan_receipt_scope_mismatch");
  assert.equal(error.statusCode, 409);
});

test("verifiedAt in the future beyond five minutes and unparsable instants are 422", () => {
  const future = new Date(NOW + 6 * 60_000).toISOString();
  assert.equal(thrown(() => normalizePlanReceiptV2(receipt({ verifiedAt: future }), IDENTITY, NOW)).code,
    "plan_receipt_evidence_mismatch");
  assert.equal(thrown(() => normalizePlanReceiptV2(receipt({ scheduledAt: "not-a-date" }), IDENTITY, NOW)).code,
    "plan_receipt_evidence_mismatch");
});

test("a structure with no usable canonical content is rejected instead of storing null", () => {
  const empty = { warmup: null, blocks: [], cooldown: null } as MobileSessionStructure;
  const error = thrown(() => normalizePlanReceiptV2(receipt({
    structure: empty,
    prescriptionDigest: prescriptionDigest("easy", empty)
  }), IDENTITY, NOW));
  assert.equal(error.code, "plan_receipt_evidence_mismatch");
  assert.equal(error.statusCode, 422);
});

test("the store persists the canonical structure and deduplicates both wire shapes", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-plan-receipt-"));
  const store = new MobileGoalsStore(root, join(root, "control.sqlite"));
  try {
    const canonical = normalizePlanReceiptV2(receipt(), IDENTITY, NOW).structure;
    const firstAt = store.recordPlanPush({
      ...receipt(),
      structure: canonical,
      revision: 12,
      pushedAt: "2026-10-08T04:00:00.000Z",
      matchesCurrent: true
    });
    const againAt = store.recordPlanPush({
      // A second client that sends the Swift-shaped wire form must be treated
      // as the same system entry after normalization, not as a key conflict.
      ...receipt(),
      structure: canonical,
      revision: 12,
      pushedAt: "2026-10-08T04:05:00.000Z",
      matchesCurrent: false
    });
    assert.equal(againAt, firstAt);
    const stored = store.planPushForSystemEntry(receipt().workoutID!, receipt().scheduledAt!);
    assert.ok(stored);
    assert.deepEqual(stored?.structure, canonical);
    assert.equal((stored?.structure as { warmup?: unknown } | null)?.warmup, null);
    assert.equal(store.planPushIsActive(receipt().workoutID!, receipt().scheduledAt!), true);

    store.recordPlanPush({
      ...receipt({ lifecycleEvent: "withdrawn",
        idempotencyKey: "00000000-0000-4000-8000-000000000001:withdrawn" }),
      structure: canonical,
      revision: 12,
      pushedAt: "2026-10-08T04:10:00.000Z"
    });
    assert.equal(store.planPushIsActive(receipt().workoutID!, receipt().scheduledAt!), false,
      "a withdrawal with the same canonical identity deactivates the entry");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
