#!/bin/bash
# Production policy regression + timezone mutations, using only temporary source copies.
set -euo pipefail
cd "$(dirname "$0")/../../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sources=(apps/ios/RAI/APIModels.swift apps/ios/RAI/TrainingReminderPolicy.swift apps/ios/RAI/NativeFormat.swift apps/ios/RAI/WorkoutPlanMapper.swift apps/ios/RAI/SyncPresentationPolicy.swift apps/ios/tests/UserExperienceRegression.swift)
xcrun swiftc -parse-as-library -disable-sandbox "${sources[@]}" apps/ios/RAI/UserDataNoticePolicy.swift -o "$tmp/ux-tests"
"$tmp/ux-tests"
python3 - "$tmp" <<'PY'
from pathlib import Path
import sys
source = Path('apps/ios/RAI/UserDataNoticePolicy.swift').read_text()
line = next(s for s in source.splitlines() if 'formatter.timeZone =' in s)
assert source.count(line) == 1
out = Path(sys.argv[1])
(out/'removed.swift').write_text(source.replace(line, ''))
(out/'hardcoded.swift').write_text(source.replace(line, '        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")'))
PY
for mutant in removed hardcoded; do
  # Compilation errors are NOT evidence of a killed semantic mutant.
  xcrun swiftc -parse-as-library -disable-sandbox "${sources[@]}" "$tmp/$mutant.swift" -o "$tmp/$mutant"
  python3 - "$tmp/$mutant" "$mutant" <<'PY'
import subprocess, sys
result = subprocess.run([sys.argv[1]], capture_output=True, text=True)
if result.returncode == 0 or 'Precondition failed' not in result.stderr:
    print(result.stdout + result.stderr)
    raise SystemExit('Timezone mutation was not rejected by the behavioral assertions: ' + sys.argv[2])
print('Timezone mutation rejected by behavioral assertions: ' + sys.argv[2])
PY
done
