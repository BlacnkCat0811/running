import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
  WorkoutMetricSeries,
  WorkoutSegment,
  WorkoutSegmentPlanMatch,
  WorkoutSeriesResponse
} from "@rai/api-contracts";

import { WorkoutSegments } from "../src/pages/WorkoutDetailPage.js";

/**
 * The segment panel makes two different kinds of statement and they must not be
 * confused:
 *   - with a matched plan, each row may carry the step's *intent* (热身/训练/…);
 *   - without one, the only honest thing known is the lap boundary itself.
 *
 * Regression: the no-plan lane tags every segment `unplanned`, and rendering
 * that as "自由训练" claimed a session type nobody recorded.
 */
const emptyMetric: WorkoutMetricSeries = { unit: "bpm", totalSamples: 0, points: [] };

const series = (overrides: Partial<WorkoutSeriesResponse> = {}): WorkoutSeriesResponse => ({
  trainingSessionId: "training_session_fixture",
  startedAt: "2026-09-14T11:20:00.000Z",
  endedAt: "2026-09-14T11:59:10.000Z",
  sourceCategory: "apple_watch",
  splits: [],
  segments: [],
  segmentPlan: null,
  segmentNote: null,
  series: {
    heartRate: emptyMetric,
    speed: emptyMetric,
    power: emptyMetric,
    cadence: emptyMetric,
    elevation: emptyMetric,
    strideLength: emptyMetric,
    verticalOscillation: emptyMetric,
    groundContactTime: emptyMetric
  },
  ...overrides
});

const segment = (overrides: Partial<WorkoutSegment> = {}): WorkoutSegment => ({
  index: 1,
  label: "训练",
  purpose: "work",
  goalType: "distance",
  goalMeters: 2600,
  goalSeconds: null,
  alertKind: "pace",
  alertLower: 423,
  alertUpper: 380,
  startOffsetSeconds: 300,
  durationSeconds: 981,
  distanceMeters: 2600,
  averagePaceSecondsPerKm: 377,
  averageHeartRateBpm: 162,
  averageCadenceSpm: 172,
  ...overrides
});

const matchedPlan: WorkoutSegmentPlanMatch = {
  localDate: "2026-09-15",
  kind: "interval",
  revision: 6,
  matchedBy: "plan_history",
  plannedDistanceKm: 4.2,
  explainedFraction: 0.67,
  reason: "按课表结构回放"
};

describe("课表分段面板", () => {
  afterEach(cleanup);

  it("匹配到课表时，把该步的意图作为标签显示", () => {
    const { container } = render(
      <WorkoutSegments series={series({ segments: [segment()], segmentPlan: matchedPlan, segmentNote: "分段由课表结构回放得到" })} />
    );

    expect(screen.getByText("训练", { selector: "small.segment-purpose" })).toBeTruthy();
    expect(container.querySelector(".purpose-work")).toBeTruthy();
    // The matched-plan line is what makes the chips above a claim someone can check.
    expect(screen.getByText("2026-09-15")).toBeTruthy();
  });

  it("没有匹配到课表时，不渲染意图标签（lap 不等于自由训练）", () => {
    const { container } = render(
      <WorkoutSegments
        series={series({
          segments: [
            segment({
              label: "第 1 段",
              purpose: "unplanned",
              goalType: null,
              goalMeters: null,
              alertKind: null,
              alertLower: null,
              alertUpper: null
            })
          ],
          segmentPlan: null,
          segmentNote: "分段取自手表记录的 lap/segment 事件（2 段），未匹配到课表"
        })}
      />
    );

    // The row still says everything that is actually known.
    expect(screen.getByText("第 1 段")).toBeTruthy();
    expect(container.querySelector(".segment-purpose")).toBeNull();
    expect(screen.queryByText("自由训练")).toBeNull();
    // …and the note explains why there is no label.
    expect(screen.getByText(/未匹配到课表/)).toBeTruthy();
  });

  it("没有分段时自述原因，不留空白面板", () => {
    render(
      <WorkoutSegments
        series={series({ segments: [], segmentNote: "这次训练没有手表 lap/segment 事件，也没有可匹配的课表，只能按公里分段" })}
      />
    );

    expect(screen.getAllByText("课表分段").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/没有手表 lap\/segment 事件/).length
    ).toBeGreaterThan(0);
    expect(screen.getByText("0 段")).toBeTruthy();
  });
});
