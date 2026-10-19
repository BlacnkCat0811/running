import Foundation

/// `SyncDeliveryPolicy` / `BackgroundRunPolicy` / `SyncFollowUp` 的回归。
///
/// 钉的是那些**改错了照样编译通过、肉眼也看不出来**的判据：
///
///   1. 未绑定服务端 ⇒ 这次唤醒一律 `.ignore`。这是**唯一**不记意图的分支：没有目标，
///      意图也没有任何东西能消费它；
///   2. 前台不加节流；
///   3. 🔴 **有在途批次 ⇒ 立刻放行，不看节流** —— 节流回答的是"要不要再拉一次新数据"，
///      而盘上卡着一批未走完的字节时问题不是刷新而是收尾；
///   4. 首次唤醒（`lastSyncAt == nil`）不被节流挡掉；
///   5. `jobId` 优先于一切，包括"系统还挂着上传"；
///   6. 字节归系统所有时连 `inspect` 都不做；
///   7. 🔴 **只要盘上有持久化任务，`action` 的取值被一张十二行表完全钉死，表里没有
///      `.startFreshSync`、也没有 `.nothingToDo`**（重导出会改 `payloadHash` ⇒ 幂等键失效
///      ⇒ 服务端多一份来源）；
///   8. 软预算留出持久化余量；
///   9. 两个 identifier 的字面量被钉住（它们会被复制进 `Info.plist`，改名不会报错，只会
///      注册不上）；
///  10. 报给系统的成败看"**按目标现读的快照**里还有没有没走完的工作"，**不是**"这一轮跑没跑起来"，
///      也不是"上一次同步写下的展示标志"（后者属于别的目标）；
///  11. 请求是一次性的 ⇒ `shouldResubmit` 必须自己把没做完的活儿再排一次（快照说"不知道"时也算）；
///  12. 🔴 系统重挂起来的传输**只在本进程正在等它时**才留（判据不是"它属于哪一批"——
///      上一个进程那次上传的结局拿不回来，留着一个仍在跑的上传只是多一倍重复流量）；
///  13. 🔴 **已有同步在跑 ⇒ `.deferToBackgroundLater`，不是 `.ignore`**。正在跑的那一轮的
///      导出起点早于这条通知，它的字节覆盖不到这次变化 —— 丢掉它，那条通知就既没有代次、
///      也不会驱动任何后续轮次，旧批次收工清空之后自动同步停在原地（P1 可达性缺陷）；
///  14. 🔴 **节流窗口内的投递同样只限制"现在跑"，不限制"记住"**（同上）。单飞与节流回答的
///      都是"这一轮要不要现在跑"，而"要不要留下这条变化"的答案只有未绑定才是"不留"；
///  15. 🔴 **一轮收工后，"没被覆盖到的那一代"必须有人接手**（`SyncFollowUp`），且**前台补跑
///      有硬上限**（`maxForegroundRounds`）—— HealthKit 大批导入期间会连发投递，没有上限的
///      "补跑"就是前台自旋，每次自旋都是一轮 GB 级导出；
///  16. `PendingWork.hasUncoveredGeneration`（通知 + 恢复请求）与 `needsAnotherRound`
///      （再加上"盘上卡着一批"）是两件事：混用会让一次网络失败之后，前台立刻重放同一个失败请求；
///  17. 🔴 **软预算只接在后台轮询上，且只在后台生效**（`shouldYieldPolling`）。接错位置的两个
///      方向都是自伤：接到导出/上传上会让一次没跑完的 GB 级导出自断重来（永远做不完），
///      漏掉 `isBackground` 会掐掉用户正看着的那次前台同步。
///  18. 🔴 **A8（2026-10-19 复核）：观察者回调必须"先落耐久意图、再 `completion()`"**，且
///      写失败 / 还没有目标 / scope 非法这三条分支下 `completion()` **仍然恰好一次**。
///      顺序判据不是"源码里谁在前"（那只能靠肉眼），而是**在 `completion()` 内部用导出侧的
///      读法去读那条意图** —— 读得到才算 durable。代价是静默的：HealthKit 收到回执后投递
///      不会重放，那批健康数据只能等下一次唤醒（`HealthSyncObserverIntentHandoff`）。
///
/// 之所以要有这个可执行文件：`HealthKitSync.swift` 与 `RAIApp.swift`/`AppDelegate.swift`
/// 都不被任何回归脚本编译（前者只被 `typecheck-ios.sh` 类型检查，后两个连同被
/// `typecheck-ios.sh:102` 排除），判据若留在它们里面就没有执行者。
/// `BackgroundUploadSession.swift` 同样：它 `#if os(iOS)` 包裹且要真实 `URLSession` 才能跑，
/// 所以它的判据在能搬出去的地方就必须搬出去。
@main
struct BackgroundSyncPolicyRegression {
    private static let now = Date(timeIntervalSince1970: 1_780_000_000)

    /// 构造一份**按目标读到的**待办快照。字段值除了 `verdict` 与三个成因位以外都不参与判据，
    /// 所以钉死成常量即可。
    private static func pending(
        verdict: HealthSyncBackgroundRecovery.PendingWork.Verdict,
        hasIntent: Bool = false,
        hasRecoveryRequest: Bool = false,
        hasPendingContinuation: Bool = false,
        hasDueWorkoutWindow: Bool = false
    ) -> HealthSyncBackgroundRecovery.PendingWork {
        HealthSyncBackgroundRecovery.PendingWork(
            serverURL: "http://127.0.0.1:8787",
            urlScope: "urlscope0000000000000000",
            scope: "syncscope000000000000000",
            verdict: verdict,
            hasIntent: hasIntent,
            hasRecoveryRequest: hasRecoveryRequest,
            hasPendingContinuation: hasPendingContinuation,
            hasDueWorkoutWindow: hasDueWorkoutWindow
        )
    }

    static func main() throws {
        try unboundDeliveriesAreIgnored()
        try aDeliveryDuringARunningSyncIsNeverDropped()
        try aThrottledDeliveryIsStillRemembered()
        try foregroundDeliveryIsNeverThrottled()
        try pendingTaskBypassesThrottle()
        try freshDeliveryIsThrottled()
        try firstEverDeliveryIsNotThrottled()
        // 🔴 下面四条的**顺序是有意的**，别按字母或"逻辑分组"重排：
        // 它们断言的是同一个函数 `action` 在不同输入上的行为，而一条突变常常会同时踩到
        // 两条以上的断言。顺序决定"红在哪一条上"，也就是决定失败信息能不能指出真正被改坏
        // 的那条判据。每条突变只允许被**它自己那一条**抓住 —— 这正是
        // `check-background-mutations.py` 要求 `assertion_hit=True` 的用意。
        try systemOwnedUploadIsNotTouched()
        try jobResumptionOutranksEverything()
        try aTaskRowNeverStartsAFreshExport()
        try noTaskFollowsTheRecordedIntent()
        try noTaskFollowsTheContinuation()
        try budgetReservesTimeForPersistence()
        try softBudgetOnlyYieldsBackgroundPolling()
        try successIsReportedFromTheRemainingWork()
        try unfinishedWorkResubmitsItself()
        try uncoveredGenerationsAreHandedOff()
        try pendingContinuationGetsItsOwnBudget()
        try foregroundContinuationWaveIsTimeBounded()
        try identifiersAreStableAndDistinct()
        try systemReloadedUploadsAreOnlyKeptWhenTracked()
        // 放在最后：这三条钉的是**回调内部**的顺序与失败处置（A8），与上面的调度判据没有
        // 共享输入。放前面会让"某条调度判据被改坏"先红在这几条上，失败信息就指错了地方。
        try observerIntentIsPersistedBeforeCompletion()
        try observerIntentFailureStillCompletesAndIsCounted()
        try observerIntentNeverWritesAnotherTargetsScope()
        print("Background sync policy regression tests passed")
    }

