import Foundation

/// Strong, consume-once readback. A date alone, content alone, or absent
/// timestamp cannot establish that THIS operation scheduled THIS day's workout.
enum PlanReceiptMatcher {
    static func instant(_ components: DateComponents, fallbackTimeZone: TimeZone) -> Date? {
        guard let year = components.year, let month = components.month, let day = components.day,
              let hour = components.hour, let minute = components.minute,
              (1970...9999).contains(year), (1...12).contains(month), (1...31).contains(day),
              (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = components.timeZone ?? components.calendar?.timeZone ?? fallbackTimeZone
        guard let date = calendar.date(from: components) else { return nil }
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        guard parts.year == year, parts.month == month, parts.day == day,
              parts.hour == hour, parts.minute == minute else { return nil }
        return date
    }

    static func matches(receipt: PlanSyncReceipt, entry: PlanScheduledEntry) -> Bool {
        guard let workoutID = receipt.workoutID, UUID(uuidString: workoutID) == entry.workoutID,
              receipt.localDate == entry.localDate, let scheduledAt = receipt.scheduledAt else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let instant = formatter.date(from: scheduledAt) ?? ISO8601DateFormatter().date(from: scheduledAt)
        return instant == entry.scheduledAt
    }

    /// Missing requests remain partial; unexpected or duplicate system entries
    /// must never be hidden by matching every requested workout.
    static func hasOnlyRequestedEntries(requests: [PlanSchedulingRequest], listed: [PlanSchedulingReadback], timeZone: TimeZone) -> Bool {
        var remaining = requests.map(\.entry)
        for item in listed {
            guard let at = instant(item.at, fallbackTimeZone: timeZone),
                  let index = remaining.firstIndex(where: { $0.workoutID == item.workoutID && $0.scheduledAt == at }) else { return false }
            remaining.remove(at: index)
        }
        return true
    }

    static func confirm(requests: [PlanSchedulingRequest], listed: [PlanSchedulingReadback], timeZone: TimeZone) -> Set<UUID> {
        var remaining = listed
        var confirmed = Set<UUID>()
        for request in requests {
            guard let pendingAt = instant(request.at, fallbackTimeZone: timeZone),
                  pendingAt == request.entry.scheduledAt,
                  UserDataNoticePolicy.localDate(now: pendingAt, timezone: timeZone.identifier) == request.entry.localDate,
                  let index = remaining.firstIndex(where: {
                      $0.workoutID == request.entry.workoutID && $0.contentMatches && !$0.complete &&
                      instant($0.at, fallbackTimeZone: timeZone) == pendingAt
                  }) else { continue }
            remaining.remove(at: index)
            confirmed.insert(request.entry.workoutID)
        }
        return confirmed
    }
}
