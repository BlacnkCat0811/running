import Foundation

/// 跨源重定向的**唯一**判据，前台与后台上传两条 `URLSession` 共用。
///
/// 为什么必须抽出来：`URLSessionTaskDelegate` 是 `URLSession` 的单值属性 —— 一个会话只能有一个
/// delegate，所以前台（`RaiRedirectGuard`）与后台上传（`RaiBackgroundUploadSession`）不可能共用
/// 同一个类。但两边**必须**用同一条判据：一条放松、另一条收紧，等于"这次上传走了哪条路径"
/// 决定了它安不安全，而那个问题没有任何人能一眼回答。
///
/// `nonisolated`：后台上传的 delegate 回调跑在 `URLSession` 自己的队列上，那里读不到
/// MainActor 隔离的东西（默认隔离下，没标注的类型就是 MainActor 的）。纯函数，不碰状态。
nonisolated enum RaiSameOrigin {
    /// 重定向的**来源**与**去向**是否同源（scheme + host + 有效端口）。
    ///
    /// 端口缺失时按 scheme 补默认端口（`https` ⇒ 443，其余 ⇒ 80）：`URL.port` 对
    /// `https://a.example/x` 返回 `nil` 而不是 `443`，不补就会把
    /// `https://a.example/x` → `https://a.example:443/y` 判成跨源 —— 一次**假阴性**，
    /// 代价是拒绝一次合法重定向，同步从此卡在 3xx 上。
    ///
    /// 任一侧读不出 scheme / host（相对 URL、非法 URL）一律判**不同源**：
    /// 这条路径上的默认答案必须是"拒绝"。
    static func allowsRedirection(from source: URL?, to destination: URL?) -> Bool {
        guard let source = origin(for: source), let destination = origin(for: destination) else {
            return false
        }
        return source == destination
    }

    static func origin(for url: URL?) -> String? {
        guard let url,
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased() else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        return "\(scheme)://\(host):\(port)"
    }
}

final class RaiRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @Sendable @escaping (URLRequest?) -> Void
    ) {
        // 判据住在 `RaiSameOrigin`（职责与"为什么不能直接共用本类"见它的说明）。
        completionHandler(
            RaiSameOrigin.allowsRedirection(from: task.originalRequest?.url, to: request.url)
                ? request
                : nil
        )
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
    /// 2026-10-18（审查 P2-6 收尾）：可重试的临时服务端错误，携带服务端
    /// `Retry-After` 建议。**只有** `503` + 可解析的整数秒头才使用它：
    /// 通用的 5xx/网络中断没有得到"一秒后就一定好"的证据，仍走 `.server`。
    /// 独立 case 是为了不破坏既有 19 处 `case .server(code, _, _)` 三元模式。
    case retryableServer(code: String, message: String, status: Int, retryAfterSeconds: TimeInterval?)
    case decoding(String)

    /// 服务端错误码（`.server` 与 `.retryableServer` 共用；其它错误为 nil）。
    var serverCode: String? {
        switch self {
        case let .server(code, _, _), let .retryableServer(code, _, _, _): return code
        default: return nil
        }
    }

    /// 服务端 HTTP 状态码（`.server` 与 `.retryableServer` 共用；其它错误为 nil）。
    var httpStatus: Int? {
        switch self {
        case let .server(_, _, status), let .retryableServer(_, _, status, _): return status
        default: return nil
        }
    }

    var errorDescription: String? {
        switch self {
        case .invalidServerAddress:
            return "服务器地址无效，请检查地址和协议。"
        case .unauthorized:
            return "服务连接已失效，请在设置中重新连接。"
        case .unavailable:
            return "暂时无法连接 RAI 服务，请检查网络或服务状态。"
        case .timedOut:
            return "连接 RAI 服务超时，请确认服务正在运行且网络通畅。"
        case let .server(_, message, _):
            return message
        case let .retryableServer(_, message, _, _):
            return message
        case let .decoding(message):
            return "服务返回的数据版本不兼容：\(message)"
        }
    }
}

