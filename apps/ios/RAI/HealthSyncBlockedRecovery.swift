import Foundation

/// 「这次同步为什么没做成」的两种**非失败**原因（文档 §3.3 / §3.4）。
///
/// 为什么不复用 `failed`：`failed` 说的是"这次尝试本身出了错"（权限被拒、包损坏、
/// 服务端报错），而这两件事说的是"条件还不满足，条件一到就能原样重跑"。
/// 混成一个值的代价是双向的 —— 界面会对一件用户没做错的事报失败，
/// 而恢复逻辑会因为"已经失败过了"不再重试。
nonisolated enum HealthSyncBlockedReason: Equatable {
    /// 设备锁屏、或开机后尚未首次解锁：HealthKit 数据库被硬件级加密锁死，读不到任何东西。
    case protectedData
    /// 批次凭证失效（HTTP 401/403）。
    case credential
}

/// 「这一批完好，但通道失效了」—— 一个**非失败**的信号（文档 §3.3）。
///
/// 为什么用独立错误类型而不是让调用方去看状态码：抛出点（`uploadWithRecovery`）与处置点
/// （`performSync` 的兜底 catch）之间隔着一次 `withRetry`，状态码在那里已经变成了
/// `SyncHTTPError` 的字段；而**兜底 catch 的首要职责是不要把更具体的结论覆盖成 `failed`**。
/// 一个专用类型让这条"别覆盖"的判据在类型层面成立，不依赖两边对同一个数字的理解一致。
nonisolated struct SyncCredentialRequiredError: Error {}

/// 阻塞态的落点与恢复判据。
///
/// 判据刻意住在这个文件而不是 `HealthKitSync.swift`：后者只被 `typecheck-ios.sh` 做类型检查，
/// **不被任何回归编译** —— 判据写在那里就等于没有执行者（本仓已为此付过代价，
/// 见 `HealthSyncLifecycle.swift` 的文件头说明）。
///
/// 本文件只依赖 Foundation（不引 HealthKit / UIKit），所以够格进
/// `run-health-sync-tests.sh` 那个可执行单元。真正"哪个 error 算锁屏"的分类留在
/// `HealthKitExport.swift`（那里能拿到 `HKError.Code`，见该文件的 `isDatabaseInaccessible`），
/// 因为把错误码硬编码到这个纯函数里，就等于让判据随 SDK 版本悄悄漂移。
nonisolated enum HealthSyncBlockedRecovery {
    /// 阻塞原因 → 该落成哪个阶段。判据的唯一来源是 `SyncPhase`，这里只做映射。
    static func phase(for reason: HealthSyncBlockedReason) -> SyncPhase {
        switch reason {
        case .protectedData: return .deferredProtectedData
        case .credential: return .authRequired
        }
    }

    /// 反向映射：这个阶段是不是"在等外部条件"。不是则返回 `nil`。
    static func reason(for phase: SyncPhase) -> HealthSyncBlockedReason? {
        switch phase {
        case .deferredProtectedData: return .protectedData
        case .authRequired: return .credential
        default: return nil
        }
    }

    /// 🔴 **不变式：阻塞态绝不推进 anchor。**
    ///
    /// 转发到 `SyncPhase.mayAdvanceAnchor`，刻意不在这里重写一遍判据 —— 两份"什么算阻塞"
    /// 正是本仓复发最多的一类缺陷。文档 §3.4 的原话是
    /// 「绝对严禁视为空数据 (0 Workouts) 推进 Anchor!」
    static func mayAdvanceAnchor(_ phase: SyncPhase) -> Bool {
        SyncPhase.mayAdvanceAnchor(phase)
    }

    /// 阻塞发生时，本地已落盘的批次产物（ZIP / multipart）该不该保留。两者都保留。
    ///
    /// 理由不同，所以不是同一条规则抄两遍：
    ///   - 锁屏：阻塞发生在**导出之前**，产物还没生成；这里的"保留"说的是
    ///     "别顺手把盘上上一批还没走完的产物清理掉" —— 它跟这次锁屏毫无关系；
    ///   - 401：产物**完好且有效**，服务端拒绝的是通道而不是字节。
    ///     删掉它意味着重新读一次 HealthKit（整个流程里最贵的一步）。
    static func keepsLocalArtifacts(_ phase: SyncPhase) -> Bool { phase.isBlocked }

    /// 外部条件已经满足时，该不该**立刻**重跑。
    ///
    /// 判据只有两条，且都不看时间：当前卡在哪个阶段 + 那个阶段需要的东西好了没有。
    /// - 不在阻塞态 ⇒ `false`。没有谁在等这件事，叫醒它只会白读一次 HealthKit
    ///   （而读 HealthKit 正是最贵的一步，也是节流策略存在的理由）。
    /// - 在阻塞态但条件仍未满足 ⇒ `false`。比如刚收到解锁通知却又立刻锁屏，
    ///   或者前台拿到了空 token。
    static func shouldResume(
        phase: SyncPhase,
        isProtectedDataAvailable: Bool,
        hasCredential: Bool
    ) -> Bool {
        switch reason(for: phase) {
        case .protectedData: return isProtectedDataAvailable
        case .credential: return hasCredential
        case .none: return false
        }
    }
}
