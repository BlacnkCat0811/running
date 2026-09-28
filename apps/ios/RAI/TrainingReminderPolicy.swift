import Foundation

struct TrainingReminderSlot: Equatable {
    let localDate: String
    let fireAt: Date
    let title: String
}
enum TrainingReminderPolicy {
    /// Single-shot, no catch-up alerts, no reminders during 22:00–06:59.
    static func slots(plan: MobileWorkoutPlanResponse?, completedDates: Set<String>, hour: Int,
                      now: Date = Date()) -> [TrainingReminderSlot] {
        guard (7...21).contains(hour), let plan, let zone = TimeZone(identifier: plan.timezone) else { return [] }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone; formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
        var seen = Set<String>()
        return plan.days.compactMap { day in
            guard day.executable, day.kind != "rest", !completedDates.contains(day.localDate),
                  seen.insert(day.localDate).inserted, let date = formatter.date(from: day.localDate),
                  formatter.string(from: date) == day.localDate,
                  let fire = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: date),
                  fire > now, fire.timeIntervalSince(now) <= 7 * 86400 else { return nil }
            return TrainingReminderSlot(localDate: day.localDate, fireAt: fire, title: day.title)
        }
    }
}
