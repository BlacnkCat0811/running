import Foundation

// 同步展示层的**纯判据**（2026-10-18 同步诊断 P0-3 / P0-5 / P0-6 / P2-3）。
//
// 为什么单独成文件、而不是写进视图：这批判据此前只以"内联字符串 + 内联布尔"的形式住在
// `TechViews.swift` / `TechSyncStatus.swift` / `TechDataSeriesChart.swift` 里，而**视图不被
// 任何回归脚本编译**（它们依赖 SwiftUI / Charts），改错了只有肉眼能发现。事故复盘里最贵的
// 两条恰恰都是"看着对、其实在说假话"：
//   · 还有 75 批没读时界面说「同步完成」（D10/§5.3）；
//   · freshness 的 `not_seen_yet` 被渲染成「暂无样本」，与"设备没有这项数据"同形（D9）。
// 抽到这里之后，`TechPresentationRegression`（`run-tech-presentation-tests.sh`）与
// `ModelRegression`（`run-model-tests.sh`）都能逐格钉住。
//
// 边界：**只做展示映射**，不读网络、不读 HealthKit、不持有任何状态。真正的取数在
// `NativeAppModel`（`reloadOpenWorkoutIfStale` / 有界前台轮询），续跑预算在
// `BackgroundSyncPolicy.SyncFollowUp`。

// MARK: - 训练详情页的补齐状态（P0-3）

