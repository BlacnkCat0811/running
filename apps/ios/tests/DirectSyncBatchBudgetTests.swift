import Foundation

/// `DirectSyncBatchBudget` 的换算与边界判据（S2.1–S2.2 + 2026-10-14 route 维度补全）。
///
/// 为什么值得测：预算错的失效方向全是静默的——换算漏了 0.9 会让载荷贴着服务端硬上界
/// （一次超界即被显式拒绝，收口后没有回退兜底）；`routeBudgetExhausted` 的边界写错
/// （`>` vs `>=`）会在恰好等于上界时放行一个必被拒的批。两者都不会编译不过、
/// 也不会在真机上显式报错——只有这里的边界用例能当场抓住。
///
/// 反向的代价也要记住：本文件**不**证明收集循环会在正确的位置调用闸门
/// （"先判后取、状态与文件同进同退"的接线断言在 `check-healthkit-record-sync.py` 的结构门禁里）。
@main
struct DirectSyncBatchBudgetTests {
    static func main() {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            precondition(condition(), name)
            checks += 1
            print("PASS: \(name)")
        }

        // 保守常量：老服务端（缺 bounds）时的回落，全部按"老上界 × 0.9 向下取整"。
        check(DirectSyncBatchBudget.conservative.maxXmlBytes == 1_887_436,
              "conservative xml bytes = 2 MiB × 0.9")
        check(DirectSyncBatchBudget.conservative.maxRecords == 4_500,
              "conservative records = 5000 × 0.9")
        check(DirectSyncBatchBudget.conservative.maxRouteFiles == 180,
              "conservative route files = 200 × 0.9")
        check(DirectSyncBatchBudget.conservative.maxRouteBytes == 30_198_988,
              "conservative route bytes = 32 MiB × 0.9")

        // 换算：服务端 bounds × 0.9（含 2026-10-14 放宽后的新上界 8 MiB / 64 MiB）。
        let bounds = DirectSyncBounds(
            maxXmlBytes: 8 * 1024 * 1024,
            maxRecords: 5000,
            maxRouteFiles: 200,
            maxRouteBytes: 64 * 1024 * 1024
        )
        let budget = DirectSyncBatchBudget.from(bounds: bounds)
        check(budget.maxXmlBytes == 7_549_747, "xml bytes budget = 8 MiB × 0.9")
        check(budget.maxRecords == 4_500, "records budget = 5000 × 0.9")
        check(budget.maxDeletions == 4_500, "deletions budget = 5000 × 0.9 (server deletion quota is maxRecords)")
        check(budget.maxRouteFiles == 180, "route files budget = 200 × 0.9")
        check(budget.maxRouteBytes == 60_397_977, "route bytes budget = 64 MiB × 0.9")
        check(DirectSyncBatchBudget.from(bounds: nil) == DirectSyncBatchBudget.conservative,
              "missing bounds falls back to the conservative constant")

        // route 闸门边界：恰好等于上界即"已到上界"（>= 语义）——fetch 侧据此停手。
        let probe = DirectSyncBatchBudget(
            maxXmlBytes: 100, maxRecords: 10, maxDeletions: 10, maxRouteFiles: 4, maxRouteBytes: 200
        )
        check(!probe.routeBudgetExhausted(routeBytes: 0, routeFiles: 0),
              "empty accumulator is not exhausted")
        check(!probe.routeBudgetExhausted(routeBytes: 199, routeFiles: 3),
              "just below both limits is not exhausted")
        check(probe.routeBudgetExhausted(routeBytes: 200, routeFiles: 0),
              "bytes at the limit are exhausted")
        check(probe.routeBudgetExhausted(routeBytes: 0, routeFiles: 4),
              "files at the limit are exhausted")
        check(probe.routeBudgetExhausted(routeBytes: 250, routeFiles: 9),
              "over both limits is exhausted")

        // 写前判定（S2.5）：`accepts` 问的是"**加上这一整页**还放得下吗"，不是"现在已经超了吗"。
        // 边界必须是 `<=`：恰好把额度用满是**放得下**（继续读下一页，由下一页自己判断放不下）。
        check(probe.accepts(xmlBytes: 0, records: 0, pageBytes: 100, pageRecords: 10),
              "a page that exactly fills the budget is accepted")
        check(!probe.accepts(xmlBytes: 0, records: 0, pageBytes: 101, pageRecords: 10),
              "one byte over the xml budget is rejected")
        check(!probe.accepts(xmlBytes: 0, records: 0, pageBytes: 100, pageRecords: 11),
              "one record over the record budget is rejected")
        check(!probe.accepts(xmlBytes: 60, records: 0, pageBytes: 41, pageRecords: 1),
              "the already-committed bytes count against the page (this is what the page-end check missed)")
        check(probe.accepts(xmlBytes: 60, records: 0, pageBytes: 40, pageRecords: 1),
              "the remaining room is what the page is measured against")
        check(!probe.accepts(xmlBytes: 100, records: 10, pageBytes: 1, pageRecords: 1),
              "a full budget rejects any further page")