    /// 🔴 契约 13/16：**未绑定服务端是唯一"不记意图"的分支**，且这时无论单飞闸门什么状态
    /// 都只有 `.ignore` 一种处置（没有目标 ⇒ 意图没有东西能消费，跑也没有目标可跑）。
    ///
    /// 判据以表格形式写出来（而不是拿实现推一遍），唯一的价值就是它能与实现**不一致**。
    private static func unboundDeliveriesAreIgnored() throws {
        // `recordsTheDelivery` 与 `decide` 是两处判断，配对关系必须逐格钉住：
        // 判据错位的两个方向都是静默的 —— 少记一次（丢一条变化）或多记一次
        // （往一个不存在的目标上写意图，而它永远不会被任何一轮消费）。
        let cases: [(bound: Bool, running: Bool, expected: SyncDeliveryPolicy.Decision)] = [
            (false, false, .ignore),
            (false, true, .ignore)
        ]
        for row in cases {
            let decision = SyncDeliveryPolicy.decide(
                isForeground: false,
                isBound: row.bound,
                isSyncRunning: row.running,
                hasPendingTask: true,
                lastSyncAt: nil,
                now: now
            )
            try require(
                decision == row.expected,
                "unbound=\(row.bound) running=\(row.running) decided \(decision) instead of \(row.expected)"
            )
            try require(
                !decision.recordsTheDelivery,
                "a delivery for a target that does not exist was recorded as a pending intent"
            )
        }
        // 反过来逐格钉住三种**已绑定**的处置都必须被记下来（未绑定那两格上面已经钉过）。
        for decision in [
            SyncDeliveryPolicy.Decision.syncNow,
            .deferToBackground,
            .deferToBackgroundLater
        ] {
            try require(
                decision.recordsTheDelivery,
                "\(decision) would drop a delivery for a target that is bound"
            )
        }
    }

    /// 🔴 契约 13：**已有同步在跑 ⇒ 记下意图、延后排一轮，绝不 `.ignore`。**
    ///
    /// 这条钉的是一次真实的可达性缺陷（报告 P1）：正在跑的那一轮的**导出起点早于这条通知**，
    /// 它的字节覆盖不到这次变化；而 `.ignore` 既不写代次、也不会驱动任何后续轮次 ⇒ 旧批次
    /// 收工清空之后，后台按快照判定"无待办"，自动同步停在原地，直到下一次投递、打开 App 或
    /// 用户手动点同步。前半条（不重复进入）仍然是单飞要求，不能因为"要记住"而放开。
    private static func aDeliveryDuringARunningSyncIsNeverDropped() throws {
        // 前台与后台各一格：单飞闸门与"在不在前台"是两件事，处置都必须落在同一格上。
        for isForeground in [true, false] {
            try require(
                SyncDeliveryPolicy.decide(
                    isForeground: isForeground, isBound: true, isSyncRunning: true,
                    hasPendingTask: false, lastSyncAt: nil, now: now
                ) == .deferToBackgroundLater,
                "a delivery that arrived while a sync was running was ignored"
            )
        }
        // 节流窗口内 + 正在跑：两个成因不冲突，也只许落在同一格上。
        try require(
            SyncDeliveryPolicy.decide(
                isForeground: false, isBound: true, isSyncRunning: true,
                hasPendingTask: false, lastSyncAt: now, now: now
            ) == .deferToBackgroundLater,
            "the single-flight gate and the throttle disagreed on what to do with a delivery"
        )
    }

    /// 🔴 契约 14：**节流窗口内的投递只限制"现在不跑"，不限制"记住"。**
    ///
    /// 放在 `foregroundDeliveryIsNeverThrottled` **之前**是有意的：两者都踩到实现里的同一行
    /// （节流判断），先跑的那一条才是"被改坏的那条判据"的指认者。前台那一格不该替这里背锅 ——
    /// 前台本来就跑，与"后台节流窗口内要不要记"是两件不同的事。
    private static func aThrottledDeliveryIsStillRemembered() throws {
        for elapsed in [1.0, SyncDeliveryPolicy.throttle - 1] {
            let decision = SyncDeliveryPolicy.decide(
                isForeground: false, isBound: true, isSyncRunning: false,
                hasPendingTask: false, lastSyncAt: now.addingTimeInterval(-elapsed), now: now
            )
            try require(
                decision == .deferToBackgroundLater,
                "a delivery inside the throttle window was dropped instead of being remembered"
            )
            try require(
                decision.recordsTheDelivery,
                "a delivery inside the throttle window would not be recorded"
            )
        }
    }

    /// 契约 2：前台不加节流。用户正看着界面，节流的代价是他点了同步却没反应。
    private static func foregroundDeliveryIsNeverThrottled() throws {
        for lastSync in [nil, now.addingTimeInterval(-1), now] {
            try require(
                SyncDeliveryPolicy.decide(
                    isForeground: true, isBound: true, isSyncRunning: false,
                    hasPendingTask: false, lastSyncAt: lastSync, now: now
                ) == .syncNow,
                "a foreground delivery was throttled (lastSyncAt=\(String(describing: lastSync)))"
            )
        }
    }

    /// 🔴 契约 3：有在途批次时，节流必须让路。
    ///
    /// 这条钉的是一个具体的错误形态：把节流判断挪到 `hasPendingTask` 之前。后果是"刚切后台
    /// 那一刻被中断的批次，要等满 15 分钟才有人管"—— 而它正是最该被立刻收尾的东西。
    private static func pendingTaskBypassesThrottle() throws {
        let justSynced = now.addingTimeInterval(-1)
        try require(
            SyncDeliveryPolicy.decide(
                isForeground: false, isBound: true, isSyncRunning: false,
                hasPendingTask: true, lastSyncAt: justSynced, now: now
            ) == .deferToBackground,
            "an in-flight batch was held back by the fresh-delivery throttle"
        )
        // 对照：同一时刻、没有在途批次时，节流**必须**生效 —— 否则上一条可能是靠"节流根本没实现"
        // 通过的。这里"生效"的准确含义是"不立刻跑"，而**不是**"丢掉"：节流管不到记忆，
        // 所以期望值是 `deferToBackgroundLater` 而不是 `ignore`（契约 14）。
        try require(
            SyncDeliveryPolicy.decide(
                isForeground: false, isBound: true, isSyncRunning: false,
                hasPendingTask: false, lastSyncAt: justSynced, now: now
            ) == .deferToBackgroundLater,
            "the throttle no longer holds back a fresh delivery after a successful sync"
        )
    }

