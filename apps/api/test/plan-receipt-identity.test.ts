import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { MobilePlanOperationScope, MobileSessionStructure } from "@rai/api-contracts";

import { MobileGoalsStore, type PlanPushRecord } from "../src/mobile-goals.js";
import { prescriptionDigest } from "../src/plan-digest.js";

const IDENTITY: MobilePlanOperationScope = { serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" };
const OTHER_IDENTITY: MobilePlanOperationScope = { ...IDENTITY, datasetEpoch: "restored-dataset" };

const structure: MobileSessionStructure = {
  warmup: null,
  blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 4000 }, alert: null }] }],
  cooldown: null
};

let nextWorkout = 0;
const workoutID = (): string => `ab8f0784-1111-4111-8111-${String(++nextWorkout).padStart(12, "0")}`;

function receipt(overrides: Partial<PlanPushRecord> = {}): PlanPushRecord {
  const workout = overrides.workoutID ?? workoutID();
  return {
    localDate: "2026-10-09",
    kind: "easy",
    revision: 12,
    structure,
    pushedAt: "2026-10-08T23:00:00.000Z",
    contractVersion: 2,
    scope: IDENTITY,
    workoutID: workout,
    scheduledAt: "2026-10-09T07:00:00+08:00",
    idempotencyKey: `${workout}:verified`,
    operationId: "11111111-1111-4111-8111-111111111111",
    coherenceToken: "a".repeat(64),
    verifiedAt: "2026-10-08T22:00:00.000Z",
    timezone: "Asia/Shanghai",
    prescriptionDigest: prescriptionDigest("easy", structure),
    lifecycleEvent: "verified",
    ...overrides
  };
}

const withStore = <T>(run: (fixture: { store: MobileGoalsStore; root: string; controlPath: string }) => T): T => {
  const root = mkdtempSync(join(tmpdir(), "rai-receipt-identity-"));
  const controlPath = join(root, "var", "rai-control.sqlite");
  const store = new MobileGoalsStore(root, controlPath);
  try {
    return run({ store, root, controlPath });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
};

const captureError = (run: () => unknown): (Error & { code?: string; statusCode?: number }) | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error as Error & { code?: string; statusCode?: number };
  }
};

test("v2 receipts are stored with a canonical UUID and UTC instant, and either spelling addresses them", () => {
  withStore(({ store }) => {
    const raw = receipt({ workoutID: workoutID().toLowerCase(), scheduledAt: "2026-10-09T07:00:00+08:00" });
    store.recordPlanPush(raw);
    const stored = store.planPushes("2026-01-01")[0];
    assert.equal(stored?.workoutID, raw.workoutID!.toUpperCase(), "UUID is stored upper case");
    assert.equal(stored?.scheduledAt, "2026-10-08T23:00:00.000Z", "instant is stored as UTC ISO");
    // The same entry found by its raw spelling, its canonical spelling and an
    // equivalent ISO representation of the same instant.
    for (const [id, at] of [
      [raw.workoutID!.toLowerCase(), "2026-10-09T07:00:00+08:00"],
      [raw.workoutID!.toUpperCase(), "2026-10-08T23:00:00.000Z"],
      [raw.workoutID!.toLowerCase(), "2026-10-08T23:00:00Z"]
    ] as const) {
      assert.ok(store.planPushForSystemEntry(id, at), `entry must be found as ${id} @ ${at}`);
      assert.equal(store.planPushIsActive(id, at), true);
    }
  });
});

test("an equivalent spelling is the same entry, not a second row", () => {
  withStore(({ store }) => {
    const first = receipt({ scheduledAt: "2026-10-09T07:00:00+08:00" });
    const recordedAt = store.recordPlanPush(first);
    // A retry rendered by another formatter: same UUID/instant, different bytes.
    const retry = store.recordPlanPush({ ...first, scheduledAt: "2026-10-08T23:00:00Z", pushedAt: "2026-10-09T01:00:00.000Z" });
    assert.equal(retry, recordedAt);
    assert.equal(store.planPushes("2026-01-01").length, 1);
  });
});

