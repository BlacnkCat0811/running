import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSessionStructure } from "../src/session-structure.js";

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
