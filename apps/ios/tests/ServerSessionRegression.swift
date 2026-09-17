import Foundation

// These symbols satisfy ServerSession's production defaults. Every test injects
// its own closures and URLSession, so touching either stub is a test failure.
enum Keychain {
    static func loadToken(for server: String?) -> String {
        preconditionFailure("ServerSession regression touched the real/default Keychain path")
    }

    static func saveToken(_ token: String, for server: String?) {
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

    func save(_ token: String, for server: String?) {
        lock.lock()
        defer { lock.unlock() }
        let key = server ?? ""
        if token.isEmpty {
            values.removeValue(forKey: key)
        } else {
            values[key] = token
        }
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
    private static let handlerLock = NSLock()

    private let stateLock = NSLock()
    private var stopped = false

    static func setHandler(_ newHandler: @escaping @Sendable (URLRequest) -> Reply) {
        handlerLock.lock()
        handler = newHandler
        deliveredReplies = 0
        handlerLock.unlock()
    }

    static var deliveryCount: Int {
        handlerLock.lock()
        defer { handlerLock.unlock() }
        return deliveredReplies
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
        do {
            ProbeURLProtocol.setHandler { _ in .http(200, delay: 0.03) }
            let (session, _, _) = makeSession()
            let probe = Task { await session.probe() }
            try await Task.sleep(for: .milliseconds(10))
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
                probe.cancel()
            }
            blockCurrentThread(for: 0.12)
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

        if failures > 0 {
            print("\(failures) ServerSession regression checks failed")
            exit(1)
        }
        print("All ServerSession regression checks passed.")
    }
}
