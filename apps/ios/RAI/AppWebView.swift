import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

#if os(iOS)
struct AppWebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    let apiToken: String

    func makeCoordinator() -> WebCoordinator {
        WebCoordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = makeConfiguredWebView(coordinator: context.coordinator, apiToken: apiToken)
        context.coordinator.load(url, in: webView, apiToken: apiToken)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        injectIosSafeArea(webView)
        context.coordinator.update(url: url, reloadToken: reloadToken, apiToken: apiToken, webView: webView)
    }
}
#else
struct AppWebView: NSViewRepresentable {
    let url: URL
    let reloadToken: Int

    func makeCoordinator() -> WebCoordinator {
        WebCoordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let webView = makeConfiguredWebView(coordinator: context.coordinator, apiToken: apiToken)
        context.coordinator.load(url, in: webView, apiToken: apiToken)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.update(url: url, reloadToken: reloadToken, apiToken: apiToken, webView: webView)
    }
}
#endif

@MainActor
final class WebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var loadedURL: URL?
    var reloadToken = 0
    var loadedToken = ""
    private var retryCount = 0
    private var retryTask: Task<Void, Never>?

    func load(_ url: URL, in webView: WKWebView, apiToken: String = "") {
        loadedURL = url
        loadedToken = apiToken
        retryCount = 0
        webView.load(URLRequest(url: iosShellURL(url), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    func update(url: URL, reloadToken: Int, apiToken: String, webView: WKWebView) {
        if loadedURL != url {
            load(url, in: webView, apiToken: apiToken)
            self.reloadToken = reloadToken
            return
        }
        if loadedToken != apiToken {
            loadedToken = apiToken
            self.reloadToken = reloadToken
            #if os(iOS)
            injectApiToken(apiToken, into: webView)
            #endif
            webView.reload()
        } else if self.reloadToken != reloadToken {
            self.reloadToken = reloadToken
            retryCount = 0
            webView.reload()
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
        // Keep file/about and same-host navigations (including port changes,
        // which the dev frontend uses to reach the API) inside the shell.
        // Cross-host http(s) links open in the system browser instead.
        if url.isFileURL || url.scheme == "about" || url.host == nil || url.host == loadedURL?.host {
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
        #if os(iOS)
        injectIosSafeArea(webView)
        #endif
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        scheduleRetry(webView, error: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        scheduleRetry(webView, error: error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        retryCount = 0
        webView.reload()
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

private func iosSafeAreaUserScript() -> WKUserScript {
    let insets = windowSafeAreaInsets()
    let source = """
    document.documentElement.dataset.shell = 'ios';
    document.documentElement.style.setProperty('--rai-safe-top', '\(insets.top)px');
    document.documentElement.style.setProperty('--rai-safe-bottom', '\(insets.bottom)px');
    """
    return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
}

@MainActor
func injectIosSafeArea(_ webView: WKWebView) {
    let insets = windowSafeAreaInsets()
    let source = """
    document.documentElement.dataset.shell = 'ios';
    document.documentElement.style.setProperty('--rai-safe-top', '\(insets.top)px');
    document.documentElement.style.setProperty('--rai-safe-bottom', '\(insets.bottom)px');
    """
    webView.evaluateJavaScript(source, completionHandler: nil)
}
#endif

@MainActor
private func makeConfiguredWebView(coordinator: WebCoordinator, apiToken: String = "") -> WKWebView {
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
    configuration.userContentController.addUserScript(iosSafeAreaUserScript())
    if !apiToken.isEmpty {
        let escaped = apiToken.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        let authScript = """
        (() => {
          if (window.__raiToken === undefined) window.__raiToken = '\(escaped)';
          const originalFetch = window.fetch;
          window.fetch = (input, init = {}) => {
            const headers = new Headers(init.headers || {});
            if (!headers.has('authorization') && window.__raiToken) headers.set('authorization', 'Bearer ' + window.__raiToken);
            return originalFetch(input, {...init, headers});
          };
          const originalOpen = XMLHttpRequest.prototype.open;
          const originalSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function() { this.__raiAuth = true; return originalOpen.apply(this, arguments); };
          XMLHttpRequest.prototype.send = function() { if (this.__raiAuth && window.__raiToken) this.setRequestHeader('authorization', 'Bearer ' + window.__raiToken); return originalSend.apply(this, arguments); };
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: authScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    #endif
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    webView.uiDelegate = coordinator
    webView.allowsBackForwardNavigationGestures = true
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

#if os(iOS)
@MainActor
private func injectApiToken(_ token: String, into webView: WKWebView) {
    let escaped = token.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
    webView.evaluateJavaScript("window.__raiToken='\(escaped)';", completionHandler: nil)
}
#endif

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
