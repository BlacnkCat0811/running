import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

/**
 * Convergence guard for the database timezone.
 *
 * Before batch 4 the backend had 41 bare `"Asia/Shanghai"` literals plus three fixed
 * UTC offsets (`'+8 hours'` in SQL, `'+08:00'` in ISO strings). They now all resolve to
 * `@rai/contracts`, so a new bare literal means someone has re-opened an implicit path.
 *
 * Deliberately out of scope, and why:
 * - `packages/contracts/src/timezone.ts` — it *is* the constant.
 * - `packages/api-contracts/src/index.ts` — the response `timezone` field is a literal
 *   *type*; widening it is an outward contract change touching API schemas, Web and iOS.
 * - `apps/web/src/**` — the frontend still reads the device timezone on purpose
 *   (decision (b): backend-only convergence). Re-scope this test when the frontend is
 *   unified.
 */
const AUTHORISED = new Set([
  "packages/contracts/src/timezone.ts",
  "packages/api-contracts/src/index.ts"
]);

const BARE_LITERAL = /"Asia\/Shanghai"|'\+08:00'|'\+8 hours'/;

const collectTypescript = (directory: string, found: string[] = []): string[] => {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) collectTypescript(path, found);
    else if (path.endsWith(".ts")) found.push(relative(process.cwd(), path));
  }
  return found;
};

test("the backend resolves the timezone through one entry point", () => {
  const roots = readdirSync("packages")
    .map((name) => `packages/${name}/src`)
    .filter((path) => existsSync(path))
    .concat("apps/api/src");

  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of collectTypescript(root)) {
      if (AUTHORISED.has(file)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (BARE_LITERAL.test(line)) offenders.push(`${file}:${index + 1}`);
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `bare timezone literals found, route them through @rai/contracts instead:\n${offenders.join("\n")}`
  );
});
