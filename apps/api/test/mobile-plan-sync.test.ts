import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { MobileSessionKind, MobileSessionStructure } from "@rai/api-contracts";
import { MOBILE_SESSION_KINDS } from "@rai/contracts";

import { MobileGoalsInputError, MobileGoalsStore, type PlanPushRecord } from "../src/mobile-goals.js";
import { apiErrorPayload } from "../src/api-error.js";
import { mobileGoalsBodySchema, mobilePlanSyncedBodySchema } from "../src/schemas.js";

/**
 * The push receipt is the only link between a stored plan day and the run that
 * executed it (WorkoutKit scheduling is device-side; the runner syncs
 * *tomorrow's* session and runs it tonight), so this layer gets its own tests.
 *
 * The session kind is the part that used to be able to fail silently: the schema
 * accepted a kind the store's own `Set` did not contain, and the resulting
 * error surfaced as an unexplained 500. The set now derives from
 * `MOBILE_SESSION_KINDS`, and the store's refusal carries a status so the client
 * can tell a malformed body from a broken server.
 */
const withStore = <T>(run: (fixture: { store: MobileGoalsStore; root: string; controlPath: string }) => T): T => {
  const root = mkdtempSync(join(tmpdir(), "rai-plan-sync-"));
  const controlPath = join(root, "var", "rai-control.sqlite");
  const store = new MobileGoalsStore(root, controlPath);
  try {
    return run({ store, root, controlPath });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
};

const structure: MobileSessionStructure = {
  warmup: null,
  blocks: [
    { iterations: 6, steps: [{ purpose: "work", goal: { type: "distance", meters: 800 }, alert: null }] }
  ],
  cooldown: null
};

const SINCE = "2026-09-01T00:00:00.000Z";

const pushReceipt = (
  localDate: string,
  pushedAt: string,
  overrides: Partial<PlanPushRecord> = {}
): PlanPushRecord => ({ localDate, kind: "easy", revision: 1, structure: null, pushedAt, ...overrides });

const captureError = (run: () => unknown): unknown => {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
};

test("every declared session kind is accepted as a push receipt", () => {
  withStore(({ store }) => {
    for (const kind of MOBILE_SESSION_KINDS) {
      assert.doesNotThrow(
        () =>
          store.recordPlanPush({
            localDate: "2026-09-15",
            kind,
            revision: 6,
            structure: null,
            pushedAt: "2026-09-14T20:00:00.000Z"
          }),
        `kind ${kind} passes the API enum, so the store must accept it too`
      );
    }
    assert.equal(store.planPushes("2026-09-01T00:00:00.000Z").length, MOBILE_SESSION_KINDS.length);
  });
});

test("an unknown kind or a non-date is refused with a diagnosable 400", () => {
  withStore(({ store }) => {
    for (const invalid of [{ kind: "progression" as MobileSessionKind }, { localDate: "2026/09/15" }]) {
      const error = captureError(() =>
        store.recordPlanPush(pushReceipt("2026-09-15", "2026-09-14T20:00:00.000Z", invalid))
      );
      const label = JSON.stringify(invalid);
      // A typed refusal rather than a bare `RangeError`, which the handler reads
      // as an internal fault.
      assert.ok(error instanceof MobileGoalsInputError, `expected a typed refusal for ${label}`);
      // The handler's view of the same error. Before, this was `500` with the
      // body message "本地服务处理请求失败" and no way to tell why.
      const payload = apiErrorPayload(error);
      assert.equal(payload.status, 400, `status for ${label}`);
      assert.equal(payload.body.code, "invalid_mobile_goals_input", `code for ${label}`);
      assert.notEqual(payload.body.message, "本地服务处理请求失败", `message for ${label}`);
    }
    // Nothing reached the table.
    assert.deepEqual(store.planPushes(SINCE), []);
  });
});

test("a receipt round-trips, stays newest-first, and survives a reopen", () => {
  withStore(({ store, root, controlPath }) => {
    store.recordPlanPush({
      localDate: "2026-09-15",
      kind: "interval",
      revision: 6,
      structure: null,
      pushedAt: "2026-09-14T20:00:00.000Z"
    });
    store.recordPlanPush({
      localDate: "2026-09-16",
      kind: "easy",
      revision: 7,
      structure,
      pushedAt: "2026-09-15T06:00:00.000Z"
    });

    const pushes = store.planPushes("2026-09-01T00:00:00.000Z");
    assert.deepEqual(pushes.map((push) => push.localDate), ["2026-09-16", "2026-09-15"]);
    assert.equal(pushes[0]?.revision, 7);
    assert.equal(pushes[0]?.structure?.blocks.length, 1);
    // A day the phone synced without a structure is a real receipt, not a defect.
    assert.equal(pushes[1]?.structure, null);
    // The window is a real filter, not decoration.
    assert.deepEqual(
      store.planPushes("2026-09-15T00:00:00.000Z").map((push) => push.localDate),
      ["2026-09-16"]
    );

    // Receipts must outlive the process: they are the only record of what the
    // watch was handed, and the run is imported later.
    const reopened = new MobileGoalsStore(root, controlPath);
    try {
      assert.deepEqual(reopened.planPushes("2026-09-01T00:00:00.000Z").map((push) => push.localDate), [
        "2026-09-16",
        "2026-09-15"
      ]);
    } finally {
      reopened.close();
    }
  });
});

test("plan history exposes the revisions a run can be matched against", () => {
  withStore(({ store }) => {
    // A fresh control database seeds revision 0 — exactly what a phone that has
    // never regenerated would have been handed.
    const history = store.planHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0]?.revision, 0);
    assert.ok(Array.isArray(history[0]?.weekPlan));
  });
});

