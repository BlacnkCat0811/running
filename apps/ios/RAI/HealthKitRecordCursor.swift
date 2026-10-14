import Foundation

/// Event time is not arrival time. Anchors have a fixed, unbounded predicate.
/// Only explicit full import replays history after newly granted read access.
/// Ordinary/automatic sync never resets an established cursor on a timer.
nonisolated struct HealthKitRecordCursor: Codable, Equatable, Sendable {
    /// 全量重放的**阶段标记**（观测阶段 2 / S2.1 起；老 payload 缺键 ⇒ `nil`）。
    ///
    /// 为什么需要它：全量重放是**两段**（先把旧游标的变更流 drain 掉——保住删除事件，
    /// 再从 `nil` 全量重读历史）。单批预算把重放切成多批之后，"我停在哪一段"必须在
    /// 跨批可持久的位置 —— 没有这个标记，第二批会把两段从头再排一遍（重复读），
    /// 或者把历史段整段跳过（丢重放语义）。
    nonisolated enum HistoryReplayPhase: String, Codable, Sendable {
        /// 增量段（旧游标 → 最新）进行中。
        case incremental
        /// 历史段（`nil` → 最新，全量重读）进行中。
        case history
    }

    let anchor: Data
    let historyReadAt: Date
    /// 见 `HistoryReplayPhase`。`nil` = 不在重放中（普通增量）。
    ///
    /// `var` + 默认值：memberwise init 因此带默认参数，既有构造点不必改；
    /// 合成的 `init(from:)` 对 Optional 用 `decodeIfPresent`，老 payload 缺键也安全
    /// （`historyReadAt` 的旧注释同源：保留键是为了向后兼容）。
    var historyReplayPhase: HistoryReplayPhase? = nil

    /// 下一次 drain 是否要先做**全量重放**。
    ///
    /// 判据 = 显式请求（`force`）**或**上次重放被预算截断还没做完（`historyReplayPhase != nil`）。
    /// 刻意不看"距今多久"：时间流逝不是 HealthKit 变更游标过期的证据
    /// （`check-healthkit-record-sync.py` 的反向哨兵钉着这一点）。
    func needsHistoryRead(now _: Date, force: Bool) -> Bool {
        force || historyReplayPhase != nil
    }

    /// An additions-empty page is not EOF when it contains deletions. Return
    /// only a fully consumed cursor; callers persist it after server acceptance.
    ///
    /// - Parameter shouldStop: 每消费完**一整页**之后询问"单批预算是否已尽"（S2.1，观测阶段 2）；
    ///   `true` 时在**页末尾**返回 `hasMorePages: true`，`anchor` 为该页的 `next` ——
    ///   下一次从这里继续，不重读、不跳过。
    ///
    /// 🔴 为什么**必须**停在页末尾（既不能停在页中途、也不能"记住读了几条"）：
    ///   `HKAnchoredObjectQuery` 的 anchor 粒度是**页**（opaque 的 `next`，没有实体级续传点）。
    ///   停在页中途意味着下一轮从**同一页的页首**重读 —— 预算不变 ⇒ 永远停在同一处（死循环）；
    ///   而"跳到页尾"会丢数据。停页末尾 + 返回该页 `next` 是唯一没有这两种病的停点。
    ///   由此也保证**每轮至少消费 1 整页**（预算检查在 `consume` 之后），任何额度下都有界前进。
    ///
    /// - Returns: `(anchor, hasMorePages)`。`hasMorePages == false` 只出现在读到空页
    ///   （`added` 与 `deleted` 同时为空 = 真到底）——不存在第三处。
    static func drain<Anchor, Sample, Deletion>(
        from start: Anchor?,
        query: (Anchor?) async throws -> (added: [Sample], deleted: [Deletion], next: Anchor),
        consume: ([Sample], [Deletion]) throws -> Void,
        shouldStop: () -> Bool = { false }
    ) async throws -> (anchor: Anchor, hasMorePages: Bool) {
        var anchor = start
        while true {
            try Task.checkCancellation()
            let page = try await query(anchor)
            try Task.checkCancellation()
            try consume(page.added, page.deleted)
            // 空页 = 真到底（两个集合都空）；在预算检查**之前**返回 —— 到底了就没有"更多页"。
            if page.added.isEmpty && page.deleted.isEmpty { return (page.next, false) }
            anchor = page.next
            // 预算检查放在页末尾（`consume` 之后）：保证"每轮至少 1 整页"的有界前进。
            if shouldStop() { return (page.next, true) }
        }
    }
}

