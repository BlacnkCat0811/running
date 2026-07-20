import { createHash, randomUUID } from "node:crypto";

export const appNow = (): string => new Date().toISOString();

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function deterministicId(prefix: string, value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `${prefix}_${digest.slice(0, 32)}`;
}

export function configHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function localDateAt(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

export function localDateStartAt(localDate: string, timezone: string): string {
  const [year, month, day] = localDate.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Invalid local date: ${localDate}`);
  const utcGuess = Date.UTC(year, month - 1, day);
  const validated = new Date(utcGuess).toISOString().slice(0, 10);
  if (validated !== localDate) throw new Error(`Invalid local date: ${localDate}`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const dateAt = (instant: number): string => {
    const parts = formatter.formatToParts(new Date(instant));
    const read = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? "00";
    return `${read("year")}-${read("month")}-${read("day")}`;
  };

  let lower = utcGuess - 36 * 60 * 60 * 1000;
  let upper = utcGuess + 36 * 60 * 60 * 1000;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (dateAt(middle) < localDate) lower = middle + 1;
    else upper = middle;
  }
  if (dateAt(lower) !== localDate) throw new Error(`Local date does not exist in ${timezone}: ${localDate}`);
  return new Date(lower).toISOString();
}

export function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid local date: ${localDate}`);
  }
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

export function daysBetween(left: string, right: string): number {
  return Math.max(
    0,
    Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000)
  );
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  const lower = sorted[middle - 1];
  if (upper === undefined) return null;
  return sorted.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper;
}
