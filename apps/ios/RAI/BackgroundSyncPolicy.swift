import Foundation

/// 后台三机制用到的**跨文件常量**。
///
/// 为什么必须集中：`BGTaskScheduler` 的 identifier 会被复制到三个彼此看不见的地方 ——
/// `Info.plist` 的 `BGTaskSchedulerPermittedIdentifiers`、`register(forTaskWithIdentifier:)`
/// 的调用点、`submit(BGProcessingTaskRequest(identifier:))` 的调用点。任一处写错的表现都
/// 不是报错，而是**注册不上**（系统直接抛 `notPermitted`）或**提交了个没人认领的请求**
/// （静默丢弃）。集中成常量后，门禁才有唯一的东西可以对账：
/// `check-background-capabilities.py` 会把这里的字面量拿去 `Info.plist` 里找。
nonisolated enum RaiBackgroundSync {
    /// `BGProcessingTask` 的 identifier。必须与 `Info.plist` 逐字一致。
    ///
    /// 用 `processing` 而不是 `apprefresh`：要搬运的是几个 GB 的导出包，
    /// `BGAppRefreshTask` 的额度是秒级，只能用来自曝"任务没做完"。
    static let taskIdentifier = "app.rai.running.health-sync"

    /// background `URLSession` 的 identifier。必须与 `Info.plist` 的
    /// `UIBackgroundModes`（`processing`）以及 `application(_:handleEventsForBackgroundURLSession:)`
    /// 里读出来的 identifier 一致。
    ///
    /// 与 `taskIdentifier` 分开而不是共用一个字符串：一个是"给我几分钟 CPU"，
    /// 一个是"把这段字节搬完"，系统的记账单位不同，混用会让日志里的两件事看起来是一件事。
    static let uploadSessionIdentifier = "app.rai.running.health-sync.upload"
}