    /// 契约 4：节流窗口内不立刻跑、窗口外恢复；窗口内也必须被**记下来**。边界取 `throttle`
    /// 本身（含等号）。
    private static func freshDeliveryIsThrottled() throws {
        let throttle = SyncDeliveryPolicy.throttle
        try require(throttle > 0, "the delivery throttle was disabled")
        let cases: [(TimeInterval, SyncDeliveryPolicy.Decision)] = [
            (1, .deferToBackgroundLater),
            (throttle - 1, .deferToBackgroundLater),
            (throttle, .deferToBackground),
            (throttle + 1, .deferToBackground)
        ]
        for (elapsed, expected) in cases {
            let decision = SyncDeliveryPolicy.decide(
                isForeground: false, isBound: true, isSyncRunning: false,
                hasPendingTask: false, lastSyncAt: now.addingTimeInterval(-elapsed), now: now
            )
            try require(
                decision == expected,
                "elapsed=\(elapsed) decided \(decision) instead of \(expected)"
            )
        }
    }

    /// 契约 5：从没同步过（`lastSyncAt == nil`）⇒ 第一次唤醒必须被放行。
    ///
    /// 「nil 被当成 0」是这类判据最经典的写法错误：`nil` 若落进"距上次不足 15 分钟"的分支，
    /// 新装的 App 会在后台永远不同步。
    private static func firstEverDeliveryIsNotThrottled() throws {
        try require(
            SyncDeliveryPolicy.decide(
                isForeground: false, isBound: true, isSyncRunning: false,
                hasPendingTask: false, lastSyncAt: nil, now: now
            ) == .deferToBackground,
            "a first-ever background delivery was throttled"
        )
    }

    /// 契约 6：`jobId` 优先于一切。
    ///
    /// 包括"系统还挂着上传"——`jobId` 落盘意味着服务端已经在算这一批，续接它是零风险且必须做的；
    /// 而若因为一个残留的上传任务就把整个后台运行降级成"什么都不做"，服务端结果就永远接不回来。
    private static func jobResumptionOutranksEverything() throws {
        for hasUploadTask in [true, false] {
            try require(
                BackgroundRunPolicy.action(
                    hasTask: true, jobId: "job-1",
                    hasBackgroundUploadTask: hasUploadTask, wantsFreshSync: true
                ) == .resumeJob,
                "a persisted jobId lost to hasUploadTask=\(hasUploadTask)"
            )
        }
        for hasTask in [true, false] {
            try require(
                BackgroundRunPolicy.action(
                    hasTask: hasTask, jobId: "job-1",
                    hasBackgroundUploadTask: hasTask, wantsFreshSync: true
                ) == .resumeJob,
                "a persisted jobId lost to hasTask=\(hasTask)"
            )
        }
        // 空串不是 jobId。持久化层可能出现空值，把它当成"有个任务要等"会让后台每一轮都空跑。
        try require(
            BackgroundRunPolicy.action(
                hasTask: false, jobId: "", hasBackgroundUploadTask: false, wantsFreshSync: true
            ) == .startFreshSync,
            "an empty jobId was treated as a real job"
        )
    }

    /// 契约 7：字节归系统所有（background URLSession 还挂着它）⇒ 不碰、不等。
    ///
    /// 「连 `inspect` 都不做」是有意的：`inspect` 读的是服务端那份来源，而它此刻可能正被写入。
    /// 等 delegate 回调，到那时 `sourceId` 才落盘，`inspect` 才有意义。
    private static func systemOwnedUploadIsNotTouched() throws {
        try require(
            BackgroundRunPolicy.action(
                hasTask: true, jobId: nil, hasBackgroundUploadTask: true, wantsFreshSync: false
            ) == .awaitSystemUpload,
            "a system-owned upload was touched by a background run"
        )
        // 对照：同一份任务、没有系统托管的传输时，必须推进。
        try require(
            BackgroundRunPolicy.action(
                hasTask: true, jobId: nil, hasBackgroundUploadTask: false, wantsFreshSync: false
            ) == .runAtomicUnit,
            "a resumable local batch was skipped"
        )
    }

    /// 🔴 契约 8：**只要盘上有持久化任务，`action` 的取值就被十二行表完全钉死，且表里没有
    /// `.startFreshSync`。**
    ///
    /// 重导出的代价不只是几分钟 CPU：新的 HealthKit 导出会写新的 `ExportDate`，于是
    /// `payloadHash` 变了、batchId 变了，服务端上那半批数据的幂等键失去意义 —— 结果是
    /// **两份来源、两个 job**。想重新导出只有一个合法入口：用户显式点「重新导入全部」。
    ///
    /// 为什么把"有任务行时一律走原子单元"与"不许重导出"合成**一条**：
    /// 它们是同一个输入上的同一件事（`runAtomicUnit` 就是"不是 startFreshSync 也不是
    /// nothingToDo"）。分成两条函数只能靠断言顺序决定谁先红，于是**一条突变会红在两条上**
    /// —— `check-background-mutations.py` 的 `assertion_hit` 就再也指不出被改坏的是哪条判据。
    /// 合并之后顺带把它升级成"精确值"：原先只断言 `!= .startFreshSync`，
    /// 那样 `.nothingToDo` 也能通过 —— 而"卡着一批却什么都不做"是同一个 bug 的另一半。
    ///
    /// 🔴 表里的期望值**逐行手写**，不用一处逻辑推导出来。用 `if jobId != nil … else if …`
    /// 推出期望值等于把实现重抄一遍：两边出自同一个想象，实现错了表也跟着错。
    private static func aTaskRowNeverStartsAFreshExport() throws {
        let rows: [(jobId: String?, uploadTask: Bool, wantsFresh: Bool, expected: BackgroundRunPolicy.Action)] = [
            (nil, false, false, .runAtomicUnit),
            (nil, false, true, .runAtomicUnit),
            (nil, true, false, .awaitSystemUpload),
            (nil, true, true, .awaitSystemUpload),
            ("", false, false, .runAtomicUnit),
            ("", false, true, .runAtomicUnit),
            ("", true, false, .awaitSystemUpload),
            ("", true, true, .awaitSystemUpload),
            ("job-1", false, false, .resumeJob),
            ("job-1", false, true, .resumeJob),
            ("job-1", true, false, .resumeJob),
            ("job-1", true, true, .resumeJob)
        ]
        for row in rows {
            let action = BackgroundRunPolicy.action(
                hasTask: true, jobId: row.jobId,
                hasBackgroundUploadTask: row.uploadTask, wantsFreshSync: row.wantsFresh
            )
            try require(
                action == row.expected,
                "a task row produced \(action) instead of \(row.expected) "
                    + "(jobId=\(String(describing: row.jobId)) uploadTask=\(row.uploadTask) "
                    + "wantsFreshSync=\(row.wantsFresh))"
            )
        }
        // 对照：没有任务行**且**有意图 ⇒ 必须能开始。少了它，上面整张表可以靠
        // "`action` 永远不返回 `.startFreshSync`"通过 —— 而那等于把功能删掉。
        try require(
            BackgroundRunPolicy.action(
                hasTask: false, jobId: nil, hasBackgroundUploadTask: false, wantsFreshSync: true
            ) == .startFreshSync,
            "a fresh export was refused with nothing on disk"
        )
    }

