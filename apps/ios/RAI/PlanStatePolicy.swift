import Foundation
import CryptoKit

/// Durable safety metadata, separate from evictable presentation caches.
struct PlanWriteAcknowledgement: Codable, Equatable {
    let revision: Int
    let action: String
    let acknowledgedAt: Date
    let planId: String?
}

enum PlanAvailability: Equatable {
    case empty
    case current
    case cached(asOf: Date?)
    case refreshing
    case savedAwaitingRefresh
    case revisionMismatch
    case unavailable

    var message: String {
        switch self {
        case .empty: return "当前窗口没有待执行训练；仍可管理旧系统排期"
        case .current: return "当前安排"
        case .cached(let asOf):
            // 2026-10-18（审查 P3-15）：缓存态必须能说明"缓存于何时"，
            // 否则离线时无法区分十分钟前和三天前的安排。
            guard let asOf else { return "上次缓存安排（缓存时间未知）；联网后请重新确认" }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd HH:mm"
            return "上次缓存安排（缓存于 \(formatter.string(from: asOf))）；联网后请重新确认"
        case .refreshing: return "正在刷新今天的安排"
        case .savedAwaitingRefresh: return "已保存，等待联网刷新；旧处方不会作为当前安排"
        case .revisionMismatch: return "计划版本不一致，请刷新后重试"
        case .unavailable: return "尚未确认今天的安排，请连接服务后重试"
        }
    }
}

/// 2026-10-18（审查 P2-8）：身份/日期/窗口/逐日/摘要等**安全字段**校验失败
/// 与"协议形状不兼容"（`RaiAPIClientError.decoding`）是两件事：
/// 前者是服务端数据不可信/不完整，后者才提示升级客户端。两者都不能进入执行，
/// 但诊断与用户文案必须分开（旧实现把前者归成 `contractMismatch` 并引导升级 App）。
struct PlanSnapshotValidationError: Error, LocalizedError, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct PlanPresentationSnapshot {
    let revision: Int
    let goals: MobileGoalsResponse?
    let coach: MobileRunCoachResponse?
    let coachPlan: MobileRunCoachPlan?
    let today: MobileTodayResponse?
    let executablePlan: MobileWorkoutPlanResponse?
    let availability: PlanAvailability
    let lastKnownTodayDate: String?
    var issue: PlanReadIssue? = nil
}

/// Equality deliberately excludes generatedAt and all credentials. Revision alone
/// is insufficient: recovery gates can change an effective prescription in place.
struct PlanSyncSnapshot: Equatable {
    let scope: String
    let configuration: UUID
    let revision: Int
    let days: [MobileWorkoutPlanDay]
    let timezone: String
    let reminderHour: Int
    let completedDates: Set<String>
    let localDate: String
    let windowDays: Int
    let leaseID: UUID
    var coherenceToken: String? = nil
    var windowStart: String? = nil
    var windowEnd: String? = nil
    var serverIdentity: PlanReceiptScope? = nil
    var coachLoop: CoachLoopReceiptContext? = nil

    func matchesForExecution(_ other: PlanSyncSnapshot) -> Bool {
        scope == other.scope && configuration == other.configuration && revision == other.revision &&
            timezone == other.timezone && reminderHour == other.reminderHour && completedDates == other.completedDates &&
            localDate == other.localDate && windowDays == other.windowDays && leaseID == other.leaseID &&
            coherenceToken == other.coherenceToken && windowStart == other.windowStart && windowEnd == other.windowEnd &&
            serverIdentity == other.serverIdentity && coachLoop == other.coachLoop && days.count == other.days.count &&
            zip(days, other.days).allSatisfy { left, right in
                left.localDate == right.localDate && left.kind == right.kind && left.executable == right.executable &&
                    left.structure == right.structure
            }
    }
}

enum PlanWatchState: String {
    case unknown, verifiedCurrent, partial, stale, empty, unsupported, denied
    var label: String {
        switch self {
        case .unknown: return "未核验"
        case .verifiedCurrent: return "系统日程已核验"
        case .partial: return "部分核验"
        case .stale: return "需要更新／撤回"
        case .empty: return "系统日程已清空"
        case .unsupported: return "设备不支持"
        case .denied: return "未获授权"
        }
    }
}

/// App-wide, not server-scoped: WorkoutKit has ONE schedule owned by this app.
/// No health samples, credentials, or full prescription payloads are retained.
struct PlanWatchLedger: Codable, Equatable {
    let scope: String
    let revision: Int
    let entries: [PlanScheduledEntry]
    let fingerprint: String
    let reminderHour: Int
    let confirmedAt: Date
    var registeredDates: [String]
    var requiresWithdrawal: Bool? = nil
    var receipts: [PlanSyncReceipt]? = nil
    var coherenceToken: String? = nil
}

struct PlanScheduledEntry: Codable, Equatable {
    let workoutID: UUID
    let localDate: String
    let scheduledAt: Date
}

enum PlanFingerprint {
    /// 与 `packages/api-contracts` 的 `MOBILE_SESSION_KINDS` 对齐（2026-10-18 审查 P2-13）。
    static let allowedSessionKinds: Set<String> = ["rest", "recovery", "easy", "long_run", "tempo", "interval"]

