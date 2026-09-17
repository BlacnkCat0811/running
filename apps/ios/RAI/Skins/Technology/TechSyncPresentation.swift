/// Presentation precedence only; never changes the underlying sync lifecycle.
enum TechSyncPresentation: Equatable {
    case hidden, busy, failed, cancelled, succeeded, previousSuccess

    static func resolve(phase: String, isBusy: Bool, hasError: Bool, hasSyncDate: Bool) -> Self {
        // Cancellation can precede the task's deferred isBusy reset, and a
        // previous successful sync must not mask the current cancellation.
        if phase == "cancelled" { return .cancelled }
        if isBusy { return .busy }
        if hasError || phase == "failed" { return .failed }
        if hasSyncDate { return phase == "succeeded" ? .succeeded : .previousSuccess }
        return .hidden
    }
}
