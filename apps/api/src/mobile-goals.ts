import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

import type {
  MobileGoalsResponse,
  MobileLockedSession,
  MobileRaceDistance,
  MobileRaceTarget,
  MobileSessionKind,
  UpdateMobileGoalsInput
} from "@rai/api-contracts";

import { DEFAULT_EASY_DURATION_FLOOR, DEFAULT_QUALITY_SESSION_CAP } from "./mobile-coach.js";

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

interface StoredGoals {
  revision: number;
  weeklyDistanceKm: number;
  easyDurationFloorFraction: number;
  qualitySessionCap: number;
  raceTarget: MobileRaceTarget | null;
  weekPlan: MobileGoalsResponse["weekPlan"];
  lockedSession: MobileLockedSession | null;
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
  updatedAt: new Date(0).toISOString()
});

/** Weekly goals persisted at `var/mobile-goals.json`. */
export class MobileGoalsStore {
  private readonly filePath: string;
  private readonly controlDatabase: DatabaseSync | null;
  private cached: StoredGoals | null = null;

  constructor(runtimeRoot: string, controlDatabasePath?: string) {
    this.filePath = join(runtimeRoot, "var", GOALS_FILE);
    this.controlDatabase = controlDatabasePath ? this.openControlDatabase(controlDatabasePath) : null;
  }

  read(): MobileGoalsResponse {
    if (this.controlDatabase) return this.toResponse(this.readControlGoals());
    if (!this.cached) {
      this.cached = existsSync(this.filePath) ? this.loadFile() : emptyGoals();
    }
    return this.toResponse(this.cached);
  }

  write(input: UpdateMobileGoalsInput): MobileGoalsResponse {
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
      weekPlan: input.weekPlan === undefined ? current.weekPlan : normalizeWeekPlan(input.weekPlan),
      lockedSession: input.lockedSession === undefined ? current.lockedSession : normalizeLockedSession(input.lockedSession),
      updatedAt: new Date().toISOString()
    };
    if (this.controlDatabase) {
      this.writeControlGoals(stored, current.revision);
    } else {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    }
    this.cached = stored;
    return this.toResponse(stored);
  }

  private toResponse(stored: StoredGoals): MobileGoalsResponse {
    return {
      revision: stored.revision,
      weeklyDistanceKm: stored.weeklyDistanceKm,
      easyDurationFloorFraction: stored.easyDurationFloorFraction,
      qualitySessionCap: stored.qualitySessionCap,
      raceTarget: stored.raceTarget,
      weekPlan: stored.weekPlan,
      lockedSession: stored.lockedSession,
      updatedAt: stored.updatedAt
    };
  }

  close(): void {
    this.controlDatabase?.close();
  }

  lockSession(locked: MobileLockedSession): MobileGoalsResponse {
    return this.write({
      weeklyDistanceKm: this.read().weeklyDistanceKm,
      lockedSession: locked
    });
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
        weekPlan: normalizeWeekPlan(Array.isArray(parsed.weekPlan) ? parsed.weekPlan : []),
        lockedSession: normalizeLockedSession(parsed.lockedSession ?? null),
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
          weekPlan: normalizeWeekPlan(Array.isArray(parsed.weekPlan) ? parsed.weekPlan : []),
          lockedSession: normalizeLockedSession(parsed.lockedSession ?? null),
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
        };
        const backup = `${this.filePath}.migrated.bak`;
        if (!existsSync(backup)) copyFileSync(this.filePath, backup);
        writeFileSync(`${this.filePath}.migration-complete`, `${new Date().toISOString()}\n`, "utf8");
      }
      const payload = JSON.stringify({
        weeklyDistanceKm: initial.weeklyDistanceKm,
        easyDurationFloorFraction: initial.easyDurationFloorFraction,
        qualitySessionCap: initial.qualitySessionCap,
        raceTarget: initial.raceTarget,
        weekPlan: initial.weekPlan,
        lockedSession: initial.lockedSession
      });
      database.prepare("INSERT INTO mobile_goals (singleton, revision, payload_json, updated_at) VALUES (1, ?, ?, ?)").run(initial.revision, payload, initial.updatedAt);
      database.prepare("INSERT INTO mobile_goals_history (revision, payload_json, changed_at) VALUES (?, ?, ?)").run(initial.revision, payload, initial.updatedAt);
    }
    return database;
  }

  private readControlGoals(): StoredGoals {
    const row = this.controlDatabase?.prepare("SELECT revision, payload_json, updated_at FROM mobile_goals WHERE singleton = 1").get() as { revision: number; payload_json: string; updated_at: string } | undefined;
    if (!row) return emptyGoals();
    const parsed = JSON.parse(row.payload_json) as Omit<StoredGoals, "revision" | "updatedAt">;
    return { ...parsed, revision: Number(row.revision), updatedAt: row.updated_at };
  }

  private writeControlGoals(stored: StoredGoals, expectedRevision: number): void {
    if (!this.controlDatabase) return;
    const payload = JSON.stringify({
      weeklyDistanceKm: stored.weeklyDistanceKm,
      easyDurationFloorFraction: stored.easyDurationFloorFraction,
      qualitySessionCap: stored.qualitySessionCap,
      raceTarget: stored.raceTarget,
      weekPlan: stored.weekPlan,
      lockedSession: stored.lockedSession
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

function normalizeWeekPlan(
  value: Array<{ localDate: string; kind: MobileSessionKind; distanceKm: number | null }>
): MobileGoalsResponse["weekPlan"] {
  return value.flatMap((item) => {
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(item.localDate)) return [];
    if (!SESSION_KINDS.has(item.kind)) return [];
    const distance = item.distanceKm;
    return [{
      localDate: item.localDate,
      kind: item.kind,
      distanceKm: distance == null || !Number.isFinite(distance) ? null : Math.min(80, Math.max(0, distance))
    }];
  });
}

function normalizeLockedSession(value: MobileLockedSession | null | undefined): MobileLockedSession | null {
  if (!value || typeof value !== "object") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.localDate)) return null;
  if (!SESSION_KINDS.has(value.session?.kind)) return null;
  if (value.verdictTone !== "green" && value.verdictTone !== "yellow" && value.verdictTone !== "red") return null;
  return {
    localDate: value.localDate,
    verdictTone: value.verdictTone,
    lockedAt: typeof value.lockedAt === "string" ? value.lockedAt : new Date().toISOString(),
    session: {
      kind: value.session.kind,
      title: value.session.title || value.session.kind,
      reason: value.session.reason ?? "",
      distanceKm: value.session.distanceKm ?? null,
      durationMinutes: value.session.durationMinutes ?? null,
      paceSecondsPerKmLower: value.session.paceSecondsPerKmLower ?? null,
      paceSecondsPerKmUpper: value.session.paceSecondsPerKmUpper ?? null,
      heartRateBpmLower: value.session.heartRateBpmLower ?? null,
      heartRateBpmUpper: value.session.heartRateBpmUpper ?? null
    }
  };
}
