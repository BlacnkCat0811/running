import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("documentation gate rejects missing links and orphan docs without depending on staged files", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-doc-links-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "README.md"), "[Guide](docs/guide.md)\n");
    writeFileSync(join(root, "docs/guide.md"), "# Guide\n[Home](../README.md)\n");
    const run = () => spawnSync(process.execPath, [
      resolve("scripts/check-doc-links.mjs"), "--root", root
    ], { encoding: "utf8" });
    assert.equal(run().status, 0);
    writeFileSync(join(root, "docs/guide.md"), "[Old](deleted.md)\n");
    assert.match(run().stderr, /missing target/);
    assert.equal(run().status, 1);
    writeFileSync(join(root, "docs/guide.md"), "```md\n[Example](deleted.md)\n```\n");
    assert.equal(run().status, 0, "example code fences are not active links");
    writeFileSync(join(root, "docs/orphan.md"), "# Orphan");
    assert.match(run().stderr, /not reachable/);
    rmSync(join(root, "docs/orphan.md"));
    writeFileSync(join(root, "docs/guide.md"), "[Private](../../outside.md)\n");
    assert.match(run().stderr, /leaves repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
