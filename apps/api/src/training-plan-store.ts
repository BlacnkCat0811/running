import { DatabaseSync } from "node:sqlite";

import { MOBILE_SESSION_KINDS } from "@rai/contracts";
import type {
  CoachLoopSettings,
  MobileLockedSession,
  MobilePlanOperationScope,
  MobilePlannedDay,
  MobileRaceDistance,
  MobileRaceTarget,
  MobileRunCoachPlan,
  MobileSessionKind
} from "@rai/api-contracts";

import { isValidLocalDate } from "./local-date.js";
import { digest } from "./plan-digest.js";
import { normalizeRunCoachPlan } from "./run-coach-policy.js";
import { normalizeSessionStructure } from "./session-structure.js";
import { validateRaceGoal, type RaceGoal, type RunState } from "./training-mode-policy.js";

/**
 * PR3 first slice: the unified control-database training state and its migration.
 *
 * This module owns three things and deliberately nothing else:
 *
 * 1. the versioned schema of `mobile_training_state`, its append-only history and
 *    the migration audit (`ensureTrainingPlanSchema`, applied as control-schema
 *    migration 2 from `mobile-goals.ts`);
 * 2. a compare-and-swap store over an already-open control `DatabaseSync`
 *    ({@link TrainingPlanStore}), so a migration can never overwrite a newer
 *    revision or a different migration result;
 * 3. the read side of the *data* migration: {@link readTrainingPlanMigrationSources}
 *    and {@link classifyTrainingPlanMigration} turn the existing `mobile_goals`
 *    row + latest `mobile_coach_loop_receipts` row into one
 *    {@link TrainingPlanState} — or into an explicit conflict list.
 *
 * The mode itself is **not** stored. `training-mode-policy.ts` derives it from
 * `raceGoal` + the business date, so a stored copy could drift from the goal it
 * was derived from; this state keeps only the inputs (race goal, run state).
 *
 * Not in this slice: no HTTP route, no command reducer, no coordination with the
 * live server, no rewriting of the legacy rows. The migration is add-only: the
 * `mobile_goals` row and every coach-loop receipt stay byte-identical and readable.
 */

// ---------------------------------------------------------------------------
// Versions and scope identity
// ---------------------------------------------------------------------------

/** Wire format of `mobile_training_state.payload_json`. Unknown values fail closed. */
export const TRAINING_PLAN_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Derivation version of the **data** migration (not the control-schema version).
 *
 * It is the `migration_version` component of the audit key
 * `(scope, migration_version)`: bump it when the derivation below changes meaning,
 * never to re-run the same derivation on the same scope. Existing audit rows are
 * never rewritten or deleted.
 */
export const TRAINING_PLAN_MIGRATION_VERSION = 1 as const;

/** Domain separator of the source digest; changing it invalidates every dry run. */
const TRAINING_PLAN_SOURCE_DIGEST_CONTRACT = "rai-training-plan-migration-source-v1";

/**
 * The one canonical scope key of the unified state: `JSON.stringify([serverId,
 * athleteId, datasetEpoch])`.
 *
 * An array is used on purpose. Object serialization depends on property insertion
 * order, so two call sites can spell the same identity differently; an array has a
 * fixed positional meaning. `mobile_coach_loop_receipts` predates this and was
 * written with the object spelling — it keeps that key untouched (rows are
 * append-only), and the migration reads it through
 * {@link legacyCoachLoopReceiptScopeKey}. Only new `mobile_training_state` /
 * audit rows use the canonical array key.
 */
export function trainingPlanScopeKey(scope: MobilePlanOperationScope): string {
  return JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
}

/** Throws unless `value` is the canonical array scope key; never guesses a form. */
export function parseTrainingPlanScopeKey(value: string): MobilePlanOperationScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TrainingPlanStateError("scope must be a JSON-encoded [serverId, athleteId, datasetEpoch] array");
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) {
    throw new TrainingPlanStateError("scope must encode exactly [serverId, athleteId, datasetEpoch]");
  }
  const parts = parsed as unknown[];
  const [serverId, athleteId, datasetEpoch] = parts;
  if (typeof serverId !== "string" || serverId.length === 0 ||
      typeof athleteId !== "string" || athleteId.length === 0 ||
      typeof datasetEpoch !== "string" || datasetEpoch.length === 0) {
    throw new TrainingPlanStateError("scope entries must be non-empty strings");
  }
  return { serverId, athleteId, datasetEpoch };
}

/**
 * Scope spelling already persisted in `mobile_coach_loop_receipts`.
 *
 * Read-only compatibility: the migration looks receipts up under both spellings.
 * Nothing writes new rows under this key.
 */
export function legacyCoachLoopReceiptScopeKey(scope: MobilePlanOperationScope): string {
  return JSON.stringify({ serverId: scope.serverId, athleteId: scope.athleteId, datasetEpoch: scope.datasetEpoch });
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type TrainingPlanSource = "legacy_goals" | "run_coach" | "coach_loop";
/** `new` is a classification result for an already-migrated scope, never a stored source. */
export type TrainingPlanSourceKind = TrainingPlanSource | "new";
export type TrainingPlanSourceStatus = "active" | "paused" | "ended" | "none";

/** Identity of the coach-loop receipt the state was derived from. */
export interface TrainingPlanCoachLoopRef {
  operationId: string;
  policyHash: string | null;
  evaluatedAt: string | null;
}

/**
 * The unified training state for one scope.
 *
 * `runState` is the only execution-permission field. A paused or ended programme
 * is always `paused` here: `ended` cannot be represented as active even by a
 * hand-edited payload, which is what makes "ending the loop releases the managed
 * semantics" a storage invariant rather than a caller promise.
 */
export interface TrainingPlanState {
  schemaVersion: typeof TRAINING_PLAN_STATE_SCHEMA_VERSION;
  migrationVersion: number;
  source: TrainingPlanSource;
  sourceStatus: TrainingPlanSourceStatus;
  /** Digest of the legacy source snapshot this state was derived from. */
  sourceDigest: string;
  runState: RunState;
  raceGoal: RaceGoal | null;
  /** Admission prerequisite hint, not a mode switch (see training-mode-policy.ts). */
  preferencesComplete: boolean;
  /** Public `mobile_goals.raceTarget` exactly as stored (F04 preservation half). */
  legacyRaceTarget: MobileRaceTarget | null;
  /** Stored weekly intent; empty when an ended loop left an all-rest window. */
  weekPlan: MobilePlannedDay[];
  lockedSession: MobileLockedSession | null;
  /** Migrated configuration/preferences evidence. Its lifecycle is never an execution authority. */
  runCoach: MobileRunCoachPlan | null;
  coachLoop: TrainingPlanCoachLoopRef | null;
  goalsRevision: number | null;
  /** PR4-2: config identity the published plan was generated for (null = legacy). */
  planContextDigest: string | null;
  migratedAt: string;
}

export interface TrainingPlanStateRow {
  scope: string;
  revision: number;
  state: TrainingPlanState;
  updatedAt: string;
}

export class TrainingPlanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrainingPlanStateError";
  }
}

