import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  MobileGoalsResponse,
  MobilePlanOperationScope,
  CoachLoopSettings,
  MobileLockedSession,
  MobilePlanAudit,
  MobilePlannedDay,
  MobileRaceDistance,
  MobileRaceTarget,
  MobileSessionKind,
  MobileSessionStructure,
  MobileRunCoachPlan,
  UpdateMobileGoalsInput
} from "@rai/api-contracts";
import { MOBILE_SESSION_KINDS } from "@rai/contracts";

import {
  DEFAULT_EASY_DURATION_FLOOR,
  DEFAULT_QUALITY_SESSION_CAP,
  buildSessionStructure,
  capStructureToDayCeiling,
  measureStructure,
  pacesFromZones,
  plannedDayNumbers,
  roundKm,
  type CoachZonePrescription
} from "./mobile-coach.js";
import { MAX_PLANNED_DISTANCE_KM, normalizeSessionStructure } from "./session-structure.js";
import { isValidLocalDate } from "./local-date.js";
import { normalizeRunCoachPlan } from "./run-coach-policy.js";
import { digest } from "./plan-digest.js";
import { PlanOperationError } from "./plan-publication.js";
import {
  beginPublicationGuard,
  clearPublicationMarkerOnStartup,
  endPublicationGuard,
  ensurePublicationGuardSchema,
  readPublicationGuard,
  type PublicationGuardState
} from "./publication-guard.js";
import { TrainingPlanStore, ensureTrainingPlanSchema, type TrainingPlanSessionState, type TrainingPlanState, type TrainingPlanStateRow } from "./training-plan-store.js";
import { assertTrainingPlanLockedRestInvariant, parseSessionPrescription, TrainingPlanSessionStateError } from "./training-plan-session-state.js";
import { ensureTrainingPlanSessionSchema, TrainingPlanSessionRepository } from "./training-plan-session-repository.js";
import { ensureTrainingPlanExecutionSchema, TrainingPlanExecutionRepository } from "./training-plan-execution-repository.js";
import { ensureTrainingPlanEvaluationSchema, TrainingPlanEvaluationRepository, type TrainingPlanEvaluation } from "./training-plan-evaluation-repository.js";
import { raceGoalFromCoachSettings, unifiedCoachSettings } from "./training-plan-ownership.js";
import { trainingPlanContextDigest } from "./training-mode-policy.js";
import { coachLocalDate } from "./coach-loop-facts.js";

const GOALS_FILE = "mobile-goals.json";
function assertGoalsLockedRestInvariant(value: unknown): void {
  try { assertTrainingPlanLockedRestInvariant(value); }
  catch (error) {
    if (!(error instanceof TrainingPlanSessionStateError)) throw error;
    throw new PlanOperationError("training_session_date_occupied", `锁课与明确休息冲突；本次写入未提交。${error.message}`, 409);
  }
}
/** Derived from the shared list so this set cannot drift from the API's enum. */
const SESSION_KINDS = new Set<MobileSessionKind>(MOBILE_SESSION_KINDS);
const RACE_DISTANCES = new Set<MobileRaceDistance>(["five_k", "ten_k", "half_marathon"]);
/**
 * Kinds whose structure is *sized* by a target distance.
 *
 * `buildSessionStructure` subtracts its warmup/cooldown overhead from
 * `targetDistanceKm` for these and ignores the option entirely for
 * `interval`/`tempo`, whose dose is fixed by the coach (reps × 800 m, reps ×
 * work interval). Only these kinds can therefore honour a distance typed into
 * the goals editor.
 */
const TARGET_SIZED_KINDS = new Set<MobileSessionKind>(["easy", "recovery", "long_run"]);

interface StoredGoals {
  revision: number;
  easyDurationFloorFraction: number;
  qualitySessionCap: number;
  raceTarget: MobileRaceTarget | null;
  weekPlan: MobileGoalsResponse["weekPlan"];
  lockedSession: MobileLockedSession | null;
  weekPlanAudit: MobilePlanAudit | null;
  weekPlanReplanRequired: boolean;
  weekPlanPreservedDate: string | null;
  runCoach: MobileRunCoachPlan | null;
  updatedAt: string;
}

/**
 * The per-call ceiling `planHistory`/`planPushes` have always applied to their
 * `LIMIT`. The caches fill to the same number, which is what makes answering a
 * bounded read from memory identical to running the query: `MAX_READ_ROWS` is
 * the largest a caller can ask for, so a cache that holds that many rows always
 * covers the request.
 */
const MAX_READ_ROWS = 200;
const cappedReadLimit = (limit: number): number => Math.min(MAX_READ_ROWS, Math.max(1, Math.round(limit)));

const clampFraction = (value: number): number => Math.min(0.95, Math.max(0.4, value));
const clampCap = (value: number): number => Math.min(4, Math.max(0, Math.round(value)));
const normalizePreservedDate = (value: unknown): string | null => typeof value === "string" && isValidLocalDate(value) ? value : null;

/** Canonical spelling of one local system-schedule entry's identity. */
export interface PlanPushIdentity {
  workoutID: string | null;
  scheduledAt: string | null;
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Uppercase form of a UUID, or null when the value is not one. */
export function canonicalPlanWorkoutID(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID_TEXT.test(trimmed) ? trimmed.toUpperCase() : null;
}

/** UTC ISO-8601 form of a parseable instant, or null when it is not one. */
export function canonicalPlanScheduledAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/**
 * Lookup identity for a system-schedule entry: canonical when the bytes are
 * parseable, byte-identical otherwise (legacy rows and legacy callers).
 *
 * The canonical form is what `recordPlanPush` persists for contract-v2 receipts
 * and what every identity predicate compares against. A client that spells the
 * same UUID/instant differently ("uuid" vs "UUID", "+08:00" vs "Z") therefore
 * addresses the same entry, which is the promise documented in
 * `docs/IOS_NATIVE_PLAN_SCHEDULING.md` §7（回执）。Legacy receipts are
 * left byte-identical on purpose: their payload comparison is the old
 * contract and rewriting it would change what a legacy client is deduplicated
 * against.
 */
export function canonicalPlanPushIdentity(value: { workoutID?: string | null | undefined; scheduledAt?: string | null | undefined }): PlanPushIdentity {
  const workoutID = value.workoutID ?? null;
  const scheduledAt = value.scheduledAt ?? null;
  return {
    workoutID: workoutID === null ? null : (canonicalPlanWorkoutID(workoutID) ?? workoutID),
    scheduledAt: scheduledAt === null ? null : (canonicalPlanScheduledAt(scheduledAt) ?? scheduledAt)
  };
}

/**
 * Scope partition of the receipt idempotency key. A v2 receipt always carries
 * its dataset identity, so the same key may be reused by another dataset (a
 * restored/emptied control database is a different dataset, not a retry).
 * Legacy receipts never carried a scope; they keep the historical global
 * behaviour among themselves (`scope_key IS NULL`).
 */
const planPushScopeKey = (scope: PlanPushRecord["scope"]): string | null => scope ? digest(scope) : null;

const isDatabaseBusyMessage = (message: string): boolean =>
  /database is locked|database table is locked|SQLITE_BUSY/i.test(message);

const isDatabaseBusyError = (error: unknown): boolean =>
  error instanceof Error && isDatabaseBusyMessage(error.message);

const mapDatabaseBusy = (error: unknown): unknown => isDatabaseBusyError(error) ? new MobileGoalsDatabaseBusyError() : error;

const emptyGoals = (): StoredGoals => ({
  revision: 0,
  easyDurationFloorFraction: DEFAULT_EASY_DURATION_FLOOR,
  qualitySessionCap: DEFAULT_QUALITY_SESSION_CAP,
  raceTarget: null,
  weekPlan: [],
  lockedSession: null,
  weekPlanAudit: null,
  weekPlanReplanRequired: false,
  weekPlanPreservedDate: null,
  runCoach: null,
  updatedAt: new Date(0).toISOString()
});

/**
 * Everything a plan operation needs beyond its own input.
 *
 * `prescription` is the zone profile the plan views use to measure a structure.
 * Pass the object — `null` included — when the zones were read and, possibly,
 * turned out to be absent: `null` then means "measure with the default paces",
 * which is exactly what readers fall back to. Leave the key out when the zones
 * could not be read at all (no database yet): the merge then keeps the day's
 * previous distance and the response echoes what is stored, instead of
 * inventing numbers from paces the runner may not use.
 *
 * Both directions take it: `write` measures the merged plan, and `read` measures
 * the stored one, so no response this store produces can carry a distance its
 * own structure does not describe.
 */
export interface PlanMergeOptions {
  /** Internal schema-2 edit transaction; preserves the existing confirmation fence. */
  sessionCommand?: boolean;
  /** Internal programme capability, never accepted by the public goals body. */
  runCoach?: MobileRunCoachPlan | null;
  prescription?: CoachZonePrescription | null;
  /** Internal confirmation capability; never accepted in the public goals body. */
  confirmCoachPlan?: boolean;
  /** Runs on the measured candidate before any durable write. */
  validate?: (candidate: MobileGoalsResponse) => MobileGoalsResponse | void;
  /** Explicit command clock for deterministic coach publication/replay. */
  evaluatedAt?: string;
  /**
   * B03: the unified session resolver already validated and measured this exact
   * plan. Re-running the legacy normalize/measure path could silently drop a
   * nullable field (`reason: null`) or re-round a protected prescription, which
   * would make the materialized week disagree with its stable session. Internal
   * only; never accepted from the public goals body.
   */
  preserveWeekPlan?: boolean;
}

/** One stored plan revision, as it was written. */
export interface PlanHistoryRevision {
  revision: number;
  changedAt: string;
  weekPlan: MobilePlannedDay[];
  lockedSession: MobileLockedSession | null;
}

/** A lock is its own prescription, not a flag on a possibly different week row. */
export function planDayWithLock(
  plan: Pick<PlanHistoryRevision, "weekPlan" | "lockedSession">, date: string
): MobilePlannedDay | undefined {
  if (plan.lockedSession?.localDate !== date) return plan.weekPlan.find(day => day.localDate === date);
  const session = plan.lockedSession.session;
  return { localDate: date, kind: session.kind, distanceKm: session.distanceKm,
    structure: session.structure, reason: session.reason };
}

/** Client-verified local system schedule; physical Watch delivery is separate. */
export interface PlanPushRecord {
  localDate: string;
  revision: number;
  kind: MobileSessionKind;
  structure: MobileSessionStructure | null;
  pushedAt: string;
  workoutID?: string;
  scheduledAt?: string;
  idempotencyKey?: string;
  exportNotes?: string[];
  contractVersion?: 2;
  scope?: { serverId: string; athleteId: string; datasetEpoch: string };
  operationId?: string;
  coherenceToken?: string;
  verifiedAt?: string;
  timezone?: string;
  prescriptionDigest?: string;
  lifecycleEvent?: "verified" | "withdrawn" | "replaced";
  matchesCurrent?: boolean;
  coachLoop?: import("@rai/api-contracts").CoachLoopReceiptContext;
}

/**
 * Parsed rows of one control-database table, stamped with the database version
 * they were read at. See `MobileGoalsStore` for what the stamp guards against.
 */
interface ReadCache<T> {
  /** `PRAGMA data_version` as it stood when `rows` was read. */
  dataVersion: number;
  rows: T[];
}

/**
 * Weekly goals, plan history and push receipts, persisted in the control
 * database (`var/rai-control.sqlite`; `var/mobile-goals.json` remains only as the
 * one-time migration source).
 *
 * ### The parsed read cache
 *
 * `planSegmentCandidates()` reads the history and push tables on **every**
 * `GET /v1/workouts/:id/series` — that is how the detail page finds the plan a
 * run executed. Measured on a realistically sized control database (20 goal
 * revisions × 7 planned days, 50 receipts), the re-read plus re-parse costs
 * **2.10 ms** of synchronous work per request against **0.020 ms** cached, on
 * the event loop — so the parsed rows are kept between requests.
 *
 * Only these two append-only tables are cached. `readControlGoals()` deliberately
 * is not: it is a single row, and `write()` is a read-modify-write on it, so
 * answering it from memory could let a stale revision slip past the
 * optimistic-concurrency check `MobileGoalsRevisionConflictError` exists to enforce.
 *
 * Nothing here expires on a timer, and two mechanisms are needed because neither
 * covers the other — both verified against SQLite rather than assumed:
 *
 *   1. **this store's own commits** call {@link invalidateReadCaches}.
 *      `PRAGMA data_version` does *not* move for them (measured: unchanged across
 *      a commit made on the same connection), so the probe below cannot see them;
 *   2. **any other connection's commits** are caught by {@link dataVersion}. That
 *      is the documented and measured behaviour (2 → 3 → 4 across two foreign
 *      commits), and it is what keeps the cache from silently outliving a writer
 *      that is not this process — a CLI, or a second connection in a test.
 *
 * The probe is a pragma against the SQLite header, costing 0.020 ms — a hundredth
 * of the read it guards, so the fast path stays fast. The arrays a reader gets
 * back are copies, but their elements are shared with the cache: treat both as
 * read-only.
 */
export class MobileGoalsStore {
  private trainingIdentity: (() => MobilePlanOperationScope) | null = null;
  private trainingBusinessDate = () => coachLocalDate(new Date().toISOString());
  private stagedCoachReceipt: { operationId: string; state: { settings: CoachLoopSettings; policyHash: string; evaluatedAt: string };
    raceGoal?: TrainingPlanState["raceGoal"]; replaceEnded?: boolean } | null = null;
  private stagedSessionFields: { sessions: TrainingPlanSessionState["sessions"]; suppressions: TrainingPlanSessionState["suppressions"];
    archivedSessionIds: readonly string[] } | null = null;
  private publicationTransaction = false;
  private publicationCommitChecks: Array<() => void> = [];
  private readonly filePath: string;
  private readonly controlDatabase: DatabaseSync | null;
  private cached: StoredGoals | null = null;
  private planHistoryCache: ReadCache<PlanHistoryRevision> | null = null;
  private planPushCache: ReadCache<PlanPushRecord> | null = null;

