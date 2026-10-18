import assert from "node:assert/strict";
import test from "node:test";

import { MOBILE_SESSION_KINDS } from "@rai/contracts";
import {
  PrescriptionDigestInputError,
  PRESCRIPTION_MAXIMUM_ABSOLUTE_VALUE,
  prescriptionDigest,
  prescriptionNumber
} from "../src/plan-digest.js";
import type { MobileSessionStructure } from "@rai/api-contracts";

/**
 * `rai-prescription-v1` is a **cross-language identity**: TypeScript hashes what
 * the iOS client exports, so the rendered bytes must be identical on both sides.
 *
 * The original TS implementation used `value.toFixed(6)` while Swift used
 * `String(format: "%.6f", locale: en_US_POSIX, value)`. Those disagree at the
 * seventh decimal (`1.0000005` → `1.000001` vs `1.000000`), which is a different
 * SHA-256 for the same prescription. The shared rule is now:
 *
 *   micro = floor(value * 1e6 + 0.5)   // exact halves toward +infinity, -0 → 0
 *   render micro as a fixed six-decimal string
 *   |value| > 1e9 or non-finite        // throw: the identity is not stable there
 *
 * The digests below are the expected values iOS must reproduce byte-for-byte. The
 * first three already exist in `apps/ios/tests/fixtures/prescription-digests.json`;
 * the rest are the boundary cases that fixture had never covered (see the review
 * note R-02).
 */

const STRUCTURE_4KM: MobileSessionStructure = {
  warmup: null,
  blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 4000 }, alert: null }] }],
  cooldown: null
};

const cases: Array<{ name: string; kind: string; structure: MobileSessionStructure | null; digest: string }> = [
  { name: "null structure", kind: "easy", structure: null, digest: "db18762a1385c31a20ac38a712ad35438164c6f13568630acb93a44118cd19f0" },
  { name: "integer 4 km", kind: "easy", structure: STRUCTURE_4KM, digest: "16ae0248a7b2fb7945b60ac16a56401b45a19aec73b1e4a1e2c917a34eb15e71" },
  {
    name: "half 1000.0000005 (rounds up)", kind: "easy",
    structure: { warmup: null, blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 1000.0000005 }, alert: null }] }], cooldown: null },
    digest: "1ee72a0b3f53ac156be2ffa83d03011bf51007dc211d7fa2fa890fd02ad084af"
  },
  {
    name: "half 1000.0000015 (rounds up; differs from toFixed)", kind: "easy",
    structure: { warmup: null, blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 1000.0000015 }, alert: null }] }], cooldown: null },
    digest: "db6ae27c3b2a3e5dbbf41544a31412f3ddb48ffcde7e716438beb07ee82adfd6"
  },
  {
    name: "heart_rate alert above the normalization clamp (digest does not clamp)", kind: "easy",
    structure: { warmup: null, blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "time", seconds: 1200 }, alert: { kind: "heart_rate", lower: 5000, upper: null } }] }], cooldown: null },
    digest: "d1844a7873978980cca145604256fdb2c3594acf30313206841a7d6faf5b8570"
  },
  {
    name: "tiny negative that quantizes to zero", kind: "easy",
    structure: { warmup: null, blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "time", seconds: 1200 }, alert: { kind: "pace", lower: -0.0000004, upper: null } }] }], cooldown: null },
    digest: "38ef975a26fe486bbf67835adc744478524f42237dfa3e2682fb09d589dd5b7c"
  },
  {
    name: "upper bound 1e9", kind: "easy",
    structure: { warmup: null, blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: 1_000_000_000 }, alert: null }] }], cooldown: null },
    digest: "bc9a82a964ce2bc80773119ce6fe9bbdd256655194549aeac8eb42be7619781a"
  },
  {
    name: "two blocks, warmup/cooldown alerts, half values", kind: "interval",
    structure: {
      warmup: { purpose: "warmup", goal: { type: "time", seconds: 600 }, alert: { kind: "heart_rate", lower: 100, upper: 150 } },
      blocks: [
        {
          iterations: 4,
          steps: [
            { purpose: "work", goal: { type: "distance", meters: 800.0000005 }, alert: { kind: "pace", lower: 270.0000005, upper: 300.0000015 } },
            { purpose: "recovery", goal: { type: "time", seconds: 90 }, alert: null }
          ]
        },
        { iterations: 2, steps: [{ purpose: "work", goal: { type: "time", seconds: 180 }, alert: { kind: "pace", lower: 280, upper: 310 } }] }
      ],
      cooldown: { purpose: "cooldown", goal: { type: "open" }, alert: { kind: "heart_rate", lower: 120, upper: null } }
    },
    digest: "0da26a0957128686eeeb32ab6c1716f6881abed46360552b4b203beabdaf14f6"
  },
  {
    name: "negative zero halves toward +infinity", kind: "easy",
    structure: { warmup: null, blocks: [{ iterations: 1, steps: [{ purpose: "work", goal: { type: "distance", meters: -0.0000005 }, alert: null }] }], cooldown: null },
    digest: "69c49d2315d14b1f0e80767b305354359852e59d3e7d6e147bf2117a73cdaf60"
  },
  {
    name: "iterations at the structural ceiling", kind: "interval",
    structure: { warmup: null, blocks: [{ iterations: 20, steps: [{ purpose: "work", goal: { type: "distance", meters: 100 }, alert: null }, { purpose: "recovery", goal: { type: "time", seconds: 60 }, alert: null }] }], cooldown: null },
    digest: "d5b2a8f5d0e9f13b90e08baf5a1ceb2c1d0beadb10f89a58e7124a499f972971"
  }
];

