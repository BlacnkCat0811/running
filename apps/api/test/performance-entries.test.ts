import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildLabelFunnel, loadLabeledRaceOutcomes, loadManualPerformanceOutcomes } from "@rai/application";
import {
  PerformanceEntryValidationError,
  RaiDatabase,
  SqlitePerformanceEntryRepository
} from "@rai/storage-sqlite";

/**
 * T04: a manual race result is a label **only from the moment it was recorded**.
 *
 * The failure this pins is subtle and unrecoverable in the other direction: a 2023
 * result typed in today would otherwise appear inside a prediction that was made
 * yesterday, which is exactly the "as-known-then" leak T01 forbids.
 */
async function withDatabase(run: (database: RaiDatabase) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-entries-"));
  try {
    const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
    try {
      run(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("T04: an entry is invisible before it was recorded, and visible after", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    repository.insert({
      localDate: "2023-04-16",
      distance: "half_marathon",
      durationSeconds: 5_520,
      note: "旧比赛",
      recordedAt: "2026-10-02T08:00:00.000Z"
    });

    const before = "2026-10-02T07:59:00.000Z";
    const after = "2026-10-02T08:01:00.000Z";
    assert.deepEqual(loadManualPerformanceOutcomes(store.database, before), [], "typed in later = not available earlier");
    const outcomes = loadManualPerformanceOutcomes(store.database, after);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.distance, "half_marathon");
    assert.equal(outcomes[0]!.actualDistanceMeters, 21_097.5);
    assert.equal(outcomes[0]!.actualSeconds, 5_520);
    assert.equal(outcomes[0]!.labelAvailableAt, "2026-10-02T08:00:00.000Z");
    assert.equal(outcomes[0]!.labelSource, "race");
    assert.ok(outcomes[0]!.id.startsWith("performance_entry_"), "provenance stays visible in the id");
  });
});

test("T04: a race dated in the future is not a label yet", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    repository.insert({
      localDate: "2026-12-06",
      distance: "ten_k",
      durationSeconds: 2_400,
      note: null,
      recordedAt: "2026-10-02T08:00:00.000Z"
    });
    assert.deepEqual(loadManualPerformanceOutcomes(store.database, "2026-10-03T00:00:00.000Z"), []);
    assert.equal(loadManualPerformanceOutcomes(store.database, "2026-12-07T00:00:00.000Z").length, 1);
  });
});

test("T04: a revoked entry stops being available from the revocation instant", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    const entry = repository.insert({
      localDate: "2024-03-10",
      distance: "five_k",
      durationSeconds: 1_290,
      note: null,
      recordedAt: "2026-10-01T00:00:00.000Z"
    });
    assert.equal(loadManualPerformanceOutcomes(store.database, "2026-10-02T00:00:00.000Z").length, 1);

    assert.equal(repository.revoke(entry.id, "2026-10-03T00:00:00.000Z"), true);
    assert.equal(loadManualPerformanceOutcomes(store.database, "2026-10-02T23:00:00.000Z").length, 1,
      "before the revocation it was still a valid label");
    assert.equal(loadManualPerformanceOutcomes(store.database, "2026-10-03T00:01:00.000Z").length, 0);
    assert.equal(repository.revoke(entry.id, "2026-10-04T00:00:00.000Z"), false, "revoking twice is a no-op");
    // The row survives as a tombstone: a delete could not report when it stopped counting.
    assert.equal(repository.list().length, 1);
    assert.equal(repository.list()[0]!.revokedAt, "2026-10-03T00:00:00.000Z");
  });
});

test("T05: implausible entries are refused before they can become labels", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    for (const invalid of [
      { localDate: "2024-13-40", distance: "ten_k" as const, durationSeconds: 2_400 },
      { localDate: "2024-03-10", distance: "marathon" as never, durationSeconds: 2_400 },
      { localDate: "2024-03-10", distance: "ten_k" as const, durationSeconds: 60 },
      { localDate: "2024-03-10", distance: "ten_k" as const, durationSeconds: 60 * 60 * 5 },
      // 10 km in 20 minutes is a 2:00/km pace — not a race result.
      { localDate: "2024-03-10", distance: "ten_k" as const, durationSeconds: 1_200 }
    ]) {
      assert.throws(() => repository.insert({ ...invalid, note: null }), PerformanceEntryValidationError,
        `expected refusal for ${JSON.stringify(invalid)}`);
    }
    assert.deepEqual(repository.list(), []);
  });
});

test("T05: the funnel counts manual and recorded labels separately and stays reconcilable", async () => {
  await withDatabase((store) => {
    new SqlitePerformanceEntryRepository(store.database).insert({
      localDate: "2025-05-11",
      distance: "ten_k",
      durationSeconds: 2_520,
      note: null,
      recordedAt: "2026-10-01T00:00:00.000Z"
    });
    const asOf = "2026-10-02T00:00:00.000Z";
    const outcomes = loadLabeledRaceOutcomes(store.database, asOf);
    const funnel = buildLabelFunnel(store.database, asOf);
    assert.equal(outcomes.length, 1, "the manual entry is a usable label");
    assert.equal(funnel.usableOutcomeCount, outcomes.length);
    assert.equal(funnel.manualEntryCount, 1);
    assert.equal(funnel.sessionCount, 0, "no training session backs it — and none is claimed");
    assert.equal(funnel.accuracyStatus, "requires_release_evaluation");
    assert.equal(funnel.byDistance.ten_k.usable, 1);
  });
});

test("T05: a threshold-style entry is still validated on pace, not just duration", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    // 21.0975 km in 50 minutes implies 2:22/km — inside the duration bounds, outside
    // the pace bounds, and exactly the kind of entry a typo produces.
    assert.throws(
      () => repository.insert({ localDate: "2025-01-01", distance: "half_marathon", durationSeconds: 3_000, note: null }),
      PerformanceEntryValidationError
    );
    const ok = repository.insert({ localDate: "2025-01-01", distance: "half_marathon", durationSeconds: 7_200, note: null });
    assert.equal(ok.distance, "half_marathon");
    assert.equal(Math.round(ok.durationSeconds / (21.0975)), 341);
  });
});
