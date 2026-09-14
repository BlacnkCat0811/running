import Foundation

/// Off-device regression for the plan → workout mapping.
///
/// Everything here is pure Foundation, so the rules that decide what reaches the
/// watch can be verified without a device, a simulator, or WorkoutKit. The one
/// part that genuinely needs the SDK — handing the workout to `WorkoutScheduler`
/// — lives in `WorkoutKitBridge.swift` and is checked by compiling it against the
/// real `WorkoutKit.swiftinterface`.
@main struct WorkoutPlanMapperRegression {
    static func main() {
        var failures = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            if condition() {
                print("  ok  \(name)")
            } else {
                failures += 1
                print("  FAIL \(name)")
            }
        }

        // MARK: Decoding the server payload

        let intervalJSON = """
        {
          "generatedAt": "2026-09-11T01:00:00.000Z",
          "timezone": "Asia/Shanghai",
          "windowDays": 7,
          "planRevision": 12,
          "audit": {"generatedBy": "llm", "model": "deepseek:deepseek-chat", "promptVersion": "weekly-plan-v1", "generatedAt": "2026-09-11T00:30:00.000Z"},
          "days": [
            {
              "localDate": "2026-09-11",
              "kind": "interval",
              "title": "间歇 / VO₂",
              "reason": "闸门放行，安排 6 组",
              "distanceKm": 11.4,
              "durationMinutes": 62,
              "paceSecondsPerKmLower": 240,
              "paceSecondsPerKmUpper": 265,
              "heartRateBpmLower": 160,
              "heartRateBpmUpper": 172,
              "structure": {
                "warmup": {"purpose": "warmup", "goal": {"type": "time", "seconds": 600}, "alert": {"kind": "heart_rate", "lower": 100, "upper": 150}},
                "blocks": [
                  {
                    "iterations": 6,
                    "steps": [
                      {"purpose": "work", "goal": {"type": "distance", "meters": 800}, "alert": {"kind": "pace", "lower": 240, "upper": 265}},
                      {"purpose": "recovery", "goal": {"type": "time", "seconds": 120}, "alert": null}
                    ]
                  }
                ],
                "cooldown": {"purpose": "cooldown", "goal": {"type": "time", "seconds": 600}, "alert": null}
              },
              "source": "llm",
              "executable": true
            },
            {
              "localDate": "2026-09-12",
              "kind": "easy",
              "title": "轻松跑",
              "reason": "",
              "distanceKm": 8,
              "durationMinutes": 48,
              "paceSecondsPerKmLower": 330,
              "paceSecondsPerKmUpper": 390,
              "heartRateBpmLower": 120,
              "heartRateBpmUpper": 150,
              "structure": {
                "warmup": {"purpose": "warmup", "goal": {"type": "time", "seconds": 300}, "alert": null},
                "blocks": [{"iterations": 1, "steps": [{"purpose": "work", "goal": {"type": "distance", "meters": 7000}, "alert": {"kind": "pace", "lower": 330, "upper": 390}}]}],
                "cooldown": {"purpose": "cooldown", "goal": {"type": "time", "seconds": 300}, "alert": null}
              },
              "source": "llm",
              "executable": true
            },
            {
              "localDate": "2026-09-13",
              "kind": "rest",
              "title": "休息",
              "reason": "恢复日",
              "distanceKm": null,
              "durationMinutes": null,
              "paceSecondsPerKmLower": null,
              "paceSecondsPerKmUpper": null,
              "heartRateBpmLower": null,
              "heartRateBpmUpper": null,
              "structure": null,
              "source": "llm",
              "executable": false
            }
          ]
        }
        """

        let decoder = JSONDecoder()
        guard let plan = try? decoder.decode(MobileWorkoutPlanResponse.self, from: Data(intervalJSON.utf8)) else {
            print("  FAIL plan payload decodes")
            exit(1)
        }
        check(plan.days.count == 3, "plan payload decodes")
        check(plan.audit?.generatedBy == "llm", "audit survives decoding")
        check(plan.planRevision == 12, "plan revision survives decoding")

        let intervalDay = plan.days[0]
        check(intervalDay.structure?.blocks.first?.steps.first?.goal == .distance(meters: 800), "union goal decodes")
        check(intervalDay.structure?.warmup?.alert?.kind == "heart_rate", "step alert decodes")

        // MARK: Interval mapping

