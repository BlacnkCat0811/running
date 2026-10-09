import Foundation

/// A workout the device can hand to the system workout scheduler.
///
/// Deliberately free of any WorkoutKit type: the SDK import lives in
/// `WorkoutKitBridge` so that these mapping rules stay compilable and testable
/// off-device. Everything the server sends is treated as untrusted input and is
/// re-bounded here — this is the device-side half of the trust boundary.
struct PlannedWorkout: Equatable {
    enum Goal: Equatable {
        case distance(meters: Double)
        case time(seconds: Double)
        case open
    }

    enum Alert: Equatable {
        case pace(lower: Double?, upper: Double?)
        case heartRate(lower: Double?, upper: Double?)
    }

    struct Step: Equatable {
        /// `warmup` | `work` | `recovery` | `cooldown`, carried through so the
        /// bridge can label an interval step without re-deriving intent.
        let purpose: String
        let goal: Goal
        let alert: Alert?

        var isRecovery: Bool { purpose == "recovery" }
    }

    struct Block: Equatable {
        let iterations: Int
        let steps: [Step]
    }

    let localDate: String
    let displayName: String
    let hour: Int
    let minute: Int
    let warmup: Step?
    let blocks: [Block]
    let cooldown: Step?
}

/// Speed bounds derived from a pace prescription. Kept separate from
/// `PlannedWorkout` because the conversion is the error-prone part and must stay
/// covered by the off-device regression test.
enum PaceBounds: Equatable {
    case range(lowerMetersPerSecond: Double, upperMetersPerSecond: Double)
    case threshold(metersPerSecond: Double)
}

enum WorkoutPlanMapper {
    struct MappingResult {
        enum Status: String { case exact, normalized, unsupported }
        let status: Status
        let reasonCode: String?
        let workout: PlannedWorkout?
        let exportedStructure: MobileSessionStructure?
        let differences: [String]
    }

    static func executionMapping(from day: MobileWorkoutPlanDay, hour: Int) -> MappingResult {
        guard ["easy", "recovery", "long_run", "tempo", "interval"].contains(day.kind), day.executable,
              let mapped = plannedWorkout(from: day, hour: hour),
              let exported = safeExportedStructure(mapped, original: day.structure) else {
            return .init(status: .unsupported, reasonCode: "required_prescription_not_lossless", workout: nil, exportedStructure: nil, differences: [])
        }
        let exact = exported == day.structure
        return .init(status: exact ? .exact : .normalized, reasonCode: nil, workout: mapped,
            exportedStructure: exported, differences: exact ? [] : ["target_bounds_reordered"])
    }
    /// Early enough that a morning runner can still see it before leaving.
    nonisolated static let defaultScheduleHour = 7
    /// When the nominal time has already passed, schedule this far ahead instead
    /// of silently dropping today's session.
    static let lateFloorSeconds: TimeInterval = 60
    static let maxBlocks = 8
    static let maxStepsPerBlock = 12
    static let maxIterations = 20
    static let maxStepMeters = 100_000.0
    static let maxStepSeconds = 14_400.0
    /// A pace bound slower than this is not a prescription, it is a malformed
    /// field — and it is *dropped*, not clamped: clamping a pace changes the
    /// intensity it asks for (a 2 000 s/km recovery jog pushed to 1 800 s/km is a
    /// faster workout than the athlete was told to run).
    static let maxPaceSecondsPerKm = 1_800.0
    /// Compatibility ceiling, not a physiological equivalence guarantee.
    /// Strict export rejects changed bounds rather than calling them "lossless".
    static let maxHeartRateBpm = 240.0

    /// Days the server cannot or should not sync are dropped here: rest days,
    /// days whose prescription failed to build, and days left with no usable
    /// step after filtering.
    static func plannedWorkouts(from plan: MobileWorkoutPlanResponse) -> [PlannedWorkout] {
        plannedWorkouts(from: plan, hour: defaultScheduleHour)
    }

    static func plannedWorkouts(
        from plan: MobileWorkoutPlanResponse,
        hour: Int,
        minute: Int = 0
    ) -> [PlannedWorkout] {
        plan.days.compactMap { plannedWorkout(from: $0, hour: hour, minute: minute) }
    }

