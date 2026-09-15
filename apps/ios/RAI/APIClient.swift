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
    case timedOut
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
        case .timedOut:
            return "连接 RAI 服务超时，请确认服务正在运行且网络通畅。"
        case let .server(_, message, _):
            return message
        case let .decoding(message):
            return "服务返回的数据版本不兼容：\(message)"
        }
    }
}

struct RaiAPIClient {
    /// Client budget for `POST /v1/mobile/workout-plan/generate`.
    ///
    /// Must stay strictly above the server's whole-call budget
    /// (`DEFAULT_TOTAL_BUDGET_MS`, 50 s) so "the request failed" and "no plan was
    /// written" remain the same event. `apps/api/test/weekly-plan.test.ts` reads
    /// this line and fails if the two ever cross.
    static let generateTimeoutInterval: TimeInterval = 60

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(session: URLSession? = nil) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        // Caps the whole transfer regardless of the per-request timeout, so it
        // has to clear `generateTimeoutInterval` or URLSession would cut the
        // generate call short anyway.
        configuration.timeoutIntervalForResource = 75
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = session ?? RaiURLSession.make(configuration: configuration)
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

    /// The executable week handed to the workout scheduler. Read-only, so it
    /// never competes with the goals revision lock.
    func workoutPlan(baseURL: URL, token: String) async throws -> MobileWorkoutPlanResponse {
        try await get(path: "/v1/mobile/workout-plan", baseURL: baseURL, token: token)
    }

    /// Asks the server to (re)generate the weekly plan. The model may be
    /// unavailable — the server falls back to its heuristic template and says so
    /// in `warnings`, so this still returns a usable week.
    ///
    /// The server holds this request open for as long as its model budget allows
    /// (`DEFAULT_TOTAL_BUDGET_MS` in `weekly-plan-llm.ts`, 50 s), so the client
    /// must out-wait it: if the client gave up first, the server would still
    /// persist a plan the runner never saw. `generateTimeoutInterval` is asserted
    /// against that budget by `apps/api/test/weekly-plan.test.ts`.
    func generateWeeklyPlan(
        _ input: GenerateWeeklyPlanRequest,
        baseURL: URL,
        token: String
    ) async throws -> MobileWeeklyPlanGenerationResponse {
        try await send(
            path: "/v1/mobile/workout-plan/generate",
            method: "POST",
            body: input,
            baseURL: baseURL,
            token: token,
            timeout: Self.generateTimeoutInterval
        )
    }

    /// Registers that a plan day was handed to the Watch.
    ///
    /// Best-effort by contract: the caller reports a failure but must never let
    /// it invalidate a sync that already landed on the watch. Losing a receipt
    /// costs segment labels on a later detail page; losing the sync would cost
    /// the runner the session itself.
    func recordPlanSync(
        _ receipt: PlanSyncReceipt,
        baseURL: URL,
        token: String
    ) async throws -> PlanSyncReceiptResponse {
        try await send(
            path: "/v1/mobile/workout-plan/synced",
            method: "POST",
            body: receipt,
            baseURL: baseURL,
            token: token
        )
    }

    func predictions(baseURL: URL, token: String) async throws -> NativePredictionResponse {
        try await get(path: "/v1/predictions", baseURL: baseURL, token: token)
    }

    func recoveryTrend(baseURL: URL, token: String) async throws -> NativeRecoveryTrend {
        try await get(path: "/v1/recovery-trends", query: [URLQueryItem(name: "days", value: "14")], baseURL: baseURL, token: token)
    }

    func dashboard(baseURL: URL, token: String) async throws -> NativeDashboardResponse {
        try await get(path: "/v1/dashboard", baseURL: baseURL, token: token)
    }

    func trainingZonesCurrent(baseURL: URL, token: String) async throws -> NativeTrainingZonesCurrentResponse {
        try await get(path: "/v1/training-zones/current", baseURL: baseURL, token: token)
    }

    func trainingStatisticsOverview(baseURL: URL, token: String) async throws -> NativeTrainingStatisticsOverviewResponse {
        try await get(path: "/v1/training-statistics/overview", baseURL: baseURL, token: token)
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
        token: String,
        timeout: TimeInterval? = nil
    ) async throws -> U {
        let bodyData: Data
        do {
            bodyData = try encoder.encode(body)
        } catch {
            throw RaiAPIClientError.decoding(error.localizedDescription)
        }
        return try await request(path: path, query: [], method: method, body: bodyData, baseURL: baseURL, token: token, timeout: timeout)
    }

    private func request<T: Decodable>(
        path: String,
        query: [URLQueryItem],
        method: String,
        body: Data?,
        baseURL: URL,
        token: String,
        timeout: TimeInterval? = nil
    ) async throws -> T {
        guard let url = endpoint(baseURL: baseURL, path: path, query: query) else {
            throw RaiAPIClientError.invalidServerAddress
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout ?? (method == "GET" ? 15 : 45)
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
        } catch let error as URLError where error.code == .timedOut {
            // 超时与"连不上"对用户的处置方式不同，分开呈现（原先统一折叠成 .unavailable）。
            throw RaiAPIClientError.timedOut
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
        // Encode an identifier as one path segment. `.urlPathAllowed` includes
        // `/`, which would let an unexpected slash change the request path.
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

struct WorkoutListResponse: Codable {
    let items: [WorkoutListItem]
    let total: Int
    let limit: Int
    let offset: Int
}
