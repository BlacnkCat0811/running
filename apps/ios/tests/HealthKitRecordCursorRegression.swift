import Foundation

@main
struct HealthKitRecordCursorRegression {
    static func main() async throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let cursor = HealthKitRecordCursor(anchor: Data([1, 2, 3]), historyReadAt: now)
        precondition(!cursor.needsHistoryRead(now: now, force: false), "normal sync uses the type anchor")
        precondition(cursor.needsHistoryRead(now: now, force: true), "manual sync replays newly authorized history")
        precondition(!cursor.needsHistoryRead(now: now.addingTimeInterval(7 * 86400 - 1), force: false))
        precondition(cursor.needsHistoryRead(now: now.addingTimeInterval(7 * 86400), force: false),
                     "background sync eventually replays history even without a detectable permission grant")
        let cursors = ["sleep": cursor, "hrv": cursor]
        let decoded = try JSONDecoder().decode([String: HealthKitRecordCursor].self,
                                               from: JSONEncoder().encode(cursors))
        precondition(decoded == cursors,
                     "all per-type cursors survive pending-batch serialization")
        var queried: [Int?] = []
        var observed: [String] = []
        let next = try await HealthKitRecordCursor.drain(from: Optional<Int>.none, query: { anchor in
            queried.append(anchor)
            switch anchor {
            case nil: return (added: ["historical-2010"], deleted: [String](), next: 1)
            case 1: return (added: [], deleted: ["old-sleep-uuid"], next: 2)
            case 2: return (added: ["late-2012"], deleted: [], next: 3)
            default: return (added: [], deleted: [], next: 4)
            }
        }, consume: { observed += $0 + $1 })
        precondition(next == 4 && queried == [nil, 1, 2, 3], "every page including deletion-only pages is drained")
        precondition(observed == ["historical-2010", "old-sleep-uuid", "late-2012"], "historical dates never filter changes")
        enum Failure: Error { case fixture }
        var returned: Int?
        do {
            returned = try await HealthKitRecordCursor.drain(from: Optional(10), query: { anchor in
                if anchor == 10 { return (added: [1], deleted: [Int](), next: 11) }
                throw Failure.fixture
            }, consume: { _, _ in })
            preconditionFailure("a failed page must fail the export")
        } catch Failure.fixture {}
        precondition(returned == nil, "partial failure cannot return an advanced cursor")
        print("HealthKit record cursor regression: 8 checks passed")
    }
}
