import Foundation

final class RaiRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @Sendable @escaping (URLRequest?) -> Void
    ) {
        guard let source = origin(for: task.originalRequest?.url),
              let destination = origin(for: request.url),
              source == destination else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    private func origin(for url: URL?) -> String? {
        guard let url,
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased() else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        return "\(scheme)://\(host):\(port)"
    }
}

enum RaiURLSession {
    static func make(configuration: URLSessionConfiguration) -> URLSession {
        URLSession(configuration: configuration, delegate: RaiRedirectGuard(), delegateQueue: nil)
    }
}

enum RaiAPIClientError: LocalizedError {
    case invalidServerAddress
    case unauthorized
    case unavailable
    case server(code: String, message: String, status: Int)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidServerAddress:
            return "服务器地址无效，请检查地址和协议。"
        case .unauthorized:
            return "API Token 无效或已过期，请在设置中更新。"
        case .unavailable:
            return "暂时无法连接 RAI 服务，请检查网络或服务状态。"
        case let .server(_, message, _):
            return message
        case let .decoding(message):
            return "服务返回的数据版本不兼容：\(message)"
        }
    }
}

struct RaiAPIClient {
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 45
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = RaiURLSession.make(configuration: configuration)
        decoder = JSONDecoder()
        encoder = JSONEncoder()
    }

    func handshake(baseURL: URL, token: String) async throws -> RaiHandshake {
        try await get(path: "/v1/handshake", baseURL: baseURL, token: token)
    }

    func today(baseURL: URL, token: String) async throws -> MobileTodayResponse {
        try await get(path: "/v1/mobile/today", baseURL: baseURL, token: token)
    }

    func statistics(baseURL: URL, token: String) async throws -> MobileStatisticsResponse {
        try await get(path: "/v1/mobile/statistics", baseURL: baseURL, token: token)
    }

    func trends(baseURL: URL, token: String) async throws -> MobileTrendsResponse {
        try await get(path: "/v1/mobile/trends", baseURL: baseURL, token: token)
    }

    func goals(baseURL: URL, token: String) async throws -> MobileGoalsResponse {
        try await get(path: "/v1/mobile/goals", baseURL: baseURL, token: token)
    }

    func workouts(
        baseURL: URL,
        token: String,
        limit: Int,
        offset: Int,
        sessionType: String?
    ) async throws -> WorkoutListResponse {
        var query: [URLQueryItem] = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        if let sessionType {
            query.append(URLQueryItem(name: "sessionType", value: sessionType))
        }
        return try await get(path: "/v1/workouts", query: query, baseURL: baseURL, token: token)
    }

    func workoutDetail(id: String, baseURL: URL, token: String) async throws -> WorkoutDetailResponse {
        try await get(path: "/v1/workouts/\(escapedPath(id))", baseURL: baseURL, token: token)
    }

    func workoutSeries(id: String, baseURL: URL, token: String) async throws -> WorkoutSeriesResponse {
        try await get(path: "/v1/workouts/\(escapedPath(id))/series", baseURL: baseURL, token: token)
    }

    func updateGoals(
        _ input: UpdateMobileGoalsRequest,
        baseURL: URL,
        token: String
    ) async throws -> MobileGoalsResponse {
        try await send(path: "/v1/mobile/goals", method: "PUT", body: input, baseURL: baseURL, token: token)
    }

    func lockSession(
        _ input: LockMobileSessionRequest,
        baseURL: URL,
        token: String
    ) async throws -> MobileGoalsResponse {
        try await send(path: "/v1/mobile/lock", method: "POST", body: input, baseURL: baseURL, token: token)
    }

    private func get<T: Decodable>(
        path: String,
        query: [URLQueryItem] = [],
        baseURL: URL,
        token: String
    ) async throws -> T {
        try await request(path: path, query: query, method: "GET", body: Optional<Data>.none, baseURL: baseURL, token: token)
    }

    private func send<T: Encodable, U: Decodable>(
        path: String,
        method: String,
        body: T,
        baseURL: URL,
        token: String
    ) async throws -> U {
        let bodyData: Data
        do {
            bodyData = try encoder.encode(body)
        } catch {
            throw RaiAPIClientError.decoding(error.localizedDescription)
        }
        return try await request(path: path, query: [], method: method, body: bodyData, baseURL: baseURL, token: token)
    }

    private func request<T: Decodable>(
        path: String,
        query: [URLQueryItem],
        method: String,
        body: Data?,
        baseURL: URL,
        token: String
    ) async throws -> T {
        guard let url = endpoint(baseURL: baseURL, path: path, query: query) else {
            throw RaiAPIClientError.invalidServerAddress
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = method == "GET" ? 15 : 45
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw RaiAPIClientError.unavailable
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            if status == 401 { throw RaiAPIClientError.unauthorized }
            let apiError = try? decoder.decode(RaiAPIError.self, from: data)
            throw RaiAPIClientError.server(
                code: apiError?.code ?? "http_\(status)",
                message: apiError?.message ?? "服务器返回 HTTP \(status)",
                status: status
            )
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw RaiAPIClientError.decoding(error.localizedDescription)
        }
    }

    private func endpoint(baseURL: URL, path: String, query: [URLQueryItem]) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let scheme = components.scheme,
              (scheme == "http" || scheme == "https"),
              components.host != nil else {
            return nil
        }
        components.path = path
        components.queryItems = query.isEmpty ? nil : query
        components.fragment = nil
        return components.url
    }

    private func escapedPath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

struct WorkoutListResponse: Codable {
    let items: [WorkoutListItem]
    let total: Int
    let limit: Int
    let offset: Int
}