    /// What one week has to offer the watch, and why the rest of it does not.
    ///
    /// A bare count cannot be explained, and each surface then invents its own
    /// reason: the panel told the runner to regenerate the week whenever the count
    /// was zero, including the case where the week was simply over or already run
    /// — which is not a shortfall and not something a new plan would fix. The
    /// classification therefore lives here, next to the rule that produces it, and
    /// every surface reads the same facts and only chooses its own wording.
    struct WeekOffer: Equatable {
        /// The days still owed: today or later, and not already trained. This is
        /// exactly what the bridge hands to the scheduler.
        let offered: [PlannedWorkout]
        /// Days the server prescribed that did not survive mapping (rest days,
        /// broken prescriptions), counted the way the sync's `skipped` is.
        let skipped: Int
        /// Days that survived mapping but are already over.
        let expired: Int
        /// Days still ahead that `/v1/mobile/today` reports as trained.
        let alreadyTrained: Int

        /// True when the week held something sendable and none of it is still owed.
        ///
        /// Distinct from "nothing was prescribed": both leave `offered` empty, and
        /// only this one means there is nothing left to do rather than nothing to
        /// send.
        var isExhausted: Bool {
            offered.isEmpty && expired + alreadyTrained > 0
        }

        /// The line for a week that had nothing usable in it.
        ///
        /// Named rather than inlined because it is also what the panel falls back
        /// to when there is no plan at all to classify: one string, so the two
        /// renderings of "this week has nothing to send" cannot drift apart.
        static let unusableWeekMessage = "未来7日窗口没有可上表的训练日，预览并确认新的课表再同步。"

        /// The panel's line when the week offers nothing.
        ///
        /// Regenerating the week is advice worth giving only when the week had
        /// nothing usable in it; when everything was run or has passed, a new plan
        /// would not change the fact that this one is done, and saying so is the
        /// whole point of telling the two apart.
        var emptyOfferMessage: String {
            isExhausted
                ? "当前窗口日期均已记录训练或已过去，不需要再上表。"
                : Self.unusableWeekMessage
        }
    }

    /// The week's offer, classified.
    static func weekOffer(
        in plan: MobileWorkoutPlanResponse,
        now: Date,
        completedLocalDates: Set<String>,
        hour: Int = defaultScheduleHour,
        minute: Int = 0
    ) -> WeekOffer {
        let executable = plannedWorkouts(from: plan, hour: hour, minute: minute)
        let timeZone = resolvedTimeZone(for: plan)
        let offered = owed(
            executable,
            now: now,
            timeZone: timeZone,
            completedLocalDates: completedLocalDates
        )
        let ahead = upcoming(executable, now: now, timeZone: timeZone)
        return WeekOffer(
            offered: offered,
            skipped: plan.days.count - executable.count,
            expired: executable.count - ahead.count,
            alreadyTrained: ahead.count - offered.count
        )
    }

    /// How many days of the week the watch will actually be offered.
    ///
    /// The count the UI shows has to come from the same rule the bridge schedules
    /// by, otherwise a week can read "5 项可上表" while the watch receives four —
    /// the panel used to count the server's `executable` flag, which is a
    /// different (looser) question than "did this day survive mapping". Days that
    /// are no longer owed (over, or already trained) are not offered, so they are
    /// not counted here either.
    static func schedulableCount(
        in plan: MobileWorkoutPlanResponse,
        now: Date,
        completedLocalDates: Set<String>,
        hour: Int = defaultScheduleHour,
        minute: Int = 0
    ) -> Int {
        weekOffer(
            in: plan,
            now: now,
            completedLocalDates: completedLocalDates,
            hour: hour,
            minute: minute
        ).offered.count
    }

    /// The plan's own timezone, or the device's when the payload carried no usable
    /// one. One rule, so the count the panel prints and the instant the bridge
    /// schedules cannot disagree about which day "today" is.
    static func resolvedTimeZone(for plan: MobileWorkoutPlanResponse) -> TimeZone {
        TimeZone(identifier: plan.timezone) ?? .current
    }

