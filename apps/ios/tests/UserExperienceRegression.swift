import Foundation

@main struct UserExperienceRegression {
    static func main() throws {
        // Force the device default away from the plan timezone: deleting the
        // production timezone assignment must fail even on a Shanghai host.
        let priorDefault = NSTimeZone.default
        NSTimeZone.default = TimeZone(secondsFromGMT: 0)!
        defer { NSTimeZone.default = priorDefault }
        let boundary = ISO8601DateFormatter().date(from: "2026-09-28T16:30:00Z")!
        precondition(UserDataNoticePolicy.isCurrentDay("2026-09-29", timezone: "Asia/Shanghai", now: boundary), "Shanghai has crossed midnight")
        precondition(!UserDataNoticePolicy.isCurrentDay("2026-09-28", timezone: "Asia/Shanghai", now: boundary), "Shanghai must reject the UTC date")
        precondition(UserDataNoticePolicy.isCurrentDay("2026-09-28", timezone: "UTC", now: boundary), "Use the requested zone, not a hardcoded Shanghai zone")
        precondition(!UserDataNoticePolicy.isCurrentDay("2026-09-29", timezone: "UTC", now: boundary))
        precondition(UserDataNoticePolicy.isCurrentDay("2026-09-29", timezone: nil, now: boundary))
        precondition(UserDataNoticePolicy.isCurrentDay("2026-09-29", timezone: "invalid-zone", now: boundary))
        let now = ISO8601DateFormatter().date(from: "2026-09-28T00:00:00Z")!
        precondition(UserDataNoticePolicy.isCurrentDay("2026-09-28", timezone: "Asia/Shanghai", now: now))
        precondition(!UserDataNoticePolicy.isCurrentDay("2026-09-27", timezone: "Asia/Shanghai", now: now))
        precondition(UserDataNoticePolicy.recommendationNotice(currentDay: true, available: true) == nil)
        precondition(UserDataNoticePolicy.recommendationNotice(currentDay: false, available: true)!.contains("不可确认"))
        let json = """
        {"generatedAt":"2026-09-28T00:00:00Z","timezone":"Asia/Shanghai","windowDays":7,"planRevision":1,"audit":null,
         "days":[{"localDate":"2026-09-29","kind":"easy","title":"轻松跑","reason":"","distanceKm":5,"durationMinutes":30,
          "structure":null,"source":"heuristic","executable":true},
          {"localDate":"2026-09-30","kind":"rest","title":"休息","reason":"","source":"heuristic","executable":false}]}
        """
        let plan = try JSONDecoder().decode(MobileWorkoutPlanResponse.self, from: Data(json.utf8))
        let slots = TrainingReminderPolicy.slots(plan: plan, completedDates: [], hour: 8, now: now)
        precondition(slots.count == 1)
        precondition(ISO8601DateFormatter().string(from: slots[0].fireAt) == "2026-09-29T00:00:00Z")
        precondition(TrainingReminderPolicy.slots(plan: plan, completedDates: ["2026-09-29"], hour: 8, now: now).isEmpty)
        precondition(TrainingReminderPolicy.slots(plan: plan, completedDates: [], hour: 22, now: now).isEmpty)
        precondition(TrainingReminderPolicy.slots(plan: plan, completedDates: [], hour: 8, now: now.addingTimeInterval(8 * 86400)).isEmpty)
        precondition(TrainingReminderPolicy.slots(plan: nil, completedDates: [], hour: 8, now: now).isEmpty)
        let feedback = """
        {"trainingSessionId":"test","expectedRevision":4,"eligibilityOverride":"exclude","statisticsParticipation":"include",
         "sessionType":"race","performanceProtocol":"five_k_time_trial","rpe":null,"conditionTags":["hot"],"note":null}
        """
        let input = try JSONDecoder().decode(NativeWorkoutFeedbackInput.self, from: Data(feedback.utf8))
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as! [String: Any]
        precondition(encoded["rpe"] is NSNull && encoded["note"] is NSNull)
        precondition(encoded["expectedRevision"] as? Int == 4)
        precondition(encoded["performanceProtocol"] as? String == "five_k_time_trial")
        precondition(encoded["statisticsParticipation"] as? String == "include")
        print("User experience policy, reminders and feedback round-trip checks passed")
    }
}
