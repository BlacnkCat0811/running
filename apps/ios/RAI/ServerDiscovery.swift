import Foundation
import Network
import Observation

@Observable
@MainActor
final class ServerDiscovery {
    var candidates: [URL] = []
    private var browser: NWBrowser?

    func start() {
        stop()
        let descriptor = NWBrowser.Descriptor.bonjour(type: "_rai._tcp", domain: "local.")
        let browser = NWBrowser(for: descriptor, using: .tcp)
        self.browser = browser
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                await self?.resolve(results)
            }
        }
        browser.start(queue: .main)
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }

    private func resolve(_ results: Set<NWBrowser.Result>) async {
        var urls: [URL] = []
        for result in results {
            #if !DEBUG
            // 2026-10-15（审查 🟡-D2）：发布构建只接受**明确宣告 TLS** 的候选 ——
            // `ServerSession.serverURL` 在非 DEBUG 下强制 https，此前 http 候选
            // 被静默拒绝，用户"点了发现的服务毫无反应"。
            guard Self.advertisedScheme(for: result) == "https" else { continue }
            #endif
            if let url = await Self.resolvedURL(from: result) {
                urls.append(url)
            }
        }
        candidates = urls.filter { url in
            let host = url.host ?? ""
            return !host.hasPrefix("192.168.126.") && host != "RAI.local"
        }
    }

    /// 候选 URL 的传输方案：读 `_rai._tcp` 的 TXT 宣告（`scheme=https` / `tls=1`）；
    /// 没有宣告时按 `http`（开发通道，仅 DEBUG 构建会展示）。
    private static func advertisedScheme(for result: NWBrowser.Result) -> String {
        guard case let .bonjour(txt) = result.metadata else { return "http" }
        let dictionary = txt.dictionary
        return (dictionary["scheme"] == "https" || dictionary["tls"] == "1") ? "https" : "http"
    }

    private static func resolvedURL(from result: NWBrowser.Result) async -> URL? {
        let scheme = advertisedScheme(for: result)
        return await withCheckedContinuation { continuation in
            let connection = NWConnection(to: result.endpoint, using: .tcp)
            var finished = false
            let finish: (URL?) -> Void = { url in
                guard !finished else { return }
                finished = true
                connection.cancel()
                continuation.resume(returning: url)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint {
                        let portNumber = port.rawValue == 0 ? 5173 : Int(port.rawValue)
                        finish(Self.serverURL(host: "\(host)", port: portNumber, scheme: scheme))
                    } else {
                        finish(nil)
                    }
                case .failed, .cancelled:
                    finish(nil)
                default:
                    break
                }
            }
            connection.start(queue: .main)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                finish(nil)
            }
        }
    }

    /// Builds a candidate URL from a resolved host.
    ///
    /// Not `URL(string:)`: that returns nil for a scoped IPv6 literal such as
    /// `fe80::1%en0`, so every IPv6-only host was silently dropped from the list.
    /// `URLComponents` brackets and escapes the host properly.
    ///
    /// `nonisolated` on purpose: the caller is `NWConnection`'s state handler,
    /// which runs outside the main actor.
    nonisolated private static func serverURL(host: String, port: Int, scheme: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        return components.url
    }
}
