import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  MobileLockedSession,
  MobilePlannedDay,
  MobileSessionKind,
  MobileSessionStructure
} from "@rai/api-contracts";
import type { MetadataMap } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";

import { RaiReadStore } from "../src/data.js";
import type { PlanHistoryRevision, PlanPushRecord } from "../src/mobile-goals.js";
import {
  STRUCTURE_METADATA_KEY,
  assemblePlanCandidates,
  eventBoundariesOf,
  matchPlanDay,
  measuredStepsOf,
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
const seedRun = async (
  events: Array<{ type: string; atMs: number; durationSeconds: number }>,
  metadataJson = "{}"
) => {
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
        ?, ?, ?, 0, ?, '{}', 1)
    `)
    .run(
      workoutId,
      sourceName,
      new Date(RUN_START_MS).toISOString(),
      new Date(RUN_START_MS + TOTAL_SECONDS * 1000).toISOString(),
      TOTAL_SECONDS,
      metadataJson
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
    assert.equal(series.hasMeasuredWorkoutSteps, false, "Plan replay does not prove structured execution");
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

test("keeps the plan's steps when the Watch tiled the run with its own laps", async () => {
  // Laps that happen to line up with the prescription. The plan still owns the
  // skeleton: 课表分段 owes the reader the prescription's steps, and a lap set is
  // a record of the Watch's settings, not a prescription.
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
    assert.equal(series.hasMeasuredWorkoutSteps, false, "Plan replay does not prove structured execution");
    assert.match(series.segmentNote ?? "", /课表结构/);
    // The note has to say which record the panel used: from the phone, "the
    // plan's steps" and "the Watch's laps" are otherwise indistinguishable.
    assert.match(series.segmentNote ?? "", /手表另有 4 段 lap\/segment 事件未参与分段/);
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

/**
 * The 2026-09-14 run's Watch events, verbatim from the export.
 *
 * Eleven `HKWorkoutEventTypeSegment` rows that are really *two overlapping
 * partitions of the whole workout*: read each duration as "this segment ends
 * here" and you get seven segments of ≈1 km and four of ≈1.6 km, because both
 * of the Watch's lap settings got exported. Neither partition is the
 * prescription — its step boundaries sit at 300 s and ≈1 281 s, and no event
 * lands there. Ranking the events first is what showed 小唐 ten rows for a
 * four-step session.
 */
const REAL_WATCH_EVENTS = [
  { atMs: 0, durationSeconds: 380.9466 },
  { atMs: 0, durationSeconds: 614.5473 },
  { atMs: 381_000, durationSeconds: 379.171 },
  { atMs: 615_000, durationSeconds: 608.7803 },
  { atMs: 760_000, durationSeconds: 377.1247 },
  { atMs: 1_137_000, durationSeconds: 384.0159 },
  { atMs: 1_223_000, durationSeconds: 617.5232 },
  { atMs: 1_521_000, durationSeconds: 392.5292 },
  { atMs: 1_841_000, durationSeconds: 507.3994 },
  { atMs: 1_914_000, durationSeconds: 414.3 },
  { atMs: 2_328_000, durationSeconds: 20.1629 }
].map((event) => ({ type: "HKWorkoutEventTypeSegment", ...event }));

test("does not let two overlapping lap partitions explode a four-step session", async () => {
  const { root, databasePath, sessionId } = await seedRun(REAL_WATCH_EVENTS);
  const read = new RaiReadStore(databasePath);
  try {
    const series = read.workoutSeries(sessionId, [planDay()]);
    assert.ok(series);
    // The whole bug, in one number: eleven events used to mean ten rows.
    assert.equal(series.segments.length, 4);
    assert.deepEqual(
      series.segments.map((segment) => segment.label),
      ["热身", "训练", "整理放松", "自由训练"]
    );
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.distanceMeters)),
      [773, 2600, 775, 1903]
    );
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.startOffsetSeconds)),
      [0, 300, 1281, 1581]
    );
    // And the reader is told what was set aside, in the same units the panel
    // uses: the ten rows the Watch's events would have drawn.
    assert.match(series.segmentNote ?? "", /手表另有 10 段 lap\/segment 事件未参与分段/);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The step layer the Watch itself recorded for that same run, copied out of
 * `workouts.metadata_json` on 2026-09-15. Three activities against a three-step
 * prescription: warmup `time 300 s`, work `distance 2 600 m`, cooldown
 * `time 300 s`. The boundaries land at 300.000 s and 1 283.456 s, and the
 * cooldown ends 0.4 s early because the workout was stopped.
 */
const REAL_STEP_LAYER = {
  activityCount: 3,
  activities: [
    { startMs: 0, durationMs: 300_000, activityTypeRaw: 37, locationRaw: 3, metadataKeys: ["WOIntervalStepKeyPath"] },
    { startMs: 300_000, durationMs: 983_456, activityTypeRaw: 37, locationRaw: 3, metadataKeys: ["WOIntervalStepKeyPath"] },
    { startMs: 1_283_456, durationMs: 299_619, activityTypeRaw: 37, locationRaw: 3, metadataKeys: ["WOIntervalStepKeyPath"] }
  ]
};

/**
 * A workout's `metadata_json`, built the way the parser builds it.
 *
 * Annotating the literal as `MetadataMap` is the point, not decoration: the real
 * value is `Record<string, string[]>`, because the parser appends on every
 * `MetadataEntry` (`health-export-parser/src/utils.ts:91`). The first version of
 * this fixture hand-wrote the key as a bare string — the author's guess about the
 * shape, asserted as if it were the contract — so the reader and its fixture
 * agreed with each other and both disagreed with the database, and the feature
 * shipped dead (`965cd54`). Typing the literal against the contract means a
 * change of shape breaks `typecheck` instead of breaking production.
 */
const workoutMetadata = (payload: unknown): string => {
  const metadata: MetadataMap = {};
  metadata[STRUCTURE_METADATA_KEY] = [JSON.stringify(payload)];
  return JSON.stringify(metadata);
};

test("measures the steps the Watch recorded instead of replaying the plan", async () => {
  const { root, databasePath, sessionId } = await seedRun(
    REAL_WATCH_EVENTS,
    workoutMetadata(REAL_STEP_LAYER)
  );
  const read = new RaiReadStore(databasePath);
  try {
    const series = read.workoutSeries(sessionId, [planDay()]);
    assert.ok(series);
    assert.equal(series.segments.length, 4);
    // Labels and goals still come from the prescription; only the boundaries are
    // measured. That split is the whole design.
    assert.deepEqual(
      series.segments.map((segment) => segment.label),
      ["热身", "训练", "整理放松", "自由训练"]
    );
    assert.equal(series.segments[0]?.goalSeconds, 300);
    assert.equal(series.segments[1]?.goalMeters, 2600);
    // The measured ends, not the replayed ones: the plan replay puts these at
    // 1 281 s / 1 581 s, so these three numbers are the proof it was used.
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.startOffsetSeconds)),
      [0, 300, 1283, 1583]
    );
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.durationSeconds)),
      [300, 983, 300, 768]
    );
    // Same four phases, re-cut 2.5 s later: 6 m of the cooldown moves into the
    // work step, and the free stretch loses 5 m.
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.distanceMeters)),
      [773, 2606, 774, 1898]
    );
    assert.equal(series.hasMeasuredWorkoutSteps, true);
    assert.match(series.segmentNote ?? "", /分段由手表记录的 3 个训练步骤实测得到/);
    assert.match(series.segmentNote ?? "", /手表另有 10 段 lap\/segment 事件未参与分段/);
    assert.equal(series.segmentPlan?.reason, "按手表记录的步骤实测");
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a measured step layer that disagrees with the plan wins, and says so", async () => {
  // The runner stopped the work step at 1 100 s instead of the prescribed
  // 2 600 m, then ran a longer cooldown. The replay would still claim 1 281 s.
  const stoppedEarly = {
    activityCount: 3,
    activities: [
      { startMs: 0, durationMs: 300_000, activityTypeRaw: 37, locationRaw: 3, metadataKeys: [] },
      { startMs: 300_000, durationMs: 800_000, activityTypeRaw: 37, locationRaw: 3, metadataKeys: [] },
      { startMs: 1_100_000, durationMs: 300_000, activityTypeRaw: 37, locationRaw: 3, metadataKeys: [] }
    ]
  };
  const { root, databasePath, sessionId } = await seedRun([], workoutMetadata(stoppedEarly));
  const read = new RaiReadStore(databasePath);
  try {
    const series = read.workoutSeries(sessionId, [planDay()]);
    assert.ok(series);
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.startOffsetSeconds)),
      [0, 300, 1100, 1400]
    );
    assert.deepEqual(
      series.segments.map((segment) => segment.label),
      ["热身", "训练", "整理放松", "自由训练"]
    );
    assert.equal(series.hasMeasuredWorkoutSteps, true);
    assert.match(series.segmentNote ?? "", /分段由手表记录的 3 个训练步骤实测得到/);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single whole-workout activity means no measured steps, so the replay stands", async () => {
  // Every run carries one activity; only a structured session adds more. A run
  // recorded without a plan must not lose its replay to a single "step".
  const wholeRun = {
    activityCount: 1,
    activities: [
      {
        startMs: 0,
        durationMs: TOTAL_SECONDS * 1000,
        activityTypeRaw: 37,
        locationRaw: 3,
        metadataKeys: []
      }
    ]
  };
  const { root, databasePath, sessionId } = await seedRun([], workoutMetadata(wholeRun));
  const read = new RaiReadStore(databasePath);
  try {
    const series = read.workoutSeries(sessionId, [planDay()]);
    assert.ok(series);
    assert.deepEqual(
      series.segments.map((segment) => Math.round(segment.startOffsetSeconds)),
      [0, 300, 1281, 1581]
    );
    assert.equal(series.hasMeasuredWorkoutSteps, false, "Plan replay does not prove structured execution");
    assert.match(series.segmentNote ?? "", /课表结构/);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads the step layer only when the metadata really carries one", () => {
  const startedAtMs = RUN_START_MS;
  const endedAtMs = RUN_START_MS + TOTAL_SECONDS * 1000;
  const steps = measuredStepsOf(workoutMetadata(REAL_STEP_LAYER), startedAtMs, endedAtMs);
  assert.deepEqual(
    steps.map((step) => [step.startMs - startedAtMs, step.endMs - step.startMs]),
    [
      [0, 300_000],
      [300_000, 983_456],
      [1_283_456, 299_619]
    ]
  );

  // Both shapes the key can take are read: the one-element array the parser
  // actually writes, and a bare string (what the first version of the reader
  // assumed). Neither a hand-built import nor a contract change may silently
  // kill the feature the way `965cd54` did.
  assert.deepEqual(
    measuredStepsOf(
      JSON.stringify({ [STRUCTURE_METADATA_KEY]: JSON.stringify(REAL_STEP_LAYER) }),
      startedAtMs,
      endedAtMs
    ),
    steps
  );

  // A repeated key is ambiguous, so the last entry wins — the same rule
  // `lastMetadataValue` applies everywhere else.
  assert.deepEqual(
    measuredStepsOf(
      JSON.stringify({
        [STRUCTURE_METADATA_KEY]: [JSON.stringify({ activities: [] }), JSON.stringify(REAL_STEP_LAYER)]
      }),
      startedAtMs,
      endedAtMs
    ),
    steps
  );

  // Absent, unparsable, or a payload with no usable steps: every one of them must
  // decline rather than throw or invent a step.
  assert.deepEqual(measuredStepsOf(null, startedAtMs, endedAtMs), []);
  assert.deepEqual(measuredStepsOf("{}", startedAtMs, endedAtMs), []);
  assert.deepEqual(measuredStepsOf("not json", startedAtMs, endedAtMs), []);
  assert.deepEqual(
    measuredStepsOf(JSON.stringify({ [STRUCTURE_METADATA_KEY]: ["not json"] }), startedAtMs, endedAtMs),
    []
  );
  assert.deepEqual(
    measuredStepsOf(JSON.stringify({ [STRUCTURE_METADATA_KEY]: [] }), startedAtMs, endedAtMs),
    []
  );
  assert.deepEqual(
    measuredStepsOf(
      JSON.stringify({ [STRUCTURE_METADATA_KEY]: [JSON.stringify({ activities: [{ startMs: 0 }] })] }),
      startedAtMs,
      endedAtMs
    ),
    []
  );

  // A multisport workout puts different sports in one workout; labelling those
  // as run steps would be a lie, so the whole layer is declined.
  const multisport = {
    activities: [
      { startMs: 0, durationMs: 600_000, activityTypeRaw: 37, locationRaw: 3, metadataKeys: [] },
      { startMs: 600_000, durationMs: 600_000, activityTypeRaw: 13, locationRaw: 3, metadataKeys: [] }
    ]
  };
  assert.deepEqual(measuredStepsOf(workoutMetadata(multisport), startedAtMs, endedAtMs), []);

  // Overlapping steps cannot be tiled into rows.
  const overlapping = {
    activities: [
      { startMs: 0, durationMs: 600_000, activityTypeRaw: 37, locationRaw: 3, metadataKeys: [] },
      { startMs: 300_000, durationMs: 600_000, activityTypeRaw: 37, locationRaw: 3, metadataKeys: [] }
    ]
  };
  assert.deepEqual(measuredStepsOf(workoutMetadata(overlapping), startedAtMs, endedAtMs), []);

  // A sliver is measurement noise, and dropping it leaves fewer than two steps,
  // which leaves the caller on its previous path.
  const slivers = {
    activities: [
      { startMs: 0, durationMs: 1_000, activityTypeRaw: 37, locationRaw: 3, metadataKeys: [] },
      { startMs: 100_000, durationMs: 400_000, activityTypeRaw: 37, locationRaw: 3, metadataKeys: [] }
    ]
  };
  assert.deepEqual(measuredStepsOf(workoutMetadata(slivers), startedAtMs, endedAtMs), [
    { startMs: startedAtMs + 100_000, endMs: startedAtMs + 500_000 }
  ]);
});

test("a first step timed slightly before the workout start is clamped, not dropped", async () => {
  // The workout start is derived from the first sample; the step layer's first
  // offset is measured from the activity record. On 2026-09-14 the two were
  // 250 ms apart, and the old reader dropped that step for starting "before"
  // the workout. Dropping it shifts every later step one slot left in
  // `planned[index]`, so the recovery step at 1 283 s is labelled 训练 — a
  // plausible-looking panel that is quietly wrong.
  const negativeFirstOffset = {
    activityCount: 3,
    activities: [
      { startMs: -250, durationMs: 300_250, activityTypeRaw: 37, locationRaw: 3, metadataKeys: ["WOIntervalStepKeyPath"] },
      { startMs: 300_000, durationMs: 983_456, activityTypeRaw: 37, locationRaw: 3, metadataKeys: ["WOIntervalStepKeyPath"] },
      { startMs: 1_283_456, durationMs: 299_619, activityTypeRaw: 37, locationRaw: 3, metadataKeys: ["WOIntervalStepKeyPath"] }
    ]
  };
  const startedAtMs = RUN_START_MS;
  const endedAtMs = RUN_START_MS + TOTAL_SECONDS * 1000;

  // The unit-level contract: the first step survives, pinned to the workout
  // start, and the two steps after it keep their measured boundaries.
  assert.deepEqual(measuredStepsOf(workoutMetadata(negativeFirstOffset), startedAtMs, endedAtMs), [
    { startMs: startedAtMs, endMs: startedAtMs + 300_000 },
    { startMs: startedAtMs + 300_000, endMs: startedAtMs + 1_283_456 },
    { startMs: startedAtMs + 1_283_456, endMs: startedAtMs + 1_583_075 }
  ]);

  // And end to end: all four prescribed labels come back in order, with the
  // measured boundaries still deciding where each one ends.
  const { root, databasePath, sessionId } = await seedRun([], workoutMetadata(negativeFirstOffset));
  const read = new RaiReadStore(databasePath);
  try {
    const series = read.workoutSeries(sessionId, [planDay()]);
    assert.ok(series);
    assert.deepEqual(
      series.segments.map((segment) => segment.label),
      ["热身", "训练", "整理放松", "自由训练"]
    );
    assert.equal(series.hasMeasuredWorkoutSteps, true);
    assert.match(series.segmentNote ?? "", /分段由手表记录的 3 个训练步骤实测得到/);
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A stored week-plan day, as `MobileGoalsStore.planHistory` hands it over. */
const storedDay = (
  localDate: string,
  kind: MobileSessionKind,
  distanceKm: number | null
): MobilePlannedDay => ({
  localDate,
  kind,
  distanceKm,
  structure: kind === "rest" ? null : INTERVAL_STRUCTURE
});

const lockedSession = (localDate: string): MobileLockedSession => ({
  localDate,
  session: {
    kind: "recovery",
    title: "恢复跑",
    reason: "模型不可用，按保守模板安排",
    distanceKm: 4,
    durationMinutes: null,
    paceSecondsPerKmLower: null,
    paceSecondsPerKmUpper: null,
    heartRateBpmLower: null,
    heartRateBpmUpper: null,
    structure: INTERVAL_STRUCTURE
  },
  verdictTone: "green",
  lockedAt: "2026-09-15T02:00:00.000Z"
});

test("a newer revision's rest day answers for its date", () => {
  // Newest first, exactly what the store returns. Revision 6 turned 09-14 into
  // rest; revision 3 still remembered it as a 2.4 km easy day.
  const history: PlanHistoryRevision[] = [
    {
      revision: 6,
      changedAt: "2026-09-14T08:06:40.252Z",
      weekPlan: [storedDay("2026-09-14", "rest", null), storedDay("2026-09-15", "recovery", 4)],
      lockedSession: null
    },
    {
      revision: 3,
      changedAt: "2026-09-14T07:17:49.709Z",
      weekPlan: [storedDay("2026-09-14", "easy", 2.4), storedDay("2026-09-15", "rest", null)],
      lockedSession: null
    }
  ];
  const candidates = assemblePlanCandidates([], history);
  // Revision 3's easy day is not resurrected, and revision 6's recovery day is
  // the only thing left that can explain a Monday-evening run.
  assert.deepEqual(
    candidates.map((candidate) => [candidate.localDate, candidate.kind, candidate.revision]),
    [["2026-09-15", "recovery", 6]]
  );
  const matched = matchPlanDay({
    candidates,
    startedAtMs: RUN_START_MS,
    localDate: "2026-09-14",
    distanceKm: 6.051
  });
  assert.equal(matched?.localDate, "2026-09-15");
  assert.equal(matched?.revision, 6);
  // The prescription the runner actually executed — warmup 300 s, work 2 600 m,
  // cooldown 300 s — rather than the 1 000 m step of the stale revision.
  const workStep = matched?.structure.blocks[0]?.steps[0];
  assert.equal(workStep?.goal.type, "distance");
  assert.equal(workStep?.goal.type === "distance" ? workStep.goal.meters : null, 2600);
});

test("reads candidates in precedence order: receipt, lock, newest revision", () => {
  const receipt: PlanPushRecord = {
    localDate: "2026-09-15",
    revision: 5,
    kind: "recovery",
    structure: INTERVAL_STRUCTURE,
    pushedAt: "2026-09-14T09:00:00.000Z"
  };
  const history: PlanHistoryRevision[] = [
    {
      revision: 7,
      changedAt: "2026-09-15T02:00:00.000Z",
      // The week plan calls today rest; the lock says otherwise. The lock is what
      // the app told the runner to run, so it wins for that date.
      weekPlan: [storedDay("2026-09-15", "rest", null)],
      lockedSession: lockedSession("2026-09-15")
    },
    {
      revision: 3,
      changedAt: "2026-09-14T07:17:49.709Z",
      weekPlan: [storedDay("2026-09-15", "easy", 2.4)],
      lockedSession: null
    }
  ];
  const candidates = assemblePlanCandidates([receipt], history);
  // The receipt is kept verbatim — it is a record of what the Watch was handed,
  // not a reading of the current plan.
  assert.deepEqual(
    candidates[0],
    {
      localDate: "2026-09-15",
      kind: "recovery",
      revision: 5,
      matchedBy: "push_record",
      structure: INTERVAL_STRUCTURE,
      distanceKm: null,
      pushedAt: "2026-09-14T09:00:00.000Z"
    }
  );
  // One entry per date: the revision-7 lock claims 09-15, so neither the rest
  // day beside it nor revision 3's easy day is added.
  assert.deepEqual(
    candidates.slice(1).map((candidate) => [candidate.localDate, candidate.revision]),
    [["2026-09-15", 7]]
  );
  // A receipt without a structure is a bare acknowledgement and explains nothing.
  assert.deepEqual(assemblePlanCandidates([{ ...receipt, structure: null }], []), []);
});

test("says why there are no segments instead of leaving the panel blank", async () => {
  const { root, databasePath, sessionId } = await seedRun([]);
  const read = new RaiReadStore(databasePath);
  try {
    const series = read.workoutSeries(sessionId, []);
    assert.ok(series);
    assert.equal(series.hasMeasuredWorkoutSteps, false);
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

test("workoutSeries builds the speed track at most once per request, including an unusable track", async () => {
  const { root, databasePath, sessionId } = await seedRun([]);
  const read = new RaiReadStore(databasePath);
  try {
    const repository = (read as unknown as {
      seriesRepository: { metricIntervals: (...args: unknown[]) => unknown };
    }).seriesRepository;
    const original = repository.metricIntervals.bind(repository);
    let speedTrackQueries = 0;
    repository.metricIntervals = (type: unknown, ...rest: unknown[]) => {
      if (type === "HKQuantityTypeIdentifierRunningSpeed") speedTrackQueries += 1;
      return original(type, ...rest);
    };
    const first = read.workoutSeries(sessionId, [planDay()]);
    assert.equal(speedTrackQueries, 1, "segmentRun + measureSegments + workoutSplits share one build");
    assert.ok((first?.segments.length ?? 0) > 0);
    assert.ok((first?.splits.length ?? 0) > 0);
    read.workoutSeries(sessionId, [planDay()]);
    assert.equal(speedTrackQueries, 2, "the provider is request-local, not a process-wide cache");
    assert.equal((read as unknown as { database: { isTransaction: boolean } }).database.isTransaction, false,
      "the short read snapshot must be committed, not left open between requests");
  } finally {
    read.close();
    rmSync(root, { recursive: true, force: true });
  }

  // A run whose track is unusable must cache the `null` result as well: the
  // second consumer cannot turn "no track" into another overlap query.
  const withoutSpeed = await seedRun([]);
  const writer = new DatabaseSync(withoutSpeed.databasePath);
  try {
    writer.prepare("DELETE FROM health_records WHERE type = 'HKQuantityTypeIdentifierRunningSpeed'").run();
  } finally { writer.close(); }
  const nullRead = new RaiReadStore(withoutSpeed.databasePath);
  try {
    const repository = (nullRead as unknown as {
      seriesRepository: { metricIntervals: (...args: unknown[]) => unknown };
    }).seriesRepository;
    const original = repository.metricIntervals.bind(repository);
    let speedTrackQueries = 0;
    repository.metricIntervals = (type: unknown, ...rest: unknown[]) => {
      if (type === "HKQuantityTypeIdentifierRunningSpeed") speedTrackQueries += 1;
      return original(type, ...rest);
    };
    const series = nullRead.workoutSeries(withoutSpeed.sessionId, [planDay()]);
    assert.equal(speedTrackQueries, 1, "null track is memoized too");
    assert.deepEqual(series?.segments, []);
    assert.deepEqual(series?.splits, []);
  } finally {
    nullRead.close();
    rmSync(withoutSpeed.root, { recursive: true, force: true });
  }
});
