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
  const linux = workflow.slice(workflow.indexOf("  verify:"));
  assert.match(linux, /runs-on: ubuntu-24\.04/);
  assert.match(linux, /RAI_TEST_CONCURRENCY: "2"/);
  assert.match(linux, /run: npm test\n/,
    "Linux 必须保留全量发现，不能用定向测试代替 SQLite/Worker/POSIX 验收");
  for (const gate of ["check:training-plan-single-writer", "check:ios-gates", "review:model-boundaries", "ml:test", "smoke:api"]) {
    assert.ok(linux.includes(`npm run ${gate}`), `Linux CI 未执行 ${gate}`);
  }
  assert.match(linux, /run: \|\n          npm ci --omit=dev/);
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

test("Node 套件默认 argv 与历史逐字相同，只有显式设了并发才多一个参数", () => {
  const files = ["packages/a/test/a.test.ts"];
  // 🔴 断言必须**自洽**，不能读环境：第一版写成 `nodeSuiteArgs(files, undefined)`，
  // 而 `undefined` 会触发默认参数、去读**真实的** `RAI_TEST_CONCURRENCY` ——
  // 于是"用 RAI_TEST_CONCURRENCY=1 跑门禁"时这条测试自己红（全量串行跑就是这样红的）。
  // 一个会读环境变量的测试不是 hermetic 的：它校验的是"我这台机器此刻的配置"，不是代码。
  // 所以下面一律用**显式传入**的环境对象。
  const ambient = { RAI_TEST_CONCURRENCY: "1" };  // 故意的：证明它不会渗进默认断言
  const legacyArgv = ["--import", "tsx", "--test", ...files];

  // 默认（未设置）⇒ argv 与历史逐字相同。谁把默认改成有界并发，这里先红。
  assert.deepEqual(runner.nodeSuiteArgs(files, runner.testConcurrency({})), legacyArgv);
  assert.equal(runner.testConcurrency({}), undefined, "未设置时不得凭空产生一个并发值");
  assert.equal(runner.testConcurrency({ RAI_TEST_CONCURRENCY: "" }), undefined, "空串按未设置处理");

  // 显式设置时才追加参数，且其余 argv 不变。
  assert.deepEqual(runner.nodeSuiteArgs(files, runner.testConcurrency(ambient)),
    ["--import", "tsx", "--test", "--test-concurrency=1", ...files]);
  assert.equal(runner.testConcurrency(ambient), 1);
  assert.equal(runner.testConcurrency({ RAI_TEST_CONCURRENCY: "2" }), 2);
});

test("非法并发值必须响亮拒绝，不许静默回落到默认", () => {
  // 静默回落会让"我想要一份确定性的结果"变成"其实还是 6 路并行"，而使用者以为已经独占。
  // 断言只钉"响亮拒绝 + 指名道姓"，不钉具体措辞（措辞会随校验收紧而改）：
  // 例 `" 2"` / `"0x2"` 都能被 `Number()` 解析成 2，所以这一层必须靠正则收。
  for (const raw of ["0", "-1", "abc", "1.5", " 2", "0x2", "1e2", "+2"]) {
    assert.throws(() => runner.testConcurrency({ RAI_TEST_CONCURRENCY: raw }),
      /RAI_TEST_CONCURRENCY must be a positive/,
      `RAI_TEST_CONCURRENCY=${JSON.stringify(raw)} 应当被拒绝`);
  }
});