/// HealthKit 投递唤醒到达时，这次唤醒该做什么。
///
/// **它是触发器，不是执行者。** iOS 给观察者回调的预算约 15 秒，而一次导出是"读 HealthKit
/// 全量改动 + 打包几个 GB"，量级差了三个数量级。所以这里只做决策：要么当场（前台）跑，
/// 要么记下意图、请求一次 `BGProcessingTask`，让系统在它自己挑的时刻给足预算。
nonisolated enum SyncDeliveryPolicy {
    enum Decision: Equatable {
        /// App 在前台：直接同步，不需要任何后台机制。
        case syncNow
        /// 记下"有新数据待同步"，并**立刻**请求一次后台执行。
        case deferToBackground
        /// 记下"有新数据待同步"，但**这一轮不跑**：已有同步在跑（单飞闸门被占），或还在
        /// 后台节流窗口内。区别只在"下一次执行排到什么时候"（`BackgroundRunPolicy.resubmitDelay`），
        /// 不在"这条变化记不记"。
        case deferToBackgroundLater
        /// 这次唤醒**没有目标**（未绑定服务端）：既没有东西可跑，也没有目标能消费一条意图。
        case ignore

        /// 这次唤醒里有没有一件"必须先被记下来"的事。
        ///
        /// 🔴 **只有未绑定是"不必记"的。** 单飞与节流限制的是"这一轮要不要现在跑"，不是
        /// "这条变化要不要留下"。把两者混成一个 `ignore`（旧版就是直接 `break`）的后果是：
        /// 这条通知既没有代次、也不会驱动任何后续轮次 —— 旧批次收工清空之后，后台按快照判
        /// "无待办"，自动同步停在原地，直到下一次投递、打开 App 或用户手动点同步。
        /// 代次确认（`shouldAcknowledgeIntent`）保护的是**已经记下来**的那一代，保护不了
        /// 被直接丢掉的那一代。
        var recordsTheDelivery: Bool { self != .ignore }
    }

    /// 后台投递唤醒之间的最小间隔。**与前台 `HealthKitSync.autoSyncInterval` 同一个值**。
    ///
    /// 为什么必须节流：一次健康数据聚合更新会**连发多个类型**的观察者回调（跑步、睡眠、
    /// HRV、静息心率各一条），每条都会唤醒一次。不节流的话后台会在几分钟内反复打包同一份
    /// 内容上传 —— 服务端的 `import_upload_busy` 会挡掉大部分，但那已经是"用服务端当限流器"。
    static let throttle: TimeInterval = 15 * 60

    /// 这次投递唤醒的处置。
    ///
    /// 判据顺序（越靠前越先过滤）：
    ///   1. 未绑定服务端 ⇒ `.ignore`。**这是唯一不记意图的分支**：没有目标，意图也没有
    ///      任何东西能消费它。
    ///   2. 🔴 **已有同步在跑 ⇒ `.deferToBackgroundLater`，不是 `.ignore`。**
    ///      `HealthSyncTaskOwner` 以 `task == nil` 单飞，重复进入会被静默拒绝，所以这一轮
    ///      确实不该跑。但正在跑的那一轮的**导出起点早于这条通知**，它的字节覆盖不到这次
    ///      变化 —— 直接丢掉等于把这条通知从盘上抹掉，于是它既没有代次、也不会驱动任何
    ///      后续轮次，旧批次收工清空之后后台判定"无待办"，自动同步停在原地。
    ///   3. 前台 ⇒ `.syncNow`。前台不加节流：用户正看着界面，节流的代价是他点了同步却没反应。
    ///   4. 🔴 **有在途批次 ⇒ 立刻 `.deferToBackground`，不看节流。**
    ///      这条是本节最容易写错的地方。节流回答的是"要不要**再拉一次新数据**"，
    ///      而盘上卡着一批未走完的字节时，问题已经不是"要不要刷新"而是"这批怎么收尾"。
    ///      把节流放在它前面，后果是切后台那一刻刚被中断的批次，要等满 15 分钟才有人管。
    ///   5. 刚同步过 ⇒ `.deferToBackgroundLater`。注意这里**也不是** `.ignore`：节流能决定的
    ///      只是"现在不跑"，而"这一轮覆盖不到的那一代"必须留到下一次执行（`resubmitDelay`
    ///      之后由后台接手）。
    ///   6. 其余 ⇒ `.deferToBackground`。
    static func decide(
        isForeground: Bool,
        isBound: Bool,
        isSyncRunning: Bool,
        hasPendingTask: Bool,
        lastSyncAt: Date?,
        now: Date
    ) -> Decision {
        guard isBound else { return .ignore }
        guard !isSyncRunning else { return .deferToBackgroundLater }
        if isForeground { return .syncNow }
        if hasPendingTask { return .deferToBackground }
        if let lastSyncAt, now.timeIntervalSince(lastSyncAt) < throttle { return .deferToBackgroundLater }
        return .deferToBackground
    }
}