/// 2026-10-18（审查 P2-6 收尾）：`Retry-After` 的解析规则。
///
/// RFC 7231 允许 HTTP-date，但本客户端只消费**整数秒**形式：HTTP-date 需要与
/// 本机时钟对齐，而计划快照重试的语义是"一秒后重读"，日期形式的收益为零、风险
/// （时钟偏差）更大，因此一律忽略。
///
/// 2026-10-18（深度审查 P3-28）：**解析**与**调度夹取**必须分开。
/// 旧实现把 `0...5` 的夹取做在解析里，于是两件不同的事共用一个值：
/// - **展示**：429 的文案是"（建议 N 秒后重试）"，它复述的是**服务端的建议**。
///   夹取后仍以服务端口吻展示 ⇒ 服务端说 60 秒，界面会说"建议 5 秒"（用户不可知地
///   被改写）。展示只做"非负 + 上限 600 秒"的理性保护，不改写服务端的意思。
/// - **调度**：`retryableServer(retryAfterSeconds:)` 驱动一次**前台**快照重读，长等待会
///   卡住界面 ⇒ 这里继续夹取 `0...5`（服务端当前只发 `1`，见 `apps/api/src/api-error.ts`）。
nonisolated enum RaiRetryAfter {
    /// **调度**用夹取区间（前台重试不应被服务端的长等待卡住）。
    static let schedulingRange: ClosedRange<TimeInterval> = 0...5
    /// **展示**用上限：只防荒谬值撑爆文案，不替服务端做决定。
    static let displayMaximum: TimeInterval = 600

    /// 原始秒数（**展示**用）：`nil` = 缺头、非整数秒或 HTTP-date。
    ///
    /// `Int` 严格整数：`"1.5"`、`"Wed, 21 Oct 2015 07:28:00 GMT"` 等都返回 nil。
    /// 负数按 0（"立即可重试"）。
    static func seconds(from rawValue: String?) -> TimeInterval? {
        guard let rawValue else { return nil }
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parsed = Int(trimmed) else { return nil }
        return min(max(TimeInterval(parsed), 0), displayMaximum)
    }

    /// 夹取后的秒数（**调度**用）：在 `seconds(from:)` 之上再夹到 `schedulingRange`。
    static func schedulingSeconds(from rawValue: String?) -> TimeInterval? {
        seconds(from: rawValue).map {
            min(max($0, schedulingRange.lowerBound), schedulingRange.upperBound)
        }
    }
}

struct RaiAPIClient {
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(session: URLSession? = nil) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        // Cap the whole transfer separately from individual request deadlines.
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

    func runCoach(baseURL: URL, token: String) async throws -> MobileRunCoachResponse {
        try await get(path: "/v1/mobile/run-coach", baseURL: baseURL, token: token)
    }

    // 2026-10-15（审查 C-🔡1）：四个"无 operationId 的直发写方法"（runCoachCommand /
    // confirmWeeklyPlan / updateGoals / lockSession）已删除 —— 持久发布统一走
    // `publishPlan(route:)` + `replayPlanPublication`（带 operationId 幂等键）。
    // 保留直发入口等于给"静默丢幂等"留一条可误用的后路。

    func coachLoop(baseURL: URL, token: String) async throws -> CoachLoopResponse {
        // 2026-10-18（事故复盘 P0-3）：coach-loop 是唯一的重计算读（服务端实测
        // 13.4s/条，且与其余读共用同一条主线程）。前台给它 60s 的专用超时：15s
        // 在故障恢复期仍会先把这条已排队的重读砍成 -1001，而重发只会再压一条
        // 重计算。其余 GET 一律保持默认 15s（轻读不应陪着重读一起等）。
        try await get(path: "/v1/mobile/coach-loop", baseURL: baseURL, token: token, timeout: 60)
    }

    func coachFeedback(_ input: CoachLoopFeedbackCommand, baseURL: URL, token: String) async throws -> CoachLoopFeedbackResult {
        try await send(path: "/v1/mobile/coach-feedback", method: "POST", body: input, baseURL: baseURL, token: token)
    }

    func refreshCoachPrediction(scope: PlanReceiptScope, baseURL: URL, token: String) async throws -> CoachLoopPredictionResult {
        struct Body: Encodable { let operationScope: PlanReceiptScope }
        return try await send(path: "/v1/mobile/coach-prediction-refresh", method: "POST",
            body: Body(operationScope: scope), baseURL: baseURL, token: token)
    }

    /// The executable week handed to the workout scheduler. Read-only, so it
    /// never competes with the goals revision lock.
    func workoutPlan(baseURL: URL, token: String) async throws -> MobileWorkoutPlanResponse {
        try await get(path: "/v1/mobile/workout-plan", baseURL: baseURL, token: token)
    }

    func trainingPlanState(baseURL: URL, token: String) async throws -> TrainingPlanStateResponse {
        try await get(path: "/v1/mobile/training-plan-state", baseURL: baseURL, token: token)
    }

    func planOperation<Result: Decodable>(id: String, baseURL: URL, token: String) async throws -> PlanPublicationResult<Result> {
        try await get(path: "/v1/mobile/plan-operations/\(escapedPath(id))", baseURL: baseURL, token: token)
    }
    func replayPlanPublication<Result: Decodable>(_ operation: PendingPlanPublication, baseURL: URL, token: String) async throws -> Result {
        let paths = ["coach": "/v1/mobile/run-coach", "coach-loop": "/v1/mobile/coach-loop", "confirm": "/v1/mobile/workout-plan/confirm", "goals": "/v1/mobile/goals", "lock": "/v1/mobile/lock"]
        guard let path = paths[operation.route] else { throw RaiAPIClientError.decoding("未知的发布操作") }
        return try await request(path: path, query: [], method: operation.route == "goals" ? "PUT" : "POST",
            body: operation.payload, baseURL: baseURL, token: token)
    }

