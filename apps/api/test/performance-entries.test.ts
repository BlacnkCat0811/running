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
import { RaiReadStore } from "../src/data.js";

/**
 * T04: a manual race result is a label **only from the moment it was recorded**.
 *
 * The failure this pins is subtle and unrecoverable in the other direction: a 2023
 * result typed in today would otherwise appear inside a prediction that was made
 * yesterday, which is exactly the "as-known-then" leak T01 forbids.
 */
async function withDatabase(run: (database: RaiDatabase, path: string) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-entries-"));
  try {
    const path = join(root, "rai.sqlite");
    const store = await RaiDatabase.open(path, { createMigrationBackup: false });
    try {
      run(store, path);
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
    assert.equal(outcomes[0]!.observedAt, "2023-04-15T16:00:00.000Z", "unknown race clock uses a conservative day cutoff");
    assert.ok(Date.parse(outcomes[0]!.observedAt) < Date.parse(outcomes[0]!.completedAt));
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
    const outcomes = loadManualPerformanceOutcomes(store.database, "2026-12-07T00:00:00.000Z");
    assert.equal(outcomes.length, 1);
    assert.ok(Date.parse(outcomes[0]!.labelAvailableAt) >= Date.parse(outcomes[0]!.completedAt));
  });
});

test("same-day manual results use midnight features and become available when recorded", async () => {
  await withDatabase((store) => {
    new SqlitePerformanceEntryRepository(store.database).insert({ localDate: "2026-10-02", distance: "five_k",
      durationSeconds: 1_290, note: null, recordedAt: "2026-10-02T02:00:00.000Z" });
    const [outcome] = loadManualPerformanceOutcomes(store.database, "2026-10-02T02:01:00.000Z");
    assert.ok(outcome);
    assert.equal(outcome.completedAt, "2026-10-02T02:00:00.000Z");
    assert.equal(outcome.observedAt, "2026-10-01T16:00:00.000Z");
    assert.equal(outcome.labelAvailableAt, "2026-10-02T02:00:00.000Z");
  });
});

test("candidate links are server-derived and reject missing or mismatched sessions", async () => {
  await withDatabase(store => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    store.database.exec(`INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, status)
      VALUES ('race', 'HKWorkoutActivityTypeRunning', '2026-10-02T00:00:00Z',
        '2026-10-02T00:50:00Z', 10, 'active')`);
    const input = { localDate: "2026-10-02", distance: "ten_k" as const,
      durationSeconds: 3000, note: null, recordedAt: "2026-10-03T00:00:00Z" };
    assert.throws(() => repository.insert({ ...input, trainingSessionId: "missing" }), PerformanceEntryValidationError);
    assert.throws(() => repository.insert({ ...input, trainingSessionId: "race", localDate: "2026-10-01" }), PerformanceEntryValidationError);
    assert.throws(() => repository.insert({ ...input, trainingSessionId: "race", distance: "five_k" }), PerformanceEntryValidationError);
    const entry = repository.insert({ ...input, trainingSessionId: "race" });
    assert.equal(entry.observedAt, "2026-10-02T00:00:00Z");
    assert.equal(entry.completedAt, "2026-10-02T00:50:00Z");
    assert.equal(entry.trainingSessionId, "race");
  });
});

for (const excludedId of ["race", "overlapping-race"]) {
  test(`excluded event ${excludedId} is not proposed as a race candidate`, async () => {
    await withDatabase((store, path) => {
      store.database.exec(`INSERT INTO training_sessions
        (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, status)
        VALUES ('race', 'HKWorkoutActivityTypeRunning', '2026-09-01T00:00:00Z', '2026-09-01T00:30:00Z', 5, 'active'),
          ('overlapping-race', 'HKWorkoutActivityTypeRunning', '2026-09-01T00:01:00Z', '2026-09-01T00:31:00Z', 5, 'active')`);
      store.database.prepare(`INSERT INTO workout_overrides
        (id, training_session_id, revision, eligibility_override, created_at)
        VALUES ('excluded', ?, 1, 'exclude', '2026-09-02T00:00:00Z')`).run(excludedId);
      const read = new RaiReadStore(path);
      try {
        assert.deepEqual(read.labelProgress().candidates, []);
      } finally {
        read.close();
      }
    });
  });

  test(`confirming excluded event ${excludedId} is refused without writing an entry`, async () => {
    await withDatabase(store => {
      store.database.exec(`INSERT INTO training_sessions
        (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, status)
        VALUES ('race', 'HKWorkoutActivityTypeRunning', '2026-09-01T00:00:00Z', '2026-09-01T00:30:00Z', 5, 'active'),
          ('overlapping-race', 'HKWorkoutActivityTypeRunning', '2026-09-01T00:01:00Z', '2026-09-01T00:31:00Z', 5, 'active')`);
      store.database.prepare(`INSERT INTO workout_overrides
        (id, training_session_id, revision, eligibility_override, created_at)
        VALUES ('excluded', ?, 1, 'exclude', '2026-09-02T00:00:00Z')`).run(excludedId);
      const repository = new SqlitePerformanceEntryRepository(store.database);
      assert.throws(() => repository.insert({ localDate: "2026-09-01", distance: "five_k", durationSeconds: 1800,
        note: null, recordedAt: "2026-09-03T00:00:00Z", trainingSessionId: "race" }), PerformanceEntryValidationError);
      assert.deepEqual(repository.list(), []);
      assert.deepEqual(loadLabeledRaceOutcomes(store.database, "2026-09-03T00:00:00Z"), []);
    });
  });
}

