import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RunningDynamicsAnalysis, RunningDynamicsMetricAnalysis } from "@rai/api-contracts";

import { WorkoutDynamicsPanel } from "../src/pages/WorkoutDetailPage.js";

/**
 * Y01–Y03 on the rendering side: an average without its coverage, a pace change
 * dressed as a form change, and a missing metric rendered as zero.
 */
afterEach(cleanup);

const metric = (overrides: Partial<RunningDynamicsMetricAnalysis> = {}): RunningDynamicsMetricAnalysis => ({
  name: "cadence",
  label: "步频",
  unit: "spm",
  status: "available",
  samples: 120,
  coverage: 0.98,
  average: 178,
  firstHalfAverage: 180,
  secondHalfAverage: 171,
  driftFraction: -0.05,
  comparableSamples: 40,
  reasonCodes: [],
  ...overrides
});

const analysis = (overrides: Partial<RunningDynamicsAnalysis> = {}): RunningDynamicsAnalysis => ({
  policyVersion: "rai-dynamics-v1",
  evidenceStatus: "device_estimated_not_lab_validated",
  metrics: [metric()],
  flags: [],
  note: null,
  ...overrides
});

describe("stride dynamics panel", () => {
  it("Y01: every average is shown next to its coverage and sample count", () => {
    render(<WorkoutDynamicsPanel dynamics={analysis()} />);
    expect(screen.getByText("178 spm")).toBeTruthy();
    expect(screen.getByText("覆盖 98% · 120 样本")).toBeTruthy();
    expect(screen.getByText("后半程 -5.0%")).toBeTruthy();
  });

  it("Y02: a metric without comparable speed says so instead of showing a drift", () => {
    render(
      <WorkoutDynamicsPanel
        dynamics={analysis({
          metrics: [
            metric({
              status: "partial",
              driftFraction: null,
              firstHalfAverage: null,
              secondHalfAverage: null,
              reasonCodes: ["no_speed_matched_pairs"]
            })
          ],
          note: "部分指标覆盖不足，只展示可用部分。"
        })}
      />
    );
    expect(screen.getByText("无同配速对比")).toBeTruthy();
    expect(screen.getByText("后半程没有可配对的同配速样本")).toBeTruthy();
    expect(screen.queryByText(/后半程 -/)).toBeNull();
  });

  it("Y03: a run with no recorded dynamics shows the reason, not dashes with zero drift", () => {
    render(
      <WorkoutDynamicsPanel
        dynamics={analysis({
          metrics: [metric({ status: "unavailable", samples: 0, coverage: 0, average: null, driftFraction: null, reasonCodes: ["no_samples"] })],
          note: "这次训练没有任何跑姿动态样本（手表未记录或未同步）。"
        })}
      />
    );
    expect(screen.getByText("这次训练没有任何跑姿动态样本（手表未记录或未同步）。")).toBeTruthy();
    expect(screen.queryByText("0 spm")).toBeNull();
  });

  it("Y02: a flagged drift is listed with its comparable-sample count", () => {
    render(
      <WorkoutDynamicsPanel
        dynamics={analysis({
          flags: [
            {
              code: "cadence_drift",
              metric: "cadence",
              detail: "步频在后半程同配速下下降 5.0%",
              driftFraction: -0.05,
              comparableSamples: 40
            }
          ]
        })}
      />
    );
    expect(screen.getByText("步频在后半程同配速下下降 5.0%")).toBeTruthy();
    expect(screen.getByText("（同配速样本 40 个）")).toBeTruthy();
  });
});