    /// The days this sync can still act on: today, and whatever is left of the week.
    ///
    /// A day that is already over cannot be trained, so handing it to the scheduler
    /// would only put a prescription dated in the past on the watch — and a past slot
    /// gets pushed onto `now` (see `scheduleComponents`), so every past day in the
    /// week would arrive wearing *today's* date. That date is what a sync receipt is
    /// matched on, which is how a day the watch never saw collects a receipt.
    /// Order is preserved.
    ///
    /// A `localDate` this cannot read is kept rather than dropped: `scheduleComponents`
    /// refuses it further down, which is where an unreadable date already becomes a
    /// counted skip instead of a silent omission.
    static func upcoming(
        _ workouts: [PlannedWorkout],
        now: Date,
        timeZone: TimeZone
    ) -> [PlannedWorkout] {
        let today = civilDate(of: now, in: timeZone)
        return workouts.filter { workout in
            guard let day = civilDate(from: workout.localDate) else { return true }
            return (day.year, day.month, day.day) >= (today.year, today.month, today.day)
        }
    }

    /// The days the watch is still *owed*: today or later, and not already trained.
    ///
    /// Both exclusions are needed and neither implies the other — a day can be over
    /// without having been trained, and today can already have been trained. This is
    /// the rule the panel has always stated in words ("已记录训练的日期不会重复下发");
    /// `completedLocalDates` comes from `/v1/mobile/today`, which is the only side
    /// that knows a day was actually run.
    static func owed(
        _ workouts: [PlannedWorkout],
        now: Date,
        timeZone: TimeZone,
        completedLocalDates: Set<String>
    ) -> [PlannedWorkout] {
        upcoming(workouts, now: now, timeZone: timeZone)
            .filter { !completedLocalDates.contains($0.localDate) }
    }

    static func plannedWorkout(
        from day: MobileWorkoutPlanDay,
        hour: Int = WorkoutPlanMapper.defaultScheduleHour,
        minute: Int = 0
    ) -> PlannedWorkout? {
        guard day.executable, day.kind != "rest", let structure = day.structure else { return nil }
        // Keep calls inside closures inheriting this context's actor isolation.
        // Passing an isolated method directly as a transform can lose that
        // isolation under the app's default MainActor build setting.
        let blocks = structure.blocks.prefix(maxBlocks).compactMap { block(from: $0) }
        // WorkoutKit requires at least one block, and a workout whose every step
        // is "just run" is an empty shell rather than a prescription.
        guard !blocks.isEmpty, blocks.contains(where: { block in block.steps.contains(where: \.hasTarget) }) else {
            return nil
        }
        return PlannedWorkout(
            localDate: day.localDate,
            displayName: displayName(for: day),
            hour: min(23, max(0, hour)),
            minute: min(59, max(0, minute)),
            warmup: structure.warmup.flatMap { step(from: $0) },
            blocks: blocks,
            cooldown: structure.cooldown.flatMap { step(from: $0) }
        )
    }

    /// Execution uses this strict boundary in addition to the tolerant display
    /// mapper. Never truncate required steps, clamp dose, or silently discard a
    /// required target and then claim the original prescription was exported.
    static func safeExportedStructure(_ mapped: PlannedWorkout, original: MobileSessionStructure?) -> MobileSessionStructure? {
        func step(_ value: PlannedWorkout.Step) -> MobileWorkoutStep {
            let goal: MobileStepGoal
            switch value.goal {
            case let .distance(meters): goal = .distance(meters: meters)
            case let .time(seconds): goal = .time(seconds: seconds)
            case .open: goal = .open
            }
            let alert: MobileStepAlert?
            switch value.alert {
            case let .pace(lower, upper): alert = .init(kind: "pace", lower: lower, upper: upper)
            case let .heartRate(lower, upper): alert = .init(kind: "heart_rate", lower: lower, upper: upper)
            case nil: alert = nil
            }
            return .init(purpose: value.purpose, goal: goal, alert: alert)
        }
        let exported = MobileSessionStructure(warmup: mapped.warmup.map { step($0) },
            blocks: mapped.blocks.map { .init(iterations: $0.iterations, steps: $0.steps.map { step($0) }) },
            cooldown: mapped.cooldown.map { step($0) })
        guard let original, original.blocks.count == exported.blocks.count else { return nil }
        func equalDose(_ raw: MobileWorkoutStep?, _ actual: MobileWorkoutStep?) -> Bool {
            guard let raw else { return actual == nil }
            guard let actual, raw.goal == actual.goal, raw.purpose == actual.purpose,
                  ["warmup", "work", "recovery", "cooldown"].contains(raw.purpose) else { return false }
            // The receipt reader normalizes dose to whole metres/seconds.
            // Refuse a compatibility payload that would export a different dose
            // than the server can preserve, rather than silently rounding it.
            switch raw.goal {
            case let .distance(meters):
                guard meters >= 1, meters.rounded() == meters else { return false }
            case let .time(seconds):
                guard seconds >= 1, seconds.rounded() == seconds else { return false }
            case .open: break
            }
            if let alert = raw.alert {
                guard let sent = actual.alert, alert.kind == sent.kind,
                      ["pace", "heart_rate"].contains(alert.kind), alert.lower != nil, alert.upper != nil,
                      alert.lower?.rounded() == alert.lower, alert.upper?.rounded() == alert.upper,
                      alert.kind != "pace" || [alert.lower!, alert.upper!].allSatisfy({ (120...1200).contains($0) }),
                      alert.lower?.isFinite != false, alert.upper?.isFinite != false,
                      (alert.lower == nil) == (sent.lower == nil), (alert.upper == nil) == (sent.upper == nil) else { return false }
                let normalized = ordered(lower: alert.lower, upper: alert.upper)
                guard normalized.0 == sent.lower, normalized.1 == sent.upper else { return false }
            } else if actual.alert != nil { return false }
            return true
        }
        guard equalDose(original.warmup, exported.warmup), equalDose(original.cooldown, exported.cooldown) else { return nil }
        for (raw, actual) in zip(original.blocks, exported.blocks) {
            guard raw.iterations == actual.iterations, raw.steps.count == actual.steps.count,
                  zip(raw.steps, actual.steps).allSatisfy({ equalDose($0, $1) }) else { return nil }
        }
        return exported
    }

