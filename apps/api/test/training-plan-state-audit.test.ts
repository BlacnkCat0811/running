import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { auditTrainingPlanStateCopy } from "../src/training-plan-state-audit.js";
import { parseTrainingPlanState } from "../src/training-plan-store.js";

const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-sessions-v2.json", import.meta.url), "utf8"));
const scope = JSON.stringify(["synthetic-server", "synthetic-athlete", "synthetic-epoch"]);
const date = "2026-10-30";
const lock = { localDate: date, session: { kind: "easy", distanceKm: 5, reason: "PRIVATE_PAYLOAD_SENTINEL" },
  verdictTone: "green", lockedAt: "2026-10-25T03:00:00.000Z" };
const legacy = () => {
  const { planInstanceId, sessions, suppressions, publishedInputKey, ...state } = fixture.payload2;
  return parseTrainingPlanState({ ...state, schemaVersion: 1, migrationVersion: 1 });
};
function copyFixture() {
  const root = mkdtempSync(join(tmpdir(), "rai-a01-audit-")), path = join(root, "offline-copy.sqlite");
  const db = new DatabaseSync(path);
  // Minimal read schema deliberately permits malformed historical JSON.
  db.exec("CREATE TABLE mobile_training_state(scope TEXT,revision INTEGER,payload_json TEXT); CREATE TABLE mobile_training_state_history(scope TEXT,revision INTEGER,payload_json TEXT)");
  const insert = (table: string, payload: unknown, revision = 1, key = scope) =>
    db.prepare(`INSERT INTO ${table}(scope,revision,payload_json) VALUES (?,?,?)`).run(key, revision, JSON.stringify(payload));
  return { root, path, db, insert, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("A-01 audit: legal schema 1/2 history and locks report zero conflicts without file writes", () => {
  const f = copyFixture();
  try {
    f.insert("mobile_training_state", { ...fixture.payload2, lockedSession: { ...lock, localDate: "2026-10-29" } }, 2);
    f.insert("mobile_training_state_history", legacy());
    const before = readFileSync(f.path), report = auditTrainingPlanStateCopy(f.path);
    assert.equal(report.ok, true); assert.equal(report.snapshots, 2); assert.equal(report.scopes, 1);
    assert.equal(report.affectedScopes, 0); assert.deepEqual(report.conflicts, []); assert.deepEqual(report.issues, []);
    assert.deepEqual(readFileSync(f.path), before);
  } finally { f.close(); }
});

test("A-01 audit: both schemas, both conflict kinds and all historical scopes are reported with safe metadata", () => {
  const f = copyFixture();
  try {
    f.insert("mobile_training_state", { ...fixture.payload2, lockedSession: lock }, 2);
    f.insert("mobile_training_state_history", { ...legacy(), lockedSession: lock }, 1);
    f.insert("mobile_training_state_history", { ...legacy(), lockedSession: lock }, 4, JSON.stringify(["s2", "a2", "e2"]));
    const before = readFileSync(f.path), report = auditTrainingPlanStateCopy(f.path);
    assert.equal(report.ok, false); assert.equal(report.scopes, 2); assert.equal(report.affectedScopes, 2);
    assert.equal(report.conflicts.length, 4);
    assert.deepEqual(new Set(report.conflicts.map(c => c.schemaVersion)), new Set([1, 2]));
    assert.deepEqual(new Set(report.conflicts.map(c => c.kind)), new Set(["locked_session_explicit_rest", "locked_session_week_plan_rest"]));
    assert.ok(report.conflicts.every(c => c.localDate === date && c.revision > 0 && c.scope && c.source));
    assert.ok(report.conflicts.every(c => c.lockedKind === "easy"));
    assert.equal(JSON.stringify(report).includes("PRIVATE_PAYLOAD_SENTINEL"), false);
    assert.equal(JSON.stringify(report).includes("distanceKm"), false);
    assert.deepEqual(readFileSync(f.path), before);
  } finally { f.close(); }
});

test("A-01 audit: malformed JSON, unsupported schema and invalid state cannot be reported as clean", () => {
  const f = copyFixture();
  try {
    f.db.prepare("INSERT INTO mobile_training_state VALUES (?,1,?)").run(scope, '{"private":"PRIVATE_PAYLOAD_SENTINEL"');
    f.insert("mobile_training_state_history", { schemaVersion: 99 }, 2);
    f.insert("mobile_training_state_history", { schemaVersion: 2 }, 3);
    const report = auditTrainingPlanStateCopy(f.path);
    assert.equal(report.ok, false);
    assert.equal(report.complete, false); assert.equal(report.affectedScopes, null, "an incomplete audit never claims zero affected scopes");
    assert.deepEqual(report.issues.map(i => i.code).sort(), ["invalid_json", "invalid_state", "unsupported_state_schema"]);
    assert.equal(JSON.stringify(report).includes("PRIVATE_PAYLOAD_SENTINEL"), false);
  } finally { f.close(); }
});

test("A-01 audit: missing file and incompatible table schema are explicit failures and never create a DB", () => {
  const f = copyFixture();
  try {
    const missing = join(f.root, "missing.sqlite");
    assert.equal(auditTrainingPlanStateCopy(missing).issues[0]?.code, "control_copy_missing_or_not_file");
    assert.equal(existsSync(missing), false);
    f.db.exec("DROP TABLE mobile_training_state_history");
    const report = auditTrainingPlanStateCopy(f.path);
    assert.equal(report.ok, false); assert.equal(report.issues[0]?.code, "state_table_schema_mismatch");
  } finally { f.close(); }
});

test("A-01 audit CLI: explicit copy path, no environment dependency, nonzero on conflicts or incomplete audit; no apply mode", () => {
  const f = copyFixture();
  try {
    const health = join(f.root, "must-not-open.sqlite");
    const invoke = (args: string[]) => spawnSync(process.execPath,
      ["--import", "tsx", "scripts/audit-training-plan-state.mts", ...args],
      { encoding: "utf8", env: { ...process.env, RAI_DATABASE: health, RAI_CONTROL_DATABASE: health } });
    assert.equal(JSON.parse(invoke([]).stdout).issues[0].code, "control_db_copy_required");
    f.insert("mobile_training_state", legacy());
    const args = ["--control-db-copy", f.path];
    assert.equal(invoke(args).status, 0);
    f.insert("mobile_training_state_history", { ...fixture.payload2, lockedSession: lock });
    const conflict = invoke(args);
    assert.equal(conflict.status, 1); assert.equal(JSON.parse(conflict.stdout).affectedScopes, 1);
    assert.equal(invoke([...args, "--apply"]).status, 1);
    assert.equal(existsSync(health), false);
  } finally { f.close(); }
});
