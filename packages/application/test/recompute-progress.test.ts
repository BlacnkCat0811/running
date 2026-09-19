import assert from "node:assert/strict";
import test from "node:test";
import { RecomputeProgressGate } from "../src/services/recompute-progress.js";

test("coalesces intermediate progress but publishes boundaries and periodic updates", () => {
  let now = 0;
  const gate = new RecomputeProgressGate(() => now);
  assert.equal(gate.shouldPublish("a", "features", 0, 100), true);
  for (let i = 1; i < 90; i++) assert.equal(gate.shouldPublish("a", "features", i, 100), false);
  now = 250;
  assert.equal(gate.shouldPublish("a", "features", 90, 100), true);
  assert.equal(gate.shouldPublish("a", "features", 91, 100), false);
  assert.equal(gate.shouldPublish("a", "features", 100, 100), true);
  assert.equal(gate.shouldPublish("a", "replay", 0, 100), true);
  assert.equal(gate.shouldPublish("a", "replay", 1, 100), false);
  assert.equal(gate.shouldPublish("a", "replay", 0, 100), true);
  assert.equal(gate.shouldPublish("b", "replay", 1, 100), true);
  assert.equal(gate.shouldPublish("b", "replay", 2, 200), true);
  assert.equal(gate.shouldPublish("b", "empty", 0, 0), true);
});
