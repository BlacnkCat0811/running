import assert from "node:assert/strict";
import test from "node:test";

import {
  environmentCoverage,
  environmentViewForWorkout,
  splitGradeContexts,
  type ElevationPoint,
  type SplitInput
} from "../src/workout-environment.js";

const START = Date.parse("2026-09-14T11:20:00.000Z");

/** Two 1 km splits, 300 s each, starting at START. */
const splits: SplitInput[] = [
  { index: 1, distanceMeters: 1_000, durationSeconds: 300, averagePaceSecondsPerKm: 300 },
  { index: 2, distanceMeters: 1_000, durationSeconds: 300, averagePaceSecondsPerKm: 300 }
];

/** Elevation samples every 30 s across the whole run (21 samples = 0…600 s). */
function ramp(stepMetersPer30s: number, count = 21): ElevationPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(START + index * 30_000).toISOString(),
    value: index * stepMetersPer30s
  }));
}

test("N02: a climbing split is adjusted faster than it was run, a descending one slower", () => {
  const climbing = splitGradeContexts({ startedAtMs: START, splits, elevationPoints: ramp(4) });
  const descending = splitGradeContexts({ startedAtMs: START, splits, elevationPoints: ramp(-4) });

  const up = climbing.splits[0]!;
  const down = descending.splits[0]!;
  assert.ok(up.gradePercent !== null && up.gradePercent > 0, "ramp up must report a positive grade");
  assert.ok(up.gainMeters !== null && up.gainMeters > 0);
  assert.equal(up.lossMeters, 0);
  assert.ok(
    up.gradeAdjustedPaceSecondsPerKm !== null && up.gradeAdjustedPaceSecondsPerKm < 300,
    "uphill flat-equivalent pace must be faster than the recorded pace"
  );
  assert.ok(
    down.gradeAdjustedPaceSecondsPerKm !== null && down.gradeAdjustedPaceSecondsPerKm > 300,
    "downhill flat-equivalent pace must be slower than the recorded pace"
  );
  // The second split climbs exactly as much as the first: same grade, same adjustment.
  assert.equal(climbing.splits[1]!.gradePercent, up.gradePercent);
  assert.equal(climbing.splits[1]!.gradeAdjustedPaceSecondsPerKm, up.gradeAdjustedPaceSecondsPerKm);
});

test("N02: a flat run keeps its own pace and the summary is distance-weighted", () => {
  const flat = splitGradeContexts({
    startedAtMs: START,
    splits,
    elevationPoints: ramp(0)
  });
  for (const split of flat.splits) {
    assert.equal(split.gradePercent, 0);
    assert.equal(split.gradeAdjustedPaceSecondsPerKm, 300);
    assert.deepEqual(split.reasonCodes, []);
  }
  assert.equal(flat.summary.coveredSplits, 2);
  assert.equal(flat.summary.gradeAdjustedPaceSecondsPerKm, 300);
  assert.deepEqual(flat.summary.reasonCodes, [], "full coverage is not a partial-coverage warning");
});

test("N03: no elevation samples leaves every grade field null with a reason, never zero", () => {
  const result = splitGradeContexts({ startedAtMs: START, splits, elevationPoints: [] });
  for (const split of result.splits) {
    assert.equal(split.gradePercent, null, "unknown grade must not be rendered as flat");
    assert.equal(split.gradeAdjustedPaceSecondsPerKm, null);
    assert.equal(split.elevationChangeMeters, null);
    assert.deepEqual(split.reasonCodes, ["elevation_samples_insufficient"]);
  }
  assert.equal(result.summary.coveredSplits, 0);
  assert.equal(result.summary.gradeAdjustedPaceSecondsPerKm, null);
  assert.deepEqual(result.summary.reasonCodes, ["no_split_with_elevation"]);
});

test("N03: a single in-window sample is not a measurement of change", () => {
  const result = splitGradeContexts({
    startedAtMs: START,
    splits: [splits[0]!],
    elevationPoints: [{ timestamp: new Date(START + 60_000).toISOString(), value: 12 }]
  });
  assert.equal(result.splits[0]!.elevationChangeMeters, null);
  assert.deepEqual(result.splits[0]!.reasonCodes, ["elevation_samples_insufficient"]);
});

