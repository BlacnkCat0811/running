import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";

// 变量说明符的动态 import：这三个是 .mjs 工具脚本，不在 tsc 的 include 里
// （`scripts/**/*.mts` 才在），所以类型是 any —— 这是有意的：测试校验运行行为，
// 不给工具脚本再造一份会漂移的类型定义。样板见 test-runner.test.ts。
const iosRunner = await import(pathToFileURL(resolve("scripts/run-ios.mjs")).href);
const openIos = await import(pathToFileURL(resolve("scripts/open-ios.mjs")).href);
const portable = await import(pathToFileURL(resolve("scripts/check-npm-scripts-portable.mjs")).href);
const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

/**
 * 把 stderr 收进内存再断言。
 * 跳过说明**必须被打印**（一个静默通过的门禁比没有门禁更危险），但 `npm test` 的输出
 * 不该被十几条告警淹没 —— 所以这里既拿到文本做断言，又不让它漏进测试输出。
 */
function captureStderr<T>(run: () => T): { value: T; stderr: string } {
  const stream = process.stderr as unknown as { write: (chunk: string) => boolean };
  const original = stream.write.bind(process.stderr);
  let captured = "";
  stream.write = (chunk: string) => { captured += chunk; return true; };
  try {
    return { value: run(), stderr: captured };
  } finally {
    stream.write = original;
  }
}

test("命令矩阵与 iOS 入口在 package.json 里只走 node 包装（cmd / PowerShell / bash 逐字相同）", () => {
  // 五条矩阵命令里，只有 iOS 这条需要跨平台分流；其余四条本来就只有 && 与纯命令。
  assert.equal(manifest.scripts.test, "node scripts/run-tests.mjs");
  assert.equal(manifest.scripts["test:ios"], "node scripts/run-ios.mjs gates");
  assert.equal(manifest.scripts["test:ios:live"], "node scripts/run-ios.mjs live");
  assert.equal(manifest.scripts["test:ios:mutation"], "node scripts/run-ios.mjs mutation");
  assert.equal(manifest.scripts["test:ios:mutation:scope"], "node scripts/run-ios.mjs mutation-scope");
  assert.equal(manifest.scripts["open:ios"], "node scripts/open-ios.mjs");
  assert.equal(manifest.scripts["check:scripts"], "node scripts/check-npm-scripts-portable.mjs");
  for (const name of ["typecheck", "build", "test:e2e:web"]) {
    assert.match(manifest.scripts[name], /^(npm |node |tsc )/, `${name} 应当是纯命令 + &&`);
  }
});

test("仓库里全部 workspace 的 script 正文都通过跨平台语法闸门", () => {
  const audit = portable.auditWorkspace();
  assert.ok(audit.scriptCount > 100, `应当扫到全部 script，实际只扫到 ${audit.scriptCount} 条`);
  // 失败时把违规清单原样带出来，而不是只报"有 N 处"。
  assert.deepEqual(audit.findings, []);
});

test("闸门对每种禁用写法都能红，且不误伤合法写法", () => {
  // 每一条都对应 package.json 里真实坏过一次的写法（2026-10-13 本机实测）。
  const forbidden: Array<[string, string]> = [
    ["node a.mjs ; node b.mjs", ";"],
    ["node a.mjs && echo $?", "$?"],
    ["echo $RAI_MUTATION_FOR && node a.mjs", "$VAR / $(…)"],
    ["RAI_MUTATION_FOR=git node a.mjs", "VAR=x cmd"],
    ["test -f x && node a.mjs", "test"],
    ["[ -f x ] && node a.mjs", "[ … ]"],
    ["uname -s", "uname"],
    ["rm -rf dist/*", "*"],
    ["python3 apps/ios/tests/x.py", "python3 / python / py"],
    ["open apps/ios/RAI.xcworkspace", "open"],
    ["bash apps/ios/tests/run-ios-gates.sh", "bash（PATH 上的）"],
    ["apps/ios/tests/run-ios-gates.sh", "apps/ios/tests/run-ios-gates.sh"],
    ["./scripts/build.mjs", "./x"]
  ];
  for (const [body, token] of forbidden) {
    const tokens = portable.inspectScript(body).map((violation: { token: string }) => violation.token);
    assert.ok(tokens.includes(token), `${body} 应被判违规「${token}」，实际：${JSON.stringify(tokens)}`);
  }

  // ⚠️ 反向对照：闸门必须放行真实存在的合法写法。
  // 尤其是 `npm test` —— 把 `test` 判成违规会让闸门自己变成噪声，而噪声会被关掉。
  for (const legal of [
    "node scripts/run-tests.mjs",
    "tsc --noEmit -p tsconfig.pure.json && tsc --noEmit -p tsconfig.json",
    "npm run build && node --import tsx --test --test-concurrency=1 apps/web/e2e/web-flows.test.ts",
    "npm run typecheck && npm test && npm run test:ios && npm run ml:test",
    "node scripts/run-ios.mjs mutation-scope"
  ]) {
    assert.deepEqual(portable.inspectScript(legal), [], `${legal} 应当合法`);
  }
});

