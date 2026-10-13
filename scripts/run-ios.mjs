#!/usr/bin/env node
/**
 * iOS 判据的跨平台入口（`npm run test:ios` / `test:ios:live` / `test:ios:mutation[:scope]`）。
 *
 * 🔴 **为什么不能继续把裸命令写在 package.json 里（2026-10-13 本机实测，全部复现）**
 *
 *   · `test:ios`：`bash apps/ios/tests/run-ios-gates.sh` —— 本机 `bash` 解析到
 *     `C:\Windows\System32\bash.exe`，那是 **WSL 的启动器**，不是 Git Bash。WSL 没装分发版时
 *     它打印「适用于 Linux 的 Windows 子系统没有已安装的分发版」（UTF-16，在 cmd 里还是乱码）
 *     并 **exit 1**：于是 `npm run test:ios` 在 Windows 上不是"显式跳过"，而是"红"。
 *   · `test:ios:mutation:scope`：`RAI_MUTATION_FOR=git python3 …` —— cmd 把 `RAI_MUTATION_FOR=git`
 *     当成程序名，报 `'RAI_MUTATION_FOR' is not recognized as an internal or external command`。
 *     这是 POSIX 的"命令前置赋值"，cmd 与 PowerShell 都不认。
 *   · `python3` 在 Windows 上**不保证存在**（本机只有 `python` / `py` 与 3.12）。
 *
 * 判据分层：本文件只负责「选解释器 + 转发退出码」，**不做 iOS 判据本身**。
 *
 *   1. **能不能跑** —— 按 `process.platform` 判定（不是 shell 判定）：非 Darwin 一律显式跳过。
 *   2. **跳过时说什么** —— `gates` 目标那句话（「本次没有检查任何 iOS 源码」）只写在
 *      `run-ios-gates.sh` 里。win32 上只要找到 Git Bash 就把活交给它，让 `uname -s` 那条判断
 *      保持**唯一一份**（`bash` 用 `uname -s`，Node 用 `process.platform`），Node 侧不复制第二份平台判断。
 *   3. **红还是绿** —— 原样转发子进程退出码。**解释器缺失是失败（1），不是跳过（0）**：
 *      "这台机器平台不对"与"这台机器本该能跑却没跑成"是两件事，后者必须响。
 *
 * ⛔ 不要用 WSL/Git Bash 去"模拟" macOS：xcodebuild / CocoaPods / 模拟器只在 macOS 上真跑。
 *    这里用到 Git Bash 的唯一目的，是让 `run-ios-gates.sh` **自己**打印那句跳过
 *    （也顺带证明那条判据在 Windows 上确实可达）。
 * ⛔ `C:\Windows\System32\bash.exe` 是 WSL 启动器，**刻意不列入候选**：它不是 Git Bash，
 *    本机实测以 1 退出，选它就是把"跳过"变回"红"。
 */
import { existsSync } from "node:fs";
import { dirname, resolve, win32 } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 跳过时必须出现的**原话**。`run-ios-gates.sh` 里也有一份（且是权威的那份）：
 * 一个静默通过的门禁比没有门禁更危险，所以"什么都没检查"必须被写出来，
 * 而不是靠退出码 0 让人以为通过了。测试会校验两处措辞不漂移。
 */
export const NO_IOS_SOURCE_CHECKED = "本次没有检查任何 iOS 源码";

const MUTATION_FILE = "apps/ios/tests/check-background-mutations.py";
const mutationReason = (platform) =>
  `当前系统是 ${platform}，突变验证要逐条改坏 Swift 源码再跑 bash+Xcode 门禁，只能在 macOS 上跑。`;
const MUTATION_UNTESTED = "本次没有验证任何 iOS 判据的有效性。";

/**
 * 目标表。`file` 一律是**仓库相对路径**（cwd 固定为仓库根）：
 * 传给 Git Bash 的 `$0` 也就是这条相对路径，`dirname "$0"/../../..` 才能落在仓库根上。
 */
export const IOS_TARGETS = {
  gates: {
    file: "apps/ios/tests/run-ios-gates.sh",
    kind: "bash",
    label: "iOS 门禁",
    reason: (platform) => `当前系统是 ${platform}，iOS 类型检查与纯逻辑回归只能在 macOS 上跑。`,
    untested: NO_IOS_SOURCE_CHECKED + "。"
  },
  live: {
    file: "apps/ios/tests/check-export-determinism-live.py",
    kind: "python",
    label: "导出确定性（真机/模拟器执行）判据",
    reason: (platform) =>
      `当前系统是 ${platform}，这条判据要把探针装进 iOS 模拟器、跨两个进程比对导出字节，只能在 macOS 上跑。`,
    untested: "本次没有执行任何导出确定性判据。"
  },
  mutation: {
    file: MUTATION_FILE,
    kind: "python",
    label: "后台同步的突变验证",
    reason: mutationReason,
    untested: MUTATION_UNTESTED
  },
  "mutation-scope": {
    file: MUTATION_FILE,
    kind: "python",
    label: "后台同步的突变验证（按改动范围裁剪，RAI_MUTATION_FOR=git）",
    reason: mutationReason,
    untested: MUTATION_UNTESTED,
    // 原来写在 npm script 正文里的 `RAI_MUTATION_FOR=git` 挪到这里：
    // env 由 spawnSync 传，cmd / PowerShell / bash 都不需要认识"命令前置赋值"。
    env: { RAI_MUTATION_FOR: "git" }
  }
};

