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

export function durationToSeconds(
  value: string | undefined,
  unit: string | undefined
): number | null {
  const amount = parseFiniteNumber(value);
  if (amount === null) return null;

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

/** Normalize export-relative paths; lowercase so UNIQUE(relative_path) matches GPX lookups. */
export function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
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
