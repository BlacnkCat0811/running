#!/bin/bash
# 用高德 SDK 自带的 AMapCoordinateConvert(_, .GPS) 对拍本地 GCJ02.fromWGS84。
#
# 需要：apps/ios/Pods（先 cd apps/ios && pod install）+ 一个已启动的 iOS 模拟器。
# 不需要高德 Key —— AMapCoordinateConvert 是纯函数，不创建 MAMapView、不联网。
# macOS 上跑不了（iOS 静态框架），所以本检查不进 run-model-tests.sh / CI。
set -euo pipefail
cd "$(dirname "$0")/../../.."

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
pods="$PWD/apps/ios/Pods"
[ -d "$pods/AMapFoundation/AMapFoundationKit.framework" ] || {
  echo 'Missing AMap pods; run: cd apps/ios && pod install' >&2; exit 1;
}

device="${RAI_COORDINATE_DEVICE:-$(xcrun simctl list devices booted -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
print(next((d["udid"] for run in devices.values() for d in run if d.get("state") == "Booted"), ""))')}"
if [ -z "$device" ]; then
  echo 'No booted Simulator; boot one or set RAI_COORDINATE_DEVICE.' >&2; exit 1
fi

# CocoaPods excludes arm64 for the simulator slice, so the app itself builds x86_64
# on Apple Silicon too; match that here.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
xcrun -sdk iphonesimulator swiftc -target x86_64-apple-ios17.0-simulator \
  -F "$pods/AMapFoundation" -F "$pods/AMap3DMap" \
  -Xlinker -ObjC -lz -lc++ \
  -framework AMapFoundationKit -framework UIKit -framework Foundation \
  -framework CoreGraphics -framework CoreLocation -framework CoreTelephony -framework CoreText \
  -framework GLKit -framework OpenGLES -framework QuartzCore -framework Security \
  -framework SystemConfiguration \
  apps/ios/tests/CoordinateSDKComparison.swift apps/ios/RAI/CoordinateConversion.swift \
  -o "$tmp/sdk-check" > "$tmp/build.log" 2>&1 || { cat "$tmp/build.log" >&2; exit 1; }

xcrun simctl spawn "$device" "$tmp/sdk-check"
