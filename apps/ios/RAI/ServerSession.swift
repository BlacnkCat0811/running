import Foundation
import Observation

@Observable
@MainActor
final class ServerSession {
    var serverURLString: String {
        didSet {
            guard serverURLString != oldValue else { return }
            userDefaults.set(serverURLString, forKey: Self.storageKey)
            invalidatePendingProbes(resetConnectionState: true)
            apiToken = loadToken(serverURLString)
        }
    }
    var apiToken: String {
        didSet {
            guard apiToken != oldValue else { return }
            // 写入失败不能静默：`apiToken` 这一秒在内存里是可用的，重启后就没了。
            // ⚠️ `saveToken` 必须**无条件**调用：清空 token 也走这条路径，而删掉钥匙串
            // 条目正是靠它。写成 `apiToken.isEmpty || saveToken(...)` 会短路掉删除，
            // 于是"清空"只清了内存，重启后旧 token 又回来了（既有回归会抓到这条）。
            let persisted = saveToken(apiToken, serverURLString)
            credentialStorageError = (persisted || apiToken.isEmpty)
                ? nil
                : "凭证未能保存到钥匙串；本次会话可用，但重启后需要重新输入。"
            invalidatePendingProbes(resetConnectionState: true)
        }
    }
    /// 钥匙串写入失败时留给界面的说明；保存成功或清空 token 后为 `nil`。
    ///
    /// 必须与 `lastError` 分开：轮询探针在每次探测成功时都会把 `lastError` 清成 `nil`
    /// （`probe()` 的 2xx 分支），凭证存储失败在那里留不住 —— 而这恰恰是一次
    /// "看起来成功、实际没存上"的失败，正是需要被看见的那一类。
    private(set) var credentialStorageError: String?
    var isReachable = false
    var lastError: String?
    var reloadToken = 0
    var hasConnectedOnce = false
    private(set) var consecutiveFailures = 0

