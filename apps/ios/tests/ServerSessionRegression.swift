import Foundation

// These symbols satisfy ServerSession's production defaults. Every test injects
// its own closures and URLSession, so touching either stub is a test failure.
enum Keychain {
    static func loadToken(for server: String?) -> String {
        preconditionFailure("ServerSession regression touched the real/default Keychain path")
    }

    static func saveToken(_ token: String, for server: String?) -> Bool {
        preconditionFailure("ServerSession regression touched the real/default Keychain path")
    }
}

enum RaiURLSession {
    static func make(configuration: URLSessionConfiguration) -> URLSession {
        preconditionFailure("ServerSession regression created a non-injected URLSession")
    }
}

final class CredentialStore: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String]

    init(_ values: [String: String]) {
        self.values = values
    }

    func load(_ server: String?) -> String {
        lock.lock()
        defer { lock.unlock() }
        return values[server ?? ""] ?? ""
    }

    /// `true` models a Keychain whose `SecItemAdd` is rejected — a locked device,
    /// a full keychain, or a managed configuration. The write is dropped, which is
    /// exactly the failure `Keychain.saveToken` must stop reporting as success.
    private var rejectsWrites = false

    func rejectWrites() {
        lock.lock()
        defer { lock.unlock() }
        rejectsWrites = true
    }

    func save(_ token: String, for server: String?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if rejectsWrites { return false }
        let key = server ?? ""
        if token.isEmpty {
            values.removeValue(forKey: key)
        } else {
            values[key] = token
        }
        return true
    }
}

final class ProbeURLProtocol: URLProtocol, @unchecked Sendable {
    struct Reply: Sendable {
        let status: Int?
        let delay: TimeInterval
        let error: URLError?

        static func http(_ status: Int, delay: TimeInterval = 0) -> Reply {
            Reply(status: status, delay: delay, error: nil)
        }

        static func failure(_ code: URLError.Code, delay: TimeInterval = 0) -> Reply {
            Reply(status: nil, delay: delay, error: URLError(code))
        }
    }

    nonisolated(unsafe) private static var handler: @Sendable (URLRequest) -> Reply = {
        _ in .http(500)
    }
    nonisolated(unsafe) private static var deliveredReplies = 0
    nonisolated(unsafe) private static var startedRequests = 0
    private static let handlerLock = NSLock()

    private let stateLock = NSLock()
    private var stopped = false

    static func setHandler(_ newHandler: @escaping @Sendable (URLRequest) -> Reply) {
        handlerLock.lock()
        handler = newHandler
        deliveredReplies = 0
        startedRequests = 0
        handlerLock.unlock()
    }

    static var deliveryCount: Int {
        handlerLock.lock()
        defer { handlerLock.unlock() }
        return deliveredReplies
    }

    /// 请求已经**开始加载**的次数。取消竞态用例靠它确认"请求确实在飞"，
    /// 而不是靠 `Task.sleep(10ms)` 猜任务是否已经跑起来（2026-10-24 CI #2）。
    static var requestCount: Int {
        handlerLock.lock()
        defer { handlerLock.unlock() }
        return startedRequests
    }

    private static func reply(for request: URLRequest) -> Reply {
        handlerLock.lock()
        let current = handler
        handlerLock.unlock()
        return current(request)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let reply = Self.reply(for: request)
        Self.handlerLock.lock()
        Self.startedRequests += 1
        Self.handlerLock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + reply.delay) { [self] in
            stateLock.lock()
            let shouldDeliver = !stopped
            stateLock.unlock()
            guard shouldDeliver else { return }

            Self.handlerLock.lock()
            Self.deliveredReplies += 1
            Self.handlerLock.unlock()
            if let error = reply.error {
                client?.urlProtocol(self, didFailWithError: error)
                return
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: reply.status!,
                httpVersion: nil,
                headerFields: nil
            )!
            client?.urlProtocol(
                self,
                didReceive: response,
                cacheStoragePolicy: .notAllowed
            )
            client?.urlProtocol(self, didLoad: Data())
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {
        stateLock.lock()
        stopped = true
        stateLock.unlock()
    }
}

@main
struct ServerSessionRegression {
    @MainActor
    static func main() async throws {
        var failures = 0

        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            if condition() {
                print("PASS: \(name)")
            } else {
                failures += 1
                print("FAIL: \(name)")
            }
        }

        func blockCurrentThread(for interval: TimeInterval) {
            Thread.sleep(forTimeInterval: interval)
        }

        func buildSession(
            defaults: UserDefaults,
            credentials: CredentialStore
        ) -> ServerSession {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [ProbeURLProtocol.self]
            return ServerSession(
                session: URLSession(configuration: configuration),
                userDefaults: defaults,
                loadToken: { credentials.load($0) },
                saveToken: { credentials.save($0, for: $1) }
            )
        }

        func makeSession(
            url: String = "https://a.example",
            tokens: [String: String] = [:]
        ) -> (ServerSession, UserDefaults, CredentialStore) {
            let suite = "ServerSessionRegression.\(UUID().uuidString)"
            let defaults = UserDefaults(suiteName: suite)!
            defaults.removePersistentDomain(forName: suite)
            defaults.set(url, forKey: "rai.serverURL")
            let credentials = CredentialStore(tokens)
            return (buildSession(defaults: defaults, credentials: credentials), defaults, credentials)
        }

