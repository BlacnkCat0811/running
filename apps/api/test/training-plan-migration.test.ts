import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { MobilePlanOperationScope } from "@rai/api-contracts";

import { MobileGoalsStore } from "../src/mobile-goals.js";
import { digest } from "../src/plan-digest.js";
import {
  TRAINING_PLAN_MIGRATION_VERSION,
  TRAINING_PLAN_STATE_SCHEMA_VERSION,
  TrainingPlanStateError,
  TrainingPlanStore,
  classifyTrainingPlanMigration,
  ensureTrainingPlanSchema,
  legacyCoachLoopReceiptScopeKey,
  parseTrainingPlanScopeKey,
  parseTrainingPlanState,
  readTrainingPlanMigrationSources,
  trainingPlanScopeKey,
  type TrainingPlanMigrationClassification,
  type TrainingPlanState
} from "../src/training-plan-store.js";
import { resolveTrainingMode } from "../src/training-mode-policy.js";

/**
 * PR3 first slice: unified training-state schema + CAS store + migration CLI.
 *
 * Every test uses a throwaway SQLite file under the OS temp directory. No test
 * opens `var/rai-control.sqlite` or `var/rai.sqlite`, and no test touches a server
 * route: this slice is deliberately not wired into the HTTP surface.
 */

/** Control-schema migration number added by this slice (next free after version 1). */
const CONTROL_SCHEMA_VERSION = 2;

const IDENTITY: MobilePlanOperationScope = { serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" };
const BUSINESS_DATE = "2026-10-20";
const FIXED_NOW = "2026-10-20T02:00:00.000Z";
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CLI_SCRIPT = join(REPO_ROOT, "scripts", "migrate-training-planner.mts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "rai-training-plan-migration-"));
}

/**
 * Creates the control database through the real store (which applies control
 * schema migration 2), then rewrites the seeded goals row and optionally appends a
 * coach-loop receipt under the historical object scope spelling — the exact shape
 * a real control database has.
 */
function createFixture(root: string, options: {
  goals?: Record<string, unknown> | null;
  goalsRevision?: number;
  receipt?: Record<string, unknown> | null;
} = {}): string {
  const controlPath = join(root, "rai-control.sqlite");
  const seed = new MobileGoalsStore(root, controlPath);
  seed.close();
  const database = new DatabaseSync(controlPath);
  try {
    if (options.goals !== null) {
      const payload = options.goals ?? goalsPayload();
      database.prepare("UPDATE mobile_goals SET revision = ?, payload_json = ?, updated_at = ? WHERE singleton = 1")
        .run(options.goalsRevision ?? 3, JSON.stringify(payload), FIXED_NOW);
    }
    if (options.receipt !== null && options.receipt !== undefined) {
      database.prepare("INSERT INTO mobile_coach_loop_receipts(scope, operation_id, payload_json) VALUES (?, ?, ?)")
        .run(legacyCoachLoopReceiptScopeKey(IDENTITY), "op-fixture-1", JSON.stringify(options.receipt));
    }
  } finally {
    database.close();
  }
  return controlPath;
}

function goalsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    easyDurationFloorFraction: 0.75,
    qualitySessionCap: 2,
    raceTarget: null,
    weekPlan: [],
    lockedSession: null,
    weekPlanAudit: null,
    weekPlanReplanRequired: false,
    weekPlanPreservedDate: null,
    runCoach: null,
    ...overrides
  };
}

function dailyAdaptiveSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "daily_adaptive",
    status: "active",
    runningDays: [1, 2, 3, 4, 5, 6, 7],
    longRunDays: [7],
    availabilityMinutesByWeekday: {},
    targetType: "pace",
    race: null,
    ...overrides
  };
}

function racePreparationSettings(raceDate = "2026-11-01", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return dailyAdaptiveSettings({
    mode: "race_preparation",
    runningDays: [1, 2, 3, 4, 5],
    longRunDays: [5],
    race: {
      goal: "finish",
      raceDate,
      raceDistanceKm: 10,
      targetTimeSeconds: null,
      runningDays: [1, 2, 3, 4, 5],
      longRunDays: [5],
      targetType: "pace",
      strengthTraining: false
    },
    ...overrides
  });
}

function receiptPayload(settings: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { settings, policyHash: "policy-hash-v1", evaluatedAt: "2026-10-19T23:00:00.000Z", result: "no_change", ...overrides };
}

