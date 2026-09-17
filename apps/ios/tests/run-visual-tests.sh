#!/bin/bash
# Native iOS screenshot review using an isolated SQLite copy and dedicated Simulator.
set -euo pipefail
cd "$(dirname "$0")/../../.."
root="$PWD"
for port in 8792 8793 8794; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is occupied; stop that acceptance service before running." >&2; exit 1
  fi
done
device="${RAI_VISUAL_DEVICE:-$(xcrun simctl list devices available -j | python3 -c 'import json,sys; print(next((d["udid"] for a in json.load(sys.stdin)["devices"].values() for d in a if d["name"] == "RAI Technology Acceptance"), ""))')}"
if [ -z "$device" ]; then
  echo 'Create a dedicated Simulator named RAI Technology Acceptance, or set RAI_VISUAL_DEVICE.' >&2; exit 1
fi
out="${RAI_VISUAL_OUTPUT:-/tmp/rai-visual-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$out"
runtime=$(mktemp -d /tmp/rai-visual-runtime.XXXXXX)
api_pid=""; proxy_pid=""
cleanup() {
  [ -z "$proxy_pid" ] || kill "$proxy_pid" 2>/dev/null || true
  [ -z "$api_pid" ] || kill "$api_pid" 2>/dev/null || true
  [ -z "$proxy_pid" ] || wait "$proxy_pid" 2>/dev/null || true
  [ -z "$api_pid" ] || wait "$api_pid" 2>/dev/null || true
  rm -rf "$runtime"
}
trap cleanup EXIT
mkdir -p "$runtime/var"
sqlite3 "${RAI_VISUAL_DATABASE:-$root/var/rai.sqlite}" ".backup '$runtime/var/rai.sqlite'"
RAI_RUNTIME_ROOT="$runtime" RAI_DATABASE="$runtime/var/rai.sqlite" RAI_API_PORT=8792 RAI_LOG_LEVEL=warn \
  node --import tsx apps/api/src/server.ts > "$out/api.log" 2>&1 & api_pid=$!
ready=false
# Startup includes validation/migration of the isolated database. A real
# 300+ MB fixture can legitimately exceed the old 40-second startup window.
startup_deadline=$((SECONDS + ${RAI_VISUAL_STARTUP_TIMEOUT:-300}))
while [ "$SECONDS" -lt "$startup_deadline" ]; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "Isolated API exited during startup; see $out/api.log" >&2
    exit 1
  fi
  if curl -fsS --max-time 2 http://127.0.0.1:8792/v1/health >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.5
done
$ready || { echo 'Isolated API did not start'; exit 1; }
# Populate only this copy's blank day editor with the API's own recommended week.
python3 - <<'PY'
import json, urllib.request
base='http://127.0.0.1:8792'
g=json.load(urllib.request.urlopen(base+'/v1/mobile/goals'))
t=json.load(urllib.request.urlopen(base+'/v1/mobile/today'))
if not g['weekPlan']:
    value={'expectedRevision':g['revision'],'weeklyDistanceKm':g['weeklyDistanceKm'],
           'weekPlan':[{k:d[k] for k in ('localDate','kind','distanceKm')} for d in t['weekPlan']]}
    req=urllib.request.Request(base+'/v1/mobile/goals', data=json.dumps(value).encode(), method='PUT',
                              headers={'Content-Type':'application/json'})
    urllib.request.urlopen(req).close()
# Warm the expensive read-only physiology/route queries before the UI timeout begins.
for endpoint in ['/v1/predictions','/v1/training-zones/current','/v1/training-statistics/overview']:
    urllib.request.urlopen(base+endpoint, timeout=90).read()
rows=json.load(urllib.request.urlopen(base+'/v1/workouts?limit=100'))['items']
route=next((w['id'] for w in rows if w['hasRoute']), None)
if route:
    for suffix in ['', '/series']:
        urllib.request.urlopen(base+'/v1/workouts/'+route+suffix, timeout=90).read()
PY
python3 apps/ios/tests/visual-state-proxy.py > "$out/state-proxy.log" 2>&1 & proxy_pid=$!
xcrun simctl boot "$device" 2>/dev/null || true
xcrun simctl bootstatus "$device" -b > "$out/simulator.log"
xcrun simctl status_bar "$device" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
# Build the CocoaPods workspace: the AMap SDK arrives as a pod, so the bare
# project fails to link (ld: framework 'Pods_RAI' not found).
xcodebuild -workspace apps/ios/RAI.xcworkspace -scheme RAI -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "${RAI_VISUAL_DERIVED_DATA:-$out/derived}" CODE_SIGNING_ALLOWED=NO build > "$out/build.log" 2>&1
xcrun simctl install "$device" "${RAI_VISUAL_DERIVED_DATA:-$out/derived}/Build/Products/Debug-iphonesimulator/RAI.app"
set +e
xcodebuild -project apps/ios/tests/VisualAcceptance.xcodeproj -scheme VisualAcceptance \
  -destination "platform=iOS Simulator,id=$device" -derivedDataPath "${RAI_VISUAL_TEST_DERIVED_DATA:-$out/test-derived}" \
  -resultBundlePath "$out/tests.xcresult" CODE_SIGNING_ALLOWED=NO "$@" test > "$out/ui-tests.log" 2>&1
status=$?
set -e
xcrun xcresulttool export attachments --path "$out/tests.xcresult" --output-path "$out/attachments"
python3 - "$out" <<'PY'
import json, pathlib, shutil, sys, re
out=pathlib.Path(sys.argv[1]); source=out/'attachments'; target=out/'screenshots'; target.mkdir(exist_ok=True)
for test in json.loads((source/'manifest.json').read_text()):
    for item in test['attachments']:
        file=source/item['exportedFileName']
        if file.suffix != '.png': continue
        name=re.sub(r'[^a-zA-Z0-9_-]', '-', item['suggestedHumanReadableName'].split('_')[0])
        shutil.copy(file, target/(name+'.png'))
PY
echo "Review screenshots and test failures in: $out"
exit "$status"