test("candidate confirmation uses the latest available override and ignores future exclusions", async () => {
  await withDatabase((store, path) => {
    store.database.exec(`INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, status)
      VALUES ('race', 'HKWorkoutActivityTypeRunning', '2026-09-01T00:00:00Z', '2026-09-01T00:30:00Z', 5, 'active');
      INSERT INTO workout_overrides (id, training_session_id, revision, eligibility_override, created_at)
      VALUES ('excluded', 'race', 1, 'exclude', '2026-09-02T08:00:00+08:00'),
        ('included', 'race', 2, 'include', '2026-09-03T08:00:00+08:00'),
        ('future-excluded', 'race', 3, 'exclude', '2099-01-01T00:00:00Z')`);
    const read = new RaiReadStore(path);
    try {
      assert.equal(read.labelProgress().candidates.length, 1);
      const repository = new SqlitePerformanceEntryRepository(store.database);
      assert.throws(() => repository.insert({ localDate: "2026-09-01", distance: "five_k", durationSeconds: 1800,
        note: null, recordedAt: "2026-09-02T12:00:00Z", trainingSessionId: "race" }), PerformanceEntryValidationError);
      const entry = repository.insert({ localDate: "2026-09-01", distance: "five_k", durationSeconds: 1800,
        note: null, recordedAt: "2026-09-04T00:00:00Z", trainingSessionId: "race" });
      assert.deepEqual(loadLabeledRaceOutcomes(store.database, "2026-09-04T00:01:00Z").map(outcome => outcome.id), [entry.id]);
      assert.deepEqual(read.labelProgress().candidates, []);
    } finally {
      read.close();
    }
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
      { localDate: "2026-02-29", distance: "ten_k" as const, durationSeconds: 2_400 },
      { localDate: "2024-02-30", distance: "ten_k" as const, durationSeconds: 2_400 },
      { localDate: "2026-04-31", distance: "ten_k" as const, durationSeconds: 2_400 },
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

test("race dates preserve valid leap days and calendar boundaries", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    for (const localDate of ["2024-02-29", "2026-04-30", "2026-12-31"])
      assert.equal(repository.insert({ localDate, distance: "ten_k", durationSeconds: 2_400, note: null }).localDate, localDate);
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
    assert.equal(funnel.trainingSampleCount, 0);
    assert.equal(funnel.trainingExcludedOutcomeCount, 1);
    assert.equal(funnel.byDistance.ten_k.trainingSamples, 0);
  });
});

test("T05: duplicate active race results are rejected, while revoked results may be corrected", async () => {
  await withDatabase(store => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    const input = { localDate: "2025-05-11", distance: "ten_k" as const, durationSeconds: 2520,
      note: null, recordedAt: "2026-10-01T00:00:00.000Z" };
    const first = repository.insert(input);
    assert.throws(() => repository.insert({ ...input, durationSeconds: 2500 }), PerformanceEntryValidationError);
    assert.equal(loadManualPerformanceOutcomes(store.database, "2026-10-02T00:00:00.000Z").length, 1);
    repository.insert({ ...input, distance: "five_k", durationSeconds: 1260 });
    assert.equal(repository.revoke(first.id, "2026-10-02T00:00:00.000Z"), true);
    const corrected = repository.insert({ ...input, durationSeconds: 2500, recordedAt: "2026-10-02T00:01:00.000Z" });
    assert.equal(repository.availableAt("2026-10-01T23:00:00.000Z").find(entry => entry.distance === "ten_k")!.id, first.id);
    assert.equal(repository.availableAt("2026-10-02T00:02:00.000Z").find(entry => entry.distance === "ten_k")!.id, corrected.id);
    assert.equal(repository.list().length, 3);
  });
});

test("T05: legacy duplicate entries count as one event without deleting historical rows", async () => {
  await withDatabase(store => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    const first = repository.insert({ localDate: "2025-05-11", distance: "ten_k", durationSeconds: 2520,
      note: null, recordedAt: "2026-10-01T00:00:00.000Z" });
    store.database.prepare(`INSERT INTO performance_entries
      (id, local_date, distance, duration_seconds, source, note, recorded_at, revoked_at, revision)
      VALUES ('performance_entry_legacy_duplicate', '2025-05-11', 'ten_k', 2500, 'manual', NULL,
        '2026-10-01T01:00:00.000Z', NULL, 1)`).run();
    const at = "2026-10-02T00:00:00.000Z";
    assert.equal(repository.list().length, 2);
    assert.deepEqual(repository.availableAt(at).map(entry => entry.id), [first.id]);
    assert.equal(loadManualPerformanceOutcomes(store.database, at).length, 1);
    assert.equal(buildLabelFunnel(store.database, at).usableOutcomeCount, 1);
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