    /// 契约 9：没有任务行时，做不做全新同步**只看记下来的意图**。
    ///
    /// 为什么要这个意图位而不是"没有任务就导出"：`applicationDidEnterBackground` 每次切后台
    /// 都会重新 submit 一次 BGTask（请求是一次性的），而"切后台"不等于"健康数据变了"。
    /// 没有意图位的话，每次切后台都会白读一遍 HealthKit。
    private static func noTaskFollowsTheRecordedIntent() throws {
        try require(
            BackgroundRunPolicy.action(
                hasTask: false, jobId: nil, hasBackgroundUploadTask: false, wantsFreshSync: true
            ) == .startFreshSync,
            "a recorded intent to sync did not start anything"
        )
        try require(
            BackgroundRunPolicy.action(
                hasTask: false, jobId: nil, hasBackgroundUploadTask: false, wantsFreshSync: false
            ) == .nothingToDo,
            "a background run with nothing to do started work anyway"
        )
        // 没有任务行时"系统托管的上传"只可能是**孤儿**（进程在 `saveTask` 之前被杀）。
        // 策略层不做保守处理：孤儿由 `RaiBackgroundUploadSession.reattachOrphans` 在启动期
        // 按「本进程有没有在等它」取消（P2-4，判据在 `BackgroundUploadReattach`），
        // 不在这里改判据 —— 否则这里会长出第二份"谁拥有这个任务"的规则。
        try require(
            BackgroundRunPolicy.action(
                hasTask: false, jobId: nil, hasBackgroundUploadTask: true, wantsFreshSync: true
            ) == .startFreshSync,
            "an orphan upload task blocked a fresh sync"
        )
    }

    /// 🔴 契约（R1，2026-10-15）：没有任务行时，**待续页**也必须能驱动一轮同步。
    ///
    /// 待续页产生于一次**成功提交之后**（`commitSuccess` 的事务删掉任务行、同时写
    /// `sync_continuation` 槽），形态恰好是"无任务行 + 无通知 + 只有待续标记"。旧实现只认
    /// 通知/恢复请求 ⇒ `.nothingToDo` 立刻收工，而 `needsAnotherRound` 又因待续标记持续为真
    /// ⇒ BGTask 反复重排却永远不推进（活锁）。
    private static func noTaskFollowsTheContinuation() throws {
        try require(
            BackgroundRunPolicy.action(
                hasTask: false, jobId: nil, hasBackgroundUploadTask: false,
                wantsFreshSync: false, wantsContinuation: true
            ) == .resumeContinuation,
            "a persisted continuation with nothing else on disk started nothing"
        )
        // 对照：没有待续页时仍是"没事可做"（防"永远返回 resumeContinuation"通过）。
        try require(
            BackgroundRunPolicy.action(
                hasTask: false, jobId: nil, hasBackgroundUploadTask: false,
                wantsFreshSync: false, wantsContinuation: false
            ) == .nothingToDo,
            "a build with no continuation and no intent started work anyway"
        )
        // 新代次优先于待续页（与 SyncFollowUp.handoff 的"新代次先扣自己额度"同源）。
        try require(
            BackgroundRunPolicy.action(
                hasTask: false, jobId: nil, hasBackgroundUploadTask: false,
                wantsFreshSync: true, wantsContinuation: true
            ) == .startFreshSync,
            "a new generation lost to a pending page"
        )
        // 有任务行时待续页不作判据：任务行本身就是重试依据。
        try require(
            BackgroundRunPolicy.action(
                hasTask: true, jobId: nil, hasBackgroundUploadTask: false,
                wantsFreshSync: false, wantsContinuation: true
            ) == .runAtomicUnit,
            "a pending page outranked the persisted task row"
        )
    }

    /// 契约 11：软预算必须留出持久化余量，且在窗口内不许提前收手。
    ///
    /// 断言写在"给定预算下 `shouldYield` 的返回值"，**不写在 `softBudget == 120` 上** ——
    /// 那个数字是拍的参数，钉死它只会让以后调参的人以为门禁坏了。
    private static func budgetReservesTimeForPersistence() throws {
        let budget: TimeInterval = 60
        let reserve: TimeInterval = 10
        let start = now
        // 提前收手：把预算与余量都吃光才叫"该收了"。
        try require(
            BackgroundRunPolicy.shouldYield(
                startedAt: start, now: start.addingTimeInterval(budget - reserve - 1),
                budget: budget, reserve: reserve
            ) == false,
            "the background run yielded before consuming its budget"
        )
        try require(
            BackgroundRunPolicy.shouldYield(
                startedAt: start, now: start.addingTimeInterval(budget - reserve),
                budget: budget, reserve: reserve
            ) == true,
            "the background run did not reserve time for persisting its progress"
        )
        // 余量必须为正：余量为 0 意味着"收手那一刻正好没时间写盘"。
        try require(
            BackgroundRunPolicy.reserveForPersistence > 0,
            "the background run reserved no time to persist progress"
        )
        try require(
            BackgroundRunPolicy.softBudget > BackgroundRunPolicy.reserveForPersistence,
            "the background budget was smaller than its own persistence reserve"
        )
    }

    /// 契约 17：🔴 软预算**只接在后台轮询上**，且**只在后台生效**。
    ///
    /// 为什么必须把这两件事一起钉住：软预算真正的风险不是"没接线"（那只是让测试显得比生产
    /// 更严格），而是**接错位置**。接到导出/上传上，一次没跑完的 GB 级 HealthKit 导出会被
    /// 自己的预算反复掐断 —— 每次都从头再来，永远做不完；而漏掉 `isBackground`，前台同步
    /// （用户正看着界面点的那一次）也会被这个拍出来的数字掐掉。
    ///
    /// 入参里的"超预算时刻"用 `softBudget` 现算而不是写死 120 —— 与契约 11 同一条理由：
    /// 那个数字是拍的参数，钉死它只会让以后调参的人以为门禁坏了。
    private static func softBudgetOnlyYieldsBackgroundPolling() throws {
        let start = now
        let pastBudget = start.addingTimeInterval(BackgroundRunPolicy.softBudget)
        let withinBudget = start.addingTimeInterval(1)

        // 后台 + 已超预算 ⇒ 让出。**这是唯一该为真的组合。**
        try require(
            BackgroundRunPolicy.shouldYieldPolling(
                isBackground: true, backgroundStartedAt: start, now: pastBudget
            ) == true,
            "a background poll past its soft budget did not yield"
        )
        // 前台 ⇒ 一律不让出：判据是"有没有系统额度限制"，不是"花了多久"。
        try require(
            BackgroundRunPolicy.shouldYieldPolling(
                isBackground: false, backgroundStartedAt: start, now: pastBudget
            ) == false,
            "the soft budget yielded a foreground sync"
        )
        // 后台但**没有后台起点**（前台驱动的这一轮没有 `backgroundPassStartedAt`）⇒ 不让出。
        // 缺这一条，前台同步会因为起点为 nil 而被误算成"预算无限"或"超预算"，两种都不对。
        try require(
            BackgroundRunPolicy.shouldYieldPolling(
                isBackground: true, backgroundStartedAt: nil, now: pastBudget
            ) == false,
            "a poll with no recorded background start yielded"
        )
        // 后台但还在预算内 ⇒ 不许提前收手。
        try require(
            BackgroundRunPolicy.shouldYieldPolling(
                isBackground: true, backgroundStartedAt: start, now: withinBudget
            ) == false,
            "a background poll yielded before consuming its budget"
        )
    }

