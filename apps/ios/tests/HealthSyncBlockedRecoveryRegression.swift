import Foundation

/// 锁屏 / 凭证阻塞的回归（V2.1 规范 §3.3 与 §3.4）。
///
/// 为什么这些判据必须住在这里：它们的调用点是 `HealthKitSync.performSync`、
/// `HealthKitSync.uploadWithRecovery` 与 `RaiStartup.observeProtectedDataAvailability`，
/// 而这三处所在的文件**都不被任何回归编译** —— 判据留在那里就只能靠结构门禁做字面匹配，
/// 证得了"有没有写"，证不了"算出来是什么"（本仓已为此付过代价，见 `HealthSyncLifecycle.swift`）。
///
/// 钉的是四件事：
///   1. 两个阻塞阶段的落点与**已存储的原始值**（老 payload 会按它解码，改名 = 静默降级成 idle）；
///   2. 🔴 **阻塞态绝不推进 anchor** —— §3.4 原文禁止的正是"把读不到当成没有数据"；
///   3. 阻塞态**不是终态**，且经生命周期中止后仍被原样保留（否则"等解锁"会退化成 idle，
///      用户解锁后什么都不会发生）；
///   4. 恢复判据不误触发：不在阻塞态时收到解锁 / 凭证事件**不得**触发同步
///      （否则每次解锁都白读一次 HealthKit，而那是整个流程里最贵的一步）。
@main
struct HealthSyncBlockedRecoveryRegression {
    static func main() throws {
        try blockedPhasesHaveStableStoredValues()
        try reasonsRoundTripThroughPhases()
        try blockedSyncNeverAdvancesTheAnchor()
        try blockedPhasesAreNotTerminal()
        try blockedResumeNeedsItsCondition()
        try blockedPhasesKeepTheirLocalArtifacts()
        try lifecycleStopPreservesBlockedPhases()
        print("Health sync blocked-recovery regression tests passed")
    }

    /// 落盘的是 `rawValue`，而老 payload 会按它解码 ⇒ 改名等于把所有老任务的阶段静默降级成 idle。
    private static func blockedPhasesHaveStableStoredValues() throws {
        try require(
            SyncPhase.deferredProtectedData.rawValue == "deferred_protected_data",
            "the lock-screen phase changed its stored value; persisted tasks would decode as idle"
        )
        try require(
            SyncPhase.authRequired.rawValue == "auth_required",
            "the credential phase changed its stored value; persisted tasks would decode as idle"
        )
        // 阻塞集合必须恰好是这两个：多一个说明有新阶段被塞进来却没配恢复路径。
        try require(
            SyncPhase.blocked == [.deferredProtectedData, .authRequired],
            "SyncPhase.blocked is \(SyncPhase.blocked.map(\.rawValue).sorted()) instead of exactly "
            + "the two blocked phases"
        )
    }

    /// 原因 ↔ 阶段必须是一一对应的双向映射；非阻塞阶段不许被认成阻塞。
    private static func reasonsRoundTripThroughPhases() throws {
        for reason in [HealthSyncBlockedReason.protectedData, .credential] {
            let phase = HealthSyncBlockedRecovery.phase(for: reason)
            try require(
                HealthSyncBlockedRecovery.reason(for: phase) == reason,
                "\(reason) did not round-trip through \(phase.rawValue)"
            )
        }
        for phase in SyncPhase.allCases where !phase.isBlocked {
            try require(
                HealthSyncBlockedRecovery.reason(for: phase) == nil,
                "\(phase.rawValue) was mistaken for a blocked phase"
            )
        }
    }

    /// 🔴 核心不变式：**处于阻塞态时绝不推进 anchor**（§3.4 的原话：
    /// 「绝对严禁视为空数据 (0 Workouts) 推进 Anchor!」）。
    ///
    /// 这条要是破了，后果不是"报错"而是**静默丢数据**：客户端会把"这一次没读到"
    /// 当成"数据没有变化"，于是推进水位；而下次查询从新水位起步，那一段真实存在的
    /// 健康数据再也不会出现在任何一次导出里。
    private static func blockedSyncNeverAdvancesTheAnchor() throws {
        for phase in SyncPhase.allCases {
            try require(
                HealthSyncBlockedRecovery.mayAdvanceAnchor(phase) == !phase.isBlocked,
                "mayAdvanceAnchor disagrees with isBlocked at \(phase.rawValue) — the invariant "
                + "'a blocked sync never advances the anchor' is broken"
            )
        }
        for reason in [HealthSyncBlockedReason.protectedData, .credential] {
            try require(
                !HealthSyncBlockedRecovery.mayAdvanceAnchor(HealthSyncBlockedRecovery.phase(for: reason)),
                "a \(reason) block was allowed to advance the anchor"
            )
        }
        // 反向：成功路径必须**能**推进，否则不变式会把正常同步一起挡住。
        try require(
            HealthSyncBlockedRecovery.mayAdvanceAnchor(.succeeded),
            "a successful sync was forbidden from advancing the anchor"
        )
    }

