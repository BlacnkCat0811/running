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
        check(budget.maxRouteFiles == 180, "route files budget = 200 × 0.9")
        check(budget.maxRouteBytes == 60_397_977, "route bytes budget = 64 MiB × 0.9")
        check(DirectSyncBatchBudget.from(bounds: nil) == DirectSyncBatchBudget.conservative,
              "missing bounds falls back to the conservative constant")

        // route 闸门边界：恰好等于上界即"已到上界"（>= 语义）——fetch 侧据此停手。
        let probe = DirectSyncBatchBudget(
            maxXmlBytes: 100, maxRecords: 10, maxRouteFiles: 4, maxRouteBytes: 200
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

        // xml 判据不受 route 字段影响（既有语义的回归）。
        check(!probe.exceeded(xmlBytes: 99, records: 9), "xml below limit is not exceeded")
        check(probe.exceeded(xmlBytes: 100, records: 0), "xml at the limit trips exceeded")

        print("\(checks) checks passed")
    }
}
