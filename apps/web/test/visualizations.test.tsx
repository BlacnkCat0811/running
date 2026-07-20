import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import {
  trainingLoadAxisMaximum,
} from "../src/components/DashboardPerformanceChart.js";
import {
  buildKilometerMarks,
  MAX_ROUTE_KILOMETER_MARKS,
  RoutePlot,
} from "../src/components/RoutePlot.js";
import { confidenceHeightPercent } from "../src/pages/TrainingZonesPage.js";
import { activeTrendModelVersion } from "../src/components/AbilityChart.js";

describe("dashboard and route visualization calculations", () => {
  it("does not attribute workout ability points to an inactive model run", () => {
    expect(activeTrendModelVersion({
      startDate: "2026-07-01",
      endDate: "2026-07-17",
      daily: [],
      workouts: [],
      context: [],
      modelRuns: [
        { id: "newer-inactive", date: "2026-07-16", modelVersion: "candidate-v2", active: false },
      ],
    })).toBe("--");

    expect(activeTrendModelVersion({
      startDate: "2026-07-01",
      endDate: "2026-07-17",
      daily: [],
      workouts: [],
      context: [],
      modelRuns: [
        { id: "active", date: "2026-07-10", modelVersion: "active-v1", active: true },
        { id: "newer-inactive", date: "2026-07-16", modelVersion: "candidate-v2", active: false },
      ],
    })).toBe("active-v1");
  });

  it("expands the independent training-load axis beyond 100", () => {
    expect(trainingLoadAxisMaximum([
      { date: "2026-01-01", endurance: 80, intensity: 245, pace: 75 },
    ])).toBe(250);
    expect(trainingLoadAxisMaximum([
      { date: "2026-01-01", endurance: 80, intensity: 72, pace: 75 },
    ])).toBe(100);
  });

  it("maps zone confidence across the full zero-to-100-percent height", () => {
    expect(confidenceHeightPercent(0)).toBe(0);
    expect(confidenceHeightPercent(0.5)).toBe(50);
    expect(confidenceHeightPercent(1)).toBe(100);
    expect(confidenceHeightPercent(1.2)).toBe(100);
  });

  it("places every crossed kilometer along a sparse route segment", () => {
    const points = [
      { latitude: 0, longitude: 0, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
      { latitude: 0, longitude: 0.027, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
    ];

    const marks = buildKilometerMarks(points);

    expect(marks.map((mark) => mark.kilometer)).toEqual([1, 2, 3]);
    expect(marks[0]?.longitude).toBeGreaterThan(0);
    expect(marks[0]?.longitude).toBeLessThan(marks[1]?.longitude ?? 0);
    expect(marks[1]?.longitude).toBeLessThan(marks[2]?.longitude ?? 0);
    expect(marks[2]?.longitude).toBeLessThan(0.027);
  });

  it("rejects invalid GPS jumps and caps the total route marker count", () => {
    const invalid = buildKilometerMarks([
      { latitude: 91, longitude: 0, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
      { latitude: 0, longitude: 0.01, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
      { latitude: 0, longitude: 170, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
    ]);
    expect(invalid).toEqual([]);

    const longRoute = Array.from({ length: 31 }, (_, index) => ({
      latitude: index * 0.09,
      longitude: 0,
      elevationMeters: null,
      speedMetersPerSecond: null,
      timestamp: null,
    }));
    expect(buildKilometerMarks(longRoute)).toHaveLength(MAX_ROUTE_KILOMETER_MARKS);
    const view = render(<RoutePlot points={longRoute} />);
    expect(view.container.querySelectorAll("g")).toHaveLength(MAX_ROUTE_KILOMETER_MARKS + 2);
    view.unmount();
  });

  it("excludes implausible GPS jumps from route bounds and line segments", () => {
    const points = [
      { latitude: 0, longitude: 0, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
      { latitude: 0, longitude: 0.01, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
      { latitude: 0, longitude: 170, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
      { latitude: 0, longitude: 0.02, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
      { latitude: 0, longitude: 0.03, elevationMeters: null, speedMetersPerSecond: null, timestamp: null },
    ];

    const view = render(<RoutePlot points={points} />);
    const lines = view.container.querySelectorAll("line");

    expect(lines).toHaveLength(2);
    expect(Number(lines[0]?.getAttribute("x2"))).toBeGreaterThan(200);
    expect(Number(lines[1]?.getAttribute("x1"))).toBeGreaterThan(500);
    expect(Number(lines[1]?.getAttribute("x2"))).toBe(776);
    view.unmount();
  });
});