/**
 * Git for Windows 的 bash 候选路径；不含 System32 的 WSL 启动器（见文件头）。
 *
 * 🔴 必须用 `path.win32.join`，不能用 `path.join`：这些是**那台 Windows 机器上的**路径，
 * 分隔符不该随"谁在读这个规划函数"而变。用 `path.join` 时在 macOS 上会拼出
 * `C:\PF/Git/bin/bash.exe`（混合分隔符）—— 生产里看不出来（只有 win32 才会真的拿它去
 * `existsSync`，而那里 `path.join` 本来就是反斜杠），但
 * `packages/application/test/cross-platform-scripts.test.ts` 那条
 * 「win32 上找到 Git Bash 就把 gates 交给 .sh」的判据在 macOS 上**恒为假**：
 * `exists` 永远不命中 ⇒ `'skip' !== 'run'`（2026-10-13 实测，干净 HEAD 上 node 套件因此恒红一条）。
 */
export function gitBashCandidates(env = process.env) {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return [
    win32.join(programFiles, "Git", "bin", "bash.exe"),
    win32.join(programFilesX86, "Git", "bin", "bash.exe"),
    ...(env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")] : [])
  ];
}

/**
 * 选 bash。macOS 直接用 PATH 上的 `bash`（与历史 npm script 逐字相同的 argv）；
 * win32 只认真实存在的 Git Bash；其它平台没有 bash 可用 ⇒ 由调用方显式跳过。
 */
export function resolveBash(platform, env = process.env, exists = existsSync) {
  if (env.RAI_BASH) return { command: env.RAI_BASH, source: "RAI_BASH" };
  if (platform === "darwin") return { command: "bash", source: "PATH" };
  if (platform === "win32") {
    const found = gitBashCandidates(env).find((candidate) => exists(candidate));
    return found ? { command: found, source: "Git for Windows" } : null;
  }
  return null;
}

/** `python3` 优先，退回 `python`；两者都必须是 Python 3（老 macOS 的 `/usr/bin/python` 是 2.7）。 */
export function resolvePython(env = process.env, probe = () => false) {
  if (env.RAI_PYTHON) return env.RAI_PYTHON;
  return ["python3", "python"].find((command) => probe(command)) ?? null;
}

/**
 * 纯函数：目标 + 平台 ⇒ 要执行什么，或要跳过什么。不读环境、不起进程（probe 由调用方注入），
 * 免得测试变成"校验我这台机器此刻的配置"而不是代码。
 */
export function planIosCommand(target, context = {}) {
  const { platform = process.platform, env = process.env, exists = existsSync, pythonProbe = () => false } = context;
  const spec = IOS_TARGETS[target];
  if (!spec) {
    throw new Error(`未知的 iOS 目标 ${JSON.stringify(target)}。可用目标：${Object.keys(IOS_TARGETS).join(" / ")}`);
  }
  const skip = (extra = []) => ({
    kind: "skip",
    lines: [
      `⚠️  跳过${spec.label}：${spec.reason(platform)}`,
      ...extra.map((line) => `    ${line}`),
      `    ${spec.untested}`
    ]
  });

  if (spec.kind === "bash") {
    const bash = resolveBash(platform, env, exists);
    if (!bash) {
      const hint = platform === "win32"
        ? [
          `也没有找到 Git for Windows 的 bash（候选：${gitBashCandidates(env).join(" / ")}）。`,
          "System32\\bash.exe 是 WSL 启动器，不是 Git Bash，本仓库刻意不用它。"
        ]
        : [];
      return skip(hint);
    }
    return { kind: "run", command: bash.command, args: [spec.file], env: spec.env, label: spec.label };
  }

  // python 目标（模拟器执行 / 突变验证）都要求 macOS：非 Darwin 连解释器都不找。
  if (platform !== "darwin") return skip([]);
  const python = resolvePython(env, pythonProbe);
  if (!python) {
    return {
      kind: "fail",
      lines: [
        `❌ 无法运行${spec.label}：这是 macOS，但找不到 Python 3（试过 python3 / python）。`,
        "    这台机器本该能跑却没跑成 —— 缺解释器是失败，不是跳过。",
        "    安装 Xcode 命令行工具（xcode-select --install），或用 RAI_PYTHON 指定解释器。"
      ]
    };
  }
  return { kind: "run", command: python, args: [spec.file], env: spec.env, label: spec.label };
}

/** 执行计划：跳过打印后返回 0，缺解释器返回 1，子进程退出码原样转发。 */
export function runPlan(plan, spawn = spawnSync) {
  if (plan.kind === "skip" || plan.kind === "fail") {
    for (const line of plan.lines) process.stderr.write(`${line}\n`);
    return plan.kind === "skip" ? 0 : 1;
  }
  const result = spawn(plan.command, plan.args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: plan.env ? { ...process.env, ...plan.env } : process.env
  });
  if (result.error) {
    console.error(`❌ ${plan.label} 无法启动（${plan.command}）：${String(result.error)}`);
    return 1;
  }
  if (result.signal === "SIGINT" || result.signal === "SIGTERM") return result.signal === "SIGINT" ? 130 : 143;
  if (result.signal) return 1;
  return result.status ?? 1;
}

export function probePython(command) {
  const probe = spawnSync(command, ["-c", "import sys; assert sys.version_info[0] == 3"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

export function main(argv = process.argv.slice(2)) {
  const target = argv[0];
  if (!target) {
    console.error("用法：node scripts/run-ios.mjs <目标>");
    console.error(`目标：${Object.keys(IOS_TARGETS).join(" / ")}`);
    return 1;
  }
  try {
    return runPlan(planIosCommand(target, { pythonProbe: probePython }));
  } catch (error) {
    // 未知目标之类：一行说清楚，不甩栈 —— 这是用法错误，不是崩溃。
    console.error(`❌ ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
