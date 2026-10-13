#!/usr/bin/env node
/**
 * `apps/ios/tests/` 下**跨平台** Python 结构门禁的统一入口（`npm run check:ios-gates`）。
 *
 * 🔴 为什么需要它（本仓已付过两次代价，两次都是同一形态）
 *
 *   1. 这些门禁是**纯文本**判据（读源码、断言形状），本来在 Windows 与 macOS 上都能跑。
 *      但它们此前只挂在 `run-*-tests.sh` 里 —— 而那条链**只在 macOS 上执行**
 *      （`run-ios-gates.sh` 在非 Darwin 上显式跳过）。于是"在 Windows 上开发"的机器
 *      **从来看不到自己的门禁结论**：不是红的，是**根本没有执行者**。
 *   2. 更糟的是其中几支还依赖宿主默认编码：裸 `read_text()` 在 Windows 上是 cp936/GBK，
 *      源码含中文就直接 `UnicodeDecodeError` 崩溃；macOS 默认 UTF-8，所以这个缺陷
 *      在 macOS 上永远不可见。2026-10-13 一次性发现 4 支（已修 4 支）。
 *
 * 判据的存在 ≠ 判据被执行（本仓的第三次同类教训）。这个入口就是为了让**自动发现**取代
 * "记得手工跑"：目录里新加一支 `check-*.py`，它自动进入本入口，不需要谁记得改一行挂载。
 *
 * 判据分层（与 `scripts/run-ios.mjs` 同源）：
 *   - **自动发现**：`apps/ios/tests/check-*.py`。
 *   - **显式排除表**：确实需要 macOS/模拟器/UDP 之类外部条件的，逐条写清原因。
 *     排除是**声明**，不是静默：新出现的门禁若没人排除就会被执行 —— 失败开放。
 *   - **红就是红**：任何一支非 0 退出即整体非 0，并打印是哪一支、退出码多少。
 *   - 非 macOS 上**不跳过**（这正是本入口存在的理由）；但解释器缺失是失败，不是跳过。
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_DIR = "apps/ios/tests";

/**
 * 需要外部条件、**不能**在普通开发机上跑的门禁。
 *
 * ⚠️ 每一条都必须写清原因，并且这个列表要"改了会有人看得出来"：
 * 排除一个**本可以跑**的门禁，就是把它变回"没有执行者"。
 */
export const EXCLUDED = {
  "check-export-determinism-live.py":
    "要把探针装进已启动的 iOS 模拟器并跨进程比对导出字节（只在 macOS + Simulator 上可跑）",
  "check-background-mutations.py":
    "逐条改坏 Swift 源码再跑 bash + Xcode 门禁（需要 macOS 工具链；`test:ios:mutation` 是它的入口）",
  "check-today-layout.py": null // 占位：把它列在这里会**取消**排除，见下方 excludedGateFiles
};

/**
 * 真正的排除集：只取上表里**给出原因**的项。占位 `null` 表示"有人想过要不要排除它，
 * 结论是不排除"——这个区分是为了让后来者看得出哪一条是深思熟虑、哪一条是漏了。
 */
export function excludedGateFiles(excluded = EXCLUDED) {
  return new Set(Object.entries(excluded).filter(([, reason]) => Boolean(reason)).map(([name]) => name));
}

/** 目录里所有 `check-*.py`，按名字排序（稳定输出，便于对拍）。 */
export function discoverGateFiles(readDir = readdirSync, dir = join(root, GATE_DIR)) {
  return readDir(dir)
    .filter((name) => name.startsWith("check-") && name.endsWith(".py"))
    .sort();
}

/** `python3` 优先，退回 `python`：老 macOS 的 `/usr/bin/python` 是 2.7，必须验证 major == 3。 */
export function resolvePython(env = process.env, probe = () => false) {
  if (env.RAI_PYTHON) return env.RAI_PYTHON;
  return ["python3", "python"].find((command) => probe(command)) ?? null;
}

export function probePython(command) {
  const probe = spawnSync(command, ["-c", "import sys; assert sys.version_info[0] == 3"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

/**
 * 纯函数：目录内容 + 解释器 ⇒ 要跑什么。不读环境、不起进程（probe 由调用方注入），
 * 免得测试变成"校验我这台机器此刻的配置"而不是代码。
 */
export function planGates(context = {}) {
  const { files = discoverGateFiles(), excluded = excludedGateFiles(), python = null } = context;
  const runnable = files.filter((name) => !excluded.has(name));
  const skipped = files.filter((name) => excluded.has(name));
  return { runnable, skipped, python };
}

export function runGates(plan, spawn = spawnSync, cwd = root) {
  if (!plan.python) {
    console.error("❌ 无法运行 iOS 结构门禁：找不到 Python 3（试过 python3 / python）。");
    console.error("    这台机器本该能跑却没跑成 —— 缺解释器是失败，不是跳过。");
    return 1;
  }
  let failed = 0;
  for (const name of plan.runnable) {
    const relative = `${GATE_DIR}/${name}`;
    process.stdout.write(`\n=== ${relative} ===\n`);
    const result = spawn(plan.python, [relative], { cwd, stdio: "inherit", shell: false });
    if (result.error) {
      console.error(`❌ ${relative} 无法启动（${plan.python}）：${String(result.error)}`);
      failed += 1;
      continue;
    }
    // 被信号打断要与"判据失败"区分开：前者是环境，后者是结论。
    if (result.signal) {
      console.error(`❌ ${relative} 被信号 ${result.signal} 中断`);
      failed += 1;
      continue;
    }
    if ((result.status ?? 1) !== 0) {
      console.error(`❌ ${relative} 退出码 ${result.status ?? 1}`);
      failed += 1;
    }
  }
  for (const name of plan.skipped) {
    console.log(`\n⏭️  跳过 ${GATE_DIR}/${name}：${EXCLUDED[name]}`);
  }
  if (failed > 0) {
    console.error(`\niOS 结构门禁：${plan.runnable.length} 支里 ${failed} 支失败。`);
    return 1;
  }
  console.log(`\niOS 结构门禁通过（${plan.runnable.length} 支跨平台判据；跳过 ${plan.skipped.length} 支需外部条件的）。`);
  return 0;
}

export function main(env = process.env) {
  const plan = planGates({ python: resolvePython(env, probePython) });
  return runGates(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
