import assert from "node:assert/strict";
import test from "node:test";
import { MAX_BLOCKS, MAX_BLOCK_ITERATIONS, MAX_STEPS_PER_BLOCK, normalizeSessionStructure, sessionStructureWithinWriteLimits } from "../src/session-structure.js";

function normalizedAlert(lower: unknown, upper: unknown) {
  return normalizeSessionStructure({
    blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 2600 }, alert: { kind: "pace", lower, upper } }] }]
  })?.blocks[0]?.steps[0]?.alert;
}

test("missing pace edges stay missing rather than becoming one second per km", () => {
  for (const missing of [null, undefined, "", " ", false]) {
    assert.deepEqual(normalizedAlert(missing, 423), { kind: "pace", lower: null, upper: 423 });
    assert.deepEqual(normalizedAlert(380, missing), { kind: "pace", lower: 380, upper: null });
  }
  assert.equal(normalizedAlert(null, null), null);
});

test("corrupt pace targets are dropped, not clamped into sprint targets", () => {
  for (const invalid of [1, 60, 0, -5, 1201]) assert.equal(normalizedAlert(invalid, 423), null);
  assert.deepEqual(normalizedAlert(423, 380), { kind: "pace", lower: 380, upper: 423 });
});


test("D-03: legacy normalization keeps nine steps; strict quantity limits are independent of reads", () => {
  const step = { purpose: "work" as const, goal: { type: "distance" as const, meters: 100 }, alert: null };
  const structure = { warmup: null, cooldown: null, blocks: [{ iterations: 1, steps: Array.from({ length: 9 }, () => step) }] };
  assert.deepEqual(normalizeSessionStructure(structure), structure);
  assert.equal(sessionStructureWithinWriteLimits(structure), false);
  assert.equal(sessionStructureWithinWriteLimits({ ...structure, blocks: [{ iterations: 20, steps: Array(8).fill(step) }] }), true);
  assert.equal(sessionStructureWithinWriteLimits({ ...structure, blocks: [{ iterations: 21, steps: [step] }] }), false);
  assert.equal(sessionStructureWithinWriteLimits({ ...structure, blocks: Array(8).fill({ iterations: 1, steps: [step] }) }), true);
  assert.equal(sessionStructureWithinWriteLimits({ ...structure, blocks: Array(9).fill({ iterations: 1, steps: [step] }) }), false);
  assert.deepEqual([MAX_BLOCKS, MAX_STEPS_PER_BLOCK, MAX_BLOCK_ITERATIONS], [8, 8, 20]);
});
