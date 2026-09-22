/// Presentation precedence only; never changes the underlying sync lifecycle.
enum TechSyncPresentation: Equatable {
    case hidden, busy, failed, cancelled, succeeded, previousSuccess, pending

    /// 顺序即优先级。`hasPendingTask` 带默认值，是为了让调用点与既有断言不必逐个改 ——
    /// 但**它不能有第二个含义**：只表示"磁盘上那份进度行还在"。
    static func resolve(
        phase: String,
        isBusy: Bool,
        hasError: Bool,
        hasSyncDate: Bool,
        hasPendingTask: Bool = false
    ) -> Self {
        // Cancellation can precede the task's deferred isBusy reset, and a
        // previous successful sync must not mask the current cancellation.
        if phase == "cancelled" { return .cancelled }
        if isBusy { return .busy }
        if hasError || phase == "failed" { return .failed }
        // 「还有一批没走完」必须排在历史之**前**。
        //
        // 不加这一条时的可见后果：一次生命周期中断（或进程被杀）之后，`phase` 已经回到
        // `idle` 或停在 `exported`/`uploaded`，而 `lastSyncAt` 是上一次成功的时间 ——
        // 界面于是显示"上次健康同步 12:30"，读起来像一切正常，磁盘上却卡着一批没发出去的数据。
        // 与 `.failed` 的分工：`.failed` 是"这一趟明确失败了"，`.pending` 是"这一趟没跑完，
        // 下次接着跑"—— 后者不需要用户做任何事，所以不能报成失败。
        if hasPendingTask { return .pending }
        if hasSyncDate { return phase == "succeeded" ? .succeeded : .previousSuccess }
        return .hidden
    }
}
