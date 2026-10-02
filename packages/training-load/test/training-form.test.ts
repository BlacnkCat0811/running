import assert from "node:assert/strict";
import test from "node:test";

import type { DailyTrainingMetric, SessionType } from "@rai/contracts";

import {
  RECOVERY_TIME_POLICY_VERSION,
  classifyTrainingForm,
  estimateRecoveryTime,
  withTrainingForm,
  type RecentLoadInput
} from "../src/index.js";

const metric = (overrides: Partial<DailyTrainingMetric> = {}): DailyTrainingMetric => ({
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
  ...overrides
});

test("L05: the form curve is additive — every persisted field survives untouched", () => {
  const day = metric();
  const [withForm] = withTrainingForm([day]);
  assert.ok(withForm);
  const { form, formRatio, formStatus, ...persisted } = withForm;
  assert.deepEqual(persisted, day, "a read-time curve must not rewrite the stored daily metric");
  assert.equal(form, 8, "form is chronicEwma - acuteEwma in load units");
  assert.equal(formRatio, 0.16);
  assert.equal(formStatus, "fresh");
});

test("L05: absent or zero chronic load is insufficient_data, not a neutral form", () => {
  for (const day of [metric({ chronicEwma: 0 }), metric({ chronicEwma: Number.NaN })]) {
    const [row] = withTrainingForm([day]);
    assert.equal(row?.form, null);
    assert.equal(row?.formRatio, null);
    assert.equal(row?.formStatus, "insufficient_data");
  }
});

test("L05: form bands sit on named boundaries and are exclusive at the edge", () => {
  assert.equal(classifyTrainingForm(null), "insufficient_data");
  assert.equal(classifyTrainingForm(0.26), "transition");
  assert.equal(classifyTrainingForm(0.25), "fresh", "the boundary belongs to the lower band");
  assert.equal(classifyTrainingForm(0.06), "fresh");
  assert.equal(classifyTrainingForm(0.05), "neutral");
  assert.equal(classifyTrainingForm(0), "neutral");
  assert.equal(classifyTrainingForm(-0.1), "loaded");
  assert.equal(classifyTrainingForm(-0.3), "overreached");
  assert.equal(classifyTrainingForm(-0.31), "overreached");
});

test("L05: a deep acute excess reads overreached, not merely loaded", () => {
  const [row] = withTrainingForm([metric({ acuteEwma: 80, chronicEwma: 50 })]);
  assert.equal(row?.form, -30);
  assert.equal(row?.formRatio, -0.6);
  assert.equal(row?.formStatus, "overreached");
});

const load = (overrides: Partial<RecentLoadInput> = {}): RecentLoadInput => ({
  trainingSessionId: "session_1",
  localDate: "2026-10-01",
  endedAt: "2026-10-01T10:00:00.000Z",
  load: 60,
  sessionType: "tempo" as SessionType,
  confidence: 0.9,
  ...overrides
});

const NOW = new Date("2026-10-01T16:00:00.000Z");

test("L06: with no finished session the estimate is insufficient, never zero hours", () => {
  const result = estimateRecoveryTime({ now: NOW, recentLoads: [], chronicEwma: 50 });
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.remainingHours, null, "unknown recovery must not render as ready now");
  assert.equal(result.readyAt, null);
  assert.equal(result.anchor, null);
  assert.deepEqual(result.basisCodes, ["no_finished_session_with_load"]);
  assert.equal(result.isLoadProxy, true);
  assert.equal(result.policyVersion, RECOVERY_TIME_POLICY_VERSION);
});

test("L06: a session still in progress is not a recovery anchor", () => {
  const future = load({ endedAt: "2026-10-01T18:00:00.000Z" });
  const result = estimateRecoveryTime({ now: NOW, recentLoads: [future], chronicEwma: 50 });
  assert.equal(result.status, "insufficient_data");
});

test("L06: without chronic context the estimate refuses rather than guessing a baseline", () => {
  const result = estimateRecoveryTime({ now: NOW, recentLoads: [load()], chronicEwma: 0 });
  assert.equal(result.status, "insufficient_data");
  assert.deepEqual(result.basisCodes, ["no_chronic_load_context"]);
  assert.equal(result.anchor?.trainingSessionId, "session_1", "the anchor is still reported");
});

