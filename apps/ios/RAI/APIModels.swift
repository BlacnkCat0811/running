import Foundation

struct RaiHandshake: Codable, Equatable {
    /// 客户端理解的同步协议主版本（2026-10-15 审查 D-🔡2）。
    ///
    /// 服务端在 `/v1/handshake` 恒定宣告该值（`apps/api/src/server.ts`，当前 `1`）。
    /// 判定点：`TechViews` 的"服务"区块 —— 版本不等时**显式提示升级**，
    /// 而不是像此前那样只把它当任务同一性字段、静默照常使用。
    static let supportedSyncProtocolVersion = 1
    var syncProtocolCompatible: Bool { syncProtocolVersion == Self.supportedSyncProtocolVersion }
    let serverId: String
    let athleteId: String
    let datasetEpoch: String
    let syncProtocolVersion: Int
    let apiVersion: String
    var healthKitRecordSyncVersion: Int? = nil
    var planReceiptMetadata: Bool? = nil
    var planSnapshotContractVersion: Int? = nil
    var planPublicationContractVersion: Int? = nil
    var planReceiptContractVersion: Int? = nil
    var coachLoopContractVersion: Int? = nil
    /// 直连原始回执能力（`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §10.2「handshake新增可选
    /// raw receipt能力，不随意改变 scope 或 datasetEpoch」）。
    ///
    /// 服务端宣告 `1`（`apps/api/src/server.ts`，声明在 `packages/api-contracts/src/index.ts`）；
    /// 老服务端省略这个键 ⇒ `nil`，而那正是"不得拿它的 `succeeded` 冒充回执"的判据。
    /// 可选 + 合成解码器的 `decodeIfPresent` 足以兼容老服务端，所以这里不需要显式 `init(from:)`。
    var factsAnalysisContractVersion: Int? = nil
    /// 直连车道的单批上界（观测阶段 1 起服务端随握手暴露；老服务端省略 ⇒ `nil`）。
    ///
    /// 唯一消费点 `DirectSyncBatchBudget.from(bounds:)`：`nil` 时回落保守常量。
    /// 客户端**不得**把它当"能力位"用（不是 `guard == 1` 那类门），它只是数值参数。
    var directSyncBounds: DirectSyncBounds? = nil
    /// 服务端覆盖探测能力（P1-1）：1 = 支持 `GET /v1/sync/coverage`。老服务端省略。
    var syncCoverageVersion: Int? = nil
}

/// 服务端 `/v1/handshake` 的 `directSyncBounds`（与 `packages/api-contracts/src/index.ts`
/// 的 `HandshakeResponse.directSyncBounds` 逐字段对应）。
nonisolated struct DirectSyncBounds: Codable, Equatable, Sendable {
    let maxXmlBytes: Int
    let maxRecords: Int
    let maxRouteFiles: Int
    let maxRouteBytes: Int
}

struct RaiAPIError: Codable {
    let code: String?
    let message: String?
    let currentRevision: Int?
}

// Explicit v1 coach-loop consumer. Never maps S onto the legacy weekly cap or
// invents a fitness programme for the unlimited daily-adaptive mode.
struct CoachLoopReceiptContext: Codable, Equatable {
    let contractVersion: Int
    let policyHash: String
    let decisionRef: String?
}

struct CoachLoopPreferences: Codable, Equatable {
    var mode: String
    var runningDays: [Int]
    var longRunDays: [Int]
    var availabilityMinutesByWeekday: [String: Int?]
    var targetType: String
    var race: MobileRunCoachConfig?

    enum CodingKeys: String, CodingKey {
        case mode, runningDays, longRunDays, availabilityMinutesByWeekday, targetType, race
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(mode, forKey: .mode)
        try values.encode(runningDays, forKey: .runningDays)
        try values.encode(longRunDays, forKey: .longRunDays)
        try values.encode(availabilityMinutesByWeekday, forKey: .availabilityMinutesByWeekday)
        try values.encode(targetType, forKey: .targetType)
        try values.encode(race, forKey: .race) // null is part of the daily-mode contract
    }
}

struct CoachLoopSettings: Codable {
    let mode: String
    let status: String
    let runningDays: [Int]
    let longRunDays: [Int]
    let availabilityMinutesByWeekday: [String: Int?]
    let targetType: String
    let race: MobileRunCoachConfig?

    var preferences: CoachLoopPreferences {
        .init(mode: mode, runningDays: runningDays, longRunDays: longRunDays,
            availabilityMinutesByWeekday: availabilityMinutesByWeekday, targetType: targetType, race: race)
    }
}

struct CoachLoopCommand: Encodable {
    let contractVersion: Int
    let operationId: String
    let operationScope: PlanReceiptScope
    let expectedRevision: Int
    let expectedFactsHash: String
    let action: String
    var acceptedPolicyHash: String? = nil
    var settings: CoachLoopPreferences? = nil
}

struct CoachLoopReason: Codable {
    let code: String
    let policyVersion: String
    let affectedDates: [String]
}

struct CoachLoopFeedback: Codable, Identifiable {
    let id: String
    let revision: Int
    let localDate: String
    let phase: String
    let requestedAction: String?
    let observedAt: String
    let availableAt: String
    let validUntil: String
    let retractedAt: String?
}

struct CoachLoopFeedbackCommand: Codable {
    let operationId: String
    let operationScope: PlanReceiptScope
    let id: String
    let expectedRevision: Int
    let action: String
    let consent: Bool
    var fields: Fields? = nil

    struct Fields: Codable {
        let phase: String
        let observedAt: String
        var workoutId: String? = nil
        var fatigue: String? = nil
        var soreness: String? = nil
        var discomfort: String? = nil
        var requestedAction: String? = nil
        var interruptionReason: String? = nil
        var replacementReason: String? = nil
        var rpeOverrideRef: RPEOverrideRef? = nil
        // RPE remains the existing workout-override fact, not a second value.
        struct RPEOverrideRef: Codable { let workoutId: String; let revision: Int }
        enum CodingKeys: String, CodingKey {
            case phase, observedAt, workoutId, fatigue, soreness, discomfort, requestedAction
            case interruptionReason, replacementReason, rpeOverrideRef
        }
        func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(phase, forKey: .phase); try values.encode(observedAt, forKey: .observedAt)
            try values.encode(workoutId, forKey: .workoutId); try values.encode(fatigue, forKey: .fatigue)
            try values.encode(soreness, forKey: .soreness); try values.encode(discomfort, forKey: .discomfort)
            try values.encode(requestedAction, forKey: .requestedAction)
            try values.encode(interruptionReason, forKey: .interruptionReason)
            try values.encode(replacementReason, forKey: .replacementReason)
            try values.encode(rpeOverrideRef, forKey: .rpeOverrideRef)
        }
    }
}

struct CoachLoopFeedbackResult: Decodable {
    let feedback: CoachLoopFeedback?
    let saved: Bool
    let refreshRequired: Bool
}

struct CoachLoopPredictionResult: Decodable {
    let status: String
    let summaryId: String?
    let reason: String?
}

struct CoachLoopResponse: Codable {
    struct Day: Codable, Identifiable {
        let day: MobilePlannedDay
        let executable: Bool
        let decisionRef: String?
        var templateId: String? = nil
        var id: String { day.localDate }
    }
    struct Volume: Codable {
        struct Anchor: Codable {
            let id: String
            let revision: Int
            let factsHash: String
            let weekStart: String
            let historyThrough: String
        }
        struct Extension: Codable {
            let status: String
            let authorizedDecisionRef: String?
            let approvedSessionsInRolling7Days: Int
            let maximumSessionsInRolling7Days: Int
            let reasons: [CoachLoopReason]
        }
        let suggestedWeeklyKm: Double
        let weeklyProtectionKm: Double
        let actualWeekKm: Double
        let suggestedRemainingKm: Double
        let actualOverSuggestionKm: Double
        let anchor: Anchor
        let `extension`: Extension
    }
    struct Execution: Codable, Identifiable {
        struct Dose: Codable { let status: String }
        struct Stimulus: Codable { let status: String }
        let localDate: String
        let observation: String
        let completion: String
        let dose: Dose
        let stimulus: Stimulus
        let reasons: [CoachLoopReason]
        var id: String { localDate }
    }
    struct ExecutionSummary: Codable {
        let qualityObserved: Int
        let qualityConfirmed: Int
        let qualityKnownNotMet: Int
        let qualityUnconfirmed: Int
    }
    struct ExecutionPolicy: Codable {
        struct Protection: Codable { let code: String; let active: Bool }
        let localDate: String
        let phase: String?
        let protections: [Protection]
    }
    struct GoalGap: Codable {
        let status: String
        let targetSeconds: Double?
        let referenceSeconds: Double?
        let gapSeconds: Double?
        let calibrationStatus: String?
    }
    let contractVersion: Int
    let scope: PlanReceiptScope
    let timezone: String
    let executionToken: String
    let policyHash: String
    let revision: Int
    let factsHash: String
    let asOf: String
    let settings: CoachLoopSettings?
    let volumePolicy: Volume
    let refreshRequired: Bool
    let today: Day
    let days: [Day]
    let subjectiveFeedback: [CoachLoopFeedback]
    let execution: [Execution]
    let executionSummary: ExecutionSummary
    let executionPolicy: ExecutionPolicy
    let goalGap: GoalGap?
    let goals: MobileGoalsResponse
    let reasons: [CoachLoopReason]

