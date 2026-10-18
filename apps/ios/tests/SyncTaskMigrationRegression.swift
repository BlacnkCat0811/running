import Foundation

/// `SyncTaskState` 的**兼容性**回归。
///
/// 它钉的是一条会静默毁数据的不变式：**升级不能把老设备上已存在的任务丢掉。**
///
/// `HealthKitSync.loadTask` 用 `try?` 解码。只要有一个字段解不开，整份任务就被当成
/// "没有任务" —— 现象是 `lastExportEnd` 之前的窗口被重新导出、`lastWorkoutCount` 归零，
/// 而 `sync_tasks` 表里那一行明明还在。最阴的地方在于：**加一个带默认值的非可选字段
/// 就会触发它**（合成解码器对非可选属性照样 `decode`，缺键即 `keyNotFound`）。
///
/// 所以这里的 V1 字面量必须**手写**、必须长得像老版本真的会写出来的东西：用
/// `SyncTaskState` 自己编码一份再喂给它自己，只能证明"今天的编码器与今天的解码器自洽"，
/// 证明不了"今天还能读昨天的 payload"。
@main
struct SyncTaskMigrationRegression {
    static func main() throws {
        try legacyPayloadDecodesWithNewFieldsNil()
        try legacyMinimalPayloadDecodes()
        try legacyRecomputingMigratesToImporting()
        try identityKeysAreStillRequired()
        try newFieldsSurviveARoundTrip()
        try dateEncodingStrategyIsNotChanged()
        try legacyNamedArtifactsAreDetectedAsAbsent()
        try corruptRouteCommitDegradesToNil()
        try exportCountsDecodeAndDegradeSafely()
        print("Sync task migration regression tests passed")
    }

