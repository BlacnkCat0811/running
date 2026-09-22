import Foundation
import Observation
import CryptoKit
#if os(iOS)
import HealthKit
import UIKit
#endif

@Observable
@MainActor
final class HealthKitSync {
    var isBusy = false
    var message: String?
    var lastError: String?
    var lastSyncAt: Date?
    var lastWorkoutCount: Int?
    var phase: String = "idle"
    var dataUpdatedGeneration = 0
    private var activeToken = ""
    private var activeScope = "unbound"
    private var activeServerURL: URL?
    private var activeIdentity: RaiHandshake?
    private let taskStore = SyncTaskStore()
    private let api = RaiAPIClient()
    private let syncOwner = HealthSyncTaskOwner()

    var hasCompletedSync: Bool { lastSyncAt != nil }

    var lastSyncAtISO: String? {
        guard let lastSyncAt else { return nil }
        return Self.isoFormatter.string(from: lastSyncAt)
    }

    private static let lastExportEndKey = "rai.hk.lastExportEnd"
    private static let lastSyncAtKey = "rai.hk.lastSyncAt"
    private static let lastWorkoutCountKey = "rai.hk.lastWorkoutCount"
    private static let lastWorkoutAnchorKey = "rai.hk.workoutAnchor"
    private static let failedZipKey = "rai.hk.failedZip"
    private static let failedZipEndKey = "rai.hk.failedZipEnd"
    private static let lastAutoSyncKey = "rai.hk.lastAutoSync"
    private static let taskKey = "rai.hk.syncTask"
    /// Inclusive overlap so workouts finalized just after the previous export are not missed.
    private static let overlap: TimeInterval = 48 * 60 * 60
    private static let autoSyncInterval: TimeInterval = 15 * 60
    #if os(iOS)
    private var observerStore: HKHealthStore?
    private var observers: [HKObserverQuery] = []
    private var onObserverChange: (@MainActor () async -> Void)?
    #endif

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 600
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return RaiURLSession.make(configuration: configuration)
    }()

    init() {
        lastSyncAt = nil
        lastWorkoutCount = nil
    }

    func syncIfNeeded(to serverURL: URL?, apiToken: String = "", force: Bool = false) async {
        guard let serverURL, !syncOwner.isRunning else { return }
        let urlScope = Self.urlScope(for: serverURL)
        if !force {
            let last = UserDefaults.standard.object(forKey: scopedKey(Self.lastAutoSyncKey, scope: urlScope)) as? Date
            if let last, Date().timeIntervalSince(last) < Self.autoSyncInterval { return }
        }
        await sync(to: serverURL, apiToken: apiToken)
    }

    func cancelSync() {
        guard syncOwner.cancel() || isBusy else { return }
        finishCancelled()
    }

    func startForegroundObserver(onChange: @escaping @MainActor () async -> Void) {
        #if os(iOS)
        onObserverChange = onChange
        guard observers.isEmpty, HKHealthStore.isHealthDataAvailable() else { return }
        let store = HKHealthStore()
        observerStore = store
        let types: [(HKSampleType, NSPredicate?)] = [
            (.workoutType(), HKQuery.predicateForWorkouts(with: .running)),
            (HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!, nil),
            (HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!, nil),
            (HKObjectType.quantityType(forIdentifier: .restingHeartRate)!, nil)
        ]
        observers = types.map { sampleType, predicate in
            HKObserverQuery(sampleType: sampleType, predicate: predicate) { [weak self] _, completion, _ in
                completion()
                Task { @MainActor in
                    guard UIApplication.shared.applicationState == .active else { return }
                    await self?.onObserverChange?()
                }
            }
        }
        observers.forEach { store.execute($0) }
        #endif
    }

    func sync(to serverURL: URL?, apiToken: String = "", full: Bool = false) async {
        await syncOwner.run { [weak self] in
            guard let self else { return }
            await self.performSync(to: serverURL, apiToken: apiToken, full: full)
        }
    }

    private func performSync(to serverURL: URL?, apiToken: String, full: Bool) async {
        guard !isBusy else { return }
        guard let serverURL else {
            lastError = "请先连接 RAI 服务"
            message = nil
            return
        }
        #if os(iOS)
        isBusy = true
        let previousServerURL = activeServerURL
        activeServerURL = serverURL
        activeScope = Self.urlScope(for: serverURL)
        activeIdentity = nil
        if previousServerURL?.absoluteString != serverURL.absoluteString {
            lastSyncAt = nil
            lastWorkoutCount = nil
        }
        phase = "collecting"
        activeToken = apiToken
        lastError = nil
        message = "正在请求 Apple 健康权限"
        let previousIdleTimerState = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        var backgroundTask = UIBackgroundTaskIdentifier.invalid
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "rai-health-sync") {
            self.cancelSync()
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        defer {
            isBusy = false
            UIApplication.shared.isIdleTimerDisabled = previousIdleTimerState
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
            }
        }
        // 取消必须在任何网络/HealthKit 工作前生效。本函数不是 throwing，不能写 `try`；
        // 原先的 `try? Task.checkCancellation()` 会把取消错误直接吞掉，检查形同虚设。
        guard !Task.isCancelled else { finishCancelled(); return }
        let identity: RaiHandshake
        do {
            identity = try await api.handshake(baseURL: serverURL, token: apiToken)
            try checkCancellation()
        } catch {
            if handleCancellation(error) { return }
            lastError = friendlyMessage(error)
            message = nil
            phase = "failed"
            return
        }
        activeScope = Self.syncScope(for: serverURL, identity: identity)
        activeIdentity = identity
        lastSyncAt = UserDefaults.standard.object(forKey: scopedKey(Self.lastSyncAtKey)) as? Date
        if UserDefaults.standard.object(forKey: scopedKey(Self.lastWorkoutCountKey)) != nil {
            lastWorkoutCount = UserDefaults.standard.integer(forKey: scopedKey(Self.lastWorkoutCountKey))
        }
        if !full, let task = loadTask(), let sourceId = task.sourceId {
            do {
                phase = task.phase
                message = "正在恢复上次同步任务"
                let inspection = try await inspect(sourceId: sourceId, on: serverURL)
                try checkCancellation()
                if inspection.status == "unchanged" {
                    if task.exportEnd == nil { clearExportWatermark() }
                    let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                    try markSuccess(
                        message: "Apple 健康数据已是最新" + (cleaned ? "" : Self.cleanupNoteSuffix),
                        exportEnd: task.exportEnd,
                        workoutCount: task.workoutCount,
                        advanceWatermark: task.exportEnd != nil,
                        anchor: task.pendingAnchor
                    )
                    clearTask()
                    clearPersistedUpload()
                    return
                }
                let jobId: String
                if let existing = task.jobId {
                    jobId = existing
                } else {
                    try checkCancellation()
                    let job = try await startImport(sourceId: sourceId, on: serverURL)
                    try checkCancellation()
                    updateTask(jobId: job.id, phase: "recomputing")
                    jobId = job.id
                }
                let finished = try await waitForJob(id: jobId, on: serverURL)
                if task.exportEnd == nil { clearExportWatermark() }
                try markSuccess(
                    message: "已从上次同步任务恢复",
                    exportEnd: task.exportEnd,
                    workoutCount: task.workoutCount,
                    advanceWatermark: task.exportEnd != nil,
                    anchor: task.pendingAnchor
                )
                clearTask()
                clearPersistedUpload()
                if finished.status == "succeeded" { clearFailedZip() }
                return
            } catch {
                if handleCancellation(error) { return }
                let httpError = error as? SyncHTTPError
                if HealthSyncResumePolicy.disposition(
                    statusCode: httpError?.statusCode,
                    errorCode: httpError?.code
                ) == .keepTask {
                    lastError = friendlyMessage(error)
                    message = nil
                    phase = "failed"
                    return
                }
                // 这个 task 不可能恢复了，先清掉它。留着它的后果不是"下次说不定能成"，
                // 而是下一次同步仍会从上面那句 `inspect(sourceId:)` 进来、拿到同一个 404：
                // 2026-09-22 线上实测，此后 nginx 日志里**再没有出现过任何 uploads**。
                clearTask()
                if httpError?.code == HealthSyncResumePolicy.terminalJobCode {
                    // 任务已经跑完并明确失败：把错误如实报出去。失败若是确定性的，
                    // 在这次点击里再悄悄跑一遍导入只是白跑一次；下一次同步从干净状态开始。
                    lastError = friendlyMessage(error)
                    message = nil
                    phase = "failed"
                    return
                }
                // 服务端已经没有这份暂存上传了（`sourceId` 已失效，且没有终结的任务挡路）：
                // 除了重新走一遍没有别的路，所以当场继续，而不是把这次点击留成一个错误提示
                // —— 「同步健康」按钮 / 前台自动同步都会立刻再撞同一个 404。
                // 落到下面时 `loadTask()` 已经是 nil，两个恢复分支都会自己跳过。
                phase = "collecting"
                message = nil
            }
        }
        if !full, let task = loadTask(), task.sourceId == nil, let persisted = pendingTaskZip(task) {
            do {
                phase = "uploading"
                message = "正在恢复已保存的健康数据批次"
                // 大包上传不做自动重试：600s 超时 ×3 最坏阻塞 30 分钟，超过整个导入窗口，
                // 也远超 iOS 后台任务的执行时限。失败时 ZIP 已持久化，下次同步会从这里恢复。
                let sourceId = try await withRetry(attempts: 1) {
                    try await self.upload(zipURL: persisted, to: serverURL, batchId: task.payloadHash)
                }
                try checkCancellation()
                updateTask(sourceId: sourceId, phase: "importing")
                message = "正在检查健康数据"
                let inspection = try await withRetry {
                    try await self.inspect(sourceId: sourceId, on: serverURL)
                }
                try checkCancellation()
                if inspection.status == "unchanged" {
                    if task.exportEnd == nil { clearExportWatermark() }
                    let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                    try markSuccess(
                        message: "Apple 健康数据已是最新" + (cleaned ? "" : Self.cleanupNoteSuffix),
                        exportEnd: task.exportEnd,
                        workoutCount: task.workoutCount,
                        advanceWatermark: task.exportEnd != nil,
                        anchor: task.pendingAnchor
                    )
                } else {
                    try checkCancellation()
                    phase = "recomputing"
                    message = "正在导入并计算跑力"
                    let job = try await withRetry {
                        try await self.startImport(sourceId: sourceId, on: serverURL)
                    }
                    try checkCancellation()
                    updateTask(jobId: job.id, phase: "recomputing")
                    let finished = try await waitForJob(id: job.id, on: serverURL)
                    if task.exportEnd == nil { clearExportWatermark() }
                    try markSuccess(
                        message: "已从保存的健康数据批次恢复导入",
                        exportEnd: task.exportEnd,
                        workoutCount: task.workoutCount,
                        advanceWatermark: task.exportEnd != nil,
                        anchor: task.pendingAnchor
                    )
                    if finished.status == "succeeded" { clearFailedZip() }
                }
                clearTask()
                clearPersistedUpload()
                phase = "succeeded"
                return
            } catch {
                if handleCancellation(error) { return }
                lastError = friendlyMessage(error)
                message = nil
                phase = "failed"
                rememberFailedZip(persisted, exportedThrough: task.exportEnd)
                return
            }
        }
        var zipURL: URL?
        var transientExportURL: URL?
        var exportedThrough: Date?
        do {
            // Asking is not the same as being answered. HealthKit returns without
            // an error when the user refuses read access — later queries just yield
            // nothing — so an empty export used to be indistinguishable from "not
            // authorized" and was reported as a successful sync of 0 runs. Ask for
            // the request status instead and stop with a cause the user can act on.
            let authorization = try await HealthKitExport.readAuthorizationState()
            try checkCancellation()
            switch authorization {
            case .unavailable:
                lastError = HealthKitExportError.unavailable.localizedDescription
                message = nil
                phase = "failed"
                return
            case .notDetermined:
                lastError = HealthKitExportError.authorizationUndecided.localizedDescription
                message = nil
                phase = "failed"
                return
            case .unknown:
                // The store could not say whether access was ever requested. An
                // empty export from here would be a guess dressed as a success, so
                // stop with a cause the runner can act on instead.
                lastError = HealthKitExportError.authorizationCheckFailed.localizedDescription
                message = nil
                phase = "failed"
                return
            case .decided:
                break
            }
            try checkCancellation()
            if full {
                UserDefaults.standard.removeObject(forKey: scopedKey(Self.lastWorkoutAnchorKey))
            }
            if !full, let failed = pendingFailedZip() {
                message = "正在重试上次未完成的上传"
                zipURL = failed
                exportedThrough = pendingFailedZipEnd()
                // 同上：大包上传只尝试一次，避免超时 × 重试挤爆后台窗口。
                let sourceId = try await withRetry(attempts: 1) {
                    try await self.upload(zipURL: failed, to: serverURL, batchId: try? self.fileHash(failed))
                }
                try checkCancellation()
                message = "正在检查健康数据"
                let inspection = try await withRetry {
                    try await self.inspect(sourceId: sourceId, on: serverURL)
                }
                try checkCancellation()
                if inspection.status == "unchanged" {
                    if exportedThrough == nil { clearExportWatermark() }
                    let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                    try markSuccess(
                        message: "Apple 健康数据已是最新" + (cleaned ? "" : Self.cleanupNoteSuffix),
                        exportEnd: exportedThrough,
                        workoutCount: lastWorkoutCount ?? 0,
                        advanceWatermark: exportedThrough != nil,
                        recordWorkoutCount: lastWorkoutCount != nil
                    )
                    clearFailedZip()
                    return
                }
                try checkCancellation()
                message = "正在导入并计算跑力"
                let job = try await withRetry {
                    try await self.startImport(sourceId: sourceId, on: serverURL)
                }
                _ = try await waitForJob(id: job.id, on: serverURL)
                try checkCancellation()
                if exportedThrough == nil { clearExportWatermark() }
                try markSuccess(
                    message: "已从上次失败的上传恢复导入",
                    exportEnd: exportedThrough,
                    workoutCount: lastWorkoutCount ?? 0,
                    advanceWatermark: exportedThrough != nil,
                    recordWorkoutCount: lastWorkoutCount != nil
                )
                clearFailedZip()
                return
            }
            let lastExportEnd = UserDefaults.standard.object(forKey: scopedKey(Self.lastExportEndKey)) as? Date
            let lowerBound: Date? = (full || lastExportEnd == nil)
                ? nil
                : lastExportEnd!.addingTimeInterval(-Self.overlap)
            let anchor = full ? nil : UserDefaults.standard.data(forKey: scopedKey(Self.lastWorkoutAnchorKey))
            let onProgress: @Sendable (String) async -> Void = { [weak self] status in
                await MainActor.run { [weak self] in
                    guard let self, !Task.isCancelled, self.phase != "cancelled" else { return }
                    self.message = status
                }
            }
            let exported = try await HealthSyncCancellation.runDetached(
                priority: .userInitiated,
                onCancelledResult: { result in
                    try? FileManager.default.removeItem(at: result.zipURL)
                }
            ) {
                try await HealthKitExport.exportArchive(
                    from: lowerBound,
                    workoutAnchor: anchor,
                    onProgress: onProgress
                )
            }
            transientExportURL = exported.zipURL
            try checkCancellation()
            exportedThrough = exported.exportedThrough
            let persisted = try persistZip(exported.zipURL)
            transientExportURL = nil
            zipURL = persisted
            let pendingAnchor = exported.workoutAnchor
            phase = "uploading"
            let payloadHash = try fileHash(persisted)
            saveTask(SyncTaskState(
                target: serverURL.absoluteString,
                serverId: identity.serverId,
                athleteId: identity.athleteId,
                datasetEpoch: identity.datasetEpoch,
                protocolVersion: identity.syncProtocolVersion,
                phase: "uploading",
                sourceId: nil,
                jobId: nil,
                payloadHash: payloadHash,
                pendingAnchor: pendingAnchor,
                exportEnd: exported.exportedThrough,
                workoutCount: exported.workoutCount
            ))
            try checkCancellation()
            message = "正在上传 \(exported.workoutCount) 次跑步"
            // 同上：大包上传只尝试一次。
            let sourceId = try await withRetry(attempts: 1) {
                try await self.upload(zipURL: persisted, to: serverURL, batchId: payloadHash)
            }
            try checkCancellation()
            phase = "importing"
            updateTask(sourceId: sourceId, phase: "importing")
            message = "正在检查健康数据"
            let inspection = try await withRetry {
                try await self.inspect(sourceId: sourceId, on: serverURL)
            }
            try checkCancellation()
            if inspection.status == "unchanged" {
                let cleaned = try await deleteUpload(sourceId: sourceId, on: serverURL)
                try markSuccess(
                    message: exportMessage(base: "Apple 健康数据已是最新", exported: exported)
                        + (cleaned ? "" : Self.cleanupNoteSuffix),
                    exportEnd: exported.exportedThrough,
                    workoutCount: exported.workoutCount,
                    advanceWatermark: true,
                    anchor: pendingAnchor
                )
            } else {
                try checkCancellation()
                phase = "recomputing"
                message = "正在导入并计算跑力"
                let job = try await withRetry {
                    try await self.startImport(sourceId: sourceId, on: serverURL)
                }
                try checkCancellation()
                updateTask(sourceId: sourceId, jobId: job.id, phase: "recomputing")
                let finished = try await waitForJob(id: job.id, on: serverURL)
                try markSuccess(
                    message: importMessage(exported: exported, job: finished),
                    exportEnd: exported.exportedThrough,
                    workoutCount: exported.workoutCount,
                    advanceWatermark: true,
                    anchor: pendingAnchor
                )
                clearTask()
            }
        } catch {
            if let transientExportURL {
                try? FileManager.default.removeItem(at: transientExportURL)
            }
            if handleCancellation(error) { return }
            phase = "failed"
            lastError = friendlyMessage(error)
            message = nil
            if let zipURL { rememberFailedZip(zipURL, exportedThrough: exportedThrough) }
        }
        if lastError == nil, phase != "failed", phase != "cancelled", let zipURL {
            try? FileManager.default.removeItem(at: zipURL)
            clearFailedZip()
            clearTask()
        }
        if lastError == nil, phase != "failed", phase != "cancelled" { phase = "succeeded" }
        #else
        lastError = "读取 Apple 健康只能在 iPhone 上进行"
        #endif
    }

    func dismissStatus() {
        if !isBusy {
            message = nil
            lastError = nil
        }
    }

    private func finishCancelled() {
        lastError = nil
        phase = "cancelled"
        message = "同步已取消"
    }

    private func checkCancellation() throws {
        try HealthSyncCancellation.check(manuallyCancelled: phase == "cancelled")
    }

    @discardableResult
    private func handleCancellation(_ error: Error) -> Bool {
        let urlError = error as? URLError
        guard error is CancellationError || urlError?.code == .cancelled || Task.isCancelled else {
            return false
        }
        finishCancelled()
        return true
    }

    private func markSuccess(
        message: String,
        exportEnd: Date?,
        workoutCount: Int,
        advanceWatermark: Bool,
        anchor: Data? = nil,
        recordWorkoutCount: Bool = true
    ) throws {
        try checkCancellation()
        let now = Date()
        if let anchor {
            UserDefaults.standard.set(anchor, forKey: scopedKey(Self.lastWorkoutAnchorKey))
        }
        if let activeServerURL {
            UserDefaults.standard.set(now, forKey: scopedKey(Self.lastAutoSyncKey, scope: Self.urlScope(for: activeServerURL)))
        }
        if advanceWatermark, let exportEnd {
            let current = UserDefaults.standard.object(forKey: scopedKey(Self.lastExportEndKey)) as? Date
            if current.map({ exportEnd > $0 }) ?? true {
                UserDefaults.standard.set(exportEnd, forKey: scopedKey(Self.lastExportEndKey))
            }
        }
        UserDefaults.standard.set(now, forKey: scopedKey(Self.lastSyncAtKey))
        // Only advance a count that is actually known: a restored task carries the
        // count of the run it is finishing, and writing the `0` stand-in for "no
        // count available" would replace a real number with a wrong one.
        if recordWorkoutCount {
            UserDefaults.standard.set(workoutCount, forKey: scopedKey(Self.lastWorkoutCountKey))
            lastWorkoutCount = workoutCount
        }
        lastSyncAt = now
        lastError = nil
        self.message = message
        dataUpdatedGeneration += 1
    }

    #if os(iOS)
    private func importMessage(exported: HealthKitExportResult, job: ImportJobResponse) -> String {
        let base: String
        if let summary = job.summary {
            let inserted = summary.insertedWorkouts ?? 0
            let updated = summary.updatedWorkouts ?? 0
            if inserted == 0 && updated == 0 {
                base = "Apple 健康数据已是最新"
            } else if inserted > 0 && updated > 0 {
                base = "已从 Apple 健康导入 \(inserted) 次、更新 \(updated) 次跑步"
            } else if updated > 0 {
                base = "已更新 \(updated) 次跑步"
            } else {
                base = "已从 Apple 健康导入 \(inserted) 次跑步"
            }
        } else {
            base = "已从 Apple 健康导入 \(exported.workoutCount) 次跑步"
        }
        return exportMessage(base: base, exported: exported)
    }

    private func latestMessage(base: String, warnings: [String]) -> String {
        guard !warnings.isEmpty else { return base }
        return "\(base)（\(warnings.joined(separator: "；"))）"
    }

    /// The line for a finished export, with the empty case named.
    ///
    /// HealthKit answers a *refused* read request exactly like an authorized one
    /// with nothing in it: no error, no warning, an empty archive. `readAuthorizationState`
    /// can only catch the "never asked" case — once the user has answered, allowed
    /// or refused, the status reads `.unnecessary` either way. So when the export
    /// comes back with nothing at all, the honest move is to name the possibility
    /// rather than report "已是最新" over data the app may never have been allowed
    /// to see.
    private func exportMessage(base: String, exported: HealthKitExportResult) -> String {
        guard exported.workoutCount == 0, exported.recordCount == 0, exported.routeCount == 0 else {
            return latestMessage(base: base, warnings: exported.warnings)
        }
        return latestMessage(base: base, warnings: exported.warnings + [Self.emptyExportHint])
    }

    private static let emptyExportHint =
        "未读到任何健康数据：若你曾在权限弹窗点过「不允许」，"
        + "请在 iPhone 设置 → 健康 → 数据访问与设备 中打开 RAI 的读取权限。"
    #endif

    private func upload(zipURL: URL, to serverURL: URL, batchId: String?) async throws -> String {
        try checkCancellation()
        let boundary = "rai-\(UUID().uuidString)"
        let multipartURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-upload-\(UUID().uuidString).multipart")
        defer { try? FileManager.default.removeItem(at: multipartURL) }
        try await HealthSyncCancellation.runDetached(priority: .utility) {
            try writeHealthKitMultipart(zipURL: zipURL, boundary: boundary, to: multipartURL)
        }
        try checkCancellation()

        var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/uploads"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let batchId, !batchId.isEmpty {
            request.setValue(batchId, forHTTPHeaderField: "X-RAI-Sync-Batch")
        }
        request.timeoutInterval = 600
        let (data, response) = try await session.upload(for: request, fromFile: multipartURL)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(UploadResponse.self, from: data).sourceId
    }

    private func inspect(sourceId: String, on serverURL: URL) async throws -> InspectionResponse {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/inspect"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["sourceId": sourceId])
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(InspectionResponse.self, from: data)
    }

    private func startImport(sourceId: String, on serverURL: URL) async throws -> ImportJobResponse {
        try await HealthSyncMutationRetry.run(
            isConflict: { error in
                guard let error = error as? SyncHTTPError else { return false }
                return error.statusCode == 409 && error.code == "mutation_conflict"
            },
            onWait: { self.message = "服务端正在处理上一项任务，完成后将自动继续同步" },
            operation: { try await self.submitImport(sourceId: sourceId, on: serverURL) }
        )
    }

    private func submitImport(sourceId: String, on serverURL: URL) async throws -> ImportJobResponse {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["sourceId": sourceId])
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        if (response as? HTTPURLResponse)?.statusCode == 409 {
            if let active = try await activeImport(on: serverURL), active.sourceId == sourceId {
                return active
            }
        }
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(ImportJobResponse.self, from: data)
    }

    private func activeImport(on serverURL: URL) async throws -> ImportJobResponse? {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs/active"))
        addAuthorization(to: &request)
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        if data.isEmpty { return nil }
        return try JSONDecoder().decode(ImportJobResponse?.self, from: data)
    }

    private func deleteUpload(sourceId: String, on serverURL: URL) async throws -> Bool {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-sources/\(sourceId)"))
        addAuthorization(to: &request)
        request.httpMethod = "DELETE"
        do {
            let (_, response) = try await session.data(for: request)
            try checkCancellation()
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // 404 means the staging upload is already gone, which is the outcome
            // this call wants — only an uncompromising failure is worth reporting.
            return (200...299).contains(status) || status == 404
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled || Task.isCancelled {
                throw CancellationError()
            }
            // Deliberately not rethrown: the import already landed, and failing the
            // sync over an uncollected temporary would be a worse trade. The caller
            // says so in the message instead of dropping it on the floor.
            return false
        }
    }

    /// Appended when the server took the import but did not confirm deleting the
    /// staging upload. Harmless (it is reclaimed on the next sync) but not silent.
    private static let cleanupNoteSuffix = "（服务端临时上传源未清理，下次同步会回收）"

    private func waitForJob(id: String, on serverURL: URL) async throws -> ImportJobResponse {
        let started = ContinuousClock.now
        let deadline = started.advanced(by: .seconds(30 * 60))
        var idleFailures = 0
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            do {
                let job = try await getJob(id: id, on: serverURL)
                try checkCancellation()
                idleFailures = 0
                if !job.message.isEmpty {
                    message = job.message
                } else if !job.phase.isEmpty {
                    message = job.phase
                }
                switch job.status {
                case "succeeded":
                    return job
                case "failed", "cancelled", "interrupted":
                    // 带上 code 再抛：恢复分支要靠它把「任务已终结」与「瞬时读不到」分开 ——
                    // 终结的任务拿同一个 jobId 再等只是重放同一个错误，那个 task 必须被放弃。
                    throw SyncHTTPError(message: job.error ?? "导入失败", code: HealthSyncResumePolicy.terminalJobCode)
                default:
                    try await Task.sleep(for: HealthSyncPolling.delay(elapsed: started.duration(to: .now)))
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as SyncHTTPError {
                let retryable = HealthSyncPolling.shouldRetryHTTP(statusCode: error.statusCode)
                if !retryable {
                    throw error
                }
                idleFailures += 1
                if idleFailures >= 8 {
                    throw error
                }
                message = "导入仍在进行，正在重新连接服务器"
                try await Task.sleep(for: .seconds(2))
            } catch {
                idleFailures += 1
                if idleFailures >= 8 {
                    throw error
                }
                message = "导入仍在进行，正在重新连接服务器"
                try await Task.sleep(for: .seconds(2))
            }
        }
        throw SyncHTTPError(message: "导入超时，请打开「数据与模型」查看任务状态")
    }

    private func getJob(id: String, on serverURL: URL) async throws -> ImportJobResponse {
        try checkCancellation()
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs/\(id)"))
        addAuthorization(to: &request)
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        try checkCancellation()
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(ImportJobResponse.self, from: data)
    }

    private func endpoint(_ base: URL, path: String) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false) ?? URLComponents()
        components.path = path
        components.query = nil
        components.fragment = nil
        return components.url ?? base
    }

    private func addAuthorization(to request: inout URLRequest) {
        if !activeToken.isEmpty { request.setValue("Bearer \(activeToken)", forHTTPHeaderField: "Authorization") }
    }

    private func withRetry<T>(
        attempts: Int = 3,
        operation: @escaping () async throws -> T
    ) async throws -> T {
        var lastError: Error?
        for attempt in 0..<attempts {
            try checkCancellation()
            do {
                return try await operation()
            } catch is CancellationError {
                // 取消不是可重试失败：否则会退避等待后再发一次请求，用户看到"点了取消仍在跑"。
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as SyncHTTPError {
                if error.statusCode.map({ (400...499).contains($0) && $0 != 429 }) == true {
                    throw error
                }
                lastError = error
            } catch {
                lastError = error
            }
            if attempt < attempts - 1 {
                try await Task.sleep(for: .seconds(Double(1 << attempt)))
            }
        }
        throw lastError ?? SyncHTTPError(message: "请求失败")
    }

    private func throwIfNeeded(_ response: URLResponse, data: Data) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            if let payload = try? JSONDecoder().decode(APIErrorMessage.self, from: data),
               let message = payload.message, !message.isEmpty {
                throw SyncHTTPError(message: message, statusCode: status, code: payload.code)
            }
            throw SyncHTTPError(message: "服务器返回 HTTP \(status)", statusCode: status)
        }
    }

    private func persistZip(_ zipURL: URL) throws -> URL {
        let folder = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory)
            .appendingPathComponent("rai-healthkit-\(activeScope)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let durable = folder.appendingPathComponent("upload.zip")
        if FileManager.default.fileExists(atPath: durable.path) {
            try FileManager.default.removeItem(at: durable)
        }
        try FileManager.default.copyItem(at: zipURL, to: durable)
        try? FileManager.default.removeItem(at: zipURL)
        return durable
    }

    private func pendingFailedZip() -> URL? {
        guard let path = UserDefaults.standard.string(forKey: scopedKey(Self.failedZipKey)) else { return nil }
        let url = URL(fileURLWithPath: path)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    private func pendingFailedZipEnd() -> Date? {
        UserDefaults.standard.object(forKey: scopedKey(Self.failedZipEndKey)) as? Date
    }

    private func rememberFailedZip(_ url: URL, exportedThrough: Date?) {
        UserDefaults.standard.set(url.path, forKey: scopedKey(Self.failedZipKey))
        if let exportedThrough {
            UserDefaults.standard.set(exportedThrough, forKey: scopedKey(Self.failedZipEndKey))
        } else {
            UserDefaults.standard.removeObject(forKey: scopedKey(Self.failedZipEndKey))
        }
    }

    private func clearFailedZip() {
        if let path = UserDefaults.standard.string(forKey: scopedKey(Self.failedZipKey)) {
            try? FileManager.default.removeItem(atPath: path)
        }
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.failedZipKey))
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.failedZipEndKey))
    }

    private func clearExportWatermark() {
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.lastExportEndKey))
    }

    private func clearPersistedUpload() {
        for url in persistedUploadURLs() {
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func pendingTaskZip(_ task: SyncTaskState) -> URL? {
        guard task.target == activeServerURL?.absoluteString else { return nil }
        for url in persistedUploadURLs() where FileManager.default.fileExists(atPath: url.path) {
            guard let hash = try? fileHash(url), hash == task.payloadHash else { continue }
            return url
        }
        return nil
    }

    private func persistedUploadURLs() -> [URL] {
        let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let scopes = [activeScope, activeServerURL.map { Self.urlScope(for: $0) }].compactMap { $0 }
        return scopes.map { scope in
            applicationSupport
                .appendingPathComponent("rai-healthkit-\(scope)", isDirectory: true)
                .appendingPathComponent("upload.zip")
        }
    }

    private func scopedKey(_ key: String) -> String {
        scopedKey(key, scope: activeScope)
    }

    private func scopedKey(_ key: String, scope: String) -> String {
        "\(key).\(scope)"
    }

    /// Writes the resume state to both homes.
    ///
    /// The journal is the primary one, but every write to it is a silent no-op
    /// when it could not be opened, and `loadTask` already reads the
    /// `UserDefaults` copy as a fallback — so writing only the journal meant a
    /// device with an unusable journal silently lost the ability to resume an
    /// import that was already uploaded.
    private func saveTask(_ task: SyncTaskState) {
        guard let data = try? JSONEncoder().encode(task) else { return }
        taskStore.save(data, scope: activeScope)
        UserDefaults.standard.set(data, forKey: scopedKey(Self.taskKey))
    }

    private func loadTask() -> SyncTaskState? {
        let decoder = JSONDecoder()
        let candidates: [Data] = [
            taskStore.load(scope: activeScope),
            UserDefaults.standard.data(forKey: scopedKey(Self.taskKey, scope: activeScope)),
            activeServerURL.flatMap { UserDefaults.standard.data(forKey: scopedKey(Self.taskKey, scope: Self.urlScope(for: $0))) }
        ].compactMap { $0 }
        for data in candidates {
            guard let task = try? decoder.decode(SyncTaskState.self, from: data), isCurrentTask(task) else { continue }
            if taskStore.load(scope: activeScope) == nil {
                taskStore.save(data, scope: activeScope)
            }
            return task
        }
        return nil
    }

    private func isCurrentTask(_ task: SyncTaskState) -> Bool {
        guard task.target == activeServerURL?.absoluteString else { return false }
        if let serverId = task.serverId, serverId != activeIdentity?.serverId { return false }
        if let athleteId = task.athleteId, athleteId != activeIdentity?.athleteId { return false }
        if let datasetEpoch = task.datasetEpoch, datasetEpoch != activeIdentity?.datasetEpoch { return false }
        if let protocolVersion = task.protocolVersion, protocolVersion != activeIdentity?.syncProtocolVersion { return false }
        return true
    }

    private func updateTask(sourceId: String? = nil, jobId: String? = nil, phase: String) {
        guard var task = loadTask() else { return }
        task.sourceId = sourceId ?? task.sourceId
        task.jobId = jobId ?? task.jobId
        task.phase = phase
        saveTask(task)
    }

    private func clearTask() {
        taskStore.clear(scope: activeScope)
        UserDefaults.standard.removeObject(forKey: scopedKey(Self.taskKey))
        if let activeServerURL {
            UserDefaults.standard.removeObject(
                forKey: scopedKey(Self.taskKey, scope: Self.urlScope(for: activeServerURL))
            )
        }
    }

    private func fileHash(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func urlScope(for url: URL) -> String {
        let canonical = ServerSession.canonicalURL(url)
        let digest = SHA256.hash(data: Data(canonical.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return String(digest.prefix(24))
    }

    private static func syncScope(for url: URL, identity: RaiHandshake) -> String {
        let value = [url.absoluteString, identity.serverId, identity.athleteId, identity.datasetEpoch].joined(separator: "|")
        let digest = SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
        return String(digest.prefix(24))
    }

    private func friendlyMessage(_ error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            return "网络中断。请检查 RAI 服务和网络后重试。"
        }
        if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileReadNoSuchFileError {
            return "本地健康导出文件已丢失，请再点一次「同步健康」。"
        }
        return error.localizedDescription
    }
}

private struct UploadResponse: Decodable {
    let sourceId: String
}

private struct InspectionResponse: Decodable {
    let status: String
}

private struct ImportJobResponse: Decodable {
    let id: String
    let sourceId: String?
    let status: String
    let phase: String
    let message: String
    let error: String?
    let summary: ImportJobSummary?
}

private struct ImportJobSummary: Decodable {
    let insertedWorkouts: Int?
    let updatedWorkouts: Int?
}

private struct APIErrorMessage: Decodable {
    let message: String?
    let code: String?
}

private struct SyncHTTPError: LocalizedError {
    let message: String
    var statusCode: Int?
    var code: String?
    var errorDescription: String? { message }
}

private struct SyncTaskState: Codable {
    let target: String
    let serverId: String?
    let athleteId: String?
    let datasetEpoch: String?
    let protocolVersion: Int?
    var phase: String
    var sourceId: String?
    var jobId: String?
    let payloadHash: String
    let pendingAnchor: Data?
    let exportEnd: Date?
    let workoutCount: Int
}

nonisolated private func writeHealthKitMultipart(zipURL: URL, boundary: String, to outputURL: URL) throws {
    try Task.checkCancellation()
    FileManager.default.createFile(atPath: outputURL.path, contents: nil)
    let output = try FileHandle(forWritingTo: outputURL)
    defer { try? output.close() }
    let header = Data("""
    --\(boundary)\r
    Content-Disposition: form-data; name="file"; filename="apple-health-healthkit.zip"\r
    Content-Type: application/zip\r
    \r

    """.utf8)
    try output.write(contentsOf: header)
    try Task.checkCancellation()
    let input = try FileHandle(forReadingFrom: zipURL)
    defer { try? input.close() }
    while true {
        try Task.checkCancellation()
        let chunk = try input.read(upToCount: 1024 * 1024) ?? Data()
        if chunk.isEmpty { break }
        try output.write(contentsOf: chunk)
    }
    try Task.checkCancellation()
    try output.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
}
