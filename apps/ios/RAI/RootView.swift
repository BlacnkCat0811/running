import SwiftUI
#if os(iOS)
import UIKit
#endif

struct RootView: View {
    @Environment(ServerSession.self) private var session
    @Environment(HealthKitSync.self) private var healthSync
    @Environment(ChromeController.self) private var chrome
    @Environment(ServerDiscovery.self) private var discovery
    #if os(iOS)
    @Environment(NativeAppModel.self) private var native
    #endif

    var body: some View {
        @Bindable var chrome = chrome
        connectedOrSetup
            .sheet(isPresented: $chrome.showSettings) {
                settingsSheet
            }
            .onAppear {
                session.startMonitoring()
                discovery.start()
                healthSync.startForegroundObserver { [session, healthSync] in
                    await healthSync.syncIfNeeded(to: session.serverURL, apiToken: session.apiToken, force: true)
                }
            }
            .onDisappear {
                session.stopMonitoring()
                discovery.stop()
            }
    }

    @ViewBuilder
    private var connectedOrSetup: some View {
        if let url = session.serverURL {
            connectedView(url: url)
        } else {
            NavigationStack {
                SetupView()
                    .navigationTitle("RAI")
                    #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                    #endif
            }
        }
    }

    @ViewBuilder
    private func connectedView(url: URL) -> some View {
        #if os(iOS)
        NativeRootView()
        #else
        NavigationStack {
            AppWebView(
                url: url,
                reloadToken: session.reloadToken,
                snapshot: nativeSnapshot,
                session: session,
                healthSync: healthSync,
                chrome: chrome
            )
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle("RAI")
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    Button("服务器") { chrome.openServer() }
                }
                ToolbarItem(placement: .automatic) {
                    Button("刷新") { session.reload() }
                }
            }
        }
        #endif
    }

    private var nativeSnapshot: NativeBridgeSnapshot {
        NativeBridgeSnapshot(
            token: session.apiToken,
            trustedOrigin: session.serverURL.flatMap { url in
                var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
                components?.path = ""
                components?.query = nil
                components?.fragment = nil
                return components?.string
            },
            reachable: session.isReachable,
            lastSyncAt: healthSync.lastSyncAtISO,
            lastSyncMessage: healthSync.message,
            lastSyncError: healthSync.lastError,
            lastWorkoutCount: healthSync.lastWorkoutCount,
            isBusy: healthSync.isBusy,
            chromeTop: nativeChromeTop,
            dataUpdatedGeneration: healthSync.dataUpdatedGeneration
        )
    }

    private var nativeChromeTop: Double {
        #if os(iOS)
        chrome.overlayHeight
        #else
        0
        #endif
    }

    private var chromeButtons: some View {
        HStack(spacing: 12) {
            #if os(iOS)
            if !session.hasConnectedOnce || !healthSync.hasCompletedSync {
                Button(healthSync.isBusy ? "同步中" : "同步健康") {
                    Task {
                        await healthSync.sync(to: session.serverURL, apiToken: session.apiToken)
                    }
                }
                .disabled(healthSync.isBusy || !session.isReachable)
            }
            #endif
            Button("服务器") { chrome.openServer() }
            if !session.hasConnectedOnce {
                Button("刷新") { session.reload() }
                    .disabled(!session.isReachable)
            }
        }
        .font(.footnote.weight(.semibold))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.ultraThinMaterial, in: Capsule())
    }

    @ViewBuilder
    private var statusBanner: some View {
        if !session.isReachable, let error = session.lastError {
            banner(text: error, color: Color.orange) {
                chrome.openServer()
            }
        } else if let error = healthSync.lastError {
            banner(text: error, color: Color.red) {
                healthSync.dismissStatus()
            }
        } else if let message = healthSync.message {
            banner(text: message, color: Color.primary, tappable: !healthSync.isBusy) {
                healthSync.dismissStatus()
            }
        }
    }

    private func banner(text: String, color: Color, tappable: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(text)
                .font(.caption)
                .foregroundStyle(color)
                .multilineTextAlignment(.trailing)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
                .frame(maxWidth: 280, alignment: .trailing)
        }
        .buttonStyle(.plain)
        .disabled(!tappable)
    }

    private var settingsSheet: some View {
        NavigationStack {
            SetupView()
                .navigationTitle("RAI 服务")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("完成") { chrome.showSettings = false }
                    }
                }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
    }
}

struct SetupView: View {
    #if os(iOS)
    @Environment(\.appSkin) private var skin
    #endif
    @State private var draftURL = ""
    @State private var draftToken = ""
    @Environment(ServerSession.self) private var session
    @Environment(ServerDiscovery.self) private var discovery

    var body: some View {
        #if os(iOS)
        Group {
            if skin == .technology { TechSetupView() }
            else { pixelBody }
        }
            .onAppear {
                draftURL = session.serverURLString
                draftToken = session.apiToken
            }
        #else
        formBody
        #endif
    }

