import Foundation
#if os(iOS)
import UIKit
import BackgroundTasks

/// 启动期的同步入口注册。
///
/// 为什么需要它：`HealthKitSync.startObservingHealthChanges` 原先唯一的调用点是
/// `RootView.onAppear`（`RootView.swift:22-24`）。而 Apple 要求 HealthKit 观察者
/// **每次启动都重新注册** —— 视图没出现时（后台唤醒、直接进入别的界面、App 被系统
/// 在后台拉起）就一个观察者都没有，健康数据的变化不会被感知。
///
/// 🔴 **这里不能改成调 `AppModel.registerSyncEntryPoints()`。** `AppModel` 定义在
/// `RAIApp.swift` 里，而那个文件被 `typecheck-ios.sh:102` 从类型检查里排除 ——
/// 逻辑写进去就没有任何门禁看得见它。所以注册逻辑本身也留在本文件。
///
/// 为什么用 `UIApplicationDelegateAdaptor` 而不是继续挂在视图上：视图必须先被建出来，
/// 而"启动期注册"的意义正是**早于任何 UI**。`BGTaskScheduler.register` 的约束更硬：
/// 它必须在 `didFinishLaunching` 返回**之前**完成（见 `registerBackgroundTasks`）。
enum RaiStartup {
    /// 注册"健康数据变化 ⇒ 同步"这条链路，并决定这次变化在哪跑。
    ///
    /// 全仓只有这一处调用 `startObservingHealthChanges`：Apple 侧重复注册只是浪费
    /// （每次变化投递两次），但**多一个调用点**就意味着有人又把入口挂回视图层，
    /// 于是"视图没出现 = 没有观察者"这个缺陷会原样长回来。结构门禁
    /// `check-background-capabilities.py` 钉的就是这一点（调用点恰好一处）。
    ///
    /// 🔴 **派发决策在这里，不在观察者里。** P1 时观察者自己判 `applicationState == .active`
    /// 然后 `return` —— 那等于把后台唤醒整个吞掉（P2 的全部意义就是让后台唤醒也能干活）。
    /// 现在观察者只说"数据变了"，这里按 `SyncDeliveryPolicy` 决定：
    /// 前台当场跑 / 后台记下意图、排一轮执行（立刻或延后）/ 未绑定目标才是真的不值得记。
    @MainActor
    static func registerSyncEntryPoints(healthSync: HealthKitSync, session: ServerSession) {
        // 🔴 A8（2026-10-19）：**注册观察者之前**先把会话目标投影给观察者回调。
        // 后台冷启动的第一次投递可能发生在任何一次同步（`performSync` / 恢复上下文）之前，
        // 而回调只能在已发布的投影上落耐久意图；不先发布，那一代投递就落 `.noTarget`
        // （A8 残余窗口）。这里只发布目标、不写意图 —— 写意图会凭空造出一条待跑变化。
        healthSync.publishObserverTarget(for: session.serverURL)
        healthSync.startObservingHealthChanges { [weak healthSync, weak session] in
            guard let healthSync, let session else { return }
            // 按**本次会话的服务端**现读，不用全局展示标志：那个标志属于最后一次写它的那次同步，
            // 而这里问的是"这个目标有没有事要做"。读不出来时按"有"处理（`?? true`）—— 两个判错
            // 方向分别是多跑一轮（代价是一次导出）与少跑一轮（等下一次投递），保守的那侧是不漏。
            let pending = healthSync.probePendingWork(for: session.serverURL)
            let isBound = session.serverURL != nil
            let decision = SyncDeliveryPolicy.decide(
                isForeground: UIApplication.shared.applicationState == .active,
                isBound: isBound,
                isSyncRunning: healthSync.isBusy,
                hasPendingTask: pending?.hasUnfinishedWork ?? true,
                lastSyncAt: healthSync.lastSyncAt,
                now: Date()
            )
            // 🔴 **先记意图，再决定这一轮跑不跑。** 一次投递就是一次真实的数据变化，而单飞与
            // 节流能决定的只是"要不要现在跑"，不该决定"这条变化要不要被记住"（判据在
            // `Decision.recordsTheDelivery`）。旧版把 `.ignore` 直接 `break` 掉，于是
            // "导出期间到达的通知"与"节流窗口内的通知"双双落空：旧批次收工清空之后，后台按
            // 快照判定"无待办"，自动同步就此停在原地。代次确认（`shouldAcknowledgeIntent`）
            // 只能保护**已经记下来**的那一代。
            if decision.recordsTheDelivery {
                healthSync.recordBackgroundIntent(for: session.serverURL)
            }
            switch decision {
            case .syncNow:
                // `force: true` 与原先视图层的调用一致：观察者被唤醒就说明数据真的变了，
                // 不该再被前台的 15 分钟节流挡掉（节流已经在 `decide` 里对后台路径做过了）。
                await healthSync.syncIfNeeded(
                    to: session.serverURL,
                    apiToken: session.apiToken,
                    force: true
                )
                // 收工后检查"这一轮没覆盖到的那一代"（导出起点之后到达的通知）。判据在
                // `SyncFollowUp.handoff`，这里只接线。
                await handOffUncoveredGenerations(healthSync: healthSync, session: session)
            case .deferToBackground:
                // `submit` 本身不携带"为什么"，而一个过期的待发请求落到 BGTask 上时，
                // 只有意图位能告诉它"这次真的有新数据"（意图已在上面记下）。
                submitBackgroundRun()
            case .deferToBackgroundLater:
                // 单飞闸门被占 / 还在后台节流窗口内：这一轮不跑，但**已经把变化记下来了**，
                // 所以要保证它真的会被跑 —— 排一次延后的后台执行，而不是等下一次投递来救。
                // 不立即 submit 是刻意的：BGTask 与正在跑的那一轮撞车只会被单飞静默拒绝，
                // 换来一条"跑过了"的假记录。
                submitBackgroundRun(after: BackgroundRunPolicy.resubmitDelay)
            case .ignore:
                break
            }
        }
    }

