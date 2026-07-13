import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeWorkoutZones,
  buildDailyZoneProfile,
  calculateCompositeTrainingLoad,
  heartRateZoneFor,
  paceZoneFor
} from "../src/index.js";

const baseInput = {
  id: "zone-1",
  localDate: "2026-07-13",
  timezoneIdentifier: "Asia/Shanghai",
  effectiveAt: "2026-07-12T16:00:00.000Z",
  createdAt: "2026-07-12T16:00:00.000Z",
  dateOfBirth: "1993-08-11",
  restingHeartRates: Array.from({ length: 8 }, (_, index) => ({
    valueBpm: index === 7 ? 174 : 60 + index % 3,
    observedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
  })),
  maximumHeartRates: [
    { peakBpm: 201, observedAt: "2026-07-10T00:00:00.000Z", coverage: 0.9, sourceConfidence: 1 },
    { peakBpm: 229, observedAt: "2026-07-11T00:00:00.000Z", coverage: 0.1, sourceConfidence: 1 }
  ],
  thresholdPace: { paceSecondsPerKm: 336, confidence: 0.2, evidenceCount: 2, dataThroughAt: "2026-07-10T00:00:00.000Z" }
};

test("builds robust HRR and provisional pace zones without accepting invalid resting heart rate", () => {
  const profile = buildDailyZoneProfile(baseInput);
  assert.ok(profile.restingHeartRateBpm >= 60 && profile.restingHeartRateBpm <= 62);
  assert.equal(profile.maximumHeartRateBpm, 201);
  assert.equal(profile.status, "provisional");
  assert.equal(heartRateZoneFor(profile.restingHeartRateBpm + 0.6 * (201 - profile.restingHeartRateBpm), profile), "aerobic_base");
  assert.equal(paceZoneFor(336 * 1.15, profile), "easy");
  assert.equal(paceZoneFor(336 * 0.89, profile), "sprint");
});

test("manual values take precedence only after their effective date", () => {
  const settings = {
    revision: 1,
    effectiveFromLocalDate: "2026-07-14",
    restingHeartRate: { mode: "manual" as const, valueBpm: 52 },
    maximumHeartRate: { mode: "manual" as const, valueBpm: 192 },
    lactateThresholdPace: { mode: "manual" as const, valueSecondsPerKm: 300 },
    createdAt: "2026-07-13T00:00:00.000Z"
  };
  const before = buildDailyZoneProfile({ ...baseInput, settings });
  const after = buildDailyZoneProfile({ ...baseInput, id: "zone-2", localDate: "2026-07-14", settings });
  assert.notEqual(before.restingHeartRateBpm, 52);
  assert.equal(after.restingHeartRateBpm, 52);
  assert.equal(after.maximumHeartRateBpm, 192);
  assert.equal(after.lactateThresholdPaceSecondsPerKm, 300);
});

test("requires seven valid resting-heart-rate days and limits maximum-heart-rate changes", () => {
  const insufficient = buildDailyZoneProfile({
    ...baseInput,
    restingHeartRates: baseInput.restingHeartRates.slice(0, 6),
    maximumHeartRates: []
  });
  assert.equal(insufficient.restingHeartRateBpm, 60);
  assert.equal(insufficient.heartRateSource, "fallback");

  const previous = buildDailyZoneProfile(baseInput);
  const higher = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-higher",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    previousProfile: previous,
    maximumHeartRates: [{ peakBpm: 210, observedAt: "2026-07-13T00:00:00.000Z", coverage: 1, sourceConfidence: 1 }]
  });
  assert.equal(higher.maximumHeartRateBpm, previous.maximumHeartRateBpm + 3);

  const recentLower = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-lower",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    previousProfile: previous,
    maximumHeartRates: [{ peakBpm: 180, observedAt: "2026-07-13T00:00:00.000Z", coverage: 1, sourceConfidence: 1 }]
  });
  assert.ok(previous.maximumHeartRateBpm - recentLower.maximumHeartRateBpm <= 1 / 90 + 1e-6);
});

