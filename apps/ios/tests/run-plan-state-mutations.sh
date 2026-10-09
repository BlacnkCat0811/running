#!/bin/bash
# Release audit: compile real model with isolated cache/API doubles, then prove
# the new F1/F2 assertions reject semantic regressions (not compile failures).
set -euo pipefail
cd "$(dirname "$0")/../../.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
python3 - "$tmp" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
source = Path('apps/ios/RAI/NativeAppModel.swift').read_text()
source = source.removeprefix('#if os(iOS)\n').removesuffix('#endif\n')
mutants = {
    'forgot-watermark': ('if cache.acknowledgePlanWrite(ack, scope: cacheScope, goals: goals, coach: coach) {', 'if true {'),
    'id-only-lease': ('planSyncSnapshot(snapshot.leaseID) == snapshot', 'isCurrentPlanSync(snapshot.leaseID)'),
}
for name, (before, after) in mutants.items():
    assert source.count(before) == 1, (name, 'anchor must occur exactly once')
    (root/f'{name}.swift').write_text(source.replace(before, after))
PY
for mutant in forgot-watermark id-only-lease; do
  xcrun swiftc -parse-as-library -disable-sandbox \
    apps/ios/RAI/APIModels.swift apps/ios/RAI/APIClient.swift apps/ios/RAI/NativeFormat.swift \
    apps/ios/RAI/WorkoutPlanMapper.swift apps/ios/RAI/CalibrationState.swift apps/ios/RAI/UserDataNoticePolicy.swift \
    apps/ios/RAI/HealthSyncBackgroundRecovery.swift apps/ios/RAI/HealthSyncIdentityPublisher.swift \
    apps/ios/RAI/PlanStatePolicy.swift apps/ios/RAI/PlanWatchScheduling.swift apps/ios/RAI/PlanReceiptMatcher.swift \
    apps/ios/RAI/PlanWatchSyncCoordinator.swift "$tmp/$mutant.swift" \
    apps/ios/tests/PlanTestFixtures.swift apps/ios/tests/ModelRegression.swift -o "$tmp/$mutant"
  python3 - "$tmp/$mutant" "$mutant" <<'PY'
import subprocess, sys
expected = {
  'forgot-watermark': 'manual confirm watermark survives all failed reads and offline restart',
  'id-only-lease': 'same revision recovery gate change invalidates the complete snapshot lease',
}[sys.argv[2]]
result = subprocess.run([sys.argv[1]], capture_output=True, text=True)
if result.returncode == 0 or 'Precondition failed: ' + expected not in result.stderr:
    print(result.stdout[-1500:] + result.stderr[-1500:])
    raise SystemExit('Semantic mutant survived or failed for another reason: ' + sys.argv[2])
print('Semantic mutant rejected by expected behavioral assertion:', sys.argv[2])
PY
done
