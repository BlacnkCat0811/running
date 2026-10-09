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
        case .cached: return "上次缓存安排；联网后请重新确认"
        case .refreshing: return "正在刷新今天的安排"
        case .savedAwaitingRefresh: return "已保存，等待联网刷新；旧处方不会作为当前安排"
        case .revisionMismatch: return "计划版本不一致，请刷新后重试"
        case .unavailable: return "尚未确认今天的安排，请连接服务后重试"
        }
    }
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

    func matchesForExecution(_ other: PlanSyncSnapshot) -> Bool {
        scope == other.scope && configuration == other.configuration && revision == other.revision &&
            timezone == other.timezone && reminderHour == other.reminderHour && completedDates == other.completedDates &&
            localDate == other.localDate && windowDays == other.windowDays && leaseID == other.leaseID &&
            coherenceToken == other.coherenceToken && windowStart == other.windowStart && windowEnd == other.windowEnd &&
            serverIdentity == other.serverIdentity && days.count == other.days.count &&
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
    static func make(days: [MobileWorkoutPlanDay], timezone: String, hour: Int, completed: Set<String>) -> String {
        struct Input: Encodable {
            let days: [String]
            let timezone: String
            let hour: Int
            let completed: [String]
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let content = days.map { "\($0.localDate)|\($0.executable)|\(prescriptionDigest(kind: $0.kind, structure: $0.structure))" }
        let data = (try? encoder.encode(Input(days: content, timezone: timezone, hour: hour, completed: completed.sorted()))) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func prescriptionDigest(kind: String, structure: MobileSessionStructure?) -> String {
        func number(_ value: Double?) -> String {
            guard let value else { return "~" }
            return String(format: "%.6f", locale: Locale(identifier: "en_US_POSIX"), value == 0 ? 0 : value)
        }
        func step(_ value: MobileWorkoutStep?) -> [String] {
            guard let value else { return ["~"] }
            let goal: [String]
            switch value.goal {
            case .distance(let meters): goal = ["distance", number(meters)]
            case .time(let seconds): goal = ["time", number(seconds)]
            case .open: goal = ["open", "~"]
            }
            return [value.purpose] + goal + [value.alert?.kind ?? "~", number(value.alert?.lower), number(value.alert?.upper)]
        }
        var parts = ["rai-prescription-v1", kind]
        if let structure {
            parts += step(structure.warmup) + [String(structure.blocks.count)]
            for block in structure.blocks {
                parts += [number(Double(block.iterations)), String(block.steps.count)]
                for item in block.steps { parts += step(item) }
            }
            parts += step(structure.cooldown)
        } else { parts.append("~") }
        return SHA256.hash(data: Data(parts.joined(separator: "|").utf8)).map { String(format: "%02x", $0) }.joined()
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
    enum Code: String { case offline, timeout, unauthorized, contractMismatch, revisionConflict, serverUnavailable, storageUnavailable, corruptPayload, unsupportedSchema }
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