    /// 一轮同步收工后，把"**这一轮没有覆盖到的那一代**"与"**没读完的页**"接过去。
    ///
    /// 为什么必须有这一步：代次确认只负责把导出起点之后到达的通知**留下**（不被本轮吞掉），
    /// 不负责找人来跑它。少接这一手，那条通知会一直躺在盘上，直到下一次切后台或下一次投递
    /// —— 那正是"自动同步停在原地"的形态。
    ///
    /// 🔴 判据住在 `SyncFollowUp.handoff` / `SyncFollowUp.shouldStopWave`（纯函数、有执行者），
    /// 这里只做接线、扣预算与进度判定。
    ///
    /// 2026-10-18 事故复盘 P0-6：待续页的前台额度从"固定 3 轮"改成**有界时间预算**
    /// （`ForegroundContinuationBudget`：一波 ≤60 s，另有轮数兜底）。旧形态下 ≈75 批历史重放
    /// 每点一次只推进 4 批，剩下约 19 次要靠用户重复点击；新形态仍然有界，但不再把
    /// "读得完多少"绑死在点击次数上。**没有新增任何后台机制**：额度用尽照旧走
    /// `submitBackgroundRun(after:)`。
    ///
    /// 🔴 进度判据用 `healthSync.dataUpdatedGeneration`：它在 `markSuccess` 里每成功提交一批
    /// 才 +1（服务端 job 还在算的那一轮不算）。"这一轮一批都没提交成功"必须**立刻收手** ——
    /// 否则一次 5xx/断网会被 60 秒预算放大成反复重放同一个失败请求，而每次重放都是一轮
    /// GB 级 HealthKit 导出。没有这条，预算越大越伤。
    ///
    /// ⚠️ 这里读的是**这一轮自己按目标现读的快照**（`probePendingWork`），不是
    /// `lastError` / `phase` 这类展示字段：单飞被拒的那一次什么都没跑，拿它的落点判断
    /// "有没有没覆盖的活儿"就是拿别人的结论给自己打分。
    ///
    /// ⚠️ 自 2026-10-15（R1）起它是**跨文件入口**：视图层的手动同步与"回到前台"也调用它。
    /// 改动调用形态（含本文件 :69 / :179 两处字面量）必须同步
    /// `check-background-capabilities.py` 的 `ordered()` 与 `check-background-mutations.py` 的锚点。
    @MainActor
    static func handOffUncoveredGenerations(healthSync: HealthKitSync, session: ServerSession) async {
        guard let serverURL = session.serverURL else { return }
        var roundsLeft = SyncFollowUp.maxForegroundRounds
        // 预算起点是**这一波第一次续读之前**：一次手动同步本身可能已经花掉几十秒，
        // 从"用户点同步那一刻"起算会让预算在续读开始前就用完。
        var budget = ForegroundContinuationBudget(startedAt: Date())
        while true {
            let pending = healthSync.probePendingWork(for: serverURL)
            let hasUncoveredGeneration = pending?.hasUncoveredGeneration ?? true
            let hasPendingContinuation = pending?.hasPendingContinuation ?? false
            let isForeground = UIApplication.shared.applicationState == .active
            switch SyncFollowUp.handoff(
                hasUncoveredGeneration: hasUncoveredGeneration,
                hasPendingContinuation: hasPendingContinuation,
                isForeground: isForeground,
                foregroundRoundsLeft: roundsLeft,
                continuationBudgetLeft: budget.allows(now: Date())
            ) {
            case .nothing:
                return
            case .scheduleBackground:
                submitBackgroundRun(after: BackgroundRunPolicy.resubmitDelay)
                return
            case .runAgain:
                // 按**本轮实际的挂起类型**扣预算 —— 扣账口径必须与 `handoff` 的判定
                // 逐条对齐（两者同时挂起时,handoff 走"新代次"分支，这里同样优先扣新代次额度）。
                if hasUncoveredGeneration { roundsLeft -= 1 } else { budget.recordRound() }
                let generationBefore = healthSync.dataUpdatedGeneration
                await healthSync.syncIfNeeded(
                    to: serverURL,
                    apiToken: session.apiToken,
                    // 与派发侧同理：这一轮要跑的是**新到的那一代**（或没读完的页），不该被
                    // 前台的 15 分钟节流挡掉（那正是它被留下来的原因）。
                    force: true
                )
                let madeProgress = healthSync.dataUpdatedGeneration != generationBefore
                if SyncFollowUp.shouldStopWave(budget: budget, now: Date(), madeProgress: madeProgress) {
                    submitBackgroundRun(after: BackgroundRunPolicy.resubmitDelay)
                    return
                }
            }
        }
    }