test("N03: GPS noise beyond the plausibility bound is refused, not clamped into a result", () => {
  // 900 m of net drop inside a 1 km split: > 60 % grade.
  const noisy: ElevationPoint[] = [
    { timestamp: new Date(START).toISOString(), value: 900 },
    { timestamp: new Date(START + 150_000).toISOString(), value: 0 },
    { timestamp: new Date(START + 299_000).toISOString(), value: 0 }
  ];
  const result = splitGradeContexts({ startedAtMs: START, splits: [splits[0]!], elevationPoints: noisy });
  const split = result.splits[0]!;
  assert.equal(split.gradePercent, null);
  assert.equal(split.gradeAdjustedPaceSecondsPerKm, null);
  assert.deepEqual(split.reasonCodes, ["grade_implausible_for_split"]);
  // The measured change is still reported: it is the *grade* that is not believable.
  assert.equal(split.elevationChangeMeters, -900);
  assert.equal(result.summary.coveredSplits, 0);
});

test("N03: a very short split is excluded before grade is even attempted", () => {
  const result = splitGradeContexts({
    startedAtMs: START,
    splits: [{ index: 1, distanceMeters: 20, durationSeconds: 6, averagePaceSecondsPerKm: 300 }],
    elevationPoints: ramp(1)
  });
  assert.deepEqual(result.splits[0]!.reasonCodes, ["split_too_short_for_grade"]);
  assert.equal(result.splits[0]!.gradePercent, null);
});

test("N03: partial coverage is reported as such and the summary still uses the covered splits", () => {
  // Only the first split has samples inside its window.
  const partial: ElevationPoint[] = [
    { timestamp: new Date(START).toISOString(), value: 0 },
    { timestamp: new Date(START + 150_000).toISOString(), value: 30 }
  ];
  const result = splitGradeContexts({ startedAtMs: START, splits, elevationPoints: partial });
  assert.equal(result.summary.coveredSplits, 1);
  assert.equal(result.summary.totalSplits, 2);
  assert.deepEqual(result.summary.reasonCodes, ["partial_elevation_coverage"]);
  assert.equal(result.summary.gainMeters, 30);
  assert.equal(result.splits[1]!.gradePercent, null);
});

test("N01: environment coverage counts parsed availability, not the presence of a key", () => {
  const coverage = environmentCoverage([
    {
      metadataJson: JSON.stringify({
        HKWeatherTemperature: "86 degF",
        HKWeatherHumidity: "8000 %",
        HKElevationAscended: "15000 cm"
      })
    },
    // Present but unreadable: the production parser refuses it, so it is not coverage.
    { metadataJson: JSON.stringify({ HKWeatherTemperature: "not-a-number" }) },
    // Completely absent weather (the current common case).
    { metadataJson: JSON.stringify({ HKIndoorWorkout: "0" }) }
  ]);
  assert.equal(coverage.workouts, 3);
  assert.equal(coverage.temperatureC, 1);
  assert.equal(coverage.humidityPercent, 1);
  assert.equal(coverage.elevationGainMeters, 1);
  assert.equal(coverage.complete, 1);
});

test("N01: the workout-level view needs a distance and a duration to normalise against", () => {
  const metadata = JSON.stringify({
    HKWeatherTemperature: "30 degC",
    HKWeatherHumidity: "70 %",
    HKElevationAscended: "5000 cm"
  });
  assert.equal(
    environmentViewForWorkout({ metadataJson: metadata, distanceMeters: null, durationSeconds: 1_800 }),
    null
  );
  assert.equal(
    environmentViewForWorkout({ metadataJson: metadata, distanceMeters: 5_000, durationSeconds: 0 }),
    null
  );
  const view = environmentViewForWorkout({
    metadataJson: metadata,
    distanceMeters: 5_000,
    durationSeconds: 1_500
  });
  assert.equal(view?.status, "applied");
  assert.equal(view?.temperatureC, 30);
  assert.equal(view?.elevationGainMeters, 50);
});
