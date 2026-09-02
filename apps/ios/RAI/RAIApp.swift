import SwiftUI

@main
struct RAIApp: App {
    @State private var session = ServerSession()
    @State private var healthSync = HealthKitSync()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(healthSync)
        }
        #if os(macOS)
        .defaultSize(width: 1440, height: 900)
        #endif
    }
}