    var receiptContext: CoachLoopReceiptContext {
        .init(contractVersion: 1, policyHash: policyHash, decisionRef: today.decisionRef)
    }

    /// Only today's published course can be exported. The future is an outlook,
    /// never seven days of device authorization copied from today's readiness.
    var devicePlan: MobileWorkoutPlanResponse {
        let source = today.day
        let day = MobileWorkoutPlanDay(localDate: source.localDate, kind: source.kind,
            title: today.templateId ?? days.first?.templateId ?? source.kind, reason: source.reason ?? "",
            distanceKm: source.distanceKm, durationMinutes: nil, paceSecondsPerKmLower: nil,
            paceSecondsPerKmUpper: nil, heartRateBpmLower: nil, heartRateBpmUpper: nil,
            structure: source.structure, source: "coach_loop", executable: today.executable && !refreshRequired)
        return .init(generatedAt: asOf, timezone: timezone, windowDays: 1, planRevision: revision,
            audit: goals.weekPlanAudit, days: [day], windowStart: source.localDate, windowEnd: source.localDate)
    }
}

struct WorkoutListItem: Codable, Identifiable, Equatable {
    let id: String
    let startedAt: String
    let endedAt: String
    let durationSeconds: Double
    let distanceKm: Double?
    let averagePaceSecondsPerKm: Double?
    let averageHeartRateBpm: Double?
    let indoor: Bool?
    let sourceCategory: String
    let sessionType: String
    let stimulusType: String
    let stimulusConfidence: Double?
    let eligibilityStatus: String
    let assessmentStatus: String?
    let missingReasons: [String]
    let qualityScore: Double
    let currentAbility: Double?
    let confidence: Double?
    let trueAbilityDelta: Double?
    let hasRoute: Bool
    /// P0-1：事实已提交但分析未发布时为 `pending`；老服务端省略 ⇒ nil（按已发布处理）。
    /// 派生字段在 pending 时可能为 null/占位，消费方必须看本字段而不是猜。
    /// A6：`pending` 也可能是"旧分析可用、新分析未发布"（此时数值是旧分析的），由
    /// `analysisAvailable` 区分。
    var analysisPublishStatus: String? = nil
    /// A6（P2-3，2026-10-19）：旧分析是否仍可读；老服务端省略 ⇒ nil（按"不可读"保守处理）。
    var analysisAvailable: Bool? = nil
}

struct AbilityMetricSet: Codable, Equatable {
    let efficiency: Double?
    let pace: Double?
    let cardio: Double?
    let stability: Double?
    let recovery: Double?
}

struct MobileAbilityCard: Codable {
    let trueAbility: Double?
    let currentAbility: Double?
    let changeFrom7DaysAgo: Double?
    let growthVelocityPerWeek: Double?
    let decayPoints: Double
    let snapshotDate: String?
    let explanation: String
}

struct MobileCalibrationCard: Codable {
    let status: String
    let eligibleSessions: Int
    let eligibleDurationMinutes: Double
    let spanDays: Int
    let highCoverageSessions: Int
    let requirements: CalibrationRequirements
    let message: String
}

struct CalibrationRequirements: Codable {
    let sessions: Int
    let durationMinutes: Int
    let spanDays: Int
    let highCoverageSessions: Int
}

struct MobileTrigger: Codable {
    let code: String
    let value: Double?
    let threshold: Double?
    let detail: String
}

struct MobileVerdict: Codable {
    let tone: String
    let title: String
    let reason: String
    let triggers: [MobileTrigger]
    let stale: Bool
    let reasonCodes: [String]?
}

/// Step goal, mirroring WorkoutKit's goal model so the bridge stays a pure
/// translation. `open` means "no target" and is not treated as a usable
/// prescription by the mapper.
enum MobileStepGoal: Codable, Equatable {
    case distance(meters: Double)
    case time(seconds: Double)
    case open

    private enum CodingKeys: String, CodingKey { case type, meters, seconds }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "distance":
            self = .distance(meters: try container.decode(Double.self, forKey: .meters))
        case "time":
            self = .time(seconds: try container.decode(Double.self, forKey: .seconds))
        case "open":
            self = .open
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown executable workout goal")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .distance(meters):
            try container.encode("distance", forKey: .type)
            try container.encode(meters, forKey: .meters)
        case let .time(seconds):
            try container.encode("time", forKey: .type)
            try container.encode(seconds, forKey: .seconds)
        case .open:
            try container.encode("open", forKey: .type)
        }
    }
}

/// At most one alert per step — the same limit WorkoutKit enforces.
struct MobileStepAlert: Codable, Equatable {
    let kind: String
    let lower: Double?
    let upper: Double?

    var isUsable: Bool { lower != nil || upper != nil }
}

struct MobileWorkoutStep: Codable, Equatable {
    let purpose: String
    let goal: MobileStepGoal
    let alert: MobileStepAlert?
}

struct MobileIntervalBlock: Codable, Equatable {
    let iterations: Int
    let steps: [MobileWorkoutStep]
}

struct MobileSessionStructure: Codable, Equatable {
    let warmup: MobileWorkoutStep?
    let blocks: [MobileIntervalBlock]
    let cooldown: MobileWorkoutStep?
}

/// Plan provenance, including legacy model plans retained for historical decoding.
struct MobilePlanAudit: Codable, Equatable {
    let generatedBy: String
    let model: String?
    let promptVersion: String?
    let generatedAt: String?
}

struct MobileNextSession: Codable {
    let kind: String
    let title: String
    let reason: String
    let distanceKm: Double?
    let durationMinutes: Double?
    let paceSecondsPerKmLower: Double?
    let paceSecondsPerKmUpper: Double?
    let heartRateBpmLower: Double?
    let heartRateBpmUpper: Double?
    /// Interval/step breakdown. Optional so an older server that predates the
    /// field still decodes.
    let structure: MobileSessionStructure?
}

/// §9.6 load-proxy recovery estimate: hours until a quality session is supported.
///
/// `isLoadProxy` is decoded rather than assumed so an older server that one day
/// sends something else cannot be presented as a measurement. `basisCodes` are
/// rendered through `nativeRecoveryBasis`, never as raw codes.
struct RecoveryTimeEstimate: Codable {
    let policyVersion: String
    let status: String
    let remainingHours: Double?
    let readyAt: String?
    let anchor: RecoveryTimeAnchor?
    let basisCodes: [String]
    let isLoadProxy: Bool
    let confidence: Double?

    /// A finished session is not a supportable anchor.
    var isAvailable: Bool { status == "available" && remainingHours != nil }
}

struct RecoveryTimeAnchor: Codable {
    let trainingSessionId: String
    let localDate: String
    let endedAt: String
    let load: Double
    let sessionType: String
}

struct MobileRecoveryBreakdown: Codable {
    let score: Double?
    let lastNightSleepMinutes: Double?
    let sleepBaselineMinutes: Double?
    let morningHrvMs: Double?
    let hrvBaselineMs: Double?
    let restingHeartRateBpm: Double?
    let restingHeartRateBaselineBpm: Double?
    let state: String?
    let hrvSampleCount: Int?
    let note: String

    var stateLabel: String {
        switch state {
        case "recovered", "recovered_phys": return "恢复良好"
        case "reduced": return "恢复不足"
        case "depleted": return "需要休息"
        case .some: return "未识别状态"
        default:
            let hasSamples = lastNightSleepMinutes != nil || morningHrvMs != nil || restingHeartRateBpm != nil
            return hasSamples ? "基线不足" : "暂无数据"
        }
    }

}

struct MobilePostRunVerdict: Codable {
    let workoutId: String
    let startedAt: String
    let sessionType: String
    let stimulusType: String
    let stimulusMatch: String
    let indoor: Bool?
    let updatedTrueAbility: Bool
    let trueAbilityDelta: Double?
    let currentAbility: Double?
    let trueAbilityAfter: Double?
    let headline: String
    let details: [String]
}

struct MobileWeekStructure: Codable {
    let easyDurationFraction: Double?
    let easyDurationFloorFraction: Double
    let qualitySessionCount: Int
    let qualitySessionCap: Int
    let easyHonesty: EasyHonesty
}

struct EasyHonesty: Codable {
    let intendedEasyCount: Int
    let easyEnoughCount: Int
    let honestyFraction: Double?
    let note: String
}

struct MobileRaceTarget: Codable, Equatable {
    let date: String
    let distance: String
    let targetPaceSecondsPerKm: Double?
}

struct MobileRaceCard: Codable {
    let target: MobileRaceTarget?
    let daysUntil: Int?
    let taper: Bool
    let shapeScore: Double?
    let volumeFraction: Double?
    let longRunFraction: Double?
    let note: String
}

