#if os(iOS)
import Foundation
import HealthKit
import WorkoutKit

/// Hands a mapped plan to the system workout scheduler.
///
/// This is the only place in the app that touches WorkoutKit, and it never
/// writes to HealthKit: scheduling a workout is Apple's official channel for
/// getting a prescription onto the watch, and it is a separate authorization
/// from health data access.
///
/// `WorkoutScheduler.schedule(_:at:)` is `async` but **non-throwing**, so a call
/// that silently does nothing looks identical to success. Every sync therefore
/// reads `scheduledWorkouts` back and compares, rather than trusting the call.
@available(iOS 17.0, *)
enum WorkoutKitBridge {
    /// Result of a sync, deliberately free of WorkoutKit types so the view layer
    /// never has to import the SDK.
    struct SyncOutcome: Equatable {
        var scheduled: Int
        var attempted: Int
        var skipped: Int
        var authorized: Bool
        var verified: Bool
        /// True when this device cannot schedule workouts at all (Simulator, or an
        /// iPhone with no paired Apple Watch). Kept apart from `authorized` because
        /// the remedy differs: such a device never becomes schedulable, so telling
        /// the runner to grant permission sends them down a dead end.
        var deviceUnsupported = false
        /// Scheduler authorization state as a plain string, because
        /// `WorkoutScheduler.AuthorizationState` is a WorkoutKit type and the view
        /// layer must not import the SDK. Carried into `summary` so a refused sync
        /// says *what* is blocking it instead of one catch-all sentence.
        var authorizationState: String?
        /// True when the plan did not carry a usable timezone and the device's own
        /// was used instead. Worth saying out loud: the scheduled instant, and with
        /// it the "already passed" test, then depends on where the phone is.
        var timeZoneFallback = false
        /// How many days survived mapping (`plannedWorkouts`), whether or not they
        /// could be built into a workout. Lets `summary` tell "nothing to send"
        /// apart from "everything that was sendable failed to build". Counts only the
        /// days still ahead, i.e. what this sync actually offered.
        var offered = 0
        /// Days of the week that were prescribed but are already over, so this sync
        /// left them alone. Named separately instead of folded into `skipped`: they are
        /// not a shortfall, and counting them as skipped made the panel read like a
        /// failed sync every day after the plan was generated.
        var expired = 0
        /// Days still ahead that `/v1/mobile/today` already reports as trained. Also
        /// not a shortfall — and re-sending one is what the panel's own sentence
        /// ("已记录训练的日期不会重复下发") promises will not happen.
        var alreadyTrained = 0
        /// The local dates that were read back from the scheduler, i.e. the days
        /// this sync can honestly claim the watch received.
        ///
        /// Carried out of here because nothing else can compute it: mapping,
        /// `maxScheduledWorkoutCount` truncation and the scheduler's own
        /// `supportsGoal`/`supportsAlert` checks all happen in this file, so a
        /// caller re-deriving "which days went to the watch" would keep reporting
        /// days that were dropped on the way. The receipt is what lets a later run
        /// be matched to its prescription, so a receipt for a day the watch never
        /// saw is worse than no receipt.
        var scheduledLocalDates: [String] = []

        static let unsupportedDevice = SyncOutcome(
            scheduled: 0,
            attempted: 0,
            skipped: 0,
            authorized: false,
            verified: false,
            deviceUnsupported: true
        )

        var summary: String {
            if deviceUnsupported {
                return "此设备无法把课表排到「体能训练」：需要 iPhone 已配对 Apple Watch（模拟器不支持排期）。"
            }
            if !authorized {
                switch authorizationState {
                case "denied":
                    return "排期授权已被拒绝。健康面板里没有对应开关，需删除 App 重装，"
                        + "或走 设置 → 通用 → 传输或还原 iPhone → 还原 → 还原位置与隐私。"
                case "notDetermined":
                    return "授权请求未送达，系统没有弹出授权框。"
                case "restricted":
                    return "系统限制了 RAI 的排期授权（屏幕使用时间/家长控制）。"
                default:
                    return "需要先允许 RAI 使用体能训练计划。"
                }
            }
            if attempted == 0 {
                // `attempted == 0` has two very different causes and the runner can
                // act on only one of them: nothing was prescribed, or something was
                // prescribed and the device could not turn it into a workout.
                // Saying "本周没有可同步的训练" for the second reads as "you have a
                // rest week" while the week actually held sessions.
                guard offered > 0 else {
                    return expired + alreadyTrained > 0
                        ? "本周没有还需要上表的训练。"
                        : "本周没有可同步的训练（休息日与无效课表不会上表）。"
                }
                return "本周有 \(offered) 天可上表，但没有一天能建成手表上的训练。请重新生成课表。" + notOwedNote
            }
            guard verified else {
                return "已提交 \(attempted) 项，但系统未回读确认\(notOwedNote)。请在手表「体能训练」中确认。"
            }
            if skipped > 0 { return "系统日程已核验 \(scheduled) 项，跳过 \(skipped) 项。请在手表上确认可见。" + notOwedNote }
            return "系统训练日程已核验 \(scheduled) 项；请在手表「体能训练」中确认可见。" + notOwedNote
        }

