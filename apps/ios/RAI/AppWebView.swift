import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@Observable
@MainActor
final class ChromeController {
    var showSettings = false
    var overlayHeight: Double = 44

    func openServer() {
        showSettings = true
    }
}

struct NativeBridgeSnapshot: Equatable {
    var token: String = ""
    var trustedOrigin: String? = nil
    var reachable: Bool = false
    var lastSyncAt: String? = nil
    var lastSyncMessage: String? = nil
    var lastSyncError: String? = nil
    var lastWorkoutCount: Int? = nil
    var isBusy: Bool = false
    var chromeTop: Double = 44
    var dataUpdatedGeneration: Int = 0

    var tokenJS: String { jsJSONString(token) }
    var trustedOriginJS: String { jsJSONString(trustedOrigin ?? "") }

    var nativeObjectJS: String {
        let object: [String: Any] = [
            "reachable": reachable,
            "lastSyncAt": lastSyncAt as Any? ?? NSNull(),
            "lastSyncMessage": lastSyncMessage as Any? ?? NSNull(),
            "lastSyncError": lastSyncError as Any? ?? NSNull(),
            "lastWorkoutCount": lastWorkoutCount as Any? ?? NSNull(),
            "isBusy": isBusy
        ]
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else {
            return "{\"reachable\":false,\"lastSyncAt\":null,\"lastSyncMessage\":null,\"lastSyncError\":null,\"lastWorkoutCount\":null,\"isBusy\":false}"
        }
        return text
    }
}

#if os(iOS)
struct AppWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    let snapshot: NativeBridgeSnapshot
    let session: ServerSession
    let healthSync: HealthKitSync
    let chrome: ChromeController

    func makeCoordinator() -> WebCoordinator {
        WebCoordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        context.coordinator.bind(session: session, healthSync: healthSync, chrome: chrome, snapshot: snapshot)
        let webView = makeConfiguredWebView(coordinator: context.coordinator, snapshot: snapshot)
        context.coordinator.load(url, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.bind(session: session, healthSync: healthSync, chrome: chrome, snapshot: snapshot)
        injectIosSafeArea(webView, chromeTop: snapshot.chromeTop)
        context.coordinator.update(url: url, reloadToken: reloadToken, snapshot: snapshot, webView: webView)
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: WebCoordinator) {
        coordinator.invalidate(webView: uiView)
    }
}
#else
struct AppWebView: NSViewRepresentable {
    let url: URL
    let reloadToken: Int
    let snapshot: NativeBridgeSnapshot
    let session: ServerSession
    let healthSync: HealthKitSync
    let chrome: ChromeController

    func makeCoordinator() -> WebCoordinator {
        WebCoordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        context.coordinator.bind(session: session, healthSync: healthSync, chrome: chrome, snapshot: snapshot)
        let webView = makeConfiguredWebView(coordinator: context.coordinator, snapshot: snapshot)
        context.coordinator.load(url, in: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.bind(session: session, healthSync: healthSync, chrome: chrome, snapshot: snapshot)
        context.coordinator.update(url: url, reloadToken: reloadToken, snapshot: snapshot, webView: webView)
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: WebCoordinator) {
        coordinator.invalidate(webView: nsView)
    }
}
#endif

@MainActor
final class WebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var loadedURL: URL?
    var reloadToken = 0
    var snapshot = NativeBridgeSnapshot()
    var session: ServerSession?
    var healthSync: HealthKitSync?
    var chrome: ChromeController?
    private var retryCount = 0
    private var retryTask: Task<Void, Never>?
    private var lastInjectedSnapshot = NativeBridgeSnapshot()
    private var didInjectSnapshot = false

    func bind(session: ServerSession, healthSync: HealthKitSync, chrome: ChromeController, snapshot: NativeBridgeSnapshot) {
        self.session = session
        self.healthSync = healthSync
        self.chrome = chrome
        self.snapshot = snapshot
    }

