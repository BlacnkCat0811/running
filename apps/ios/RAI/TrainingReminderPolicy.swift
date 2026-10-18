import Foundation

struct TrainingReminderSlot: Equatable {
    let localDate: String
    let fireAt: Date
    let title: String
}

/// 2026-10-18（审查 P2-10）：`reconcile` 的输入不再由调用方用
/// `canConfirmToday` 隐式表达 —— 教练闭环下 `today` 恒为 nil，`canConfirmToday`
/// 永远 false，提醒会静默失效却仍显示"已开启"。这里把"当前是否有可提醒的计划、
/// 提醒哪一份计划、哪些日期已完成"收敛为一个纯函数，由合同类型显式决定。
struct TrainingReminderContext: Equatable {
    let available: Bool
    let plan: MobileWorkoutPlanResponse?
    let completedDates: Set<String>

    static let unavailable = TrainingReminderContext(available: false, plan: nil, completedDates: [])
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

    /// 当前是否允许安排提醒，以及权威计划是哪一份。
    ///
    /// - 教练闭环：只提醒**今天已发布**的完整课（`devicePlan`，窗口 1 天）；
    ///   未来日只是展望，不排提醒。`refreshRequired` 或非当前业务日时不做任何事。
    /// - 旧合同：仍然是完整滚动执行窗口，但必须已通过与今日建议一致的 revision，
    ///   且 today 属于当前业务日（离线缓存/待刷新状态不可提醒）。
    static func context(isCurrent: Bool, persistenceFailed: Bool,
                        legacyToday: MobileTodayResponse?, legacyPlan: MobileWorkoutPlanResponse?,
                        completedDates: Set<String>, coachLoop: CoachLoopResponse?,
                        now: Date = Date()) -> TrainingReminderContext {
        guard isCurrent, !persistenceFailed else { return .unavailable }
        if let loop = coachLoop, loop.settings != nil {
            guard !loop.refreshRequired,
                  UserDataNoticePolicy.isCurrentDay(loop.today.day.localDate, timezone: loop.timezone, now: now) else {
                return .unavailable
            }
            return .init(available: true, plan: loop.devicePlan, completedDates: [])
        }
        guard let plan = legacyPlan, let today = legacyToday,
              plan.planRevision == today.recommendation.planRevision,
              plan.timezone == today.timezone,
              UserDataNoticePolicy.isCurrentDay(today.today.localDate, timezone: today.timezone, now: now) else {
            return .unavailable
        }
        return .init(available: true, plan: plan, completedDates: completedDates)
    }
}
