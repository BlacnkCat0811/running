import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  MobileGoalsResponse,
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

const GOALS_FILE = "mobile-goals.json";
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
  /** Internal programme capability, never accepted by the public goals body. */
  runCoach?: MobileRunCoachPlan | null;
  prescription?: CoachZonePrescription | null;
  /** Internal confirmation capability; never accepted in the public goals body. */
  confirmCoachPlan?: boolean;
  /** Runs on the measured candidate before any durable write. */
  validate?: (candidate: MobileGoalsResponse) => MobileGoalsResponse | void;
}

/** One stored plan revision, as it was written. */
export interface PlanHistoryRevision {
  revision: number;
  changedAt: string;
  weekPlan: MobilePlannedDay[];
  lockedSession: MobileLockedSession | null;
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

  /** Retire tomorrow and later from legacy model weeks, without rewriting today's prescription. */
  retireLegacyModelPlan(today: string): MobileGoalsResponse {
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
    if (current.weekPlanReplanRequired && input.weekPlan !== undefined && !options?.confirmCoachPlan) {
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
      weekPlan: input.weekPlan === undefined ? current.weekPlan : normalizeWeekPlan(input.weekPlan, current.weekPlan, options),
      lockedSession:
        input.lockedSession === undefined
          ? current.lockedSession
          : normalizeLockedSession(input.lockedSession, options?.prescription),
      weekPlanAudit: input.weekPlanAudit === undefined ? current.weekPlanAudit : normalizePlanAudit(input.weekPlanAudit),
      weekPlanReplanRequired: options?.confirmCoachPlan ? false : current.weekPlanReplanRequired,
      weekPlanPreservedDate: current.weekPlanPreservedDate,
      runCoach: options?.runCoach === undefined ? current.runCoach : options.runCoach,
      updatedAt: new Date().toISOString()
    };
    const validated = options?.validate?.(this.toResponse(stored, options));
    if (validated) stored.weekPlan = validated.weekPlan;
    this.persistGoals(stored, current.revision);
    return this.toResponse(stored, options);
  }