/** A CAS write found a different current revision (concurrent command/migration). */
export class TrainingPlanStateConflictError extends TrainingPlanStateError {
  constructor(readonly currentRevision: number | null) {
    super(currentRevision === null
      ? "training plan state scope has no row"
      : `training plan state revision conflict: current is ${currentRevision}`);
    this.name = "TrainingPlanStateConflictError";
  }
}

// ---------------------------------------------------------------------------
// Schema (control-schema migration 2)
// ---------------------------------------------------------------------------

/**
 * Creates the three unified-state tables. Every statement is `IF NOT EXISTS`, so
 * it is safe both as the recorded schema migration and as the operator CLI's
 * pre-flight on a control database whose API process has not restarted yet.
 */
export function ensureTrainingPlanSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mobile_training_state (
      scope TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 0),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mobile_training_state_history (
      scope TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      changed_at TEXT NOT NULL,
      PRIMARY KEY (scope, revision)
    );
    CREATE TABLE IF NOT EXISTS mobile_training_migration_audit (
      scope TEXT NOT NULL,
      migration_version INTEGER NOT NULL,
      source_digest TEXT NOT NULL,
      result_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope, migration_version)
    );
  `);
}

function tableExists(database: DatabaseSync, name: string): boolean {
  const row = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined;
}

function assertTrainingPlanTables(database: DatabaseSync): void {
  for (const name of ["mobile_training_state", "mobile_training_state_history", "mobile_training_migration_audit"]) {
    if (!tableExists(database, name)) {
      throw new TrainingPlanStateError(`control database is missing ${name}; apply control-schema migration 2 first`);
    }
  }
}

// ---------------------------------------------------------------------------
// Guarded parsing (unknown JSON -> typed state, no unvalidated casts)
// ---------------------------------------------------------------------------

const SESSION_KINDS: ReadonlySet<string> = new Set(MOBILE_SESSION_KINDS);
const RACE_DISTANCE_KM: Readonly<Record<MobileRaceDistance, number>> = {
  five_k: 5,
  ten_k: 10,
  half_marathon: 21.0975
};
const SOURCE_VALUES: ReadonlySet<string> = new Set<TrainingPlanSource>(["legacy_goals", "run_coach", "coach_loop"]);
const SOURCE_STATUS_VALUES: ReadonlySet<string> = new Set<TrainingPlanSourceStatus>(["active", "paused", "ended", "none"]);
const SHA256_HEX = /^[0-9a-f]{64}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isParseableInstant = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));

function isRaceDistance(value: unknown): value is MobileRaceDistance {
  return value === "five_k" || value === "ten_k" || value === "half_marathon";
}

interface Collected<T> {
  value: T | null;
  problems: string[];
}

function collectRaceGoal(value: unknown, path: string): Collected<RaceGoal> {
  if (value === null) return { value: null, problems: [] };
  if (!isRecord(value)) return { value: null, problems: [`${path} must be an object or null`] };
  const problems: string[] = [];
  const id = value.id;
  if (!isNonEmptyString(id)) problems.push(`${path}.id must be a non-empty string`);
  const date = value.date;
  const distanceKm = value.distanceKm;
  const goal = value.goal;
  const targetTimeSeconds = value.targetTimeSeconds;
  if (typeof date !== "string") problems.push(`${path}.date must be a string`);
  if (typeof distanceKm !== "number") problems.push(`${path}.distanceKm must be a number`);
  if (goal !== "finish" && goal !== "time") problems.push(`${path}.goal must be "finish" or "time"`);
  if (targetTimeSeconds !== null && typeof targetTimeSeconds !== "number") {
    problems.push(`${path}.targetTimeSeconds must be a number or null`);
  }
  if (problems.length > 0) return { value: null, problems };
  const validation = validateRaceGoal({
    date: date as string,
    distanceKm: distanceKm as number,
    goal: goal as "finish" | "time",
    targetTimeSeconds: (targetTimeSeconds ?? null) as number | null
  });
  if (validation.status !== "valid") return { value: null, problems: [`${path}: ${validation.reasons.join(", ")}`] };
  return {
    value: { id: id as string, ...validation.goal },
    problems: []
  };
}

function collectRaceTarget(value: unknown, path: string): Collected<MobileRaceTarget> {
  if (value === null || value === undefined) return { value: null, problems: [] };
  if (!isRecord(value)) return { value: null, problems: [`${path} must be an object or null`] };
  const problems: string[] = [];
  if (typeof value.date !== "string" || !isValidLocalDate(value.date)) problems.push(`${path}.date must be a real YYYY-MM-DD date`);
  if (!isRaceDistance(value.distance)) problems.push(`${path}.distance must be five_k, ten_k or half_marathon`);
  const pace = value.targetPaceSecondsPerKm;
  if (pace !== null && pace !== undefined && (typeof pace !== "number" || !Number.isFinite(pace) || pace <= 0)) {
    problems.push(`${path}.targetPaceSecondsPerKm must be a positive number or null`);
  }
  if (problems.length > 0) return { value: null, problems };
  return {
    value: {
      date: value.date as string,
      distance: value.distance as MobileRaceDistance,
      targetPaceSecondsPerKm: typeof pace === "number" ? pace : null
    },
    problems: []
  };
}

function collectWeekPlan(value: unknown, path: string): Collected<MobilePlannedDay[]> {
  if (value === null || value === undefined) return { value: [], problems: [] };
  if (!Array.isArray(value)) return { value: null, problems: [`${path} must be an array`] };
  const days: MobilePlannedDay[] = [];
  const problems: string[] = [];
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(entry)) { problems.push(`${itemPath} must be an object`); return; }
    if (typeof entry.localDate !== "string" || !isValidLocalDate(entry.localDate)) {
      problems.push(`${itemPath}.localDate must be a real YYYY-MM-DD date`); return;
    }
    if (typeof entry.kind !== "string" || !SESSION_KINDS.has(entry.kind)) {
      problems.push(`${itemPath}.kind is not a supported session kind`); return;
    }
    const distanceKm = entry.distanceKm;
    if (distanceKm !== null && distanceKm !== undefined &&
        (typeof distanceKm !== "number" || !Number.isFinite(distanceKm))) {
      problems.push(`${itemPath}.distanceKm must be a finite number or null`); return;
    }
    const rawStructure = entry.structure;
    const structure = rawStructure == null ? null : normalizeSessionStructure(rawStructure);
    if (rawStructure != null && structure === null) {
      problems.push(`${itemPath}.structure is not a valid session structure`); return;
    }
    const reason = entry.reason;
    if (reason !== null && reason !== undefined && typeof reason !== "string") {
      problems.push(`${itemPath}.reason must be a string or null`); return;
    }
    const day: MobilePlannedDay = {
      localDate: entry.localDate,
      kind: entry.kind as MobileSessionKind,
      distanceKm: typeof distanceKm === "number" ? distanceKm : null,
      structure
    };
    if (typeof reason === "string") day.reason = reason;
    days.push(day);
  });
  return problems.length > 0 ? { value: null, problems } : { value: days, problems: [] };
}

/**
 * Locked-session rows are carried over for the future coordinator, not re-derived
 * here. The shallow checks below only prove the row addresses a date and holds an
 * object where the contract expects one; the nested `MobileNextSession` stays the
 * stored payload (a migration has no authority to re-measure it).
 */
function collectLockedSession(value: unknown, path: string): Collected<MobileLockedSession> {
  if (value === null || value === undefined) return { value: null, problems: [] };
  if (!isRecord(value)) return { value: null, problems: [`${path} must be an object or null`] };
  const problems: string[] = [];
  if (typeof value.localDate !== "string" || !isValidLocalDate(value.localDate)) problems.push(`${path}.localDate must be a real YYYY-MM-DD date`);
  if (!isRecord(value.session)) problems.push(`${path}.session must be an object`);
  if (typeof value.verdictTone !== "string") problems.push(`${path}.verdictTone must be a string`);
  if (!isParseableInstant(value.lockedAt)) problems.push(`${path}.lockedAt must be a parseable instant`);
  if (problems.length > 0) return { value: null, problems };
  return { value: value as unknown as MobileLockedSession, problems: [] };
}

function collectRunCoachPlan(value: unknown, path: string): Collected<MobileRunCoachPlan> {
  if (value === null || value === undefined) return { value: null, problems: [] };
  const plan = normalizeRunCoachPlan(value);
  return plan === null
    ? { value: null, problems: [`${path} is not a valid run-coach plan`] }
    : { value: plan, problems: [] };
}

function collectCoachLoopRef(value: unknown, path: string): Collected<TrainingPlanCoachLoopRef> {
  if (value === null || value === undefined) return { value: null, problems: [] };
  if (!isRecord(value)) return { value: null, problems: [`${path} must be an object or null`] };
  const problems: string[] = [];
  if (!isNonEmptyString(value.operationId)) problems.push(`${path}.operationId must be a non-empty string`);
  if (value.policyHash !== null && value.policyHash !== undefined && !isNonEmptyString(value.policyHash)) {
    problems.push(`${path}.policyHash must be a non-empty string or null`);
  }
  if (value.evaluatedAt !== null && value.evaluatedAt !== undefined && !isParseableInstant(value.evaluatedAt)) {
    problems.push(`${path}.evaluatedAt must be a parseable instant or null`);
  }
  if (problems.length > 0) return { value: null, problems };
  return {
    value: {
      operationId: value.operationId as string,
      policyHash: isNonEmptyString(value.policyHash) ? value.policyHash : null,
      evaluatedAt: isParseableInstant(value.evaluatedAt) ? value.evaluatedAt : null
    },
    problems: []
  };
}

/**
 * Runtime validation of one stored state payload. Any unknown `schemaVersion`,
 * unknown source, malformed race goal or ended-but-active combination throws
 * instead of being coerced into a plausible plan.
 */
export function parseTrainingPlanState(value: unknown): TrainingPlanState {
  if (!isRecord(value)) throw new TrainingPlanStateError("training plan state must be a JSON object");
  if (value.schemaVersion !== TRAINING_PLAN_STATE_SCHEMA_VERSION) {
    throw new TrainingPlanStateError(
      `unknown training plan state schemaVersion ${JSON.stringify(value.schemaVersion)}; expected ${TRAINING_PLAN_STATE_SCHEMA_VERSION}`);
  }
  const problems: string[] = [];
  const migrationVersion = value.migrationVersion;
  if (typeof migrationVersion !== "number" || !Number.isInteger(migrationVersion) || migrationVersion < 1) {
    problems.push("migrationVersion must be a positive integer");
  }
  const source = value.source;
  if (typeof source !== "string" || !SOURCE_VALUES.has(source)) problems.push("source must be legacy_goals, run_coach or coach_loop");
  const sourceStatus = value.sourceStatus;
  if (typeof sourceStatus !== "string" || !SOURCE_STATUS_VALUES.has(sourceStatus)) {
    problems.push("sourceStatus must be active, paused, ended or none");
  }
  const sourceDigest = value.sourceDigest;
  if (typeof sourceDigest !== "string" || !SHA256_HEX.test(sourceDigest)) {
    problems.push("sourceDigest must be a hex sha256 digest");
  }
  const runState = value.runState;
  if (runState !== "active" && runState !== "paused") problems.push("runState must be active or paused");
  if (typeof value.preferencesComplete !== "boolean") problems.push("preferencesComplete must be a boolean");
  const goalsRevision = value.goalsRevision;
  if (goalsRevision !== null && (typeof goalsRevision !== "number" || !Number.isInteger(goalsRevision) || goalsRevision < 0)) {
    problems.push("goalsRevision must be a non-negative integer or null");
  }
  // Additive in PR4-2: payloads written before it (or by the migration) carry no
  // value, which means "the published plan predates the context digest". A present
  // value must be a real sha256, not an empty string that would compare unequal by
  // accident and report every plan as stale.
  const planContextDigest = value.planContextDigest ?? null;
  if (planContextDigest !== null && (typeof planContextDigest !== "string" || !SHA256_HEX.test(planContextDigest))) {
    problems.push("planContextDigest must be a hex sha256 digest or null");
  }
  if (!isParseableInstant(value.migratedAt)) problems.push("migratedAt must be a parseable instant");

  const raceGoal = collectRaceGoal(value.raceGoal ?? null, "raceGoal");
  const legacyRaceTarget = collectRaceTarget(value.legacyRaceTarget ?? null, "legacyRaceTarget");
  const weekPlan = collectWeekPlan(value.weekPlan ?? [], "weekPlan");
  const lockedSession = collectLockedSession(value.lockedSession ?? null, "lockedSession");
  const runCoach = collectRunCoachPlan(value.runCoach ?? null, "runCoach");
  const coachLoop = collectCoachLoopRef(value.coachLoop ?? null, "coachLoop");
  problems.push(...raceGoal.problems, ...legacyRaceTarget.problems, ...weekPlan.problems,
    ...lockedSession.problems, ...runCoach.problems, ...coachLoop.problems);

  // `sourceStatus` records the legacy source as it was when the migration ran;
  // `runState` is the user's CURRENT run willingness (PR4-2 commands change it).
  // They are different dimensions, so only the one irreducible safety rule stays:
  // an ENDED programme can never be reported as active. A migrated active/none
  // source may legitimately be paused afterwards, and an ended one cannot be
  // resumed back into the ended programme (it needs a new configuration).
  if (sourceStatus === "ended" && runState !== "paused") {
    problems.push("an ended source must have runState paused");
  }

  if (problems.length > 0) throw new TrainingPlanStateError(problems.join("; "));
  return {
    schemaVersion: TRAINING_PLAN_STATE_SCHEMA_VERSION,
    migrationVersion: migrationVersion as number,
    source: source as TrainingPlanSource,
    sourceStatus: sourceStatus as TrainingPlanSourceStatus,
    sourceDigest: sourceDigest as string,
    runState: runState as RunState,
    raceGoal: raceGoal.value,
    preferencesComplete: value.preferencesComplete as boolean,
    legacyRaceTarget: legacyRaceTarget.value,
    weekPlan: weekPlan.value ?? [],
    lockedSession: lockedSession.value,
    runCoach: runCoach.value,
    coachLoop: coachLoop.value,
    goalsRevision: (goalsRevision ?? null) as number | null,
    planContextDigest: planContextDigest as string | null,
    migratedAt: value.migratedAt as string
  };
}

// ---------------------------------------------------------------------------
// Store and CAS
// ---------------------------------------------------------------------------

export type TrainingPlanMigrationConflictReason = "digest_mismatch" | "already_migrated" | "revision_conflict";

export type TrainingPlanMigrationResult =
  | { status: "applied"; revision: number; state: TrainingPlanState; updatedAt: string }
  | { status: "replayed"; revision: number; state: TrainingPlanState; updatedAt: string }
  | {
      status: "conflict";
      reason: TrainingPlanMigrationConflictReason;
      currentRevision: number | null;
      currentSourceDigest: string | null;
    };

export interface TrainingPlanMigrationInput {
  /** Canonical array scope key. */
  scope: string;
  /** `null`/`0` means "this scope has no state yet"; a positive number is the revision read before the call. */
  expectedAbsentOrRevision: number | null;
  sourceDigest: string;
  state: TrainingPlanState;
}

interface RawStateRow {
  revision: number;
  payload_json: string;
  updated_at: string;
}

interface RawAuditRow {
  migration_version: number;
  source_digest: string;
  result_digest: string;
  status: string;
  payload_json: string;
  created_at: string;
}

export function readTrainingPlanStateRow(database: DatabaseSync, scope: string): TrainingPlanStateRow | null {
  const row = database.prepare(
    "SELECT revision, payload_json, updated_at FROM mobile_training_state WHERE scope = ?").get(scope) as
    RawStateRow | undefined;
  if (row === undefined) return null;
  const revision = Number(row.revision);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new TrainingPlanStateError("stored training plan revision is not a non-negative integer");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch (error) {
    throw new TrainingPlanStateError(`stored training plan payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { scope, revision, state: parseTrainingPlanState(parsed), updatedAt: row.updated_at };
}