    #if os(iOS)
    private var pixelBody: some View {
        @Bindable var session = session
        return ZStack {
            PixelBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: PixelMetrics.sectionSpacing) {
                    PixelPageHeader(title: "连接 RAI") {
                        PixelBadge(title: session.isReachable ? "在线" : "待连接", color: session.isReachable ? PixelColor.green : PixelColor.coral, fill: session.isReachable ? PixelColor.mint : PixelColor.paleCoral)
                    }
                    PixelPanel {
                        VStack(alignment: .leading, spacing: 11) {
                            PixelSectionHeader(title: "服务连接", trailing: session.isReachable ? "已连接" : "未连接", trailingColor: session.isReachable ? PixelColor.green : PixelColor.coral)
                            PixelField("服务器地址") {
                                TextField(serverPlaceholder, text: Binding(
                                    get: { draftURL },
                                    set: {
                                        draftURL = $0
                                        draftToken = Keychain.loadToken(for: $0)
                                    }
                                ))
                                    .keyboardType(.URL)
                                    .textInputAutocapitalization(.never)
                                    .autocorrectionDisabled()
                                    .submitLabel(.done)
                            }
                            PixelField("API Token（云端部署时填写）") {
                                SecureField("可选", text: $draftToken)
                            }
                            PixelPrimaryButton(title: "检查连接", systemName: "network", isDisabled: draftURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                                session.serverURLString = draftURL
                                session.apiToken = draftToken
                                Task { await session.probe() }
                            }
                            if let error = session.lastError {
                                Text(error)
                                    .font(.caption)
                                    .foregroundStyle(PixelColor.coral)
                            }
                        }
                    }
                    if !discovery.candidates.isEmpty {
                        PixelPanel(tint: PixelColor.cyan) {
                            VStack(alignment: .leading, spacing: 8) {
                                PixelSectionHeader(title: "发现的 RAI 服务", trailing: "Bonjour", trailingColor: PixelColor.cyan)
                                ForEach(discovery.candidates, id: \.absoluteString) { url in
                                    Button(url.absoluteString) {
                                        draftURL = url.absoluteString
                                        draftToken = Keychain.loadToken(for: url.absoluteString)
                                    }
                                    .font(.caption.monospaced())
                                    .foregroundStyle(PixelColor.cyan)
                                }
                            }
                        }
                    }
                    PixelPanel {
                        VStack(alignment: .leading, spacing: 7) {
                            PixelSectionHeader(title: "使用说明")
                            Text("1. 虚拟机运行 npm run dev:device，把打印的局域网地址填到上面。")
                            Text("2. VMware 请使用桥接网络；不要填写 127.0.0.1。")
                            Text("3. 连接后在首页同步 Apple 健康，数据会进入当前 RAI API。")
                            Text("4. 手机端只展示结果，不运行 Node.js、评分核心或服务端 SQLite。")
                        }
                        .font(.footnote)
                        .foregroundStyle(PixelColor.muted)
                    }
                    Button("打开健康权限") {
                        if let url = URL(string: "x-apple-health://") {
                            UIApplication.shared.open(url)
                        }
                    }
                    .font(.footnote.weight(.heavy))
                    .foregroundStyle(PixelColor.cyan)
                    .frame(maxWidth: .infinity)
                    AppSkinPicker()
                }
                .padding(.horizontal, PixelMetrics.pageHorizontal)
                .padding(.vertical, PixelMetrics.pageVertical)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }
    #endif

    private var serverPlaceholder: String {
        #if DEBUG
        return "http://192.168.x.x:5173"
        #else
        return "https://rai.example.com"
        #endif
    }

    private var formBody: some View {
        @Bindable var session = session
        return Form {
            Section("服务连接") {
                TextField("https://rai.example.com", text: $session.serverURLString)
                    .submitLabel(.done)
                SecureField("API Token（云端部署时填写）", text: $session.apiToken)
                if session.isReachable {
                    Label("已连接到 RAI 服务", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else if let error = session.lastError {
                    Text(error)
                        .foregroundStyle(.secondary)
                }
            }

            if !discovery.candidates.isEmpty {
                Section("发现的 RAI 服务") {
                    ForEach(discovery.candidates, id: \.absoluteString) { url in
                        Button(url.absoluteString) {
                            session.serverURLString = url.absoluteString
                        }
                    }
                }
            }
            Section("使用") {
                Text("1. 虚拟机运行 npm run dev:device，把打印的局域网地址填到上面。")
                Text("2. 连上后在设置里点「同步健康」，允许读取跑步、心率和路线。")
                Text("3. 导入完成后点底部训练、统计、趋势查看结果。")
                Text("4. 不要填 127.0.0.1。VMware 请用桥接，USB 只负责安装 App。")
            }
        }
        .formStyle(.grouped)
    }
}
