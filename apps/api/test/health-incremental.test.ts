import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test, { before, after } from "node:test";
import { RaiApplicationService } from "@rai/application";
import { healthTypes } from "@rai/contracts";
import { canonicalizeNights } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";
import { analyzeDatasetChange } from "../src/import-dataset-analysis.js";

const root = mkdtempSync(join(tmpdir(), "rai-health-incremental-"));
const baselinePath = join(root, "baseline.sqlite");
const evaluatedAt = "2026-01-31T12:00:00.000Z";
const iso = (time: number) => new Date(time).toISOString();
const runAt = (index: number) => Date.UTC(2026, 0, 1 + index * 3);
const batchId = "health-delta";
const source = "Fixture Apple Watch";

function record(db: DatabaseSync, id: string, type: string, start: string, end: string, value: number | string, name = source) {
  db.prepare(`INSERT INTO health_records (id,type,source_name,source_category,unit,value_numeric,value_text,
    start_at,end_at,metadata_json,raw_attributes_json) VALUES (?,?,?,'apple_watch',?,?,?,?,?,'{}','{}')`)
    .run(id, type, name, type === healthTypes.runningSpeed ? "m/s" : "count/min",
      typeof value === "number" ? value : null, typeof value === "string" ? value : null, start, end);
}
function ledger(db: DatabaseSync, id: string, change = "updated", kind = "record") {
  // Deliberately late effective_at: bounds must come from old/new facts.
  db.prepare(`INSERT INTO import_entity_changes (batch_id,entity_kind,entity_id,change_type,effective_at,content_hash)
    VALUES (?,?,?,?,?,'changed')`).run(batchId, kind, id, change, evaluatedAt);
}

before(async () => {
  const store = await RaiDatabase.open(baselinePath);
  try {
    const db = store.database;
    for (let day = 0; day < 61; day++) {
      const wake = Date.UTC(2025, 11, 1 + day, 22);
      const hours = [4, 8, 5, 9, 6, 10, 7][day % 7]!;
      const hrv = [30, 55, 40, 65, 35, 60, 45][day % 7]!;
      record(db, `sleep-${day}`, healthTypes.sleepAnalysis, iso(wake - hours * 3600_000), iso(wake), "HKCategoryValueSleepAnalysisAsleepCore");
      record(db, `hrv-${day}`, healthTypes.hrvSdnn, iso(wake - 3600_000), iso(wake - 3600_000), hrv);
      record(db, `rhr-${day}`, healthTypes.restingHeartRate, iso(wake + 3600_000), iso(wake + 3600_000), 52);
    }
    for (let i = 0; i < 10; i++) {
      db.prepare(`INSERT INTO workouts (id,activity_type,source_name,source_category,start_at,end_at,duration_seconds,
        indoor,metadata_json,raw_attributes_json,is_canonical)
        VALUES (?,'HKWorkoutActivityTypeRunning',?,'apple_watch',?,?,1800,0,'{}','{}',1)`)
        .run(`workout-${i}`, source, iso(runAt(i)), iso(runAt(i) + 1800_000));
      db.prepare(`INSERT INTO training_sessions (id,activity_type,anchor_start_at,anchor_end_at,anchor_distance_km,canonical_workout_id,status)
        VALUES (?,'HKWorkoutActivityTypeRunning',?,?,5,?,'active')`)
        .run(`session-${i}`, iso(runAt(i)), iso(runAt(i) + 1800_000), `workout-${i}`);
      db.prepare(`INSERT INTO workout_statistics (workout_id,ordinal,type,unit,sum_value) VALUES (?,0,?,'km',5)`)
        .run(`workout-${i}`, healthTypes.distanceWalkingRunning);
      for (let j = 0; j < 30; j++) {
        record(db, `hr-${i}-${j}`, healthTypes.heartRate, iso(runAt(i) + j * 60_000), iso(runAt(i) + (j + 1) * 60_000), 150);
        record(db, `speed-${i}-${j}`, healthTypes.runningSpeed, iso(runAt(i) + j * 60_000), iso(runAt(i) + (j + 1) * 60_000), 2.8);
      }
    }
    canonicalizeNights(db, "Asia/Shanghai");
    store.setManifest("dataset_version", "baseline"); store.flush();
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt, timezoneIdentifier: "Asia/Shanghai" });
    assert.equal(service.runNextJob()?.status, "succeeded");
  } finally { store.close(); }
});
after(() => rmSync(root, { recursive: true, force: true }));