/// 一轮同步收工之后，"**这一轮没有覆盖到的那一代**"该由谁接手。
///
/// 为什么单独立一条判据：代次确认（`shouldAcknowledgeIntent`）只负责**留下**导出起点之后
/// 到达的通知（代次比对决定它不会被本轮吞掉），而"留下来"与"有人来接"是两件事。少了接手的
/// 这一方，那条通知会一直躺在盘上，直到下一次切后台或下一次投递 —— 表现就是报告里那句
/// "自动同步停在原地，直到再次通知、打开 App 或手动同步"。
///
/// 判据只在两个维度上取值：
///   - **有没有未覆盖的代次**：没有就什么都不做（这是前台自旋唯一的入口）；
///   - **在不在前台、还有没有补跑额度**：前台优先当场补跑（用户正看着界面，把新数据拖到
///     下一次切后台等于让他盯着旧数字），其余交给后台执行。
nonisolated enum SyncFollowUp {
    /// 一轮收工后最多在**前台**再补跑几轮。
    ///
    /// 🔴 **必须有上限。** HealthKit 在一次大批导入期间会连发投递，每一轮导出都可能被新的
    /// 投递甩在后面；没有上限的话"补跑"会退化成前台自旋 —— 而每一次自旋都是一轮 GB 级导出。
    /// 超出额度的那一代交给后台的 `BackgroundRunPolicy.resubmitDelay` 兜着（关掉 App 之后照跑）。
    ///
    /// 口径：**新代次**（`hasUncoveredGeneration`）专用。待续页另有独立额度
    /// （`maxForegroundContinuationRounds`）—— 两者是不同的事，合成一份会让
    /// "12,000 条积压"的第二、三页拿不到额度（那是常见路径），也会让新代次的防自旋护栏
    /// 被页循环吃掉。
    static let maxForegroundRounds = 1

    /// 一轮收工后，**只因为"自己没读完"（待续页）**而允许的前台续跑轮数（S2.3）。
    ///
    /// 有界性的依据：每轮至少消费 1 整页（预算在页末尾检查，见 `HealthKitRecordCursor.drain`），
    /// 时间上界 ≈ 本额度 × 单页导出成本；读不完的部分与既有路径同源交给后台兜底
    /// （`needsAnotherRound` 会因待续标记继续为真）。
    static let maxForegroundContinuationRounds = 3

    enum Handoff: Equatable {
        /// 这一轮已经把盘上的代次都覆盖了 ⇒ 什么都不做。
        case nothing
        /// 前台且还有额度 ⇒ 立刻再跑一轮。
        case runAgain
        /// 交给后台执行（不在前台，或前台额度已用完）。
        case scheduleBackground
    }

    /// - Parameters:
    ///   - hasUncoveredGeneration: 有新代次（通知 / scope 恢复请求）没被覆盖。
    ///   - hasPendingContinuation: 上一批还有**未读完的页**（`PendingWork.hasPendingContinuation`）。
    ///   - foregroundRoundsLeft: 新代次的前台补跑额度（从 `maxForegroundRounds` 起算）。
    ///   - continuationRoundsLeft: 待续页的前台续跑额度（从 `maxForegroundContinuationRounds` 起算）。
    ///
    /// 🔴 判定的优先级 = 新代次优先用**自己的**额度：两者同时挂起时先按新代次扣账，
    /// 额度尽后若待续页仍悬着再落到续页额度 —— 每个分支都对应"这一轮到底为什么还要跑"，
    /// 调用方据此扣**对应**的计数器（见 `AppDelegate.handOffUncoveredGenerations`）。
    static func handoff(
        hasUncoveredGeneration: Bool,
        hasPendingContinuation: Bool,
        isForeground: Bool,
        foregroundRoundsLeft: Int,
        continuationRoundsLeft: Int
    ) -> Handoff {
        guard hasUncoveredGeneration || hasPendingContinuation else { return .nothing }
        guard isForeground else { return .scheduleBackground }
        if hasUncoveredGeneration { return foregroundRoundsLeft > 0 ? .runAgain : .scheduleBackground }
        return continuationRoundsLeft > 0 ? .runAgain : .scheduleBackground
    }
}

