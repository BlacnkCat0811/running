import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../../..");

test("line-reference checks report an empty scan as NOT CHECKED, not validation evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "rai-doc-ref-test-"));
  try {
    const doc = join(directory, "empty.md");
    writeFileSync(doc, "# No source-line references\n");
    const result = spawnSync(process.execPath, ["scripts/check-doc-line-refs.mjs", relative(root, doc)], {
      cwd: root, encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /NOT CHECKED: no line references found/);
    writeFileSync(doc, "apps/api/src/server.ts:1\n");
    const checked = spawnSync(process.execPath, ["scripts/check-doc-line-refs.mjs", relative(root, doc)], {
      cwd: root, encoding: "utf8"
    });
    assert.equal(checked.status, 0, checked.stderr);
    assert.doesNotMatch(checked.stderr, /NOT CHECKED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
