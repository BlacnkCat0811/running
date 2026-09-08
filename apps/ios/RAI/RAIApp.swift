import SwiftUI

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
                #endif
                #if os(iOS)
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
