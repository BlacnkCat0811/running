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

    /// 跑步动态「迟到样本」一次性补读的完成时刻（2026-10-17；`nil` = 还没补过）。
    ///
    /// 为什么需要它：Apple Watch → iPhone 的样本传输有延迟，跑步动态（功率/触地时间/
    /// 步幅/垂直振幅）可能**晚于** B1 的近 48h 窗口到达。窗口一旦过期、锚点流又排在
    /// 历史重放队尾，那段时间就再没有任何通道能捡回 —— 2026-10-14 的跑步实测踩中：
    /// 10-16 的窗口查回空，10-17 手机健康 App 里已有样本，服务端却永远是 0 条。
    ///
    /// 语义（`LateDynamicsBackfill`）：
    /// - `lateBackfillAt` = 最近一次**完整覆盖**近 14 天窗口的时刻；过了
    ///   `LateDynamicsBackfill.retryInterval`（30 天）允许再补一次 —— 权限后开、或又一次
    ///   样本迟到都还有通道。
    /// - `lateBackfillBefore` = 分页上界：还有 `[windowStart, before)` 这一段没读；
    ///   nil = 没有未读段（补读被单类型上限截断时才会出现）。
    /// - `lateBackfillWindowStart` = 本次补读的**窗口下界**（2026-10-18 深度审查 P3-22）。
    ///   第一页把 `now − lookback` 固定下来，**后续页复用同一个值**。
    ///   🔴 为什么必须固定：旧实现每批用**当时的** `now` 重算 `now − 14d`，而补读可能跨多批
    ///   （单类型上限 1500 条很容易被一次长跑撑满）⇒ 窗口下界随批次间隔前移，读完最后一页时
    ///   左下沿已越过最初那段时间；`pageOutcome` 又按 `oldestSample <= windowStart` 判"整窗
    ///   已完成"⇒ 那一小段**从未被读过却被记成已覆盖**，只能等 30 天后再补。
    ///   固定下界后 `[lateBackfillWindowStart, now]` 的覆盖是自洽的：读完 = 真读完。
    ///   nil = 还没开始分页（第一页）。
    ///
    /// 🔴 **空页不记账**（`PageOutcome.retry`）：HealthKit 对未授权读、或样本尚未从手表同步到
    /// 手机时都只返回空、不报错。若把一次空查询当成"补过了"，这条唯一的恢复通道就被自己关死
    /// —— 那正是本次事故的同类形态。空查询不写字节，重试成本只是一次 `HKSampleQuery`。
    ///
    /// `var` + 默认值：老 payload 缺键 ⇒ nil ⇒ 升级后的第一批补读一次，这正是恢复路径。
    var lateBackfillAt: Date? = nil
    var lateBackfillBefore: Date? = nil
    var lateBackfillWindowStart: Date? = nil

    /// P1-1（2026-10-18 同步诊断）：本类型历史重放时使用的**服务端覆盖下界**。
    ///
    /// 背景：服务端 `GET /v1/sync/coverage` 会回答"每个记录类型已经覆盖到哪个时刻"。
    /// 当本地游标丢失（修复/重装/游标损坏）时，客户端过去只能从 `nil` 把 52.7 万条历史
    /// 全部重读并重传，生产实测 118 批、≈96% 重复（2026-10-18 诊断 P1-1）。
    /// 有了覆盖点之后，历史段改为只读 `[knownUntil − 24h, now]`，把已入库的历史跳过。
    ///
    /// 语义：
    /// - `nil` = 本类型的历史段没有覆盖下界（老服务端 / 覆盖探测失败 / 服务端没有这类数据）
    ///   ⇒ 行为与旧版**完全一致**（从 nil 全量重放）。
    /// - 非 nil = 历史段（`.historyFromScratch` / `.historyResume`）查询必须带
    ///   `startDate >= floor` 的时间谓词；**重放被预算截断后，续读必须沿用同一个下界** ——
    ///   换谓词会让已持久化的锚点失去意义（`HKAnchoredObjectQuery` 的锚点是"变更序"位置，
    ///   按新谓词重读会从页首重来，变成每批都在同一段上空转）。
    /// - 🔴 **一旦用过就"粘住"**（2026-10-18 Lead 复核修正）：历史段跑完
    ///   （`historyReplayPhase` 归 nil）后**也不清空** —— 该类型之后**所有** anchor 查询
    ///   （历史段与增量段）都必须带同一个 `startDate` 谓词。理由：`HKQueryAnchor` 与
    ///   predicate 的绑定关系 Apple 没有承诺"可换谓词"，拿一个用日期谓词建立的锚点去跑
    ///   `predicate: nil` 的增量查询是未定义行为（真机症状：漏数据或整段重读）。
    ///   下界之前的数据/删除本来就按"覆盖探测跳过已入库历史"的取舍放弃（诊断报告 §7.4）。
    ///   唯一清除路径 = 显式「修复增量游标」（`repairSyncCursor` 清掉该类型整条游标）。
    ///
    /// `var` + 默认值：老 payload 缺键 ⇒ nil ⇒ 下一次重放照旧全量（升级瞬间的安全方向）。
    var historyCoverageFloor: Date? = nil

    /// 下一次 drain 是否要先做**全量重放**。
    ///
    /// 判据 = 上次重放被预算截断还没做完（`historyReplayPhase != nil`）。
    ///
    /// 刻意不看"距今多久"：时间流逝不是 HealthKit 变更游标过期的证据
    /// （`check-healthkit-record-sync.py` 的反向哨兵钉着这一点）。
    /// 也**没有**显式 `force` 通道了：「重新导入全部」于 2026-10-17 删除，重放只能由
    /// "上一轮没做完"或"游标被显式修复（`repairSyncCursor`）后为空"触发。
    func needsHistoryRead() -> Bool {
        historyReplayPhase != nil
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
    ///   - history: `needsHistoryRead` 的结论（"上轮重放未完成"）。
    ///   - resumingHistoryPhase: 上轮的中断记账停在 `history` 段。
    ///   - coverageRestart: P1-1 —— 服务端覆盖探测要求把一段**旧的、没有覆盖下界的**
    ///     历史续读换成"带下界从 nil 重新开始"。它只在上轮续读没有 `historyCoverageFloor`
    ///     （即这段续读产生于本功能之前）时置 true；已经带上下界的续读必须继续
    ///     `.historyResume`，否则每批都从页首重来、永远读不完。
    static func segments(
        decodedAvailable: Bool,
        history: Bool,
        resumingHistoryPhase: Bool,
        coverageRestart: Bool = false
    ) -> [Segment] {
        // 上轮中断在历史段：只续读历史流（增量段已完成）——
        // 这是"两段各自续传"的关键一格；丢了它，第二批会从增量段重新排起（重复读）
        // 而历史段永远不会被续上（重放语义静默丢失）。
        // P1-1：旧的无下界续读 ⇒ 丢弃旧锚、按覆盖下界从 nil 重来（删除事件的那一段
        // 已经由"跳过已入库历史"的取舍承担，见 `SyncCoveragePolicy` 头注释）。
        if history, resumingHistoryPhase, decodedAvailable, coverageRestart {
            return [.historyFromScratch]
        }
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

/// B1 近期窗口的水位推进判定（2026-10-17 修正）。
///
/// 旧行为：窗口查询**空**也把 `recentWindowReadAt` 推到 `now`，等于宣称"这段时间已交付"。
/// 于是样本迟到时该类型再也不会覆盖那段时间 —— 2026-10-14 跑步的功率/触地时间就是这样
/// 从"晚一点到"变成"永远缺失"的（10-16 的两次窗口查询都返回空，之后窗口下界越过那天）。
///
/// 空窗只能说明**此刻**没有数据，不能当成已覆盖：保持水位不动，下批用同一个窗口再查一次
/// （空查询没有写入、没有字节，成本仅为一次 `HKSampleQuery`）。
///
/// ## 代价（2026-10-18 深度审查 P3-21，量化后接受）
///
/// "空窗不推进"意味着 `recentWindowReadAt` 可以**无限期停在 nil**，而窗口下界随之恒为
/// `now − 48h`。窗口 pass 只在 `previousWindow == nil || previousWindow.needsHistoryRead()`
/// 时启用（`HealthKitExport.writeGlobalRecords`）⇒ **历史重放持续多久，这些空类型就被重查
/// 多久**：每批每个"近 48h 无样本"的类型各 1 次 `HKSampleQuery(limit: 1500)`，`descriptors`
/// 目前 18 个 ⇒ 最坏每批 18 次查询、重放可达数天。
///
/// 接受它的理由（与"加有界重查/降频"对比）：
/// - 这是 2026-10-14「样本迟到 ⇒ 永久缺失」的**唯一**防复发通道；任何降频（例如空窗 N 批后
///   跳查）都会把"最后一批查询之后才到达的样本"重新暴露在同一个缺口里，只是把概率乘上 N；
/// - 空查询**不写字节、不占预算、不改任何游标**，成本只在上层查询次数与耗电；
/// - 窗口 pass 本身在稳态（`needsHistoryRead == false`）就整体停用 ⇒ 这不是长期成本，
///   只在首装/游标修复后的重放窗口期内存在。
///
/// 因此本项**不改行为**，只把代价写清。若将来确实观察到耗电/时长问题，正确方向是"减少重放
/// 持续时长"（例如提高单批预算或让窗口类型轮转更公平），而不是给这条唯一通道加跳过。
nonisolated enum RecentWindowAccounting {
    /// 返回 `nil` = **不要推进水位**（空窗）；有数据才推进到 `now`。
    ///
    /// 截断（命中 `recentWindowLimit`）仍推进到 `now`：页面是"最新优先"，剩余部分由正式
    /// 锚点流补齐（`docs/IOS_SYNC_PERFORMANCE_REVIEW.md` O05 步骤 6 的"明确交由正式流补齐"）；
    /// 截断本身已被 warning 记录，不再静默。
    static func nextMark(written: Int, now: Date) -> Date? {
        written > 0 ? now : nil
    }
}

/// 跑步动态「迟到样本」的一次性补读计划（2026-10-17）。
///
/// 为什么必须**按日期**而不是按锚点：`HKAnchoredObjectQuery` 的锚点是变更序，但客户端可能
/// 正处在历史重放态（每批 4500 条几乎全是重复），跑步动态类型的锚点页排在队尾；而迟到样本
/// 的时间点又已经滑出 B1 的 48h 窗口。两条通道同时够不着 ⇒ 只能显式按日期补读。
nonisolated enum LateDynamicsBackfill {
    /// 补读对象：跑步动态家族（只在跑步时才有样本，是训练详情时序的来源）。
    static let types: Set<String> = [
        "HKQuantityTypeIdentifierRunningPower",
        "HKQuantityTypeIdentifierRunningGroundContactTime",
        "HKQuantityTypeIdentifierRunningStrideLength",
        "HKQuantityTypeIdentifierRunningVerticalOscillation"
    ]
    /// 回看时长：覆盖"跑步 → 手表 → 手机"可能达到的样本延迟（实测 2 天以上）。
    static let lookback: TimeInterval = 14 * 24 * 60 * 60
    /// 单类型单批上限。有界是判据的一部分；**命中上限不是完成** —— 下一批继续读更老的一段。
    static let limit = 1500
    /// 完成后再补一次的间隔。它让"空结果不记账"不至于变成永远不补：
    /// 权限后开 / 又一次样本迟到，最迟过这么久也会有下一次机会。
    static let retryInterval: TimeInterval = 30 * 24 * 60 * 60

    /// 触发判据：**流已建立**（有游标）且（从没完成 或 完成已超过 `retryInterval`）。
    ///
    /// 没有游标 = 首装/游标被清空 ⇒ 历史重放本身会从头读一遍，不需要补读
    /// （也就不会平白多送一份重复数据）。
    static func needs(cursor: HealthKitRecordCursor?, now: Date) -> Bool {
        guard let cursor else { return false }
        guard let completed = cursor.lateBackfillAt else { return true }
        return now.timeIntervalSince(completed) >= retryInterval
    }

    /// 一页之后的记账结论（纯逻辑，回归逐组合钉住 —— `HealthKitExport` 不进任何回归编译）。
    enum PageOutcome: Equatable {
        /// 整窗已读完：记完成时刻、清分页上界。
        case completed
        /// 单类型上限截断了这一页：还有更老的一段没读，把分页上界移到 `before`。
        case nextPage(before: Date)
        /// 空页且不在分页中：可能是未授权 / 样本尚未同步到手机 ⇒ **不记账**，下批重试。
        case retry
    }

    /// - Parameters:
    ///   - returned: 本页拿到的样本数（0 = 空页）。
    ///   - truncated: 是否命中 `limit`（`returned >= limit`）。
    ///   - oldestSample: 本页最早样本的 startDate（"最新优先" ⇒ 它就是本页覆盖的最老边界）。
    ///   - windowStart: 回看窗口的下界；分页到它就该收手（否则同一时刻的样本会来回打转）。
    ///   - paging: 本页是否属于"上一批被截断后的续读"（`lateBackfillBefore != nil`）。
    static func pageOutcome(
        returned: Int,
        truncated: Bool,
        oldestSample: Date?,
        windowStart: Date,
        paging: Bool
    ) -> PageOutcome {
        if truncated, let oldestSample, oldestSample > windowStart {
            return .nextPage(before: oldestSample)
        }
        // 分页到底（或本来就没被截断）⇒ 整窗已覆盖；首次查询就空 ⇒ 当作"还不能下结论"。
        if returned == 0, !paging { return .retry }
        return .completed
    }

    /// 本次补读的**窗口下界**（P3-22）：分页中复用持久化的固定起点，否则开场取 `now − lookback`。
    ///
    /// 调用方必须把返回值在 `.nextPage` 时**持久化**（`lateBackfillWindowStart`），否则下一个
    /// 批次又会拿新的 `now` 重算 —— 那正是前缘漂移的成因（见该字段的注释）。
    static func windowStart(cursor: HealthKitRecordCursor?, now: Date) -> Date {
        cursor?.lateBackfillWindowStart ?? now.addingTimeInterval(-lookback)
    }

    /// 稳态下"该有却没有"的**非用户可见**诊断（2026-10-18 深度审查 P3-24）。
    ///
    /// 为什么需要它：为 2026-10-14 事故新增的用户警告（`HealthKitExport` 里
    /// "本次同步没有跑步功率/触地时间样本…"）只在**窗口 pass 真的查过**时才可能触发，而窗口
    /// pass 只在重放/首装期启用 —— 事故当时与之后的**稳态增量**（游标已建立、无重放）根本走不到
    /// 那条判据，于是"又缺了"依旧零痕迹。这里给稳态补一条只进 `NSLog` 的观察通道：判据相同
    /// （功率/触地时间本批**一条都没写**，但同一家族的其它跑步动态写了），只是不弹用户警告，
    /// 避免把"权限问题"与"预算/时序问题"混成同一条噪音。
    ///
    /// - Parameter writtenTypes: 本批**真正写进 export.xml** 的类型（三个通道的并集）。
    /// - Returns: 每条缺口一段可直接打印的诊断文本（空数组 = 本批无可报告的缺口）。
    static func steadyStateGapDiagnostics(writtenTypes: Set<String>) -> [String] {
        let power = "HKQuantityTypeIdentifierRunningPower"
        let groundContact = "HKQuantityTypeIdentifierRunningGroundContactTime"
        let siblings = [
            "HKQuantityTypeIdentifierRunningSpeed",
            "HKQuantityTypeIdentifierRunningStrideLength",
            "HKQuantityTypeIdentifierRunningVerticalOscillation"
        ]
        guard siblings.contains(where: { writtenTypes.contains($0) }) else { return [] }
        let silent = [power, groundContact].filter { !writtenTypes.contains($0) }
        guard !silent.isEmpty else { return [] }
        return silent.map { type in
            "[RAI] 稳态同步缺口：本批写入了其它跑步动态但没有 \(type)"
                + "（检查读取权限；若是预算/时序问题，下一次补读通道会再覆盖近 14 天）"
        }
    }
}

/// P1-1（2026-10-18 同步诊断）：服务端覆盖探测的**纯逻辑**。
///
/// ## 缺陷形态
///
/// 本地记录游标一旦丢失（游标损坏后修复、重装、状态复位），重放是唯一能重建基线的方式，
/// 客户端因此会从 `nil` 把全部历史重新读一遍并**重新上传**。2026-10-18 生产实测：自 10-14
/// 起 43 批 / 192,500 条、新增仅 8,117 条（≈95.8% 重复），按基数推算还剩 ≈75 批 ——
/// 而服务端 `health_records` 里这些数据一条都不缺。每批 4500 条预算因此被重复数据占满，
/// 新训练只能挤 20% 窗口份额（P0-4 要治的另一半）。
///
/// ## 判据
///
/// 服务端新增 `GET /v1/sync/coverage`（handshake 能力位 `syncCoverageVersion >= 1`）回答
/// 每个类型的 `knownUntil`（已覆盖到的样本时刻）与 `sampleCount`。客户端据此把历史段的
/// 查询起点抬到 `knownUntil − 24h`：
///
/// - **24h 重叠**：覆盖点是"服务端已接收的样本里最大的 startDate"，而客户端的样本是流式
///   到达的；24h 重叠覆盖"服务端刚收到但尚未发布/时钟偏差"的那一段，代价是少量重复
///   （服务端按 UUID 幂等）。
/// - **`sampleCount == 0` / `knownUntil` 缺失 / 解析失败** ⇒ **不设下界**（全量重放）。
///   服务端没有这类数据时"跳过历史"会把它们**永久丢掉** —— 方向必须保守。
/// - **`knownUntil` 太旧**（早于 `maximumUsefulLag`）⇒ 不设下界：跳过一段 90 天以前的历史
///   本身没有收益，却要承担"该区间删除/更正事件不再上报"的代价。90 天与显式修复的有界
///   下界（`HealthKitSync.repairFloorWindow`）同量级。
/// - 🔴 **下界一旦落到游标上就"粘住"**：该类型之后所有 anchor 查询都带同一个谓词
///   （见 `HealthKitRecordCursor.historyCoverageFloor`）—— 谓词与锚点必须同源，
///   所以后续批次即使 coverage 给出更新的 knownUntil，也**不**替换已持久化的下界。
/// - 覆盖探测请求本身**失败 / 老服务端** ⇒ 传 nil 覆盖表 ⇒ 回落全量重放（不得报错中断）。
///
/// ## 已知代价（诊断报告 §7.4 已点明，这里如实重复）
///
/// 被跳过的历史区间内的**删除事件**不会上报（`HKAnchoredObjectQuery` 从 `nil` 出发本来也
/// 看不到删除；只有持久锚点才能看到）。这是"用一次覆盖探测换掉 75 批重复上传"的取舍。
nonisolated enum SyncCoveragePolicy {
    /// 历史查询起点与覆盖点之间的重叠。见类型说明。
    static let overlap: TimeInterval = 24 * 60 * 60
    /// 覆盖点超过这么久没有更新 ⇒ 认为"太旧、不值得跳过"（见类型说明）。
    static let maximumUsefulLag: TimeInterval = 90 * 24 * 60 * 60

    /// 服务端覆盖表的一行（由 `HealthKitSync` 从 `SyncCoverageResponse` 映射而来，
    /// 刻意不引用 APIModels 类型：本文件被"只编译 HealthKitRecordCursor"的回归单元执行，
    /// 引 APIModels 会让那个单元编译不过 —— 与 `RouteTodoScheduler` 零外部依赖同源）。
    nonisolated struct TypeCoverage: Equatable, Sendable {
        let type: String
        /// 服务端该类型已覆盖到的样本时刻（`knownUntil`，ISO8601 解析后）。
        let knownUntil: Date?
        /// 服务端该类型的样本数。0 = 服务端没有这类数据 ⇒ 不跳历史。
        let sampleCount: Int

        init(type: String, knownUntil: Date?, sampleCount: Int) {
            self.type = type
            self.knownUntil = knownUntil
            self.sampleCount = sampleCount
        }
    }

    /// 要不要向服务端发覆盖探测请求。
    ///
    /// 判据：handshake 宣告了能力位（调用方负责）**且**存在需要重放的类型 ——
    /// "游标缺失"或"上轮重放未完成"。稳态增量同步（所有类型游标都有效）不花这次请求。
    static func needsCoverageQuery(
        cursors: [String: HealthKitRecordCursor],
        types: [String]
    ) -> Bool {
        types.contains { type in
            guard let cursor = cursors[type] else { return true }
            return cursor.needsHistoryRead()
        }
    }

    /// ISO8601 时间串解析（服务端 `knownUntil` 形如 `2026-10-18T12:28:46.000Z` 或整秒）。
    /// 两种格式都试；解析不了返回 nil（⇒ 不设下界，安全方向）。
    static func parseTimestamp(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: raw) { return parsed }
        return ISO8601DateFormatter().date(from: raw)
    }

    /// 历史段查询下界。`nil` = 保持旧行为（从 nil 全量重放）。
    ///
    /// - Parameters:
    ///   - type: HealthKit 类型标识（如 `HKQuantityTypeIdentifierHeartRate`）。
    ///   - coverage: 服务端覆盖表（类型 → 覆盖点）。空表 = 老服务端/探测失败。
    ///   - now: 本批的判定基准（与导出共用一个时钟，便于回归用合成时钟）。
    static func historyFloor(
        type: String,
        coverage: [String: TypeCoverage],
        now: Date
    ) -> Date? {
        guard let entry = coverage[type], entry.sampleCount > 0, let knownUntil = entry.knownUntil else {
            return nil
        }
        // 服务端时钟可能略快：覆盖点"在未来"时按 now 收敛，避免把下界推到 now 之后。
        let anchor = min(knownUntil, now)
        // 太旧 ⇒ 跳过没有收益，不值得承担删除事件丢失的代价。
        guard now.timeIntervalSince(anchor) <= maximumUsefulLag else { return nil }
        let floor = anchor.addingTimeInterval(-overlap)
        guard floor <= now else { return nil }
        return floor
    }

    /// 是否需要把一段**旧的无下界历史续读**换成带下界的新重放。
    ///
    /// 只有"上轮中断在历史段、且那一轮没有持久化覆盖下界"才重开；已经带下界的续读必须
    /// 继续（否则每批从页首重来，永远读不完）。
    static func shouldRestartHistory(
        cursor: HealthKitRecordCursor?,
        floor: Date?
    ) -> Bool {
        guard floor != nil, let cursor else { return false }
        return cursor.historyReplayPhase == .history && cursor.historyCoverageFloor == nil
    }
}