const REST_DAY = { localDate: "2026-10-21", kind: "rest", distanceKm: null, structure: null, reason: "ended" };
const EASY_DAY = { localDate: "2026-10-21", kind: "easy", distanceKm: 5, structure: null, reason: "fixture" };

function classify(database: DatabaseSync): TrainingPlanMigrationClassification {
  return classifyTrainingPlanMigration({
    scope: IDENTITY,
    sources: readTrainingPlanMigrationSources(database, IDENTITY),
    businessDate: BUSINESS_DATE,
    now: FIXED_NOW
  });
}

function stateOf(classification: TrainingPlanMigrationClassification): TrainingPlanState {
  const state = classification.state;
  assert.ok(state !== null, "fixture must classify without conflicts");
  return state;
}

function applyClassification(database: DatabaseSync, classification: TrainingPlanMigrationClassification,
  overrides: { sourceDigest?: string; state?: TrainingPlanState; expected?: number | null } = {}) {
  const store = new TrainingPlanStore(database);
  return store.applyMigration({
    scope: classification.scope,
    expectedAbsentOrRevision: overrides.expected === undefined ? classification.existingRevision : overrides.expected,
    sourceDigest: overrides.sourceDigest ?? classification.sourceDigest,
    state: overrides.state ?? stateOf(classification)
  });
}

interface Counts {
  state: number;
  history: number;
  audit: number;
  goals: number;
  receipts: number;
  operations: number;
}

function counts(database: DatabaseSync): Counts {
  const count = (table: string): number => {
    if (!database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return 0;
    const row = database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number };
    return Number(row.value);
  };
  return {
    state: count("mobile_training_state"),
    history: count("mobile_training_state_history"),
    audit: count("mobile_training_migration_audit"),
    goals: count("mobile_goals"),
    receipts: count("mobile_coach_loop_receipts"),
    operations: count("mobile_plan_operations")
  };
}

function controlSchemaVersions(database: DatabaseSync): number[] {
  const rows = database.prepare("SELECT version FROM mobile_control_schema ORDER BY version").all() as Array<{ version: number }>;
  return rows.map(row => Number(row.version));
}

function goalsPayloadText(database: DatabaseSync): string {
  const row = database.prepare("SELECT payload_json FROM mobile_goals WHERE singleton = 1").get() as { payload_json: string };
  return row.payload_json;
}

// CLI spawn: no shell, no bash. `node --import tsx` is how the repo runs scripts.
function runCli(controlPath: string, extra: string[] = []) {
  return spawnSync(process.execPath, [
    "--import", "tsx", CLI_SCRIPT,
    "--control-db", controlPath,
    "--server-id", IDENTITY.serverId,
    "--athlete-id", IDENTITY.athleteId,
    "--dataset-epoch", IDENTITY.datasetEpoch,
    "--business-date", BUSINESS_DATE,
    ...extra
  ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 180_000 });
}

function parseCliJson(result: { stdout: string }): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Control-schema migration 2
// ---------------------------------------------------------------------------

