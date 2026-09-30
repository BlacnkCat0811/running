import assert from "node:assert/strict";
import test from "node:test";

import { READINESS_MODEL_VERSION, type ModelLineageV2 } from "@rai/contracts";

import { assessReadiness, withReadinessLineage, type ReadinessInput } from "../src/index.js";

const baseline: ReadinessInput = {
  asOf: "2026-09-03T08:00:00.000Z",
  localDate: "2026-09-03",
  evidenceLocalDate: "2026-09-03",
  evidenceStatus: "valid",
  sleepMinutes: 430,
  sleepBaselineMinutes: 430,
  nightsBelowSleepBaseline: 0,
  hrvMs: 52,
  hrvBaselineMs: 52,
  restingHeartRateBpm: 53,
  restingHeartRateBaselineBpm: 53,
  observedAt: null,
  availableAt: null
};

const lineage: ModelLineageV2 = {
  sourceRunId: "run_1",
  datasetVersion: "dataset-v1",
  factsSnapshotHash: "facts",
  overrideSnapshotHash: "overrides",
  modelVersion: READINESS_MODEL_VERSION,
  featureSchemaVersion: "workout-feature-v3",
  configVersion: "rai-readiness-v1.0.0",
  configHash: "config",
  calibrationCohortHash: null,
  baselineEpochId: null,
  normalizationVersion: null,
  normalizationConfigHash: null,
  timezoneIdentifier: "Asia/Shanghai",
  asOf: "2026-09-03T08:00:00.000Z",
  dataThroughAt: "2026-09-03T00:00:00.000Z"
};

test("a complete, on-baseline day is reported as no low signal with complete coverage", () => {
  const result = assessReadiness(baseline);
  assert.equal(result.coverage, "complete");
  assert.equal(result.assessment, "no_low_signal");
  assert.equal(result.state, "no_low_signal");
  assert.deepEqual(result.reasonCodes, ["no_low_signal"]);
  assert.equal(result.modelVersion, READINESS_MODEL_VERSION);
});

test("each signal keeps its own ratio so a single bad night is attributable", () => {
  const result = assessReadiness({ ...baseline, sleepMinutes: 300 });
  assert.equal(result.signals.sleep.ratio, 300 / 430);
  assert.equal(result.signals.sleep.low, true);
  assert.equal(result.signals.hrv.low, false);
  assert.equal(result.signals.rhr.low, false);
  assert.deepEqual(result.reasonCodes, ["sleep"]);
  assert.equal(result.assessment, "low_signal");
  assert.equal(result.state, "caution");
});

test("the sleep streak rule reports itself rather than being folded into a single night", () => {
  const result = assessReadiness({ ...baseline, nightsBelowSleepBaseline: 3 });
  assert.equal(result.sleepStreak, true);
  assert.deepEqual(result.reasonCodes, ["sleep_streak"]);
  assert.equal(result.assessment, "multiple_low_signals");
});

test("a missing reading is missing, not normal", () => {
  const result = assessReadiness({ ...baseline, hrvMs: null });
  assert.equal(result.signals.hrv.value, null);
  assert.equal(result.signals.hrv.ratio, null);
  assert.equal(result.signals.hrv.low, false);
  assert.equal(result.signals.hrv.quality, "missing");
  assert.equal(result.coverage, "partial");
});

test("a raised resting heart rate is compared against its own baseline", () => {
  const raised = assessReadiness({ ...baseline, restingHeartRateBpm: 60 });
  assert.equal(raised.signals.rhr.low, true);
  const marginal = assessReadiness({ ...baseline, restingHeartRateBpm: 54 });
  assert.equal(marginal.signals.rhr.low, false);
});

test("a lone raised resting heart rate is recorded but does not by itself escalate the assessment", () => {
  // Preserved Coach behaviour: `low_signal` needs either a low sleep night, or
  // HRV low together with a raised RHR. A raised RHR on its own is recorded on
  // its own signal but does not move the verdict band. Pinned here because it is
  // the kind of rule someone "fixes" without noticing it changes existing
  // arrangements.
  const alone = assessReadiness({ ...baseline, restingHeartRateBpm: 60 });
  assert.equal(alone.signals.rhr.low, true);
  assert.equal(alone.assessment, "no_low_signal");
  assert.deepEqual(alone.reasonCodes, ["no_low_signal"]);

  const paired = assessReadiness({ ...baseline, hrvMs: 40, restingHeartRateBpm: 60 });
  assert.equal(paired.assessment, "low_signal");
  assert.deepEqual(paired.reasonCodes, ["hrv", "resting_heart_rate"]);
});

test("lineage is attached by the assembler, and scores stay uncalibrated", () => {
  const snapshot = withReadinessLineage(assessReadiness(baseline), lineage);
  assert.equal(snapshot.lineage.timezoneIdentifier, "Asia/Shanghai");
  assert.equal(snapshot.lineage.calibrationCohortHash, null);
  assert.equal(snapshot.score, null);
  assert.equal(snapshot.scoreStatus, "not_calibrated");
  assert.equal(snapshot.stateEvidence.validationStatus, "not_empirically_validated");
});
