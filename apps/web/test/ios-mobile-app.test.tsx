import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkoutListItem } from "@rai/api-contracts";

const { useRemoteMock } = vi.hoisted(() => ({ useRemoteMock: vi.fn() }));
vi.mock("../src/hooks.js", () => ({ useRemote: useRemoteMock }));

import { IosMobileApp } from "../src/IosMobileApp.js";

const remote = (data: unknown, overrides: Record<string, unknown> = {}) => ({
  data,
  dataPath: null,
  error: null,
  loading: false,
  reload: vi.fn(),
  ...overrides
});

const workoutItem: WorkoutListItem = {
  id: "w1",
  startedAt: "2026-09-02T01:00:00.000Z",
  endedAt: "2026-09-02T01:30:00.000Z",
  durationSeconds: 1800,
  distanceKm: 5.2,
  averagePaceSecondsPerKm: 346,
  averageHeartRateBpm: 148,
  indoor: false,
  sourceCategory: "apple_watch",
  sessionType: "easy",
  stimulusType: "aerobic_base",
  stimulusConfidence: 0.8,
  eligibilityStatus: "eligible",
  assessmentStatus: "eligible",
  missingReasons: [],
  qualityScore: 0.9,
  currentAbility: 42,
  confidence: 0.9,
  trueAbilityDelta: 0.2,
  hasRoute: true
};

const today = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  timezone: "Asia/Shanghai",
  latestDataDate: "2026-09-03",
  today: {
    localDate: "2026-09-03",
    distanceKm: 0,
    durationSeconds: 0,
    paceSecondsPerKm: null,
    energyKcal: null,
    workoutCount: 0
  },
  week: {
    periodStart: "2026-08-31",
    periodEnd: "2026-09-06",
    distanceKm: 5.2,
    durationSeconds: 1800,
    workoutCount: 1,
    goalDistanceKm: 30,
    goalProgressFraction: 0.173
  },
  weekDaily: [
    { localDate: "2026-08-31", distanceKm: 0, workoutCount: 0 },
    { localDate: "2026-09-01", distanceKm: 0, workoutCount: 0 },
    { localDate: "2026-09-02", distanceKm: 5.2, workoutCount: 1 },
    { localDate: "2026-09-03", distanceKm: 0, workoutCount: 0 },
    { localDate: "2026-09-04", distanceKm: 0, workoutCount: 0 },
    { localDate: "2026-09-05", distanceKm: 0, workoutCount: 0 },
    { localDate: "2026-09-06", distanceKm: 0, workoutCount: 0 }
  ],
  recentWorkouts: [workoutItem],
  ability: {
    trueAbility: 44,
    currentAbility: 42,
    changeFrom7DaysAgo: 0.2,
    growthVelocityPerWeek: 0.1,
    decayPoints: 0,
    snapshotDate: "2026-09-02",
    explanation: "这次发挥接近真实能力。"
  },
  calibration: {
    status: "completed",
    eligibleSessions: 20,
    eligibleDurationMinutes: 1000,
    spanDays: 60,
    highCoverageSessions: 15,
    requirements: { sessions: 8, durationMinutes: 180, spanDays: 21, highCoverageSessions: 5 },
    message: "校准完成，真实能力可以当作主参考。"
  },
  verdict: {
    tone: "yellow",
    title: "只宜有氧",
    reason: "今天按轻松跑安排",
    triggers: [],
    stale: true
  },
  nextSession: {
    kind: "easy",
    title: "轻松跑",
    reason: "负荷允许有氧",
    distanceKm: 8,
    durationMinutes: 50,
    paceSecondsPerKmLower: 330,
    paceSecondsPerKmUpper: 390,
    heartRateBpmLower: 120,
    heartRateBpmUpper: 145
  },
  recovery: {
    score: 0.72,
    lastNightSleepMinutes: 420,
    sleepBaselineMinutes: 430,
    morningHrvMs: 48,
    hrvBaselineMs: 50,
    restingHeartRateBpm: 52,
    restingHeartRateBaselineBpm: 53,
    note: "昨夜睡眠接近基线"
  },
  postRun: {
    workoutId: "w1",
    startedAt: "2026-09-02T01:00:00.000Z",
    sessionType: "easy",
    stimulusType: "aerobic_base",
    stimulusMatch: "aligned",
    indoor: false,
    updatedTrueAbility: true,
    trueAbilityDelta: 0.2,
    currentAbility: 42,
    trueAbilityAfter: 44,
    headline: "这堂课进入了真实能力更新。",
    details: ["轻松跑留在轻松区"]
  },
  weekStructure: {
    easyDurationFraction: 0.8,
    easyDurationFloorFraction: 0.7,
    qualitySessionCount: 0,
    qualitySessionCap: 2,
    easyHonesty: {
      intendedEasyCount: 1,
      easyEnoughCount: 1,
      honestyFraction: 1,
      note: "轻松日够轻松"
    },
    remainingDistanceKm: 24.8
  },
  race: {
    target: null,
    daysUntil: null,
    taper: false,
    shapeScore: 0.5,
    volumeFraction: 0.6,
    longRunFraction: 0.4,
    note: "还没有目标赛事。"
  },
  injuryFlags: [],
  phase: "morning_open",
  lock: { present: false, relockSuggested: false, lockedAt: null },
  weekPlan: [
    { localDate: "2026-08-31", kind: "rest", title: "休息", planned: true, completedWorkoutId: null, distanceKm: 0, workoutCount: 0 },
    { localDate: "2026-09-01", kind: "rest", title: "休息", planned: true, completedWorkoutId: null, distanceKm: 0, workoutCount: 0 },
    { localDate: "2026-09-02", kind: "completed", title: "已完成", planned: false, completedWorkoutId: "w1", distanceKm: 5.2, workoutCount: 1 },
    { localDate: "2026-09-03", kind: "easy", title: "轻松跑", planned: true, completedWorkoutId: null, distanceKm: 8, workoutCount: 0 },
    { localDate: "2026-09-04", kind: "easy", title: "轻松跑（建议）", planned: true, completedWorkoutId: null, distanceKm: 0, workoutCount: 0 },
    { localDate: "2026-09-05", kind: "easy", title: "轻松跑（建议）", planned: true, completedWorkoutId: null, distanceKm: 0, workoutCount: 0 },
    { localDate: "2026-09-06", kind: "long_run", title: "长距离（建议）", planned: true, completedWorkoutId: null, distanceKm: 0, workoutCount: 0 }
  ]
};

