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
        /// v2 训练读合同不被服务端理解（409 `training_contract_unsupported` 或 404）。
        /// 与 `contractMismatch` 分开：这是**必须升级**才能解决的状态，不是某份载荷
        /// 解不开；把它折进"计划快照不可信"会让升级提示消失。
        case upgradeRequired
        /// v2 统一安装尚未迁移（409 `training_plan_not_migrated`）。
        case notMigrated
    }
    let code: Code
    let message: String
    var retryable: Bool { [.offline, .timeout, .serverUnavailable, .revisionConflict].contains(code) }
}

/// v2 统一训练页的**纯**展示状态。
///
/// 为什么把判定放在这里而不是视图里：页面必须把休息 / 比赛日 / 需要刷新 /
/// 事实待确认 / 不可判定 / 设备协调待确认 / 合同需升级分开，其中任何一项写错，
/// 用户就会把"不知道"读成"今天休息"。视图没有回归通道，这里可以用纯逻辑钉住；
/// 七个状态里只有"休息"允许出现"休息"二字。
struct TrainingPlanUnifiedView: Equatable {
    enum Phase: Equatable {
        /// 还没读到（首次进入页面），不是"没有训练"。
        case loading
        /// 服务端不认识合同 2：显示升级提示，绝不显示成休息。
        case upgradeRequired
        /// 数据域尚未迁移：显示迁移提示，绝不显示成休息。
        case notMigrated
        /// 网络/服务端暂时不可读。
        case unavailable(String)
        /// 载荷解开了，但模式/运行状态/准入取值本版本不认识：不猜，不当作休息。
        case notAssessable(String)
        /// 缺少（或未接受）训练配置：唯一入口是配置向导。
        case needsConfiguration
        /// 程序已结束，需要确认后才能创建新的训练模式。
        case needsConfirmation
        /// 状态陈旧（业务日已过 / 旧 goals 行又变过 / 只有上次缓存）。
        case refreshRequired
        case ready
    }

    let phase: Phase
    /// 这份状态只作上次参考，不能当作当前安排。
    let isReferenceOnly: Bool
    let mode: String?
    let runState: String?
    let admission: String?
    let daysToRace: Int?
    let isRaceDay: Bool
    /// 只有存储里今天**明确排了休息**才是 true；没有行 = 不知道，不是休息。
    let isRest: Bool
    let todayIntent: MobilePlannedDay?
    let weekDays: [MobilePlannedDay]
    /// 事实新鲜度尚未评估（`execution.reasonCodes`）。
    let factsPending: Bool
    /// 设备（手表）排期尚未协调完成：不可把"还没同步"说成"今天没有训练"。
    let deviceCoordinationPending: Bool
    /// 读投影**从不**产生执行授权；恒为 false（见 `TrainingPlanUnifiedPolicy.executionGranted`）。
    let executionGranted: Bool
    /// 服务端若在投影里给了执行授权，这里记下契约冲突（消费方不得据此执行）。
    let contractViolation: String?
}

/// 过去一天在统一训练页"本周回顾"里的展示行。
///
/// F03 的渲染侧：过去一天有处方、没有观测时，`kind` 是原计划类型、`observation`
/// 是 `unknown`。把它画成"休息"等于断言跑者休息了，而数据只说明**没有证据**。
struct TrainingPlanWeekReviewRow: Identifiable, Equatable {
    let localDate: String
    /// 用于配色/图标的展示类型。未观测的日期用**原处方类型**，不是 rest。
    let displayKind: String
    let title: String
    let detail: String
    var id: String { localDate }
}

enum TrainingPlanUnifiedValidationError: Error, LocalizedError, Equatable {
    case unsupportedContractVersion(Int)
    case identityMismatch
    case staleGoalsRevision(reported: Int, floor: Int)
    case invalidBusinessDate(String)
    case invalidDays(String)
    case unknownValue(field: String, value: String)
    case inconsistentRaceMode(String)