/// `GET /v1/workouts/:id/freshness` 的展示映射。
///
/// 服务端合同（`packages/api-contracts`，2026-10-18 新增）：
/// - `analysis.status`：`pending | running | published | failed`；
/// - `series[].state`：`present | not_seen_yet | unsupported`（**`not_seen_yet` ≠ 设备不支持**）；
/// - `completeness`：`partial | complete`（老判据；A5 之后客户端仍须兼容，但不再是唯一依据）。
/// - A5 三态（2026-10-19，老服务端整组省略）：`deliveryState` = `delivered | partial | unknown`
///   （**到达证据**，不证明手机读到了什么）、`analysisState`（与 `analysis.status` 同源）、
///   `stabilityState` = `stable | settling`（唯一吃 24h 静默窗口的量）。
nonisolated enum WorkoutFreshnessPresentation {
    /// 详情页顶部横幅。视图只负责挑颜色/图标，文案与条件都在这里。
    struct Banner: Equatable, Sendable {
        enum Kind: Equatable, Sendable {
            /// 事实已提交、分析未发布：`analysis.status != "published"`（或详情里的 `publishStatus == "pending"`）。
            case analyzing
            /// 分析已发布，但仍有指标 `not_seen_yet`，或观测窗口仍在 `settling`。
            /// 文案只说"尚未观察到 / 可能仍在补传"，**不**替服务端声称手表还在传。
            case waitingForSamples
            /// 分析失败：**不是**"还在算"，不能继续用「分析中」。
            case analysisFailed
        }

        let kind: Kind
        let title: String
        let detail: String
        /// 详情页可见期间是否允许有界前台轮询（`WorkoutFreshnessPollPolicy`）。
        let pollsInForeground: Bool
    }

    /// A5 三态字段是否可用。
    ///
    /// 服务端一次性发 `deliveryState` / `analysisState` / `stabilityState` 三个键；老服务端
    /// 整组省略。这里按"任一键出现即新服务端"处理：否则一个只缺 `stabilityState` 的载荷会
    /// 被当成老服务端，而它恰恰带着新服务端的 `not_seen_yet` 证据。**全部缺失**时才退回
    /// `completeness` 语义 —— 那才是真正的老服务端。
    static func hasTriState(_ freshness: WorkoutFreshnessResponse?) -> Bool {
        guard let freshness else { return false }
        return freshness.deliveryState != nil || freshness.analysisState != nil
            || freshness.stabilityState != nil
    }

    /// 分析状态。优先 A5 的 `analysisState`（与 `analysis.status` 同源），老服务端退回
    /// `analysis.status` —— 两个字段都由服务端给出，缺失时不会凭空编造。
    static func analysisState(_ freshness: WorkoutFreshnessResponse?) -> String? {
        guard let freshness else { return nil }
        return freshness.analysisState ?? freshness.analysis.status
    }

    /// 至少一个指标处于 `not_seen_yet`（尚未观察到）。`unsupported` 不算：设备没有这项
    /// 能力，再等也不会来 —— 把它算进"补齐中"就是让用户永远等一个不会到的样本（D9）。
    static func hasUnobservedMetrics(_ freshness: WorkoutFreshnessResponse?) -> Bool {
        guard let freshness else { return false }
        return freshness.series.contains { $0.state == "not_seen_yet" }
    }

    /// **唯一**的"仍在补齐 / 仍可能变化"判据（R5，2026-10-19）。
    ///
    /// 新服务端（三态任一出现）满足任一即算补齐：
    ///   1. 分析未发布（`analysisState`/`analysis.status` ≠ `published`）；
    ///   2. `stabilityState == "settling"`（24h 内仍有批次 —— 安静只说明观测稳定）；
    ///   3. 至少一个指标 `not_seen_yet`。
    /// 三项都不成立 ⇒ **不**因为旧 `completeness == "partial"` 继续装成"还在补"。这正是
    /// R5 的合成案例：`deliveryState=delivered`、`completeness=complete`、功率 0/not_seen_yet
    /// 必须判为补齐；反过来 published+stable 且没有缺项时必须判为收敛。
    ///
    /// 老服务端（三态全缺）：原样沿用 `completeness != "complete"`，行为不变。
    /// 混合载荷只缺 `stabilityState`：这一项退回 `completeness`，不把"未知"读成 stable。
    static func isPartial(_ freshness: WorkoutFreshnessResponse?) -> Bool {
        guard let freshness else { return false }
        guard hasTriState(freshness) else { return freshness.completeness != "complete" }
        if analysisIsPending(freshness, publishStatus: nil) { return true }
        if let stability = freshness.stabilityState {
            if stability == "settling" { return true }
        } else if freshness.completeness != "complete" {
            // 没有 stability 证据时保守退回旧口径：缺键不是 stable 的证明。
            return true
        }
        return hasUnobservedMetrics(freshness)
    }

    /// 分析是否还没发布。freshness 缺失（老服务端）时退回详情/列表里的 `analysisPublishStatus`。
    static func analysisIsPending(_ freshness: WorkoutFreshnessResponse?, publishStatus: String?) -> Bool {
        if let freshness { return analysisState(freshness) != "published" }
        return publishStatus == "pending"
    }

    /// 分析是否**失败**（区别于"还在算"）。freshness 缺失时无从判断，按未失败处理。
    static func analysisFailed(_ freshness: WorkoutFreshnessResponse?) -> Bool {
        analysisState(freshness) == "failed"
    }

    /// 详情页横幅。返回 `nil` = 没有待补齐的证据（分析已发布、观测已安静、没有待观察指标）。
    ///
    /// 三种情形必须分开，否则会出现"用一句假话盖住另一句"：
    ///   1. 分析未发布 ⇒ 「分析中」（派生字段为 null 时**不许**显示成 0/空）；
    ///   2. 分析已发布但还有 `not_seen_yet` 指标 ⇒ 「数据仍在补齐」+ 待观察指标清单；
    ///   3. 分析失败 ⇒ 「分析未完成」，且**不**轮询（再算一次是服务端的事，不是刷页面能解决的）。
    ///
    /// R5：横幅**不再**说"Apple Watch 数据仍在传输"。服务端没有"手机读到了哪些类型"的回执，
    /// 它只知道自己收到了什么 —— 可以说"尚未观察到 / 可能仍在补传"，不能把未知归因给手表。
    static func banner(freshness: WorkoutFreshnessResponse?, publishStatus: String?) -> Banner? {
        let failed = analysisFailed(freshness)
        let pending = analysisIsPending(freshness, publishStatus: publishStatus)
        let partial = isPartial(freshness)
        let missing = missingMetricNames(freshness)
        guard failed || pending || partial else { return nil }

        var parts: [String] = []
        // 分析与样本是两件事：各说各的结论，别用一句话同时替两者下断言。
        if failed {
            parts.append("训练记录已保存；分析结果发布后会自动更新。")
        } else if pending {
            parts.append("分析仍在进行，完成后自动更新。")
        }
        if !missing.isEmpty {
            parts.append("部分指标尚未观察到：\(missing.joined(separator: "、"))，可能仍在补传或同步；到齐后自动更新。")
        }
        if parts.isEmpty {
            // 只有 `stabilityState == "settling"`（或老服务端 `completeness == partial`）：
            // 只知道"最近 24h 还可能有新批次"，不知道缺哪项 —— 不编造指标，也不归因手表。
            parts.append("最近 24 小时仍可能有新样本到达；到齐后自动更新。")
        }

        let kind: Banner.Kind = failed ? .analysisFailed : (pending ? .analyzing : .waitingForSamples)
        let title: String = failed ? "分析未完成" : (pending ? "分析中" : "数据仍在补齐")
        return Banner(kind: kind, title: title, detail: parts.joined(separator: " "),
                      pollsInForeground: partial && !failed)
    }

    /// 指标 key 归一。服务端可能按 `/series` 的名字写（`heartRate`/`speed`/`power`），
    /// 也可能按 HealthKit 类型名写（`RunningStrideLength`/`StepCount`/`VO`/`GCT`）——
    /// 展示层不该因为命名差异把"已到达"说成"待到达"。归一结果与 `TechWorkoutMetric.rawValue`
    /// 同一套 key（展示顺序由视图决定，这里只做分类）。
    static func canonicalMetricKey(_ raw: String) -> String? {
        let key = raw.lowercased().replacingOccurrences(of: "_", with: "")
        if key.contains("heartrate") || key == "hr" { return "heartRate" }
        if key.contains("groundcontact") || key.contains("gct") { return "groundContactTime" }
        if key.contains("vertical") || key == "vo" { return "verticalOscillation" }
        if key.contains("stride") { return "strideLength" }
        if key.contains("cadence") || key.contains("step") { return "cadence" }
        if key.contains("power") { return "power" }
        if key.contains("speed") || key.contains("pace") { return "pace" }
        if key.contains("elevation") || key.contains("altitude") || key.contains("route") { return "elevation" }
        return nil
    }

    /// 该指标在 freshness 里的 `state`（`present` / `not_seen_yet` / `unsupported`），没有这条时 `nil`。
    static func metricState(_ metricKey: String, freshness: WorkoutFreshnessResponse?) -> String? {
        guard let freshness else { return nil }
        let wanted = canonicalMetricKey(metricKey) ?? metricKey
        return freshness.series.first { canonicalMetricKey($0.metric) == wanted }?.state
    }

    /// 待观察指标的中文名（横幅清单用），按固定顺序去重。
    ///
    /// 只收 `not_seen_yet`：`unsupported` 是"设备没有这项能力"，把它写进"还没到"就是
    /// 让用户永远等一个不会来的样本 —— 那正是 D9 要消灭的那类假话。
    static func missingMetricNames(_ freshness: WorkoutFreshnessResponse?) -> [String] {
        guard let freshness else { return [] }
        let order = ["heartRate", "pace", "cadence", "power", "strideLength",
                     "verticalOscillation", "groundContactTime", "elevation"]
        var found: [String: String] = [:]
        for metric in freshness.series {
            guard let key = canonicalMetricKey(metric.metric), found[key] == nil else { continue }
            guard metric.state == "not_seen_yet" else { continue }
            found[key] = displayName(key)
        }
        return order.compactMap { found[$0] }
    }

    /// 归一 key 的中文名（横幅、占位、分区说明共用；视图不再各写一份）。
    static func displayName(_ canonicalKey: String) -> String {
        switch canonicalKey {
        case "heartRate": return "心率"
        case "pace": return "配速"
        case "cadence": return "步频"
        case "power": return "跑步功率"
        case "strideLength": return "步幅"
        case "verticalOscillation": return "垂直振幅"
        case "groundContactTime": return "触地时间"
        case "elevation": return "海拔"
        default: return "时序"
        }
    }

    /// 时序图的空态占位（P0-3 的核心之一）。
    ///
    /// 三句话必须分得开：
    ///   · `not_seen_yet` ⇒ 「样本尚未观察到；可能仍在补传或同步」——**不是**"没有"，
    ///     也**不**声称手表还在传输（手机读到什么，服务端并不知道）；
    ///   · `unsupported` ⇒ 「设备未提供」——设备确实没有，不要再等；
    ///   · 其余（`present` 但 0 点 / 没有 freshness 的老服务端）⇒ 沿用既有的「暂无…时序样本」。
    static func emptySeriesPlaceholder(
        metricKey: String,
        title: String,
        freshness: WorkoutFreshnessResponse?
    ) -> String {
        switch metricState(metricKey, freshness: freshness) {
        case "not_seen_yet":
            return "\(title)样本尚未观察到；可能仍在补传或同步，到齐后会自动更新。"
        case "unsupported":
            return "设备未提供\(title)数据。"
        default:
            return "暂无\(title)时序样本"
        }
    }

    /// 详情自动重取的判据（P0-6 / R5）。
    ///
    /// 判据顺序（越靠前越保守）：
    ///   1. 有 freshness：`isPartial` ⇒ 重取。新服务端由三态决定（分析未发布 / `settling` /
    ///      有 `not_seen_yet`）；三态全缺时**原样**退回旧 `completeness != complete` 语义；
    ///   2. 老服务端没有 freshness：`publishStatus == "pending"` ⇒ 重取；
    ///   3. 仍无证据：会话在最近 `recentWindow` 内结束 ⇒ 重取一次（迟到样本窗口）；
    ///   4. 最后：连时序都没有（`series` 全 0 样本）⇒ 重取一次；
    ///   5. 其余 ⇒ 不重取，避免每一代次都白读三条接口。
    ///
    /// R5 的关键：新字段说 `analysisState=published` + `stabilityState=stable` + 没有
    /// `not_seen_yet` 时返回 `false`，**即使旧 `completeness` 仍是 `partial`**；反过来，
    /// 分析已发布但某个指标仍 `not_seen_yet` 时必须 `true`（旧实现只看 completeness，合成
    /// 案例里会停止刷新）。分析失败也算"未发布"：失败不证明不会重算，保留既有重取语义。
    static func shouldReload(
        endedAt: String,
        publishStatus: String?,
        freshness: WorkoutFreshnessResponse?,
        series: WorkoutSeriesResponse?,
        now: Date,
        recentWindow: TimeInterval = 6 * 3600
    ) -> Bool {
        if let freshness {
            // 老服务端：`isPartial` 已退回 completeness；`analysisIsPending` 保住旧 OR 的第二条。
            guard hasTriState(freshness) else {
                return isPartial(freshness) || analysisIsPending(freshness, publishStatus: publishStatus)
            }
            return isPartial(freshness)
        }
        if publishStatus == "pending" { return true }
        if let ended = parseISO8601(endedAt), now.timeIntervalSince(ended) <= recentWindow { return true }
        return seriesIsEmpty(series)
    }

    /// 会话窗口内一条样本都没有（`/series` 的八个通道全 0）。老服务端缺 freshness 时的兜底。
    static func seriesIsEmpty(_ series: WorkoutSeriesResponse?) -> Bool {
        guard let series else { return false }
        let channels = [series.series.heartRate, series.series.speed, series.series.power,
                        series.series.cadence, series.series.elevation, series.series.strideLength,
                        series.series.verticalOscillation, series.series.groundContactTime]
        return channels.allSatisfy { $0.totalSamples == 0 && $0.points.isEmpty }
    }

    private static func parseISO8601(_ value: String) -> Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = parser.date(from: value) { return parsed }
        return ISO8601DateFormatter().date(from: value)
    }
}