const emptySeries = { unit: "count", totalSamples: 0, points: [] };

const statistics = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  timezone: "Asia/Shanghai",
  months: [
    {
      month: "2026-07",
      runningDistanceKm: 40,
      cyclingDistanceKm: 10,
      otherDistanceKm: 0,
      totalDistanceKm: 50,
      durationSeconds: 18000,
      workoutCount: 8
    },
    {
      month: "2026-08",
      runningDistanceKm: 32,
      cyclingDistanceKm: 8,
      otherDistanceKm: 0,
      totalDistanceKm: 40,
      durationSeconds: 14000,
      workoutCount: 6
    }
  ],
  totals: {
    distanceKm: 28.4,
    durationSeconds: 9600,
    workoutCount: 5,
    averagePaceSecondsPerKm: 340,
    distanceChangeFraction: null
  },
  heartRateZones: [
    { zone: "aerobic_base", durationSeconds: 8000, fraction: 0.8 },
    { zone: "recovery", durationSeconds: 2000, fraction: 0.2 }
  ]
};

const trends = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  timezone: "Asia/Shanghai",
  weeks: [
    { periodStart: "2026-08-10", periodEnd: "2026-08-16", distanceKm: 8, workoutCount: 2, isComplete: true },
    { periodStart: "2026-08-17", periodEnd: "2026-08-23", distanceKm: 12, workoutCount: 3, isComplete: true }
  ],
  distanceChangeFraction4Weeks: null,
  records: {
    fastest5k: { distanceKm: 5, paceSecondsPerKm: 300, startedAt: "2026-08-01T00:00:00.000Z" },
    fastest10k: { distanceKm: 10, paceSecondsPerKm: 330, startedAt: "2026-08-08T00:00:00.000Z" },
    longestDistance: { distanceKm: 21.1, startedAt: "2026-07-20T00:00:00.000Z" },
    biggestMonth: { month: "2026-07", distanceKm: 90 }
  },
  insights: [],
  ability: [
    { date: "2026-08-20", trueAbility: 43, decayPoints: 0, growthVelocityPerWeek: 0.1, status: "active" },
    { date: "2026-09-02", trueAbility: 44, decayPoints: 0, growthVelocityPerWeek: 0.1, status: "active" }
  ],
  currentAbility: [
    { id: "w1", date: "2026-09-02T01:00:00.000Z", currentAbility: 42, confidence: 0.9, assessmentStatus: "eligible", distanceKm: 5.2 }
  ],
  growthVelocityPerWeek: 0.1,
  decayPoints: 0
};