  constructor(runtimeRoot: string, controlDatabasePath?: string) {
    this.filePath = join(runtimeRoot, "var", GOALS_FILE);
    this.controlDatabase = controlDatabasePath ? this.openControlDatabase(controlDatabasePath) : null;
  }

  read(options?: PlanMergeOptions): MobileGoalsResponse {
    if (this.controlDatabase) return this.toResponse(this.readControlGoals(), options);
    if (!this.cached) {
      this.cached = existsSync(this.filePath) ? this.loadFile() : emptyGoals();
    }
    return this.toResponse(this.cached, options);
  }

  get supportsPublicationOperations(): boolean { return this.controlDatabase !== null; }

  bindTrainingPlanOwner(identity: () => MobilePlanOperationScope, businessDate?: () => string): void {
    this.trainingIdentity = identity;
    if (businessDate !== undefined) this.trainingBusinessDate = businessDate;
  }

  currentTrainingPlan(): TrainingPlanStateRow | null {
    const id = this.trainingIdentity?.();
    return id ? this.trainingPlanStateRow(JSON.stringify([id.serverId, id.athleteId, id.datasetEpoch])) : null;
  }

  /** Read current configuration through unified's immutable receipt pointer. */
  currentCoachLoopState<T extends { settings: CoachLoopSettings }>(scope: string): T | null {
    const row = this.currentTrainingPlan();
    if (row === null) return this.coachLoopState<T>(scope);
    if (row.state.coachLoop === null) {
      // A migrated scope without an owner pointer must not silently adopt the
      // latest legacy receipt as a second current configuration. The one
      // exception is the existing ended-release contract: an ended receipt has
      // already handed the dataset back to legacy reads, so it is safe evidence
      // (and required for the managed preHandler to release the read routes).
      const legacy = this.coachLoopState<T>(scope);
      if (legacy === null) return null;
      const status = (legacy as { settings?: { status?: string } }).settings?.status;
      if (status === "ended") return legacy;
      throw new PlanOperationError("training_plan_owner_invalid", "训练配置证据与统一状态不一致，请恢复控制库。", 503);
    }
    const receipt = this.controlDatabase!.prepare(
      "SELECT payload_json FROM mobile_coach_loop_receipts WHERE scope=? AND operation_id=?"
    ).get(scope, row.state.coachLoop.operationId) as { payload_json: string } | undefined;
    if (!receipt) throw new PlanOperationError("training_plan_owner_invalid", "训练配置证据缺失，请恢复控制库。", 503);
    const value = JSON.parse(receipt.payload_json) as T;
    return { ...value, settings: unifiedCoachSettings(row.state, value.settings, this.trainingBusinessDate()) };
  }

  private reconcileTrainingPlanOwner(): void {
    const row = this.currentTrainingPlan();
    if (row === null) return;
    const goals = this.read();
    const receipt = this.stagedCoachReceipt;
    if (row.state.goalsRevision === goals.revision && receipt === null) return;
    const stagedSessions = row.state.schemaVersion === 2 ? this.stagedSessionFields : null;
    const state: TrainingPlanState = { ...row.state, goalsRevision: goals.revision,
      legacyRaceTarget: goals.raceTarget ?? null,
      weekPlan: goals.weekPlan, lockedSession: goals.lockedSession,
      ...(stagedSessions === null ? {} : { sessions: stagedSessions.sessions, suppressions: stagedSessions.suppressions }),
      // The legacy projection stops running a programme after v2 takes over.
      // Its migrated preferences stay in unified until a coach receipt replaces
      // them with an explicitly configured set of current preferences.
      runCoach: receipt !== null || row.state.coachLoop !== null ? null : goals.runCoach ?? row.state.runCoach };
    if (receipt !== null) {
      state.coachLoop = { operationId: receipt.operationId, policyHash: receipt.state.policyHash,
        evaluatedAt: receipt.state.evaluatedAt };
      // `ended` is terminal unless this receipt came from an explicit new
      // enable. A malformed/stale pause receipt must never downgrade the owner
      // from ended back to paused and make a v2 resume possible.
      const keepEnded = row.state.sourceStatus === "ended" &&
        receipt.state.settings.status !== "ended" && receipt.replaceEnded !== true;
      state.sourceStatus = keepEnded ? "ended" : receipt.state.settings.status;
      state.runState = keepEnded ? "paused" : receipt.state.settings.status === "active" ? "active" : "paused";
      state.raceGoal = keepEnded ? row.state.raceGoal : receipt.raceGoal === undefined
        ? raceGoalFromCoachSettings(receipt.state.settings, row.state.raceGoal) : receipt.raceGoal;
      state.preferencesComplete = true;
      state.planContextDigest = trainingPlanContextDigest(state);
    }
    this.commitTrainingPlanCommandState({ scope: row.scope, expectedRevision: row.revision, state,
      eventType: receipt ? "owner:coach-loop" : "owner:projection" },
      stagedSessions === null ? {} : { archivedSessionIds: stagedSessions.archivedSessionIds, archiveBefore: this.trainingBusinessDate() });
  }

  trainingPlanOwnerReady(): boolean {
    try {
      const row = this.currentTrainingPlan();
      const identity = this.trainingIdentity?.();
      if (row === null || identity === undefined || this.controlDatabase === null) return false;
      if (row.state.goalsRevision !== this.read().revision) return false;
      const scope = JSON.stringify(identity);
      const latest = this.controlDatabase.prepare(
        "SELECT operation_id FROM mobile_coach_loop_receipts WHERE scope=? ORDER BY sequence DESC LIMIT 1"
      ).get(scope) as { operation_id: string } | undefined;
      if ((latest?.operation_id ?? null) !== (row.state.coachLoop?.operationId ?? null)) return false;
      this.currentCoachLoopState(scope);
      return true;
    } catch {
      // Missing receipt, unreadable control DB or stale projection: keep the
      // v2 read/write surface closed instead of guessing an owner.
      return false;
    }
  }

  /** Coach configuration, anchor and decision receipts share the publication
   * transaction with goals/history. Not a second store of health facts. */
  coachLoopState<T>(scope: string): T | null {
    const row = this.controlDatabase?.prepare(`SELECT payload_json FROM mobile_coach_loop_receipts
      WHERE scope=? ORDER BY sequence DESC LIMIT 1`).get(scope) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as T : null;
  }

  /**
   * Unified training-plan state for the v2 read contract (PR3/PR4-1).
   *
   * Strictly read-only: a GET must never migrate, publish or write. `null` means
   * "this scope has not been migrated" (and also "this store has no control
   * database"), which the route answers with an explicit not-migrated error rather
   * than a legacy fallback. A damaged store throws instead of guessing.
   */
  trainingPlanStateRow(scope: string): TrainingPlanStateRow | null {
    if (!this.controlDatabase) return null;
    return new TrainingPlanStore(this.controlDatabase).read(scope);
  }

  /** Indexed frozen course reads, independent of the capped compatibility planHistory. */
  trainingPlanSessionHistory(scope: string, instance: string, id: string, revision: number) {
    return this.controlDatabase ? new TrainingPlanSessionRepository(this.controlDatabase).get(scope, instance, id, revision) : null;
  }

  trainingPlanSessionAt(scope: string, instance: string, id: string, asOf: string) {
    return this.controlDatabase ? new TrainingPlanSessionRepository(this.controlDatabase).effectiveAt(scope, instance, id, asOf) : null;
  }

  trainingPlanSessionsForDate(scope: string, date: string, asOf: string,
    options: Parameters<TrainingPlanSessionRepository["forDate"]>[3] = {}) {
    return this.controlDatabase ? new TrainingPlanSessionRepository(this.controlDatabase).forDate(scope, date, asOf, options) : [];
  }

  /** B06: current execution associations for one scope/instance. */
  trainingPlanExecutions(scope: string, instance: string) {
    return this.controlDatabase ? new TrainingPlanExecutionRepository(this.controlDatabase).list(scope, instance).map(row => row.execution) : [];
  }

