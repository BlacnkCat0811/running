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
            WorkoutPlanMapper.inactiveLabel(for: flagOff, completedLocalDates: [flagOff.localDate]) == "已记录训练",
            "a day already trained says so instead of showing a stale prescription"
        )
        check(
            WorkoutPlanMapper.inactiveLabel(for: plan.days[2], completedLocalDates: [plan.days[2].localDate]) == "已记录训练",
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
        check(WorkoutPlanMapper.paceBounds(lower: 1, upper: 423) == nil, "corrupt one-second pace must never reach Watch")
        check(WorkoutPlanMapper.paceBounds(lower: 60, upper: 423) == nil, "corrupt one-minute pace must never reach Watch")
        check(WorkoutPlanMapper.paceBounds(lower: 423, upper: 380) == .range(lowerMetersPerSecond: 1_000.0 / 423, upperMetersPerSecond: 1_000.0 / 380), "September 14 target stays 6:20 to 7:03 per km")

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

        // MARK: What the watch will actually be offered

        // The panel prints this count. It used to count the server's `executable`
        // flag, which asks a looser question — `flagOff` above is executable-shaped
        // and still does not survive mapping — so a week could read "3 项可上表"
        // while the bridge handed over two.
        check(
            WorkoutPlanMapper.schedulableCount(in: plan, now: dayBefore, completedLocalDates: []) == 2,
            "the offered count equals the days the bridge can hand over"
        )
        let allUnschedulable = MobileWorkoutPlanResponse(
            generatedAt: plan.generatedAt, timezone: plan.timezone, windowDays: plan.windowDays,
            planRevision: plan.planRevision, audit: plan.audit, days: [plan.days[2], flagOff]
        )
        check(
            WorkoutPlanMapper.schedulableCount(in: allUnschedulable, now: dayBefore, completedLocalDates: []) == 0,
            "a week of rest days and broken prescriptions offers nothing"
        )
        // `notExecutable` is the case the two predicates disagree on: the server
        // marks it executable and its prescription still cannot be built. Without
        // it, a regression back to `\\.executable` would pass the check above.
        let flagOnButBroken = MobileWorkoutPlanResponse(
            generatedAt: plan.generatedAt, timezone: plan.timezone, windowDays: plan.windowDays,
            planRevision: plan.planRevision, audit: plan.audit, days: [plan.days[0], notExecutable]
        )
        check(
            flagOnButBroken.days.filter(\.executable).count == 2,
            "the fixture really does contain two server-executable days"
        )
        check(
            WorkoutPlanMapper.schedulableCount(in: flagOnButBroken, now: dayBefore, completedLocalDates: []) == 1,
            "an executable day whose prescription was not built is not counted as offerable"
        )

        // MARK: What is left of the week

        func planned(localDate: String) -> PlannedWorkout {
            PlannedWorkout(
                localDate: localDate,
                displayName: "RAI · 轻松跑 8.0km",
                hour: 7,
                minute: 0,
                warmup: nil,
                blocks: [
                    PlannedWorkout.Block(
                        iterations: 1,
                        steps: [PlannedWorkout.Step(purpose: "work", goal: .distance(meters: 8_000), alert: nil)]
                    )
                ],
                cooldown: nil
            )
        }

        // A day that is already over is not offered to the scheduler. It cannot be
        // trained, and — because a past slot is pushed onto `now` — it would reach the
        // watch wearing today's date, which is the date a receipt is matched on. The
        // panel's own sentence ("已记录训练的日期不会重复下发") has always promised this.
        let partWayThroughTheWeek = calendar.date(from: DateComponents(year: 2026, month: 9, day: 12, hour: 9, minute: 0))!
        let weekOver = calendar.date(from: DateComponents(year: 2026, month: 9, day: 20, hour: 9, minute: 0))!
        let plannedWeek = ["2026-09-11", "2026-09-12", "2026-09-13"].map { planned(localDate: $0) }
        check(
            WorkoutPlanMapper.upcoming(plannedWeek, now: dayBefore, timeZone: shanghai).map(\.localDate)
                == ["2026-09-11", "2026-09-12", "2026-09-13"],
            "a week that has not started yet is offered in full"
        )
        check(
            WorkoutPlanMapper.upcoming(plannedWeek, now: partWayThroughTheWeek, timeZone: shanghai).map(\.localDate)
                == ["2026-09-12", "2026-09-13"],
            "a day that is already over is dropped and the day itself is kept"
        )
        check(
            WorkoutPlanMapper.upcoming(plannedWeek, now: weekOver, timeZone: shanghai).isEmpty,
            "a week whose last day has gone offers nothing"
        )
        // A date this cannot read is kept, not classified: `scheduleComponents` is the
        // one place that refuses it, and it already reports that as a counted skip.
        check(
            WorkoutPlanMapper.upcoming([planned(localDate: "not-a-date")], now: partWayThroughTheWeek, timeZone: shanghai).count == 1,
            "a date that cannot be read is left for the scheduler to refuse"
        )
        check(
            WorkoutPlanMapper.schedulableCount(in: plan, now: partWayThroughTheWeek, completedLocalDates: []) == 1,
            "the panel's count drops the days of the week that are already over"
        )
        check(
            WorkoutPlanMapper.schedulableCount(in: plan, now: weekOver, completedLocalDates: []) == 0,
            "a week that is entirely over offers nothing, so the sync action is offered nothing either"
        )
        // The plan's own timezone decides which day "today" is: 23:30 UTC on the 11th
        // is already 07:30 on the 12th in Shanghai, so the 11th is over by then.
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let lateUtcInShanghai = utc.date(from: DateComponents(year: 2026, month: 9, day: 11, hour: 23, minute: 30))!
        check(
            WorkoutPlanMapper.schedulableCount(in: plan, now: lateUtcInShanghai, completedLocalDates: []) == 1,
            "today is read in the plan's timezone, not the device's"
        )

        // MARK: Days that are no longer owed

        // "Not owed" has two causes and neither implies the other: a day can be over
        // without having been trained, and today can already have been trained. The
        // panel's sentence ("已记录训练的日期不会重复下发") has always stated the second.
        check(
            WorkoutPlanMapper.owed(
                plannedWeek, now: partWayThroughTheWeek, timeZone: shanghai, completedLocalDates: ["2026-09-12"]
            ).map(\.localDate) == ["2026-09-13"],
            "today's own session is not owed once it has been trained"
        )
        check(
            WorkoutPlanMapper.owed(
                plannedWeek, now: dayBefore, timeZone: shanghai,
                completedLocalDates: ["2026-09-11", "2026-09-12"]
            ).map(\.localDate) == ["2026-09-13"],
            "a trained day drops out while it is still ahead too"
        )
        check(
            WorkoutPlanMapper.owed(
                plannedWeek, now: partWayThroughTheWeek, timeZone: shanghai,
                completedLocalDates: ["2026-09-12", "2026-09-13"]
            ).isEmpty,
            "nothing is owed when the rest of the week is over and today is done"
        )
        check(
            WorkoutPlanMapper.schedulableCount(in: plan, now: dayBefore, completedLocalDates: ["2026-09-11"]) == 1,
            "a trained day lowers the count the panel prints"
        )
        check(
            WorkoutPlanMapper.schedulableCount(
                in: plan, now: dayBefore, completedLocalDates: ["2026-09-11", "2026-09-12"]
            ) == 0,
            "a week that is trained drops the count to zero, so the panel offers the action disabled"
        )

        // MARK: Why the count is zero
        //
        // A bare count cannot be explained, and each surface used to invent its own
        // reason. The panel told the runner to regenerate the week whenever the count
        // was zero — including when the week was simply over or already run, which a
        // new plan would not change — while the sync itself said "本周没有还需要上表
        // 的训练". Both now read one classification; only the wording differs.

        // Everything run: the week is finished, not missing. Regenerating it would not
        // put anything back on the watch, so the panel must not suggest that.
        let allDone = WorkoutPlanMapper.weekOffer(
            in: plan, now: dayBefore, completedLocalDates: Set(plan.days.map(\.localDate))
        )
        check(allDone.offered.isEmpty && allDone.isExhausted, "a fully trained week reads as finished")
        check(
            allDone.alreadyTrained == 2 && allDone.expired == 0,
            "the finished week names the trained days and no expired ones"
        )
        // A week whose days have all passed: also nothing left to do, and also not a
        // reason to regenerate.
        let allPassed = WorkoutPlanMapper.weekOffer(in: plan, now: weekOver, completedLocalDates: [])
        check(
            allPassed.offered.isEmpty && allPassed.isExhausted,
            "a week that is entirely over also reads as finished rather than as a bad plan"
        )
        // The case the old copy was written for: the server offered days and the device
        // could not use any of them. That one *is* a shortfall, and regenerating is the
        // right advice.
        let nothingUsable = WorkoutPlanMapper.weekOffer(
            in: allUnschedulable, now: dayBefore, completedLocalDates: []
        )
        check(
            nothingUsable.offered.isEmpty && !nothingUsable.isExhausted && nothingUsable.skipped == 2,
            "a week whose prescriptions all failed to build is not reported as finished"
        )
        check(
            nothingUsable.emptyOfferMessage.contains("预览并确认"),
            "the unusable week is the one that tells the runner to regenerate"
        )
        // The panel's fallback for "there is no plan to classify" must be that same
        // sentence, not a second copy of it that can drift.
        check(
            nothingUsable.emptyOfferMessage == WorkoutPlanMapper.WeekOffer.unusableWeekMessage,
            "the unusable week's line is the one the panel falls back to"
        )
        check(
            allDone.emptyOfferMessage.contains("已记录训练"),
            "the finished week says the work is done instead of asking for a new plan"
        )
        check(
            allPassed.emptyOfferMessage.contains("已过去"),
            "the week that is over says so instead of asking for a new plan"
        )
        // The classification has to agree with the count the panel prints, since both
        // now come from the same call.
        check(
            WorkoutPlanMapper.weekOffer(in: plan, now: partWayThroughTheWeek, completedLocalDates: [])
                .offered.count == WorkoutPlanMapper.schedulableCount(
                    in: plan, now: partWayThroughTheWeek, completedLocalDates: []
                ),
            "the classified offer and the printed count are the same set"
        )
        check(
            WorkoutPlanMapper.weekOffer(in: plan, now: partWayThroughTheWeek, completedLocalDates: [])
                .expired == 1,
            "the expired count is what makes the printed number read below the week"
        )

        check(
            WorkoutPlanMapper.eligibility(for: plan.days[0], completedLocalDates: []) == .scheduled,
            "a day that survives mapping is eligible as scheduled"
        )
        check(
            WorkoutPlanMapper.eligibility(for: plan.days[0], completedLocalDates: [plan.days[0].localDate]) == .completed,
            "a trained day is eligible as completed even though it still maps"
        )
        check(
            WorkoutPlanMapper.eligibility(for: plan.days[2], completedLocalDates: []) == .rest,
            "a rest day is eligible as rest"
        )
        check(
            WorkoutPlanMapper.eligibility(for: flagOff, completedLocalDates: []) == .noPrescription,
            "a day that cannot survive mapping is eligible as no prescription"
        )

        let unoffered = WorkoutPlanMapper.unofferedDays(in: allUnschedulable, completedLocalDates: [])
        check(unoffered.count == 1, "only the broken training day is unoffered, never the rest day")
        check(unoffered.first?.localDate == flagOff.localDate, "the unoffered day is the broken one")
        check(unoffered.first?.reason == "不可上表", "the unoffered day carries its reason")
        check(
            WorkoutPlanMapper.unofferedDays(in: plan, completedLocalDates: [plan.days[0].localDate]).isEmpty,
            "a completed day is not reported as unoffered"
        )

        // MARK: Pace bounds are dropped, heart-rate bounds are clamped

        // A pace outside the usable band is a malformed field, and clamping it
        // would change the intensity the session asks for; a heart rate above what
        // a human reaches is decoration, so clamping it loses nothing. Both are
        // asserted through the same `alert` path the scheduler sees — checking
        // `paceBounds` instead would miss the bound entirely, because that helper
        // carries its own, far looser, 86 400 cap.
        func dayWith(_ alert: MobileStepAlert, localDate: String = "2026-09-17") -> MobileWorkoutPlanDay {
            MobileWorkoutPlanDay(
                localDate: localDate, kind: "easy", title: "轻松跑", reason: "", distanceKm: 8,
                durationMinutes: 48, paceSecondsPerKmLower: nil, paceSecondsPerKmUpper: nil,
                heartRateBpmLower: nil, heartRateBpmUpper: nil,
                structure: MobileSessionStructure(
                    warmup: nil,
                    blocks: [MobileIntervalBlock(iterations: 1, steps: [MobileWorkoutStep(purpose: "work", goal: .distance(meters: 8_000), alert: alert)])],
                    cooldown: nil
                ),
                source: "llm", executable: true
            )
        }
        func alert(of day: MobileWorkoutPlanDay) -> PlannedWorkout.Alert? {
            WorkoutPlanMapper.plannedWorkout(from: day)?.blocks[0].steps[0].alert
        }
        check(
            alert(of: dayWith(MobileStepAlert(kind: "pace", lower: 1_200, upper: 2_000))) == .pace(lower: 1_200, upper: nil),
            "an impossible pace bound is dropped, the usable one is kept"
        )
        check(
            alert(of: dayWith(MobileStepAlert(kind: "pace", lower: 2_000, upper: 2_400))) == nil,
            "a pace alert with no usable bound is dropped entirely"
        )
        check(
            alert(of: dayWith(MobileStepAlert(kind: "heart_rate", lower: 150, upper: 260))) == .heartRate(lower: 150, upper: 240),
            "an impossible heart-rate ceiling is clamped to what a human reaches"
        )
        check(
            alert(of: dayWith(MobileStepAlert(kind: "pace", lower: 300, upper: 320))) == .pace(lower: 300, upper: 320),
            "a usable pace band is still passed through untouched"
        )

        // MARK: Dates the calendar has to agree with

        func schedule(_ localDate: String) -> DateComponents? {
            WorkoutPlanMapper.plannedWorkout(
                from: dayWith(MobileStepAlert(kind: "pace", lower: 300, upper: 320), localDate: localDate)
            ).flatMap { WorkoutPlanMapper.scheduleComponents(for: $0, timeZone: shanghai, now: dayBefore) }
        }
        // `Calendar.date(from:)` rolls "2026-02-30" forward into March instead of
        // failing, which would put a session on a day nobody asked for.
        check(schedule("2026-02-30") == nil, "a day the calendar would roll forward is refused")
        check(schedule("2026-02-29") == nil, "a non-leap February 29 is refused")
        check(schedule("2028-02-29")?.day == 29, "a real leap day still schedules on its own day")
        check(schedule("2028-02-29")?.month == 2, "a real leap day stays in February")

        // MARK: The strip's status word

        // Both skins used to carry their own copy of these four branches; only the
        // colour is a skin decision.
        check(
            WorkoutPlanMapper.weekStripStatus(completed: true, isRest: false, isToday: true) == "已记录训练",
            "a completed day reads as completed"
        )
        check(
            WorkoutPlanMapper.weekStripStatus(completed: true, isRest: true, isToday: true) == "已记录训练",
            "completion outranks rest"
        )
        check(
            WorkoutPlanMapper.weekStripStatus(completed: false, isRest: true, isToday: true) == "休息日",
            "rest outranks today"
        )
        check(
            WorkoutPlanMapper.weekStripStatus(completed: false, isRest: false, isToday: true) == "今日安排",
            "today's session reads as today"
        )
        check(
            WorkoutPlanMapper.weekStripStatus(completed: false, isRest: false, isToday: false) == "计划中",
            "a future session reads as planned"
        )

        // MARK: Reviewing a week whose early days have already passed

        // The scheduler pushes a slot ahead, but only inside its own day: a day that
        // is already over keeps the date it was planned for. That is exactly what
        // makes the date on a listed entry mean something — pushing every past day
        // onto `now` gives Monday, Tuesday and Wednesday one identical `at`, so the
        // receipt for whichever of them landed is handed to Monday.
        let midWeek = calendar.date(from: DateComponents(year: 2026, month: 9, day: 16, hour: 21, minute: 30))!
        func scheduled(_ localDate: String, now: Date = midWeek) -> DateComponents? {
            WorkoutPlanMapper.scheduleComponents(
                for: PlannedWorkout(
                    localDate: localDate,
                    displayName: "轻松跑",
                    hour: 7,
                    minute: 0,
                    warmup: nil,
                    blocks: [
                        PlannedWorkout.Block(
                            iterations: 1,
                            steps: [PlannedWorkout.Step(purpose: "work", goal: .distance(meters: 8_000), alert: nil)]
                        )
                    ],
                    cooldown: nil
                ),
                timeZone: shanghai,
                now: now
            )
        }
        func instant(_ components: DateComponents?) -> String {
            guard let components else { return "nil" }
            return "\(components.year!)-\(components.month!)-\(components.day!) "
                + "\(components.hour!):\(String(format: "%02d", components.minute!))"
        }
        let week = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]
        let weekAt = week.map { scheduled($0) }
        check(instant(weekAt[0]) == "2026-9-14 7:00", "a day that is already over keeps its own date and hour")
        check(instant(weekAt[1]) == "2026-9-15 7:00", "so does the day before it")
        check(instant(weekAt[2]) == "2026-9-16 21:31", "today's passed slot is still pushed ahead of now")
        check(instant(weekAt[3]) == "2026-9-17 7:00", "a day still ahead is untouched")
        check(Set(weekAt.map(instant)).count == week.count, "no two days of the week share one instant")

        let lastMinute = calendar.date(from: DateComponents(year: 2026, month: 9, day: 16, hour: 23, minute: 59, second: 40))!
        check(instant(scheduled("2026-09-16", now: lastMinute)) == "2026-9-17 0:00", "late mapper slot can cross midnight; strict scheduler must refuse it")

        if failures > 0 {
            print("\(failures) workout plan mapper check(s) failed.")
            exit(1)
        }
        print("All workout plan mapper checks passed.")
    }
}
