import Foundation

/// `HealthSyncLifecycle` 的回归。
///
/// 它钉的是 `HealthSyncLifecycle.enterBackground` / `resumablePhase` 的**契约**，
/// 也就是"改错了照样编译通过、肉眼也看不出来"的那几条：
///
///   1. `.doNothing` 只允许出现在"没有在飞的工作"与"工作已归系统所有"两态 ——
///      在 `isBusy == true` 时返回它等于对调用方撒谎；
///   2. `jobId` 落盘（服务端在算）⇒ `.stopResumable`，**字段优先于 `phase` 文字**；
///   3. 其余非终态阶段 ⇒ `.keepWorking`；
///   4. 终态 / 未知文字 ⇒ `.doNothing`；
///   5. `"cancelled"` **当且仅当**用户取消（`SyncCancelCause.manual`）时产出；生命周期中止与
///      `cause == .none`（父任务被取消）永不产出它；阶段早已结束且非用户取消时返回 `nil`
///      ⇒ 不动 `phase`，否则会把用户需要看到的失败原因抹成 `idle`；
///   6. 已经交给系统的传输（`hasUploadTask`）一根手指都不许碰。
///
/// 之所以要有这个可执行文件：`HealthKitSync.swift` 不被任何回归脚本编译，
/// 判据若留在它里面就没有执行者。
///
/// 各条判据对应的**可达状态与出处**（判据不许凭空发明状态）：
///   - `collecting`          `HealthKitSync.swift:177`、`:298`
///   - `uploading`           `HealthKitSync.swift:304`、`:475`
///   - `importing` + 无 jobId `HealthKitSync.swift:499`（`inspect`+`startImport` 窗口，到 `:517` 才变）
///   - `recomputing` + jobId  `HealthKitSync.swift:336`、`:523`
///   - `succeeded`/`failed`/`cancelled`/`idle`
///
/// `uploaded` 是 P1 才会开始写入的中间态，这里先当非终态覆盖，好在它上线前就钉住判据。
@main
struct HealthSyncLifecycleRegression {
    static func main() throws {
        try noInFlightWorkIsReportedAsNothing()
        try serverWaitStopsRegardlessOfPhaseLabel()
        try systemOwnedTransferIsNotTouched()
        try terminalAndUnknownPhasesDoNothing()
        try onlyUserCancelRecordsCancelled()
        try lifecycleNeverProducesCancelled()
        try lifecyclePreservesInProgressPhase()
        try declaredPhaseSetsAreCoherent()
        print("Health sync lifecycle regression tests passed")
    }

    /// 契约 5：`"cancelled"` **当且仅当**用户取消时产出；生命周期中止与"来源无从判断"的中止
    /// （父任务被取消 ⇒ `cause == .none`）永不产出它；阶段早已结束且非用户取消时返回 `nil`
    /// （不动 `phase`，否则会把用户需要看到的失败原因抹掉）。
    ///
    /// 这一条对应计划 §4 要求的"`cancelSync` 路径仍产出 `cancelled`"：判据已从
    /// `HealthKitSync.finishCancelled()` 搬进纯函数 `phaseAfterStop`，才第一次可被断言。
    private static func onlyUserCancelRecordsCancelled() throws {
        // 用户点了取消：这是他明确表达的事实，任何阶段都如实记下。
        for phase in HealthSyncLifecycle.persistedPhases {
            try require(
                HealthSyncLifecycle.phaseAfterStop(cause: .manual, current: phase) == "cancelled",
                "a user cancel did not record itself from \(phase)"
            )
        }
        // 系统收回额度、或父任务被取消：永远不能冒充用户取消。
        for cause in [SyncCancelCause.lifecycle, .none] {
            for phase in HealthSyncLifecycle.persistedPhases {
                try require(
                    HealthSyncLifecycle.phaseAfterStop(cause: cause, current: phase) != "cancelled",
                    "\(cause.rawValue) impersonated a user cancel from \(phase)"
                )
            }
            for unknown in ["", "exporting", "CANCELLED"] {
                try require(
                    HealthSyncLifecycle.phaseAfterStop(cause: cause, current: unknown) != "cancelled",
                    "\(cause.rawValue) impersonated a user cancel from unknown input \(unknown)"
                )
            }
        }
        // 已结束的阶段 + 非用户取消 ⇒ 不动 phase（nil）。
        for phase in HealthSyncLifecycle.terminalPhases {
            try require(
                HealthSyncLifecycle.phaseAfterStop(cause: .lifecycle, current: phase) == nil,
                "a lifecycle stop rewrote an already-finished phase \(phase)"
            )
        }
        // 非终态 + 非用户取消 ⇒ 原样保留"进行到哪一步"。
        for phase in HealthSyncLifecycle.persistedPhases
        where !HealthSyncLifecycle.terminalPhases.contains(phase) {
            try require(
                HealthSyncLifecycle.phaseAfterStop(cause: .lifecycle, current: phase) == phase,
                "a lifecycle stop did not preserve the in-flight phase \(phase)"
            )
        }
    }