/**
 * Compare-and-swap store over an already-open control database.
 *
 * The caller owns schema creation (`ensureTrainingPlanSchema`) and the database
 * connection. Every write is one `BEGIN IMMEDIATE` transaction that touches the
 * state row, its history row and the migration audit together; a caller never
 * observes one without the others.
 */
export class TrainingPlanStore {
  constructor(private readonly database: DatabaseSync) {
    assertTrainingPlanTables(database);
  }

  /** The unified state for `scope`, or `null` when the scope has not been migrated. */
  read(scope: string): TrainingPlanStateRow | null {
    const parsedScope = parseTrainingPlanScopeKey(scope);
    return readTrainingPlanStateRow(this.database, trainingPlanScopeKey(parsedScope));
  }

  /**
   * Applies the migration result for one scope with a real CAS.
   *
   * Semantics:
   * - same `(scope, sourceDigest, migration_version)` already audited ⇒ `replayed`,
   *   no row is written (an idempotent retry);
   * - an audited `(scope, migration_version)` with a different digest ⇒
   *   `digest_mismatch`, the stored result is never overwritten;
   * - an existing row whose `migrationVersion` is the same or newer ⇒
   *   `already_migrated` / `digest_mismatch`;
   * - otherwise the caller's `expectedAbsentOrRevision` must still match the
   *   current revision, and the `UPDATE ... WHERE revision = ?` must report one
   *   changed row — otherwise `revision_conflict`.
   */
  applyMigration(input: TrainingPlanMigrationInput): TrainingPlanMigrationResult {
    const parsedScope = parseTrainingPlanScopeKey(input.scope);
    const scope = trainingPlanScopeKey(parsedScope);
    if (!isNonEmptyString(input.sourceDigest) || !SHA256_HEX.test(input.sourceDigest)) {
      throw new TrainingPlanStateError("sourceDigest must be a hex sha256 digest");
    }
    const expected = input.expectedAbsentOrRevision;
    if (expected !== null && (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0)) {
      throw new TrainingPlanStateError("expectedAbsentOrRevision must be null or a non-negative integer");
    }
    const state = parseTrainingPlanState(input.state);
    if (state.sourceDigest !== input.sourceDigest) {
      throw new TrainingPlanStateError("state.sourceDigest must equal the migration sourceDigest");
    }
    const migrationVersion = state.migrationVersion;
    const updatedAt = state.migratedAt;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = readTrainingPlanStateRow(this.database, scope);
      const audit = this.database.prepare(
        `SELECT migration_version, source_digest, result_digest, status, payload_json, created_at
         FROM mobile_training_migration_audit WHERE scope = ? AND migration_version = ?`).get(scope, migrationVersion) as
        RawAuditRow | undefined;

      if (audit !== undefined) {
        if (audit.source_digest === input.sourceDigest) {
          if (current === null) {
            throw new TrainingPlanStateError("migration audit exists without a training state row");
          }
          const replayed = parseAuditPayload(audit.payload_json);
          this.database.exec("ROLLBACK");
          return { status: "replayed", revision: replayed.revision, state: replayed.state, updatedAt: replayed.state.migratedAt };
        }
        this.database.exec("ROLLBACK");
        return {
          status: "conflict",
          reason: "digest_mismatch",
          currentRevision: current?.revision ?? null,
          currentSourceDigest: audit.source_digest
        };
      }

      if (current !== null) {
        if (migrationVersion <= current.state.migrationVersion) {
          this.database.exec("ROLLBACK");
          return {
            status: "conflict",
            reason: current.state.sourceDigest === input.sourceDigest ? "already_migrated" : "digest_mismatch",
            currentRevision: current.revision,
            currentSourceDigest: current.state.sourceDigest
          };
        }
        if (expected === null || expected === 0) {
          this.database.exec("ROLLBACK");
          return { status: "conflict", reason: "already_migrated", currentRevision: current.revision,
            currentSourceDigest: current.state.sourceDigest };
        }
        if (expected !== current.revision) {
          this.database.exec("ROLLBACK");
          return { status: "conflict", reason: "revision_conflict", currentRevision: current.revision,
            currentSourceDigest: current.state.sourceDigest };
        }
        const revision = current.revision + 1;
        const updated = this.database.prepare(
          "UPDATE mobile_training_state SET revision = ?, payload_json = ?, updated_at = ? WHERE scope = ? AND revision = ?")
          .run(revision, JSON.stringify(state), updatedAt, scope, current.revision);
        if (Number(updated.changes) !== 1) {
          this.database.exec("ROLLBACK");
          const latest = readTrainingPlanStateRow(this.database, scope);
          return { status: "conflict", reason: "revision_conflict", currentRevision: latest?.revision ?? null,
            currentSourceDigest: latest?.state.sourceDigest ?? null };
        }
        this.insertHistory(scope, revision, "migration_applied", state, updatedAt);
        this.insertAudit(scope, migrationVersion, input.sourceDigest, state, revision, updatedAt);
        this.database.exec("COMMIT");
        return { status: "applied", revision, state, updatedAt };
      }

      if (expected !== null && expected !== 0) {
        this.database.exec("ROLLBACK");
        return { status: "conflict", reason: "revision_conflict", currentRevision: null, currentSourceDigest: null };
      }
      const revision = 1;
      this.database.prepare(
        "INSERT INTO mobile_training_state(scope, revision, payload_json, updated_at) VALUES (?, ?, ?, ?)")
        .run(scope, revision, JSON.stringify(state), updatedAt);
      this.insertHistory(scope, revision, "migration_created", state, updatedAt);
      this.insertAudit(scope, migrationVersion, input.sourceDigest, state, revision, updatedAt);
      this.database.exec("COMMIT");
      return { status: "applied", revision, state, updatedAt };
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* the original error wins */ }
      throw error;
    }
  }

  /**
   * CAS write of a command-derived state (PR4-2).
   *
   * `inTransaction: true` joins the caller's `BEGIN IMMEDIATE` publication
   * transaction, so a configuration change and the legacy goals mirror commit (or
   * roll back) together. A plain call owns its transaction. The revision is
   * `expectedRevision + 1`; a missing row or a stale revision is a conflict, never
   * an overwrite.
   */
  commitState(input: {
    scope: string;
    expectedRevision: number;
    state: TrainingPlanState;
    eventType: string;
  }, options: { inTransaction?: boolean } = {}): { revision: number; updatedAt: string } {
    const scope = trainingPlanScopeKey(parseTrainingPlanScopeKey(input.scope));
    const state = parseTrainingPlanState(input.state);
    if (!isNonEmptyString(input.eventType)) throw new TrainingPlanStateError("eventType is required");
    if (typeof input.expectedRevision !== "number" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new TrainingPlanStateError("expectedRevision must be a non-negative integer");
    }
    const revision = input.expectedRevision + 1;
    const updatedAt = new Date().toISOString();
    const ownTransaction = options.inTransaction !== true;
    if (ownTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.database.prepare(
        "UPDATE mobile_training_state SET revision = ?, payload_json = ?, updated_at = ? WHERE scope = ? AND revision = ?")
        .run(revision, JSON.stringify(state), updatedAt, scope, input.expectedRevision);
      if (Number(updated.changes) !== 1) {
        const current = readTrainingPlanStateRow(this.database, scope);
        throw new TrainingPlanStateConflictError(current?.revision ?? null);
      }
      this.insertHistory(scope, revision, input.eventType, state, updatedAt);
      if (ownTransaction) this.database.exec("COMMIT");
      return { revision, updatedAt };
    } catch (error) {
      if (ownTransaction) { try { this.database.exec("ROLLBACK"); } catch { /* already rolled back */ } }
      throw error;
    }
  }

  private insertHistory(scope: string, revision: number, eventType: string, state: TrainingPlanState, changedAt: string): void {
    this.database.prepare(
      "INSERT INTO mobile_training_state_history(scope, revision, event_type, payload_json, changed_at) VALUES (?, ?, ?, ?, ?)")
      .run(scope, revision, eventType, JSON.stringify(state), changedAt);
  }

  private insertAudit(scope: string, migrationVersion: number, sourceDigest: string,
    state: TrainingPlanState, revision: number, createdAt: string): void {
    this.database.prepare(
      `INSERT INTO mobile_training_migration_audit(scope, migration_version, source_digest, result_digest, status, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(scope, migrationVersion, sourceDigest, digest(state), "applied",
        JSON.stringify({ revision, state }), createdAt);
  }
}

function parseAuditPayload(payloadJson: string): { revision: number; state: TrainingPlanState } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch (error) {
    throw new TrainingPlanStateError(`migration audit payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new TrainingPlanStateError("migration audit payload must be an object");
  const revision = parsed.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new TrainingPlanStateError("migration audit payload revision must be a positive integer");
  }
  return { revision, state: parseTrainingPlanState(parsed.state) };
}