test("control-schema migration 2 is appended after version 1 and keeps legacy rows readable", () => {
  const root = tempRoot();
  try {
    const controlPath = join(root, "legacy-control.sqlite");
    const legacyScope = legacyCoachLoopReceiptScopeKey(IDENTITY);
    const legacyReceipt = JSON.stringify(receiptPayload(dailyAdaptiveSettings()));
    // A pre-PR3 control database: schema ledger at version 1, with a coach-loop
    // receipt and an idempotency row that must survive the new migration.
    const legacy = new DatabaseSync(controlPath);
    try {
      legacy.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE mobile_control_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        INSERT INTO mobile_control_schema(version, applied_at) VALUES (1, '2026-10-01T00:00:00.000Z');
        CREATE TABLE mobile_coach_loop_receipts (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
          operation_id TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(scope, operation_id));
        CREATE TABLE mobile_plan_operations (
          scope TEXT NOT NULL, operation_id TEXT NOT NULL, request_digest TEXT NOT NULL,
          result_json TEXT, expires_at TEXT NOT NULL, PRIMARY KEY(scope, operation_id));
      `);
      legacy.prepare("INSERT INTO mobile_coach_loop_receipts(scope, operation_id, payload_json) VALUES (?, ?, ?)")
        .run(legacyScope, "op-legacy", legacyReceipt);
      legacy.prepare("INSERT INTO mobile_plan_operations(scope, operation_id, request_digest, result_json, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(legacyScope, "op-idem", "digest", '{"ok":true}', "2026-11-01T00:00:00.000Z");
    } finally {
      legacy.close();
    }

    // Dry-run must also work on a control database that predates migration 2, and
    // it must not create the new tables (otherwise it would not be a dry run).
    const dryRun = runCli(controlPath);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(parseCliJson(dryRun).mode, "dry-run");
    assert.equal(parseCliJson(dryRun).applyAllowed, true);
    const untouched = new DatabaseSync(controlPath);
    try {
      assert.deepEqual(controlSchemaVersions(untouched), [1], "dry-run does not run schema migration 2");
      assert.equal(untouched.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mobile_training_state'").get(), undefined,
        "dry-run does not create the unified state table");
      assert.equal(counts(untouched).receipts, 1);
    } finally {
      untouched.close();
    }

    const first = new MobileGoalsStore(root, controlPath);
    try {
      const database = new DatabaseSync(controlPath);
      try {
        assert.deepEqual(controlSchemaVersions(database), [1, CONTROL_SCHEMA_VERSION],
          "the new migration is appended after the existing version 1, never renumbered");
        for (const table of ["mobile_training_state", "mobile_training_state_history", "mobile_training_migration_audit"]) {
          assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
            `${table} exists`);
        }
        assert.equal(counts(database).receipts, 1, "the legacy coach-loop receipt is untouched");
        assert.equal(counts(database).operations, 1, "the legacy idempotency row is untouched");
        const stored = database.prepare("SELECT payload_json FROM mobile_coach_loop_receipts WHERE operation_id = 'op-legacy'")
          .get() as { payload_json: string };
        assert.equal(stored.payload_json, legacyReceipt, "receipt bytes are not rewritten by the migration");
        assert.equal(counts(database).state, 0, "the schema migration writes no training state");
      } finally {
        database.close();
      }
      assert.ok(first.coachLoopState<{ settings: { status: string } }>(legacyScope) !== null,
        "the store still reads the legacy receipt scope");
    } finally {
      first.close();
    }

    // Re-opening a database that already recorded version 2 is a no-op.
    const second = new MobileGoalsStore(root, controlPath);
    try {
      const database = new DatabaseSync(controlPath);
      try {
        assert.deepEqual(controlSchemaVersions(database), [1, CONTROL_SCHEMA_VERSION], "no duplicate ledger row");
        assert.equal(counts(database).receipts, 1);
      } finally {
        database.close();
      }
    } finally {
      second.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CAS store
// ---------------------------------------------------------------------------

test("apply writes state, one history row and one audit row together, and read returns the same state", () => {
  const root = tempRoot();
  try {
    const controlPath = createFixture(root, {
      goals: goalsPayload({ weekPlan: [EASY_DAY] }),
      goalsRevision: 7,
      receipt: receiptPayload(dailyAdaptiveSettings())
    });
    const database = new DatabaseSync(controlPath);
    try {
      const classification = classify(database);
      assert.equal(classification.conflicts.length, 0);
      assert.equal(classification.kind, "coach_loop");
      assert.equal(classification.runState, "active");
      const state = stateOf(classification);
      assert.equal(state.schemaVersion, TRAINING_PLAN_STATE_SCHEMA_VERSION);

      const store = new TrainingPlanStore(database);
      const before = counts(database);
      const result = store.applyMigration({
        scope: classification.scope,
        expectedAbsentOrRevision: null,
        sourceDigest: classification.sourceDigest,
        state
      });
      assert.equal(result.status, "applied");
      if (result.status !== "applied") return;
      assert.equal(result.revision, 1);

      const after = counts(database);
      assert.equal(after.state, before.state + 1);
      assert.equal(after.history, before.history + 1);
      assert.equal(after.audit, before.audit + 1);
      assert.equal(after.receipts, before.receipts, "the migration never appends or deletes receipts");

      const audit = database.prepare(
        `SELECT migration_version, source_digest, result_digest, status, payload_json
         FROM mobile_training_migration_audit WHERE scope = ?`).get(classification.scope) as
        { migration_version: number; source_digest: string; result_digest: string; status: string; payload_json: string };
      assert.equal(Number(audit.migration_version), TRAINING_PLAN_MIGRATION_VERSION);
      assert.equal(audit.source_digest, classification.sourceDigest);
      assert.equal(audit.result_digest, digest(state), "audit records the result digest of the state");
      assert.equal(audit.status, "applied");
      assert.equal((JSON.parse(audit.payload_json) as { revision: number }).revision, 1);

      const history = database.prepare("SELECT revision, event_type FROM mobile_training_state_history WHERE scope = ?")
        .get(classification.scope) as { revision: number; event_type: string };
      assert.equal(Number(history.revision), 1);
      assert.equal(history.event_type, "migration_created");

      const row = store.read(classification.scope);
      assert.ok(row !== null);
      assert.equal(row.revision, 1);
      assert.deepEqual(row.state, state, "a JSON round trip preserves the state");
      assert.deepEqual(row.state.weekPlan, [EASY_DAY], "the stored weekly intent is carried over");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replaying the same source digest is a no-op; a different digest is an explicit conflict", () => {
  const root = tempRoot();
  try {
    const controlPath = createFixture(root, {
      goals: goalsPayload({ weekPlan: [EASY_DAY] }),
      receipt: receiptPayload(dailyAdaptiveSettings())
    });
    const database = new DatabaseSync(controlPath);
    try {
      const classification = classify(database);
      const first = applyClassification(database, classification);
      assert.equal(first.status, "applied");
      const afterFirst = counts(database);

      const replay = applyClassification(database, classification);
      assert.equal(replay.status, "replayed");
      if (replay.status === "replayed") assert.equal(replay.revision, 1);
      assert.deepEqual(counts(database), afterFirst, "replay writes neither state nor history nor audit");

      const otherDigest = digest({ contract: "other-source", scope: classification.scope });
      const changedState: TrainingPlanState = { ...stateOf(classification), sourceDigest: otherDigest };
      const conflict = applyClassification(database, classification, { sourceDigest: otherDigest, state: changedState });
      assert.equal(conflict.status, "conflict");
      if (conflict.status === "conflict") {
        assert.equal(conflict.reason, "digest_mismatch");
        assert.equal(conflict.currentRevision, 1);
        assert.equal(conflict.currentSourceDigest, classification.sourceDigest);
      }
      assert.deepEqual(counts(database), afterFirst, "a refused different digest never overwrites the recorded result");
      const row = new TrainingPlanStore(database).read(classification.scope);
      assert.deepEqual(row?.state, stateOf(classification));
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CAS conflict on a concurrent revision is detected and does not overwrite", () => {
  const root = tempRoot();
  try {
    const controlPath = createFixture(root, {
      goals: goalsPayload({ weekPlan: [EASY_DAY] }),
      receipt: receiptPayload(dailyAdaptiveSettings())
    });
    const database = new DatabaseSync(controlPath);
    try {
      const classification = classify(database);
      const applied = applyClassification(database, classification);
      assert.equal(applied.status, "applied");

      // Simulate a future command writer committing between the CLI's read and its
      // CAS write. The payload stays at migration version 1; only the revision moves.
      database.prepare("UPDATE mobile_training_state SET revision = 2, updated_at = ? WHERE scope = ?")
        .run("2026-10-20T03:00:00.000Z", classification.scope);
      const afterConcurrentWrite = counts(database);

      // A second derivation version is the only way a new write may follow the
      // recorded one; it still has to CAS against revision 2, not the stale 1.
      const upgradeDigest = digest({ contract: "upgrade-v2", scope: classification.scope });
      const upgradeState: TrainingPlanState = {
        ...stateOf(classification),
        migrationVersion: TRAINING_PLAN_MIGRATION_VERSION + 1,
        sourceDigest: upgradeDigest,
        planContextDigest: null,
        migratedAt: "2026-10-20T03:01:00.000Z"
      };
      const stale = applyClassification(database, classification, {
        sourceDigest: upgradeDigest,
        state: upgradeState,
        expected: applied.status === "applied" ? applied.revision : 1
      });
      assert.equal(stale.status, "conflict");
      if (stale.status === "conflict") {
        assert.equal(stale.reason, "revision_conflict");
        assert.equal(stale.currentRevision, 2);
      }
      assert.deepEqual(counts(database), afterConcurrentWrite, "the refused upgrade wrote no rows");

      // The retry, having observed revision 2, applies and records a second audit
      // version without rewriting the first one.
      const retried = applyClassification(database, classification, {
        sourceDigest: upgradeDigest,
        state: upgradeState,
        expected: 2
      });
      assert.equal(retried.status, "applied");
      if (retried.status === "applied") assert.equal(retried.revision, 3);
      assert.equal(counts(database).history, 2);
      assert.equal(counts(database).audit, 2);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state validation fails closed on unknown schemaVersion, non-canonical scope and ended/active state", () => {
  const root = tempRoot();
  try {
    const controlPath = createFixture(root, { receipt: receiptPayload(dailyAdaptiveSettings({ status: "ended" })) });
    const database = new DatabaseSync(controlPath);
    try {
      const state = stateOf(classify(database));

      assert.throws(() => parseTrainingPlanState({ ...state, schemaVersion: 99 }),
        (error: unknown) => error instanceof TrainingPlanStateError && /schemaVersion/.test(error.message));
      assert.throws(() => parseTrainingPlanState({ ...state, sourceStatus: "ended", runState: "active" }),
        (error: unknown) => error instanceof TrainingPlanStateError && /ended/.test(error.message));
      // The canonical scope is the array form only; the historical object spelling
      // used by receipts must not silently address the new store.
      assert.throws(() => parseTrainingPlanScopeKey(JSON.stringify(IDENTITY)),
        (error: unknown) => error instanceof TrainingPlanStateError && /scope/.test(error.message));
      assert.notEqual(trainingPlanScopeKey(IDENTITY), legacyCoachLoopReceiptScopeKey(IDENTITY),
        "receipts keep their historical object scope key; the unified state uses the array key");
      assert.deepEqual(parseTrainingPlanScopeKey(trainingPlanScopeKey(IDENTITY)), IDENTITY);

      const store = new TrainingPlanStore(database);
      const mismatchedDigest = digest({ contract: "unrelated" });
      assert.throws(() => store.applyMigration({
        scope: trainingPlanScopeKey(IDENTITY),
        expectedAbsentOrRevision: null,
        sourceDigest: mismatchedDigest,
        state
      }), (error: unknown) => error instanceof TrainingPlanStateError && /sourceDigest/.test(error.message));
      assert.equal(counts(database).state, 0, "a rejected payload writes nothing");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Classification: source selection, F04 preservation, ended semantics, conflicts
// ---------------------------------------------------------------------------

test("a pre-existing public race goal is preserved into the state (F04 data half)", () => {
  const root = tempRoot();
  try {
    const publicRaceTarget = { date: "2026-11-01", distance: "ten_k", targetPaceSecondsPerKm: 300 };
    const controlPath = createFixture(root, {
      goals: goalsPayload({ raceTarget: publicRaceTarget }),
      goalsRevision: 5,
      // The live daily-adaptive runtime writes `raceTarget: null` on enable; the
      // migration must still read the public goal from the stored row.
      receipt: receiptPayload(dailyAdaptiveSettings())
    });
    const database = new DatabaseSync(controlPath);
    try {
      const classification = classify(database);
      assert.equal(classification.conflicts.length, 0);
      assert.deepEqual(classification.publicRaceTarget, publicRaceTarget);
      assert.ok(classification.raceGoal !== null);
      assert.equal(classification.raceGoal.date, "2026-11-01");
      assert.equal(classification.raceGoal.distanceKm, 10);
      assert.equal(classification.raceGoal.goal, "time");
      assert.equal(classification.raceGoal.targetTimeSeconds, 3000, "pace × distance becomes the target time");
      assert.deepEqual(stateOf(classification).legacyRaceTarget, publicRaceTarget,
        "the public payload is preserved verbatim for the future publisher");

      // Mode is derived, never stored: the CLI/report path delegates to the policy.
      assert.deepEqual(resolveTrainingMode({ raceGoal: classification.raceGoal, businessDate: BUSINESS_DATE }),
        { mode: "race", reason: "race_goal_upcoming", daysToRace: 12 });

      const result = applyClassification(database, classification);
      assert.equal(result.status, "applied");
      const row = new TrainingPlanStore(database).read(classification.scope);
      assert.deepEqual(row?.state.legacyRaceTarget, publicRaceTarget);
      assert.deepEqual(row?.state.raceGoal, classification.raceGoal);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an ended coach loop is stored as paused/ended and its all-rest window is not recorded as intent", () => {
  const root = tempRoot();
  try {
    const controlPath = createFixture(root, {
      goals: goalsPayload({ weekPlan: [REST_DAY], lockedSession: null }),
      goalsRevision: 9,
      receipt: receiptPayload(dailyAdaptiveSettings({ status: "ended" }))
    });
    const database = new DatabaseSync(controlPath);
    try {
      const classification = classify(database);
      assert.equal(classification.conflicts.length, 0);
      assert.equal(classification.kind, "coach_loop");
      assert.equal(classification.sourceStatus, "ended");
      assert.equal(classification.runState, "paused", "an ended programme must never be mapped to active");
      assert.ok(classification.notes.some(note => /all-rest/.test(note)));
      const state = stateOf(classification);
      assert.deepEqual(state.weekPlan, [], "the `end` command's rest rows are discarded as intent");
      assert.equal(state.lockedSession, null);
      assert.deepEqual(resolveTrainingMode({ raceGoal: classification.raceGoal, businessDate: BUSINESS_DATE }).mode, "coach");

      const result = applyClassification(database, classification);
      assert.equal(result.status, "applied");
      const row = new TrainingPlanStore(database).read(classification.scope);
      assert.equal(row?.state.runState, "paused");
      assert.equal(row?.state.sourceStatus, "ended");
      assert.deepEqual(row?.state.weekPlan, []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting legacy sources are reported as conflicts and refused without writing", () => {
  const root = tempRoot();
  try {
    const legacyPlan = {
      id: "run-coach-1", goal: "finish", raceDate: "2026-12-01", raceDistanceKm: 10,
      targetTimeSeconds: null, runningDays: [1, 3, 5], longRunDays: [5], targetType: "pace",
      strengthTraining: false, durationWeeks: 12, startedOn: "2026-10-01",
      status: "active", pausedOn: null, endedOn: null, adaptationKey: null, adaptedAt: null
    };
    const controlPath = createFixture(root, {
      goals: goalsPayload({ runCoach: legacyPlan }),
      receipt: receiptPayload(racePreparationSettings("2026-11-01"))
    });
    const database = new DatabaseSync(controlPath);
    try {
      const classification = classify(database);
      const codes = classification.conflicts.map(conflict => conflict.code);
      assert.ok(codes.includes("source_disagreement"),
        `an active legacy programme plus an active coach loop must be a conflict, got ${JSON.stringify(classification.conflicts)}`);
      assert.ok(codes.includes("race_goal_mismatch"), "the two sources declare different races");
      assert.equal(classification.applyAllowed, false);
      assert.equal(classification.state, null, "no state is built from conflicting sources");
      assert.equal(classification.sourceDigest.length, 64);
      assert.equal(counts(database).state, 0);

      const result = runCli(controlPath, ["--apply", "--expect-source-digest", classification.sourceDigest]);
      assert.equal(result.status, 1, result.stderr);
      const report = parseCliJson(result);
      assert.equal(report.ok, false);
      assert.equal((report.error as { code: string }).code, "migration_conflicts");
      assert.equal(counts(database).state, 0, "the refused apply wrote nothing");
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI: dry-run writes nothing, apply is digest-gated and idempotent
// ---------------------------------------------------------------------------

test("CLI dry-run writes nothing and delegates the derived mode to training-mode-policy", () => {
  const root = tempRoot();
  try {
    const controlPath = createFixture(root, {
      goals: goalsPayload({ raceTarget: { date: "2026-11-01", distance: "ten_k", targetPaceSecondsPerKm: 300 } }),
      receipt: receiptPayload(dailyAdaptiveSettings())
    });
    const before = new DatabaseSync(controlPath, { readOnly: true });
    let beforeCounts: Counts;
    let beforeGoals: string;
    let beforeVersions: number[];
    try {
      beforeCounts = counts(before);
      beforeGoals = goalsPayloadText(before);
      beforeVersions = controlSchemaVersions(before);
    } finally {
      before.close();
    }

    const result = runCli(controlPath);
    assert.equal(result.status, 0, result.stderr);
    const report = parseCliJson(result);
    assert.equal(report.mode, "dry-run");
    assert.equal(report.ok, true);
    assert.equal(report.source, "coach_loop");
    assert.equal(report.sourceStatus, "active");
    assert.equal(report.runState, "active");
    assert.equal(report.applyAllowed, true);
    assert.deepEqual(report.conflicts, []);
    assert.match(String(report.sourceDigest), /^[0-9a-f]{64}$/);
    assert.deepEqual(report.derivedMode, { mode: "race", reason: "race_goal_upcoming", daysToRace: 12 },
      "the CLI reports the mode from the pure policy module, not a second implementation");

    const after = new DatabaseSync(controlPath);
    try {
      assert.deepEqual(counts(after), beforeCounts, "dry-run writes no state/history/audit/goal/receipt row");
      assert.equal(goalsPayloadText(after), beforeGoals, "the legacy goals payload is byte-identical after a dry run");
      assert.deepEqual(controlSchemaVersions(after), beforeVersions);
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI apply requires the dry-run digest, writes once, replays idempotently and rejects a mismatch", () => {
  const root = tempRoot();
  try {
    const controlPath = createFixture(root, {
      goals: goalsPayload({ weekPlan: [EASY_DAY] }),
      goalsRevision: 4,
      receipt: receiptPayload(dailyAdaptiveSettings())
    });
    const readOnly = new DatabaseSync(controlPath, { readOnly: true });
    let legacyGoalsBefore: string;
    try {
      legacyGoalsBefore = goalsPayloadText(readOnly);
    } finally {
      readOnly.close();
    }

    const dry = runCli(controlPath);
    assert.equal(dry.status, 0, dry.stderr);
    const dryReport = parseCliJson(dry);
    const sourceDigest = String(dryReport.sourceDigest);
    assert.match(sourceDigest, /^[0-9a-f]{64}$/);

    const wrong = runCli(controlPath, ["--apply", "--expect-source-digest", digest({ contract: "wrong" })]);
    assert.equal(wrong.status, 1, "a digest mismatch is refused");
    assert.equal((parseCliJson(wrong).error as { code: string }).code, "source_digest_mismatch");
    const beforeApply = new DatabaseSync(controlPath);
    try {
      assert.equal(counts(beforeApply).state, 0, "a refused apply writes no state");
    } finally {
      beforeApply.close();
    }

    const applied = runCli(controlPath, ["--apply", "--expect-source-digest", sourceDigest]);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedReport = parseCliJson(applied);
    assert.equal(appliedReport.ok, true);
    const appliedInfo = appliedReport.applied as { status: string; revision: number; readBackRevision: number };
    assert.equal(appliedInfo.status, "applied");
    assert.equal(appliedInfo.revision, 1);
    assert.equal(appliedInfo.readBackRevision, 1, "the CLI reads the committed state back through the store");

    const afterApply = new DatabaseSync(controlPath);
    let appliedCounts: Counts;
    try {
      appliedCounts = counts(afterApply);
      assert.equal(appliedCounts.state, 1);
      assert.equal(appliedCounts.history, 1);
      assert.equal(appliedCounts.audit, 1);
      assert.equal(goalsPayloadText(afterApply), legacyGoalsBefore, "apply never rewrites the legacy goals row");
    } finally {
      afterApply.close();
    }

    const replay = runCli(controlPath, ["--apply", "--expect-source-digest", sourceDigest]);
    assert.equal(replay.status, 0, replay.stderr);
    const replayReport = parseCliJson(replay);
    assert.equal((replayReport.applied as { status: string }).status, "replayed");
    const afterReplay = new DatabaseSync(controlPath);
    try {
      assert.deepEqual(counts(afterReplay), appliedCounts, "a replay adds no row");
    } finally {
      afterReplay.close();
    }

    const secondDry = runCli(controlPath);
    assert.equal(secondDry.status, 0, secondDry.stderr);
    const secondReport = parseCliJson(secondDry);
    assert.equal(secondReport.source, "new");
    assert.equal(secondReport.applyAllowed, true);
    assert.equal(secondReport.sourceDigest, sourceDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("store refuses a schema-less database instead of creating tables implicitly", () => {
  const root = tempRoot();
  try {
    const controlPath = join(root, "empty-control.sqlite");
    const database = new DatabaseSync(controlPath);
    try {
      assert.throws(() => new TrainingPlanStore(database),
        (error: unknown) => error instanceof TrainingPlanStateError && /migration 2/.test(error.message));
      // Explicit schema creation is the supported path (the API migration or the
      // operator CLI call it; the store itself never DDLs behind the caller's back).
      ensureTrainingPlanSchema(database);
      const store = new TrainingPlanStore(database);
      assert.equal(store.read(trainingPlanScopeKey(IDENTITY)), null);
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
