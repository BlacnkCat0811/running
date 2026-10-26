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
#   - run-visual-tests.sh         需要专用模拟器；prepare-phase5-fixture.mts 生成隔离合成数据库，不读取个人 var/rai.sqlite
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

# Swift 前端能力预检（2026-10-24，GitHub Actions 首次真实运行 CI #1 实测）：
# 两条子脚本都以 `-swift-version 5 -default-isolation MainActor` 编译。`-default-isolation`
# 是 Swift 6.2（Xcode 26）才有的前端参数；macos-14 runner 上最新只到 Xcode 16.2
# （Swift 6.0），实测输出是一行 `error: unknown argument: '-default-isolation'` 之后退出 1。
# 结论没错（判据确实没跑成），但那行字看起来像源码写错了，排查方向会被带偏。
# 所以把"工具链太旧"和"源码有错"分开说：**缺能力是失败，不是跳过** ——
# 这台机器有 Xcode，只是它跑不了本判据，绝不能因此静默变绿。
swiftc_help="$(xcrun swiftc -help-hidden 2>&1 || true)"
if ! grep -q -- "-default-isolation" <<<"$swiftc_help"; then
  {
    echo "❌ iOS 门禁无法执行：当前 Swift 工具链不支持 -default-isolation（需要 Swift 6.2+ / Xcode 26+）。"
    echo "    DEVELOPER_DIR=$DEVELOPER_DIR"
    xcrun swiftc --version 2>&1 | head -2 | sed 's/^/    /'
    echo "    这不是「跳过」：本机有 Xcode，但跑不了本判据，所以本次没有检查任何 iOS 源码。"
    echo "    修复：xcode-select 到 Xcode 26+（详见 docs/IOS_NATIVE_RUNBOOK.md）。"
  } >&2
  exit 1
fi

# Python 解释器预检（D2，2026-10-15）：三支 direct-sync 门禁需要 Python ≥ 3.9
# （模块级 PEP 604 注解在 3.9 下会 TypeError；更低版本更不行）。macOS 默认的
# /usr/bin/python3 恰是 3.9 —— "默认机即绿"就是这条阈值的来源。
# 缺解释器 / 版本过低时**显式失败**：门禁在"没跑"的时候必须说出来，不能静默跳过。
gate_python="$(command -v python3 || true)"
if [ -z "$gate_python" ]; then
  echo "❌ iOS 门禁需要 Python 3（找不到 python3）" >&2
  exit 1
fi
gate_python_version="$("$gate_python" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
case "$gate_python_version" in
  3.[0-8])
    echo "❌ iOS 门禁需要 Python ≥ 3.9（当前 ${gate_python_version}，来自 ${gate_python}）" >&2
    exit 1
    ;;
esac

set -e
bash apps/ios/tests/typecheck-ios.sh
bash apps/ios/tests/run-model-tests.sh
echo "iOS 门禁通过（类型检查 + 纯逻辑回归）"
