#!/usr/bin/env node
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Explicit paths, not shell globs: identical test discovery on cmd and POSIX. */
export function nodeTestFiles(directory = root) {
  const packages = readdirSync(join(directory, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => join("packages", entry.name, "test"));
  const folders = [...packages, join("apps", "api", "test")];
  return folders.flatMap((folder) => existsSync(join(directory, folder))
    ? readdirSync(join(directory, folder), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => join(folder, entry.name)) : []).sort();
}

/** Both suites run after ordinary failures; signals/startup errors never pass. */
export function executeSuites(suites, spawn = spawnSync) {
  let failed = false;
  for (const suite of suites) {
    let result;
    try {
      result = spawn(process.execPath, suite.args, {
        cwd: suite.cwd, stdio: "inherit", shell: false, env: process.env
      });
    } catch (error) {
      console.error(`${suite.name} could not start: ${String(error)}`);
      failed = true;
      continue;
    }
    if (result.error) console.error(`${suite.name} could not start: ${String(result.error)}`);
    if (result.error || result.signal || result.status !== 0) failed = true;
    if (result.signal === "SIGINT" || result.signal === "SIGTERM") return result.signal === "SIGINT" ? 130 : 143;
  }
  return failed ? 1 : 0;
}

/**
 * Node 套件的文件级并发。
 *
 * 🔴 **为什么需要这个旋钮（实测，不是推测）**：本脚本把**全部**测试文件一次性交给
 * `node --test`，不传 `--test-concurrency` 时 node 用默认并发 = `os.availableParallelism()`
 * （本机 = 6）。而几个重文件自身就要 5–7 分钟、且靠**墙钟轮询**判成败：
 *   · `apps/api/test/worker.test.ts:214` 的 `waitFor` 默认预算 **5000 ms**；
 *   · `apps/api/test/data-only-import-queue.test.ts:61` 的 `wait` 预算 **30 000 ms**；
 *   · 单跑实测：`server-runtime` **443 s**、`worker` **349 s**。
 * 六路并行时它们必然重叠 ⇒ 5s / 30s 预算越界 ⇒ **全量红、单跑绿**。
 * 2026-10-12 用控制变量实验定过性：**同一份代码、同一批文件**，
 * 默认并发 → `EXIT=1`（2 条超时失败）；`--test-concurrency=1` → `EXIT=0`（132 条 0 失败）。
 *
 * ⚠️ **默认行为一个字节都没改**（下面 `undefined → 不传该参数`）：调并发会让全量明显变慢，
 * 那是 CI 吞吐与稳定性的取舍，属项目决策，不该由一次改动顺手决定。
 * 需要一份可验收的独占结果时，显式设置：
 *
 *     RAI_TEST_CONCURRENCY=2 npm test
 *
 * ⛔ 不要为了让它变绿去调大测试里的 5s / 30s 预算 —— 那是把测试调弱换绿灯。
 */
export function testConcurrency(env = process.env) {
  const raw = env.RAI_TEST_CONCURRENCY;
  if (raw === undefined || raw === "") return undefined;
  // ⚠️ 用**正则**而不是 `Number.isInteger(Number(raw))`：后者会放行 `" 2"`（Number 去空白）
  // 与 `"0x2"`（十六进制），于是"非法值静默当成合法"，而使用者以为自己已经独占运行了。
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      `RAI_TEST_CONCURRENCY must be a positive decimal integer, got ${JSON.stringify(raw)}. ` +
      "Refusing to guess: an empty or non-numeric value would silently fall back to the default."
    );
  }
  return Number(raw);
}

/**
 * Node 套件的 argv。
 *
 * ⚠️ `concurrency` **故意不给默认值**：给了默认值（`= testConcurrency()`）以后，
 * 调用方传 `undefined` 也会触发它 —— 于是这个"纯函数"藏了一次**环境读取**，
 * 而任何断言它的测试都会变成"校验本机此刻的配置"，不再是 hermetic。
 * 这正是本函数第一版的样子，并且**在门禁里真实地红过一次**（用 `RAI_TEST_CONCURRENCY=1` 跑时）。
 * 现在由 `main()` 显式传入，`undefined` 就明确表示"不追加并发参数"。
 */
export function nodeSuiteArgs(files, concurrency) {
  return [
    "--import", "tsx", "--test",
    ...(concurrency === undefined ? [] : [`--test-concurrency=${concurrency}`]),
    ...files
  ];
}

export function main() {
  const files = nodeTestFiles();
  if (!files.length) throw new Error("No Node test files found; refuse an empty green test run");
  return executeSuites([
    { name: "Node", cwd: root, args: nodeSuiteArgs(files, testConcurrency()) }
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
