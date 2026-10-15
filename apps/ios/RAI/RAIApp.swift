import SwiftUI
#if os(iOS)
import AMapFoundationKit
import MAMapKit
#endif

@MainActor
final class AppModel {
    static let shared = AppModel()
    let session: ServerSession
    let healthSync: HealthKitSync
    let chrome = ChromeController()
    let discovery = ServerDiscovery()
    #if os(iOS)
    let native: NativeAppModel
    #endif

    init() {
        #if os(iOS)
        // 高德合规：只有用户同意隐私政策后才初始化高德地图与 Key（见 MapPrivacy）。
        // MAMapKit 要求在任何 MAMapView 实例化之前完成，因此放在最早的 init 里。
        MapPrivacy.configureIfAgreed()
        #endif
        let session = ServerSession()
        self.session = session
        self.healthSync = HealthKitSync()
        #if os(iOS)
        self.native = NativeAppModel(session: session)
        #endif
    }
}

@main
struct RAIApp: App {
    #if os(iOS)
    /// 启动期入口。HealthKit 观察者必须**早于任何 UI** 注册（后台唤醒时视图不会出现），
    /// 所以它挂在 `didFinishLaunching` 而不是 `RootView.onAppear`。
    /// 逻辑本身全在 `AppDelegate.swift` 里 —— 本文件被 `typecheck-ios.sh` 排除。
    @UIApplicationDelegateAdaptor(RaiAppDelegate.self) private var appDelegate
    @AppStorage(MapPrivacy.storageKey) private var mapPrivacyState = MapPrivacy.State.ask.rawValue
    @Environment(\.scenePhase) private var scenePhase
    #endif

    var body: some Scene {
        let model = AppModel.shared
        WindowGroup {
            RootView()
                .environment(model.session)
                .environment(model.healthSync)
                .environment(model.chrome)
                .environment(model.discovery)
                #if os(iOS)
                .environment(model.native)
                // 原生端只有运动深色一套视觉：配色与强调色固定，
                // 不再从 `rai.appearance.skin` 读取（存量键留着不影响，无人读它）。
                .preferredColorScheme(.dark)
                .tint(TechColor.cyan)
                #endif
                #if os(iOS)
                .overlay {
                    if mapPrivacyState == MapPrivacy.State.ask.rawValue {
                        MapPrivacyConsentView(
                            context: .firstRun,
                            onAgree: { MapPrivacy.agree() },
                            onDismiss: { MapPrivacy.decline() }
                        )
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        model.discovery.start()
                        Task {
                            await model.healthSync.syncIfNeeded(
                                to: model.session.serverURL,
                                apiToken: model.session.apiToken
                            )
                            // R1（2026-10-15）：回到前台也接手"未覆盖的代次 / 未读完的页"
                            //（此前只有观察者与解锁两个入口有这条收尾）。
                            await RaiStartup.handOffUncoveredGenerations(healthSync: model.healthSync, session: model.session)
                        }
                    } else {
                        if phase == .background {
                            // 不在这里取消：切后台中止的是"App 拥有的执行时间"，不是用户的意图。
                            // 由 `handleEnterBackground()` 按 `HealthSyncLifecycle` 判据决定
                            // 是让在飞的工作跑完、还是收手保存为可续接。
                            model.healthSync.handleEnterBackground()
                        }
                        model.discovery.stop()
                    }
                }
                #endif
        }
        #if os(macOS)
        .defaultSize(width: 1440, height: 900)
        #endif
    }
}
