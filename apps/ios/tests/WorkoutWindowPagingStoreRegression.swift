import Foundation

/// R3（2026-10-19 复核）：训练窗口分页游标在**真实 SQLite 库**上的提交语义。
///
/// 钉三件事：
///   1. 页进度只在 `commitSuccess` 的**同一事务**里、随任务行删除一起提交；
///   2. 提交是**有条件**的（前驱锚点必须一致）：陈旧候选只跳过、绝不覆盖更新进度；
///   3. 纯空观察走窄事务（`commitEmptyWorkoutPageObservations`），不推进正式游标、
///      也不依赖上传回执。
@main
struct WorkoutWindowPagingStoreRegression {
    static func main() {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }
        func require(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-page-store-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SyncTaskStore(directory: directory)
        check(store.isAvailable, "the page-store regression journal is available")
        let scope = "scope-a"
        let workout = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        let type = "HKQuantityTypeIdentifierHeartRate"
        // 分页行必须挂在一条**活着的窗口**上（探针只统计仍会被查询的 revision）。
        var window = WorkoutBackfillWindow(
            workoutUUID: workout,
            windowStart: now.addingTimeInterval(-30 * 60),
            windowEnd: now.addingTimeInterval(30 * 60),
            createdAt: now.addingTimeInterval(-3600),
            nextCheckAt: now,
            attemptCount: 1,
            lastSampleCount: 0,
            stableCount: 0,
            completedAt: nil
        )
        let revision = WorkoutWindowPaging.windowRevision(window)
        require(store.upsertWorkoutBackfillWindows([window], scope: scope),
                "the paging fixtures persisted their live workout window")

        func key(_ recordType: String = type) -> WorkoutWindowPageKey {
            WorkoutWindowPageKey(
                scope: scope, workoutUUID: workout,
                windowRevision: revision, recordType: recordType
            )
        }
        func commit(
            recordType: String = type,
            expected: Data?,
            anchor: Data?,
            state: WorkoutWindowPageState,
            nextCheckAt: Date? = nil
        ) -> WorkoutWindowPageCommit {
            WorkoutWindowPageCommit(
                key: key(recordType),
                predicateJSON: "{\"version\":1,\"recordType\":\"\(recordType)\"}",
                expectedAnchor: expected,
                committedAnchor: anchor,
                state: state,
                nextCheckAt: nextCheckAt,
                servedAt: now,
                eofObservedAt: state == .caughtUp ? now : nil,
                lastErrorCode: nil
            )
        }

        // 首次应用（盘上没有行、候选期望 nil）。
        let firstAnchor = Data([0x01])
        check(
            store.commitEmptyWorkoutPageObservations(
                [commit(expected: nil, anchor: firstAnchor, state: .paging)],
                scope: scope
            ),
            "the first page cursor commit applies"
        )
        var pages = store.loadWorkoutWindowPages(scope: scope)
        check(
            pages[key()]?.committedAnchor == firstAnchor
                && pages[key()]?.state == .paging
                && pages[key()]?.predicateJSON.contains("version") == true,
            "the committed anchor, state and predicate round-trip through SQLite"
        )
        let probe = store.probeWorkoutWindowWork(scope: scope, now: now)
        check(
            probe?.immediatePageCount == 1,
            "a paging cursor is reported as immediate work by the read-only probe"
        )
        // 陈旧候选（期望 nil，但盘上已经是 firstAnchor）⇒ 只跳过、不倒退。
        check(
            store.commitEmptyWorkoutPageObservations(
                [commit(expected: nil, anchor: Data([0xEE]), state: .caughtUp)],
                scope: scope
            ),
            "a stale candidate is skipped without failing the transaction"
        )
        pages = store.loadWorkoutWindowPages(scope: scope)
        check(
            pages[key()]?.committedAnchor == firstAnchor
                && pages[key()]?.state == .paging,
            "a stale candidate cannot overwrite the newer committed anchor"
        )

        // 页进度只能随 commitSuccess 一起提交（任务行删除 + 锚点推进同一事务）。
        let secondAnchor = Data([0x02])
        check(store.save(Data("task".utf8), scope: scope), "a resumable task row was persisted")
        check(
            store.commitSuccess(
                scope: scope,
                anchor: nil,
                watermark: .keep,
                workoutPageCommits: [commit(expected: firstAnchor, anchor: secondAnchor, state: .caughtUp,
                                            nextCheckAt: now.addingTimeInterval(900))]
            ),
            "commitSuccess applies the page candidates in its own transaction"
        )
        pages = store.loadWorkoutWindowPages(scope: scope)
        check(
            pages[key()]?.committedAnchor == secondAnchor
                && pages[key()]?.state == .caughtUp
                && pages[key()]?.eofObservedAt == now,
            "the page cursor commits together with the successful batch"
        )
        check(store.hasTask(scope: scope) == false, "commitSuccess still removes the task row")
        check(
            store.probeWorkoutWindowWork(scope: scope, now: now)?.immediatePageCount == 0,
            "a caught_up cursor is not immediate work"
        )

        // 任务行存在时，陈旧分页候选同样只跳过；事实提交不能被本地页游标竞争连带失败。
        check(store.save(Data("task2".utf8), scope: scope), "a second task row was persisted")
        check(
            store.commitSuccess(
                scope: scope,
                anchor: nil,
                watermark: .keep,
                workoutPageCommits: [
                    commit(expected: firstAnchor, anchor: Data([0xFF]), state: .paging)
                ]
            ),
            "commitSuccess succeeds even when a stale page candidate is skipped"
        )
        pages = store.loadWorkoutWindowPages(scope: scope)
        check(
            pages[key()]?.committedAnchor == secondAnchor,
            "a stale candidate inside commitSuccess never overwrites newer progress"
        )
        check(store.hasTask(scope: scope) == false, "the stale candidate still lets the task row clear")

        // scope 隔离：另一个 scope 读不到这一行。
        check(
            store.loadWorkoutWindowPages(scope: "scope-b").isEmpty,
            "page cursors are scoped"
        )

        // 空观察窄事务：不推进正式 anchor（`sync_state` 逐字段不变），只写页游标。
        let stateBeforeEmptyCommit = store.loadState(scope: scope)
        let emptyAnchor = Data([0x03])
        check(
            store.commitEmptyWorkoutPageObservations(
                [commit(recordType: "HKQuantityTypeIdentifierRunningPower",
                        expected: nil, anchor: emptyAnchor, state: .caughtUp,
                        nextCheckAt: now.addingTimeInterval(900))],
                scope: scope
            ),
            "an empty-query observation commits through the narrow transaction"
        )
        check(
            store.loadState(scope: scope) == stateBeforeEmptyCommit,
            "the narrow empty-observation transaction never changes the formal sync watermark"
        )
        pages = store.loadWorkoutWindowPages(scope: scope)
        check(
            pages[key("HKQuantityTypeIdentifierRunningPower")]?.committedAnchor == emptyAnchor,
            "the empty observation advances only the per-type window cursor"
        )

        // 窗口扩宽 ⇒ revision 变 ⇒ 旧 revision 的分页行在同一事务里被清掉；
        // 否则探针会永远把旧行当成"立即工作"（后台空转）。
        let oldRevision = revision
        window.windowEnd = window.windowEnd.addingTimeInterval(10 * 60)
        window.nextCheckAt = now
        window.attemptCount = 0
        window.types = [:]
        require(store.upsertWorkoutBackfillWindows([window], scope: scope),
                "a widened window is registered")
        let newRevision = WorkoutWindowPaging.windowRevision(window)
        require(newRevision != oldRevision, "the widened window changed its revision")
        pages = store.loadWorkoutWindowPages(scope: scope)
        require(
            pages.keys.allSatisfy { $0.windowRevision == newRevision },
            "widening a window prunes every stale-revision page cursor"
        )
        require(
            store.probeWorkoutWindowWork(scope: scope, now: now)?.immediatePageCount == 0,
            "no stale-revision page can keep the probe reporting immediate work"
        )

        // 不可用库：所有分页读写都必须明确失败，而不是假装成功。
        let broken = SyncTaskStore(directory: URL(fileURLWithPath: "/dev/null/not-a-directory"))
        require(
            broken.commitEmptyWorkoutPageObservations(
                [commit(expected: nil, anchor: Data([0x01]), state: .paging)], scope: scope
            ) == false,
            "an unavailable journal cannot commit page cursors"
        )
        require(
            broken.loadWorkoutWindowPages(scope: scope).isEmpty,
            "an unavailable journal reads no page cursors"
        )

        print("\(checks) workout window page store regression checks passed")
    }
}
