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

test("keeps seven valid resting-heart-rate days when MAD is zero or near zero", () => {
  for (const values of [
    [61, 61, 61, 61, 60, 60, 60],
    [61, 61, 61, 61, 60.5, 60.5, 60.5]
  ]) {
    const profile = buildDailyZoneProfile({
      ...baseInput,
      id: `zone-zero-mad-${values[4]}`,
      restingHeartRates: values.map((valueBpm, index) => ({
        valueBpm,
        observedAt: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
      }))
    });

    assert.equal(profile.evidence.restingHeartRateDays, 7);
    assert.ok(profile.restingHeartRateBpm >= 60 && profile.restingHeartRateBpm <= 61);
  }
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

test("keeps fallback provenance when a profile is carried without heart-rate evidence", () => {
  const first = buildDailyZoneProfile({
    ...baseInput,
    restingHeartRates: [],
    maximumHeartRates: []
  });
  const next = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-fallback-next",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    restingHeartRates: [],
    maximumHeartRates: [],
    previousProfile: first
  });
  assert.equal(first.status, "fallback");
  assert.equal(next.heartRateSource, "fallback");
  assert.equal(next.status, "fallback");
});

test("uses conservative heart-rate confidence when only one input is manual", () => {
  const profile = buildDailyZoneProfile({
    ...baseInput,
    restingHeartRates: [],
    maximumHeartRates: [],
    settings: {
      revision: 1,
      effectiveFromLocalDate: "2026-07-13",
      restingHeartRate: { mode: "manual", valueBpm: 52 },
      maximumHeartRate: { mode: "auto", valueBpm: null },
      lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null },
      createdAt: "2026-07-12T00:00:00.000Z"
    }
  });
  assert.equal(profile.restingHeartRateBpm, 52);
  assert.ok(profile.heartRateConfidence < 1);
  assert.equal(profile.heartRateSource, "fallback");
  assert.equal(profile.status, "fallback");
});

test("replaces a manual pace anchor immediately after switching to automatic", () => {
  const manual = buildDailyZoneProfile({
    ...baseInput,
    settings: {
      revision: 1,
      effectiveFromLocalDate: "2026-07-13",
      restingHeartRate: { mode: "auto", valueBpm: null },
      maximumHeartRate: { mode: "auto", valueBpm: null },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 300 },
      createdAt: "2026-07-12T00:00:00.000Z"
    }
  });
  const automatic = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-pace-automatic",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    previousProfile: manual,
    thresholdPace: { paceSecondsPerKm: 345, confidence: 0.2, evidenceCount: 2, dataThroughAt: "2026-07-13T00:00:00.000Z" },
    settings: {
      revision: 2,
      effectiveFromLocalDate: "2026-07-14",
      restingHeartRate: { mode: "auto", valueBpm: null },
      maximumHeartRate: { mode: "auto", valueBpm: null },
      lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null },
      createdAt: "2026-07-13T00:00:00.000Z"
    }
  });
  assert.equal(automatic.lactateThresholdPaceSecondsPerKm, 345);
  assert.equal(automatic.paceSource, "automatic");
  assert.equal(automatic.paceConfidence, 0.2);
  assert.equal(automatic.status, "provisional");
});

test("refreshes a provisional pace anchor only when low-confidence evidence is new", () => {
  const first = buildDailyZoneProfile(baseInput);
  const carried = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-carried",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    previousProfile: first,
    thresholdPace: { paceSecondsPerKm: 300, confidence: 0.2, evidenceCount: 2, dataThroughAt: first.dataThroughAt }
  });
  assert.equal(carried.lactateThresholdPaceSecondsPerKm, first.lactateThresholdPaceSecondsPerKm);
  assert.ok(carried.paceConfidence < first.paceConfidence);

  const refreshed = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-refreshed",
    localDate: "2026-07-15",
    effectiveAt: "2026-07-14T16:00:00.000Z",
    previousProfile: carried,
    thresholdPace: { paceSecondsPerKm: 340, confidence: 0.1, evidenceCount: 3, dataThroughAt: "2026-07-14T00:00:00.000Z" }
  });
  assert.equal(refreshed.lactateThresholdPaceSecondsPerKm, 340);
  assert.equal(refreshed.dataThroughAt, "2026-07-14T00:00:00.000Z");
  assert.equal(refreshed.status, "provisional");
});

