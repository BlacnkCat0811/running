import SwiftUI

struct RootView: View {
    @Environment(ServerSession.self) private var session
    @Environment(HealthKitSync.self) private var healthSync
    @State private var showSettings = false

    var body: some View {
        connectedOrSetup
            .sheet(isPresented: $showSettings) {
                settingsSheet
            }
            .onAppear { session.startMonitoring() }
            .onDisappear { session.stopMonitoring() }
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
        ZStack(alignment: .topTrailing) {
            AppWebView(url: url, reloadToken: session.reloadToken)
                .ignoresSafeArea()
            VStack(alignment: .trailing, spacing: 8) {
                chromeButtons
                statusBanner
            }
            .padding(.trailing, 12)
            .safeAreaPadding(.top)
        }
        #else
        NavigationStack {
            AppWebView(url: url, reloadToken: session.reloadToken)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("RAI")
                .toolbar {
                    ToolbarItem(placement: .automatic) {
                        Button("服务器") { showSettings = true }
                    }
                    ToolbarItem(placement: .automatic) {
                        Button("刷新") { session.reload() }
                    }
                }
        }
        #endif
    }

    private var chromeButtons: some View {
        HStack(spacing: 12) {
            #if os(iOS)
            Button(healthSync.isBusy ? "同步中" : "同步健康") {
                Task {
                    await healthSync.sync(to: session.serverURL)
                    if healthSync.lastError == nil {
                        session.reload()
                    }
                }
            }
            .disabled(healthSync.isBusy || !session.isReachable)
            #endif
            Button("服务器") { showSettings = true }
            Button("刷新") { session.reload() }
                .disabled(!session.isReachable)
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
                showSettings = true
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
                .navigationTitle("开发服务器")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("完成") { showSettings = false }
                    }
                }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #endif
    }
}

struct SetupView: View {
    @Environment(ServerSession.self) private var session

    var body: some View {
        @Bindable var session = session
        Form {
            Section("Mac 开发服务器") {
                TextField("http://192.168.x.x:5173", text: $session.serverURLString)
                    #if os(iOS)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    #endif
                    .submitLabel(.done)
                if session.isReachable {
                    Label("已连接到开发服务器", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else if let error = session.lastError {
                    Text(error)
                        .foregroundStyle(.secondary)
                }
            }

            Section("使用") {
                Text("1. 虚拟机运行 npm run dev:device，把打印的局域网地址填到上面。")
                Text("2. 连上后点「同步健康」，允许读取跑步、心率和路线。")
                Text("3. 导入完成后点底部训练、统计、趋势查看结果。")
                Text("4. 不要填 127.0.0.1。VMware 请用桥接，USB 只负责安装 App。")
            }
        }
        .formStyle(.grouped)
    }
}