  trainingPlanExecution(scope: string, id: string) {
    return this.controlDatabase ? new TrainingPlanExecutionRepository(this.controlDatabase).current(scope, id) : null;
  }

  trainingPlanExecutionHistory(scope: string, id: string) {
    return this.controlDatabase ? new TrainingPlanExecutionRepository(this.controlDatabase).history(scope, id) : [];
  }

  /** The one session currently claiming this actual run, across the whole scope. */
  trainingPlanExecutionForRun(scope: string, trainingSessionId: string) {
    return this.controlDatabase ? new TrainingPlanExecutionRepository(this.controlDatabase)
      .confirmedByTrainingSession(scope, trainingSessionId) : null;
  }

  /** B08: newest input checked for this scope, or null before the first publication. */
  trainingPlanEvaluation(scope: string): TrainingPlanEvaluation | null {
    return this.controlDatabase ? new TrainingPlanEvaluationRepository(this.controlDatabase).get(scope) : null;
  }

  recordTrainingPlanEvaluation(scope: string, value: TrainingPlanEvaluation): void {
    if (!this.controlDatabase || !this.publicationTransaction) {
      throw new PlanOperationError("training_plan_transaction_required", "评估游标必须与发布在同一事务内提交。", 500);
    }
    new TrainingPlanEvaluationRepository(this.controlDatabase).record(scope, value);
  }

  /**
   * B06: append an execution revision inside the caller's publication
   * transaction. The course/lifecycle state and this link share one COMMIT.
   */
  appendTrainingPlanExecution(scope: string, instance: string, execution: import("@rai/api-contracts").TrainingPlanSessionExecution, reason: string): void {
    if (!this.controlDatabase || !this.publicationTransaction) {
      throw new PlanOperationError("training_plan_transaction_required", "执行关联必须与发布在同一事务内提交。", 500);
    }
    new TrainingPlanExecutionRepository(this.controlDatabase).append(scope, instance, execution, reason);
  }

  /**
   * PR4-2: CAS write of a command-derived unified state.
   *
   * Must run inside the caller's publication transaction so the state write, its
   * history row, the legacy goals mirror and the operation result commit or roll
   * back together. Calling it without a transaction throws instead of silently
   * creating a second, torn publication path.
   */
  /**
   * B03: the legacy coach-loop command path still owns an existing operation
   * contract. When the scope has already been migrated to schema 2, its planned
   * window must go through the same session resolver as the unified refresh; this
   * stages the resolved fields for reconciliation inside the same publication
   * transaction. It is internal to a publication action and cannot be called
   * outside one.
   */
  stageTrainingPlanSessionState(fields: { sessions: TrainingPlanSessionState["sessions"]; suppressions: TrainingPlanSessionState["suppressions"];
    archivedSessionIds?: readonly string[] }): void {
    if (!this.publicationTransaction) throw new PlanOperationError("training_plan_transaction_required",
      "课程会话只能随发布事务提交。", 500);
    this.stagedSessionFields = { sessions: fields.sessions, suppressions: fields.suppressions,
      archivedSessionIds: fields.archivedSessionIds ?? [] };
  }

  commitTrainingPlanCommandState(input: {
    scope: string;
    expectedRevision: number;
    state: TrainingPlanState;
    eventType: string;
  }, options: { archivedSessionIds?: readonly string[]; archiveBefore?: string } = {}): { revision: number; updatedAt: string } {
    if (!this.controlDatabase) throw new PlanOperationError("training_plan_state_unavailable",
      "当前存储没有控制库，不能提交统一训练状态。", 503);
    if (!this.publicationTransaction) throw new PlanOperationError("training_plan_transaction_required",
      "统一状态必须与发布在同一事务内提交。", 500);
    const result = new TrainingPlanStore(this.controlDatabase).commitState(input, { inTransaction: true, ...options });
    if (this.stagedCoachReceipt?.operationId === input.state.coachLoop?.operationId) this.stagedCoachReceipt = null;
    return result;
  }

  /** One immutable receipt by operation id; used for semantic no-change checks. */
  coachLoopReceipt<T>(scope: string, operationId: string): T | null {
    const row = this.controlDatabase?.prepare("SELECT payload_json FROM mobile_coach_loop_receipts WHERE scope=? AND operation_id=?")
      .get(scope, operationId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as T : null;
  }

  coachLoopReceipts<T>(scope: string, limit = 100): T[] {
    return (this.controlDatabase?.prepare(`SELECT payload_json FROM mobile_coach_loop_receipts
      WHERE scope=? ORDER BY sequence DESC LIMIT ?`).all(scope, cappedReadLimit(limit)) as
      { payload_json: string }[] | undefined ?? []).map(row => JSON.parse(row.payload_json) as T);
  }

  appendCoachLoopReceipt(scope: string, operationId: string, state: unknown, raceGoal?: TrainingPlanState["raceGoal"],
    options: { replaceEnded?: boolean } = {}): void {
    if (!this.publicationTransaction || !this.controlDatabase) throw new Error("Coach receipt requires atomic plan publication");
    this.controlDatabase.prepare("INSERT INTO mobile_coach_loop_receipts(scope,operation_id,payload_json) VALUES (?,?,?)")
      .run(scope, operationId, JSON.stringify(state));
    if (this.trainingIdentity !== null) {
      this.stagedCoachReceipt = { operationId, state: state as { settings: CoachLoopSettings; policyHash: string; evaluatedAt: string },
        ...(raceGoal === undefined ? {} : { raceGoal }),
        ...(options.replaceEnded === true ? { replaceEnded: true } : {}) };
    }
  }

  /**
   * Cross-store publication state (see `publication-guard.ts`).
   *
   * Readers call this before and after building a snapshot: a moved epoch or a
   * non-stale `pendingSince` means a publication may have committed one store
   * but not the other. Without a control database there is nothing to guard.
   */
  publicationGuardState(): PublicationGuardState {
    if (!this.controlDatabase) return { epoch: 0, pendingSince: null };
    const state = readPublicationGuard(this.controlDatabase);
    // Invariant: while this store holds its control write transaction, the
    // pending marker in the table is this store's own publication, not a foreign
    // one. `withPublicationTransaction` commits the marker *before* it takes the
    // write transaction, and the whole span is synchronous, so no foreign
    // publisher can start and no in-process code can observe a half-applied
    // publication from inside it: another writer is either blocked on
    // `BEGIN IMMEDIATE`, or it marked pending before this transaction and cannot
    // write the main database while this control write lock is held. Reporting
    // the marker would make every write path that reads the plan inside its own
    // transaction (e.g. `/synced` computing `matchesCurrent` and the coach device
    // receipt validating the snapshot it is about to record) fail closed with
    // `plan_snapshot_changed`. `epoch` is preserved so a foreign publication that
    // started before this transaction is still detectable by the before/after
    // epoch comparison of the guarded readers.
    return this.publicationTransaction ? { epoch: state.epoch, pendingSince: null } : state;
  }

  /**
   * True while this store is inside its own plan publication transaction.
   *
   * Kept as a public accessor for diagnostics and tests. Guarded readers no
   * longer disable themselves because of it: `publicationGuardState` already
   * hides the store's own `pending_since` marker while preserving the epoch, so
   * a read inside the transaction neither fails closed on itself nor loses the
   * ability to detect a foreign publication (review P3-03).
   */
  publicationInFlight(): boolean { return this.publicationTransaction; }

  /**
   * Runs `fn` inside one control write transaction that is preceded by a
   * committed guard marker and followed by clearing it.
   *
   * Ordering matters: the marker is committed *before* the business transaction
   * so a reader that observed the old state cannot also have seen a main-store
   * write that belongs to this publication. Clearing happens in its own
   * transaction after the business transaction committed (or rolled back), so a
   * failed business transaction never leaves a live lock — only the lease.
   *
   * Nested calls (a function that already runs inside the transaction, e.g.
   * `recordPlanPush` invoked from a publication action) execute immediately.
   */
  withPublicationTransaction<T>(fn: () => T): T {
    if (this.publicationTransaction) return fn();
    if (!this.controlDatabase) return fn();
    this.beginPublicationMarker();
    try {
      const result = this.inWriteTransaction(fn);
      this.invalidateReadCaches();
      return result;
    } finally {
      // Never let a marker-clearing failure mask the business result/error.
      this.endPublicationMarker();
    }
  }

  /** Register a final cross-store check after all business/result writes and owner reconciliation.
   * The caller must hold the existing main-DB mutation lease through COMMIT:
   * this control transaction alone cannot prevent a main-library writer.
   */
  beforePublicationCommit(check: () => void): void {
    if (!this.publicationTransaction) throw new Error("Commit checks require a publication transaction");
    this.publicationCommitChecks.push(check);
  }

  /** Commits the guard marker before the guarded business transaction starts. */
  private beginPublicationMarker(): void {
    const database = this.controlDatabase!;
    try {
      database.exec("BEGIN IMMEDIATE");
      beginPublicationGuard(database);
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* no transaction to roll back */ }
      throw mapDatabaseBusy(error);
    }
  }

  /** Clears the marker in its own transaction; best effort by design (lease). */
  private endPublicationMarker(): void {
    const database = this.controlDatabase;
    if (!database) return;
    try {
      database.exec("BEGIN IMMEDIATE");
      endPublicationGuard(database);
      database.exec("COMMIT");
    } catch {
      try { database.exec("ROLLBACK"); } catch { /* no transaction to roll back */ }
    }
  }

  /** `BEGIN IMMEDIATE` + fn + `COMMIT`, with the flag nested writers observe. */
  private inWriteTransaction<T>(fn: () => T): T {
    const database = this.controlDatabase!;
    try {
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw mapDatabaseBusy(error);
    }
    this.publicationTransaction = true;
    try {
      const result = fn();
      this.reconcileTrainingPlanOwner();
      for (const check of this.publicationCommitChecks) check();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* SQLite may have rolled back already */ }
      this.cached = null;
      this.invalidateReadCaches();
      throw mapDatabaseBusy(error);
    } finally {
      this.publicationTransaction = false;
      this.publicationCommitChecks = [];
      this.stagedCoachReceipt = null;
      this.stagedSessionFields = null;
    }
  }

  publicationResult(scope: string, operationId: string): unknown {
    const row = this.controlDatabase?.prepare("SELECT result_json, expires_at FROM mobile_plan_operations WHERE scope = ? AND operation_id = ?")
      .get(scope, operationId) as { result_json: string | null; expires_at: string } | undefined;
    if (!row) {
      const other = this.controlDatabase?.prepare("SELECT 1 FROM mobile_plan_operations WHERE operation_id = ? AND scope != ?").get(operationId, scope);
      return { status: other ? "scopeMismatch" : "notFound", operationId };
    }
    if (Date.parse(row.expires_at) <= Date.now() || row.result_json === null) {
      this.controlDatabase?.prepare("UPDATE mobile_plan_operations SET result_json = NULL WHERE scope = ? AND operation_id = ? AND expires_at <= ?")
        .run(scope, operationId, new Date().toISOString());
      return { status: "expired", operationId };
    }
    return { status: "committed", operationId, result: JSON.parse(row.result_json) };
  }

