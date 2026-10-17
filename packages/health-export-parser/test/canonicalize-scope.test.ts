import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { healthTypes, workoutTypes } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { canonicalizeRunningWorkouts } from "../src/canonicalize.js";

/**
 * 邻域作用域的等价性回归。
 *
 * 判据不是"跑得快"，而是**两条路径产出逐字相同的库状态**：
 * `scope: "all"`（旧的全量候选集）vs `scope: "neighborhood"`（按 dirty 时间邻域加载）。
 * 外加一个可观测的"确实没扫全表"证据：`loadedWorkoutCount`。
 *
 * 夹具刻意覆盖四类难点：
 * - 重复组里被**软删**一个成员（组变小、canonical 换人）；
 * - 三成员**链式**重复（相邻 60–90s，首尾 150s —— 只有传递闭包能归到一组）；
 * - 一条训练被移到远处（旧组失去成员，旧组必须被找到并重建）；
 * - 会话 anchor 与训练 start 相差两小时（identity 命中在时间窗之外）。
 */

const DAY = "2026-03-01";

interface SeedWorkout {
  id: string;
  source: string;
  category: string;
  /** `HH:MM:SS`（UTC，固定到 2026-03-01）。 */
  time: string;
  durationSeconds: number;
  distanceMeters: number;
  device?: string | null;
}

const at = (time: string): string => `${DAY}T${time}.000Z`;

const BASE_WORKOUTS: SeedWorkout[] = [
  // A：同一次跑步的两份来源（apple_watch + coros），互为重复。
  { id: "w-dup-a1", source: "watch", category: "apple_watch", time: "07:00:00", durationSeconds: 2_700, distanceMeters: 10_000, device: "Watch" },
  { id: "w-dup-a2", source: "coros-app", category: "coros", time: "07:00:30", durationSeconds: 2_700, distanceMeters: 10_050 },
  // B：单条，且会话 anchor 稍后会被手工改到两小时之前（identity 通道的靶子）。
  { id: "w-single-b", source: "watch", category: "apple_watch", time: "08:00:00", durationSeconds: 1_800, distanceMeters: 6_000, device: "Watch" },
  // C：三成员链式重复：C1–C2 60s、C2–C3 90s、C1–C3 150s（只有传递闭包能归到一组）。
  { id: "w-chain-c1", source: "garmin", category: "connect", time: "09:00:00", durationSeconds: 3_600, distanceMeters: 12_000 },
  { id: "w-chain-c2", source: "huawei-app", category: "huawei", time: "09:01:00", durationSeconds: 3_600, distanceMeters: 12_050 },
  { id: "w-chain-c3", source: "coros-app", category: "coros", time: "09:02:30", durationSeconds: 3_600, distanceMeters: 12_020 },
  // D：与任何人都无关的对照组 —— 邻域路径不该加载它。
  { id: "w-single-d", source: "watch", category: "apple_watch", time: "10:00:00", durationSeconds: 1_200, distanceMeters: 4_000, device: "Watch" }
];

function seedWorkouts(store: RaiDatabase, workouts: readonly SeedWorkout[]): void {
  const insertWorkout = store.database.prepare(`
    INSERT INTO workouts (
      id, activity_type, source_name, source_category, source_version, device,
      start_at, end_at, duration_seconds, metadata_json, raw_attributes_json
    ) VALUES (?, ?, ?, ?, '1', ?, ?, ?, ?, '{}', '{}')
  `);
  const insertStat = store.database.prepare(`
    INSERT INTO workout_statistics (
      workout_id, ordinal, type, start_at, end_at, unit, sum_value,
      average_value, minimum_value, maximum_value
    ) VALUES (?, 0, ?, ?, ?, 'm', ?, NULL, NULL, NULL)
  `);
  store.database.exec("BEGIN IMMEDIATE");
  try {
    for (const workout of workouts) {
      const startAt = at(workout.time);
      const endAt = new Date(Date.parse(startAt) + workout.durationSeconds * 1_000).toISOString();
      insertWorkout.run(
        workout.id, workoutTypes.running, workout.source, workout.category,
        workout.device ?? null, startAt, endAt, workout.durationSeconds
      );
      insertStat.run(
        workout.id, healthTypes.distanceWalkingRunning, startAt, endAt, workout.distanceMeters
      );
    }
    store.database.exec("COMMIT");
  } catch (error) {
    store.database.exec("ROLLBACK");
    throw error;
  }
}

function dump(store: RaiDatabase): unknown {
  return {
    groups: store.database.prepare(
      "SELECT id, activity_type, canonical_workout_id, member_count, reason, training_session_id FROM workout_groups ORDER BY id"
    ).all(),
    members: store.database.prepare(
      "SELECT group_id, workout_id, is_canonical, canonical_rank FROM workout_group_members ORDER BY group_id, workout_id"
    ).all(),
    workouts: store.database.prepare(
      "SELECT id, canonical_group_id, is_canonical, start_at, end_at, duration_seconds, deleted_at FROM workouts ORDER BY id"
    ).all(),
    // 时间戳列不在判据里：同一份输入执行两次，`updated_at` 必然不同。
    sessions: store.database.prepare(
      "SELECT id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status FROM training_sessions ORDER BY id"
    ).all(),
    // `import_issues.id` 是 AUTOINCREMENT，重建一次就换号；比较业务列。
    issues: store.database.prepare(
      "SELECT code, object_id, message FROM import_issues ORDER BY code, object_id, message"
    ).all()
  };
}

