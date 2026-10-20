import Foundation

@main
struct HealthKitRecordCursorRegression {
    static func main() async throws {
        var checks = 0
        func check(_ condition: Bool, _ message: String) {
            precondition(condition, message)
            checks += 1
        }

        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let cursor = HealthKitRecordCursor(anchor: Data([1, 2, 3]), historyReadAt: now)
        // 🔴 2026-10-17：`needsHistoryRead()` 已经没有时间参数、也没有 `force` 通道 ——
        // 「重新导入全部」被删除，重放只能由"上轮被预算截断"触发。时间流逝从来不是理由。
        check(!cursor.needsHistoryRead(), "normal sync uses the type anchor")
        check(!cursor.needsHistoryRead(), "an uninterrupted cursor never replays")
        // 中断记账（S2.1）：带 phase 的游标要求续做重放；没有 phase 的保持增量。
        let replaying = HealthKitRecordCursor(anchor: Data([9]), historyReadAt: now, historyReplayPhase: .history)
        check(replaying.needsHistoryRead(), "an interrupted history replay must resume")
        check(!HealthKitRecordCursor(anchor: Data([9]), historyReadAt: now).needsHistoryRead(),
              "a cursor without a replay phase stays incremental")
        // B2（2026-10-19 复核）：游标更新集中化 —— 三条更新路径以**所有字段非默认**的
        // 游标为输入，逐字段验证"只有预期字段变化"（漏带任一旁路字段的旧缺陷就是从这里来的）。
        let fullyPopulated = HealthKitRecordCursor(
            anchor: Data([1, 2, 3]),
            historyReadAt: now.addingTimeInterval(-10),
            historyReplayPhase: .history,
            recentWindowReadAt: now.addingTimeInterval(-20),
            lateBackfillAt: now.addingTimeInterval(-30),
            lateBackfillBefore: now.addingTimeInterval(-40),
            lateBackfillWindowStart: now.addingTimeInterval(-50),
            historyCoverageFloor: now.addingTimeInterval(-60)
        )
        let recentOnly = fullyPopulated.settingRecentWindowReadAt(now)
        check(recentOnly.recentWindowReadAt == now
              && recentOnly.anchor == fullyPopulated.anchor
              && recentOnly.historyReadAt == fullyPopulated.historyReadAt
              && recentOnly.historyReplayPhase == fullyPopulated.historyReplayPhase
              && recentOnly.lateBackfillAt == fullyPopulated.lateBackfillAt
              && recentOnly.lateBackfillBefore == fullyPopulated.lateBackfillBefore
              && recentOnly.lateBackfillWindowStart == fullyPopulated.lateBackfillWindowStart
              && recentOnly.historyCoverageFloor == fullyPopulated.historyCoverageFloor,
              "recentWindowReadAt update preserves every other channel")
        let lateOnly = fullyPopulated.settingLateBackfill(
            at: now, before: nil, windowStart: now.addingTimeInterval(-70))
        check(lateOnly.lateBackfillAt == now
              && lateOnly.lateBackfillBefore == nil
              && lateOnly.lateBackfillWindowStart == now.addingTimeInterval(-70)
              && lateOnly.anchor == fullyPopulated.anchor
              && lateOnly.historyReadAt == fullyPopulated.historyReadAt
              && lateOnly.recentWindowReadAt == fullyPopulated.recentWindowReadAt
              && lateOnly.historyCoverageFloor == fullyPopulated.historyCoverageFloor,
              "late-backfill pagination update preserves anchor/history/window channels")
        let advanced = fullyPopulated.advancingAnchor(
            anchor: Data([4, 5]), historyReadAt: now,
            historyReplayPhase: nil, historyCoverageFloor: nil)
        check(advanced.anchor == Data([4, 5]) && advanced.historyReadAt == now
              && advanced.historyReplayPhase == nil && advanced.historyCoverageFloor == nil
              && advanced.recentWindowReadAt == fullyPopulated.recentWindowReadAt
              && advanced.lateBackfillAt == fullyPopulated.lateBackfillAt
              && advanced.lateBackfillBefore == fullyPopulated.lateBackfillBefore
              && advanced.lateBackfillWindowStart == fullyPopulated.lateBackfillWindowStart,
              "anchor advance preserves every side-channel cursor field")
        let established = HealthKitRecordCursor.established(
            anchor: Data([6]), historyReadAt: now, historyReplayPhase: nil,
            historyCoverageFloor: nil)
        check(established.recentWindowReadAt == nil && established.lateBackfillAt == nil
              && established.lateBackfillBefore == nil && established.lateBackfillWindowStart == nil,
              "a first cursor explicitly initializes side channels to nil (no inherited value)")
        let cursors = ["sleep": cursor, "hrv": cursor, "steps": replaying]
        let decoded = try JSONDecoder().decode([String: HealthKitRecordCursor].self,
                                               from: JSONEncoder().encode(cursors))
        check(decoded == cursors,
              "all per-type cursors (including the replay phase) survive pending-batch serialization")
        // 老 payload（没有 `historyReplayPhase` 键）必须仍能解开 —— 向后兼容的硬要求。
        // `"AQID"` = base64([1,2,3])；`historyReadAt: 0` = deferredToDate 的 2001-01-01。
        let legacy = Data(#"{"anchor":"AQID","historyReadAt":0}"#.utf8)
        let legacyCursor = try JSONDecoder().decode(HealthKitRecordCursor.self, from: legacy)
        check(legacyCursor.historyReplayPhase == nil, "a legacy payload decodes with no replay phase")
        // B1（2026-10-16）：窗口记账字段的**两条兼容 + 一条往返**。
        // 老 payload（连 `recentWindowReadAt` 都没有）必须解出 nil —— 语义是"没记过 ⇒
        // 下批从完整 48h 窗重扫一次"（服务端按 UUID 幂等），不是"该类型没有近期数据"。
        check(legacyCursor.recentWindowReadAt == nil,
              "a legacy payload decodes with no recent-window bookkeeping")
        let windowed = HealthKitRecordCursor(
            anchor: Data([9]), historyReadAt: now,
            historyReplayPhase: nil, recentWindowReadAt: now.addingTimeInterval(-3600)
        )
        let windowedRound = try JSONDecoder().decode(
            HealthKitRecordCursor.self, from: JSONEncoder().encode(windowed)
        )
        check(windowedRound == windowed,
              "the recent-window watermark survives pending-batch serialization")
        check(windowedRound.recentWindowReadAt == now.addingTimeInterval(-3600),
              "the recent-window watermark keeps its exact value (not truncated)")

        // 2026-10-17：跑步动态「迟到样本」补读记账的兼容 + 往返 + 判据。
        // 背景：10-14 的跑步在 10-16 用 48h 窗口查时样本还没到手机，窗口随后越过那天 ⇒
        // 服务端永远缺这两类。补读就是为"晚到的样本"留的一条按日期通道。
        check(legacyCursor.lateBackfillAt == nil,
              "a legacy payload decodes with no late-backfill bookkeeping")
        let backfilled = HealthKitRecordCursor(
            anchor: Data([9]), historyReadAt: now,
            historyReplayPhase: nil, recentWindowReadAt: now,
            lateBackfillAt: now, lateBackfillBefore: now.addingTimeInterval(-7 * 24 * 3600)
        )
        let backfilledRound = try JSONDecoder().decode(
            HealthKitRecordCursor.self, from: JSONEncoder().encode(backfilled)
        )
        check(backfilledRound == backfilled,
              "the late-backfill bookkeeping survives pending-batch serialization")
        check(backfilledRound.lateBackfillAt == now && backfilledRound.lateBackfillBefore == now.addingTimeInterval(-7 * 24 * 3600),
              "the late-backfill bookkeeping keeps its exact values")
        // 触发判据：有游标 + （从没完成 或 完成已超过 retryInterval）。首装（无游标）不补。
        check(!LateDynamicsBackfill.needs(cursor: nil, now: now),
              "a first install does not run the backfill (history replay covers it)")
        check(LateDynamicsBackfill.needs(cursor: cursor, now: now),
              "an established cursor that has never backfilled runs it")
        check(!LateDynamicsBackfill.needs(cursor: backfilled, now: now),
              "a just-completed backfill does not run again")
        check(LateDynamicsBackfill.needs(
                cursor: backfilled,
                now: now.addingTimeInterval(LateDynamicsBackfill.retryInterval + 1)),
              "the backfill re-arms after retryInterval — a later permission grant or a new late arrival still has a channel")
        check(LateDynamicsBackfill.types == Set([
                "HKQuantityTypeIdentifierRunningPower",
                "HKQuantityTypeIdentifierRunningGroundContactTime",
                "HKQuantityTypeIdentifierRunningStrideLength",
                "HKQuantityTypeIdentifierRunningVerticalOscillation"
              ]),
              "the backfill covers exactly the running-dynamics family")
        check(LateDynamicsBackfill.lookback >= 7 * 24 * 3600,
              "the backfill lookback must comfortably exceed the 48h window it compensates for")
        // 一页之后的记账（纯逻辑 —— HealthKitExport 不进任何回归编译，所以结论必须在这里钉住）。
        let windowStart = now.addingTimeInterval(-LateDynamicsBackfill.lookback)
        let oldestInWindow = now.addingTimeInterval(-3 * 24 * 3600)
        check(LateDynamicsBackfill.pageOutcome(
                returned: LateDynamicsBackfill.limit, truncated: true,
                oldestSample: oldestInWindow, windowStart: windowStart, paging: false)
              == .nextPage(before: oldestInWindow),
              "a truncated page must page older — never mark the 14-day window complete")
        check(LateDynamicsBackfill.pageOutcome(
                returned: LateDynamicsBackfill.limit, truncated: true,
                oldestSample: windowStart, windowStart: windowStart, paging: true)
              == .completed,
              "paging stops at the window start (same-instant samples must not loop forever)")
        check(LateDynamicsBackfill.pageOutcome(
                returned: 0, truncated: false, oldestSample: nil,
                windowStart: windowStart, paging: false)
              == .retry,
              "an EMPTY first page must not mark the backfill done (unauthorized read / sample not yet on the phone)")
        check(LateDynamicsBackfill.pageOutcome(
                returned: 0, truncated: false, oldestSample: nil,
                windowStart: windowStart, paging: true)
              == .completed,
              "an empty continuation page means the older slice is covered")
        check(LateDynamicsBackfill.pageOutcome(
                returned: 12, truncated: false, oldestSample: oldestInWindow,
                windowStart: windowStart, paging: false)
              == .completed,
              "a page shorter than the limit means the whole window was read")
        // 窗口水位：**空窗不推进**（2026-10-17 修正）。旧行为把"此刻没数据"记成"这段已交付"，
        // 于是迟到样本永远失去被窗口覆盖的机会 —— 这正是 10-14 那次的放大机制。
        check(RecentWindowAccounting.nextMark(written: 0, now: now) == nil,
              "an EMPTY window must not advance the watermark (a late sample could still arrive)")
        check(RecentWindowAccounting.nextMark(written: 1, now: now) == now,
              "a window that actually delivered samples advances the watermark to now")

        // ── P3-22（2026-10-18）：补读分页的窗口下界必须**固定**，否则前缘漂移 ──
        // 缺陷形态：补读跨多批时旧实现每批用当时的 `now` 重算 `now − 14d`，读完最后一页时
        // 左下沿已经越过最初那段时间，而 `pageOutcome` 按 `oldestSample <= windowStart` 判
        // "整窗完成" ⇒ 那一小段从未读过却被记成已覆盖（只能等 30 天再补）。
        check(legacyCursor.lateBackfillWindowStart == nil,
              "a legacy payload decodes with no backfill window start (first page re-derives it)")
        let pagingCursor = HealthKitRecordCursor(
            anchor: Data([9]), historyReadAt: now, recentWindowReadAt: nil,
            lateBackfillAt: nil, lateBackfillBefore: now.addingTimeInterval(-2 * 24 * 3600),
            lateBackfillWindowStart: now.addingTimeInterval(-LateDynamicsBackfill.lookback)
        )
        let pagingRound = try JSONDecoder().decode(
            HealthKitRecordCursor.self, from: JSONEncoder().encode(pagingCursor)
        )
        check(pagingRound == pagingCursor && pagingRound.lateBackfillWindowStart == pagingCursor.lateBackfillWindowStart,
              "the fixed backfill window start survives pending-batch serialization")
        let firstPageStart = LateDynamicsBackfill.windowStart(cursor: cursor, now: now)
        check(firstPageStart == now.addingTimeInterval(-LateDynamicsBackfill.lookback),
              "the first page derives the window start from now − lookback")
        let secondBatchStart = LateDynamicsBackfill.windowStart(
            cursor: pagingCursor, now: now.addingTimeInterval(6 * 3600))
        check(secondBatchStart == firstPageStart,
              "later pages reuse the persisted window start — the leading edge must not drift with the batch clock")

        // 多批补读的覆盖并集：每批 `now` 前移 2h、每页读最新 3 天（模拟单类型上限截断），
        // 断言 (a) 一直读到固定下界才 `completed`；(b) 各批区间首尾相接、没有缝。
        var covered: [ClosedRange<Date>] = []
        var nextPagingCursor: HealthKitRecordCursor? = HealthKitRecordCursor(
            anchor: Data([1]), historyReadAt: now)
        var simulationBatches = 0
        while simulationBatches < 12 {
            let batchNow = now.addingTimeInterval(Double(simulationBatches) * 7_200)
            guard let current = nextPagingCursor,
                  LateDynamicsBackfill.needs(cursor: current, now: batchNow) else { break }
            let lower = LateDynamicsBackfill.windowStart(cursor: current, now: batchNow)
            let upper = current.lateBackfillBefore ?? batchNow
            let pageOldest = max(lower, upper.addingTimeInterval(-3 * 24 * 3600))
            covered.append(pageOldest...upper)
            switch LateDynamicsBackfill.pageOutcome(
                returned: LateDynamicsBackfill.limit, truncated: pageOldest > lower,
                oldestSample: pageOldest, windowStart: lower,
                paging: current.lateBackfillBefore != nil
            ) {
            case .completed:
                nextPagingCursor = HealthKitRecordCursor(
                    anchor: current.anchor, historyReadAt: current.historyReadAt,
                    lateBackfillAt: batchNow, lateBackfillBefore: nil,
                    lateBackfillWindowStart: nil)
            case .nextPage(let before):
                nextPagingCursor = HealthKitRecordCursor(
                    anchor: current.anchor, historyReadAt: current.historyReadAt,
                    lateBackfillAt: current.lateBackfillAt, lateBackfillBefore: before,
                    lateBackfillWindowStart: lower)
            case .retry:
                nextPagingCursor = nil
            }
            simulationBatches += 1
        }
        let fixedStart = now.addingTimeInterval(-LateDynamicsBackfill.lookback)
        check(covered.count == 5 && covered.last?.lowerBound == fixedStart,
              "multi-batch paging reaches the FIXED window start before marking the backfill complete")
        check(zip(covered, covered.dropFirst()).allSatisfy { $0.upperBound >= $1.lowerBound },
              "consecutive backfill batches abut each other — no unread gap in the middle")
        check(nextPagingCursor?.lateBackfillAt != nil && nextPagingCursor?.lateBackfillBefore == nil,
              "the completion bookkeeping clears the paging bound and the fixed window start")
        check(nextPagingCursor?.lateBackfillWindowStart == nil,
              "a completed backfill forgets its window start (the next run re-derives a fresh one)")

        // ── P3-24（2026-10-18）：稳态"该有却没有"只进诊断，不弹用户警告 ──
        check(LateDynamicsBackfill.steadyStateGapDiagnostics(writtenTypes: [
                "HKQuantityTypeIdentifierRunningSpeed",
                "HKQuantityTypeIdentifierRunningStrideLength"
              ]).count == 2,
              "a steady-state batch with power AND ground-contact missing reports both (siblings prove the run happened)")
        check(LateDynamicsBackfill.steadyStateGapDiagnostics(writtenTypes: [
                "HKQuantityTypeIdentifierRunningSpeed",
                "HKQuantityTypeIdentifierRunningPower",
                "HKQuantityTypeIdentifierRunningGroundContactTime"
              ]).isEmpty,
              "a batch that wrote both dynamics types reports no gap")
        check(LateDynamicsBackfill.steadyStateGapDiagnostics(writtenTypes: [
                "HKQuantityTypeIdentifierHeartRate",
                "HKQuantityTypeIdentifierStepCount"
              ]).isEmpty,
              "without any running-dynamics sibling there is nothing to report (no false permission alarm)")
        check(LateDynamicsBackfill.steadyStateGapDiagnostics(writtenTypes: [
                "HKQuantityTypeIdentifierRunningVerticalOscillation",
                "HKQuantityTypeIdentifierRunningPower"
              ]) == [
                "[RAI] 稳态同步缺口：本批写入了其它跑步动态但没有 HKQuantityTypeIdentifierRunningGroundContactTime"
                  + "（检查读取权限；若是预算/时序问题，下一次补读通道会再覆盖近 14 天）"
              ],
              "only the actually-missing type is reported, with a stable diagnostic text")

        // ── 读到底：每页（含 deletion-only 页）都被提交，锚点推进到最后 ──
        var drainedQueried: [Int?] = []
        var drainedCommitted: [String] = []
        let drained = try await HealthKitRecordCursor.drain(
            from: Optional<Int>.none,
            pageLimit: 1000,
            query: { anchor, _ in
                drainedQueried.append(anchor)
                switch anchor {
                case nil: return (added: ["historical-2010"], deleted: [String](), next: 1)
                case 1: return (added: [], deleted: ["old-sleep-uuid"], next: 2)
                case 2: return (added: ["late-2012"], deleted: [], next: 3)
                default: return (added: [], deleted: [], next: 4)
                }
            },
            render: { added, deleted -> [String] in added + deleted },
            decide: { _, _ in .accept },
            commit: { page, _ in drainedCommitted += page }
        )
        check(drained.anchor == 4 && drained.hasMorePages == false && drained.stoppedBeforePage == false,
              "every page including deletion-only pages is drained to a fresh anchor")
        check(drainedQueried == [nil, 1, 2, 3], "each page is queried exactly once when nothing is rejected")
        check(drainedCommitted == ["historical-2010", "old-sleep-uuid", "late-2012"],
              "historical dates never filter changes")

        // ── 写前判定（S2.5 核心）：整页放不下 ⇒ **零提交 + 锚点回退到页前** ──
        // 预算模型：只允许提交 `allowance` 条；用满后本页放不下 ⇒ `.retryWithLimit(1)`。
        var tightenQueried: [Int?] = []
        var tightenCommitted: [String] = []
        var remaining = 1
        let tightened = try await HealthKitRecordCursor.drain(
            from: Optional<Int>.none,
            pageLimit: 1000,
            query: { anchor, _ in
                tightenQueried.append(anchor)
                switch anchor {
                case nil: return (added: ["a"], deleted: [String](), next: 1)
                case 1: return (added: ["b"], deleted: [String](), next: 2)
                default: return (added: [], deleted: [], next: 3)
                }
            },
            render: { added, deleted -> [String] in added + deleted },
            decide: { page, _ in
                if page.count <= remaining { return .accept }
                return .retryWithLimit(1)
            },
            commit: { page, _ in
                tightenCommitted += page
                remaining -= page.count
            }
        )
        check(tightenCommitted == ["a"], "a page that does not fit is never partially committed")
        check(tightened.anchor == 1 && tightened.hasMorePages == true && tightened.stoppedBeforePage == true,
              "rejecting the page rolls the anchor back to the page start (anchor == 1, not 2)")
        check(tightenQueried == [nil, 1, 1],
              "the rejected page is re-queried from the same anchor (once at the full limit, once shrunk), never skipped")

        // 下一批：预算重新给满额 ⇒ 同一页现在装得下，锚点推进到该页 next（不丢页、不重复）。
        var nextBatchCommitted: [String] = []
        let nextBatch = try await HealthKitRecordCursor.drain(
            from: Optional<Int>.some(1),
            pageLimit: 1000,
            query: { anchor, _ in
                switch anchor {
                case 1: return (added: ["b"], deleted: [String](), next: 2)
                default: return (added: [], deleted: [], next: 3)
                }
            },
            render: { added, deleted -> [String] in added + deleted },
            decide: { _, _ in .accept },
            commit: { page, _ in nextBatchCommitted += page }
        )
        check(nextBatchCommitted == ["b"] && nextBatch.anchor == 3 && nextBatch.hasMorePages == false,
              "the page deferred to the next batch is read exactly once, with no loss and no duplicate")

        // ── 收缩路径：本页只有在更小的 limit 下才装得下 ──
        // 判据：a) 用更小的 limit **重查同一锚点**；b) 载荷真的变小；c) 提交后锚点按该页推进。
        // 🔴 fixture 契约：**被 `.accept` 的页必须返回一个推进了的锚点**（`next != 当前锚点`），
        // 否则 `drain` 会 accept → `limit` 复位到满页 → 用同一锚点重查 → 再 accept……
        // `while true` **永不退出**（本回归第一版就是 `next` 恒为 1，实测挂死 3 分钟）。
        // 生产侧不受此约束影响：`HKAnchoredObjectQuery` 给出非空页时必然给出新锚点。
        // 所以这里 `next` 一律取 41（≠ 起点 nil），并靠"越过目标页后给空页"收尾。
        var shrinkLimits: [Int] = []          // 只记"在目标页上试过的 limit"，收尾用的空页不计
        var shrinkCommitted: [[Int]] = []
        let shrunk = try await HealthKitRecordCursor.drain(
            from: Optional<Int>.none,
            pageLimit: 1000,
            query: { anchor, limit in
                guard anchor == nil else { return (added: [Int](), deleted: [Int](), next: 41) }
                shrinkLimits.append(limit)
                return (added: Array(1...limit), deleted: [Int](), next: 41)
            },
            render: { added, _ -> [Int] in added },
            decide: { page, _ in page.count <= 2 ? .accept : .retryWithLimit(2) },
            commit: { page, _ in shrinkCommitted.append(page) }
        )
        check(shrinkLimits == [1000, 2], "an oversized page is re-queried with the shrunk limit from the same anchor")
        check(shrinkCommitted == [[1, 2]] && shrunk.anchor == 41,
              "the shrunk page is committed whole and the anchor follows that page's next")

        // ── 退化：连 1 条都放不进 ⇒ 页首收手（零提交），且**绝不无限查询** ──
        // decide 恒拒绝、请求的 limit 又大于当前值 ⇒ 必须严格下降收敛。
        var degenerateLimits: [Int] = []
        var degenerateCommits = 0
        let degenerate = try await HealthKitRecordCursor.drain(
            from: Optional<Int>.some(7),
            pageLimit: 1000,
            query: { _, limit in
                degenerateLimits.append(limit)
                return (added: Array(1...limit), deleted: [Int](), next: 99)
            },
            render: { added, _ -> [Int] in added },
            decide: { _, _ in .retryWithLimit(1000) },
            commit: { _, _ in degenerateCommits += 1 }
        )
        check(degenerateCommits == 0 && degenerate.anchor == 7 && degenerate.stoppedBeforePage == true,
              "a permanently exhausted budget stops before the page with nothing committed and no anchor move")
        check(degenerateLimits.count <= 12 && degenerateLimits == degenerateLimits.sorted(by: >),
              "the retry limit strictly decreases, so the shrink path terminates (no deadlock)")

        // ── 段计划状态机（S2.1 的"双段重放 × 预算截断"交互 —— R-03 风险的两面）──
        check(RecordReplayPlan.segments(decodedAvailable: true, history: false, resumingHistoryPhase: false) == [.incremental],
              "ordinary sync plans a single incremental segment")
        check(RecordReplayPlan.segments(decodedAvailable: true, history: true, resumingHistoryPhase: false) == [.incremental, .historyFromScratch],
              "a fresh replay drains the old cursor first, then reads history from scratch")
        check(RecordReplayPlan.segments(decodedAvailable: true, history: true, resumingHistoryPhase: true) == [.historyResume],
              "resuming an interrupted history replay must not rerun the incremental segment")
        check(RecordReplayPlan.segments(decodedAvailable: false, history: true, resumingHistoryPhase: false) == [.historyFromScratch],
              "a first read (or a corrupt anchor) reads history from scratch")
        check(RecordReplayPlan.interruptedPhase(segments: [.incremental, .historyFromScratch], interruptedIndex: 0) == .incremental,
              "an interruption inside the incremental segment records .incremental")
        check(RecordReplayPlan.interruptedPhase(segments: [.incremental, .historyFromScratch], interruptedIndex: 1) == .history,
              "an interruption inside the history segment records .history")
        check(RecordReplayPlan.interruptedPhase(segments: [.historyResume], interruptedIndex: 0) == .history,
              "an interruption while resuming history records .history")
        check(RecordReplayPlan.interruptedPhase(segments: [.incremental], interruptedIndex: 0) == nil,
              "a truncated ordinary increment must NOT record a replay phase (it would trigger a full replay)")

        // ── 失败必须冒泡（不能返回一个"前进过的"游标）──
        enum Failure: Error { case fixture }
        var returned: (anchor: Int?, hasMorePages: Bool, stoppedBeforePage: Bool)?
        do {
            returned = try await HealthKitRecordCursor.drain(
                from: Optional(10),
                pageLimit: 1000,
                query: { anchor, _ in
                    if anchor == 10 { return (added: [1], deleted: [Int](), next: 11) }
                    throw Failure.fixture
                },
                render: { added, _ -> [Int] in added },
                decide: { _, _ in .accept },
                commit: { _, _ in }
            )
            preconditionFailure("a failed page must fail the export")
        } catch Failure.fixture {}
        check(returned == nil, "partial failure cannot return an advanced cursor")

        // ── P1-1（2026-10-18 同步诊断）：服务端覆盖探测的纯逻辑 ──────────────────────
        // 缺陷形态：本地游标丢失后从 nil 重放全部历史并重传。生产实测 43 批/19.25 万条只新增
        // 8,117 条（≈95.8% 重复）。判据：服务端说"已覆盖到 knownUntil"时，历史段查询起点
        // 抬到 `knownUntil − 24h`；不知道/太空/太旧/老服务端一律回落全量重放。
        check(legacyCursor.historyCoverageFloor == nil,
              "a legacy payload decodes with no coverage floor (next replay stays full history)")
        let floored = HealthKitRecordCursor(
            anchor: Data([7]), historyReadAt: now,
            historyReplayPhase: .history,
            historyCoverageFloor: now.addingTimeInterval(-3 * 24 * 3600)
        )
        let flooredRound = try JSONDecoder().decode(
            HealthKitRecordCursor.self, from: JSONEncoder().encode(floored)
        )
        check(flooredRound == floored,
              "the coverage floor survives pending-batch serialization (resume needs the same predicate)")
        // 🔴 Lead 复核修正：覆盖下界"粘住"——历史段跑完（`historyReplayPhase == nil`）之后也
        // 保留，该类型后续增量查询继续带同一个谓词。清空它会拿旧锚点去跑 predicate:nil，
        // 而 HKQueryAnchor 与 predicate 的绑定关系 Apple 没有承诺可换。
        let stickyFloor = now.addingTimeInterval(-3 * 24 * 3600)
        let sticky = HealthKitRecordCursor(
            anchor: Data([7]), historyReadAt: now,
            historyReplayPhase: nil, historyCoverageFloor: stickyFloor
        )
        let stickyRound = try JSONDecoder().decode(
            HealthKitRecordCursor.self, from: JSONEncoder().encode(sticky)
        )
        check(stickyRound == sticky && stickyRound.historyCoverageFloor == stickyFloor,
              "a completed replay keeps its coverage floor (the predicate must stick for incremental queries)")

        // parseTimestamp：服务端可能给带毫秒的 ISO8601，也可能给整秒。
        check(SyncCoveragePolicy.parseTimestamp("2026-10-18T12:28:46Z") ==
              Date(timeIntervalSince1970: 1_792_326_526),
              "an ISO8601 timestamp without fractional seconds parses")
        check(SyncCoveragePolicy.parseTimestamp("2026-10-18T12:28:46.000Z") != nil,
              "an ISO8601 timestamp with fractional seconds parses")
        check(SyncCoveragePolicy.parseTimestamp(nil) == nil
              && SyncCoveragePolicy.parseTimestamp("") == nil
              && SyncCoveragePolicy.parseTimestamp("not-a-time") == nil,
              "missing/garbage coverage timestamps are 'unknown' (never a date)")
        check(SyncCoveragePolicy.parseTimestamp("2026-10-18T12:28:46Z") ==
              SyncCoveragePolicy.parseTimestamp("2026-10-18T12:28:46.000Z"),
              "both ISO8601 shapes agree on the same instant")

        // needsCoverageQuery：只有"确实要重放"的类型才值得一次覆盖探测。
        let incrementalCursor = HealthKitRecordCursor(anchor: Data([2]), historyReadAt: now)
        check(SyncCoveragePolicy.needsCoverageQuery(
                cursors: [:],
                types: ["HKQuantityTypeIdentifierHeartRate"],
                allowSkip: true),
              "no cursor at all means 'needs a coverage query' when history skipping is enabled")
        check(SyncCoveragePolicy.needsCoverageQuery(
                cursors: ["HKQuantityTypeIdentifierHeartRate": replaying],
                types: ["HKQuantityTypeIdentifierHeartRate"],
                allowSkip: true),
              "an interrupted history replay still asks for coverage when skipping is enabled")
        check(!SyncCoveragePolicy.needsCoverageQuery(
                cursors: ["HKQuantityTypeIdentifierHeartRate": incrementalCursor],
                types: ["HKQuantityTypeIdentifierHeartRate"],
                allowSkip: true),
              "steady-state incremental sync does not spend a coverage request")
        check(!SyncCoveragePolicy.needsCoverageQuery(cursors: [:], types: []),
              "an empty type list needs no request")
        // R6/A3：默认（生产）开关关闭 ⇒ 连缺游标/历史续读都不发覆盖请求。
        check(!SyncCoveragePolicy.needsCoverageQuery(
                cursors: [:],
                types: ["HKQuantityTypeIdentifierHeartRate"]),
              "with history skipping disabled, a missing cursor must not trigger a coverage request")
        check(!SyncCoveragePolicy.needsCoverageQuery(
                cursors: ["HKQuantityTypeIdentifierHeartRate": replaying],
                types: ["HKQuantityTypeIdentifierHeartRate"]),
              "with history skipping disabled, an interrupted replay must not trigger a coverage request")

        // historyFloor 的算术夹具：knownUntil − 24h；四种"不知道/不可用"一律 nil。
        let coverageNow = Date(timeIntervalSince1970: 1_792_326_526)  // 2026-10-18T12:28:46Z
        let freshCoverage: [String: SyncCoveragePolicy.TypeCoverage] = [
            "hr": .init(type: "hr", knownUntil: coverageNow.addingTimeInterval(-3_600), sampleCount: 1_000),
            "empty": .init(type: "empty", knownUntil: nil, sampleCount: 0),
            "old": .init(type: "old", knownUntil: coverageNow.addingTimeInterval(-120 * 24 * 3600), sampleCount: 10),
            "future": .init(type: "future", knownUntil: coverageNow.addingTimeInterval(3_600), sampleCount: 10),
            "unparsed": .init(type: "unparsed", knownUntil: nil, sampleCount: 10)
        ]

        // 🔴 A7 闸门（2026-10-19）：覆盖点只证明"服务端有这条样本"，证明不了区间连续。
        // 默认必须**不允许**跳过任何历史 —— 否则一条今日样本就能把该类型 90 天的历史永久跳过。
        check(SyncCoveragePolicy.allowsHistorySkip == false,
              "coverage points must not authorize skipping history until the server reports continuous segments")
        check(SyncCoveragePolicy.historyFloor(type: "hr", coverage: freshCoverage, now: coverageNow) == nil,
              "the gate is closed by default even for a fresh, dense coverage point")

        // 闸门打开时的算术（`allowSkip: true` 只给回归用；生产路径不传这个参数）。
        check(SyncCoveragePolicy.historyFloor(
                type: "hr", coverage: freshCoverage, now: coverageNow, allowSkip: true) ==
              coverageNow.addingTimeInterval(-3_600 - 24 * 3600),
              "a fresh coverage point yields knownUntil − 24h (the 24h overlap protects the edge)")
        check(SyncCoveragePolicy.historyFloor(
                type: "missing", coverage: freshCoverage, now: coverageNow, allowSkip: true) == nil,
              "a type the server did not report keeps the old full-history replay")
        check(SyncCoveragePolicy.historyFloor(
                type: "empty", coverage: freshCoverage, now: coverageNow, allowSkip: true) == nil,
              "sampleCount == 0 means 'the server has nothing' ⇒ never skip that history")
        check(SyncCoveragePolicy.historyFloor(
                type: "old", coverage: freshCoverage, now: coverageNow, allowSkip: true) == nil,
              "a coverage point older than 90 days is not worth skipping history for")
        check(SyncCoveragePolicy.historyFloor(
                type: "unparsed", coverage: freshCoverage, now: coverageNow, allowSkip: true) == nil,
              "an unparsable knownUntil falls back to full replay (fail open)")
        let clamped = SyncCoveragePolicy.historyFloor(
            type: "future", coverage: freshCoverage, now: coverageNow, allowSkip: true)
        check(clamped == coverageNow.addingTimeInterval(-24 * 3600),
              "a coverage point slightly in the future is clamped to now before subtracting the overlap")
        check(SyncCoveragePolicy.historyFloor(
                type: "hr", coverage: [:], now: coverageNow, allowSkip: true) == nil,
              "an empty coverage table (old server / failed probe) is the full-replay fallback")

        // shouldRestartHistory：只把"旧的、没有下界的续读"换成带下界的新重放。
        check(SyncCoveragePolicy.shouldRestartHistory(cursor: replaying, floor: clamped),
              "a legacy replay without a stored floor is restarted with the coverage floor")
        check(!SyncCoveragePolicy.shouldRestartHistory(cursor: replaying, floor: nil),
              "without a coverage floor there is nothing to restart for")
        check(!SyncCoveragePolicy.shouldRestartHistory(cursor: incrementalCursor, floor: clamped),
              "a steady incremental cursor is never restarted by coverage")
        check(!SyncCoveragePolicy.shouldRestartHistory(
                cursor: HealthKitRecordCursor(
                    anchor: Data([8]), historyReadAt: now, historyReplayPhase: .history,
                    historyCoverageFloor: now.addingTimeInterval(-3_600)),
                floor: clamped),
              "a replay that already carries a floor resumes (restarting would loop at the page head)")

        // R6（2026-10-19 复核）：开关关闭时仍带 floor 的游标 = 来源不可信，必须逐类型
        // **从 nil 重放一次**清除它（不能只丢 floor 复用旧 anchor，也不能清空其它游标）。
        let floorCursor = HealthKitRecordCursor(
            anchor: Data([7]), historyReadAt: now,
            recentWindowReadAt: now.addingTimeInterval(-60),
            lateBackfillAt: now.addingTimeInterval(-120),
            historyCoverageFloor: now.addingTimeInterval(-3_600)
        )
        check(SyncCoveragePolicy.hasDisabledCoverageFloor(floorCursor),
              "a stored coverage floor is reported when the skip gate is closed")
        check(!SyncCoveragePolicy.hasDisabledCoverageFloor(cursor),
              "a normal cursor without a floor is not a repair candidate")
        check(!SyncCoveragePolicy.hasDisabledCoverageFloor(nil),
              "a missing cursor is not a repair candidate")
        // 修复轮把 decodedAnchor 置 nil（见 HealthKitExport）⇒ 段计划只能是从头重放，
        // 不能是 `.historyResume`（那会带着旧谓词建出来的锚点继续读）。
        check(RecordReplayPlan.segments(
                decodedAvailable: false, history: true, resumingHistoryPhase: false)
              == [.historyFromScratch],
              "the disabled-floor repair replays the type from nil, never resumes the old anchor")
        check(RecordReplayPlan.segments(
                decodedAvailable: false, history: true, resumingHistoryPhase: true)
              == [.historyFromScratch],
              "an interrupted repair also restarts from nil instead of resuming a filtered anchor")

        // RecordReplayPlan × coverageRestart：旧续读重启 vs 带下界续读续段。
        // RecordReplayPlan × coverageRestart：旧续读重启 vs 带下界续读续段。
        check(RecordReplayPlan.segments(
                decodedAvailable: true, history: true, resumingHistoryPhase: true,
                coverageRestart: true) == [.historyFromScratch],
              "an interrupted legacy replay restarts history from nil once coverage is known")
        check(RecordReplayPlan.segments(
                decodedAvailable: true, history: true, resumingHistoryPhase: true,
                coverageRestart: false) == [.historyResume],
              "an interrupted replay that already has a floor resumes the same segment")
        check(RecordReplayPlan.segments(
                decodedAvailable: true, history: true, resumingHistoryPhase: false,
                coverageRestart: true) == [.incremental, .historyFromScratch],
              "a fresh replay still drains the old cursor first (deletions) before the floored history")
        check(RecordReplayPlan.segments(
                decodedAvailable: true, history: false, resumingHistoryPhase: false,
                coverageRestart: true) == [.incremental],
              "coverage never touches a steady incremental segment")

        print("HealthKit record cursor regression: \(checks) checks passed")
    }
}