  /** One committed publication result, or null when the key has no live row. */
  private replayPublicationResult<Result>(
    scope: string,
    operationId: string,
    requestDigest: string
  ): { result: Result } | null {
    this.assertPublicationOperationScope(scope, operationId);
    const previous = this.controlDatabase!.prepare(
      "SELECT request_digest, result_json, expires_at FROM mobile_plan_operations WHERE scope = ? AND operation_id = ?"
    ).get(scope, operationId) as { request_digest: string; result_json: string | null; expires_at: string } | undefined;
    if (!previous) return null;
    if (previous.request_digest !== requestDigest) {
      throw new PlanOperationError("plan_operation_key_conflict", "操作键已用于不同请求，原操作未重放。");
    }
    if (Date.parse(previous.expires_at) <= Date.now() || previous.result_json === null) {
      throw new PlanOperationError("plan_operation_expired", "原操作结果已过保留期，不能重新执行；请核对历史。", 410);
    }
    return { result: JSON.parse(previous.result_json) as Result };
  }

  private assertPublicationOperationScope(scope: string, operationId: string): void {
    if (this.controlDatabase!.prepare("SELECT 1 FROM mobile_plan_operations WHERE operation_id = ? AND scope != ?").get(operationId, scope)) {
      throw new PlanOperationError("plan_operation_scope_mismatch", "原操作属于其他服务或数据集，不能跨域重放。");
    }
  }

  publicationOperation<Result>(scope: string, operationId: string | undefined, route: string, input: unknown, action: () => Result): Result {
    if (!operationId) {
      // Legacy clients have no durable key, but their write still participates in
      // the cross-store guard so a reader can never observe a torn publication.
      if (!this.controlDatabase || this.publicationTransaction) return action();
      return this.withPublicationTransaction(() => action());
    }
    if (!this.controlDatabase) throw new PlanOperationError("plan_operations_unavailable", "当前存储不支持持久操作，请升级服务。", 503);
    if (this.publicationTransaction) throw new Error("Nested plan publication");
    const requestDigest = digest({ route, input });
    // Replay needs no write lock and must not bump the guard: the stored result is
    // immutable, so answering it is a read. The check is repeated inside the
    // transaction below to cover a foreign process committing the same key
    // between this read and the write lock.
    const replayed = this.replayPublicationResult<Result>(scope, operationId, requestDigest);
    if (replayed) return replayed.result;
    return this.withPublicationTransaction(() => {
      const concurrent = this.replayPublicationResult<Result>(scope, operationId, requestDigest);
      if (concurrent) return concurrent.result;
      const result = action();
      const expiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
      this.controlDatabase!.prepare("INSERT INTO mobile_plan_operations(scope, operation_id, request_digest, result_json, expires_at) VALUES (?,?,?,?,?)")
        .run(scope, operationId, requestDigest, JSON.stringify(result), expiresAt);
      this.controlDatabase!.prepare("UPDATE mobile_plan_operations SET result_json = NULL WHERE expires_at <= ?").run(new Date().toISOString());
      return result;
    });
  }

  /**
   * Read-only replay lookup for a durable operation (PR4-3).
   *
   * A retry of an already-committed operation must be answered with the stored
   * result BEFORE any freshness/precondition check: those checks compare against a
   * state that this very operation already changed, so running them first would
   * turn a safe retry into a revision conflict. The request digest is verified, so a
   * different payload under the same key still fails closed.
   */
  replayOperation<Result>(scope: string, operationId: string, route: string, input: unknown): Result | null {
    if (!this.controlDatabase) return null;
    const replayed = this.replayPublicationResult<Result>(scope, operationId, digest({ route, input }));
    return replayed?.result ?? null;
  }

  /** Retire tomorrow and later from legacy model weeks, without rewriting today's prescription. */
  retireLegacyModelPlan(today: string): MobileGoalsResponse {
    if (this.currentTrainingPlan() !== null) return this.read();
    if (!isValidLocalDate(today)) throw new MobileGoalsInputError("迁移日期无效");
    const current = this.readStored();
    if (current.weekPlanAudit?.generatedBy !== "llm") return this.toResponse(current);
    const hasToday = current.weekPlan.some(day => day.localDate === today);
    const needsRetirement = !current.weekPlanReplanRequired && current.weekPlan.some(day => day.localDate > today);
    // Protect a legacy day even with no future rows to retire, and backfill
    // already-retired payloads that did not carry a protection date.
    const needsProtection = current.weekPlanPreservedDate == null && hasToday;
    if (!needsRetirement && !needsProtection) return this.toResponse(current);
    if (!this.controlDatabase) {
      const backup = `${this.filePath}.llm-retired.bak`;
      if (!existsSync(backup)) copyFileSync(this.filePath, backup);
    }
    const retired: StoredGoals = {
      ...current,
      revision: current.revision + 1,
      weekPlan: current.weekPlan.filter(day => day.localDate <= today),
      weekPlanReplanRequired: current.weekPlanReplanRequired || needsRetirement,
      weekPlanPreservedDate: hasToday ? today : null,
      updatedAt: new Date().toISOString()
    };
    this.persistGoals(retired, current.revision);
    return this.toResponse(retired);
  }

  write(input: UpdateMobileGoalsInput, options?: PlanMergeOptions): MobileGoalsResponse {
    if (!this.publicationTransaction && this.currentTrainingPlan() !== null) {
      return this.withPublicationTransaction(() => this.write(input, options));
    }
    if (input.raceTarget !== undefined && input.raceTarget !== null &&
        !isValidLocalDate(input.raceTarget.date)) {
      throw new MobileGoalsInputError("raceTarget.date must be a real YYYY-MM-DD date");
    }
    const current = this.readStored();
    if (input.expectedRevision != null && input.expectedRevision !== current.revision) {
      throw new MobileGoalsRevisionConflictError(current.revision);
    }
    if (options?.confirmCoachPlan && (input.weekPlan === undefined || input.weekPlanAudit?.generatedBy !== "heuristic")) {
      throw new MobileGoalsInputError("确认课表必须提供规则教练方案");
    }
    const sessionCommand = options?.sessionCommand === true && this.publicationTransaction &&
      options.preserveWeekPlan === true && this.currentTrainingPlan()?.state.schemaVersion === 2;
    if (options?.sessionCommand === true && !sessionCommand) throw new MobileGoalsInputError("课程编辑需要统一课程发布事务");
    if (current.weekPlanReplanRequired && input.weekPlan !== undefined && !options?.confirmCoachPlan && !sessionCommand) {
      throw new WeeklyPlanConfirmationRequiredError();
    }
    const stored: StoredGoals = {
      revision: current.revision + 1,
      easyDurationFloorFraction:
        input.easyDurationFloorFraction == null
          ? current.easyDurationFloorFraction
          : clampFraction(input.easyDurationFloorFraction),
      qualitySessionCap:
        input.qualitySessionCap == null ? current.qualitySessionCap : clampCap(input.qualitySessionCap),
      raceTarget: input.raceTarget === undefined ? current.raceTarget : normalizeRaceTarget(input.raceTarget),
      // Merged rather than replaced: the goals editor only carries kind and
      // distance, so a blind replace would erase the generated structure (and
      // its tuned rep count) every time a user saves their weekly distance.
      weekPlan: input.weekPlan === undefined ? current.weekPlan
        : options?.preserveWeekPlan === true ? input.weekPlan.map(day => structuredClone(day))
          : normalizeWeekPlan(input.weekPlan, current.weekPlan, options),
      lockedSession:
        input.lockedSession === undefined
          ? current.lockedSession
          : normalizeLockedSession(input.lockedSession, options?.prescription),
      weekPlanAudit: input.weekPlanAudit === undefined ? current.weekPlanAudit : normalizePlanAudit(input.weekPlanAudit),
      weekPlanReplanRequired: input.weekPlanReplanRequired ??
        (options?.confirmCoachPlan ? false : current.weekPlanReplanRequired),
      weekPlanPreservedDate: current.weekPlanPreservedDate,
      runCoach: options?.runCoach === undefined ? current.runCoach : options.runCoach,
      updatedAt: options?.evaluatedAt ?? new Date().toISOString()
    };
    const validated = options?.validate?.(this.toResponse(stored, options));
    if (validated) stored.weekPlan = validated.weekPlan;
    this.persistGoals(stored, current.revision);
    return this.toResponse(stored, options);
  }

