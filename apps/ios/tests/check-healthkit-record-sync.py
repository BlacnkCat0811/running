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
# B1（2026-10-16）：锚点从 `records`（writeGlobalRecords 全体）收窄到 `query`
# （anchoredRecords 本体）—— 窗口 pass 是**有意**引入的、独立于正式 anchor 的近期通道，
# 它用时间谓词恰恰是它的定义；而"历史/增量 anchor 查询不得事件时间过滤"这条不变式
# 依然逐字成立（:58 的 `predicate: nil` 与这里构成双保险）。
check("predicateForSamples" not in query,
      "historical changes cannot be event-date filtered (the anchored record query stays predicate-free)")
check("HealthKitRecordCursor.drain" in records,
      "tested pagination must drive the production query")
# 2026-10-17（边界收紧）：全量重导通道被**删除**（不是隐藏）。判据改成"通道不存在、
# 只剩定点修复"：任何把 `recordsForceRescan` / `full` 加回来的改动都必须让这条转红。
check("recordsForceRescan" not in sync and "forceHistory" not in export,
      "the full-replay channel must be gone (no recordsForceRescan / forceHistory)")
check("func repairSyncCursor()" in sync and "clearWorkoutAnchor(" in sync,
      "the only recovery must be the explicit cursor repair (it clears one cursor, not the row)")
# 第三轮（2026-10-17）：**首次**读取失败也必须登记待办。只给"已在队列里"的待办退避时，
# 一条既无状态行、又无待办的迟到训练在 anchor 越过之后四条发现通道全关（永久不可发现）。
check("afterUnreadableFailure(" in export and "pageNewTodos[routeKey] = unreadable" in export,
      "a FIRST route read failure must register a persistent todo — without it a late workout "
      "with no state row has no discovery channel left once the anchor passes it")
check("manual: true" not in sync and "full || manual" not in sync,
      "the button/shortcut entry point must not turn incremental sync into history replay")
history_policy = body(cursor, "func needsHistoryRead(", "/// An additions-empty")
check("timeIntervalSince" not in history_policy and "force" not in history_policy
      and "historyReplayPhase != nil" in history_policy,
      "an established record cursor may only replay because an earlier replay was interrupted — "
      "neither elapsed time nor an explicit force may reset it")
check("previous == nil || decoded != nil else" in records,
      "a corrupt stored anchor must not silently trigger automatic history replay")
# 2026-10-16（WP-10）重锚点：校验从 `runningWorkouts` 移入 `exportArchive`（查询页改造），
# 变量随之为 `workoutAnchor` / `storedWorkoutAnchor`；不变量不变（损坏的存储锚必须显式报错，
# 不得静默重置成"全量从零重查"）。
check("guard workoutAnchor == nil || storedWorkoutAnchor != nil" in export,
      "a corrupt stored workout anchor must not silently reset the workout query")
check("guard hasWorkoutChange || !routeFiles.isEmpty" in export,
      "workout candidates without a change or GPX retry must not be exported")
check('"sourceIds": exportedWorkouts.map(workoutSyncId)' in export
      and "workoutCount: exportedWorkouts.count" in export,
      "the manifest and UI count must describe exported deltas, not rechecked workouts")
check("routeForceRescan" not in sync,
      "the full route rescan flag must be gone with the re-import entry; the only wake-up path "
      "left is a targeted retry (routeRetryWorkoutIDs)")
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

# B1（2026-10-16）：近期窗口 pass —— 三条硬形态（存在 / 有界+最新优先 / 命名常量）。
check("recentWindowReadAt" in cursor and "recentWindowReadAt" in export,
      "the recent-window watermark must exist in both the cursor and the export loop (B1)")
check("func recentSamples<T: HKSample>(" in export and "ascending: false" in export,
      "the window query must be bounded and newest-first (ascending order would revisit the oldest end)")
check("recentWindowLookback" in export and "recentWindowLimit" in export
      and "recentWindowOverlap" in export,
      "the window bounds must be named constants (drifting literals would hide a runaway window)")
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

# WP-12（O03）：删除余量守恒的接线判据。
check("pendingDeletions: DirectSyncPendingDeletions? = nil" not in sync,
      "markSuccess must NOT default pendingDeletions — a default silently covers a missed call site "
      "(R3b missed two resume branches), and every call site must state its three-state intent")
check("pendingDeletions: try? JSONEncoder().encode(exported.pendingDeletions)" in sync,
      "the export round must encode an EMPTY payload too (explicit empty = clear the slot; "
      "only a legacy task's missing key means 'do not touch')")
check(sync.count("try Self.restoredCommitDeletions(from: restored)") == 5,
      "all five resume/commit branches must go through the single restore entry "
      "(nil = keep / empty = clear / corrupted = fail loudly)")
check("case .corrupted:" in sync,
      "the corrupted branch must exist — folding it into 'empty' would advance the anchor and lose the backlog")

# O01（WP-10）：页循环的推进/收缩/删除池接线判据。
check(export.count("deliveredAnchor = page.next") == 2,
      "deliveredAnchor may only advance in exactly two places — a fully delivered page and a "
      "drained stream; anywhere else the anchor would skip undelivered workouts")
