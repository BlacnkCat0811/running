import Foundation

/// 「这次成功收尾该把导出水位写成什么」——三态，不是布尔。
///
/// 为什么非要有第三态：原先这件事被拆成**两次**调用 —— `markSuccess(advanceWatermark:)`
/// 负责"前进"，`clearExportWatermark()` 负责"清空"，而后者写的是 `UserDefaults`、
/// 前者写 anchor 时会进 SQLite。两次调用之间是一条崩溃窗口，且方向很坏：
/// 水位清了、任务行还在 ⇒ 下一次同步按"无水位"重导一段**已经成功导入过**的窗口。
/// 收进一次提交之后，"清空"也必须是提交的一部分，于是它就得能在同一个位置上被表达。
///
/// 三个 case 的语义（**必须**与 `HealthKitSync.markSuccess` 改造前的行为逐字一致）：
///   - `.keep`：不动。原代码里"`advanceWatermark == true` 但 `exportEnd == nil`"落到这里
///     （`if advanceWatermark, let exportEnd` 不成立 ⇒ 一个字节都不写）。
///   - `.advance(date)`：前进，且**只许前进**（单调性由 SQL 里的 `CASE` 保证，
///     不是靠调用方先读后比 —— 那是两段之间的竞态）。
///   - `.clear`：显式清空。原代码里"`restored.exportEnd == nil` ⇒ `clearExportWatermark()`"。
nonisolated enum SyncWatermarkUpdate: Equatable, Sendable {
    case keep
    case advance(Date)
    case clear
}

/// 成功收尾的两条判据。纯函数、只依赖 Foundation + `SyncPhase`，因此**有执行者**
/// （`run-health-sync-tests.sh` 第 7 个编译单元）。
///
/// 这个类型存在的理由很具体：`SyncPhase.mayAdvanceAnchor` 此前**没有任何生产调用点** ——
/// 它只有定义、一处转发、以及一条自比式回归（断言 `mayAdvanceAnchor(p) == !p.isBlocked`，
/// 而实现就是 `!blocked.contains(p)` ⇒ 那条断言只在实现自相矛盾时才可能红）。
/// 换句话说「阻塞态绝不推进 anchor」这条不变式当时是**写着好看**的：
/// 真正拦住它的是 `performSync` 里两处提前 `return`，而那两处是**另一件事**的副产品。
/// 把判据挂到这里，它才第一次出现在 anchor 的写入路径上。
nonisolated enum SyncStateCommitPlan {
    /// 这次成功收尾允不允许推进 anchor。
    ///
    /// 阻塞态（`deferred_protected_data` / `auth_required`）一律不许：那两种状态下
    /// **我们根本没读到数据**，把"没读到"当成"没有变化"去推进水位，会让那段健康数据
    /// 从此再也不出现在任何一次导出里（`HealthKitExport.swift` 的锚定查询只回传
    /// anchor 之后的新增）。
    static func mayCommit(phase: SyncPhase) -> Bool {
        SyncPhase.mayAdvanceAnchor(phase)
    }

    /// 把「前进 / 清空 / 不动」这三个意图析出成一个值，供提交一次写下去。
    ///
    /// - Parameters:
    ///   - advance: 调用方是否要求前进（`markSuccess(advanceWatermark:)`）。
    ///   - clear: 调用方是否要求清空（原先的 `clearExportWatermark()`）。
    ///   - exportEnd: 本次导出实际覆盖到的时间点。
    static func watermark(advance: Bool, clear: Bool, exportEnd: Date?) -> SyncWatermarkUpdate {
        if advance, let exportEnd { return .advance(exportEnd) }
        if clear { return .clear }
        return .keep
    }
}

/// 落盘时间的规范化。
///
/// 🔴 为什么必须有这一步（2026-09-24 真机故障的根因）：
///
/// `sync_state.export_end` 与 `sync_route_state` 的两个时间列都是 REAL，写入走
/// `Date.timeIntervalSince1970`、读回走 `Date(timeIntervalSince1970:)`。而 `Date` 内部
/// 存的是 `timeIntervalSinceReferenceDate`，两者差常量 978307200 —— 这个映射**不是双射**：
/// 对 2026 年的时间戳，结果与常量之比 ≈ 1.8（< 2），加法那一步落在 Sterbenz 引理的邻居
/// 情形上，结果的 ulp 会被放大到原值网格的 2 倍，于是原值最低位为 1 的那些时间戳
/// **会被舍掉一位**。读回来的 `Date` 因此与写进去的那个不是同一个值。
///
/// 实测（本机 Xcode 26.5 / Swift，逐 ulp 扫 200,000 个真实时间戳）：
///   - 往返有损：**100000 / 200000**（恰好一半）
///   - 整秒时间戳：**0 / 200000**（无损）
///   - `Date()` 的当前值：**有损**
///
/// 后果：`HealthKitExport` 的 `exportedThrough = Date()` 与 route 的 `routeNow = Date()`
/// 都带完整小数秒 ⇒ `readBackMatches` 拿**原始 Date** 去比读回来的 Date，约一半概率判为
/// 不等 ⇒ 一次完全成功的提交被整段回滚，用户看到「同步水位写入后无法读回一致的值」。
/// 而现有回归的 fixture 恰好是整数秒（`1_700_000_000`）⇒ 它**永远绿**。这正是
/// 「跑绿 ≠ 断言有效」的形态：fixture 的值落在无损区，守卫对它完全不可见。
///
/// 修法：写入前把时间点吸附到该映射的**不动点**上。此后
/// `Date(timeIntervalSince1970: y).timeIntervalSince1970 == y` 恒成立，
/// 写入值与回读值逐位相等。代价是时间点被吸附到约 1e-7 秒的网格上 ——
/// 对"上次导出到哪儿 / 上次查过没有"这两个语义都无关紧要。
nonisolated extension Date {
    /// 把时间点吸附到「REAL 列能逐位往返」的那一个值上。
    var canonicalForREAL: Date {
        // 正常时间戳（与常量之比 < 2）一次即到不动点；多迭代两次是给 `.distantPast`
        // 这类极端值兜底 —— 那里 |r| / |C| ≈ 64，Sterbenz 的前提不成立，第一次投影
        // 未必已经稳定。迭代上限刻意写死：这个函数在写入路径上，不能有无界循环。
        var value = self
        for _ in 0..<3 {
            let roundTripped = Date(timeIntervalSince1970: value.timeIntervalSince1970)
            if roundTripped == value { return value }
            value = roundTripped
        }
        return value
    }
}

nonisolated extension SyncWatermarkUpdate {
    /// 让 `.advance` 的时间点先过一遍 `Date.canonicalForREAL`。
    ///
    /// 必须在**写入之前、且只发生一次**：`upsertState` 绑定的 `?3` 与 `readBackMatches`
    /// 算出的期望值必须来自同一个数，否则两侧仍会在最后一位上分叉 ——
    /// 而"两侧独立算一次、指望它们恰好一致"正是这次故障的形状。
    var storedInREAL: SyncWatermarkUpdate {
        switch self {
        case .keep, .clear: return self
        case .advance(let end): return .advance(end.canonicalForREAL)
        }
    }
}
