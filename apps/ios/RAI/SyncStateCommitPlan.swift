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
