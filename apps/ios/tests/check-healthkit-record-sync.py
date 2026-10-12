#!/usr/bin/env python3
"""Wiring checks complement the executable cursor/parser/SQLite regressions.

判据总数由 `check()` 在**运行时**累加，末尾用 `MIN_CHECKS` 兜地板 —— 照搬
`check-background-capabilities.py` 的纪律：跑绿只说明"没红"，不说明"判据还在"。
（此前的写法是散落的 `assert` + 一句硬编码 `"21 checks passed"`，实际有 22 条
且没有任何地板 ⇒ 改写脚本时静默少跑一条判据不可检测，见未提交改动审查 🟡3。）
"""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
export = (root / "apps/ios/RAI/HealthKitExport.swift").read_text()
sync = (root / "apps/ios/RAI/HealthKitSync.swift").read_text()
store = (root / "apps/ios/RAI/SyncTaskStore.swift").read_text()
parser = (root / "packages/health-export-parser/src/apple-health-parser.ts").read_text()
cursor = (root / "apps/ios/RAI/HealthKitRecordCursor.swift").read_text()

failures: list[str] = []
checks = 0


def check(condition: bool, message: str) -> None:
    """累加计数并记录失败。**不用 `assert`**：`python -O` 会把 assert 整条删掉，
    而运行时计数与地板的存在意义正是"判据还在不在"。"""
    global checks
    checks += 1
    if not condition:
        failures.append(message)


def body(source: str, start: str, end: str) -> str:
    return source.split(start, 1)[1].split(end, 1)[0]


def ordered(text: str, *needles: str) -> bool:
    """所有锚点都存在且按给定顺序出现。缺任一锚点即 False —— **不用 `str.index`**：
    缺锚点会抛一个与判据无关的 traceback（traceback 也让门禁红，但指认不了是哪条判据丢了）。"""
    start = 0
    for needle in needles:
        at = text.find(needle, start)
        if at < 0:
            return False
        start = at + len(needle)
    return True


query = body(export, "private static func anchoredRecords(", "private static func optionalSamples")
records = body(export, "private static func writeGlobalRecords(", "private static func anchoredRecords(")
quantity = body(export, "private static func recordXML(", "private static func sampleMetadataXML(")
commit = body(store, "func commitSuccess(", "func loadRecordCursors(")

check("HKAnchoredObjectQuery(type: type, predicate: nil, anchor: anchor, limit: 1000)" in query,
      "the record query is no longer anchored/paginated the way the regressions exercise")
check("guard let next else" in query,
      "missing anchor is an error, never cursor zero")
check("withTaskCancellationHandler" in query and "box.cancel()" in query,
      "the anchored record query lost its cancellation handling")
check("predicateForSamples" not in records,
      "historical changes cannot be event-date filtered")
check("HealthKitRecordCursor.drain" in records,
      "tested pagination must drive the production query")
check("recordsForceRescan: full," in sync,
      "ordinary sync must not force full record history; only explicit full import does")
check("manual: true" not in sync and "full || manual" not in sync,
      "the button/shortcut entry point must not turn incremental sync into history replay")
history_policy = body(cursor, "func needsHistoryRead(", "/// An additions-empty")
check("timeIntervalSince" not in history_policy and "force" in history_policy,
      "ordinary sync must not periodically reset an established record cursor")
check("previous == nil || decoded != nil || forceHistory" in records,
      "a corrupt stored anchor must not silently trigger automatic history replay")
check("guard anchorData == nil || stored != nil" in export,
      "a corrupt stored workout anchor must not silently reset the workout query")
check("guard hasWorkoutChange || routeForceRescan || !routeFiles.isEmpty" in export,
      "workout candidates without a change or GPX retry must not be exported")
check('"sourceIds": exportedWorkouts.map(workoutSyncId)' in export
      and "workoutCount: exportedWorkouts.count" in export,
      "the manifest and UI count must describe exported deltas, not rechecked workouts")
