import assert from "node:assert/strict";
import test from "node:test";
import { BoundedCache } from "../src/services/bounded-cache.js";

test("record LRU respects sample budget, evicts least recently used, and resets per run", () => {
  const cache = new BoundedCache<number[]>(2, 3);
  cache.set("a", [1], 1); cache.set("b", [2], 1);
  assert.deepEqual(cache.get("a"), [1]);
  cache.set("c", [3, 4], 2);
  assert.equal(cache.get("b"), undefined);
  assert.deepEqual(cache.get("a"), [1]);
  cache.set("oversize", [1, 2, 3, 4], 4);
  assert.equal(cache.get("oversize"), undefined);
  cache.clear();
  assert.equal(cache.hits, 0);
  assert.equal(cache.get("a"), undefined);
});