test("a withdrawal spelled differently still deactivates the entry, for both spellings", () => {
  withStore(({ store }) => {
    const verified = receipt({ scheduledAt: "2026-10-09T07:00:00+08:00" });
    store.recordPlanPush(verified);
    store.recordPlanPush({
      ...verified,
      scheduledAt: "2026-10-08T23:00:00Z",
      lifecycleEvent: "withdrawn",
      idempotencyKey: `${verified.workoutID}:withdrawn`,
      pushedAt: "2026-10-09T02:00:00.000Z"
    });
    assert.equal(store.planPushIsActive(verified.workoutID!, "2026-10-09T07:00:00+08:00"), false);
    assert.equal(store.planPushIsActive(verified.workoutID!.toLowerCase(), "2026-10-08T23:00:00.000Z"), false);
    // The verification stays as history; `planPushForSystemEntry` only ever
    // returns the verified event, and the withdrawal is what makes it inactive.
    assert.equal(store.planPushForSystemEntry(verified.workoutID!, "2026-10-09T07:00:00+08:00")?.lifecycleEvent, "verified");
    // Two rows: the verification and the withdrawal event, as lifecycle history requires.
    assert.equal(store.planPushes("2026-01-01").length, 2);
  });
});

test("unparsable identity is refused with a diagnosable 422 instead of being stored raw", () => {
  withStore(({ store }) => {
    const badTime = captureError(() => store.recordPlanPush(receipt({ scheduledAt: "not-an-instant" })));
    assert.equal(badTime?.code, "plan_receipt_date_invalid");
    assert.equal(badTime?.statusCode, 422);
    const badID = captureError(() => store.recordPlanPush(receipt({ workoutID: "not-a-uuid" })));
    assert.equal(badID?.code, "plan_receipt_contract_mismatch");
    assert.equal(badID?.statusCode, 422);
    assert.equal(store.planPushes("2026-01-01").length, 0);
  });
});

test("the idempotency key is unique per dataset, not globally", () => {
  withStore(({ store }) => {
    const key = "client-generated-key";
    const first = receipt({ idempotencyKey: key, scope: IDENTITY });
    store.recordPlanPush(first);
    // Same key, another dataset: a restored control database is not a retry.
    const other = receipt({ idempotencyKey: key, scope: OTHER_IDENTITY, workoutID: workoutID() });
    assert.equal(store.recordPlanPush(other), other.pushedAt);
    assert.equal(store.planPushes("2026-01-01").length, 2);
    // Same key, same dataset, different content: still a conflict.
    const conflict = captureError(() => store.recordPlanPush(receipt({
      idempotencyKey: key,
      scope: IDENTITY,
      workoutID: workoutID(),
      scheduledAt: "2026-10-10T07:00:00+08:00",
      localDate: "2026-10-10"
    })));
    assert.equal(conflict?.code, "plan_receipt_key_conflict");
    assert.equal(store.planPushes("2026-01-01").length, 2);
  });
});

test("the same UUID/instant/event on another day is a conflict, not a silent repeat", () => {
  withStore(({ store }) => {
    const first = receipt();
    const recordedAt = store.recordPlanPush(first);
    // Same day + same key is the idempotent lost-reply retry.
    assert.equal(store.recordPlanPush({ ...first, pushedAt: "2026-10-09T00:00:00.000Z" }), recordedAt);
    // Different localDate cannot describe the same instant; treating it as a
    // repeat (the old query ignored localDate) silently dropped the conflict.
    const otherDay = captureError(() => store.recordPlanPush({ ...first, localDate: "2026-10-10" }));
    assert.equal(otherDay?.code, "plan_receipt_key_conflict");
    assert.equal(store.planPushes("2026-01-01").length, 1);
  });
});

