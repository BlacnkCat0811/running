import Foundation

/// Count the same seven-day buckets as the API's elapsedWeeks, including race
/// day. A race on the next bucket's first day belongs to that final week.
func techCoachTotalWeeks(for plan: MobileRunCoachPlan) -> Int? {
    if plan.goal == "fitness" {
        let weeks = plan.durationWeeks ?? 12
        return (6...52).contains(weeks) ? weeks : nil
    }
    guard let raceDate = plan.raceDate else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.isLenient = false
    guard let start = formatter.date(from: plan.startedOn),
          let end = formatter.date(from: raceDate),
          formatter.string(from: start) == plan.startedOn,
          formatter.string(from: end) == raceDate,
          let days = calendar.dateComponents([.day], from: start, to: end).day,
          days >= 0 else { return nil }
    return days / 7 + 1
}

/// Session-level zone ranges are references, not the alerts the Watch executes.
/// Only a uniform main-work alert can be summarised as one training target.
struct TechCoachTrainingTarget: Equatable {
    let alert: MobileStepAlert

    var title: String { alert.kind == "heart_rate" ? "目标心率" : "目标配速" }
}

func techCoachTrainingTarget(
    structure: MobileSessionStructure?,
    legacyAlert: MobileStepAlert? = nil
) -> TechCoachTrainingTarget? {
    let alert: MobileStepAlert?
    if let structure {
        let workSteps = structure.blocks.flatMap(\.steps).filter { $0.purpose == "work" }
        guard let first = workSteps.first?.alert,
              workSteps.allSatisfy({ $0.alert == first }) else { return nil }
        alert = first
    } else {
        // Older payloads have no structure. Do not use this fallback for a
        // structured session whose work deliberately carries no target.
        alert = legacyAlert
    }
    guard let alert, alert.isUsable, ["pace", "heart_rate"].contains(alert.kind) else { return nil }
    return TechCoachTrainingTarget(alert: alert)
}

func techCoachTrainingTarget(for session: MobileNextSession, preferredType: String) -> TechCoachTrainingTarget? {
    let legacyAlert = techCoachLegacyAlert(preferredType: preferredType,
        paceLower: session.paceSecondsPerKmLower, paceUpper: session.paceSecondsPerKmUpper,
        heartRateLower: session.heartRateBpmLower, heartRateUpper: session.heartRateBpmUpper)
    return techCoachTrainingTarget(structure: session.structure, legacyAlert: legacyAlert)
}

func techCoachTrainingTarget(for day: MobileWorkoutPlanDay, preferredType: String) -> TechCoachTrainingTarget? {
    let legacyAlert = techCoachLegacyAlert(preferredType: preferredType,
        paceLower: day.paceSecondsPerKmLower, paceUpper: day.paceSecondsPerKmUpper,
        heartRateLower: day.heartRateBpmLower, heartRateUpper: day.heartRateBpmUpper)
    return techCoachTrainingTarget(structure: day.structure, legacyAlert: legacyAlert)
}

private func techCoachLegacyAlert(
    preferredType: String,
    paceLower: Double?, paceUpper: Double?,
    heartRateLower: Double?, heartRateUpper: Double?
) -> MobileStepAlert? {
    switch preferredType {
    case "pace": return MobileStepAlert(kind: "pace", lower: paceLower, upper: paceUpper)
    case "heart_rate": return MobileStepAlert(kind: "heart_rate", lower: heartRateLower, upper: heartRateUpper)
    default: return nil
    }
}

/// A valid executable schedule is independent of the today endpoint. Use its
/// timezone and the current clock, never a stale/missing today payload, as the cutoff.
func techCoachUpcomingTrainingDays(in schedule: MobileWorkoutPlanResponse, now: Date = Date()) -> [MobileWorkoutPlanDay] {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = WorkoutPlanMapper.resolvedTimeZone(for: schedule)
    formatter.dateFormat = "yyyy-MM-dd"
    let todayLocalDate = formatter.string(from: now)
    return Array(schedule.days.filter { $0.localDate > todayLocalDate && $0.kind != "rest" }
        .sorted { $0.localDate < $1.localDate }
        .prefix(3))
}

/// Presentation counts only. The adherence response preserves historical prescriptions;
/// the week strip replaces completed days with observations and includes explicit rest days.
struct TechCoachWeekProgress {
    let completedCount: Int
    let plannedCount: Int
    let unknownCount: Int
    let fraction: Double?

    var unrecordedCount: Int { max(0, plannedCount - completedCount) }

    init(days: [MobileWeekPlanDay], adherence: MobileAdherenceWeek?) {
        completedCount = adherence?.observedDays ?? days.filter(techCoachDayIsCompleted).count
        plannedCount = adherence?.plannedDays ?? days.filter {
            techCoachDayIsCompleted($0) || ($0.planned && $0.kind != "rest")
        }.count
        unknownCount = adherence?.unknownDays ?? 0
        let sessionFraction = plannedCount > 0 ? Double(completedCount) / Double(plannedCount) : nil
        fraction = adherence?.volumeRatio ?? sessionFraction
    }
}

func techCoachDayIsCompleted(_ day: MobileWeekPlanDay) -> Bool {
    day.completedWorkoutId != nil || day.kind == "completed" || day.workoutCount > 0
}

func techCoachWeekDayTitle(_ day: MobileWeekPlanDay) -> String {
    if techCoachDayIsCompleted(day) { return "已完成" }
    return day.planned ? nativeSessionName(day.kind) : "未排课"
}

func techCoachRaceCountdown(raceDate: String?, todayLocalDate: String?, daysToRace: Int?) -> String? {
    guard let raceDate else { return nil }
    // The API clamps daysToRace to zero after the race; zero alone cannot mean "today".
    if let todayLocalDate, raceDate < todayLocalDate { return "比赛日已过" }
    guard let daysToRace else { return nil }
    return daysToRace < 0 ? "比赛日已过" : "距比赛 \(daysToRace) 天"
}

func techCoachCalibrationLabel(_ calibration: MobileCalibrationCard) -> String {
    calibration.status == "completed"
        ? "校准已完成"
        : "校准未完成（\(calibration.eligibleSessions)/\(calibration.requirements.sessions) 次）"
}

func techCoachCalibrationExplanation(_ calibration: MobileCalibrationCard?, weeklyBudgetKm: Double?) -> String? {
    guard let calibration, calibrationNeedsAttention(calibration.status) else { return nil }
    let opening = weeklyBudgetKm.map { "本周 \(nativeNumber($0, digits: 1)) km 是保守起步" } ?? "当前训练安排是保守起步"
    return "\(opening)，不是整个计划的全部内容：校准未完成时只排轻松训练，先把基础建立起来。"
}
