import Foundation

/// R3（2026-10-19 复核）：训练窗口的**独立 anchored 分页**。
///
/// ## 为什么不能再靠"固定类型顺序 + recentSamples 第一页"
///
/// 旧窗口通道每批对每个类型都做一次 `recentSamples(limit: 1500)`（时间谓词、无锚点）。
/// 它有两个结构性缺口：
///   1. 高密度窗口里单类型 3,000 条只会反复读到**同一个前缀**，后半永远没有断点；
///   2. 同一时间戳下超过页大小的样本，靠"扩大 limit 再跳过已见 UUID"或"最早时间减一秒"
///      猜下一页都会漏/重，且进程重启后没有任何持久断点。
///
/// 本文件是分页的**纯状态机**：每个键 `(scope, workoutUUID, windowRevision, recordType)`
/// 持有自己的 `HKAnchoredObjectQuery` 锚点（以 `Data` 作不透明载体）。查询与写盘由
/// `HealthKitExport` / `SyncTaskStore` 接线，判据（页接受、EOF、轮转、失败分类）住在这里，
/// 因而可以被纯逻辑回归执行。
///
/// ## 状态闭集
///
/// ```text
/// ready ──page──> paging ──<limit page──> paging
///                    └────EOF(空/不足一页)──> caught_up ──nextCheckAt──> ready
/// ready/paging ──预算或字节放不下──> blocked（保留锚点，下批从同一处继续）
/// 任意未收口 ──7 天──> expired（由执行入口的短事务明确落盘）
/// ```
nonisolated struct WorkoutWindowPageKey: Hashable, Codable, Sendable {
    let scope: String
    let workoutUUID: String
    /// 窗口修订号：窗口扩宽 = 新 revision ⇒ 新分页游标；旧在途 revision 仍可结算。
    let windowRevision: Int
    /// `export.xml` 的记录类型名（如 `HKQuantityTypeIdentifierHeartRate`）。
    let recordType: String
}

nonisolated enum WorkoutWindowPageState: String, Codable, CaseIterable, Sendable {
    /// 还没有已确认锚点，可以开始读第一页。
    case ready
    /// 已确认锚点之后还有页（本批被预算/字节挡下，或页恰好满）。
    case paging
    /// 本次已经读到 EOF。**不代表未来不会来数据**：到 `nextCheckAt` 或对应类型通知时
    /// 继续沿同一个 anchor 读增量。
    case caughtUp = "caught_up"
    /// 有明确原因（字节放不下 / 授权失败等）的退避。
    case retryWait = "retry_wait"
    /// 连最小页都装不下 / 不可读：不进入无限续批。
    case blocked
    /// 7 天到期，由执行入口结算；不删除正式游标，也不丢已入库事实。
    case expired
}

/// 一条分页游标的**已确认**状态（`sync_workout_type_pages` 一行）。
nonisolated struct WorkoutWindowPage: Codable, Equatable, Sendable {
    let key: WorkoutWindowPageKey
    /// 规范化谓词（窗口 + 类型 + padding + 谓词版本）。窗口扩宽 ⇒ revision 变 ⇒ 新行。
    let predicateJSON: String
    var committedAnchor: Data?
    var state: WorkoutWindowPageState
    var nextCheckAt: Date?
    var lastServedAt: Date?
    var eofObservedAt: Date?
    var lastErrorCode: String?

    var isImmediate: Bool { state == .ready || state == .paging }

    /// 现在该不该轮到这个键（`caught_up` 要等 `nextCheckAt`）。
    func isServiceable(now: Date) -> Bool {
        switch state {
        case .ready, .paging:
            return true
        case .caughtUp, .retryWait:
            return (nextCheckAt ?? .distantPast) <= now
        case .blocked, .expired:
            return false
        }
    }
}

/// 一次页读取之后**准备提交**的分页进度（先放任务行，拿到 committed 回执后才落库）。
nonisolated struct WorkoutWindowPageCommit: Codable, Equatable, Sendable {
    let key: WorkoutWindowPageKey
    /// 规范化谓词（随行落盘；窗口 revision 变化会生成新 key，不复用旧谓词）。
    let predicateJSON: String
    /// 导出开始时读到的已确认锚点。提交前必须仍等于它（比较写入的判据）。
    let expectedAnchor: Data?
    /// 本页接受后应提交的锚点。
    let committedAnchor: Data?
    let state: WorkoutWindowPageState
    let nextCheckAt: Date?
    let servedAt: Date?
    let eofObservedAt: Date?
    let lastErrorCode: String?
}

