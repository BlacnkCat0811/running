import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { MobileSessionStructure } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

import { RaiReadStore } from "../src/data.js";
import {
  eventBoundariesOf,
  matchPlanDay,
  resolveSegmentation,
  timeAtMeters,
  type PlanCandidateDay,
  type SegmentTrack
} from "../src/workout-segments.js";

/**
 * The 2026-09-14 run, as measured. Four phases whose distances and durations sum
 * exactly to the workout total — the same shape the Fitness app renders as
 * 热身 / 训练 / 整理放松 / 自由训练, and the shape the plan replay must
 * reproduce from the stored structure alone.
 */
const PHASES = [
  { seconds: 300, meters: 773, heartRate: 150 },
  { seconds: 981, meters: 2600, heartRate: 162 },
  { seconds: 300, meters: 775, heartRate: 155 },
  { seconds: 770, meters: 1903, heartRate: 150 }
];
const TOTAL_SECONDS = PHASES.reduce((total, phase) => total + phase.seconds, 0);
const TOTAL_METERS = PHASES.reduce((total, phase) => total + phase.meters, 0);
const PHASE_ENDS_MS = PHASES.reduce<number[]>((ends, phase) => {
  ends.push((ends[ends.length - 1] ?? 0) + phase.seconds * 1000);
  return ends;
}, []);

/** The session the phone pushed for 09-15 and the runner executed on 09-14. */
const INTERVAL_STRUCTURE: MobileSessionStructure = {
  warmup: { purpose: "warmup", goal: { type: "time", seconds: 300 }, alert: { kind: "heart_rate", lower: 146, upper: 160 } },
  blocks: [
    {
      iterations: 1,
      steps: [{ purpose: "work", goal: { type: "distance", meters: 2600 }, alert: { kind: "pace", lower: 423, upper: 380 } }]
    }
  ],
  cooldown: { purpose: "cooldown", goal: { type: "time", seconds: 300 }, alert: { kind: "heart_rate", lower: 146, upper: 160 } }
};

const planDay = (overrides: Partial<PlanCandidateDay> = {}): PlanCandidateDay => ({
  localDate: "2026-09-15",
  kind: "interval",
  revision: 6,
  matchedBy: "plan_history",
  structure: INTERVAL_STRUCTURE,
  distanceKm: 4.2,
  pushedAt: null,
  ...overrides
});

/** Speed samples for one phase; `km/hr` exercises the unit conversion the real export uses. */
const phaseSamples = (phase: { seconds: number; meters: number }, phaseStartMs: number) => {
  const metersPerSecond = phase.meters / phase.seconds;
  const samples: Array<{ startMs: number; endMs: number; meters: number }> = [];
  for (let elapsed = 0; elapsed < phase.seconds * 1000; elapsed += 10_000) {
    const endMs = Math.min(phase.seconds * 1000, elapsed + 10_000);
    samples.push({
      startMs: phaseStartMs + elapsed,
      endMs: phaseStartMs + endMs,
      meters: (metersPerSecond * (endMs - elapsed)) / 1000
    });
  }
  return samples;
};

const RUN_START_MS = Date.parse("2026-09-14T11:20:00.000Z");

const syntheticTrack = (): SegmentTrack => ({
  officialMeters: TOTAL_METERS,
  samples: PHASES.flatMap((phase, index) => phaseSamples(phase, index === 0 ? 0 : PHASE_ENDS_MS[index - 1]!))
});