    func load(_ url: URL, in webView: WKWebView) {
        loadedURL = url
        retryCount = 0
        webView.load(URLRequest(url: iosShellURL(url), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    func update(url: URL, reloadToken: Int, snapshot: NativeBridgeSnapshot, webView: WKWebView) {
        let previous = lastInjectedSnapshot
        self.snapshot = snapshot
        if loadedURL != url {
            installUserScripts(on: webView.configuration.userContentController, snapshot: snapshot)
            load(url, in: webView)
            self.reloadToken = reloadToken
            lastInjectedSnapshot = snapshot
            didInjectSnapshot = false
            return
        }
        if self.reloadToken != reloadToken {
            installUserScripts(on: webView.configuration.userContentController, snapshot: snapshot)
            self.reloadToken = reloadToken
            retryCount = 0
            lastInjectedSnapshot = snapshot
            didInjectSnapshot = false
            webView.reload()
            return
        }
        let tokenChanged = previous.token != snapshot.token
        let statusChanged = nativeStatusChanged(previous, snapshot)
        let dataUpdated = previous.dataUpdatedGeneration != snapshot.dataUpdatedGeneration
        if tokenChanged || statusChanged {
            installUserScripts(on: webView.configuration.userContentController, snapshot: snapshot)
        }
        if tokenChanged && !statusChanged {
            injectToken(snapshot, into: webView)
        }
        if statusChanged || !didInjectSnapshot {
            injectNativeStatus(snapshot, into: webView)
        }
        if dataUpdated && didInjectSnapshot {
            injectDataUpdated(into: webView)
        }
        lastInjectedSnapshot = snapshot
        didInjectSnapshot = true
    }

    func invalidate(webView: WKWebView) {
        retryTask?.cancel()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "rai")
    }

    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // `add(_:name:)` delivers on the main thread; parse here so the Task only hops Sendable fields.
        let parsed = MainActor.assumeIsolated {
            guard message.frameInfo.isMainFrame,
                  self.isTrustedFrame(message.frameInfo.securityOrigin) else { return nil }
            parseRaiMessage(message.body)
        }
        Task { @MainActor in
            guard let parsed else { return }
            self.handleRaiMessage(parsed)
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if url.isFileURL || url.scheme == "about" || isTrustedOrigin(url) {
            decisionHandler(.allow)
            return
        }
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retryCount = 0
        injectNativeStatus(snapshot, into: webView)
        lastInjectedSnapshot = snapshot
        didInjectSnapshot = true
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleRetry(webView, error: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetry(webView, error: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        retryCount = 0
        guard let url = loadedURL ?? webView.url else { return }
        webView.load(URLRequest(url: iosShellURL(url), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        completionHandler(directory.appendingPathComponent(suggestedFilename))
    }

    #if os(macOS)
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }
    #endif

    private func handleRaiMessage(_ parsed: (action: String, full: Bool)) {
        switch parsed.action {
        case "syncHealth":
            guard let healthSync, let session else {
                reportMissingDependency("同步组件未就绪，请刷新后重试")
                return
            }
            Task {
                await healthSync.sync(to: session.serverURL, apiToken: session.apiToken, full: parsed.full)
            }
        case "openServer":
            guard let chrome else {
                reportMissingDependency("无法打开服务器设置")
                return
            }
            chrome.openServer()
        case "openHealthSettings":
            #if os(iOS)
            if let url = URL(string: "x-apple-health://") {
                UIApplication.shared.open(url)
            } else {
                UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)
            }
            #endif
        case "reload":
            guard let session else {
                reportMissingDependency("无法刷新页面")
                return
            }
            session.reload()
        default:
            break
        }
    }

    private func isTrustedFrame(_ origin: WKSecurityOrigin) -> Bool {
        guard let trusted = snapshot.trustedOrigin, let expected = URL(string: trusted),
              origin.protocol == expected.scheme, origin.host == expected.host else { return false }
        return origin.port == (expected.port ?? (expected.scheme == "https" ? 443 : 80))
    }

    private func isTrustedOrigin(_ url: URL) -> Bool {
        guard let trusted = snapshot.trustedOrigin, let expected = URL(string: trusted),
              url.scheme == expected.scheme, url.host == expected.host else { return false }
        return (url.port ?? (url.scheme == "https" ? 443 : 80)) == (expected.port ?? (expected.scheme == "https" ? 443 : 80))
    }

    private func reportMissingDependency(_ message: String) {
        guard let healthSync else { return }
        healthSync.lastError = message
        healthSync.message = nil
    }

    private func scheduleRetry(_ webView: WKWebView, error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return
        }
        guard retryCount < 5 else { return }
        retryCount += 1
        retryTask?.cancel()
        let delay = UInt64(min(8, retryCount * 2))
        retryTask = Task { [weak webView] in
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            guard !Task.isCancelled, let webView else { return }
            webView.reload()
        }
    }
}

#if os(iOS)
private func windowSafeAreaInsets() -> UIEdgeInsets {
    let windows = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows)
    let window = windows.first(where: \.isKeyWindow) ?? windows.first
    let insets = window?.safeAreaInsets ?? .zero
    if insets.bottom > 0 || insets.top > 0 {
        return insets
    }
    return UIEdgeInsets(top: 47, left: 0, bottom: 34, right: 0)
}

private func iosSafeAreaUserScript(chromeTop: Double) -> WKUserScript {
    let insets = windowSafeAreaInsets()
    let source = """
    document.documentElement.dataset.shell = 'ios';
    document.documentElement.style.setProperty('--rai-safe-top', '\(insets.top)px');
    document.documentElement.style.setProperty('--rai-safe-bottom', '\(insets.bottom)px');
    document.documentElement.style.setProperty('--rai-chrome-top', '\(chromeTop)px');
    """
    return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
}

@MainActor
func injectIosSafeArea(_ webView: WKWebView, chromeTop: Double) {
    let insets = windowSafeAreaInsets()
    let source = """
    document.documentElement.dataset.shell = 'ios';
    document.documentElement.style.setProperty('--rai-safe-top', '\(insets.top)px');
    document.documentElement.style.setProperty('--rai-safe-bottom', '\(insets.bottom)px');
    document.documentElement.style.setProperty('--rai-chrome-top', '\(chromeTop)px');
    """
    webView.evaluateJavaScript(source, completionHandler: nil)
}
#endif

@MainActor
private func makeConfiguredWebView(coordinator: WebCoordinator, snapshot: NativeBridgeSnapshot) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    #if DEBUG
    configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")
    #endif
    #if os(iOS)
    configuration.defaultWebpagePreferences.preferredContentMode = .mobile
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = []
    #endif
    installUserScripts(on: configuration.userContentController, snapshot: snapshot)
    configuration.userContentController.add(coordinator, name: "rai")
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    webView.uiDelegate = coordinator
    webView.allowsBackForwardNavigationGestures = false
    webView.allowsLinkPreview = false
    #if os(iOS)
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.scrollView.contentInset = .zero
    webView.scrollView.keyboardDismissMode = .interactive
    webView.backgroundColor = UIColor(red: 0.95, green: 0.96, blue: 0.95, alpha: 1)
    webView.isOpaque = true
    #endif
    #if DEBUG
    if #available(iOS 16.4, macOS 13.3, *) {
        webView.isInspectable = true
    }
    #endif
    return webView
}

