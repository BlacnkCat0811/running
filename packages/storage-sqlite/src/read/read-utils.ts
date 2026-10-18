export const nullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * 24 h of slack for indexable text-range prefilters on `health_records.start_at` /
 * `end_at`.
 *
 * Imported timestamps are normalised to fixed-width UTC (`normalizeAppleDate` →
 * `toISOString()`), so text order equals time order and a text range is exact.
 * Legacy rows may still carry a `±HH:MM` offset; comparing such text against a
 * canonical `Z` bound is then off by at most 14 h. Callers widen the indexed
 * text range by this slack so it stays a **superset** of the exact
 * `julianday(...)` window, then let the `julianday` predicates decide membership.
 * That keeps the absolute-instant semantics the facts reader documents while
 * restoring an index seek on the column.
 */
export const HEALTH_RECORD_TIME_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Canonical fixed-width UTC text shifted by `deltaMs`.
 *
 * Unparseable inputs are returned unchanged: the exact `julianday` predicate
 * still decides membership (an invalid bound yields NULL there, as before).
 */
export function shiftedIsoBound(value: string, deltaMs: number): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds + deltaMs).toISOString() : value;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const paceSeconds = (duration: number, distance: number | null): number | null =>
  distance !== null && distance > 0 ? duration / distance : null;