    var errorDescription: String? {
        switch self {
        case let .unsupportedContractVersion(version):
            return "训练读合同版本 \(version) 与客户端理解的版本 2 不一致。"
        case .identityMismatch:
            return "统一训练状态的数据域与服务身份不一致。"
        case let .staleGoalsRevision(reported, floor):
            return "统一训练状态的目标版本 \(reported) 低于已确认的 \(floor)。"
        case let .invalidBusinessDate(value):
            return "统一训练状态的业务日期不是当前业务日：\(value)。"
        case let .invalidDays(reason):
            return "统一训练状态的七日意图不可信：\(reason)。"
        case let .unknownValue(field, value):
            return "统一训练状态的 \(field) 取值 \(value) 本版本无法判定。"
        case let .inconsistentRaceMode(reason):
            return "统一训练状态的比赛模式自相矛盾：\(reason)。"
        }
    }
}

/// v2 统一训练状态的全部判定（纯函数）。
///
/// 两个职责：
/// 1. `validate`：接受一份快照前校验身份、业务日、七日窗口和版本下限。**失败即拒绝**，
///    不做"看起来差不多就先用"的降级 —— 旧快照被当成当前安排，比没有安排更危险。
/// 2. `view`：把"服务端说了什么"翻译成页面可渲染的七种状态。这是"未知合同版本
///    显示升级、不显示休息"这条要求的唯一实现点。
enum TrainingPlanUnifiedPolicy {
    static let businessTimeZone = "Asia/Shanghai"
    static let modes: Set<String> = ["coach", "race"]
    static let runStates: Set<String> = ["active", "paused"]
    static let admissions: Set<String> = ["ready", "needs_configuration", "needs_confirmation"]
    static let windowDays = 7

    private static let zone = TimeZone(identifier: businessTimeZone)
        ?? TimeZone(secondsFromGMT: 8 * 3600)
        ?? TimeZone.current

    /// 严格 `YYYY-MM-DD`（`2026-02-30` 这类近似值不算）。业务日期会移动整个窗口，
    /// `DateFormatter` 默认的宽松解析会把它们悄悄挪到 3 月。
    static func isValidLocalDate(_ value: String) -> Bool {
        guard value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else {
            return false
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.isLenient = false
        guard let date = formatter.date(from: value) else { return false }
        return formatter.string(from: date) == value
    }

    private static func parseLocalDate(_ value: String) -> Date? {
        guard isValidLocalDate(value) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value)
    }

    private static func formatLocalDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    /// 业务日起七日窗口的最后一天（含）。
    static func windowEnd(after businessDate: String) -> String? {
        guard let start = parseLocalDate(businessDate) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        guard let end = calendar.date(byAdding: .day, value: windowDays - 1, to: start) else { return nil }
        return formatLocalDate(end)
    }

