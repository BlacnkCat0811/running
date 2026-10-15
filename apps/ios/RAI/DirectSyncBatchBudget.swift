import Foundation

/// 单批导出的**载荷预算**（观测阶段 2 / 实施方案 S2.1–S2.2）。
///
/// 取值 = 服务端 `/v1/handshake` 的 `directSyncBounds` × 0.9（0.9 为打包/摘要/壳开销留余量）；
/// 服务端未升级（缺字段）时回落到**保守常量** —— 宁可小一点多分几批，也不要超界被拒。
///
/// 🔴 为什么必须存在：服务端直连车道对单批有硬上界（**2026-10-14 起** XML ≤ 8 MiB、记录 ≤ 5000、
/// 路线 ≤ 64 MiB / 200 个文件；旧值 2 MiB / 32 MiB 由 `f7b2bc3` 放宽），超界**此前**是"静默
/// 回退候选链路"（整库备份 + 两次全库校验，线上实测 9.9–13.3 min，其中全库校验占 71.5–76.9%）。
/// 分批之后正常同步的每一批都 ≤ 上界 ⇒ 直连能
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

    /// **写前判定**（S2.5，2026-10-14）：给定**已提交**的字节/条数与**本页渲染后的**
    /// 字节/条数，这一整页放得下吗。`false` ⇒ 调用方必须整页不提交（锚点也不推进）。
    ///
    /// 🔴 判定必须在 `commit` **之前**、用**渲染后的真实字节**做。旧版 `exceeded(xmlBytes:)`
    /// 是"页已落盘之后再问" ⇒ 每批最后一个页必然越界（真机实测 524,305 B）。
    /// 「已写字节还没到预算」**不等于**「下一页放得下」—— 这是旧判据修不掉本缺陷的原因。
    func accepts(xmlBytes: UInt64, records: Int, pageBytes: Int, pageRecords: Int) -> Bool {
        xmlBytes + UInt64(max(0, pageBytes)) <= UInt64(maxXmlBytes)
            && records + max(0, pageRecords) <= maxRecords
    }

    /// 放不下时的**收缩估算**：用本页实测的"每记录字节"算出剩余额度还能取几条。
    ///
    /// 唯一触发场景是"满页比整批预算还大"（正常批走不到这里）。`HealthKitRecordCursor.drain`
    /// 会把它夹到 `min(返回值, 当前 limit − 1)` ⇒ 收缩严格单调、有限步终止；夹到 <1 时收手（零提交）。
    /// 🔴 这是"每轮至少前进 1 条记录"的兜底：去掉它，页首回退就会退化成死循环。
    ///
    /// 🔴 「先比较再相减」（R4 修复，2026-10-15）：旧式 `Int(max(0, UInt64(maxXmlBytes) - usedXmlBytes))`
    /// 里那一截是无符号减法，`usedXmlBytes > maxXmlBytes` 时会**先于**外层 `max(0, …)` 触发算术陷阱
    /// （SIGILL 杀进程）。该输入可达：workout XML 在记录分页之前连续写出、没有写前字节闸门，
    /// 全量重扫或预算已收缩时可以先耗尽字节账。余量不足一律返回 1 —— 由 `drain` 的
    /// `limit == 1` 零提交收手兜底，不自锁（收缩仍严格单调、有界步终止）。
    func shrinkLimit(pageBytes: Int, pageRecords: Int, usedXmlBytes: UInt64, usedRecords: Int) -> Int {
        guard pageRecords > 0 else { return 1 }
        let perRecord = max(1, pageBytes / pageRecords)
        guard usedXmlBytes < UInt64(maxXmlBytes) else { return 1 }
        let remainingBytes = maxXmlBytes - Int(usedXmlBytes)
        let remainingRecords = max(0, maxRecords - usedRecords)
        return max(1, min(remainingBytes / perRecord, remainingRecords))
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

    /// 缩一档：四个维度同时折半（**严格下降且 ≥1**）。
    ///
    /// 为什么折半而不是"少一点"：超界的成因是"我方预算与服务端口径不一致"，而差多少
    /// **未知**（日志里只有一个 400 与一份已经被服务端 retain 掉的暂存上传）。折半给出
    /// 确定性的上界收缩（`maxSteps` 档内 O(log) 收敛）；"少一点"可能一档都不够，
    /// 于是每轮都白读一次 HealthKit —— 整个流程里最贵的一步。
    func halved() -> DirectSyncBatchBudget {
        DirectSyncBatchBudget(
            maxXmlBytes: max(1, maxXmlBytes / 2),
            maxRecords: max(1, maxRecords / 2),
            maxRouteFiles: max(1, maxRouteFiles / 2),
            maxRouteBytes: max(1, maxRouteBytes / 2)
        )
    }

    /// **本地自校验**（P2b）：本批产物是否真的超过了**服务端硬上界**。
    ///
    /// 与 `accepts` 的分工：`accepts` 比的是**我方预算**（= 上界 × 0.9，写前判定用），
    /// 这里比的是**服务端上界本身**（上传前自校验用）。两者都得"是"才说明"预算没挡住它"。
    ///
    /// 🔴 四个维度必须与服务端**逐条同口径**（`apps/api/src/direct-sync-ingest.ts`）：
    ///   - `xmlBytes` ↔ `statSync(export.xml).size`（`:418`）；
    ///   - `routeFiles` / `routeBytes` ↔ `inputTreeCheck` 对 `workout-routes/**.gpx` 的
    ///     文件数与字节累加（`:367-374`，同为 `statSync` 口径）；
    ///   - `deletions` ↔ **manifest 的 `deletedRecords.length + deletedWorkoutIds.length`**
    ///     （`:439-443`）—— 🔴 **不是**"XML 里的记录条数"：`DIRECT_SYNC_MAX_RECORDS` 在直连车道
    ///     **只约束删除配额**。拿记录条数来比会**误报**，把一批本来合法的载荷反复重导。
    func exceedsServerBounds(
        bounds: DirectSyncBounds,
        xmlBytes: Int,
        deletions: Int,
        routeBytes: Int,
        routeFiles: Int
    ) -> Bool {
        xmlBytes > bounds.maxXmlBytes
            || deletions > bounds.maxRecords
            || routeBytes > bounds.maxRouteBytes
            || routeFiles > bounds.maxRouteFiles
    }
}