/** A workout + session + speed/HR records matching `PHASES`. */
const seedRun = async (events: Array<{ type: string; atMs: number; durationSeconds: number }>) => {
  const root = mkdtempSync(join(tmpdir(), "rai-segments-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  const database = store.database;
  const workoutId = "fixture_segment_workout";
  const sessionId = "fixture_segment_session";
  const sourceName = "唐攀的Apple Watch";
  database
    .prepare(`
      INSERT INTO workouts (
        id, activity_type, source_name, source_category, source_version, device,
        start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json,
        is_canonical
      ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, 'apple_watch', '26.6', 'Watch',
        ?, ?, ?, 0, '{}', '{}', 1)
    `)
    .run(
      workoutId,
      sourceName,
      new Date(RUN_START_MS).toISOString(),
      new Date(RUN_START_MS + TOTAL_SECONDS * 1000).toISOString(),
      TOTAL_SECONDS
    );
  database
    .prepare(`
      INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status
      ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, ?, ?, 'active')
    `)
    .run(
      sessionId,
      new Date(RUN_START_MS).toISOString(),
      new Date(RUN_START_MS + TOTAL_SECONDS * 1000).toISOString(),
      TOTAL_METERS / 1000,
      workoutId
    );
  const insertRecord = database.prepare(`
    INSERT INTO health_records (
      id, type, source_name, source_category, unit, value_numeric,
      start_at, end_at, metadata_json, raw_attributes_json
    ) VALUES (?, ?, ?, 'apple_watch', 'km/hr', ?, ?, ?, '{}', '{}')
  `);
  let ordinal = 0;
  PHASES.forEach((phase, index) => {
    const phaseStartMs = index === 0 ? 0 : PHASE_ENDS_MS[index - 1]!;
    const metersPerSecond = phase.meters / phase.seconds;
    for (let elapsed = 0; elapsed < phase.seconds * 1000; elapsed += 10_000) {
      const startMs = RUN_START_MS + phaseStartMs + elapsed;
      const endMs = RUN_START_MS + phaseStartMs + Math.min(phase.seconds * 1000, elapsed + 10_000);
      insertRecord.run(
        `speed_${ordinal++}`,
        "HKQuantityTypeIdentifierRunningSpeed",
        sourceName,
        metersPerSecond * 3.6,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString()
      );
    }
    for (let elapsed = 0; elapsed < phase.seconds * 1000; elapsed += 30_000) {
      const startMs = RUN_START_MS + phaseStartMs + elapsed;
      const endMs = RUN_START_MS + phaseStartMs + Math.min(phase.seconds * 1000, elapsed + 30_000);
      insertRecord.run(
        `heart_${ordinal++}`,
        "HKQuantityTypeIdentifierHeartRate",
        sourceName,
        phase.heartRate,
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString()
      );
    }
  });
  const insertEvent = database.prepare(`
    INSERT INTO workout_events (workout_id, ordinal, type, event_at, duration_seconds, metadata_json)
    VALUES (?, ?, ?, ?, ?, '{}')
  `);
  events.forEach((event, index) => {
    insertEvent.run(
      workoutId,
      index,
      event.type,
      new Date(RUN_START_MS + event.atMs).toISOString(),
      event.durationSeconds
    );
  });
  store.close();
  return { root, databasePath, sessionId };
};

test("replays the stored interval session onto the measured track", async () => {
  const { root, databasePath, sessionId } = await seedRun([]);
  const read = new RaiReadStore(databasePath);
  try {
    const series = read.workoutSeries(sessionId, [planDay()]);
    assert.ok(series);
    assert.deepEqual(
      series.segments.map((segment) => segment.label),
      ["热身", "训练", "整理放松", "自由训练"]
    );
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.distanceMeters)),
      [773, 2600, 775, 1903]
    );
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.durationSeconds)),
      [300, 981, 300, 770]
    );
    assert.deepEqual(
      series.segments.map((segment) => segment.purpose),
      ["warmup", "work", "cooldown", "unplanned"]
    );
    assert.equal(series.segments[0]?.goalType, "time");
    assert.equal(series.segments[0]?.goalSeconds, 300);
    assert.equal(series.segments[0]?.alertKind, "heart_rate");
    assert.equal(series.segments[0]?.alertUpper, 160);
    assert.equal(series.segments[1]?.goalType, "distance");
    assert.equal(series.segments[1]?.goalMeters, 2600);
    // The trailing stretch must not inherit the cooldown's prescription.
    assert.equal(series.segments[3]?.goalType, null);
    assert.equal(series.segments[3]?.alertKind, null);
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.startOffsetSeconds)),
      [0, 300, 1281, 1581]
    );
    assert.equal(series.segmentPlan?.localDate, "2026-09-15");
    assert.equal(series.segmentPlan?.matchedBy, "plan_history");
    assert.ok(Math.abs((series.segmentPlan?.explainedFraction ?? 0) - 1581 / TOTAL_SECONDS) < 0.01);
    assert.match(series.segmentNote ?? "", /课表结构/);
    // The kilometre split is untouched: both stories stay available.
    assert.deepEqual(
      series.splits.map((split) => split.distanceMeters),
      [1000, 1000, 1000, 1000, 1000, 1000, 51]
    );
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefers Watch lap events and labels them from the plan", async () => {
  const { root, databasePath, sessionId } = await seedRun([
    { type: "HKWorkoutEventTypePause", atMs: 600_000, durationSeconds: 0 },
    { type: "HKWorkoutEventTypeLap", atMs: 0, durationSeconds: 300 },
    { type: "HKWorkoutEventTypeLap", atMs: 300_000, durationSeconds: 981.13 },
    { type: "HKWorkoutEventTypeLap", atMs: 1_281_130, durationSeconds: 300 },
    { type: "HKWorkoutEventTypeLap", atMs: 1_581_130, durationSeconds: 769.87 }
  ]);
  const read = new RaiReadStore(databasePath);
  try {
    const series = read.workoutSeries(sessionId, [planDay()]);
    assert.ok(series);
    assert.equal(series.segments.length, 4);
    assert.match(series.segmentNote ?? "", /lap\/segment/);
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.distanceMeters)),
      [773, 2600, 775, 1903]
    );
    assert.deepEqual(
      series.segments.map((segment) => segment.label),
      ["热身", "训练", "整理放松", "自由训练"]
    );
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("says why there are no segments instead of leaving the panel blank", async () => {
  const { root, databasePath, sessionId } = await seedRun([]);
  const read = new RaiReadStore(databasePath);
  try {
    const series = read.workoutSeries(sessionId, []);
    assert.ok(series);
    assert.deepEqual(series.segments, []);
    assert.equal(series.segmentPlan, null);
    assert.match(series.segmentNote ?? "", /没有手表 lap\/segment 事件/);
    // The fallback is still there, and still correct.
    assert.equal(series.splits.length, 7);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tiles legacy zero-duration laps and drops sliver boundaries", () => {
  const events = [
    { type: "HKWorkoutEventTypeLap", startMs: 0, endMs: 0 },
    { type: "HKWorkoutEventTypeLap", startMs: 300_000, endMs: 300_000 },
    // Closer than MIN_SEGMENT_MS to the previous boundary: measurement noise.
    { type: "HKWorkoutEventTypeMarker", startMs: 302_000, endMs: 302_000 },
    { type: "HKWorkoutEventTypeSegment", startMs: 1_281_130, endMs: 1_581_130 }
  ];
  assert.deepEqual(eventBoundariesOf(events, 0, 2_351_000), [0, 300_000, 1_281_130, 1_581_130, 2_351_000]);
  // Events outside the workout window cannot open a segment.
  assert.deepEqual(eventBoundariesOf([{ type: "HKWorkoutEventTypeLap", startMs: 9_999_999, endMs: 9_999_999 }], 0, 2_351_000), [0, 2_351_000]);
});

test("walks the track by distance, not by plan arithmetic", () => {
  const track = syntheticTrack();
  assert.equal(timeAtMeters(track, 0, 0), 0);
  // 773 m is exactly the warmup, which the synthetic track places at 300 s.
  assert.ok(Math.abs(timeAtMeters(track, 0, 773) - 300_000) < 1);
  // Unreachable distances clamp to the end of the track rather than running past it.
  assert.equal(timeAtMeters(track, 0, TOTAL_METERS * 2), PHASE_ENDS_MS[3]);
});

test("matches a run to the plan the runner pushed for tomorrow", () => {
  const startedAtMs = RUN_START_MS;
  const push = planDay({
    matchedBy: "push_record",
    localDate: "2026-09-15",
    pushedAt: new Date(RUN_START_MS - 3 * 3_600_000).toISOString()
  });
  // A receipt from three hours earlier wins outright.
  assert.equal(
    matchPlanDay({ candidates: [push, planDay()], startedAtMs, localDate: "2026-09-14", distanceKm: 6.051 })?.matchedBy,
    "push_record"
  );
  // Too old to be this run's session.
  assert.equal(
    matchPlanDay({
      candidates: [planDay({ matchedBy: "push_record", pushedAt: new Date(RUN_START_MS - 72 * 3_600_000).toISOString() })],
      startedAtMs,
      localDate: "2026-09-14",
      distanceKm: 6.051
    }),
    null
  );
  // A receipt dated after the run cannot explain it either.
  assert.equal(
    matchPlanDay({
      candidates: [planDay({ matchedBy: "push_record", pushedAt: new Date(RUN_START_MS + 3_600_000).toISOString() })],
      startedAtMs,
      localDate: "2026-09-14",
      distanceKm: 6.051
    }),
    null
  );
  // No receipt: the run's own date first, then the day after — which is exactly
  // the "push tomorrow, run tonight" case.
  assert.equal(
    matchPlanDay({ candidates: [planDay()], startedAtMs, localDate: "2026-09-14", distanceKm: 6.051 })?.localDate,
    "2026-09-15"
  );
  assert.equal(
    matchPlanDay({ candidates: [planDay({ localDate: "2026-09-14" })], startedAtMs, localDate: "2026-09-14", distanceKm: 6.051 })?.localDate,
    "2026-09-14"
  );
  // A neighbouring plan that asks for more distance than the run contains is
  // rejected: the neighbour rule guesses, so it only accepts a plan that fits.
  assert.equal(
    matchPlanDay({ candidates: [planDay({ distanceKm: 12 })], startedAtMs, localDate: "2026-09-14", distanceKm: 6.051 }),
    null
  );
  // A run whose own distance is unknown gives the neighbour rule nothing to check
  // a guess against, so it declines instead of labelling an arbitrary nearby day.
  assert.equal(
    matchPlanDay({ candidates: [planDay()], startedAtMs, localDate: "2026-09-14", distanceKm: null }),
    null
  );
  // The same-day match is an identity rather than a guess, so it still applies.
  assert.equal(
    matchPlanDay({
      candidates: [planDay({ localDate: "2026-09-14" })],
      startedAtMs,
      localDate: "2026-09-14",
      distanceKm: null
    })?.localDate,
    "2026-09-14"
  );
  // A push receipt is a record, not a guess, so it also survives an unknown distance.
  assert.equal(
    matchPlanDay({
      candidates: [
        planDay({
          matchedBy: "push_record",
          pushedAt: new Date(RUN_START_MS - 3 * 3_600_000).toISOString()
        })
      ],
      startedAtMs,
      localDate: "2026-09-14",
      distanceKm: null
    })?.matchedBy,
    "push_record"
  );
  // Highest revision wins when several describe the same date.
  assert.equal(
    matchPlanDay({
      candidates: [planDay({ revision: 6 }), planDay({ revision: 9 })],
      startedAtMs,
      localDate: "2026-09-14",
      distanceKm: 6.051
    })?.revision,
    9
  );
});

test("refuses to invent segments when neither producer has anything", () => {
  const result = resolveSegmentation({
    startedAtMs: 0,
    endedAtMs: TOTAL_SECONDS * 1000,
    events: [],
    plan: null,
    track: syntheticTrack()
  });
  assert.deepEqual(result.boundaries, []);
  assert.deepEqual(result.descriptors, []);
  assert.equal(result.plan, null);
  assert.equal(result.note, null);
});