@MainActor
private func installUserScripts(on controller: WKUserContentController, snapshot: NativeBridgeSnapshot) {
    controller.removeAllUserScripts()
    #if os(iOS)
    controller.addUserScript(iosSafeAreaUserScript(chromeTop: snapshot.chromeTop))
    #endif
    controller.addUserScript(WKUserScript(source: bridgeUserScript(snapshot), injectionTime: .atDocumentStart, forMainFrameOnly: true))
}

private func bridgeUserScript(_ snapshot: NativeBridgeSnapshot) -> String {
    """
    (() => {
      window.__raiToken = \(snapshot.tokenJS);
      window.__raiTrustedOrigin = \(snapshot.trustedOriginJS);
      window.__raiNative = \(snapshot.nativeObjectJS);
      if (!window.__raiFetchWrapped) {
        window.__raiFetchWrapped = true;
        const originalFetch = window.fetch;
        const isTrustedApi = (value) => {
          try {
            const url = new URL(typeof value === 'string' ? value : value.url, window.location.href);
            return url.origin === window.__raiTrustedOrigin && url.pathname.startsWith('/v1/');
          } catch (e) { return false; }
        };
        window.fetch = (input, init = {}) => {
          if (!isTrustedApi(input)) return originalFetch(input, init);
          const headers = new Headers(init.headers || {});
          if (!headers.has('authorization') && window.__raiToken) {
            headers.set('authorization', 'Bearer ' + window.__raiToken);
          }
          return originalFetch(input, {...init, headers});
        };
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function() {
          this.__raiAuth = isTrustedApi(arguments[1]);
          return originalOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          if (this.__raiAuth && window.__raiToken) {
            try { this.setRequestHeader('authorization', 'Bearer ' + window.__raiToken); } catch (e) {}
          }
          return originalSend.apply(this, arguments);
        };
      }
      window.dispatchEvent(new Event('rai:native-status'));
    })();
    """
}