        guard let interval = WorkoutPlanMapper.plannedWorkout(from: intervalDay) else {
            print("  FAIL interval day maps")
            exit(1)
        }
        check(interval.blocks.count == 1, "interval day maps to one block")
        check(interval.blocks.first?.iterations == 6, "iterations carry over")
        check(interval.blocks.first?.steps.count == 2, "work and recovery steps carry over")
        check(interval.blocks.first?.steps.first?.isRecovery == false, "work step is not recovery")
        check(interval.blocks.first?.steps.last?.isRecovery == true, "recovery step is labelled recovery")
        check(interval.warmup?.goal == .time(seconds: 600), "warmup carries over")
        check(interval.cooldown?.goal == .time(seconds: 600), "cooldown carries over")
        check(interval.displayName == "RAI · 间歇 / VO₂ 11.4km", "display name includes title and distance")
        check(interval.hour == WorkoutPlanMapper.defaultScheduleHour && interval.minute == 0, "default schedule is 07:00")

        // MARK: Rest and unschedulable days never reach the watch

        check(WorkoutPlanMapper.plannedWorkout(from: plan.days[2]) == nil, "rest day is not schedulable")
        check(WorkoutPlanMapper.plannedWorkouts(from: plan).count == 2, "only executable days are returned")
        let notExecutable = MobileWorkoutPlanDay(
            localDate: "2026-09-14", kind: "tempo", title: "节奏", reason: "", distanceKm: 10,
            durationMinutes: 50, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil,
            heartRateBpmLower: nil, heartRateBpmUpper: nil, structure: nil, source: "llm", executable: true
        )
        check(WorkoutPlanMapper.plannedWorkout(from: notExecutable) == nil, "a day with no structure is not schedulable")
        let flagOff = MobileWorkoutPlanDay(
            localDate: "2026-09-14", kind: "easy", title: "轻松跑", reason: "", distanceKm: 8,
            durationMinutes: 48, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil,
            heartRateBpmLower: nil, heartRateBpmUpper: nil,
            structure: MobileSessionStructure(
                warmup: nil,
                blocks: [MobileIntervalBlock(iterations: 1, steps: [MobileWorkoutStep(purpose: "work", goal: .distance(meters: 8000), alert: nil)])],
                cooldown: nil
            ),
            source: "llm", executable: false
        )
        check(WorkoutPlanMapper.plannedWorkout(from: flagOff) == nil, "executable false is respected even with a structure")

        // MARK: Why a row is not offered to the watch

        // Both endpoints render the same date differently on purpose: `/today`
        // reports what was run, `/workout-plan` still reports the prescription.
        // After a run the week panel showed that prescription dimmed with its
        // distance and no explanation, which reads as work still owed. The label
        // is what makes the two legible side by side.
        check(
            WorkoutPlanMapper.inactiveLabel(for: plan.days[0], completedLocalDates: []) == nil,
            "a day the watch will receive carries no label"
        )
        check(
            WorkoutPlanMapper.inactiveLabel(for: flagOff, completedLocalDates: []) == "不可上表",
            "a prescription that failed to build says it cannot be scheduled"
        )
        check(
            WorkoutPlanMapper.inactiveLabel(for: plan.days[2], completedLocalDates: []) == "休息",
            "a rest day says rest"
        )
        check(
            WorkoutPlanMapper.inactiveLabel(for: flagOff, completedLocalDates: [flagOff.localDate]) == "已完成",
            "a day already trained says so instead of showing a stale prescription"
        )
        check(
            WorkoutPlanMapper.inactiveLabel(for: plan.days[2], completedLocalDates: [plan.days[2].localDate]) == "已完成",
            "trained wins over rest when a stored day is both"
        )

        // MARK: Device-side re-bounding of untrusted input