struct MobileInjuryFlag: Codable, Identifiable {
    let code: String
    let title: String
    let detail: String

    var id: String { code }
}

struct MobileWeekPlanDay: Codable, Identifiable {
    let localDate: String
    let kind: String
    let title: String
    let planned: Bool
    let completedWorkoutId: String?
    let distanceKm: Double
    let workoutCount: Int
    let structure: MobileSessionStructure?

    var id: String { localDate }
}

struct MobileLockedSession: Codable {
    let localDate: String
    let session: MobileNextSession
    let verdictTone: String
    let lockedAt: String
}

struct MobileLockState: Codable {
    var candidate: MobileNextSession? = nil
    let present: Bool
    let relockSuggested: Bool
    let lockedAt: String?
}

/// 服务端刷新的结果。与训练/恢复日期无关：一次导入没有带来任何新记录仍然是 `ok`，
/// 也不会因为当晚没戴表而变成"过期"。
struct MobileSyncStatus: Codable {
    let status: String
    let lastAttemptAt: String?
    let lastSuccessAt: String?
    let error: String?
}

/// 某个指标在目标日期上有没有记录。`historical` 是真实存在但属于更早一天的数据：
/// 可以当参考展示，绝不是今天的读数。
struct MobileCoverageMetric: Codable {
    let state: String
    let latestDate: String?
}

/// 逐指标的记录覆盖。`latestHealthSampleAt` 是"数据流走到哪了"，与"该测的测了没"分开。
struct MobileCoverage: Codable {
    let latestTrainingDate: String?
    let latestHealthSampleAt: String?
    let sleep: MobileCoverageMetric
    let hrv: MobileCoverageMetric
    let restingHeartRate: MobileCoverageMetric
}

/// 今天的恢复证据支持什么。`coverage` 说"能不能评"，`assessment` 说"评出来是什么"：
/// 覆盖不足是缺测，不是差评。
struct MobileRecoveryAssessment: Codable {
    let targetDate: String?
    let coverage: String
    let assessment: String
    let reasonCodes: [String]
    let lastObservationDate: String?
}

/// 今天这条建议是怎么来的。`recoveryAdjustment` 区分"没查"与"查了并否决"——
/// 两者都不是对跑者的批准。
struct MobileRecommendation: Codable {
    var planRevision: Int? = nil
    var plannedKind: String? = nil
    var effectiveKind: String? = nil
    var adjustmentReason: String? = nil
    let basis: String
    let recoveryAdjustment: String
    let uncertaintyReasons: [String]
    let reasonCodes: [String]
}

struct MobileTodayResponse: Codable {
    var recentPlanExecution: [MobilePlanExecutionDay]? = nil
    let generatedAt: String
    let timezone: String
    let latestDataDate: String?
    let lastSyncedAt: String?
    let sync: MobileSyncStatus
    let coverage: MobileCoverage
    let recoveryAssessment: MobileRecoveryAssessment
    let recommendation: MobileRecommendation
    /// 契约里已标 `@deprecated`。客户端不再用它表达任何时效性判断：它曾经用
    /// "有没有今晚的夜"回答"数据新不新"，于是普通的缺测被显示成"数据过期"。
    /// 仍保留解码，是为了让尚未更新的旧版本还能读完整份载荷。
    let freshness: Freshness
    let recommendationRevision: String
    let today: TodaySummary
    let week: WeekSummary
    let weekDaily: [WeekDailyPoint]
    let recentWorkouts: [WorkoutListItem]
    let ability: MobileAbilityCard
    let calibration: MobileCalibrationCard
    let verdict: MobileVerdict
    let nextSession: MobileNextSession
    let recovery: MobileRecoveryBreakdown
    /// §20 race-driven skeleton, adherence and re-plan advice. Optional so an older
    /// server keeps decoding; the section is then hidden.
    let periodization: MobilePeriodization?
    let adherence: MobilePlanAdherence?
    let replan: MobileReplanAdvice?
    /// §9.6 load-proxy recovery estimate. Optional so a build that talks to an
    /// older server keeps decoding the whole payload; the card is then hidden.
    /// Deliberately separate from `recovery` above: that one reports *measured*
    /// evidence, this one extrapolates from load.
    let recoveryTime: RecoveryTimeEstimate?
    let postRun: MobilePostRunVerdict?
    let weekStructure: MobileWeekStructure
    let race: MobileRaceCard
    let injuryFlags: [MobileInjuryFlag]
    let weekPlan: [MobileWeekPlanDay]
    let phase: String
    let lock: MobileLockState
}

extension MobileTodayResponse {
    /// 显式解码（2026-10-15 审查 🟡-B1）：四个核心子卡的**版本偏斜降级层**。
    ///
    /// 合成解码器对四个非可选字段（`sync` / `coverage` / `recoveryAssessment` /
    /// `recommendation`）缺键即 `keyNotFound` ⇒ 整份 today 丢弃、"今日"面板整体回退缓存。
    /// 主纪律仍是"服务端与 iOS 同批进退"（本仓服务端恒发这四键）；这里只把"缺键"从
    /// "整页失败"降为**诚实的空态**（未知 / 未评估），与 `periodization` 等可选字段的
    /// "缺就隐藏"策略一致。
    ///
    /// ⚠️ 本 init 取代合成解码：**新增字段必须同时加到声明与这里**，否则会静默不被解码
    /// （合成解码已不存在，漏一处没有任何编译错误）。
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func tolerant<T: Decodable>(_ type: T.Type, forKey key: CodingKeys, fallback: T) throws -> T {
            if let value = try container.decodeIfPresent(type, forKey: key) { return value }
            return fallback
        }
        recentPlanExecution = try container.decodeIfPresent([MobilePlanExecutionDay].self, forKey: .recentPlanExecution)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        timezone = try container.decode(String.self, forKey: .timezone)
        latestDataDate = try container.decodeIfPresent(String.self, forKey: .latestDataDate)
        lastSyncedAt = try container.decodeIfPresent(String.self, forKey: .lastSyncedAt)
        sync = try tolerant(MobileSyncStatus.self, forKey: .sync,
            fallback: MobileSyncStatus(status: "never", lastAttemptAt: nil, lastSuccessAt: nil, error: nil))
        coverage = try tolerant(MobileCoverage.self, forKey: .coverage,
            fallback: MobileCoverage(latestTrainingDate: nil, latestHealthSampleAt: nil,
                sleep: MobileCoverageMetric(state: "none", latestDate: nil),
                hrv: MobileCoverageMetric(state: "none", latestDate: nil),
                restingHeartRate: MobileCoverageMetric(state: "none", latestDate: nil)))
        recoveryAssessment = try tolerant(MobileRecoveryAssessment.self, forKey: .recoveryAssessment,
            fallback: MobileRecoveryAssessment(targetDate: nil, coverage: "none", assessment: "not_assessed",
                reasonCodes: [], lastObservationDate: nil))
        recommendation = try tolerant(MobileRecommendation.self, forKey: .recommendation,
            fallback: MobileRecommendation(basis: "insufficient_training_history", recoveryAdjustment: "no_evidence",
                uncertaintyReasons: [], reasonCodes: []))
        freshness = try container.decode(Freshness.self, forKey: .freshness)
        recommendationRevision = try container.decode(String.self, forKey: .recommendationRevision)
        today = try container.decode(TodaySummary.self, forKey: .today)
        week = try container.decode(WeekSummary.self, forKey: .week)
        weekDaily = try container.decode([WeekDailyPoint].self, forKey: .weekDaily)
        recentWorkouts = try container.decode([WorkoutListItem].self, forKey: .recentWorkouts)
        ability = try container.decode(MobileAbilityCard.self, forKey: .ability)
        calibration = try container.decode(MobileCalibrationCard.self, forKey: .calibration)
        verdict = try container.decode(MobileVerdict.self, forKey: .verdict)
        nextSession = try container.decode(MobileNextSession.self, forKey: .nextSession)
        recovery = try container.decode(MobileRecoveryBreakdown.self, forKey: .recovery)
        periodization = try container.decodeIfPresent(MobilePeriodization.self, forKey: .periodization)
        adherence = try container.decodeIfPresent(MobilePlanAdherence.self, forKey: .adherence)
        replan = try container.decodeIfPresent(MobileReplanAdvice.self, forKey: .replan)
        recoveryTime = try container.decodeIfPresent(RecoveryTimeEstimate.self, forKey: .recoveryTime)
        postRun = try container.decodeIfPresent(MobilePostRunVerdict.self, forKey: .postRun)
        weekStructure = try container.decode(MobileWeekStructure.self, forKey: .weekStructure)
        race = try container.decode(MobileRaceCard.self, forKey: .race)
        injuryFlags = try container.decode([MobileInjuryFlag].self, forKey: .injuryFlags)
        weekPlan = try container.decode([MobileWeekPlanDay].self, forKey: .weekPlan)
        phase = try container.decode(String.self, forKey: .phase)
        lock = try container.decode(MobileLockState.self, forKey: .lock)
    }
}