    /// 阻塞态不是终态 —— 是终态的话 `resumablePhase` 会把它降级成 idle。
    private static func blockedPhasesAreNotTerminal() throws {
        for phase in SyncPhase.blocked {
            try require(
                !phase.isTerminal,
                "\(phase.rawValue) is terminal — a lifecycle stop would downgrade it to idle and "
                + "the 'waiting on a condition' fact would be lost"
            )
        }
    }

    /// 恢复判据：**条件没满足不许动，不在等的事不许被叫醒。**
    private static func blockedResumeNeedsItsCondition() throws {
        // 不在阻塞态 ⇒ 任何组合都不得触发同步。这是"每次解锁白读一次 HealthKit"的闸门。
        for phase in SyncPhase.allCases where !phase.isBlocked {
            for available in [true, false] {
                for credential in [true, false] {
                    try require(
                        !HealthSyncBlockedRecovery.shouldResume(
                            phase: phase,
                            isProtectedDataAvailable: available,
                            hasCredential: credential
                        ),
                        "\(phase.rawValue) claimed it should resume although nothing is blocked"
                    )
                }
            }
        }
        // 锁屏阻塞：只有设备真的能读了才恢复。
        try require(
            HealthSyncBlockedRecovery.shouldResume(
                phase: .deferredProtectedData,
                isProtectedDataAvailable: true,
                hasCredential: true
            ),
            "an unlocked device did not resume the lock-screen block"
        )
        try require(
            !HealthSyncBlockedRecovery.shouldResume(
                phase: .deferredProtectedData,
                isProtectedDataAvailable: false,
                hasCredential: true
            ),
            "the lock-screen block resumed while the device was still locked"
        )
        // 凭证阻塞：只看凭证，**不看**锁屏与否 —— 两件事互不蕴含，混起来会让
        // "解锁了但还没登录"被误判成可以恢复。
        try require(
            HealthSyncBlockedRecovery.shouldResume(
                phase: .authRequired,
                isProtectedDataAvailable: false,
                hasCredential: true
            ),
            "a credential block did not resume once a credential was available"
        )
        try require(
            !HealthSyncBlockedRecovery.shouldResume(
                phase: .authRequired,
                isProtectedDataAvailable: true,
                hasCredential: false
            ),
            "the credential block resumed without any credential"
        )
    }

    /// 阻塞期间本地批次必须保留：401 的字节是**完好**的，删掉它要重读一次 HealthKit。
    private static func blockedPhasesKeepTheirLocalArtifacts() throws {
        for phase in SyncPhase.blocked {
            try require(
                HealthSyncBlockedRecovery.keepsLocalArtifacts(phase),
                "\(phase.rawValue) discarded its local batch — a stale credential would then cost "
                + "a full HealthKit re-read"
            )
        }
        for phase in SyncPhase.allCases where !phase.isBlocked {
            try require(
                !HealthSyncBlockedRecovery.keepsLocalArtifacts(phase),
                "\(phase.rawValue) claims to keep a batch although it is not blocked"
            )
        }
    }

    /// 生命周期中止必须原样保留阻塞态，而用户取消仍要如实记下（阻塞不是例外）。
    private static func lifecycleStopPreservesBlockedPhases() throws {
        for reason in [HealthSyncBlockedReason.protectedData, .credential] {
            let phase = HealthSyncBlockedRecovery.phase(for: reason).rawValue
            try require(
                HealthSyncLifecycle.persistedPhases.contains(phase),
                "blocked phase \(phase) is not in persistedPhases, so nothing may ever store it"
            )
            try require(
                HealthSyncLifecycle.resumablePhase(for: phase) == phase,
                "a lifecycle stop rewrote \(phase) instead of preserving it"
            )
            try require(
                HealthSyncLifecycle.phaseAfterStop(cause: .lifecycle, current: phase) == phase,
                "a lifecycle stop produced a non-preserving phase for \(phase)"
            )
            try require(
                HealthSyncLifecycle.phaseAfterStop(cause: .manual, current: phase) == "cancelled",
                "a user cancel was not recorded while blocked in \(phase)"
            )
            // 阻塞态没有在飞的工作 ⇒ 进后台 `.doNothing`（不是 keepWorking）。
            try require(
                HealthSyncLifecycle.enterBackground(
                    phase: phase, isBusy: true, hasJobId: false
                ) == .doNothing,
                "\(phase) claimed in-flight work on entering the background"
            )
        }
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw BlockedRecoveryRegressionFailure(message) }
    }
}

private struct BlockedRecoveryRegressionFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