// MARK: - 详情页可见期间的有界前台轮询（P0-3 / P0-6）

/// `WorkoutFreshnessPresentation.isPartial`（仍在补齐：分析未发布 / settling / 有
/// `not_seen_yet` 指标）为真时，详情页在**可见期间**的有限重取。
///
/// 硬约束（事故复盘 §6.1 P0-3：不新增后台机制）：
///   · 只在详情页的 `.task` 里跑 —— 页面消失时任务被取消，`Task.sleep` 直接抛出停止；
///   · 次数有界（`maxAttempts = 4`），间隔递增（2/5/10/15s），一波总时长 ≈ 32s；
///   · App 进入后台时 `.task(id:)` 的 key 变了、旧任务被取消 —— 于是**没有任何后台轮询**。
nonisolated enum WorkoutFreshnessPollPolicy {
    /// 最多再重取几次。
    static let maxAttempts = 4

    /// 每次重取前的等待（秒）。递增且封顶，避免"每 2 秒刷一次接口"。
    static let delays: [TimeInterval] = [2, 5, 10, 15]

    /// 第 `attempt` 次（从 1 起算）重取前的等待秒数。
    static func delaySeconds(afterAttempt attempt: Int) -> TimeInterval {
        delays[min(max(attempt, 1), delays.count) - 1]
    }

    /// 这一轮还能不能继续轮询。
    ///
    /// 四个条件缺一不可：还有次数、freshness 仍在补齐（`isPartial` 的三态判据）、
    /// 用户看的仍是这条训练、详情页还在前台（调用方用 `scenePhase` 决定要不要开这个任务）。
    static func shouldContinue(
        attempts: Int,
        isPartial: Bool,
        openWorkoutID: String?,
        expectedID: String
    ) -> Bool {
        guard isPartial, attempts < maxAttempts else { return false }
        return openWorkoutID == expectedID
    }
}

