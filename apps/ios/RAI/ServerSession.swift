import Foundation
import Observation

@Observable
@MainActor
final class ServerSession {
    var serverURLString: String {
        didSet {
            UserDefaults.standard.set(serverURLString, forKey: Self.storageKey)
            apiToken = Keychain.loadToken(for: serverURLString)
        }
    }
    var apiToken: String {
        didSet { Keychain.saveToken(apiToken, for: serverURLString) }
    }
    var isReachable = false
    var lastError: String?
    var reloadToken = 0
    var hasConnectedOnce = false
    private(set) var consecutiveFailures = 0

    private var pollTask: Task<Void, Never>?
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 8
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return RaiURLSession.make(configuration: configuration)
    }()

    private static let storageKey = "rai.serverURL"
    private static let tokenKey = "rai.apiToken"
    private static let connectedKey = "rai.hasConnectedOnce"
    private static let failureThreshold = 3

    init() {
        let storedURL = UserDefaults.standard.string(forKey: Self.storageKey) ?? ""
        if storedURL.isEmpty {
            #if os(macOS) && DEBUG
            serverURLString = "http://127.0.0.1:5173"
            #else
            serverURLString = ""
            #endif
            apiToken = Keychain.loadToken()
        } else {
            serverURLString = storedURL
            // Tokens are stored per server so changing the configured origin
            // cannot accidentally reuse credentials for another service.
            let scopedToken = Keychain.loadToken(for: storedURL)
            if scopedToken.isEmpty {
                let legacyToken = Keychain.loadToken()
                if !legacyToken.isEmpty {
                    Keychain.saveToken(legacyToken, for: storedURL)
                }
                apiToken = legacyToken
            } else {
                apiToken = scopedToken
            }
        }
        hasConnectedOnce = UserDefaults.standard.bool(forKey: Self.connectedKey)
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
    static func canonicalURL(_ url: URL) -> URL {
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
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.probe()
                try? await Task.sleep(for: self?.pollInterval ?? .seconds(1))
            }
        }
    }

    func stopMonitoring() {
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
        if !apiToken.isEmpty { request.setValue("Bearer \(apiToken)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200...299).contains(status) {
                let wasReachable = isReachable
                consecutiveFailures = 0
                isReachable = true
                lastError = nil
                if !hasConnectedOnce {
                    hasConnectedOnce = true
                    UserDefaults.standard.set(true, forKey: Self.connectedKey)
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
            markUnreachable("暂时无法连接 RAI 服务，请检查网络或服务状态")
        }
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
