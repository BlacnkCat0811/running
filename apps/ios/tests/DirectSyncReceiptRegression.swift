import Foundation

/// 直连回执 / 游标闸门 / 持久任务新字段的纯逻辑回归
/// （`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §5.1 / §9.1 / §10.1 / §10.2）。
///
/// 为什么这些判据必须有执行者：它们决定"这一页的游标能不能提交"与"后台待办意图要不要留着"，
/// 而两种错法在设备上**都没有症状** —— 游标推进早了，那段窗口从此不会再被任何一次 anchored
/// query 返回（§3.4 的"绝对严禁视为空数据推进 Anchor"）；意图清早了，用户不打开 App 就再也没人
/// 接着发下一批（§10.2）。`HealthKitSync.swift` 不被任何回归脚本编译（整份锁在
/// `#if os(iOS)` + HealthKit 里），`typecheck-ios.sh` 也只看类型不看执行 ——
/// 所以判据必须落在纯 Foundation 的这一侧，与 `CalibrationState` / `PlanReceiptMatcher`
/// 那两次教训同类：**判据存在 ≠ 判据被执行**。
///
/// ⚠️ 与 `SyncTaskMigrationRegression.swift` 的分工：那个文件钉"旧键还在不在"，
/// 本文件钉"加了三个新键之后，旧 payload 还能不能原样读出来"。两件事分开写，
/// 任一侧被删掉都会各自转红。
@main struct DirectSyncReceiptRegression {
    static func main() {
        var failures = 0
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ name: String) {
            checks += 1
            if condition() {
                print("  ok  \(name)")
            } else {
                failures += 1
                print("  FAIL \(name)")
            }
        }
        func decodeReceipt(_ json: String) -> DirectSyncReceipt? {
            try? JSONDecoder().decode(DirectSyncReceipt.self, from: Data(json.utf8))
        }
        func decodeSummary(_ json: String) -> DirectSyncSummaryEnvelope? {
            try? JSONDecoder().decode(DirectSyncSummaryEnvelope.self, from: Data(json.utf8))
        }
        func decodeTask(_ json: String) -> SyncTaskState? {
            try? JSONDecoder().decode(SyncTaskState.self, from: Data(json.utf8))
        }

        // MARK: A. 回执解码：两个维度各自成立

        let full = decodeReceipt(DirectSyncFixture.committedQueued)
        check(full != nil, "a complete server receipt decodes")
        check(full?.ingestStatus == .committed, "ingestStatus decodes into the closed set")
        check(full?.isCommitted == true, "isCommitted answers only the facts half (§1.4)")
        check(full?.receiptId == "job-42", "receiptId is what a restart reconciles the same batch on (§10.1)")
        check(full?.analysisStatus == .queued, "analysisStatus is decoded independently of ingestStatus")
        check(full?.analysisOutcome == .pending, "committed + queued reads as 'facts saved, analysis pending' (§9.1)")
        check(full?.dependencyGeneration == "7", "dependencyGeneration keeps the server's value")
        check(full?.publishedReleaseId == nil, "a null publishedReleaseId is nil, not an empty string")
        check(full?.parentBatchId == nil, "a null parentBatchId is nil (§5.2 未分片)")

        // 三个"没有值"的键**整键缺席**时同样必须解得开：合同写的是 `string | null`，
        // 而"没这个键"是第三种形态。少一条这样的判据，`decodeIfPresent` 被改成 `decode`
        // 时没有任何断言会说话（老服务端不发这三个键的情况就这样消失）。
        let omitted = decodeReceipt(DirectSyncFixture.committedWithoutOptionalKeys)
        check(omitted != nil, "a receipt that omits the three optional keys decodes")
        check(omitted?.dependencyGeneration == nil && omitted?.publishedReleaseId == nil
                && omitted?.parentBatchId == nil,
              "omitted optional keys decodes as nil, exactly like explicit nulls")

        // 服务端将来加键（§10.1 的 `routeReceipts` 属于 PR3）不得让今天的客户端解码失败。
        let futureKeys = decodeReceipt(DirectSyncFixture.committedWithFutureKeys)
        check(futureKeys?.isCommitted == true,
              "unknown keys next to the receipt are ignored — PR3 may add routeReceipts without breaking iOS")

        // MARK: A2. `summary.directSync` 的三种形态

        // ⚠️ 这两条必须先断言"summary 自己解得开"，再断言"没有回执"：
        // 只写 `decodeSummary(x)?.directSync == nil` 时，替身类型整体解不开也会是绿的
        // （`nil?.directSync` 同样是 nil）—— 那就成了"用失败换绿灯"。
        let noReceipt = decodeSummary(DirectSyncFixture.summaryWithoutReceipt)
        check(noReceipt != nil, "a summary that has no directSync key still decodes as a summary")
        check(noReceipt?.directSync == nil,
              "a summary with no directSync key yields no receipt (老服务端, §10.2)")
        let nullReceipt = decodeSummary(DirectSyncFixture.summaryWithNullReceipt)
        check(nullReceipt != nil, "a summary with an explicit null directSync still decodes")
        check(nullReceipt?.directSync == nil, "an explicit null directSync yields no receipt")
        check(decodeSummary(DirectSyncFixture.summaryWithReceipt)?.directSync?.receiptId == "job-42",
              "an embedded receipt decodes through the summary shape the wiring will add")
        let legacySucceeded = decodeSummary(DirectSyncFixture.legacySummarySucceededWithoutReceipt)
        check(legacySucceeded != nil, "a legacy summary still decodes")
        check(legacySucceeded?.directSync == nil,
              "a legacy summary's single succeeded is NOT a receipt (§10.2)")