test("classifies aerobic, threshold, VO2 and sprint stimulus from zone dose", () => {
  const profile = buildDailyZoneProfile(baseInput);
  const aerobic = analyzeWorkoutZones({
    trainingSessionId: "easy", durationSeconds: 2400, distanceMeters: 6000, sourceConfidence: 1, profile,
    heartRateSamples: [{ value: 150, durationSeconds: 2400 }],
    speedSamples: [{ value: 1000 / 420, durationSeconds: 2400 }]
  });
  assert.equal(aerobic.stimulusType, "aerobic_base");

  const threshold = analyzeWorkoutZones({
    trainingSessionId: "threshold", durationSeconds: 1200, distanceMeters: 3500, sourceConfidence: 1, profile,
    heartRateSamples: [{ value: 180, durationSeconds: 1200 }],
    speedSamples: [{ value: 1000 / 336, durationSeconds: 1200 }]
  });
  assert.equal(threshold.stimulusType, "lactate_threshold");

  const intervals = Array.from({ length: 3 }, (_, index) => ({ value: 1000 / 315, durationSeconds: 180, startOffsetSeconds: index * 240 }));
  const vo2 = analyzeWorkoutZones({
    trainingSessionId: "vo2", durationSeconds: 900, distanceMeters: 3000, sourceConfidence: 1, profile,
    heartRateSamples: [], speedSamples: intervals
  });
  assert.equal(vo2.stimulusType, "vo2max");

  const sprints = Array.from({ length: 4 }, (_, index) => ({ value: 1000 / 280, durationSeconds: 30, startOffsetSeconds: index * 60 }));
  const anaerobic = analyzeWorkoutZones({
    trainingSessionId: "sprint", durationSeconds: 300, distanceMeters: 1000, sourceConfidence: 1, profile,
    heartRateSamples: [], speedSamples: sprints
  });
  assert.equal(anaerobic.stimulusType, "anaerobic_endurance");
});

test("normalizes threshold HR and pace to 100 load and caps distance adjustment", () => {
  const profile = buildDailyZoneProfile({
    ...baseInput,
    settings: {
      revision: 1, effectiveFromLocalDate: "2026-07-13", createdAt: "2026-07-12T00:00:00.000Z",
      restingHeartRate: { mode: "manual", valueBpm: 50 },
      maximumHeartRate: { mode: "manual", valueBpm: 190 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 300 }
    }
  });
  const summary = analyzeWorkoutZones({
    trainingSessionId: "load", durationSeconds: 3600, distanceMeters: 12000, sourceConfidence: 1, profile,
    heartRateSamples: [{ value: 169, durationSeconds: 3600 }],
    speedSamples: [{ value: 1000 / 300, durationSeconds: 3600 }]
  });
  const load = calculateCompositeTrainingLoad({
    durationSeconds: 3600, distanceMeters: 12000, distanceReferenceMeters: 5000, profile, zoneSummary: summary,
    heartRateSamples: [{ value: 169, durationSeconds: 3600 }],
    speedSamples: [{ value: 1000 / 300, durationSeconds: 3600 }]
  });
  assert.ok(Math.abs((load.internalLoad ?? 0) - 100) < 0.001);
  assert.ok(Math.abs((load.paceLoad ?? 0) - 100) < 0.001);
  assert.equal(load.distanceFactor, 1.15);
  assert.ok(Math.abs(load.compositeLoad - 115) < 0.001);
});

test("does not double-count dual-zone dose or extrapolate sparse load samples", () => {
  const profile = buildDailyZoneProfile(baseInput);
  const summary = analyzeWorkoutZones({
    trainingSessionId: "dual", durationSeconds: 900, distanceMeters: 500, sourceConfidence: 1, profile,
    heartRateSamples: [{ value: 150, durationSeconds: 900 }],
    speedSamples: [{ value: 1000 / 420, durationSeconds: 900, distanceMeters: 1000 }]
  });
  const aerobicScore = summary.stimulusScores.find((item) => item.stimulusType === "aerobic_base");
  assert.equal(aerobicScore?.qualifyingSeconds, 900);
  assert.equal(summary.stimulusType, "aerobic_base");
  assert.ok(summary.stimulusConfidence <= 0.4);
  assert.ok(summary.paceExposure.reduce((sum, item) => sum + item.distanceMeters, 0) <= 500);

  const sparseSummary = analyzeWorkoutZones({
    trainingSessionId: "sparse", durationSeconds: 3600, distanceMeters: 10000, sourceConfidence: 1, profile,
    heartRateSamples: [{ value: 180, durationSeconds: 60 }],
    speedSamples: [{ value: 1000 / 336, durationSeconds: 60 }]
  });
  const sparse = calculateCompositeTrainingLoad({
    durationSeconds: 3600, distanceMeters: 10000, profile, zoneSummary: sparseSummary,
    heartRateSamples: [{ value: 180, durationSeconds: 60 }],
    speedSamples: [{ value: 1000 / 336, durationSeconds: 60 }]
  });
  assert.ok((sparse.internalLoad ?? 0) < 5);
  assert.ok((sparse.paceLoad ?? 0) < 5);
});
