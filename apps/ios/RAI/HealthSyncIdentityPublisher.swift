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
