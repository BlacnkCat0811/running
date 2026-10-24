// 阶段 6 证据冻结：EVIDENCE-FREEZE 必须记录“本次写出的” run-index 哈希。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { REPO_ROOT } from "../../../scripts/phase6/safety.mjs";

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function makeDeliverable() {
  const root = mkdtempSync(join(tmpdir(), "phase6-freeze-"));
  mkdirSync(join(root, "evidence", "runs", "run-a"), { recursive: true });
  writeFileSync(join(root, "protocol.json"), JSON.stringify({ protocolVersion: 1, protocolId: "freeze-test" }));
  writeFileSync(join(root, "evidence", "runs", "run-a", "manifest.json"), JSON.stringify({
    runId: "run-a", profile: "dev", dataset: "D1", scenarios: [], commands: []
  }));
  // 模拟上一轮已经写过的索引：若冻结先读旧哈希再覆盖，就会记录这个值。
  writeFileSync(join(root, "evidence", "run-index.json"), JSON.stringify({ old: true }));
  return root;
}

function runFreeze(deliverable) {
  return spawnSync(process.execPath, ["scripts/phase6/freeze-evidence.mjs", "--deliverable", deliverable], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000
  });
}

function assertCurrentIndexHash(deliverable) {
  const freeze = JSON.parse(readFileSync(join(deliverable, "evidence", "EVIDENCE-FREEZE.json"), "utf8"));
  const indexEntry = freeze.evidence.files.find((file) => file.path === "evidence/run-index.json");
  assert.ok(indexEntry, "freeze record must contain the run-index entry");
  assert.equal(indexEntry.sha256, sha256(join(deliverable, "evidence", "run-index.json")),
    "freeze record must hash the run-index written in this run, not a previous one");
}

test("freeze-evidence records the current run-index hash and stays correct on rerun", () => {
  const deliverable = makeDeliverable();
  try {
    const first = runFreeze(deliverable);
    assert.equal(first.status, 0, first.stderr);
    assertCurrentIndexHash(deliverable);

    const second = runFreeze(deliverable);
    assert.equal(second.status, 0, second.stderr);
    assertCurrentIndexHash(deliverable);
  } finally {
    rmSync(deliverable, { recursive: true, force: true });
  }
});
