import Foundation

@main
struct HealthKitRecordCursorRegression {
    static func main() async throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let cursor = HealthKitRecordCursor(anchor: Data([1, 2, 3]), historyReadAt: now)
        precondition(!cursor.needsHistoryRead(now: now, force: false), "normal sync uses the type anchor")
        precondition(cursor.needsHistoryRead(now: now, force: true), "explicit full import replays newly authorized history")
        precondition(!cursor.needsHistoryRead(now: now.addingTimeInterval(7 * 86400 - 1), force: false))
        for days in [7, 30, 365, 3650] {
            precondition(!cursor.needsHistoryRead(now: now.addingTimeInterval(Double(days) * 86400), force: false),
                         "automatic sync must remain incremental even after \(days) days")
        }
        precondition(cursor.needsHistoryRead(now: now.addingTimeInterval(365 * 86400), force: true),
                     "explicit full import remains available after a long idle period")
        // 中断记账（S2.1）：带 phase 的游标在 force=false 时也要求续做重放；没有 phase 的保持增量。
        let replaying = HealthKitRecordCursor(anchor: Data([9]), historyReadAt: now, historyReplayPhase: .history)
        precondition(replaying.needsHistoryRead(now: now, force: false),
                     "an interrupted history replay must resume without a new force")
        precondition(!HealthKitRecordCursor(anchor: Data([9]), historyReadAt: now).needsHistoryRead(now: now, force: false),
                     "a cursor without a replay phase stays incremental")
        let cursors = ["sleep": cursor, "hrv": cursor, "steps": replaying]
        let decoded = try JSONDecoder().decode([String: HealthKitRecordCursor].self,
                                               from: JSONEncoder().encode(cursors))
        precondition(decoded == cursors,
                     "all per-type cursors (including the replay phase) survive pending-batch serialization")
        // 老 payload（没有 `historyReplayPhase` 键）必须仍能解开 —— 向后兼容的硬要求。
        // `"AQID"` = base64([1,2,3])；`historyReadAt: 0` = deferredToDate 的 2001-01-01。
        let legacy = Data(#"{"anchor":"AQID","historyReadAt":0}"#.utf8)
        let legacyCursor = try JSONDecoder().decode(HealthKitRecordCursor.self, from: legacy)
        precondition(legacyCursor.historyReplayPhase == nil, "a legacy payload decodes with no replay phase")
        var queried: [Int?] = []
        var observed: [String] = []
        let outcome = try await HealthKitRecordCursor.drain(from: Optional<Int>.none, query: { anchor in
            queried.append(anchor)
            switch anchor {
            case nil: return (added: ["historical-2010"], deleted: [String](), next: 1)
            case 1: return (added: [], deleted: ["old-sleep-uuid"], next: 2)
            case 2: return (added: ["late-2012"], deleted: [], next: 3)
            default: return (added: [], deleted: [], next: 4)
            }
        }, consume: { observed += $0 + $1 })
        precondition(outcome.anchor == 4 && outcome.hasMorePages == false && queried == [nil, 1, 2, 3],
                     "every page including deletion-only pages is drained")
        precondition(observed == ["historical-2010", "old-sleep-uuid", "late-2012"], "historical dates never filter changes")

        // 页边界预算停止（S2.1 的核心判据）：
        // 预算在第 2 页（deletion-only 页）末尾耗尽 ⇒ **停在页末尾**：anchor == 该页 next == 2、
        // hasMorePages == true。反例断言在这里：跳过页（anchor==3）会丢页 3 的数据；
        // 停在页首（anchor==1）会让下一轮重读同一页 —— 预算不变就永远停在同一处（死循环）。
        var budgetQueried: [Int?] = []
        var budgetConsumed: [String] = []
        var checks = 0
        let stopped = try await HealthKitRecordCursor.drain(from: Optional<Int>.none, query: { anchor in
            budgetQueried.append(anchor)
            switch anchor {
            case nil: return (added: ["p1"], deleted: [String](), next: 1)
            case 1: return (added: [], deleted: ["d2"], next: 2)
            case 2: return (added: ["p3"], deleted: [], next: 3)
            default: return (added: [], deleted: [], next: 4)
            }
        }, consume: { budgetConsumed += $0 + $1 }, shouldStop: {
            checks += 1
            return checks >= 2
        })
        precondition(stopped.anchor == 2 && stopped.hasMorePages == true,
                     "the budget must stop at the page boundary (anchor = that page's next)")
        precondition(budgetQueried == [nil, 1], "stopping consumes whole pages; no page is skipped or reread")
        precondition(budgetConsumed == ["p1", "d2"],
                     "a deletion-only page still counts as one full page (at least one page per round)")

        // 永远超预算的极端：每轮仍必须前进一页（绝不死循环）。
        var extremeQueried: [Int?] = []
        let extreme = try await HealthKitRecordCursor.drain(from: Optional<Int>.none, query: { anchor in
            extremeQueried.append(anchor)
            switch anchor {
            case nil: return (added: [1], deleted: [Int](), next: 1)
            default: return (added: [2], deleted: [Int](), next: 2)
            }
        }, consume: { _, _ in }, shouldStop: { true })
        precondition(extreme.anchor == 1 && extreme.hasMorePages == true && extremeQueried == [nil],
                     "even a permanently exhausted budget advances one page per round (no deadlock)")

        // 段计划状态机（S2.1 的"双段重放 × 预算截断"交互 —— R-03 风险的两面）：
        precondition(RecordReplayPlan.segments(decodedAvailable: true, history: false, resumingHistoryPhase: false) == [.incremental],
                     "ordinary sync plans a single incremental segment")
        precondition(RecordReplayPlan.segments(decodedAvailable: true, history: true, resumingHistoryPhase: false) == [.incremental, .historyFromScratch],
                     "a fresh replay drains the old cursor first, then reads history from scratch")
        precondition(RecordReplayPlan.segments(decodedAvailable: true, history: true, resumingHistoryPhase: true) == [.historyResume],
                     "resuming an interrupted history replay must not rerun the incremental segment")
        precondition(RecordReplayPlan.segments(decodedAvailable: false, history: true, resumingHistoryPhase: false) == [.historyFromScratch],
                     "a first read (or a corrupt anchor) reads history from scratch")
        precondition(RecordReplayPlan.interruptedPhase(segments: [.incremental, .historyFromScratch], interruptedIndex: 0) == .incremental,
                     "an interruption inside the incremental segment records .incremental")
        precondition(RecordReplayPlan.interruptedPhase(segments: [.incremental, .historyFromScratch], interruptedIndex: 1) == .history,
                     "an interruption inside the history segment records .history")
        precondition(RecordReplayPlan.interruptedPhase(segments: [.historyResume], interruptedIndex: 0) == .history,
                     "an interruption while resuming history records .history")
        precondition(RecordReplayPlan.interruptedPhase(segments: [.incremental], interruptedIndex: 0) == nil,
                     "a truncated ordinary increment must NOT record a replay phase (it would trigger a full replay)")

        enum Failure: Error { case fixture }
        var returned: (anchor: Int, hasMorePages: Bool)?
        do {
            returned = try await HealthKitRecordCursor.drain(from: Optional(10), query: { anchor in
                if anchor == 10 { return (added: [1], deleted: [Int](), next: 11) }
                throw Failure.fixture
            }, consume: { _, _ in })
            preconditionFailure("a failed page must fail the export")
        } catch Failure.fixture {}
        precondition(returned == nil, "partial failure cannot return an advanced cursor")
        print("HealthKit record cursor regression: 27 checks passed")
    }
}
