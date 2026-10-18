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

    /// 2026-10-18（审查 P3-16）：撤回核验的"残留"判据必须与 `WorkoutKitBridge`
    /// 删除条目时的身份一致 —— UUID **且** 精确 scheduledAt，而不是只看 UUID。
    /// 只看 UUID 会把"同 UUID 不同时刻"的条目也算成己方残留；只看时刻又会丢身份。
    static func hasResidualEntries(_ entries: [PlanScheduledEntry], in listed: [PlanSchedulingReadback], timeZone: TimeZone) -> Bool {
        listed.contains { item in
            entries.contains { entry in
                entry.workoutID == item.workoutID &&
                    instant(item.at, fallbackTimeZone: timeZone) == entry.scheduledAt
            }
        }
    }

    /// 计划业务时区的解析入口（2026-10-18 深度审查 P3-25：**可选**，不再静默兜底）。
    ///
    /// 旧实现解析失败时回落 `UTC+8`。它被用在**撤回核验**（`hasResidualEntries`：UUID + 精确
    /// 时刻的身份比较）上，而"用一个错误的时区去比较绝对时刻"可能把残留判成已清、也可能把
    /// 已清判成残留 —— 两种都不可接受，而兜底让这种形态**不可见**（没有任何日志、没有失败）。
    ///
    /// 语义：`nil` = 这个字符串不是合法 IANA 时区 ⇒ 调用方**不得做身份比较**，必须按
    /// "不可核验"处理（`cleanupVerified = false`，保留风险账目并留诊断）。
    static func planTimeZone(_ identifier: String) -> TimeZone? {
        TimeZone(identifier: identifier)
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