    /// 不变式 1：任何输入都不能让生命周期中止冒充用户取消。
    private static func lifecycleNeverProducesCancelled() throws {
        for phase in HealthSyncLifecycle.persistedPhases {
            try require(
                HealthSyncLifecycle.resumablePhase(for: phase) != "cancelled",
                "a lifecycle stop impersonated a user cancel from \(phase)"
            )
        }
        // 未知 / 大小写错 / 带空白的输入同样不能落进取消态。
        for unknown in ["", "exporting", "waitingServer", "CANCELLED", "cancelled ", " cancel"] {
            try require(
                HealthSyncLifecycle.resumablePhase(for: unknown) != "cancelled",
                "a lifecycle stop impersonated a user cancel from unknown input \(unknown)"
            )
        }
    }

    /// 非终态阶段必须原样保留（"进行到哪一步"不因进程进入后台而改变）；
    /// 终态与未知输入落到 idle，好让 UI 如实显示"当前没有在进行中的同步"。
    private static func lifecyclePreservesInProgressPhase() throws {
        for phase in ["collecting", "exported", "uploading", "uploaded", "importing", "recomputing"] {
            try require(
                HealthSyncLifecycle.resumablePhase(for: phase) == phase,
                "in-flight phase \(phase) was rewritten by a lifecycle stop"
            )
        }
        for phase in ["idle", "succeeded", "failed", "cancelled"] {
            try require(
                HealthSyncLifecycle.resumablePhase(for: phase) == "idle",
                "terminal phase \(phase) did not fall back to idle"
            )
        }
        try require(
            HealthSyncLifecycle.resumablePhase(for: "not-a-phase") == "idle",
            "an unknown phase did not fall back to idle"
        )
    }

    /// 契约 1+3：非终态的在飞工作一律 `.keepWorking`，绝不能被报成"没事可做"。
    ///
    /// 这一条钉的是 2026-09-22 那一版判据的实际缺陷：它把 `sourceId != nil` 短路成
    /// `.doNothing`，而 `HealthKitSync.swift:499` 恰恰会停在 `sourceId` 已落盘、`jobId`
    /// 还是 nil 的窗口里（`inspect` + `startImport` 两次短请求，到 `:517` 才改 phase）
    /// —— `isBusy == true` 却被告知"没有在飞的工作"。
    private static func noInFlightWorkIsReportedAsNothing() throws {
        let inFlight = HealthSyncLifecycle.persistedPhases
            .filter { !HealthSyncLifecycle.terminalPhases.contains($0) }
            // 🔴 阻塞态（等解锁 / 等凭证）**不是**在飞的工作：它们在等一个外部条件，
            // 续期额度对它们毫无意义。排除它们 —— 否则"非终态一律 keepWorking"这条断言
            // 会把正确的"没事可做"报成缺陷，而正确的处置被改成 `.keepWorking` 之后，
            // "等解锁"就会被当成"正在跑"记着。它们的落点由 `blockedPhasesHaveNoInFlightWork` 单独钉。
            .filter { !SyncPhase.migrate($0).isBlocked }
        // 阶段清单本身也要被钉住：谁把某个在飞阶段挪进终态集合，这里先红。
        try require(inFlight.count >= 6, "too few non-terminal phases to cover the contract")
        for phase in inFlight {
            let disposition = HealthSyncLifecycle.enterBackground(
                phase: phase, isBusy: true, hasJobId: false
            )
            try require(
                disposition == .keepWorking,
                "in-flight work in \(phase) was reported as \(disposition) instead of keepWorking"
            )
        }
    }

