import { createHash } from "node:crypto";

import { stableId } from "./utils.js";

/**
 * Identity-algorithm fingerprint —— turns "the algorithm that maps a payload to
 * its derived ids and content hashes" into a value that can be compared, folded
 * into a digest, and frozen.
 *
 * ## The failure it exists to stop
 *
 * `importPayloadSha256` (`apps/api/src/import-payload-identity.ts`) folds in the
 * payload content, `CONTRACT_VERSION`, the deletion semantics and the execution
 * engine. The only thing that could notice "the algorithm changed while the
 * payload bytes did not" was a **manual** bump of `CONTRACT_VERSION`, and nothing
 * in the repository failed when that bump was forgotten. The consequence of
 * forgetting is a **silent no-op**: the anchor keeps matching, the pre-flight
 * short-circuits, and the new algorithm never reaches the database it was
 * supposed to rewrite.
 *
 * That is not hypothetical. Two changes of this family have already landed:
 * `6c61a9a` (dropping the `device` dimension from record ids, eventually
 * repaired by the v22 full-database migration) and `a9b0759` (adding object-key
 * canonicalisation to `stableId`). The second only escaped because the payload
 * anchor did not exist yet.
 *
 * ## Why this hashes *behaviour*, never source text
 *
 * The migration freeze (`FROZEN_MIGRATION_CHECKSUMS` in `@rai/storage-sqlite`) is
 * the precedent, and also the cautionary tale: hashing `up.toString()` makes the
 * current behaviour of the build tool part of persisted data, so swapping the
 * execution channel or upgrading esbuild moves the frozen values for no
 * algorithmic reason. This function hashes **what the algorithm computes** —
 * the same probe inputs yield the same ids under the same algorithm, regardless
 * of the execution channel, comments, whitespace or transpiler version.
 *
 * ## The two consumers
 *
 *  1. **Runtime (removes the silent case entirely).** `import-worker` folds
 *     `identityAlgorithmFingerprint()` into the payload digest, so an algorithm
 *     change invalidates the anchor by itself and costs one full import — which
 *     is what it should cost. Nobody has to remember anything.
 *  2. **Test-time sentinel (tells a human).** `FROZEN_IDENTITY_ALGORITHM` pins
 *     the current fingerprint, so an algorithm change turns a test red and says
 *     out loud: "you changed the identity algorithm; the live anchor will
 *     invalidate and the next import runs the full path. Confirm that is
 *     intended, and whether `CONTRACT_VERSION` also needs a bump because the
 *     parsing rules changed too."
 */
