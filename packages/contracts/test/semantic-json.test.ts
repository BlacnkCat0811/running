import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSemanticJson, SemanticJsonError } from "../src/index.js";

test("normalises object key order and preserves array order", () => {
  const left = { b: 1, a: [{ y: 1, x: 2 }, "s"] };
  const right = { a: [{ x: 2, y: 1 }, "s"], b: 1 };
  assert.equal(canonicalSemanticJson(left), canonicalSemanticJson(right));
  assert.notEqual(canonicalSemanticJson({ a: [1, 2] }), canonicalSemanticJson({ a: [2, 1] }));
});

test("keeps null distinct from absent", () => {
  assert.equal(canonicalSemanticJson({ a: null }), '{"a":null}');
  assert.notEqual(canonicalSemanticJson({ a: null }), canonicalSemanticJson({}));
});

test("throws on non-finite numbers instead of silently writing null", () => {
  // The trap this guards: JSON.stringify turns NaN into null, so a hash taken
  // over stringified output can look stable while the value is already garbage.
  assert.equal(JSON.stringify({ value: Number.NaN }), '{"value":null}');
  assert.throws(() => canonicalSemanticJson({ value: Number.NaN }), SemanticJsonError);
  assert.throws(() => canonicalSemanticJson({ value: Number.POSITIVE_INFINITY }), SemanticJsonError);
  assert.throws(() => canonicalSemanticJson([1, Number.NEGATIVE_INFINITY]), SemanticJsonError);
});

test("reports the path of the offending value", () => {
  assert.throws(
    () => canonicalSemanticJson({ a: { b: [1, Number.NaN] } }),
    (error: unknown) => error instanceof SemanticJsonError && error.path === "$.a.b[1]"
  );
});

test("excludes declared operational metadata only", () => {
  const withMetadata = { value: 1, createdAt: "2026-01-01T00:00:00.000Z", durationMs: 12 };
  assert.equal(
    canonicalSemanticJson(withMetadata, { ignoreKeys: ["createdAt", "durationMs"] }),
    canonicalSemanticJson({ value: 1 })
  );
  // A declared-ignored key list that is too short must not collapse the hash.
  assert.notEqual(
    canonicalSemanticJson(withMetadata, { ignoreKeys: ["createdAt"] }),
    canonicalSemanticJson({ value: 1 })
  );
});

test("drops undefined object properties the way JSON.stringify does, but rejects them elsewhere", () => {
  assert.equal(canonicalSemanticJson({ keep: 1, drop: undefined }), '{"keep":1}');
  assert.throws(() => canonicalSemanticJson([undefined]), SemanticJsonError);
  assert.throws(() => canonicalSemanticJson(undefined), SemanticJsonError);
});

test("rejects values JSON.stringify would silently mangle", () => {
  assert.throws(() => canonicalSemanticJson({ at: new Date("2026-01-01T00:00:00.000Z") }), SemanticJsonError);
  assert.throws(() => canonicalSemanticJson({ map: new Map() }), SemanticJsonError);
  assert.throws(() => canonicalSemanticJson({ fn: () => 1 }), SemanticJsonError);
});
