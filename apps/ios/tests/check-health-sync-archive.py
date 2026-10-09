#!/usr/bin/env python3
"""Pin the MainActor-to-file-worker wiring that Swift typechecking cannot verify.

判据总数由 `check()` 在**运行时**累加，末尾用 `MIN_CHECKS` 兜地板 —— 照搬
`check-background-capabilities.py` 的纪律：跑绿只说明"没红"，不说明"判据还在"。
（此前的写法是散落的 `assert` + 一句不带数字的 `...passed`，且没有任何地板 ⇒
改写脚本时静默少跑一条判据不可检测，见未提交改动审查 🟡3。）
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
sync = (root / "apps/ios/RAI/HealthKitSync.swift").read_text()
worker = (root / "apps/ios/RAI/HealthSyncArchive.swift").read_text()
runner = (root / "apps/ios/tests/run-health-sync-tests.sh").read_text()

failures: list[str] = []
checks = 0


def check(condition: bool, message: str) -> None:
    """累加计数并记录失败。**不用 `assert`**：`python -O` 会把 assert 整条删掉，
    而运行时计数与地板的存在意义正是"判据还在不在"。"""
    global checks
    checks += 1
    if not condition:
        failures.append(message)


def code(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.strip().startswith("//"))


def find(text: str, needle: str, start: int = 0) -> int:
    """定位锚点；找不到返回 -1 —— 让调用处的 `check` 报失败，而不是抛一个与判据无关的
    traceback（traceback 也会让门禁变红，但它指认不了是哪条判据丢了）。"""
    return text.find(needle, start if start >= 0 else 0)


sync = code(sync)
worker = code(worker)

check("Data(contentsOf:" not in worker,
      "archive worker regressed to whole-file buffering")
check(not re.search(r"private func (fileHash|persistZip)\b", sync),
      "MainActor still owns synchronous ZIP processing")
check("copyItem(" not in sync,
      "MainActor still copies the full ZIP synchronously")
check("nonisolated enum HealthSyncArchive" in worker,
      "file helper inherits MainActor isolation")
check(worker.count("HealthSyncCancellation.runDetached(") == 2,
      "hash and preparation must both leave MainActor")
check("onCancelledResult: { $0.discardIfUncommitted() }" in worker,
      "late cancelled result leaks its new archive")
check("autoreleasepool" in worker and "read(upToCount: chunkSize)" in worker,
      "archive reads must stay memory-bounded")
check("Task.checkCancellation()" in worker,
      "file worker no longer checks cancellation")
check("replaceItemAt(durableURL, withItemAt: stagingURL)" in worker,
      "existing archive is not atomically replaced")
check("removeItem(at: durableURL)" not in worker,
      "file worker deletes the old ZIP before publishing")
check(".completeUntilFirstUserAuthentication" in worker,
      "persistent archive lost background-readable protection")
check("isExcludedFromBackup = true" in worker,
      "persistent archive entered backups")
check("try await HealthSyncArchive.fileHash(url)" in sync,
      "legacy resume hashes on MainActor")
check(sync.count("try await persistedZipURL(restoredTask)") == 1,
      "legacy resume repeats its full archive hash")
check("hasZip: restoredZip != nil" in sync and "let persisted = restoredZip" in sync,
      "resume ignores cached ZIP validation")

start = find(sync, "let prepared = try await HealthSyncArchive.prepare(")
saved = find(sync, "try saveTask(SyncTaskState(", start)
released = find(sync, "uncommittedArchive = nil", saved)
uploaded = find(sync, "try await uploadWithRecovery(", released)
check(-1 < start < saved < released < uploaded,
      "file ownership must transfer only after journaling, before uploading "
      "(an anchor moved or disappeared: %d/%d/%d/%d)" % (start, saved, released, uploaded))
check(uploaded >= 0 and "uncommittedArchive.discardIfUncommitted()" in sync[uploaded:],
      "journal failure leaks its newly published archive")
check("HealthSyncArchiveRegression.swift" in runner and "check-health-sync-archive.py" in runner,
      "archive checks have no gate entry")

# --- 判据总数的下限（**必须放在全部判据之后**） ---------------------------------
# 照 `check-background-capabilities.py`：`check()` 的参数在调用前求值，所以这里读到的
# `checks` 还不含这条地板本身 ⇒ 地板 = 印制总数 − 1。**零容忍**：删掉任意一条判据
# （或把它挪进走不到的分支）都会让它变红。
MIN_CHECKS = 18
check(
    checks >= MIN_CHECKS,
    "only %d judgements ran, floor is %d — a wiring judgement was silently dropped"
    % (checks, MIN_CHECKS),
)

if failures:
    for item in failures:
        print("FAIL: %s" % item)
    print("Health sync archive execution-boundary checks: %d checks, %d failed" % (checks, len(failures)))
    sys.exit(1)

print("Health sync archive execution-boundary checks: %d checks, 0 failed" % checks)
