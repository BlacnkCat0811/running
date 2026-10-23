// 阶段 3 证据生成器的反例守卫：日志不是“跑过就算通过”，必须证明
// fail=0 且存在完整测试摘要；否则会生成带 `pass: true` 的假验收结论。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const projectRoot = resolve(import.meta.dirname, "../../..");
const summaryScript = join(projectRoot, "scripts/phase3-equivalence-summary.mts");

function runSummaryFromLog(logText: string): { status: number | null; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "rai-evidence-log-"));
  const logPath = join(root, "run.log");
  try {
    writeFileSync(logPath, logText);
    return spawnSync(process.execPath, [
      "--import", "tsx", summaryScript, "--from-log", logPath
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 60_000
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("phase3 equivalence summary refuses a TAP log with failing tests", () => {
  const result = runSummaryFromLog("# tests 2\n# pass 1\n# fail 1\n# duration_ms 10\n");
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /contains failures/i);
});

test("phase3 equivalence summary refuses a spec-reporter log with failing tests", () => {
  const result = runSummaryFromLog("ℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ cancelled 0\nℹ duration_ms 10\n");
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /contains failures/i);
});

test("phase3 equivalence summary refuses a log without a complete test summary", () => {
  const result = runSummaryFromLog("✔ a test that printed no summary\n");
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /no complete test summary/i);
});