async function withFixture(
  workouts: readonly SeedWorkout[],
  work: (store: RaiDatabase) => void
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "rai-canonicalize-scope-"));
  const store = await RaiDatabase.open(join(directory, "rai.sqlite"), { createMigrationBackup: false });
  try {
    seedWorkouts(store, workouts);
    work(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 全量建组 → 施加变更 → 用指定作用域跑增量。 */
async function runIncremental(
  workouts: readonly SeedWorkout[],
  mutate: (store: RaiDatabase) => string[],
  scope: "all" | "neighborhood"
): Promise<{ dump: unknown; result: ReturnType<typeof canonicalizeRunningWorkouts> }> {
  let captured: { dump: unknown; result: ReturnType<typeof canonicalizeRunningWorkouts> } | undefined;
  await withFixture(workouts, (store) => {
    canonicalizeRunningWorkouts(store.database);
    const dirtyWorkoutTimes = mutate(store);
    const result = canonicalizeRunningWorkouts(
      store.database, { dirtyWorkoutTimes }, { scope }
    );
    captured = { dump: dump(store), result };
  });
  assert.ok(captured !== undefined);
  return captured;
}

function applyMutations(store: RaiDatabase): string[] {
  // 1) 软删 A2：组从 2 人变 1 人，canonical 必须换人。
  store.database.prepare("UPDATE workouts SET deleted_at = ? WHERE id = 'w-dup-a2'")
    .run(at("12:00:00"));
  // 2) C3 被移到 11:00 且距离差距超出容差 ⇒ 离开 C 组，C 组要靠**旧组成员闭包**才找得回来。
  store.database.prepare(
    "UPDATE workouts SET start_at = ?, end_at = ?, duration_seconds = 3600 WHERE id = 'w-chain-c3'"
  ).run(at("11:00:00"), at("12:00:00"));
  store.database.prepare(
    "UPDATE workout_statistics SET sum_value = 5000 WHERE workout_id = 'w-chain-c3'"
  ).run();
  // 3) B 的会话 anchor 被改到两小时前：几何窗口（±120s）够不到，只有 identity 通道能找到它。
  store.database.prepare(
    "UPDATE training_sessions SET anchor_start_at = ?, anchor_end_at = ? WHERE canonical_workout_id = 'w-single-b'"
  ).run(at("06:00:00"), at("06:30:00"));
  return [at("11:00:00"), at("07:00:30"), at("08:00:00")];
}

test("neighborhood scope produces the same database state as the full candidate set", async () => {
  const all = await runIncremental(BASE_WORKOUTS, applyMutations, "all");
  const scoped = await runIncremental(BASE_WORKOUTS, applyMutations, "neighborhood");

  assert.deepEqual(scoped.dump, all.dump);
  // `runningWorkoutCount` 是**全局**口径，两条路径必须一致；组数/会话数描述的是"本次处理的
  // 子集"，作用域不同本来就会不同（D 没有参与邻域运行）—— 那不是可比的量。
  assert.equal(scoped.result.runningWorkoutCount, all.result.runningWorkoutCount);
  assert.equal(scoped.result.runningWorkoutCount, BASE_WORKOUTS.length - 1);
  // 确实没扫全表：A2 已软删不可加载，D 不该被邻域碰到。
  assert.equal(all.result.loadedWorkoutCount, BASE_WORKOUTS.length - 1);
  assert.ok(
    scoped.result.loadedWorkoutCount < all.result.loadedWorkoutCount,
    `expected scoped < all, got ${scoped.result.loadedWorkoutCount} vs ${all.result.loadedWorkoutCount}`
  );
});

test("empty dirty list skips both full loads and leaves the database byte-identical", async () => {
  await withFixture(BASE_WORKOUTS, (store) => {
    canonicalizeRunningWorkouts(store.database);
    const before = dump(store);
    const result = canonicalizeRunningWorkouts(store.database, { dirtyWorkoutTimes: [] });
    assert.equal(result.loadedWorkoutCount, 0);
    assert.equal(result.runningWorkoutCount, BASE_WORKOUTS.length);
    assert.equal(result.groupCount, 0);
    assert.equal(result.trainingSessionCount, 0);
    assert.deepEqual(dump(store), before);
  });
});

test("more than 64 dirty points fall back to a single min..max window and stay equivalent", async () => {
  const many: SeedWorkout[] = Array.from({ length: 80 }, (_, index) => ({
    id: `w-many-${index}`,
    source: `source-${index % 3}`,
    category: ["apple_watch", "coros", "connect"][index % 3]!,
    time: `${String(6 + (index % 12)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00`,
    durationSeconds: 1_200,
    distanceMeters: 3_000 + index
  }));
  const dirty = many.map((workout) => at(workout.time));
  const all = await runIncremental(many, () => dirty, "all");
  const scoped = await runIncremental(many, () => dirty, "neighborhood");
  assert.deepEqual(scoped.dump, all.dump);
  assert.equal(scoped.result.loadedWorkoutCount, all.result.loadedWorkoutCount);
});
