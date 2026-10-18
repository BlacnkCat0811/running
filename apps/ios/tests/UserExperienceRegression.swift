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

        // 2026-10-18（审查 P2-10）：提醒上下文必须显式区分合同。旧实现把
        // `canConfirmToday` 当"提醒可用性"，而教练闭环下 today == nil ⇒ 提醒静默失效。
        let contextNow = ISO8601DateFormatter().date(from: "2026-09-29T00:00:00Z")!
        let todayJSON = """
        {"generatedAt":"2026-09-29T00:00:00Z","timezone":"Asia/Shanghai","latestDataDate":null,"lastSyncedAt":null,
         "sync":{"status":"never","lastAttemptAt":null,"lastSuccessAt":null,"error":null},
         "coverage":{"latestTrainingDate":null,"latestHealthSampleAt":null,
          "sleep":{"state":"none","latestDate":null},"hrv":{"state":"none","latestDate":null},
          "restingHeartRate":{"state":"none","latestDate":null}},
         "recoveryAssessment":{"targetDate":"2026-09-29","coverage":"none","assessment":"not_assessed","reasonCodes":[],"lastObservationDate":null},
         "recommendation":{"planRevision":1,"basis":"training_load_and_plan","recoveryAdjustment":"none","uncertaintyReasons":[],"reasonCodes":[]},
         "freshness":{"state":"unknown","checkedAt":null,"latestTrainingDate":null,"recoveryDate":null},
         "recommendationRevision":"fixture",
         "today":{"localDate":"2026-09-29","distanceKm":0,"durationSeconds":0,"paceSecondsPerKm":null,"energyKcal":null,"workoutCount":0},
         "week":{"periodStart":"2026-09-28","periodEnd":"2026-10-04","distanceKm":0,"durationSeconds":0,"workoutCount":0},
         "weekDaily":[],"recentWorkouts":[],
         "ability":{"trueAbility":null,"currentAbility":null,"changeFrom7DaysAgo":null,"growthVelocityPerWeek":null,"decayPoints":0,"snapshotDate":null,"explanation":""},
         "calibration":{"status":"not_started","eligibleSessions":0,"eligibleDurationMinutes":0,"spanDays":0,"highCoverageSessions":0,"requirements":{"sessions":12,"durationMinutes":360,"spanDays":28,"highCoverageSessions":6},"message":""},
         "verdict":{"tone":"yellow","title":"","reason":"","triggers":[],"stale":false,"reasonCodes":[]},
         "nextSession":{"kind":"rest","title":"","reason":"","distanceKm":null,"durationMinutes":null,"paceSecondsPerKmLower":null,"paceSecondsPerKmUpper":null,"heartRateBpmLower":null,"heartRateBpmUpper":null,"structure":null},
         "recovery":{"score":null,"lastNightSleepMinutes":null,"sleepBaselineMinutes":null,"morningHrvMs":null,"hrvBaselineMs":null,"restingHeartRateBpm":null,"restingHeartRateBaselineBpm":null,"state":"unknown","hrvSampleCount":0,"note":""},
         "weekStructure":{"easyDurationFraction":null,"easyDurationFloorFraction":0.7,"qualitySessionCount":0,"qualitySessionCap":2,"easyHonesty":{"intendedEasyCount":0,"easyEnoughCount":0,"honestyFraction":null,"note":""}},
         "race":{"target":null,"daysUntil":null,"taper":false,"shapeScore":null,"volumeFraction":null,"longRunFraction":null,"note":""},
         "injuryFlags":[],"weekPlan":[],"phase":"morning_open","lock":{"present":false,"relockSuggested":false,"lockedAt":null}}
        """
        let legacyToday = try JSONDecoder().decode(MobileTodayResponse.self, from: Data(todayJSON.utf8))
        let legacyContext = TrainingReminderPolicy.context(isCurrent: true, persistenceFailed: false,
            legacyToday: legacyToday, legacyPlan: plan, completedDates: [], coachLoop: nil, now: contextNow)
        precondition(legacyContext.available && legacyContext.plan?.days.count == plan.days.count,
                     "a current legacy plan yields a schedulable reminder context")
        precondition(!TrainingReminderPolicy.context(isCurrent: false, persistenceFailed: false,
            legacyToday: legacyToday, legacyPlan: plan, completedDates: [], coachLoop: nil, now: contextNow).available,
            "an unconfirmed plan cannot schedule reminders")
        precondition(!TrainingReminderPolicy.context(isCurrent: true, persistenceFailed: true,
            legacyToday: legacyToday, legacyPlan: plan, completedDates: [], coachLoop: nil, now: contextNow).available,
            "unpersisted safety state cannot schedule reminders")
        let nextBusinessDay = ISO8601DateFormatter().date(from: "2026-09-30T00:00:00Z")!
        precondition(!TrainingReminderPolicy.context(isCurrent: true, persistenceFailed: false,
            legacyToday: legacyToday, legacyPlan: plan, completedDates: [], coachLoop: nil, now: nextBusinessDay).available,
            "a yesterday plan cannot schedule reminders after the business day ends")

        // 教练闭环：只提醒今天已发布的完整课；refreshRequired 时仅作参照。
        let loopData = try Data(contentsOf: URL(fileURLWithPath: "apps/ios/tests/fixtures/coach-loop-v1.json"))
        let loop = try JSONDecoder().decode(CoachLoopResponse.self, from: loopData)
        let loopNow = ISO8601DateFormatter().date(from: "2026-10-08T04:00:00Z")!
        let loopContext = TrainingReminderPolicy.context(isCurrent: true, persistenceFailed: false,
            legacyToday: nil, legacyPlan: nil, completedDates: [], coachLoop: loop, now: loopNow)
        precondition(loopContext.available && loopContext.plan?.windowDays == 1,
                     "coach-loop reminders target today's published course only")
        precondition(TrainingReminderPolicy.slots(plan: loopContext.plan, completedDates: [], hour: 8, now: loopNow).count <= 1,
                     "coach-loop reminder slots never invent future days")
        var loopObject = try JSONSerialization.jsonObject(with: loopData) as! [String: Any]
        loopObject["refreshRequired"] = true
        let refreshRequiredLoop = try JSONDecoder().decode(CoachLoopResponse.self,
            from: try JSONSerialization.data(withJSONObject: loopObject))
        precondition(!TrainingReminderPolicy.context(isCurrent: true, persistenceFailed: false,
            legacyToday: nil, legacyPlan: nil, completedDates: [], coachLoop: refreshRequiredLoop, now: loopNow).available,
            "a refresh-required coach-loop snapshot is reference-only for reminders")

        // 2026-10-18（审查 P2-11）：比赛日期固定在业务时区（本测试开头已把设备默认时区设为 UTC）。
        precondition(NativeRaceGoalDraft.dateFormatter.timeZone.identifier == "Asia/Shanghai",
                     "race target dates must use the business timezone, not the device timezone")
        let shanghaiMidnight = ISO8601DateFormatter().date(from: "2026-10-08T16:30:00Z")!
        precondition(NativeRaceGoalDraft.businessLocalDate(shanghaiMidnight) == "2026-10-09",
                     "16:30Z is already the next business day in Shanghai")
        let lateEvening = ISO8601DateFormatter().date(from: "2026-10-08T15:30:00Z")!
        precondition(NativeRaceGoalDraft.businessLocalDate(lateEvening) == "2026-10-08",
                     "23:30 Shanghai stays on the same business day")
        // 2026-10-18（同步诊断 P0-5 / P0-6）：用户能读到的两句同步结论。
        //
        // 这两条属于"用户体验承诺"，不是内部状态机：事故里用户的原话是"界面在还有 75 批
        // 待读时显示完成"，而"本批 0 新增"被读成"同步坏了"。判据逐字钉在文案上，
        // 因为它们改错了不会让任何东西变红 —— 只有用户会误解。
        let pendingCopy = SyncResultCopy.manualResult(
            hasPendingContinuation: true, hasPendingTask: false, isCancelled: false,
            hasError: false, succeeded: true, counts: nil)
        precondition(pendingCopy.contains("还有未读完的页"),
                     "a sync with unread pages must say so instead of reporting completion")
        precondition(pendingCopy != "健康数据检查完成。",
                     "an unfinished sync must never be reported as checks complete")
        let zeroInsertCopy = SyncResultCopy.manualResult(
            hasPendingContinuation: false, hasPendingTask: false, isCancelled: false,
            hasError: false, succeeded: true,
            counts: SyncResultCopy.BatchCounts(parsed: 4500, inserted: 0, unchanged: 4500))
        precondition(zeroInsertCopy.contains("均为已有记录"),
                     "a 0-insert batch must explain itself (duplicates are the normal state during replay)")
        precondition(SyncResultCopy.countsNote(SyncResultCopy.BatchCounts()) == nil,
                     "missing receipt counts must stay unknown instead of being written as zero inserts")
        precondition(SyncResultCopy.manualResult(
            hasPendingContinuation: false, hasPendingTask: false, isCancelled: false,
            hasError: false, succeeded: true, counts: nil) == "健康数据检查完成。",
            "a plain successful sync keeps the documented result line")

        print("User experience policy, reminders and feedback round-trip checks passed")
    }
}
