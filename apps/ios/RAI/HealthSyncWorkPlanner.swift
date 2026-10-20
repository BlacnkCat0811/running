import Foundation

/// R1（2026-10-19 复核）：**同一份待办快照决定"执行什么"与"何时重排"**。
///
/// 存在的理由：旧实现把两件事分别拼装 ——
///   - `BackgroundRunPolicy.action` 的 `wantsFreshSync` 只看通知/恢复请求；
///   - `PendingWork.needsAnotherRound` 却把到期窗口算进去；
///   - `SyncFollowUp.handoff` 又不认识窗口。
/// 三处各算一份，于是"有窗口要重排"与"重排后实际执行窗口"可以同时成立，
/// 后台被派发后不导出、只再次重排，直到窗口过期或别的入口打破条件（R1 活锁）。
///
/// 现在只在这里生成一个 `Action`；前后台两条执行路径与后台重排都消费它。
/// 判据是纯函数：`BackgroundSyncPolicyRegression` 逐格钉住。
nonisolated enum HealthSyncWorkPlanner {
    /// 这一轮导出的**原因**。写进日志与重排判据，不许调用方再用布尔反推。
    enum ExportReason: String, Equatable, Sendable, CaseIterable {
        /// 有一条真实的 HealthKit 通知 / scope 恢复请求没被覆盖。
        case newDelivery = "new_delivery"
        /// 正式记录流的待续页（上一批被单批预算截断）。
        case regularContinuation = "regular_continuation"
        /// 已确认位置之后还有窗口类型页要读。
        case workoutPage = "workout_page"
        /// 到期窗口需要探一次迟样本。
        case workoutProbe = "workout_probe"
    }

    /// 统一的执行计划。`deferUntil` 不等于 `idle`：前者保留一个**未来**复查时刻，
    /// 后者才是真的没事可做。
    enum Action: Equatable, Sendable {
        /// 盘上有可恢复的任务行：按原任务接续，不重新导出。
        case resumeExistingTask
        /// 需要一次导出；原因决定这一轮该不该扣"新代次"额度。
        case export(ExportReason)
        /// 现在不导出，只在 `date` 安排一次既有后台机制（不新增定时器）。
        case deferUntil(Date)
        /// 锁屏 / 凭证等外部阻塞：不做注定失败的导出，但待办原样保留。
        case blocked
        /// 确认没有任何依据。
        case idle
    }

    /// 唯一的执行计划生成点。优先级 = §8.2 的七条（任务 → 阻塞 → 新代次 → 窗口页/探测 →
    /// 正式流续页 → 未来探测 → 空闲）。
    ///
    /// - Parameters:
    ///   - pending: 按目标现读的只读快照（`HealthKitSync.probePendingWork`）。
    ///   - hasTask: 盘上是否真有任务行（快照的 `.pending` 判定就是它，但调用方可能已经在
    ///     后台路径里读到了同一信息；两者必须一致，测试逐组合钉住）。
    ///   - isBlocked: 这一轮是否卡在锁屏/凭证阻塞态（后台 `performBackgroundPass` 的早退判据）。
    static func plan(
        pending: HealthSyncBackgroundRecovery.PendingWork,
        hasTask: Bool,
        isBlocked: Bool,
        now: Date
    ) -> Action {
        // 阻塞态：不做注定失败的导出，也不允许把待办当成"没有"。
        if isBlocked { return .blocked }
        // 有任务行 ⇒ 永远按原任务接续（重新导出会换 payloadHash/batchId，服务端会多一份来源）。
        if hasTask { return .resumeExistingTask }
        // 读盘失败（`.unknown` / 窗口表读不出来）不能退化成空闲：保守方向是多跑一轮。
        if pending.verdict == .unknown || pending.workoutWindow.readFailed {
            return .export(.newDelivery)
        }
        if pending.hasUncoveredGeneration { return .export(.newDelivery) }
        if pending.workoutWindow.immediatePageCount > 0 { return .export(.workoutPage) }
        if pending.workoutWindow.dueProbeCount > 0 { return .export(.workoutProbe) }
        // 正式记录流待续排在窗口之后：窗口服务的是"刚跑完的训练"，而续页是历史重放，
        // 两者都不允许互相饿死（批内份额由 `DirectSyncBatchBudget` 决定）。
        if pending.hasPendingContinuation { return .export(.regularContinuation) }
        if pending.hasUnfinishedWork { return .export(.newDelivery) }
        if let next = pending.workoutWindow.nextProbeAt {
            // 只有未来探测 ⇒ 现在不导出；把时刻交给调用方安排既有 BGTask。
            return next > now ? .deferUntil(next) : .export(.workoutProbe)
        }
        return .idle
    }
}
