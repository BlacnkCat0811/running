import Foundation

/// `SyncDeliveryPolicy` / `BackgroundRunPolicy` 的回归。
///
/// 钉的是那些**改错了照样编译通过、肉眼也看不出来**的判据：
///
///   1. 未绑定 / 已有同步在跑 ⇒ 这次唤醒一律 `.ignore`（后者是单飞要求，静默拒绝在 BGTask
///      侧会被记成"跑过了"）；
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
///      上一个进程那次上传的结局拿不回来，留着一个仍在跑的上传只是多一倍重复流量）。
///
/// 之所以要有这个可执行文件：`HealthKitSync.swift` 与 `RAIApp.swift`/`AppDelegate.swift`
/// 都不被任何回归脚本编译（前者只被 `typecheck-ios.sh` 类型检查，后两个连同被
/// `typecheck-ios.sh:102` 排除），判据若留在它们里面就没有执行者。
/// `BackgroundUploadSession.swift` 同样：它 `#if os(iOS)` 包裹且要真实 `URLSession` 才能跑，
/// 所以它的判据在能搬出去的地方就必须搬出去。
@main
struct BackgroundSyncPolicyRegression {
    private static let now = Date(timeIntervalSince1970: 1_780_000_000)

    /// 构造一份**按目标读到的**待办快照。字段值除了 `verdict` 与两个成因位以外都不参与判据，
    /// 所以钉死成常量即可。
    private static func pending(
        verdict: HealthSyncBackgroundRecovery.PendingWork.Verdict,
        hasIntent: Bool = false,
        hasRecoveryRequest: Bool = false
    ) -> HealthSyncBackgroundRecovery.PendingWork {
        HealthSyncBackgroundRecovery.PendingWork(
            serverURL: "http://127.0.0.1:8787",
            urlScope: "urlscope0000000000000000",
            scope: "syncscope000000000000000",
            verdict: verdict,
            hasIntent: hasIntent,
            hasRecoveryRequest: hasRecoveryRequest
        )
    }

    static func main() throws {
        try deliveryIsIgnoredWhenUnboundOrAlreadyRunning()
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
        try budgetReservesTimeForPersistence()
        try successIsReportedFromTheRemainingWork()
        try unfinishedWorkResubmitsItself()
        try identifiersAreStableAndDistinct()
        try systemReloadedUploadsAreOnlyKeptWhenTracked()
        print("Background sync policy regression tests passed")
    }

    /// 契约 1：未绑定服务端时任何唤醒都不做事；已有同步在跑时同理。
    ///
    /// 后半条不是省事：`HealthSyncTaskOwner` 以 `task == nil` 单飞，第二次进入被**静默拒绝**，
    /// 而 BGTask 那侧只看到"handler 返回了"，会把它记成"跑过了"。
    private static func deliveryIsIgnoredWhenUnboundOrAlreadyRunning() throws {
        // 写死四行期望值，**不写 `(isBound && !isRunning) ? … : …`** ——
        // 那是把实现重抄一遍：两边出自同一个想象，改坏了照样一起错。
        // 判据以表格形式写出来的唯一价值就是它能与实现**不一致**。
        let cases: [(bound: Bool, running: Bool, expected: SyncDeliveryPolicy.Decision)] = [
            (false, false, .ignore),
            (false, true, .ignore),
            (true, false, .deferToBackground),
            (true, true, .ignore)
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
        }
        // 前台也一样：在跑就不许再进。
        try require(
            SyncDeliveryPolicy.decide(
                isForeground: true, isBound: true, isSyncRunning: true,
                hasPendingTask: true, lastSyncAt: nil, now: now
            ) == .ignore,
            "a foreground delivery re-entered an already-running sync"
        )
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
        // 对照：同一时刻、没有在途批次时，节流**必须**生效 —— 否则上一条可能是靠"节流根本没实现"通过的。
        try require(
            SyncDeliveryPolicy.decide(
                isForeground: false, isBound: true, isSyncRunning: false,
                hasPendingTask: false, lastSyncAt: justSynced, now: now
            ) == .ignore,
            "the throttle did not fire for a fresh delivery right after a successful sync"
        )
    }

    /// 契约 4：节流窗口内不再投递，窗口外恢复。边界取 `throttle` 本身（含等号）。
    private static func freshDeliveryIsThrottled() throws {
        let throttle = SyncDeliveryPolicy.throttle
        try require(throttle > 0, "the delivery throttle was disabled")
        let cases: [(TimeInterval, SyncDeliveryPolicy.Decision)] = [
            (1, .ignore),
            (throttle - 1, .ignore),
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

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw BackgroundPolicyRegressionFailure(message) }
    }
}

private struct BackgroundPolicyRegressionFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
