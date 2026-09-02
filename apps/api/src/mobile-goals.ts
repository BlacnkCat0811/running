import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { MobileGoalsResponse, UpdateMobileGoalsInput } from "@rai/api-contracts";

export const DEFAULT_WEEKLY_DISTANCE_KM = 30;
const GOALS_FILE = "mobile-goals.json";

interface StoredGoals {
  weeklyDistanceKm: number;
  updatedAt: string;
}

const clampGoal = (value: number): number => Math.min(500, Math.max(1, value));

/** Weekly goal persisted at `var/mobile-goals.json`. */
export class MobileGoalsStore {
  private readonly filePath: string;
  private cached: StoredGoals | null = null;

  constructor(runtimeRoot: string) {
    this.filePath = join(runtimeRoot, "var", GOALS_FILE);
  }

  read(): MobileGoalsResponse {
    if (!this.cached) {
      this.cached = existsSync(this.filePath) ? this.loadFile() : {
        weeklyDistanceKm: DEFAULT_WEEKLY_DISTANCE_KM,
        updatedAt: new Date(0).toISOString()
      };
    }
    return { weeklyDistanceKm: this.cached.weeklyDistanceKm, updatedAt: this.cached.updatedAt };
  }

  write(input: UpdateMobileGoalsInput): MobileGoalsResponse {
    if (!Number.isFinite(input.weeklyDistanceKm)) {
      throw new RangeError("weeklyDistanceKm must be a finite number");
    }
    const stored: StoredGoals = {
      weeklyDistanceKm: clampGoal(input.weeklyDistanceKm),
      updatedAt: new Date().toISOString()
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    this.cached = stored;
    return { weeklyDistanceKm: stored.weeklyDistanceKm, updatedAt: stored.updatedAt };
  }

  private loadFile(): StoredGoals {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoredGoals>;
      const weekly = Number(parsed.weeklyDistanceKm);
      if (!Number.isFinite(weekly)) throw new Error("invalid weeklyDistanceKm");
      return {
        weeklyDistanceKm: clampGoal(weekly),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
      };
    } catch {
      // Corrupt or foreign file: fall back to defaults rather than failing reads.
      return {
        weeklyDistanceKm: DEFAULT_WEEKLY_DISTANCE_KM,
        updatedAt: new Date(0).toISOString()
      };
    }
  }
}
