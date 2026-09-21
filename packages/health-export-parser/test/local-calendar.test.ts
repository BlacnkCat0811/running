import assert from "node:assert/strict";
import test from "node:test";

import { localDateAt, localDateTimeAt } from "../src/utils.js";

// Golden values captured from the pre-optimisation implementation (HEAD 41c2490).
// Caching the Intl formatters must not change a single one of them.

test("localDateAt resolves the calendar date in an IANA timezone", () => {
  assert.equal(localDateAt(0), "1970-01-01");
  assert.equal(localDateAt(0, "UTC"), "1970-01-01");
  assert.equal(localDateAt("2023-10-31T15:30:16.000Z", "Asia/Shanghai"), "2023-10-31");
  assert.equal(localDateAt("2024-06-13T16:00:00.000Z", "Asia/Shanghai"), "2024-06-14");
  assert.equal(localDateAt("2024-12-31T16:00:00.000Z", "Asia/Shanghai"), "2025-01-01");
  assert.equal(localDateAt("2026-09-20T22:30:30.000Z", "Asia/Shanghai"), "2026-09-21");
  assert.equal(localDateAt("2024-11-03T05:30:00.000Z", "America/New_York"), "2024-11-03");
  assert.equal(localDateAt(1_700_000_000_000, "UTC"), "2023-11-14");
});

test("localDateAt rejects an instant it cannot parse", () => {
  assert.throws(() => localDateAt("not-a-date"), /Invalid instant/);
});

test("localDateTimeAt resolves a local wall-clock time to an instant", () => {
  assert.equal(localDateTimeAt("2024-06-13T18:00:00", "Asia/Shanghai"), "2024-06-13T10:00:00.000Z");
  assert.equal(localDateTimeAt("2024-06-13T00:00:00", "Asia/Shanghai"), "2024-06-12T16:00:00.000Z");
  assert.equal(localDateTimeAt("2024-06-13T14:00:00", "Asia/Shanghai"), "2024-06-13T06:00:00.000Z");
  assert.equal(localDateTimeAt("2023-10-30T18:00:00", "Asia/Shanghai"), "2023-10-30T10:00:00.000Z");
});

test("localDateTimeAt accepts a minute-precision value and a non-default timezone", () => {
  assert.equal(localDateTimeAt("2024-06-13T12:00", "Asia/Shanghai"), "2024-06-13T04:00:00.000Z");
  assert.equal(localDateTimeAt("2024-06-13T04:00:00", "UTC"), "2024-06-13T04:00:00.000Z");
});

// Shanghai has never observed DST, so the production timezone cannot cover this path.
test("localDateTimeAt resolves an ambiguous DST fall-back to the later instant", () => {
  assert.equal(
    localDateTimeAt("2024-11-03T01:30:00", "America/New_York"),
    "2024-11-03T06:30:00.000Z",
  );
});

test("localDateTimeAt rejects a wall-clock time that does not exist", () => {
  assert.throws(
    () => localDateTimeAt("2024-03-10T02:30:00", "America/New_York"),
    /does not exist in America\/New_York/,
  );
  assert.throws(() => localDateTimeAt("2024-06-13"), /Invalid local date-time/);
});

// Mutation guard: if the per-key cache is removed (or two field sets are collapsed onto
// one key), repeated calls start constructing a formatter each time and this turns red.
test("formatter construction is bounded per (timezone, field set)", () => {
  const Real = Intl.DateTimeFormat;
  let constructions = 0;
  Intl.DateTimeFormat = function (
    this: unknown,
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    constructions += 1;
    return new Real(...args);
  } as unknown as typeof Intl.DateTimeFormat;
  try {
    for (let index = 0; index < 200; index += 1) {
      localDateAt(1_700_000_000_000 + index * 86_400_000, "Asia/Shanghai");
      localDateTimeAt("2024-06-13T18:00:00", "Asia/Shanghai");
      localDateTimeAt("2024-06-13T18:00:00", "Europe/Berlin");
      localDateAt(1_700_000_000_000, "Europe/Berlin");
    }
  } finally {
    Intl.DateTimeFormat = Real;
  }
  assert.ok(
    constructions <= 6,
    `expected the formatter cache to bound constructions to a handful, saw ${constructions}`,
  );
});