    /// 设备解锁时，把"因为锁屏而停下的同步"重新推一次（文档 §3.4）。
    ///
    /// 为什么需要这条链路：`performSync` 的预检查在锁屏时会**立刻返回**（那是正确的 ——
    /// 硬读 HealthKit 只会拿到 `errorDatabaseInaccessible`），但这样一来"解锁之后自动继续"
    /// 就没人负责了。没有它，用户解锁后要等到下一次 HealthKit 投递、或者自己手动点一次；
    /// 而文档 §3.1 的状态机里 `deferred_protected_data → queued` 那条边要求的正是"设备解锁恢复"。
    ///
    /// 🔴 判据住在 `HealthSyncBlockedRecovery.shouldResume`（纯函数、有执行者），这里只做接线。
    /// 它保证"不在阻塞态时收到解锁通知"**不会**触发同步 —— 否则每次解锁都会白读一次 HealthKit，
    /// 而那正是整个流程里最贵的一步（也是节流策略存在的全部理由）。
    ///
    /// 只注册一次（`didFinishLaunching` 调一次）。重复注册会让每次解锁触发多轮同步，
    /// 而症状只是"解锁后同步了两次"，看不出是谁干的。
    @MainActor
    static func observeProtectedDataAvailability() {
        _ = NotificationCenter.default.addObserver(
            forName: UIApplication.protectedDataDidBecomeAvailableNotification,
            object: nil,
            queue: .main
        ) { _ in
            // 闭包实际跑在 main queue 上，但类型系统看不到这个事实（block 的参数类型不带隔离），
            // 所以照 `runBackgroundTask` 的写法先跳回 MainActor 再碰状态。
            Task { @MainActor in
                let model = AppModel.shared
                let healthSync = model.healthSync
                let session = model.session
                guard HealthSyncBlockedRecovery.shouldResume(
                    phase: SyncPhase.migrate(healthSync.phase),
                    isProtectedDataAvailable: true,
                    hasCredential: session.serverURL != nil
                ) else { return }
                RaiStartup.report("protected data became available; resuming the blocked sync")
                await healthSync.syncIfNeeded(
                    to: session.serverURL,
                    apiToken: session.apiToken,
                    // 跳过节流：这一轮不是"新的投递"，而是**补上一次没做成的**。
                    // 走 `force: false` 会被 15 分钟窗口挡下，而那个窗口对"等解锁"毫无意义。
                    force: true
                )
                // 与投递唤醒那条路同一条收尾：解锁期间到达的投递也可能没被这一轮覆盖到。
                await RaiStartup.handOffUncoveredGenerations(healthSync: healthSync, session: session)
            }
        }
    }