const predictions = {
  reportVersion: "rai-physiology-report-v2",
  generatedAt: "2026-09-03T00:00:00.000Z",
  inputs: {
    recoveryReadiness: 0.72,
    directVo2Evidence: 2,
    labeledPerformanceEvidence: 0,
    lactateThresholdSegments: 8,
    performanceVdotEvidence: 4,
    labeledRaceOutcomes: 0,
    readiness: { five_k: 0.7, ten_k: 0.6, half_marathon: 0.5 },
    scenario: {
      temperatureC: null,
      humidityPercent: null,
      elevationGainMeters: { five_k: null, ten_k: null, half_marathon: null }
    },
    profile: { restingHeartRateBpm: 68, observedMaximumHeartRateBpm: 200 }
  },
  modelSelection: {
    biasCalibration: {
      status: "inactive",
      historicalOutcomeCount: 0,
      eligibleOutcomeCountByDistance: { five_k: 0, ten_k: 0, half_marathon: 0 },
      appliedDistances: []
    },
    machineLearning: {
      status: "insufficient_samples",
      modelVersion: null,
      trainedExampleCount: 0,
      evaluatedOutcomeCount: 0,
      meanAbsoluteErrorImprovement: null,
      regressesAnyDistanceByMoreThan5Percent: false,
      activeModelRunId: null,
      activeModelVersion: null,
      featureSchemaVersion: null,
      artifactSha256: null,
      activatedAt: null
    }
  },
  guidanceCodes: ["prediction_confidence_low"],
  snapshot: {
    schemaVersion: "physiology-prediction-v1",
    modelVersion: "test",
    generatedAt: "2026-09-03T00:00:00.000Z",
    dataThroughAt: "2026-08-15T00:00:00.000Z",
    vo2Max: {
      status: "available",
      valueMlKgMin: 42.3,
      rangeMlKgMin: { lower: 40, upper: 44.5 },
      confidence: 0.78,
      confidenceLevel: "moderate",
      evidenceCount: 10,
      latestEvidenceAt: "2026-08-15T00:00:00.000Z",
      method: "robust_evidence_ensemble_v1",
      evidenceCodes: []
    },
    performanceVdot: {
      status: "available",
      value: 41.1,
      range: { lower: 39, upper: 43 },
      confidence: 0.7,
      confidenceLevel: "moderate",
      evidenceCount: 4,
      latestEvidenceAt: "2026-08-15T00:00:00.000Z",
      method: "performance_envelope_v1",
      evidenceCodes: []
    },
    lactateThreshold: {
      status: "available",
      paceSecondsPerKm: 368,
      paceRangeSecondsPerKm: { lower: 328, upper: 408 },
      heartRateBpm: 175,
      heartRateRangeBpm: { lower: 167, upper: 182 },
      confidence: 0.21,
      confidenceLevel: "low",
      evidenceCount: 8,
      latestEvidenceAt: "2026-08-15T00:00:00.000Z",
      method: "multi_evidence_threshold_v2",
      evidenceCodes: []
    },
    races: [],
    disclaimer: "not medical"
  }
};

const zones = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  profile: {
    id: "zone-1",
    localDate: "2026-09-03",
    timezoneIdentifier: "Asia/Shanghai",
    effectiveAt: "2026-09-02T16:00:00.000Z",
    dataThroughAt: null,
    restingHeartRateBpm: 68,
    maximumHeartRateBpm: 200,
    lactateThresholdPaceSecondsPerKm: 368,
    heartRateSource: "automatic",
    paceSource: "automatic",
    heartRateConfidence: 0.6,
    paceConfidence: 0.4,
    status: "stable",
    heartRateBands: [
      { zone: "recovery", lowerReserveFraction: null, upperReserveFraction: 0.6, lowerBpm: null, upperBpm: 147 },
      { zone: "lactate_threshold", lowerReserveFraction: 0.8, upperReserveFraction: 0.9, lowerBpm: 174, upperBpm: 187 }
    ],
    paceBands: [
      { zone: "easy", lowerSecondsPerKm: 424, upperSecondsPerKm: null },
      { zone: "lactate_threshold", lowerSecondsPerKm: 358, upperSecondsPerKm: 391 }
    ],
    evidence: { restingHeartRateDays: 14, maximumHeartRateWorkouts: 4, thresholdEvidenceCount: 2 },
    createdAt: "2026-09-03T00:00:00.000Z"
  },
  settings: {
    revision: 1,
    effectiveFromLocalDate: "2026-01-01",
    restingHeartRate: { mode: "auto", valueBpm: null },
    maximumHeartRate: { mode: "auto", valueBpm: null },
    lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null },
    createdAt: "2026-01-01T00:00:00.000Z"
  },
  previousProfile: null
};