    /// 接受一份 v2 快照之前的全部校验。抛出即拒绝，调用方必须回到"未确认"状态。
    static func validate(
        _ snapshot: TrainingPlanStateResponseV2,
        identity: PlanReceiptScope?,
        minimumGoalsRevision: Int,
        now: Date
    ) throws {
        guard snapshot.contractVersion == 2 else {
            throw TrainingPlanUnifiedValidationError.unsupportedContractVersion(snapshot.contractVersion)
        }
        // 身份校验必须先于任何展示：缓存按 scope 命名空间存放，但一条错域快照
        // 仍然会污染另一个数据域的页面。
        guard let identity, !identity.serverId.isEmpty, !identity.athleteId.isEmpty,
              !identity.datasetEpoch.isEmpty, identity == snapshot.scope else {
            throw TrainingPlanUnifiedValidationError.identityMismatch
        }
        guard isValidLocalDate(snapshot.businessDate),
              UserDataNoticePolicy.isCurrentDay(snapshot.businessDate, timezone: businessTimeZone, now: now) else {
            throw TrainingPlanUnifiedValidationError.invalidBusinessDate(snapshot.businessDate)
        }
        guard modes.contains(snapshot.mode) else {
            throw TrainingPlanUnifiedValidationError.unknownValue(field: "mode", value: snapshot.mode)
        }
        guard runStates.contains(snapshot.runState) else {
            throw TrainingPlanUnifiedValidationError.unknownValue(field: "runState", value: snapshot.runState)
        }
        guard admissions.contains(snapshot.admission) else {
            throw TrainingPlanUnifiedValidationError.unknownValue(field: "admission", value: snapshot.admission)
        }
        // 版本下限：写确认（acknowledgement）只提高下限，读侧永远不能把它拉低。
        guard snapshot.plan.currentGoalsRevision >= minimumGoalsRevision else {
            throw TrainingPlanUnifiedValidationError.staleGoalsRevision(
                reported: snapshot.plan.currentGoalsRevision, floor: minimumGoalsRevision)
        }
        guard let end = windowEnd(after: snapshot.businessDate) else {
            throw TrainingPlanUnifiedValidationError.invalidBusinessDate(snapshot.businessDate)
        }
        var previous = ""
        var seen = Set<String>()
        for day in snapshot.plan.days {
            guard isValidLocalDate(day.localDate) else {
                throw TrainingPlanUnifiedValidationError.invalidDays("日期不可解析：\(day.localDate)")
            }
            guard day.localDate >= snapshot.businessDate, day.localDate <= end else {
                throw TrainingPlanUnifiedValidationError.invalidDays(
                    "日期 \(day.localDate) 不在业务日窗口 \(snapshot.businessDate)…\(end) 内")
            }
            guard seen.insert(day.localDate).inserted else {
                throw TrainingPlanUnifiedValidationError.invalidDays("重复日期：\(day.localDate)")
            }
            guard day.localDate > previous else {
                throw TrainingPlanUnifiedValidationError.invalidDays("未按日期升序：\(day.localDate)")
            }
            previous = day.localDate
        }
        if let identities = snapshot.sessions {
            guard identities.contractVersion == 1 else {
                throw TrainingPlanUnifiedValidationError.unknownValue(field: "sessions.contractVersion", value: "\(identities.contractVersion)")
            }
            guard !identities.planInstanceId.isEmpty else { throw TrainingPlanUnifiedValidationError.invalidDays("课程实例身份缺失") }
            var ids = Set<String>(), activeDates = Set<String>()
            let protections: Set<String> = ["automatic", "user_protected"]
            let lifecycles: Set<String> = ["pending", "completed", "partial", "skipped", "cancelled"]
            let instant = ISO8601DateFormatter()
            instant.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            for session in identities.sessions {
                guard session.planInstanceId == identities.planInstanceId, !session.sessionId.isEmpty,
                      session.sessionRevision > 0, ids.insert(session.sessionId).inserted,
                      isValidLocalDate(session.prescription.localDate), session.prescription.kind != "rest",
                      protections.contains(session.protection), lifecycles.contains(session.lifecycle),
                      instant.date(from: session.availableAt) != nil,
                      session.supersededBySessionId != session.sessionId else {
                    throw TrainingPlanUnifiedValidationError.invalidDays("课程身份、修订或状态不可信")
                }
                if let override = session.userOverride {
                    guard session.protection == "user_protected", override.prescription == session.prescription,
                          instant.date(from: override.availableAt) != nil else {
                        throw TrainingPlanUnifiedValidationError.invalidDays("用户覆盖与有效处方不一致")
                    }
                }
                if session.lifecycle != "cancelled" && session.supersededBySessionId == nil {
                    let date = session.prescription.localDate
                    guard activeDates.insert(date).inserted else { throw TrainingPlanUnifiedValidationError.invalidDays("同日课程占位冲突") }
                    if date >= snapshot.businessDate && date <= end && !snapshot.plan.days.contains(session.prescription) {
                        throw TrainingPlanUnifiedValidationError.invalidDays("课程与已发布意图不一致")
                    }
                }
            }
            for day in snapshot.plan.days where day.kind != "rest" {
                guard identities.sessions.contains(where: { $0.prescription == day && $0.lifecycle != "cancelled" && $0.supersededBySessionId == nil }) else {
                    throw TrainingPlanUnifiedValidationError.invalidDays("已发布意图没有稳定课程身份")
                }
            }
            if let executions = identities.executions {
                var executionIds = Set<String>()
                for execution in executions {
                    guard executionIds.insert(execution.sessionId).inserted,
                          let session = identities.sessions.first(where: { $0.sessionId == execution.sessionId }) else {
                        throw TrainingPlanUnifiedValidationError.invalidDays("执行行重复或没有对应课程")
                    }
                    if let message = TrainingPlanExecutionPolicy.validate(execution: execution, session: session) {
                        throw TrainingPlanUnifiedValidationError.invalidDays(message)
                    }
                }
            }
            for suppression in identities.suppressions {
                guard isValidLocalDate(suppression.localDate), ["moved", "cancelled", "explicit_rest"].contains(suppression.reason),
                      instant.date(from: suppression.availableAt) != nil,
                      suppression.sessionId.map({ ids.contains($0) }) ?? (suppression.reason == "explicit_rest"),
                      suppression.reason != "explicit_rest" || !activeDates.contains(suppression.localDate) else {
                    throw TrainingPlanUnifiedValidationError.invalidDays("课程日期抑制不可信")
                }
            }
        }
        if snapshot.mode == "race" {
            guard snapshot.raceGoal != nil, let days = snapshot.daysToRace, days >= 0 else {
                throw TrainingPlanUnifiedValidationError.inconsistentRaceMode(
                    "mode=race 但没有可用的比赛目标或天数")
            }
        }
    }