    /// 注册 `BGProcessingTask`。
    ///
    /// 🔴 **必须在 `didFinishLaunching` 返回之前调用完，而且不能挪进 `Task { }`。**
    /// 注册晚于 launch 完成时，之后所有 `submit` 都会被系统拒绝（抛 `notPermitted`），
    /// 现象是"后台同步从不发生"、而日志里没有任何别的线索。这就是它不进
    /// `registerSyncEntryPoints`（那个在 `Task` 里跑）的原因。
    ///
    /// 🔴 返回值必须检查。`register` 返回 `false` 意味着**这次注册没生效**（identifier 与
    /// `Info.plist` 的 `BGTaskSchedulerPermittedIdentifiers` 不一致、或重复注册 ——
    /// 重复注册会让系统直接杀掉进程）。静默忽略它等于把"后台永不运行"伪装成正常。
    nonisolated static func registerBackgroundTasks() {
        let registered = BGTaskScheduler.shared.register(
            forTaskWithIdentifier: RaiBackgroundSync.taskIdentifier,
            using: nil
        ) { task in
            guard let processingTask = task as? BGProcessingTask else { return }
            // 🔴 系统在**后台队列**上调用这个 block，不是主线程（R3）。所有判据都住在
            // MainActor 上，所以先跳回去再读 `taskStore` / `isBusy` —— 在这里直接读是
            // 数据竞争，而 `-default-isolation MainActor` 不会替你发现这一点。
            Task { @MainActor in
                RaiStartup.runBackgroundTask(processingTask)
            }
        }
        if !registered {
            RaiStartup.report("BGTaskScheduler.register returned false for \(RaiBackgroundSync.taskIdentifier)")
        } else {
            // 真机验收 V1 的判据。补这一行的理由：成功路径此前**完全静默**，于是
            // 「注册成功了」与「这段代码根本没跑到」在控制台里长得一模一样 ——
            // 而下面那个 `enableBackgroundDelivery` 同族的做法（失败才说话）在这里不成立，
            // 因为注册没有别的观察面。
            RaiStartup.report("BGTaskScheduler.register ok for \(RaiBackgroundSync.taskIdentifier)")
        }
    }

    /// 排一次后台执行请求。
    ///
    /// 🔴 **`submit` 失败绝不能用 `try?` 吞掉。** 缺 `UIBackgroundModes: [processing]`、
    /// identifier 不在 `Info.plist`、或同一个 identifier 已有待发请求之外的配额问题，
    /// 都会在这里抛错。2026-09-10 的项目健康审计记录过一次同形态的缺陷
    /// （`scheduleHealthSync` 用 `try?` 吞掉 submit 失败 ⇒ 后台同步永不执行却看不出问题）。
    ///
    /// 同一 identifier 只保留**一个**待发请求（新的覆盖旧的），所以这条路可以被多处调用
    /// 而不会堆积 —— 切后台时排一次、后台跑完再排一次，是安全的。
    nonisolated static func submitBackgroundRun(after delay: TimeInterval = 0) {
        let request = BGProcessingTaskRequest(identifier: RaiBackgroundSync.taskIdentifier)
        // 没有网就什么都做不了；让系统等到有网再派活，省一次注定失败的唤醒。
        request.requiresNetworkConnectivity = true
        // 刻意不要求外接电源：跑步数据晚几小时到不影响正确性，但"必须插着电"会把
        // 绝大多数手机排除在外 —— 那等于这个机制在真实使用里从不生效。
        request.requiresExternalPower = false
        request.earliestBeginDate = Date().addingTimeInterval(delay)
        do {
            try BGTaskScheduler.shared.submit(request)
            // `delay=0` 是「切后台时排的那一次」，`delay=900` 是「后台跑完自己重排的那一次」
            // （`BackgroundRunPolicy.resubmitDelay`）。两者必须能在控制台里分开 ——
            // 「请求是一次性的」这件事的可见后果就是"这一行只出现在切后台那一刻"。
            RaiStartup.report("BGTaskScheduler.submit ok (delay=\(Int(delay))s)")
        } catch {
            RaiStartup.report("BGTaskScheduler.submit failed: \(String(describing: error))")
        }
    }