test("does not repeatedly move a pace anchor for already-consumed high-confidence evidence", () => {
  const first = buildDailyZoneProfile({
    ...baseInput,
    thresholdPace: { paceSecondsPerKm: 300, confidence: 0.8, evidenceCount: 3, dataThroughAt: "2026-07-10T00:00:00.000Z" }
  });
  const updated = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-high-confidence-updated",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    previousProfile: first,
    thresholdPace: { paceSecondsPerKm: 360, confidence: 0.8, evidenceCount: 4, dataThroughAt: "2026-07-13T00:00:00.000Z" }
  });
  assert.equal(updated.lactateThresholdPaceSecondsPerKm, 300.321429);
  assert.equal(updated.dataThroughAt, "2026-07-13T00:00:00.000Z");
  const repeated = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-high-confidence-repeated",
    localDate: "2026-07-15",
    effectiveAt: "2026-07-14T16:00:00.000Z",
    previousProfile: updated,
    thresholdPace: { paceSecondsPerKm: 360, confidence: 0.8, evidenceCount: 4, dataThroughAt: updated.dataThroughAt }
  });
  assert.equal(repeated.lactateThresholdPaceSecondsPerKm, updated.lactateThresholdPaceSecondsPerKm);
  assert.equal(repeated.dataThroughAt, updated.dataThroughAt);
  assert.equal(repeated.paceSource, "carried_forward");
});

test("updates pace when performance evidence advances the cursor without changing threshold evidence count", () => {
  const first = buildDailyZoneProfile({
    ...baseInput,
    thresholdPace: { paceSecondsPerKm: 300, confidence: 0.8, evidenceCount: 3, dataThroughAt: "2026-07-10T00:00:00.000Z" }
  });
  const updated = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-performance-cursor-updated",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    previousProfile: first,
    thresholdPace: { paceSecondsPerKm: 250, confidence: 0.8, evidenceCount: 3, dataThroughAt: "2026-07-13T00:00:00.000Z" }
  });

  assert.ok((updated.lactateThresholdPaceSecondsPerKm ?? Infinity) < 300);
  assert.equal(updated.dataThroughAt, "2026-07-13T00:00:00.000Z");
  assert.equal(updated.evidence.thresholdEvidenceCount, 3);
  assert.equal(updated.paceSource, "automatic");
});

test("advances the evidence cursor by instant across mixed offsets", () => {
  const first = buildDailyZoneProfile({
    ...baseInput,
    thresholdPace: {
      paceSecondsPerKm: 300,
      confidence: 0.8,
      evidenceCount: 3,
      dataThroughAt: "2026-07-10T10:00:00+10:00"
    }
  });
  const updated = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-offset-cursor",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    previousProfile: first,
    thresholdPace: {
      paceSecondsPerKm: 250,
      confidence: 0.8,
      evidenceCount: 3,
      dataThroughAt: "2026-07-10T02:00:00+00:00"
    }
  });

  assert.ok((updated.lactateThresholdPaceSecondsPerKm ?? Infinity) < 300);
  assert.equal(updated.dataThroughAt, "2026-07-10T02:00:00+00:00");
});

test("does not adopt previously rejected threshold evidence after confidence decay", () => {
  let profile = buildDailyZoneProfile({
    ...baseInput,
    thresholdPace: { paceSecondsPerKm: 300, confidence: 0.8, evidenceCount: 3, dataThroughAt: "2026-07-10T00:00:00.000Z" }
  });
  const rejectedEvidence = {
    paceSecondsPerKm: 400, confidence: 0.1, evidenceCount: 4, dataThroughAt: "2026-07-11T00:00:00.000Z"
  };
  for (let day = 0; day < 10; day += 1) {
    profile = buildDailyZoneProfile({
      ...baseInput,
      id: `zone-rejected-${day}`,
      localDate: `2026-07-${String(14 + day).padStart(2, "0")}`,
      effectiveAt: new Date(Date.UTC(2026, 6, 13 + day, 16)).toISOString(),
      previousProfile: profile,
      thresholdPace: rejectedEvidence
    });
  }
  assert.equal(profile.lactateThresholdPaceSecondsPerKm, 300);
  assert.equal(profile.dataThroughAt, rejectedEvidence.dataThroughAt);
  assert.equal(profile.evidence.thresholdEvidenceCount, rejectedEvidence.evidenceCount);
});