        // MARK: B. 解码不得"默认成功"（本文件的突变自检）

        check(decodeReceipt(DirectSyncFixture.unknownIngestStatus) == nil,
              "an ingestStatus the client does not know fails decoding instead of falling back to a known state")
        check(decodeReceipt(DirectSyncFixture.unknownAnalysisStatus) == nil,
              "an analysisStatus the client does not know fails decoding")
        check(decodeReceipt(DirectSyncFixture.upperCaseIngestStatus) == nil,
              "the closed set is case-sensitive: 'Committed' is not 'committed'")
        check(decodeReceipt(DirectSyncFixture.missingIngestStatus) == nil,
              "a receipt without ingestStatus fails — the required keys are the judgement itself")
        check(decodeReceipt(DirectSyncFixture.missingReceiptId) == nil,
              "a receipt without receiptId fails (no restart reconciliation without it)")
        check(decodeReceipt(DirectSyncFixture.missingAnalysisStatus) == nil,
              "a receipt without analysisStatus fails")
        check(DirectSyncIngestStatus(rawValue: "someday") == nil,
              "no fallback exists in the ingest closed set")
        check(DirectSyncAnalysisStatus(rawValue: "in_progress") == nil,
              "no fallback exists in the analysis closed set")

        // 认不出的字面量必须走 `dataCorrupted`，而不是 `keyNotFound`：后者说明键根本没读到，
        // 与"服务端加了新状态"是两件事，处置也不同（前者要等客户端升级，后者是合同破了）。
        do {
            _ = try JSONDecoder().decode(
                DirectSyncReceipt.self, from: Data(DirectSyncFixture.unknownIngestStatus.utf8)
            )
            check(false, "decoding an unknown ingestStatus threw nothing")
        } catch let error as DecodingError {
            if case .dataCorrupted(_) = error {
                check(true, "an unknown ingestStatus throws DecodingError.dataCorrupted")
            } else {
                check(false, "an unknown ingestStatus threw \(error) instead of dataCorrupted")
            }
        } catch {
            check(false, "an unknown ingestStatus threw a non-DecodingError: \(error)")
        }
        do {
            _ = try JSONDecoder().decode(
                DirectSyncReceipt.self, from: Data(DirectSyncFixture.missingIngestStatus.utf8)
            )
            check(false, "decoding a receipt without ingestStatus threw nothing")
        } catch let error as DecodingError {
            if case .keyNotFound(_, _) = error {
                check(true, "a missing ingestStatus throws DecodingError.keyNotFound")
            } else {
                check(false, "a missing ingestStatus threw \(error) instead of keyNotFound")
            }
        } catch {
            check(false, "a missing ingestStatus threw a non-DecodingError: \(error)")
        }

        // MARK: C. 游标闸门（§10.1 / §10.2）

