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

export function stableId(kind: string, parts: unknown[]): string {
  const hash = createHash("sha256");
  hash.update(kind);
  hash.update("\0");
  hash.update(JSON.stringify(parts));
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

/** Return the calendar date in an IANA timezone for an instant. */
export function localDateAt(instantOrIso: number | string, timezone = "Asia/Shanghai"): string {
  const instant = typeof instantOrIso === "string" ? Date.parse(instantOrIso) : instantOrIso;
  if (!Number.isFinite(instant)) throw new Error(`Invalid instant: ${instantOrIso}`);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Resolve a local wall-clock timestamp to an instant, including DST transitions. */
export function localDateTimeAt(value: string, timezone = "Asia/Shanghai"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`Invalid local date-time: ${value}`);
  const target = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}`;
  const naive = Date.parse(`${target}Z`);
  for (let offset = -16 * 60; offset <= 16 * 60; offset += 15) {
    const candidate = naive - offset * 60_000;
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const hour = values.hour === "24" ? "00" : values.hour;
    if (`${values.year}-${values.month}-${values.day}T${hour}:${values.minute}:${values.second}` === target) return new Date(candidate).toISOString();
  }
  throw new Error(`Local date-time does not exist in ${timezone}: ${value}`);
}

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