    /// 老 payload 的实质形态。缺 `serverId` / `athleteId` / `datasetEpoch` / `protocolVersion`
    /// / `sourceId` / `jobId` / `pendingAnchor` / `exportEnd` 都是合法的 —— 合成编码器对
    /// `Optional` 用 `encodeIfPresent`，`nil` 时**整个键不写**。
    private static let legacyFull = """
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

    /// 最省的一版：只有四个必填键。这是"刚导出完、还没上传"的形态。
    private static let legacyMinimal = """
    {
      "target": "http://127.0.0.1:8787",
      "phase": "uploading",
      "payloadHash": "0000000000000000000000000000000000000000000000000000000000000000",
      "workoutCount": 0
    }
    """

    private static func decode(_ json: String) throws -> SyncTaskState {
        do {
            return try JSONDecoder().decode(SyncTaskState.self, from: Data(json.utf8))
        } catch {
            throw MigrationRegressionFailure("failed to decode a legacy payload: \(error)")
        }
    }

    /// 老 payload 必须解得开，且所有新字段都是 `nil`（而不是被塞了默认值 ——
    /// 默认值会让"这次同步到底有没有把字节交给系统"变成一个猜谜游戏）。
    private static func legacyPayloadDecodesWithNewFieldsNil() throws {
        let task = try decode(legacyFull)
        try require(task.target == "http://127.0.0.1:8787", "target was not read")
        try require(task.phase == "importing", "phase was not read")
        try require(task.sourceId == "src-1", "sourceId was lost")
        try require(task.jobId == "job-1", "jobId was lost")
        try require(task.workoutCount == 12, "workoutCount was lost")
        try require(task.pendingAnchor == Data("hello".utf8), "pendingAnchor was lost")
        try require(task.pendingRecordCursors == nil, "old pending batches must not manufacture record cursors")
        try require(task.pendingRouteDiscoveryCursor == nil, "old pending batches must not manufacture a route traversal cursor")
        try require(
            task.exportEnd == Date(timeIntervalSinceReferenceDate: 789_000_000),
            "exportEnd did not decode as a reference-date Double"
        )
        for (name, value) in newFieldNames(task) {
            try require(value == nil, "legacy payload manufactured a value for \(name)")
        }
    }

    /// 只有必填键的那一版同样必须解得开：它是老版本最容易写出来的形态。
    private static func legacyMinimalPayloadDecodes() throws {
        let task = try decode(legacyMinimal)
        try require(task.phase == "uploading", "phase was not read from the minimal payload")
        try require(task.serverId == nil && task.jobId == nil && task.sourceId == nil, "optional keys appeared")
        try require(task.workoutCount == 0, "a zero workoutCount must be readable, not treated as missing")
        try require(task.protocolVersion == nil, "protocolVersion appeared from nowhere")
    }

    /// 老 payload 里写过的 `recomputing` 是"服务端已在算"，语义等于 `importing`。
    private static func legacyRecomputingMigratesToImporting() throws {
        let json = """
        {
          "target": "http://127.0.0.1:8787",
          "phase": "recomputing",
          "jobId": "job-9",
          "payloadHash": "00",
          "workoutCount": 1
        }
        """
        let task = try decode(json)
        try require(task.phase == "recomputing", "the raw string must stay untouched on disk")
        try require(
            task.resolvedPhase == .importing,
            "a legacy recomputing task resolved to \(task.resolvedPhase.rawValue) instead of importing"
        )
        let full = try decode(legacyFull)
        try require(
            full.resolvedPhase == .importing,
            "the full legacy payload did not resolve to importing"
        )
    }

    /// 四个身份键缺任何一个都必须**解码失败**，而不是被默认值补上。
    ///
    /// 缺 `target` 的 payload 会造出一个"目标为空"的任务，让恢复分支去连一个不存在的
    /// 服务器 —— 那种失败的样子是"莫名其妙的握手错误"，与真正的原因隔了三层。
    private static func identityKeysAreStillRequired() throws {
        for missing in ["target", "phase", "payloadHash", "workoutCount"] {
            var fields = [
                "target": "\"http://127.0.0.1:8787\"",
                "phase": "\"idle\"",
                "payloadHash": "\"00\"",
                "workoutCount": "3"
            ]
            fields.removeValue(forKey: missing)
            let json = "{" + fields.map { "\"\($0.key)\": \($0.value)" }.joined(separator: ",") + "}"
            var decoded = false
            do {
                _ = try JSONDecoder().decode(SyncTaskState.self, from: Data(json.utf8))
                decoded = true
            } catch {
                // 期望路径。
            }
            try require(!decoded, "a payload missing \(missing) decoded successfully")
        }
    }

    /// 新字段写进去要能原样读回来，且 `uploadState` 是闭集 ——
    /// 一个未知取值会被 `decodeIfPresent(SyncUploadState.self)` 判成解码失败，
    /// 进而让**整份任务**消失。所以这里也顺便钉住"闭集里只有这四个"。
    private static func newFieldsSurviveARoundTrip() throws {
        let original = SyncTaskState(
            target: "http://127.0.0.1:8787",
            serverId: "srv",
            athleteId: "ath",
            datasetEpoch: "ep",
            protocolVersion: 4,
            phase: SyncPhase.uploaded.rawValue,
            sourceId: "src",
            jobId: nil,
            payloadHash: String(repeating: "a", count: 64),
            pendingAnchor: Data([0x01, 0x02]),
            pendingRecordCursors: Data("record-cursors-v2".utf8),
            pendingRouteDiscoveryCursor: "history-019",
            exportEnd: Date(timeIntervalSinceReferenceDate: 100),
            workoutCount: 7,
            uploadTaskId: 42,
            uploadSessionIdentifier: "app.rai.running.health-sync.upload",
            multipartFileName: "upload-aaa.multipart",
            zipFileName: "upload-aaa.zip",
            multipartBoundary: "rai-aaa",
            uploadState: .inFlight,
            uploadRequestedAt: Date(timeIntervalSinceReferenceDate: 90),
            uploadCompletedAt: nil,
            lastLifecycleStopAt: Date(timeIntervalSinceReferenceDate: 80),
            lastBackgroundRunAt: Date(timeIntervalSinceReferenceDate: 70)
        )
        let data = try JSONEncoder().encode(original)
        let restored: SyncTaskState
        do {
            restored = try JSONDecoder().decode(SyncTaskState.self, from: data)
        } catch {
            throw MigrationRegressionFailure("a P1 payload did not round-trip: \(error)")
        }
        try require(restored.schemaVersion == SyncTaskState.currentSchemaVersion, "schemaVersion was lost")
        try require(restored.pendingRecordCursors == original.pendingRecordCursors, "pending record cursors were lost")
        try require(restored.pendingRouteDiscoveryCursor == original.pendingRouteDiscoveryCursor,
                    "a resumed upload must retain its pending route traversal cursor")
        var previousVersion = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        previousVersion.removeValue(forKey: "pendingRouteDiscoveryCursor")
        let previousTask = try JSONDecoder().decode(
            SyncTaskState.self, from: JSONSerialization.data(withJSONObject: previousVersion)
        )
        try require(previousTask.pendingRouteDiscoveryCursor == nil
                    && previousTask.pendingRecordCursors == original.pendingRecordCursors,
                    "a pre-rediscovery v2 task still resumes without inventing a traversal position")
        try require(restored.uploadTaskId == 42, "uploadTaskId was lost")
        try require(restored.uploadState == .inFlight, "uploadState was lost")
        try require(restored.multipartFileName == "upload-aaa.multipart", "multipartFileName was lost")
        try require(restored.zipFileName == "upload-aaa.zip", "zipFileName was lost")
        try require(restored.multipartBoundary == "rai-aaa", "multipartBoundary was lost")
        try require(restored.uploadCompletedAt == nil, "a nil new field came back non-nil")
        try require(restored.hasNamedArtifacts, "named artifacts were not detected")
        try require(restored.resolvedPhase == .uploaded, "uploaded did not round-trip")

        try require(
            Set(SyncUploadState.allCases.map(\.rawValue)) == ["pending", "inFlight", "completed", "abandoned"],
            "SyncUploadState's closed set changed"
        )
        // 闭集外的取值必须让整份 payload 解不开（而不是被静默当成 nil）。
        let poisoned = """
        {"target":"t","phase":"idle","payloadHash":"00","workoutCount":0,"uploadState":"uploading"}
        """
        var decoded = false
        do {
            _ = try JSONDecoder().decode(SyncTaskState.self, from: Data(poisoned.utf8))
            decoded = true
        } catch {
            // 期望路径：闭集外的取值必须失败，否则"正在上传"会被读成"没有在传"。
        }
        try require(!decoded, "an out-of-set uploadState was accepted")
    }

    /// 时间必须继续按 `deferredToDate` 编码。
    ///
    /// 谁给编码器加了 `dateEncodingStrategy = .iso8601`，同一张 `sync_tasks` 表里就会
    /// 出现两种时间编码：老行是数字、新行是字符串。解码器只有一份策略，必然有一半读不出来
    /// —— 而那一半的可见症状是"任务凭空消失"。
    private static func dateEncodingStrategyIsNotChanged() throws {
        let task = SyncTaskState(
            target: "t",
            phase: SyncPhase.exported.rawValue,
            payloadHash: "00",
            exportEnd: Date(timeIntervalSinceReferenceDate: 789_000_000),
            workoutCount: 0
        )
        let json = try JSONEncoder().encode(task)
        let text = String(decoding: json, as: UTF8.self)
        try require(
            text.contains("\"exportEnd\":789000000"),
            "exportEnd is no longer encoded as a reference-date number: \(text)"
        )
        try require(
            !text.contains("\"exportEnd\":\""),
            "exportEnd was encoded as a string — the encoding strategy changed"
        )
    }

    /// 老 payload 没有文件名 ⇒ `hasNamedArtifacts == false`，恢复分支据此回退到
    /// 历史上唯一用过的那个名字并重算哈希。这条判据必须存在，否则"回退路径"会
    /// 在第一次升级后悄悄消失，而消失的方式是**用错批次上传**。
    private static func legacyNamedArtifactsAreDetectedAsAbsent() throws {
        let full = try decode(legacyFull)
        let minimal = try decode(legacyMinimal)
        try require(!full.hasNamedArtifacts, "a legacy payload claimed named artifacts")
        try require(!minimal.hasNamedArtifacts, "the minimal payload claimed named artifacts")
    }

    /// B01：**损坏的路线候选不能拖垮整份任务**。
    ///
    /// 候选只是"这一批查过什么"的可选证据。`loadTask` 用 `try?` 解码：如果候选解不开时
    /// 让它抛出去，整份任务会被当成"没有任务" ⇒ 升级后首次同步重导整个窗口。
    /// 正确方向是把它降级为 `nil`（这一轮不结算、待办保留），**不是**牺牲任务行。
    ///
    /// 反向的失败形态也在判据里：这条不能靠"没有 routeCommit 键"通过 —— 那个用例
    /// 被 `legacyPayloadDecodesWithNewFieldsNil` 覆盖；这里必须给一个**存在但损坏**的键。
    private static func corruptRouteCommitDegradesToNil() throws {
        let json = """
        {
          "target": "http://127.0.0.1:8787",
          "phase": "uploading",
          "payloadHash": "0000000000000000000000000000000000000000000000000000000000000000",
          "workoutCount": 3,
          "routeCommit": { "version": 1 }
        }
        """
        let task = try decode(json)
        try require(task.routeCommit == nil, "a corrupt route candidate must degrade to nil")
        try require(task.workoutCount == 3, "the rest of the task must survive a corrupt candidate")
        try require(task.target == "http://127.0.0.1:8787", "the task identity must survive")
    }

    /// P2-3（2026-10-18 同步诊断）：本批通道计数随任务行落盘 —— 恢复轮要能读出它。
    ///
    /// 两条判据：
    ///   1. 正常 payload 里的计数逐字段往返（`attempt_count` 之类不能错位）；
    ///   2. **损坏/未知形态降级为 nil**，绝不拖垮整份任务（与 `routeCommit` 同一条纪律 ——
    ///      `loadTask` 用 `try?`，一个解不开的键等于整个进度消失，症状是升级后重导整个窗口）。
    private static func exportCountsDecodeAndDegradeSafely() throws {
        let counts = ExportChannelCounts(
            anchorRecords: 4_500,
            windowRecords: 12,
            backfillRecords: 640,
            workoutWindowRecords: 88,
            writtenTypes: 9,
            replayingTypes: 3,
            historySkippedTypes: 2,
            workoutWindows: 2,
            workoutWindowsCompleted: 1
        )
        let task = SyncTaskState(
            target: "http://127.0.0.1:8787",
            phase: SyncPhase.exported.rawValue,
            payloadHash: "00",
            workoutCount: 1,
            lastExportCounts: counts
        )
        let data = try JSONEncoder().encode(task)
        let restored = try JSONDecoder().decode(SyncTaskState.self, from: data)
        try require(restored.lastExportCounts == counts,
                    "the channel counts survive the task-row round trip field for field")
        try require(restored.lastExportCounts?.logLine.contains("anchor=4500") == true,
                    "the restored counts keep their log shape (diagnostics depend on it)")
        // 损坏的计数不许把整份任务变成"没有任务"。
        var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        object["lastExportCounts"] = ["anchorRecords": "not-a-number"]
        let corrupted = try JSONDecoder().decode(
            SyncTaskState.self, from: JSONSerialization.data(withJSONObject: object)
        )
        try require(corrupted.lastExportCounts == nil,
                    "a corrupt channel-count payload degrades to nil, never fails the task decode")
        try require(corrupted.workoutCount == 1 && corrupted.target == "http://127.0.0.1:8787",
                    "the rest of the task survives a corrupt channel-count payload")
    }

    private static func newFieldNames(_ task: SyncTaskState) -> [(String, Any?)] {
        [
            ("schemaVersion", task.schemaVersion),
            ("uploadTaskId", task.uploadTaskId),
            ("uploadSessionIdentifier", task.uploadSessionIdentifier),
            ("multipartFileName", task.multipartFileName),
            ("zipFileName", task.zipFileName),
            ("multipartBoundary", task.multipartBoundary),
            ("uploadState", task.uploadState),
            ("uploadRequestedAt", task.uploadRequestedAt),
            ("uploadCompletedAt", task.uploadCompletedAt),
            ("lastLifecycleStopAt", task.lastLifecycleStopAt),
            ("lastBackgroundRunAt", task.lastBackgroundRunAt),
            // P2-3（2026-10-18 同步诊断）：通道计数是纯观测，老 payload 缺键 ⇒ nil。
            ("lastExportCounts", task.lastExportCounts)
        ]
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw MigrationRegressionFailure(message) }
    }
}

private struct MigrationRegressionFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
