import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildLabelFunnel, loadLabeledRaceOutcomes } from "../src/prediction-data.js";

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE workouts(id TEXT PRIMARY KEY, duration_seconds REAL);
    CREATE TABLE training_sessions(id TEXT PRIMARY KEY, status TEXT, anchor_start_at TEXT,
      anchor_end_at TEXT, anchor_distance_km REAL, canonical_workout_id TEXT);
    CREATE TABLE workout_overrides(id TEXT PRIMARY KEY, training_session_id TEXT, revision INTEGER,
      session_type TEXT, performance_protocol TEXT, rpe REAL, condition_tags_json TEXT,
      eligibility_override TEXT, created_at TEXT);
    INSERT INTO workouts VALUES ('w', 1800);
    INSERT INTO training_sessions VALUES ('s', 'active', '2026-09-01T01:00:00.000Z',
      '2026-09-01T01:30:00.000Z', 5, 'w');
  `);
  return db;
}

function label(db: DatabaseSync, revision: number, at: string, protocol: string | null, excluded = false): void {
  db.prepare("INSERT INTO workout_overrides VALUES (?, 's', ?, NULL, ?, NULL, '[]', ?, ?)")
    .run(`label-${revision}`, revision, protocol, excluded ? "exclude" : null, at);
}

test("T03: label funnel distinguishes unconfirmed, later confirmation, withdrawal and historical replay", () => {
  const db = fixture();
  try {
    const before = "2026-09-02T00:00:00.000Z";
    label(db, 1, "2026-09-03T00:00:00.000Z", "five_k_time_trial");
    assert.equal(buildLabelFunnel(db, before).primaryRejections.not_confirmed, 1);
    const acceptedAt = "2026-09-04T00:00:00.000Z";
    const accepted = buildLabelFunnel(db, acceptedAt);
    assert.equal(accepted.usableOutcomeCount, 1);
    assert.equal(accepted.byDistance.five_k.usable, 1);
    assert.equal(loadLabeledRaceOutcomes(db, acceptedAt)[0]?.labelAvailableAt, "2026-09-03T00:00:00.000Z");
    label(db, 2, "2026-09-05T00:00:00.000Z", null);
    assert.equal(buildLabelFunnel(db, "2026-09-06T00:00:00.000Z").primaryRejections.not_confirmed, 1);
    assert.deepEqual(buildLabelFunnel(db, acceptedAt), accepted);
  } finally { db.close(); }
});

test("T03: user exclusion, protocol mismatch and threshold-only records never become race labels", () => {
  const db = fixture();
  try {
    label(db, 1, "2026-09-02T00:00:00.000Z", "five_k_time_trial", true);
    assert.equal(buildLabelFunnel(db, "2026-09-02T12:00:00.000Z").primaryRejections.user_excluded, 1);
    label(db, 2, "2026-09-03T00:00:00.000Z", "ten_k_time_trial");
    assert.equal(buildLabelFunnel(db, "2026-09-03T12:00:00.000Z").primaryRejections.protocol_distance_mismatch, 1);
    label(db, 3, "2026-09-04T00:00:00.000Z", "thirty_min_threshold");
    const report = buildLabelFunnel(db, "2026-09-04T12:00:00.000Z");
    assert.equal(report.primaryRejections.threshold_only_protocol, 1);
    assert.equal(report.sessionCount, report.rejectedCount + report.usableOutcomeCount);
    assert.equal(report.rejectedCount, Object.values(report.primaryRejections).reduce((a, b) => a + b, 0));
  } finally { db.close(); }
});

test("T03: latest revisions and corrected results are counted once; inactive sessions are rejected", () => {
  const db = fixture();
  try {
    label(db, 1, "2026-09-02T00:00:00.000Z", "five_k_time_trial");
    label(db, 2, "2026-09-03T00:00:00.000Z", "five_k_time_trial");
    const at = "2026-09-04T00:00:00.000Z";
    const report = buildLabelFunnel(db, at, { five_k: 1 });
    assert.equal(report.usableOutcomeCount, 1);
    assert.equal(report.evaluatedOutcomeCount, 1);
    assert.equal(report.decisions[0]?.revision, 2);
    assert.throws(() => buildLabelFunnel(db, at, { five_k: 2 }), /Evaluated label counts/);
    db.exec("UPDATE training_sessions SET status='inactive'");
    assert.equal(buildLabelFunnel(db, at).primaryRejections.inactive_session, 1);
  } finally { db.close(); }
});
