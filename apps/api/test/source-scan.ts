import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Comments removed, string literals kept.
 *
 * A regex would be fooled both ways: `Text("https://x").tag("steady")` contains
 * a `//` inside a literal, and `// .tag("steady")` is a comment that looks like
 * a picker. This walks the source instead — literals are copied through
 * untouched, comments are dropped.
 */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') {
        if (source[end] === "\\") end += 1;
        end += 1;
      }
      out += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Every `.ts` file under a directory, recursively — a route module would land in a subdirectory. */
export function sourceFiles(root: URL): string[] {
  const found: string[] = [];
  const walk = (directory: URL): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts")) found.push(fileURLToPath(child));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Every Swift source under `apps/ios/RAI`, found rather than listed.
 *
 * The session-kind guard used to name the two skin files explicitly, which meant
 * a third skin — or a picker moved to a new file — would simply not be checked.
 */
export function swiftSources(): string[] {
  const root = fileURLToPath(new URL("../../ios/RAI/", import.meta.url));
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${directory}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else if (entry.name.endsWith(".swift")) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

/** A file's contents with comments stripped, for the text-level guards. */
export function readStripped(target: URL | string): string {
  return stripComments(readFileSync(target, "utf8"));
}

/**
 * The `{ … }` block starting at `openIndex`, brace-balanced and inclusive.
 *
 * The Swift guards have to reason about *which rows a loop walks*: the rule
 * lives inside the closure, and no line-at-a-time regex can see where the
 * closure ends. String literals are skipped, so a `{` in a message or in an
 * interpolation cannot close the block early.
 */
export function balancedBlock(source: string, openIndex: number): string {
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"') {
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
    index += 1;
  }
  return source.slice(openIndex);
}

/**
 * Index of the bracket that closes the group opened at `openIndex`.
 *
 * `balancedBlock` starts at the first `{` after a call, which is not always the
 * call's own block: `Picker(selection: Binding(get: { … }, set: { … })) { … }`
 * puts a closure inside the *argument list*, so the "block" the picker guard read
 * was an empty `get:` closure and every check inside it passed vacuously.
 * Skipping the argument list first is what makes the block the block.
 */
export function skipBalanced(source: string, openIndex: number, open = "(", close = ")"): number {
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"') {
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * The body of a declared property, found by name.
 *
 * A guard that only asserts the *name* `editablePlanIndexes` appears somewhere
 * passes on a property that keeps the name and returns everything — which is
 * exactly the edit a later change would make. Resolving the body lets the guard
 * assert the rule inside it instead. Returns `null` for a stored property (one
 * assigned with `=`, which has no body).
 */
export function propertyBody(source: string, name: string): string | null {
  const declaration = new RegExp("\\bvar\\s+" + name + "\\b[^\\n]*").exec(source);
  if (!declaration) return null;
  const open = source.indexOf("{", declaration.index);
  if (open < 0) return null;
  const between = source.slice(declaration.index + declaration[0].length, open);
  if (between.trim() !== "") return null;
  return balancedBlock(source, open);
}