    /// 契约 2：服务端在算（`jobId` 已落盘）时必须收手，且**字段优先于 `phase` 文字** ——
    /// 无论此刻 `phase` 被写成什么，只要 `jobId` 在就说明还在轮询一个服务端任务，
    /// 而后台轮询零收益（服务端没有推送机制）。
    private static func serverWaitStopsRegardlessOfPhaseLabel() throws {
        for phase in HealthSyncLifecycle.persistedPhases {
            try require(
                HealthSyncLifecycle.enterBackground(
                    phase: phase, isBusy: true, hasJobId: true
                ) == .stopResumable,
                "a persisted jobId was not honoured while phase was \(phase)"
            )
        }
    }

    /// 契约 6：系统拥有的传输不受生命周期影响。
    private static func systemOwnedTransferIsNotTouched() throws {
        for phase in HealthSyncLifecycle.persistedPhases {
            try require(
                HealthSyncLifecycle.enterBackground(
                    phase: phase, isBusy: true, hasJobId: true, hasUploadTask: true
                ) == .doNothing,
                "a system-owned upload was disturbed from \(phase)"
            )
        }
    }

    /// 契约 4：终态与未知文字 ⇒ `.doNothing`（此时确实没有在飞的工作）。
    private static func terminalAndUnknownPhasesDoNothing() throws {
        for phase in HealthSyncLifecycle.persistedPhases {
            try require(
                HealthSyncLifecycle.enterBackground(
                    phase: phase, isBusy: false, hasJobId: false
                ) == .doNothing,
                "an idle sync (\(phase)) reacted to entering the background"
            )
        }
        for phase in HealthSyncLifecycle.terminalPhases {
            try require(
                HealthSyncLifecycle.enterBackground(
                    phase: phase, isBusy: true, hasJobId: false
                ) == .doNothing,
                "terminal phase \(phase) reacted to entering the background"
            )
        }
        // 未知文字（老版本留下的持久化值、拼写错误）必须保守：不动它。
        for unknown in ["", "exporting", "waitingServer", "uploaded ", "IMPORTING"] {
            try require(
                HealthSyncLifecycle.enterBackground(
                    phase: unknown, isBusy: true, hasJobId: false
                ) == .doNothing,
                "an unknown phase \(unknown) reacted to entering the background"
            )
        }
    }

    /// 声明的集合自身要自洽 —— 否则上面几条覆盖会悄悄漏掉阶段。
    private static func declaredPhaseSetsAreCoherent() throws {
        for phase in HealthSyncLifecycle.terminalPhases {
            try require(
                HealthSyncLifecycle.persistedPhases.contains(phase),
                "terminal phase \(phase) is missing from persistedPhases"
            )
        }
        try require(
            HealthSyncLifecycle.terminalPhases.count < HealthSyncLifecycle.persistedPhases.count,
            "every persisted phase was declared terminal"
        )
        try require(
            Set(HealthSyncLifecycle.persistedPhases).count == HealthSyncLifecycle.persistedPhases.count,
            "persistedPhases contains duplicates"
        )
        // 取消原因的字面量会被持久化，改名等于静默改变语义。
        try require(SyncCancelCause.none.rawValue == "none", "empty cancel cause changed its stored value")
        try require(SyncCancelCause.manual.rawValue == "manual", "manual cancel cause changed its stored value")
        try require(SyncCancelCause.lifecycle.rawValue == "lifecycle", "lifecycle cancel cause changed its stored value")
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw LifecycleRegressionFailure(message) }
    }
}

private struct LifecycleRegressionFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