const overview = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  timezone: "Asia/Shanghai",
  status: {
    localDate: "2026-09-03",
    distanceMeters: 0,
    durationSeconds: 0,
    workoutCount: 0,
    load: 0,
    current7dLoad: 0,
    previous7dLoad: 10,
    acuteEwma: 0,
    chronicEwma: 10,
    loadRatio: 0.9,
    rampRate: 0,
    monotony: null,
    strain: null,
    recoveryEvidence: 0.64,
    trainingStatus: "recovery",
    statusExplanations: [],
    loadConfidence: 0.5
  },
  statusConfidence: 0.5,
  week: {},
  month: {},
  year: {},
  rolling7Days: {},
  rolling28Days: { averagePaceSecondsPerKm: 360 }
};

function mockRemote() {
  useRemoteMock.mockImplementation((path: string) => {
    if (path === "/v1/mobile/today") return remote(today, { dataPath: path });
    if (path === "/v1/predictions") return remote(predictions, { dataPath: path });
    if (path === "/v1/dashboard") {
      return remote({ latestWorkout: workoutItem, dimensions: { recovery: 40 } }, { dataPath: path });
    }
    if (path === "/v1/training-zones/current") return remote(zones, { dataPath: path });
    if (path === "/v1/training-statistics/overview") return remote(overview, { dataPath: path });
    if (path === "/v1/mobile/statistics") return remote(statistics, { dataPath: path });
    if (path === "/v1/mobile/trends") return remote(trends, { dataPath: path });
    if (path === "/v1/mobile/goals") {
      return remote({
        weeklyDistanceKm: 30,
        easyDurationFloorFraction: 0.7,
        qualitySessionCap: 2,
        raceTarget: null,
        weekPlan: [],
        lockedSession: null,
        updatedAt: "2026-09-01T00:00:00.000Z"
      }, { dataPath: path });
    }
    if (path.startsWith("/v1/workouts?") ) {
      return remote({ items: [workoutItem], total: 1, limit: 100, offset: 0 }, { dataPath: path });
    }
    if (path === "/v1/workouts/w1") {
      return remote({
        workout: {
          ...workoutItem,
          elapsedSeconds: 1800,
          activeEnergyKcal: 320,
          elevationGainMeters: 40,
          averageCadenceSpm: 170,
          averagePowerWatts: null,
          averageStrideLengthMeters: null,
          averageVerticalOscillationCm: null,
          averageGroundContactTimeMs: null,
          modelVersion: "v1",
          updatedTrueAbility: true,
          heartRateCoverage: 0.9,
          heartRateSampleCount: 100,
          routeQuality: 0.8,
          routePointCount: 2,
          sourceConfidence: 0.9,
          effectiveWeights: {},
          confidenceFactors: {},
          explanationCodes: [],
          explanation: {},
          trueAbilityBefore: 42,
          trueAbilityAfter: 42.2,
          workoutContribution: 0.1
        },
        dimensions: { efficiency: 50, pace: 49, cardio: 45, stability: 40, recovery: 28 },
        route: [
          { latitude: 31.2, longitude: 121.4, elevationMeters: 10, speedMetersPerSecond: 3, timestamp: "2026-09-02T01:00:00.000Z" },
          { latitude: 31.21, longitude: 121.41, elevationMeters: 12, speedMetersPerSecond: 3.1, timestamp: "2026-09-02T01:10:00.000Z" }
        ],
        override: null,
        trainingLoad: {
          trainingSessionId: "w1",
          localDate: "2026-09-02",
          distanceMeters: 5200,
          durationSeconds: 1800,
          load: 80,
          intensity: 0.5,
          source: "composite",
          confidence: 0.8,
          rpe: null,
          sessionType: "easy",
          averageHeartRate: 148,
          elevationGainMeters: 40,
          stimulusType: "aerobic_base",
          breakdown: {
            rawHrrTrimp: 40,
            internalLoad: 40,
            paceLoad: 50,
            distanceReferenceMeters: 5000,
            distanceExposureRatio: 1,
            distanceFactor: 1,
            compositeLoad: 80,
            compositeIntensity: 0.5,
            heartRateConfidence: 0.8,
            paceConfidence: 0.9
          },
          explanations: []
        },
        zoneSummary: {
          trainingSessionId: "w1",
          zoneProfileId: "zone_1",
          stimulusType: "aerobic_base",
          secondaryStimulusTypes: [],
          stimulusConfidence: 0.8,
          heartRateCoverage: 0.9,
          paceCoverage: 0.9,
          heartRateExposure: [
            { zone: "recovery", durationSeconds: 60, distanceMeters: 200, fraction: 0.1 },
            { zone: "aerobic_base", durationSeconds: 1740, distanceMeters: 5000, fraction: 0.9 }
          ],
          paceExposure: [],
          stimulusScores: [],
          explanationCodes: []
        },
        zoneProfile: null
      }, { dataPath: path });
    }
    if (path === "/v1/workouts/w1/series") {
      return remote({
        trainingSessionId: "w1",
        startedAt: workoutItem.startedAt,
        endedAt: workoutItem.endedAt,
        sourceCategory: "apple_watch",
        splits: [{
          index: 1,
          distanceMeters: 1000,
          durationSeconds: 340,
          averagePaceSecondsPerKm: 340,
          averageHeartRateBpm: 145,
          averageCadenceSpm: 170
        }],
        series: {
          heartRate: emptySeries,
          speed: emptySeries,
          power: emptySeries,
          cadence: emptySeries,
          elevation: emptySeries,
          strideLength: emptySeries,
          verticalOscillation: emptySeries,
          groundContactTime: emptySeries
        }
      }, { dataPath: path });
    }
    return remote(null, { loading: true, dataPath: path });
  });
}