    /// 读投影**从不**执行。即便服务端（或中间人）在 `execution.permitted` 里写了
    /// true，这里也返回 false：统一状态是投影，事实新鲜度与设备协调都还没有评估过；
    /// 真正的执行授权只能来自执行快照（`TrainingPlanStore.executablePlan`）。
    static func executionGranted(for snapshot: TrainingPlanStateResponseV2) -> Bool {
        _ = snapshot
        return false
    }

    /// 把快照/读取错误翻译成页面状态。`issue` 来自最近一次 v2 读，
    /// `isReferenceOnly` 表示手上的快照只是上次接受过的参考（不是本次确认的当前状态）。
    static func view(
        snapshot: TrainingPlanStateResponseV2?,
        issue: PlanReadIssue?,
        isRefreshing: Bool,
        isReferenceOnly: Bool,
        deviceCoordinationPending: Bool,
        now: Date
    ) -> TrainingPlanUnifiedView {
        func blank(_ phase: TrainingPlanUnifiedView.Phase) -> TrainingPlanUnifiedView {
            .init(phase: phase, isReferenceOnly: isReferenceOnly, mode: nil, runState: nil,
                  admission: nil, daysToRace: nil, isRaceDay: false, isRest: false,
                  todayIntent: nil, weekDays: [], factsPending: false,
                  deviceCoordinationPending: false, executionGranted: false, contractViolation: nil)
        }
        // 合同拒绝优先于一切：一份昨天可读的状态不能掩盖"服务端已不认识合同"。
        switch issue?.code {
        case .upgradeRequired: return blank(.upgradeRequired)
        case .notMigrated: return blank(.notMigrated)
        default: break
        }
        guard let snapshot else {
            if let issue { return blank(.unavailable(issue.message)) }
            if isRefreshing { return blank(.loading) }
            return blank(.loading)
        }
        guard snapshot.contractVersion == 2 else { return blank(.upgradeRequired) }
        guard modes.contains(snapshot.mode), runStates.contains(snapshot.runState),
              admissions.contains(snapshot.admission) else {
            return blank(.notAssessable("服务端返回了本版本无法判定的模式、运行状态或准入状态"))
        }
        let todayIntent = snapshot.intent(on: snapshot.businessDate)
        let reasonCodes = snapshot.execution.reasonCodes
        let currentBusinessDate = isValidLocalDate(snapshot.businessDate)
            && UserDataNoticePolicy.isCurrentDay(snapshot.businessDate, timezone: businessTimeZone, now: now)
        let phase: TrainingPlanUnifiedView.Phase
        if snapshot.admission == "needs_configuration" {
            phase = .needsConfiguration
        } else if snapshot.admission == "needs_confirmation" || snapshot.migration.sourceStatus == "ended" {
            phase = .needsConfirmation
        } else if !currentBusinessDate || !snapshot.plan.current || isReferenceOnly {
            phase = .refreshRequired
        } else {
            phase = .ready
        }
        let isRaceDay = snapshot.mode == "race" && snapshot.modeReason == "race_day"
        return .init(
            phase: phase,
            isReferenceOnly: isReferenceOnly,
            mode: snapshot.mode,
            runState: snapshot.runState,
            admission: snapshot.admission,
            daysToRace: snapshot.daysToRace,
            isRaceDay: isRaceDay,
            // 只有"今天存储里明确排了休息"才算休息。没有今天的行 = 不知道，
            // 这是 F03 在客户端这边的同一判据。
            isRest: phase == .ready && !isRaceDay && todayIntent?.kind == "rest",
            todayIntent: todayIntent,
            weekDays: snapshot.plan.days,
            factsPending: reasonCodes.contains("facts_freshness_not_evaluated"),
            deviceCoordinationPending: deviceCoordinationPending
                || reasonCodes.contains("device_coordination_not_evaluated"),
            executionGranted: executionGranted(for: snapshot),
            contractViolation: snapshot.execution.permitted
                ? "训练读合同返回了执行授权；本版本把统一状态当作只读投影，已忽略该授权。"
                : nil
        )
    }

