import Foundation

/// Event time is not arrival time. Anchors have a fixed, unbounded predicate.
/// Only explicit full import replays history after newly granted read access.
/// Ordinary/automatic sync never resets an established cursor on a timer.
nonisolated struct HealthKitRecordCursor: Codable, Equatable, Sendable {
    let anchor: Data
    let historyReadAt: Date

    func needsHistoryRead(now _: Date, force: Bool) -> Bool {
        // Keep historyReadAt in persisted payloads for backward compatibility.
        // Elapsed time is not evidence that HealthKit's change cursor is stale.
        force
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