  private persistGoals(stored: StoredGoals, expectedRevision: number): void {
    // All legacy locks, commands and coordinator publications pass here. Include
    // staged owner decisions so the compatibility projection cannot hide a rest.
    const owner = this.currentTrainingPlan()?.state;
    const suppressions = this.stagedSessionFields?.suppressions ?? (owner?.schemaVersion === 2 ? owner.suppressions : []);
    assertGoalsLockedRestInvariant({ ...stored, suppressions });
    if (this.controlDatabase) {
      this.writeControlGoals(stored, expectedRevision);
    } else {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
        renameSync(temporary, this.filePath);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    this.cached = stored;
  }

  /** Measures the stored plan so the editor and the plan views show one number. */
  private toResponse(stored: StoredGoals, options?: PlanMergeOptions): MobileGoalsResponse {
    const prescription = options?.prescription;
    return {
      revision: stored.revision,
      easyDurationFloorFraction: stored.easyDurationFloorFraction,
      qualitySessionCap: stored.qualitySessionCap,
      raceTarget: stored.raceTarget,
      weekPlan: stored.weekPlan.map((day) => measurePlanDay(day, prescription)),
      lockedSession: measureLockedSession(stored.lockedSession, prescription),
      weekPlanAudit: stored.weekPlanAudit,
      weekPlanReplanRequired: stored.weekPlanReplanRequired,
      weekPlanPreservedDate: stored.weekPlanPreservedDate,
      runCoach: stored.runCoach,
      updatedAt: stored.updatedAt
    };
  }

  close(): void {
    this.controlDatabase?.close();
  }

  lockSession(locked: MobileLockedSession, options?: PlanMergeOptions): MobileGoalsResponse {
    return this.write({ lockedSession: locked }, options);
  }

  /**
   * The stored plan revisions, newest first.
   *
   * Segment reconstruction needs the plan *as it was*, not as it is: the runner
   * syncs tomorrow's session, runs it that same evening, and by the time the run
   * is imported the stored week may already have been regenerated for the next
   * Monday. Only the history table keeps the revision the watch actually got.
   */
  planHistory(limit = 20): PlanHistoryRevision[] {
    if (!this.controlDatabase) return [];
    // Stamped with the version read *before* the query, so a commit that lands
    // in between can only make the stamp look older than the rows — which costs
    // one extra refill, never a stale hit.
    const version = this.dataVersion();
    if (!this.planHistoryCache || this.planHistoryCache.dataVersion !== version) {
      this.planHistoryCache = { dataVersion: version, rows: this.readPlanHistory(MAX_READ_ROWS) };
    }
    return this.planHistoryCache.rows.slice(0, cappedReadLimit(limit));
  }

  /** Fills the history cache. The query is capped, so the cache always covers a bounded read. */
  private readPlanHistory(limit: number): PlanHistoryRevision[] {
    if (!this.controlDatabase) return [];
    const rows = this.controlDatabase
      .prepare("SELECT revision, payload_json, changed_at FROM mobile_goals_history ORDER BY revision DESC LIMIT ?")
      .all(limit) as Array<{
      revision: number;
      payload_json: string;
      changed_at: string;
    }>;
    return rows.flatMap((row) => {
      let parsed: Partial<StoredGoals>;
      try {
        parsed = JSON.parse(row.payload_json) as Partial<StoredGoals>;
      } catch {
        return [];
      }
      return [
        {
          revision: Number(row.revision),
          changedAt: String(row.changed_at),
          weekPlan: normalizeWeekPlan(Array.isArray(parsed.weekPlan) ? parsed.weekPlan : [], []),
          lockedSession: normalizeLockedSession(parsed.lockedSession ?? null)
        }
      ];
    });
  }

  /**
   * Registers the client-verified local system schedule for a plan day.
   *
   * This is a receipt, not a projection: the structure is stored exactly as the
   * phone reported it. Later edits to the week must not rewrite what was
   * executed, and the run's own date cannot identify the plan (the plan is
   * pushed for *tomorrow*), so the receipt is the only reliable link.
   */
  recordPlanPush(input: PlanPushRecord): string {
    if (!this.controlDatabase) return input.pushedAt;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate)) {
      throw new MobileGoalsInputError("localDate must be YYYY-MM-DD");
    }
    if (!SESSION_KINDS.has(input.kind)) throw new MobileGoalsInputError("kind is not a session kind");
    const isV2 = input.contractVersion === 2;
    // Identity is the system entry (UUID + instant), not its spelling. A v2
    // receipt is stored canonically and every predicate below compares canonically
    // — see `canonicalPlanPushIdentity` for why the two spellings must be one row.
    const canonicalWorkoutID = canonicalPlanWorkoutID(input.workoutID);
    const canonicalScheduledAt = canonicalPlanScheduledAt(input.scheduledAt);
    if (isV2 && canonicalWorkoutID === null) {
      throw new PlanOperationError("plan_receipt_contract_mismatch", "新版回执的系统条目 ID 不是合法 UUID。", 422);
    }
    if (isV2 && canonicalScheduledAt === null) {
      throw new PlanOperationError("plan_receipt_date_invalid", "新版回执的计划时刻不是可解析的 ISO 时间。", 422);
    }
    if (isV2 && !input.lifecycleEvent) {
      throw new PlanOperationError("plan_receipt_contract_mismatch", "新版回执缺少生命周期事件。", 422);
    }
    if (isV2 && !input.scope) {
      // Without a dataset identity a v2 key would fall into the legacy global
      // partition, where two datasets would silently share one receipt.
      throw new PlanOperationError("plan_receipt_contract_mismatch", "新版回执缺少数据集身份。", 422);
    }
    const normalizedStructure = isV2 ? normalizeSessionStructure(input.structure) : input.structure;
    if (isV2 && normalizedStructure === null) {
      throw new PlanOperationError("plan_receipt_evidence_mismatch", "新版回执缺少可规范化的实际导出结构。", 422);
    }
    const stored: PlanPushRecord = isV2
      ? { ...input, workoutID: canonicalWorkoutID!, scheduledAt: canonicalScheduledAt!, structure: normalizedStructure }
      : input;
    const identity = canonicalPlanPushIdentity({ workoutID: stored.workoutID, scheduledAt: stored.scheduledAt });
    const scopeKey = planPushScopeKey(stored.scope);
    const { localDate: _date, revision: _revision, kind: _kind, pushedAt: _at, ...payload } = stored;
    const revision = Number.isFinite(stored.revision) ? Math.max(0, Math.round(stored.revision)) : 0;
    // Serialise lookup + insert even if another process owns the same control
    // database. A unique index alone would turn a concurrent retry into a 500.
    const ownsTransaction = !this.publicationTransaction;
    if (ownsTransaction) {
      try {
        this.controlDatabase.exec("BEGIN IMMEDIATE");
      } catch (error) {
        throw mapDatabaseBusy(error);
      }
    }
    try {
      if (isV2) {
        const previous = this.controlDatabase.prepare(`
          SELECT local_date, kind, revision, payload_json FROM mobile_plan_pushes
          WHERE workout_id = ? AND scheduled_at = ? LIMIT 1
        `).get(identity.workoutID!, identity.scheduledAt!) as
          { local_date: string; kind: string; revision: number; payload_json: string } | undefined;
        if (previous) {
          const actual = JSON.parse(previous.payload_json) as PlanPushRecord;
          if (previous.local_date !== input.localDate || previous.kind !== input.kind || previous.revision !== revision ||
              digest(actual.scope) !== digest(input.scope) ||
              actual.prescriptionDigest !== input.prescriptionDigest ||
              !isDeepStrictEqual(normalizeSessionStructure(actual.structure), normalizedStructure) ||
              !isDeepStrictEqual(actual.coachLoop, input.coachLoop)) {
            throw new PlanOperationError("plan_receipt_key_conflict", "相同系统条目不能登记不同的实际导出内容。");
          }
        }
      }
      if (input.idempotencyKey) {
        // The key is unique per scope: a restored/emptied control database is a
        // different dataset, so the same client key is not a retry there. Legacy
        // receipts never carried a scope and keep the historical global behaviour
        // among themselves (`scope_key IS NULL`).
        const previous = this.controlDatabase.prepare(`
          SELECT local_date, revision, kind, payload_json, pushed_at FROM mobile_plan_pushes
          WHERE idempotency_key = ? AND scope_key IS ? LIMIT 1
        `).get(input.idempotencyKey, scopeKey) as
          { local_date: string; revision: number; kind: string; payload_json: string; pushed_at: string } | undefined;
        if (previous) {
          if (isV2) {
            const original = JSON.parse(previous.payload_json) as PlanPushRecord;
            const originalIdentity = canonicalPlanPushIdentity(original);
            if (previous.local_date !== input.localDate || previous.revision !== revision || previous.kind !== input.kind ||
                originalIdentity.workoutID !== identity.workoutID || originalIdentity.scheduledAt !== identity.scheduledAt ||
                original.lifecycleEvent !== input.lifecycleEvent || original.prescriptionDigest !== input.prescriptionDigest ||
                !isDeepStrictEqual(normalizeSessionStructure(original.structure), normalizedStructure)) {
              throw new PlanOperationError("plan_receipt_key_conflict", "同一回执键不能改变实际导出内容或生命周期事件。");
            }
            if (ownsTransaction) this.controlDatabase.exec("COMMIT");
            return previous.pushed_at;
          }
          const previousPayload = JSON.parse(previous.payload_json);
          delete previousPayload.matchesCurrent;
          const { matchesCurrent: _matches, ...actualPayload } = payload;
          if (previous.local_date !== input.localDate || previous.revision !== revision ||
              previous.kind !== input.kind || !isDeepStrictEqual(previousPayload, actualPayload)) {
            throw new MobileGoalsInputError("idempotencyKey was already used for a different system schedule receipt");
          }
          if (ownsTransaction) this.controlDatabase.exec("COMMIT");
          return previous.pushed_at;
        }
      }
      if (isV2) {
        // Same entry, same event, same day, same dataset: a lost reply is a retry.
        // Both the date and the scope belong to the identity; the old query only
        // compared UUID + instant + event, so a receipt for another day (or the
        // same UUID in a replaced dataset) was silently treated as this one.
        const repeated = this.controlDatabase.prepare(`
          SELECT pushed_at FROM mobile_plan_pushes
          WHERE workout_id = ? AND scheduled_at = ? AND local_date = ? AND scope_key IS ?
            AND json_valid(payload_json) AND json_extract(payload_json, '$.lifecycleEvent') = ? LIMIT 1
        `).get(identity.workoutID!, identity.scheduledAt!, input.localDate, scopeKey, input.lifecycleEvent ?? null) as
          { pushed_at: string } | undefined;
        if (repeated) { if (ownsTransaction) this.controlDatabase.exec("COMMIT"); return repeated.pushed_at; }
      }
      this.controlDatabase
        .prepare(`
          INSERT INTO mobile_plan_pushes
            (local_date, revision, kind, payload_json, pushed_at, scope_key, idempotency_key, workout_id, scheduled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.localDate,
          revision,
          input.kind,
          JSON.stringify(payload),
          input.pushedAt,
          scopeKey,
          typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : null,
          identity.workoutID,
          identity.scheduledAt
        );
      if (ownsTransaction) this.controlDatabase.exec("COMMIT");
      this.invalidateReadCaches();
      return input.pushedAt;
    } catch (error) {
      if (ownsTransaction) { try { this.controlDatabase.exec("ROLLBACK"); } catch { /* already rolled back */ } }
      // A foreign process can win the (scope, idempotencyKey) race between the
      // lookup above and this insert; that is the same conflict, not a 500.
      if (!isDatabaseBusyError(error) && error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
        throw new PlanOperationError("plan_receipt_key_conflict", "同一回执键已用于不同内容。");
      }
      throw mapDatabaseBusy(error);
    }
  }

  planPushIsActive(workoutID: string, scheduledAt: string): boolean {
    if (!this.controlDatabase) return true;
    const identity = canonicalPlanPushIdentity({ workoutID, scheduledAt });
    if (identity.workoutID === null || identity.scheduledAt === null) return true;
    return !this.controlDatabase.prepare(`
      SELECT 1 FROM mobile_plan_pushes
      WHERE workout_id = ? AND scheduled_at = ?
        AND json_valid(payload_json) AND json_extract(payload_json, '$.lifecycleEvent') IN ('withdrawn','replaced') LIMIT 1
    `).get(identity.workoutID, identity.scheduledAt);
  }

  /** Push receipts at or after `sinceIso`, newest first. */
  planPushes(sinceIso: string, limit = 50): PlanPushRecord[] {
    return this.allPlanPushes().filter(push => push.pushedAt >= sinceIso).slice(0, cappedReadLimit(limit));
  }

  /** Safety occupancy cannot use a presentation/history LIMIT: an older active
   * system entry does not disappear when unrelated receipts arrive. */
  activePlanPushes(): PlanPushRecord[] {
    return this.allPlanPushes().filter(push => push.kind !== "rest" &&
      (push.lifecycleEvent == null || push.lifecycleEvent === "verified") &&
      (!push.workoutID || !push.scheduledAt || this.planPushIsActive(push.workoutID, push.scheduledAt)));
  }

  planPushForSystemEntry(workoutID: string, scheduledAt: string): PlanPushRecord | null {
    const target = canonicalPlanPushIdentity({ workoutID, scheduledAt });
    if (target.workoutID === null || target.scheduledAt === null) return null;
    return this.allPlanPushes().find(push => {
      if (push.lifecycleEvent != null && push.lifecycleEvent !== "verified") return false;
      const identity = canonicalPlanPushIdentity(push);
      return identity.workoutID === target.workoutID && identity.scheduledAt === target.scheduledAt;
    }) ?? null;
  }

  private allPlanPushes(): PlanPushRecord[] {
    if (!this.controlDatabase) return [];
    const version = this.dataVersion();
    if (!this.planPushCache || this.planPushCache.dataVersion !== version) {
      this.planPushCache = { dataVersion: version, rows: this.readPlanPushes() };
    }
    // Filtered in memory rather than in SQL. The query's `LIMIT` applies *after*
    // its `WHERE`, so a cache bounded to `limit` rows reproduces it only while
    // `pushed_at` never goes backwards across inserts — the column is
    // caller-supplied, so that is not a safe thing to build on. Keeping every
    // receipt removes the case entirely, and the table gains about one row a day
    // (one per plan sync), so "every receipt" stays small.
    return this.planPushCache.rows;
  }

  /** Fills the push cache. Every receipt is kept — see `planPushes` for why no limit. */
  private readPlanPushes(): PlanPushRecord[] {
    if (!this.controlDatabase) return [];
    const rows = this.controlDatabase
      .prepare(`
        SELECT local_date, revision, kind, payload_json, pushed_at
        FROM mobile_plan_pushes
        ORDER BY pushed_at DESC
      `)
      .all() as Array<{
      local_date: string;
      revision: number;
      kind: string;
      payload_json: string;
      pushed_at: string;
    }>;
    return rows.flatMap((row) => {
      if (!SESSION_KINDS.has(row.kind as MobileSessionKind)) return [];
      let parsed: Omit<PlanPushRecord, "localDate" | "kind" | "revision" | "pushedAt">;
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        return [];
      }
      return [
        {
          ...parsed,
          localDate: row.local_date,
          revision: Number(row.revision),
          kind: row.kind as MobileSessionKind,
          structure: parsed.contractVersion === 2 ? parsed.structure : normalizeSessionStructure(parsed.structure),
          pushedAt: row.pushed_at,
          ...(parsed.workoutID !== undefined ? { workoutID: parsed.workoutID } : {}),
          ...(parsed.scheduledAt !== undefined ? { scheduledAt: parsed.scheduledAt } : {}),
          ...(parsed.idempotencyKey !== undefined ? { idempotencyKey: parsed.idempotencyKey } : {}),
          ...(parsed.exportNotes !== undefined ? { exportNotes: parsed.exportNotes } : {})
        }
      ];
    });
  }

  /**
   * The version of the control database as *this* connection last saw it.
   *
   * SQLite bumps it for every commit made by another connection and leaves it
   * alone for this connection's own — which is exactly the split the cache needs:
   * the probe covers foreign writers, {@link invalidateReadCaches} covers this
   * store's writes, and neither alone would be enough.
   */
  private dataVersion(): number {
    const row = this.controlDatabase?.prepare("PRAGMA data_version").get() as { data_version?: number } | undefined;
    return Number(row?.data_version ?? 0);
  }

  /**
   * Drops the parsed read caches; every write path that this store performs on
   * the control database calls this, since the version probe cannot see it.
   *
   * Coarse on purpose: a cache miss costs the parse, and the one caller of these
   * tables reads both of them together, so tracking which table a given write
   * touched would buy nothing but a chance to forget one.
   */
  private invalidateReadCaches(): void {
    this.planHistoryCache = null;
    this.planPushCache = null;
  }

  private loadFile(): StoredGoals {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredGoals>;
      const floor = Number(parsed.easyDurationFloorFraction);
      const cap = Number(parsed.qualitySessionCap);
      return {
        revision: Number.isInteger(parsed.revision) && Number(parsed.revision) >= 0 ? Number(parsed.revision) : 0,
        easyDurationFloorFraction: Number.isFinite(floor) ? clampFraction(floor) : DEFAULT_EASY_DURATION_FLOOR,
        qualitySessionCap: Number.isFinite(cap) ? clampCap(cap) : DEFAULT_QUALITY_SESSION_CAP,
        raceTarget: normalizeRaceTarget(parsed.raceTarget ?? null),
        weekPlan: normalizeWeekPlan(Array.isArray(parsed.weekPlan) ? parsed.weekPlan : [], []),
        lockedSession: normalizeLockedSession(parsed.lockedSession ?? null),
        weekPlanAudit: normalizePlanAudit(parsed.weekPlanAudit ?? null),
        weekPlanReplanRequired: parsed.weekPlanReplanRequired === true,
        weekPlanPreservedDate: normalizePreservedDate(parsed.weekPlanPreservedDate),
        runCoach: normalizeRunCoachPlan(parsed.runCoach),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
      };
    } catch {
      return emptyGoals();
    }
  }

  private readStored(): StoredGoals {
    return this.controlDatabase
      ? this.readControlGoals()
      : (existsSync(this.filePath) ? this.loadFile() : emptyGoals());
  }

  private openControlDatabase(path: string): DatabaseSync {
    mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      -- The control database is a single-writer store: every write is a short
      -- synchronous transaction on this process's event loop, and the only other
      -- writers are tests, a CLI or a second API process. A shorter timeout keeps
      -- that contention bounded instead of stalling the whole server for 5 s.
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS mobile_goals (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mobile_goals_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mobile_plan_pushes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_date TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        pushed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mobile_plan_operations (
        scope TEXT NOT NULL, operation_id TEXT NOT NULL, request_digest TEXT NOT NULL,
        result_json TEXT, expires_at TEXT NOT NULL, PRIMARY KEY(scope, operation_id)
      );
      CREATE TABLE IF NOT EXISTS mobile_coach_loop_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
        operation_id TEXT NOT NULL, payload_json TEXT NOT NULL,
        UNIQUE(scope,operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mobile_plan_pushes_pushed_at
        ON mobile_plan_pushes(pushed_at);
    `);
    // Versioned control-schema migrations. The old global receipt-idempotency
    // index and the derived identity columns are created/backfilled there, so an
    // existing database keeps its receipts instead of being recreated.
    this.ensureControlSchema(database);
    ensurePublicationGuardSchema(database);
    // A marker left by a crashed/killed publisher is not a live publication: no
    // publication can be in flight before this process opened the database (the
    // API holds the publication lock for its lifetime). Clear it so a quick
    // restart does not answer guarded plan reads with 503 for the full lease;
    // the epoch is preserved for post-restart comparisons (review P3-14).
    clearPublicationMarkerOnStartup(database);
    const existing = database.prepare("SELECT revision FROM mobile_goals WHERE singleton = 1").get();
    if (!existing) {
      let initial = emptyGoals();
      if (existsSync(this.filePath)) {
        let parsed: Partial<StoredGoals>;
        try {
          parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredGoals>;
        } catch (error) {
          database.close();
          throw new Error(`mobile-goals.json 迁移失败：文件损坏（${error instanceof Error ? error.message : "JSON 无效"}）`);
        }
        // The migration used to be gated on `weeklyDistanceKm` being a finite
        // number. That field is gone, so `revision` takes over as the probe: a
        // real payload always carries it, and without a check a truncated or
        // unrelated JSON would migrate silently as a fresh install.
        if (!Number.isInteger(parsed.revision) || Number(parsed.revision) < 0) {
          database.close();
          throw new Error("mobile-goals.json 迁移失败：revision 无效");
        }
        try { assertGoalsLockedRestInvariant(parsed); }
        catch (error) { database.close(); throw error; }
        initial = {
          revision: 0,
          easyDurationFloorFraction: Number.isFinite(Number(parsed.easyDurationFloorFraction)) ? clampFraction(Number(parsed.easyDurationFloorFraction)) : DEFAULT_EASY_DURATION_FLOOR,
          qualitySessionCap: Number.isFinite(Number(parsed.qualitySessionCap)) ? clampCap(Number(parsed.qualitySessionCap)) : DEFAULT_QUALITY_SESSION_CAP,
          raceTarget: normalizeRaceTarget(parsed.raceTarget ?? null),
          weekPlan: normalizeWeekPlan(Array.isArray(parsed.weekPlan) ? parsed.weekPlan : [], []),
          lockedSession: normalizeLockedSession(parsed.lockedSession ?? null),
          weekPlanAudit: normalizePlanAudit(parsed.weekPlanAudit ?? null),
          weekPlanReplanRequired: parsed.weekPlanReplanRequired === true,
          weekPlanPreservedDate: normalizePreservedDate(parsed.weekPlanPreservedDate),
          runCoach: normalizeRunCoachPlan(parsed.runCoach),
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
        };
        const backup = `${this.filePath}.migrated.bak`;
        if (!existsSync(backup)) copyFileSync(this.filePath, backup);
      }
      const payload = JSON.stringify({
        easyDurationFloorFraction: initial.easyDurationFloorFraction,
        qualitySessionCap: initial.qualitySessionCap,
        raceTarget: initial.raceTarget,
        weekPlan: initial.weekPlan,
        lockedSession: initial.lockedSession,
        weekPlanAudit: initial.weekPlanAudit,
        weekPlanReplanRequired: initial.weekPlanReplanRequired,
        weekPlanPreservedDate: initial.weekPlanPreservedDate,
        runCoach: initial.runCoach
      });
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("INSERT INTO mobile_goals (singleton, revision, payload_json, updated_at) VALUES (1, ?, ?, ?)").run(initial.revision, payload, initial.updatedAt);
        database.prepare("INSERT INTO mobile_goals_history (revision, payload_json, changed_at) VALUES (?, ?, ?)").run(initial.revision, payload, initial.updatedAt);
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* preserve the migration error */ }
        database.close();
        throw error;
      }
      if (existsSync(this.filePath)) {
        writeFileSync(`${this.filePath}.migration-complete`, `${new Date().toISOString()}\n`, "utf8");
      }
      // The seed is a write too, so it follows the same rule as every other one.
      // It cannot actually have filled a cache yet (this runs during
      // construction), but keeping the rule exceptionless is what stops a later
      // re-open path from leaking a revision that predates the seed.
      this.invalidateReadCaches();
    }
    return database;
  }

  /**
   * Applies versioned control-schema migrations in order.
   *
   * The control database is created by whichever build opened it first, so a
   * new column or index has to be added in place: deleting/recreating the table
   * would lose the publication results, plan history and receipts that are the
   * whole point of the store. Each step runs in its own write transaction and is
   * recorded, and every step is written so that re-running it (e.g. a database
   * restored from a backup taken mid-migration) is a no-op.
   */
  private ensureControlSchema(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS mobile_control_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM mobile_control_schema").get() as
      { version: number } | undefined;
    const applied = Number(row?.version ?? 0);
    const migrations: Array<{ version: number; apply: () => void }> = [
      { version: 1, apply: () => this.migratePlanPushIdentity(database) },
      // Version 2 is the next free number (nothing above 1 existed in the file or
      // in any control database when it was added); `applied` above is still the
      // runtime source of truth, so a restored/older database only runs what it
      // has not recorded yet.
      { version: 2, apply: () => this.migrateTrainingPlanState(database) },
      // B02: append-only identity history; no runtime data migration or capability enablement.
      { version: 3, apply: () => ensureTrainingPlanSessionSchema(database) },
      // B06: current execution link + append-only execution revisions.
      { version: 4, apply: () => ensureTrainingPlanExecutionSchema(database) },
      // B08: one per-scope evaluation cursor (not a task queue).
      { version: 5, apply: () => ensureTrainingPlanEvaluationSchema(database) }
    ];
    for (const migration of migrations) {
      if (migration.version <= applied) continue;
      database.exec("BEGIN IMMEDIATE");
      try {
        migration.apply();
        database.prepare("INSERT INTO mobile_control_schema(version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
        throw error;
      }
    }
  }

  /**
   * Migration 1: canonical receipt identity columns and per-scope idempotency.
   *
   * Before this, lookups used `json_extract(payload_json, '$.workoutID')`, so
   * two spellings of the same UUID/instant were two different system entries,
   * and the receipt idempotency key was globally unique, so the same key could
   * not be reused by a different dataset. The derived columns become the query
   * surface; the old payload remains the record, except for contract-v2 rows
   * whose identity is rewritten to the canonical spelling (v1 rows keep their
   * bytes because their deduplication is a byte comparison by contract).
   */
  private migratePlanPushIdentity(database: DatabaseSync): void {
    const columns = new Set((database.prepare("PRAGMA table_info(mobile_plan_pushes)").all() as Array<{ name: string }>)
      .map(column => column.name));
    for (const [name, type] of [["scope_key", "TEXT"], ["idempotency_key", "TEXT"], ["workout_id", "TEXT"], ["scheduled_at", "TEXT"]] as const) {
      if (!columns.has(name)) database.exec(`ALTER TABLE mobile_plan_pushes ADD COLUMN ${name} ${type}`);
    }
    database.exec("DROP INDEX IF EXISTS idx_mobile_plan_pushes_idempotency");
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_plan_pushes_scope_idempotency
        ON mobile_plan_pushes(scope_key, idempotency_key)
        WHERE scope_key IS NOT NULL AND idempotency_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_plan_pushes_unscoped_idempotency
        ON mobile_plan_pushes(idempotency_key)
        WHERE scope_key IS NULL AND idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_mobile_plan_pushes_workout
        ON mobile_plan_pushes(workout_id, scheduled_at);
    `);
    const rows = database.prepare("SELECT id, payload_json FROM mobile_plan_pushes").all() as
      Array<{ id: number; payload_json: string }>;
    const update = database.prepare(`
      UPDATE mobile_plan_pushes
      SET payload_json = ?, scope_key = ?, idempotency_key = ?, workout_id = ?, scheduled_at = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const contractVersion = parsed.contractVersion;
      const canonicalWorkoutID = canonicalPlanWorkoutID(parsed.workoutID);
      const canonicalScheduledAt = canonicalPlanScheduledAt(parsed.scheduledAt);
      const workoutID = canonicalWorkoutID ?? (typeof parsed.workoutID === "string" ? parsed.workoutID : null);
      const scheduledAt = canonicalScheduledAt ?? (typeof parsed.scheduledAt === "string" ? parsed.scheduledAt : null);
      const scopeKey = planPushScopeKey(parsed.scope as PlanPushRecord["scope"]);
      const idempotencyKey = typeof parsed.idempotencyKey === "string" ? parsed.idempotencyKey : null;
      let payload = row.payload_json;
      if (contractVersion === 2 && (workoutID !== parsed.workoutID || scheduledAt !== parsed.scheduledAt)) {
        payload = JSON.stringify({
          ...parsed,
          ...(workoutID !== null ? { workoutID } : {}),
          ...(scheduledAt !== null ? { scheduledAt } : {})
        });
      }
      update.run(payload, scopeKey, idempotencyKey, workoutID, scheduledAt, row.id);
    }
  }

  /**
   * Migration 2: the unified training-state tables (PR3 first slice).
   *
   * Add-only. The state, its history and the data-migration audit live beside the
   * legacy rows, which are neither rewritten nor deleted: `mobile_goals`,
   * `mobile_goals_history`, `mobile_plan_pushes`, `mobile_plan_operations` and
   * `mobile_coach_loop_receipts` keep their exact identity, so the migration can
   * be developed and rolled back without losing a receipt. The DDL is
   * `IF NOT EXISTS` (see `training-plan-store.ts`) because the operator CLI may
   * have created the same tables before this process restarted.
   */
  private migrateTrainingPlanState(database: DatabaseSync): void {
    ensureTrainingPlanSchema(database);
  }

  /**
   * A schema-2 unified scope must read its materialized week byte-for-byte. The
   * legacy normalize path is a v1 compatibility adapter; using it here would drop
   * `reason:null` (and potentially reshape a protected prescription) and make the
   * compatibility projection disagree with the frozen session identity.
   */
  private preserveUnifiedWeekPlan(): boolean {
    if (!this.trainingIdentity) return false;
    try { return this.currentTrainingPlan()?.state.schemaVersion === 2; } catch { return false; }
  }

  private readControlGoals(): StoredGoals {
    const row = this.controlDatabase?.prepare("SELECT revision, payload_json, updated_at FROM mobile_goals WHERE singleton = 1").get() as { revision: number; payload_json: string; updated_at: string } | undefined;
    if (!row) return emptyGoals();
    // Normalized on the way out as well as on the way in: a row written by an
    // older build has no `weekPlanAudit` (nor `structure`/`reason` on its plan
    // days), and the response type promises `null` — never a missing key.
    const parsed = JSON.parse(row.payload_json) as Partial<StoredGoals>;
    const rawWeekPlan = Array.isArray(parsed.weekPlan) ? parsed.weekPlan : [];
    return {
      revision: Number(row.revision),
      easyDurationFloorFraction: Number.isFinite(Number(parsed.easyDurationFloorFraction)) ? clampFraction(Number(parsed.easyDurationFloorFraction)) : DEFAULT_EASY_DURATION_FLOOR,
      qualitySessionCap: Number.isFinite(Number(parsed.qualitySessionCap)) ? clampCap(Number(parsed.qualitySessionCap)) : DEFAULT_QUALITY_SESSION_CAP,
      raceTarget: normalizeRaceTarget(parsed.raceTarget ?? null),
      weekPlan: this.preserveUnifiedWeekPlan() ? rawWeekPlan.map(day => parseSessionPrescription(day)) : normalizeWeekPlan(rawWeekPlan, []),
      lockedSession: normalizeLockedSession(parsed.lockedSession ?? null),
      weekPlanAudit: normalizePlanAudit(parsed.weekPlanAudit ?? null),
      weekPlanReplanRequired: parsed.weekPlanReplanRequired === true,
      weekPlanPreservedDate: normalizePreservedDate(parsed.weekPlanPreservedDate),
      runCoach: normalizeRunCoachPlan(parsed.runCoach),
      updatedAt: row.updated_at
    };
  }

  private writeControlGoals(stored: StoredGoals, expectedRevision: number): void {
    if (!this.controlDatabase) return;
    const payload = JSON.stringify({
      easyDurationFloorFraction: stored.easyDurationFloorFraction,
      qualitySessionCap: stored.qualitySessionCap,
      raceTarget: stored.raceTarget,
      weekPlan: stored.weekPlan,
      lockedSession: stored.lockedSession,
      weekPlanAudit: stored.weekPlanAudit,
      weekPlanReplanRequired: stored.weekPlanReplanRequired,
      weekPlanPreservedDate: stored.weekPlanPreservedDate,
      runCoach: stored.runCoach
    });
    const ownsTransaction = !this.publicationTransaction;
    if (ownsTransaction) {
      try {
        this.controlDatabase.exec("BEGIN IMMEDIATE");
      } catch (error) {
        throw mapDatabaseBusy(error);
      }
    }
    try {
      const result = this.controlDatabase.prepare(`
        UPDATE mobile_goals SET revision = ?, payload_json = ?, updated_at = ?
        WHERE singleton = 1 AND revision = ?
      `).run(stored.revision, payload, stored.updatedAt, expectedRevision);
      if (Number(result.changes) !== 1) {
        throw new MobileGoalsRevisionConflictError(this.readControlGoals().revision);
      }
      this.controlDatabase.prepare("INSERT INTO mobile_goals_history (revision, payload_json, changed_at) VALUES (?, ?, ?)").run(stored.revision, payload, stored.updatedAt);
      if (ownsTransaction) this.controlDatabase.exec("COMMIT");
      // After the commit, never before: a rolled-back write must leave the cache
      // exactly as it was, so the only reads the cache can be stale for are the
      // committed ones it is invalidated for.
      this.invalidateReadCaches();
    } catch (error) {
      if (ownsTransaction) { try { this.controlDatabase.exec("ROLLBACK"); } catch { } }
      throw mapDatabaseBusy(error);
    }
  }
}

