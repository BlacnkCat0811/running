/**
 * Strict local calendar-date helpers — `YYYY-MM-DD` only, and only dates that
 * actually exist in the proleptic Gregorian calendar.
 *
 * `isValidLocalDate` is the original name and stays the shared contract: plan
 * periodisation, weekly capacity, run-coach config, receipts and execution
 * assessment all have to agree on what "a local date" is. The `isStrictLocalDate`
 * alias exists because the looser regex-plus-`Date.parse` checks that once lived
 * beside each of those callers accepted strings such as `2026-02-30` — V8 shifts
 * that to 2 March, so a skeleton built from it had a `generatedFor` that did not
 * name the week it was computed for.
 */
export function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(0);
  probe.setUTCHours(0, 0, 0, 0);
  probe.setUTCFullYear(year, month, 0);
  return day <= probe.getUTCDate();
}

/** Explicit alias for callers that were using a local (looser) duplicate. */
export const isStrictLocalDate = isValidLocalDate;

/** The value itself when it is a real local date, otherwise `null`. */
export function parseStrictLocalDate(value: string): string | null {
  return isValidLocalDate(value) ? value : null;
}