    /// 契约 12：报给系统的成败看"收工时盘上还有没有没走完的工作"，**不是**"这一轮跑没跑起来"。
    ///
    /// 单飞闸门拒绝掉的那一次如果报成功，系统会认为这个 App 的后台预算够用，
    /// 于是以后照常派活 —— 而每次派活都撞在同一个闸门上。
    ///
    /// 🔴 **判据的输入是一份按目标现读的快照**（`PendingWork`），不是 `HealthKitSync` 上的
    /// 展示标志。多出来的那两个"非任务"成因（读不出来 ⇒ `.unknown`、以及挂着的通知/恢复请求）
    /// 都是**不许报成功**的：报成功之后没人会再派活，而盘上那一批或那条通知就再也没人管。
    private static func successIsReportedFromTheRemainingWork() throws {
        try require(
            BackgroundRunPolicy.reportedSuccess(pending(verdict: .empty)) == true,
            "a clean run was reported as a failure"
        )
        try require(
            BackgroundRunPolicy.reportedSuccess(pending(verdict: .pending)) == false,
            "a run that left an unfinished batch reported success"
        )
        try require(
            BackgroundRunPolicy.reportedSuccess(pending(verdict: .unknown)) == false,
            "a run that could not read the journal reported success — the batch on disk is now nobody's"
        )
        // A4：到期未读的窗口 = 这一轮还没干完，不能报成功（否则系统不再排下一轮）。
        try require(
            BackgroundRunPolicy.reportedSuccess(
                pending(verdict: .empty, hasDueWorkoutWindow: true)) == false,
            "a run that left a due workout backfill window reported success"
        )
        try require(
            BackgroundRunPolicy.reportedSuccess(pending(verdict: .empty, hasIntent: true)) == false,
            "a run that left an unclaimed notification reported success"
        )
        try require(
            BackgroundRunPolicy.reportedSuccess(pending(verdict: .empty, hasRecoveryRequest: true)) == false,
            "a run that left a scope recovery request reported success — the new scope stays empty"
        )
    }

    /// 契约 13：请求是一次性的，所以"没做完"必须自己再排一次。
    ///
    /// 漏掉这条的后果不是报错，而是**三机制白装**：后台跑一次、没做完、之后再没人管，
    /// 直到用户下次手动打开 App。
    private static func unfinishedWorkResubmitsItself() throws {
        try require(
            BackgroundRunPolicy.shouldResubmit(pending(verdict: .pending)),
            "an unfinished batch did not schedule the next background run"
        )
        try require(
            BackgroundRunPolicy.shouldResubmit(pending(verdict: .empty, hasIntent: true)),
            "a recorded intent did not schedule a background run"
        )
        try require(
            BackgroundRunPolicy.shouldResubmit(pending(verdict: .empty, hasRecoveryRequest: true)),
            "a scope recovery request did not schedule a background run"
        )
        // A4（2026-10-19）：到期窗口也是"还有活"。缺这一条时，anchor 追平 + 无意图时
        // 探针会回答"没事可做"，而窗口的 nextCheckAt 就躺在库里没人执行。
        try require(
            BackgroundRunPolicy.shouldResubmit(pending(verdict: .empty, hasDueWorkoutWindow: true)),
            "a due workout backfill window did not schedule the next round"
        )
        try require(
            BackgroundRunPolicy.shouldResubmit(pending(verdict: .unknown)),
            "an unreadable journal did not schedule another attempt"
        )
        try require(
            BackgroundRunPolicy.shouldResubmit(pending(verdict: .empty)) == false,
            "a run with nothing left scheduled itself again"
        )
        // 重排的最小延迟必须为正 —— 否则刚因 5xx/断网失败就会立刻被再派一次，重放同一个错误。
        try require(
            BackgroundRunPolicy.resubmitDelay > 0,
            "the resubmit delay was disabled"
        )
        try require(
            BackgroundRunPolicy.earliestBeginDate(now: now)
                == now.addingTimeInterval(BackgroundRunPolicy.resubmitDelay),
            "the resubmit deadline did not apply the minimum delay"
        )
    }

    /// 🔴 契约 15/16：一轮收工后，"**这一轮没覆盖到的那一代**"必须有人接手，且前台补跑有硬上限。
    ///
    /// 前两条钉的是"接得准"：没有未覆盖的代次就不许再跑（这是前台自旋唯一的入口），
    /// 而在前台、又有额度时必须当场补跑（把新数据拖到下一次切后台，用户就只能盯着旧数字）。
    /// 最后一条钉的是"接得住但别失控"：HealthKit 大批导入期间会连发投递，额度必须有限 ——
    /// 没有上限的"补跑"就是连续几轮 GB 级导出。
    ///
    /// 期望值逐格手写，不拿 `isForeground && left > 0` 推一遍（那是把实现重抄一遍）。
    private static func uncoveredGenerationsAreHandedOff() throws {
        let rows: [(uncovered: Bool, foreground: Bool, left: Int, expected: SyncFollowUp.Handoff)] = [
            (false, true, 1, .nothing),
            (false, false, 1, .nothing),
            (false, true, 0, .nothing),
            (true, true, 1, .runAgain),
            (true, false, 1, .scheduleBackground)
        ]
        for row in rows {
            let handoff = SyncFollowUp.handoff(
                hasUncoveredGeneration: row.uncovered,
                hasPendingContinuation: false,
                isForeground: row.foreground,
                foregroundRoundsLeft: row.left,
                continuationBudgetLeft: true
            )
            try require(
                handoff == row.expected,
                "uncovered=\(row.uncovered) foreground=\(row.foreground) left=\(row.left) "
                    + "handed off \(handoff) instead of \(row.expected)"
            )
        }
        // 额度为 0 等于把前台补跑整个删掉（而且没有任何报错），必须为正。
        try require(
            SyncFollowUp.maxForegroundRounds > 0,
            "foreground follow-up rounds are disabled outright"
        )
        // 前台额度用完 ⇒ 必须交给后台，不许自旋。
        //
        // ⚠️ 这一格**刻意不放进上面那张表**：表里再放一行同样的输入，先红的就是表（循环里那条
        // 泛化消息），而"额度是不是真的有限"这条判据的指认者就变成了一个说不清被改坏了哪里的
        // 消息 —— `check-background-mutations.py` 的 `assertion_hit` 会指错地方。
        try require(
            SyncFollowUp.handoff(
                hasUncoveredGeneration: true, hasPendingContinuation: false,
                isForeground: true, foregroundRoundsLeft: 0,
                continuationBudgetLeft: true
            ) == .scheduleBackground,
            "foreground follow-up rounds are unbounded"
        )
        // 「没覆盖到的那一代」= 通知 + 恢复请求；而"盘上卡着一批"不进这一格 —— 那是后台重排
        // 的活（`needsAnotherRound`），混用会让一次网络失败之后前台立刻重放同一个失败请求。
        try require(
            pending(verdict: .empty, hasIntent: true).hasUncoveredGeneration
                && pending(verdict: .empty, hasRecoveryRequest: true).hasUncoveredGeneration,
            "an unclaimed notification or recovery request stopped counting as an uncovered generation"
        )
        try require(
            !pending(verdict: .empty).hasUncoveredGeneration
                && !pending(verdict: .pending).hasUncoveredGeneration,
            "unfinished bytes on disk were mistaken for a notification that this round did not cover"
        )
        // 反过来：`needsAnotherRound` 仍然把"盘上卡着一批"算进去（BGTask 的重排与回执用它）。
        try require(
            pending(verdict: .pending).needsAnotherRound && pending(verdict: .unknown).needsAnotherRound,
            "the resubmit judgement lost its unfinished-batch or unreadable-journal case"
        )
    }