        // 收缩估算：用本页实测的每记录字节推"还能取几条"，且**永远 ≥1**（否则退化成死循环）。
        check(probe.shrinkLimit(pageBytes: 1000, pageRecords: 10, usedXmlBytes: 0, usedRecords: 0) == 1,
              "0.1 B per record estimate still floors at one record, never zero")
        check(probe.shrinkLimit(pageBytes: 100, pageRecords: 10, usedXmlBytes: 0, usedRecords: 0) == 10,
              "10 B per record fits ten records into a 100 B budget")
        check(probe.shrinkLimit(pageBytes: 100, pageRecords: 10, usedXmlBytes: 50, usedRecords: 0) == 5,
              "only the remaining room counts")
        check(probe.shrinkLimit(pageBytes: 100, pageRecords: 10, usedXmlBytes: 0, usedRecords: 8) == 2,
              "the remaining record budget also caps the estimate")
        check(probe.shrinkLimit(pageBytes: 0, pageRecords: 0, usedXmlBytes: 0, usedRecords: 0) == 1,
              "a page with no records cannot produce a zero estimate")

        // 下溢边界（R4 修复，2026-10-15）：已用字节 ≥ 上限时旧的 `UInt64 - UInt64` 是算术陷阱
        // （SIGILL 杀进程，`max(0, …)` 拦不住——它在外层）。触发路径真实存在：workout XML 在
        // 记录分页前没有写前闸门，可先把 `offsetInFile` 推过预算。判据只能是"不崩溃且返回 ≥1"；
        // 返回 1 后由 `drain` 的 `limit == 1` 零提交收手兜底，不退化成死循环。
        check(probe.shrinkLimit(pageBytes: 100, pageRecords: 10, usedXmlBytes: 100, usedRecords: 0) == 1,
              "used bytes at exactly the xml cap returns one instead of trapping")
        check(probe.shrinkLimit(pageBytes: 100, pageRecords: 10, usedXmlBytes: 101, usedRecords: 0) == 1,
              "one byte over the xml cap returns one instead of underflowing")
        check(probe.shrinkLimit(pageBytes: 100, pageRecords: 10, usedXmlBytes: 1_000_000, usedRecords: 0) == 1,
              "far over the xml cap still returns one")
        check(probe.shrinkLimit(pageBytes: 100, pageRecords: 10, usedXmlBytes: 101, usedRecords: 99) == 1,
              "over the xml cap with the record budget also exhausted returns one")
        check(probe.shrinkLimit(pageBytes: 0, pageRecords: 0, usedXmlBytes: 101, usedRecords: 0) == 1,
              "an empty page over the xml cap returns one")

        // 缩一档（`halved`）：四维同时折半，且**永不落到 0**。
        // 落 0 的失效方式很安静：`accepts` 会把每一页都判成放不下 ⇒ 收缩路径一路走到
        // `limit == 1` 才收手（有界，但该类型本轮零进展、每批都是空批）。
        let halved = DirectSyncBatchBudget.conservative.halved()
        check(halved.maxXmlBytes == 943_718, "halving the xml budget is exact integer division")
        check(halved.maxRecords == 2_250, "halving the record budget is exact integer division")
        check(halved.maxDeletions == 2_250, "halving the deletions budget is exact integer division")
        check(halved.maxRouteFiles == 90, "halving the route file budget is exact integer division")
        check(halved.maxRouteBytes == 15_099_494, "halving the route byte budget is exact integer division")
        let atFloor = DirectSyncBatchBudget(maxXmlBytes: 1, maxRecords: 1, maxDeletions: 1, maxRouteFiles: 1, maxRouteBytes: 1)
        check(atFloor.halved() == atFloor, "halving never reaches zero: every dimension floors at one")