@MainActor
private func injectToken(_ snapshot: NativeBridgeSnapshot, into webView: WKWebView) {
    webView.evaluateJavaScript("window.__raiToken = \(snapshot.tokenJS);", completionHandler: nil)
}

@MainActor
private func injectNativeStatus(_ snapshot: NativeBridgeSnapshot, into webView: WKWebView) {
    #if os(iOS)
    let insets = windowSafeAreaInsets()
    let css = """
    document.documentElement.dataset.shell = 'ios';
    document.documentElement.style.setProperty('--rai-safe-top', '\(insets.top)px');
    document.documentElement.style.setProperty('--rai-safe-bottom', '\(insets.bottom)px');
    document.documentElement.style.setProperty('--rai-chrome-top', '\(snapshot.chromeTop)px');
    """
    #else
    let css = ""
    #endif
    let source = """
    window.__raiToken = \(snapshot.tokenJS);
    window.__raiTrustedOrigin = \(snapshot.trustedOriginJS);
    window.__raiNative = \(snapshot.nativeObjectJS);
    \(css)
    window.dispatchEvent(new Event('rai:native-status'));
    """
    webView.evaluateJavaScript(source, completionHandler: nil)
}

@MainActor
private func injectDataUpdated(into webView: WKWebView) {
    webView.evaluateJavaScript("window.dispatchEvent(new Event('rai:data-updated'));", completionHandler: nil)
}

private func nativeStatusChanged(_ a: NativeBridgeSnapshot, _ b: NativeBridgeSnapshot) -> Bool {
    a.reachable != b.reachable
        || a.lastSyncAt != b.lastSyncAt
        || a.lastSyncMessage != b.lastSyncMessage
        || a.lastSyncError != b.lastSyncError
        || a.lastWorkoutCount != b.lastWorkoutCount
        || a.isBusy != b.isBusy
        || a.chromeTop != b.chromeTop
        || a.trustedOrigin != b.trustedOrigin
}

nonisolated private func parseRaiMessage(_ body: Any) -> (action: String, full: Bool)? {
    if let dict = body as? NSDictionary, let action = dict["action"] as? String {
        let full = (dict["full"] as? NSNumber)?.boolValue ?? boolValue(dict["full"])
        return (action, full)
    }
    if let dict = body as? [String: Any], let action = dict["action"] as? String {
        return (action, boolValue(dict["full"]))
    }
    if let text = body as? String, let data = text.data(using: .utf8),
       let json = try? JSONSerialization.jsonObject(with: data) {
        return parseRaiMessage(json)
    }
    return nil
}

nonisolated private func boolValue(_ value: Any?) -> Bool {
    if let value = value as? Bool { return value }
    if let value = value as? NSNumber { return value.boolValue }
    if let value = value as? String { return value == "true" || value == "1" }
    return false
}

private func jsJSONString(_ value: String) -> String {
    guard let data = try? JSONEncoder().encode(value),
          let text = String(data: data, encoding: .utf8) else {
        return "\"\""
    }
    return text
}

func iosShellURL(_ url: URL) -> URL {
    #if os(iOS)
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        return url
    }
    var items = components.queryItems ?? []
    if items.contains(where: { $0.name == "raiShell" }) {
        return url
    }
    items.append(URLQueryItem(name: "raiShell", value: "ios"))
    components.queryItems = items
    return components.url ?? url
    #else
    return url
    #endif
}