test("publication transactions bracket the guard marker and roll back both spans", () => {
  withStore(({ store }) => {
    const before = store.publicationGuardState();
    let inside = before;
    const result = store.withPublicationTransaction(() => {
      inside = store.publicationGuardState();
      return store.write({});
    });
    assert.equal(result.revision, 1);
    assert.equal(inside.epoch, before.epoch + 1, "a publication starts one guard epoch");
    // The marker is committed by this publication itself, so a read inside the
    // transaction must not report it as a foreign pending publication (see the
    // dedicated own-marker test for the raw table assertion).
    assert.equal(inside.pendingSince, null);
    const after = store.publicationGuardState();
    assert.equal(after.epoch, before.epoch + 1);
    assert.equal(after.pendingSince, null, "the marker is cleared after the transaction");

    const revision = store.read().revision;
    const failure = captureError(() => store.withPublicationTransaction(() => {
      store.write({});
      throw new Error("boom-after-write");
    }));
    assert.equal(failure?.message, "boom-after-write");
    assert.equal(store.read().revision, revision, "the business write rolled back");
    assert.equal(store.publicationGuardState().pendingSince, null, "a failed publication still clears its marker");

    // Nested use is direct: it must not bump the epoch a second time or open a
    // second transaction (recordPlanPush/write rely on the flag).
    let epochWhileNested = 0;
    store.withPublicationTransaction(() => {
      const epoch = store.publicationGuardState().epoch;
      store.withPublicationTransaction(() => store.write({}));
      epochWhileNested = store.publicationGuardState().epoch;
      assert.equal(epochWhileNested, epoch);
      store.recordPlanPush(receipt());
    });
    assert.equal(store.planPushes("2026-01-01").length, 1);
  });
});

test("a publication's own guard marker is hidden from reads inside its transaction and cleared after", () => {
  withStore(({ store, controlPath }) => {
    const outside = new DatabaseSync(controlPath);
    try {
      const marker = () => (outside.prepare(
        "SELECT epoch, pending_since FROM mobile_publication_guard WHERE id = 1"
      ).get() as { epoch: number; pending_since: string | null });
      assert.equal(marker().pending_since, null);
      let inside = store.publicationGuardState();
      store.withPublicationTransaction(() => {
        // The marker is committed before the business transaction, so another
        // connection can see it; the store must still not report it as a foreign
        // publication to code running inside that same transaction.
        assert.ok(marker().pending_since !== null, "the marker is committed before the business write");
        inside = store.publicationGuardState();
        assert.equal(inside.pendingSince, null);
        assert.ok(inside.epoch > 0);
      });
      const after = store.publicationGuardState();
      assert.equal(after.pendingSince, null);
      assert.equal(marker().pending_since, null, "the marker is cleared after the transaction commits");
      assert.equal(after.epoch, inside.epoch);
    } finally {
      outside.close();
    }
  });
});

