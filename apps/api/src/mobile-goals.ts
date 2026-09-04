import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  private cached: StoredGoals | null = null;

  constructor(runtimeRoot: string) {
    this.filePath = join(runtimeRoot, "var", GOALS_FILE);
  }

  read(): MobileGoalsResponse {
    if (!this.cached) {
      this.cached = existsSync(this.filePath) ? this.loadFile() : emptyGoals();
    }
    return this.toResponse(this.cached);
  }

  write(input: UpdateMobileGoalsInput): MobileGoalsResponse {
    if (!Number.isFinite(input.weeklyDistanceKm)) {
      throw new RangeError("weeklyDistanceKm must be a finite number");
    }
    const current = existsSync(this.filePath) ? this.loadFile() : emptyGoals();
    const stored: StoredGoals = {
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
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    this.cached = stored;
    return this.toResponse(stored);
  }

  private toResponse(stored: StoredGoals): MobileGoalsResponse {
    return {
      weeklyDistanceKm: stored.weeklyDistanceKm,
      easyDurationFloorFraction: stored.easyDurationFloorFraction,
      qualitySessionCap: stored.qualitySessionCap,
      raceTarget: stored.raceTarget,
      weekPlan: stored.weekPlan,
      lockedSession: stored.lockedSession,
      updatedAt: stored.updatedAt
    };
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
