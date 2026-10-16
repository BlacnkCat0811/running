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

    /// 最近一次**窗口 pass**读完的时刻（B1，2026-10-16）。
    ///
    /// 窗口 = `[max(now − 48h, 上次读完 − 6h), now]`（6h 重叠覆盖"数据迟到"）。它是
    /// **独立于正式 anchor 的独立状态**：历史重放可能持续数天，而"最近 48 小时"的数据
    /// （训练详情、恢复评估要用的）不能排在队尾 —— 窗口 pass 每批先用一次**有界**查询把
    /// 近期数据送到，正式 anchor 只由历史/增量段推进（窗口**绝不**污染它）。
    ///
    /// `var` + 默认值：与 `historyReplayPhase` 同一条兼容纪律（老 payload 缺键 = 没记过 ⇒
    /// 下批从完整 48h 窗重扫一次，服务端按 UUID 幂等）。
    var recentWindowReadAt: Date? = nil

    /// 下一次 drain 是否要先做**全量重放**。
    ///
    /// 判据 = 显式请求（`force`）**或**上次重放被预算截断还没做完（`historyReplayPhase != nil`）。
    /// 刻意不看"距今多久"：时间流逝不是 HealthKit 变更游标过期的证据
    /// （`check-healthkit-record-sync.py` 的反向哨兵钉着这一点）。
    func needsHistoryRead(now _: Date, force: Bool) -> Bool {
        force || historyReplayPhase != nil
    }

    /// 单批预算下"这一整页放得下吗"的裁决（S2.5 写前判定，2026-10-14）。
    ///
    /// 只有两个 case，**没有"超预算也提交"** —— "先落盘再检查"正是被本改造删掉的旧行为
    /// （它让每批最后一个页整体越界：真机实测 524,305 B）。
    nonisolated enum PageDecision: Equatable, Sendable {
        /// 整页提交，锚点推进到该页 `next`，`limit` 复位到满页。
        case accept
        /// 本页放不下：整页不提交、锚点不推进；用给定 `limit` 重查**同一**锚点。
        case retryWithLimit(Int)
    }

    /// An additions-empty page is not EOF when it contains deletions. Return
    /// only a fully consumed cursor; callers persist it after server acceptance.
    ///
    /// ## 写前判定（S2.5）
    ///
    /// 预算判定发生在**整页落盘之前**：调用方把 `render` 的产物（该页完整字节）交给
    /// `decide`，只有 `.accept` 才 `commit`。
    ///
    /// 🔴 为什么必须是"写前"而不是"页末尾检查"：服务端按**字节**判上界
    /// （`statSync(export.xml).size`），而页是**不可分**的提交单位。先落盘再检查 ⇒
    /// 每批最后一个页**整体越界**（2026-10-14 真机：预算 1,887,436 B → 实际 2,411,741 B，
    /// 超 524,305 B，被 400 硬拒并卡死同步链）。
    /// 页末尾检查**修不掉它**：「已写字节还没到预算」不等于「下一页放得下」。
    ///
    /// ## 停在哪：页首，不是页尾
    ///
    /// 放不下 ⇒ **整页不提交、锚点不推进**（返回页前锚点），这一页留给下一批。
    /// 下一批的预算是重新给的满额 ⇒ 不是死循环。唯一会卡住的形态是"**单页本身大于整批预算**"，
    /// 它由 `.retryWithLimit` 兜住（收缩 `limit` 重查同一锚点，极限到 1 条）。
    ///
    /// 🔴 前进性粒度从「每轮 ≥1 **整页**」降到「每轮 ≥1 **条记录**」（或本轮明确让给下一批）。
    /// 旧的"每轮至少 1 整页"是**拿超额换前进**，正是本缺陷的成因，不能保留；
    /// 但前进性本身必须保留（否则死循环），这就是 `.retryWithLimit` 存在的唯一理由。
    ///
    /// - Returns: `(anchor, hasMorePages, stoppedBeforePage)`。
    ///   - `hasMorePages == false` 只出现在读到空页（`added` 与 `deleted` 同时为空 = 真到底）。
    ///   - `anchor` 是 `Anchor?`：停止在**页首**且该段一页都没读时，返回的仍是**该段起点**
    ///     （`.historyFromScratch` 段的起点就是 `nil`）⇒ 调用方不能无条件把它当"前进后的锚点"。
    ///   - `stoppedBeforePage == true` = 因"连一条都放不进剩余额度"而在**页首**收手：
    ///     本段本轮零进展。这不是错误（下一批重新给满额预算），但调用方要能区分
    ///     "读完了" / "读了一部分" / "本轮一条都没读"。
    static func drain<Anchor, Sample, Deletion, Rendered>(
        from start: Anchor?,
        pageLimit: Int,
        query: (Anchor?, Int) async throws -> (added: [Sample], deleted: [Deletion], next: Anchor),
        render: ([Sample], [Deletion]) throws -> Rendered,
        decide: (Rendered, Int) -> PageDecision,
        commit: (Rendered, Int) throws -> Void
    ) async throws -> (anchor: Anchor?, hasMorePages: Bool, stoppedBeforePage: Bool) {
        var anchor = start
        var limit = pageLimit
        while true {
            try Task.checkCancellation()
            let page = try await query(anchor, limit)
            try Task.checkCancellation()
            // 空页 = 真到底（两个集合都空）；与预算无关，永远没有"更多页"。
            if page.added.isEmpty && page.deleted.isEmpty { return (page.next, false, false) }
            let rendered = try render(page.added, page.deleted)
            switch decide(rendered, page.added.count) {
            case .accept:
                try commit(rendered, page.added.count)
                anchor = page.next
                limit = pageLimit
            case .retryWithLimit(let requested):
                // 🔴 夹紧规则（收敛性全靠它）：请求值**严格小于**当前 `limit` 才采纳，否则折半；
                // 当前 `limit` 已经是 1 ⇒ 没有更小的页可取了，收手（零提交）。
                // 没有折半兜底，一次写错的 `requested`（例如恒返回满页值）会让每轮只减 1 条
                // ⇒ 上千次查询才收敛。折半把它压到 ~log2(pageLimit) 次。
                guard limit > 1 else {
                    // 连 1 条都放不进剩余额度 ⇒ 本段到此为止，零提交、零推进。
                    return (anchor, true, true)
                }
                limit = requested < limit ? max(1, requested) : max(1, limit / 2)
            }
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