function renderApp(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <IosMobileApp />
    </MemoryRouter>
  );
}

describe("iOS mobile detail navigation", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    useRemoteMock.mockReset();
    mockRemote();
  });

  it("opens this week's activity detail from the home card action", () => {
    renderApp("/");
    fireEvent.click(screen.getByRole("button", { name: "本周" }));
    expect(screen.getByRole("heading", { name: "本周活动" })).toBeTruthy();
    expect(screen.getByText("每日跑量")).toBeTruthy();
    expect(screen.getByText("本周训练")).toBeTruthy();
    expect(screen.getByText("1 次")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /轻松跑/ }).length).toBeGreaterThan(0);
  });

  it("shows aerobic pace, VO2max, recovery, lactate threshold and threshold HR on home", () => {
    renderApp("/");
    expect(screen.getByText("长期跑力估计")).toBeTruthy();
    expect(screen.getByText("今日训练建议")).toBeTruthy();
    expect(screen.getByText("只宜有氧")).toBeTruthy();
    expect(screen.getByText("下一堂课")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认今日安排" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "本周" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "身体指标" })).toBeTruthy();
    expect(screen.getByText("7h00min")).toBeTruthy();
  });

  it("opens physiology detail from the body status card", () => {
    renderApp("/");
    fireEvent.click(screen.getByRole("button", { name: "身体指标" }));
    expect(screen.getByRole("heading", { name: "身体指标" })).toBeTruthy();
    expect(screen.getByText("最近训练平均配速")).toBeTruthy();
    expect(screen.getByText("轻松跑区（分区处方）")).toBeTruthy();
    expect(screen.getByText(/恢复阶段/)).toBeTruthy();
    expect(screen.getByText("快 0:14，较 28 天均值")).toBeTruthy();
    expect(screen.getByText("心率分区")).toBeTruthy();
    expect(screen.getByText("乳酸阈值区")).toBeTruthy();
    expect(screen.getByText("证据有限，请把区间而不是单点作为主要参考。")).toBeTruthy();
  });

  it("opens a workout detail from the training list", () => {
    renderApp("/workouts");
    fireEvent.click(screen.getByRole("button", { name: "查看轻松跑详情" }));
    expect(screen.getByRole("heading", { name: "训练详情" })).toBeTruthy();
    expect(screen.getByText("5.2")).toBeTruthy();
    expect(screen.getByText("平均心率")).toBeTruthy();
    expect(screen.getByText("公里分段")).toBeTruthy();
    expect(screen.getByText("有氧基础区")).toBeTruthy();
  });

  it("opens a workout from home recent list and returns with the back button", () => {
    renderApp("/workouts");
    fireEvent.click(screen.getByRole("button", { name: "查看轻松跑详情" }));
    expect(screen.getByRole("heading", { name: "训练详情" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /返回/ }));
    expect(screen.getByRole("heading", { name: "训练" })).toBeTruthy();
  });

  it("shows a sync CTA when the store has no latest data date", () => {
    useRemoteMock.mockImplementation((path: string) => {
      if (path === "/v1/mobile/today") {
        return remote({ ...today, latestDataDate: null }, { dataPath: path });
      }
      return remote(null, { loading: true, dataPath: path });
    });
    renderApp("/");
    expect(screen.getByText(/点同步健康读取跑步|同步健康/)).toBeTruthy();
    expect(screen.getByText(/今天还没跑 · 本周已 5.2 km/)).toBeTruthy();
  });

  it("rejects weekly goals outside 1–500", () => {
    renderApp("/settings");
    fireEvent.change(screen.getByLabelText("每周跑量（km）"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存目标" }));
    expect(screen.getByText("请输入 1–500 的周跑量（公里）")).toBeTruthy();
    expect(screen.getByText("未连接")).toBeTruthy();
  });

  it("still shows health sync when weekly goals fail to load", () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: { messageHandlers: { rai: { postMessage } } }
    });
    useRemoteMock.mockImplementation((path: string) => {
      if (path === "/v1/mobile/goals") {
        return remote(null, { error: "无法读取周目标", loading: false, dataPath: path });
      }
      return remote(null, { loading: true, dataPath: path });
    });
    try {
      renderApp("/settings");
      expect(screen.getByText("服务器连接")).toBeTruthy();
      expect(screen.getByText("健康数据")).toBeTruthy();
      expect(screen.getByRole("button", { name: "同步健康" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "重新导入全部" })).toBeTruthy();
      expect(screen.getByText("无法读取周目标")).toBeTruthy();
      expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
      expect(screen.queryByLabelText("每周跑量（km）")).toBeNull();
    } finally {
      Reflect.deleteProperty(window, "webkit");
    }
  });

  it("shows statistics 环比 as 数据不足 and captions the 28-day totals", () => {
    renderApp("/statistics");
    expect(screen.getByText("环比")).toBeTruthy();
    expect(screen.getByText("数据不足")).toBeTruthy();
    expect(screen.getByText("以上合计为近 28 天")).toBeTruthy();
  });

  it("uses empty-state copy when trend change fraction is missing", () => {
    renderApp("/trends");
    expect(screen.getByText("近 8 周对比数据不足，还不能计算跑量变化")).toBeTruthy();
    expect(screen.queryByText("数据不足")).toBeNull();
    expect(screen.getByText("2026年7月")).toBeTruthy();
  });

  it("changes the workouts request when a session type chip is selected", () => {
    renderApp("/workouts");
    fireEvent.click(screen.getByRole("button", { name: "节奏跑" }));
    const paths = useRemoteMock.mock.calls.map((call) => String(call[0]));
    expect(paths.some((path) => path.includes("sessionType=tempo"))).toBe(true);
    expect(paths.some((path) => path.includes("/v1/workouts?") && !path.includes("sessionType="))).toBe(true);
  });

  it("requests days=28 when the 28天 chip is selected", () => {
    renderApp("/workouts");
    fireEvent.click(screen.getByRole("button", { name: "28天" }));
    const paths = useRemoteMock.mock.calls.map((call) => String(call[0]));
    expect(paths.some((path) => /[?&]days=28(?:&|$)/.test(path))).toBe(true);
    expect(paths.some((path) => /[?&]days=7(?:&|$)/.test(path))).toBe(false);
  });

  it("shows today's distance in the hero when there is a run", () => {
    useRemoteMock.mockImplementation((path: string) => {
      if (path === "/v1/mobile/today") {
        return remote({
          ...today,
          latestDataDate: "2026-09-03",
          today: {
            ...today.today,
            distanceKm: 8.4,
            durationSeconds: 2400,
            paceSecondsPerKm: 286,
            energyKcal: 510,
            workoutCount: 1
          }
        }, { dataPath: path });
      }
      return remote(null, { loading: true, dataPath: path });
    });
    renderApp("/");
    expect(screen.getByText("今日跑步 · 1 次")).toBeTruthy();
    expect(screen.getByText("8.4")).toBeTruthy();
    expect(screen.queryByText(/今天还没跑/)).toBeNull();
  });

  it("navigates to settings from the profile button", () => {
    renderApp("/");
    fireEvent.click(screen.getByRole("button", { name: "个人资料" }));
    expect(screen.getByRole("heading", { name: "设置" })).toBeTruthy();
    expect(screen.getByLabelText("每周跑量（km）")).toBeTruthy();
  });
});
