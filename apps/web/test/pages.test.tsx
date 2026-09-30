import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useRemoteMock } = vi.hoisted(() => ({ useRemoteMock: vi.fn() }));
vi.mock("../src/hooks.js", () => ({ useRemote: useRemoteMock }));

import { DataAuditPage } from "../src/pages/DataAuditPage.js";
import { PredictionsPage } from "../src/pages/PredictionsPage.js";
import { WorkoutsPage } from "../src/pages/WorkoutsPage.js";

const remote = (data: unknown, overrides: Record<string, unknown> = {}) => ({
  data,
  dataPath: null,
  error: null,
  loading: false,
  reload: vi.fn(),
  ...overrides
});

function LocationStateProbe() {
  const location = useLocation();
  return <span data-testid="return-to">{(location.state as { from?: string } | null)?.from}</span>;
}

describe("page data presentation", () => {
  beforeEach(() => useRemoteMock.mockReset());

  it("uses workout source totals for audit shares and formats quality as a percentage", () => {
    useRemoteMock.mockReturnValue(remote({
      datasetVersion: "test",
      importCompletedAt: null,
      canonical: {
        healthRecords: 1000,
        workouts: 4,
        canonicalWorkouts: 4,
        workoutGroups: 4,
        trainingSessions: 3,
        routes: 0,
        routePoints: 0
      },
      featureQuality: {
        averageQualityScore: 0.82,
        averageHeartRateCoverage: 0.75,
        minimumHeartRateCoverage: 0.5,
        maximumHeartRateCoverage: 1
      },
      recordTypes: [],
      sourceCategories: [
        { category: "Apple Watch", count: 3 },
        { category: "Manual", count: 1 }
      ],
      sessionStatuses: [],
      missingReasons: [],
      issues: []
    }));

    render(<MemoryRouter><DataAuditPage /></MemoryRouter>);

    expect(screen.getByText("75.0%", { selector: ".audit-source-table span" })).toBeTruthy();
    expect(screen.getByText("25.0%", { selector: ".audit-source-table span" })).toBeTruthy();
    expect(screen.getByText("4 Workouts")).toBeTruthy();
    expect(screen.getByText("82.0%", { selector: ".audit-overview b" })).toBeTruthy();
    expect(screen.getByText("数据完整性：82.0%", { selector: ".audit-health-bar span" })).toBeTruthy();
  });

  it("shows prediction uncertainty, method, fallback reason, and report guidance", () => {
    useRemoteMock.mockReturnValue(remote({
      generatedAt: "2026-07-17T00:00:00.000Z",
      inputs: {
        recoveryReadiness: 0.7,
        performanceVdotEvidence: 2,
        lactateThresholdSegments: 0,
        labeledRaceOutcomes: 0,
        directVo2Evidence: 0
      },
      modelSelection: {
        machineLearning: {
          status: "inference_unavailable",
          activeModelVersion: null,
          featureSchemaVersion: null,
          trainedExampleCount: 0,
          evaluatedOutcomeCount: 0,
          meanAbsoluteErrorImprovement: null
        }
      },
      guidanceCodes: ["prediction_confidence_low"],
      labelFunnel: {
        sessionCount: 268, confirmedCount: 0, usableOutcomeCount: 0,
        evaluatedOutcomeCount: 0, primaryRejections: { not_confirmed: 268 },
        accuracyStatus: "not_evaluable"
      },
      snapshot: {
        modelVersion: "rai-test-v1",
        vo2Max: { valueMlKgMin: 45, confidence: 0.6 },
        performanceVdot: { value: 44 },
        lactateThreshold: { paceSecondsPerKm: 300, heartRateBpm: 170 },
        races: [{
          distance: "five_k",
          status: "available",
          potentialSeconds: 1200,
          predictedSeconds: 1260,
          readiness: 0.7,
          confidence: 0.55,
          optimisticSeconds: 1200,
          pessimisticSeconds: 1320,
          method: "daniels_vdot_conditions_v3",
          machineLearningFallbackReason: "inference_failed"
        }]
      }
    }));

    render(<MemoryRouter><PredictionsPage /></MemoryRouter>);

    expect(screen.getByText("VDOT + 场景修正")).toBeTruthy();
    expect(screen.getByText("55%")).toBeTruthy();
    expect(screen.getByText("20:00 至 22:00")).toBeTruthy();
    expect(screen.getByText("机器学习推理失败，本距离已回退到公式基线。")).toBeTruthy();
    expect(screen.getByText(/请把区间而不是单一点值作为主要参考/)).toBeTruthy();
    expect(screen.getByText("参考区间（非 P80/P90 保证）")).toBeTruthy();
    expect(screen.getByText("尚无合格标签，不能证明预测准确率或激活精度增强。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看训练并确认已有结果" }).getAttribute("href")).toBe("/workouts");
    expect(screen.getByText("未确认标准测试或比赛：268")).toBeTruthy();
  });

  it("does not show a cached workout preview while a different path is loading", () => {
    useRemoteMock.mockReturnValue(remote({
      total: 1,
      items: [{ id: "stale-workout" }]
    }, {
      dataPath: "/v1/workouts?limit=30&offset=30",
      loading: true
    }));

    render(<MemoryRouter initialEntries={["/workouts"]}><WorkoutsPage /></MemoryRouter>);

    expect(screen.queryByRole("link", { name: /查看训练详情/ })).toBeNull();
    expect(screen.getByText(/筛选结果将在这里显示速览/)).toBeTruthy();
  });

  it("preserves workout filters and pagination when opening the preview detail", () => {
    useRemoteMock.mockReturnValue(remote({
      total: 60,
      items: [{
        id: "workout-31",
        startedAt: "2026-07-17T00:00:00.000Z",
        durationSeconds: 3600,
        distanceKm: 10,
        averagePaceSecondsPerKm: 360,
        averageHeartRateBpm: 150,
        indoor: false,
        sourceCategory: "apple_watch",
        sessionType: "easy",
        stimulusType: "aerobic_base",
        stimulusConfidence: 0.8,
        currentAbility: 42,
        confidence: 0.9,
        assessmentStatus: "eligible",
        eligibilityStatus: "eligible",
        missingReasons: [],
        hasRoute: true
      }]
    }, {
      dataPath: "/v1/workouts?status=eligible&offset=30&limit=30"
    }));

    const view = render(
      <MemoryRouter initialEntries={["/workouts?status=eligible&offset=30"]}>
        <Routes>
          <Route path="/workouts" element={<WorkoutsPage />} />
          <Route path="/workouts/:id" element={<LocationStateProbe />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(view.container.querySelector<HTMLAnchorElement>(".workout-preview-panel a")!);

    expect(screen.getByTestId("return-to").textContent).toBe("/workouts?status=eligible&offset=30");
  });
});
