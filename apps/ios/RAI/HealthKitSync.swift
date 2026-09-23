import Foundation
import Observation
import CryptoKit
#if os(iOS)
import HealthKit
import UIKit
#endif

@Observable
@MainActor
final class HealthKitSync {
    var isBusy = false
    var message: String?
    var lastError: String?
    var lastSyncAt: Date?
    var lastWorkoutCount: Int?
    var phase: String = "idle"
    var dataUpdatedGeneration = 0
    private var activeToken = ""
    private var activeScope = "unbound"
    private var activeServerURL: URL?
    private var activeIdentity: RaiHandshake?
    private let taskStore = SyncTaskStore()
    private let api = RaiAPIClient()
    private let syncOwner = HealthSyncTaskOwner()
    /// 本次中止的来源。生命周期中止与用户取消必须可分（理由见 `HealthSyncLifecycle.swift` 文件头）。
    /// 每次 `performSync` 开头重置，否则上一次的手动取消会让下一次在握手后立刻自杀。
    private var cancelCause: SyncCancelCause = .none

    /// 上一次 `loadTask()` 是否遇到"磁盘上**有** payload 但解不开"。
    ///
    /// 与"没有任务"必须分开：解不开说明磁盘上留着一份属于**别的版本**的进度，把它当成
    /// "没任务"的可见后果是安静地重导整个窗口、计数归零，而 `sync_tasks` 里那一行还在。
    /// 加一个带默认值的非可选字段就会制造这个形态（见 `SyncTaskState` 的说明）。
    private(set) var taskDecodeError: String?

    /// 磁盘上是否留着一批**没走完**的工作。
    ///
    /// 与 `phase` 是两件事：`phase` 是**本次进程内**的自述，重启后回到 `idle`；这个字段
    /// 读的是 `sync_tasks` 里那一行。分开的理由是界面上必须能同时说"上次同步成功"与
    /// "磁盘上还卡着一批" —— 只看 `phase` 时，一次生命周期中断之后的界面会把那批未完成
    /// 的数据显示成"上次健康同步 12:30"，读起来像一切正常。
    ///
    /// 写入点只有两处，都是**进度本身的写点**：`saveTask`（有进度了）与 `clearTask`
    /// （进度没了）。放在别处就会与 `sync_tasks` 的真实内容漂移。
    private(set) var hasPendingTask = false

    /// 本次同步里，当前这批是否已被服务端**确定性拒绝**（`SyncUploadRecovery.abandonBatch`）。
    ///
    /// 它只影响失败之后的收尾：坏批次**不得**被登记成"待重试的失败批次"，
    /// 否则每次同步都会拿同一份字节再撞一次，而服务端的拒绝是确定性的 —— 同步永远好不了。
    private var abandonedBatch = false

    var hasCompletedSync: Bool { lastSyncAt != nil }

    var lastSyncAtISO: String? {
        guard let lastSyncAt else { return nil }
        return Self.isoFormatter.string(from: lastSyncAt)
    }

    private static let lastExportEndKey = "rai.hk.lastExportEnd"
    private static let lastSyncAtKey = "rai.hk.lastSyncAt"
    private static let lastWorkoutCountKey = "rai.hk.lastWorkoutCount"
    private static let lastWorkoutAnchorKey = "rai.hk.workoutAnchor"
    private static let lastAutoSyncKey = "rai.hk.lastAutoSync"
    /// 「健康数据变了，等后台有机会就跑一次」的意图位（P2）。
    ///
    /// 与 `lastAutoSyncKey` 是两件事：那个记的是"上一次**成功**同步的时刻"，用来节流
    /// **新的**投递；这个记的是"有一条已经到达但我还没处理的变更"。混用一个键的后果是
    /// 后者会被前者的写入时机（`markSuccess`）意外清掉。
    private static let backgroundIntentKey = "rai.hk.backgroundIntent"
    private static let taskKey = "rai.hk.syncTask"
    /// Inclusive overlap so workouts finalized just after the previous export are not missed.
    private static let overlap: TimeInterval = 48 * 60 * 60
    private static let autoSyncInterval: TimeInterval = 15 * 60
    /// 老 payload 时代唯一用过的 ZIP 文件名。新代码按 `upload-<payloadHash>` 命名，
    /// 这个名字只为**读老 payload** 留着。
    private static let legacyZipName = "upload.zip"

    /// 批次产物一律**按 `payloadHash` 确定性命名**。
    ///
    /// 这不是命名洁癖：名字里带着哈希，就让"这个文件属于哪一批"由文件名本身回答
    /// （`.zip` 与 `.multipart` 都是），于是恢复时不必对动辄几个 GB 的包重算哈希 ——
    /// 旧实现 `pendingTaskZip` 会对每个候选路径跑一次整文件哈希，代价是几十秒到几分钟。
    static func zipName(for payloadHash: String) -> String { "upload-\(payloadHash).zip" }

    static func multipartName(for payloadHash: String) -> String { "upload-\(payloadHash).multipart" }

    /// boundary 同样由 `payloadHash` 派生 ⇒ **重建 multipart 会得到字节完全一致的产物**，
    /// 于是"重传"与"重建后再传"在服务端看来是同一批，幂等键也就能生效。
    static func multipartBoundary(for payloadHash: String) -> String { "rai-\(payloadHash.prefix(32))" }

    /// 🔴 设备此刻**能不能**读 HealthKit。
    ///
    /// 锁屏（或开机后尚未首次解锁）时 HealthKit 数据库被硬件级加密锁死，**任何**读取都会被拒。
    /// 抽成一个属性、而不是在两个调用点各写一遍 `UIApplication.shared.isProtectedDataAvailable`：
    /// 这条判据有两处要用（`performSync` 的预检查、`runBackgroundPass` 的后台早退），
    /// 写两遍就有两份语义 —— 而"什么算读不到"恰恰是文档 §3.4 要求**只有一份**的定义。
    ///
    /// 非 iOS 平台没有这个 API，按"可读"处理（那边的导出路径本来也走不通，见 `#else` 分支）。
    private static var isProtectedDataAvailable: Bool {
        #if os(iOS)
        return UIApplication.shared.isProtectedDataAvailable
        #else
        return true
        #endif
    }

