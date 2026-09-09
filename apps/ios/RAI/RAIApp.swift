import SwiftUI
#if os(iOS)
import BackgroundTasks
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
        let session = ServerSession()
        self.session = session
        self.healthSync = HealthKitSync()
        #if os(iOS)
        self.native = NativeAppModel(session: session)
        #endif
        #if os(iOS)
        BGTaskScheduler.shared.register(forTaskWithIdentifier: "app.rai.running.health-sync", using: nil) { task in
            guard let processingTask = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            processingTask.expirationHandler = {
                self.healthSync.cancelSync()
            }
            Task { @MainActor in
                await self.healthSync.syncIfNeeded(
                    to: self.session.serverURL,
                    apiToken: self.session.apiToken,
                    force: true
                )
                processingTask.setTaskCompleted(success: !self.healthSync.isBusy)
                self.scheduleHealthSync()
            }
        }
        #endif
    }

    #if os(iOS)
    func scheduleHealthSync() {
        let request = BGProcessingTaskRequest(identifier: "app.rai.running.health-sync")
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
    #endif
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
                        model.scheduleHealthSync()
                        Task {
                            await model.healthSync.syncIfNeeded(
                                to: model.session.serverURL,
                                apiToken: model.session.apiToken
                            )
                        }
                    } else {
                        model.healthSync.cancelSync()
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