/// 记录 drain 的**段计划**：把"本轮从哪些起点读、中断记在哪一段"从
/// `HealthKitExport.writeGlobalRecords` 里抽出来的**纯逻辑**（不依赖 HealthKit 类型，
/// 因此回归能在 macOS 上直接钉它）。
///
/// 🔴 为什么值得单独立出来：S2.1 的头号风险（R-03）正是"页边界预算 × 全量重放两段结构"
///   的交互 —— 预算停错地方会死循环（停在页首）或丢重放语义（跳过历史段）。
///   状态机写在这里、回归逐组合断言；`writeGlobalRecords` 只做接线。
nonisolated enum RecordReplayPlan {
    /// 一段 drain 的语义归属（**起点不同**是三种 case 的分界）。
    nonisolated enum Segment: Equatable, Sendable {
        /// 旧游标 → 最新的变更流（包含删除事件）。起点 = 盘上锚点。
        case incremental
        /// `nil` → 最新：初次全量重读，**没有任何起点可依赖**，从头开始。
        case historyFromScratch
        /// 盘上锚点 → 最新：**历史段断点续读**（上次重放被预算截断在历史段）。
        case historyResume
    }

    /// 本轮的段列表。
    ///
    /// - Parameters:
    ///   - decodedAvailable: 游标存在且 anchor 能解码（首读/损坏 = false）。
    ///   - history: `needsHistoryRead` 的结论（force 或"上轮重放未完成"）。
    ///   - resumingHistoryPhase: 上轮的中断记账停在 `history` 段。
    static func segments(
        decodedAvailable: Bool,
        history: Bool,
        resumingHistoryPhase: Bool
    ) -> [Segment] {
        // 上轮中断在历史段：只续读历史流（增量段已完成）——
        // 这是"两段各自续传"的关键一格；丢了它，第二批会从增量段重新排起（重复读）
        // 而历史段永远不会被续上（重放语义静默丢失）。
        if history, resumingHistoryPhase, decodedAvailable { return [.historyResume] }
        // 首读 / 游标损坏（没有可解码的起点）：只有历史段一段，且只能从头。
        if history, !decodedAvailable { return [.historyFromScratch] }
        // 初次重放：先增量段（保住删除事件）再历史段（从头）。
        if history { return [.incremental, .historyFromScratch] }
        // 普通增量。
        return [.incremental]
    }

    /// 中断（`hasMorePages == true`）时写进 cursor 的阶段记账。
    ///
    /// 规则：记的是"中断发生在**重放的**哪一段"；`nil` = 本轮不是重放（普通增量被截断）
    /// 或没有中断。**普通增量截断绝不能记账** —— 记了 `incremental` 会让
    /// `needsHistoryRead` 在下轮返回 true，凭空触发一次全量重放（把一次普通的预算截断
    /// 放大成整库重读，正是这个状态机最需要防的形态）。
    static func interruptedPhase(segments: [Segment], interruptedIndex: Int) -> HealthKitRecordCursor.HistoryReplayPhase? {
        guard segments.contains(where: { $0 != .incremental }) else { return nil }
        guard segments.indices.contains(interruptedIndex) else { return nil }
        return segments[interruptedIndex] == .incremental ? .incremental : .history
    }
}