// ---------------------------------------------------------------------------
// Reading the migration source (legacy goals + latest coach-loop receipt)
// ---------------------------------------------------------------------------

export interface TrainingPlanMigrationGoalsSource {
  revision: number;
  /** Raw parsed payload; validated by the classifier, never trusted here. */
  payload: unknown;
}

export interface TrainingPlanMigrationReceiptSource {
  operationId: string;
  payload: unknown;
}

export interface TrainingPlanMigrationSources {
  goals: TrainingPlanMigrationGoalsSource | null;
  coachLoopReceipt: TrainingPlanMigrationReceiptSource | null;
  existingState: TrainingPlanStateRow | null;
}

/**
 * Reads the rows the migration derives from. Missing tables (an old control
 * database that has not seen schema migration 2 yet) simply mean "no unified
 * state", never an error; the classifier decides what to do with the rest.
 */
export function readTrainingPlanMigrationSources(
  database: DatabaseSync,
  scope: MobilePlanOperationScope
): TrainingPlanMigrationSources {
  const canonicalScope = trainingPlanScopeKey(scope);
  let goals: TrainingPlanMigrationGoalsSource | null = null;
  if (tableExists(database, "mobile_goals")) {
    const row = database.prepare("SELECT revision, payload_json FROM mobile_goals WHERE singleton = 1").get() as
      { revision: number; payload_json: string } | undefined;
    if (row !== undefined) {
      goals = { revision: Number(row.revision), payload: parseJsonOrNull(row.payload_json) };
    }
  }
  let coachLoopReceipt: TrainingPlanMigrationReceiptSource | null = null;
  if (tableExists(database, "mobile_coach_loop_receipts")) {
    const row = database.prepare(
      `SELECT operation_id, payload_json FROM mobile_coach_loop_receipts
       WHERE scope = ? OR scope = ? ORDER BY sequence DESC LIMIT 1`)
      .get(canonicalScope, legacyCoachLoopReceiptScopeKey(scope)) as
      { operation_id: string; payload_json: string } | undefined;
    if (row !== undefined) {
      coachLoopReceipt = { operationId: row.operation_id, payload: parseJsonOrNull(row.payload_json) };
    }
  }
  const existingState = tableExists(database, "mobile_training_state")
    ? readTrainingPlanStateRow(database, canonicalScope)
    : null;
  return { goals, coachLoopReceipt, existingState };
}

function parseJsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Classification (plan §10.1/10.2: pick one source, surface disagreements)
// ---------------------------------------------------------------------------

export type TrainingPlanMigrationConflictCode =
  | "invalid_goals_payload"
  | "invalid_race_target"
  | "invalid_coach_loop_receipt"
  | "source_disagreement"
  | "race_goal_mismatch";

export interface TrainingPlanMigrationConflict {
  code: TrainingPlanMigrationConflictCode;
  detail: string;
}

export interface TrainingPlanMigrationClassification {
  scope: string;
  businessDate: string;
  /** `new` means the scope already has a unified state; `--apply` is a replay. */
  kind: TrainingPlanSourceKind;
  migrationVersion: number;
  sourceStatus: TrainingPlanSourceStatus;
  runState: RunState;
  raceGoal: RaceGoal | null;
  publicRaceTarget: MobileRaceTarget | null;
  coachLoop: TrainingPlanCoachLoopRef | null;
  goalsRevision: number | null;
  /** `null` when a conflict prevents building a state. */
  state: TrainingPlanState | null;
  sourceDigest: string;
  conflicts: TrainingPlanMigrationConflict[];
  notes: string[];
  existingRevision: number | null;
  applyAllowed: boolean;
}

interface GoalsFacts {
  revision: number | null;
  raceTarget: MobileRaceTarget | null;
  runCoach: MobileRunCoachPlan | null;
  weekPlan: MobilePlannedDay[];
  lockedSession: MobileLockedSession | null;
}

