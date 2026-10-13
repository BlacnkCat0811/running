#!/usr/bin/env node
/**
 * 打开 iOS workspace 的跨平台入口（`npm run open:ios`）。
 *
 * 🔴 原来的 npm script 是裸 `open apps/ios/RAI.xcworkspace`：`open` 是 macOS 专属命令，
 * 本机（Windows）实测 `'open' is not recognized as an internal or external command`，exit 1。
 *
 * 为什么 win32 分支**不**用 `start`（用户最初给的是"darwin → open / win32 → start"）：
 * 本命令的目标是 `.xcworkspace`，而它在 Windows 上**没有关联程序**。`start` 会弹出
 * 「你要如何打开这个文件？」对话框、命令本身照样 exit 0 —— 那既是**假成功**（脚本说成功了，
 * 实际什么都没打开），又可能在无人值守的运行里挂住等人点按钮。这与本仓库对 iOS 判据的
 * 要求（宁可显式跳过，也不要静默通过/假装成功）冲突，所以这里选**显式跳过 + 说清原因**。
 * 如果确实想改成真的调 `start`，只需把下面 win32 分支换成
 * `cmd /c start "" <path>`，并接受上述两点代价。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** workspace 是**入库**的（`apps/ios/Pods/` 不入库），所以路径相对仓库根写死即可。 */
export const IOS_WORKSPACE = "apps/ios/RAI.xcworkspace";

/** 跳过时必须出现的原话：没有任何东西被打开，就不许让人以为打开了。 */
export const NOTHING_OPENED = "本次没有打开任何东西";

export function planOpenIos(context = {}) {
  const { platform = process.platform, exists = existsSync } = context;

  if (platform !== "darwin") {
    return {
      kind: "skip",
      lines: [
        `⚠️  跳过打开 iOS workspace：当前系统是 ${platform}，${IOS_WORKSPACE} 只能在 macOS 上用 Xcode 打开。`,
        "    （这里刻意不用 Windows 的 start：.xcworkspace 在 Windows 上没有关联程序，",
        "      它会弹「你要如何打开这个文件？」对话框，然后照样以 0 退出 —— 那是假成功。）",
        `    ${NOTHING_OPENED}。`
      ]
    };
  }

  if (!exists(join(root, IOS_WORKSPACE))) {
    return {
      kind: "fail",
      lines: [
        `❌ 打不开 ${IOS_WORKSPACE}：这个路径不存在，工作副本不完整。`,
        "    workspace 的 contents.xcworkspacedata 是入库的；`apps/ios/Pods/` 不入库，",
        "    先 `cd apps/ios && pod install` 把 Pods 装回来再试。"
      ]
    };
  }

  return { kind: "run", command: "open", args: [IOS_WORKSPACE], label: "打开 iOS workspace" };
}

export function runPlan(plan, spawn = spawnSync) {
  if (plan.kind === "skip" || plan.kind === "fail") {
    for (const line of plan.lines) process.stderr.write(`${line}\n`);
    return plan.kind === "skip" ? 0 : 1;
  }
  const result = spawn(plan.command, plan.args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`❌ ${plan.label} 失败（${plan.command}）：${String(result.error)}`);
    return 1;
  }
  if (result.signal) return result.signal === "SIGINT" ? 130 : 143;
  return result.status ?? 1;
}

export function main(argv = process.argv.slice(2)) {
  const unknown = argv.find((arg) => arg !== "");
  if (unknown) {
    console.error(`❌ open:ios 不接受参数：${JSON.stringify(unknown)}`);
    return 1;
  }
  return runPlan(planOpenIos());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
