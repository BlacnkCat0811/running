import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

export type ImportEntityKind = "workout" | "route" | "heart_rate" | "sleep" | "resting_heart_rate" | "hrv" | "maximum_heart_rate" | "other";
export type ImportChangeType = "inserted" | "updated" | "removed" | "unchanged";

export interface SourceFingerprint {
  path: string;
  sizeBytes: number;
  modifiedAtMs: number;
  sha256: string;
}

export interface ImportEntityChange {
  entityKind: ImportEntityKind;
  entityId: string;
  changeType: ImportChangeType;
  effectiveAt: string | null;
}

export interface DatasetFingerprints {
  xmlSha256: string;
  routeBundleSha256: string | null;
}

export interface DatasetDiff {
  status: "unchanged" | "changed";
  xmlChanged: boolean;
  routesChanged: boolean;
}

export interface RecomputePlan {
  mode: "none" | "partial" | "full";
  dirtySessionIds: string[];
  dirtyFromAt: string | null;
  reasons: string[];
}

export async function fingerprintFile(path: string, knownStat?: Stats): Promise<SourceFingerprint> {
  const fileStat = knownStat ?? await stat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return { path, sizeBytes: fileStat.size, modifiedAtMs: fileStat.mtimeMs, sha256: hash.digest("hex") };
}

export function diffDataset(previous: DatasetFingerprints | null, next: DatasetFingerprints): DatasetDiff {
  if (!previous) return { status: "changed", xmlChanged: true, routesChanged: next.routeBundleSha256 !== null };
  const xmlChanged = previous.xmlSha256 !== next.xmlSha256;
  const routesChanged = previous.routeBundleSha256 !== next.routeBundleSha256;
  return { status: xmlChanged || routesChanged ? "changed" : "unchanged", xmlChanged, routesChanged };
}

/** Plans only transformations whose dependency boundary is known. Unknown or recovery changes deliberately fall back to full. */
export function planRecompute(changes: readonly ImportEntityChange[]): RecomputePlan {
  const material = changes.filter((change) => change.changeType !== "unchanged");
  if (material.length === 0) return { mode: "none", dirtySessionIds: [], dirtyFromAt: null, reasons: ["source_fingerprint_unchanged"] };
  const unsafe = material.filter((change) => !["workout", "route"].includes(change.entityKind));
  const dates = material.map((change) => change.effectiveAt).filter((value): value is string => value !== null).sort();
  const sessions = [...new Set(material.filter((change) => change.entityKind === "workout" || change.entityKind === "route").map((change) => change.entityId))].sort();
  if (unsafe.length > 0 || dates.length !== material.length) {
    const kinds = [...new Set(unsafe.map((change) => change.entityKind))].sort();
    return {
      mode: "full",
      dirtySessionIds: sessions,
      dirtyFromAt: dates[0] ?? null,
      reasons: [unsafe.length > 0 ? `global_dependency:${kinds.join(",")}` : "missing_effective_timestamp"]
    };
  }
  return { mode: "partial", dirtySessionIds: sessions, dirtyFromAt: dates[0]!, reasons: ["workout_or_route_change"] };
}

export function readDatasetFingerprints(database: DatabaseSync): DatasetFingerprints | null {
  const rows = database.prepare(`
    SELECT key, value FROM import_manifest
    WHERE key IN ('source_xml_sha256', 'source_gpx_bundle_sha256')
  `).all() as unknown as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const xmlSha256 = values.get("source_xml_sha256");
  return xmlSha256 ? { xmlSha256, routeBundleSha256: values.get("source_gpx_bundle_sha256") ?? null } : null;
}