// MARK: - 「还有没读完的页」的文案（P0-6）

/// 待续页（`sync_continuation` 槽）在界面上怎么说。
///
/// 事故原始表现：任务行提交后即删，界面显示「健康同步完成」，而盘上还有 75 批待读。
/// 这几句是"不得说完成"的唯一出口 —— `TechSyncStatus` 与 `TechHomeActions` 都从这里取。
nonisolated enum SyncContinuationCopy {
    /// `.pending` 档的标题。**逐字**钉住"还有未读完的页"这几个字：
    /// 它是用户能区分"卡住了"与"还在读"的唯一线索。
    static let pendingTitle = "同步尚未完成（还有未读完的页）"

    /// `.pending` 档的正文：明确"会继续"，并说明不需要重新读健康数据。
    static let pendingDetail = "将继续读取剩余的页；不必重新读取健康数据。"

    /// `.pending` 档的操作按钮。
    static let pendingAction = "继续同步"

    /// 手动同步收工提示：还有未读完的页时**必须**给这一句，不许说"检查完成"。
    static let manualResult = "同步尚未完成（还有未读完的页），将继续。"

    /// 手动同步收工提示（返回 `nil` ⇒ 调用方用常规成功文案）。
    static func manualResultIfPending(hasPendingContinuation: Bool) -> String? {
        hasPendingContinuation ? manualResult : nil
    }
}

