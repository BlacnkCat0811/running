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

    var id: String { localDate }
}

struct MobileLockedSession: Codable {
    let localDate: String
    let session: MobileNextSession
    let verdictTone: String
    let lockedAt: String
}

struct MobileLockState: Codable {
    let present: Bool
    let relockSuggested: Bool
    let lockedAt: String?
}

struct MobileTodayResponse: Codable {
    let generatedAt: String
    let timezone: String
    let latestDataDate: String?
    let lastSyncedAt: String?
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
    let inputs: NativePredictionInputs
    let snapshot: NativePredictionSnapshot
}

struct NativePredictionInputs: Codable {
    let recoveryReadiness: Double?
}

struct NativePredictionSnapshot: Codable {
    let vo2Max: NativeVo2MaxEstimate
    let performanceVdot: NativeVdotEstimate
    let lactateThreshold: NativeLactateThresholdEstimate
    let races: [NativeRacePrediction]
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
    let readiness: Double?
    let confidence: Double

    var id: String { distance }
}

struct NativeDashboardResponse: Codable {
    let latestWorkout: WorkoutListItem?
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
    let rolling28Days: NativeTrainingPeriodSummary?
}

struct NativeDailyTrainingMetric: Codable {
    let trainingStatus: String
    let recoveryEvidence: Double?
}

struct NativeTrainingPeriodSummary: Codable {
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
    let updatedAt: String
}

struct MobileGoalsPlanItem: Codable, Identifiable {
    let localDate: String
    var kind: String
    var distanceKm: Double?

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
        try container.encodeIfPresent(raceTarget, forKey: .raceTarget)
        try container.encodeIfPresent(weekPlan, forKey: .weekPlan)
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

struct WorkoutDetailResponse: Codable {
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
    let series: WorkoutSeries
}

struct WorkoutSplit: Codable, Identifiable {
    let index: Int
    let distanceMeters: Double
    let durationSeconds: Double
    let averagePaceSecondsPerKm: Double
    let averageHeartRateBpm: Double?
    let averageCadenceSpm: Double?

    var id: Int { index }
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