    /// 一轮后台执行。`BGProcessingTask` 是**主载荷**，不是兜底（分工见计划 §9 的四机制表）。
    @MainActor
    private static func runBackgroundTask(_ task: BGProcessingTask) {
        let model = AppModel.shared
        let healthSync = model.healthSync
        let session = model.session
        // 系统收走时间 ≠ 用户取消。必须走 lifecycle：写 `"cancelled"` 会让下一次同步的
        // `checkCancellation()` 把系统的决定当成用户意图，从此永久卡死。
        task.expirationHandler = {
            // 真机验收 V3 的判据。⚠️ 这个闭包由系统在**任意线程**上调用，所以里面只能碰
            // `nonisolated` 的东西 —— `report` 正是（它只调 `NSLog`，不读任何状态）。
            RaiStartup.report("BGProcessingTask expiration fired")
            Task { @MainActor in healthSync.suspendForLifecycle() }
        }
        Task { @MainActor in
            // 真机验收 V2 的判据：这是「系统真的把 BGTask 派发下来了」的唯一直接证据。
            // 没有它时，「系统没派发」与「派发了但这一轮什么都没做」在服务端看完全一样
            // （都没有请求），§11.3 那张归因表就无从判起。
            RaiStartup.report("BGProcessingTask launched (\(RaiBackgroundSync.taskIdentifier))")
            // 🔴 这一轮的**重排与完成回执**都用它自己按目标读到的快照（返回值），不用
            // `healthSync.hasPendingTask` 那个展示标志：单飞闸门拒绝掉的那一轮一个字段都没碰过，
            // 而那个标志属于另一次同步（"用别人的结论给自己打分"的形态见
            // `BackgroundRunPolicy.reportedSuccess` 的说明）。
            let pending = await healthSync.runBackgroundPass(
                to: session.serverURL,
                apiToken: session.apiToken
            )
            // 🔴 重排必须发生在 `setTaskCompleted` **之前**：这一轮很可能做不完
            // （服务端 job 还在算），而 `BGTaskScheduler` 的请求是**一次性**的、
            // 系统不会自动重试。漏掉这一步的可见后果是"后台跑过一次，之后再没人管"，
            // 直到用户下次手动打开 App —— 那等于三机制白装。
            if let pending, BackgroundRunPolicy.shouldResubmit(pending) {
                submitBackgroundRun(after: BackgroundRunPolicy.resubmitDelay)
            }
            // 报成功与否看"收工时盘上还有没有没走完的工作"，**不看**"这一轮跑没跑起来"。
            // 快照为 `nil`（压根没绑定服务端 ⇒ 构造不出来）时保守报**失败**：宁可让系统遥测
            // 记一次"没做完"，也不要凭空报成功。
            task.setTaskCompleted(success: pending.map(BackgroundRunPolicy.reportedSuccess) ?? false)
        }
    }

    /// 没有用户界面的失败要留下痕迹（与 `HealthKitSync.report` 同一形态）。
    ///
    /// `fileprivate` 而不是 `private`：`RaiAppDelegate`（同文件）也要用它 —— 类型内的 `private`
    /// 只对本类型及其同文件扩展可见，对本文件里的另一个类型不可见。
    nonisolated fileprivate static func report(_ message: String) {
        NSLog("[RAI] %@", message)
    }
}