interface CoachLoopFacts {
  status: "active" | "paused" | "ended";
  /** Race goal of the loop's race mode, `null` for daily-adaptive. */
  raceGoal: RaceGoal | null;
  ref: TrainingPlanCoachLoopRef;
  /** Comparable preference/race shape, for "do the two engines agree?" checks. */
  comparable: unknown;
  preferencesComplete: boolean;
}

const COACH_DISTANCE_KM: Readonly<Record<string, number>> = { five_k: 5, ten_k: 10, half_marathon: 21.0975 };

function buildRaceGoalId(date: string, distanceKm: number): string {
  const body = digest({ contract: "rai-training-plan-race-goal-v1", date, distanceKm });
  return `migrated-${body.slice(0, 32)}`;
}

/**
 * Adapts a run-coach race configuration to a policy `RaceGoal`.
 *
 * `null` means "no race goal declared" (fitness / ended legacy programme), not an
 * error; structural problems are returned as strings so the CLI can print them.
 */
function raceGoalFromConfig(config: MobileRunCoachPlan | CoachLoopRaceConfig,
  path: string): Collected<RaceGoal> {
  const goal = config.goal;
  if (goal === "fitness") {
    if (config.raceDate !== null || config.raceDistanceKm !== null) {
      return { value: null, problems: [`${path} declares no race goal but carries race fields`] };
    }
    return { value: null, problems: [] };
  }
  if (config.raceDate === null || config.raceDistanceKm === null) {
    return { value: null, problems: [`${path} is a race goal without a date/distance`] };
  }
  const validation = validateRaceGoal({
    date: config.raceDate,
    distanceKm: config.raceDistanceKm,
    goal,
    targetTimeSeconds: config.targetTimeSeconds
  });
  if (validation.status !== "valid") {
    return { value: null, problems: [`${path}: ${validation.reasons.join(", ")}`] };
  }
  return {
    value: { id: buildRaceGoalId(validation.goal.date, validation.goal.distanceKm), ...validation.goal },
    problems: []
  };
}

interface CoachLoopRaceConfig {
  goal: "finish" | "time" | "fitness";
  raceDate: string | null;
  raceDistanceKm: number | null;
  targetTimeSeconds: number | null;
}

function readCoachLoopReceipt(payload: unknown, operationId: string): Collected<CoachLoopFacts> {
  const path = "coachLoopReceipt";
  if (!isRecord(payload)) return { value: null, problems: [`${path} payload must be an object`] };
  const settings = payload.settings;
  if (!isRecord(settings)) return { value: null, problems: [`${path}.settings must be an object`] };
  const problems: string[] = [];
  const mode = settings.mode;
  const status = settings.status;
  if (mode !== "daily_adaptive" && mode !== "race_preparation") problems.push(`${path}.settings.mode is not a known coach mode`);
  if (status !== "active" && status !== "paused" && status !== "ended") problems.push(`${path}.settings.status is not active, paused or ended`);
  const runningDays = settings.runningDays;
  if (!Array.isArray(runningDays) || runningDays.length === 0 ||
      !runningDays.every(day => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 7)) {
    problems.push(`${path}.settings.runningDays must be a non-empty ISO weekday list`);
  }
  const longRunDays = settings.longRunDays;
  if (!Array.isArray(longRunDays) || !longRunDays.every(day => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 7)) {
    problems.push(`${path}.settings.longRunDays must be an ISO weekday list`);
  } else if (Array.isArray(runningDays)) {
    for (const day of longRunDays) if (!runningDays.includes(day)) problems.push(`${path}.settings.longRunDays must be a subset of runningDays`);
  }
  if (settings.targetType !== "pace" && settings.targetType !== "heart_rate") {
    problems.push(`${path}.settings.targetType is not pace or heart_rate`);
  }
  let raceGoal: RaceGoal | null = null;
  if (mode === "daily_adaptive") {
    if (settings.race !== null && settings.race !== undefined) problems.push(`${path}.settings.race must be null in daily_adaptive mode`);
  } else if (!isRecord(settings.race)) {
    problems.push(`${path}.settings.race must be an object in race_preparation mode`);
  } else {
    const race = settings.race;
    const raceConfig: CoachLoopRaceConfig = {
      goal: race.goal === "finish" || race.goal === "time" ? race.goal : "fitness",
      raceDate: typeof race.raceDate === "string" ? race.raceDate : null,
      raceDistanceKm: typeof race.raceDistanceKm === "number" ? race.raceDistanceKm : null,
      targetTimeSeconds: typeof race.targetTimeSeconds === "number" ? race.targetTimeSeconds : null
    };
    if (race.goal === "fitness") problems.push(`${path}.settings.race.goal must be finish or time in race_preparation mode`);
    const collected = raceGoalFromConfig(raceConfig, `${path}.settings.race`);
    problems.push(...collected.problems);
    raceGoal = collected.value;
  }
  if (problems.length > 0) return { value: null, problems };
  const evaluatedAt = isParseableInstant(payload.evaluatedAt) ? payload.evaluatedAt : null;
  const preferredRunningDays = (runningDays as unknown[]).slice().sort((left, right) => Number(left) - Number(right));
  return {
    value: {
      status: status as "active" | "paused" | "ended",
      raceGoal,
      ref: {
        operationId,
        policyHash: isNonEmptyString(payload.policyHash) ? payload.policyHash : null,
        evaluatedAt
      },
      comparable: {
        goal: mode === "daily_adaptive" ? "fitness" : settings.race !== null && isRecord(settings.race) ? settings.race.goal : null,
        raceDate: raceGoal?.date ?? null,
        raceDistanceKm: raceGoal?.distanceKm ?? null,
        targetTimeSeconds: raceGoal?.targetTimeSeconds ?? null,
        runningDays: preferredRunningDays,
        longRunDays: Array.isArray(longRunDays) ? longRunDays.slice().sort((left, right) => Number(left) - Number(right)) : [],
        targetType: settings.targetType
      },
      preferencesComplete: true
    },
    problems: []
  };
}

