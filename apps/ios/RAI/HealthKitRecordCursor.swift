import Foundation

/// Event time is not arrival time. Anchors have a fixed, unbounded predicate.
/// Manual sync and periodic history replay also cover newly granted read access,
/// which HealthKit deliberately doesn't expose as an authorization boolean.
nonisolated struct HealthKitRecordCursor: Codable, Equatable, Sendable {
    let anchor: Data
    let historyReadAt: Date

    func needsHistoryRead(now: Date, force: Bool) -> Bool {
        force || now.timeIntervalSince(historyReadAt) >= 7 * 24 * 60 * 60
    }

    /// An additions-empty page is not EOF when it contains deletions. Return
    /// only a fully consumed cursor; callers persist it after server acceptance.
    static func drain<Anchor, Sample, Deletion>(
        from start: Anchor?,
        query: (Anchor?) async throws -> (added: [Sample], deleted: [Deletion], next: Anchor),
        consume: ([Sample], [Deletion]) throws -> Void
    ) async throws -> Anchor {
        var anchor = start
        while true {
            try Task.checkCancellation()
            let page = try await query(anchor)
            try Task.checkCancellation()
            try consume(page.added, page.deleted)
            if page.added.isEmpty && page.deleted.isEmpty { return page.next }
            anchor = page.next
        }
    }
}
