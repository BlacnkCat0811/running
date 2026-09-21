import assert from "node:assert/strict";
import test from "node:test";

import {
  DATABASE_TIMEZONE,
  DATABASE_UTC_OFFSET_HOURS,
  ISO_UTC_OFFSET,
  SQL_UTC_OFFSET_MODIFIER,
  localCalendarFormatter,
  localDateAt,
  localDateTimeAt
} from "../src/index.js";

// The three shapes of the offset must agree with the IANA zone. A fixed offset is exact
// here only because Asia/Shanghai has observed no DST since 1991 — if that ever changed,
// the SQL modifier and the ISO offset would silently disagree with `DATABASE_TIMEZONE`.
test("the offset constants agree with the database timezone", () => {
  assert.equal(DATABASE_TIMEZONE, "Asia/Shanghai");
  assert.equal(DATABASE_UTC_OFFSET_HOURS, 8);
  assert.equal(SQL_UTC_OFFSET_MODIFIER, "+8 hours");
  assert.equal(ISO_UTC_OFFSET, "+08:00");

  const localHour = new Intl.DateTimeFormat("en-CA", {
    timeZone: DATABASE_TIMEZONE,
    hour: "2-digit",
    hour12: false
  });
  // 12:00Z is 20:00 in UTC+8, in winter and in summer alike.
  assert.equal(localHour.format(new Date("2026-01-15T12:00:00Z")), "20");
  assert.equal(localHour.format(new Date("2026-07-15T12:00:00Z")), "20");
});

// Mutation guard: this asserts identity, not just value. Remove the per-key cache in
// `timezone.ts` and the first assertion turns red; collapse the two field sets onto one
// key and the second does.
test("localCalendarFormatter memoises per (timezone, field set)", () => {
  const day = localCalendarFormatter("Asia/Shanghai", "day");
  assert.strictEqual(day, localCalendarFormatter("Asia/Shanghai", "day"));

  // Different field sets must not share an entry — they format different things.
  assert.notStrictEqual(day, localCalendarFormatter("Asia/Shanghai", "dateTime"));
  // Different timezones must not share an entry either.
  assert.notStrictEqual(day, localCalendarFormatter("Europe/Berlin", "day"));
});

// Golden values captured from the pre-optimisation implementation (HEAD 41c2490).
// Moving the helpers from `@rai/health-export-parser` to `@rai/contracts` must not
// change a single one of them.
test("timezone helpers keep the pre-optimisation output", () => {
  assert.equal(localDateAt(0), "1970-01-01");
  assert.equal(localDateAt("2024-12-31T16:00:00.000Z"), "2025-01-01");
  assert.equal(localDateAt("2024-12-31T16:00:00.000Z", "UTC"), "2024-12-31");
  assert.equal(localDateAt(1_700_000_000_000, "UTC"), "2023-11-14");
  assert.equal(localDateTimeAt("2024-06-13T18:00:00"), "2024-06-13T10:00:00.000Z");
  assert.equal(localDateTimeAt("2024-06-13T00:00:00"), "2024-06-12T16:00:00.000Z");
  assert.throws(() => localDateAt("not-a-date"), /Invalid instant/);
});

// Shanghai has never observed DST, so the production timezone cannot cover this path.
test("the deliberate DST probe survives the move", () => {
  assert.equal(
    localDateTimeAt("2024-11-03T01:30:00", "America/New_York"),
    "2024-11-03T06:30:00.000Z"
  );
  assert.throws(
    () => localDateTimeAt("2024-03-10T02:30:00", "America/New_York"),
    /does not exist in America\/New_York/
  );
});
