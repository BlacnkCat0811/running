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

        static let needsAuthorization = SyncOutcome(
            scheduled: 0,
            attempted: 0,
            skipped: 0,
            authorized: false,
            verified: false
        )

        var summary: String {
            if !authorized { return "需要先允许 RAI 使用体能训练计划。" }
            if attempted == 0 { return "本周没有可同步的训练（休息日与无效课表不会上表）。" }
            guard verified else { return "已提交 \(attempted) 项，但系统未回读确认。请在手表「体能训练」中确认。" }
            if skipped > 0 { return "已同步 \(scheduled) 项，跳过 \(skipped) 项。" }
            return "已同步 \(scheduled) 项到「体能训练」。"
        }
    }

    static var isSupported: Bool { WorkoutScheduler.isSupported }

    static var maxScheduledWorkoutCount: Int { WorkoutScheduler.maxAllowedScheduledWorkoutCount }

    static func isAuthorized() async -> Bool {
        await WorkoutScheduler.shared.authorizationState == .authorized
    }

    /// Returns true once RAI is allowed to schedule workouts.
    @discardableResult
    static func requestAuthorization() async -> Bool {
        await WorkoutScheduler.shared.requestAuthorization() == .authorized
    }

    /// Replaces everything RAI previously scheduled.
    ///
    /// Refreshing means the week may have changed, and a stale prescription on
    /// the watch is worse than none — the runner would follow a session that the
    /// gate has since withdrawn.
    static func sync(plan: MobileWorkoutPlanResponse, now: Date = Date()) async -> SyncOutcome {
        let state = await WorkoutScheduler.shared.authorizationState
        guard state == .authorized, isSupported else { return .needsAuthorization }
        let timeZone = TimeZone(identifier: plan.timezone) ?? .current
        let executable = WorkoutPlanMapper.plannedWorkouts(from: plan)
        let skipped = plan.days.count - executable.count
        guard !executable.isEmpty else {
            await WorkoutScheduler.shared.removeAllWorkouts()
            return SyncOutcome(scheduled: 0, attempted: 0, skipped: skipped, authorized: true, verified: true)
        }

        var pending: [PendingWorkout] = []
        for mapped in executable.prefix(maxScheduledWorkoutCount) {
            guard let at = WorkoutPlanMapper.scheduleComponents(for: mapped, timeZone: timeZone, now: now),
                  let custom = customWorkout(from: mapped) else { continue }
            pending.append(PendingWorkout(custom: custom, plan: WorkoutPlan(.custom(custom)), at: at))
        }
        guard !pending.isEmpty else {
            return SyncOutcome(scheduled: 0, attempted: 0, skipped: skipped, authorized: true, verified: false)
        }

        await WorkoutScheduler.shared.removeAllWorkouts()
        for item in pending {
            await WorkoutScheduler.shared.schedule(item.plan, at: item.at)
        }

        // Read back: the scheduler reports no error, so the only proof that the
        // week actually landed is that it is now listed. `WorkoutPlan` carries a
        // fresh UUID on every init, so identity is the wrapped workout, not the
        // plan itself.
        let listed = await WorkoutScheduler.shared.scheduledWorkouts
        let confirmed = pending.filter { item in
            listed.contains { $0.plan.workout == .custom(item.custom) }
        }.count
        let dropped = skipped + (executable.count - pending.count) + (pending.count - confirmed)
        return SyncOutcome(
            scheduled: confirmed,
            attempted: pending.count,
            skipped: dropped,
            authorized: true,
            verified: confirmed == pending.count
        )
    }

    private struct PendingWorkout {
        let custom: CustomWorkout
        let plan: WorkoutPlan
        let at: DateComponents
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
