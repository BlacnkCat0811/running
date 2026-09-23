import { createHash } from "node:crypto";

import type { MetadataMap } from "@rai/contracts";

export type SourceCategory =
  | "apple_watch"
  | "apple_phone"
  | "connect"
  | "coros"
  | "huawei"
  | "manual"
  | "other";

/**
 * Serialises a value with **object keys in sorted order** and **array order
 * preserved**.
 *
 * `JSON.stringify` emits an object's keys in insertion order, so two values that
 * are equal *as data* hash differently when they were built in a different key
 * order. That is not hypothetical here: the HealthKit exporter writes
 * `<MetadataEntry>` lines from a Swift `Dictionary`, which has no stable
 * iteration order, and the parser creates a `MetadataMap` key on first sight of
 * each line (`addMetadata`). The key order of the resulting object therefore
 * varied between two exports of the *same* unchanged workout, which changed
 * `stableId("workout_content", …)` — and a changed content hash means
 * `observeImportEntity` reports the workout as `updated`, so the incremental
 * importer replayed the model over the whole window on every sync.
 *
 * Arrays keep their order on purpose: an array here is a sequence, not a set.
 * `metadata[key]` holds one entry per `<MetadataEntry>` line for that key, and
 * `lastMetadataValue` deliberately takes the last one. Sorting arrays would
 * change what the data means.
 *
 * Only *plain* objects are reordered. Anything else (`Date`, `Map`, class
 * instances) is passed through untouched so `JSON.stringify` still applies its
 * own `toJSON` handling rather than this function flattening it to `{}`.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const source = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) ordered[key] = canonicalize(source[key]);
  return ordered;
}

export function stableId(kind: string, parts: unknown[]): string {
  const hash = createHash("sha256");
  hash.update(kind);
  hash.update("\0");
  // `canonicalize` sorts object keys only, so every caller that passes a flat
  // list of primitives — which is all of the real primary keys: record, workout,
  // route, training_session, canonical_night, workout_group and the job ids —
  // hashes byte-for-byte as before and **no persisted id is regenerated**. Only
  // the two content hashes (`record_content`, `workout_content`), which embed
  // attribute/metadata objects, take new values — once.
  hash.update(JSON.stringify(canonicalize(parts)));
  return `${kind}_${hash.digest("hex").slice(0, 32)}`;
}

export function parseFiniteNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeAppleDate(value: string | undefined): string | null {
  if (!value) return null;

  const normalized = value.replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/,
    "$1T$2$3:$4"
  );
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Calendar-date helpers in the database timezone.
 *
 * The implementation now lives in `@rai/contracts` (`src/timezone.ts`): the same memoised
 * `Intl.DateTimeFormat` lookup is needed by `@rai/application`, `@rai/storage-sqlite`,
 * `@rai/training-load`, `@rai/training-zones` and the API, and `storage-sqlite` /
 * `training-load` do not depend on each other, so no leaf package can host it.
 *
 * Re-exported here so this package's public API — and its byte-identical output,
 * including the deliberate linear DST probe — is unchanged. The original measurement
 * that motivated the cache (21,301 ms -> 2,416 ms on `canonicalizeNights`) still holds:
 * this package reaches the same cache instance through `@rai/contracts`.
 */
export { localDateAt, localDateTimeAt } from "@rai/contracts";

export function durationToSeconds(
  value: string | undefined,
  unit: string | undefined
): number | null {
  const amount = parseFiniteNumber(value);
  if (amount === null || amount < 0) return null;

  switch ((unit ?? "s").toLowerCase()) {
    case "s":
    case "sec":
    case "second":
    case "seconds":
      return amount;
    case "min":
    case "minute":
    case "minutes":
      return amount * 60;
    case "h":
    case "hr":
    case "hour":
    case "hours":
      return amount * 3600;
    default:
      return null;
  }
}

export function addMetadata(
  metadata: MetadataMap,
  key: string | undefined,
  value: string | undefined
): void {
  if (!key || value === undefined) return;
  const values = metadata[key] ?? [];
  values.push(value);
  metadata[key] = values;
}

export function lastMetadataValue(
  metadata: MetadataMap,
  key: string
): string | null {
  const values = metadata[key];
  return values?.at(-1) ?? null;
}

export function metadataBoolean(
  metadata: MetadataMap,
  key: string
): boolean | null {
  const value = lastMetadataValue(metadata, key)?.trim().toLowerCase();
  if (value === undefined || value === null) return null;
  if (["1", "true", "yes"].includes(value)) return true;
  if (["0", "false", "no"].includes(value)) return false;
  return null;
}

export function classifySource(
  sourceName: string | null | undefined,
  device: string | null | undefined = null,
  metadata: MetadataMap = {}
): SourceCategory {
  if (metadataBoolean(metadata, "HKWasUserEntered") === true) return "manual";
  const normalized = `${sourceName ?? ""} ${device ?? ""}`
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (normalized.includes("coros")) return "coros";
  if (normalized.includes("huawei") || normalized.includes("华为")) return "huawei";
  if (normalized.includes("connect")) return "connect";
  if (normalized.includes("apple watch")) return "apple_watch";
  if (normalized.includes("iphone") || normalized.includes("apple phone")) {
    return "apple_phone";
  }
  return "other";
}

/**
 * Normalize an export-relative path for **filesystem** access: separators only,
 * case preserved. Archive entries carry case-sensitive names (an iOS workout
 * route is named after the uppercased `HKWorkout.uuidString`), so the path used
 * to touch the disk must never be lowercased — that only resolves by accident on
 * a case-insensitive host.
 */
export function normalizeRelativePathForFileSystem(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "");
}

/**
 * Normalize export-relative paths for **identity** lookups; lowercase so
 * `UNIQUE(relative_path)` and the GPX target map match case-insensitively.
 */
export function normalizeRelativePath(value: string): string {
  return normalizeRelativePathForFileSystem(value).toLowerCase();
}

export function distanceToKilometers(
  value: number | null,
  unit: string | null
): number | null {
  if (value === null) return null;
  switch ((unit ?? "").toLowerCase()) {
    case "km":
      return value;
    case "m":
      return value / 1000;
    case "mi":
      return value * 1.609344;
    default:
      return null;
  }
}
