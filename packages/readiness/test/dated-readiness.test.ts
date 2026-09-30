import assert from "node:assert/strict";
import test from "node:test";
import { assessDatedReadiness, type DatedRecoverySignal, legacyRecoveryBackground } from "../src/index.js";

const day = "2026-09-29";
function signal(value = 100, date = day): DatedRecoverySignal {
  return {
    value, baseline: 100, localDate: date,
    observedAt: `${date}T00:00:00Z`, availableAt: `${date}T01:00:00Z`
  };
}
const input = () => ({
  asOf: `${day}T08:00:00Z`, localDate: day,
  signals: { sleep: signal(), hrv: signal(), rhr: signal() },
  nights: [] as DatedRecoverySignal[]
});

test("R02: dated readiness cannot wash stale sleep into today with fresh HRV", () => {
  const value = input();
  value.signals.sleep = signal(30, "2026-09-28");
  const result = assessDatedReadiness(value);
  assert.equal(result.coverage, "partial");
  assert.equal(result.assessment, "no_low_signal");
  assert.equal(result.signals.sleep.ratio, null);
  assert.equal(result.signals.sleep.evidenceLocalDate, "2026-09-28");
  assert.equal(result.stateEvidence.validationStatus, "not_empirically_validated");
});

test("future observations, late-arriving signals and unknown arrival times cannot affect state", () => {
  for (const clocks of [
    { observedAt: `${day}T09:00:00Z`, availableAt: `${day}T10:00:00Z` },
    { observedAt: `${day}T00:00:00Z`, availableAt: `${day}T10:00:00Z` },
    { observedAt: `${day}T00:00:00Z`, availableAt: null }
  ]) {
    const value = input();
    for (const name of ["sleep", "hrv", "rhr"] as const) {
      value.signals[name] = { ...signal(30), ...clocks };
    }
    const result = assessDatedReadiness(value);
    assert.equal(result.coverage, "none");
    assert.equal(result.assessment, "not_assessed");
  }
});

test("streak is consecutive canonical local dates, not count of nonadjacent low nights", () => {
  const value = input();
  value.nights = [signal(70), signal(70, "2026-09-27"), signal(70, "2026-09-26")];
  assert.equal(assessDatedReadiness(value).sleepStreak, false);
  value.nights = [signal(70), signal(70, "2026-09-28"), signal(70, "2026-09-27")];
  assert.equal(assessDatedReadiness(value).sleepStreak, true);
  value.nights.push(signal(70));
  assert.throws(() => assessDatedReadiness(value), /unique per date/);
});

test("invalid/zero measurements and absent references cannot inflate coverage", () => {
  for (const bad of [null, 0, -1, NaN, Infinity]) {
    const value = input();
    value.signals.sleep.value = bad;
    assert.equal(assessDatedReadiness(value).coverage, "partial");
  }
  assert.throws(() => assessDatedReadiness({ ...input(), asOf: "invalid" }), /valid asOf/);
});

test("recent background compatibility has one owner and never claims a calibrated daily score", () => {
  const result = legacyRecoveryBackground({
    sleepMinutes: 400, sleepBaselineMinutes: 500,
    hrvMs: 40, hrvBaselineMs: 50,
    rhrBpm: 60, rhrBaselineBpm: 54
  });
  assert.equal(result, (0.8 + 0.5 + 0.8) / 3);
  assert.equal(legacyRecoveryBackground({
    sleepMinutes: null, sleepBaselineMinutes: null, hrvMs: null,
    hrvBaselineMs: null, rhrBpm: null, rhrBaselineBpm: null
  }), null);
});