/// R3 的纯判据集合。
nonisolated enum WorkoutWindowPaging {
    /// 谓词形态版本：改窗口/类型的谓词语义时必须递增（旧行按新语义解读就是漏数据）。
    static let predicateVersion = 1

    /// 窗口修订号。窗口**变宽**（`nextCheckAt` 之外的 windowStart/windowEnd 变化）⇒ 新数字。
    ///
    /// 用时间位的确定性混合，不用进程内哈希（Swift `Hasher` 每进程随机，跨进程会分叉）。
    static func windowRevision(_ window: WorkoutBackfillWindow) -> Int {
        let start = window.windowStart.timeIntervalSinceReferenceDate.bitPattern
        let end = window.windowEnd.timeIntervalSinceReferenceDate.bitPattern
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for value in [start, end] {
            var mutated = value
            for _ in 0..<8 {
                hash ^= UInt64(mutated & 0xff)
                hash = hash &* 0x0000_0100_0000_01b3
                mutated >>= 8
            }
        }
        return Int(bitPattern: UInt(hash & 0x7fff_ffff_ffff_ffff))
    }

    /// 规范化谓词 JSON。**确定性**（键排序 + 秒级 REAL 规范化）：
    /// 同一窗口两次编码逐字节相同，分页行才能用 `predicate_json` 做 revision/口径对账。
    static func predicateJSON(
        window: WorkoutBackfillWindow,
        recordType: String
    ) -> String {
        let payload: [String: Any] = [
            "version": predicateVersion,
            "recordType": recordType,
            "windowStart": window.windowStart.timeIntervalSince1970,
            "windowEnd": window.windowEnd.timeIntervalSince1970,
            "options": "strictStartDate"
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return "{\"version\":\(predicateVersion),\"recordType\":\"\(recordType)\"}"
        }
        return text
    }

    /// 为一条窗口 + 一个类型创建初始页（没有已确认锚点）。
    static func initialPage(
        scope: String,
        window: WorkoutBackfillWindow,
        recordType: String
    ) -> WorkoutWindowPage {
        WorkoutWindowPage(
            key: WorkoutWindowPageKey(
                scope: scope,
                workoutUUID: window.workoutUUID,
                windowRevision: windowRevision(window),
                recordType: recordType
            ),
            predicateJSON: predicateJSON(window: window, recordType: recordType),
            committedAnchor: nil,
            state: .ready,
            nextCheckAt: nil,
            lastServedAt: nil,
            eofObservedAt: nil,
            lastErrorCode: nil
        )
    }

    /// 公平轮转：每个窗口类型先发一个有界页，再轮到下一个类型。
    ///
    /// 排序键 = `lastServedAt`（从未服务的最先，其后最早服务的最先），同龄按类型名稳定排序。
    /// **不能每次重启都回到心率**：旧实现每批都从固定类型序开始，预算总被前几个高频类型用光。
    static func serviceOrder(
        _ pages: [WorkoutWindowPage],
        now: Date
    ) -> [WorkoutWindowPage] {
        pages
            .filter { $0.isServiceable(now: now) }
            .sorted { lhs, rhs in
                let left = lhs.lastServedAt ?? .distantPast
                let right = rhs.lastServedAt ?? .distantPast
                if left != right { return left < right }
                return lhs.key.recordType < rhs.key.recordType
            }
    }

    /// 页被**完整接受**（整页已进载荷）后的候选提交。
    ///
    /// - `nextAnchor == nil`：HealthKit 没给候选锚点。此时不得把已确认游标推进到不可验证的
    ///   位置，也不得伪造 EOF —— 分类为 `retry_wait`，下一批从同一处重试。
    static func afterAcceptedPage(
        _ page: WorkoutWindowPage,
        observed: Int,
        pageLimit: Int,
        nextAnchor: Data?,
        now: Date
    ) -> WorkoutWindowPageCommit {
        guard let nextAnchor else {
            return WorkoutWindowPageCommit(
                key: page.key,
                predicateJSON: page.predicateJSON,
                expectedAnchor: page.committedAnchor,
                committedAnchor: page.committedAnchor,
                state: .retryWait,
                nextCheckAt: now.addingTimeInterval(WorkoutBackfillScheduler.retryInterval(attempts: 1)),
                servedAt: now,
                eofObservedAt: page.eofObservedAt,
                lastErrorCode: "missing_page_anchor"
            )
        }
        let fullPage = pageLimit > 0 && observed >= pageLimit
        return WorkoutWindowPageCommit(
            key: page.key,
            predicateJSON: page.predicateJSON,
            expectedAnchor: page.committedAnchor,
            committedAnchor: nextAnchor,
            state: fullPage ? .paging : .caughtUp,
            nextCheckAt: fullPage ? nil : nextProbeDate(now: now),
            servedAt: now,
            eofObservedAt: fullPage ? page.eofObservedAt : now,
            lastErrorCode: nil
        )
    }

    /// 空结果（或删除-only 页）之后的候选提交。
    ///
    /// 🔴 空结果**不是**"这条训练没有该类型"：它只证明"本次 EOF"。`caughtUp` 仍保留 anchor，
    /// 到下一次 `nextCheckAt` 或对应类型通知时继续读增量 —— 迟到样本正是靠这条路径补进来的。
    /// 删除-only 页（`deleted > 0`）**不是 EOF**：本批没有新增载荷，但删除事件本身必须
    /// 继续由正式记录流交付；这里只推进窗口分页锚点并保持 `paging`，避免同一页原地重读。
    static func afterEmptyPage(
        _ page: WorkoutWindowPage,
        nextAnchor: Data?,
        deletedCount: Int,
        now: Date
    ) -> WorkoutWindowPageCommit {
        guard let nextAnchor else {
            return WorkoutWindowPageCommit(
                key: page.key,
                predicateJSON: page.predicateJSON,
                expectedAnchor: page.committedAnchor,
                committedAnchor: page.committedAnchor,
                state: .retryWait,
                nextCheckAt: now.addingTimeInterval(WorkoutBackfillScheduler.retryInterval(attempts: 1)),
                servedAt: now,
                eofObservedAt: page.eofObservedAt,
                lastErrorCode: "missing_page_anchor"
            )
        }
        if deletedCount > 0 {
            return WorkoutWindowPageCommit(
                key: page.key,
                predicateJSON: page.predicateJSON,
                expectedAnchor: page.committedAnchor,
                committedAnchor: nextAnchor,
                state: .paging,
                nextCheckAt: nil,
                servedAt: now,
                eofObservedAt: page.eofObservedAt,
                lastErrorCode: nil
            )
        }
        return WorkoutWindowPageCommit(
            key: page.key,
            predicateJSON: page.predicateJSON,
            expectedAnchor: page.committedAnchor,
            committedAnchor: nextAnchor,
            state: .caughtUp,
            nextCheckAt: nextProbeDate(now: now),
            servedAt: now,
            eofObservedAt: now,
            lastErrorCode: nil
        )
    }

    /// 页放不下（预算/字节）：**不写、不推进**，同 anchor 缩页重查；连最小页都放不下才 blocked。
    static func afterRejectedPage(
        _ page: WorkoutWindowPage,
        canShrink: Bool,
        reason: String,
        now: Date
    ) -> WorkoutWindowPageCommit {
        WorkoutWindowPageCommit(
            key: page.key,
            predicateJSON: page.predicateJSON,
            expectedAnchor: page.committedAnchor,
            committedAnchor: page.committedAnchor,
            state: canShrink ? .blocked : .retryWait,
            nextCheckAt: canShrink ? nil : now.addingTimeInterval(WorkoutBackfillScheduler.retryInterval(attempts: 1)),
            servedAt: now,
            eofObservedAt: page.eofObservedAt,
            lastErrorCode: reason
        )
    }

    /// 授权失败：不是空页，是"不知道"。作废本页的稳定/EOF 证据，按原因退避。
    static func afterUnauthorizedPage(
        _ page: WorkoutWindowPage,
        now: Date
    ) -> WorkoutWindowPageCommit {
        WorkoutWindowPageCommit(
            key: page.key,
            predicateJSON: page.predicateJSON,
            expectedAnchor: page.committedAnchor,
            committedAnchor: page.committedAnchor,
            state: .retryWait,
            nextCheckAt: now.addingTimeInterval(WorkoutBackfillScheduler.retryInterval(attempts: 1)),
            servedAt: now,
            eofObservedAt: page.eofObservedAt,
            lastErrorCode: "unauthorized"
        )
    }

    /// `caught_up`/`retry_wait` 的下一次复查时刻：沿用既有重试阶梯（15m/1h/6h/24h/72h）。
    /// 用固定第一档而不是逐次累加：窗口本身已有 `attemptCount`/7 天上限，分页层不再造一份退避。
    static func nextProbeDate(now: Date) -> Date {
        now.addingTimeInterval(WorkoutBackfillScheduler.retryIntervals[0])
    }
}
