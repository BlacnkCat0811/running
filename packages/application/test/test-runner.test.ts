import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";

const runner = await import(pathToFileURL(resolve("scripts/run-tests.mjs")).href);

test("npm test keeps the shell-free runner as the actual cross-platform entry point", () => {
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.equal(manifest.scripts.test, "node scripts/run-tests.mjs");
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const windows = workflow.slice(workflow.indexOf("  windows-runtime:"), workflow.indexOf("  verify:"));
  assert.match(windows, /runs-on: windows-latest/);
  assert.match(windows, /run: npm test/);
});

test("test runner discovers explicit filenames including spaces without shell expansion", () => {
  const root = mkdtempSync(join(tmpdir(), "rai test runner "));
  try {
    for (const folder of ["packages/a/test", "packages/b/src", "apps/api/test"]) mkdirSync(join(root, folder), { recursive: true });
    for (const file of ["packages/a/test/a.test.ts", "packages/a/test/with space.test.ts", "apps/api/test/api.test.ts", "packages/a/test/helper.ts"]) {
      writeFileSync(join(root, file), "");
    }
    assert.deepEqual(runner.nodeTestFiles(root), [
      join("apps", "api", "test", "api.test.ts"), join("packages", "a", "test", "a.test.ts"), join("packages", "a", "test", "with space.test.ts")
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("test runner executes both real Node children and propagates either suite's failure", () => {
  const root = mkdtempSync(join(tmpdir(), "rai runner failure "));
  try {
    const marker = join(root, "web-ran");
    for (const [first, second] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      rmSync(marker, { force: true });
      const result = runner.executeSuites([
        { name: "Node", cwd: root, args: ["-e", `process.exitCode=${first}`] },
        { name: "Web", cwd: root, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');process.exitCode=${second}`] }
      ], (command: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
        assert.equal(command, process.execPath);
        assert.equal(options?.shell, false);
        return spawnSync(command, args, options);
      });
      assert.equal(result, first || second ? 1 : 0);
      assert.equal(spawnSync(process.execPath, ["-e", `require('node:fs').accessSync(${JSON.stringify(marker)})`]).status, 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("test runner refuses silent startup failure and stops on cancellation", () => {
  const suite = { name: "fixture", cwd: process.cwd(), args: [] };
  assert.equal(runner.executeSuites([suite], () => ({ status: null, error: new Error("spawn failed") })), 1);
  assert.equal(runner.executeSuites([suite], () => { throw new Error("spawn threw"); }), 1);
  assert.equal(runner.executeSuites([suite], () => ({ status: null, signal: "SIGKILL" })), 1);
  let calls = 0;
  assert.equal(runner.executeSuites([suite, suite], () => { calls++; return { status: null, signal: "SIGINT" }; }), 130);
  assert.equal(calls, 1);
});
