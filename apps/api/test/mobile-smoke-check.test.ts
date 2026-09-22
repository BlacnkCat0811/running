import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("smoke checks accept only named predicates and parse filenames as data", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-smoke-predicate-"));
  try {
    const file = join(root, "quoted' file.json");
    writeFileSync(file, JSON.stringify({ today: { distanceKm: 3 } }));
    const script = fileURLToPath(new URL("../../../scripts/mobile-smoke-check.mjs", import.meta.url));
    assert.equal(spawnSync(process.execPath, [script, file, "today-distance"]).status, 0);
    const sentinel = join(root, "executed");
    assert.equal(spawnSync(process.execPath, [script, file, `require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`]).status, 1);
    assert.equal(existsSync(sentinel), false);
    assert.equal(spawnSync(process.execPath, [script, file, "constructor"]).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