export class WeeklyPlanConfirmationRequiredError extends Error {
  readonly code = "weekly_plan_confirmation_required";
  readonly statusCode = 409;
  constructor() {
    super("旧模型课表的未来安排已停用，请先预览并确认规则教练课表。");
    this.name = "WeeklyPlanConfirmationRequiredError";
  }
}

export class MobileGoalsRevisionConflictError extends Error {
  readonly code = "mobile_goals_revision_conflict";
  /**
   * Without a status this error was mapped to 500 `internal_error` on every
   * route that did not catch it explicitly. A stale revision is a normal
   * concurrency outcome, so the class itself carries 409 as the floor; routes
   * that want to add `currentRevision` still catch it explicitly.
   */
  readonly statusCode = 409;
  constructor(readonly currentRevision: number) {
    super("训练目标已在其他页面更新，请重新加载后再保存");
  }
}

/**
 * The control database was locked by another writer for the whole busy timeout.
 *
 * This is a transient contention outcome, not a server fault: the publication
 * either did not start (the write lock could not be taken) or rolled back. It is
 * deliberately retryable — a 500 here both lied about what happened and gave the
 * client no code to branch on. The status is 503 because the request can be
 * retried unchanged; unlike a 409 it must not clear a pending publication.
 */
export class MobileGoalsDatabaseBusyError extends Error {
  readonly statusCode = 503;
  readonly code = "database_busy";
  constructor() {
    super("训练计划存储正忙，请稍后重试；本次写入未提交。");
    this.name = "MobileGoalsDatabaseBusyError";
  }
}

