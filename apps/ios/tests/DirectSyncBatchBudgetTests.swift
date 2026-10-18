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
        // ── P1-4（2026-10-18 同步诊断）：记录条数改为**字节驱动** ──
        // 旧实现抄服务端 `maxRecords × 0.9`（4500）当 XML 记录条数上限；可服务端直连车道
        // **只对删除配额**用这个数，对 XML 记录条数没有硬上界（`exceedsServerBounds` 的注释）。
        // 结果每批被 4500 卡住、字节只用 29%，重放期被切成 118 批。
        // 新式：min(12_000, max(4_500, 7_549_747 / 480)) = 12_000。
        check(budget.maxRecords == 12_000,
              "records budget is byte-driven and capped at 12,000 (7.55 MB / 480 B per record ≈ 15.7k)")
        check(budget.maxRecords > 4_500,
              "the byte-driven record budget must actually lift the old 4,500 self-imposed ceiling")
        check(budget.maxDeletions == 4_500, "deletions budget = 5000 × 0.9 (server deletion quota is maxRecords)")
        check(budget.maxRouteFiles == 180, "route files budget = 200 × 0.9")
        check(budget.maxRouteBytes == 60_397_977, "route bytes budget = 64 MiB × 0.9")
        check(DirectSyncBatchBudget.from(bounds: nil) == DirectSyncBatchBudget.conservative,
              "missing bounds falls back to the conservative constant")

        // P1-4 边界：下限 4,500 不被小字节预算缩水；上限 12,000 封顶；两者之间按字节换算。
        let tinyBounds = DirectSyncBounds(
            maxXmlBytes: 512 * 1024, maxRecords: 5_000,
            maxRouteFiles: 200, maxRouteBytes: 64 * 1024 * 1024
        )
        let tinyBudget = DirectSyncBatchBudget.from(bounds: tinyBounds)
        check(tinyBudget.maxXmlBytes == 471_859, "a 512 KiB server bound yields a 471,859 B client budget")
        check(tinyBudget.maxRecords == 4_500,
              "a tiny xml budget keeps the 4,500 floor (shrinking it only splits more batches)")
        let midBounds = DirectSyncBounds(
            maxXmlBytes: 3 * 1024 * 1024, maxRecords: 5_000,
            maxRouteFiles: 200, maxRouteBytes: 64 * 1024 * 1024
        )
        let midBudget = DirectSyncBatchBudget.from(bounds: midBounds)
        check(midBudget.maxXmlBytes == 2_831_155, "a 3 MiB server bound yields a 2,831,155 B client budget")
        check(midBudget.maxRecords == 2_831_155 / 480,
              "between the floor and the cap the record budget is exactly xmlBytes/480 (byte-driven)")
        check(midBudget.maxRecords > 4_500 && midBudget.maxRecords < 12_000,
              "the middle case proves both the floor and the cap are inert where they should be")
        check(budget.maxRecords == min(12_000, max(4_500, budget.maxXmlBytes / 480)),
              "the production formula is min(12_000, max(4_500, xmlBytesBudget / 480))")
        let hugeBounds = DirectSyncBounds(
            maxXmlBytes: 64 * 1024 * 1024, maxRecords: 5_000,
            maxRouteFiles: 200, maxRouteBytes: 64 * 1024 * 1024
        )
        check(DirectSyncBatchBudget.from(bounds: hugeBounds).maxRecords == 12_000,
              "the 12,000 cap holds even for a much larger server bound")

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

        // ── P2-06（2026-10-18 深度审查）：子通道**独立份额**，anchor 流保底 ──
        // 缺陷形态：迟到样本补读只受全量 `accepts` 约束，而它排在窗口 pass 与 anchor 循环
        // **之前** ⇒ 4 类型 × 1500 条足以吃光整批预算，让心率/睡眠/步数零进展。失效方向是
        // "同步变慢且无从归因"，不在任何既有判据里。
        let conservativeBudget = DirectSyncBatchBudget.conservative
        let windowSubShare = DirectSyncBatchBudget.recentWindowShare(of: conservativeBudget)
        let backfillShare = DirectSyncBatchBudget.lateBackfillShare(of: conservativeBudget)
        check(windowSubShare.maxRecords == 900 && windowSubShare.maxBytes == 377_487,
              "the recent-window share stays at 20% of the batch (900 records / 377,487 B)")
        check(backfillShare.maxRecords == 642 && backfillShare.maxBytes == 269_633,
              "the late-backfill share is 1/7 (≈14.3%) — strictly below the 15% ceiling")
        // P0-4：workout 定向补齐窗口的独立份额 = 25%（排在迟到补读/48h 窗口/anchor 之前）。
        let workoutWindowShare = DirectSyncBatchBudget.workoutWindowShare(of: conservativeBudget)
        check(workoutWindowShare.maxRecords == 1_125 && workoutWindowShare.maxBytes == 471_859,
              "the workout-backfill share is 25% of the batch (1,125 records / 471,859 B)")
        check(workoutWindowShare.maxRecords + windowSubShare.maxRecords + backfillShare.maxRecords
                <= conservativeBudget.maxRecords * 60 / 100,
              "workout window (25%) + recent window (20%) + late backfill (1/7) still leave "
              + "the anchored stream ≥40% of the record budget")
        check(workoutWindowShare.maxRecords + windowSubShare.maxRecords + backfillShare.maxRecords
                <= conservativeBudget.maxRecords,
              "the three sub-channel shares never add up to more than the whole batch")
        check(windowSubShare.maxRecords + backfillShare.maxRecords <= conservativeBudget.maxRecords * 35 / 100,
              "window + backfill leave at least 65% of the RECORD budget to the anchored stream")
        check(windowSubShare.maxBytes + backfillShare.maxBytes <= conservativeBudget.maxXmlBytes * 35 / 100,
              "window + backfill leave at least 65% of the BYTE budget to the anchored stream")

        // 份额裁决：页必须**同时**满足份额与全量预算（任一条不满足都拒绝）。
        check(DirectSyncBatchBudget.acceptsWithin(
                budget: conservativeBudget, share: backfillShare,
                shareBytesUsed: 0, shareRecordsUsed: 0,
                xmlBytes: 0, records: 0,
                pageBytes: 269_633, pageRecords: 642),
              "a page that exactly fills the backfill share is accepted")
        check(!DirectSyncBatchBudget.acceptsWithin(
                budget: conservativeBudget, share: backfillShare,
                shareBytesUsed: 0, shareRecordsUsed: 0,
                xmlBytes: 0, records: 0,
                pageBytes: 269_634, pageRecords: 642),
              "one byte over the share is rejected while the full budget still has room")
        check(!DirectSyncBatchBudget.acceptsWithin(
                budget: conservativeBudget, share: backfillShare,
                shareBytesUsed: 269_633 - 10, shareRecordsUsed: 0,
                xmlBytes: 0, records: 0,
                pageBytes: 11, pageRecords: 1),
              "bytes already written by the same sub-channel count against its share (per batch, not per page)")
        check(!DirectSyncBatchBudget.acceptsWithin(
                budget: conservativeBudget, share: (maxBytes: conservativeBudget.maxXmlBytes,
                                                   maxRecords: conservativeBudget.maxRecords),
                shareBytesUsed: 0, shareRecordsUsed: 0,
                xmlBytes: UInt64(conservativeBudget.maxXmlBytes - 5), records: 0,
                pageBytes: 10, pageRecords: 1),
              "the share never overrides the full-batch budget either — both gates must pass")

        // 份额必须能**装下一整页**，否则补读会被自己的闸门锁死（满页 1500 条 > 642 条份额）。
        check(DirectSyncBatchBudget.shareLimitedPageSize(
                pageLimit: 1500, shareBytesLeft: 269_633, shareRecordsLeft: 642, estimatePerRecord: 512) == 526,
              "the page limit shrinks to the share's byte room (269,633 / 512 B per record)")
        check(DirectSyncBatchBudget.shareLimitedPageSize(
                pageLimit: 1500, shareBytesLeft: 10_000_000, shareRecordsLeft: 116, estimatePerRecord: 250) == 116,
              "the page limit also shrinks to the share's remaining record count")
        check(DirectSyncBatchBudget.shareLimitedPageSize(
                pageLimit: 1500, shareBytesLeft: 0, shareRecordsLeft: 642, estimatePerRecord: 512) == 0,
              "an exhausted share reports 0 (the caller defers the whole channel to the next batch)")
        check(DirectSyncBatchBudget.shareLimitedPageSize(
                pageLimit: 1500, shareBytesLeft: 50, shareRecordsLeft: 642, estimatePerRecord: 512) == 1,
              "a nearly exhausted share still admits one record (progress is never zero while room remains)")

        // 高密度场景（审查 §I1 的量化）：4 个跑步动态类型、各 1500 条 / 每条 250 B。
        // 用生产同款纯函数模拟两批补读 ⇒ (a) 首批绝不越过份额；(b) 首批确实有进展（不冻结）；
        // (c) 每批之后 anchor 流都还剩 ≥65% 的行/字节额度。
        func simulateBackfillBatch() -> (records: Int, bytes: Int) {
            var usedBytes = 0
            var usedRecords = 0
            var committedBytes = 0
            var committedRecords = 0
            for _ in 0..<4 {
                let estimate = usedRecords > 0 ? max(1, usedBytes / usedRecords) : 512
                let pageLimit = DirectSyncBatchBudget.shareLimitedPageSize(
                    pageLimit: 1500,
                    shareBytesLeft: backfillShare.maxBytes - usedBytes,
                    shareRecordsLeft: backfillShare.maxRecords - usedRecords,
                    estimatePerRecord: estimate)
                guard pageLimit > 0 else { continue }
                let pageBytes = pageLimit * 250
                guard DirectSyncBatchBudget.acceptsWithin(
                    budget: conservativeBudget, share: backfillShare,
                    shareBytesUsed: usedBytes, shareRecordsUsed: usedRecords,
                    xmlBytes: UInt64(committedBytes), records: committedRecords,
                    pageBytes: pageBytes, pageRecords: pageLimit) else { continue }
                usedBytes += pageBytes; usedRecords += pageLimit
                committedBytes += pageBytes; committedRecords += pageLimit
            }
            return (committedRecords, committedBytes)
        }
        let firstBackfillBatch = simulateBackfillBatch()
        check(firstBackfillBatch.records > 0,
              "the share-limited backfill still makes progress in the first batch (it must not freeze)")
        check(firstBackfillBatch.records <= backfillShare.maxRecords
                && firstBackfillBatch.bytes <= backfillShare.maxBytes,
              "a 4-type × 1500-record backfill never exceeds its share (before P2-06 it took the whole budget)")
        check(conservativeBudget.maxRecords - firstBackfillBatch.records >= conservativeBudget.maxRecords * 65 / 100,
              "the anchored stream still gets at least 65% of the record budget after the backfill")
        check(conservativeBudget.maxXmlBytes - firstBackfillBatch.bytes >= conservativeBudget.maxXmlBytes * 65 / 100,
              "the anchored stream still gets at least 65% of the byte budget after the backfill")
        let secondBackfillBatch = simulateBackfillBatch()
        check(secondBackfillBatch.records > 0,
              "the next batch refreshes the share, so multi-batch paging keeps moving (no starvation)")

        // 第二趟（top-up）语义（P2-06 的收敛半边）：anchor 流跑完后把**剩余全量预算**当作
        // 这一趟的额度 ⇒ 同一份 4 类型 / 1500 条/类 的载荷一次能用满整批。没有它，15% 份额
        // 会把 14 天窗口拉成上百批（642 条/批 vs 4500 条/批）。
        func simulateTopUpPass() -> Int {
            let limitBytes = conservativeBudget.maxXmlBytes
            let limitRecords = conservativeBudget.maxRecords
            var usedBytes = 0
            var usedRecords = 0
            var committedRecords = 0
            for _ in 0..<4 {
                let estimate = usedRecords > 0 ? max(1, usedBytes / usedRecords) : 512
                let pageLimit = DirectSyncBatchBudget.shareLimitedPageSize(
                    pageLimit: 1500,
                    shareBytesLeft: limitBytes - usedBytes,
                    shareRecordsLeft: limitRecords - usedRecords,
                    estimatePerRecord: estimate)
                guard pageLimit > 0 else { continue }
                let pageBytes = pageLimit * 250
                guard DirectSyncBatchBudget.acceptsWithin(
                    budget: conservativeBudget,
                    share: (maxBytes: limitBytes, maxRecords: limitRecords),
                    shareBytesUsed: usedBytes, shareRecordsUsed: usedRecords,
                    xmlBytes: UInt64(usedBytes), records: usedRecords,
                    pageBytes: pageBytes, pageRecords: pageLimit) else { continue }
                usedBytes += pageBytes; usedRecords += pageLimit; committedRecords += pageLimit
            }
            return committedRecords
        }
        let topUpRecords = simulateTopUpPass()
        check(topUpRecords == conservativeBudget.maxRecords,
              "the top-up pass fills the whole remaining budget (3 × 1500 = 4500 records), so a dense "
              + "14-day window converges in a handful of batches instead of ~100 at the 15% share alone")
        check(topUpRecords > firstBackfillBatch.records * 5,
              "the top-up pass is more than five times the share-limited pass (measured: 4500 vs 642)")
        check(topUpRecords <= conservativeBudget.maxRecords,
              "even the top-up pass never exceeds the batch budget")

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

        // ── WP-12（O03）删除队列守恒 ─────────────────────────────────────────────
        // 🔴 缺陷本体：R3b 的旧实现用 `prefix` 截断旧槽后**丢弃尾部** ⇒ 那些删除随 anchor
        // 推进永久丢失。以下断言把它钉死：①尾部必须进余量 ②三批 10,000 条全量交付
        // ③去重后 `发送 ∩ 下批 = ∅`（身份 = record (type, 小写 uuid) / 小写 uuid）。
        let tenThousandDeletions: [[String: String]] = (0..<10_000).map {
            ["type": "HKQuantityTypeIdentifierHeartRate", "uuid": String(format: "u-%05d", $0)]
        }
        let roundOne = DirectSyncDeletionPartition.plan(
            pending: DirectSyncPendingDeletions(recordDeletions: tenThousandDeletions, workoutIds: []),
            freshWorkoutIds: [],
            budget: 4_500
        )
        check(roundOne.stashRecordDeletions.count == 4_500,
              "round 1 sends exactly the deletion budget (4,500 of 10,000)")
        check(roundOne.pendingRecordDeletions.count == 5_500,
              "round 1 keeps the TAIL in the durable backlog (the old prefix-drop lost exactly these)")
        let roundTwo = DirectSyncDeletionPartition.plan(
            pending: DirectSyncPendingDeletions(recordDeletions: roundOne.pendingRecordDeletions, workoutIds: []),
            freshWorkoutIds: [],
            budget: 4_500
        )
        check(roundTwo.stashRecordDeletions.count == 4_500 && roundTwo.pendingRecordDeletions.count == 1_000,
              "round 2 sends 4,500 and the backlog shrinks to 1,000")
        let roundThree = DirectSyncDeletionPartition.plan(
            pending: DirectSyncPendingDeletions(recordDeletions: roundTwo.pendingRecordDeletions, workoutIds: []),
            freshWorkoutIds: [],
            budget: 4_500
        )
        check(roundThree.stashRecordDeletions.count == 1_000 && roundThree.pendingRecordDeletions.isEmpty,
              "round 3 drains the remaining 1,000 and the backlog is empty")
        let delivered = Set(
            (roundOne.stashRecordDeletions + roundTwo.stashRecordDeletions + roundThree.stashRecordDeletions)
                .compactMap { $0["uuid"] }
        )
        check(delivered.count == 10_000,
              "the three rounds deliver all 10,000 deletions exactly once (sends form the input set)")

        // 去重：重复条目只保留第一条；额度只扣**实际发送的唯一引用**。
        let dedup = DirectSyncDeletionPartition.plan(
            pending: DirectSyncPendingDeletions(
                recordDeletions: [
                    ["type": "T", "uuid": "ABC"], ["type": "T", "uuid": "abc"],
                    ["type": "T", "uuid": "ABC"], ["type": "T", "uuid": "OTHER"]
                ],
                workoutIds: ["W-XYZ", "w-xyz"]
            ),
            freshWorkoutIds: ["W-XYZ", "w-new"],
            budget: 4_500
        )
        check(dedup.stashRecordDeletions.count == 2,
              "duplicate record deletions (same type + case-insensitive uuid) collapse before spending quota")
        check(dedup.stashWorkoutIds.count == 1 && dedup.keptWorkoutIds.count == 1,
              "duplicate workout deletions collapse across the old slot AND the fresh batch")
        check(dedup.pendingRecordDeletions.isEmpty && dedup.pendingWorkoutIds.isEmpty
              && dedup.overflowWorkoutIds.isEmpty,
              "nothing lands in the next batch when everything fits (sends ∩ backlog = ∅)")

        // 溢出链与剩余额度：旧 record → 旧 workout → 新 workout 依次占额，record 侧拿剩余。
        let overflowChain = DirectSyncDeletionPartition.plan(
            pending: DirectSyncPendingDeletions(
                recordDeletions: (0..<100).map { ["type": "T", "uuid": "r-\($0)"] },
                workoutIds: (0..<100).map { "w-\($0)" }
            ),
            freshWorkoutIds: (0..<100).map { "f-\($0)" },
            budget: 150
        )
        check(overflowChain.stashRecordDeletions.count == 100, "old record deletions take quota first")
        check(overflowChain.stashWorkoutIds.count == 50, "old workout deletions use the remaining 50")
        check(overflowChain.pendingWorkoutIds.count == 50,
              "the old-slot workout tail goes to the backlog, not the void")
        check(overflowChain.overflowWorkoutIds.count == 100, "the whole fresh workout batch overflows")
        check(overflowChain.remainingRecordBudget == 0, "the fresh record allocation gets what is left (zero)")

        // 零预算与恰好装下两个边界。
        let zeroBudget = DirectSyncDeletionPartition.plan(
            pending: DirectSyncPendingDeletions(
                recordDeletions: [["type": "T", "uuid": "a"]], workoutIds: ["w"]
            ),
            freshWorkoutIds: ["f"],
            budget: 0
        )
        check(zeroBudget.stashRecordDeletions.isEmpty && zeroBudget.pendingRecordDeletions.count == 1
              && zeroBudget.pendingWorkoutIds.count == 1 && zeroBudget.overflowWorkoutIds.count == 1,
              "a zero budget keeps every deletion in the durable backlog (nothing is dropped)")
        let exact = DirectSyncDeletionPartition.plan(
            pending: DirectSyncPendingDeletions(recordDeletions: [], workoutIds: ["w"]),
            freshWorkoutIds: ["f"],
            budget: 2
        )
        check(exact.stashWorkoutIds == ["w"] && exact.keptWorkoutIds == ["f"]
              && exact.remainingRecordBudget == 0,
              "an exactly-fitting budget accepts both and leaves nothing")

        // 三态恢复（任务行 → 余量）：老任务缺键 / 显式空 / 非空 / 损坏。
        check(DirectSyncPendingDeletions.restoredFromTask(nil) == .notRecorded,
              "a legacy task (key absent) restores as notRecorded — the slot stays untouched")
        if let emptyData = try? JSONEncoder().encode(DirectSyncPendingDeletions()) {
            check(DirectSyncPendingDeletions.restoredFromTask(emptyData) == .decoded(.empty),
                  "an explicit empty object restores as decoded empty — the commit clears the slot")
        } else {
            check(false, "the empty payload must encode")
        }
        if let realData = try? JSONEncoder().encode(pending),
           case .decoded(let restored) = DirectSyncPendingDeletions.restoredFromTask(realData) {
            check(restored == pending, "a real backlog round-trips through the task row")
        } else {
            check(false, "a real backlog must round-trip through the task row")
        }
        check(DirectSyncPendingDeletions.restoredFromTask(Data("###not-json###".utf8)) == .corrupted,
              "a corrupted payload restores as corrupted — the caller must fail, never advance as empty")

        // ── O01（WP-10）workout 页收缩：严格下降、有限步到单条、单条仍放不下 = 可见阻塞 ──
        // （页循环的"每轮至少前进一格"就靠这条链：拒绝 → 缩半 → 重查同一锚点。）
        check(WorkoutPageShrink.nextLimit(after: 1_000) == 500, "shrinking halves the query page")
        check(WorkoutPageShrink.nextLimit(after: 3) == 1, "shrinking clamps to a single workout")
        check(WorkoutPageShrink.nextLimit(after: 2) == 1, "exactly two shrinks to one")
        check(WorkoutPageShrink.nextLimit(after: 1) == nil,
              "a single-workout page that still does not fit is the visible-blocked exit (not a loop)")
        check(WorkoutPageShrink.nextLimit(after: 0) == nil, "a zero limit is already blocked")
        var shrinkSteps = 0
        var shrinkLimit = 1_000
        while let next = WorkoutPageShrink.nextLimit(after: shrinkLimit) {
            shrinkLimit = next
            shrinkSteps += 1
        }
        check(shrinkLimit == 1 && shrinkSteps <= 10,
              "the shrink chain terminates at one within bounded steps (1000 → … → 1 → nil)")

        // ── O05（WP-13）窗口独立份额 = 单批总预算的 20%（初始值 1/5，待基准校准） ──
        let windowShare = DirectSyncBatchBudget.recentWindowShare(of: budget)
        check(windowShare.maxBytes == budget.maxXmlBytes / 5
              && windowShare.maxRecords == budget.maxRecords / 5,
              "the recent-window share is one fifth of the batch budget")
        check(windowShare.maxBytes < budget.maxXmlBytes && windowShare.maxRecords < budget.maxRecords,
              "the window share must never equal the whole batch budget — 80% is reserved for the anchored stream")

        // ── R04（2026-10-16 复查）批次级路线清单的跨页去重 ──────────────────────────
        // 缺陷本体：页 1 的"附件"版本与页 N 的"正式流"版本各自收录同一路径
        //（`workout-routes/<uuid>_1.gpx`）⇒ ZIP 里同名两个条目 ⇒ 接收器整批拒收。
        // 语义：①跨页身份 = 相对路径；②同名再现 = 后写版本**替换**（不是丢弃）；
        // ③顺序 = 首次出现顺序（确定性）。
        var batch = RouteBatchFileList()
        let pageOneURL = URL(fileURLWithPath: "/tmp/page-1/workout-routes/aaaa_1.gpx")
        let pageTwoURL = URL(fileURLWithPath: "/tmp/page-2/workout-routes/aaaa_1.gpx")
        let otherURL = URL(fileURLWithPath: "/tmp/page-1/workout-routes/bbbb_1.gpx")
        batch.merge([
            ("workout-routes/aaaa_1.gpx", pageOneURL),
            ("workout-routes/bbbb_1.gpx", otherURL)
        ])
        check(batch.count == 2, "two distinct paths land in the batch list")
        batch.merge([("workout-routes/aaaa_1.gpx", pageTwoURL)])
        check(batch.count == 2, "a cross-page repeat does not grow the manifest")
        check(batch.files.map { $0.name } == ["workout-routes/aaaa_1.gpx", "workout-routes/bbbb_1.gpx"],
              "first-seen order is preserved across pages")
        check(batch.files.first?.url == pageTwoURL,
              "the later page's version replaces the earlier reference (the repeat is never dropped)")
        var intraPage = RouteBatchFileList()
        intraPage.merge([
            ("workout-routes/cccc_1.gpx", pageOneURL),
            ("workout-routes/cccc_1.gpx", pageOneURL)
        ])
        check(intraPage.count == 1 && intraPage.files.count == 1,
              "intra-page repeats collapse to one entry")
        check(RouteBatchFileList().files.isEmpty, "an empty list expands to nothing")

        print("\(checks) checks passed")
    }
}
