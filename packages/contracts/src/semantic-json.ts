// Deterministic JSON canonicalisation for semantic output hashing.
//
// `RAI_ALGORITHM_V2_OPTIMIZATION_2026-09-28.md` §3.2 requires that two runs over
// the same facts and the same config produce the same semantic hash, while
// operational metadata (timestamps, task ids, durations) is allowed to differ.
// That needs rules stricter than `JSON.stringify`:
//
// 1. Non-finite numbers throw. `JSON.stringify` silently rewrites `NaN` and
//    `Infinity` to `null`, so a hash taken over stringified output can look
//    stable while the underlying value is already garbage, and a "there is no
//    NaN in the output" assertion written against that string is a false
//    assertion. Failing loudly is what keeps such a check meaningful.
// 2. Object key order is normalised; array order is preserved. Arrays carry
//    meaning (samples, ids); object keys do not.
// 3. Only plain objects, arrays, strings, finite numbers, booleans and null are
//    accepted. `Date`, `Map`, class instances and functions are rejected rather
//    than silently reduced to `{}` or dropped from the tree.

export class SemanticJsonError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string
  ) {
    super(`Cannot canonicalise semantic JSON at ${path}: ${reason}`);
    this.name = "SemanticJsonError";
  }
}

export interface CanonicalSemanticJsonOptions {
  /**
   * Object keys excluded anywhere in the tree. Use for declared operational
   * metadata only — never to hide a value that carries algorithmic meaning, or
   * the resulting hash stops describing the result.
   */
  readonly ignoreKeys?: readonly string[];
}

/**
 * Serialise `value` so that equal semantic content always yields the same
 * string, independent of key insertion order and of excluded metadata.
 *
 * Note on `-0`: it serialises as `0`, matching `JSON.stringify`. Equal-content
 * hashing intentionally treats them as the same value.
 */
export function canonicalSemanticJson(
  value: unknown,
  options: CanonicalSemanticJsonOptions = {}
): string {
  const ignored = new Set(options.ignoreKeys ?? []);
  return serialise(value, "$", ignored);
}

function serialise(value: unknown, path: string, ignored: ReadonlySet<string>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SemanticJsonError(path, `non-finite number (${String(value)})`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => serialise(item, `${path}[${index}]`, ignored))
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SemanticJsonError(path, "only plain objects and arrays can be canonicalised");
    }
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    // `sort()` without a comparator compares UTF-16 code units, which is stable
    // across runs and platforms — the property this function needs.
    for (const key of Object.keys(record).sort()) {
      if (ignored.has(key)) continue;
      const child = record[key];
      // Mirrors `JSON.stringify`: an `undefined` property is dropped, not nulled.
      if (child === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serialise(child, `${path}.${key}`, ignored)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new SemanticJsonError(path, `unsupported ${typeof value} value`);
}