test("prescription digest: TS/Swift shared fixture values (including the half-value boundary)", () => {
  for (const value of cases) {
    assert.equal(prescriptionDigest(value.kind, value.structure), value.digest, value.name);
  }
});

test("prescription number: micro quantization, -0, half values and range guard", () => {
  // Half values round toward +infinity exactly like the Swift rule.
  assert.equal(prescriptionNumber(1.0000005), "1.000001");
  assert.equal(prescriptionNumber(1.0000015), "1.000002");
  assert.equal(prescriptionNumber(0.0000005), "0.000001");
  assert.equal(prescriptionNumber(-0.0000005), "0.000000");
  assert.equal(prescriptionNumber(-0.0000004), "0.000000");
  assert.equal(prescriptionNumber(-0), "0.000000", "-0 is not rendered as -0.000000");
  assert.equal(prescriptionNumber(0), "0.000000");
  assert.equal(prescriptionNumber(4000), "4000.000000");
  assert.equal(prescriptionNumber(1e9), "1000000000.000000");
  assert.equal(prescriptionNumber(-1e9), "-1000000000.000000");
  assert.equal(prescriptionNumber(1e-9), "0.000000");
  assert.equal(prescriptionNumber(-1e-9), "0.000000");

  assert.equal(PRESCRIPTION_MAXIMUM_ABSOLUTE_VALUE, 1e9);
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e9 + 1, -1e9 - 1]) {
    assert.throws(() => prescriptionNumber(invalid), PrescriptionDigestInputError, String(invalid));
  }
});

test("prescription digest: kind must be an enumeration member, so `|` cannot forge a collision", () => {
  for (const kind of MOBILE_SESSION_KINDS) {
    assert.doesNotThrow(() => prescriptionDigest(kind, null), kind);
  }
  // This pair used to hash identically: the kind carries the separator, so a null
  // structure could impersonate the empty structure of another kind.
  assert.throws(() => prescriptionDigest("easy|~|0", null), PrescriptionDigestInputError);
  assert.throws(() => prescriptionDigest("", null), PrescriptionDigestInputError);
  assert.throws(() => prescriptionDigest("EASY", null), PrescriptionDigestInputError);
  assert.notEqual(
    prescriptionDigest("easy", { warmup: null, blocks: [], cooldown: null }),
    prescriptionDigest("easy", null)
  );
});
