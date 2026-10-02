import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildPersonalCalibrationSamples, personalCalibrationStatus } from "@rai/application";
import { RaiDatabase, SqlitePerformanceEntryRepository } from "@rai/storage-sqlite";

/**
 * M06 (replay half): the residual must come from a prediction that could not see the
 * result it is scoring.
 *
 * The failure mode is silent and flattering: a residual computed from a prediction
 * that already contains the result is smaller than the truth, so the runner is shown
 * a *narrower* band exactly when the data is thinnest.
 *
 * The pass uses everything known at `asOf` minus the one label being scored — not the
 * as-known-then replay, which is impossible for a result entered years after the race
 * (§12.10). The single-label case below is the proof that the subtraction happens:
 * with one label and nothing else, the rule has no evidence at all.
 */

async function withDatabase(run: (database: RaiDatabase) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-personal-"));
  try {
    const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
    try {
      await run(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const AS_OF = "2026-10-02T00:00:00.000Z";
const RECORDED = "2026-09-01T00:00:00.000Z";

/** Ten races over roughly a year, two distances, recorded on one day. */
const RACES = [
  { localDate: "2025-09-14", distance: "ten_k" as const, durationSeconds: 2_460 },
  { localDate: "2025-10-05", distance: "ten_k" as const, durationSeconds: 2_430 },
  { localDate: "2025-11-02", distance: "half_marathon" as const, durationSeconds: 5_400 },
  { localDate: "2025-12-07", distance: "ten_k" as const, durationSeconds: 2_400 },
  { localDate: "2026-01-18", distance: "half_marathon" as const, durationSeconds: 5_310 },
  { localDate: "2026-03-01", distance: "ten_k" as const, durationSeconds: 2_370 },
  { localDate: "2026-04-12", distance: "half_marathon" as const, durationSeconds: 5_220 },
  { localDate: "2026-05-24", distance: "ten_k" as const, durationSeconds: 2_340 },
  { localDate: "2026-07-05", distance: "half_marathon" as const, durationSeconds: 5_160 },
  { localDate: "2026-08-30", distance: "ten_k" as const, durationSeconds: 2_310 }
];

test("M06: a single entered race cannot predict itself", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    repository.insert({ ...RACES[0]!, note: null, recordedAt: RECORDED });

    const pass = buildPersonalCalibrationSamples(store.database, AS_OF);
    assert.equal(pass.labelCount, 1, "the entry is a label");
    assert.equal(pass.scoredCount, 0, "but there is no evidence left to predict it from");
    assert.deepEqual(pass.samples, []);
    assert.ok(pass.reasonCodes.includes("label_without_held_out_prediction"));
  });
});

test("M06: two labels score each other, and neither sees itself", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    for (const race of RACES.slice(0, 2)) repository.insert({ ...race, note: null, recordedAt: RECORDED });

    const pass = buildPersonalCalibrationSamples(store.database, AS_OF);
    assert.equal(pass.labelCount, 2);
    assert.equal(pass.scoredCount, 2, "each label is predicted from the other one");
    for (const sample of pass.samples) {
      assert.ok(sample.pointSeconds > 0);
      assert.notEqual(sample.pointSeconds, sample.actualSeconds, "a held-out prediction is not the result");
    }
    // The first race is faster than the second in this pair, and each is predicted
    // from the other: the point estimates must therefore differ from each other.
    assert.notEqual(pass.samples[0]!.pointSeconds, pass.samples[1]!.pointSeconds);
  });
});

test("M06: nothing is scored before the entry was recorded", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    for (const race of RACES) repository.insert({ ...race, note: null, recordedAt: RECORDED });
    const pass = buildPersonalCalibrationSamples(store.database, "2026-08-01T00:00:00.000Z");
    assert.equal(pass.labelCount, 0, "entries recorded later do not exist yet");
    assert.ok(pass.reasonCodes.includes("no_labels"));
  });
});

test("M11: the status reports scored labels, not entered ones", async () => {
  await withDatabase((store) => {
    const repository = new SqlitePerformanceEntryRepository(store.database);
    for (const race of RACES) repository.insert({ ...race, note: null, recordedAt: RECORDED });

    const status = personalCalibrationStatus(store.database, AS_OF);
    assert.equal(status.labelCount, 10);
    assert.equal(status.scoredCount, 10);
    assert.equal(status.samples, 10);
    assert.equal(status.distances, 2, "ten-k and half-marathon");
    assert.ok(status.spanDays >= 120);
    assert.equal(status.available, true, "ten labels, two distances, a year apart");

    // A single entry is not "available" even though it is a label: the pass cannot
    // score it, and reporting readiness from the entry count alone would promise a
    // band that can never be fitted.
    const lonely = buildPersonalCalibrationSamples(store.database, AS_OF);
    assert.equal(lonely.samples.length, status.scoredCount);
  });
});
