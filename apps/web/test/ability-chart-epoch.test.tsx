import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import {
  AbilityChart,
  trendCalibratingRanges,
  trendChartSeries,
  trendEpochBoundaries,
  trendEpochSegments
} from "../src/components/AbilityChart.js";

// vitest.config.ts 未开 globals / setupFiles，没有自动 DOM 清理。
afterEach(cleanup);

type Daily = Array<{ date: string; baselineEpochId?: string | null; trueAbility: number | null; decayPoints: number; growthVelocityPerWeek: number | null; status: string }>;

const daily = (): Daily => [
  { date: "2026-01-01", baselineEpochId: "epoch-a", trueAbility: 50, decayPoints: 0, growthVelocityPerWeek: null, status: "active" },
  { date: "2026-01-02", baselineEpochId: "epoch-a", trueAbility: 51, decayPoints: 0, growthVelocityPerWeek: null, status: "active" },
  { date: "2026-01-03", baselineEpochId: "epoch-b", trueAbility: 46, decayPoints: 0, growthVelocityPerWeek: null, status: "calibrating" },
  { date: "2026-01-04", baselineEpochId: "epoch-b", trueAbility: 47, decayPoints: 0, growthVelocityPerWeek: null, status: "calibrating" },
  { date: "2026-01-05", baselineEpochId: "epoch-b", trueAbility: 48, decayPoints: 0, growthVelocityPerWeek: null, status: "active" }
];

const trend = (points: Daily) => ({
  startDate: points[0]?.date ?? null,
  endDate: points.at(-1)?.date ?? null,
  daily: points,
  workouts: [],
  context: [],
  modelRuns: []
});

describe("ability trend epoch segmentation", () => {
  it("B02/D5: breaks the TA line at an epoch change instead of joining two scales", () => {
    const series = trendChartSeries(daily());
    expect(series.map((point) => point.ta)).toEqual([50, 51, null, 47, 48]);
    // 断点是新 epoch 的第一天，而不是"前一天"：错位一天会让读者以为旧标尺还多撑了一天。
    expect(series[2]?.date).toBe("2026-01-03");
  });

  it("D5: reports one boundary and two segments for a two-epoch curve", () => {
    expect(trendEpochBoundaries(daily())).toEqual(["2026-01-03"]);
    expect(trendEpochSegments(daily())).toEqual([
      { epochId: "epoch-a", start: "2026-01-01", end: "2026-01-02" },
      { epochId: "epoch-b", start: "2026-01-03", end: "2026-01-05" }
    ]);
    // 单 epoch 曲线没有断点，也就没有"标尺已变"的提示。
    expect(trendEpochBoundaries(daily().slice(0, 2))).toEqual([]);
  });

  it("D5: an unknown epoch is its own segment, never merged into the previous one", () => {
    // `null` 表示"这条记录没有可用 epoch"。把它并进上一段，等于用一个不知道的标尺
    // 去延续一条已知标尺的曲线。
    const segments = trendEpochSegments([
      { date: "2026-02-01", baselineEpochId: "epoch-a", trueAbility: 50, decayPoints: 0, growthVelocityPerWeek: null, status: "active" },
      { date: "2026-02-02", baselineEpochId: null, trueAbility: 52, decayPoints: 0, growthVelocityPerWeek: null, status: "active" },
      { date: "2026-02-03", baselineEpochId: null, trueAbility: 53, decayPoints: 0, growthVelocityPerWeek: null, status: "active" }
    ]);
    expect(segments).toEqual([
      { epochId: "epoch-a", start: "2026-02-01", end: "2026-02-01" },
      { epochId: null, start: "2026-02-02", end: "2026-02-03" }
    ]);
    expect(trendEpochBoundaries([
      { date: "2026-02-01", baselineEpochId: "epoch-a", trueAbility: 50, decayPoints: 0, growthVelocityPerWeek: null, status: "active" },
      { date: "2026-02-02", baselineEpochId: null, trueAbility: 52, decayPoints: 0, growthVelocityPerWeek: null, status: "active" }
    ])).toEqual(["2026-02-02"]);
  });

  it("D5: shades the re-calibration window separately from steady state", () => {
    expect(trendCalibratingRanges(daily())).toEqual([{ start: "2026-01-03", end: "2026-01-04" }]);
    // 非连续的校准日不能被并成一段连续区间。
    expect(trendCalibratingRanges([
      { date: "2026-03-01", trueAbility: 50, decayPoints: 0, growthVelocityPerWeek: null, status: "calibrating" },
      { date: "2026-03-02", trueAbility: 50, decayPoints: 0, growthVelocityPerWeek: null, status: "active" },
      { date: "2026-03-06", trueAbility: 50, decayPoints: 0, growthVelocityPerWeek: null, status: "calibrating" }
    ])).toEqual([{ start: "2026-03-01", end: "2026-03-01" }, { start: "2026-03-06", end: "2026-03-06" }]);
  });

  it("B04/D5: the chart states that two epochs are not directly comparable", () => {
    const view = render(<MemoryRouter><AbilityChart trend={trend(daily())} /></MemoryRouter>);
    expect(screen.getByText(/此处基线重建（2026-01-03）/)).toBeTruthy();
    expect(screen.getByText(/两侧不可直接比较/)).toBeTruthy();
    expect(screen.getByText(/重新校准期（2026-01-03 至 2026-01-04）/)).toBeTruthy();
    view.unmount();
  });

  it("D5: a single-epoch curve carries no scale-change claim", () => {
    render(<MemoryRouter><AbilityChart trend={trend(daily().slice(0, 2))} /></MemoryRouter>);
    expect(screen.queryByText(/此处基线重建/)).toBeNull();
    expect(screen.queryByText(/重新校准期/)).toBeNull();
  });
});
