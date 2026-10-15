#!/usr/bin/env python3
"""Wiring checks complement the executable cursor/parser/SQLite regressions.

判据总数由 `check()` 在**运行时**累加，末尾用 `MIN_CHECKS` 兜地板 —— 照搬
`check-background-capabilities.py` 的纪律：跑绿只说明"没红"，不说明"判据还在"。
（此前的写法是散落的 `assert` + 一句硬编码 `"21 checks passed"`，实际有 22 条
且没有任何地板 ⇒ 改写脚本时静默少跑一条判据不可检测，见未提交改动审查 🟡3。）

🔴 显式 `encoding="utf-8"`：被读的 Swift/TS 源码含中文，而 `read_text()` 不带
`encoding` 时用**本机默认编码**（Windows = cp936/GBK）⇒ 在 Windows 上直接
`UnicodeDecodeError` 崩溃退出，而这条链只在 macOS 上跑（默认 UTF-8），
所以"本机跑不了自己的门禁"这个缺口在两边都看不见。
"""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
export = (root / "apps/ios/RAI/HealthKitExport.swift").read_text(encoding="utf-8")
sync = (root / "apps/ios/RAI/HealthKitSync.swift").read_text(encoding="utf-8")
store = (root / "apps/ios/RAI/SyncTaskStore.swift").read_text(encoding="utf-8")
parser = (root / "packages/health-export-parser/src/apple-health-parser.ts").read_text(encoding="utf-8")
cursor = (root / "apps/ios/RAI/HealthKitRecordCursor.swift").read_text(encoding="utf-8")

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

check("HKAnchoredObjectQuery(type: type, predicate: nil, anchor: anchor, limit: limit)" in query,
      "the record query must carry a **shrinkable** limit (a fixed literal cannot shrink an oversized page)")
check("private static let recordPageLimit = 1000" in export,
      "the full-page cap must stay a named constant (1000) - it is where the shrink path starts")
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
# 2026-10-14（S2.1）**改写而非删除**：段序从内联数组搬进了 `RecordReplayPlan.segments`
# （纯逻辑；`HealthKitRecordCursorRegression` 用相等断言逐组合钉着）。判据拆成两处：
# 一处钉**段序本身**（先增量后历史 —— 内联形态消失但语义不变），一处钉
# **导出路径确实用这个计划驱动 drain**（否则段序写对了也没人用）。
check("[.incremental, .historyFromScratch]" in cursor,
      "the committed cursor must be drained before the nil (full re-read) start")
check("let segments = RecordReplayPlan.segments(" in records,
      "the drain segments must be planned by RecordReplayPlan")
check("RAIHealthKitSampleUUID" in export and "sampleMetadataXML(sample)" in quantity,
      "quantity records must carry their sample UUID into the XML metadata")
check('sampleMetadataXML(sample))</Record>' in records,
      "sleep must carry UUIDs too")
check('"version": 2' in export and '"deletedRecords": stashRecordDeletions + records.deleted' in export,
      "the export manifest must be v2 and carry the record deletions (stash + this batch, R3b)")
check('"deletedSourceIds": (stashWorkoutIds + keptWorkoutIds).sorted()' in export,
      "the manifest must send stashed workout deletions together with this batch's (R3b)")
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

# --- 分批与续传的接线判据（S2.1–S2.3，2026-10-14） ----------------------------
# 这一批的失效方向全是"改错了照样编译通过"：预算检查放错位置（页首=死循环）、
# 换算式写错（载荷超界 ⇒ 静默回退候选链路）、待续标记漏接线（剩下的页没人读）。
# 行为断言在 macOS 的纯逻辑回归（HealthKitRecordCursorRegression /
# BackgroundSyncPolicyRegression）里跑；这里钉**接线与常量**，本机（Windows）即可执行。
budget = (root / "apps/ios/RAI/DirectSyncBatchBudget.swift").read_text(encoding="utf-8")

# S2.5（2026-10-14）：预算判定必须在**提交之前**、用**渲染后的整页字节**做。
# 旧判据要求"停在页末尾（consume 之后）"，那正是 524 KB 超额的成因：服务端按字节判上界，
# 而页是不可分的提交单位 ⇒ 每批最后一个页整体越界（真机：预算 1,887,436 B → 实际 2,411,741 B）。
# 现在的形态：render → decide → commit，放不下就**整页不提交**且锚点回退到页前。
check(ordered(cursor, "let rendered = try render(page.added, page.deleted)", "try commit(rendered"),
      "the budget decision must sit between render and commit (committing first IS the 524 KB overage)")