    private var pollTask: Task<Void, Never>?
    private let session: URLSession
    private let userDefaults: UserDefaults
    private let loadToken: @MainActor (String?) -> String
    private let saveToken: @MainActor (String, String?) -> Bool
    private var probeGeneration: UInt64 = 0

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 8
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return RaiURLSession.make(configuration: configuration)
    }

    private static let storageKey = "rai.serverURL"
    private static let tokenKey = "rai.apiToken"
    private static let connectedKey = "rai.hasConnectedOnce"
    private static let failureThreshold = 3

    init(
        session: URLSession? = nil,
        userDefaults: UserDefaults = .standard,
        loadToken: @escaping @MainActor (String?) -> String = { Keychain.loadToken(for: $0) },
        saveToken: @escaping @MainActor (String, String?) -> Bool = { Keychain.saveToken($0, for: $1) }
    ) {
        self.session = session ?? Self.makeSession()
        self.userDefaults = userDefaults
        self.loadToken = loadToken
        self.saveToken = saveToken

        let storedURL = userDefaults.string(forKey: Self.storageKey) ?? ""
        if storedURL.isEmpty {
            #if os(macOS) && DEBUG
            serverURLString = "http://127.0.0.1:5173"
            #else
            serverURLString = ""
            #endif
            apiToken = ""
        } else {
            serverURLString = storedURL
            // Tokens are stored per server so changing the configured origin
            // cannot accidentally reuse credentials for another service.
            //
            // A legacy unscoped token carries no trustworthy origin metadata.
            // In particular, the previous app may already have copied A's token,
            // switched its stored URL to B, and only then upgraded. Treating the
            // current stored URL as migration evidence would leak A's credential
            // into B. Keep the legacy Keychain item untouched for manual recovery,
            // but require the user to re-enter it before saving it into an origin.
            apiToken = loadToken(storedURL)
        }
        hasConnectedOnce = userDefaults.bool(forKey: Self.connectedKey)
    }

    var serverURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "。", with: ".")
        guard !trimmed.isEmpty, let url = URL(string: trimmed), let scheme = url.scheme else {
            return nil
        }
        guard scheme == "http" || scheme == "https", url.host != nil else { return nil }
        #if !DEBUG
        guard scheme == "https" else { return nil }
        #endif
        return Self.canonicalURL(url)
    }

    /// One stable representation is used for Keychain and cache scoping.
    ///
    /// `nonisolated` because the Keychain helper (which is not main-actor bound)
    /// scopes its account name with it; the conversion only reads the URL.
    nonisolated static func canonicalURL(_ url: URL) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let scheme = components?.scheme?.lowercased()
        let host = components?.host?.lowercased()
        components?.scheme = scheme
        components?.host = host
        if (components?.port == 80 && components?.scheme == "http") ||
            (components?.port == 443 && components?.scheme == "https") {
            components?.port = nil
        }
        components?.path = ""
        components?.query = nil
        components?.fragment = nil
        return components?.url ?? url
    }

    var isLocalhostURL: Bool {
        let host = serverURL?.host?.lowercased()
        return host == "127.0.0.1" || host == "localhost" || host == "::1"
    }

    func startMonitoring() {
        invalidatePendingProbes(resetConnectionState: false)
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.probe()
                try? await Task.sleep(for: self?.pollInterval ?? .seconds(1))
            }
        }
    }

    func stopMonitoring() {
        invalidatePendingProbes(resetConnectionState: false)
        pollTask?.cancel()
        pollTask = nil
    }

    func reload() {
        reloadToken += 1
    }

    func probe() async {
        guard let base = serverURL else {
            isReachable = false
            consecutiveFailures = 0
            lastError = "请填写 RAI 服务地址"
            return
        }
        // The Simulator shares the Mac's loopback interface. Only a physical
        // iPhone must reject localhost as an unreachable desktop service address.
        #if os(iOS) && !targetEnvironment(simulator)
        if isLocalhostURL {
            isReachable = false
            lastError = "请填写手机可访问的 RAI 服务地址"
            return
        }
        #endif
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            isReachable = false
            lastError = "服务器地址无效"
            return
        }
        components.path = "/v1/health"
        components.query = nil
        components.fragment = nil
        guard let healthURL = components.url else {
            isReachable = false
            lastError = "服务器地址无效"
            return
        }

        var request = URLRequest(url: healthURL)
        let requestToken = apiToken
        let requestGeneration = probeGeneration
        if !requestToken.isEmpty { request.setValue("Bearer \(requestToken)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, response) = try await session.data(for: request)
            guard isCurrentProbe(
                requestURL: healthURL,
                requestToken: requestToken,
                generation: requestGeneration
            ) else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200...299).contains(status) {
                let wasReachable = isReachable
                consecutiveFailures = 0
                isReachable = true
                lastError = nil
                if !hasConnectedOnce {
                    hasConnectedOnce = true
                    userDefaults.set(true, forKey: Self.connectedKey)
                }
                if !wasReachable {
                    reload()
                }
            } else {
                markUnreachable("服务器返回 HTTP \(status)")
            }
        } catch is CancellationError {
            return
        } catch {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
                return
            }
            guard isCurrentProbe(
                requestURL: healthURL,
                requestToken: requestToken,
                generation: requestGeneration
            ) else { return }
            markUnreachable("暂时无法连接 RAI 服务，请检查网络或服务状态")
        }
    }

    private func isCurrentProbe(requestURL: URL, requestToken: String, generation: UInt64) -> Bool {
        guard !Task.isCancelled,
              generation == probeGeneration,
              requestToken == apiToken else {
            return false
        }
        guard let base = serverURL,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            return false
        }
        components.path = "/v1/health"
        components.query = nil
        components.fragment = nil
        return components.url == requestURL
    }

    private func invalidatePendingProbes(resetConnectionState: Bool) {
        probeGeneration &+= 1
        guard resetConnectionState else { return }
        isReachable = false
        consecutiveFailures = 0
        lastError = nil
    }

    private var pollInterval: Duration {
        if isReachable { return .seconds(30) }
        switch consecutiveFailures {
        case 0, 1: return .seconds(1)
        case 2: return .seconds(2)
        default: return .seconds(5)
        }
    }

    private func markUnreachable(_ message: String) {
        consecutiveFailures += 1
        lastError = message
        if consecutiveFailures >= Self.failureThreshold {
            isReachable = false
        }
    }
}
