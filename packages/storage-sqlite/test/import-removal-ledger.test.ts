import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "../src/database.js";

/**
 * Every import-time fact-row deletion must leave two independent per-batch
 * witnesses: a `change_type='removed'` row in `import_entity_changes` and a
 * durable `import_entity_tombstones` row, both carrying the importing batch id.
 *
 * `RecomputePipeline.sourceBackfillEvidence` decides `preservedAbsent` purely
 * from those two tables (`recompute-pipeline.ts`). A deletion path that forgot
 * the batch id would make a real data loss read as "the import removed nothing"
 * and be exempted from the eligibility-drift gate. The three production deleters
 * below were only covered by hand-written ledger fixtures before, so the write
 * side itself had no direct assertion.
 *
 * Mutation that turns these red: replace `if (batchId)` with `if (false)` at a
 * write site (database.ts:2653 / :2746 / :2965 / :3064) — the ledger row
 * disappears and the corresponding assertion fails.
 */

type Kind = "record" | "workout" | "activity_summary";

const HEART_RATE = "HKQuantityTypeIdentifierHeartRate";

function insertBatch(store: RaiDatabase, id: string): void {
  store.database.prepare(`INSERT INTO import_batches (id, xml_sha256, status, import_mode)
    VALUES (?, 'sha', 'succeeded', 'incremental')`).run(id);
}

function insertRecord(store: RaiDatabase, id: string, startAt: string): void {
  store.database.prepare(`INSERT INTO health_records
    (id, type, source_name, source_category, start_at, end_at, metadata_json, raw_attributes_json)
    VALUES (?, ?, 'watch', 'active', ?, ?, '{}', '{}')`).run(id, HEART_RATE, startAt, startAt);
}

function mapSource(store: RaiDatabase, type: string, uuid: string, recordId: string): void {
  store.database.prepare("INSERT INTO healthkit_record_sources VALUES (?, ?, ?)")
    .run(type, uuid.toLowerCase(), recordId);
}

function insertWorkout(store: RaiDatabase, id: string, startAt: string, syncId: string): void {
  store.database.prepare(`INSERT INTO workouts
    (id, activity_type, source_name, source_category, start_at, end_at, duration_seconds,
     metadata_json, raw_attributes_json)
    VALUES (?, 'HKWorkoutActivityTypeRunning', 'Watch', 'apple_watch', ?, ?, 1800, ?, '{}')`)
    .run(id, startAt, startAt, JSON.stringify({ HKMetadataKeySyncIdentifier: [syncId] }));
}

function insertSummary(store: RaiDatabase, date: string): void {
  store.database.prepare("INSERT INTO activity_summaries (date_components, attributes_json) VALUES (?, '{}')")
    .run(date);
}

function stampGeneration(store: RaiDatabase, kind: Kind, id: string, generation: string): void {
  store.database.prepare(`INSERT INTO import_entity_generations
    (entity_kind, entity_id, generation, content_hash, effective_at) VALUES (?, ?, ?, 'seed', NULL)`)
    .run(kind, id, generation);
}