export const IDENTITY_ALGORITHM_PROBES: ReadonlyArray<[string, unknown[]]> = [
  // ── The shape every real primary key has: a flat array of primitives.
  //    record / workout / route / training_session / canonical_night /
  //    workout_group / canonical_hrv_day and the job ids all look like this.
  ["record", ["HKQuantityTypeIdentifierHeartRate", "唐攀的Apple Watch", "2026-09-01T10:00:00.000Z"]],
  ["workout", ["HKWorkoutActivityTypeRunning", "唐攀的Apple Watch", "sync-identifier-1"]],
  ["route", ["uuid-1", "gpx/routes/UUID-1.gpx"]],
  // The timezone slot carries "Asia-Shanghai" rather than the real identifier on
  // purpose: `packages/contracts/test/timezone-convergence.test.ts` forbids bare
  // timezone literals outside `@rai/contracts`, and a probe only needs *a* string.
  ["canonical_night", ["2026-09-01", "Asia-Shanghai", "core", "唐攀的Apple Watch", "2026-08-31T23:10:00.000Z"]],
  ["canonical_hrv_day", ["2026-09-01", "Asia-Shanghai", "canonical_night_abc"]],
  ["training_session", ["workout_group_abc"]],
  // `cli.ts` hashes the manifest fingerprints as an array of {key,value} objects.
  ["dataset", [{ key: "source_xml_sha256", value: "a" }, { key: "source_gpx_bundle_sha256", value: "b" }]],
  ["import_batch", ["2026-09-01T10:00:00.000Z", "/tmp/export.xml"]],

  // ── canonicalize branch 1: arrays keep their order (a sequence, not a set).
  ["x", [[1, 2, 3]]],
  ["x", [[3, 2, 1]]],

  // ── canonicalize branch 2: primitives and null pass straight through.
  ["x", [null]],
  ["x", [undefined]],
  ["x", [0]],
  ["x", [""]],
  ["x", [false]],
  ["x", []],

  // ── canonicalize branch 3: non-plain objects pass through untouched
  //    (the `Object.getPrototypeOf` test), so JSON.stringify's own handling
  //    applies rather than this function flattening them to `{}`.
  ["x", [new Date("2026-01-01T00:00:00.000Z")]],
  ["x", [new Map([["k", 1]])]],
  ["x", [new Set([1, 2])]],
  ["x", [Object.create(null)]],
  ["x", [{ plain: 1, nested: new Date("2026-01-01T00:00:00.000Z") }]],

  // ── canonicalize branch 4: plain objects hash by sorted key, which is the
  //    exact property `a9b0759` added and the exact property the payload anchor
  //    cannot see. The two `record_content` probes below must stay equal to each
  //    other; the two `workout_content` probes likewise.
  ["record_content", [{ activeEnergy: 1, distance: 2 }]],
  ["record_content", [{ distance: 2, activeEnergy: 1 }]],
  ["workout_content", [{ metadata: { HKA: ["v-HKA"], HKB: ["v-HKB"] }, indoor: true }]],
  ["workout_content", [{ indoor: true, metadata: { HKB: ["v-HKB"], HKA: ["v-HKA"] } }]],
  // Reserved keys are payload data; fixes here must invalidate existing import anchors.
  ["record_content", [JSON.parse('{"__proto__":"raw-data","constructor":"data"}')]],
  ["workout_content", [{ metadata: JSON.parse('{"__proto__":["data"],"constructor":["data"]}') }]],
  ["x", [{ "": 1, z: 2 }]],
  ["x", [{ a: { b: { c: [1, { d: null }, []] } } }]],

  // ── stableId's `\0` separator between kind and payload. Without it the pairs
  //    below could not be told apart.
  ["x", ["a", "b"]],
  ["x\u0000a", ["b"]],
  ["x", ["a\u0000b"]],

  // ── stableId's JSON encoding step: number precision, `-0`, `\uXXXX` escaping,
  //    and the NaN/Infinity-to-null collapse that JSON.stringify performs.
  ["x", [0.1 + 0.2]],
  ["x", [Number.MAX_SAFE_INTEGER]],
  ["x", [Number.MAX_SAFE_INTEGER + 2]],
  ["x", [1e21]],
  ["x", [-0]],
  ["x", ["中文🧭"]],
  ["x", [{ a: Number.NaN, b: Number.POSITIVE_INFINITY }]],
  ["x", [{ a: "1", b: 1 }]]
];

/**
 * sha256 over every probe's `stableId`, in order.
 *
 * Pure and total: no filesystem, no environment, no clock, no timezone. Any
 * change to `stableId`, to `canonicalize`, or to the JSON encoding step moves it;
 * a comment, a rename of a local, or a different transpiler does not.
 */
export function identityAlgorithmFingerprint(): string {
  const hash = createHash("sha256");
  hash.update("rai.identity-algorithm.v1");
  for (const [kind, parts] of IDENTITY_ALGORITHM_PROBES) {
    hash.update("\u0000");
    hash.update(kind);
    hash.update("\u0001");
    hash.update(stableId(kind, parts));
  }
  return hash.digest("hex");
}

/**
 * The frozen fingerprint, pinned by `test/identity-algorithm.test.ts`.
 *
 * ⚠️ When this assertion fails, the algorithm changed. That is a **deliberate**
 * tripwire, not a broken test: do not "fix" it by pasting the new value without
 * answering both questions first —
 *
 *  1. Is the algorithm change intended, and is a full re-import of the live
 *     database (which invalidates every anchor and rewrites derived ids) an
 *     acceptable cost right now? The project's backup policy keeps a rollback
 *     window of well under an hour, so a full import consumes part of it.
 *  2. Did the change also alter what the payload *means* (parsing or
 *     normalisation)? If so, `CONTRACT_VERSION`
 *     (`packages/contracts/src/index.ts`) needs its own bump, because that is
 *     the only thing that can invalidate an anchor without the algorithm moving.
 */
// Reserved-key content hashing changed; primitive-array record IDs did not.
export const FROZEN_IDENTITY_ALGORITHM = "6f9f88cfc3884becfd2d96bd49efe898064451b285ccaf39a6889b5038edca75";