async function scenario(name: string, mutate: (db: DatabaseSync) => void, canonicalize = false) {
  const path = join(root, `${name}.sqlite`);
  copyFileSync(baselinePath, path);
  const store = await RaiDatabase.open(path);
  try {
    store.database.prepare(`INSERT INTO import_batches(id,xml_sha256,status,import_mode,summary_json)
      VALUES (?,'fixture','succeeded','incremental','{}')`).run(batchId);
    mutate(store.database);
    if (canonicalize) canonicalizeNights(store.database, "Asia/Shanghai");
    store.setManifest("dataset_version", name); store.flush();
  } finally { store.close(); }
  return { path, plan: analyzeDatasetChange(path, baselinePath, batchId, true) };
}

const cases: Array<{ name: string; mutate: (db: DatabaseSync) => void; boundary: string; reused: number; canonicalize?: boolean }> = [
  {
    name: "heart-overlap",
    mutate: (db) => { db.prepare("UPDATE health_records SET value_numeric=150.1 WHERE id='hr-8-10'").run(); ledger(db, "hr-8-10"); },
    boundary: iso(runAt(8)), reused: 8
  },
  {
    name: "speed-deleted",
    mutate: (db) => { db.prepare("DELETE FROM health_records WHERE id='speed-8-10'").run(); ledger(db, "speed-8-10", "removed"); },
    boundary: iso(runAt(8)), reused: 8
  },
  {
    name: "resting-heart",
    mutate: (db) => { db.prepare("UPDATE health_records SET value_numeric=52.01 WHERE id='rhr-54'").run(); ledger(db, "rhr-54"); },
    boundary: "2026-01-24T23:00:00.000Z", reused: 8
  },
  {
    name: "hrv-correction",
    mutate: (db) => { db.prepare("UPDATE health_records SET value_numeric=51 WHERE id='hrv-54'").run(); ledger(db, "hrv-54"); },
    boundary: "2026-01-24T21:00:00.000Z", reused: 8, canonicalize: true
  },
  {
    name: "deleted-night",
    mutate: (db) => { db.prepare("DELETE FROM health_records WHERE id='sleep-54'").run(); ledger(db, "sleep-54", "removed"); },
    boundary: "2026-01-24T12:00:00.000Z", reused: 8, canonicalize: true
  },
  {
    name: "late-sleep-switch",
    mutate: (db) => {
      record(db, "late-sleep", healthTypes.sleepAnalysis, "2026-01-25T01:00:00.000Z", "2026-01-25T05:00:00.000Z",
        "HKCategoryValueSleepAnalysisAsleepCore", "AAA Apple Watch");
      ledger(db, "late-sleep", "inserted");
    },
    boundary: "2026-01-24T22:00:00.000Z", reused: 8, canonicalize: true
  },
  {
    name: "after-last-workout",
    mutate: (db) => {
      record(db, "today-rhr", healthTypes.restingHeartRate, "2026-01-31T00:00:00.000Z", "2026-01-31T00:00:00.000Z", 52.01);
      ledger(db, "today-rhr", "inserted");
    },
    boundary: "2026-01-31T00:00:00.000Z", reused: 10
  }
];

for (const value of cases) {
  test(`health increment ${value.name} matches independent full replay`, async () => {
    const { path, plan } = await scenario(value.name, value.mutate, value.canonicalize ?? false);
    assert.equal(plan.mode, "incremental", JSON.stringify(plan));
    assert.equal(plan.dirtyFromAt, value.boundary);
    const store = await RaiDatabase.open(path);
    try {
      const service = new RaiApplicationService(store);
      const id = service.enqueueIncrementalRecompute({
        mode: "partial", dirtySessionIds: [], dirtyFromAt: plan.dirtyFromAt!, reasons: plan.recomputeReasons ?? []
      }, { evaluatedAt, timezoneIdentifier: "Asia/Shanghai", validationMode: "shadow" });
      const completed = service.runNextJob();
      assert.equal(completed?.status, "succeeded", JSON.stringify(completed));
      const validation = store.database.prepare("SELECT status FROM recompute_validations WHERE job_id=?").get(id!) as { status: string };
      assert.equal(validation.status, "matched");
      const feature = store.database.prepare(`SELECT feature.reused_feature_count AS reused, feature.recomputed_feature_count AS recomputed
        FROM active_model_run active JOIN model_runs model ON model.id=active.model_run_id
        JOIN feature_runs feature ON feature.id=model.feature_run_id`).get() as { reused: number; recomputed: number };
      assert.equal(feature.reused, value.reused);
      assert.equal(feature.recomputed, 10 - value.reused);
    } finally { store.close(); }
  });
}

test("moving a stable record id uses both timestamps and does not trust only the new value", async () => {
  const { plan } = await scenario("moved-record", (db) => {
    db.prepare("UPDATE health_records SET start_at=?,end_at=? WHERE id='hr-7-10'").run(iso(runAt(9)), iso(runAt(9) + 60_000));
    ledger(db, "hr-7-10");
  });
  assert.equal(plan.mode, "incremental");
  assert.equal(plan.dirtyFromAt, iso(runAt(7)));
});