  private persistGoals(stored: StoredGoals, expectedRevision: number): void {
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
    const payload = {
      structure: input.structure,
      ...(input.workoutID !== undefined ? { workoutID: input.workoutID } : {}),
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.exportNotes !== undefined ? { exportNotes: input.exportNotes } : {})
    };
    const revision = Number.isFinite(input.revision) ? Math.max(0, Math.round(input.revision)) : 0;
    // Serialise lookup + insert even if another process owns the same control
    // database. A unique index alone would turn a concurrent retry into a 500.
    this.controlDatabase.exec("BEGIN IMMEDIATE");
    try {
      if (input.idempotencyKey) {
        const previous = this.controlDatabase.prepare(`
          SELECT local_date, revision, kind, payload_json, pushed_at FROM mobile_plan_pushes
          WHERE json_valid(payload_json) AND json_extract(payload_json, '$.idempotencyKey') = ?
        `).get(input.idempotencyKey) as { local_date: string; revision: number; kind: string; payload_json: string; pushed_at: string } | undefined;
        if (previous) {
          if (previous.local_date !== input.localDate || previous.revision !== revision ||
              previous.kind !== input.kind || !isDeepStrictEqual(JSON.parse(previous.payload_json), payload)) {
            throw new MobileGoalsInputError("idempotencyKey was already used for a different system schedule receipt");
          }
          this.controlDatabase.exec("COMMIT");
          return previous.pushed_at;
        }
      }
      this.controlDatabase
        .prepare(`
          INSERT INTO mobile_plan_pushes (local_date, revision, kind, payload_json, pushed_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          input.localDate,
          revision,
          input.kind,
          JSON.stringify(payload),
          input.pushedAt
        );
      this.controlDatabase.exec("COMMIT");
      this.invalidateReadCaches();
      return input.pushedAt;
    } catch (error) {
      this.controlDatabase.exec("ROLLBACK");
      throw error;
    }
  }

  /** Push receipts at or after `sinceIso`, newest first. */
  planPushes(sinceIso: string, limit = 50): PlanPushRecord[] {
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
    return this.planPushCache.rows
      .filter((push) => push.pushedAt >= sinceIso)
      .slice(0, cappedReadLimit(limit));
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
      let parsed: { structure?: unknown; workoutID?: string; scheduledAt?: string; idempotencyKey?: string; exportNotes?: string[] };
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        return [];
      }
      return [
        {
          localDate: row.local_date,
          revision: Number(row.revision),
          kind: row.kind as MobileSessionKind,
          structure: normalizeSessionStructure(parsed.structure),
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
      PRAGMA busy_timeout = 5000;
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
      CREATE INDEX IF NOT EXISTS idx_mobile_plan_pushes_pushed_at
        ON mobile_plan_pushes(pushed_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_plan_pushes_idempotency
        ON mobile_plan_pushes(json_extract(payload_json, '$.idempotencyKey'))
        WHERE json_valid(payload_json) AND json_extract(payload_json, '$.idempotencyKey') IS NOT NULL;
    `);
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

  private readControlGoals(): StoredGoals {
    const row = this.controlDatabase?.prepare("SELECT revision, payload_json, updated_at FROM mobile_goals WHERE singleton = 1").get() as { revision: number; payload_json: string; updated_at: string } | undefined;
    if (!row) return emptyGoals();
    // Normalized on the way out as well as on the way in: a row written by an
    // older build has no `weekPlanAudit` (nor `structure`/`reason` on its plan
    // days), and the response type promises `null` — never a missing key.
    const parsed = JSON.parse(row.payload_json) as Partial<StoredGoals>;
    return {
      revision: Number(row.revision),
      easyDurationFloorFraction: Number.isFinite(Number(parsed.easyDurationFloorFraction)) ? clampFraction(Number(parsed.easyDurationFloorFraction)) : DEFAULT_EASY_DURATION_FLOOR,
      qualitySessionCap: Number.isFinite(Number(parsed.qualitySessionCap)) ? clampCap(Number(parsed.qualitySessionCap)) : DEFAULT_QUALITY_SESSION_CAP,
      raceTarget: normalizeRaceTarget(parsed.raceTarget ?? null),
      weekPlan: normalizeWeekPlan(Array.isArray(parsed.weekPlan) ? parsed.weekPlan : [], []),
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
    this.controlDatabase.exec("BEGIN IMMEDIATE");
    try {
      const result = this.controlDatabase.prepare(`
        UPDATE mobile_goals SET revision = ?, payload_json = ?, updated_at = ?
        WHERE singleton = 1 AND revision = ?
      `).run(stored.revision, payload, stored.updatedAt, expectedRevision);
      if (Number(result.changes) !== 1) {
        this.controlDatabase.exec("ROLLBACK");
        throw new MobileGoalsRevisionConflictError(this.readControlGoals().revision);
      }
      this.controlDatabase.prepare("INSERT INTO mobile_goals_history (revision, payload_json, changed_at) VALUES (?, ?, ?)").run(stored.revision, payload, stored.updatedAt);
      this.controlDatabase.exec("COMMIT");
      // After the commit, never before: a rolled-back write must leave the cache
      // exactly as it was, so the only reads the cache can be stale for are the
      // committed ones it is invalidated for.
      this.invalidateReadCaches();
    } catch (error) {
      try { this.controlDatabase.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
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
  constructor(readonly currentRevision: number) {
    super("训练目标已在其他页面更新，请重新加载后再保存");
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
    const reason = typeof item.reason === "string" && item.reason.length > 0 ? item.reason.slice(0, 400) : (prior?.reason ?? null);
    if (reason) day.reason = reason;
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
  if (day.reason) measured.reason = day.reason;
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