function readLegacyGoals(payload: unknown, rowRevision: number): Collected<GoalsFacts> {
  const problems: string[] = [];
  if (!Number.isInteger(rowRevision) || rowRevision < 0) problems.push("mobile_goals.revision is not a non-negative integer");
  if (!isRecord(payload)) {
    problems.push("mobile_goals.payload_json must be a JSON object");
    return { value: null, problems };
  }
  let raceTarget: MobileRaceTarget | null = null;
  const collectedTarget = collectRaceTarget(payload.raceTarget ?? null, "mobile_goals.raceTarget");
  problems.push(...collectedTarget.problems);
  raceTarget = collectedTarget.value;
  const collectedRunCoach = collectRunCoachPlan(payload.runCoach ?? null, "mobile_goals.runCoach");
  problems.push(...collectedRunCoach.problems);
  const collectedWeekPlan = collectWeekPlan(payload.weekPlan ?? [], "mobile_goals.weekPlan");
  problems.push(...collectedWeekPlan.problems);
  const collectedLockedSession = collectLockedSession(payload.lockedSession ?? null, "mobile_goals.lockedSession");
  problems.push(...collectedLockedSession.problems);
  if (problems.length > 0) return { value: null, problems };
  return {
    value: {
      revision: rowRevision,
      raceTarget,
      runCoach: collectedRunCoach.value,
      weekPlan: collectedWeekPlan.value ?? [],
      lockedSession: collectedLockedSession.value
    },
    problems: []
  };
}

function raceGoalFromPublicTarget(target: MobileRaceTarget, path: string): Collected<RaceGoal> {
  const distanceKm = COACH_DISTANCE_KM[target.distance];
  if (distanceKm === undefined) return { value: null, problems: [`${path}.distance is not a known race distance`] };
  const targetTimeSeconds = target.targetPaceSecondsPerKm === null
    ? null
    : Math.round(target.targetPaceSecondsPerKm * distanceKm);
  const validation = validateRaceGoal({ date: target.date, distanceKm, goal: targetTimeSeconds === null ? "finish" : "time", targetTimeSeconds });
  if (validation.status !== "valid") return { value: null, problems: [`${path}: ${validation.reasons.join(", ")}`] };
  return {
    value: { id: buildRaceGoalId(validation.goal.date, validation.goal.distanceKm), ...validation.goal },
    problems: []
  };
}

function comparableRunCoach(config: MobileRunCoachPlan): unknown {
  return {
    goal: config.goal,
    raceDate: config.raceDate,
    raceDistanceKm: config.raceDistanceKm,
    targetTimeSeconds: config.targetTimeSeconds,
    runningDays: [...config.runningDays].sort((left, right) => left - right),
    longRunDays: [...config.longRunDays].sort((left, right) => left - right),
    targetType: config.targetType
  };
}

function sourceDigestOf(scope: MobilePlanOperationScope, sources: TrainingPlanMigrationSources): string {
  return digest({
    contract: TRAINING_PLAN_SOURCE_DIGEST_CONTRACT,
    migrationVersion: TRAINING_PLAN_MIGRATION_VERSION,
    scope: { serverId: scope.serverId, athleteId: scope.athleteId, datasetEpoch: scope.datasetEpoch },
    goals: sources.goals === null ? null : { revision: sources.goals.revision, payload: sources.goals.payload },
    coachLoopReceipt: sources.coachLoopReceipt === null
      ? null
      : { operationId: sources.coachLoopReceipt.operationId, payload: sources.coachLoopReceipt.payload }
  });
}

/**
 * Classifies the migration source for one scope and builds the state to write.
 *
 * Precedence and disagreement rules (plan §10.1/10.2, applied defensively):
 * - an existing unified state wins (`kind: "new"`): a second migration may replay
 *   but never overwrite it;
 * - the public `mobile_goals.raceTarget` is the authority for the race goal, so a
 *   daily-adaptive loop that nulled it cannot erase it (F04 data half);
 * - a coach-loop receipt is the live source when present; a legacy `runCoach` that
 *   is still active alongside it, or that contradicts its preferences/race, is a
 *   conflict, not a "pick the newer one" guess;
 * - an ended loop is `paused` (`sourceStatus: "ended"`), and its all-rest week
 *   window is not recorded as intent (the `end` command rewrote it).
 */
