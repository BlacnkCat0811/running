import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkoutEnvironmentView, WorkoutSplit, WorkoutSplitGrade } from "@rai/api-contracts";

import { WorkoutEnvironmentPanel, WorkoutSplits } from "../src/pages/WorkoutDetailPage.js";

/**
 * The environment read-out has one job that is easy to get wrong: **unknown is not
 * zero**. A capture without weather must not render like a run at reference
 * conditions, and a run with partial data must not show a partial penalty as if it
 * were the whole correction.
 */
afterEach(cleanup);

const environment = (overrides: Partial<WorkoutEnvironmentView> = {}): WorkoutEnvironmentView => ({
  policyVersion: "rai-environment-view-v1",
  adapterVersion: "rai-physiology-v1.8.0:conditions-v1",
  status: "applied",
  source: "workout_metadata",
  temperatureC: 30,
  humidityPercent: 80,
  elevationGainMeters: 100,
  correction: { environment: 0.04, elevation: 0.035, total: 0.075 },
  adjusted: { durationSeconds: 3348.8, paceSecondsPerKm: 334.9 },
  reasonCodes: ["heat_humidity_adjustment", "elevation_adjustment"],
  ...overrides
});

const grade = (overrides: Partial<WorkoutSplitGrade> = {}): WorkoutSplitGrade => ({
  elevationChangeMeters: 12.5,
  gainMeters: 14,
  lossMeters: 1.5,
  gradePercent: 1.25,
  gradeAdjustedPaceSecondsPerKm: 297.4,
  policyVersion: "rai-grade-adjustment-v1",
  reasonCodes: [],
  ...overrides
});

const split = (overrides: Partial<WorkoutSplit> = {}): WorkoutSplit => ({
  index: 1,
  distanceMeters: 1000,
  durationSeconds: 300,
  averagePaceSecondsPerKm: 300,
  averageHeartRateBpm: 150,
  averageCadenceSpm: 178,
  grade: grade(),
  ...overrides
});

describe("environment panel", () => {
  it("N01: shows the applied correction, the raw conditions and the equivalent pace", () => {
    render(<WorkoutEnvironmentPanel environment={environment()} />);
    expect(screen.getByText("已按环境条件修正")).toBeTruthy();
    expect(screen.getByText("30.0 °C")).toBeTruthy();
    expect(screen.getByText("80 %")).toBeTruthy();
    expect(screen.getByText("7.5 %")).toBeTruthy();
    expect(screen.getByText("含高温/高湿修正")).toBeTruthy();
    expect(screen.getByText("含爬升修正")).toBeTruthy();
  });

  it("N01: an unavailable correction names the missing field and never shows a zero penalty", () => {
    render(
      <WorkoutEnvironmentPanel
        environment={environment({
          status: "unavailable",
          elevationGainMeters: null,
          correction: null,
          adjusted: null,
          reasonCodes: ["elevation_missing"]
        })}
      />
    );
    expect(screen.getByText("环境数据不足，未修正")).toBeTruthy();
    expect(screen.getByText("缺少爬升")).toBeTruthy();
    // Two dashes: 修正量 and 等效用时/等效配速 have no value to show.
    expect(screen.queryByText("0.0 %")).toBeNull();
    expect(screen.getAllByText("--").length).toBeGreaterThan(0);
    expect(screen.getByText(/环境数据不完整，因此本次不做修正/)).toBeTruthy();
  });

  it("N01: a reference-conditions run says so explicitly instead of staying blank", () => {
    render(
      <WorkoutEnvironmentPanel
        environment={environment({
          status: "not_needed",
          temperatureC: 15,
          humidityPercent: 50,
          elevationGainMeters: 0,
          correction: { environment: 0, elevation: 0, total: 0 },
          adjusted: { durationSeconds: 3000, paceSecondsPerKm: 300 },
          reasonCodes: ["reference_conditions"]
        })}
      />
    );
    expect(screen.getByText("参考条件，无需修正")).toBeTruthy();
    expect(screen.getByText("处于参考条件内")).toBeTruthy();
    expect(screen.getByText("0.0 %")).toBeTruthy();
  });

  it("N01: a null view says why rather than rendering an empty correction", () => {
    render(<WorkoutEnvironmentPanel environment={null} />);
    expect(screen.getByText(/缺少可用于归一化的距离或时长/)).toBeTruthy();
  });
});

describe("splits with grade", () => {
  it("N02: grade columns appear only when a split actually has altitude", () => {
    const { unmount } = render(
      <WorkoutSplits
        splits={[split()]}
        grade={{
          policyVersion: "rai-grade-adjustment-v1",
          coveredSplits: 1,
          totalSplits: 1,
          gainMeters: 14,
          lossMeters: 1.5,
          gradeAdjustedPaceSecondsPerKm: 297.4,
          reasonCodes: []
        }}
      />
    );
    expect(screen.getByText("等强配速（全程加权）")).toBeTruthy();
    expect(screen.getByText("+1.3%")).toBeTruthy();
    unmount();

    // No altitude anywhere: the columns must disappear rather than claim "flat".
    render(
      <WorkoutSplits
        splits={[split({ grade: grade({ gradePercent: null, gradeAdjustedPaceSecondsPerKm: null, reasonCodes: ["elevation_samples_insufficient"] }) })]}
        grade={{
          policyVersion: "rai-grade-adjustment-v1",
          coveredSplits: 0,
          totalSplits: 1,
          gainMeters: null,
          lossMeters: null,
          gradeAdjustedPaceSecondsPerKm: null,
          reasonCodes: ["no_split_with_elevation"]
        }}
      />
    );
    expect(screen.queryByText("等强配速（全程加权）")).toBeNull();
    expect(screen.getByText(/没有任何分段带海拔数据/)).toBeTruthy();
  });

  it("N03: an unknown split grade renders as -- instead of 0.0%", () => {
    render(
      <WorkoutSplits
        splits={[
          split({ index: 1, grade: grade() }),
          split({
            index: 2,
            grade: grade({ gradePercent: null, gradeAdjustedPaceSecondsPerKm: null, reasonCodes: ["elevation_samples_insufficient"] })
          })
        ]}
        grade={{
          policyVersion: "rai-grade-adjustment-v1",
          coveredSplits: 1,
          totalSplits: 2,
          gainMeters: 14,
          lossMeters: 1.5,
          gradeAdjustedPaceSecondsPerKm: 297.4,
          reasonCodes: ["partial_elevation_coverage"]
        }}
      />
    );
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.getAllByText("--").length).toBeGreaterThanOrEqual(2);
  });
});