    /// 🔴 契约（S2.3 新增）：**待续页与新代次分账** —— 两者都要求"再来一轮"，但必须用
    /// 独立的前台额度与独立的语义位：
    ///   - 合成一份额度 ⇒ 12,000 条积压（每批 4,500）从第二页起全被甩给后台（常见路径变慢）；
    ///   - 把待续页算进 `hasUncoveredGeneration` ⇒ 大批导入期间的防自旋护栏被页循环吃掉。
    private static func pendingContinuationGetsItsOwnBudget() throws {
        // 纯续页：新代次额度为 0 也照样可以前台续（用续页额度）。
        try require(
            SyncFollowUp.handoff(
                hasUncoveredGeneration: false, hasPendingContinuation: true,
                isForeground: true, foregroundRoundsLeft: 0, continuationBudgetLeft: true
            ) == .runAgain,
            "a pending page lost its own foreground budget (the second batch would always be deferred)"
        )
        // 续页额度尽 ⇒ 交后台（有界性的另一面）。
        try require(
            SyncFollowUp.handoff(
                hasUncoveredGeneration: false, hasPendingContinuation: true,
                isForeground: true, foregroundRoundsLeft: 0, continuationBudgetLeft: false
            ) == .scheduleBackground,
            "the continuation budget is unbounded"
        )
        // 两种成因同时挂起、新代次额度尽 ⇒ 优先甩后台（新代次优先用**自己的**额度，保守方向）。
        try require(
            SyncFollowUp.handoff(
                hasUncoveredGeneration: true, hasPendingContinuation: true,
                isForeground: true, foregroundRoundsLeft: 0,
                continuationBudgetLeft: true
            ) == .scheduleBackground,
            "an uncovered generation must keep its own budget semantics when both are pending"
        )
        // 后台一律排后台执行（不分额度）。
        try require(
            SyncFollowUp.handoff(
                hasUncoveredGeneration: false, hasPendingContinuation: true,
                isForeground: false, foregroundRoundsLeft: 3,
                continuationBudgetLeft: true
            ) == .scheduleBackground,
            "a background round must never spin in the foreground"
        )
        // 两个成因都不在 ⇒ 什么都不做。
        try require(
            SyncFollowUp.handoff(
                hasUncoveredGeneration: false, hasPendingContinuation: false,
                isForeground: true, foregroundRoundsLeft: 3,
                continuationBudgetLeft: true
            ) == .nothing,
            "a non-existent pending page must not schedule anything"
        )
        // 额度必须为正（为 0 等于把续页路径整个删掉，而且没有任何报错）。
        try require(
            SyncFollowUp.maxForegroundContinuationRounds > 0,
            "the continuation budget is disabled outright"
        )
        // `PendingWork` 上的新维度：`needsAnotherRound` 必须看见待续页
        // （否则 BGTask 的回执说"没事了"，而页还没读完 —— 重排断链）。
        try require(
            pending(verdict: .empty, hasPendingContinuation: true).needsAnotherRound,
            "a pending page stopped resubmitting the background run"
        )
        // 但它**不进** `hasUncoveredGeneration`（那是"外部产生的新活"的专属口径）。
        try require(
            !pending(verdict: .empty, hasPendingContinuation: true).hasUncoveredGeneration,
            "a pending page was mistaken for an uncovered generation (the front-spin guard would weaken)"
        )
    }

    /// 🔴 契约（2026-10-18 事故复盘 P0-6）：待续页的前台续读是**有界时间预算**，不是
    /// "固定 1+3 批"。
    ///
    /// 旧形态的可见后果：≈75 批历史重放每点一次只推进 4 批，剩下约 19 次全靠用户重复点击
    /// （跑后 6 批的 +12 s / +44 s / +55 s / +21 s / +13 s 就是它的指纹）。新形态把"这一波
    /// 最多占用用户多久"写成时间，而不是"固定几批" —— 单批成本随样本量从秒级到几十秒不等，
    /// "3 批"在轻量增量上是 10 秒、在 GB 级重放上是 3 分钟。
    ///
    /// 期望值逐格手写：预算的两个维度（时间、轮数）与两个停因（预算尽、无进展）都必须各自
    /// 可辨 —— 混成一条会让"预算没生效"与"进度判据没生效"看起来一模一样。
    private static func foregroundContinuationWaveIsTimeBounded() throws {
        // 预算与常量同源：改了常量却忘了同步 `ForegroundContinuationBudget`，会让界面说明与
        // 真实额度分叉（而两者都不会报错）。
        try require(
            ForegroundContinuationBudget.timeBudget == SyncFollowUp.foregroundContinuationTimeBudget,
            "the wave budget and the published time budget drifted apart"
        )
        try require(
            ForegroundContinuationBudget.maxRounds == SyncFollowUp.maxForegroundContinuationRounds,
            "the wave budget and the published round cap drifted apart"
        )
        // 时间预算必须是"一小段"：0 等于删掉续读；几十分钟等于把前台当后台用。
        try require(
            ForegroundContinuationBudget.timeBudget >= 10 && ForegroundContinuationBudget.timeBudget <= 300,
            "the foreground continuation budget is not a bounded wave "
                + "(\(ForegroundContinuationBudget.timeBudget)s)"
        )

        let started = now
        var budget = ForegroundContinuationBudget(startedAt: started)
        try require(
            budget.rounds == 0 && budget.allows(now: started),
            "a fresh wave cannot start its first round"
        )
        // 时间边界：59.9 s 还能开一轮，整 60 s 必须停（边界值属于"停"的那一侧）。
        try require(
            budget.allows(now: started.addingTimeInterval(59.9)),
            "the wave stopped before its time budget"
        )
        try require(
            !budget.allows(now: started.addingTimeInterval(ForegroundContinuationBudget.timeBudget)),
            "the time budget does not stop the wave at its boundary"
        )
        // 轮数边界：跑满 `maxRounds` 后即使时间没到也必须停 —— 单页导出可能比预算快得多。
        for _ in 0..<ForegroundContinuationBudget.maxRounds { budget.recordRound() }
        try require(
            budget.rounds == ForegroundContinuationBudget.maxRounds,
            "recordRound did not count the round"
        )
        try require(!budget.allows(now: started), "the round cap does not stop the wave")

        // 停因二分：预算尽是**预期**停因；无进展是**异常**停因 —— 没有后者，一次 5xx/断网
        // 会被时间预算放大成"在 60 s 内反复重放同一个失败请求"，而每次重放都是一轮 GB 级导出。
        let fresh = ForegroundContinuationBudget(startedAt: started)
        try require(
            !SyncFollowUp.shouldStopWave(budget: fresh, now: started, madeProgress: true),
            "a productive round inside the budget stopped the wave"
        )
        try require(
            SyncFollowUp.shouldStopWave(budget: fresh, now: started, madeProgress: false),
            "a round that committed nothing did not stop the wave"
        )
        var spent = ForegroundContinuationBudget(startedAt: started)
        for _ in 0..<ForegroundContinuationBudget.maxRounds { spent.recordRound() }
        try require(
            SyncFollowUp.shouldStopWave(budget: spent, now: started, madeProgress: true),
            "the wave ignored its own round budget"
        )
        try require(
            SyncFollowUp.shouldStopWave(
                budget: fresh,
                now: started.addingTimeInterval(ForegroundContinuationBudget.timeBudget + 1),
                madeProgress: true
            ),
            "the wave kept going past its time budget"
        )
    }