// MARK: - 同步结果自解释（P0-5）

/// 「这一批到底带来了什么」的文案（P0-5）。
///
/// 依据：回执新增 `records: { parsed, inserted, unchanged }`（D9/P0-3）。没有它时用户只能
/// 看到"同步成功"，而 4500 条里 99% 是服务端已有的重复 —— 于是"本批 0 新增"被读成"同步坏了"。
nonisolated enum SyncResultCopy {
    /// 本批回执计数。三个字段都可空：老服务端没有 `records` 字段。
    struct BatchCounts: Equatable, Sendable {
        let parsed: Int?
        let inserted: Int?
        let unchanged: Int?

        init(parsed: Int? = nil, inserted: Int? = nil, unchanged: Int? = nil) {
            self.parsed = parsed
            self.inserted = inserted
            self.unchanged = unchanged
        }
    }

    /// 计数尾注。`nil` = 没有回执计数（**不许**编造"新增 0 条"）。
    static func countsNote(_ counts: BatchCounts?) -> String? {
        guard let counts else { return nil }
        if let inserted = counts.inserted, let unchanged = counts.unchanged {
            if inserted == 0 {
                return "本批 \(inserted + unchanged) 条均为已有记录，没有新增"
            }
            return "本批新增 \(inserted) 条，其余 \(unchanged) 条为已有"
        }
        if let parsed = counts.parsed {
            return "本批 \(parsed) 条（服务端未返回新增计数）"
        }
        return nil
    }

    /// 手动同步收工提示。
    ///
    /// 顺序即优先级：**待续页**排在成败之前 —— 盘上还有没读完的页时，无论这一批成功与否，
    /// 界面都不能说"完成"。
    static func manualResult(
        hasPendingContinuation: Bool,
        hasPendingTask: Bool,
        isCancelled: Bool,
        hasError: Bool,
        succeeded: Bool,
        counts: BatchCounts?
    ) -> String {
        if hasPendingContinuation { return SyncContinuationCopy.manualResult }
        if isCancelled { return "已取消同步。" }
        // "没跑完"与"跑完了但没成功"共用一句：两者都不该被读成成功，而区分它们需要的信息
        // （服务端 job 终态）本来就在 `sync.message` / 失败卡片里，不在这个 4 秒提示里。
        if !succeeded || hasPendingTask || hasError { return "更新尚未完成，可在设置查看状态。" }
        guard let note = countsNote(counts) else { return "健康数据检查完成。" }
        return "健康数据检查完成（\(note)）。"
    }
}