        // A success from server A must not clear the current failure from B.
        do {
            ProbeURLProtocol.setHandler { request in
                request.url?.host == "a.example" ? .http(200, delay: 0.16) : .http(503)
            }
            let (session, _, _) = makeSession()
            let old = Task { await session.probe() }
            try await Task.sleep(for: .milliseconds(25))
            session.serverURLString = "https://b.example"
            await session.probe()
            await old.value
            check(!session.isReachable, "late success cannot mark a new server reachable")
            check(session.reloadToken == 0, "late success cannot increase reloadToken")
            check(session.consecutiveFailures == 1, "late success cannot clear the new server failure count")
            check(session.lastError == "服务器返回 HTTP 503", "late success cannot clear the new server error")
        }

        // A failure from the old token must not damage a successful current probe.
        do {
            ProbeURLProtocol.setHandler { request in
                request.value(forHTTPHeaderField: "Authorization") == "Bearer old"
                    ? .failure(.cannotConnectToHost, delay: 0.16)
                    : .http(204)
            }
            let (session, _, _) = makeSession(tokens: ["https://a.example": "old"])
            let old = Task { await session.probe() }
            try await Task.sleep(for: .milliseconds(25))
            session.apiToken = "new"
            await session.probe()
            await old.value
            check(session.isReachable, "late failure for an old token cannot mark the current token unreachable")
            check(session.consecutiveFailures == 0, "late failure for an old token cannot increase the error count")
            check(session.lastError == nil, "late failure for an old token cannot present an error")
            check(session.reloadToken == 1, "only the current successful token triggers one reload")
        }

        // URL/token can return to identical values; generation, not equality alone,
        // must still reject the response that started before A -> B -> A.
        do {
            ProbeURLProtocol.setHandler { _ in .http(200, delay: 0.14) }
            let (session, _, _) = makeSession(tokens: [
                "https://a.example": "same",
                "https://b.example": "same",
            ])
            let old = Task { await session.probe() }
            try await Task.sleep(for: .milliseconds(20))
            session.serverURLString = "https://b.example"
            session.serverURLString = "https://a.example"
            await old.value
            check(!session.isReachable, "A -> B -> A invalidates the original A response")
            check(session.reloadToken == 0, "A -> B -> A stale success cannot trigger reload")
            check(session.consecutiveFailures == 0 && session.lastError == nil,
                  "configuration changes reset connection errors")
        }

        // Cancellation can race after URLSession has received a successful
        // response but before the main actor publishes it. Block this actor long
        // enough for that ordering instead of only exercising URLError.cancelled.
        //
        // 2026-10-24（CI #2 实测，macos-26 / 3 核 runner）：旧写法拿两个定时器抢窗口 ——
        // 响应 +0.03s 投递、`asyncAfter(+0.05s)` 取消、主线程阻塞 0.12s，只留 70ms 余量。
        // runner 上全局队列把那次 `cancel()` 拖过了 120ms，于是顺序变成"先发布成功、
        // 后取消"，两条判据一起红；换到本机（同一份代码、Intel、机器空闲）又恒绿 ——
        // 判据不该由机器快慢决定。现在改成按事实推进：
        //   1. 等请求真的开始（`requestCount`），不再猜 10ms 睡够没有；
        //   2. 从这一刻起本线程（= 主 actor）一直被占住，响应到达后没有任何 continuation 能跑；
        //   3. 确认响应已投递后才 `cancel()`，再放开主线程。
        // 于是"响应已到 → 已取消 → 才允许发布"由主线程自己保证，与定时器运气无关。
        do {
            ProbeURLProtocol.setHandler { _ in .http(200, delay: 0.03) }
            let (session, _, _) = makeSession()
            let probe = Task { await session.probe() }
            var waited = 0.0
            while ProbeURLProtocol.requestCount == 0 && waited < 5 {
                try await Task.sleep(for: .milliseconds(5))
                waited += 0.005
            }
            // 下面开始阻塞本线程：响应投递发生在别的队列上，但"发布"只能排在主 actor 上，
            // 所以它不可能抢在下面那次 `cancel()` 之前。
            let deadline = Date().addingTimeInterval(5)
            while ProbeURLProtocol.deliveryCount == 0 && Date() < deadline {
                blockCurrentThread(for: 0.005)
            }
            probe.cancel()
            blockCurrentThread(for: 0.05)
            await probe.value
            check(ProbeURLProtocol.deliveryCount == 1,
                  "cancellation race receives a successful URLProtocol response")
            check(probe.isCancelled, "probe is cancelled before main-actor publication")
            check(!session.isReachable, "late success cannot publish after probe cancellation")
            check(session.reloadToken == 0, "late success after cancellation cannot trigger reload")
            check(session.lastError == nil, "cancelled late-success probe does not present an error")
            check(session.consecutiveFailures == 0, "cancelled probe does not increase the error count")
        }

