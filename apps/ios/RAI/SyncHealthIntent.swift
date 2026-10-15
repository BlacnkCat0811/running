#if os(iOS)
import AppIntents

struct SyncHealthIntent: AppIntent {
    static var title: LocalizedStringResource = "同步健康"
    static var description: IntentDescription = "从 Apple 健康增量同步跑步数据到 RAI"
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = await Self.syncOnMainActor()
        return .result(dialog: IntentDialog(stringLiteral: text))
    }

    @MainActor
    private static func syncOnMainActor() async -> String {
        let model = AppModel.shared
        await model.healthSync.sync(to: model.session.serverURL, apiToken: model.session.apiToken)
        // R1（2026-10-15）：快捷指令入口收工后接手未覆盖的代次 / 未读完的页（与视图入口同）。
        await RaiStartup.handOffUncoveredGenerations(healthSync: model.healthSync, session: model.session)
        if let error = model.healthSync.lastError {
            return error
        }
        return model.healthSync.message ?? "已开始同步 Apple 健康"
    }
}

struct RAIShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SyncHealthIntent(),
            phrases: [
                "同步 \(.applicationName) 健康",
                "用 \(.applicationName) 同步跑步"
            ],
            shortTitle: "同步健康",
            systemImageName: "heart.fill"
        )
    }
}
#endif
