#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
xcrun swiftc -parse-as-library -disable-sandbox -swift-version 5 -default-isolation MainActor \
  apps/ios/RAI/APIModels.swift apps/ios/RAI/PlanStatePolicy.swift \
  apps/ios/RAI/WorkoutPlanMapper.swift apps/ios/RAI/PlanReceiptMatcher.swift \
  apps/ios/RAI/UserDataNoticePolicy.swift apps/ios/RAI/PlanWatchScheduling.swift \
  apps/ios/RAI/PlanScheduleOperationJournal.swift \
  apps/ios/tests/PlanTestFixtures.swift apps/ios/tests/PlanWatchSchedulingRegression.swift \
  -o "$tmp/plan-watch-tests"
"$tmp/plan-watch-tests"
# Optional red/green proof using isolated copies only. Normal npm test:ios keeps
# the fast production regressions; release audits can request semantic mutants.
if [ "${RAI_PLAN_WATCH_MUTATIONS:-0}" = 1 ]; then
  python3 - "$tmp" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
matcher = Path('apps/ios/RAI/PlanReceiptMatcher.swift').read_text()
scheduling = Path('apps/ios/RAI/PlanWatchScheduling.swift').read_text()
mutants = {
    'wrong-id': ('PlanReceiptMatcher.swift', matcher, '$0.workoutID == request.entry.workoutID &&', 'true &&'),
    'pending-is-coverage': ('PlanWatchScheduling.swift', scheduling, 'outcome.verified = outcome.clearVerified && outcome.scheduled == outcome.offered', 'outcome.verified = outcome.clearVerified && outcome.scheduled == requests.count'),
    'silent-clear-is-success': ('PlanWatchScheduling.swift', scheduling, 'outcome.clearVerified = afterClear.isEmpty', 'outcome.clearVerified = true'),
    'effect-before-journal': ('PlanWatchScheduling.swift', scheduling, 'guard journal.prepare(requests) else {', 'await scheduler.removeAll()\n        guard journal.prepare(requests) else {'),
}
for name, (file, source, before, after) in mutants.items():
    assert source.count(before) == 1, (name, 'mutation anchor must occur exactly once')
    changed = source.replace(before, after)
    if name == 'pending-is-coverage':
        changed = changed.replace('guard requests.count == owed.count else {', 'guard true else {')
    (root / f'{name}.swift').write_text(changed)
PY
  for mutant in wrong-id pending-is-coverage silent-clear-is-success effect-before-journal; do
    matcher=apps/ios/RAI/PlanReceiptMatcher.swift
    scheduling=apps/ios/RAI/PlanWatchScheduling.swift
    if [ "$mutant" = wrong-id ]; then matcher="$tmp/$mutant.swift"; else scheduling="$tmp/$mutant.swift"; fi
    # A compile error is NOT a killed behavioral mutant.
    xcrun swiftc -parse-as-library -disable-sandbox -swift-version 5 -default-isolation MainActor \
      apps/ios/RAI/APIModels.swift apps/ios/RAI/PlanStatePolicy.swift \
      apps/ios/RAI/WorkoutPlanMapper.swift "$matcher" apps/ios/RAI/UserDataNoticePolicy.swift "$scheduling" \
      apps/ios/RAI/PlanScheduleOperationJournal.swift \
      apps/ios/tests/PlanTestFixtures.swift apps/ios/tests/PlanWatchSchedulingRegression.swift \
      -o "$tmp/$mutant"
    python3 - "$tmp/$mutant" "$mutant" <<'PY'
import subprocess, sys
result = subprocess.run([sys.argv[1]], capture_output=True, text=True)
if result.returncode == 0 or 'Precondition failed' not in result.stderr:
    raise SystemExit('Semantic mutant survived or failed for another reason: ' + sys.argv[2])
print('Semantic mutant rejected by behavioral assertions:', sys.argv[2])
PY
  done
fi