        /// Days of the week that were prescribed but are not owed any more.
        ///
        /// Named rather than left out: they are why a count can read below the length
        /// of the week, and a runner who cannot see that reads it as days that failed
        /// to sync. Neither kind is a shortfall, so neither is part of `skipped`.
        private var notOwedNote: String {
            var reasons: [String] = []
            if expired > 0 { reasons.append("\(expired) 天已过去") }
            if alreadyTrained > 0 { reasons.append("\(alreadyTrained) 天已记录训练") }
            guard !reasons.isEmpty else { return "" }
            return "（" + reasons.joined(separator: "、") + "，不再排期）"
        }

        /// The one line the panel shows, warnings included.
        var report: String {
            guard timeZoneFallback else { return summary }
            return "\(summary)（课表未带时区，已按手机当前时区排期）"
        }
    }

    static var isSupported: Bool { WorkoutScheduler.isSupported }

    static var maxScheduledWorkoutCount: Int { WorkoutScheduler.maxAllowedScheduledWorkoutCount }

    static func isAuthorized() async -> Bool {
        await WorkoutScheduler.shared.authorizationState == .authorized
    }

    /// Flattens the scheduler's state into a string so callers keep the SDK out of
    /// their own types. The values are matched in `SyncOutcome.summary`.
    static func describe(_ state: WorkoutScheduler.AuthorizationState) -> String {
        switch state {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        @unknown default: return "unknown"
        }
    }

    /// Returns true once RAI is allowed to schedule workouts.
    @discardableResult
    static func requestAuthorization() async -> Bool {
        await WorkoutScheduler.shared.requestAuthorization() == .authorized
    }

    /// Runs the whole sync flow: try, ask once if the scheduler has not decided,
    /// then retry.
    ///
    /// Kept in the bridge rather than repeated in both skin views — the ask step
    /// must not run on a device that cannot schedule at all, and that condition
    /// belongs next to the support check, not in the UI.
    @MainActor static func syncRequestingAuthorization(
        plan: MobileWorkoutPlanResponse,
        completedLocalDates: Set<String>,
        isCurrent: @escaping @MainActor () -> Bool = { true }
    ) async -> SyncOutcome {
        let outcome = await sync(plan: plan, completedLocalDates: completedLocalDates, isCurrent: isCurrent)
        guard !outcome.authorized, !outcome.deviceUnsupported else { return outcome }
        guard isCurrent(), await requestAuthorization(), isCurrent() else { return outcome }
        return await sync(plan: plan, completedLocalDates: completedLocalDates, isCurrent: isCurrent)
    }

