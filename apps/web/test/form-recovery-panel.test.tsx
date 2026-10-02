import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RecoveryTimeEstimate, TrainingLoadTimelineDay } from "@rai/api-contracts";

import { FormRecoveryPanel } from "../src/pages/StatisticsPage.js";

/**
 * §9.6: the form curve and the recovery interval are both **load proxies**. The
 * panel exists to keep three failures out of the UI:
 *   - an extrapolated interval presented like the measured sleep/HRV numbers;
 *   - an empty history rendered as "balanced" instead of "not enough data";
 *   - a missing estimate rendered as zero hours ("you are ready").
 */
afterEach(cleanup);

const day = (overrides: Partial<TrainingLoadTimelineDay> = {}): TrainingLoadTimelineDay => ({
  localDate: "2026-10-01",
  distanceMeters: 10_000,
  durationSeconds: 3_000,
  workoutCount: 1,
  load: 40,
  current7dLoad: 200,
  previous7dLoad: 190,
  acuteEwma: 42,
  chronicEwma: 50,
  loadRatio: 0.84,
  rampRate: 0.05,
  monotony: 1.4,
  strain: 280,
  recoveryEvidence: null,
  trainingStatus: "maintaining",
  statusExplanations: [],
  loadConfidence: 0.9,
  form: 8,
  formRatio: 0.16,
  formStatus: "fresh",
  ...overrides
});

const estimate = (overrides: Partial<RecoveryTimeEstimate> = {}): RecoveryTimeEstimate => ({
  policyVersion: "rai-recovery-time-v1",
  status: "available",
  remainingHours: 24,
  readyAt: "2026-10-02T16:00:00.000Z",
  anchor: {
    trainingSessionId: "session_1",
    localDate: "2026-10-01",
    endedAt: "2026-10-01T10:00:00.000Z",
    load: 60,
    sessionType: "tempo"
  },
  basisCodes: ["load_proxy_not_measurement"],
  isLoadProxy: true,
  confidence: 0.9,
  ...overrides
});

describe("form and recovery panel", () => {
  it("L05: renders the form value, its ratio and the band label", () => {
    render(<FormRecoveryPanel day={day()} recovery={estimate()} />);
    expect(screen.getByText("+8.0（+16%）")).toBeTruthy();
    expect(screen.getByText("较新鲜")).toBeTruthy();
    expect(screen.getByText("rai-recovery-time-v1")).toBeTruthy();
  });

  it("L06: renders the remaining interval and refuses to call it a measurement", () => {
    render(<FormRecoveryPanel day={day()} recovery={estimate()} />);
    expect(screen.getByText("24 小时")).toBeTruthy();
    expect(screen.getByText("按负荷推算，非实测恢复状态")).toBeTruthy();
    expect(screen.getByText(/起点：2026-10-01 的节奏跑/)).toBeTruthy();
  });

  it("L06: an insufficient estimate says so instead of showing zero hours", () => {
    render(
      <FormRecoveryPanel
        day={day()}
        recovery={estimate({
          status: "insufficient_data",
          remainingHours: null,
          readyAt: null,
          anchor: null,
          basisCodes: ["no_finished_session_with_load"],
          confidence: null
        })}
      />
    );
    expect(screen.getByText("数据不足，不外推")).toBeTruthy();
    expect(screen.queryByText("0 小时")).toBeNull();
    expect(screen.getByText("没有已完成的训练可作为起点")).toBeTruthy();
  });

  it("L06: an elapsed window reads as ended, not as a fresh session", () => {
    render(<FormRecoveryPanel day={day()} recovery={estimate({ remainingHours: 0 })} />);
    expect(screen.getByText("已结束")).toBeTruthy();
    expect(screen.getByText("现在即可安排质量课")).toBeTruthy();
  });

  it("L05: an empty history shows insufficient data rather than a neutral form", () => {
    render(<FormRecoveryPanel day={day({ form: null, formRatio: null, formStatus: "insufficient_data" })} recovery={estimate()} />);
    // Both the value and the band say "not enough data": an empty history must not
    // render as the neutral band.
    expect(screen.getAllByText("数据不足").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("负荷平衡")).toBeNull();
  });
});
