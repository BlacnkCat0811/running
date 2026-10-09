import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface HealthKitRecordDeletion { type: string; uuid: string }
export interface HealthSyncManifest {
  deletedWorkoutIds: string[];
  deletedRecords: HealthKitRecordDeletion[];
  recordIdentity: boolean;
}

export function validSampleUUID(value: string): boolean {
  return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
}

/** Version 1/XML retain their existing identity and workout deletion contract.
 * Reject unsupported protocols rather than acknowledge an ignored deletion. */
export function readHealthSyncManifest(inputRoot: string): HealthSyncManifest {
  const empty = { deletedWorkoutIds: [], deletedRecords: [], recordIdentity: false };
  let current = resolve(inputRoot);
  for (let depth = 0; depth <= 3; depth += 1) {
    const path = resolve(current, "sync-manifest.json");
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (parsed.version !== 1 && parsed.version !== 2) throw new Error("Unsupported health sync manifest version");
      const deletedWorkoutIds = Array.isArray(parsed.deletedSourceIds)
        ? parsed.deletedSourceIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
      if (parsed.version === 1) return { ...empty, deletedWorkoutIds };
      if (parsed.sourceScope !== "healthkit" || !Array.isArray(parsed.deletedRecords)) {
        throw new Error("Invalid HealthKit v2 manifest");
      }
      const deletedRecords = parsed.deletedRecords.map((item: unknown) => {
        if (item === null || typeof item !== "object") throw new Error("Invalid HealthKit record deletion");
        const { type, uuid } = item as Record<string, unknown>;
        if (typeof type !== "string" || !/^HK(?:Quantity|Category)TypeIdentifier[A-Za-z0-9]+$/.test(type)
          || typeof uuid !== "string" || !validSampleUUID(uuid)) throw new Error("Invalid HealthKit record deletion");
        return { type, uuid: uuid.toLowerCase() };
      });
      return { deletedWorkoutIds, deletedRecords, recordIdentity: true };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return empty;
}