// MARK: - 同步详情页的本批计数（P2-3）

/// 同步详情页的「本批」一行与预算说明（P2-3：只展示，不新增轮询）。
///
/// 预算停因来自 `HealthKitExportResult.BudgetStopReason.rawValue`
/// （`recordPage` / `recordNone` / `routeFile` / `workoutBytes`；`nil` = 没被预算停住）。
///
/// 🔴 `recordNone` 的既有文案是"单条记录放不进本批剩余预算，该类型本轮零进展" —— 它在
/// **满载批**上是误导（那一批明明写了 4500 条）。展示层必须把它读成"本批已满"，而不是
/// "这个类型没有进展"；两份文案的分工写在这里，视图不再自己解释停因。
nonisolated enum SyncExportSummaryCopy {
    /// 本批计数一行。
    static func batchLine(recordCount: Int, workoutCount: Int, routeCount: Int) -> String {
        "本批记录 \(recordCount) 条 · 训练 \(workoutCount) 条 · 路线 \(routeCount) 个"
    }

    /// 预算停因 → 用户能读懂的说明。
    static func budgetNote(budgetStopReason: String?, hasMorePages: Bool) -> String? {
        guard let reason = budgetStopReason else {
            return hasMorePages ? "本批还有剩余页，将继续读取。" : nil
        }
        switch reason {
        case "recordPage":
            return "本批达单批记录页上限，剩余记录下一批继续。"
        case "recordNone":
            return "本批记录条数已满（不是该类型零进展）：剩余记录下一批继续。"
        case "routeFile":
            return "本批路线文件达上限，剩余路线下一批继续。"
        case "workoutBytes":
            return "本批训练体积达上限，剩余训练下一批继续。"
        default:
            return "本批受单批预算限制，剩余数据下一批继续。"
        }
    }

    /// 「还有没读完的页」在详情页的展示口径。
    static func continuationNote(hasPendingContinuation: Bool) -> String? {
        hasPendingContinuation ? "还有未读完的页，会继续读取（关闭 App 也可能被系统接着跑）。" : nil
    }

    /// 满载批的**旧尾注是反话**：「单条记录放不进本批剩余预算，该类型本轮零进展」——
    /// 满载时该类型明明写了 4500 条（`lane-ios.md` §2.1 的算术指纹）。文案源在
    /// `HealthKitSync`（另一条 lane），展示层在这里做一次**定向替换**：不替换的话，用户在
    /// 同一屏里会同时读到「零进展」和「本批已满」两句互相矛盾的结论。
    ///
    /// `hasMorePages == false` 时**原样返回**：那种情形下"该类型零进展"可能是真的
    /// （预算还有余量却一条都放不进），替换掉就是把一句真话改坏。
    static func clarifiedMessage(_ message: String, hasMorePages: Bool) -> String {
        guard hasMorePages else { return message }
        let misleading = "单条记录放不进本批剩余预算，该类型本轮零进展"
        guard message.contains(misleading) else { return message }
        return message.replacingOccurrences(
            of: misleading,
            with: "本批记录条数已满（不是该类型零进展），剩余记录下一批继续"
        )
    }
}
