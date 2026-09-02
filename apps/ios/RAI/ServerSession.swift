import Foundation
import Observation

@Observable
@MainActor
final class ServerSession {
    var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: Self.storageKey) }
    }
    var isReachable = false
    var lastError: String?
    var reloadToken = 0
    private(set) var consecutiveFailures = 0

    private var pollTask: Task<Void, Never>?
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 8
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    private static let storageKey = "rai.serverURL"
    private static let failureThreshold = 3

    init() {
        if let stored = UserDefaults.standard.string(forKey: Self.storageKey), !stored.isEmpty {
            serverURLString = stored
        } else {
            #if os(macOS)
            serverURLString = "http://127.0.0.1:5173"
            #else
            serverURLString = ""
            #endif
        }
    }

    var serverURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "。", with: ".")
        guard !trimmed.isEmpty, let url = URL(string: trimmed), let scheme = url.scheme else {
            return nil
        }
        guard scheme == "http" || scheme == "https", url.host != nil else { return nil }
        return url
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
                let delay: Duration = (self?.isReachable == true) ? .seconds(5) : .seconds(1)
                try? await Task.sleep(for: delay)
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
            lastError = "填写 Mac 开发服务器地址，例如 http://192.168.x.x:5173"
            return
        }
        #if os(iOS)
        if isLocalhostURL {
            isReachable = false
            lastError = "手机上不要填 127.0.0.1。请填 Mac 的局域网地址，例如 http://192.168.10.75:5173"
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
            markUnreachable("连不上开发服务器。确认 Mac 已运行 npm run dev:device，且 iPhone 与虚拟机在同一网段。")
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
