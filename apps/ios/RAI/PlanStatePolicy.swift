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
    case current
    case cached(asOf: Date?)
    case refreshing
    case savedAwaitingRefresh
    case revisionMismatch
    case unavailable

    var message: String {
        switch self {
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
}

struct PlanScheduledEntry: Codable, Equatable {
    let workoutID: UUID
    let localDate: String
    let scheduledAt: Date
}

enum PlanFingerprint {
    static func make(days: [MobileWorkoutPlanDay], timezone: String, hour: Int, completed: Set<String>) -> String {
        struct Input: Encodable {
            let days: [MobileWorkoutPlanDay]
            let timezone: String
            let hour: Int
            let completed: [String]
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(Input(days: days, timezone: timezone, hour: hour, completed: completed.sorted()))) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
