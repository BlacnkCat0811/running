import Foundation

/// 单批导出的**载荷预算**（观测阶段 2 / 实施方案 S2.1–S2.2）。
///
/// 取值 = 服务端 `/v1/handshake` 的 `directSyncBounds` × 0.9（0.9 为打包/摘要/壳开销留余量）；
/// 服务端未升级（缺字段）时回落到**保守常量** —— 宁可小一点多分几批，也不要超界被拒。
///
/// 🔴 为什么必须存在：服务端直连车道对单批有硬上界（XML ≤ 2 MiB、记录 ≤ 5000、路线 ≤ 32 MiB /
/// 200 个文件），超界**此前**是"静默回退候选链路"（整库备份 + 两次全库校验，线上实测
/// 9.9–13.3 min，其中全库校验占 71.5–76.9%）。分批之后正常同步的每一批都 ≤ 上界 ⇒ 直连能
/// 接住 ⇒ 回退率归零 —— 而且这在**旧服务端**上就能收割，不依赖服务端收口版（发布顺序 R1：
/// iOS 分批版先行）。
///
/// 🔴 2026-10-14（route 维度补全）：首版只覆盖 xml/records，而当天真机回填批以 34 MB 路线
/// 数据拿到 `route_exceeds_bounds`（收口后不再有回退 ⇒ 直接卡死同步链）⇒ 补上 route 两个
/// 维度。收集侧的闸门是**先判后取**（`HealthKitExport.swift` 的逐 workout 循环）：预算满就
/// 不 fetch、`routeDecisions` 不写 ⇒ **状态与文件严格同进同退**（半 fetch 再丢弃会让状态先行
/// 推进到 settled、文件永久丢失）。
nonisolated struct DirectSyncBatchBudget: Equatable, Sendable {
    let maxXmlBytes: Int
    let maxRecords: Int
    let maxRouteFiles: Int
    let maxRouteBytes: Int

    /// 服务端 bounds 缺省时的保守值（S2.2）：1.8 MiB / 4500 条 / 180 个 / 28.8 MiB。
    ///
    /// 四个数字与换算式（`× 0.9`）由 `check-healthkit-record-sync.py` 文本门禁钉住 ——
    /// 本文件依赖 `DirectSyncBounds`（`APIModels.swift`），而 APIModels 的编译面
    /// 远大于一个纯数据类型，所以预算的行为断言交给 macOS 侧回归
    /// （`apps/ios/tests/DirectSyncBatchBudgetTests.swift`），
    /// 常量与换算式的防漂移交给门禁（本机（Windows）即可执行）。
    static let conservative = DirectSyncBatchBudget(
        maxXmlBytes: 1_887_436,  // 1.8 MiB（2 MiB × 0.9 向下取整，宁小勿大）
        maxRecords: 4_500,
        maxRouteFiles: 180,
        maxRouteBytes: 30_198_988  // 28.8 MiB（32 MiB × 0.9 向下取整）
    )

    /// 用握手 bounds 收敛出预算。`nil`（老服务端 / 未握手）⇒ 保守常量。
    static func from(bounds: DirectSyncBounds?) -> DirectSyncBatchBudget {
        guard let bounds else { return conservative }
        return DirectSyncBatchBudget(
            maxXmlBytes: Int(Double(bounds.maxXmlBytes) * 0.9),
            maxRecords: Int(Double(bounds.maxRecords) * 0.9),
            maxRouteFiles: Int(Double(bounds.maxRouteFiles) * 0.9),
            maxRouteBytes: Int(Double(bounds.maxRouteBytes) * 0.9)
        )
    }

    /// drain 的 `shouldStop` 用：给定当前**已写入字节**与**已消费记录条数**，是否到上界。
    ///
    /// 调用时机是"消费完一整页之后"（`HealthKitRecordCursor.drain` 的页末尾检查）——
    /// 所以这里返回 `true` 时的超额是"本页带上来的"，不是"页中途切断了"。
    func exceeded(xmlBytes: UInt64, records: Int) -> Bool {
        xmlBytes >= UInt64(maxXmlBytes) || records >= maxRecords
    }

    /// route 收集的**先判后取**闸门：给定已累计的路线字节与文件数，本轮是否已到上界。
    ///
    /// 🔴 只允许在 `routeEntries` **fetch 之前**使用（`HealthKitExport.swift`）：预算满 ⇒
    /// 本轮不再查任何新路线。**不许**改成"fetch 之后再丢弃"——那会让状态先行推进、
    /// 而文件永久丢失；"先判后取"下未查的 workout 保持原状态，由
    /// `RouteSyncStateMachine.rediscoveryCandidates` 在后续轮次继续发现。
    func routeBudgetExhausted(routeBytes: Int, routeFiles: Int) -> Bool {
        routeBytes >= maxRouteBytes || routeFiles >= maxRouteFiles
    }
}