/// `BGProcessingTask` 真的跑起来之后，这一轮该推进到哪一步。
///
/// **它是主载荷，不是兜底。** 分工（计划 §9 的四机制表）：HealthKit delivery 负责"知道有变化"，
/// `beginBackgroundTask` 负责"让快完成的那一步跑完"，background URLSession 负责"字节的搬运"，
/// 只有这里是"给几分钟 CPU 做完整件事"。
nonisolated enum BackgroundRunPolicy {
    enum Action: Equatable {
        /// 没有可续接的工作，也没有待同步的意图 ⇒ 立刻报成功收工。
        case nothingToDo
        /// 这一批的字节**已经归系统所有**（background URLSession 还挂着它）⇒ 不碰、不等。
        case awaitSystemUpload
        /// 盘上有可续接的批次 ⇒ 按 `SyncAtomicUnit` 推导的下一步推进（可能是导出）。
        case runAtomicUnit
        /// `jobId` 已落盘（服务端在算）⇒ 续接结果。**这一条允许跨会话**。
        case resumeJob
        /// 没有任何批次，但有"新数据待同步"的意图 ⇒ 从零开始一次同步。
        case startFreshSync
    }

    /// 后台运行的软预算（秒）。**这是参数，不是验收标准。**
    ///
    /// 系统的真实额度不可读（文档口径只有"minutes"，且随设备状态变化），所以这里只是"我方"
    /// 的上限：超过它就当作"这一步这次做不完"，把持久化字段留在可续接的位置交给下次唤醒。
    /// 为什么不留到系统真的来杀：被杀与主动收手在持久化层面的后果不同 —— 前者可能在
    /// 写完一半 multipart 时断电，后者保证收在一个 `SyncAtomicUnit` 认得出来的状态。
    static let softBudget: TimeInterval = 120

    /// 留给"写盘 + 回调 + `setTaskCompleted`"的余量。
    static let reserveForPersistence: TimeInterval = 20

    /// 这一轮该做什么。判据顺序就是优先级。
    ///
    /// 🔴 **一次后台运行只推进一个批次。**
    ///
    /// `jobId` 最先判：它意味着服务端已经在算这一批。此时即便本地还有字节没传完，也不该
    /// 另起一炉 —— 新一次导出会算出**新的** `payloadHash`，也就是新的 batchId、新的
    /// `import_sources` 记录、新的 job。服务端的 `import_upload_busy` 只挡上传互斥的那一瞬，
    /// 挡不住"两个 job 交替跑"。所以"续接旧的"与"发起新的"在**同一个批次内**互斥，
    /// 而这正是"一次只推进一个批次"的落地形态。
    ///
    /// 🔴 同理：**只要盘上有持久化任务行，就永远不会返回 `.startFreshSync`。**
    /// 任务行的存在本身就说明"有一个批次还没走完"，而重新导出的代价不只是几分钟 CPU ——
    /// 新的 HealthKit 导出会写新的 `ExportDate`，于是 `payloadHash` 变了、batchId 变了，
    /// 服务端上那半批数据的幂等键失去意义，结果是**两份来源、两个 job**。
    /// 想重新导出只有一个合法入口：用户显式点「重新导入全部」。
    /// 这条不变式由回归在全参数组合上钉死（`BackgroundSyncPolicyRegression`）。
    ///
    /// 第二条与第三条的顺序同理：字节归系统时（`hasBackgroundUploadTask`）连 `inspect`
    /// 都不做 —— `inspect` 读的是服务端那份来源，而它此刻可能正被写入。等 delegate 回调，
    /// 到那时 `sourceId` 才落盘，`inspect` 才有意义。
    static func action(
        hasTask: Bool,
        jobId: String?,
        hasBackgroundUploadTask: Bool,
        wantsFreshSync: Bool
    ) -> Action {
        if let jobId, !jobId.isEmpty { return .resumeJob }
        if hasTask {
            if hasBackgroundUploadTask { return .awaitSystemUpload }
            return .runAtomicUnit
        }
        return wantsFreshSync ? .startFreshSync : .nothingToDo
    }

    /// 这一轮后台运行是否已经该主动收手。
    ///
    /// `budget` 做成参数（而不是直接读 `softBudget`）是为了让回归能用秒级预算把边界跑出来；
    /// 断言写在"给定预算下 `shouldYield` 的返回值"，不写在 `softBudget == 120` 上 ——
    /// 那个数字是拍的参数，钉死它只会让以后调参的人以为门禁坏了。
    static func shouldYield(
        startedAt: Date,
        now: Date,
        budget: TimeInterval = softBudget,
        reserve: TimeInterval = reserveForPersistence
    ) -> Bool {
        now.timeIntervalSince(startedAt) >= budget - reserve
    }

    /// 后台**轮询**该不该把这一轮让出去 —— 软预算的真正接入点。
    ///
    /// 为什么单独一条、而不是到处直接判 `shouldYield`：软预算**能不能**生效，取决于当前
    /// 处在流程的哪一段。轮询是"等服务端算"，放弃是**零代价**的（`jobId` 已落盘，下一次
    /// 唤醒走 `.resumeJob` 从同一处续接）；而导出与上传被中断要从头再来（GB 级 HealthKit
    /// 导出是整个流程里最贵的一步）。所以软预算只接在轮询上，不接在导出/上传上 ——
    /// 在那里"主动收手"不是保守，是自伤。
    ///
    /// 为什么还要 `isBackground`：前台没有系统额度限制，`softBudget` 只是"我方"给后台拍的
    /// 一个上限。拿它在**前台**掐掉用户正看着的那一次同步，就是把参数当成了策略。
    static func shouldYieldPolling(
        isBackground: Bool,
        backgroundStartedAt: Date?,
        now: Date
    ) -> Bool {
        guard isBackground, let backgroundStartedAt else { return false }
        return shouldYield(startedAt: backgroundStartedAt, now: now)
    }

    /// 这一轮该向系统报"成功"还是"失败"。
    ///
    /// 判据是**收工时盘上还有没有未走完的工作**，不是"这一轮跑没跑起来"。
    ///
    /// 为什么不能用"跑没跑起来"：`HealthSyncTaskOwner` 以 `task == nil` 单飞，与前台同步
    /// 撞车时这一轮会被**静默拒绝**。那一刻报成功等于对系统撒谎 —— 系统据此认为这个 App
    /// 的后台预算够用，以后照常派活，而每次派活都撞在同一个闸门上。
    ///
    /// 反过来说，"批次还在（例如服务端 job 还在算）"报 `false` 也不吃亏：
    /// `BGTaskScheduler` **不会因为 `false` 自动重试**，这个值只进系统遥测。
    /// 真正决定"还会不会再跑一次"的是 `shouldResubmit`。
    ///
    /// 🔴 **入参是快照，不是全局标志。** `HealthKitSync.hasPendingTask` 是展示层的字段，
    /// 它属于**最后一次**写它的那次同步；而单飞被拒的一轮恰恰什么都没碰过。用全局标志回答
    /// "这一轮该报什么"就是拿别人的结论给自己打分。快照还必须能表达第三种答案
    /// （`PendingWork.Verdict.unknown`）—— 读盘失败或归属不明时它**不许**报成功，
    /// 否则盘上那一批就再也没人管了。
    static func reportedSuccess(_ pending: HealthSyncBackgroundRecovery.PendingWork) -> Bool {
        pending.reportsSuccess
    }

    /// 收工时要不要再排一次后台执行。
    ///
    /// 🔴 `BGTaskScheduler` 的请求是**一次性**的：跑完就没了，系统不会自动重试。
    /// 所以"这一轮没做完"必须由我们自己再 `submit` 一次，否则剩下的活儿要等到用户下次
    /// 打开 App —— 那等于三机制白装。同一 identifier 只保留一个待发请求，重复 submit
    /// 不会堆积，所以"切后台时也 submit 一次"是安全的。
    ///
    /// 入参同样是**按目标读到的快照**，理由与 `reportedSuccess` 相同。
    static func shouldResubmit(_ pending: HealthSyncBackgroundRecovery.PendingWork) -> Bool {
        pending.needsAnotherRound
    }

    /// 下一次后台执行请求的 `earliestBeginDate` 相对现在的最小延迟（秒）。
    ///
    /// 不设它等于"越快越好"，系统可能几十秒后就派活 —— 而这一轮刚因为服务端 5xx / 断网
    /// 失败，紧接着再跑一次只会拿到同样的结果。设一个最小间隔，既表达"还需要再来一次"，
    /// 又不把后台预算浪费在重放同一个错误上。
    static let resubmitDelay: TimeInterval = 15 * 60

    /// 下一次 `submit` 该填的 `earliestBeginDate`。
    static func earliestBeginDate(now: Date, after delay: TimeInterval = resubmitDelay) -> Date {
        now.addingTimeInterval(delay)
    }
}