// The body metrics page reuses existing physiology, zone and training
// statistics endpoints. These model only fields rendered by the native page.
struct NativePredictionResponse: Codable {
    let reportVersion: String?
    let generatedAt: String?
    let inputs: NativePredictionInputs
    let modelSelection: NativePredictionModelSelection?
    let guidanceCodes: [String]?
    let snapshot: NativePredictionSnapshot
    let explainability: NativePredictionExplainability?
}

struct NativePredictionInputs: Codable {
    let recoveryReadiness: Double?
    let directVo2Evidence: Int?
    let labeledPerformanceEvidence: Int?
    let lactateThresholdSegments: Int?
    let performanceVdotEvidence: Int?
    let labeledRaceOutcomes: Int?
    let readiness: [String: Double?]?
}

struct NativePredictionSnapshot: Codable {
    let schemaVersion: String?
    let modelVersion: String?
    let generatedAt: String?
    let dataThroughAt: String?
    let vo2Max: NativeVo2MaxEstimate
    let performanceVdot: NativeVdotEstimate
    let lactateThreshold: NativeLactateThresholdEstimate
    let races: [NativeRacePrediction]
    let disclaimer: String?
}

struct NativeVo2MaxEstimate: Codable {
    let status: String
    let valueMlKgMin: Double?
    let confidence: Double
}

struct NativeVdotEstimate: Codable {
    let status: String
    let value: Double?
    let confidence: Double
}

struct NativeLactateThresholdEstimate: Codable {
    let status: String
    let paceSecondsPerKm: Double?
    let heartRateBpm: Double?
    let confidence: Double
}

struct NativeRacePrediction: Codable, Identifiable {
    let distance: String
    let predictedSeconds: Double?
    let optimisticSeconds: Double?
    let pessimisticSeconds: Double?
    let potentialSeconds: Double?
    let readinessAdjustmentSeconds: Double?
    let environmentAdjustmentSeconds: Double?
    let elevationAdjustmentSeconds: Double?
    let fatigueAdjustmentSeconds: Double?
    let readiness: Double?
    let confidence: Double
    let confidenceLevel: String?
    let method: String?
    let evidenceCodes: [String]?

    var id: String { distance }
}

struct NativePredictionModelSelection: Codable {
    let biasCalibration: NativePredictionBiasCalibration?
    let machineLearning: NativePredictionMachineLearning?
}

struct NativePredictionBiasCalibration: Codable {
    let status: String?
    let historicalOutcomeCount: Int?
    let eligibleOutcomeCountByDistance: [String: Int]?
    let appliedDistances: [String]?
}

struct NativePredictionMachineLearning: Codable {
    let status: String?
    let modelVersion: String?
    let trainedExampleCount: Int?
    let evaluatedOutcomeCount: Int?
    let meanAbsoluteErrorImprovement: Double?
    let activeModelRunId: String?
    let activeModelVersion: String?
    let featureSchemaVersion: String?
    let artifactSha256: String?
    let activatedAt: String?
}

struct NativePredictionExplainability: Codable {
    let schemaVersion: String?
    let recovery: NativeRecoveryExplainability?
    let readiness: [String: NativeReadinessExplainability]?
}

struct NativeRecoveryExplainability: Codable {
    let readiness: Double?
    let status: String?
    let source: String?
    let asOf: String?
    let latestObservedAt: String?
    let coverage: String?
}

struct NativeReadinessExplainability: Codable {
    let value: Double?
    let status: String?
    let evidenceCount: Int?
    let dataThroughAt: String?
}

enum PredictionLoadState: Equatable {
    case current(generatedAt: String?, dataThroughAt: String?)
    case stale(lastSuccessAt: Date?, message: String)
    case unavailable(message: String)
}

enum NativeRecoveryState: Equatable {
    case recovered
    case reduced
    case depleted
    case unknown(raw: String?)
}

struct NativeDashboardResponse: Codable {
    let latestWorkout: WorkoutListItem?
    /// 最近一次纳入分析的训练的五维得分。旧缓存里没有这个键时为 nil，
    /// 页面按缺失处理，不补零。
    let dimensions: AbilityMetricSet?
}

struct NativeTrainingZonesCurrentResponse: Codable {
    let profile: NativeZoneProfile
}

struct NativeZoneProfile: Codable {
    let restingHeartRateBpm: Double
    let maximumHeartRateBpm: Double
    let lactateThresholdPaceSecondsPerKm: Double?
    let heartRateBands: [NativeHeartRateBand]
    let paceBands: [NativePaceBand]
}

struct NativeHeartRateBand: Codable, Identifiable {
    let zone: String
    let lowerBpm: Double?
    let upperBpm: Double?

    var id: String { zone }
}

struct NativePaceBand: Codable, Identifiable {
    let zone: String
    let lowerSecondsPerKm: Double?
    let upperSecondsPerKm: Double?

    var id: String { zone }
}

struct NativeTrainingStatisticsOverviewResponse: Codable {
    let status: NativeDailyTrainingMetric?
    let statusConfidence: Double?
    let week: NativeTrainingPeriodSummary?
    let month: NativeTrainingPeriodSummary?
    let year: NativeTrainingPeriodSummary?
    let rolling7Days: NativeTrainingPeriodSummary?
    let rolling28Days: NativeTrainingPeriodSummary?
}

struct NativeDailyTrainingMetric: Codable {
    let trainingStatus: String
    let recoveryEvidence: Double?
}

struct NativeTrainingPeriodSummary: Codable {
    let distanceMeters: Double?
    let durationSeconds: Double?
    let workoutCount: Int?
    let averagePaceSecondsPerKm: Double?
}

struct Freshness: Codable {
    let state: String
    let checkedAt: String?
    let latestTrainingDate: String?
    let recoveryDate: String?
}

struct TodaySummary: Codable {
    let localDate: String
    let distanceKm: Double
    let durationSeconds: Double
    let paceSecondsPerKm: Double?
    let energyKcal: Double?
    let workoutCount: Int
}

struct WeekSummary: Codable {
    let periodStart: String
    let periodEnd: String
    let distanceKm: Double
    let durationSeconds: Double
    let workoutCount: Int
    let averageSpeedKmPerHour: Double?
    let averagePaceSecondsPerKm: Double?
    let averageHeartRateBpm: Double?
    let heartRateZones: [HeartRateZoneSummary]?
    let paceZones: [HeartRateZoneSummary]?

    /// nil arrays mean an older API/cache, while [] means a successful empty aggregation.
    var hasWeeklyActivityStatistics: Bool {
        heartRateZones != nil && paceZones != nil
    }
}

struct WeekDailyPoint: Codable, Identifiable {
    let localDate: String
    let distanceKm: Double
    let workoutCount: Int

    var id: String { localDate }
}

struct MobileStatisticsResponse: Codable {
    let generatedAt: String
    let timezone: String
    let months: [MonthSummary]
    let totals: StatisticsTotals
    let heartRateZones: [HeartRateZoneSummary]
}

struct MonthSummary: Codable, Identifiable {
    let month: String
    let runningDistanceKm: Double
    let cyclingDistanceKm: Double
    let otherDistanceKm: Double
    let totalDistanceKm: Double
    let durationSeconds: Double
    let workoutCount: Int

    var id: String { month }
}

struct StatisticsTotals: Codable {
    let distanceKm: Double
    let durationSeconds: Double
    let workoutCount: Int
    let averagePaceSecondsPerKm: Double?
    let distanceChangeFraction: Double?
}

struct HeartRateZoneSummary: Codable, Identifiable {
    let zone: String
    let durationSeconds: Double
    let fraction: Double

    var id: String { zone }
}

struct MobileTrendsResponse: Codable {
    let generatedAt: String
    let timezone: String
    let weeks: [WeekTrend]
    let distanceChangeFraction4Weeks: Double?
    let records: PersonalRecords
    let insights: [MobileInsight]
    let ability: [AbilityTrendPoint]
    let currentAbility: [CurrentAbilityPoint]
    let growthVelocityPerWeek: Double?
    let decayPoints: Double
}

struct WeekTrend: Codable, Identifiable {
    let periodStart: String
    let periodEnd: String
    let distanceKm: Double
    let workoutCount: Int
    let isComplete: Bool

    var id: String { periodStart }
}

struct PersonalRecords: Codable {
    let fastest5k: FastestRecord?
    let fastest10k: FastestRecord?
    let longestDistance: LongestRecord?
    let biggestMonth: BiggestMonthRecord?
}

struct FastestRecord: Codable {
    let distanceKm: Double
    let paceSecondsPerKm: Double
    let startedAt: String
}

struct LongestRecord: Codable {
    let distanceKm: Double
    let startedAt: String
}

struct BiggestMonthRecord: Codable {
    let month: String
    let distanceKm: Double
}

struct MobileInsight: Codable, Identifiable {
    let kind: String
    let title: String
    let detail: String

