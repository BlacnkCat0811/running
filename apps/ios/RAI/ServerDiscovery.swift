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
            if let url = await Self.resolvedURL(from: result) {
                urls.append(url)
            }
        }
        candidates = urls.filter { url in
            let host = url.host ?? ""
            return !host.hasPrefix("192.168.126.") && host != "RAI.local"
        }
    }

    private static func resolvedURL(from result: NWBrowser.Result) async -> URL? {
        await withCheckedContinuation { continuation in
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
                        finish(URL(string: "http://\(host):\(portNumber)"))
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
}
