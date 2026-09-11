import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSyncManifest } from "../src/cli.js";

test("CLI reads sync manifests three parent directories above the export root", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-cli-manifest-depth-"));
  try {
    const exportRoot = join(root, "a", "b", "c");
    mkdirSync(exportRoot, { recursive: true });
    writeFileSync(join(root, "sync-manifest.json"), JSON.stringify({
      version: 1, deletedSourceIds: ["workout-1", "workout-2"]
    }), "utf8");
    assert.deepEqual(readSyncManifest(exportRoot), ["workout-1", "workout-2"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
