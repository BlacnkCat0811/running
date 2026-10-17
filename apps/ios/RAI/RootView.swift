import SwiftUI

struct RootView: View {
    @Environment(ServerSession.self) private var session
    @Environment(ServerDiscovery.self) private var discovery

    var body: some View {
        connectedOrSetup
            .onAppear {
                session.startMonitoring()
                discovery.start()
                // 健康观察者**不在这里注册**：它必须早于任何 UI（后台唤醒时视图根本不会出现），
                // 入口在 `AppDelegate.didFinishLaunching` → `RaiStartup.registerSyncEntryPoints`。
            }
            .onDisappear {
                session.stopMonitoring()
                discovery.stop()
            }
    }

    @ViewBuilder
    private var connectedOrSetup: some View {
        if session.serverURL != nil {
            NativeRootView()
        } else {
            NavigationStack {
                SetupView()
                    .navigationTitle("RAI")
                    .navigationBarTitleDisplayMode(.inline)
            }
        }
    }
}

struct SetupView: View {
    @Environment(ServerSession.self) private var session
    @Environment(ServerDiscovery.self) private var discovery

    var body: some View {
        // 原生端只有清新一套视觉，首次连接页固定走 TechSetupView。
        // 像素皮肤的 `pixelBody`、`serverPlaceholder` 与两个草稿状态一并删除：
        // `TechSetupView` 自己管草稿，外层再存一份只会是一份没人读的副本。
        TechSetupView()
    }
}
