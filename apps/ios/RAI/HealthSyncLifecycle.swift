import Foundation

/// 「这次中止是系统收回了时间，还是用户点了取消」。
///
/// 为什么必须分开：`beginBackgroundTask` 的 expiration handler 与 UI 取消按钮原先共用
/// `cancelSync()` → `phase = "cancelled"`，于是"系统到点了"在持久化状态里与"用户取消"
/// **完全不可区分**。后果是双向的：
///   - 下次同步的 `checkCancellation()` 把上一次的生命周期中止当成用户意图；
///   - UI 会告诉用户"同步已取消"，而用户根本没点过取消。
///
/// 2026-09-22 核实证据：`HealthKitSync.swift` 的 `cancelSync()`（`:81-84`）、
/// `finishCancelled()`（`:516-520`，赋值在 `:518`）、`checkCancellation()`（`:522-524`），
/// 以及 `RAIApp.swift:75-77` 的切后台取消 —— 三处共用同一条链。
nonisolated enum SyncCancelCause: String, Equatable {
    case none
    case manual
    case lifecycle
}

/// 进入后台时对"在飞的工作"的处置判据。
///
/// 这里刻意做成纯函数：`HealthKitSync.swift` 不被任何回归脚本编译（只被
/// `typecheck-ios.sh` 类型检查），判据写在它里面就等于没有执行者。
/// 本文件平铺在 `apps/ios/RAI/` 下，落在 `typecheck-ios.sh` 的 glob 内，并由
/// `run-health-sync-tests.sh` 单独编译执行。
nonisolated enum HealthSyncLifecycle {
    enum Disposition: Equatable {
        /// 没有在飞的工作，或工作已经归系统所有（background URLSession 传输）。
        case doNothing
        /// 让它在续期额度内跑完；额度到了由 `suspendForLifecycle()` 保存为可续接。
        case keepWorking
        /// 立刻收手，但**保存为可续接** —— 不是取消。回到前台按持久化字段续跑。
        case stopResumable
    }

    /// 客户端可能持久化进 `phase` 的全部取值。
    ///
    /// 🔴 **由 `SyncPhase` 派生，不再自己抄一份。** 这里曾经是一份手写数组，与
    /// `HealthKitSync.swift` 里的裸字符串、`SyncPhase` 的枚举构成三份同名单 ——
    /// 失效方式是静默的（多一个阶段没人管），而它决定的正是"生命周期中止会不会
    /// 把某个阶段写坏"。
    ///
    /// `exported` / `uploaded` 在 P1 之前还没有写入点，但那时也先收在这里，为的是让
    /// 「生命周期中止永不产出 cancelled」这条不变式从一开始就覆盖它们。
    /// 结构门禁 `tests/check-background-capabilities.py` 会配平
    /// `SyncPhase.allCases` 与 `HealthKitSync.swift` 实际写出的取值。
    static let persistedPhases: [String] = SyncPhase.allCases.map(\.rawValue)

    /// 已经结束、不会自己变好的阶段。
    static let terminalPhases: Set<String> = Set(SyncPhase.terminal.map(\.rawValue))

    /// 进入后台时该做什么。
    ///
    /// 判据只有一条：**在飞的工作归谁拥有**。
    /// - 归 App 的（HealthKit 导出、打包、ZIP 上传、`inspect`/`startImport`、`waitForJob`）
    ///   ⇒ 在续期额度内跑完，到点由 expiration handler 保存为可续接。
    /// - 归系统的（background URLSession 传输，以 `hasUploadTask` 表示）⇒ 一根手指都不许碰。
    ///
    /// 契约（`HealthSyncLifecycleRegression` 逐条钉死）：
    ///   I1 `.doNothing` **只允许**出现在"没有在飞的工作"与"工作已归系统所有"两态。
    ///      在 `isBusy == true` 时返回它等于对调用方撒谎 —— 调用方会据此认为可以立刻
    ///      释放续期额度（P2 引入 background session 后就会这么做）。
    ///   I2 `jobId` 落盘（服务端在算）⇒ `.stopResumable`：**字段优先于 `phase` 文字**。
    ///      服务端没有推送机制（无 webhook / SSE / 长轮询），后台空转轮询零收益，
    ///      保留 `jobId` 交给下次唤醒续接即可。
    ///   I3 其余非终态阶段 ⇒ `.keepWorking`。
    ///   I4 终态 / 未知文字 ⇒ `.doNothing`。
    ///
    /// 为什么"批次已上传（`sourceId` 已落盘）但导入任务还没发起"**算** `.keepWorking`
    /// 而不是收手：那个窗口里的在飞工作是 `inspect` + `startImport` 两次短 HTTP 请求
    /// （`HealthKitSync.swift:499` → `:517`），让它跑完能把 `jobId` 落盘，下次唤醒直接
    /// 跳到"等服务端结果"；收手则下次要重新走一遍。而"原子单元不跨会话"这条恢复语义
    /// 由**会话边界**（`performSync` 结束或中止）保证，不靠在这里故意掐断 —— 进程随时
    /// 可能被 kill，系统本来就必须容忍"单元做到一半就断"。
    ///
    /// `hasUploadTask` 在当前阶段恒为 false，参数先留着，好让引入 background session 时
    /// 只改调用点、不改判据。
    static func enterBackground(
        phase: String,
        isBusy: Bool,
        hasJobId: Bool,
        hasUploadTask: Bool = false
    ) -> Disposition {
        guard isBusy else { return .doNothing }
        if hasUploadTask { return .doNothing }
        if hasJobId { return .stopResumable }
        if terminalPhases.contains(phase) { return .doNothing }
        switch phase {
        case "collecting", "exported", "uploading", "uploaded", "importing", "recomputing":
            return .keepWorking
        default:
            return .doNothing
        }
    }

    /// 生命周期中止时把 `phase` 落成什么。
    ///
    /// 🔴 不变式：**永不返回 `"cancelled"`** —— 那个值只保留给用户取消
    /// （`SyncCancelCause.manual`）。非终态阶段一律原样保留，因为"进行到哪一步"
    /// 这个事实不因进程进入后台而改变；终态或未知输入一律落到 `"idle"`。
    static func resumablePhase(for interrupted: String) -> String {
        guard persistedPhases.contains(interrupted), !terminalPhases.contains(interrupted) else {
            return "idle"
        }
        return interrupted
    }

    /// 一次中止之后 `phase` 该落成什么。返回 `nil` = **不要动 `phase`**。
    ///
    /// `nil` 的含义是"本次中止没有新信息可记"：阶段早已是终态，硬写只会把用户需要看到的
    /// 失败原因抹掉。
    ///
    /// 🔴 契约：`"cancelled"` **当且仅当** `cause == .manual` 时才产出。
    ///
    /// 这条是从 `HealthKitSync.swift` 的 `finishCancelled()` 里**搬出来**的：那个文件不被
    /// 任何回归脚本编译（只被 `typecheck-ios.sh` 类型检查），判据留在那里就只能靠
    /// `check-background-capabilities.py` 做字面匹配，证得了"有没有写"，证不了"写成什么"。搬到这里它才有执行者。
    static func phaseAfterStop(cause: SyncCancelCause, current: String) -> String? {
        if cause != .manual, terminalPhases.contains(current) { return nil }
        // 用户点了取消：这是他明确表达的事实，任何阶段都如实记下 —— 包括阶段刚好已经结束的
        // 那一瞬，覆盖一次成功提示，也好过出现"我点了取消、界面却说成功"。
        if cause == .manual { return "cancelled" }
        return resumablePhase(for: current)
    }
}
