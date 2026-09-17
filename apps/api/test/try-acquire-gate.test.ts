import assert from "node:assert/strict";
import test from "node:test";

import { TryAcquireGate } from "../src/try-acquire-gate.js";

test("try-acquire gate fails fast and releases idempotently", () => {
  const gate = new TryAcquireGate();
  const release = gate.tryAcquire();
  assert.ok(release);
  assert.equal(gate.tryAcquire(), null);
  release();
  release();
  assert.ok(gate.tryAcquire());
});