    var id: String { "\(kind)-\(title)" }
}

struct AbilityTrendPoint: Codable, Identifiable {
    let date: String
    let trueAbility: Double?
    let decayPoints: Double
    let growthVelocityPerWeek: Double?
    let status: String

    var id: String { date }
}

struct CurrentAbilityPoint: Codable, Identifiable {
    let id: String
    let date: String
    let currentAbility: Double?
    let confidence: Double?
    let assessmentStatus: String
    let distanceKm: Double?
}

struct MobileGoalsResponse: Codable {
    let revision: Int
    let easyDurationFloorFraction: Double
    let qualitySessionCap: Int
    let raceTarget: MobileRaceTarget?
    let weekPlan: [MobileGoalsPlanItem]
    let lockedSession: MobileLockedSession?
    let weekPlanAudit: MobilePlanAudit?
    let weekPlanReplanRequired: Bool?
    var runCoach: MobileRunCoachPlan? = nil
    let updatedAt: String
}

struct MobileRunCoachConfig: Codable, Equatable {
    var goal: String
    var raceDate: String?
    var raceDistanceKm: Double?
    var targetTimeSeconds: Double?
    var runningDays: [Int]
    var longRunDays: [Int]
    var targetType: String
    var strengthTraining: Bool
    var durationWeeks: Int? = nil

    enum CodingKeys: String, CodingKey {
        case goal, raceDate, raceDistanceKm, targetTimeSeconds, runningDays, longRunDays
        case targetType, strengthTraining, durationWeeks
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(goal, forKey: .goal)
        try values.encode(raceDate, forKey: .raceDate)
        try values.encode(raceDistanceKm, forKey: .raceDistanceKm)
        try values.encode(targetTimeSeconds, forKey: .targetTimeSeconds)
        try values.encode(runningDays, forKey: .runningDays)
        try values.encode(longRunDays, forKey: .longRunDays)
        try values.encode(targetType, forKey: .targetType)
        try values.encode(strengthTraining, forKey: .strengthTraining)
        try values.encodeIfPresent(durationWeeks, forKey: .durationWeeks)
    }
}

struct MobileRunCoachPlan: Codable, Equatable {
    let id: String
    let startedOn: String
    let status: String
    let pausedOn: String?
    let endedOn: String?
    let adaptationKey: String?
    let adaptedAt: String?
    let goal: String
    let raceDate: String?
    let raceDistanceKm: Double?
    let targetTimeSeconds: Double?
    let runningDays: [Int]
    let longRunDays: [Int]
    let targetType: String
    let strengthTraining: Bool
    var durationWeeks: Int? = nil

    var config: MobileRunCoachConfig {
        MobileRunCoachConfig(goal: goal, raceDate: raceDate, raceDistanceKm: raceDistanceKm,
            targetTimeSeconds: targetTimeSeconds, runningDays: runningDays, longRunDays: longRunDays,
            targetType: targetType, strengthTraining: strengthTraining, durationWeeks: durationWeeks)
    }
}

struct MobileRunCoachCommand: Codable {
    let expectedRevision: Int
    let action: String
    let config: MobileRunCoachConfig?
    var operationId: String? = nil
    var operationScope: PlanReceiptScope? = nil
}

struct MobileRunCoachResponse: Codable {
    let revision: Int
    let plan: MobileRunCoachPlan?
    let phase: String?
    let daysToRace: Int?
    let elapsedWeeks: Int
    /// This week's *spendable* budget, km — the number the week was actually generated from.
    let weeklyCapacityKm: Double
    let notices: [String]
    let phases: [Phase]?
    let strength: [StrengthSession]
    /// Selected running weekdays inside the programme that carry no session, with a code and
    /// the observable counts behind it. Optional so a payload cached before this field existed
    /// still decodes.
    let unplannedDays: [UnplannedDay]?
    /// Prep readiness for the race distance. Nil when there is no race programme at all.
    let confidence: Confidence?

    struct Confidence: Codable, Equatable {
        let status: String
        /// 0–100. Nil — never `0` — whenever `status` is not `available`; `0` would read as the
        /// assertion "preparedness is zero".
        let value: Double?
        let band: String?
        let basis: String?
        let components: Components?
        let evidenceLevel: String?
        let reasonCodes: [String]
        let note: String
    }
    struct Components: Codable, Equatable {
        let volume: Double
        let longRun: Double
        let frequency: Double
        let exposure: Double
        let recency: Double
    }
    struct UnplannedDay: Codable, Identifiable {
        let localDate: String
        let code: String
        let detail: String
        var id: String { localDate }
    }
    struct StrengthSession: Codable, Identifiable {
        let localDate: String
        let durationMinutes: Int
        let exercises: [Exercise]
        var id: String { localDate }
    }
    struct Phase: Codable, Identifiable {
        let phase: String
        let startsOn: String
        let endsOn: String
        let current: Bool
        var id: String { startsOn }
    }
    struct Exercise: Codable {
        let name: String
        let dose: String
    }
}

/// A persisted planned day. `structure` and `reason` are carried through
/// unchanged on save so editing training settings cannot silently downgrade a
/// generated prescription.
struct MobileGoalsPlanItem: Codable, Identifiable {
    let localDate: String
    var kind: String
    var distanceKm: Double?
    var structure: MobileSessionStructure?
    var reason: String?

    var id: String { localDate }
}

struct UpdateMobileGoalsRequest: Encodable {
    let expectedRevision: Int?
    let easyDurationFloorFraction: Double?
    let qualitySessionCap: Int?
    let raceTarget: MobileRaceTarget?
    let weekPlan: [MobileGoalsPlanItem]?
    var operationId: String? = nil
    var operationScope: PlanReceiptScope? = nil

    enum CodingKeys: String, CodingKey {
        case expectedRevision, easyDurationFloorFraction, qualitySessionCap
        case raceTarget, weekPlan, operationId, operationScope
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(expectedRevision, forKey: .expectedRevision)
        try container.encodeIfPresent(easyDurationFloorFraction, forKey: .easyDurationFloorFraction)
        try container.encodeIfPresent(qualitySessionCap, forKey: .qualitySessionCap)
        // Explicit null clears the persisted race; omission would preserve it.
        try container.encode(raceTarget, forKey: .raceTarget)
        try container.encodeIfPresent(weekPlan, forKey: .weekPlan)
        try container.encodeIfPresent(operationId, forKey: .operationId)
        try container.encodeIfPresent(operationScope, forKey: .operationScope)
    }
}

/// One day of the executable week handed to the WorkoutKit bridge.
struct MobileWorkoutPlanDay: Codable, Identifiable, Equatable {
    let localDate: String
    let kind: String
    let title: String
    let reason: String
    let distanceKm: Double?
    let durationMinutes: Double?
    let paceSecondsPerKmLower: Double?
    let paceSecondsPerKmUpper: Double?
    let heartRateBpmLower: Double?
    let heartRateBpmUpper: Double?
    let structure: MobileSessionStructure?
    let source: String
    /// False for rest days and for days whose prescription could not be built.
    let executable: Bool

    var id: String { localDate }
}

struct MobileWorkoutPlanResponse: Codable, Equatable {
    let generatedAt: String
    let timezone: String
    let windowDays: Int
    let planRevision: Int
    let audit: MobilePlanAudit?
    let days: [MobileWorkoutPlanDay]
    var windowStart: String? = nil
    var windowEnd: String? = nil
}

struct TrainingPlanStateResponse: Codable {
    struct Metadata: Codable, Equatable {
        let contractVersion: Int
        let serverId: String
        let athleteId: String
        let datasetEpoch: String
        let goalsRevision: Int
        let coherenceToken: String
        let timezone: String
        let localDate: String
        let windowStart: String
        let windowEnd: String
        let ruleVersion: String
        let publicationDigest: String
    }
    let metadata: Metadata
    let availability: String
    let goals: MobileGoalsResponse
    let today: MobileTodayResponse
    let workoutPlan: MobileWorkoutPlanResponse
    let coachSummary: MobileRunCoachResponse
}

/// A locally verified system-schedule receipt, NOT physical Watch delivery.
/// `structure` describes the actual export; UUID/time/idempotency metadata is
/// additive and is sent only when the server advertises the capability.
struct PlanSyncReceipt: Codable, Equatable {
    let localDate: String
    let kind: String
    let revision: Int
    let structure: MobileSessionStructure?
    var workoutID: String? = nil
    var scheduledAt: String? = nil
    var idempotencyKey: String? = nil
    var exportNotes: [String]? = nil
    var contractVersion: Int? = nil
    var scope: PlanReceiptScope? = nil
    var operationId: String? = nil
    var coherenceToken: String? = nil
    var verifiedAt: String? = nil
    var timezone: String? = nil
    var prescriptionDigest: String? = nil
    var lifecycleEvent: String? = nil
    var coachLoop: CoachLoopReceiptContext? = nil

