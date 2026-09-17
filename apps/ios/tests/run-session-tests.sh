#!/bin/bash
# Runs ServerSession probe isolation regressions with suite-scoped defaults,
# injected Keychain closures, and URLProtocol-only networking.
set -euo pipefail
cd "$(dirname "$0")/../../.."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

xcrun swiftc -parse-as-library -disable-sandbox \
  apps/ios/RAI/ServerSession.swift \
  apps/ios/tests/ServerSessionRegression.swift \
  -o "$tmp/server-session-tests"
"$tmp/server-session-tests"
