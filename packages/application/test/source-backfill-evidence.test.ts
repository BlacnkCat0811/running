import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RaiDatabase,
  RecomputeJobRepository,
  SqliteModelRunRepository,
  SqliteTrainingSessionRepository,
  type ModelTransitionSourceBackfillEvidence
} from "@rai/storage-sqlite";

import { RecomputePipeline } from "../src/services/recompute-pipeline.js";

type EvidenceReader = {
  sourceBackfillEvidence(
    importBatchId: string | undefined,
    removedEligibleSessions: number,
    removedCalibrationSessions: number
  ): ModelTransitionSourceBackfillEvidence | undefined;
};

/**
 * Exercises the DB-derived backfill evidence against a real schema. The whole
 * exemption rests on this query layer, so it is verified directly rather than
 * only through the pure gate: a change ledger that lost rows, or an earliest fact
 * that predates the batch, must never read as a verified backfill.
 */
test("source backfill evidence is read from the per-batch change ledger, not inferred", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-backfill-evidence-"));
  const file = join(root, "db.sqlite");
  const store = await RaiDatabase.open(file, { createMigrationBackup: false });
  try {
    const database = store.database;
    const pipeline = new RecomputePipeline(
      store,
      new RecomputeJobRepository(database),
      new SqliteModelRunRepository(database),
      new SqliteTrainingSessionRepository(database)
    );
    const reader = pipeline as unknown as EvidenceReader;

    const batch = (id: string): void => {
      database.prepare(`INSERT INTO import_batches (id, xml_sha256, status, import_mode)
        VALUES (?, 'sha', 'succeeded', 'incremental')`).run(id);
    };
    const record = (id: string, startAt: string): void => {
      database.prepare(`INSERT INTO health_records
        (id, type, source_name, source_category, start_at, end_at, metadata_json, raw_attributes_json)
        VALUES (?, 'HKQuantityTypeIdentifierHeartRate', 'watch', 'active', ?, ?, '{}', '{}')`)
        .run(id, startAt, startAt);
    };
    const change = (
      batchId: string, kind: string, id: string, type: "inserted" | "updated" | "removed"
    ): void => {
      database.prepare(`INSERT INTO import_entity_changes
        (batch_id, entity_kind, entity_id, change_type, effective_at, content_hash)
        VALUES (?, ?, ?, ?, NULL, ?)`).run(batchId, kind, id, type, id);
    };

    // An older history slice: two records, the second is the new global earliest.
    record("r_old", "2023-10-31T00:00:00Z");
    record("r_older", "2020-02-26T00:00:00Z");

    batch("batch_pure");
    change("batch_pure", "record", "r_old", "inserted");
    change("batch_pure", "record", "r_older", "inserted");

    const pure = reader.sourceBackfillEvidence("batch_pure", 0, 0);
    assert.ok(pure);
    assert.equal(pure.preservedAbsent, true);
    assert.equal(pure.removedRecords, 0);
    assert.equal(pure.removedWorkouts, 0);
    assert.equal(pure.removedActivitySummaries, 0);
    assert.equal(pure.earliestInsertedIsNewGlobalEarliest, true);
    assert.equal(pure.removedEligibleSessions, 0);
    assert.equal(pure.removedCalibrationSessions, 0);

    // A batch that removed a fact row is never a preserved-absence backfill.
    batch("batch_deleted");
    change("batch_deleted", "record", "r_old", "removed");
    const removed = reader.sourceBackfillEvidence("batch_deleted", 0, 0);
    assert.ok(removed);
    assert.equal(removed.preservedAbsent, false);
    assert.equal(removed.removedRecords, 1);

    // A durable tombstone alone (arrival-less deletion) still blocks the claim.
    batch("batch_tombstoned");
    database.prepare(`INSERT INTO import_entity_tombstones
      (entity_kind, entity_id, source_identifier, batch_id, deleted_at)
      VALUES ('record', 'r_gone', 'healthkit-record:v2:x:y', 'batch_tombstoned', '2026-10-11T00:00:00Z')`).run();
    const tombstoned = reader.sourceBackfillEvidence("batch_tombstoned", 0, 0);
    assert.ok(tombstoned);
    assert.equal(tombstoned.preservedAbsent, false);
    assert.equal(tombstoned.removedRecords, 0);

    // A batch that only *updated* the global-earliest row did not move the
    // timeline backwards, so the membership proof must reject it.
    batch("batch_updated");
    change("batch_updated", "record", "r_older", "updated");
    const updated = reader.sourceBackfillEvidence("batch_updated", 3, 1);
    assert.ok(updated);
    assert.equal(updated.preservedAbsent, true);
    assert.equal(updated.earliestInsertedIsNewGlobalEarliest, false);
    assert.equal(updated.removedEligibleSessions, 3);
    assert.equal(updated.removedCalibrationSessions, 1);

    // No batch identity means no evidence at all: the gate stays untouched.
    assert.equal(reader.sourceBackfillEvidence(undefined, 0, 0), undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