test("a control-less store runs the transaction directly and reports an empty guard", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-receipt-filemode-"));
  const store = new MobileGoalsStore(root);
  try {
    let inside = store.publicationGuardState();
    const value = store.withPublicationTransaction(() => {
      inside = store.publicationGuardState();
      return 7;
    });
    assert.equal(value, 7);
    assert.deepEqual(inside, { epoch: 0, pendingSince: null });
    assert.deepEqual(store.publicationGuardState(), { epoch: 0, pendingSince: null });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("publicationOperation takes the guard on a new operation and leaves replay untouched", () => {
  withStore(({ store }) => {
    const scope = JSON.stringify(IDENTITY);
    const input = { operationId: "22222222-2222-4222-8222-222222222222", expectedRevision: 0 };
    const first = store.publicationOperation(scope, input.operationId, "goals", input, () => ({ revision: 1, marker: "first" }));
    assert.deepEqual(first, { revision: 1, marker: "first" });
    const afterFirst = store.publicationGuardState();
    assert.equal(afterFirst.epoch, 1);
    assert.equal(afterFirst.pendingSince, null);

    // Replay must be a read: same result, no guard bump.
    const replay = store.publicationOperation(scope, input.operationId, "goals", input, () => ({ revision: 999, marker: "second" }));
    assert.deepEqual(replay, first);
    assert.equal(store.publicationGuardState().epoch, afterFirst.epoch);

    // Legacy clients (no operationId) still publish under the guard.
    const legacy = store.publicationOperation(scope, undefined, "goals", { expectedRevision: 1 }, () => ({ revision: 2 }));
    assert.deepEqual(legacy, { revision: 2 });
    assert.equal(store.publicationGuardState().epoch, afterFirst.epoch + 1);
    assert.equal(store.publicationGuardState().pendingSince, null);

    // An action that throws commits no operation row and leaves no live marker,
    // and the same key may be retried.
    const failing = captureError(() => store.publicationOperation(scope, "33333333-3333-4333-8333-333333333333", "goals",
      { expectedRevision: 2 }, () => { throw new Error("boom"); }));
    assert.equal(failing?.message, "boom");
    assert.equal(store.publicationGuardState().pendingSince, null);
    assert.deepEqual(store.publicationResult(scope, "33333333-3333-4333-8333-333333333333"), {
      status: "notFound", operationId: "33333333-3333-4333-8333-333333333333"
    });
  });
});

test("control-database contention is a retryable 503 database_busy, not a 500 or a five-second stall", () => {
  withStore(({ store, controlPath }) => {
    const blocker = new DatabaseSync(controlPath);
    try {
      blocker.exec("PRAGMA busy_timeout = 0");
      blocker.exec("BEGIN IMMEDIATE");
      const started = Date.now();
      const error = captureError(() => store.recordPlanPush(receipt()));
      const elapsed = Date.now() - started;
      assert.equal(error?.code, "database_busy");
      assert.equal(error?.statusCode, 503);
      assert.ok(elapsed >= 1_200, `waited for the bounded busy timeout (${elapsed}ms)`);
      assert.ok(elapsed < 8_000, `did not stall for the old five-second timeout twice (${elapsed}ms)`);

      // The publication path reports the same transient class.
      const publication = captureError(() => store.withPublicationTransaction(() => 1));
      assert.equal(publication?.code, "database_busy");
      blocker.exec("ROLLBACK");
    } finally {
      blocker.close();
    }
    // Once the other writer is gone the same receipt is accepted unchanged.
    assert.equal(store.recordPlanPush(receipt()), "2026-10-08T23:00:00.000Z");
  });
});

test("an existing control database is migrated in place: canonical payload, derived columns, per-scope index", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-receipt-migration-"));
  const controlPath = join(root, "var", "rai-control.sqlite");
  const oldWorkout = "ab8f0784-1111-4111-8111-bc78d3e66666";
  try {
    // The pre-migration schema: identity only lives inside the JSON payload and
    // the idempotency index is global.
    mkdirSync(join(root, "var"), { recursive: true });
    const raw = new DatabaseSync(controlPath);
    raw.exec(`
      CREATE TABLE mobile_plan_pushes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_date TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        pushed_at TEXT NOT NULL
      );
      CREATE INDEX idx_mobile_plan_pushes_pushed_at ON mobile_plan_pushes(pushed_at);
      CREATE UNIQUE INDEX idx_mobile_plan_pushes_idempotency
        ON mobile_plan_pushes(json_extract(payload_json, '$.idempotencyKey'))
        WHERE json_valid(payload_json) AND json_extract(payload_json, '$.idempotencyKey') IS NOT NULL;
    `);
    raw.prepare("INSERT INTO mobile_plan_pushes (local_date, revision, kind, payload_json, pushed_at) VALUES (?,?,?,?,?)").run(
      "2026-10-09",
      12,
      "easy",
      JSON.stringify({
        contractVersion: 2,
        scope: IDENTITY,
        workoutID: oldWorkout,
        scheduledAt: "2026-10-09T07:00:00+08:00",
        idempotencyKey: `${oldWorkout}:verified`,
        lifecycleEvent: "verified",
        structure,
        prescriptionDigest: prescriptionDigest("easy", structure)
      }),
      "2026-10-08T23:00:00.000Z"
    );
    raw.close();

    const store = new MobileGoalsStore(root, controlPath);
    try {
      const stored = store.planPushes("2026-01-01")[0];
      assert.equal(stored?.workoutID, oldWorkout.toUpperCase(), "the v2 payload identity is rewritten canonically");
      assert.equal(stored?.scheduledAt, "2026-10-08T23:00:00.000Z");
      assert.ok(store.planPushForSystemEntry(oldWorkout, "2026-10-09T07:00:00+08:00"),
        "the derived columns make the pre-migration row addressable by canonical identity");
      assert.equal(store.planPushIsActive(oldWorkout, "2026-10-09T07:00:00+08:00"), true);

      // A second write with a different spelling is a retry, not a new row.
      store.recordPlanPush({
        localDate: "2026-10-09",
        kind: "easy",
        revision: 12,
        structure,
        pushedAt: "2026-10-09T00:00:00.000Z",
        contractVersion: 2,
        scope: IDENTITY,
        workoutID: oldWorkout.toLowerCase(),
        scheduledAt: "2026-10-08T23:00:00Z",
        idempotencyKey: `${oldWorkout}:verified`,
        lifecycleEvent: "verified",
        prescriptionDigest: prescriptionDigest("easy", structure)
      });
      assert.equal(store.planPushes("2026-01-01").length, 1);
    } finally {
      store.close();
    }

    const verify = new DatabaseSync(controlPath);
    try {
      const indexes = (verify.prepare("PRAGMA index_list(mobile_plan_pushes)").all() as Array<{ name: string }>)
        .map(index => index.name);
      assert.ok(indexes.includes("idx_mobile_plan_pushes_scope_idempotency"));
      assert.ok(indexes.includes("idx_mobile_plan_pushes_unscoped_idempotency"));
      assert.ok(!indexes.includes("idx_mobile_plan_pushes_idempotency"), "the global key index is replaced");
      const version = verify.prepare("SELECT MAX(version) AS version FROM mobile_control_schema").get() as { version: number };
      // The ledger maximum moved to 2 with the PR3 unified training-plan tables
      // (mobile_training_state / history / migration audit). This assertion pins the
      // migration ledger having advanced, not the receipt/identity semantics below.
      assert.equal(version.version, 2);
    } finally {
      verify.close();
    }

    // Reopening applies nothing again and keeps exactly the same rows.
    const reopened = new MobileGoalsStore(root, controlPath);
    try {
      assert.equal(reopened.planPushes("2026-01-01").length, 1);
      assert.equal(reopened.planPushes("2026-01-01")[0]?.workoutID, oldWorkout.toUpperCase());
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v2 receipts without an identity never fall back to byte identity", () => {
  withStore(({ store }) => {
    const withoutWorkout = receipt();
    delete withoutWorkout.workoutID;
    assert.equal(captureError(() => store.recordPlanPush(withoutWorkout))?.code, "plan_receipt_contract_mismatch");
    const withoutTime = receipt();
    delete withoutTime.scheduledAt;
    assert.equal(captureError(() => store.recordPlanPush(withoutTime))?.code, "plan_receipt_date_invalid");
    const withoutEvent = receipt();
    delete withoutEvent.lifecycleEvent;
    assert.equal(captureError(() => store.recordPlanPush(withoutEvent))?.code, "plan_receipt_contract_mismatch");
    const withoutScope = receipt();
    delete withoutScope.scope;
    assert.equal(captureError(() => store.recordPlanPush(withoutScope))?.code, "plan_receipt_contract_mismatch");
    assert.equal(store.planPushes("2026-01-01").length, 0);
  });
});