        let hostile = MobileWorkoutPlanDay(
            localDate: "2026-09-15", kind: "interval", title: "越界", reason: "", distanceKm: 40,
            durationMinutes: 240, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil,
            heartRateBpmLower: nil, heartRateBpmUpper: nil,
            structure: MobileSessionStructure(
                warmup: MobileWorkoutStep(purpose: "warmup", goal: .time(seconds: -5), alert: nil),
                blocks: (0..<12).map { _ in
                    MobileIntervalBlock(
                        iterations: 500,
                        steps: [
                            MobileWorkoutStep(purpose: "work", goal: .distance(meters: 5_000_000), alert: MobileStepAlert(kind: "pace", lower: 0, upper: -10)),
                            MobileWorkoutStep(purpose: "recovery", goal: .time(seconds: 1_000_000), alert: MobileStepAlert(kind: "power", lower: 100, upper: 200))
                        ]
                    )
                },
                cooldown: nil
            ),
            source: "llm", executable: true
        )
        guard let bounded = WorkoutPlanMapper.plannedWorkout(from: hostile) else {
            print("  FAIL hostile day is still scheduled with bounded numbers")
            exit(1)
        }
        check(bounded.warmup == nil, "a negative-duration warmup is dropped")
        check(bounded.blocks.count == WorkoutPlanMapper.maxBlocks, "block count is capped")
        check(bounded.blocks.allSatisfy { $0.iterations == WorkoutPlanMapper.maxIterations }, "iterations are capped")
        let boundedWork = bounded.blocks[0].steps[0]
        check(boundedWork.goal == .distance(meters: WorkoutPlanMapper.maxStepMeters), "an absurd distance is clamped")
        check(boundedWork.alert == nil, "a pace alert with no usable bound is dropped")
        check(bounded.blocks[0].steps[1].goal == .time(seconds: WorkoutPlanMapper.maxStepSeconds), "an absurd duration is clamped")
        check(bounded.blocks[0].steps[1].alert == nil, "an unknown alert kind is dropped")

        let tooManySteps = WorkoutPlanMapper.plannedWorkout(
            from: MobileWorkoutPlanDay(
                localDate: "2026-09-15", kind: "interval", title: "长块", reason: "", distanceKm: 10,
                durationMinutes: 60, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil,
                heartRateBpmLower: nil, heartRateBpmUpper: nil,
                structure: MobileSessionStructure(
                    warmup: nil,
                    blocks: [
                        MobileIntervalBlock(
                            iterations: 4,
                            steps: (0..<30).map { _ in
                                MobileWorkoutStep(purpose: "work", goal: .distance(meters: 400), alert: nil)
                            }
                        )
                    ],
                    cooldown: nil
                ),
                source: "llm", executable: true
            )
        )
        check(tooManySteps?.blocks[0].steps.count == WorkoutPlanMapper.maxStepsPerBlock, "steps per block are capped")

        // MARK: Alert normalization

        let swapped = MobileStepAlert(kind: "pace", lower: 390, upper: 330)
        check(
            WorkoutPlanMapper.plannedWorkout(
                from: MobileWorkoutPlanDay(
                    localDate: "2026-09-16", kind: "easy", title: "轻松跑", reason: "", distanceKm: 8,
                    durationMinutes: 48, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil,
                    heartRateBpmLower: nil, heartRateBpmUpper: nil,
                    structure: MobileSessionStructure(
                        warmup: nil,
                        blocks: [MobileIntervalBlock(iterations: 1, steps: [MobileWorkoutStep(purpose: "work", goal: .distance(meters: 8_000), alert: swapped)])],
                        cooldown: nil
                    ),
                    source: "llm", executable: true
                )
            )?.blocks[0].steps[0].alert == .pace(lower: 330, upper: 390),
            "swapped alert bounds are put back in order"
        )
        check(WorkoutPlanMapper.paceBounds(lower: nil, upper: nil) == nil, "no pace bound yields no alert")

        // MARK: Pace to speed inversion

        guard case let .range(lowerSpeed, upperSpeed)? = WorkoutPlanMapper.paceBounds(lower: 240, upper: 265) else {
            print("  FAIL pace bounds produce a speed range")
            exit(1)
        }
        // 240 s/km is the fast end, 265 s/km the slow end, so the speed band runs
        // from 1000/265 up to 1000/240.
        check(abs(lowerSpeed - 1_000.0 / 265) < 0.0001, "the slow pace becomes the speed floor")
        check(abs(upperSpeed - 1_000.0 / 240) < 0.0001, "the fast pace becomes the speed ceiling")
        check(lowerSpeed < upperSpeed, "speed bounds stay ascending")
        guard case let .range(swappedLower, swappedUpper)? = WorkoutPlanMapper.paceBounds(lower: 265, upper: 240) else {
            print("  FAIL reversed pace bounds still produce a range")
            exit(1)
        }
        check(
            abs(swappedLower - lowerSpeed) < 0.0001 && abs(swappedUpper - upperSpeed) < 0.0001,
            "the speed band is independent of the order the paces arrive in"
        )
        check(WorkoutPlanMapper.paceBounds(lower: 240, upper: 240) == .range(lowerMetersPerSecond: 1_000.0 / 240, upperMetersPerSecond: 1_000.0 / 240), "a fixed pace collapses to a point range")
        check(WorkoutPlanMapper.paceBounds(lower: 240, upper: nil) == .threshold(metersPerSecond: 1_000.0 / 240), "a single bound becomes a threshold alert")
        check(WorkoutPlanMapper.paceBounds(lower: 0, upper: -5) == nil, "non-positive paces yield no alert")

