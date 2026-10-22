import assert from "node:assert/strict";
import test from "node:test";
import {
  WINDOW_SELECTION_VERSION,
  expectedWindowIndex,
  selectTrainingWindows
} from "../../../scripts/phase2-series-window-selection.mjs";

const session = (id, day, options = {}) => ({
  id,
  startedAt: `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  endedAt: `2026-01-${String(day).padStart(2, "0")}T01:00:00.000Z`,
  ...options
});

const byName = (selection) => Object.fromEntries(selection.windows.map((window) => [window.name, window]));

test("five increasing sessions map oldest/recent correctly and keep count quantiles", () => {
  const selection = selectTrainingWindows([
    session("s0", 1), session("s1", 2), session("s2", 3), session("s3", 4), session("s4", 5)
  ]);
  const windows = byName(selection);

  assert.equal(selection.readableSessions, 5);
  assert.equal(selection.selection.version, WINDOW_SELECTION_VERSION);
  assert.equal(windows.oldest.id, "s0");
  assert.equal(windows.oldest.indexFromOldest, 0);
  assert.equal(windows.recent.id, "s4");
  assert.equal(windows.recent.indexFromOldest, 4);
  assert.equal(windows.p25.id, "s1");
  assert.equal(windows.p25.indexFromOldest, 1);
  assert.equal(windows.p50.id, "s2");
  assert.equal(windows.p50.indexFromOldest, 2);
  assert.equal(windows.p75.id, "s3");
  assert.equal(windows.p75.indexFromOldest, 3);
  assert.equal(windows.recent.startedAt, "2026-01-05T00:00:00.000Z");
  assert.equal(windows.oldest.startedAt, "2026-01-01T00:00:00.000Z");
});

test("selection sorts by startedAt then training id and is repeatable", () => {
  const shuffled = [
    session("s3", 4), session("s0", 1), session("s4", 5), session("s2", 3), session("s1", 2)
  ];
  const first = selectTrainingWindows(shuffled);
  const second = selectTrainingWindows(shuffled);
  assert.deepEqual(
    first.windows.map((window) => [window.name, window.id, window.indexFromOldest]),
    second.windows.map((window) => [window.name, window.id, window.indexFromOldest])
  );
  assert.equal(byName(first).oldest.id, "s0");
  assert.equal(byName(first).recent.id, "s4");

  const tied = [
    session("c", 1), session("a", 1), session("b", 1)
  ];
  const tiedWindows = byName(selectTrainingWindows(tied));
  assert.equal(tiedWindows.oldest.id, "a");
  assert.equal(tiedWindows.p25.id, "a");
  assert.equal(tiedWindows.p50.id, "b");
  assert.equal(tiedWindows.p75.id, "b");
  assert.equal(tiedWindows.recent.id, "c");
});

test("soft-deleted sessions are filtered before choosing windows", () => {
  const selection = selectTrainingWindows([
    session("s0", 1, { deletedAt: "2026-01-06T00:00:00.000Z" }),
    session("s1", 2),
    session("s2", 3, { deletedAt: "2026-01-06T00:00:00.000Z" }),
    session("s3", 4),
    session("s4", 5, { deletedAt: "2026-01-06T00:00:00.000Z" })
  ]);
  const ids = selection.windows.map((window) => window.id);
  assert.deepEqual([...new Set(ids)].sort(), ["s1", "s3"]);
  assert.equal(byName(selection).oldest.id, "s1");
  assert.equal(byName(selection).recent.id, "s3");
  assert.equal(selection.readableSessions, 2);
});

test("a single readable session may fill all five windows and is recorded explicitly", () => {
  const selection = selectTrainingWindows([session("only", 1)]);
  for (const window of selection.windows) {
    assert.equal(window.id, "only");
    assert.equal(window.indexFromOldest, 0);
    assert.equal(window.startedAt, "2026-01-01T00:00:00.000Z");
  }
  assert.equal(selection.readableSessions, 1);
});

test("no readable session is a hard failure", () => {
  assert.throws(() => selectTrainingWindows([]), /no readable training sessions/);
  assert.throws(
    () => selectTrainingWindows([session("s0", 1, { deletedAt: "2026-01-02T00:00:00.000Z" })]),
    /no readable training sessions/
  );
});

test("expected index is derived from the shared readable-session total", () => {
  assert.equal(expectedWindowIndex("oldest", 5), 0);
  assert.equal(expectedWindowIndex("p25", 5), 1);
  assert.equal(expectedWindowIndex("p50", 5), 2);
  assert.equal(expectedWindowIndex("p75", 5), 3);
  assert.equal(expectedWindowIndex("recent", 5), 4);
  assert.equal(expectedWindowIndex("recent", 1), 0);
  assert.equal(expectedWindowIndex("p50", 2), 0);
  assert.throws(() => expectedWindowIndex("recent", 0), /readableSessions/);
  assert.throws(() => expectedWindowIndex("unknown", 5), /unknown window name/);
});
