import Foundation

/// R3（2026-10-19 复核）：训练窗口 anchored 分页的**纯状态机**回归。
///
/// 钉的是那些"改错了照样编译通过、只有真机数据攒到一定密度才显形"的判据：
///   - 窗口扩宽必须换 revision（旧锚点不能套到新谓词上）；
///   - 满页是 `paging`、不足一页才是 EOF；缺候选锚点时**不推进**：
///   - 空结果不是"设备没有该类型"；删除-only 页不是 EOF；
///   - 轮转按 `lastServedAt` 公平，`caught_up` 到期才重新服务。
@main
struct WorkoutWindowPagingRegression {
    static func main() {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let window = WorkoutBackfillWindow(
            workoutUUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            windowStart: now.addingTimeInterval(-30 * 60),
            windowEnd: now.addingTimeInterval(30 * 60),
            createdAt: now.addingTimeInterval(-3600),
            nextCheckAt: now,
            attemptCount: 1,
            lastSampleCount: 0,
            stableCount: 0,
            completedAt: nil
        )
        let type = "HKQuantityTypeIdentifierHeartRate"

        // revision：同一窗口稳定；窗口变宽必须换号（旧游标不得套新谓词）。
        let revision = WorkoutWindowPaging.windowRevision(window)
        check(
            WorkoutWindowPaging.windowRevision(window) == revision,
            "the same window yields a stable revision"
        )
        var widened = window
        widened.windowEnd = window.windowEnd.addingTimeInterval(10 * 60)
        check(
            WorkoutWindowPaging.windowRevision(widened) != revision,
            "a widened window must change the paging revision"
        )
        // revision 必须跨进程稳定（不能用 Swift Hasher）：同一输入两次独立调用逐位相同。
        check(
            WorkoutWindowPaging.windowRevision(widened) == WorkoutWindowPaging.windowRevision(widened),
            "the revision is deterministic (no per-process hash seed)"
        )

        let predicate = WorkoutWindowPaging.predicateJSON(window: window, recordType: type)
        check(
            predicate.contains("\"version\":1") && predicate.contains(type),
            "the predicate JSON records the version and record type"
        )
        check(
            predicate == WorkoutWindowPaging.predicateJSON(window: window, recordType: type),
            "the predicate JSON encoding is byte-deterministic"
        )

        let initial = WorkoutWindowPaging.initialPage(
            scope: "scope-a", window: window, recordType: type
        )
        check(
            initial.state == .ready && initial.committedAnchor == nil
                && initial.key.windowRevision == revision
                && initial.key.scope == "scope-a",
            "an initial page starts ready with no committed anchor"
        )

        // 页被完整接受：满页 ⇒ paging（还有下一页），不足一页 ⇒ caughtUp（EOF）。
        let fullPageCommit = WorkoutWindowPaging.afterAcceptedPage(
            initial, observed: 1500, pageLimit: 1500,
            nextAnchor: Data([0x01, 0x02]), now: now
        )
        check(
            fullPageCommit.state == .paging && fullPageCommit.committedAnchor == Data([0x01, 0x02])
                && fullPageCommit.nextCheckAt == nil
                && fullPageCommit.expectedAnchor == nil,
            "a full page advances the candidate anchor and stays paging"
        )
        let partialPageCommit = WorkoutWindowPaging.afterAcceptedPage(
            initial, observed: 42, pageLimit: 1500,
            nextAnchor: Data([0x03]), now: now
        )
        check(
            partialPageCommit.state == .caughtUp
                && partialPageCommit.nextCheckAt == WorkoutWindowPaging.nextProbeDate(now: now)
                && partialPageCommit.eofObservedAt == now,
            "a short page is EOF for this probe and schedules a future check"
        )
        let missingAnchorCommit = WorkoutWindowPaging.afterAcceptedPage(
            initial, observed: 42, pageLimit: 1500, nextAnchor: nil, now: now
        )
        check(
            missingAnchorCommit.state == .retryWait
                && missingAnchorCommit.committedAnchor == nil
                && missingAnchorCommit.lastErrorCode == "missing_page_anchor",
            "a non-empty page without a candidate anchor must not advance the cursor"
        )

        // 空结果 / 删除-only 页：空结果可以 caughtUp（本次 EOF），删除-only 不是 EOF。
        let emptyCommit = WorkoutWindowPaging.afterEmptyPage(
            initial, nextAnchor: Data([0x04]), deletedCount: 0, now: now
        )
        check(
            emptyCommit.state == .caughtUp && emptyCommit.committedAnchor == Data([0x04]),
            "an empty anchored page records EOF at the returned anchor"
        )
        let deletionOnlyCommit = WorkoutWindowPaging.afterEmptyPage(
            initial, nextAnchor: Data([0x05]), deletedCount: 3, now: now
        )
        check(
            deletionOnlyCommit.state == .paging && deletionOnlyCommit.committedAnchor == Data([0x05]),
            "a deletion-only page advances the cursor but is not EOF"
        )
        let unauthorized = WorkoutWindowPaging.afterUnauthorizedPage(initial, now: now)
        check(
            unauthorized.state == .retryWait && unauthorized.lastErrorCode == "unauthorized"
                && unauthorized.committedAnchor == initial.committedAnchor,
            "authorization failure backs off without advancing the anchor"
        )
        let rejected = WorkoutWindowPaging.afterRejectedPage(
            initial, canShrink: false, reason: "page_bytes", now: now
        )
        check(
            rejected.state == .retryWait && rejected.lastErrorCode == "page_bytes"
                && rejected.committedAnchor == initial.committedAnchor,
            "an unshrinkable page backs off instead of spinning"
        )

        // 服务顺序：从未服务的最先；caught_up 未到期不服务、到期才服务；blocked/expired 不服务。
        let older = Date(timeIntervalSince1970: 100)
        let newer = Date(timeIntervalSince1970: 200)
        func page(_ recordType: String, state: WorkoutWindowPageState,
                  nextCheckAt: Date? = nil, lastServedAt: Date? = nil) -> WorkoutWindowPage {
            WorkoutWindowPage(
                key: WorkoutWindowPageKey(
                    scope: "scope-a", workoutUUID: window.workoutUUID,
                    windowRevision: revision, recordType: recordType
                ),
                predicateJSON: "{}",
                committedAnchor: nil,
                state: state,
                nextCheckAt: nextCheckAt,
                lastServedAt: lastServedAt,
                eofObservedAt: nil,
                lastErrorCode: nil
            )
        }
        let order = WorkoutWindowPaging.serviceOrder([
            page(type, state: .paging, lastServedAt: newer),
            page("type-never-served", state: .ready),
            page("type-caught-up-future", state: .caughtUp, nextCheckAt: now.addingTimeInterval(60 * 60)),
            page("type-caught-up-due", state: .caughtUp,
                 nextCheckAt: now.addingTimeInterval(-1), lastServedAt: older),
            page("type-blocked", state: .blocked),
            page("type-expired", state: .expired)
        ], now: now)
        check(
            order.map(\.key.recordType) == ["type-never-served", "type-caught-up-due", type],
            "service order is fair: never-served first, caught_up only when due, blocked/expired excluded"
        )
        // 两个同龄（都有 lastServedAt）⇒ 更早服务的先；同龄按类型名稳定。
        let sameAge = WorkoutWindowPaging.serviceOrder([
            page("zzz", state: .paging, lastServedAt: older),
            page("aaa", state: .paging, lastServedAt: older)
        ], now: now)
        check(
            sameAge.map(\.key.recordType) == ["aaa", "zzz"],
            "ties in lastServedAt break deterministically by record type"
        )

        // 页候选必须带上前驱锚点（CAS 的依据）与规范化谓词（窗口扩宽后不复用旧谓词）。
        check(
            partialPageCommit.expectedAnchor == nil
                && partialPageCommit.predicateJSON == initial.predicateJSON
                && partialPageCommit.servedAt == now,
            "a page commit carries the predecessor anchor, predicate and served time"
        )
        var advanced = initial
        advanced.committedAnchor = Data([0x09])
        let secondCommit = WorkoutWindowPaging.afterAcceptedPage(
            advanced, observed: 1500, pageLimit: 1500, nextAnchor: Data([0x0A]), now: now
        )
        check(
            secondCommit.expectedAnchor == Data([0x09])
                && secondCommit.committedAnchor == Data([0x0A]),
            "the next page commit is chained to the previous committed anchor"
        )

        print("\(checks) workout window paging regression checks passed")
    }
}