/// 「系统手上那个上传任务，还要不要留」。
///
/// 调用时机只有一处：我方准备发起（或重新打算发起）一次上传之前，由
/// `RaiBackgroundUploadSession.reattachOrphans` 对 `getAllTasks` 的结果逐个过一遍。
///
/// 🔴 判据是「**本进程还在等它的结局吗**」，不是「它属于哪一批」。为什么后者不行 ——
/// 那是我方**观测不到**的差距，不是保守程度的选择：
///   - 服务端没有"按批次 id 查来源"的接口（`sourceByIdempotencyKey` 只在 `saveUpload` 内部用，
///     `import-routes.ts` 的端点里一个都不暴露它；`GET /v1/import-sources/recent` 又只返回
///     `lastUsedAt != null` 的来源，而"已上传未导入"恰好是 `null`）⇒ 上一个进程那次上传的
///     **结局拿不回来**，`sourceId` 只能靠**重传同一份字节**让服务端幂等命中
///     （`saveUpload:323-331` 按归档字节比对，命中则返回**同一条**来源）。
///   - 既然横竖要重传，留着一个仍在跑的上传只会让**两份同样的字节同时**打向服务端，其中一份
///     必然撞上 `import_upload_busy`（429）—— 用服务端当限流器，而且多占一倍的带宽。
/// ⇒ 留下的收益是零，代价是一份重复流量。所以"没人等它"一律取消。
///
/// 反过来，"还在等它结局"的任务一根手指都不许碰：取消它才是真的丢东西（那次同步正挂在
/// 那个 continuation 上）。
nonisolated enum BackgroundUploadReattach {
    enum Disposition: Equatable {
        /// 本进程正等着它的结局 ⇒ 不动它。
        case keep
        /// 没人在等（别的进程留下的，或本进程已经放弃等待的）⇒ 取消。
        case cancelOrphan
    }

    /// - Parameter isAwaitedInThisProcess: `RaiBackgroundUploadSession` 里 `waiters` 是否有这条。
    ///   ⚠️ 刻意不是"`descriptions` 里有没有这条"：`descriptions` 说的是"系统正在为这一批搬字节"，
    ///   而生命周期中止之后那件事**仍然成立**（字节还在走）、只是**没人在等结局**了
    ///   —— 后者才是这里要问的。混用会让"中止之后重进一次同步"变成两份字节同时在传。
    static func disposition(isAwaitedInThisProcess: Bool) -> Disposition {
        isAwaitedInThisProcess ? .keep : .cancelOrphan
    }

    /// 🔴 **这不是判据**，两种取值下的动作都是取消。留在这里是因为它决定**重传的代价**：
    ///
    ///   - 命中（`true`）：服务端走幂等分支，只把同样的字节再收一遍，**不新建来源**；
    ///   - 不命中（`false`）：服务端新建一份来源，而那份来源在旧批次被放弃后**永远不会有人来取**
    ///     （要靠 24h TTL 回收，`ABANDONED_UPLOAD_TTL_MS`）。
    ///
    /// 真机验收（计划 §11.3）要靠这个数把「白传了一次字节」与「服务端多了一份垃圾」分开 ——
    /// 这两种现象在只看日志的情况下长得一模一样。
    ///
    /// 两侧任一为 `nil` 一律判**不命中**：`taskDescription` 在进程重启后是否仍可读，本仓无法从
    /// 代码断言（计划 §15 第 2 条）。不命中只是把口径记得悲观一点，不改变任何动作。
    static func matchesCurrentBatch(taskDescription: String?, currentPayloadHash: String?) -> Bool {
        guard let taskDescription, let currentPayloadHash else { return false }
        return taskDescription == currentPayloadHash
    }
}