    func previewWeeklyPlan(_ input: PreviewWeeklyPlanRequest, baseURL: URL, token: String) async throws -> MobileWeeklyPlanPreview {
        try await send(path: "/v1/mobile/workout-plan/preview", method: "POST", body: input,
                       baseURL: baseURL, token: token)
    }

    /// Registers a client-verified LOCAL SYSTEM workout schedule. Physical
    /// paired-Watch visibility is a separate manual acceptance step.
    /// Registration failure does not revoke SDK readback; the coordinator keeps
    /// the exact exported receipt for an explicit foreground retry.
    ///
    /// 2026-10-18（审查 P1-1）：v2 回执的规范线格式是**显式 null**——
    /// `warmup` / `cooldown` / 每个 step 的 `alert` / `alert.lower` / `alert.upper`
    /// 缺省时必须写 `null`，而不是像合成 Codable 那样省略键。此前只有教练闭环
    /// 分支手工补 null，普通手动计划直接发送合成 Codable ⇒ 合法回执被 422 终局拒绝
    /// （`plan_receipt_evidence_mismatch`）或 500（`step()` 读到 `undefined`）。
    /// 服务端已同时接受两种形状（P1-1 修复：先规范化再比较/落库），客户端仍统一写
    /// 规范形状，既保持跨客户端身份一致，也能让尚未升级的服务端接受。
    /// 现在**所有** v2 回执统一走 `planSyncWireBody`；legacy 手动计划回执仍保持
    /// 合成 Codable 的省略语义（`PlanSyncReceipt.useLegacyContract`）。
    func recordPlanSync(
        _ receipt: PlanSyncReceipt,
        baseURL: URL,
        token: String
    ) async throws -> PlanSyncReceiptResponse {
        // Legacy coach-loop receipts already went through the explicit-null
        // encoding before v2 existed, so they keep the exact same bytes.
        if receipt.contractVersion == 2 || receipt.coachLoop != nil {
            let path = receipt.coachLoop == nil
                ? "/v1/mobile/workout-plan/synced"
                : "/v1/mobile/coach-loop/synced"
            return try await request(path: path, query: [], method: "POST",
                body: try planSyncWireBody(receipt), baseURL: baseURL, token: token)
        }
        return try await send(
            path: "/v1/mobile/workout-plan/synced",
            method: "POST",
            body: receipt,
            baseURL: baseURL,
            token: token
        )
    }

