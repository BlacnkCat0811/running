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
    @AppStorage(AppSkin.storageKey) private var rawSkin = AppSkin.pixel.rawValue
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
                .environment(\.appSkin, AppSkin.resolve(rawSkin))
                .preferredColorScheme(AppSkin.resolve(rawSkin) == .technology ? .dark : nil)
                .tint(AppSkin.resolve(rawSkin) == .technology ? TechColor.cyan : nil)
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
                        }
                    } else {
                        if phase == .background {
                            model.healthSync.cancelSync()
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
