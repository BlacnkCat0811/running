import Foundation

struct RaiHandshake: Codable, Equatable {
    let serverId: String
    let athleteId: String
    let datasetEpoch: String
    let syncProtocolVersion: Int
    let apiVersion: String
}

struct RaiAPIError: Codable {
    let code: String?
    let message: String?
    let currentRevision: Int?
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
        default:
            self = .open
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

/// Who produced a stored weekly plan. Kept so a surprising week can be traced
/// back to the model that wrote it.
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
    let remainingDistanceKm: Double?
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
    let goalDistanceKm: Double?
    let goalProgressFraction: Double?
    let averageSpeedKmPerHour: Double?
    let averagePaceSecondsPerKm: Double?
    let averageHeartRateBpm: Double?
    let heartRateZones: [HeartRateZoneSummary]?
    let paceZones: [HeartRateZoneSummary]?

    /// nil arrays mean an older API/cache, while [] means a successful empty aggregation.
    var hasWeeklyActivityStatistics: Bool {
        heartRateZones != nil && paceZones != nil
    }

    var remainingDistanceKm: Double? {
        guard let goalDistanceKm, goalDistanceKm.isFinite, goalDistanceKm > 0,
              distanceKm.isFinite else { return nil }
        return max(0, goalDistanceKm - distanceKm)
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
    let weeklyDistanceKm: Double
    let easyDurationFloorFraction: Double
    let qualitySessionCap: Int
    let raceTarget: MobileRaceTarget?
    let weekPlan: [MobileGoalsPlanItem]
    let lockedSession: MobileLockedSession?
    let weekPlanAudit: MobilePlanAudit?
    let updatedAt: String
}

/// A persisted planned day. `structure` and `reason` are carried through
/// unchanged on save so editing the weekly distance cannot silently downgrade a
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
    let weeklyDistanceKm: Double
    let easyDurationFloorFraction: Double?
    let qualitySessionCap: Int?
    let raceTarget: MobileRaceTarget?
    let weekPlan: [MobileGoalsPlanItem]?

    enum CodingKeys: String, CodingKey {
        case expectedRevision, weeklyDistanceKm, easyDurationFloorFraction, qualitySessionCap
        case raceTarget, weekPlan
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(expectedRevision, forKey: .expectedRevision)
        try container.encode(weeklyDistanceKm, forKey: .weeklyDistanceKm)
        try container.encodeIfPresent(easyDurationFloorFraction, forKey: .easyDurationFloorFraction)
        try container.encodeIfPresent(qualitySessionCap, forKey: .qualitySessionCap)
        // Explicit null clears the persisted race; omission would preserve it.
        try container.encode(raceTarget, forKey: .raceTarget)
        try container.encodeIfPresent(weekPlan, forKey: .weekPlan)
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
}

/// "This day was handed to the Watch", reported to the server after a sync.
///
/// The server has no other way to know: WorkoutKit scheduling is entirely
/// device-side, and the runner syncs *tomorrow's* session and runs it the same
/// evening, so the run's own date points at a rest day. The receipt is the only
/// link between a stored plan day and the run that executed it.
struct PlanSyncReceipt: Encodable {
    let localDate: String
    let kind: String
    let revision: Int
    let structure: MobileSessionStructure?
}

struct PlanSyncReceiptResponse: Decodable {
    let recordedAt: String
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

struct ConfirmWeeklyPlanRequest: Encodable {
    let candidateId: String
    let expectedRevision: Int
}

struct GenerateWeeklyPlanRequest: Encodable {
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

    enum CodingKeys: String, CodingKey { case action, expectedRevision }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(action, forKey: .action)
        try container.encodeIfPresent(expectedRevision, forKey: .expectedRevision)
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
    let series: WorkoutSeries

    private enum CodingKeys: String, CodingKey {
        case trainingSessionId, startedAt, endedAt, sourceCategory
        case splits, segments, segmentPlan, segmentNote, hasMeasuredWorkoutSteps, grade, series
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
struct NativeJobStatus: Codable { let status: String }
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