        let committedPublished = DirectSyncReceipt(
            ingestStatus: .committed, receiptId: "r-1", analysisStatus: .published
        )
        let committedQueued = DirectSyncReceipt(
            ingestStatus: .committed, receiptId: "r-2", analysisStatus: .queued
        )
        let applying = DirectSyncReceipt(ingestStatus: .applying, receiptId: "r-3", analysisStatus: .queued)
        let rejected = DirectSyncReceipt(ingestStatus: .rejected, receiptId: "r-4", analysisStatus: .failed)
        let version = DirectSyncReceipt.factsAnalysisContractVersion

        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: committedPublished,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .importing
            ) == .advance,
            "① committed receipt + declared capability + pending cursors advances"
        )
        // R2（2026-10-15）：服务端 no-op（内容与已导入完全一致）的成功现在携带
        // `directSync` 回执（`apps/api/src/import-worker.ts` 的 `writeNoopReceipt`）。
        // 客户端必须能从这份形状走完确认——否则"已建立 job"的分支永远 `.hold(no_receipt)`，
        // 而同内容并发来源是真实网络上可达的触发路径（本轮实证的停滞形态）。
        let noopReceipt = decodeReceipt(DirectSyncFixture.noopCommittedNotRequired)
        check(noopReceipt != nil, "the server's no-op receipt shape decodes")
        check(noopReceipt?.ingestStatus == .committed, "a no-op receipt is committed on the facts half")
        check(noopReceipt?.analysisStatus == .notRequired,
              "a no-op batch registers no analysis: not_required is the accurate claim, never published")
        check(noopReceipt?.analysisOutcome == .notRequired,
              "not_required folds to its own outcome — it must not read as 'analysis updated' (§9.1)")
        check(noopReceipt?.dependencyGeneration == nil && noopReceipt?.publishedReleaseId == nil
                && noopReceipt?.parentBatchId == nil,
              "the contract's nulls for 'this batch does not affect analysis' decode as nil")
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: noopReceipt,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .importing
            ) == .advance,
            "a no-op receipt satisfies the gate: identical content answered with a queryable receipt advances"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: nil,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .importing
            ) == .hold(reason: "no_receipt"),
            "② no receipt holds: a single succeeded is not a receipt (§10.2)"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: applying,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .importing
            ) == .hold(reason: "not_committed"),
            "③ an uncommitted receipt holds"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: rejected,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .importing
            ) == .hold(reason: "not_committed"),
            "③b a rejected receipt holds too — nothing was committed"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: nil, receipt: committedPublished,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .importing
            ) == .hold(reason: "server_contract_missing"),
            "④ an old server that does not declare the capability holds (老服务端不得冒充回执)"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version - 1, receipt: committedPublished,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .importing
            ) == .hold(reason: "server_contract_missing"),
            "④b a capability below the floor holds as well"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version + 1, receipt: committedPublished,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .importing
            ) == .advance,
            "④c a newer capability is still accepted (>= floor) — the floor is a lower bound, not equality"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: committedPublished,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .authRequired
            ) == .hold(reason: "blocked"),
            "⑤ a blocked phase holds even when everything else is satisfied"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: committedPublished,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .deferredProtectedData
            ) == .hold(reason: "blocked"),
            "⑤b the other blocked phase holds too — the list lives in SyncPhase, not here"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: nil, receipt: nil,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .authRequired
            ) == .hold(reason: "blocked"),
            "⑤c blocked wins over the other reasons: a locked device must never advance"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: nil, receipt: nil,
                pendingCursorsPresent: false, requiresReceipt: true, phase: .importing
            ) == .advance,
            "⑥ nothing to submit advances, and that path must be reachable"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: committedPublished,
                pendingCursorsPresent: false, requiresReceipt: true, phase: .authRequired
            ) == .hold(reason: "blocked"),
            "⑥b blocked stays blocked even with nothing to submit"
        )
        // §10.2 的核心：`succeeded` 不是判据。它既不因为"看起来成功了"而放行，
        // 也不因为"结束了"而阻塞 —— 唯一算数的是持久回执。
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: nil,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .succeeded
            ) == .hold(reason: "no_receipt"),
            "⑦ a succeeded phase with no receipt still holds (§10.2)"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: committedPublished,
                pendingCursorsPresent: true, requiresReceipt: true, phase: .succeeded
            ) == .advance,
            "⑦b and with a committed receipt the phase string does not block it either"
        )

        // MARK: C2. `requiresReceipt == false`：这一轮的成功收尾**不等任何回执**

        // 这一节钉的是一条实测出来的**自锁**：`HealthKitExportResult.recordCursors` 是
        // **非可选** `Data`（`HealthKitExport.swift:32`），所以调用点的
        // `pendingCursorsPresent: recordCursors != nil` 恒为 true；而 `POST /v1/imports/inspect`
        // 回 `unchanged`（服务端明确回答"这批不必导入"）的那三个成功收尾**没有作业、也没有回执**。
        // 若照样套回执判据 ⇒ `.hold("no_receipt")` ⇒ 水位与游标一个字都不写 ⇒ 下一轮服务端
        // 照样回 `unchanged` ⇒ **自锁，而且永远好不了**（没有哪一轮会突然变出一个回执）。
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: nil,
                pendingCursorsPresent: true, requiresReceipt: false, phase: .importing
            ) == .advance,
            "⑧ an unchanged round with no receipt to wait for still advances (the self-lock)"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: applying,
                pendingCursorsPresent: true, requiresReceipt: false, phase: .importing
            ) == .advance,
            "⑧b a round that does not wait for a receipt is not blocked by one still in flight"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: nil, receipt: nil,
                pendingCursorsPresent: true, requiresReceipt: false, phase: .importing
            ) == .advance,
            "⑧c an old server keeps the old behaviour instead of holding forever (§10.2 保留旧等待含义)"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: nil, receipt: nil,
                pendingCursorsPresent: true, requiresReceipt: false, phase: .authRequired
            ) == .hold(reason: "blocked"),
            "⑧d the blocked invariant still wins: a locked device never advances, receipt protocol or not"
        )
        check(
            DirectSyncCursorPolicy.decision(
                serverContractVersion: version, receipt: nil,
                pendingCursorsPresent: false, requiresReceipt: false, phase: .importing
            ) == .advance,
            "⑧e nothing to submit stays an advance on this path too"
        )

        // 四个理由必须能互相区分：塌成一个理由之后，日志里只剩"没推进"，
        // 而"老服务端一直在 hold"（等升级）与"提交失败"（该重试）完全不同。
        let reasons: Set<String> = [
            DirectSyncCursorPolicy.blockedReason,
            DirectSyncCursorPolicy.noReceiptReason,
            DirectSyncCursorPolicy.notCommittedReason,
            DirectSyncCursorPolicy.serverContractMissingReason,
        ]
        check(reasons.count == 4, "the four hold reasons are distinct")
        check(DirectSyncCursorPolicy.blockedReason == "blocked", "the 'blocked' reason string is a contract")
        check(DirectSyncCursorPolicy.noReceiptReason == "no_receipt", "the 'no_receipt' reason string is a contract")
        check(
            DirectSyncCursorPolicy.notCommittedReason == "not_committed",
            "the 'not_committed' reason string is a contract"
        )
        check(
            DirectSyncCursorPolicy.serverContractMissingReason == "server_contract_missing",
            "the 'server_contract_missing' reason string is a contract"
        )

        // MARK: D. 续接意图（§5.1 / §10.2）

        check(
            DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: true, receipt: committedPublished, deletionOnlyPage: false, requiresReceipt: true
            ),
            "a page with a next page always needs a continuation (§5.1)"
        )
        check(
            DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: false, receipt: committedPublished, deletionOnlyPage: true, requiresReceipt: true
            ),
            "a deletion-only page is not EOF (§5.1)"
        )
        check(
            DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: false, receipt: nil, deletionOnlyPage: false, requiresReceipt: true
            ),
            "no receipt means the batch is not drained: the background intent must stay (§10.2)"
        )
        check(
            DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: false, receipt: applying, deletionOnlyPage: false, requiresReceipt: true
            ),
            "an in-flight receipt is not a drain either"
        )
        check(
            DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: false, receipt: rejected, deletionOnlyPage: false, requiresReceipt: true
            ),
            "a rejected batch was never saved, so it is not drained"
        )
        check(
            DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: true, receipt: nil, deletionOnlyPage: true, requiresReceipt: true
            ),
            "all three reasons at once still needs a continuation"
        )
        check(
            !DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: false, receipt: committedPublished, deletionOnlyPage: false, requiresReceipt: true
            ),
            "only 'no next page + committed receipt + not deletion-only' ends the drain"
        )

        // MARK: D2. `requiresReceipt == false` 的续接意图

        check(
            !DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: false, receipt: nil, deletionOnlyPage: false, requiresReceipt: false
            ),
            "⑨ a round that waits for no receipt has no 'unconfirmed batch' to continue for"
        )
        check(
            DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: true, receipt: nil, deletionOnlyPage: false, requiresReceipt: false
            ),
            "⑨b …but §5.1 pagination still holds: more pages keep the intent even without the protocol"
        )
        check(
            DirectSyncCursorPolicy.continuationNeeded(
                hasMorePages: false, receipt: nil, deletionOnlyPage: true, requiresReceipt: false
            ),
            "⑨c …and a deletion-only page is still not EOF (§5.1)"
        )

        // 穷举 3 种回执 × 2 种 requiresReceipt × 2 种分页 × 2 种删除-only = 24 种组合。
        // 写成穷举而不是再抄一遍公式：抄公式只能证明"实现等于自己"
        // （`SyncPhase.mayAdvanceAnchor` 那类自比断言的坑）。
        // 期望的"drain 完"集合有 4 个成员，且形状很说明问题：
        //   - `requiresReceipt == false` 时回执完全不参与 ⇒ 只要没有下一页、也不是删除-only 就算完；
        //   - `requiresReceipt == true` 时**只有** committed 那一种回执算完。
        let receiptShapes: [(String, DirectSyncReceipt?)] = [
            ("none", nil), ("committed", committedPublished), ("rejected", rejected),
        ]
        var drained: [String] = []
        for (name, receipt) in receiptShapes {
            for requiresReceipt in [true, false] {
                for hasMore in [true, false] {
                    for deletionOnly in [true, false] {
                        let needed = DirectSyncCursorPolicy.continuationNeeded(
                            hasMorePages: hasMore, receipt: receipt,
                            deletionOnlyPage: deletionOnly, requiresReceipt: requiresReceipt
                        )
                        if !needed {
                            drained.append(
                                "\(name)/requiresReceipt=\(requiresReceipt)/more=\(hasMore)/deletionOnly=\(deletionOnly)"
                            )
                        }
                    }
                }
            }
        }
        check(
            drained.sorted() == [
                "committed/requiresReceipt=false/more=false/deletionOnly=false",
                "committed/requiresReceipt=true/more=false/deletionOnly=false",
                "none/requiresReceipt=false/more=false/deletionOnly=false",
                "rejected/requiresReceipt=false/more=false/deletionOnly=false",
            ].sorted(),
            "the drain-complete set changed (expected 4 of the 24 combinations), got \(drained)"
        )

        // MARK: E. 老 payload 兼容（§10.2「保留旧ZIP、batch和续传身份」）

        let legacy = decodeTask(DirectSyncFixture.legacyTask)
        check(legacy != nil, "a payload written before the three new keys still decodes (loadTask uses try?)")
        check(legacy?.lastReceipt == nil, "an old payload does not manufacture a receipt")
        check(legacy?.needsContinuation == nil, "'no key' stays nil — it must not default to false")
        check(legacy?.lastAnalysisStatus == nil, "an old payload does not manufacture an analysis status")
        check(legacy?.target == "http://127.0.0.1:8787", "target survives the new keys")
        check(legacy?.serverId == "srv-1" && legacy?.athleteId == "ath-1", "the identity fields survive")
        check(legacy?.datasetEpoch == "epoch-1", "datasetEpoch survives (§10.2 不得随能力位改变)")
        check(legacy?.protocolVersion == 3, "protocolVersion survives")
        check(legacy?.sourceId == "src-1", "the old ZIP/batch identity survives (§10.2)")
        check(legacy?.jobId == "job-1", "the resume identity survives (§10.2)")
        check(
            legacy?.payloadHash == "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
            "payloadHash survives"
        )
        check(legacy?.pendingAnchor == Data("hello".utf8), "pendingAnchor survives")
        check(
            legacy?.exportEnd == Date(timeIntervalSinceReferenceDate: 789_000_000),
            "exportEnd still decodes as a reference-date Double"
        )
        check(legacy?.workoutCount == 12, "workoutCount survives")
        check(legacy?.resolvedPhase == .importing, "the phase still resolves through SyncPhase.migrate")

        // 三个新键必须**各自独立**可选：只写其中一个时，另外两个仍然是 nil。
        // 只要有一处写成 `decode`（而不是 `decodeIfPresent`），这一条就会红 ——
        // 而在真机上它的症状是"任务凭空消失"，看不见任何报错。
        let receiptOnly = decodeTask(DirectSyncFixture.taskWithReceiptOnly)
        check(receiptOnly != nil, "a payload carrying only lastReceipt still decodes")
        check(receiptOnly?.lastReceipt?.receiptId == "job-1", "lastReceipt decodes from the stored blob")
        check(receiptOnly?.lastReceipt?.analysisStatus == .queued, "its analysisStatus comes along")
        check(
            receiptOnly?.needsContinuation == nil && receiptOnly?.lastAnalysisStatus == nil,
            "the other two new keys stay nil independently, not as a group"
        )

        // MARK: E2. 新字段落盘后能读回来

        let task = SyncTaskState(
            target: "http://127.0.0.1:8787",
            phase: SyncPhase.importing.rawValue,
            payloadHash: String(repeating: "a", count: 64),
            workoutCount: 3,
            lastReceipt: committedQueued,
            needsContinuation: true,
            lastAnalysisStatus: .queued
        )
        guard let encoded = try? JSONEncoder().encode(task) else {
            print("  FAIL the task with the new fields does not encode at all")
            exit(1)
        }
        let blob = String(decoding: encoded, as: UTF8.self)
        check(blob.contains("\"lastReceipt\""), "lastReceipt is written to the payload")
        check(
            blob.contains("\"ingestStatus\":\"committed\"") && blob.contains("\"analysisStatus\":\"queued\""),
            "the stored receipt keeps the server's key names — a rename would silently orphan old rows"
        )
        check(blob.contains("\"needsContinuation\":true"), "the continuation intent is written")
        check(blob.contains("\"lastAnalysisStatus\":\"queued\""), "the analysis half is written separately")
        let restored = decodeTask(blob)
        check(restored?.lastReceipt == committedQueued, "the stored receipt round-trips field by field")
        check(restored?.needsContinuation == true, "restart reconciliation keeps the continuation intent (§10.1)")
        check(
            restored?.lastAnalysisStatus == .queued,
            "the analysis half is tracked apart from the frozen facts half (§10.2 分析另行跟踪)"
        )

        // MARK: F. 展示通知（§10.3 / §9.1）

        check(
            DirectSyncCursorPolicy.notice(for: nil) == nil,
            "no receipt produces no notice — the wiring must not invent a sentence"
        )
        check(
            DirectSyncCursorPolicy.notice(
                for: DirectSyncReceipt(ingestStatus: .receiving, receiptId: "r", analysisStatus: .queued)
            ) == .savingFacts,
            "receiving reads as 'saving facts'"
        )
        check(
            DirectSyncCursorPolicy.notice(
                for: DirectSyncReceipt(ingestStatus: .validating, receiptId: "r", analysisStatus: .queued)
            ) == .savingFacts,
            "validating reads as 'saving facts'"
        )
        check(
            DirectSyncCursorPolicy.notice(
                for: DirectSyncReceipt(ingestStatus: .applying, receiptId: "r", analysisStatus: .queued)
            ) == .savingFacts,
            "applying reads as 'saving facts'"
        )
        check(
            DirectSyncCursorPolicy.notice(for: committedPublished) == .factsSavedAnalysisPublished,
            "committed + published is the only 'analysis updated'"
        )
        check(
            DirectSyncCursorPolicy.notice(for: committedQueued) == .factsSavedAnalysisPending(.queued),
            "queued passes the raw analysis status through"
        )
        check(
            DirectSyncCursorPolicy.notice(
                for: DirectSyncReceipt(ingestStatus: .committed, receiptId: "r-5", analysisStatus: .running)
            ) == .factsSavedAnalysisPending(.running),
            "running passes the raw analysis status through"
        )
        check(
            DirectSyncCursorPolicy.notice(
                for: DirectSyncReceipt(ingestStatus: .committed, receiptId: "r-6", analysisStatus: .failed)
            ) == .factsSavedAnalysisFailed,
            "a failed analysis is its own notice (raw kept, analysis retryable)"
        )
        let notRequired = DirectSyncReceipt(
            ingestStatus: .committed, receiptId: "r-7", analysisStatus: .notRequired
        )
        check(
            DirectSyncCursorPolicy.notice(for: notRequired) == .factsSavedAnalysisNotRequired,
            "not_required is its own notice (§9.1: it is not 'analysis updated')"
        )
        check(
            DirectSyncCursorPolicy.notice(for: notRequired) != .factsSavedAnalysisPublished,
            "not_required must never be displayed as published (§9.1)"
        )
        check(
            DirectSyncCursorPolicy.notice(for: rejected) == nil,
            "a rejected batch gets no 'facts saved' notice — the failure channel owns that sentence"
        )

        // 5 个分析取值 → 4 个语义结论的折叠。`notRequired` 与 `published` 是两个 case，
        // 所以"把 not_required 当成 published"必须被显式写出来才可能发生。
        check(DirectSyncReceipt(
            ingestStatus: .committed, receiptId: "r", analysisStatus: .notRequired
        ).analysisOutcome == .notRequired, "not_required folds to its own outcome")
        check(committedQueued.analysisOutcome == .pending, "queued folds to pending")
        check(DirectSyncReceipt(
            ingestStatus: .committed, receiptId: "r", analysisStatus: .running
        ).analysisOutcome == .pending, "running folds to pending")
        check(committedPublished.analysisOutcome == .published, "published folds to published")
        check(rejected.analysisOutcome == .failed, "failed folds to failed")

        // MARK: G. 与服务端逐字一致（服务端加状态时这里必须一起改）

        check(
            DirectSyncIngestStatus.allCases.map(\.rawValue)
                == ["receiving", "validating", "applying", "committed", "rejected"],
            "the ingest closed set drifted from INGEST_STATUSES in packages/contracts/src/direct-sync.ts"
        )
        check(
            DirectSyncAnalysisStatus.allCases.map(\.rawValue)
                == ["not_required", "queued", "running", "published", "failed"],
            "the analysis closed set drifted from ANALYSIS_STATUSES in packages/contracts/src/direct-sync.ts"
        )
        check(
            DirectSyncReceipt.factsAnalysisContractVersion == 1,
            "the client's floor must equal the declared factsAnalysisContractVersion (server: 1)"
        )

        // MARK: H. 分析终态对账（§10.2「分析另行跟踪」/ §10.3 后两句文案）

        // 这一节存在的原因：回执里的 `analysisStatus` 是服务端 **COMMIT 时刻**的快照
        // （直连车道恒写 `queued`），而全仓**没有任何更新方**会把回执改成 `published` /
        // `failed`。所以 §10.3 的「分析已更新」与「健康数据已保存，分析更新失败，可重试分析」
        // 两句，只靠回执永远不可达 —— 它们是靠这里这条独立通道拿到终态的。
        // 这条通道的判据**只在纯逻辑里**：`HealthKitSync.swift` 不被任何回归脚本编译，
        // 把判据写在那边等于没有执行者（本仓已付过两次代价）。
        func reconcile(_ status: DirectSyncAnalysisStatus, job: String?, failed: Bool = false)
            -> DirectSyncAnalysisStatus? {
            DirectSyncCursorPolicy.reconcileAnalysis(
                receipt: DirectSyncReceipt(
                    ingestStatus: .committed, receiptId: "job-42", analysisStatus: status
                ),
                jobStatus: job, jobFailed: failed
            )
        }

        // ① 只有真终态才改写。
        check(reconcile(.queued, job: "succeeded") == .published,
              "a succeeded analysis job turns queued into published (§10.3 published copy)")
        check(reconcile(.running, job: "succeeded") == .published,
              "the same holds while the receipt still says running")
        check(reconcile(.queued, job: "failed", failed: true) == .failed,
              "a failed analysis job turns queued into failed (§10.3 retryable-analysis copy)")
        // ② 进行中 / 拿不到 ⇒ nil。这一格是整节最要紧的：把"没问到"当成结论，
        //    界面就会在分析还在跑时说一句它没有依据的话。
        check(reconcile(.queued, job: "queued") == nil, "a queued job is not a terminal state")
        check(reconcile(.queued, job: "running") == nil, "a running job is not a terminal state")
        check(reconcile(.queued, job: nil) == nil, "not having asked is not a conclusion")
        check(reconcile(.queued, job: "") == nil, "an empty status is not a conclusion either")
        check(reconcile(.queued, job: "scheduled") == nil,
              "an unknown status must not be guessed into published")
        // 「取消」不是「失败」：§10.1 明写取消只停止分析、保留待更新提示，不宣称 raw 已撤销。
        check(reconcile(.queued, job: "cancelled") == nil,
              "cancelled is not failed (§10.1) — do not promise a retry the user did not get")
        check(reconcile(.queued, job: "failed", failed: false) == nil,
              "a failed status without the task_failed code is not enough to say 'analysis failed'")
        // ③ 已经确认过的结论不被改写（滞后读不许把已发布/已失败打回去）。
        check(reconcile(.published, job: "failed", failed: true) == nil,
              "a confirmed published never regresses")
        check(reconcile(.failed, job: "succeeded") == nil,
              "a confirmed failed never turns into published")
        // 🔴 `not_required` 是"本批结构上不影响分析"，**不是**"分析已完成"（§9.1）。
        //    用一次 `succeeded` 把它改写成 `.published` 会让界面说一句关于分析的假话 ——
        //    而这个 case 存在的全部理由就是防止这件事。
        check(reconcile(.notRequired, job: "succeeded") == nil,
              "not_required must never be rewritten into published (§9.1)")
        // ④ 事实那一半没提交就不对账：分析那一半此刻没有意义。
        check(
            DirectSyncCursorPolicy.reconcileAnalysis(
                receipt: DirectSyncReceipt(
                    ingestStatus: .applying, receiptId: "job-42", analysisStatus: .queued
                ),
                jobStatus: "succeeded", jobFailed: false
            ) == nil,
            "an uncommitted batch is not reconciled — the facts half has no conclusion yet"
        )
        check(
            DirectSyncCursorPolicy.reconcileAnalysis(
                receipt: nil, jobStatus: "succeeded", jobFailed: false
            ) == nil,
            "no receipt means no reconciliation (an old server's succeeded is not a receipt, §10.2)"
        )

        // ⑤ 对账槽 payload：它要能跨启动往返。任务行在 `commitSuccess` 里被删掉之后，
        //    盘上只剩这一份记录知道"该去问哪条任务" —— 编码/解码丢一个字段，
        //    症状就是"重启后再也不问终态"，而它在设备上完全看不出来。
        let pending = DirectSyncAnalysisReconcile(
            receiptId: "job-42", ingestStatus: .committed, analysisStatus: .queued,
            analysisJobId: "recompute-7", observedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        check(pending.needsReconcile, "a committed batch with a job id still needs reconciling")
        check(!pending.hasTerminalAnalysis, "queued is not a terminal analysis")
        if let encoded = try? JSONEncoder().encode(pending),
           let decoded = try? JSONDecoder().decode(DirectSyncAnalysisReconcile.self, from: encoded) {
            check(decoded == pending,
                  "the reconcile slot payload survives a JSON round trip (it outlives the task row)")
            check(decoded.analysisJobId == "recompute-7",
                  "the job id survives — it is the only pointer to the outcome")
            check(decoded.receiptId == "job-42",
                  "the receipt id survives — a restart must reconcile the same batch")
            check(decoded.needsReconcile, "a decoded pending record still needs reconciling")
        } else {
            check(false, "the reconcile slot payload must encode and decode")
        }
        var settledRecord = pending
        settledRecord.analysisStatus = .published
        check(settledRecord.hasTerminalAnalysis, "published is a terminal analysis")
        check(!settledRecord.needsReconcile, "a terminal analysis is not asked about again")
        // `not_required` **不算**终态分析：它是"本批没有分析任务"（§9.1），不是"分析跑完了"。
        let notRequiredRecord = DirectSyncAnalysisReconcile(
            receiptId: "job-9", ingestStatus: .committed, analysisStatus: .notRequired,
            analysisJobId: nil, observedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        check(!notRequiredRecord.needsReconcile,
              "no job id means there is nothing to ask about (record-only batches)")
        // 空串 id 与 `nil` 一样算"没有任务"：它会让对账去请求 `/v1/jobs/`，而那条路径恒 404，
        // 症状是"永远问不到终态"——与"分析还在跑"在界面上长得一模一样。
        let emptyIdRecord = DirectSyncAnalysisReconcile(
            receiptId: "job-9", ingestStatus: .committed, analysisStatus: .queued,
            analysisJobId: "", observedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        check(!emptyIdRecord.needsReconcile, "an empty job id is 'no job', not 'ask /v1/jobs/'")
        // 事实那一半没提交的记录同样不再对账（对账槽里可能出现这种中间态）。
        let uncommittedRecord = DirectSyncAnalysisReconcile(
            receiptId: "job-9", ingestStatus: .applying, analysisStatus: .queued,
            analysisJobId: "recompute-9", observedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        check(!uncommittedRecord.needsReconcile, "an uncommitted record does not get reconciled")

        if failures > 0 {
            print("\(failures) direct sync receipt check(s) failed.")
            exit(1)
        }
        print("Direct sync receipt regression: \(checks) checks passed")
    }
}

/// `summary` 的最小替身 —— 只用来钉"可选回执键"的四种形态：缺键 / `null` / 有值 / 只有老字段。
///
/// 不复制 `HealthKitSync.ImportJobSummary`：那份类型还带八个别的字段，复制它只会制造第二份
/// 需要维护的形状。这里要钉的是 `Optional<DirectSyncReceipt>` 的**解码语义**，而它在两边同形。
private struct DirectSyncSummaryEnvelope: Decodable {
    let directSync: DirectSyncReceipt?
}

/// 服务端会真正发出来的字面量。JSON 文本**手写**：用 `DirectSyncReceipt` 自己编码一份再喂回来，
/// 只能证明"今天的编码器与今天的解码器自洽"，证明不了"服务端发的东西读得出来"。
private enum DirectSyncFixture {
    /// 一份完整回执：已提交，分析在排队。
    static let committedQueued = """
    {
      "ingestStatus": "committed",
      "receiptId": "job-42",
      "analysisStatus": "queued",
      "dependencyGeneration": "7",
      "publishedReleaseId": null,
      "parentBatchId": null
    }
    """

    /// R2（2026-10-15）：服务端 no-op（内容与已导入完全一致）的持久回执形状——
    /// `apps/api/src/import-worker.ts` 的 `writeNoopReceipt` 输出（committed / not_required /
    /// 三个"没有值"字段为 null）。同样的载荷、同样的字节，也要能被客户端走完确认。
    static let noopCommittedNotRequired = """
    {
      "ingestStatus": "committed",
      "receiptId": "web_import_noop_1",
      "analysisStatus": "not_required",
      "dependencyGeneration": null,
      "publishedReleaseId": null,
      "parentBatchId": null
    }
    """

    /// 三个可选键**整键缺席**（不是 `null`）。
    static let committedWithoutOptionalKeys = """
    {
      "ingestStatus": "committed",
      "receiptId": "job-42",
      "analysisStatus": "queued"
    }
    """

    /// 服务端将来加的键（§10.1 的 `routeReceipts` 属于 PR3）。
    static let committedWithFutureKeys = """
    {
      "ingestStatus": "committed",
      "receiptId": "job-42",
      "analysisStatus": "published",
      "dependencyGeneration": "7",
      "publishedReleaseId": "rel-9",
      "parentBatchId": null,
      "routeReceipts": [{"routeId": "r-1", "status": "committed"}],
      "rawGeneration": "delta:job-42"
    }
    """

    /// 认不出的 `ingestStatus`：服务端加了新状态而客户端还没升级。
    static let unknownIngestStatus = """
    {
      "ingestStatus": "partially_committed",
      "receiptId": "job-42",
      "analysisStatus": "queued"
    }
    """

    static let unknownAnalysisStatus = """
    {
      "ingestStatus": "committed",
      "receiptId": "job-42",
      "analysisStatus": "in_progress"
    }
    """

    static let upperCaseIngestStatus = """
    {
      "ingestStatus": "Committed",
      "receiptId": "job-42",
      "analysisStatus": "queued"
    }
    """

    static let missingIngestStatus = """
    {
      "receiptId": "job-42",
      "analysisStatus": "queued"
    }
    """

    static let missingReceiptId = """
    {
      "ingestStatus": "committed",
      "analysisStatus": "queued"
    }
    """

    static let missingAnalysisStatus = """
    {
      "ingestStatus": "committed",
      "receiptId": "job-42"
    }
    """

    /// 老服务端的 `summary`：它有别的字段，但没有 `directSync`。
    static let summaryWithoutReceipt = """
    {
      "id": "job-42",
      "status": "succeeded",
      "insertedWorkouts": 12
    }
    """

    static let summaryWithNullReceipt = """
    {
      "id": "job-42",
      "status": "succeeded",
      "directSync": null
    }
    """

    static let summaryWithReceipt = """
    {
      "id": "job-42",
      "status": "succeeded",
      "directSync": {
        "ingestStatus": "committed",
        "receiptId": "job-42",
        "analysisStatus": "published",
        "dependencyGeneration": "7",
        "publishedReleaseId": "rel-9",
        "parentBatchId": null
      }
    }
    """

    /// §10.2 点名的那个形态：老服务端的单一 `succeeded`，没有任何回执。
    static let legacySummarySucceededWithoutReceipt = """
    {
      "id": "job-42",
      "status": "succeeded",
      "insertedWorkouts": 12,
      "updatedWorkouts": 0
    }
    """

    /// 升级前写出来的 `sync_tasks.payload`。缺三个新键，且缺得**合法**：
    /// 合成编码器对 `Optional` 用 `encodeIfPresent`，`nil` 时整个键不写。
    static let legacyTask = """
    {
      "target": "http://127.0.0.1:8787",
      "serverId": "srv-1",
      "athleteId": "ath-1",
      "datasetEpoch": "epoch-1",
      "protocolVersion": 3,
      "phase": "importing",
      "sourceId": "src-1",
      "jobId": "job-1",
      "payloadHash": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      "pendingAnchor": "aGVsbG8=",
      "exportEnd": 789000000,
      "workoutCount": 12
    }
    """

    /// 升级中途的形态：新键只写了 `lastReceipt` 一个。
    static let taskWithReceiptOnly = """
    {
      "target": "http://127.0.0.1:8787",
      "phase": "importing",
      "jobId": "job-1",
      "payloadHash": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      "workoutCount": 12,
      "lastReceipt": {
        "ingestStatus": "committed",
        "receiptId": "job-1",
        "analysisStatus": "queued",
        "dependencyGeneration": "7",
        "publishedReleaseId": null,
        "parentBatchId": null
      }
    }
    """
}
