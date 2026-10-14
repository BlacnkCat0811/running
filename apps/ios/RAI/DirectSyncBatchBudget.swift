import Foundation

/// 单批导出的**载荷预算**（观测阶段 2 / 实施方案 S2.1–S2.2）。
///
/// 取值 = 服务端 `/v1/handshake` 的 `directSyncBounds` × 0.9（0.9 为打包/摘要/壳开销留余量）；
/// 服务端未升级（缺字段）时回落到**保守常量** —— 宁可小一点多分几批，也不要超界被拒成回退。
///
/// 🔴 为什么必须存在：服务端直连车道对单批有硬上界（XML ≤ 2 MiB、记录 ≤ 5000），超界
/// **此前**是"静默回退候选链路"（整库备份 + 两次全库校验，线上实测 9.9–13.3 min，
/// 其中全库校验占 71.5–76.9%）。分批之后正常同步的每一批都 ≤ 上界 ⇒ 直连能接住 ⇒
/// 回退率归零 —— 而且这在**旧服务端**上就能收割，不依赖服务端收口版（发布顺序 R1：
/// iOS 分批版先行）。
nonisolated struct DirectSyncBatchBudget: Equatable, Sendable {
    let maxXmlBytes: Int
    let maxRecords: Int

    /// 服务端 bounds 缺省时的保守值（S2.2）：1.8 MiB / 4500 条。
    ///
    /// 两个数字与换算式（`× 0.9`）由 `check-healthkit-record-sync.py` 文本门禁钉住 ——
    /// 本文件依赖 `DirectSyncBounds`（`APIModels.swift`），而 APIModels 的编译面
    /// 远大于一个纯数据类型，所以预算的行为断言交给 macOS 侧真机流程，
    /// 常量与换算式的防漂移交给门禁（本机（Windows）即可执行）。
    static let conservative = DirectSyncBatchBudget(
        maxXmlBytes: 1_887_436,  // 1.8 MiB（向下取整，宁小勿大）
        maxRecords: 4_500
    )

    /// 用握手 bounds 收敛出预算。`nil`（老服务端 / 未握手）⇒ 保守常量。
    static func from(bounds: DirectSyncBounds?) -> DirectSyncBatchBudget {
        guard let bounds else { return conservative }
        return DirectSyncBatchBudget(
            maxXmlBytes: Int(Double(bounds.maxXmlBytes) * 0.9),
            maxRecords: Int(Double(bounds.maxRecords) * 0.9)
        )
    }

    /// drain 的 `shouldStop` 用：给定当前**已写入字节**与**已消费记录条数**，是否到上界。
    ///
    /// 调用时机是"消费完一整页之后"（`HealthKitRecordCursor.drain` 的页末尾检查）——
    /// 所以这里返回 `true` 时的超额是"本页带上来的"，不是"页中途切断了"。
    func exceeded(xmlBytes: UInt64, records: Int) -> Bool {
        xmlBytes >= UInt64(maxXmlBytes) || records >= maxRecords
    }
}
