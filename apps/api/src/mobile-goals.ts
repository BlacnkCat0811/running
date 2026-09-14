import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

import type {
  MobileGoalsResponse,
  MobileLockedSession,
  MobilePlanAudit,
  MobilePlannedDay,
  MobileRaceDistance,
  MobileRaceTarget,
  MobileSessionKind,
  MobileSessionStructure,
  UpdateMobileGoalsInput
} from "@rai/api-contracts";

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

export const DEFAULT_WEEKLY_DISTANCE_KM = 30;
const GOALS_FILE = "mobile-goals.json";
const SESSION_KINDS = new Set<MobileSessionKind>([
  "rest",
  "recovery",
  "easy",
  "long_run",
  "tempo",
  "interval"
]);
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
  weeklyDistanceKm: number;
  easyDurationFloorFraction: number;
  qualitySessionCap: number;
  raceTarget: MobileRaceTarget | null;
  weekPlan: MobileGoalsResponse["weekPlan"];
  lockedSession: MobileLockedSession | null;
  weekPlanAudit: MobilePlanAudit | null;
  updatedAt: string;
}

const clampGoal = (value: number): number => Math.min(500, Math.max(1, value));
const clampFraction = (value: number): number => Math.min(0.95, Math.max(0.4, value));
const clampCap = (value: number): number => Math.min(4, Math.max(0, Math.round(value)));