    var hasRequiredVerificationFields: Bool {
        guard contractVersion == 2 else { return contractVersion == nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        func instant(_ value: String?) -> Date? {
            guard let value else { return nil }
            return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        }
        guard let scope, !scope.serverId.isEmpty, !scope.athleteId.isEmpty, !scope.datasetEpoch.isEmpty,
              let operationId, UUID(uuidString: operationId) != nil, let workoutID, UUID(uuidString: workoutID) != nil,
              instant(scheduledAt) != nil, instant(verifiedAt) != nil, timezone == "Asia/Shanghai", structure != nil,
              let coherenceToken, coherenceToken.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let prescriptionDigest, prescriptionDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let lifecycleEvent, ["verified", "withdrawn", "replaced"].contains(lifecycleEvent) else { return false }
        return true
    }

    mutating func useLegacyContract(metadata: Bool) {
        contractVersion = nil; scope = nil; operationId = nil; coherenceToken = nil
        verifiedAt = nil; timezone = nil; prescriptionDigest = nil; lifecycleEvent = nil
        if !metadata { workoutID = nil; scheduledAt = nil; idempotencyKey = nil; exportNotes = nil }
    }
}

struct PlanReceiptScope: Codable, Equatable {
    let serverId: String
    let athleteId: String
    let datasetEpoch: String
}

/// `/v1/mobile/workout-plan/synced` 的响应投影。
///
/// ⚠️ 服务端同时返回 `informationLevel`（`verifiedClient` / `legacy`，`server.ts` 的回执路由），
/// 客户端**刻意不消费**（2026-10-15 审查 C-🔡2 的边界声明）：两种核验等级共用同一套
/// "系统日程已核验"文案，解码层丢弃它不改变任何行为。若将来要在 UI 区分等级，
/// 从这里加字段，并同步 `check-direct-sync-status-copy.py` 的文案门禁。
struct PlanSyncReceiptResponse: Decodable {
    let recordedAt: String
    let matchesCurrent: Bool?
}

struct MobilePlannedDay: Codable, Equatable {
    let localDate: String
    let kind: String
    let distanceKm: Double?
    let structure: MobileSessionStructure?
    let reason: String?
}

struct MobileWeeklyPlanGenerationResponse: Codable, Equatable {
    let generatedAt: String
    let revision: Int
    let audit: MobilePlanAudit
    let days: [MobilePlannedDay]
    let warnings: [String]
}

struct MobilePlanExecutionDay: Codable, Identifiable {
    let localDate: String
    let planRevision: Int?
    let plannedKind: String?
    let plannedDistanceKm: Double?
    let observedDistanceKm: Double
    let observedWorkoutCount: Int
    let distanceRatio: Double?
    let status: String
    var id: String { localDate }
}

struct MobileWeeklyPlanPreview: Codable, Identifiable {
    var previousDays: [MobilePlannedDay]? = nil
    let candidateId: String
    let expiresAt: String
    let revision: Int
    let generatedAt: String
    let audit: MobilePlanAudit
    let days: [MobilePlannedDay]
    let warnings: [String]
    let replacedDates: [String]
    let windowStart: String
    let windowEnd: String
    var id: String { candidateId }
}

struct ConfirmWeeklyPlanRequest: Codable {
    let candidateId: String
    let expectedRevision: Int
    var operationId: String? = nil
    var operationScope: PlanReceiptScope? = nil
}

struct PreviewWeeklyPlanRequest: Encodable {
    let expectedRevision: Int?

    enum CodingKeys: String, CodingKey { case expectedRevision }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(expectedRevision, forKey: .expectedRevision)
    }
}

struct LockMobileSessionRequest: Encodable {
    let action: String
    let expectedRevision: String?
    var operationId: String? = nil
    var operationScope: PlanReceiptScope? = nil

    enum CodingKeys: String, CodingKey { case action, expectedRevision, operationId, operationScope }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(action, forKey: .action)
        try container.encodeIfPresent(expectedRevision, forKey: .expectedRevision)
        try container.encodeIfPresent(operationId, forKey: .operationId)
        try container.encodeIfPresent(operationScope, forKey: .operationScope)
    }
}

struct WorkoutDetailResponse: Codable, Identifiable {
    var id: String { workout.id }
    let workout: WorkoutDetail
    let dimensions: AbilityMetricSet
    let route: [RoutePoint]
    let override: WorkoutOverride?
    let trainingLoad: WorkoutTrainingLoad?
    let zoneSummary: WorkoutZoneSummary?
}

struct WorkoutDetail: Codable {
    let id: String
    let startedAt: String
    let endedAt: String
    let durationSeconds: Double
    let elapsedSeconds: Double
    /// P0-1：事实已提交但分析未发布时为 `pending`；老服务端省略 ⇒ nil（按已发布处理）。
    var analysisPublishStatus: String? = nil
    /// A6（P2-3，2026-10-19）：旧分析是否仍可读；老服务端省略 ⇒ nil（按"不可读"保守处理）。
    var analysisAvailable: Bool? = nil
    let distanceKm: Double?
    let activeEnergyKcal: Double?
    let elevationGainMeters: Double?
    let averagePaceSecondsPerKm: Double?
    let averageHeartRateBpm: Double?
    let averageCadenceSpm: Double?
    let averagePowerWatts: Double?
    let averageStrideLengthMeters: Double?
    let averageVerticalOscillationCm: Double?
    let averageGroundContactTimeMs: Double?
    let indoor: Bool?
    let sourceCategory: String
    let sessionType: String
    let stimulusType: String
    let stimulusConfidence: Double?
    let eligibilityStatus: String
    let assessmentStatus: String?
    let missingReasons: [String]
    let qualityScore: Double
    let currentAbility: Double?
    let confidence: Double?
    let trueAbilityDelta: Double?
    let hasRoute: Bool
    let modelVersion: String
    let updatedTrueAbility: Bool
    let heartRateCoverage: Double?
    let heartRateSampleCount: Int
    let routeQuality: Double?
    let routePointCount: Int
    let sourceConfidence: Double
    let effectiveWeights: [String: Double]
    let confidenceFactors: [String: Double]
    let explanationCodes: [String]
    let trueAbilityBefore: Double?
    let trueAbilityAfter: Double?
    let workoutContribution: Double?
    /// §5 environment read-out. Optional so an older server still decodes.
    let environment: WorkoutEnvironmentView?
}

struct WorkoutOverride: Codable {
    let revision: Int
    let eligibilityOverride: String?
    let statisticsParticipation: String?
    let sessionType: String?
    let performanceProtocol: String?
    let rpe: Double?
    let conditionTags: [String]
    let note: String?
    let createdAt: String
}

struct RoutePoint: Codable, Identifiable {
    let latitude: Double
    let longitude: Double
    let elevationMeters: Double?
    let speedMetersPerSecond: Double?
    let timestamp: String?

    var id: String { "\(latitude)-\(longitude)-\(timestamp ?? "")" }
}

struct WorkoutTrainingLoad: Codable {
    let trainingSessionId: String
    let localDate: String
    let distanceMeters: Double?
    let durationSeconds: Double
    let load: Double
    let intensity: Double
    let source: String
    let confidence: Double
    let rpe: Double?
    let sessionType: String
    let averageHeartRate: Double?
    let elevationGainMeters: Double?
    let stimulusType: String
    let breakdown: TrainingLoadBreakdown
    let explanations: [TrainingStatusExplanation]
}

struct TrainingLoadBreakdown: Codable {
    let rawHrrTrimp: Double?
    let internalLoad: Double?
    let paceLoad: Double?
    let distanceReferenceMeters: Double?
    let distanceExposureRatio: Double?
    let distanceFactor: Double
    let compositeLoad: Double
    let compositeIntensity: Double
    let heartRateConfidence: Double
    let paceConfidence: Double
}

struct TrainingStatusExplanation: Codable {
    let code: String
    let value: Double?
    let threshold: Double?
}

struct WorkoutZoneSummary: Codable {
    let trainingSessionId: String
    let zoneProfileId: String
    let stimulusType: String
    let secondaryStimulusTypes: [String]
    let stimulusConfidence: Double
    let heartRateCoverage: Double
    let paceCoverage: Double
    let heartRateExposure: [ZoneExposure]
    let paceExposure: [ZoneExposure]
    let stimulusScores: [StimulusScore]
    let explanationCodes: [String]
}

struct StimulusScore: Codable {
    let stimulusType: String
    let qualifyingSeconds: Double
    let targetSeconds: Double
    let score: Double
    let confidence: Double
}

struct ZoneExposure: Codable, Identifiable {
    let zone: String
    let durationSeconds: Double
    let distanceMeters: Double
    let fraction: Double

    var id: String { zone }
}

/* The API can omit a load while a database is being rebuilt. */
struct OptionalWorkoutTrainingLoad: Codable {
    let loadRatio: Double?
    let strain: Double?
    let trainingStatus: String?
}

/// `GET /v1/sync/coverage`（P1-1）：服务端每个记录类型的已覆盖区间。
nonisolated struct SyncCoverageResponse: Codable, Equatable, Sendable {
    let datasetEpoch: String
    let types: [SyncCoverageType]
}