    /// Replaces everything RAI previously scheduled.
    ///
    /// Refreshing means the week may have changed, and a stale prescription on
    /// the watch is worse than none — the runner would follow a session that the
    /// gate has since withdrawn.
    @MainActor static func sync(
        plan: MobileWorkoutPlanResponse,
        now: Date = Date(),
        completedLocalDates: Set<String>,
        isCurrent: @escaping @MainActor () -> Bool = { true }
    ) async -> SyncOutcome {
        // Order matters: an unsupported device reports neither a prompt nor an
        // authorization, so support is checked first to keep the two causes apart.
        guard isSupported else { return .unsupportedDevice }
        let state = await WorkoutScheduler.shared.authorizationState
        guard state == .authorized else {
            return SyncOutcome(
                scheduled: 0,
                attempted: 0,
                skipped: 0,
                authorized: false,
                verified: false,
                authorizationState: describe(state)
            )
        }
        let timeZone = TimeZone(identifier: plan.timezone)
        let resolvedTimeZone = WorkoutPlanMapper.resolvedTimeZone(for: plan)
        // Only the days the watch is still *owed* are offered: today or later, and not
        // already trained. A day that is already over cannot be trained and a day that
        // has been trained is not owed again, so scheduling either would only put a
        // stale prescription on the watch — and, because a past slot is pushed onto
        // `now`, a past day would arrive dated today, which is the date a receipt is
        // matched on. Counted rather than silently dropped, so the panel can say why
        // the number is below the length of the week.
        // The rule itself lives in the mapper, because the panel prints a count and a
        // sentence about the very same set and the two must not drift apart — reading
        // it from one place is what keeps "N 项可上表" and "why not more" consistent.
        let offer = WorkoutPlanMapper.weekOffer(
            in: plan,
            now: now,
            completedLocalDates: completedLocalDates
        )
        let offered = offer.offered
        let skipped = offer.skipped
        let expired = offer.expired
        let alreadyTrained = offer.alreadyTrained
        let cancelled = SyncOutcome(scheduled: 0, attempted: 0, skipped: skipped, authorized: true, verified: false)
        guard isCurrent() else { return cancelled }
        guard !offered.isEmpty else {
            await WorkoutScheduler.shared.removeAllWorkouts()
            // Clearing is as silent as scheduling when it fails, and the failure
            // that matters here is the opposite one: a withdrawal that did not
            // land leaves a prescription on the watch the gate has already pulled.
            let remaining = await WorkoutScheduler.shared.scheduledWorkouts.count
            let current = isCurrent()
            return SyncOutcome(
                scheduled: 0,
                attempted: 0,
                skipped: skipped,
                authorized: true,
                verified: remaining == 0 && current,
                timeZoneFallback: timeZone == nil,
                offered: 0,
                expired: expired,
                alreadyTrained: alreadyTrained
            )
        }

        var pending: [PendingWorkout] = []
        for mapped in offered.prefix(maxScheduledWorkoutCount) {
            guard let at = WorkoutPlanMapper.scheduleComponents(for: mapped, timeZone: resolvedTimeZone, now: now),
                  let custom = customWorkout(from: mapped) else { continue }
            pending.append(PendingWorkout(
                custom: custom,
                plan: WorkoutPlan(.custom(custom)),
                at: at,
                localDate: mapped.localDate
            ))
        }
        guard !pending.isEmpty else {
            return SyncOutcome(
                scheduled: 0,
                attempted: 0,
                skipped: skipped,
                authorized: true,
                verified: false,
                timeZoneFallback: timeZone == nil,
                offered: offered.count,
                expired: expired,
                alreadyTrained: alreadyTrained
            )
        }

        guard isCurrent() else { return cancelled }
        await WorkoutScheduler.shared.removeAllWorkouts()
        for item in pending {
            guard isCurrent() else { return cancelled }
            await WorkoutScheduler.shared.schedule(item.plan, at: item.at)
        }
        guard isCurrent() else { return cancelled }

        // Read back: the scheduler reports no error, so the only proof that the
        // week actually landed is that it is now listed.
        //
        // Matching is *by date*, not by content: a listed entry carries the `at` it
        // was scheduled for, so it names its own day. Content matching would hand
        // the receipt for a day the watch never saw to the day whose `schedule`
        // silently failed, whenever two days prescribed the same workout. The rule
        // lives in `PlanReceiptMatcher` so the macOS regression can pin it.
        let listed = await WorkoutScheduler.shared.scheduledWorkouts
        let confirmed: [String]
        if let byDate = PlanReceiptMatcher.confirm(
            pending: pending.map { PlanReceiptMatcher.PendingDay(localDate: $0.localDate, at: $0.at) },
            listed: listed.map(\.date),
            timeZone: resolvedTimeZone
        ) {
            confirmed = byDate
        } else {
            // No listed entry carried a readable date, so there is nothing to
            // match on by date. Not reachable while `ScheduledWorkoutPlan.date`
            // is non-optional; kept so a future OS dropping the field degrades to
            // the previous behaviour instead of reporting an empty receipt.
            var unmatched = listed.map(\.plan.workout)
            confirmed = pending.compactMap { item in
                guard let index = unmatched.firstIndex(of: .custom(item.custom)) else { return nil }
                unmatched.remove(at: index)
                return item.localDate
            }
        }
        let dropped = skipped + (offered.count - pending.count) + (pending.count - confirmed.count)
        return SyncOutcome(
            scheduled: confirmed.count,
            attempted: pending.count,
            skipped: dropped,
            authorized: true,
            verified: confirmed.count == pending.count,
            timeZoneFallback: timeZone == nil,
            offered: offered.count,
            expired: expired,
            alreadyTrained: alreadyTrained,
            scheduledLocalDates: confirmed
        )
    }