check("routeForceRescan: full," in sync,
      "explicit full import must still rescan routes as well as records")
check(ordered(records, "var starts: [HKQueryAnchor?] = [decoded]", "starts.append(nil)"),
      "the committed cursor must seed the drain before the nil (full re-read) start")
check("RAIHealthKitSampleUUID" in export and "sampleMetadataXML(sample)" in quantity,
      "quantity records must carry their sample UUID into the XML metadata")
check('sampleMetadataXML(sample))</Record>' in records,
      "sleep must carry UUIDs too")
check('"version": 2' in export and '"deletedRecords": records.deleted' in export,
      "the export manifest must be v2 and carry the record deletions")
check("writeWorkoutRecords" not in export,
      "associated samples must use type cursors too")
check("pendingRecordCursors: exported.recordCursors" in sync,
      "a successful export must save the per-type cursors")
# 5 = 四条恢复分支（`.inspect` 的 unchanged/resumed、`.upload` 的 unchanged/resumed）
# + 2026-10-11 补上的第五条：`.waitJob`（盘上有 jobId 时续接服务端终态）。
# 🔴 这个数字是**分支总数**的钉子，不是装饰：`SyncAtomicUnit.Step` 里的 `.waitJob`
# 此前没有任何生产消费点，带 jobId 的任务会直接坠进导出路径 —— 而这门禁当时数的是 4，
# 恰好把"少一条恢复分支"这件事数成了正常。加分支就必须加这个数，加的时候必须想清楚
# "这一条**为什么**要提交同一批游标"。
check(sync.count("recordCursors: restored.pendingRecordCursors") == 5,
      "every resume success must commit the saved cursors")
check("recordCursors: recordCursors" in body(sync, "private func markSuccess(", "private func "),
      "manual success must also commit the cursors")
check("healthKitRecordSyncVersion ?? 0" in sync,
      "old servers must not acknowledge unsupported deltas")
check(ordered(sync, "restoredTask?.pendingRecordCursors != nil", "let unitStep = SyncAtomicUnit.nextStep"),
      "a restored v2 batch must be recognised before the unit step is computed")
check(sync.count("identity.healthKitRecordSyncVersion ?? 0") == 2,
      "both new exports and restored v2 batches require capability")
check("HealthKitExport.recordSampleTypes.map" in sync,
      "all record types must reach the existing observer delivery pipeline")
check("exported.deletionCount == 0" in sync,
      "a deletion-only sync is not an unreadable empty export")
check(ordered(commit, "writeRecordCursors", 'prepare("DELETE FROM sync_tasks', 'execute("COMMIT"'),
      "cursor writes must land before the task row is deleted and the transaction commits")
check("loadRecordCursors(scope: scope) == recordCursors" in commit,
      "the cursor write must be read back inside the transaction")
check("removedHealthKitRecords" in parser and "sourceIdentifiers" in parser,
      "the parser must report removed records together with their source identifiers")
check(ordered(parser, "store.removeHealthKitRecords", "if (atomic) store.commitAtomicImport()"),
      "record deletions must be applied before the atomic import commits")

# --- 判据总数的下限（**必须放在全部判据之后**） ---------------------------------
# 照 `check-background-capabilities.py`：`check()` 的参数在调用前求值，所以这里读到的
# `checks` 还不含这条地板本身 ⇒ 地板 = 印制总数 − 1。**零容忍**：删掉任意一条判据
# （或把它挪进走不到的分支）都会让它变红。
MIN_CHECKS = 30
check(
    checks >= MIN_CHECKS,
    "only %d judgements ran, floor is %d — a wiring judgement was silently dropped"
    % (checks, MIN_CHECKS),
)

if failures:
    for item in failures:
        print("FAIL: %s" % item)
    print("HealthKit record sync wiring: %d checks, %d failed" % (checks, len(failures)))
    sys.exit(1)

print("HealthKit record sync wiring: %d checks, 0 failed" % checks)
