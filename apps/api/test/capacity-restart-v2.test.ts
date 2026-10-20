import assert from "node:assert/strict";
import test from "node:test";

import { legacyCapacityHistory } from "../src/data.js";
import {
  CAPACITY_RESTART_POLICY_VERSION,
  LEGACY_HISTORY_CAP_FRACTION,
  LEGACY_HISTORY_DECAY,
  LEGACY_HISTORY_RELEASE_WEEKS,
  legacyRestartBaseline,
  weeklyCapacity
} from "../src/weekly-capacity.js";

/**
 * G02-C (signed 2026-10-20): decayed legacy-history restart.
 *
 * Frozen here: the decay coefficient (0.5), the 0.7 cap, the four-week release,
 * the 28-day gap and the fact that the gap itself never raises the baseline. The
 * restart is the only place old history may anchor capacity; normal recent-volume
 * paths are untouched.
 */

const monday = "2026-10-19";
const weeksBefore = (from: string, count: number): string[] => {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => new Date(start - (count - index) * 7 * 86_400_000).toISOString().slice(0, 10));
};

const metricsFor = (weekStarts: string[], kmPerWeek: number) => weekStarts.map((week) => ({
  localDate: week,
  distanceMeters: kmPerWeek * 1000
}));

test("G02-C 常量与衰减：0.5 衰减、0.7 封顶、连续 4 周才释放", () => {
  assert.equal(CAPACITY_RESTART_POLICY_VERSION, "rai-capacity-restart-v2");
  assert.equal(LEGACY_HISTORY_DECAY, 0.5);
  assert.equal(LEGACY_HISTORY_CAP_FRACTION, 0.7);
  assert.equal(LEGACY_HISTORY_RELEASE_WEEKS, 4);
  // No old window → nothing to decay.
  assert.deepEqual(legacyRestartBaseline({ stableWeeklyKm: 0, observedRecentWeeks: 4 }),
    { released: false, baselineKm: 0, reasonCodes: ["legacy_history_absent"] });
  // Observed but not enough consecutive weeks → not released.
  assert.deepEqual(legacyRestartBaseline({ stableWeeklyKm: 40, observedRecentWeeks: 3 }),
    { released: false, baselineKm: 0, reasonCodes: ["legacy_history_not_released"] });
  // Released: 40 km × 0.5 = 20 km, never above 40 × 0.7 = 28 km.
  const released = legacyRestartBaseline({ stableWeeklyKm: 40, observedRecentWeeks: 4 });
  assert.equal(released.released, true);
  assert.equal(released.baselineKm, 20);
  assert.deepEqual(released.reasonCodes, ["legacy_history_restart", "legacy_history_decay_0.5"]);
  // The floor still applies to a tiny old window.
  assert.equal(legacyRestartBaseline({ stableWeeklyKm: 4, observedRecentWeeks: 4 }).baselineKm, 5);
});

test("稳定窗口与观测周都按自然周计算，缺口本身不抬高容量", () => {
  // Four stable weeks ending 28 days before the current week.
  const oldWeeks = weeksBefore(monday, 8).slice(0, 4);
  const history = legacyCapacityHistory(metricsFor(oldWeeks, 40), metricsFor(weeksBefore(monday, 4), 0), monday);
  assert.equal(history.stableWeeklyKm, 40);
  assert.equal(history.observedRecentWeeks, 4);
  // A partial old window is not a stable window.
  const partial = legacyCapacityHistory(metricsFor(oldWeeks.slice(0, 3), 40), [], monday);
  assert.equal(partial.stableWeeklyKm, 0);
  assert.equal(partial.observedRecentWeeks, 0);
});

test("weeklyCapacity：冷启动 + 已释放的旧历史 → legacy_history；未释放仍是 5 km", () => {
  const released = weeklyCapacity({ today: monday, recentWeeklyKm: 0, previousWeekDistanceKm: null,
    legacyHistory: { stableWeeklyKm: 40, observedRecentWeeks: 4 } });
  assert.equal(released.source, "legacy_history");
  assert.equal(released.baselineKm, 20);
  assert.equal(released.coldStart, false);
  assert.ok(released.reasonCodes.includes("legacy_history_restart"));
  const blocked = weeklyCapacity({ today: monday, recentWeeklyKm: 0, previousWeekDistanceKm: null,
    legacyHistory: { stableWeeklyKm: 40, observedRecentWeeks: 2 } });
  assert.equal(blocked.source, "no_history");
  assert.equal(blocked.baselineKm, 5);
  assert.ok(blocked.reasonCodes.includes("legacy_history_not_released"));
  // The legacy window may not raise capacity when recent volume exists.
  const recent = weeklyCapacity({ today: monday, recentWeeklyKm: 20, previousWeekDistanceKm: null,
    legacyHistory: { stableWeeklyKm: 40, observedRecentWeeks: 4 } });
  assert.notEqual(recent.source, "legacy_history");
});
