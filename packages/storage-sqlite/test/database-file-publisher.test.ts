import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishDatabaseFile } from "../src/index.js";

test("publisher installs by rename-aside and preserves the displaced file", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-file-publisher-"));
  const target = join(root, "rai.sqlite");
  const candidate = join(root, "candidate.sqlite");
  const rollback = join(root, "rollback.sqlite");
  writeFileSync(target, "old");
  writeFileSync(candidate, "new");
  try {
    const result = await publishDatabaseFile({
      candidatePath: candidate,
      targetPath: target,
      rollbackPath: rollback,
      targetExists: () => existsSync(target),
      prepareOriginal: () => {},
      moveFile: rename,
      validateInstalled: () => readFileSync(target, "utf8") === "new"
    });
    assert.deepEqual(result, { originalExisted: true, originalMoved: true });
    assert.equal(readFileSync(target, "utf8"), "new");
    assert.equal(readFileSync(rollback, "utf8"), "old");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