test("changing a scoring record into an unrelated type still invalidates its old interval", async () => {
  const { plan } = await scenario("changed-record-type", (db) => {
    db.prepare("UPDATE health_records SET type='HKQuantityTypeIdentifierStepCount' WHERE id='hr-8-10'").run();
    ledger(db, "hr-8-10");
  });
  assert.equal(plan.mode, "incremental");
  assert.equal(plan.dirtyFromAt, iso(runAt(8)));
});

test("recovery algorithm changes retain full recompute even without raw record changes", async () => {
  const { plan } = await scenario("recovery-version", (db) => {
    db.prepare("UPDATE canonical_nights SET provenance_json=json_set(provenance_json,'$.algorithmVersion','future-version')").run();
  });
  assert.equal(plan.mode, "full");
  assert.ok(plan.recomputeReasons?.includes("recovery_algorithm_changed"));
});

test("workout statistics edits with stable identity still invalidate the correct prefix", async () => {
  const { plan } = await scenario("workout-content", (db) => {
    db.prepare("UPDATE workout_statistics SET sum_value=5.01 WHERE workout_id='workout-8'").run();
    ledger(db, "workout-8", "updated", "workout");
  });
  assert.equal(plan.mode, "incremental");
  assert.equal(plan.dirtyFromAt, iso(runAt(8)));
  assert.equal(plan.updatedWorkouts, 1);
  assert.equal(plan.unchangedWorkouts, 9);
});

for (const kind of ["unknown-deletion", "invalid-time", "vo2", "profile", "parser-version", "earliest-health"] as const) {
  test(`uncertain/global health change ${kind} retains full recompute`, async () => {
    const { plan } = await scenario(kind, (db) => {
      if (kind === "unknown-deletion") ledger(db, "not-in-either-snapshot", "removed");
      if (kind === "invalid-time") { db.prepare("UPDATE health_records SET start_at='invalid' WHERE id='hr-8-10'").run(); ledger(db, "hr-8-10"); }
      if (kind === "vo2") { record(db, "vo2", healthTypes.vo2Max, iso(runAt(8)), iso(runAt(8)), 50); ledger(db, "vo2", "inserted"); }
      if (kind === "profile") db.prepare("INSERT INTO profile(id,attributes_json) VALUES (1,?)").run('{"HKCharacteristicTypeIdentifierDateOfBirth":"1990-01-01"}');
      if (kind === "parser-version") db.prepare("INSERT INTO import_manifest(key,value) VALUES ('parser_contract_version','changed')").run();
      if (kind === "earliest-health") { db.prepare("UPDATE health_records SET value_numeric=149 WHERE id='hr-0-0'").run(); ledger(db, "hr-0-0"); }
    });
    assert.equal(plan.mode, "full", JSON.stringify(plan));
    assert.equal(plan.dirtyFromAt, null);
  });
}

test("same-id edits without a usable ledger cannot slip through as unchanged", async () => {
  const { path } = await scenario("no-ledger-edit", (db) => { db.prepare("UPDATE health_records SET value_numeric=151 WHERE id='hr-8-10'").run(); });
  const plan = analyzeDatasetChange(path, baselinePath);
  assert.equal(plan.mode, "full");
  assert.ok(plan.recomputeReasons?.includes("health_ledger_unavailable"));
});

test("timezone changes prevent reuse of a feature prefix calculated for another timezone", async () => {
  const { path, plan } = await scenario("timezone-change", cases[0]!.mutate);
  const store = await RaiDatabase.open(path);
  try {
    const service = new RaiApplicationService(store);
    const id = service.enqueueIncrementalRecompute({
      mode: "partial", dirtySessionIds: [], dirtyFromAt: plan.dirtyFromAt!, reasons: ["timezone-test"]
    }, { evaluatedAt, timezoneIdentifier: "UTC", validationMode: "shadow" });
    service.runNextJob();
    // A version-to-version quality gate may reject a timezone change; the
    // independent candidate/reference comparison must nevertheless match.
    const validation = store.database.prepare("SELECT status FROM recompute_validations WHERE job_id=?")
      .get(id!) as { status: string } | undefined;
    assert.equal(validation?.status, "matched");
    const runs = store.database.prepare("SELECT reused_feature_count AS reused FROM feature_runs WHERE dataset_version=?")
      .all("timezone-change") as { reused: number }[];
    assert.ok(runs.length > 0);
    assert.ok(runs.every((run) => run.reused === 0));
  } finally { store.close(); }
});
