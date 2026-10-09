import Foundation

/// Presentation only: never infers coverage from the last workout or changes sync state.
enum UserDataNoticePolicy {
    static func isCurrentDay(_ date: String, timezone: String?, now: Date = Date()) -> Bool {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: timezone ?? "Asia/Shanghai") ?? TimeZone(secondsFromGMT: 8 * 3600)
        formatter.dateFormat = "yyyy-MM-dd"
        return date == formatter.string(from: now)
    }

    static func localDate(now: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: timezone)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: now)
    }

    static func recommendationNotice(currentDay: Bool, available: Bool) -> String? {
        if !currentDay { return "连接后查看今天的安排；以下为上次建议，不可确认。" }
        if !available { return "离线参考：连接并刷新后才能确认安排。" }
        return nil
    }
}