test("macOS 上 argv 与历史逐字相同：gates 走 bash，python 目标走 python3", () => {
  const darwin = { platform: "darwin", env: {}, pythonProbe: (command: string) => command === "python3" };
  const gates = iosRunner.planIosCommand("gates", { ...darwin, exists: () => true });
  assert.equal(gates.command, "bash");
  assert.deepEqual(gates.args, ["apps/ios/tests/run-ios-gates.sh"]);
  assert.equal(gates.env, undefined);

  const live = iosRunner.planIosCommand("live", darwin);
  assert.equal(live.command, "python3");
  assert.deepEqual(live.args, ["apps/ios/tests/check-export-determinism-live.py"]);

  const mutation = iosRunner.planIosCommand("mutation", darwin);
  assert.equal(mutation.command, "python3");
  assert.deepEqual(mutation.args, ["apps/ios/tests/check-background-mutations.py"]);
});

test("非 macOS 上每个 iOS 目标都是显式跳过、退出 0，且一个子进程都不起", () => {
  let spawned = 0;
  const neverSpawn = () => { spawned += 1; throw new Error("非 macOS 不得启动子进程"); };
  for (const platform of ["win32", "linux", "freebsd"]) {
    for (const target of Object.keys(iosRunner.IOS_TARGETS)) {
      // exists 一律 false：win32 上模拟"这台机器没有 Git for Windows"。
      const plan = iosRunner.planIosCommand(target, { platform, env: {}, exists: () => false });
      assert.equal(plan.kind, "skip", `${platform} / ${target} 应当显式跳过`);
      const { value, stderr } = captureStderr(() => iosRunner.runPlan(plan, neverSpawn));
      assert.equal(value, 0, "跳过是 0：平台不对 ≠ 失败");
      assert.match(stderr, /跳过/);
      assert.match(stderr, /本次没有/, "跳过必须写明「什么都没做」，不许静默通过");
    }
  }
  assert.equal(spawned, 0);
});