final class RaiAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // 🔴 同步注册，且在返回之前完成。**不能挪进下面那个 `Task`** ——
        // 注册晚于 launch 完成时之后所有 submit 都会被拒绝。
        RaiStartup.registerBackgroundTasks()
        // `AppModel.shared` 是 `@MainActor`，而系统是在主线程调用本方法的 —— 但那是
        // 运行期事实，类型系统看不到。跳到 MainActor 上再取。
        Task { @MainActor in
            let model = AppModel.shared
            RaiStartup.registerSyncEntryPoints(healthSync: model.healthSync, session: model.session)
            // 锁屏恢复链路（文档 §3.4）与观察者注册同属"启动期入口"，也必须只有一次。
            RaiStartup.observeProtectedDataAvailability()
        }
        return true
    }

    /// 系统因为"后台上传有事发生"把 App 拉起来（`sessionSendsLaunchEvents = true` 的兑现）。
    ///
    /// 🔴 这个方法是**唯一**能把 `urlSessionDidFinishEvents` 唤醒的入口，而后者是"这次后台事件
    /// 处理完了"的唯一回执。不实现它（或忘了调 completion）的后果不是报错，而是系统认为这个 App
    /// 的后台事件永远处理不完 —— 它会**降低后续的派发频率**，现象是"上传偶尔能续上，越用越少"。
    ///
    /// 这里**不做同步**，只做两件事：
    ///   1. 建 session（幂等）并记下完成回调 —— 事件必须有一个 delegate 才收得到；
    ///   2. 排一次后台执行，让真正的续接跑在 `BGProcessingTask` 里 ——
    ///      本方法拿到的执行时间是给"处理事件"用的，而"续接一个批次"要读盘、要 HTTP、可能还要
    ///      重新导出，量级完全不匹配。
    ///
    /// 至于那次传输的**结局**：本进程多半没有它的等待者（进程被杀过），所以
    /// `didCompleteWithError` 会静默跳过 —— 服务端收下与否由下一次同步用同一个 batchId 重传后
    /// 幂等命中来定论（`import-sources.ts:323-331`）。
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        guard identifier == RaiBackgroundSync.uploadSessionIdentifier else {
            // 不认识也**必须**回调：系统按 identifier 记账，漏调一次就少一次派发额度。
            // 但我们不替它建 session —— 那不是我们的 identifier，建出来只会挂一个空 delegate。
            RaiStartup.report(
                "handleEventsForBackgroundURLSession got an unknown identifier \(identifier)"
            )
            completionHandler()
            return
        }
        let session = RaiBackgroundUploadSession.shared
        // 先建 session 再记回调：反过来的话，`getAllTasks`/完成事件在 session 建立之前到达
        // 就没人接。
        _ = session.makeSession()
        session.storeSystemCompletion(completionHandler)
        RaiStartup.submitBackgroundRun()
    }

    /// 每次进入后台都重新排一次后台执行请求。
    ///
    /// `BGTaskScheduler` 的请求是**一次性**的：跑完就没了，系统不会自动重试。所以"上次切后台
    /// 时排的那次"用完之后，剩下没做完的活儿就再没人管。这里重排，等于给"每次离开 App"
    /// 都留一条回来的路。
    ///
    /// 只在**确实有事可做**时排（`BackgroundRunPolicy.shouldResubmit`）：没有待办也没有
    /// 意图时排一次，只会换来若干分钟后的空跑 —— 而空跑本身有代价（`runBackgroundPass`
    /// 要读盘，冷启动一次 App）。
    ///
    /// 🔴 **自己读快照，不依赖任何"先跑过的回调"。** 本方法与 SwiftUI 的 `scenePhase` 变化
    /// （那条路上跑 `HealthKitSync.handleEnterBackground()`）之间**没有先后保证**；
    /// 依赖它就意味着"另一条路还没跑 ⇒ 这里读到的是上一轮的值"，于是重排按一份过期的
    /// 待办清单决定要不要排。探针是只读的现读，谁先谁后都对。
    func applicationDidEnterBackground(_ application: UIApplication) {
        Task { @MainActor in
            let model = AppModel.shared
            guard let pending = model.healthSync.probePendingWork(for: model.session.serverURL),
                  BackgroundRunPolicy.shouldResubmit(pending) else { return }
            RaiStartup.submitBackgroundRun()
        }
    }
}
#endif