    #if os(iOS)
    private var observerStore: HKHealthStore?
    private var observers: [HKObserverQuery] = []
    private var onObserverChange: (@MainActor () async -> Void)?
    #endif

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 600
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return RaiURLSession.make(configuration: configuration)
    }()

    // MARK: 由系统搬运字节的那条路（P2-4）

    /// 把一批字节交给**系统**搬运。
    ///
    /// 为什么不能直接用上面那个 `session`：`.ephemeral` 的传输活不过进程挂起，而一次全量导出
    /// 可以是几个 GB、`beginBackgroundTask` 只给约 30 秒 —— 切一次后台就得从头再来。
    /// 带 identifier 的 background session 由系统持有，进程被杀也照常传完
    /// （职责与三条语义差异见 `RaiBackgroundUploadSession` 的文件头）。
    ///
    /// 非 iOS 平台保留当前会话：`background(withIdentifier:)` 那条路只有 iOS 有。
    private func uploadToSystem(
        _ request: URLRequest,
        from file: URL,
        payloadHash: String
    ) async throws -> (Data, URLResponse) {
        #if os(iOS)
        return try await RaiBackgroundUploadSession.shared.upload(
            request: request, fromFile: file, payloadHash: payloadHash
        )
        #else
        _ = payloadHash
        return try await session.upload(for: request, fromFile: file)
        #endif
    }

    /// 盘点系统手上还挂着哪些传输，并把没人在等结局的那些取消掉。
    ///
    /// 调用点恰好三处，都在"我方准备发起（或重新打算发起）一次上传之前"：
    /// `performSync` 推导下一步之前、`runBackgroundPass` 决定这一轮推进哪一步之前，
    /// 以及后台任务被系统唤起时的 `handleEnterBackground`（走的是 `systemUploadInFlight` 那条快速路）。
    ///
    /// 为什么必须跑：没人在等的那些传输，其结局我方**永远拿不回来**（服务端没有按批次查来源的
    /// 接口，证据见 `BackgroundUploadReattach`），而它占着的那个 batchId 正是这一轮要用的。
    /// 取消它，让这一轮用盘上那份 multipart 重传：`boundary` 由 `payloadHash` 派生 ⇒ 逐字节相同
    /// ⇒ 服务端按归档字节比对走幂等分支，返回**同一条**来源（`import-sources.ts:323-331`）。
    /// 不取消则是两份同样的字节同时打向服务端，其中一份必然撞 `import_upload_busy`（429）
    /// —— 等于用服务端当限流器。
    ///
    /// 判据（`BackgroundUploadReattach`）是纯函数、有执行者；这里只做"跑一次 + 留一行日志 +
    /// 把盘上那句已经不成立的自述改回来"。日志不是装饰：真机验收（计划 §11.3）靠它把
    /// "系统压根没把任务重挂起来"（`foundAny == false`）与"重挂了但属于别的批次"
    /// （`cancelledCurrentBatch == 0` 而 `cancelledOthers > 0`）分开 —— 只看"有没有取消"，
    /// 这两件事长得一模一样，而它们指向完全不同的修复方向。
    private func reconcileSystemUploads(_ task: SyncTaskState?) async {
        #if os(iOS)
        let report = await RaiBackgroundUploadSession.shared.reattachOrphans(
            currentPayloadHash: task?.payloadHash
        )
        if report.foundAny {
            Self.report(
                "reattached system uploads: kept \(report.keptAwaited) awaited, "
                    + "cancelled \(report.cancelledCurrentBatch) for the current batch, "
                    + "\(report.cancelledOthers) from other batches"
            )
        }
        // 盘上说"字节归系统"、而系统手上已经没有任何属于这一批的传输（刚被取消，或本来就没有）
        // ⇒ 那次传输已经结束而我方没有它的结局。把这个字段拉回与事实一致。
        if let task, !systemUploadInFlight(payloadHash: task.payloadHash) {
            clearStaleUploadState(task)
        }
        #else
        _ = task
        #endif
    }

    /// 把停在 `inFlight` 的自述改回 `pending`（"下次会重传"）。
    ///
    /// 🔴 **这不是判据。** 判据是 `BackgroundUploadReattach`，已经在调用点执行完毕；这里只是不让
    /// 盘上留一句已经站不住的谎话 —— `uploadState` 会被真机排查读到，而"停在 `inFlight`"
    /// 正是那个会让下一个人（或下一版代码）以为"字节归系统、不许碰"的形状，也就是活锁的来源。
    ///
    /// 写失败**不中止同步**（它不承载任何判据），但必须留痕：静默吞掉写失败正是
    /// `SyncTaskStore` 那套设计要消灭的形态。
    private func clearStaleUploadState(_ task: SyncTaskState) {
        guard task.uploadState == .inFlight else { return }
        var updated = task
        updated.uploadState = .pending
        updated.uploadTaskId = nil
        updated.uploadCompletedAt = nil
        do {
            try saveTask(updated)
        } catch {
            Self.report("failed to reset a stale uploadState: \(friendlyMessage(error))")
        }
    }

    /// 本进程内、**同步**可读的"系统正在为这一批搬字节"。
    ///
    /// 给 `handleEnterBackground` 用：切后台的处理必须在几十毫秒内返回，不能去等 `getAllTasks`。
    /// 与 `reconcileSystemUploads` 的分工是"快速判空 vs 权威盘点"，两者共用同一份内部登记，
    /// 所以不会出现"一个说有、一个说没有"。
    private func systemUploadInFlight(payloadHash: String?) -> Bool {
        #if os(iOS)
        guard let payloadHash else { return false }
        return RaiBackgroundUploadSession.shared.hasInFlightUpload(forPayloadHash: payloadHash)
        #else
        _ = payloadHash
        return false
        #endif
    }

    init() {
        lastSyncAt = nil
        lastWorkoutCount = nil
    }

    func syncIfNeeded(to serverURL: URL?, apiToken: String = "", force: Bool = false) async {
        guard let serverURL, !syncOwner.isRunning else { return }
        let urlScope = Self.urlScope(for: serverURL)
        // 🔴 卡在阻塞态时，节流不该挡住恢复（文档 §3.3 / §3.4）。
        // 那 15 分钟是给**新的投递**用的，而这两个阶段等的是一个**外部条件** ——
        // 条件刚满足（用户刚解锁 / 刚重新登录）就被节流挡下，等于让用户白等一轮，
        // 而界面上仍然写着"等解锁 / 等登录"。
        //
        // 判据必须读**盘上**那份自述：进程重启之后内存 `phase` 回到 `idle`，
        // 而"卡在等凭证"这件事只留在 `sync_tasks` 那一行里。
        let persistedPhase = loadTask()?.resolvedPhase
        let isBlocked = persistedPhase?.isBlocked ?? SyncPhase.migrate(phase).isBlocked
        if !force, !isBlocked {
            let last = UserDefaults.standard.object(forKey: scopedKey(Self.lastAutoSyncKey, scope: urlScope)) as? Date
            if let last, Date().timeIntervalSince(last) < Self.autoSyncInterval { return }
        }
        await sync(to: serverURL, apiToken: apiToken)
    }

    /// 用户主动取消（同步按钮 / App Intent）。**这是唯一会产出 `phase == "cancelled"` 的路径。**
    func cancelSync() {
        guard syncOwner.cancel() || isBusy else { return }
        cancelCause = .manual
        finishCancelled()
    }

    /// 生命周期中止：系统收回执行时间（`beginBackgroundTask` 到期）或 App 切到后台。
    ///
    /// 与 `cancelSync()` 的唯一区别在**记录方式**：这里不写 `"cancelled"`，而是把 `phase`
    /// 落回它本来的可续接阶段，下次唤醒按持久化字段接着跑。取消动作本身是一样的。
    func suspendForLifecycle() {
        guard syncOwner.cancel() || isBusy else { return }
        cancelCause = .lifecycle
        finishCancelled()
    }

    /// 进入后台时对"在飞的工作"的处置。判据是纯函数 `HealthSyncLifecycle.enterBackground`。
    ///
    /// 刻意不在这里做任何网络或 HealthKit 工作：切后台的处理必须在几十毫秒内返回。
    func handleEnterBackground() {
        // 刷新"磁盘上还有没有没走完的批次"必须放在 `isBusy` 守卫**之前**：
        // 需要它更新的正是"在飞的工作刚被中断"这个时刻，而那一刻 `isBusy` 可能已经归 false。
        let task = loadTask()
        hasPendingTask = task != nil
        guard isBusy else { return }
        switch HealthSyncLifecycle.enterBackground(
            phase: phase,
            isBusy: isBusy,
            hasJobId: task?.jobId != nil,
            // 字节归系统时（background URLSession 还在搬这一批）⇒ 一根手指都不许碰，
            // 连 `stopResumable` 都不能落 —— 中止的是"等结果"，不是"搬字节"
            // （两条路的区别见 `RaiBackgroundUploadSession.abandonWaiting`）。
            hasUploadTask: systemUploadInFlight(payloadHash: task?.payloadHash)
        ) {
        case .doNothing:
            break
        case .keepWorking:
            // `performSync` 自己持有 `beginBackgroundTask` 的续期额度，让它把在飞的那一步跑完。
            // 额度到期由 expiration handler 走 `suspendForLifecycle()`，不是这里。
            break
        case .stopResumable:
            // 等服务端出结果（`jobId` 已落盘）时后台轮询零收益（服务端没有推送机制），
            // 立刻收手并保留 `jobId` 交给下次唤醒续接 —— 这不是取消。
            suspendForLifecycle()
        }
    }

    /// 注册 HealthKit 观察者。**每次启动都必须调用一次**（Apple 的要求）。
    ///
    /// 调用点只有一处：`RaiStartup.registerSyncEntryPoints`（`AppDelegate.swift`），
    /// 由 `didFinishLaunching` 驱动。原先这里是 `guard observers.isEmpty` + 视图层
    /// `onAppear` 调用 —— 那个组合的问题不在守卫，而在**入口的位置**：视图没出现就完全
    /// 没有观察者。守卫因此被删掉（它只会掩盖"有人又挂回视图层"这件事），改成由结构门禁
    /// 钉住"调用点恰好一处"。
    ///
    /// 名字里刻意不带 `foreground`：P2 之后观察者要在后台唤醒路径上同样生效。
    func startObservingHealthChanges(onChange: @escaping @MainActor () async -> Void) {
        #if os(iOS)
        onObserverChange = onChange
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let store = HKHealthStore()
        observerStore = store
        let types: [(HKSampleType, NSPredicate?)] = [
            (.workoutType(), HKQuery.predicateForWorkouts(with: .running)),
            (HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!, nil),
            (HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!, nil),
            (HKObjectType.quantityType(forIdentifier: .restingHeartRate)!, nil)
        ]
        observers = types.map { sampleType, predicate in
            HKObserverQuery(sampleType: sampleType, predicate: predicate) { [weak self] _, completion, _ in
                // 🔴 `completion()` 必须在**任何 `await`／`Task`／状态守卫之前**调用。
                // HealthKit 连续 3 次没收到它会**永久停掉**这个类型的投递 ——
                // 现象是"第一次能唤醒，之后再也不唤醒"，而且毫无报错。
                completion()
                Task { @MainActor in
                    // 这里**刻意不判** `applicationState`（P2 之前判过）。
                    // 判在哪跑不是观察者的事：派发方（`RaiStartup` 注册的回调，判据在
                    // `SyncDeliveryPolicy`）才知道前台该当场跑、后台该记下意图交给
                    // `BGProcessingTask`。观察者提前 return 等于把后台唤醒整个吞掉。
                    await self?.onObserverChange?()
                }
            }
        }
        // 后台投递必须**逐个类型**开。`enableBackgroundDelivery` 的完成回调是
        // 唯一的失败信号：被拒（缺 entitlement、用户关了"后台 App 刷新"、被 MDM 限制）
        // 时 `success == false`，**绝不能用 `try?` / `_ =` 吞掉** ——
        // 那样现象是"后台永远不唤醒"，而代码里看不出任何问题。
        //
        // 频率取 `.hourly`：`.immediate` 会被系统按进程/类型重度节流，而且与本仓自己的
        // `SyncDeliveryPolicy.throttle`（15 min）冲突 —— 投递来了也会被自己的节流挡掉，
        // 白白消耗一次唤醒额度。跑步数据在天级尺度上补齐就够。
        for (sampleType, _) in types {
            let identifier = sampleType.identifier
            store.enableBackgroundDelivery(for: sampleType, frequency: .hourly) { success, error in
                guard !success else { return }
                Self.report("enableBackgroundDelivery failed for \(identifier): "
                    + (error.map { String(describing: $0) } ?? "no error given"))
            }
        }
        observers.forEach { store.execute($0) }
        #endif
    }

    /// 没有用户界面的失败要留下痕迹。
    ///
    /// `NSLog` 而不是 `print`：这是发布路径上的诊断，不是控制台噪音 ——
    /// 与 `SyncTaskStore.report` 同一个理由。真机验收（计划 §11 V1）就是靠
    /// `[RAI]` 前缀在 Xcode 控制台里过滤出这些行的。
    ///
    /// `nonisolated`：调用点之一是 `enableBackgroundDelivery` 的 `@Sendable` 完成回调，
    /// 它在非隔离上下文里跑；默认隔离（`-default-isolation MainActor`）会把没有标注的
    /// 静态方法算成 MainActor 隔离的，于是这里会报 actor 越界 —— 而它只调 `NSLog`，不碰任何状态。
    nonisolated private static func report(_ message: String) {
        #if os(iOS)
        NSLog("[RAI] %@", message)
        #else
        print("[RAI] \(message)")
        #endif
    }

    /// 跑一次同步。**返回值 = "这一次真的被跑起来了吗"**，由 `HealthSyncTaskOwner` 的单飞闸门决定。
    ///
    /// 🔴 后台路径必须用上这个返回值（`BackgroundRunPolicy.reportedSuccess`）：与前台同步
    /// 撞车时这一轮被**静默拒绝**，而 BGTask 那侧只看得到"handler 返回了"。报成功等于告诉系统
    /// "这个 App 的后台预算够用"，于是以后每次派活都撞在同一个闸门上 —— 而 nginx 那一侧
    /// 全程没有任何 uploads。
    ///
    /// `@discardableResult` 是为了让既有的六个前台调用点（`TechSyncStatus` / `TechViews` /
    /// `RootView` / `SyncHealthIntent` / `AppWebView`）一个字都不用改。
    @discardableResult
    func sync(to serverURL: URL?, apiToken: String = "", full: Bool = false) async -> Bool {
        await syncOwner.run { [weak self] in
            guard let self else { return }
            await self.performSync(to: serverURL, apiToken: apiToken, full: full)
        }
    }

    /// 记下"健康数据变了，等后台有机会就跑一次"。
    ///
    /// 为什么不能只靠 `submit`：`applicationDidEnterBackground` 每次切后台都会 submit 一次
    /// （请求是一次性的），而"切后台"不等于"数据变了"。没有这个意图位，一个**过期的**待发请求
    /// 在数据没变时落到 BGTask 上会变成一次白读 HealthKit 的全量导出 —— 那是最贵的一步。
    func recordBackgroundIntent() {
        guard let url = activeServerURL else { return }
        UserDefaults.standard.set(Date(), forKey: scopedKey(Self.backgroundIntentKey, scope: Self.urlScope(for: url)))
    }

    /// 读并**清掉**意图位。叫 `consume` 是因为它只能被用一次：同一次数据变化不该让两轮后台都跑。
    private func consumeBackgroundIntent(scope: String) -> Bool {
        let key = scopedKey(Self.backgroundIntentKey, scope: scope)
        guard UserDefaults.standard.object(forKey: key) != nil else { return false }
        UserDefaults.standard.removeObject(forKey: key)
        return true
    }

    /// 磁盘上是否记着"有新数据待同步"。给 `BackgroundRunPolicy.shouldResubmit` 用。
    var hasBackgroundIntent: Bool {
        guard let url = activeServerURL else { return false }
        return UserDefaults.standard.object(forKey: scopedKey(Self.backgroundIntentKey, scope: Self.urlScope(for: url))) != nil
    }

    /// 后台一轮（由 `BGProcessingTask` 驱动）。判据全部来自纯函数，这里只做接线。
    ///
    /// 顺序与理由：
    ///   1. 先读盘上的任务行 —— `hasPendingTask` 的真实来源（它同时决定报给系统的成败）。
    ///   2. `BackgroundRunPolicy.action` 决定这一轮推进哪一段。**一次后台运行只推进一个批次**。
    ///   3. 只有 `.startFreshSync` 才允许重新导出，而它要求**盘上没有任务行**（见该函数说明）。
    func runBackgroundPass(to serverURL: URL?, apiToken: String) async {
        let task = loadTask()
        hasPendingTask = task != nil
        guard let serverURL else { return }
        // 🔴 卡在阻塞态（等解锁 / 等凭证）时，后台这一轮**什么都不做**（文档 §3.3 / §3.4）。
        //
        // 为什么需要这一道：`BackgroundRunPolicy.action` 只看"盘上还有没有没走完的批次"，
        // 于是锁屏时它会派一次注定读不到 HealthKit 的导出、等凭证时它会派一次注定 401 的上传。
        // 两次都会"正常失败"，然后因为批次还在而**再排下一轮** —— 每 15 分钟一次的活锁，
        // 代价是反复白读 HealthKit（整个流程里最贵的一步）。
        //
        // ⚠️ 早退**不**影响重排（`RaiStartup.runBackgroundTask` 里的 `shouldResubmit` 照旧）：
        // 唤醒这两个阶段的是外部条件，但"谁来发现条件已经满足"只能靠重排 —— 解锁通知在
        // App 已被系统杀掉时是收不到的。
        let persistedPhase = task?.resolvedPhase ?? SyncPhase.migrate(phase)
        if persistedPhase.isBlocked {
            Self.report("background pass: skipped, waiting on an external condition (\(persistedPhase.rawValue))")
            return
        }
        // 🔴 先问系统，再信盘上那一行。`task.uploadState == .inFlight` 只是"我方曾经把它交出去过"
        // 的记录 —— 它**不会**因为系统传完（或进程被杀）而改变，所以拿它当判据时，每一轮唤醒都会
        // 说"字节归系统"（`.awaitSystemUpload` ⇒ 什么都不做），而 `shouldResubmit` 又因为
        // "盘上有任务"一直为真 ⇒ 系统持续派活、持续空转。那是**活锁**，不是保守。
        // 盘点顺带会把盘上那句已经不成立的自述改回来（`clearStaleUploadState`）。
        await reconcileSystemUploads(task)
        // 意图位只在"盘上什么都没有"时才有意义：有任务行时下一步由字段推导，用户意图插不上手。
        // `&&` 的短路在这里是有意的 —— 不去消费一个这次用不上的意图。
        let wantsFresh = task == nil && consumeBackgroundIntent(scope: Self.urlScope(for: serverURL))
        let action = BackgroundRunPolicy.action(
            hasTask: task != nil,
            jobId: task?.jobId,
            // 只认"本进程还在等它结局"的那些。用词要准：这个入参喂的是 `.awaitSystemUpload`
            // （"一根手指都不许碰"），而唯一该不碰的情形是**另一次同步正挂在那个 continuation 上**
            // （后台一轮撞见前台同步在传）。刚盘点出来的孤儿**不是**不碰的理由 —— 它们已经被取消，
            // 这一轮该做的是用盘上的字节重传，让服务端幂等命中同一份来源。
            hasBackgroundUploadTask: systemUploadInFlight(payloadHash: task?.payloadHash),
            wantsFreshSync: wantsFresh
        )
        // 后台一轮「被派发了但什么都没做」与「压根没被派发」在服务端看是同一件事（都没有请求）。
        // 这一行把它们分开，也是排查活锁（每轮唤醒都落在 `.awaitSystemUpload`）的唯一入口。
        Self.report("background pass: action=\(String(describing: action))")
        switch action {
        case .nothingToDo, .awaitSystemUpload:
            // `.nothingToDo`：没有待办 ⇒ 立刻收工，报成功。
            // `.awaitSystemUpload`：字节归系统 ⇒ 一根手指都不许碰，连 `inspect` 都不做。
            return
        case .runAtomicUnit, .resumeJob, .startFreshSync:
            await sync(to: serverURL, apiToken: apiToken)
        }
        // 收工前重读一次：`performSync` 可能已经把任务清掉（`clearTask`）或新建了一个。
        // 用调用前的快照去报成败会在"这一轮正好做完了"时把成功报成失败。
        hasPendingTask = loadTask() != nil
    }

    private func performSync(to serverURL: URL?, apiToken: String, full: Bool) async {
        guard !isBusy else { return }
        guard let serverURL else {
            lastError = "请先连接 RAI 服务"
            message = nil
            return
        }
        // 上一次中止的来源只属于上一次。不重置的话，用户取消过一次之后，
        // 下一次同步会在握手后第一个 checkCancellation() 处立刻自杀。
        cancelCause = .none
        abandonedBatch = false
        taskDecodeError = nil
        #if os(iOS)
        isBusy = true
        let previousServerURL = activeServerURL
        activeServerURL = serverURL
        activeScope = Self.urlScope(for: serverURL)
        activeIdentity = nil
        if previousServerURL?.absoluteString != serverURL.absoluteString {
            lastSyncAt = nil
            lastWorkoutCount = nil
        }
        phase = SyncPhase.collecting.rawValue
        activeToken = apiToken
        lastError = nil
        message = "正在请求 Apple 健康权限"
        let previousIdleTimerState = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        var backgroundTask = UIBackgroundTaskIdentifier.invalid
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "rai-health-sync") {
            // 系统收回时间 ≠ 用户取消。这里必须走 lifecycle：写 "cancelled" 会让下一次同步的
            // `checkCancellation()` 把系统的决定当成用户意图，从此永久卡死。
            self.suspendForLifecycle()
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        defer {
            isBusy = false
            UIApplication.shared.isIdleTimerDisabled = previousIdleTimerState
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
            }
        }
        // 取消必须在任何网络/HealthKit 工作前生效。本函数不是 throwing，不能写 `try`；
        // 原先的 `try? Task.checkCancellation()` 会把取消错误直接吞掉，检查形同虚设。
        guard !Task.isCancelled else { finishCancelled(); return }
        // 🔴 锁屏预检查（文档 §3.4）。设备锁屏、或开机后尚未首次解锁时，HealthKit 数据库被
        // 硬件级加密锁死 —— 这里在动 HealthKit（以及握手）**之前**就拦下来，落一个可续接的
        // 阻塞态，而不是等第一次查询失败再报错。
        //
        // 为什么不能只靠 `HealthKitExport` 抛错兜底：那条路要到第一次查询才生效，而更早的
        // `readAuthorizationState()` 在锁屏时同样读不到状态（返回 `.unknown`），于是这里会先
        // 落一个 `failed` —— 用户看到一次"同步失败"，而解锁之后什么都不会自己发生。
        //
        // 位置刻意选在 `defer` 之后（`isBusy` 与续期额度都会被正确释放），也刻意在握手之前
        // （锁屏时那次握手没有任何用处，代价却是一次完整的网络往返）。
        if !Self.isProtectedDataAvailable {
            phase = HealthSyncBlockedRecovery.phase(for: .protectedData).rawValue
            message = HealthKitExportError.databaseLocked.localizedDescription
            lastError = nil
            // 记下"有事没做完"：`phase` 只活在进程内，而锁屏期间系统随时可能把 App 杀掉；
            // 磁盘上这份意图位是进程重启之后**唯一**还记得"该同步、但没同步成"的东西。
            recordBackgroundIntent()
            return
        }
        let identity: RaiHandshake
        do {
            identity = try await api.handshake(baseURL: serverURL, token: apiToken)
            try checkCancellation()
        } catch {
            if handleCancellation(error) { return }
            lastError = friendlyMessage(error)
            message = nil
            phase = SyncPhase.failed.rawValue
            return
        }
        activeScope = Self.syncScope(for: serverURL, identity: identity)
        activeIdentity = identity
        lastSyncAt = UserDefaults.standard.object(forKey: scopedKey(Self.lastSyncAtKey)) as? Date
        if UserDefaults.standard.object(forKey: scopedKey(Self.lastWorkoutCountKey)) != nil {
            lastWorkoutCount = UserDefaults.standard.integer(forKey: scopedKey(Self.lastWorkoutCountKey))
        }
        // A failed journal read is not an empty queue. Do not overwrite an
        // unresolved batch (or advance its anchor) while storage is unavailable.
        _ = loadTask()
        if let journalError = taskStore.lastError {
            lastError = journalError
            phase = SyncPhase.failed.rawValue
            message = nil
            return
        }
        // 磁盘上**有**进度但解不开，与"没有进度"必须分开处理。
        //
        // 当成"没有任务"的可见后果是：安静地重导整个窗口、把 `lastWorkoutCount` 归零，
        // 而 `sync_tasks` 里那一行还在 —— 看起来就是一次普通的成功同步。所以这里如实报错，
        // 并把那份进度**清掉**（它已经不可用，留着会让每次同步都撞同一个错误）。
        // 下一次同步从干净状态开始，正常跑完。
        if taskDecodeError != nil {
            guard discardUnreadableTask() else { return }
            lastError = taskDecodeError
            message = nil
            return
        }
        // 🔴 在推导"下一步做什么"**之前**盘点系统手上的传输。放在后面等于让
        // `SyncAtomicUnit.nextStep` 在"字节已经归系统"的情况下再发起一次上传 ——
        // 两份同样的字节同时打向服务端，其中一份必然撞 `import_upload_busy`（429）。
        // 取消掉它们不会丢东西：盘上的 multipart 还在，且 `boundary` 由 `payloadHash` 派生
        // ⇒ 重传的字节逐字节相同 ⇒ 服务端幂等命中同一条来源。
        await reconcileSystemUploads(loadTask())
        // 下一步由**字段**推导（`SyncAtomicUnit.nextStep`），不按 `phase` 字符串猜。
        // 猜错过一次：2026-09-22 那一版把"批次已上传、导入没发起"与"导入已在跑"写成同一个
        // `importing`，于是恢复分支只能二选一，线上的表现是 nginx 里再也没有 uploads。
        let restoredTask = loadTask()
        // 进度写点已在 `saveTask`/`clearTask` 里维护这个标志；这里补一次是为了让**重启后
        // 第一次读盘**也反映到界面上（`loadTask` 是唯一能看见磁盘上旧进度的地方）。
        hasPendingTask = restoredTask != nil
        let unitStep = SyncAtomicUnit.nextStep(
            full: full,
            sourceId: restoredTask?.sourceId,
            jobId: restoredTask?.jobId,
            hasZip: restoredTask.flatMap { persistedZipURL($0) } != nil,
            hasMultipart: restoredTask.flatMap { persistedMultipartURL(for: $0) } != nil
        )
        if let restored = restoredTask, unitStep == .inspect, let sourceId = restored.sourceId {
            do {
                phase = restored.resolvedPhase.rawValue
                message = "正在恢复上次同步任务"
                let inspection = try await inspect(sourceId: sourceId, on: serverURL)
                try checkCancellation()
                if inspection.status == "unchanged" {
                    let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                    // ⚠️ 顺序有讲究：**先删本地产物，再提交**。反过来的话（提交成功、
                    // 进程在删文件前被杀）会留下"没有任务行、却有一份多 GB 的 ZIP/multipart"
                    // 的孤儿 —— 而本仓没有任何 GC 会回收它（`removeTaskArtifacts` 之外
                    // 只有 `removeAllTaskArtifacts`，其唯一调用点在 payload 解不开时）。
                    // 现在这个顺序被杀只会留下"行还在、字节没了"，由 `SyncAtomicUnit`
                    // 的字段推导回到 `.export` 重导一次：多花时间，不丢数据、不漏磁盘。
                    removeTaskArtifacts(payloadHash: restored.payloadHash)
                    try markSuccess(
                        message: "Apple 健康数据已是最新" + (cleaned ? "" : Self.cleanupNoteSuffix),
                        exportEnd: restored.exportEnd,
                        workoutCount: restored.workoutCount,
                        advanceWatermark: restored.exportEnd != nil,
                        clearWatermark: restored.exportEnd == nil,
                        anchor: restored.pendingAnchor
                    )
                    return
                }
                let jobId: String
                if let existing = restored.jobId {
                    jobId = existing
                } else {
                    try checkCancellation()
                    let job = try await startImport(sourceId: sourceId, on: serverURL)
                    try checkCancellation()
                    try updateTask(jobId: job.id, phase: .importing)
                    jobId = job.id
                }
                // `waitForJob` 只在 `succeeded` 时返回，其余终态都抛错 ⇒ 走到下一行就是成功，
                // 返回值本身没有别的用途（旧代码拿它去清 failedZip 记录，那套机制已删除）。
                _ = try await waitForJob(id: jobId, on: serverURL)
                removeTaskArtifacts(payloadHash: restored.payloadHash)
                try markSuccess(
                    message: "已从上次同步任务恢复",
                    exportEnd: restored.exportEnd,
                    workoutCount: restored.workoutCount,
                    advanceWatermark: restored.exportEnd != nil,
                    clearWatermark: restored.exportEnd == nil,
                    anchor: restored.pendingAnchor
                )
                return
            } catch {
                if handleCancellation(error) { return }
                let httpError = error as? SyncHTTPError
                if HealthSyncResumePolicy.disposition(
                    statusCode: httpError?.statusCode,
                    errorCode: httpError?.code
                ) == .keepTask {
                    lastError = friendlyMessage(error)
                    message = nil
                    phase = SyncPhase.failed.rawValue
                    return
                }
                // 这个 task 不可能恢复了，先清掉它。留着它的后果不是"下次说不定能成"，
                // 而是下一次同步仍会从上面那句 `inspect(sourceId:)` 进来、拿到同一个 404：
                // 2026-09-22 线上实测，此后 nginx 日志里**再没有出现过任何 uploads**。
                guard clearTask() else { return }
                if httpError?.code == HealthSyncResumePolicy.terminalJobCode {
                    // 任务已经跑完并明确失败：把错误如实报出去。失败若是确定性的，
                    // 在这次点击里再悄悄跑一遍导入只是白跑一次；下一次同步从干净状态开始。
                    lastError = friendlyMessage(error)
                    message = nil
                    phase = SyncPhase.failed.rawValue
                    return
                }
                // 服务端已经没有这份暂存上传了（`sourceId` 已失效，且没有终结的任务挡路）：
                // 除了重新走一遍没有别的路，所以当场继续，而不是把这次点击留成一个错误提示
                // —— 「同步健康」按钮 / 前台自动同步都会立刻再撞同一个 404。
                // `clearTask()` 已经把它清掉，所以下面两个恢复分支都会自己跳过。
                phase = SyncPhase.collecting.rawValue
                message = nil
            }
        } else if let restored = restoredTask, unitStep == .upload, let persisted = persistedZipURL(restored) {
            do {
                phase = SyncPhase.uploading.rawValue
                message = "正在恢复已保存的健康数据批次"
                // 大包上传不做自动重试：600s 超时 ×3 最坏阻塞 30 分钟，超过整个导入窗口，
                // 也远超 iOS 后台任务的执行时限。**multipart 与 ZIP 都已落盘**，所以失败
                // 不再是"白读一次 HealthKit"—— 下次同步会从这里接着传，且用的是同一个
                // `batchId`（服务端幂等命中同一份来源，不产生第二份）。
                let sourceId = try await uploadWithRecovery(
                    zipURL: persisted,
                    payloadHash: restored.payloadHash,
                    to: serverURL
                )
                try checkCancellation()
                // 🔴 上传一返回就落 `uploaded`（"服务端已收下、导入还没发起"），
                // 而不是直接落 `importing`。中间这一态是 D1 的全部依据：`inspect` 与
                // `startImport` 之间才是"原子单元的中间"。少了它，恢复时又只能靠猜。
                phase = SyncPhase.uploaded.rawValue
                try updateTask(sourceId: sourceId, phase: .uploaded, uploadState: .completed)
                message = "正在检查健康数据"
                let inspection = try await withRetry {
                    try await self.inspect(sourceId: sourceId, on: serverURL)
                }
                try checkCancellation()
                if inspection.status == "unchanged" {
                    let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                    removeTaskArtifacts(payloadHash: restored.payloadHash)
                    try markSuccess(
                        message: "Apple 健康数据已是最新" + (cleaned ? "" : Self.cleanupNoteSuffix),
                        exportEnd: restored.exportEnd,
                        workoutCount: restored.workoutCount,
                        advanceWatermark: restored.exportEnd != nil,
                        clearWatermark: restored.exportEnd == nil,
                        anchor: restored.pendingAnchor
                    )
                } else {
                    try checkCancellation()
                    phase = SyncPhase.importing.rawValue
                    message = "正在导入并计算跑力"
                    let job = try await withRetry {
                        try await self.startImport(sourceId: sourceId, on: serverURL)
                    }
                    try checkCancellation()
                    try updateTask(jobId: job.id, phase: .importing)
                    _ = try await waitForJob(id: job.id, on: serverURL)
                    removeTaskArtifacts(payloadHash: restored.payloadHash)
                    try markSuccess(
                        message: "已从保存的健康数据批次恢复导入",
                        exportEnd: restored.exportEnd,
                        workoutCount: restored.workoutCount,
                        advanceWatermark: restored.exportEnd != nil,
                        clearWatermark: restored.exportEnd == nil,
                        anchor: restored.pendingAnchor
                    )
                }
                return
            } catch {
                if handleCancellation(error) { return }
                lastError = friendlyMessage(error)
                message = nil
                phase = SyncPhase.failed.rawValue
                // 不登记任何"待重试批次"：**进度本身就是那条记录**。失败时它被刻意留着
                // （phase 停在 `exported` 或 `uploaded`），`SyncAtomicUnit.nextStep` 下次会
                // 从同一份本地产物接着走，用的是同一个 `payloadHash` 作为 batchId。
                // 唯一例外是确定性坏批次 —— 那时 `uploadWithRecovery` 已经把产物删掉了。
                return
            }
        }
        // `batchHash` = 本次成功落盘的那一批的 `payloadHash`。只在成功收尾时用来删本地产物
        // （`zipName` / `multipartName` 都由它派生）—— 失败路径刻意不删：那正是续传的全部依据。
        var batchHash: String?
        var transientExportURL: URL?
        do {
            // Asking is not the same as being answered. HealthKit returns without
            // an error when the user refuses read access — later queries just yield
            // nothing — so an empty export used to be indistinguishable from "not
            // authorized" and was reported as a successful sync of 0 runs. Ask for
            // the request status instead and stop with a cause the user can act on.
            let authorization = try await HealthKitExport.readAuthorizationState()
            try checkCancellation()
            switch authorization {
            case .unavailable:
                lastError = HealthKitExportError.unavailable.localizedDescription
                message = nil
                phase = SyncPhase.failed.rawValue
                return
            case .notDetermined:
                lastError = HealthKitExportError.authorizationUndecided.localizedDescription
                message = nil
                phase = SyncPhase.failed.rawValue
                return
            case .unknown:
                // The store could not say whether access was ever requested. An
                // empty export from here would be a guess dressed as a success, so
                // stop with a cause the runner can act on instead.
                lastError = HealthKitExportError.authorizationCheckFailed.localizedDescription
                message = nil
                phase = SyncPhase.failed.rawValue
                return
            case .decided:
                break
            }
            try checkCancellation()
            if full {
                // 🔴 「重新导入全部」= 忘掉已提交的锚，从零重取。水位搬进 `sync_state` 之后
                // **两处都要清**：只清老键的话，`loadCommittedState` 会从 `sync_state` 把锚
                // 读回来，于是"全量重导"只做了前半程 —— 下一次同步又按老锚只取增量，
                // 而界面已经宣称"重新导入了全部"。漏掉哪一处都是**静默**的。
                taskStore.forgetState(scope: activeScope)
                UserDefaults.standard.removeObject(forKey: scopedKey(Self.lastWorkoutAnchorKey))
            }
            // 🔴 这里原先还有第三个恢复分支：「UserDefaults 里记着一个失败 ZIP ⇒ 直接重传它」。
            // 它已随 P1 删除，理由是它**与 `SyncAtomicUnit` 覆盖同一件事、判据却各不相同**：
            // 它用 `try? fileHash(...)` 现算 batchId（哈希失败 ⇒ 静默不发幂等头 ⇒ 服务端每次
            // 新建一份来源 ⇒ 同一份数据被反复导入），还把**绝对路径**写进 UserDefaults
            // （`SyncTaskState` 的说明里已经写明这是不安全的形状）。
            // 现在是单一机制：失败时进度留在 `sync_tasks` 里（phase 停在 `exported` /
            // `uploaded`），下次由 `SyncAtomicUnit.nextStep` 从同一份本地产物接着走。
            // 锚与导出水位都从 `loadCommittedState()` 一处取 —— 这是**唯一**的读取点。
            // 改造前它们各自直接读 `UserDefaults`（这里三处 + `markSuccess` 一写），
            // 而"两套真相"的全部代价都来自读取点分散：漏改一处就静默分裂。
            let committed = loadCommittedState()
            let lastExportEnd = committed?.exportEnd
            let lowerBound: Date? = (full || lastExportEnd == nil)
                ? nil
                : lastExportEnd!.addingTimeInterval(-Self.overlap)
            let anchor = full ? nil : committed?.workoutAnchor
            // 伴生 Route 状态必须在**导出开始之前**整批读出来：导出跑在脱离主线程的上下文里
            // （`HealthSyncCancellation.runDetached`），那里碰不了 `@MainActor` 的 `taskStore`。
            // 表很小（每 workout 一行），整表读比"导出中发现一个 uuid 再跨 actor 回来查"更省。
            // 读失败（`isAvailable == false`）时是空字典 ⇒ 每个 workout 都按首查处理，
            // 方向安全：多查一次，不会漏读轨迹。
            let routeStates = taskStore.loadRouteStates()
            let onProgress: @Sendable (String) async -> Void = { [weak self] status in
                await MainActor.run { [weak self] in
                    // 任何来源的中止一旦发生就不再发布晚到的进度：原因分类只影响 phase 怎么写，
                    // 不影响"中止后不要覆盖用户看到的文案"这条规则。
                    guard let self, !Task.isCancelled, self.cancelCause == .none else { return }
                    self.message = status
                }
            }
            let exported = try await HealthSyncCancellation.runDetached(
                priority: .userInitiated,
                onCancelledResult: { result in
                    try? FileManager.default.removeItem(at: result.zipURL)
                }
            ) {
                try await HealthKitExport.exportArchive(
                    from: lowerBound,
                    workoutAnchor: anchor,
                    routeStates: routeStates,
                    // 人工重扫 = `full`（"重新导入全部"）：所有 workout 的状态复位成 `active`，
                    // 于是这一轮每个都重查一次。它是 `settled` 唯一的唤醒通道。
                    routeForceRescan: full,
                    onProgress: onProgress
                )
            }
            transientExportURL = exported.zipURL
            try checkCancellation()
            // 先算哈希再落盘：名字里必须带哈希，而"落盘之后再算"会在哈希失败时留下一份
            // 来路不明的 ZIP（名字只能回退成 `upload.zip`，且没有进度能指向它）。
            let payloadHash = try fileHash(exported.zipURL)
            let persisted = try persistZip(exported.zipURL, payloadHash: payloadHash)
            transientExportURL = nil
            batchHash = payloadHash
            let pendingAnchor = exported.workoutAnchor
            // `exported` = "ZIP 已落盘、`payloadHash` 已算，还没上传"。写它而不是直接写
            // `uploading`，是为了让"有一份本地产物等着被发送"成为**可持久表达**的状态：
            // 崩溃在这个窗口里时，下次唤醒靠它知道不需要重读 HealthKit。
            phase = SyncPhase.exported.rawValue
            try saveTask(SyncTaskState(
                target: serverURL.absoluteString,
                serverId: identity.serverId,
                athleteId: identity.athleteId,
                datasetEpoch: identity.datasetEpoch,
                protocolVersion: identity.syncProtocolVersion,
                phase: SyncPhase.exported.rawValue,
                sourceId: nil,
                jobId: nil,
                payloadHash: payloadHash,
                pendingAnchor: pendingAnchor,
                exportEnd: exported.exportedThrough,
                workoutCount: exported.workoutCount,
                multipartFileName: Self.multipartName(for: payloadHash),
                zipFileName: Self.zipName(for: payloadHash),
                multipartBoundary: Self.multipartBoundary(for: payloadHash),
                uploadState: .pending
            ))
            try checkCancellation()
            phase = SyncPhase.uploading.rawValue
            message = "正在上传 \(exported.workoutCount) 次跑步"
            let sourceId = try await uploadWithRecovery(
                zipURL: persisted,
                payloadHash: payloadHash,
                to: serverURL
            )
            try checkCancellation()
            // 上传一返回就落 `uploaded`，理由同恢复分支：这是 D1 的中间态。
            phase = SyncPhase.uploaded.rawValue
            try updateTask(sourceId: sourceId, phase: .uploaded, uploadState: .completed)
            message = "正在检查健康数据"
            let inspection = try await withRetry {
                try await self.inspect(sourceId: sourceId, on: serverURL)
            }
            try checkCancellation()
            if inspection.status == "unchanged" {
                let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                // 先删本地产物、再提交。反过来的话，提交成功而进程死在删文件之前，
                // 留下的就是"没有任务行、却有一份多 GB 的 ZIP"的孤儿（本仓没有回收它的人）。
                // 现在这个顺序被杀只会退回 `.export` 重导一次：多花时间，不丢数据、不漏磁盘。
                removeTaskArtifacts(payloadHash: payloadHash)
                try markSuccess(
                    message: exportMessage(base: "Apple 健康数据已是最新", exported: exported)
                        + (cleaned ? "" : Self.cleanupNoteSuffix),
                    exportEnd: exported.exportedThrough,
                    workoutCount: exported.workoutCount,
                    advanceWatermark: true,
                    anchor: pendingAnchor,
                    routeStates: exported.routeStates
                )
            } else {
                try checkCancellation()
                phase = SyncPhase.importing.rawValue
                message = "正在导入并计算跑力"
                let job = try await withRetry {
                    try await self.startImport(sourceId: sourceId, on: serverURL)
                }
                try checkCancellation()
                try updateTask(sourceId: sourceId, jobId: job.id, phase: .importing)
                let finished = try await waitForJob(id: job.id, on: serverURL)
                removeTaskArtifacts(payloadHash: payloadHash)
                try markSuccess(
                    message: importMessage(exported: exported, job: finished),
                    exportEnd: exported.exportedThrough,
                    workoutCount: exported.workoutCount,
                    advanceWatermark: true,
                    anchor: pendingAnchor,
                    routeStates: exported.routeStates
                )
            }
        } catch {
            if let transientExportURL {
                try? FileManager.default.removeItem(at: transientExportURL)
            }
            if handleCancellation(error) { return }
            // 🔴 **兜底 catch 不许覆盖更具体的结论。** 这一段此前无条件写 `failed`，于是
            // "锁屏"与"等凭证"这两个**非失败**结论会被抹掉 —— 而它们各自都有正确的落点
            // （阻塞态）与各自的恢复路径（解锁通知 / 前台重新拿到凭证）。
            // 判据顺序也重要：先判阻塞，再落 `failed`。
            if let exportError = error as? HealthKitExportError, exportError == .databaseLocked {
                // 预检查通过之后设备才被锁上 —— 锁屏可以发生在任意两次 await 之间。
                phase = HealthSyncBlockedRecovery.phase(for: .protectedData).rawValue
                message = HealthKitExportError.databaseLocked.localizedDescription
                lastError = nil
                recordBackgroundIntent()
                return
            }
            if error is SyncCredentialRequiredError {
                // `uploadWithRecovery` 已经落好了 `auth_required` 与文案（它知道当时是哪个
                // 响应、盘上哪一批），这里只负责**不要**把它覆盖成失败。
                return
            }
            phase = SyncPhase.failed.rawValue
            lastError = friendlyMessage(error)
            message = nil
            // 与恢复分支同理：失败时**不登记**任何"待重试批次"，进度留在 `sync_tasks` 里
            // 就够了（phase 停在 `exported` 或 `uploaded`，下次由 `SyncAtomicUnit` 接着走）。
            // 确定性坏批次连本地产物都已被 `uploadWithRecovery` 删掉，下一次从新导出开始。
        }
        // 收尾兜底。正常情况下两个成功分支已经在 `markSuccess` 里**一次事务**把
        // 「水位前进 + 任务行清空」做完了（`SyncTaskStore.commitSuccess`），所以到这里的
        // `clearTask()` 是删 0 行的幂等调用。留着它的理由是"将来有人加一条不抛错、也没走
        // `markSuccess` 的提前返回"——那种形态下盘上会留着一行，界面会一直说"还卡着一批"。
        //
        // ⚠️ 清本地产物**只能在成功路径上发生**。中止路径（`handleCancellation` 返回 true）
        // 在这之前就已经 `return` 了，所以这里多出来的 phase 判断是第二道锁：
        // 它挡的是"将来有人加一条不抛错的提前返回"，那种形态下会把一份**还没发出去**的
        // 批次连字节一起删掉 —— 而 `phase` 是唯一能反映这件事的字段。
        let settled = lastError == nil && phase != SyncPhase.failed.rawValue
            && phase != SyncPhase.cancelled.rawValue
        if settled {
            if let batchHash { removeTaskArtifacts(payloadHash: batchHash) }
            guard clearTask() else { return }
            phase = SyncPhase.succeeded.rawValue
        }
        #else
        lastError = "读取 Apple 健康只能在 iPhone 上进行"
        #endif
    }

    func dismissStatus() {
        if !isBusy {
            message = nil
            lastError = nil
        }
    }

    /// 中止的落点。落点判据本身在 `HealthSyncLifecycle.phaseAfterStop`（纯函数，有执行者）——
    /// 这个文件不被任何回归脚本编译，写在这里的行为没人能断言。
    private func finishCancelled() {
        guard let next = HealthSyncLifecycle.phaseAfterStop(cause: cancelCause, current: phase) else {
            // 阶段早已结束，本次中止没有新信息可记；不动 phase / lastError，
            // 免得把失败原因抹成 idle、让用户看不到为什么失败。
            return
        }
        lastError = nil
        phase = next
        message = cancelCause == .manual ? "同步已取消" : "同步已暂停，下次连接继续"
    }

    private func checkCancellation() throws {
        try HealthSyncCancellation.check(manuallyCancelled: cancelCause == .manual)
    }

    @discardableResult
    private func handleCancellation(_ error: Error) -> Bool {
        let urlError = error as? URLError
        guard error is CancellationError || urlError?.code == .cancelled || Task.isCancelled else {
            return false
        }
        finishCancelled()
        return true
    }

    /// 成功收尾：**一次事务**把「水位前进/清空 + 任务行清空」落下去，然后才更新展示字段。
    ///
    /// 与改造前的区别（V2.1 规范 §2 原则 3「单状态源真相」）：
    ///   - anchor 与导出水位此前写在 `UserDefaults`、任务行写在 `sync_tasks`（SQLite）⇒
    ///     「这次同步已提交」被拆成**跨两个存储的两步写**；
    ///   - `clearExportWatermark()` 与 `markSuccess(advanceWatermark:)` 此前是一对调用
    ///     （四个恢复分支各一次），中间又是一条崩溃窗口；
    ///   - 现在两者都进 `SyncTaskStore.commitSuccess` 的同一个事务，"清空"用
    ///     `clearWatermark:` 表达，不再有独立的第二次调用。
    ///
    /// 🔴 提交前先过 `SyncStateCommitPlan.mayCommit` —— **阻塞态绝不推进 anchor**。
    /// 这条不变式此前在 `SyncPhase` 里定义、在 `HealthSyncBlockedRecovery` 里转发、在回归里
    /// 自比，却**没有任何生产调用点**：真正拦住它的是 `performSync` 里两处提前 `return`，
    /// 而那两处是"锁屏/等凭证该怎么办"的副产品，不是"anchor 该怎么写"的判据。
    /// 挂到这里之后，它才第一次出现在 anchor 的写入路径上。
    /// - Parameter routeStates: 本轮实际查询过的 workout 的伴生 Route 状态（键 = workout uuid）。
    ///   默认空 —— 只有**从导出一路走到底**的那两条分支有得传（`SyncAtomicUnit` 的续传分支
    ///   是接着一份已经落盘的本地产物走，没有本轮导出，也就没有新的观测）。
    private func markSuccess(
        message: String,
        exportEnd: Date?,
        workoutCount: Int,
        advanceWatermark: Bool,
        clearWatermark: Bool = false,
        anchor: Data? = nil,
        recordWorkoutCount: Bool = true,
        routeStates: [String: RouteSyncRecord] = [:]
    ) throws {
        try checkCancellation()
        guard SyncStateCommitPlan.mayCommit(phase: SyncPhase.migrate(phase)) else {
            // 走到这里说明调用点漏了阻塞态的前置返回 —— 而它的后果是**永久丢数据**
            // （把"这次没读到"记成"数据没有变化"，那段健康数据从此不再进入任何一次导出）。
            // 宁可让本次同步失败，也不许把 anchor 推上去。
            phase = SyncPhase.failed.rawValue
            lastError = "同步正在等待设备解锁或等待重新登录，本次不推进导出水位。"
            throw SyncHTTPError(message: lastError ?? "同步处于阻塞状态")
        }
        let watermark = SyncStateCommitPlan.watermark(
            advance: advanceWatermark,
            clear: clearWatermark,
            exportEnd: exportEnd
        )
        guard taskStore.commitSuccess(scope: activeScope, anchor: anchor, watermark: watermark) else {
            throw SyncHTTPError(message: taskStore.lastError ?? "同步进度未能保存")
        }
        // 🔴 「降频记忆」只能在**这次同步已经被判定成功之后**落盘，而且必须排在
        // `commitSuccess` 之后。反过来的话会出现一个不可自愈的窗口：状态机把某个 workout
        // 记成"已稳定、可以少查"，而这一批数据**从未真正交付到服务端**（上传失败、导入失败、
        // 或进程在导入中途被杀）。之后它一路降到 `settled`，而 `settled` 只有人工重扫能唤醒
        // ⇒ 服务端永远收不到这条轨迹，界面却一直显示同步成功。
        // 反过来（提交成功、记忆没写上）只损失一次"下次再多查一遍"，且下一轮会自己补上。
        //
        // 写失败**不**让本次同步变红：durable 的部分（水位 + 进度）已经提交，这里失败的后果
        // 只是"下一轮重查一次"。但也不静默——`upsertRouteStates` 会把原因推进
        // `taskStore.lastError`，并由 `SQLiteSupport.report` 打出带错误码的日志。
        if !routeStates.isEmpty, !taskStore.upsertRouteStates(Array(routeStates.values)) {
            NSLog("[RAI] route state flush after commit failed: %@", taskStore.lastError ?? "unknown")
        }
        // `hasPendingTask` 只在**真的清掉了那一行**之后才翻 —— 它现在与 `clearTask()` 同为
        // 日志清空点，两处是判据要求的全部（多一处就等于界面可以凭空说"没有待办了"）。
        hasPendingTask = false
        // 老键只在**提交成功之后**删：迁移期回退读的正是它们，先删就等于把回退路径拆掉。
        // 老键存在与否同时是"这一 scope 还没迁移"的判据（见 `loadCommittedState`）。
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.lastWorkoutAnchorKey))
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.lastExportEndKey))
        let now = Date()
        // 下面这三个键**刻意留在 `UserDefaults`**：它们丢了都无害（只影响展示与 15 分钟节流），
        // 而搬进来会顺带改掉它们的 scope 语义 —— `lastAutoSyncKey` 用的是 `urlScope`
        // （去端口去 path/query），其余用 `activeScope`，统一 key 会**静默**改掉节流窗口。
        if let activeServerURL {
            UserDefaults.standard.set(now, forKey: scopedKey(Self.lastAutoSyncKey, scope: Self.urlScope(for: activeServerURL)))
        }
        UserDefaults.standard.set(now, forKey: scopedKey(Self.lastSyncAtKey))
        // Only advance a count that is actually known: a restored task carries the
        // count of the run it is finishing, and writing the `0` stand-in for "no
        // count available" would replace a real number with a wrong one.
        if recordWorkoutCount {
            UserDefaults.standard.set(workoutCount, forKey: scopedKey(Self.lastWorkoutCountKey))
            lastWorkoutCount = workoutCount
        }
        lastSyncAt = now
        lastError = nil
        self.message = message
        dataUpdatedGeneration += 1
        phase = SyncPhase.succeeded.rawValue
    }

    #if os(iOS)
    private func importMessage(exported: HealthKitExportResult, job: ImportJobResponse) -> String {
        let base: String
        if let summary = job.summary {
            let inserted = summary.insertedWorkouts ?? 0
            let updated = summary.updatedWorkouts ?? 0
            if inserted == 0 && updated == 0 {
                base = "Apple 健康数据已是最新"
            } else if inserted > 0 && updated > 0 {
                base = "已从 Apple 健康导入 \(inserted) 次、更新 \(updated) 次跑步"
            } else if updated > 0 {
                base = "已更新 \(updated) 次跑步"
            } else {
                base = "已从 Apple 健康导入 \(inserted) 次跑步"
            }
        } else {
            base = "已从 Apple 健康导入 \(exported.workoutCount) 次跑步"
        }
        return exportMessage(base: base, exported: exported)
    }

    private func latestMessage(base: String, warnings: [String]) -> String {
        guard !warnings.isEmpty else { return base }
        return "\(base)（\(warnings.joined(separator: "；"))）"
    }

    /// The line for a finished export, with the empty case named.
    ///
    /// HealthKit answers a *refused* read request exactly like an authorized one
    /// with nothing in it: no error, no warning, an empty archive. `readAuthorizationState`
    /// can only catch the "never asked" case — once the user has answered, allowed
    /// or refused, the status reads `.unnecessary` either way. So when the export
    /// comes back with nothing at all, the honest move is to name the possibility
    /// rather than report "已是最新" over data the app may never have been allowed
    /// to see.
    private func exportMessage(base: String, exported: HealthKitExportResult) -> String {
        // `routeCount` 自 T1（按 workout 定频）起语义为「本轮**实际查询到**的 workout 数」，
        // 不再等于「窗口内有轨迹的 workout 数」；降频后它必然偏小，但这**不是 bug**。
        // 此处只把三者当成「这一轮有没有读到任何东西」的判据（任一非 0 即非空导出），
        // 所以偏小的值不会误报。⚠️ 将来若要展示「导出了几条轨迹」，**不要**直接读这个字段
        // —— 它会给出一个偏小的数且不报错。详见 `HealthKitExportResult.routeCount` 的声明注释。
        guard exported.workoutCount == 0, exported.recordCount == 0, exported.routeCount == 0 else {
            return latestMessage(base: base, warnings: exported.warnings)
        }
        return latestMessage(base: base, warnings: exported.warnings + [Self.emptyExportHint])
    }

    private static let emptyExportHint =
        "未读到任何健康数据：若你曾在权限弹窗点过「不允许」，"
        + "请在 iPhone 设置 → 健康 → 数据访问与设备 中打开 RAI 的读取权限。"
    #endif

    /// 上传一批并处理失败。
    ///
    /// 与裸 `upload` 的区别只有一处，但它是 P1 的全部价值：**失败之后本批还能不能用**。
    /// 判据在 `SyncUploadRecovery`（纯函数、有执行者），这里的职责只是把它的结论落成动作。
    ///
    /// 大包上传不做**通用**重试（600s 超时 ×3 最坏阻塞 30 分钟，超过整个导入窗口，也远超
    /// iOS 后台任务的执行时限）。唯一的例外是并发占用：那是"现在不行"，值得当场让一次。
    private func uploadWithRecovery(zipURL: URL, payloadHash: String, to serverURL: URL) async throws -> String {
        do {
            return try await withRetry(attempts: 1) {
                try await self.upload(zipURL: zipURL, to: serverURL, payloadHash: payloadHash)
            }
        } catch {
            // 取消不是"这一批好不好"的证据，不参与分类。
            if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled {
                throw CancellationError()
            }
            let httpError = error as? SyncHTTPError
            // 🔴 凭证失效**先判**（文档 §3.3）：它既不该删批次（字节完好），也不该在后台
            // 无限重试（每次唤醒撞同一个 401）。落 `auth_required` 之后，唤醒它的是
            // "前台拿到有效凭证"，而不是时间。
            if SyncUploadRecovery.isCredentialFailure(statusCode: httpError?.statusCode) {
                phase = HealthSyncBlockedRecovery.phase(for: .credential).rawValue
                message = "登录状态已失效，请重新登录后继续同步"
                lastError = nil
                // 盘上那份任务的自述也要跟着改：只改内存变量的话，进程被杀之后"卡在等凭证"
                // 就没了痕迹，下次唤醒除了再撞一次 401 无事可做。
                // ⚠️ `SyncAtomicUnit.nextStep` 只看**字段**（`hasZip` / `hasMultipart`），
                // 所以盘上这个 phase 不改变恢复分支走哪条路 —— 它只是把"为什么停在这里"
                // 如实记下来（给界面与排查用），这也是文档要求"可持久表达的阻塞态"的落点。
                try? updateTask(phase: .authRequired)
                throw SyncCredentialRequiredError()
            }
            let action = SyncUploadRecovery.disposition(
                statusCode: httpError?.statusCode,
                errorCode: httpError?.code
            )
            switch action {
            case .abandonBatch:
                // 这一批的字节不得再被发送 ⇒ multipart（唯一用途是被发送）与 ZIP
                // （用途是重建 multipart 再发送）同时作废。**不是顺手删掉**。
                // 置位之后，失败收尾不会再把它登记成待续传批次 —— 否则每次同步都会
                // 拿同一份字节再撞一次，而服务端的拒绝是确定性的。
                abandonedBatch = true
                removeTaskArtifacts(payloadHash: payloadHash)
                throw error
            case .backOffAndRetry:
                // 并发占用：退避后**同 batchId** 再试一次（幂等键保证不会多出一份来源）。
                message = "服务端正在处理另一项上传，稍后自动重试"
                try? await Task.sleep(for: .seconds(5))
                try checkCancellation()
                do {
                    return try await withRetry(attempts: 1) {
                        try await self.upload(zipURL: zipURL, to: serverURL, payloadHash: payloadHash)
                    }
                } catch {
                    if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled {
                        throw CancellationError()
                    }
                    throw error
                }
            case .keepForNextWake:
                throw error
            }
        }
    }

    /// 构建 multipart 并上传。
    ///
    /// 🔴 这里**没有** `defer { removeItem(multipartURL) }`。原先有，那是"上传必须在本次调用内
    /// 结束"这个前提的产物；一旦字节归**系统**所有（P2-4 起走 background URLSession），
    /// 函数返回就删文件等于把续传能力一并删掉。这个文件的生命周期现在由**终结结果**决定：
    /// 成功由 `removeTaskArtifacts` 删，确定性坏批次由 `uploadWithRecovery` 删，
    /// 瞬时失败与生命周期中止留着给下次唤醒续传（续传用的 batchId 不变，服务端幂等命中）。
    ///
    /// 本函数返回**只代表"这次等待结束了"**，不代表"系统不再搬运这批字节"：生命周期中止会把
    /// 等待者摘掉而让传输继续（`RaiBackgroundUploadSession.abandonWaiting`）。所以"字节归谁"
    /// 的判据是 `RaiBackgroundUploadSession.hasInFlightUpload`，不是本函数有没有返回。
    private func upload(zipURL: URL, to serverURL: URL, payloadHash: String) async throws -> String {
        try checkCancellation()
        // boundary 由 `payloadHash` 派生 ⇒ 重建出来的 multipart 与上一次**逐字节相同**。
        // 随机 boundary 会让"重传"变成"一份看起来不同、内容相同的包"。
        let boundary = Self.multipartBoundary(for: payloadHash)
        try ensureArtifactFolder()
        let multipartURL = artifactURL(named: Self.multipartName(for: payloadHash))
        try await HealthSyncCancellation.runDetached(priority: .utility) {
            try writeHealthKitMultipart(zipURL: zipURL, boundary: boundary, to: multipartURL)
        }
        protect(multipartURL)
        try checkCancellation()

        var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/uploads"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        // 幂等键恒等于 `payloadHash`（sha256 小写 hex，64 位，满足服务端正则
        // `import-routes.ts:42` 的 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`）。
        // 旧代码这里是 `try? fileHash(...)`：哈希失败就**静默地不发这个头**，
        // 于是服务端每次都新建一份来源 ⇒ 同一份数据被反复导入，且没有任何迹象。
        request.setValue(payloadHash, forHTTPHeaderField: "X-RAI-Sync-Batch")
        // 600 s 只对**前台**那条 `session` 有意义：后台 session 永远等待连通，等待期间
        // `timeoutIntervalForRequest` 不生效（`NSURLSession.h:769-771`），真正的约束是它的
        // `timeoutIntervalForResource`（1 小时，见 `RaiBackgroundUploadSession.makeSession`）。
        // 留着这一行不是残留：切回前台路径时它仍然是超时口径的唯一来源。
        request.timeoutInterval = 600
        // 🔴 先落盘"字节正要归系统所有"，**再**把字节交出去。次序反了就会出现一个窗口：
        // 字节已经在系统手上、而盘上还写着 `pending` —— 进程在那个窗口里被杀，下次唤醒会用
        // 同一个 batchId 再传一遍（幂等，白费一次带宽）。反过来（先写 `inFlight` 再交出去）
        // 最坏只是"盘上说在飞、其实没飞"，而那条路由 `clearStaleUploadState` 收尾。
        // 两个方向都不会写坏数据，所以把代价放在便宜的那一侧。
        //
        // 写失败**中止上传**（与 `saveTask` 的纪律一致：写不进去就不能推进网络动作）——
        // 一行进展都记不住的批次，传上去也没人能接住它。
        try updateTask(phase: .uploading, uploadState: .inFlight)
        let (data, response) = try await uploadToSystem(request, from: multipartURL, payloadHash: payloadHash)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        // 这里**不写** `uploadState = .completed`：调用方紧接着就会用
        // `updateTask(sourceId:phase: .uploaded, uploadState: .completed)` 把 `sourceId` 与自述
        // 一起落盘（`performSync` 的恢复分支与新建分支各一处）。在这里再写一次，既重复，
        // 又会在"上传成功但这次写失败"时制造一条与调用方不一致的中间态。
        return try JSONDecoder().decode(UploadResponse.self, from: data).sourceId
    }

    private func inspect(sourceId: String, on serverURL: URL) async throws -> InspectionResponse {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/inspect"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["sourceId": sourceId])
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(InspectionResponse.self, from: data)
    }

    private func startImport(sourceId: String, on serverURL: URL) async throws -> ImportJobResponse {
        try await HealthSyncMutationRetry.run(
            isConflict: { error in
                guard let error = error as? SyncHTTPError else { return false }
                return error.statusCode == 409 && error.code == "mutation_conflict"
            },
            onWait: { self.message = "服务端正在处理上一项任务，完成后将自动继续同步" },
            operation: { try await self.submitImport(sourceId: sourceId, on: serverURL) }
        )
    }

    private func submitImport(sourceId: String, on serverURL: URL) async throws -> ImportJobResponse {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["sourceId": sourceId])
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        if (response as? HTTPURLResponse)?.statusCode == 409 {
            if let active = try await activeImport(on: serverURL), active.sourceId == sourceId {
                return active
            }
        }
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(ImportJobResponse.self, from: data)
    }

    private func activeImport(on serverURL: URL) async throws -> ImportJobResponse? {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs/active"))
        addAuthorization(to: &request)
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        if data.isEmpty { return nil }
        return try JSONDecoder().decode(ImportJobResponse?.self, from: data)
    }

    private func deleteUpload(sourceId: String, on serverURL: URL) async throws -> Bool {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-sources/\(sourceId)"))
        addAuthorization(to: &request)
        request.httpMethod = "DELETE"
        do {
            let (_, response) = try await session.data(for: request)
            try checkCancellation()
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // 404 means the staging upload is already gone, which is the outcome
            // this call wants — only an uncompromising failure is worth reporting.
            return (200...299).contains(status) || status == 404
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled {
                throw CancellationError()
            }
            // Deliberately not rethrown: the import already landed, and failing the
            // sync over an uncollected temporary would be a worse trade. The caller
            // says so in the message instead of dropping it on the floor.
            return false
        }
    }

    /// Appended when the server took the import but did not confirm deleting the
    /// staging upload. Harmless (it is reclaimed on the next sync) but not silent.
    private static let cleanupNoteSuffix = "（服务端临时上传源未清理，下次同步会回收）"

    private func waitForJob(id: String, on serverURL: URL) async throws -> ImportJobResponse {
        let started = ContinuousClock.now
        let deadline = started.advanced(by: .seconds(30 * 60))
        var idleFailures = 0
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            do {
                let job = try await getJob(id: id, on: serverURL)
                try checkCancellation()
                idleFailures = 0
                if !job.message.isEmpty {
                    message = job.message
                } else if !job.phase.isEmpty {
                    message = job.phase
                }
                switch job.status {
                case "succeeded":
                    return job
                case "failed", "cancelled", "interrupted":
                    // 带上 code 再抛：恢复分支要靠它把「任务已终结」与「瞬时读不到」分开 ——
                    // 终结的任务拿同一个 jobId 再等只是重放同一个错误，那个 task 必须被放弃。
                    throw SyncHTTPError(message: job.error ?? "导入失败", code: HealthSyncResumePolicy.terminalJobCode)
                default:
                    try await Task.sleep(for: HealthSyncPolling.delay(elapsed: started.duration(to: .now)))
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as SyncHTTPError {
                let retryable = HealthSyncPolling.shouldRetryHTTP(statusCode: error.statusCode)
                if !retryable {
                    throw error
                }
                idleFailures += 1
                if idleFailures >= 8 {
                    throw error
                }
                message = "导入仍在进行，正在重新连接服务器"
                try await Task.sleep(for: .seconds(2))
            } catch {
                idleFailures += 1
                if idleFailures >= 8 {
                    throw error
                }
                message = "导入仍在进行，正在重新连接服务器"
                try await Task.sleep(for: .seconds(2))
            }
        }
        throw SyncHTTPError(message: "导入超时，请打开「数据与模型」查看任务状态")
    }

    private func getJob(id: String, on serverURL: URL) async throws -> ImportJobResponse {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs/\(id)"))
        addAuthorization(to: &request)
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(ImportJobResponse.self, from: data)
    }

    private func endpoint(_ base: URL, path: String) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.path = path
        components.query = nil
        components.fragment = nil
        return components.url ?? base
    }

    private func addAuthorization(to request: inout URLRequest) {
        if !activeToken.isEmpty { request.setValue("Bearer \(activeToken)", forHTTPHeaderField: "Authorization") }
    }

    private func withRetry<T>(
        attempts: Int = 3,
        operation: @escaping () async throws -> T
    ) async throws -> T {
        var lastError: Error?
        for attempt in 0..<attempts {
            try checkCancellation()
            do {
                return try await operation()
            } catch is CancellationError {
                // 取消不是可重试失败：否则会退避等待后再发一次请求，用户看到"点了取消仍在跑"。
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as SyncHTTPError {
                if error.statusCode.map({ (400...499).contains($0) && $0 != 429 }) == true {
                    throw error
                }
                lastError = error
            } catch {
                lastError = error
            }
            if attempt < attempts - 1 {
                try await Task.sleep(for: .seconds(Double(1 << attempt)))
            }
        }
        throw lastError ?? SyncHTTPError(message: "请求失败")
    }

    private func throwIfNeeded(_ response: URLResponse, data: Data) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            if let payload = try? JSONDecoder().decode(APIErrorMessage.self, from: data),
               let message = payload.message, !message.isEmpty {
                throw SyncHTTPError(message: message, statusCode: status, code: payload.code)
            }
            throw SyncHTTPError(message: "服务器返回 HTTP \(status)", statusCode: status)
        }
    }

    // MARK: 本地批次产物（ZIP 与 multipart）

    /// 批次产物一律放在 `Application Support/rai-healthkit-<scope>/`。
    ///
    /// 不能用 `/tmp`（系统会清理，而"续传"的全部前提就是字节还在），也不能用
    /// `Caches`（磁盘紧张时会被系统删）—— 两者的失效方式都是"某天起续传悄悄变成重导"。
    private func artifactFolder() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("rai-healthkit-\(activeScope)", isDirectory: true)
    }

    private func artifactURL(named name: String) -> URL {
        artifactFolder().appendingPathComponent(name)
    }

    private func ensureArtifactFolder() throws {
        try FileManager.default.createDirectory(at: artifactFolder(), withIntermediateDirectories: true)
    }

    /// 批次产物一律 `.completeUntilFirstUserAuthentication`，且不进备份。
    ///
    /// 不能用 `.complete`：锁屏后后台读不到文件，现象是**后台上传偶发
    /// `NSFileReadNoSuchFileError`、解锁后同一操作必成功** —— 最难查的一类不一致
    /// （`friendlyMessage` 里就有这条分支）。与 `CacheStore.swift:46-49`、
    /// `SyncTaskStore.swift:60-71` 保持一致。
    ///
    /// 排除备份的理由是体积：一次全量导出可以是好几个 GB，让 iCloud 备份多背一份
    /// "随时可以重新生成"的字节没有道理。
    private func protect(_ url: URL) {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = url
        try? mutable.setResourceValues(values)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
    }

    /// 把导出的 ZIP 落到持久位置，并按 `payloadHash` 命名。
    ///
    /// 名字里带哈希不是命名洁癖：它让"这个文件属于哪一批"由文件名本身回答，
    /// 于是恢复时不必对几个 GB 的包重算哈希（旧实现 `pendingTaskZip` 会对**每个候选
    /// 路径**跑一次整文件哈希，代价是几十秒到几分钟）。
    ///
    /// 用 `copyItem` 而不是重新打包：服务端幂等只比**归档字节**
    /// （`import-sources.ts:326-329`），逐字节相同才命中同一份来源。
    @discardableResult
    private func persistZip(_ zipURL: URL, payloadHash: String) throws -> URL {
        try ensureArtifactFolder()
        let durable = artifactURL(named: Self.zipName(for: payloadHash))
        if FileManager.default.fileExists(atPath: durable.path) {
            try FileManager.default.removeItem(at: durable)
        }
        try FileManager.default.copyItem(at: zipURL, to: durable)
        protect(durable)
        try? FileManager.default.removeItem(at: zipURL)
        return durable
    }

    /// 删掉某一批的全部本地产物。
    ///
    /// 顺带删一次老名字（`upload.zip`）：它是历史版本的产物，留着只会在升级后
    /// 白占一份几个 GB 的空间，而这里是唯一会碰这些文件的地方。
    private func removeTaskArtifacts(payloadHash: String) {
        for url in [
            artifactURL(named: Self.zipName(for: payloadHash)),
            artifactURL(named: Self.multipartName(for: payloadHash)),
            artifactURL(named: Self.legacyZipName)
        ] {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// 丢掉**整个 scope** 的本地产物。
    ///
    /// 只在"进度读不出来"时用：文件名由 `payloadHash` 派生，而 `payloadHash` 正是
    /// 读不出来的那个字段 —— 没有别的途径能把它们对应回任何一批，留着就是永久孤儿。
    private func removeAllTaskArtifacts() {
        let folder = artifactFolder()
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return }
        for name in names where name.hasPrefix("upload-") || name == Self.legacyZipName {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
    }

    /// 按任务**记录的字段**解析出本地产物，不看目录里有什么。
    ///
    /// 两条纪律：
    ///   - `target` 必须与当前服务器一致 —— 否则会把 A 服务器的批次传给 B；
    ///   - 🔴 老 payload 只存了哈希、没存文件名（`zipFileName == nil`）。名字相同**不代表
    ///     批次相同**：`persistZip` 是覆盖写，崩溃窗口里可能留下"新文件 + 老 task"。
    ///     所以这条回退路径必须校验哈希。代价是一次整文件哈希，且只在**升级时仍有在飞
    ///     任务**这一次付出 —— 其余情况全部靠文件名，零哈希。
    private func persistedZipURL(_ task: SyncTaskState) -> URL? {
        guard task.target == activeServerURL?.absoluteString else { return nil }
        let file = task.zipFileName ?? Self.legacyZipName
        let url = artifactURL(named: file)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        if task.zipFileName == nil, (try? fileHash(url)) != task.payloadHash { return nil }
        return url
    }

    /// multipart 的名字即使对老 payload 也是可推的（由 `payloadHash` 派生），
    /// 而老版本从来没有持久化过 multipart ⇒ 这条回退在升级场景下恒为 `nil`，不会误判。
    private func persistedMultipartURL(for task: SyncTaskState) -> URL? {
        guard task.target == activeServerURL?.absoluteString else { return nil }
        let file = task.multipartFileName ?? Self.multipartName(for: task.payloadHash)
        let url = artifactURL(named: file)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// 已提交的水位（anchor + 导出水位）。**这是唯一的读取点**，锚与水位的所有读者都走它。
    ///
    /// 真相在 `sync_state`（与任务进度同库同事务）；老 `UserDefaults` 键**只在迁移期**兜底。
    /// 回退判据是"这一 scope 在 `sync_state` 里**还没有行**"，不是"字段是不是空" ——
    /// `anchor` 与 `export_end` 各自都可以合法地是空值（`.keep` / `.clear`），
    /// 拿"值是不是空"当迁移判据，会把一次合法的"清空水位"误读成"还没迁移"从而把老值读回来。
    ///
    /// 「`sync_state` 有行 ⇒ 老键已被删」这条不变式由**写方**保证：`markSuccess` 在提交成功后
    /// 才删老键，`full` 那条路同时 `forgetState` + 删老键。两处都做全，迁移期就不存在
    /// "两边都有值且不一致"的第三态。
    ///
    /// ⚠️ 读失败（`lastError != nil`）时返回 nil，与 `loadTask` 同一口径：日志读不出来时宁可
    /// 退化成"没有水位"（多做一次全量导出），也不要拿一个来路不明的值去推进。
    private func loadCommittedState() -> SyncTaskStore.CommittedState? {
        let committed = taskStore.loadState(scope: activeScope)
        guard taskStore.lastError == nil else { return nil }
        if let committed { return committed }
        var legacy = SyncTaskStore.CommittedState()
        legacy.workoutAnchor = UserDefaults.standard.data(forKey: scopedKey(Self.lastWorkoutAnchorKey))
        legacy.exportEnd = UserDefaults.standard.object(forKey: scopedKey(Self.lastExportEndKey)) as? Date
        // 两个都没有 ⇒ 返回 nil，与"没有这一行"等价（否则一次全量导出会被 `full` 的判据
        // 之外的分支当成"水位存在但为空"，走向另一条路）。
        return legacy == SyncTaskStore.CommittedState() ? nil : legacy
    }

    private func scopedKey(_ key: String) -> String {
        scopedKey(key, scope: activeScope)
    }

    private func scopedKey(_ key: String, scope: String) -> String {
        "\(key).\(scope)"
    }

    /// The SQLite journal is authoritative. Legacy UserDefaults data is read
    /// only for migration; a failed write must not advance a network operation.
    private func saveTask(_ task: SyncTaskState) throws {
        let data = try JSONEncoder().encode(task)
        guard taskStore.save(data, scope: activeScope) else {
            throw SyncHTTPError(message: taskStore.lastError ?? "同步进度未能保存")
        }
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.taskKey))
        hasPendingTask = true
    }

    private func loadTask() -> SyncTaskState? {
        let decoder = JSONDecoder()
        let journal = taskStore.load(scope: activeScope)
        guard taskStore.lastError == nil else { return nil }
        let candidates: [Data] = [
            journal,
            UserDefaults.standard.data(forKey: scopedKey(Self.taskKey, scope: activeScope)),
            activeServerURL.flatMap { UserDefaults.standard.data(forKey: scopedKey(Self.taskKey, scope: Self.urlScope(for: $0))) }
        ].compactMap { $0 }
        var unreadable = false
        for data in candidates {
            // 🔴 `try?` 在这里是被**刻意**保留下来的：不是所有候选都必须解得出
            // （排在后面的老 UserDefaults 记录本来就可能是别的版本的）。但它不能被
            // 当成"没有任务" —— 那正是 R6 的形态：加一个非可选字段 ⇒ 整份任务解不开 ⇒
            // 老设备升级后首次同步做一次**全量重导**，而 `sync_tasks` 里那一行还在。
            guard let task = try? decoder.decode(SyncTaskState.self, from: data) else {
                unreadable = true
                continue
            }
            guard isCurrentTask(task) else { continue }
            if journal == nil && !taskStore.save(data, scope: activeScope) { return nil }
            return task
        }
        if unreadable {
            taskDecodeError = "发现一份由其他版本 App 写入的同步进度，无法读取，已按新任务重新开始。"
        }
        return nil
    }

    /// 丢掉一份**读不懂**的进度，连同它可能引用过的本地产物。
    ///
    /// 为什么要清：不清的话每次同步都会走到同一个错误上，变成永久失败。为什么可以清：
    /// 读得出来的信息只剩"某个版本的进度曾存在过"，里面的 `jobId` / `payloadHash`
    /// 一个都取不到 —— 留着也不可能续接。清掉之后下一次同步是干净状态。
    private func discardUnreadableTask() -> Bool {
        guard clearTask() else { return false }
        removeAllTaskArtifacts()
        return true
    }

    private func isCurrentTask(_ task: SyncTaskState) -> Bool {
        guard task.target == activeServerURL?.absoluteString else { return false }
        if let serverId = task.serverId, serverId != activeIdentity?.serverId { return false }
        if let athleteId = task.athleteId, athleteId != activeIdentity?.athleteId { return false }
        if let datasetEpoch = task.datasetEpoch, datasetEpoch != activeIdentity?.datasetEpoch { return false }
        if let protocolVersion = task.protocolVersion, protocolVersion != activeIdentity?.syncProtocolVersion { return false }
        return true
    }

    /// 进度写入的**唯一**入口。
    ///
    /// 形参是 `SyncPhase` 而不是 `String`：阶段闭集的约束因此由编译器执行，而不是靠
    /// 评审时数清单 —— 后者在本仓已经失效过一次（同一份阶段名单被抄成三份）。
    private func updateTask(
        sourceId: String? = nil,
        jobId: String? = nil,
        phase: SyncPhase,
        uploadState: SyncUploadState? = nil
    ) throws {
        guard var task = loadTask() else { throw SyncHTTPError(message: "同步进度无法读取，已停止本次操作") }
        task.sourceId = sourceId ?? task.sourceId
        task.jobId = jobId ?? task.jobId
        task.phase = phase.rawValue
        if let uploadState { task.uploadState = uploadState }
        try saveTask(task)
    }

    @discardableResult
    private func clearTask() -> Bool {
        guard taskStore.clear(scope: activeScope) else {
            lastError = taskStore.lastError ?? "同步进度未能清理，下次连接将重新确认"
            phase = SyncPhase.failed.rawValue
            return false
        }
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.taskKey))
        if let activeServerURL {
            UserDefaults.standard.removeObject(
                forKey: scopedKey(Self.taskKey, scope: Self.urlScope(for: activeServerURL))
            )
        }
        hasPendingTask = false
        return true
    }

    private func fileHash(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func urlScope(for url: URL) -> String {
        let canonical = ServerSession.canonicalURL(url)
        let digest = SHA256.hash(data: Data(canonical.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return String(digest.prefix(24))
    }

    private static func syncScope(for url: URL, identity: RaiHandshake) -> String {
        let value = [url.absoluteString, identity.serverId, identity.athleteId, identity.datasetEpoch].joined(separator: "|")
        let digest = SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
        return String(digest.prefix(24))
    }

    private func friendlyMessage(_ error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            return "网络中断。请检查 RAI 服务和网络后重试。"
        }
        if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileReadNoSuchFileError {
            return "本地健康导出文件已丢失，请再点一次「同步健康」。"
        }
        return error.localizedDescription
    }
}

private struct UploadResponse: Decodable {
    let sourceId: String
}

private struct InspectionResponse: Decodable {
    let status: String
}

private struct ImportJobResponse: Decodable {
    let id: String
    let sourceId: String?
    let status: String
    let phase: String
    let message: String
    let error: String?
    let summary: ImportJobSummary?
}

private struct ImportJobSummary: Decodable {
    let insertedWorkouts: Int?
    let updatedWorkouts: Int?
}

private struct APIErrorMessage: Decodable {
    let message: String?
    let code: String?
}

private struct SyncHTTPError: LocalizedError {
    let message: String
    var statusCode: Int?
    var code: String?
    var errorDescription: String? { message }
}

// `SyncTaskState` 已搬到 `SyncTaskState.swift`：本文件不被任何回归脚本编译，
// 放这里的类型连"能不能读老 payload"都断言不了。


nonisolated private func writeHealthKitMultipart(zipURL: URL, boundary: String, to outputURL: URL) throws {
    try Task.checkCancellation()
    FileManager.default.createFile(atPath: outputURL.path, contents: nil)
    let output = try FileHandle(forWritingTo: outputURL)
    defer { try? output.close() }
    let header = Data("""
    --\(boundary)\r
    Content-Disposition: form-data; name="file"; filename="apple-health-healthkit.zip"\r
    Content-Type: application/zip\r
    \r

    """.utf8)
    try output.write(contentsOf: header)
    try Task.checkCancellation()
    let input = try FileHandle(forReadingFrom: zipURL)
    defer { try? input.close() }
    while true {
        try Task.checkCancellation()
        let chunk = try input.read(upToCount: 1024 * 1024) ?? Data()
        if chunk.isEmpty { break }
        try output.write(contentsOf: chunk)
    }
    try Task.checkCancellation()
    try output.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
}