test("win32 上找到 Git Bash 时，把 gates 交给 run-ios-gates.sh 自己判定（平台判据只有一份）", () => {
  const env = { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PFX" };
  const gitBash = "C:\\PF\\Git\\bin\\bash.exe";
  const plan = iosRunner.planIosCommand("gates", { platform: "win32", env, exists: (path: string) => path === gitBash });
  assert.equal(plan.kind, "run");
  assert.equal(plan.command, gitBash);
  assert.deepEqual(plan.args, ["apps/ios/tests/run-ios-gates.sh"]);

  // `C:\Windows\System32\bash.exe` 是 WSL 启动器（本机实测 exit 1），永远不许进候选。
  for (const candidate of iosRunner.gitBashCandidates(env)) {
    assert.ok(!candidate.toLowerCase().includes("system32"), `候选里混进了 WSL 启动器：${candidate}`);
  }
  // 显式覆盖口只认 RAI_BASH。
  assert.equal(iosRunner.resolveBash("win32", { RAI_BASH: "D:\\tools\\bash.exe" }, () => false).command, "D:\\tools\\bash.exe");
});

test("macOS 上缺 Python 是失败（1）而不是跳过（0）：本该能跑却没跑成必须响", () => {
  const plan = iosRunner.planIosCommand("live", { platform: "darwin", env: {}, pythonProbe: () => false });
  assert.equal(plan.kind, "fail");
  const { value, stderr } = captureStderr(() => iosRunner.runPlan(plan, () => { throw new Error("不得启动"); }));
  assert.equal(value, 1);
  assert.match(stderr, /找不到 Python 3/);
  const overridden = iosRunner.planIosCommand("live", { platform: "darwin", env: { RAI_PYTHON: "/opt/py" }, pythonProbe: () => false });
  assert.equal(overridden.command, "/opt/py");
});

test("RAI_MUTATION_FOR 走 spawnSync 的 env，不再依赖 shell 的「命令前置赋值」", () => {
  const plan = iosRunner.planIosCommand("mutation-scope",
    { platform: "darwin", env: {}, pythonProbe: (command: string) => command === "python3" });
  // ⚠️ 显式声明成 any：闭包内被赋值的局部变量，在 TS 控制流分析里"永远是初始值 null"，
  // 于是 `assert.ok(seen)` 会把类型收窄成 never（第一版就是这样让 `npm run typecheck` 变红的）。
  let seen: any = null;
  const value = iosRunner.runPlan(plan, (command: string, args: string[], options: any) => {
    seen = { command, args, options };
    return { status: 0, signal: null };
  });
  assert.equal(value, 0);
  assert.ok(seen);
  assert.equal(seen.options.shell, false, "不许经过 shell");
  assert.equal(seen.options.cwd, iosRunner.root);
  assert.equal(seen.options.env.RAI_MUTATION_FOR, "git");
  assert.equal(seen.options.stdio, "inherit");
  assert.deepEqual(seen.args, ["apps/ios/tests/check-background-mutations.py"]);
});

test("子进程退出码原样转发；启动失败是 1，绝不静默变绿", () => {
  const plan = iosRunner.planIosCommand("gates", { platform: "darwin", env: {}, exists: () => true });
  assert.equal(iosRunner.runPlan(plan, () => ({ status: 7 })), 7);
  assert.equal(iosRunner.runPlan(plan, () => ({ status: null, signal: "SIGINT" })), 130);
  assert.equal(iosRunner.runPlan(plan, () => ({ status: null, signal: "SIGKILL" })), 1);
  const { value, stderr } = captureStderr(() => iosRunner.runPlan(plan, () => ({ error: new Error("ENOENT") })));
  assert.equal(value, 1);
  assert.match(stderr, /无法启动/);
  assert.throws(() => iosRunner.planIosCommand("bogus"), /未知的 iOS 目标/);
});

test("「本次没有检查任何 iOS 源码」在 .sh 与 Node 两侧不漂移，每个目标都写明「本次没有…」", () => {
  const gates = readFileSync(resolve("apps/ios/tests/run-ios-gates.sh"), "utf8");
  assert.ok(gates.includes(iosRunner.NO_IOS_SOURCE_CHECKED),
    "run-ios-gates.sh 里的跳过原话变了：win32 侧委托给它打印，两边必须同一句");
  for (const [target, spec] of Object.entries(iosRunner.IOS_TARGETS) as Array<[string, any]>) {
    assert.match(spec.untested, /^本次没有/, `${target} 必须写明"本次没有…"`);
  }
});

test("pre-commit 的 iOS 段：门禁「跳过」不等于「放行」，必须有认账闸门", () => {
  // 事故形状（2026-10-13）：`60678af` 在 Windows 上提交，`npm run test:ios` 按设计
  // 打印跳过并 exit 0 ⇒ 钩子放行 ⇒ 6 条 Swift 类型错误进主干，而 message 写着"门禁全绿"。
  // 下面四条各钉一件事，**都在注释剥掉之后按代码文本断言**（注释里引述那句跳过原话是说明，
  // 不是漂移点；代码里再抄一份才是）。
  const hook = readFileSync(resolve(".githooks/pre-commit"), "utf8");
  const code = hook.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  assert.ok(code.includes("NO_IOS_SOURCE_CHECKED"),
    "钩子必须从 scripts/run-ios.mjs 读哨兵常量：平台判断只许有一处，钩子自己判平台就会漂移");
  assert.ok(!code.includes(iosRunner.NO_IOS_SOURCE_CHECKED),
    "钩子代码里出现了跳过原话的字面量：`.sh` 与 Node 两份已被本文件上面那条测试钉住，第三份只会先漂移");
  assert.ok(code.includes("RAI_IOS_UNVERIFIED"),
    "必须留一个显式认账的逃生口：iOS 判据在非 macOS 上物理跑不了，硬拒会把提交逼到 --no-verify，"
    + "而那一次会连带绕过 blob 上限 / typecheck / 文档引用 / 迁移冻结四道门禁");
  assert.ok(code.includes("npm run test:ios"),
    "认账闸门不能替代跑门禁本身：本机跑得动时必须真跑");
});

test("open:ios 在 macOS 打开 workspace，其它平台显式跳过且不假装打开", () => {
  const opened = openIos.planOpenIos({ platform: "darwin", exists: () => true });
  assert.equal(opened.command, "open");
  assert.deepEqual(opened.args, ["apps/ios/RAI.xcworkspace"]);
  assert.equal(openIos.planOpenIos({ platform: "darwin", exists: () => false }).kind, "fail");

  let spawned = 0;
  for (const platform of ["win32", "linux"]) {
    const plan = openIos.planOpenIos({ platform, exists: () => true });
    assert.equal(plan.kind, "skip");
    const { value, stderr } = captureStderr(() => openIos.runPlan(plan, () => { spawned += 1; throw new Error("不得启动"); }));
    assert.equal(value, 0);
    assert.ok(stderr.includes(openIos.NOTHING_OPENED), "跳过必须说清什么都没打开");
  }
  assert.equal(spawned, 0);
});

test(".gitattributes 把四种扩展名钉成 LF，并真的对已入库文件生效", () => {
  const attributes = readFileSync(resolve(".gitattributes"), "utf8");
  const lines = attributes.split(/\r?\n/);
  for (const line of ["*.sh text eol=lf", "*.py text eol=lf", "*.swift text eol=lf", "*.pbxproj text eol=lf"]) {
    assert.ok(lines.includes(line), `.gitattributes 缺少「${line}」`);
  }
  assert.ok(lines.includes("/.githooks/* text eol=lf"), "无扩展名的 bash 钩子同样会因为 CRLF 变成 bad interpreter");

  // 只断言"文件里有这几行"是不够的（写错 section、写错文件名都能骗过它）：
  // 这里让 git 自己回答"这些文件最终被判成什么行尾"。
  if (!existsSync(resolve(".git"))) return; // 从 tarball 解出来的目录没有 git 元数据，无法核对
  for (const file of [
    "apps/ios/tests/run-ios-gates.sh",
    "apps/ios/tests/check-background-mutations.py",
    "apps/ios/RAI/RAIApp.swift",
    "apps/ios/RAI.xcodeproj/project.pbxproj",
    ".githooks/pre-commit"
  ]) {
    const result = spawnSync("git", ["check-attr", "eol", "--", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `git check-attr 失败：${String(result.stderr)}`);
    assert.match(result.stdout.trim(), /eol: lf$/, `git 没把 ${file} 判成 eol=lf：${result.stdout.trim()}`);
  }
});

test("Windows CI 会真的执行 test:ios：判据是「显式跳过 + 退出 0」，不是失败也不是静默通过", () => {
  const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
  const start = workflow.indexOf("  windows-runtime:");
  const end = workflow.indexOf("  verify:");
  assert.ok(start >= 0 && end > start, "ci.yml 里找不到 windows-runtime 作业");
  const windows = workflow.slice(start, end);
  assert.match(windows, /runs-on: windows-latest/);
  assert.match(windows, /run: npm run test:ios/);
});