nonisolated struct SyncCoverageType: Codable, Equatable, Sendable {
    let type: String
    let knownFrom: String?
    let knownUntil: String?
    let sampleCount: Int
}

/// `GET /v1/workouts/:id/freshness`（P0-3）：事实/分析/时序的补齐状态。
nonisolated struct WorkoutFreshnessResponse: Codable, Equatable, Sendable {
    let workoutId: String
    let facts: WorkoutFreshnessFacts
    let analysis: WorkoutFreshnessAnalysis
    let series: [WorkoutFreshnessMetric]
    /// `complete` = 分析已发布且最近 24h 无新事实；`partial` = 仍可能补齐。
    /// ⚠️ A5 本轮不改它；三态拆分读下面的可选字段。
    let completeness: String
    /// A5（P2-3，2026-10-19）：`delivered | partial | unknown`。
    /// 服务端口径是**到达证据**（没有批次账本 ⇒ `unknown`，不是"手表还在传"）；老服务端省略 ⇒ nil。
    var deliveryState: String? = nil
    /// A5：`published | pending | failed`，与 `analysis.status` 同源（A6 的判据）。
    var analysisState: String? = nil
    /// A5：`stable | settling`。**唯一**受 24h 静默窗口影响的字段。
    var stabilityState: String? = nil
}

nonisolated struct WorkoutFreshnessFacts: Codable, Equatable, Sendable {
    let committedAt: String?
    let lastBatchAt: String?
    let batches: Int
}

nonisolated struct WorkoutFreshnessAnalysis: Codable, Equatable, Sendable {
    let status: String
    /// A6（2026-10-19）：旧分析是否仍可读。`status != "published"` 且它为 true ⇒
    /// 旧分析字段可读，但没有覆盖最新事实代次。老服务端省略 ⇒ nil。
    var available: Bool? = nil
    let jobId: String?
    let publishedAt: String?
}

nonisolated struct WorkoutFreshnessMetric: Codable, Equatable, Sendable {
    let metric: String
    let samples: Int
    /// `present` / `not_seen_yet`（后者 ≠ 设备不支持）。
    let state: String
    /// P2-2：该指标最近一次被服务端接收的时刻；旧服务端省略 ⇒ nil。
    var lastAvailableAt: String? = nil
}

struct WorkoutSeriesResponse: Codable {
    let trainingSessionId: String
    let startedAt: String
    let endedAt: String
    let sourceCategory: String
    let splits: [WorkoutSplit]
    /// What the run was actually made of. Decoded tolerantly: an older server
    /// build does not send these keys, and a hard failure would take the whole
    /// detail page down over an optional panel.
    let segments: [WorkoutSegment]
    let segmentPlan: WorkoutSegmentPlanMatch?
    /// Why `segments` is empty — never a silent blank panel.
    let segmentNote: String?
    /// Absent on older APIs: hide inferred/unknown segments rather than claim plan execution.
    let hasMeasuredWorkoutSteps: Bool?
    var showsPlanSegments: Bool { hasMeasuredWorkoutSteps == true && !segments.isEmpty }
    /// Grade summary for the splits. Absent on older APIs; the panel then hides.
    let grade: WorkoutGradeSummary?
    /// §19 stride read-out. Absent on older APIs — the panel then hides rather
    /// than the whole detail page failing to decode.
    let dynamics: RunningDynamicsAnalysis?
    let series: WorkoutSeries

    private enum CodingKeys: String, CodingKey {
        case trainingSessionId, startedAt, endedAt, sourceCategory
        case splits, segments, segmentPlan, segmentNote, hasMeasuredWorkoutSteps, grade, dynamics, series
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        trainingSessionId = try container.decode(String.self, forKey: .trainingSessionId)
        startedAt = try container.decode(String.self, forKey: .startedAt)
        endedAt = try container.decode(String.self, forKey: .endedAt)
        sourceCategory = try container.decode(String.self, forKey: .sourceCategory)
        splits = try container.decode([WorkoutSplit].self, forKey: .splits)
        segments = try container.decodeIfPresent([WorkoutSegment].self, forKey: .segments) ?? []
        segmentPlan = try container.decodeIfPresent(WorkoutSegmentPlanMatch.self, forKey: .segmentPlan)
        segmentNote = try container.decodeIfPresent(String.self, forKey: .segmentNote)
        hasMeasuredWorkoutSteps = try container.decodeIfPresent(Bool.self, forKey: .hasMeasuredWorkoutSteps)
        grade = try container.decodeIfPresent(WorkoutGradeSummary.self, forKey: .grade)
        dynamics = try container.decodeIfPresent(RunningDynamicsAnalysis.self, forKey: .dynamics)
        series = try container.decode(WorkoutSeries.self, forKey: .series)
    }
}

/// One executed segment: a Watch lap/segment, or a plan step replayed onto the
/// measured track. `purpose == "unplanned"` is the stretch no step covered.
///
/// `purpose`/`goalType`/`alertKind` stay `String` rather than enums on purpose:
/// a server that learns a new purpose must not break decoding on an old build.
struct WorkoutSegment: Codable, Identifiable {
    let index: Int
    let label: String
    let purpose: String
    let goalType: String?
    let goalMeters: Double?
    let goalSeconds: Double?
    let alertKind: String?
    let alertLower: Double?
    let alertUpper: Double?
    let startOffsetSeconds: Double
    let durationSeconds: Double
    let distanceMeters: Double
    let averagePaceSecondsPerKm: Double?
    let averageHeartRateBpm: Double?
    let averageCadenceSpm: Double?

    var id: Int { index }
}

/// Which stored plan day a run was matched to, and how confidently.
///
/// Shown next to the segments because the match is a guess when it comes from a
/// date window: presenting a guess as a measurement is the failure mode this
/// type exists to prevent.
struct WorkoutSegmentPlanMatch: Codable {
    let localDate: String
    let kind: String
    let revision: Int
    let matchedBy: String
    let plannedDistanceKm: Double?
    let explainedFraction: Double
    let reason: String
}

struct WorkoutSplit: Codable, Identifiable {
    let index: Int
    let distanceMeters: Double
    let durationSeconds: Double
    let averagePaceSecondsPerKm: Double
    let averageHeartRateBpm: Double?
    let averageCadenceSpm: Double?
    /// §5 grade context from the route points of the same run. Absent on older
    /// servers and on runs without altitude; `gradePercent == nil` means unknown,
    /// which is not the same as flat.
    let grade: WorkoutSplitGrade?

    var id: Int { index }
}

/// Per-split grade and its flat-equivalent pace.
///
/// Display-only: the Minetti cost model re-expresses a measured pace, it does not
/// correct evidence. Decoded tolerantly so an older server keeps working.
struct WorkoutSplitGrade: Codable {
    let elevationChangeMeters: Double?
    let gainMeters: Double?
    let lossMeters: Double?
    let gradePercent: Double?
    let gradeAdjustedPaceSecondsPerKm: Double?
    let policyVersion: String
    let reasonCodes: [String]
}

/// §20 race-driven periodisation. Read-time and deterministic: the skeleton follows
/// the race target the moment it changes, and nothing here is persisted.
struct MobilePeriodization: Codable {
    let policyVersion: String
    let generatedFor: String
    let raceDate: String?
    let distance: String?
    let weeks: [MobilePeriodizationWeek]
    let current: MobilePeriodizationWeek?
    let reasonCodes: [String]
}

struct MobilePeriodizationWeek: Codable, Identifiable {
    let weekStart: String
    let phase: String
    let weeksToRace: Int
    let volumeBandKm: MobileVolumeBand
    let longRunCapKm: Double
    let qualityDose: Int
    let note: String

    var id: String { weekStart }
}

struct MobileVolumeBand: Codable {
    let lower: Double
    let upper: Double
}

/// §20 adherence. `unknownDays` is a first-class field: a planned day nobody observed
/// is not a missed session, and the view must be able to say which it is.
struct MobilePlanAdherence: Codable {
    let policyVersion: String
    let generatedFor: String
    let weeks: [MobileAdherenceWeek]
    let current: MobileAdherenceWeek?
    let reasonCodes: [String]
}

struct MobileAdherenceWeek: Codable, Identifiable {
    let weekStart: String
    let phase: String?
    let plannedDays: Int
    let observedDays: Int
    let unknownDays: Int
    let plannedDistanceKm: Double?
    let observedDistanceKm: Double
    let volumeRatio: Double?
    let qualityPlanned: Int
    let qualityObserved: Int
    let status: String

    var id: String { weekStart }
}

/// §20 advice only. A re-draft still goes through preview/confirm.
struct MobileReplanAdvice: Codable {
    let policyVersion: String
    let recommended: Bool
    let reasons: [MobileReplanReason]
}

struct MobileReplanReason: Codable, Identifiable {
    let code: String
    let detail: String

    var id: String { code }
}