        // MARK: Scheduling

        let shanghai = TimeZone(identifier: "Asia/Shanghai")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = shanghai

        // Reviewed the day before, the session keeps its own day and hour.
        let dayBefore = calendar.date(from: DateComponents(year: 2026, month: 9, day: 10, hour: 8, minute: 0))!
        let future = WorkoutPlanMapper.scheduleComponents(for: interval, timeZone: shanghai, now: dayBefore)
        check(future?.year == 2026 && future?.month == 9, "future date keeps its own calendar date")
        check(future?.day == 11, "a future session keeps its planned day")
        check(future?.hour == 7 && future?.minute == 0, "a future session keeps its planned hour")
        check(future?.second == 0, "a future session is pinned to the start of the minute")
        check(future?.timeZone?.identifier == "Asia/Shanghai", "scheduled components carry the plan timezone")

        // The same plan reviewed late on its own day must still be schedulable.
        let sameDay = calendar.date(from: DateComponents(year: 2026, month: 9, day: 11, hour: 21, minute: 30, second: 0))!
        let rolled = WorkoutPlanMapper.scheduleComponents(for: interval, timeZone: shanghai, now: sameDay)
        check(rolled?.day == 11, "a passed session stays on its own day")
        check(rolled?.hour == 21 && rolled?.minute == 31, "a passed session is pushed just ahead of now")
        check(rolled?.second == 0, "a rolled session lands on a whole second")

        let badDate = MobileWorkoutPlanDay(
            localDate: "2026-13-45", kind: "easy", title: "轻松跑", reason: "", distanceKm: 8,
            durationMinutes: 48, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil,
            heartRateBpmLower: nil, heartRateBpmUpper: nil,
            structure: MobileSessionStructure(
                warmup: nil,
                blocks: [MobileIntervalBlock(iterations: 1, steps: [MobileWorkoutStep(purpose: "work", goal: .distance(meters: 8_000), alert: nil)])],
                cooldown: nil
            ),
            source: "llm", executable: true
        )
        check(
            WorkoutPlanMapper.plannedWorkout(from: badDate)
                .flatMap { WorkoutPlanMapper.scheduleComponents(for: $0, timeZone: shanghai, now: dayBefore) } == nil,
            "an impossible date cannot be scheduled"
        )

        // MARK: Session summary text

        // Mirrored by `structureSummary` in `apps/web/src/ios/shared.tsx`. The
        // same cases are asserted on both sides, so the two renderings of a
        // prescription cannot drift apart without a test failing.
        func summary(iterations: Int, goal: MobileStepGoal) -> String {
            WorkoutPlanMapper.structureSummary(
                MobileSessionStructure(
                    warmup: nil,
                    blocks: [
                        MobileIntervalBlock(
                            iterations: iterations,
                            steps: [MobileWorkoutStep(purpose: "work", goal: goal, alert: nil)]
                        )
                    ],
                    cooldown: nil
                )
            )
        }
        check(summary(iterations: 6, goal: .distance(meters: 800)) == "6 × 800m", "a distance prescription summarises as reps × metres")
        check(summary(iterations: 1, goal: .distance(meters: 5_000)) == "1 × 5.0km", "a kilometre-scale prescription uses one decimal")
        check(summary(iterations: 3, goal: .time(seconds: 480)) == "3 × 8分", "a timed prescription summarises in minutes")
        check(summary(iterations: 2, goal: .time(seconds: 45)) == "2 × 45秒", "a sub-minute prescription stays in seconds")
        check(summary(iterations: 4, goal: .open) == "4 组", "an open prescription falls back to a set count")
        check(WorkoutPlanMapper.structureSummary(nil) == "", "no structure yields no summary")

        if failures > 0 {
            print("\(failures) workout plan mapper check(s) failed.")
            exit(1)
        }
        print("All workout plan mapper checks passed.")
    }
}