/**
 * The store was handed goals or a receipt it cannot store.
 *
 * This exists to carry a status. A bare `RangeError` is read by `apiErrorPayload`
 * as "no status ⇒ 500", which answers the client with the generic
 * `internal_error` message and nothing else — so a request would fail with no
 * way to tell a malformed body from a broken server. The routes' JSON schemas
 * already reject both of these shapes, which is exactly why the guard is a
 * backstop: a backstop that reports itself as an internal fault is worse than
 * useless the day it fires.
 */
export class MobileGoalsInputError extends Error {
  readonly statusCode = 400;
  readonly code = "invalid_mobile_goals_input";
}

function normalizeRaceTarget(value: MobileRaceTarget | null | undefined): MobileRaceTarget | null {
  if (!value || typeof value !== "object") return null;
  if (!isValidLocalDate(value.date)) return null;
  if (!RACE_DISTANCES.has(value.distance)) return null;
  const pace = value.targetPaceSecondsPerKm;
  return {
    date: value.date,
    distance: value.distance,
    targetPaceSecondsPerKm:
      pace == null || !Number.isFinite(pace) || pace < 150 || pace > 900 ? null : pace
  };
}

/**
 * Normalizes a client-supplied plan.
 *
 * A day is defined by its structure, so this function decides **which**
 * structure the day owns before deciding what its distance is:
 *
 *   1. a structure that is the stored day's own structure, sent for a different
 *      kind, is discarded — stale by construction, because the goals editor
 *      echoes back whatever it loaded, so a kind change would otherwise persist
 *      an easy prescription under a tempo label (the day is rebuilt from its new
 *      kind instead). A structure that differs from the stored one is trusted:
 *      that is a prescription built for the new kind;
 *   2. a distance the store has never seen, sent with no structure for a
 *      target-sized kind (`easy`/`recovery`/`long_run`), is a request to rebuild
 *      at that size — that is what the editor sends when the runner edits the
 *      distance, and inheriting the stored structure would make the field
 *      silently ineffective. A fixed-dose quality day keeps its prescription,
 *      because no distance can reshape it;
 *   3. otherwise the stored day's structure for the same date **and** kind is
 *      inherited, so a plain goals edit cannot downgrade a generated
 *      prescription;
 *   4. with nothing to inherit, the structure is materialized from the day's
 *      kind and the live prescription — the same structure `plannedDayNumbers`
 *      would build on the way out.
 *
 * The distance then follows from that structure rather than from the client: it
 * is a property of what the watch will execute. Keeping both was the defect this
 * function used to have — the editor wrote a distance, the generator wrote a
 * structure, and the two endpoints rendered one each. Order:
 *
 *   1. a prescription        - the structure is measured; the normal path, and it
 *                              pulls days written before this rule into line
 *   2. no structure at all   - the hint is all there is
 *   3. the prior day holds the very same structure
 *                            - keep its distance, which describes this structure
 *   4. otherwise             - the hint, as the only remaining number
 *
 * A rest day stores no distance and no structure: it has none, and every reader
 * measures one anyway.
 */