/// D9 share card. The route arrives already trimmed: `polylines` is a list so a
/// renderer cannot reconnect across a privacy-zone cut by accident.
struct ShareCardResponse: Codable {
    let trainingSessionId: String
    let generatedAt: String
    let privacy: ShareCardPrivacy
    let workout: ShareCardWorkout
    let polylines: [[ShareCardRoutePoint]]
    let note: String?
}

struct ShareCardPrivacy: Codable {
    let policyVersion: String
    let zonesApplied: Int
    let redactedPoints: Int
    let gaps: Int
    let unfiltered: Bool
}

struct ShareCardWorkout: Codable {
    let startedAt: String
    let sessionType: String
    let distanceKm: Double?
    let durationSeconds: Double
    let averagePaceSecondsPerKm: Double?
    let averageHeartRateBpm: Double?
    let elevationGainMeters: Double?
    let gradeAdjustedPaceSecondsPerKm: Double?
}

struct ShareCardRoutePoint: Codable, Equatable {
    let latitude: Double
    let longitude: Double
}

/// §19 stride read-out.
///
/// Device estimates with no laboratory validation: `evidenceStatus` is decoded so
/// the view cannot present them as measurements. Coverage travels with every
/// metric because an average without its coverage is the finding this contract
/// exists to prevent.
struct RunningDynamicsAnalysis: Codable {
    let policyVersion: String
    let evidenceStatus: String
    let metrics: [RunningDynamicsMetricAnalysis]
    let flags: [RunningDynamicsFlag]
    let note: String?

    /// Metrics that can carry a comparison; unavailable ones are listed but not
    /// counted as findings.
    var analysable: [RunningDynamicsMetricAnalysis] {
        metrics.filter { $0.status == "available" || $0.status == "partial" }
    }
}

struct RunningDynamicsMetricAnalysis: Codable, Identifiable {
    let name: String
    let label: String
    let unit: String
    let status: String
    let samples: Int
    let coverage: Double
    let average: Double?
    let firstHalfAverage: Double?
    let secondHalfAverage: Double?
    let driftFraction: Double?
    let comparableSamples: Int
    let reasonCodes: [String]

    var id: String { name }
}

struct RunningDynamicsFlag: Codable, Identifiable {
    let code: String
    let metric: String
    let detail: String
    let driftFraction: Double
    let comparableSamples: Int

    var id: String { code }
}

/// Distance-weighted grade-adjusted pace across the covered splits.
struct WorkoutGradeSummary: Codable {
    let policyVersion: String
    let coveredSplits: Int
    let totalSplits: Int
    let gainMeters: Double?
    let lossMeters: Double?
    let gradeAdjustedPaceSecondsPerKm: Double?
    let reasonCodes: [String]
}

/// Environment read-out for one run (docs/ALGORITHM.md §5).
///
/// The correction is applied by the physiology evidence path; this is the same
/// number made readable. `status == "unavailable"` means the capture carried no
/// weather — never render it as a zero correction.
struct WorkoutEnvironmentView: Codable {
    let policyVersion: String
    let adapterVersion: String
    let status: String
    let source: String
    let weatherCondition: Int?
    let temperatureC: Double?
    let humidityPercent: Double?
    let elevationGainMeters: Double?
    let correction: WorkoutEnvironmentCorrection?
    let adjusted: WorkoutEnvironmentAdjusted?
    let reasonCodes: [String]
}

struct WorkoutEnvironmentCorrection: Codable {
    let environment: Double
    let elevation: Double
    let total: Double
}

struct WorkoutEnvironmentAdjusted: Codable {
    let durationSeconds: Double
    let paceSecondsPerKm: Double?
}

struct WorkoutSeries: Codable {
    let heartRate: MetricSeries
    let speed: MetricSeries
    let power: MetricSeries
    let cadence: MetricSeries
    let elevation: MetricSeries
    let strideLength: MetricSeries
    let verticalOscillation: MetricSeries
    let groundContactTime: MetricSeries
}

struct MetricSeries: Codable {
    let unit: String
    let totalSamples: Int
    let points: [MetricPoint]
}

struct MetricPoint: Codable, Identifiable {
    let timestamp: String
    let offsetSeconds: Double
    let value: Double

    var id: Double { offsetSeconds }
}

struct NativeRecoveryTrend: Decodable {
    let days: [Day]
    struct Day: Decodable, Identifiable {
        let date: String
        let sleepMinutes: Double?
        var id: String { date }
    }
}

/// Presentation bounds only; no on-device training/recovery scoring.
struct HeartRateChartData {
    let points: [MetricPoint]
    let duration: Double
    var maximum: Double? { points.map(\.value).max() }
    var lowerBound: Double { min(40, floor((points.map(\.value).min() ?? 40) / 40) * 40) }
    var upperBound: Double { max(200, ceil((maximum ?? 200) / 40) * 40) }
    var timeTicks: [Double] {
        let intervals: [Double] = [60, 120, 300, 600, 900, 1800, 3600]
        let step: Double = intervals.first(where: { $0 >= duration / 5 }) ?? ceil(duration / 5 / 3600) * 3600
        var ticks: [Double] = []
        for tick in stride(from: 0.0, to: duration, by: step) {
            if tick == 0 || duration - tick >= step * 0.6 { ticks.append(tick) }
        }
        ticks.append(duration)
        return ticks
    }
    init(points: [MetricPoint], durationSeconds: Double) {
        self.points = points.filter { $0.offsetSeconds.isFinite && $0.offsetSeconds >= 0 && $0.value.isFinite && $0.value > 0 }
            .sorted { $0.offsetSeconds < $1.offsetSeconds }
        duration = max(1, durationSeconds.isFinite ? durationSeconds : 0, self.points.last?.offsetSeconds ?? 0)
    }
    static func timeLabel(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

struct NativeWorkoutFeedbackInput: Codable, Equatable {
    var trainingSessionId: String
    var expectedRevision: Int
    var eligibilityOverride: String?
    var statisticsParticipation: String?
    var sessionType: String?
    var performanceProtocol: String?
    var rpe: Int?
    var conditionTags: [String]
    var note: String?

    init(detail: WorkoutDetailResponse) {
        trainingSessionId = detail.workout.id
        expectedRevision = detail.override?.revision ?? 0
        eligibilityOverride = detail.override?.eligibilityOverride
        statisticsParticipation = detail.override?.statisticsParticipation
        sessionType = detail.override?.sessionType
        performanceProtocol = detail.override?.performanceProtocol
        rpe = detail.override?.rpe.map(Int.init)
        conditionTags = detail.override?.conditionTags ?? []
        note = detail.override?.note
    }
    // Encode null explicitly: the override contract is a full snapshot, not a patch.
    enum CodingKeys: String, CodingKey {
        case trainingSessionId, expectedRevision, eligibilityOverride, statisticsParticipation,
             sessionType, performanceProtocol, rpe, conditionTags, note
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(trainingSessionId, forKey: .trainingSessionId)
        try c.encode(expectedRevision, forKey: .expectedRevision)
        try c.encode(eligibilityOverride, forKey: .eligibilityOverride)
        try c.encode(statisticsParticipation, forKey: .statisticsParticipation)
        try c.encode(sessionType, forKey: .sessionType)
        try c.encode(performanceProtocol, forKey: .performanceProtocol)
        try c.encode(rpe, forKey: .rpe)
        try c.encode(conditionTags, forKey: .conditionTags)
        try c.encode(note, forKey: .note)
    }
}
struct NativeFeedbackCommand: Codable {
    let idempotencyKey: String
    var kind = "workout_override"
    let payload: NativeWorkoutFeedbackInput
}
struct NativeFeedbackPending: Codable {
    var command: NativeFeedbackCommand?
}
struct NativeCommandResponse: Codable {
    let id: String
    let status: String
    let result: NativeFeedbackResult?
    let error: RaiAPIError?
}
struct NativeFeedbackResult: Codable {
    let overrideId: String
    let jobId: String?
}
/// `GET /v1/jobs/:id` 的读侧投影（`apps/api/src/data.ts` 的 `mapJobFromDomain`）。
///
/// `error` 是**必须**解的：服务端在任务失败时给 `error.code = "task_failed"`
/// （`apps/api/src/data.ts`，`failed ? { code: "task_failed", … } : null`），而
/// `status` 单独一个字段**分不清"执行失败"与"用户取消"** —— 两者都是任务停下来了，
/// 但 §10.1 只允许把前者说成"分析更新失败，可重试分析"，取消要说的是另一回事
/// （「不宣称raw已撤销；只停止分析，保留待更新提示」）。少了这个字段，客户端只能把
/// 取消也显示成"可重试分析"，那是替用户编一句关于他自己操作的假话。
///
/// 可选键 ⇒ 老服务端的响应（没有 `error`）照旧解码。
struct NativeJobStatus: Codable {
    let status: String
    let error: RaiAPIError?
}
enum NativeFeedbackOutcome {
    case saved(String)
    case pending(String)
    case failed(String)
}

struct NativeWorkoutExport: Codable {
    let from: String
    let through: String
    let timezone: String
    let count: Int
    let csv: String
}