const emptyGoals = (): StoredGoals => ({
  revision: 0,
  weeklyDistanceKm: DEFAULT_WEEKLY_DISTANCE_KM,
  easyDurationFloorFraction: DEFAULT_EASY_DURATION_FLOOR,
  qualitySessionCap: DEFAULT_QUALITY_SESSION_CAP,
  raceTarget: null,
  weekPlan: [],
  lockedSession: null,
  weekPlanAudit: null,
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
  prescription?: CoachZonePrescription | null;
}

/** Weekly goals persisted at `var/mobile-goals.json`. */
export class MobileGoalsStore {
  private readonly filePath: string;
  private readonly controlDatabase: DatabaseSync | null;
  private cached: StoredGoals | null = null;

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

  write(input: UpdateMobileGoalsInput, options?: PlanMergeOptions): MobileGoalsResponse {
    if (!Number.isFinite(input.weeklyDistanceKm)) {
      throw new RangeError("weeklyDistanceKm must be a finite number");
    }
    const current = this.readStored();
    if (input.expectedRevision != null && input.expectedRevision !== current.revision) {
      throw new MobileGoalsRevisionConflictError(current.revision);
    }
    const stored: StoredGoals = {
      revision: current.revision + 1,
      weeklyDistanceKm: clampGoal(input.weeklyDistanceKm),
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
      updatedAt: new Date().toISOString()
    };
    if (this.controlDatabase) {
      this.writeControlGoals(stored, current.revision);
    } else {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    }
    this.cached = stored;
    return this.toResponse(stored, options);
  }

  /** Measures the stored plan so the editor and the plan views show one number. */
  private toResponse(stored: StoredGoals, options?: PlanMergeOptions): MobileGoalsResponse {
    const prescription = options?.prescription;
    return {
      revision: stored.revision,
      weeklyDistanceKm: stored.weeklyDistanceKm,
      easyDurationFloorFraction: stored.easyDurationFloorFraction,
      qualitySessionCap: stored.qualitySessionCap,
      raceTarget: stored.raceTarget,
      weekPlan: stored.weekPlan.map((day) => measurePlanDay(day, prescription)),
      lockedSession: measureLockedSession(stored.lockedSession, prescription),
      weekPlanAudit: stored.weekPlanAudit,
      updatedAt: stored.updatedAt
    };
  }

  close(): void {
    this.controlDatabase?.close();
  }

  lockSession(locked: MobileLockedSession, options?: PlanMergeOptions): MobileGoalsResponse {
    return this.write(
      {
        weeklyDistanceKm: this.read().weeklyDistanceKm,
        lockedSession: locked
      },
      options
    );
  }

  private loadFile(): StoredGoals {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredGoals>;
      const weekly = Number(parsed.weeklyDistanceKm);
      if (!Number.isFinite(weekly)) throw new Error("invalid weeklyDistanceKm");
      const floor = Number(parsed.easyDurationFloorFraction);
      const cap = Number(parsed.qualitySessionCap);
      return {
        revision: Number.isInteger(parsed.revision) && Number(parsed.revision) >= 0 ? Number(parsed.revision) : 0,
        weeklyDistanceKm: clampGoal(weekly),
        easyDurationFloorFraction: Number.isFinite(floor) ? clampFraction(floor) : DEFAULT_EASY_DURATION_FLOOR,
        qualitySessionCap: Number.isFinite(cap) ? clampCap(cap) : DEFAULT_QUALITY_SESSION_CAP,
        raceTarget: normalizeRaceTarget(parsed.raceTarget ?? null),
        weekPlan: normalizeWeekPlan(Array.isArray(parsed.weekPlan) ? parsed.weekPlan : [], []),
        lockedSession: normalizeLockedSession(parsed.lockedSession ?? null),
        weekPlanAudit: normalizePlanAudit(parsed.weekPlanAudit ?? null),
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
        const weekly = Number(parsed.weeklyDistanceKm);
        if (!Number.isFinite(weekly)) {
          database.close();
          throw new Error("mobile-goals.json 迁移失败：weeklyDistanceKm 无效");
        }
        initial = {
          revision: 0,
          weeklyDistanceKm: clampGoal(weekly),
          easyDurationFloorFraction: Number.isFinite(Number(parsed.easyDurationFloorFraction)) ? clampFraction(Number(parsed.easyDurationFloorFraction)) : DEFAULT_EASY_DURATION_FLOOR,
          qualitySessionCap: Number.isFinite(Number(parsed.qualitySessionCap)) ? clampCap(Number(parsed.qualitySessionCap)) : DEFAULT_QUALITY_SESSION_CAP,
          raceTarget: normalizeRaceTarget(parsed.raceTarget ?? null),
          weekPlan: normalizeWeekPlan(Array.isArray(parsed.weekPlan) ? parsed.weekPlan : [], []),
          lockedSession: normalizeLockedSession(parsed.lockedSession ?? null),
          weekPlanAudit: normalizePlanAudit(parsed.weekPlanAudit ?? null),
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
        };
        const backup = `${this.filePath}.migrated.bak`;
        if (!existsSync(backup)) copyFileSync(this.filePath, backup);
      }
      const payload = JSON.stringify({
        weeklyDistanceKm: initial.weeklyDistanceKm,
        easyDurationFloorFraction: initial.easyDurationFloorFraction,
        qualitySessionCap: initial.qualitySessionCap,
        raceTarget: initial.raceTarget,
        weekPlan: initial.weekPlan,
        lockedSession: initial.lockedSession,
        weekPlanAudit: initial.weekPlanAudit
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
      weeklyDistanceKm: Number.isFinite(Number(parsed.weeklyDistanceKm)) ? clampGoal(Number(parsed.weeklyDistanceKm)) : DEFAULT_WEEKLY_DISTANCE_KM,
      easyDurationFloorFraction: Number.isFinite(Number(parsed.easyDurationFloorFraction)) ? clampFraction(Number(parsed.easyDurationFloorFraction)) : DEFAULT_EASY_DURATION_FLOOR,
      qualitySessionCap: Number.isFinite(Number(parsed.qualitySessionCap)) ? clampCap(Number(parsed.qualitySessionCap)) : DEFAULT_QUALITY_SESSION_CAP,
      raceTarget: normalizeRaceTarget(parsed.raceTarget ?? null),
      weekPlan: normalizeWeekPlan(Array.isArray(parsed.weekPlan) ? parsed.weekPlan : [], []),
      lockedSession: normalizeLockedSession(parsed.lockedSession ?? null),
      weekPlanAudit: normalizePlanAudit(parsed.weekPlanAudit ?? null),
      updatedAt: row.updated_at
    };
  }

  private writeControlGoals(stored: StoredGoals, expectedRevision: number): void {
    if (!this.controlDatabase) return;
    const payload = JSON.stringify({
      weeklyDistanceKm: stored.weeklyDistanceKm,
      easyDurationFloorFraction: stored.easyDurationFloorFraction,
      qualitySessionCap: stored.qualitySessionCap,
      raceTarget: stored.raceTarget,
      weekPlan: stored.weekPlan,
      lockedSession: stored.lockedSession,
      weekPlanAudit: stored.weekPlanAudit
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
    } catch (error) {
      try { this.controlDatabase.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    }
  }
}

export class MobileGoalsRevisionConflictError extends Error {
  readonly code = "mobile_goals_revision_conflict";
  constructor(readonly currentRevision: number) {
    super("训练目标已在其他页面更新，请重新加载后再保存");
  }
}

function normalizeRaceTarget(value: MobileRaceTarget | null | undefined): MobileRaceTarget | null {
  if (!value || typeof value !== "object") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return null;
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
