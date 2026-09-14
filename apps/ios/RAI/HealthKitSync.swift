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
    private var syncTask: Task<Void, Never>?

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
        guard let serverURL, !isBusy else { return }
        let urlScope = Self.urlScope(for: serverURL)
        if !force {
            let last = UserDefaults.standard.object(forKey: scopedKey(Self.lastAutoSyncKey, scope: urlScope)) as? Date
            if let last, Date().timeIntervalSince(last) < Self.autoSyncInterval { return }
        }
        await sync(to: serverURL, apiToken: apiToken)
    }

    func cancelSync() {
        syncTask?.cancel()
        syncTask = nil
        if isBusy {
            phase = "cancelled"
            message = "同步已取消"
        }
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
        guard !Task.isCancelled else {
            phase = "cancelled"
            message = "同步已取消"
            return
        }
        let identity: RaiHandshake
        do {
            identity = try await api.handshake(baseURL: serverURL, token: apiToken)
        } catch {
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
                if inspection.status == "unchanged" {
                    if task.exportEnd == nil { clearExportWatermark() }
                    await deleteUpload(sourceId: sourceId, on: serverURL)
                    markSuccess(
                        message: "Apple 健康数据已是最新",
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
                    let job = try await startImport(sourceId: sourceId, on: serverURL)
                    updateTask(jobId: job.id, phase: "recomputing")
                    jobId = job.id
                }
                let finished = try await waitForJob(id: jobId, on: serverURL)
                if task.exportEnd == nil { clearExportWatermark() }
                    markSuccess(
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
                lastError = friendlyMessage(error)
                message = nil
                phase = "failed"
                return
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
                updateTask(sourceId: sourceId, phase: "importing")
                message = "正在检查健康数据"
                let inspection = try await withRetry {
                    try await self.inspect(sourceId: sourceId, on: serverURL)
                }
                if inspection.status == "unchanged" {
                    if task.exportEnd == nil { clearExportWatermark() }
                    markSuccess(
                        message: "Apple 健康数据已是最新",
                        exportEnd: task.exportEnd,
                        workoutCount: task.workoutCount,
                        advanceWatermark: task.exportEnd != nil,
                        anchor: task.pendingAnchor
                    )
                    await deleteUpload(sourceId: sourceId, on: serverURL)
                } else {
                    phase = "recomputing"
                    message = "正在导入并计算跑力"
                    let job = try await withRetry {
                        try await self.startImport(sourceId: sourceId, on: serverURL)
                    }
                    updateTask(jobId: job.id, phase: "recomputing")
                    let finished = try await waitForJob(id: job.id, on: serverURL)
                    if task.exportEnd == nil { clearExportWatermark() }
                    markSuccess(
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
                lastError = friendlyMessage(error)
                message = nil
                phase = "failed"
                rememberFailedZip(persisted, exportedThrough: task.exportEnd)
                return
            }
        }
        var zipURL: URL?
        var exportedThrough: Date?
        do {
            try await HealthKitExport.requestReadAuthorization()
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
                message = "正在检查健康数据"
                let inspection = try await withRetry {
                    try await self.inspect(sourceId: sourceId, on: serverURL)
                }
                if inspection.status == "unchanged" {
                    if exportedThrough == nil { clearExportWatermark() }
                    markSuccess(
                        message: "Apple 健康数据已是最新",
                        exportEnd: exportedThrough,
                        workoutCount: lastWorkoutCount ?? 0,
                        advanceWatermark: exportedThrough != nil
                    )
                    await deleteUpload(sourceId: sourceId, on: serverURL)
                    clearFailedZip()
                    return
                }
                message = "正在导入并计算跑力"
                let job = try await withRetry {
                    try await self.startImport(sourceId: sourceId, on: serverURL)
                }
                _ = try await waitForJob(id: job.id, on: serverURL)
                if exportedThrough == nil { clearExportWatermark() }
                markSuccess(
                    message: "已从上次失败的上传恢复导入",
                    exportEnd: exportedThrough,
                    workoutCount: lastWorkoutCount ?? 0,
                    advanceWatermark: exportedThrough != nil
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
                    self?.message = status
                }
            }
            let exported = try await Task.detached(priority: .userInitiated) {
                try Task.checkCancellation()
                return try await HealthKitExport.exportArchive(
                    from: lowerBound,
                    workoutAnchor: anchor,
                    onProgress: onProgress
                )
            }.value
            try Task.checkCancellation()
            exportedThrough = exported.exportedThrough
            let persisted = try persistZip(exported.zipURL)
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
            message = "正在上传 \(exported.workoutCount) 次跑步"
            // 同上：大包上传只尝试一次。
            let sourceId = try await withRetry(attempts: 1) {
                try await self.upload(zipURL: persisted, to: serverURL, batchId: payloadHash)
            }
            phase = "importing"
            updateTask(sourceId: sourceId, phase: "importing")
            message = "正在检查健康数据"
            let inspection = try await withRetry {
                try await self.inspect(sourceId: sourceId, on: serverURL)
            }
            if inspection.status == "unchanged" {
                markSuccess(
                    message: latestMessage(base: "Apple 健康数据已是最新", warnings: exported.warnings),
                    exportEnd: exported.exportedThrough,
                    workoutCount: exported.workoutCount,
                    advanceWatermark: true,
                    anchor: pendingAnchor
                )
                await deleteUpload(sourceId: sourceId, on: serverURL)
            } else {
                phase = "recomputing"
                message = "正在导入并计算跑力"
                let job = try await withRetry {
                    try await self.startImport(sourceId: sourceId, on: serverURL)
                }
                updateTask(sourceId: sourceId, jobId: job.id, phase: "recomputing")
                let finished = try await waitForJob(id: job.id, on: serverURL)
                markSuccess(
                    message: importMessage(exported: exported, job: finished),
                    exportEnd: exported.exportedThrough,
                    workoutCount: exported.workoutCount,
                    advanceWatermark: true,
                    anchor: pendingAnchor
                )
                clearTask()
            }
        } catch is CancellationError {
            phase = "failed"
            message = "已取消同步"
        } catch {
            phase = "failed"
            lastError = friendlyMessage(error)
            message = nil
            if let zipURL { rememberFailedZip(zipURL, exportedThrough: exportedThrough) }
        }
        if lastError == nil, phase != "failed", let zipURL {
            try? FileManager.default.removeItem(at: zipURL)
            clearFailedZip()
            clearTask()
        }
        if lastError == nil, phase != "failed" { phase = "succeeded" }
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

    private func markSuccess(message: String, exportEnd: Date?, workoutCount: Int, advanceWatermark: Bool, anchor: Data? = nil) {
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
        UserDefaults.standard.set(workoutCount, forKey: scopedKey(Self.lastWorkoutCountKey))
        lastSyncAt = now
        lastWorkoutCount = workoutCount
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
        return latestMessage(base: base, warnings: exported.warnings)
    }

    private func latestMessage(base: String, warnings: [String]) -> String {
        guard !warnings.isEmpty else { return base }
        return "\(base)（\(warnings.joined(separator: "；"))）"
    }
    #endif

    private func upload(zipURL: URL, to serverURL: URL, batchId: String?) async throws -> String {
        let boundary = "rai-\(UUID().uuidString)"
        let multipartURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-upload-\(UUID().uuidString).multipart")
        defer { try? FileManager.default.removeItem(at: multipartURL) }
        try await Task.detached(priority: .utility) {
            try writeHealthKitMultipart(zipURL: zipURL, boundary: boundary, to: multipartURL)
        }.value

        var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/uploads"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let batchId, !batchId.isEmpty {
            request.setValue(batchId, forHTTPHeaderField: "X-RAI-Sync-Batch")
        }
        request.timeoutInterval = 600
        let (data, response) = try await session.upload(for: request, fromFile: multipartURL)
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(UploadResponse.self, from: data).sourceId
    }

    private func inspect(sourceId: String, on serverURL: URL) async throws -> InspectionResponse {
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/inspect"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["sourceId": sourceId])
        let (data, response) = try await session.data(for: request)
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(InspectionResponse.self, from: data)
    }

    private func startImport(sourceId: String, on serverURL: URL) async throws -> ImportJobResponse {
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["sourceId": sourceId])
        let (data, response) = try await session.data(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 409,
           let active = try? await activeImport(on: serverURL),
           active.sourceId == sourceId {
            return active
        }
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(ImportJobResponse.self, from: data)
    }

    private func activeImport(on serverURL: URL) async throws -> ImportJobResponse? {
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs/active"))
        addAuthorization(to: &request)
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        try throwIfNeeded(response, data: data)
        if data.isEmpty { return nil }
        return try JSONDecoder().decode(ImportJobResponse?.self, from: data)
    }

    private func deleteUpload(sourceId: String, on serverURL: URL) async {
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-sources/\(sourceId)"))
        addAuthorization(to: &request)
        request.httpMethod = "DELETE"
        _ = try? await session.data(for: request)
    }

    private func waitForJob(id: String, on serverURL: URL) async throws -> ImportJobResponse {
        let deadline = Date().addingTimeInterval(30 * 60)
        var idleFailures = 0
        while Date() < deadline {
            try Task.checkCancellation()
            do {
                let job = try await getJob(id: id, on: serverURL)
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
                    throw SyncHTTPError(message: job.error ?? "导入失败")
                default:
                    try await Task.sleep(for: .seconds(2))
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as URLError where error.code == .cancelled {
                throw CancellationError()
            } catch let error as SyncHTTPError {
                let retryable = error.statusCode.map { status in
                    status == 429 || status >= 500
                } ?? true
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
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-jobs/\(id)"))
        addAuthorization(to: &request)
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
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
            try Task.checkCancellation()
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
                throw SyncHTTPError(message: message, statusCode: status)
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

    private func saveTask(_ task: SyncTaskState) {
        if let data = try? JSONEncoder().encode(task) {
            taskStore.save(data, scope: activeScope)
        }
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
}

private struct SyncHTTPError: LocalizedError {
    let message: String
    var statusCode: Int?
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
    let input = try FileHandle(forReadingFrom: zipURL)
    defer { try? input.close() }
    while true {
        let chunk = try input.read(upToCount: 1024 * 1024) ?? Data()
        if chunk.isEmpty { break }
        try output.write(contentsOf: chunk)
    }
    try output.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
}