        // Stopping and restarting monitoring invalidates the previous monitor run.
        do {
            final class Counter: @unchecked Sendable {
                private let lock = NSLock()
                private var value = 0
                func next() -> Int {
                    lock.lock()
                    defer { lock.unlock() }
                    value += 1
                    return value
                }
            }
            let counter = Counter()
            ProbeURLProtocol.setHandler { _ in
                counter.next() == 1 ? .http(200, delay: 0.18) : .http(503)
            }
            let (session, _, _) = makeSession()
            session.startMonitoring()
            try await Task.sleep(for: .milliseconds(25))
            session.stopMonitoring()
            session.startMonitoring()
            try await Task.sleep(for: .milliseconds(100))
            session.stopMonitoring()
            check(!session.isReachable, "restarted monitoring is not overwritten by the old success")
            check(session.reloadToken == 0, "stopped monitor response cannot trigger reload")
            check(session.consecutiveFailures == 1, "only the restarted monitor failure is counted")
            check(session.lastError == "服务器返回 HTTP 503", "restarted monitor keeps its current error")
        }

        // A normal current probe still preserves the existing connection semantics.
        do {
            ProbeURLProtocol.setHandler { _ in .http(200) }
            let (session, defaults, _) = makeSession()
            await session.probe()
            check(session.isReachable, "normal successful probe marks the server reachable")
            check(session.reloadToken == 1, "first normal successful probe triggers reload")
            check(session.hasConnectedOnce, "normal successful probe records first connection")
            check(defaults.bool(forKey: "rai.hasConnectedOnce"),
                  "first connection is persisted only in isolated defaults")

            ProbeURLProtocol.setHandler { _ in .http(500) }
            await session.probe()
            check(session.isReachable, "one normal failure keeps a previously reachable server online")
            check(session.consecutiveFailures == 1, "normal failure increments the failure count")
            check(session.lastError == "服务器返回 HTTP 500", "normal HTTP failure presents its status")
        }

        // Upgrade-at-B: an old build copied A's legacy token into A's scope,
        // then the user switched the stored URL to B before installing this build.
        // There is no trustworthy evidence that the unscoped token belongs to B.
        do {
            let (session, defaults, credentials) = makeSession(
                url: "https://b.example",
                tokens: [
                    "": "legacy-a",
                    "https://a.example": "legacy-a",
                ]
            )
            check(session.apiToken.isEmpty, "upgrade at B does not infer B as the legacy credential origin")
            check(credentials.load("https://b.example").isEmpty,
                  "upgrade at B never copies A's legacy token into B")
            check(credentials.load(nil) == "legacy-a",
                  "untrusted legacy credential is preserved for manual recovery")

            let restarted = buildSession(defaults: defaults, credentials: credentials)
            check(restarted.apiToken.isEmpty, "restarting at B still requires explicit credential entry")
            check(credentials.load("https://b.example").isEmpty,
                  "restarting at B still cannot populate its scoped credential")

            restarted.apiToken = "token-b"
            let explicitlyConfigured = buildSession(defaults: defaults, credentials: credentials)
            check(explicitlyConfigured.apiToken == "token-b",
                  "an explicitly entered B credential is restored from B's scope")
            explicitlyConfigured.apiToken = ""
            let cleared = buildSession(defaults: defaults, credentials: credentials)
            check(cleared.apiToken.isEmpty, "clearing B's token does not revive the legacy A token")
            check(credentials.load(nil) == "legacy-a",
                  "clearing a scoped token does not destroy the retained recovery credential")
        }

        // Even when the current URL happens to be A, legacy-only storage has no
        // authenticated origin evidence and therefore is not auto-migrated.
        do {
            let (session, _, credentials) = makeSession(
                url: "https://a.example",
                tokens: ["": "legacy-without-origin"]
            )
            check(session.apiToken.isEmpty, "legacy-only credentials require manual re-entry")
            check(credentials.load("https://a.example").isEmpty,
                  "current storedURL alone is never accepted as migration evidence")
            check(credentials.load(nil) == "legacy-without-origin",
                  "declining unsafe migration does not delete the only credential")
        }

        // 钥匙串写入失败必须留下可见的痕迹，且不能被随后成功的探针抹掉。
        do {
            let (session, _, credentials) = makeSession()
            credentials.rejectWrites()
            session.apiToken = "unpersisted"
            check(session.credentialStorageError != nil,
                  "a rejected keychain write must be surfaced, not reported as success")
            // 探针成功会清 `lastError`：凭证存储失败不能跟着一起消失，否则
            // "看起来成功、实际没存上"这件事又变回不可见。
            ProbeURLProtocol.setHandler { _ in .http(204) }
            await session.probe()
            check(session.lastError == nil, "a successful probe clears the connectivity error")
            check(session.credentialStorageError != nil,
                  "a successful probe must not clear the credential storage error")
            // 删除失败不能伪装成清空成功。
            session.apiToken = ""
            check(session.credentialStorageError?.contains("删除") == true,
                  "a rejected keychain deletion must remain visible")
        }

        if failures > 0 {
            print("\(failures) ServerSession regression checks failed")
            exit(1)
        }
        print("All ServerSession regression checks passed.")
    }
}