/// 预算收敛的**档位**（P1b/P2b）。
///
/// 🔴 为什么必须是一个独立、可被回归断言的纯类型：收敛只是"多导一次"，看着无害，
/// 但**不收敛**的后果是"每次同步都用满预算产出同一份必被拒的产物" ⇒ 每次同步白读一遍
/// HealthKit（GB 级导出，整个流程最贵的一步）。档数、上限、折半全在这里，
/// `DirectSyncBatchBudgetTests` 直接钉住；`HealthKitSync` 只做接线。
nonisolated struct DirectSyncBudgetConvergence: Equatable, Codable, Sendable {
    /// 已经收敛了几档。0 = 用握手 bounds × 0.9 的原预算。
    var steps: Int = 0

    /// 收敛上限（档）。
    ///
    /// 有界是**判据的一部分**、不是保守：不设上限 ⇒ "缩预算 + 每次全量导出"变成
    /// 一个没有出口的昂贵循环（用户看到的是"同步一直在转"）。到顶就把确定性失败
    /// 如实报出去、等人工处置。
    static let maxSteps = 3

    /// 耗尽时抛出的**本地错误码**（P2-2a，2026-10-15）：P2b 重导循环在满档仍超界时以它抛出，
    /// 外层兜底 catch 据此把耗尽态落进跨批收敛档（`steps = maxSteps`），避免下一轮从旧档重导。
    /// 它不是服务端码（仅进程内流转）；生产 throw 点与 catch 点以本常量为唯一契约。
    static let exhaustedErrorCode = "budget_convergence_exhausted"

    /// 未收敛（原预算）。
    static let initial = DirectSyncBudgetConvergence()

    var isExhausted: Bool { steps >= Self.maxSteps }

    /// 再收敛一档。到顶后保持不变（**幂等**：重复触发不会越界，也不会让 `apply` 多折半）。
    func advanced() -> DirectSyncBudgetConvergence {
        DirectSyncBudgetConvergence(steps: min(steps + 1, Self.maxSteps))
    }

    /// 把收敛作用到预算上：折半 `steps` 次。
    func apply(to budget: DirectSyncBatchBudget) -> DirectSyncBatchBudget {
        (0..<steps).reduce(budget) { partial, _ in partial.halved() }
    }
}
