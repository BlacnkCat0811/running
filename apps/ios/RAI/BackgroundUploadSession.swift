#if os(iOS)
import Foundation

/// 由**系统**负责搬运字节的 `URLSession`。
///
/// 为什么需要它（而不是继续用 `.ephemeral`）：一次全量导出可以是几个 GB，而 App 拿到的
/// 后台执行时间只有秒级（`beginBackgroundTask` 约 30 s，且额度到了就会被系统收回）。
/// `.ephemeral` 的传输活不过进程挂起；带 identifier 的 background session 由系统持有，
/// 进程被杀也照常传完 —— 这是三个机制里唯一能跨进程存活的搬运能力。
///
/// 🔴 与前台 session 的三条语义差异（都来自本机 SDK 原文 `NSURLSession.h`）：
///   1. **永远等待连通**：`waitsForConnectivity` 被 background session 忽略
///      （`:778-779` "Ignored by background sessions, as background sessions always wait
///      for connectivity"）⇒ 设不设等价；真正的约束是**不要用
///      `taskIsWaitingForConnectivity` 做判据**（`:1022` "will never be called for
///      background sessions"）。
///   2. 等待连通期间 `timeoutIntervalForRequest` **不生效**，只有
///      `timeoutIntervalForResource` 生效（`:769-771`）⇒ 超时口径变宽，别把它当成
///      "没网所以该失败"。
///   3. 只能从**文件**上传（`uploadTask(with:fromFile:)` 是后台 session 唯一支持的上传形态）。
///      这正是既有 `upload()` 已经在做的事：multipart 先落盘，再整份传。
///
/// 🔴 **不要在这里放 `defer { removeItem(multipart) }` 之类的清理。** 字节交给系统之后，
/// 本类型任何一个函数的返回都**不代表传输结束** —— 删文件等于把续传能力一起删掉。
/// 产物的生命周期由终结结果驱动（`HealthKitSync.removeTaskArtifacts`）。
nonisolated final class RaiBackgroundUploadSession: NSObject, URLSessionDataDelegate {
    static let shared = RaiBackgroundUploadSession()

    /// 等待中的上传，键是 `URLSessionTask.taskIdentifier`。
    ///
    /// 这张表与 `descriptions` 是**同一个 identifier 空间**、回答两个不同问题：
    /// "我还在等它的结局吗"（本表）与"我方认为系统正在为哪一批搬字节"（`descriptions`）。
    /// 判据分别落在 `BackgroundUploadReattach.disposition` 与
    /// `hasInFlightUpload(forPayloadHash:)` 上 —— 混用任何一处，都会把"生命周期中止之后
    /// 重进一次同步"变成两份字节同时在传。
    nonisolated(unsafe) private var waiters: [Int: CheckedContinuation<(Data, URLResponse), Error>] = [:]
    /// 「我方认为系统正在为哪一批搬字节」。与 `waiters` 是**两件事**：等待者会因为我方中止而被
    /// 摘掉（`abandonWaiting`），字节却照旧在走。所以这个字典只在任务真正完成、或被
    /// `reattachOrphans` 明确取消时才清理。
    nonisolated(unsafe) private var descriptions: [Int: String] = [:]
    /// 取消早于等待者注册的那些 identifier（见 `abandonWaiting`）。
    nonisolated(unsafe) private var abandonedBeforeRegistration: Set<Int> = []
    /// 响应体按 task 累积。后台 session 在 App 不运行时会把数据**缓存**到恢复后再投递，
    /// 所以这里必须按 task 分开存，不能假设"一次回调就是全部"。
    nonisolated(unsafe) private var buffers: [Int: Data] = [:]
    /// 系统在 `handleEventsForBackgroundURLSession` 交给我们、必须在
    /// `urlSessionDidFinishEvents` 里**恰好调用一次**的回调。不调用的后果是系统认为这次
    /// 后台事件没处理完，会降低后续的派发频率。
    nonisolated(unsafe) private var systemCompletion: (() -> Void)?
    /// `NSLock` 本身是 `Sendable`，所以这里**不要** `nonisolated(unsafe)` —— 编译器会提示多余，
    /// 而那个提示不是噪音：多余的安全标注会让下一个人以为"这里有什么是非 Sendable 的"。
    nonisolated private let lock = NSLock()
    nonisolated(unsafe) private var session: URLSession?

    /// 建（或复用）后台 session。**幂等**：系统可能对同一个 identifier 多次调用
    /// `handleEventsForBackgroundURLSession`，重复建第二个 session 会让 delegate 收不到
    /// 已在途任务的回调。
    func makeSession() -> URLSession {
        lock.lock()
        defer { lock.unlock() }
        if let session { return session }
        let configuration = URLSessionConfiguration.background(
            withIdentifier: RaiBackgroundSync.uploadSessionIdentifier
        )
        // 不设 `waitsForConnectivity`：后台 session 永远等待连通，设了也只是噪音。
        configuration.timeoutIntervalForResource = 60 * 60
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        // 由系统决定何时传（而不是"我交给你你就马上传"）会让传输落到充电/闲时，
        // 代价是"本轮唤醒里拿不到结果"。这里明确不交给系统裁量：我方已经用
        // `BGProcessingTask` 与投递节流控制过频次了，再叠一层 discretionary
        // 会让真机验收里"提交了却迟迟不传"变得无法归因。
        configuration.isDiscretionary = false
        // 显式写出来（默认值就是 YES）：它的意思是"任务完成时允许系统把 App 拉起来"，
        // 那是 `handleEventsForBackgroundURLSession` 能被调到、`urlSessionDidFinishEvents`
        // 能被调到的前提。
        configuration.sessionSendsLaunchEvents = true
        let created = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        session = created
        return created
    }

    /// 记录系统的完成回调。由 `application(_:handleEventsForBackgroundURLSession:completionHandler:)` 调用。
    func storeSystemCompletion(_ completion: @escaping () -> Void) {
        lock.lock()
        systemCompletion = completion
        lock.unlock()
    }

    /// 本进程内、**同步**可读：系统手上有没有属于这一批的传输。
    ///
    /// 同步是硬要求，不是图省事：唯一的调用点 `HealthKitSync.handleEnterBackground` 必须在
    /// 几十毫秒内返回（切后台的处理不能阻塞主线程），而 `getAllTasks` 是异步的。
    ///
    /// 🔴 含义是"**我方认为这一批的字节正由系统搬运**"，与"我在等它的结局"（`waiters`）是两件事：
    /// 生命周期中止只摘 `waiters`（`abandonWaiting`），字节照旧在走 —— 那正是 `.keepWorking`
    /// 这条分支存在的理由。
    func hasInFlightUpload(forPayloadHash payloadHash: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return descriptions.values.contains(payloadHash)
    }

    /// 盘点系统手上还挂着哪些传输，并取消**没人在等结局**的那些。
    ///
    /// 调用时机：我方准备发起（或重新打算发起）一次上传之前 —— 启动握手之后一次，
    /// `performSync` 推导"下一步做什么"之前一次，`runBackgroundPass` 决定这一轮推进哪一步之前一次。
    ///
    /// 三处共用一个判据（`BackgroundUploadReattach.disposition`，纯函数、有执行者）：
    /// **本进程还在等它吗**。
    ///   - 还在等（`waiters` 里有）：一根手指都不许碰。那说明另一次同步正挂在这个 continuation 上
    ///     —— `runBackgroundPass` 撞见前台同步在传时走的就是这条。
    ///   - 没人在等：取消。既包括别的进程留下的，也包括**本进程上一轮生命周期中止放弃等待的**
    ///     （`abandonWaiting` 只摘等待者、不停传输）。后者是同一个问题的第二种走法：横竖要重传
    ///     同一份字节让服务端幂等命中，留着一个仍在跑的上传只会让两份字节同时打向服务端。
    ///
    /// 取消时**同时**把 `descriptions` 里的登记摘掉：登记的含义是"我方认为字节正由系统搬运"，
    /// 而取消之后我方已不再依赖它、下一步就是重传。不摘的话，紧接着的
    /// `hasInFlightUpload` 会说"在飞" ⇒ `BackgroundRunPolicy` 这一轮什么都不做，
    /// 白白多等一个唤醒周期（15 分钟）。
    ///
    /// 异步而不是 `DispatchGroup.wait()`：`getAllTasks` 的回调在 delegate 队列上，同步等它会把
    /// **主线程**（本类的调用方都在 MainActor 上）卡住，等多久由系统决定。
    @discardableResult
    func reattachOrphans(currentPayloadHash: String?) async -> BackgroundUploadReattachReport {
        let urlSession = makeSession()
        let tasks = await withCheckedContinuation { continuation in
            urlSession.getAllTasks { continuation.resume(returning: $0) }
        }
        var report = BackgroundUploadReattachReport()
        for task in tasks {
            let identifier = task.taskIdentifier
            guard BackgroundUploadReattach.disposition(isAwaitedInThisProcess: isAwaited(identifier)) == .cancelOrphan else {
                report.keptAwaited += 1
                continue
            }
            if BackgroundUploadReattach.matchesCurrentBatch(
                taskDescription: task.taskDescription,
                currentPayloadHash: currentPayloadHash
            ) {
                report.cancelledCurrentBatch += 1
            } else {
                report.cancelledOthers += 1
            }
            task.cancel()
            dropDescription(identifier)
        }
        return report
    }

    /// 这两个小函数存在的唯一理由是**加锁不许出现在 `async` 上下文里**：
    /// `NSLock.lock()` / `unlock()` 在异步上下文是 Swift 6 的**错误**（现在是警告）。
    /// 把临界区收进同步函数，比在这里散着写 `lock()/unlock()` 更耐改 —— 后者迟早有人加一句
    /// `await` 进去，而那样会静默地让锁跨过挂起点。
    nonisolated private func isAwaited(_ identifier: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return waiters[identifier] != nil
    }

    nonisolated private func dropDescription(_ identifier: Int) {
        lock.lock()
        descriptions.removeValue(forKey: identifier)
        lock.unlock()
    }

    /// 把一份已经落盘的文件交给系统上传。
    ///
    /// 返回值是"服务端怎么答的"，**不是**"字节传完了" —— 但两者在本函数返回时同时成立
    /// （等结果就是等传输结束）。想在中止之后让字节继续走，用 `abandonWaiting` 那条路。
    func upload(request: URLRequest, fromFile file: URL, payloadHash: String) async throws -> (Data, URLResponse) {
        let urlSession = makeSession()
        let task = urlSession.uploadTask(with: request, fromFile: file)
        // 只为 `reattachOrphans` 的**诊断**计数用（`matchesCurrentBatch`）。任何判据都不许建立在
        // 它上面：`taskDescription` 在进程重启后是否仍可读，本仓无法从代码断言（计划 §15 第 2 条），
        // 而它读不到时 `reattachOrphans` 只会把任务记成"不属于当前批次" —— 那只是把口径记得悲观
        // 一点，动作不变（照旧取消、照旧重传）。真正的判据是 `waiters` 里有没有这条。
        task.taskDescription = payloadHash
        let identifier = task.taskIdentifier
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                let abandonedEarly = abandonedBeforeRegistration.remove(identifier) != nil
                // `descriptions` **无条件**登记：它说的是"系统正在为这一批搬字节"，而"我这次还在不在等"
                // 由 `waiters` 单独表达。两者混成一个会让"中止之后字节还在走"这件事无处安放。
                descriptions[identifier] = payloadHash
                if !abandonedEarly {
                    waiters[identifier] = continuation
                }
                lock.unlock()
                // 取消早于注册：照旧把任务发出去（字节继续走、系统持有它），只是这次没人等结果 ——
                // 与"等待者已随进程消失"是同一种情形，`didCompleteWithError` 会静默跳过。
                if abandonedEarly {
                    continuation.resume(throwing: CancellationError())
                }
                task.resume()
            }
        } onCancel: {
            self.abandonWaiting(identifier: identifier)
        }
    }

    /// 放弃"等结果"，但**不动** `URLSessionTask`。
    ///
    /// 🔴 这两件事必须分开。把字节交给 background session 之后，"我还在不在等"与"字节还在不在走"
    /// 是两个独立的事实，而生命周期中止（`beginBackgroundTask` 到期 / 切后台）要的正是
    /// **前者停下、后者继续** —— 那是装这套机制的**全部**目的；顺手 `task.cancel()` 等于把刚拿到手的
    /// 跨进程续传能力又扔掉。（也正因如此，用户手动取消走的也是这条路：他要的是"别再等了"，
    /// 而系统把字节传完、下次同步用同一个 batchId 幂等命中，并不会多出一份来源。）
    ///
    /// 🔴 必须真的把等待者 resume 掉。`withCheckedThrowingContinuation` **不会**因为 Task 取消而
    /// 自动 resume，而 `HealthSyncTaskOwner.run` 是 `await worker.value` —— 少这一下，被中止的那次
    /// 同步会永远挂在这个 continuation 上：`performSync` 不返回 ⇒ `isBusy` 永远为 true ⇒
    /// 单飞闸门从此拒绝一切同步。现象是"点同步没反应，只有重启 App 才好"，且没有任何报错。
    nonisolated private func abandonWaiting(identifier: Int) {
        lock.lock()
        let waiter = waiters.removeValue(forKey: identifier)
        // 还没登记过 = 取消早于注册（`Task` 进来时已经是取消态）。记下来让注册路径立刻收手：
        // 不记的话注册路径会挂在一个永远不会被 resume 的 continuation 上 —— 就是上面那个死锁的
        // 另一种走法。这个集合只会被注册路径 `remove` 掉，所以不会无界增长。
        if descriptions[identifier] == nil {
            abandonedBeforeRegistration.insert(identifier)
        }
        lock.unlock()
        waiter?.resume(throwing: CancellationError())
    }

    // MARK: URLSessionDataDelegate

    nonisolated func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive data: Data
    ) {
        lock.lock()
        buffers[dataTask.taskIdentifier, default: Data()].append(data)
        lock.unlock()
    }

    nonisolated func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        lock.lock()
        // 三个字典各自回答一个问题，所以各自清理：`waiters` = 谁在等结果（可能已经没人等了），
        // `descriptions` = 系统还在为哪一批搬字节（**这个才是"在飞"的判据**），
        // `buffers` = 这次响应体攒到哪了。
        let waiter = waiters.removeValue(forKey: task.taskIdentifier)
        let body = buffers.removeValue(forKey: task.taskIdentifier) ?? Data()
        descriptions.removeValue(forKey: task.taskIdentifier)
        abandonedBeforeRegistration.remove(task.taskIdentifier)
        lock.unlock()

        // 没有等待者有两种情形，**都必须静默**：
        //   1. 进程重启后系统补投递的完成事件（上一个进程的等待者已经随进程消失）；
        //   2. 我方已经因生命周期中止放弃了这一次等待。
        // 两种情形下"服务端收下了这一批"这件事都由**下次同步**用同一个 batchId 重传后
        // 幂等命中来处理 —— 不需要在这里凭空造一条跨进程的结果通道。
        guard let waiter else { return }
        if let error {
            waiter.resume(throwing: error)
            return
        }
        guard let response = task.response else {
            waiter.resume(throwing: URLError(.badServerResponse))
            return
        }
        waiter.resume(returning: (body, response))
    }

    nonisolated func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        // 与 `RaiRedirectGuard` 共用同一条判据（`RaiSameOrigin`）。这里不复用那个类是因为
        // delegate 位置已经被本对象占住 —— 一个 `URLSession` 只能有一个 delegate，
        // 而这正是把判据抽成纯函数、而不是抽成基类的原因。
        completionHandler(
            RaiSameOrigin.allowsRedirection(from: task.originalRequest?.url, to: request.url) ? request : nil
        )
    }

    nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.lock()
        let completion = systemCompletion
        systemCompletion = nil
        lock.unlock()
        guard let completion else { return }
        // 文档要求在主队列上调用（它会让系统知道"这次后台事件处理完了"）。本方法是
        // `nonisolated`（delegate 队列），所以显式跳主队列。
        DispatchQueue.main.async { completion() }
    }
}
#endif