function normalizeWeekPlan(
  value: MobilePlannedDay[],
  previous: MobilePlannedDay[],
  options?: PlanMergeOptions
): MobileGoalsResponse["weekPlan"] {
  const prescription = options?.prescription;
  return value.flatMap((item) => {
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(item.localDate)) return [];
    if (!SESSION_KINDS.has(item.kind)) return [];
    const hint = item.distanceKm;
    const clientDistance =
      hint == null || !Number.isFinite(hint) ? null : Math.min(MAX_PLANNED_DISTANCE_KM, Math.max(0, hint));
    // The stored day is the fallback for every field the editor does not own.
    const prior = previous.find((entry) => entry.localDate === item.localDate && entry.kind === item.kind);
    const sameDate = previous.find((entry) => entry.localDate === item.localDate);
    const suppliedStructure = normalizeSessionStructure(item.structure);
    // A structure belongs to the kind it was generated for. The goals editor
    // echoes back whatever it loaded while the user may have changed the kind,
    // so a structure arriving for a date whose stored kind differs is stale by
    // construction: keeping it would persist e.g. an easy prescription labelled
    // tempo. It is dropped and rebuilt from the new kind instead.
    // A structure is stale when it is *the stored day's own structure* sent back
    // for a different kind — which is exactly what the goals editor does, since
    // it copies the item it loaded. Comparing the two is what separates that
    // echo from a prescription deliberately built for the new kind (the weekly
    // generator replaces a day's kind and sends a structure to match it); a
    // blanket "kind changed, drop it" would rebuild those with the default dose
    // and disagree with the response the generator just returned.
    const staleEcho =
      sameDate != null &&
      sameDate.kind !== item.kind &&
      suppliedStructure != null &&
      sameDate.structure != null &&
      sameStructure(sameDate.structure, suppliedStructure);
    const trustedStructure = staleEcho ? null : suppliedStructure;
    // A distance the store has never seen, sent without a structure, is a
    // request to rebuild the day at that size — that is what the goals editor
    // sends when the runner edits the distance field. Only a kind whose
    // prescription is sized by a target can honour it; for a fixed-dose quality
    // day the stored structure is kept and the typed number stays a hint, which
    // is what the field's own validation ("0–80 km, blank for unset") implies.
    const distanceChanged =
      clientDistance != null && prior?.distanceKm != null && clientDistance !== prior.distanceKm;
    const rebuildAtHint = distanceChanged && TARGET_SIZED_KINDS.has(item.kind);
    const stored = trustedStructure ?? (rebuildAtHint ? null : (prior?.structure ?? null));
    // Materialized only when the live prescription allows it, and never for a
    // rest day: `plannedDayNumbers` reports no structure for rest either, and the
    // write side has to agree with the read side about what the day contains.
    const planned =
      stored ??
      (prescription !== undefined && item.kind !== "rest"
        ? buildSessionStructure(item.kind, prescription, { targetDistanceKm: clientDistance })
        : null);
    // Capped by measurement, not by the field bounds `normalizeSessionStructure`
    // enforces: a structure may satisfy every one of them and still describe a
    // 2000 km run. Done before any distance is derived from it, so the number and
    // the prescription cannot disagree — and before it is stored, so the ceiling
    // binds the write as well as what the plan views render.
    const structure =
      planned == null ? null : capStructureToDayCeiling(planned, item.kind, prescription ?? null);
    let distanceKm: number | null;
    if (item.kind === "rest") {
      distanceKm = null;
    } else if (prescription !== undefined && structure != null) {
      distanceKm = roundKm(measureStructure(structure, item.kind, pacesFromZones(prescription)).distanceKm);
    } else if (structure == null) {
      distanceKm = clientDistance;
    } else if (prior?.structure != null && sameStructure(prior.structure, structure)) {
      // The prior value describes exactly this structure, so it is the best
      // available number; the client's hint does not describe it at all.
      distanceKm = prior.distanceKm ?? clientDistance;
    } else {
      distanceKm = clientDistance;
    }
    const day: MobilePlannedDay = {
      localDate: item.localDate,
      kind: item.kind,
      distanceKm
    };
    if (structure && item.kind !== "rest") day.structure = structure;
    const explicitNull = item.reason === null;
    const reason = typeof item.reason === "string" && item.reason.length > 0 ? item.reason.slice(0, 400)
      : explicitNull ? null : (prior?.reason ?? null);
    // `null` is a value ("no reason"), not the same byte shape as an omitted
    // field. A schema-2 materialization compares exact prescriptions, so the
    // legacy normalizer must not erase it on the way through.
    if (reason !== null) day.reason = reason;
    else if (explicitNull || prior?.reason === null) day.reason = null;
    return [day];
  });
}

/** Structural identity of two prescriptions; used to tell "inherited" from "replaced". */
function sameStructure(left: MobileSessionStructure, right: MobileSessionStructure): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Re-measures a stored plan day through {@link plannedDayNumbers}, the same
 * helper both plan endpoints use.
 *
 * Without a prescription the day is echoed untouched: measuring it with default
 * paces would replace numbers the runner's own zones produced with numbers that
 * only describe the fallback profile.
 */
function measurePlanDay(
  day: MobilePlannedDay,
  prescription: CoachZonePrescription | null | undefined
): MobilePlannedDay {
  if (prescription === undefined) return day;
  // Capped on the way out as well as on the way in, so a day stored before the
  // ceiling bound this store is corrected instead of being echoed at 2000 km.
  const structure =
    day.structure == null ? null : capStructureToDayCeiling(day.structure, day.kind, prescription);
  const numbers = plannedDayNumbers(day.kind, structure, day.distanceKm, prescription);
  const measured: MobilePlannedDay = {
    localDate: day.localDate,
    kind: day.kind,
    distanceKm: numbers.distanceKm
  };
  if (numbers.structure) measured.structure = numbers.structure;
  // Preserve an explicit `null` as well: a stored schema-2 prescription uses the
  // field to say "no reason", and dropping it would make the measured copy differ
  // from the frozen session identity on the next ownership reconciliation.
  if (day.reason !== undefined) measured.reason = day.reason;
  return measured;
}

/** The lock is rendered by `/v1/mobile/today` too, so it is measured the same way. */
function measureLockedSession(
  locked: MobileLockedSession | null,
  prescription: CoachZonePrescription | null | undefined
): MobileLockedSession | null {
  if (!locked || prescription === undefined) return locked;
  const structure =
    locked.session.structure == null
      ? null
      : capStructureToDayCeiling(locked.session.structure, locked.session.kind, prescription);
  const numbers = plannedDayNumbers(
    locked.session.kind,
    structure,
    locked.session.distanceKm,
    prescription
  );
  return {
    ...locked,
    session: {
      ...locked.session,
      distanceKm: numbers.distanceKm,
      durationMinutes: numbers.durationMinutes,
      structure: numbers.structure
    }
  };
}

function normalizePlanAudit(value: MobilePlanAudit | null | undefined): MobilePlanAudit | null {
  if (!value || typeof value !== "object") return null;
  if (value.generatedBy !== "llm" && value.generatedBy !== "heuristic" && value.generatedBy !== "manual") return null;
  return {
    generatedBy: value.generatedBy,
    model: typeof value.model === "string" ? value.model.slice(0, 120) : null,
    promptVersion: typeof value.promptVersion === "string" ? value.promptVersion.slice(0, 60) : null,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : null
  };
}

function normalizeLockedSession(
  value: MobileLockedSession | null | undefined,
  zones?: CoachZonePrescription | null
): MobileLockedSession | null {
  if (!value || typeof value !== "object") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.localDate)) return null;
  if (!SESSION_KINDS.has(value.session?.kind)) return null;
  if (value.verdictTone !== "green" && value.verdictTone !== "yellow" && value.verdictTone !== "red") return null;
  const kind = value.session.kind;
  // The lock is what `/v1/mobile/today` renders as today's session and what the
  // watch is handed, so its structure is capped like a plan day's: a client may
  // post one whose every field is legal and whose total is not.
  const parsed = normalizeSessionStructure(value.session.structure);
  return {
    localDate: value.localDate,
    verdictTone: value.verdictTone,
    lockedAt: typeof value.lockedAt === "string" ? value.lockedAt : new Date().toISOString(),
    session: {
      kind,
      title: value.session.title || kind,
      reason: value.session.reason ?? "",
      distanceKm: value.session.distanceKm ?? null,
      durationMinutes: value.session.durationMinutes ?? null,
      paceSecondsPerKmLower: value.session.paceSecondsPerKmLower ?? null,
      paceSecondsPerKmUpper: value.session.paceSecondsPerKmUpper ?? null,
      heartRateBpmLower: value.session.heartRateBpmLower ?? null,
      heartRateBpmUpper: value.session.heartRateBpmUpper ?? null,
      structure: parsed == null ? null : capStructureToDayCeiling(parsed, kind, zones ?? null)
    }
  };
}