    /// v2 回执的规范 wire 形状：缺失的可选键写成显式 `null`。
    ///
    /// 服务端把结构规范化后再计算摘要与落库，并接受省略 nil 的旧形状；但规范
    /// wire 形状仍要求显式 null（`warmup`/`cooldown`/`alert`/`lower`/`upper`
    /// 缺省即 `null`），这样同一条处方在两端得到同一个身份，未升级的服务端也能
    /// 通过它自己的规范化校验。教练闭环的 `decisionRef` 同样必须显式 null：
    /// 常规课没有决策引用，但键不能消失。
    ///
    /// 放在客户端而不是给 DTO 写 `encode(to:)`：legacy v1 与本地缓存解码必须继续
    /// 保持"省略 nil"的旧语义（`PlanSyncReceipt.useLegacyContract`）。
    private func planSyncWireBody(_ receipt: PlanSyncReceipt) throws -> Data {
        // 2026-10-18（审查 P3-17）：编码形状变化时安全失败，不能在主线程 `as!` trap。
        guard let objectValue = try JSONSerialization.jsonObject(with: encoder.encode(receipt)) as? [String: Any] else {
            throw RaiAPIClientError.decoding("回执无法编码为 JSON 对象")
        }
        var object = objectValue
        if let coachLoop = receipt.coachLoop {
            var context = object["coachLoop"] as? [String: Any] ?? [:]
            if let decisionRef = coachLoop.decisionRef { context["decisionRef"] = decisionRef }
            else { context["decisionRef"] = NSNull() }
            object["coachLoop"] = context
        }
        if var structure = object["structure"] as? [String: Any] {
            func step(_ value: Any?) -> Any {
                guard var result = value as? [String: Any] else { return NSNull() }
                if var alert = result["alert"] as? [String: Any] {
                    alert["lower"] = alert["lower"] ?? NSNull()
                    alert["upper"] = alert["upper"] ?? NSNull()
                    result["alert"] = alert
                } else { result["alert"] = NSNull() }
                return result
            }
            structure["warmup"] = step(structure["warmup"])
            structure["cooldown"] = step(structure["cooldown"])
            structure["blocks"] = (structure["blocks"] as? [[String: Any]] ?? []).map { block in
                var value = block
                value["steps"] = (block["steps"] as? [Any] ?? []).map { step($0) }
                return value
            }
            object["structure"] = structure
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
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
        sessionType: String?,
        localDate: String? = nil
    ) async throws -> WorkoutListResponse {
        var query: [URLQueryItem] = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]
        if let localDate { query.append(URLQueryItem(name: "localDate", value: localDate)) }
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

    /// P0-3：事实/分析/时序补齐状态。详情页在 `partial` 时显示「仍在补齐」并自动重取。
    func workoutFreshness(id: String, baseURL: URL, token: String) async throws -> WorkoutFreshnessResponse {
        try await get(path: "/v1/workouts/\(escapedPath(id))/freshness", baseURL: baseURL, token: token)
    }

    /// P1-1：服务端已覆盖区间，用于跳过已入库历史的重放。服务端不支持时调用方必须回落全量重放。
    func syncCoverage(types: [String], baseURL: URL, token: String) async throws -> SyncCoverageResponse {
        let query: [URLQueryItem] = types.isEmpty
            ? []
            : [URLQueryItem(name: "types", value: types.joined(separator: ","))]
        return try await get(path: "/v1/sync/coverage", query: query, baseURL: baseURL, token: token)
    }

    /// D9 分享卡片：服务端已按隐私区裁剪轨迹，客户端只画 `polylines`。
    func shareCard(id: String, baseURL: URL, token: String) async throws -> ShareCardResponse {
        try await get(path: "/v1/workouts/\(escapedPath(id))/share-card", baseURL: baseURL, token: token)
    }

    func submitFeedback(_ command: NativeFeedbackCommand, baseURL: URL, token: String) async throws -> NativeCommandResponse {
        try await send(path: "/v1/commands", method: "POST", body: command, baseURL: baseURL, token: token)
    }
    func command(id: String, baseURL: URL, token: String) async throws -> NativeCommandResponse {
        try await get(path: "/v1/commands/\(escapedPath(id))", baseURL: baseURL, token: token)
    }
    func job(id: String, baseURL: URL, token: String) async throws -> NativeJobStatus {
        try await get(path: "/v1/jobs/\(escapedPath(id))", baseURL: baseURL, token: token)
    }

    func exportWorkouts(from: String, through: String, baseURL: URL, token: String) async throws -> NativeWorkoutExport {
        try await get(path: "/v1/exports/workout-summary", query: [URLQueryItem(name: "from", value: from), URLQueryItem(name: "through", value: through)], baseURL: baseURL, token: token)
    }

    private func get<T: Decodable>(
        path: String,
        query: [URLQueryItem] = [],
        baseURL: URL,
        token: String,
        timeout: TimeInterval? = nil
    ) async throws -> T {
        try await request(path: path, query: query, method: "GET", body: Optional<Data>.none,
            baseURL: baseURL, token: token, timeout: timeout)
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
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw RaiAPIClientError.unavailable
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            if status == 401 { throw RaiAPIClientError.unauthorized }
            let apiError = try? decoder.decode(RaiAPIError.self, from: data)
            // 2026-10-15（审查 C-🔡3）：429 的 `Retry-After` 是服务端给出的**建议等待秒数**
            // （`apps/api/src/server.ts` 对 429 恒带该头）。折叠进文案，让"容量瞬时满"
            // 与"确定性拒绝"在提示层可分（此前两者文案完全一样，重试节奏只能靠猜）。
            // 展示用（429 文案复述服务端建议）与调度用（503 退避）**分开解析**（P3-28）：
            // 展示保留服务端原意（只防荒谬值），调度夹取 `0...5` 以免前台刷新被卡住。
            let displayRetryAfter = RaiRetryAfter.seconds(from: (response as? HTTPURLResponse)?
                .value(forHTTPHeaderField: "Retry-After"))
            let retryHint: String
            if status == 429, let displayRetryAfter {
                retryHint = "（建议 \(Int(displayRetryAfter)) 秒后重试）"
            } else {
                retryHint = ""
            }
            let code = apiError?.code ?? "http_\(status)"
            let message = (apiError?.message ?? "服务器返回 HTTP \(status)") + retryHint
            // 2026-10-18（审查 P2-6 收尾）：只有 503 + 可解析的 Retry-After 才升级成
            // "可重试的错误"，供新快照契约按服务端提示退避；其余响应保持旧 `.server`，
            // 既有模式匹配点不受影响。
            if status == 503,
               let schedulingRetryAfter = RaiRetryAfter.schedulingSeconds(
                   from: (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After")) {
                throw RaiAPIClientError.retryableServer(code: code, message: message,
                    status: status, retryAfterSeconds: schedulingRetryAfter)
            }
            throw RaiAPIClientError.server(code: code, message: message, status: status)
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