test("both plan-kind schemas take their enum from the shared list", () => {
  const declared = [...MOBILE_SESSION_KINDS];
  assert.deepEqual([...mobilePlanSyncedBodySchema.properties.kind.enum], declared);
  const weekPlanItem = mobileGoalsBodySchema.properties.weekPlan.items;
  assert.deepEqual([...weekPlanItem.properties.kind.enum], declared);
  // A narrowed hand-written list would still be a subset, so equality is the point.
  assert.equal(new Set(declared).size, declared.length);
});

/**
 * `planSegmentCandidates()` reads these two tables on every series request, so
 * the parsed rows are cached. Cached reads must be indistinguishable from the
 * queries they replaced — including for writes the cache did not make itself.
 */
test("a cached read still sees this store's own writes", () => {
  withStore(({ store }) => {
    // Fill both caches before writing, which is the only way to detect a
    // missing invalidation.
    assert.equal(store.planHistory()[0]?.revision, 0);
    assert.deepEqual(store.planPushes(SINCE), []);

    const written = store.write({});
    store.recordPlanPush(pushReceipt("2026-09-16", "2026-09-15T06:00:00.000Z"));

    assert.equal(store.planHistory()[0]?.revision, written.revision);
    assert.deepEqual(store.planPushes(SINCE).map((push) => push.localDate), ["2026-09-16"]);
  });
});

test("a cached read still sees another connection's commit", () => {
  withStore(({ store, controlPath }) => {
    assert.equal(store.planHistory()[0]?.revision, 0);
    assert.deepEqual(store.planPushes(SINCE), []);

    // A writer this store does not own. `PRAGMA data_version` is what catches
    // it; the store's own invalidation cannot, and vice versa.
    const other = new DatabaseSync(controlPath);
    other
      .prepare("INSERT INTO mobile_goals_history (revision, payload_json, changed_at) VALUES (?, ?, ?)")
      .run(9, JSON.stringify({ weekPlan: [], lockedSession: null }), "2026-09-15T05:00:00.000Z");
    other
      .prepare("INSERT INTO mobile_plan_pushes (local_date, revision, kind, payload_json, pushed_at) VALUES (?, ?, ?, ?, ?)")
      .run("2026-09-16", 9, "easy", JSON.stringify({ structure: null }), "2026-09-15T06:00:00.000Z");
    other.close();

    assert.equal(store.planHistory()[0]?.revision, 9);
    assert.deepEqual(store.planPushes(SINCE).map((push) => push.localDate), ["2026-09-16"]);
  });
});

test("a cached window matches the query it replaced", () => {
  withStore(({ store, controlPath }) => {
    // One receipt goes backwards in time and one lands exactly on the window
    // boundary: the filter is `>=`, so the boundary receipt belongs in it.
    const boundary = "2026-09-10T00:00:00.000Z";
    store.recordPlanPush(pushReceipt("2026-09-09", "2026-09-09T00:00:00.000Z"));
    store.recordPlanPush(pushReceipt("2026-09-10", boundary));
    store.recordPlanPush(pushReceipt("2026-09-11", "2026-09-11T00:00:00.000Z"));
    store.recordPlanPush(pushReceipt("2026-09-12", "2026-09-08T00:00:00.000Z"));

    const raw = new DatabaseSync(controlPath);
    const query = (statement: string, ...params: Array<string | number>) =>
      (raw.prepare(statement).all(...params) as Array<Record<string, unknown>>);

    for (const [since, limit] of [
      [SINCE, 50],
      [boundary, 2],
      [boundary, 1],
      ["2026-09-11T00:00:00.000Z", 50]
    ] as Array<[string, number]>) {
      assert.deepEqual(
        store.planPushes(since, limit).map((push) => push.localDate),
        query(
          "SELECT local_date FROM mobile_plan_pushes WHERE pushed_at >= ? ORDER BY pushed_at DESC LIMIT ?",
          since,
          limit
        ).map((row) => row.local_date),
        `push window since=${since} limit=${limit}`
      );
    }

    // Two empty writes are enough to advance the revision past the cached window.
    for (let i = 0; i < 2; i++) store.write({});
    for (const limit of [1, 2, 3, 999]) {
      assert.deepEqual(
        store.planHistory(limit).map((entry) => entry.revision),
        query("SELECT revision FROM mobile_goals_history ORDER BY revision DESC LIMIT ?", limit).map((row) =>
          Number(row.revision)
        ),
        `history limit=${limit}`
      );
    }

    raw.close();
  });
});