test("L06: elapsed time reduces the remaining window, and it can reach zero", () => {
  const fresh = estimateRecoveryTime({ now: NOW, recentLoads: [load()], chronicEwma: 60 });
  // tempo base 30 h × relative 1.0 = 30 h; 6 h have elapsed since the session ended.
  assert.equal(fresh.remainingHours, 24);
  assert.equal(fresh.readyAt, "2026-10-02T16:00:00.000Z");

  const stale = estimateRecoveryTime({
    now: new Date("2026-10-03T10:00:00.000Z"),
    recentLoads: [load()],
    chronicEwma: 60
  });
  assert.equal(stale.remainingHours, 0);
  assert.ok(stale.basisCodes.includes("recovery_window_elapsed"));
});

test("L06: a bigger session relative to chronic load lengthens the estimate, and is capped", () => {
  const light = estimateRecoveryTime({ now: NOW, recentLoads: [load({ load: 30 })], chronicEwma: 60 });
  const heavy = estimateRecoveryTime({ now: NOW, recentLoads: [load({ load: 120 })], chronicEwma: 60 });
  const capped = estimateRecoveryTime({ now: NOW, recentLoads: [load({ load: 240 })], chronicEwma: 60 });
  const extreme = estimateRecoveryTime({ now: NOW, recentLoads: [load({ load: 900, sessionType: "race" })], chronicEwma: 20 });
  assert.ok(light.remainingHours !== null && heavy.remainingHours !== null && extreme.remainingHours !== null);
  assert.ok(light.remainingHours! < heavy.remainingHours!);
  assert.ok(extreme.remainingHours! <= 96, "the estimate is capped at the policy maximum");
  // 4× the chronic load hits the relative-load ceiling; the number must stop growing there.
  assert.ok(capped.basisCodes.includes("relative_load_capped"));
  assert.equal(capped.remainingHours, heavy.remainingHours === null ? null : capped.remainingHours);
  assert.ok(extreme.basisCodes.includes("recovery_capped_at_maximum"));
});

test("L06: the session type sets the base window", () => {
  const easy = estimateRecoveryTime({ now: NOW, recentLoads: [load({ sessionType: "easy" as SessionType })], chronicEwma: 30 });
  const race = estimateRecoveryTime({ now: NOW, recentLoads: [load({ sessionType: "race" as SessionType })], chronicEwma: 30 });
  assert.ok(easy.remainingHours !== null && race.remainingHours !== null);
  assert.ok(race.remainingHours! > easy.remainingHours!);
});

test("L06: readiness may lengthen the estimate, and says so when consulted", () => {
  const base = estimateRecoveryTime({ now: NOW, recentLoads: [load()], chronicEwma: 60 });
  const strained = estimateRecoveryTime({ now: NOW, recentLoads: [load()], chronicEwma: 60, physState: "strained" });
  assert.ok(base.remainingHours !== null && strained.remainingHours !== null);
  assert.ok(strained.remainingHours! > base.remainingHours!);
  assert.ok(strained.basisCodes.includes("readiness_strained_multiplier"));
  // No caller passes physState yet (§9.6 note): the default path must be explicit
  // about being a load-only estimate rather than looking like a full assessment.
  assert.ok(base.basisCodes.includes("load_proxy_not_measurement"));
  assert.ok(!base.basisCodes.includes("readiness_strained_multiplier"));
});

test("L06: the newest finished session anchors the estimate when several are in the window", () => {
  const result = estimateRecoveryTime({
    now: NOW,
    chronicEwma: 60,
    recentLoads: [
      load({ trainingSessionId: "old", endedAt: "2026-09-30T10:00:00.000Z", load: 90 }),
      load({ trainingSessionId: "new", endedAt: "2026-10-01T13:00:00.000Z", load: 20, sessionType: "easy" as SessionType })
    ]
  });
  assert.equal(result.anchor?.trainingSessionId, "new");
  // easy 12 h × the 0.5 relative-load floor = 6 h; the newest session ended 3 h ago.
  assert.equal(result.remainingHours, 3);
  assert.ok(result.basisCodes.includes("load_proxy_not_measurement"));
});

test("L06: low load confidence is reported instead of silently trusted", () => {
  const result = estimateRecoveryTime({ now: NOW, recentLoads: [load({ confidence: 0.3 })], chronicEwma: 60 });
  assert.ok(result.basisCodes.includes("low_load_confidence"));
  assert.equal(result.confidence, 0.3);
});
