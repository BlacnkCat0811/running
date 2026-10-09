#if os(iOS)
import Foundation
import HealthKit
import WorkoutKit

/// The sole SDK boundary. Readback establishes LOCAL SYSTEM scheduling, not
/// delivery to the physical paired Watch. Business flow is off-device testable.
@available(iOS 17.0, *)
@MainActor
final class WorkoutKitBridge: WorkoutScheduling {
    private var plans: [UUID: WorkoutPlan] = [:]
    var isSupported: Bool { WorkoutScheduler.isSupported }
    var capacity: Int { WorkoutScheduler.maxAllowedScheduledWorkoutCount }
    func authorization() async -> String { Self.describe(await WorkoutScheduler.shared.authorizationState) }
    func requestAuthorization() async -> String { Self.describe(await WorkoutScheduler.shared.requestAuthorization()) }
    func prepare(_ request: PlanSchedulingRequest) -> String? {
        guard let custom = Self.customWorkout(from: request.workout) else {
            return "系统不支持必要步骤或目标；整日拒绝导出，未删减处方"
        }
        plans[request.entry.workoutID] = WorkoutPlan(.custom(custom), id: request.entry.workoutID)
        return nil
    }
    func schedule(_ request: PlanSchedulingRequest) async {
        guard let plan = plans[request.entry.workoutID] else { return }
        await WorkoutScheduler.shared.schedule(plan, at: request.at)
    }
    func remove(_ request: PlanSchedulingRequest) async {
        guard let plan = plans[request.entry.workoutID] else { return }
        await WorkoutScheduler.shared.remove(plan, at: request.at)
    }
    func removeAll() async { await WorkoutScheduler.shared.removeAllWorkouts() }
    func readBack() async -> [PlanSchedulingReadback] {
        await WorkoutScheduler.shared.scheduledWorkouts.map { item in
            PlanSchedulingReadback(workoutID: item.plan.id, at: item.date,
                contentMatches: plans[item.plan.id]?.workout == item.plan.workout, complete: item.complete)
        }
    }
    private static func describe(_ state: WorkoutScheduler.AuthorizationState) -> String {
        switch state {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        case .restricted: return "restricted"
        @unknown default: return "unknown"
        }
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
            guard steps.count == block.steps.count, !steps.isEmpty else { return nil }
            return IntervalBlock(steps: steps, iterations: block.iterations)
        }
        guard blocks.count == mapped.blocks.count, !blocks.isEmpty else { return nil }
        var warmup: WorkoutStep?
        if let mappedWarmup = mapped.warmup {
            warmup = workoutStep(from: mappedWarmup, activity: activity, location: location)
            guard warmup != nil else { return nil }
        }
        var cooldown: WorkoutStep?
        if let mappedCooldown = mapped.cooldown {
            cooldown = workoutStep(from: mappedCooldown, activity: activity, location: location)
            guard cooldown != nil else { return nil }
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
            guard alert != nil else { return nil }
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
            // WorkoutKit has no single-sided heart-rate alert, and a guessed
            // bound would misrepresent the prescription. A half-specified
            // target rejects the containing day; it is never silently omitted.
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