        // 删除分配器（R3b，2026-10-15）：装得下就记账、装不下进溢出；**绝不丢弃**
        // （截断但暂存才是合法形态 —— 审计禁止的只是"截断却不暂存"）。
        let allocation = DirectSyncDeletionAllocation(remaining: 2)
        check(allocation.allocate(uuid: "a", type: "T1"), "first deletion fits")
        check(allocation.allocate(uuid: "b", type: "T2"), "second deletion fits")
        check(!allocation.allocate(uuid: "c", type: "T1"), "third deletion overflows")
        check(allocation.remaining == 0, "allocation reports zero remaining after exhaustion")
        check(allocation.overflow == [["type": "T1", "uuid": "c"]],
              "overflow keeps the full record for the next batch")
        let negative = DirectSyncDeletionAllocation(remaining: -5)
        check(!negative.allocate(uuid: "x", type: "T1"),
              "a negative starting budget refuses everything (never traps)")

        // 溢出载荷的编解码往返（它就是 `sync_pending_deletions` 槽里的字节）。
        let pending = DirectSyncPendingDeletions(
            recordDeletions: [["type": "A", "uuid": "u1"]], workoutIds: ["w1"]
        )
        check(!pending.isEmpty, "non-empty payload reports non-empty")
        check(DirectSyncPendingDeletions.empty.isEmpty, "the empty constant is empty")
        if let data = try? JSONEncoder().encode(pending),
           let round = try? JSONDecoder().decode(DirectSyncPendingDeletions.self, from: data) {
            check(round == pending, "pending deletions round-trip through JSON")
        } else {
            check(false, "pending deletions must round-trip through JSON")
        }

        // 本地自校验（P2b）：比的是**服务端硬上界**，边界与 `accepts` 同向
        // （恰好等于上界**不算**超 —— 服务端那三处判据用的都是严格 `>`）。
        // 四个维度逐条对齐 `apps/api/src/direct-sync-ingest.ts`：xml :418 / route :369 / deletions :440。
        let maxXml = 8 * 1024 * 1024
        let maxRouteBytes = 64 * 1024 * 1024
        check(!budget.exceedsServerBounds(bounds: bounds, xmlBytes: maxXml, deletions: 5_000,
                                          routeBytes: maxRouteBytes, routeFiles: 200),
              "a payload exactly at every server bound is NOT over it (the server uses strict >)")
        check(budget.exceedsServerBounds(bounds: bounds, xmlBytes: maxXml + 1, deletions: 0,
                                         routeBytes: 0, routeFiles: 0),
              "one byte over the server xml bound is over")
        check(budget.exceedsServerBounds(bounds: bounds, xmlBytes: 0, deletions: 5_001,
                                         routeBytes: 0, routeFiles: 0),
              "one deletion over the server record bound is over (deletions, not XML record count)")
        check(budget.exceedsServerBounds(bounds: bounds, xmlBytes: 0, deletions: 0,
                                         routeBytes: maxRouteBytes + 1, routeFiles: 0),
              "one byte over the server route byte bound is over")
        check(budget.exceedsServerBounds(bounds: bounds, xmlBytes: 0, deletions: 0,
                                         routeBytes: 0, routeFiles: 201),
              "one file over the server route file bound is over")

        // 收敛档位（P1b）：`apply` = 折半 `steps` 次；`advanced` **幂等封顶** ——
        // 到顶后再触发不会越界，也不会让 `apply` 多折半一档（那会让"缩预算 + 每次全量导出"
        // 变成一个没有出口的昂贵循环）。
        check(DirectSyncBudgetConvergence.initial.apply(to: budget) == budget,
              "zero steps is the identity: an unconverged sync uses the full handshake budget")
        check(DirectSyncBudgetConvergence(steps: 1).apply(to: budget) == budget.halved(),
              "one step halves the budget once")
        let twiceHalved = budget.halved().halved()
        check(DirectSyncBudgetConvergence(steps: 2).apply(to: budget) == twiceHalved,
              "two steps halve twice")
        check(DirectSyncBudgetConvergence.maxSteps == 3 && !DirectSyncBudgetConvergence(steps: 2).isExhausted,
              "two steps is not yet exhausted")
        check(DirectSyncBudgetConvergence.initial.advanced() == DirectSyncBudgetConvergence(steps: 1),
              "advancing from zero lands on one step")
        let capped = DirectSyncBudgetConvergence(steps: DirectSyncBudgetConvergence.maxSteps)
        check(capped.isExhausted, "the cap is where exhaustion starts")
        check(capped.advanced() == capped,
              "advancing past the cap is a no-op: repeated rejections cannot shrink the budget without limit")

        print("\(checks) checks passed")
    }
}