function countRows(store: RaiDatabase, table: string): number {
  return (store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function changeRow(
  store: RaiDatabase, batchId: string, kind: Kind, id: string
): { changeType: string; effectiveAt: string | null } | undefined {
  return store.database.prepare(`SELECT change_type AS changeType, effective_at AS effectiveAt
    FROM import_entity_changes WHERE batch_id = ? AND entity_kind = ? AND entity_id = ?`)
    .get(batchId, kind, id) as { changeType: string; effectiveAt: string | null } | undefined;
}

function tombstoneBatchId(store: RaiDatabase, kind: Kind, id: string): string | null | undefined {
  const row = store.database.prepare(
    "SELECT batch_id AS batchId FROM import_entity_tombstones WHERE entity_kind = ? AND entity_id = ?"
  ).get(kind, id) as { batchId: string | null } | undefined;
  return row?.batchId;
}

async function openStore(): Promise<{ store: RaiDatabase; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "rai-removal-ledger-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  return { store, root };
}

test("finalizeImportGeneration records each removed entity in the batch ledger and tombstone", async () => {
  const { store, root } = await openStore();
  try {
    insertBatch(store, "batch_finalize");
    insertRecord(store, "rec_stale", "2026-01-01T00:00:00.000Z");
    insertWorkout(store, "wo_stale", "2026-01-02T00:00:00.000Z", "sync-stale");
    insertSummary(store, "2026-01-03");
    stampGeneration(store, "record", "rec_stale", "old-gen");
    stampGeneration(store, "workout", "wo_stale", "old-gen");
    stampGeneration(store, "activity_summary", "2026-01-03", "old-gen");

    const removed = store.finalizeImportGeneration("new-gen", "batch_finalize", {});
    store.flush();
    assert.equal(removed.removedRecords, 1);
    assert.equal(removed.removedWorkouts, 1);
    assert.equal(removed.removedActivitySummaries, 1);

    for (const [kind, id] of [
      ["record", "rec_stale"], ["workout", "wo_stale"], ["activity_summary", "2026-01-03"]
    ] as const) {
      const change = changeRow(store, "batch_finalize", kind, id);
      assert.ok(change, `${kind} ${id} must leave a ledger row for its batch`);
      assert.equal(change.changeType, "removed", `${kind} ${id} must be recorded as removed`);
      assert.equal(
        tombstoneBatchId(store, kind, id), "batch_finalize",
        `${kind} ${id} tombstone must carry the importing batch id`
      );
    }
    assert.equal(countRows(store, "health_records"), 0, "the stale record row must actually be gone");
    assert.equal(countRows(store, "workouts"), 0, "the stale workout row must actually be gone");
    assert.equal(countRows(store, "activity_summaries"), 0, "the stale summary row must actually be gone");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeHealthKitRecords attributes an explicit deletion to the importing batch", async () => {
  const { store, root } = await openStore();
  try {
    insertBatch(store, "batch_rec_delete");
    insertRecord(store, "rec_del", "2026-02-01T00:00:00.000Z");
    mapSource(store, HEART_RATE, "uuid-1", "rec_del");

    const removed = store.removeHealthKitRecords([{ type: HEART_RATE, uuid: "uuid-1" }], "batch_rec_delete");
    store.flush();
    assert.equal(removed, 1, "the resolution must find and remove the mapped record");

    const change = changeRow(store, "batch_rec_delete", "record", "rec_del");
    assert.ok(change, "an explicit record deletion must leave a per-batch ledger row");
    assert.equal(change.changeType, "removed");
    assert.equal(change.effectiveAt, "2026-02-01T00:00:00.000Z", "the removal keeps the deleted fact's time");
    assert.equal(tombstoneBatchId(store, "record", "rec_del"), "batch_rec_delete");
    assert.equal(countRows(store, "health_records"), 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("removeWorkoutsBySyncIdentifiers attributes an explicit deletion to the importing batch", async () => {
  const { store, root } = await openStore();
  try {
    insertBatch(store, "batch_wo_delete");
    insertWorkout(store, "wo_del", "2026-03-01T00:00:00.000Z", "sync-del");

    const dirty = store.removeWorkoutsBySyncIdentifiers(["sync-del"], "batch_wo_delete");
    assert.deepEqual(dirty, ["2026-03-01T00:00:00.000Z"], "the caller needs the deleted workout's time");

    const change = changeRow(store, "batch_wo_delete", "workout", "wo_del");
    assert.ok(change, "an explicit workout deletion must leave a per-batch ledger row");
    assert.equal(change.changeType, "removed");
    assert.equal(tombstoneBatchId(store, "workout", "wo_del"), "batch_wo_delete");
    assert.equal(countRows(store, "workouts"), 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a preserve-absent generation writes no removals and deletes nothing", async () => {
  const { store, root } = await openStore();
  try {
    insertBatch(store, "batch_preserve");
    insertRecord(store, "rec_keep", "2026-04-01T00:00:00.000Z");
    stampGeneration(store, "record", "rec_keep", "old-gen");

    const removed = store.finalizeImportGeneration("new-gen", "batch_preserve", { preserveAbsent: true });
    store.flush();
    assert.deepEqual(
      [removed.removedRecords, removed.removedWorkouts, removed.removedActivitySummaries],
      [0, 0, 0], "preserve-absent must short-circuit before any deletion"
    );
    assert.equal(countRows(store, "health_records"), 1, "preserve-absent must keep the entity");
    assert.equal(
      countRows(store, "import_entity_changes"), 0,
      "preserve-absent must write no ledger rows — otherwise the zero-deletion witness would be broken"
    );
    assert.equal(countRows(store, "import_entity_tombstones"), 0, "preserve-absent must leave no tombstone");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