    /// 契约 12：两个 identifier 会被复制进 `Info.plist`，改名不报错、只让注册静默失败。
    private static func identifiersAreStableAndDistinct() throws {
        try require(
            RaiBackgroundSync.taskIdentifier == "app.rai.running.health-sync",
            "the BGTask identifier changed; Info.plist must be updated in the same commit"
        )
        try require(
            RaiBackgroundSync.uploadSessionIdentifier == "app.rai.running.health-sync.upload",
            "the background URLSession identifier changed; Info.plist must be updated in the same commit"
        )
        try require(
            RaiBackgroundSync.taskIdentifier != RaiBackgroundSync.uploadSessionIdentifier,
            "the BGTask and the background URLSession share one identifier"
        )
        // plist 的 identifier 只能是 ASCII 且不含空白。
        for identifier in [RaiBackgroundSync.taskIdentifier, RaiBackgroundSync.uploadSessionIdentifier] {
            try require(
                identifier.allSatisfy { $0.isASCII && !$0.isWhitespace },
                "identifier \(identifier) is not plist-safe"
            )
        }
    }

    /// 🔴 契约 14：系统手上的传输，**只在本进程还等着它的结局时**才留。
    ///
    /// 判据不是"它属于哪一批"。后者的致命处不是保守程度，而是**观测不到**：上个进程那次上传的
    /// 结局拿不回来（服务端没有按批次查来源的接口），所以横竖要重传同一份字节让服务端幂等命中
    /// —— 留着一个仍在跑的上传只会让两份同样的字节同时打向服务端，其中一份必然撞上
    /// `import_upload_busy`。留下的收益是零，代价是一份重复流量。
    ///
    /// 也别把判据读成"登记过就算"：生命周期中止之后登记还在（字节仍在走）而等待者已经被摘掉，
    /// 那正是**要取消**的状态 —— 拿登记当判据，会让"中止之后重进一次同步"变成两份字节同时在传。
    ///
    /// 期望值**手写**，不用 `awaited ? .keep : .cancelOrphan` 推导 —— 那是把实现重抄一遍。
    private static func systemReloadedUploadsAreOnlyKeptWhenTracked() throws {
        let rows: [(awaited: Bool, expected: BackgroundUploadReattach.Disposition)] = [
            (true, .keep),
            (false, .cancelOrphan)
        ]
        for row in rows {
            let disposition = BackgroundUploadReattach.disposition(isAwaitedInThisProcess: row.awaited)
            try require(
                disposition == row.expected,
                "awaited=\(row.awaited) produced \(disposition) instead of \(row.expected)"
            )
        }

        // `matchesCurrentBatch` **不是判据**（两种取值下的动作都是取消），它只决定重传的代价：
        // 命中 ⇒ 服务端走幂等分支、不新建来源；不命中 ⇒ 服务端多一份没人来取的来源。
        // 钉住它是为了让真机验收能把这两种现象分开 —— 只看日志它们长得一模一样。
        let batchRows: [(description: String?, current: String?, expected: Bool)] = [
            ("hash-a", "hash-a", true),
            ("hash-a", "hash-b", false),
            (nil, "hash-a", false),
            ("hash-a", nil, false),
            (nil, nil, false),
            ("", "", true)
        ]
        for row in batchRows {
            let matches = BackgroundUploadReattach.matchesCurrentBatch(
                taskDescription: row.description,
                currentPayloadHash: row.current
            )
            try require(
                matches == row.expected,
                "description=\(String(describing: row.description)) current=\(String(describing: row.current)) "
                    + "matched=\(matches) instead of \(row.expected)"
            )
        }

        // 空报告：什么都没找到时三个计数都必须是 0，且 `foundAny` 为假 ——
        // 真机验收把 `foundAny` 当"系统到底有没有把任务重挂起来"的证据，恒真等于这条证据失效。
        let empty = BackgroundUploadReattachReport()
        try require(
            empty.keptAwaited == 0 && empty.cancelledCurrentBatch == 0 && empty.cancelledOthers == 0
                && !empty.foundAny,
            "an empty reattach report did not read as empty"
        )
        // 反过来：**只有** `keptAwaited` 非零时 `foundAny` 也必须为真 ——
        // 否则"系统手上有任务、但它是另一次同步正在等的那一个"会被读成"系统手上什么都没有"，
        // 而那正是 `BackgroundRunPolicy.awaitSystemUpload` 唯一的来源形态。
        let keptOnly = BackgroundUploadReattachReport(keptAwaited: 1)
        try require(
            keptOnly.foundAny,
            "a report that kept an awaited task did not read as found — the '.awaitSystemUpload' path goes invisible"
        )
    }

    // MARK: - A8：观察者回调的耐久意图（record → completion）

    /// 生产形状的 URL scope：`HealthKitSync.urlScope(for:)` 取 `sha256(canonicalURL)` 前 24 位
    /// 十六进制。这里**不复制那段算法**（复制就有两份语义、迟早分叉），只用一个同形的字面量。
    private static let observerScope = "9f2c1a4b6d8e0f3a5c7b9d1e"

