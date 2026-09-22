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
/// `RAIApp.swift` 里，而那个文件被 `typecheck-ios.sh:92` 从类型检查里排除 ——
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
    /// 前台当场跑 / 后台记下意图交给 `BGProcessingTask` / 不值得跑。
    @MainActor
    static func registerSyncEntryPoints(healthSync: HealthKitSync, session: ServerSession) {
        healthSync.startObservingHealthChanges { [weak healthSync, weak session] in
            guard let healthSync, let session else { return }
            switch SyncDeliveryPolicy.decide(
                isForeground: UIApplication.shared.applicationState == .active,
                isBound: session.serverURL != nil,
                isSyncRunning: healthSync.isBusy,
                hasPendingTask: healthSync.hasPendingTask,
                lastSyncAt: healthSync.lastSyncAt,
                now: Date()
            ) {
            case .syncNow:
                // `force: true` 与原先视图层的调用一致：观察者被唤醒就说明数据真的变了，
                // 不该再被前台的 15 分钟节流挡掉（节流已经在 `decide` 里对后台路径做过了）。
                await healthSync.syncIfNeeded(
                    to: session.serverURL,
                    apiToken: session.apiToken,
                    force: true
                )
            case .deferToBackground:
                // 记下意图再 submit：`submit` 本身不携带"为什么"，而一个过期的待发请求
                // 落到 BGTask 上时，只有这个意图位能告诉它"这次真的有新数据"。
                healthSync.recordBackgroundIntent()
                submitBackgroundRun()
            case .ignore:
                break
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
            await healthSync.runBackgroundPass(to: session.serverURL, apiToken: session.apiToken)
            // 🔴 重排必须发生在 `setTaskCompleted` **之前**：这一轮很可能做不完
            // （服务端 job 还在算），而 `BGTaskScheduler` 的请求是**一次性**的、
            // 系统不会自动重试。漏掉这一步的可见后果是"后台跑过一次，之后再没人管"，
            // 直到用户下次手动打开 App —— 那等于三机制白装。
            let hasPendingTask = healthSync.hasPendingTask
            let hasFreshIntent = healthSync.hasBackgroundIntent
            if BackgroundRunPolicy.shouldResubmit(hasPendingTask: hasPendingTask, hasFreshIntent: hasFreshIntent) {
                submitBackgroundRun(after: BackgroundRunPolicy.resubmitDelay)
            }
            // 报成功与否看"盘上还有没有没走完的批次"，**不看**"这一轮跑没跑起来"：
            // 单飞闸门拒绝掉的那一次什么都没做，报成功会让系统持续派活去撞同一个闸门。
            // 判据与理由见 `BackgroundRunPolicy.reportedSuccess`。
            task.setTaskCompleted(success: BackgroundRunPolicy.reportedSuccess(hasPendingTask: hasPendingTask))
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
    func applicationDidEnterBackground(_ application: UIApplication) {
        Task { @MainActor in
            let healthSync = AppModel.shared.healthSync
            guard BackgroundRunPolicy.shouldResubmit(
                hasPendingTask: healthSync.hasPendingTask,
                hasFreshIntent: healthSync.hasBackgroundIntent
            ) else { return }
            RaiStartup.submitBackgroundRun()
        }
    }
}
#endif