test("preserves the threshold evidence cursor while a candidate is temporarily missing", () => {
  const first = buildDailyZoneProfile({
    ...baseInput,
    thresholdPace: { paceSecondsPerKm: 300, confidence: 0.8, evidenceCount: 3, dataThroughAt: "2026-07-10T00:00:00.000Z" }
  });
  const missing = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-missing-candidate",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    previousProfile: first,
    thresholdPace: null
  });
  assert.equal(missing.evidence.thresholdEvidenceCount, 3);

  const returned = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-returned-candidate",
    localDate: "2026-07-15",
    effectiveAt: "2026-07-14T16:00:00.000Z",
    previousProfile: missing,
    thresholdPace: { paceSecondsPerKm: 360, confidence: 0.8, evidenceCount: 3, dataThroughAt: first.dataThroughAt }
  });
  assert.equal(returned.lactateThresholdPaceSecondsPerKm, first.lactateThresholdPaceSecondsPerKm);
  assert.equal(returned.evidence.thresholdEvidenceCount, 3);
  assert.equal(returned.paceSource, "carried_forward");
});

test("switching a manual pace to automatic adopts the available candidate as a fresh anchor", () => {
  const manual = buildDailyZoneProfile({
    ...baseInput,
    thresholdPace: { paceSecondsPerKm: 330, confidence: 0.7, evidenceCount: 5, dataThroughAt: "2026-07-10T00:00:00.000Z" },
    settings: {
      revision: 1,
      effectiveFromLocalDate: "2026-07-13",
      restingHeartRate: { mode: "auto", valueBpm: null },
      maximumHeartRate: { mode: "auto", valueBpm: null },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 300 },
      createdAt: "2026-07-12T00:00:00.000Z"
    }
  });
  const automatic = buildDailyZoneProfile({
    ...baseInput,
    id: "zone-manual-to-auto-same-evidence",
    localDate: "2026-07-14",
    effectiveAt: "2026-07-13T16:00:00.000Z",
    previousProfile: manual,
    thresholdPace: { paceSecondsPerKm: 330, confidence: 0.7, evidenceCount: 5, dataThroughAt: "2026-07-10T00:00:00.000Z" },
    settings: {
      revision: 2,
      effectiveFromLocalDate: "2026-07-14",
      restingHeartRate: { mode: "auto", valueBpm: null },
      maximumHeartRate: { mode: "auto", valueBpm: null },
      lactateThresholdPace: { mode: "auto", valueSecondsPerKm: null },
      createdAt: "2026-07-13T00:00:00.000Z"
    }
  });
  assert.equal(automatic.lactateThresholdPaceSecondsPerKm, 330);
  assert.equal(automatic.paceSource, "automatic");
  assert.equal(automatic.paceConfidence, 0.7);
  assert.equal(automatic.dataThroughAt, "2026-07-10T00:00:00.000Z");
  assert.equal(automatic.evidence.thresholdEvidenceCount, 5);
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
  assert.ok(load.compositeIntensity > 0 && load.compositeIntensity <= 1);
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

test("uses one clipped timeline for overlapping zone exposure and load", () => {
  const profile = buildDailyZoneProfile({
    ...baseInput,
    settings: {
      revision: 1, effectiveFromLocalDate: "2026-07-13", createdAt: "2026-07-12T00:00:00.000Z",
      restingHeartRate: { mode: "manual", valueBpm: 50 },
      maximumHeartRate: { mode: "manual", valueBpm: 190 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 300 }
    }
  });
  const heartRateSamples = [
    { value: 169, durationSeconds: 3600, startOffsetSeconds: 0 },
    { value: 169, durationSeconds: 3600, startOffsetSeconds: 0 },
    { value: 169, durationSeconds: 120, startOffsetSeconds: 3540 }
  ];
  const speedSamples = [
    { value: 1000 / 300, durationSeconds: 3600, startOffsetSeconds: 0 },
    { value: 1000 / 300, durationSeconds: 3600, startOffsetSeconds: 0 }
  ];
  const summary = analyzeWorkoutZones({
    trainingSessionId: "overlap", durationSeconds: 3600, distanceMeters: 12000,
    sourceConfidence: 1, profile, heartRateSamples, speedSamples
  });
  const load = calculateCompositeTrainingLoad({
    durationSeconds: 3600, distanceMeters: 12000, profile, zoneSummary: summary,
    heartRateSamples, speedSamples
  });
  assert.equal(summary.heartRateCoverage, 1);
  assert.equal(summary.paceCoverage, 1);
  assert.equal(summary.heartRateExposure.reduce((sum, item) => sum + item.durationSeconds, 0), 3600);
  assert.equal(summary.paceExposure.reduce((sum, item) => sum + item.durationSeconds, 0), 3600);
  assert.ok(Math.abs((load.internalLoad ?? 0) - 100) < 0.001);
  assert.ok(Math.abs((load.paceLoad ?? 0) - 100) < 0.001);
});

test("keeps samples recorded after a paused workout resumes", () => {
  const profile = buildDailyZoneProfile({
    ...baseInput,
    settings: {
      revision: 1, effectiveFromLocalDate: "2026-07-13", createdAt: "2026-07-12T00:00:00.000Z",
      restingHeartRate: { mode: "manual", valueBpm: 50 },
      maximumHeartRate: { mode: "manual", valueBpm: 190 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 300 }
    }
  });
  const heartRateSamples = [
    { value: 120, durationSeconds: 900, startOffsetSeconds: 0 },
    { value: 169, durationSeconds: 900, startOffsetSeconds: 1800 }
  ];
  const speedSamples = [
    { value: 1000 / 420, durationSeconds: 900, startOffsetSeconds: 0 },
    { value: 1000 / 300, durationSeconds: 900, startOffsetSeconds: 1800 }
  ];
  const summary = analyzeWorkoutZones({
    trainingSessionId: "paused", durationSeconds: 1800, elapsedDurationSeconds: 2700,
    distanceMeters: 5000, sourceConfidence: 1, profile, heartRateSamples, speedSamples
  });
  const load = calculateCompositeTrainingLoad({
    durationSeconds: 1800, elapsedDurationSeconds: 2700, distanceMeters: 5000,
    profile, zoneSummary: summary, heartRateSamples, speedSamples
  });

  assert.equal(summary.heartRateCoverage, 1);
  assert.equal(summary.paceCoverage, 1);
  assert.equal(summary.heartRateExposure.reduce((sum, item) => sum + item.durationSeconds, 0), 1800);
  assert.equal(summary.paceExposure.reduce((sum, item) => sum + item.durationSeconds, 0), 1800);
  assert.ok((load.internalLoad ?? 0) > 20);
  assert.ok((load.paceLoad ?? 0) > 20);
});

test("caps continuously recorded paused-workout exposure, stimulus, and load at active duration", () => {
  const profile = buildDailyZoneProfile({
    ...baseInput,
    settings: {
      revision: 1, effectiveFromLocalDate: "2026-07-13", createdAt: "2026-07-12T00:00:00.000Z",
      restingHeartRate: { mode: "manual", valueBpm: 50 },
      maximumHeartRate: { mode: "manual", valueBpm: 190 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 300 }
    }
  });
  const heartRateSamples = [
    { value: 120, durationSeconds: 900, startOffsetSeconds: 0 },
    { value: 169, durationSeconds: 1_800, startOffsetSeconds: 900 }
  ];
  const speedSamples = [
    { value: 1000 / 420, durationSeconds: 900, startOffsetSeconds: 0 },
    { value: 1000 / 300, durationSeconds: 1_800, startOffsetSeconds: 900 }
  ];
  const summary = analyzeWorkoutZones({
    trainingSessionId: "paused-continuous", durationSeconds: 1_800, elapsedDurationSeconds: 2_700,
    distanceMeters: 5_000, sourceConfidence: 1, profile, heartRateSamples, speedSamples
  });
  const load = calculateCompositeTrainingLoad({
    durationSeconds: 1_800, elapsedDurationSeconds: 2_700, distanceMeters: 5_000,
    profile, zoneSummary: summary, heartRateSamples, speedSamples
  });
  const heartSeconds = summary.heartRateExposure.reduce((sum, item) => sum + item.durationSeconds, 0);
  const paceSeconds = summary.paceExposure.reduce((sum, item) => sum + item.durationSeconds, 0);
  const thresholdScore = summary.stimulusScores.find((item) => item.stimulusType === "lactate_threshold");

  assert.equal(heartSeconds, 1_800);
  assert.equal(paceSeconds, 1_800);
  assert.equal(summary.heartRateExposure.reduce((sum, item) => sum + item.fraction, 0), 1);
  assert.equal(summary.paceExposure.reduce((sum, item) => sum + item.fraction, 0), 1);
  assert.ok((thresholdScore?.qualifyingSeconds ?? Infinity) <= 1_800);
  assert.ok((load.internalLoad ?? Infinity) < 50);
  assert.ok((load.paceLoad ?? Infinity) < 50);
  assert.ok(summary.heartRateExposure.some((item) => item.zone === "lactate_threshold" && item.durationSeconds > 0));
  assert.ok(summary.paceExposure.some((item) => item.zone === "lactate_threshold" && item.durationSeconds > 0));
});

test("folds sourceConfidence and discounts average-only heart coverage for load confidence", () => {
  const profile = buildDailyZoneProfile({
    ...baseInput,
    settings: {
      revision: 1, effectiveFromLocalDate: "2026-07-13", createdAt: "2026-07-12T00:00:00.000Z",
      restingHeartRate: { mode: "manual", valueBpm: 50 },
      maximumHeartRate: { mode: "manual", valueBpm: 190 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 300 }
    }
  });
  const fullSeriesSummary = analyzeWorkoutZones({
    trainingSessionId: "series", durationSeconds: 3600, distanceMeters: 10_000,
    sourceConfidence: 0.8, profile,
    heartRateSamples: [{ value: 169, durationSeconds: 3600 }],
    speedSamples: []
  });
  const fullSeries = calculateCompositeTrainingLoad({
    durationSeconds: 3600, distanceMeters: 10_000, profile, zoneSummary: fullSeriesSummary,
    heartRateSamples: [{ value: 169, durationSeconds: 3600 }],
    speedSamples: [], sourceConfidence: 0.8
  });
  // sourceConfidence * coverage(1) * profile.hrConf(1) = 0.8
  assert.equal(fullSeries.heartRateConfidence, 0.8);
  assert.equal(fullSeries.paceConfidence, 0);

  const averageOnlySummary = analyzeWorkoutZones({
    trainingSessionId: "avg-only", durationSeconds: 3600, distanceMeters: 10_000,
    sourceConfidence: 1, profile,
    heartRateSamples: [], speedSamples: [],
    averageHeartRateBpm: 169
  });
  assert.equal(averageOnlySummary.heartRateCoverage, 1);
  assert.ok(averageOnlySummary.explanationCodes.includes("heart_rate_average_fallback"));
  const averageOnly = calculateCompositeTrainingLoad({
    durationSeconds: 3600, distanceMeters: 10_000, profile, zoneSummary: averageOnlySummary,
    heartRateSamples: [], speedSamples: [], averageHeartRateBpm: 169, sourceConfidence: 1
  });
  // Average-only must not treat coverage as 1.0 for load provenance (~0.4 discount).
  assert.equal(averageOnly.heartRateConfidence, 0.4);
  assert.ok((averageOnly.internalLoad ?? 0) > 0);
});

test("RPE and session fallbacks use Banister intensity and target confidences", () => {
  const profile = buildDailyZoneProfile({
    ...baseInput,
    settings: {
      revision: 1, effectiveFromLocalDate: "2026-07-13", createdAt: "2026-07-12T00:00:00.000Z",
      restingHeartRate: { mode: "manual", valueBpm: 50 },
      maximumHeartRate: { mode: "manual", valueBpm: 190 },
      lactateThresholdPace: { mode: "manual", valueSecondsPerKm: 300 }
    }
  });
  const emptySummary = analyzeWorkoutZones({
    trainingSessionId: "fallback", durationSeconds: 3600, distanceMeters: null,
    sourceConfidence: 1, profile, heartRateSamples: [], speedSamples: []
  });
  const rpe = calculateCompositeTrainingLoad({
    durationSeconds: 3600, distanceMeters: null, profile, zoneSummary: emptySummary,
    heartRateSamples: [], speedSamples: [], rpe: 5, sourceConfidence: 1
  });
  // RPE 5 → intensity 0.52 (shared table), not (5/10)^2.
  assert.equal(rpe.compositeIntensity, 0.52);
  assert.equal(rpe.heartRateConfidence, 0.65);
  assert.equal(rpe.paceConfidence, 0);
  assert.equal(rpe.internalLoad, null);
  assert.equal(rpe.paceLoad, null);
  // Normalized TRIMP at intensity 0.52 for 60 minutes relative to 0.85 threshold.
  const expectedRpeLoad = 60 * (0.52 * Math.exp(1.92 * 0.52)) * 100 / (60 * (0.85 * Math.exp(1.92 * 0.85)));
  assert.ok(Math.abs(rpe.compositeLoad - expectedRpeLoad) < 1e-4);

  const session = calculateCompositeTrainingLoad({
    durationSeconds: 3600, distanceMeters: null, profile, zoneSummary: emptySummary,
    heartRateSamples: [], speedSamples: [], sessionType: "easy", sourceConfidence: 1
  });
  assert.equal(session.compositeIntensity, 0.42);
  assert.equal(session.heartRateConfidence, 0.4);
  assert.equal(session.paceConfidence, 0);

  const lowSource = calculateCompositeTrainingLoad({
    durationSeconds: 3600, distanceMeters: null, profile, zoneSummary: emptySummary,
    heartRateSamples: [], speedSamples: [], rpe: 7, sourceConfidence: 0.5
  });
  assert.equal(lowSource.heartRateConfidence, 0.325);
});