    /// The instant the session should appear on the watch. A nominal time that
    /// already passed is pushed just far enough ahead that *today's* session stays
    /// schedulable; a day that is already over keeps its own date and hour, and a
    /// malformed date yields nil.
    ///
    /// Returns `DateComponents` because that is what `WorkoutScheduler.schedule`
    /// accepts — a `Date` would have to be converted back anyway.
    static func scheduleComponents(
        for workout: PlannedWorkout,
        timeZone: TimeZone,
        now: Date
    ) -> DateComponents? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = workout.localDate.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1970...9999).contains(year), (1...12).contains(month), (1...31).contains(day) else {
            return nil
        }
        var components = DateComponents()
        components.timeZone = timeZone
        components.year = year
        components.month = month
        components.day = day
        components.hour = workout.hour
        components.minute = workout.minute
        components.second = 0
        guard let planned = calendar.date(from: components) else { return nil }
        // `Calendar.date(from:)` is lenient: it rolls "2026-02-30" forward into
        // March instead of failing, which would put a session on a day nobody
        // asked for. Read the date back and require the calendar to agree.
        let resolved = calendar.dateComponents([.year, .month, .day], from: planned)
        guard resolved.year == year, resolved.month == month, resolved.day == day else { return nil }
        guard planned <= now else { return components }
        // Only a slot *on today* is pushed ahead. Rolling a day that is already over
        // onto `now` would hand last Monday's prescription today's calendar day, and
        // the calendar day is what a sync receipt is matched on — so every past day
        // in the week would collapse onto one date and collect the receipt for
        // whichever of them did land.
        guard calendar.isDate(planned, inSameDayAs: now) else { return components }
        let rolled = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: now.addingTimeInterval(lateFloorSeconds))
        var adjusted = DateComponents()
        adjusted.timeZone = timeZone
        adjusted.year = rolled.year
        adjusted.month = rolled.month
        adjusted.day = rolled.day
        adjusted.hour = rolled.hour
        adjusted.minute = rolled.minute
        // Always on a whole minute, like the future path: `lateFloorSeconds` is
        // larger than the seconds it can drop, so the result stays strictly ahead
        // of `now` while the two paths agree on what "scheduled at" looks like.
        adjusted.second = 0
        return adjusted
    }

    /// Converts a pace prescription into speed bounds.
    ///
    /// RAI stores seconds per kilometre, where a *smaller* number is faster;
    /// WorkoutKit expects speed, so the bounds invert — the pace floor becomes
    /// the speed ceiling. Getting this backwards would silently prescribe the
    /// opposite intensity, which is why it lives in tested code.
    static func paceBounds(lower: Double?, upper: Double?) -> PaceBounds? {
        guard ![lower, upper].contains(where: { value in
            guard let value else { return false }
            return !value.isFinite || value < 120
        }) else { return nil }
        let lowerPace = boundedPace(lower)
        let upperPace = boundedPace(upper)
        if let lowerPace, let upperPace {
            // The slower pace maps to the lower speed, the faster pace to the
            // upper speed, so the resulting range is always ascending.
            let slowest = 1_000 / max(lowerPace, upperPace)
            let fastest = 1_000 / min(lowerPace, upperPace)
            guard slowest > 0, fastest >= slowest else { return nil }
            return .range(lowerMetersPerSecond: slowest, upperMetersPerSecond: fastest)
        }
        guard let single = lowerPace ?? upperPace else { return nil }
        return .threshold(metersPerSecond: 1_000 / single)
    }

    /// Short human summary of a prescription, e.g. `6 × 800m` or `3 × 8分`.
    /// Empty when there is nothing worth showing.
    static func structureSummary(_ structure: MobileSessionStructure?) -> String {
        guard let structure, let block = structure.blocks.first else { return "" }
        let work = block.steps.first { $0.purpose == "work" } ?? block.steps.first
        guard let work else { return "" }
        let sets = max(1, block.iterations)
        switch work.goal {
        case let .distance(meters):
            let text = meters >= 1_000
                ? String(format: "%.1fkm", meters / 1_000)
                : String(format: "%.0fm", meters)
            return "\(sets) × \(text)"
        case let .time(seconds):
            let text = seconds >= 60
                ? String(format: "%.0f分", seconds / 60)
                : String(format: "%.0f秒", seconds)
            return "\(sets) × \(text)"
        case .open:
            return "\(sets) 组"
        }
    }

    /// Status word for one day of the seven-day strip (the `/today` payload).
    ///
    /// Both skins had their own copy of this rule — identical line for line except
    /// for the colour each pairs it with — which is the same drift `inactiveLabel`
    /// exists to prevent. The word is a statement about the data; only its colour
    /// is a skin decision. Kept here, next to the other week/day judgment, so the
    /// off-device regression can pin it.
    static func weekStripStatus(completed: Bool, isRest: Bool, isToday: Bool) -> String {
        if completed { return "已记录训练" }
        if isRest { return "休息日" }
        return isToday ? "今日安排" : "计划中"
    }

    /// Why a row of the week is not offered to the watch, or nil when it is.
    ///
    /// Every label is derived from the same predicate the bridge schedules by
    /// (`plannedWorkout(from:)`), so a row can never be shown as offered while the
    /// watch silently receives nothing — which is what the server's `executable`
    /// flag on its own allowed (an executable day whose structure is missing or
    /// whose steps all lack a target does not survive mapping).
    ///
    /// The week panel dims the rows the watch will not receive and still prints
    /// their distance, which left a finished day reading as «周四 轻松跑 5.0km»
    /// at 60% opacity — the prescription that was *not* run, with nothing saying
    /// so. `unofferedDays` turns these labels into the panel's one line; the seven
    /// day strip has its own vocabulary (`weekStripStatus`), because it describes
    /// what was run rather than what was handed over.
    ///
    /// `completedLocalDates` comes from `/v1/mobile/today`, which is the only
    /// side that knows the day was actually trained.
    static func inactiveLabel(for day: MobileWorkoutPlanDay, completedLocalDates: Set<String>) -> String? {
        switch eligibility(for: day, completedLocalDates: completedLocalDates) {
        case .scheduled: return nil
        case .completed: return "已记录训练"
        case .rest: return "休息"
        case .noPrescription: return "不可上表"
        }
    }

    /// What the watch will do with one day of the week.
    enum WatchEligibility: Equatable {
        /// The day survives mapping and is handed to the scheduler.
        case scheduled
        /// `/today` says the day was trained; it is not owed any more.
        case completed
        case rest
        /// The server offered the day but nothing usable came out of it.
        case noPrescription
    }

    static func eligibility(
        for day: MobileWorkoutPlanDay,
        completedLocalDates: Set<String>
    ) -> WatchEligibility {
        if completedLocalDates.contains(day.localDate) { return .completed }
        if plannedWorkout(from: day) != nil { return .scheduled }
        if day.kind == "rest" { return .rest }
        return .noPrescription
    }

    /// The days of the week the watch will *not* receive, with the reason.
    ///
    /// Rest days are excluded: they are the schedule, not a shortfall. What is
    /// left is the surprising case — the server offered a training day and the
    /// device cannot use it — and the panel says so instead of quietly showing a
    /// smaller number than the week suggests.
    static func unofferedDays(
        in plan: MobileWorkoutPlanResponse,
        completedLocalDates: Set<String>
    ) -> [(localDate: String, reason: String)] {
        plan.days.compactMap { day in
            guard eligibility(for: day, completedLocalDates: completedLocalDates) == .noPrescription,
                  let reason = inactiveLabel(for: day, completedLocalDates: completedLocalDates) else { return nil }
            return (day.localDate, reason)
        }
    }

    // MARK: - Private

    /// The calendar day an instant falls on, in `timeZone`.
    private static func civilDate(of instant: Date, in timeZone: TimeZone) -> (year: Int, month: Int, day: Int) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: instant)
        return (parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// The day a `YYYY-MM-DD` string names, or nil when it names none. Read field by
    /// field: the value is already a civil date in the plan's timezone, and putting a
    /// `Calendar` back in the way would reintroduce a timezone it does not have.
    private static func civilDate(from localDate: String) -> (year: Int, month: Int, day: Int)? {
        let parts = localDate.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else { return nil }
        return (year, month, day)
    }

    private static func boundedPace(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value > 0 else { return nil }
        return min(86_400, value)
    }

    private static func displayName(for day: MobileWorkoutPlanDay) -> String {
        let title = day.title.isEmpty ? "训练" : day.title
        guard let distance = day.distanceKm, distance > 0 else { return "RAI · \(title)" }
        return "RAI · \(title) \(String(format: "%.1f", distance))km"
    }

    private static func block(from raw: MobileIntervalBlock) -> PlannedWorkout.Block? {
        let steps = raw.steps.prefix(maxStepsPerBlock).compactMap { step(from: $0) }
        guard !steps.isEmpty else { return nil }
        return PlannedWorkout.Block(iterations: min(maxIterations, max(1, raw.iterations)), steps: steps)
    }

    private static func step(from raw: MobileWorkoutStep) -> PlannedWorkout.Step? {
        guard let goal = goal(from: raw.goal) else { return nil }
        return PlannedWorkout.Step(purpose: raw.purpose, goal: goal, alert: alert(from: raw.alert))
    }

    private static func goal(from raw: MobileStepGoal) -> PlannedWorkout.Goal? {
        switch raw {
        case let .distance(meters):
            guard meters.isFinite, meters > 0 else { return nil }
            return .distance(meters: min(maxStepMeters, meters))
        case let .time(seconds):
            guard seconds.isFinite, seconds > 0 else { return nil }
            return .time(seconds: min(maxStepSeconds, seconds))
        case .open:
            return .open
        }
    }

    /// Returns nil rather than an alert with no bound: a step whose alert
    /// carries no target cannot be scheduled, and dropping the alert is better
    /// than dropping the whole workout.
    private static func alert(from raw: MobileStepAlert?) -> PlannedWorkout.Alert? {
        guard let raw, raw.isUsable else { return nil }
        switch raw.kind {
        case "pace":
            guard ![raw.lower, raw.upper].contains(where: { value in
                guard let value else { return false }
                return !value.isFinite || value < 120
            }) else { return nil }
            let (lower, upper) = ordered(lower: paceBound(raw.lower), upper: paceBound(raw.upper))
            guard lower != nil || upper != nil else { return nil }
            return .pace(lower: lower, upper: upper)
        case "heart_rate":
            let (lower, upper) = ordered(lower: heartRateBound(raw.lower), upper: heartRateBound(raw.upper))
            guard lower != nil || upper != nil else { return nil }
            return .heartRate(lower: lower, upper: upper)
        default:
            return nil
        }
    }

    private static func ordered(lower: Double?, upper: Double?) -> (Double?, Double?) {
        guard let lower, let upper, lower > upper else { return (lower, upper) }
        return (upper, lower)
    }

    /// Keeps a usable pace bound or drops it. Never clamps: see
    /// `maxPaceSecondsPerKm`.
    private static func paceBound(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value > 0, value <= maxPaceSecondsPerKm else { return nil }
        return value
    }

    /// Keeps a usable heart-rate bound, clamping an impossible ceiling.
    private static func heartRateBound(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value > 0 else { return nil }
        return min(maxHeartRateBpm, value)
    }
}

private extension PlannedWorkout.Step {
    /// True when the goal is an actual target rather than "just run".
    var hasTarget: Bool {
        switch goal {
        case let .distance(meters): return meters > 0
        case let .time(seconds): return seconds > 0
        case .open: return false
        }
    }
}
