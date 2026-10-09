import Foundation

/// `RouteSyncStateMachine` 的边界判据。
///
/// 为什么这台机器必须**无副作用**才值得测：整台机器要判的核心问题是
/// "这一轮**没查**"与"这一轮**查了、但是没变化**"的区别。在真实的同步里这两件事的
/// 表现完全一样（都表现为"这次同步没有新轨迹"），所以一旦把时钟、数据库、HealthKit
/// 混进判据里，这个区别就只能靠真机、真等待、真网络去复现 —— 也就是根本没法验证。
/// 把决策剥成纯函数之后，每一条规则都有一个当场可跑的边界用例。
///
/// 反向的代价也要记住：本文件**不**证明管线会在正确的时候调用它。调用点（是不是真的
/// 在用 `shouldQuery` 过滤、跳过时是不是真的不产出文件、状态是不是在成功收尾时才落盘）
/// 由门禁 `check-background-capabilities.py` 的结构判据负责，两者缺一不可。
@main
struct RouteSyncStateMachineTests {
    static func main() {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let uuid = "0f0f0f0f-1111-2222-3333-444444444444"
        let end = Date(timeIntervalSince1970: 1_700_000_000)
        let hour: TimeInterval = 3600
        let day: TimeInterval = 24 * hour

        func observation(_ points: Int, _ hash: String?) -> RouteObservation {
            RouteObservation(pointCount: points, routeHash: hash)
        }
        func record(
            _ status: RouteSyncStatus,
            endDate: Date = end,
            points: Int = 500,
            hash: String? = "h1",
            checkedAt: Date,
            stable: Int
        ) -> RouteSyncRecord {
            RouteSyncRecord(
                workoutUUID: uuid,
                workoutEndDate: endDate,
                status: status,
                pointCount: points,
                routeHash: hash,
                lastCheckedAt: checkedAt,
                stableCheckCount: stable
            )
        }

        // ---- 1. 未知状态必查；而且"首查"永远算一次**变化**。
        //      基线里的 (pointCount: 0, routeHash: nil) 是哨兵而不是观测值。
        //      把它当观测的后果是不对称的：一次 0 点的首查会被判成"没变"，
        //      于是 `stableCheckCount` 从第一次就记成 1 —— 一条真的没有轨迹的跑步
        //      会比别人早一轮降频。所以这里直接规定首查必然算变化。
        let baseline = RouteSyncStateMachine.baseline(workoutUUID: uuid, workoutEndDate: end)
        check(baseline.status == .unknown, "a workout that was never observed starts in unknown")
        check(
            RouteSyncStateMachine.shouldQuery(existing: baseline, now: end.addingTimeInterval(hour)),
            "an unknown route must be queried once"
        )
        let firstLook = RouteSyncStateMachine.decide(
            existing: baseline,
            observation: observation(0, nil),
            now: end.addingTimeInterval(hour)
        )
        check(firstLook.shouldQuery, "the first look reports that it queried")
        check(firstLook.nextState.status == .active, "the first look lands in active, even with zero points")
        check(
            firstLook.nextState.stableCheckCount == 0,
            "the first look is not stability evidence — the baseline's (0, nil) is a sentinel, not an observation"
        )
        check(
            firstLook.nextState.lastCheckedAt == end.addingTimeInterval(hour),
            "the first look stamps lastCheckedAt with the batch clock"
        )

        // ---- 2. 高频窗口：跨过 24 小时**且**连续两次一致，才降为 cooling。
        //      只判"一致"不判年龄，会让一场刚跑完的步在两次同步后就降频；只判年龄不判一致，
        //      会让还在补传的轨迹提前降频。两级判据都要满足。
        //      计数在**递增之后**才判：第 1 次一致记成 1，第 2 次一致记成 2 时才够格。
        let within = RouteSyncStateMachine.decide(
            existing: record(.active, checkedAt: end, stable: 0),
            observation: observation(500, "h1"),
            now: end.addingTimeInterval(6 * hour)
        )
        check(within.nextState.status == .active, "inside the 24h window an unchanged route stays active")
        check(within.nextState.stableCheckCount == 1, "an identical look counts as one piece of stability evidence")

        // 反例：已经跨过 24 小时，但只一致过一次 ⇒ 证据不够，仍留在 active。
        let oneEvidencePastDay = RouteSyncStateMachine.decide(
            existing: record(.active, checkedAt: end, stable: 0),
            observation: observation(500, "h1"),
            now: end.addingTimeInterval(25 * hour)
        )
        check(
            oneEvidencePastDay.nextState.status == .active,
            "past 24h with only one identical look is not enough evidence to slow down"
        )
        check(oneEvidencePastDay.nextState.stableCheckCount == 1, "that look is still counted as evidence")

        // 第 2 次一致、且已跨过 24 小时 ⇒ 两级判据同时满足，才降为 cooling。
        let cooled = RouteSyncStateMachine.decide(
            existing: within.nextState,
            observation: observation(500, "h1"),
            now: end.addingTimeInterval(25 * hour)
        )
        check(
            cooled.nextState.status == .cooling,
            "past 24h with a second identical look is what promotes active to cooling"
        )
        check(cooled.nextState.stableCheckCount == 2, "the second identical look is counted")

        // ---- 3. 降频用的是 workout 的**年龄**，不是"距上次查询"。
        //      用后者的话，一台刚装上、连着查了好几次的设备会把一场一小时前才跑完的步
        //      立刻判成稳定 —— 而那正是轨迹最可能还在陆续到达的时段。
        let freshButWellExplored = RouteSyncStateMachine.decide(
            existing: record(.active, endDate: end.addingTimeInterval(-hour), checkedAt: end, stable: 9),
            observation: observation(500, "h1"),
            now: end
        )
        check(
            freshButWellExplored.nextState.status == .active,
            "the 24h threshold is the workout's age, not the time since the last look"
        )

        // ---- 4. 任何变化都回到 active 并把稳定计数清零。
        //      注意时间要落在 `cooling` 的 12 小时节流窗口**之外**，否则这一轮根本不会被查询，
        //      判据就会退化成"跳过时状态没变"（那是第 6 条要测的东西），而不是在测变化。
        let grew = RouteSyncStateMachine.decide(
            existing: cooled.nextState,
            observation: observation(612, "h2"),
            now: end.addingTimeInterval(40 * hour)
        )
        check(grew.nextState.status == .active, "a route that gained points goes back to high frequency")
        check(grew.nextState.stableCheckCount == 0, "a change wipes the stability count")
        check(grew.nextState.pointCount == 612 && grew.nextState.routeHash == "h2", "the new observation is stored")

        // 点数相同、摘要不同：GPS 纠偏或重采样会换掉坐标而点数不变。只比点数会让这条轨迹
        // 被永远冻结在旧内容上 —— 服务端也永远拿不到修正后的轨迹。
        let retouched = RouteSyncStateMachine.decide(
            existing: cooled.nextState,
            observation: observation(500, "h-shifted"),
            now: end.addingTimeInterval(40 * hour)
        )
        check(
            retouched.nextState.status == .active,
            "an identical point count with a different digest is still a change"
        )
        check(retouched.nextState.stableCheckCount == 0, "a digest change wipes the stability count too")

        // ---- 5. 冷却期的节流：距**上次实际查询**不足 12 小时就跳过。
        let cooling = record(.cooling, checkedAt: end, stable: 3)
        check(
            !RouteSyncStateMachine.shouldQuery(existing: cooling, now: end.addingTimeInterval(11 * hour + 3599)),
            "just under 12h the cooling route is skipped"
        )
        check(
            RouteSyncStateMachine.shouldQuery(existing: cooling, now: end.addingTimeInterval(12 * hour)),
            "exactly 12h the cooling route may be queried again"
        )

        // ---- 6. 🔴 跳过的那一轮**绝不**改动状态，尤其不产生稳定证据。
        //      这是整台机器唯一会把"没读到"写成"没变化"的地方，它与 ADR-004 决策二
        //      「没读到 ≠ 没变化」是同一条不变式。破了它的后果不是报错，是**静默丢数据**：
        //      一条刚变更过的轨迹会被当成"又一次确认稳定"，直接降到 settled 而错过及时补齐。
        let fiveDaysOld = record(.cooling, endDate: end.addingTimeInterval(-5 * day), checkedAt: end, stable: 2)
        let skipped = RouteSyncStateMachine.decide(
            existing: fiveDaysOld,
            observation: nil,
            now: end.addingTimeInterval(hour)
        )
        check(!skipped.shouldQuery, "a cooling route consulted an hour ago is not queried")
        check(skipped.nextState == fiveDaysOld, "a skipped round carries the record over byte for byte")
        check(
            skipped.nextState.stableCheckCount == 2,
            "a skipped round must not count as stability evidence — otherwise this 5-day-old route settles immediately"
        )
        check(
            !RouteSyncStateMachine.shouldQuery(existing: skipped.nextState, now: end.addingTimeInterval(11 * hour)),
            "the skip did not move the throttle window: 11h after the last real check it is still skipped"
        )
        // 这一条是判别性的：跳过时若（错误地）把 `lastCheckedAt` 也盖上"现在"，
        // 12 小时的窗口就会从那一刻重新开始，于是这次查询会被判成"还不到时候"。
        check(
            RouteSyncStateMachine.shouldQuery(existing: skipped.nextState, now: end.addingTimeInterval(12 * hour)),
            "the next query is allowed 12h after the LAST REAL check — a skip must not push that window back"
        )

        // 正对照：冷却期满 12 小时后的那次查询确认稳定、且年龄已过 3 天 ⇒ 才允许 settled。
        let settledNow = RouteSyncStateMachine.decide(
            existing: fiveDaysOld,
            observation: observation(500, "h1"),
            now: end.addingTimeInterval(12 * hour)
        )
        check(
            settledNow.nextState.status == .settled,
            "a cooling route confirmed stable past the 3-day mark finally settles"
        )

        // ---- 7. settled 降为低频，不再永久终止。间隔从上次真实观测计，不是 workout 年龄。
        let settled = record(.settled, endDate: end.addingTimeInterval(-10 * day), checkedAt: end, stable: 5)
        check(
            !RouteSyncStateMachine.shouldQuery(existing: settled, now: end.addingTimeInterval(7 * day - 1)),
            "an existing settled route is skipped before the weekly rediscovery boundary"
        )
        check(
            RouteSyncStateMachine.shouldQuery(existing: settled, now: end.addingTimeInterval(7 * day)),
            "an existing settled route is eligible exactly one week after the last real check"
        )
        let rediscoveredUnchanged = RouteSyncStateMachine.decide(
            existing: settled, observation: observation(500, "h1"), now: end.addingTimeInterval(7 * day)
        )
        check(rediscoveredUnchanged.nextState.status == .settled, "an unchanged rediscovery keeps the low-frequency state")
        check(
            rediscoveredUnchanged.nextState.lastCheckedAt == end.addingTimeInterval(7 * day),
            "only a real rediscovery starts the next weekly interval"
        )
        let settledEmpty = record(
            .settled, endDate: end.addingTimeInterval(-30 * day),
            points: 0, hash: nil, checkedAt: end, stable: 5
        )
        check(
            !RouteSyncStateMachine.shouldQuery(existing: settledEmpty, now: end.addingTimeInterval(day - 1)),
            "empty routes are still throttled just before one day"
        )
        check(
            RouteSyncStateMachine.shouldQuery(existing: settledEmpty, now: end.addingTimeInterval(day)),
            "empty routes are rediscovered daily even if the workout is months old"
        )
        let lateRoute = RouteSyncStateMachine.decide(
            existing: settledEmpty, observation: observation(850, "late"),
            now: end.addingTimeInterval(day)
        )
        check(
            lateRoute.nextState.status == .active && lateRoute.nextState.stableCheckCount == 0,
            "a route arriving after empty settlement wakes high-frequency tracking"
        )
        check(lateRoute.nextState.pointCount == 850, "rediscovery stores late route points")
        let correctedRoute = RouteSyncStateMachine.decide(
            existing: settled, observation: observation(500, "corrected"),
            now: end.addingTimeInterval(7 * day)
        )
        check(correctedRoute.nextState.status == .active, "a settled route correction is rediscovered even with the same point count")
        let unavailable = RouteSyncStateMachine.decide(
            existing: settledEmpty, observation: nil, now: end.addingTimeInterval(day)
        )
        check(
            unavailable.shouldQuery && unavailable.nextState == settledEmpty,
            "an unreadable rediscovery never counts as an empty/stable observation or moves its clock"
        )
        let changedWorkout = RouteSyncStateMachine.decide(
            existing: settled, observation: observation(600, "changed"),
            now: end.addingTimeInterval(hour), hasWorkoutChange: true
        )
        check(changedWorkout.shouldQuery && changedWorkout.nextState.status == .active,
              "an anchored workout change bypasses settlement without waiting a week")
        check(
            RouteSyncStateMachine.shouldQuery(existing: cooling, now: end.addingTimeInterval(hour), hasWorkoutChange: true),
            "an anchored workout change also bypasses cooling"
        )
        let unrelatedChange = RouteSyncStateMachine.decide(
            existing: settled, observation: observation(500, "h1"),
            now: end.addingTimeInterval(hour), hasWorkoutChange: true
        )
        check(unrelatedChange.nextState.status == .settled, "a workout-only change does not reset an unchanged route to active")
        check(
            !RouteSyncStateMachine.shouldQuery(existing: settledEmpty, now: end.addingTimeInterval(-day)),
            "a backwards clock does not cause repeated rediscovery"
        )
        // 原始故障链：连续空观测可以降频，但不可以成为永久终止条件。
        var emptyChain = firstLook.nextState
        for time in [25 * hour, 26 * hour, 4 * day] {
            emptyChain = RouteSyncStateMachine.decide(
                existing: emptyChain, observation: observation(0, nil),
                now: end.addingTimeInterval(time)
            ).nextState
        }
        check(emptyChain.status == .settled, "repeated successful zero-point observations can still enter low-frequency settlement")
        let grantedLater = RouteSyncStateMachine.decide(
            existing: emptyChain, observation: observation(1000, "now-authorized"),
            now: end.addingTimeInterval(5 * day)
        )
        check(grantedLater.shouldQuery && grantedLater.nextState.status == .active,
              "late arrival or later read permission recovers automatically after repeated empty observations")

        // ---- 8. 人工重扫：回 active、稳定计数清零、这一轮必查。
        //      清零放在**变化判定之前**是必须的：一条恰好没变的轨迹若保留了旧的
        //      `stableCheckCount`，重扫完的第一轮就又够格降频 —— 那等于没重扫。
        let woken = RouteSyncStateMachine.decide(
            existing: settled,
            observation: observation(500, "h1"),
            now: end.addingTimeInterval(10 * day),
            isForceManualRescan: true
        )
        check(woken.shouldQuery, "a manual rescan always queries")
        check(woken.nextState.status == .active, "a manual rescan resets the status to active")
        check(woken.nextState.stableCheckCount == 0, "a manual rescan wipes the stability count even for an identical look")
        check(
            woken.nextState.lastCheckedAt == end.addingTimeInterval(10 * day),
            "a manual rescan stamps the batch clock"
        )
        let forcedIdentical = RouteSyncStateMachine.decide(
            existing: record(.cooling, checkedAt: end, stable: 5),
            observation: observation(500, "h1"),
            now: end.addingTimeInterval(hour),
            isForceManualRescan: true
        )
        check(
            forcedIdentical.nextState.stableCheckCount == 0 && forcedIdentical.nextState.status == .active,
            "a manual rescan must not let an unchanged route keep its old stability count"
        )

        // ---- 9. 不变式（对全部状态成立）：`shouldQuery == false` ⇒ 状态原样携带。
        //      把它写成一条遍历断言，是为了让以后**新增一个状态**时自动被覆盖 ——
        //      新状态一旦"跳过时也顺手改点什么"，这里立刻红。
        for status in RouteSyncStatus.allCases {
            let candidate = record(status, checkedAt: end, stable: 4)
            let decision = RouteSyncStateMachine.decide(existing: candidate, observation: nil, now: end.addingTimeInterval(hour))
            if decision.shouldQuery { continue }
            check(
                decision.nextState == candidate,
                "a skipped round carries the record unchanged at \(status.rawValue)"
            )
        }

        // ---- 10. 边界：`Decision` 是值语义，两次同样的输入必须给出同样的输出
        //       （管线在"先问要不要查、再拿观测算下一个状态"里调用了两次相邻的逻辑）。
        let deterministicA = RouteSyncStateMachine.decide(
            existing: cooling,
            observation: observation(500, "h1"),
            now: end.addingTimeInterval(12 * hour)
        )
        let deterministicB = RouteSyncStateMachine.decide(
            existing: cooling,
            observation: observation(500, "h1"),
            now: end.addingTimeInterval(12 * hour)
        )
        check(deterministicA == deterministicB, "the machine is a pure function of its inputs")

        // ---- 11. 历史候选有界、轮转且不依赖最近窗口。不可读/已删除的 UUID 不能饿死队列。
        var backlog = (0..<45).map { index in
            RouteSyncRecord(
                workoutUUID: String(format: "history-%03d", index), workoutEndDate: settledEmpty.workoutEndDate,
                status: settledEmpty.status, pointCount: settledEmpty.pointCount, routeHash: settledEmpty.routeHash,
                lastCheckedAt: settledEmpty.lastCheckedAt, stableCheckCount: settledEmpty.stableCheckCount
            )
        }
        let later = end.addingTimeInterval(8 * day)
        func candidates(_ records: [RouteSyncRecord], current: Set<String> = [],
                        changes: Set<String> = [], cursor: String? = nil, limit: Int = 20) -> [String] {
            RouteSyncStateMachine.rediscoveryCandidates(
                existing: records, currentWorkoutUUIDs: current, changedWorkoutUUIDs: changes,
                now: later, cursor: cursor, limit: limit
            )
        }
        let page1 = candidates(backlog)
        let page2 = candidates(backlog, cursor: page1.last)
        let page3 = candidates(backlog, cursor: page2.last)
        check(page1.count == RouteSyncStateMachine.rediscoveryBatchLimit, "one pass admits at most 20 rediscovery candidates")
        check(page2.count == 20 && page3.count == 20, "resumed and wraparound pages respect the same budget")
        check(Set(page1).isDisjoint(with: Set(page2)), "the next pass progresses even if no earlier workout was readable")
        check(
            Set(page1 + page2 + page3) == Set(backlog.map(\.workoutUUID)),
            "three bounded passes visit every old route instead of permanently ignoring historical workouts"
        )
        check(candidates(Array(backlog.reversed())) == page1, "candidate order is deterministic independent of database row order")
        check(candidates(backlog, current: Set(backlog.map(\.workoutUUID))).count == 20,
              "settled routes inside the recent window share the same budget")
        check(candidates(backlog, limit: 0).isEmpty, "a zero budget reads no history")
        check(candidates(backlog, limit: -1).isEmpty, "a negative budget cannot become an unlimited scan")
        backlog[0].status = .active
        backlog[1].status = .cooling
        check(candidates(backlog).contains(backlog[0].workoutUUID), "old active routes also enter the historical queue")
        check(candidates(backlog).contains(backlog[1].workoutUUID), "old cooling routes are not lost when they leave the recent window")
        let current = Set([backlog[0].workoutUUID, backlog[1].workoutUUID])
        let changes = Set([backlog[2].workoutUUID])
        let separate = candidates(backlog, current: current, changes: changes)
        check(Set(separate).isDisjoint(with: current), "current active/cooling workouts use their normal queries, not extra history slots")
        check(Set(separate).isDisjoint(with: changes), "anchored changes use immediate queries, not extra history slots")
        let notDue = record(.settled, checkedAt: later, stable: 4)
        check(candidates([notDue]).isEmpty, "not-yet-due settled routes are not admitted to rediscovery")
        check(candidates(backlog, cursor: "deleted-cursor") == candidates(backlog),
              "a cursor whose row disappeared still has a deterministic next page")

        print("\(checks) route sync state machine checks passed")
    }
}
