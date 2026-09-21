/**
 * Single source of truth for the database timezone, and the shared memoised
 * `Intl.DateTimeFormat` cache used to read calendar dates in it.
 *
 * ## Why a constant, not configuration
 *
 * This module *names* the implicit timezone; it does not make it configurable.
 * Making the timezone configurable at runtime is a **data migration**, not a
 * refactor: `canonical_nights` stores no algorithm-version column (only
 * `algorithmVersion` inside `provenance_json`), so changing the calendar-day
 * attribution would leave historical rows untraceable. The contract layer
 * (`@rai/api-contracts`) also pins the response `timezone` field to this exact
 * literal type, so widening it is an outward-facing contract change.
 *
 * ## Why the formatter cache
 *
 * Constructing `Intl.DateTimeFormat` is expensive (per-instance ICU setup) and
 * the helpers below are called inside tight loops — once per sleep segment,
 * four times per calendar day, and once per row in `/v1/mobile/today`. The
 * timezone and the requested field set are constant for the lifetime of the
 * process, so a per-key cache removes the redundant work while producing
 * byte-identical output. Measured on the production host: `canonicalizeNights`
 * 21,301 ms -> 2,416 ms (8.8x), and a real import's `parseImport` stage
 * 31,004.7 ms -> 11,899.6 ms.
 */

/** The IANA timezone every stored calendar day is attributed to. */
export const DATABASE_TIMEZONE = "Asia/Shanghai" as const;
export type DatabaseTimezone = typeof DATABASE_TIMEZONE;

/**
 * Fixed UTC offset of `DATABASE_TIMEZONE`, in the three shapes the codebase needs.
 *
 * 🔴 These are deliberately *fixed offsets*, not IANA lookups, and must stay that way:
 *
 * - **SQLite cannot take an IANA name as a `date()` modifier.** Writing
 *   `date(x, 'Asia/Shanghai')` returns NULL **silently** — no error, no warning —
 *   which is the most dangerous class of failure this codebase can produce.
 *   `SQL_UTC_OFFSET_MODIFIER` exists so that fact is stated once, in one place.
 * - **Asia/Shanghai has had no daylight saving since 1991**, so a fixed +08:00 is
 *   exact for every instant this database can hold. That is why the fixed offset is
 *   equivalent to the IANA zone here — and it is *not* a general property. Enabling
 *   DST-observing zones would invalidate both the SQL modifier and these constants.
 */
export const DATABASE_UTC_OFFSET_HOURS = 8;
export const SQL_UTC_OFFSET_MODIFIER = `+${DATABASE_UTC_OFFSET_HOURS} hours`;
export const ISO_UTC_OFFSET = `+0${DATABASE_UTC_OFFSET_HOURS}:00`;

export type LocalCalendarFieldSet = "day" | "dateTime";

const localCalendarFieldOptions: Record<LocalCalendarFieldSet, Intl.DateTimeFormatOptions> = {
  day: { year: "numeric", month: "2-digit", day: "2-digit" },
  dateTime: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
};

const localCalendarFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Memoised `Intl.DateTimeFormat` lookup. The key carries the field set as well as
 * the timezone because callers ask for different fields and must not share an entry.
 */
export function localCalendarFormatter(timezone: string, fields: LocalCalendarFieldSet): Intl.DateTimeFormat {
  const key = `${fields}\u0000${timezone}`;
  const cached = localCalendarFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, ...localCalendarFieldOptions[fields] });
  localCalendarFormatters.set(key, formatter);
  return formatter;
}

/** Calendar fields for an instant, with `literal` separators dropped. */
export function localCalendarParts(instant: number | Date, timezone: string, fields: LocalCalendarFieldSet): Record<string, string> {
  const date = typeof instant === "number" ? new Date(instant) : instant;
  const parts = localCalendarFormatter(timezone, fields).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

/** Return the calendar date in an IANA timezone for an instant. */
export function localDateAt(instantOrIso: number | string, timezone: string = DATABASE_TIMEZONE): string {
  const instant = typeof instantOrIso === "string" ? Date.parse(instantOrIso) : instantOrIso;
  if (!Number.isFinite(instant)) throw new Error(`Invalid instant: ${instantOrIso}`);
  const values = localCalendarParts(instant, timezone, "day");
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Resolve a local wall-clock timestamp to an instant, including DST transitions.
 *
 * The result is an ISO string; the linear probe below is load-bearing.
 */
export function localDateTimeAt(value: string, timezone: string = DATABASE_TIMEZONE): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`Invalid local date-time: ${value}`);
  const target = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}`;
  const naive = Date.parse(`${target}Z`);
  // Deliberate linear probe: it resolves ambiguous DST wall-clock times to the *later*
  // instant. Do not replace it with a closed-form offset calculation — that changes the
  // semantic for DST roll-back hours and is a behaviour change, not an optimisation.
  for (let offset = -16 * 60; offset <= 16 * 60; offset += 15) {
    const candidate = naive - offset * 60_000;
    const values = localCalendarParts(candidate, timezone, "dateTime");
    const hour = values.hour === "24" ? "00" : values.hour;
    if (`${values.year}-${values.month}-${values.day}T${hour}:${values.minute}:${values.second}` === target) {
      return new Date(candidate).toISOString();
    }
  }
  throw new Error(`Local date-time does not exist in ${timezone}: ${value}`);
}