export function classifyTrainingPlanMigration(input: {
  scope: MobilePlanOperationScope;
  sources: TrainingPlanMigrationSources;
  businessDate: string;
  now: string;
}): TrainingPlanMigrationClassification {
  const { scope, sources, businessDate, now } = input;
  const scopeKey = trainingPlanScopeKey(scope);
  if (!isValidLocalDate(businessDate)) throw new TrainingPlanStateError("businessDate must be a real YYYY-MM-DD date");
  if (!isParseableInstant(now)) throw new TrainingPlanStateError("now must be a parseable instant");

  if (sources.existingState !== null) {
    const existing = sources.existingState;
    return {
      scope: scopeKey,
      businessDate,
      kind: "new",
      migrationVersion: existing.state.migrationVersion,
      sourceStatus: existing.state.sourceStatus,
      runState: existing.state.runState,
      raceGoal: existing.state.raceGoal,
      publicRaceTarget: existing.state.legacyRaceTarget,
      coachLoop: existing.state.coachLoop,
      goalsRevision: existing.state.goalsRevision,
      state: existing.state,
      sourceDigest: existing.state.sourceDigest,
      conflicts: [],
      notes: ["scope already has a unified training state; --apply only replays the recorded migration result"],
      existingRevision: existing.revision,
      applyAllowed: true
    };
  }

  const conflicts: TrainingPlanMigrationConflict[] = [];
  const notes: string[] = [];
  const sourceDigest = sourceDigestOf(scope, sources);

  // --- legacy goals row -----------------------------------------------------
  let goals: GoalsFacts | null = null;
  if (sources.goals !== null) {
    const collected = readLegacyGoals(sources.goals.payload, sources.goals.revision);
    if (collected.value === null) {
      conflicts.push({ code: "invalid_goals_payload", detail: collected.problems.join("; ") });
    } else {
      goals = collected.value;
    }
  }

  // --- latest coach-loop receipt -------------------------------------------
  let coachLoop: CoachLoopFacts | null = null;
  if (sources.coachLoopReceipt !== null) {
    const collected = readCoachLoopReceipt(sources.coachLoopReceipt.payload, sources.coachLoopReceipt.operationId);
    if (collected.value === null) {
      conflicts.push({ code: "invalid_coach_loop_receipt", detail: collected.problems.join("; ") });
    } else {
      coachLoop = collected.value;
    }
  }
  const runCoach = goals?.runCoach ?? null;

  // --- source disagreement --------------------------------------------------
  if (coachLoop !== null && runCoach !== null) {
    if (coachLoop.status !== runCoach.status) {
      conflicts.push({
        code: "source_disagreement",
        detail: `coach-loop receipt is ${coachLoop.status} while the legacy run-coach programme is ${runCoach.status}`
      });
    } else if (digest(coachLoop.comparable) !== digest(comparableRunCoach(runCoach))) {
      conflicts.push({
        code: "source_disagreement",
        detail: "coach-loop receipt and legacy run-coach programme are both present but describe different preferences/race"
      });
    } else {
      notes.push("legacy run-coach programme mirrors the coach-loop receipt; the loop source wins");
    }
  }

  // --- race goal reconciliation --------------------------------------------
  let publicRaceGoal: RaceGoal | null = null;
  if (goals !== null && goals.raceTarget !== null) {
    const collected = raceGoalFromPublicTarget(goals.raceTarget, "mobile_goals.raceTarget");
    if (collected.value === null) {
      conflicts.push({ code: "invalid_race_target", detail: collected.problems.join("; ") });
    } else {
      publicRaceGoal = collected.value;
    }
  }
  let runCoachRaceGoal: RaceGoal | null = null;
  if (runCoach !== null) {
    const collected = raceGoalFromConfig(runCoach, "mobile_goals.runCoach");
    if (collected.value === null && collected.problems.length > 0) {
      conflicts.push({ code: "invalid_goals_payload", detail: collected.problems.join("; ") });
    } else {
      runCoachRaceGoal = collected.value;
    }
  }
  let coachRaceGoal = coachLoop?.raceGoal ?? null;
  if (runCoachRaceGoal !== null && coachRaceGoal !== null &&
      (runCoachRaceGoal.date !== coachRaceGoal.date || runCoachRaceGoal.distanceKm !== coachRaceGoal.distanceKm)) {
    conflicts.push({ code: "race_goal_mismatch", detail: "legacy run-coach programme and coach-loop receipt declare different races" });
  }
  const coachRaceGoalAuthority = coachRaceGoal ?? runCoachRaceGoal;
  let raceGoal: RaceGoal | null = coachRaceGoalAuthority;
  if (publicRaceGoal !== null) {
    if (coachRaceGoalAuthority !== null &&
        (publicRaceGoal.date !== coachRaceGoalAuthority.date || publicRaceGoal.distanceKm !== coachRaceGoalAuthority.distanceKm)) {
      conflicts.push({
        code: "race_goal_mismatch",
        detail: "public mobile_goals.raceTarget and the coach configuration declare different races; the public goal is authoritative"
      });
    }
    // The public goal is the authority (plan §10.1); take richer target-time detail
    // from the coach config only when the race identity matches.
    raceGoal = coachRaceGoalAuthority !== null &&
      coachRaceGoalAuthority.date === publicRaceGoal.date &&
      coachRaceGoalAuthority.distanceKm === publicRaceGoal.distanceKm &&
      publicRaceGoal.targetTimeSeconds === null &&
      coachRaceGoalAuthority.targetTimeSeconds !== null
      ? coachRaceGoalAuthority
      : publicRaceGoal;
  }

  // --- source status / run state -------------------------------------------
  const loopStatus = coachLoop?.status ?? null;
  const runCoachStatus = runCoach?.status ?? null;
  const sourceStatus: TrainingPlanSourceStatus = loopStatus ?? runCoachStatus ?? "none";
  const runState: RunState = sourceStatus === "active" ? "active" : "paused";
  const kind: TrainingPlanSource = coachLoop !== null ? "coach_loop" : runCoach !== null ? "run_coach" : "legacy_goals";

  // --- plan window ----------------------------------------------------------
  const endedLoop = loopStatus === "ended";
  const weekPlan = endedLoop ? [] : (goals?.weekPlan ?? []);
  const lockedSession = endedLoop ? null : (goals?.lockedSession ?? null);
  if (endedLoop && (goals?.weekPlan.length ?? 0) > 0) {
    notes.push("ended coach loop: its all-rest week window is not recorded as training intent");
  }

  const preferencesComplete = coachLoop !== null ? coachLoop.preferencesComplete : runCoach !== null;

  let state: TrainingPlanState | null = null;
  if (conflicts.length === 0) {
    state = parseTrainingPlanState({
      schemaVersion: TRAINING_PLAN_STATE_SCHEMA_VERSION,
      migrationVersion: TRAINING_PLAN_MIGRATION_VERSION,
      source: kind,
      sourceStatus,
      sourceDigest,
      runState,
      raceGoal,
      preferencesComplete,
      legacyRaceTarget: goals?.raceTarget ?? null,
      weekPlan,
      lockedSession,
      runCoach,
      coachLoop: coachLoop?.ref ?? null,
      goalsRevision: goals?.revision ?? null,
      // The migration derives configuration only; a published plan is attached by
      // the PR4-2 command/refresh path, so no context digest exists yet.
      planContextDigest: null,
      migratedAt: now
    });
  }

  const result: TrainingPlanMigrationClassification = {
    scope: scopeKey,
    businessDate,
    kind,
    migrationVersion: TRAINING_PLAN_MIGRATION_VERSION,
    sourceStatus,
    runState,
    raceGoal,
    publicRaceTarget: goals?.raceTarget ?? null,
    coachLoop: coachLoop?.ref ?? null,
    goalsRevision: goals?.revision ?? null,
    state,
    sourceDigest,
    conflicts,
    notes,
    existingRevision: null,
    applyAllowed: conflicts.length === 0 && state !== null
  };
  return result;
}