    /// 过去日期的回顾行（F03 渲染侧）。规则与 `apps/api/src/mobile-coach.ts` 的
    /// `buildWeekPlan` 对齐：`observation == "unknown"` 说明**没有证据**，
    /// 有原处方就是"已排课、尚无观测"，没有原处方就是"未排课"，两者都不是"休息"。
    static func weekReview(from days: [MobileWeekPlanDay], businessDate: String) -> [TrainingPlanWeekReviewRow] {
        days.filter { $0.localDate < businessDate }
            .sorted { $0.localDate < $1.localDate }
            .map { day in
                let observed = day.observation == "observed" || day.completedWorkoutId != nil
                if observed {
                    return TrainingPlanWeekReviewRow(
                        localDate: day.localDate,
                        displayKind: day.kind,
                        title: day.title.isEmpty ? "已完成" : day.title,
                        detail: "已导入训练"
                    )
                }
                let plannedKind = day.intentKind ?? (day.planned && day.kind != "rest" ? day.kind : nil)
                if let plannedKind, plannedKind != "rest" {
                    return TrainingPlanWeekReviewRow(
                        localDate: day.localDate,
                        displayKind: plannedKind,
                        title: day.title.isEmpty ? "原计划 \(plannedKind)" : day.title,
                        detail: "尚无训练观测"
                    )
                }
                if day.observation == "unknown" {
                    return TrainingPlanWeekReviewRow(
                        localDate: day.localDate,
                        displayKind: "rest",
                        title: day.title.isEmpty ? "未安排训练" : day.title,
                        detail: "未排课，也未观测到训练"
                    )
                }
                // F03 之前的服务端不区分"排了休息"和"没取到观测"：只能如实说明
                // 这份载荷没有该字段，不能据此断言跑者休息了。
                return TrainingPlanWeekReviewRow(
                    localDate: day.localDate,
                    displayKind: day.kind,
                    title: day.title.isEmpty ? "无观测记录" : day.title,
                    detail: "该服务端未提供观测状态"
                )
            }
    }

    /// 单日状态副标题：把"没有观测证据"和"没排课"分开。
    ///
    /// 返回值只用于补充 `kind`（展示类型）**旁边**的说明，不参与配色或执行判断：
    /// 一个 past interval 的展示类型仍是 interval，不能被渲染成 rest。
    /// `nil` = 现行契约没有给出观测字段（老服务端），调用方沿用原状态文案。
    static func observationNote(_ day: MobileWeekPlanDay) -> String? {
        if day.completedWorkoutId != nil || day.observation == "observed" { return "已导入训练" }
        if day.observation == "unknown" {
            if let intent = day.intentKind, intent != "rest" { return "原计划 · 尚无训练观测" }
            if day.planned, day.kind != "rest" { return "尚无训练观测" }
            return "未排课"
        }
        return nil
    }
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

@MainActor protocol TrainingPlanCommandPersistence: AnyObject {
    func pendingPublication(scope: String) -> CacheReadResult<PendingPlanPublication?>
    func savePublication(_ value: PendingPlanPublication?, scope: String) -> Bool
    func trainingPlanCommandWatermark(scope: String) -> CacheReadResult<TrainingPlanCommandWatermark>
    func saveTrainingPlanCommandWatermark(_ value: TrainingPlanCommandWatermark, scope: String) -> Bool
}
