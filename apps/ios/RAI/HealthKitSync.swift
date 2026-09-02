import Foundation
import Observation
#if os(iOS)
import UIKit
#endif

@Observable
@MainActor
final class HealthKitSync {
    var isBusy = false
    var message: String?
    var lastError: String?
    private var activeToken = ""

    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 600
        configuration.waitsForConnectivity = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    func sync(to serverURL: URL?, apiToken: String = "") async {
        guard !isBusy else { return }
        guard let serverURL else {
            lastError = "先连接 Mac 开发服务器"
            message = nil
            return
        }
        #if os(iOS)
        isBusy = true
        activeToken = apiToken
        lastError = nil
        message = "正在请求 Apple 健康权限"
        UIApplication.shared.isIdleTimerDisabled = true
        defer {
            isBusy = false
            UIApplication.shared.isIdleTimerDisabled = false
        }
        var zipURL: URL?
        do {
            let exported = try await HealthKitExport.exportArchive { [weak self] status in
                self?.message = status
            }
            zipURL = exported.zipURL
            message = "正在上传 \(exported.workoutCount) 次跑步"
            let sourceId = try await withRetry {
                try await self.upload(zipURL: exported.zipURL, to: serverURL)
            }
            message = "正在检查健康数据"
            let inspection = try await withRetry {
                try await self.inspect(sourceId: sourceId, on: serverURL)
            }
            if inspection.status == "unchanged" {
                message = "Apple 健康数据已是最新"
                await deleteUpload(sourceId: sourceId, on: serverURL)
            } else {
                message = "正在导入并计算跑力"
                let job = try await withRetry {
                    try await self.startImport(sourceId: sourceId, on: serverURL)
                }
                try await waitForJob(id: job.id, on: serverURL)
                message = "已从 Apple 健康导入 \(exported.workoutCount) 次跑步"
            }
        } catch is CancellationError {
            message = "已取消同步"
        } catch {
            lastError = friendlyMessage(error)
            message = nil
        }
        if let zipURL {
            try? FileManager.default.removeItem(at: zipURL)
        }
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

    private func upload(zipURL: URL, to serverURL: URL) async throws -> String {
        let boundary = "rai-\(UUID().uuidString)"
        let multipartURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("rai-upload-\(UUID().uuidString).multipart")
        defer { try? FileManager.default.removeItem(at: multipartURL) }
        try writeMultipart(zipURL: zipURL, boundary: boundary, to: multipartURL)

        var request = URLRequest(url: endpoint(serverURL, path: "/v1/imports/uploads"))
        addAuthorization(to: &request)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 600
        let (data, response) = try await session.upload(for: request, fromFile: multipartURL)
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(UploadResponse.self, from: data).sourceId
    }

    private func writeMultipart(zipURL: URL, boundary: String, to outputURL: URL) throws {
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
        try throwIfNeeded(response, data: data)
        return try JSONDecoder().decode(ImportJobResponse.self, from: data)
    }

    private func deleteUpload(sourceId: String, on serverURL: URL) async {
        var request = URLRequest(url: endpoint(serverURL, path: "/v1/import-sources/\(sourceId)"))
        addAuthorization(to: &request)
        request.httpMethod = "DELETE"
        _ = try? await session.data(for: request)
    }

    private func waitForJob(id: String, on serverURL: URL) async throws {
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
                    return
                case "failed", "cancelled", "interrupted":
                    throw SyncHTTPError(message: job.error ?? "导入失败")
                default:
                    try await Task.sleep(for: .seconds(2))
                }
            } catch let error as SyncHTTPError {
                throw error
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

    private func friendlyMessage(_ error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            return "网络中断。请确认 npm run dev:device 仍在运行，然后重试。"
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
    let status: String
    let phase: String
    let message: String
    let error: String?
}

private struct APIErrorMessage: Decodable {
    let message: String?
}

private struct SyncHTTPError: LocalizedError {
    let message: String
    var statusCode: Int?
    var errorDescription: String? { message }
}