/// 一次「系统在搬字节」的盘点结果。只有**诊断**用途。
///
/// 为什么不是 `[Int]`（任务 id 列表）：调用方（`HealthKitSync`）拿那些 id 什么也做不了 ——
/// 判据是"本进程还在不在等它结局"（`BackgroundUploadReattach`），而盘上那一行不会因此改变。
/// 真机验收（计划 §11.3）要的只是几个计数：系统到底把几个任务重挂起来了、其中几个是当前批次。
///
/// 🔴 **它必须住在这个文件里，不能住进 `BackgroundUploadSession.swift`。** 那边的类型被
/// `#if os(iOS)` 包住、且要真实 `URLSession` 才跑得起来，于是判据就只能靠人眼读；
/// 这里平铺在 `apps/ios/RAI/` 下，落在 `run-health-sync-tests.sh` 编译的单元里，`foundAny`
/// 这类会被验收当证据用的派生量才有执行者。
nonisolated struct BackgroundUploadReattachReport: Equatable {
    /// 本进程正等着结局、因此没被动过的任务数（`disposition` 的 `.keep`）。
    ///
    /// 正常情况下是 0：能走到盘点这一步就说明上一次同步已经收尾了。非 0 只出现在
    /// "后台一轮撞见前台同步正在传"那一态，而那一态正是 `.awaitSystemUpload` 唯一的来源。
    var keptAwaited = 0
    /// 被取消的、属于盘上那一批的任务数（⇒ 重传会命中服务端幂等分支，`matchesCurrentBatch`）。
    var cancelledCurrentBatch = 0
    /// 被取消的、属于别的批次（或认不出批次）的任务数（⇒ 服务端会多出一份没人来取的来源）。
    var cancelledOthers = 0

    /// 系统手上到底有没有留下传输。给真机验收当证据用。
    var foundAny: Bool { keptAwaited + cancelledCurrentBatch + cancelledOthers > 0 }
}