    private struct PendingWorkout {
        let custom: CustomWorkout
        let plan: WorkoutPlan
        let at: DateComponents
        /// Kept for the receipt: the day this workout stands for.
        let localDate: String
    }

    /// Numbers are checked by `CustomWorkout.supportsGoal` / `supportsAlert`
    /// before scheduling, so an unsupported combination is dropped here with a
    /// countable skip rather than silently rejected by the system.
    private static func customWorkout(from mapped: PlannedWorkout) -> CustomWorkout? {
        let activity = HKWorkoutActivityType.running
        let location = HKWorkoutSessionLocationType.outdoor
        let blocks = mapped.blocks.compactMap { block -> IntervalBlock? in
            let steps = block.steps.compactMap { step -> IntervalStep? in
                guard let workoutStep = workoutStep(from: step, activity: activity, location: location) else {
                    return nil
                }
                return IntervalStep(step.isRecovery ? .recovery : .work, step: workoutStep)
            }
            guard !steps.isEmpty else { return nil }
            return IntervalBlock(steps: steps, iterations: block.iterations)
        }
        guard !blocks.isEmpty else { return nil }
        var warmup: WorkoutStep?
        if let mappedWarmup = mapped.warmup {
            warmup = workoutStep(from: mappedWarmup, activity: activity, location: location)
        }
        var cooldown: WorkoutStep?
        if let mappedCooldown = mapped.cooldown {
            cooldown = workoutStep(from: mappedCooldown, activity: activity, location: location)
        }
        return CustomWorkout(
            activity: activity,
            location: location,
            displayName: mapped.displayName,
            warmup: warmup,
            blocks: blocks,
            cooldown: cooldown
        )
    }

    private static func workoutStep(
        from mapped: PlannedWorkout.Step,
        activity: HKWorkoutActivityType,
        location: HKWorkoutSessionLocationType
    ) -> WorkoutStep? {
        let goal: WorkoutGoal
        switch mapped.goal {
        case let .distance(meters):
            goal = .distance(meters, .meters)
        case let .time(seconds):
            goal = .time(seconds, .seconds)
        case .open:
            goal = .open
        }
        guard CustomWorkout.supportsGoal(goal, activity: activity, location: location) else { return nil }
        var alert: (any WorkoutAlert)?
        if let mappedAlert = mapped.alert {
            alert = workoutAlert(from: mappedAlert, activity: activity, location: location)
        }
        return WorkoutStep(goal: goal, alert: alert)
    }

    private static func workoutAlert(
        from mapped: PlannedWorkout.Alert,
        activity: HKWorkoutActivityType,
        location: HKWorkoutSessionLocationType
    ) -> (any WorkoutAlert)? {
        var alert: (any WorkoutAlert)?
        switch mapped {
        case let .pace(lower, upper):
            alert = paceAlert(lower: lower, upper: upper)
        case let .heartRate(lower, upper):
            // WorkoutKit has no single-sided heart-rate alert, and a degenerate
            // one-point range would misrepresent the prescription, so a
            // half-specified HR target is dropped instead of guessed.
            if let lower, let upper {
                // Beats per minute is the factory default unit.
                alert = HeartRateRangeAlert.heartRate(lower...upper)
            }
        }
        guard let alert, CustomWorkout.supportsAlert(alert, activity: activity, location: location) else {
            return nil
        }
        return alert
    }

    /// Turns the mapper's (fully tested) speed bounds into a WorkoutKit alert.
    private static func paceAlert(lower: Double?, upper: Double?) -> (any WorkoutAlert)? {
        switch WorkoutPlanMapper.paceBounds(lower: lower, upper: upper) {
        case let .range(lowerSpeed, upperSpeed):
            return SpeedRangeAlert.speed(lowerSpeed...upperSpeed, unit: .metersPerSecond)
        case let .threshold(speed):
            return SpeedThresholdAlert.speed(speed, unit: .metersPerSecond)
        case nil:
            return nil
        }
    }
}
#endif