    static func make(days: [MobileWorkoutPlanDay], timezone: String, hour: Int, completed: Set<String>) -> String {
        struct Input: Encodable {
            let days: [String]
            let timezone: String
            let hour: Int
            let completed: [String]
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        // 不可量化的数值（非有限 / |x|>1e9）不猜测成某个剂量：落成 "invalid" 这个
        // 永不等于任何 64 位十六进制摘要的哨兵，使租约/指纹比较 fail-closed（必然提示更新）。
        let content = days.map { "\($0.localDate)|\($0.executable)|\(safePrescriptionDigest(kind: $0.kind, structure: $0.structure) ?? "invalid")" }
        let data = (try? encoder.encode(Input(days: content, timezone: timezone, hour: hour, completed: completed.sorted()))) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// `rai-prescription-v1` 的数值格式：与 TS 端（2026-10-18 审查 P2-13）逐字节对齐。
    ///
    /// 规则（两端必须一致）：
    /// 1. null → `~`；
    /// 2. 非有限或 |x| > 1e9 → 抛错（不猜测、不钳制）；
    /// 3. 量化到微单位 `floor(x*1e6 + 0.5)`（JS `Math.round` 同一舍入，`-0` 自然落到 0）；
    /// 4. 从整数微单位拼出固定六位小数（`1.0000015 → "1.000002"`），
    ///    **不要**对原值直接 `%.6f`/`toFixed`：两者对十进制半值的舍入不同，
    ///    在大值上还会二次舍入。
    static func prescriptionDigest(kind: String, structure: MobileSessionStructure?) throws -> String {
        // 与 TS 端一致：kind 是摘要身份的一部分，且不允许未知取值或分隔符注入。
        // 未知 kind 抛错而不是拼进摘要（旧实现会让 `"easy|~|0"` 这类 kind 撞上别的结构）。
        guard PlanFingerprint.allowedSessionKinds.contains(kind) else {
            throw PlanDigestError.unknownSessionKind(kind)
        }
        func number(_ value: Double?) throws -> String {
            guard let value else { return "~" }
            guard value.isFinite else { throw PlanDigestError.nonFinitePrescriptionValue }
            guard abs(value) <= 1_000_000_000 else { throw PlanDigestError.prescriptionValueOutOfRange }
            let micro = Int64((value * 1_000_000 + 0.5).rounded(.down))
            if micro == 0 { return "0.000000" }
            var digits = String(micro.magnitude)
            if digits.count < 7 { digits = String(repeating: "0", count: 7 - digits.count) + digits }
            let split = digits.index(digits.endIndex, offsetBy: -6)
            return (micro < 0 ? "-" : "") + String(digits[..<split]) + "." + String(digits[split...])
        }
        func step(_ value: MobileWorkoutStep?) throws -> [String] {
            guard let value else { return ["~"] }
            let goal: [String]
            switch value.goal {
            case .distance(let meters): goal = ["distance", try number(meters)]
            case .time(let seconds): goal = ["time", try number(seconds)]
            case .open: goal = ["open", "~"]
            }
            return [value.purpose] + goal + [value.alert?.kind ?? "~", try number(value.alert?.lower), try number(value.alert?.upper)]
        }
        var parts = ["rai-prescription-v1", kind]
        if let structure {
            parts += try step(structure.warmup)
            parts.append(String(structure.blocks.count))
            for block in structure.blocks {
                parts.append(try number(Double(block.iterations)))
                parts.append(String(block.steps.count))
                for item in block.steps { parts += try step(item) }
            }
            parts += try step(structure.cooldown)
        } else { parts.append("~") }
        return SHA256.hash(data: Data(parts.joined(separator: "|").utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// 非执行/指纹比较路径的安全入口：不可量化的数值返回 nil，由调用方 fail-closed。
    static func safePrescriptionDigest(kind: String, structure: MobileSessionStructure?) -> String? {
        try? prescriptionDigest(kind: kind, structure: structure)
    }
}

/// 2026-10-18（审查 P2-13）：数值不可量化时的显式错误，调用方不得吞成某个剂量。
enum PlanDigestError: Error, LocalizedError, Equatable {
    case nonFinitePrescriptionValue
    case prescriptionValueOutOfRange
    case unknownSessionKind(String)
    var errorDescription: String? {
        switch self {
        case .nonFinitePrescriptionValue: return "处方数值不是有限数"
        case .prescriptionValueOutOfRange: return "处方数值超出可表示范围（|x| > 1e9）"
        case .unknownSessionKind(let kind): return "未知训练类型：\(kind)"
        }
    }
}

enum CacheReadResult<Value> {
    case value(Value), notFound, unsupportedSchema, corruptPayload, storageUnavailable
    var value: Value? { if case .value(let value) = self { return value }; return nil }
    var isFailure: Bool {
        switch self { case .value, .notFound: return false; default: return true }
    }
    var failureCode: PlanReadIssue.Code? {
        switch self {
        case .unsupportedSchema: return .unsupportedSchema
        case .corruptPayload: return .corruptPayload
        case .storageUnavailable: return .storageUnavailable
        default: return nil
        }
    }
}

struct PlanReadIssue: Equatable {
    enum Code: String {
        case offline, timeout, unauthorized, contractMismatch, revisionConflict, serverUnavailable
        case storageUnavailable, corruptPayload, unsupportedSchema
        /// 服务端数据通过了协议形状，但安全字段（身份/日期/窗口/逐日/摘要）不可信。
        /// 与 `contractMismatch` 分开：前者不该提示升级客户端（2026-10-18 审查 P2-8）。
        case snapshotValidationFailed
    }
    let code: Code
    let message: String
    var retryable: Bool { [.offline, .timeout, .serverUnavailable, .revisionConflict].contains(code) }
}

struct PlanPublicationResult<Result: Decodable>: Decodable {
    let status: String
    let operationId: String
    let result: Result?
}

struct PendingPlanPublication: Codable {
    let operationId: String
    let route: String
    let payload: Data
    let preparedAt: Date
}

struct PlanDiagnosticEvent: Codable {
    let at: Date
    let name: String
    let scopeDigest: String
    let operationId: String?
    let revision: Int
    let owed: Int?
    let confirmed: Int?
    let errorCode: String?
    var durationMilliseconds: Double? = nil
}
