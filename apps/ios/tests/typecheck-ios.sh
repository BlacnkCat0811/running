#!/bin/bash
# 沙箱内可用的 iOS 层类型检查。
#
# 为什么需要它：本机没有 CocoaPods（`pod` 不存在），`apps/ios/Pods` 不入库，因此
# xcodebuild 与完整 target 编译都跑不起来。但高德 SDK 只被 4 个文件直接依赖，
# 其余 Swift 源码可以配一个替身模块用 `swiftc -typecheck` 真实检查——两个皮肤的
# 视图文件（NativeViews.swift / TechViews.swift）都在覆盖范围内，这是它们唯一
# 能被验证的通道。
#
# 覆盖率：apps/ios/RAI/** 除下列 4 个文件外的全部源码。
#   MapPrivacy.swift / MapPrivacyConsentView.swift / RAIApp.swift / TechRouteView.swift
# 这 4 个文件只依赖高德 SDK，改动它们时必须在装有 Pods 的机器上编译。
#
# 用法：bash apps/ios/tests/typecheck-ios.sh
set -euo pipefail
cd "$(dirname "$0")/../../.."

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
[ -d "$DEVELOPER_DIR" ] || { echo "缺少 Xcode：$DEVELOPER_DIR" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 替身模块：与真实文件的公开接口一致，只去掉高德依赖。
cat > "$tmp/SandboxStubs.swift" <<'SWIFT'
#if os(iOS)
import Foundation
import SwiftUI

/// 替身：对应 apps/ios/RAI/MapPrivacy.swift（去掉 AMapFoundationKit / MAMapKit）。
@MainActor
enum MapPrivacy {
    enum State: String { case ask, agreed, declined }
    static let storageKey = "rai.privacy.amap.state"
    static let policyURL = URL(string: "https://lbs.amap.com/pages/privacy/")!
    static var state: State { State(rawValue: UserDefaults.standard.string(forKey: storageKey) ?? "") ?? .ask }
    static var mapEnabled: Bool { state == .agreed }
    static func configureIfAgreed() {}
    static func agree() {}
    static func decline() {}
    static func resetToAsk() {}
}

/// 替身：对应 apps/ios/RAI/RAIApp.swift 里的 AppModel（该文件的其余部分依赖 AMap）。
@MainActor
final class AppModel {
    static let shared = AppModel()
    let session: ServerSession
    let healthSync: HealthKitSync
    let chrome = ChromeController()
    let discovery = ServerDiscovery()
    let native: NativeAppModel

    init() {
        let session = ServerSession()
        self.session = session
        self.healthSync = HealthKitSync()
        self.native = NativeAppModel(session: session)
    }
}

/// 替身：对应 apps/ios/RAI/Skins/Technology/TechRouteView.swift（唯一需要 MAMapKit
/// 的视图，被 TechViews 的路线面板引用，所以这里只需要入口签名）。
struct TechRouteView: View {
    let route: [RoutePoint]
    var body: some View { EmptyView() }
}
#endif
SWIFT

shopt -s nullglob
files=(apps/ios/RAI/*.swift apps/ios/RAI/Skins/*.swift apps/ios/RAI/Skins/*/*.swift)

# 没有匹配到任何源文件时必须失败：否则 swiftc 只检查替身模块、零错误，
# 脚本会打印「通过」并退出 0 —— 一个什么都不检查的门禁比没有门禁更危险。
# 必须放在遍历之前：bash 3.2 下空数组的 `"${files[@]}"` 会先触发 unbound variable。
if [ "${#files[@]}" -eq 0 ]; then
  echo "错误：没有找到任何 iOS 源文件（当前目录 $(pwd) 是否正确？）" >&2
  exit 1
fi

keep=()
for file in "${files[@]}"; do
  case "$file" in
    *MapPrivacy.swift|*MapPrivacyConsentView.swift|*RAIApp.swift|*TechRouteView.swift) continue ;;
  esac
  keep+=("$file")
done

if [ "${#keep[@]}" -eq 0 ]; then
  echo "错误：排除仅依赖高德 SDK 的文件后没有剩余源文件" >&2
  exit 1
fi

echo "类型检查 ${#keep[@]} 个文件（已跳过 $((${#files[@]} - ${#keep[@]})) 个仅依赖高德 SDK 的文件）"

# The macro plugin (`swift-plugin-server`) must start for `@Observable` and
# friends to expand. On a machine that blocks it (sandbox, broken toolchain
# wiring) every macro expansion fails, and the output reads like a wall of
# source errors. Name the real cause — and still exit non-zero, because the
# sources genuinely were not checked.
#
# `-disable-sandbox` is what actually keeps it working here: swift-driver wraps
# the plugin server in `sandbox-exec`, and when the outer environment refuses a
# nested sandbox the server dies with "sandbox_apply: Operation not permitted"
# and every macro expansion reports "produced malformed response". macOS 与 iOS
# 目标同样受影响（实测 2026-09-13）；关掉这层包装后 36 文件 0 error。
set +e
output=$(xcrun -sdk iphonesimulator swiftc -typecheck -disable-sandbox \
  -target x86_64-apple-ios17.0-simulator \
  "${keep[@]}" "$tmp/SandboxStubs.swift" 2>&1)
status=$?
set -e
printf '%s\n' "$output"
if [ "$status" -ne 0 ]; then
  # here-string, not a pipe: `grep -q` exits on the first match and would
  # SIGPIPE the writer mid-output.
  if grep -qE "swift-plugin-server|could not be found for macro" <<<"$output"; then
    {
      echo ""
      echo "⚠️  环境不支持 Swift 宏展开：swift-plugin-server 无法启动（沙箱拒绝等）。"
      echo "    这不是源码错误——但类型检查没有完成，不要当成通过。"
      echo "    请改用 run-model-tests.sh 验证纯逻辑，或在装有 Pods 的机器 / CI 上跑本脚本。"
    } >&2
  fi
  exit "$status"
fi
echo "iOS 类型检查通过"