    private static func isolatedIntentDefaults(_ label: String) throws -> (UserDefaults, String) {
        let suiteName = "rai-observer-intent-\(label)-\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            throw BackgroundPolicyRegressionFailure("could not create an isolated UserDefaults suite")
        }
        return (defaults, suiteName)
    }

    /// 🔴 契约 18 的上半条：**顺序**。判据写在 `completion()` **内部** —— 那一刻用导出侧的
    /// 读法（`HealthSyncBackgroundIntentStore.observe(scope:)`）必须已经读得到这次投递的意图。
    ///
    /// 为什么不用"日志顺序"当判据：`record`/`complete` 两个闭包的调用顺序只能证明接线，
    /// 证明不了"耐久痕迹真的落地了"（一条写到错误 key 上的意图也会让日志顺序漂亮）。
    /// 这里走的是**生产构造**（真实的意图存储 + 真实的默认域），读的也是导出确认时的同一份 API。
    private static func observerIntentIsPersistedBeforeCompletion() throws {
        let (defaults, suiteName) = try isolatedIntentDefaults("order")
        defer { defaults.removePersistentDomain(forName: suiteName) }
        // 生产用的就是这两个字面量（`HealthKitSync.backgroundIntentKey`），键空间必须逐字相同，
        // 否则观察者写进去的意图与导出确认读的是两个位置 —— 而两边都不会报错。
        let baseKey = "rai.hk.backgroundIntent"
        let store = HealthSyncBackgroundIntentStore(userDefaults: defaults, baseKey: baseKey)

        var lines: [String] = []
        let channel = HealthSyncObserverIntentChannel(
            baseKey: baseKey, userDefaults: defaults, report: { lines.append($0) }
        )
        channel.publish(scope: observerScope)

        var completions = 0
        var intentVisibleInsideCompletion = false
        let outcome = channel.recordThenComplete {
            completions += 1
            intentVisibleInsideCompletion = store.observe(scope: observerScope) != nil
        }
        try require(completions == 1, "completion() ran \(completions) times instead of exactly once")
        try require(
            intentVisibleInsideCompletion,
            "completion() ran before the durable intent was readable — the A8 window is back"
        )
        try require(
            outcome == .recorded(scope: observerScope),
            "the delivery was not recorded against the projected target: \(outcome)"
        )
        try require(store.hasIntent(scope: observerScope), "no durable intent survived the delivery")
        try require(lines.isEmpty, "a successful intent write still emitted a failure line: \(lines)")
    }

    /// 🔴 契约 18 的下半条：**写失败也必须 `completion()`**，且失败要**分类计数**、不许静默。
    ///
    /// 注入是唯一能在本机复现"默认域写不进去"的方式：真实的 `UserDefaults.set` 不抛错、也没有
    /// 返回值，所以生产实现靠**回读**判定成败（`record(scope:)`），而回读失败路径由这里覆盖。
    /// 失败不重试也是判据的一部分：重试会突破"回调里有上限的同步写"这条约束。
    private static func observerIntentFailureStillCompletesAndIsCounted() throws {
        var recordCalls = 0
        var lines: [String] = []
        let channel = HealthSyncObserverIntentChannel(
            record: { _ in
                recordCalls += 1
                return false
            },
            report: { lines.append($0) }
        )
        channel.publish(scope: observerScope)

        var completions = 0
        let first = channel.recordThenComplete { completions += 1 }
        try require(completions == 1, "a failed intent write swallowed completion()")
        try require(first == .failed(.writeNotVerified), "a failed write was classified as \(first)")
        try require(
            recordCalls == 1,
            "a failed write was attempted \(recordCalls) times — the callback must stay bounded to one attempt"
        )
        try require(channel.failures[.writeNotVerified] == 1, "the failed write was not counted")
        try require(lines.count == 1, "a failed write left \(lines.count) diagnostic lines instead of one")
        try require(
            lines.first?.contains("writeNotVerified") == true && lines.first?.contains("n=1") == true,
            "the diagnostic line carries neither the failure class nor its running count: \(lines)"
        )

        // 第二次失败：completion 照样执行，计数递增 —— "这不是偶发"必须能从日志里一眼看出来。
        let second = channel.recordThenComplete { completions += 1 }
        try require(completions == 2, "a repeated failed write swallowed completion()")
        try require(second == .failed(.writeNotVerified), "a repeated failed write changed classification")
        try require(channel.failures[.writeNotVerified] == 2, "repeated failures are not counted")
        try require(
            lines.count == 2 && lines.last?.contains("n=2") == true,
            "the diagnostic line does not report the running failure count: \(lines)"
        )
        try require(
            channel.failures[.scopeUnusable] == nil,
            "a write failure was also counted as an unusable scope"
        )
    }

    /// 🔴 契约 18 的边界：**scope 不匹配不得误记**，没有目标/非法 scope 时也绝不写。
    ///
    /// 三条都必须是"不写 + 仍然 `completion()`"：
    ///   · 投影里是**另一个**目标 ⇒ 意图只许落在那个目标上，导出侧（`observerScope`）那一格
    ///     必须仍然是空的 —— 否则这个 URL 的下一轮会以为"这条变化已经被覆盖"，而那批数据
    ///     没人导；
    ///   · 本进程还没有目标 ⇒ 没有位置可落（与 `SyncDeliveryPolicy` 的 `.ignore` 同一条理由），
    ///     但回执必须发出去，且这个已知窗口每个进程只报一次；
    ///   · scope 非法 ⇒ 写进去就是一条**没人读的死 key**，与"丢了这次唤醒"等价。
    private static func observerIntentNeverWritesAnotherTargetsScope() throws {
        let (defaults, suiteName) = try isolatedIntentDefaults("scope")
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let baseKey = "rai.hk.backgroundIntent"
        let store = HealthSyncBackgroundIntentStore(userDefaults: defaults, baseKey: baseKey)
        // 真实存储 + 可数的写入缝：既钉住 key 落在哪（真默认域），也钉住"没有写"那条判据。
        var recordCalls = 0
        var lines: [String] = []
        let channel = HealthSyncObserverIntentChannel(
            record: { scope in
                recordCalls += 1
                return store.record(scope: scope)
            },
            report: { lines.append($0) }
        )

        // ① 目标是另一个 URL scope（例如用户刚切过服务端）。
        let otherTargetScope = "00112233445566778899aabb"
        channel.publish(scope: otherTargetScope)
        var completions = 0
        let outcome = channel.recordThenComplete { completions += 1 }
        try require(
            outcome == .recorded(scope: otherTargetScope),
            "the delivery was not recorded against the projected target: \(outcome)"
        )
        try require(completions == 1, "completion() did not run for a projected target")
        try require(
            !store.hasIntent(scope: observerScope),
            "an intent for another target leaked into the export's scope — that export would skip real data"
        )
        try require(store.hasIntent(scope: otherTargetScope), "the intent did not land on the projected scope")

        // ② 本进程还没有目标（全新安装 / 首个投递）。
        channel.publish(scope: nil)
        let writesBeforeNoTarget = recordCalls
        var noTargetCompletions = 0
        let noTarget = channel.recordThenComplete { noTargetCompletions += 1 }
        try require(noTarget == .noTarget, "a delivery without a target was classified as \(noTarget)")
        try require(noTargetCompletions == 1, "a delivery without a target swallowed completion()")
        try require(recordCalls == writesBeforeNoTarget, "a delivery without a target still touched the store")
        try require(channel.noTargets == 1, "the no-target delivery is not counted")
        // 每个进程只报一次：逐条报会把日志刷满，而"一次都不报"会把已知窗口藏起来。
        _ = channel.recordThenComplete {}
        try require(
            channel.noTargets == 2 && lines.count == 1,
            "the no-target window is reported \(lines.count) times instead of once per process"
        )

        // ③ 非法 scope：空 / 只有空白 / 带空白 / 超过 64 字节。
        let writesBeforeUnusable = recordCalls
        for badScope in ["", " ", "  scope-a  ", String(repeating: "a", count: 65)] {
            channel.publish(scope: badScope)
            var badCompletions = 0
            let bad = channel.recordThenComplete { badCompletions += 1 }
            try require(
                bad == .failed(.scopeUnusable),
                "scope \(badScope.debugDescription) was accepted as a UserDefaults key"
            )
            try require(badCompletions == 1, "an unusable scope swallowed completion()")
        }
        try require(
            recordCalls == writesBeforeUnusable,
            "an unusable scope still reached the store — that writes a key nothing ever reads"
        )
        try require(
            channel.failures[.scopeUnusable] == 4,
            "unusable scopes are not counted per category: \(channel.failures)"
        )
        // 合法边界：生产形状的 scope 必须被接受（判据不能宽到把正常值也挡掉）。
        try require(
            HealthSyncObserverIntentHandoff.isUsableScope(observerScope),
            "the production-shaped URL scope was rejected by the key-safety judge"
        )
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw BackgroundPolicyRegressionFailure(message) }
    }
}

private struct BackgroundPolicyRegressionFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