check("case .retryWithLimit" in cursor and "return (anchor, true, true)" in cursor,
      "an oversized page must be left uncommitted with the anchor rolled back to the page start")
check("stoppedBeforePage" in cursor and "hasMorePages" in cursor,
      "drain must report hasMorePages and stoppedBeforePage separately (zero progress != partial read)")
check("limit = requested < limit ? max(1, requested) : max(1, limit / 2)" in cursor,
      "the retry limit must strictly decrease, otherwise the shrink path can never terminate")
# S2.2：保守常量与 ×0.9 换算（服务端 bounds 缺字段时的回落路径）。
check("1_887_436" in budget and "4_500" in budget,
      "the conservative budget constants drifted (1.8 MiB / 4500)")
check("Double(bounds.maxXmlBytes) * 0.9" in budget and "Double(bounds.maxRecords) * 0.9" in budget,
      "the 0.9 margin over the server bounds is gone (payloads would exceed the hard limits)")
# route 维度（2026-10-14 补全）：常量、换算与收集侧闸门（先判后取；状态与文件同进同退）。
check("30_198_988" in budget and "180" in budget,
      "the conservative route budgets drifted (28.8 MiB / 180 files)")
check("Double(bounds.maxRouteBytes) * 0.9" in budget and "Double(bounds.maxRouteFiles) * 0.9" in budget,
      "the 0.9 margin over the route bounds is gone (route payloads would exceed the hard limits)")
check("func routeBudgetExhausted(routeBytes:" in budget
      and "budget.routeBudgetExhausted(routeBytes:" in export,
      "the route budget gate must sit in the export loop (pre-fetch; state and files advance together)")
# 导出路径：drain 调用必须接**写前判定**与**收缩**（判定用渲染后的整页字节 + 已提交字节）。
check("budget.accepts(" in export and "budget.shrinkLimit(" in export,
      "writeGlobalRecords must decide before committing the page (accepts) and be able to shrink it")
# S2.3：待续标记必须过 commitSuccess 的事务；探测点必须读它；前台分额度接线必须都到位。
check("hasMorePages: hasMorePages" in sync,
      "the real hasMorePages must reach continuationNeeded (a hard-coded false drops the flag)")
check("continuationPending: needsContinuation" in sync,
      "markSuccess must persist the continuation flag through commitSuccess")
check("loadContinuation(scope:" in sync,
      "probePendingWork must read the continuation slot (otherwise nobody sends the next page)")
check("CREATE TABLE IF NOT EXISTS sync_continuation" in store,
      "the continuation slot table is missing from the store schema")
check("func writeContinuation(" in store and "continuationPending || deletionsStillPending" in store,
      "commitSuccess must write/clear the continuation slot inside its transaction "
      "(the sentinel now also covers still-pending deletions, R3b)")
check("CREATE TABLE IF NOT EXISTS sync_pending_deletions" in store
      and "func writePendingDeletions(" in store and "func loadPendingDeletions(" in store,
      "the pending-deletions slot must exist with its write/load pair (R3b)")
check("pendingDeletions: DirectSyncPendingDeletions? = nil" in store,
      "commitSuccess must accept the pending-deletions payload (nil = leave the old slot)")
# 任务行透传：导出轮必须把 hasMorePages 写进任务行（崩溃/挂起后恢复轮才有得透传）。
check("needsContinuation: exported.hasMorePages" in sync,
      "the export round must persist hasMorePages into the task row for resume rounds")

# --- 判据总数的下限（**必须放在全部判据之后**） ---------------------------------
# 照 `check-background-capabilities.py`：`check()` 的参数在调用前求值，所以这里读到的
# `checks` 还不含这条地板本身 ⇒ 地板 = 印制总数 − 1。**零容忍**：删掉任意一条判据
# （或把它挪进走不到的分支）都会让它变红。
# 2026-10-16（R3b）：新增删除暂存/截断判据后实测打印 52 ⇒ 按同一纪律重设为 51。
MIN_CHECKS = 51
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
