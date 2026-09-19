#!/bin/bash
# iOS 门禁的统一入口（`npm run test:ios`）。
#
# 为什么需要它：仓库远端是 gitee，`.github/workflows/ci.yml` 从不运行，`npm test`
# 与 `npm run test:all` 也完全不含 iOS。于是 `typecheck-ios.sh`、`run-model-tests.sh`、
# `run-tech-presentation-tests.sh` 在很长一段时间里都只是"手工脚本"——判据写好了，
# 但没有执行者。2026-09-19 的 test11 回归就是这条路走进主干的：那个 `scrollTo`
# 从 09-18 15:47 起必然失败，却没有任何自动入口会跑它，直到本机手动跑 UI 用例
# 才发现。这属于同一类教训的第三次（前两次是 `CalibrationState.swift` 与
# `PlanReceiptMatcher.swift`）：**判据存在 ≠ 判据被执行**。
#
# 本脚本覆盖「本机可跑的 iOS 判据」：
#   1. typecheck-ios.sh          —— 全部 iOS 源码（除 3 个高德依赖文件）的真实类型检查
#   2. run-model-tests.sh        —— 纯逻辑回归聚合（模型/DTO、Keychain、坐标、课表映射、
#                                   会话探测、健康同步取消、Tech 展示层与对比度）
#
# **刻意不含**下面两条，它们需要模拟器或 Pods，不属于"任何一台开发机都能跑"：
#   - run-visual-tests.sh         需要已启动的模拟器 + `var/rai.sqlite`（`var/` 不入库）
#   - run-coordinate-sdk-check.sh 需要 `apps/ios/Pods` + 已启动模拟器
# 这两条依然是手工验收项，见 docs/IOS_NATIVE_RUNBOOK.md。
#
# 环境检测：iOS 判据需要 macOS + Xcode。不满足时打印**显式跳过**并退出 0——但要说清
# "本次没有检查任何 iOS 源码"，因为一个静默通过的门禁比没有门禁更危险。反之，只要
# 机器上确实有 Xcode，就绝不允许降级：`typecheck-ios.sh` 里"宏插件起不来"这类
# 环境性失败照样以非零退出，因为它意味着源码真的没被检查。
#
# 用法：npm run test:ios  或  bash apps/ios/tests/run-ios-gates.sh
set -uo pipefail
cd "$(dirname "$0")/../../.."

if [ "$(uname -s)" != "Darwin" ]; then
  {
    echo "⚠️  跳过 iOS 门禁：当前系统是 $(uname -s)，iOS 类型检查与回归只能在 macOS 上跑。"
    echo "    本次没有检查任何 iOS 源码。"
  } >&2
  exit 0
fi

developer_dir="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
if [ ! -d "$developer_dir" ]; then
  {
    echo "⚠️  跳过 iOS 门禁：找不到 Xcode（$developer_dir）。"
    echo "    本次没有检查任何 iOS 源码。"
  } >&2
  exit 0
fi
# `xcode-select -p` 在本机指向 CommandLineTools（黑苹果上的既有配置），裸 `xcrun`
# 会拿到没有 iOS SDK 的工具链。显式固定 DEVELOPER_DIR，与两条子脚本保持一致。
export DEVELOPER_DIR="$developer_dir"

set -e
bash apps/ios/tests/typecheck-ios.sh
bash apps/ios/tests/run-model-tests.sh
echo "iOS 门禁通过（类型检查 + 纯逻辑回归）"