check("WorkoutPageShrink.nextLimit(after: pageLimit)" in export
      and "workoutStop = .workoutBytes" in export,
      "a rejected workout page must shrink via WorkoutPageShrink and end in the visible-blocked stop")
check("freshWorkoutIdSet.insert(object.uuid.uuidString)" in export,
      "workout deletions must be de-duplicated into the page-scoped pool "
      "(shrinking re-queries the same page and re-returns the same deletedObjects)")

# O05（WP-13）：窗口条件化 + 独立份额 + 截断可观测的接线判据。
# 🔴 这条必须两条腿一起钉（首版只数调用次数，突变实测暴露了盲区：把 `guard` 换成
# `_ = needsRecentWindow` 后调用仍在、计数不变 ⇒ 条件化已被旁路而门禁全绿）。
check(export.count("needsHistoryRead()") == 2,
      "the recent-window pass must be gated on the production backlog judgement "
      "(needsHistoryRead) — the usual two call sites are the window pass and the anchored "
      "stream; otherwise the window re-reads every batch in steady state")
check("guard needsRecentWindow else { continue }" in export,
      "the backlog judgement must actually GATE the window pass (computing it and discarding "
      "it wires nothing — the window would run every batch again)")
check("recentWindowShare(of: budget)" in export,
      "the window pass must use its own 20% share — sharing the whole batch budget "
      "lets the window starve the anchored stream")
check("recent.count >= Self.recentWindowLimit" in export,
      "a window query that hits the per-type limit must say so (warnings), not pass silently")

# O02/WP-11：待办路线队列的落盘与接线判据。
check("CREATE TABLE IF NOT EXISTS sync_pending_routes" in store
      and "func upsertPendingRoutes(" in store and "func loadPendingRoutes(" in store
      and "func removePendingRoutes(" in store,
      "the pending-routes queue must exist in the journal with its upsert/load/remove trio (O02)")
# 2026-10-17：第三条 page-scoped 登记通道 = **首次读取失败**（`.routeUnreadable`）。
# 它必须与页交付同进同退（页被拒时下一批从同一 anchor 重查，不会把一次失败计成两次）。
check(export.count("pageNewTodos[routeKey] =") == 3,
      "exactly three page-level paths may enqueue a todo: the pre-fetch budget gate, the "
      "mid-write exhaustion (both routeBudget) and a FIRST read failure (routeUnreadable) — "
      "R07 registers the full-budget oversized route as a persistent size block instead")
check("RouteTodoScheduler.executable(" in export and "executableTodoIDs" in export
      and "Set(rediscovery).union(executableTodoIDs)" in export
      and "RouteTodoScheduler.afterUnreadableFailure(" in export
      and "RouteTodoScheduler.afterOversized(" in export,
      "R07: the export loop must consume the todo scheduler — only the executable subset enters "
      "discovery/query (blocked-size and unexpired retry-wait never re-read the same GPX), and "
      "attempt outcomes must book bounded retry / size-block state")
check("upsertPendingRoutes(exported.pendingRouteTodos" in sync,
      "the export round must register new todos BEFORE the task row persists the advanced anchor "
      "(register-after-anchor would lose the uuids forever — they have no state row)")
check("settlePendingRouteCommit()" in sync
      and "removePendingTodos: settlement.removals" in sync
      and "RouteCommitSettlement.settle(" in sync,
      "delivered todos must be removed in the SAME local transaction as the route-state flush "
      "(upsertRouteStates(removePendingTodos:)), and only after the durable commit — an earlier or "
      "non-atomic removal would drop the only discovery path for stateless uuids if the state "
      "flush fails or the payload is never accepted (R03). B01: the removal set is derived from "
      "the persisted candidate (observation + uuid), never from a bare uuid")

# --- 判据总数的下限（**必须放在全部判据之后**） ---------------------------------
# 照 `check-background-capabilities.py`：`check()` 的参数在调用前求值，所以这里读到的
# `checks` 还不含这条地板本身 ⇒ 地板 = 印制总数 − 1。**零容忍**：删掉任意一条判据
# （或把它挪进走不到的分支）都会让它变红。
# 2026-10-16（R3b）：新增删除暂存/截断判据后实测打印 52 ⇒ 按同一纪律重设为 51。
# 2026-10-16（B1）：新增窗口 pass 三条判据后实测打印 55 ⇒ 重设为 54。
# 2026-10-16（WP-12/O03）：新增删除守恒四条判据后实测打印 59 ⇒ 重设为 58。
# 2026-10-16（WP-10/O01）：新增页循环三条判据后实测打印 62 ⇒ 重设为 61。
# 2026-10-16（WP-13/O05）：新增窗口三条判据后实测打印 65 ⇒ 重设为 64。
# 2026-10-16（WP-11/O02）：新增待办队列四条判据后实测打印 70 ⇒ 重设为 69。
# 2026-10-16（R03/R04/R07）：R03 原子结算改写一条 + R07 调度接线新增一条后实测打印 71 ⇒ 重设为 70。
MIN_CHECKS = 70
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
