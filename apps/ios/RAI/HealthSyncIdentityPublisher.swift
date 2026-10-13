import Foundation

/// All online handshakes publish through this entry point. Keep the existing
/// handshake key and the recovery request in separate storage domains.
@MainActor
enum HealthSyncIdentityPublisher {
    static func syncScope(for baseURL: URL, identity: RaiHandshake) -> String {
        String(CacheStore.scope(baseURL: baseURL, handshake: identity).prefix(24))
    }

    static func urlScope(for baseURL: URL) -> String {
        String(CacheStore.urlScope(baseURL: baseURL).prefix(24))
    }

    /// 直连回执能力位的**具名读取入口**（§10.2 的"handshake 新增可选 raw receipt 能力"）。
    ///
    /// 为什么不让调用点直接写 `identity.factsAnalysisContractVersion`：这个数字决定
    /// "要不要按回执推进游标"，而它的**缺席**（老服务端）与"值小于下界"必须走同一个出口。
    /// 取值只在这里发生一次，`DirectSyncCursorPolicy.decision` 收到的是 `Int?` 并自己判下界，
    /// 于是调用点不必各写一份 `?? nil` / `?? 0` —— 那种写法里，`?? 0` 会把"老服务端"
    /// 悄悄变成"能力位为 0"（同样是 hold，但日志里再也看不出到底是哪一种）。
    ///
    /// 它**不参与** scope 计算：能力位变化不改变 `serverId` / `athleteId` / `datasetEpoch`，
    /// 所以 §10.2 那句"不随意改变 scope 或 datasetEpoch"在这里是结构性的 ——
    /// 本函数读不到任何 scope 用的字段。
    ///
    /// `nonisolated`：纯读一个 `Codable` 字段，没有共享状态要保护。
    nonisolated static func directSyncCapabilityVersion(_ identity: RaiHandshake) -> Int? {
        identity.factsAnalysisContractVersion
    }

    static func publish(
        _ identity: RaiHandshake,
        baseURL: URL,
        userDefaults: UserDefaults = .standard,
        load: @MainActor (URL) -> RaiHandshake? = { CacheStore.loadHandshake(baseURL: $0) },
        save: @MainActor (RaiHandshake, URL) -> Void = { CacheStore.saveHandshake($0, baseURL: $1) }
    ) {
        let nextScope = syncScope(for: baseURL, identity: identity)
        if let previous = load(baseURL), syncScope(for: baseURL, identity: previous) != nextScope {
            HealthSyncScopeRecoveryStore(userDefaults: userDefaults, baseKey: "rai.hk.backgroundRecovery")
                .record(urlScope: urlScope(for: baseURL), targetScope: nextScope)
        }
        // The request is durable before the shared offline identity changes.
        save(identity, baseURL)
    }
}
