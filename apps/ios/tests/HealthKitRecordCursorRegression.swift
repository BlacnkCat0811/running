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
        check(!cursor.needsHistoryRead(now: now, force: false), "normal sync uses the type anchor")
        check(cursor.needsHistoryRead(now: now, force: true), "explicit full import replays newly authorized history")
        check(!cursor.needsHistoryRead(now: now.addingTimeInterval(7 * 86400 - 1), force: false),
              "a week minus a second is not a replay")
        for days in [7, 30, 365, 3650] {
            check(!cursor.needsHistoryRead(now: now.addingTimeInterval(Double(days) * 86400), force: false),
                  "automatic sync must remain incremental even after \(days) days")
        }
        check(cursor.needsHistoryRead(now: now.addingTimeInterval(365 * 86400), force: true),
              "explicit full import remains available after a long idle period")
        // 中断记账（S2.1）：带 phase 的游标在 force=false 时也要求续做重放；没有 phase 的保持增量。
        let replaying = HealthKitRecordCursor(anchor: Data([9]), historyReadAt: now, historyReplayPhase: .history)
        check(replaying.needsHistoryRead(now: now, force: false),
              "an interrupted history replay must resume without a new force")
        check(!HealthKitRecordCursor(anchor: Data([9]), historyReadAt: now).needsHistoryRead(now: now, force: false),
              "a cursor without a replay phase stays incremental")
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

        print("HealthKit record cursor regression: \(checks) checks passed")
    }
}
