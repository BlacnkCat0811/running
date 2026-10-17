import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { beginOwnedTransaction, commitOwnedTransaction, rollbackOwnedTransaction } from "./owned-transaction.js";
import { workoutPresentConditionSql } from "@rai/storage-sqlite";

import { healthTypes, workoutTypes } from "@rai/contracts";

import { distanceToKilometers, stableId } from "./utils.js";

interface WorkoutCandidate {
  id: string;
  activityType: string;
  sourceCategory: string;
  startAt: string;
  endAt: string;
  durationSeconds: number;
  distanceValue: number | null;
  distanceUnit: string | null;
  routeCount: number;
  heartRateStatisticCount: number;
  runningDynamicsCount: number;
  hasDevice: number;
}

interface ExistingTrainingSession {
  id: string;
  canonicalWorkoutId: string | null;
  activityType: string;
  anchorStartAt: string;
  anchorEndAt: string;
  anchorDistanceKm: number | null;
  status: string;
}

/** Prefer rematching onto live sessions: active < ambiguous < inactive. */
function sessionStatusRank(status: string): number {
  if (status === "active") return 0;
  if (status === "ambiguous") return 1;
  return 2; // inactive (and any unexpected status)
}

export interface CanonicalizationResult {
  runningWorkoutCount: number;
  groupCount: number;
  duplicateGroupCount: number;
  excludedDuplicateCount: number;
  trainingSessionCount: number;
  ambiguousTrainingSessionCount: number;
  affectedWorkoutCount?: number;
  /**
   * 本次实际加载的 `WorkoutCandidate` 行数。
   *
   * 它是"没有扫全表"的**唯一**可断言证据：快速路径为 0，邻域作用域为闭包集合的大小，
   * 全量路径等于 `runningWorkoutCount`。别拿耗时当判据 —— 那是机器属性，不是行为。
   */
  loadedWorkoutCount: number;
}

export interface IncrementalCanonicalizationOptions {
  dirtyWorkoutTimes: readonly string[];
}

/** 调用方持有事务时本段使用的 SAVEPOINT 名。 */
export const CANONICALIZE_WORKOUTS_SAVEPOINT = "rai_canonicalize_workouts";

/**
 * 邻域作用域的边界参数。
 *
 * `SCOPE_WINDOW_MS` 必须与 {@link overlapsAsDuplicate} 的 120s 门槛同值：作用域是
 * "所有**可能**被 union 的候选"的超集，窗口比它小就会漏掉真实的重复。
 */
const SCOPE_WINDOW_MS = 120_000;
/** 超过这么多 dirty 点就退化成"min..max 单区间"（仍是作用域，不会漏）。 */
const MAX_SCOPE_WINDOWS = 64;
/** 单区间跨一年以上时与全量没有区别，直接回退全量（省掉一次无意义的窗口扫描）。 */
const MAX_SCOPE_SPAN_MS = 365 * 86_400_000;
/** 极端批次（首装全量）不做邻域：脏点本身就有上万条。 */
const MAX_DIRTY_WINDOWS_FOR_SCOPE = 5_000;
/** 闭包轮数上限；不收敛 ⇒ 回退全量（安全方向，绝不"差不多就停"）。 */
const MAX_CLOSURE_ROUNDS = 8;
/** `IN (?,?,…)` 的变量数上限（旧版 SQLite 是 999，这里留足余量）。 */
const ID_CHUNK_SIZE = 400;
const WINDOW_CHUNK_SIZE = 100;

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parent[index];
    if (parent === undefined) throw new Error("Union-find index out of bounds");
    if (parent !== index) this.parent[index] = this.find(parent);
    return this.parent[index] ?? index;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent[rightRoot] = leftRoot;
  }
}

function overlapsAsDuplicate(left: WorkoutCandidate, right: WorkoutCandidate): boolean {
  const leftStart = Date.parse(left.startAt);
  const rightStart = Date.parse(right.startAt);
  const leftEnd = Date.parse(left.endAt);
  const rightEnd = Date.parse(right.endAt);
  if (![leftStart, rightStart, leftEnd, rightEnd].every(Number.isFinite)) return false;

  const startDifferenceSeconds = Math.abs(leftStart - rightStart) / 1000;
  if (startDifferenceSeconds > 120) return false;

  const overlapSeconds =
    Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart)) / 1000;
  const minimumDuration = Math.max(1, Math.min(left.durationSeconds, right.durationSeconds));
  if (overlapSeconds / minimumDuration < 0.85) return false;

  const leftDistance = distanceToKilometers(left.distanceValue, left.distanceUnit);
  const rightDistance = distanceToKilometers(right.distanceValue, right.distanceUnit);
  if (leftDistance !== null && rightDistance !== null) {
    const tolerance = Math.max(0.2, 0.03 * Math.max(leftDistance, rightDistance));
    return Math.abs(leftDistance - rightDistance) <= tolerance;
  }

  const durationTolerance = Math.max(
    120,
    0.05 * Math.max(left.durationSeconds, right.durationSeconds)
  );
  return Math.abs(left.durationSeconds - right.durationSeconds) <= durationTolerance;
}

function sourceRank(category: string): number {
  switch (category) {
    case "apple_watch":
      return 30;
    case "coros":
      return 20;
    case "huawei":
      return 10;
    case "connect":
      return 5;
    default:
      return 0;
  }
}

function canonicalRank(workout: WorkoutCandidate): number {
  return (
    sourceRank(workout.sourceCategory) +
    workout.routeCount * 100 +
    workout.heartRateStatisticCount * 40 +
    workout.runningDynamicsCount * 8 +
    workout.hasDevice * 5
  );
}

function matchesExistingTrainingSession(
  workout: WorkoutCandidate,
  session: ExistingTrainingSession
): boolean {
  if (workout.activityType !== session.activityType) return false;

  const workoutStart = Date.parse(workout.startAt);
  const workoutEnd = Date.parse(workout.endAt);
  const sessionStart = Date.parse(session.anchorStartAt);
  const sessionEnd = Date.parse(session.anchorEndAt);
  if (![workoutStart, workoutEnd, sessionStart, sessionEnd].every(Number.isFinite)) {
    return false;
  }

  if (Math.abs(workoutStart - sessionStart) / 1000 > 120) return false;
  const overlapSeconds =
    Math.max(0, Math.min(workoutEnd, sessionEnd) - Math.max(workoutStart, sessionStart)) / 1000;
  const sessionDuration = Math.max(1, (sessionEnd - sessionStart) / 1000);
  if (overlapSeconds / Math.min(workout.durationSeconds, sessionDuration) < 0.85) {
    return false;
  }

  const workoutDistance = distanceToKilometers(workout.distanceValue, workout.distanceUnit);
  if (workoutDistance !== null && session.anchorDistanceKm !== null) {
    const tolerance = Math.max(0.2, 0.03 * Math.max(workoutDistance, session.anchorDistanceKm));
    return Math.abs(workoutDistance - session.anchorDistanceKm) <= tolerance;
  }

  return Math.abs(workout.durationSeconds - sessionDuration) <= Math.max(
    120,
    0.05 * Math.max(workout.durationSeconds, sessionDuration)
  );
}

/**
 * 候选行的列清单与统计子查询**只有这一份**：全量加载与按 id 加载必须给出同形的候选，
 * 否则 `canonicalRank` 会在两条路径上算出不同的 canonical。
 */
const RUNNING_WORKOUT_SELECT = `
      SELECT
        w.id,
        w.activity_type AS activityType,
        w.source_category AS sourceCategory,
        w.start_at AS startAt,
        w.end_at AS endAt,
        w.duration_seconds AS durationSeconds,
        (
          SELECT ws.sum_value
          FROM workout_statistics ws
          WHERE ws.workout_id = w.id
            AND ws.type = ?
          ORDER BY ws.ordinal
          LIMIT 1
        ) AS distanceValue,
        (
          SELECT ws.unit
          FROM workout_statistics ws
          WHERE ws.workout_id = w.id
            AND ws.type = ?
          ORDER BY ws.ordinal
          LIMIT 1
        ) AS distanceUnit,
        (SELECT COUNT(*) FROM workout_routes wr WHERE wr.workout_id = w.id) AS routeCount,
        (
          SELECT COUNT(*) FROM workout_statistics ws
          WHERE ws.workout_id = w.id AND ws.type = ?
        ) AS heartRateStatisticCount,
        (
          SELECT COUNT(*) FROM workout_statistics ws
          WHERE ws.workout_id = w.id AND ws.type IN (?, ?, ?, ?, ?)
        ) AS runningDynamicsCount,
        CASE WHEN w.device IS NULL THEN 0 ELSE 1 END AS hasDevice
      FROM workouts w`;

/** 与 `RUNNING_WORKOUT_SELECT` 的 8 个统计类型 `?` 一一对应。 */
function runningWorkoutFilterParams(): SQLInputValue[] {
  return [
    healthTypes.distanceWalkingRunning,
    healthTypes.distanceWalkingRunning,
    healthTypes.heartRate,
    healthTypes.runningPower,
    healthTypes.runningSpeed,
    healthTypes.runningStrideLength,
    healthTypes.runningVerticalOscillation,
    healthTypes.runningGroundContactTime
  ];
}

/**
 * `ORDER BY start_at, id` 不是装饰：配对循环用 `startDifferenceSeconds > 120` **break**，
 * 换成按主键或 rowid 取行会静默漏掉后面的 union 边（组会变小、canonical 会换人）。
 */
const RUNNING_WORKOUT_ORDER = "ORDER BY w.start_at, w.id";

function loadRunningWorkouts(database: DatabaseSync): WorkoutCandidate[] {
  return database
    .prepare(`${RUNNING_WORKOUT_SELECT}
      WHERE w.activity_type = ? AND ${workoutPresentConditionSql("w")}
      ${RUNNING_WORKOUT_ORDER}`)
    .all(...runningWorkoutFilterParams(), workoutTypes.running) as unknown as WorkoutCandidate[];
}

function countRunningWorkouts(database: DatabaseSync): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM workouts w
      WHERE w.activity_type = ? AND ${workoutPresentConditionSql("w")}`)
    .get(workoutTypes.running) as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function loadRunningWorkoutsByIds(
  database: DatabaseSync,
  ids: ReadonlySet<string>
): WorkoutCandidate[] {
  if (ids.size === 0) return [];
  const rows: WorkoutCandidate[] = [];
  for (const chunk of chunkValues([...ids], ID_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    rows.push(...database
      .prepare(`${RUNNING_WORKOUT_SELECT}
        WHERE w.activity_type = ? AND ${workoutPresentConditionSql("w")}
          AND w.id IN (${placeholders})
        ${RUNNING_WORKOUT_ORDER}`)
      .all(...runningWorkoutFilterParams(), workoutTypes.running, ...chunk) as unknown as WorkoutCandidate[]);
  }
  // 分块查询后必须重新排序：配对循环的 break 依赖全局升序。
  rows.sort((left, right) =>
    left.startAt === right.startAt ? left.id.localeCompare(right.id) : left.startAt < right.startAt ? -1 : 1);
  return rows;
}

/** 会话列清单的唯一来源：全量与局部加载必须同形。 */
const TRAINING_SESSION_SELECT = `
      SELECT
        id,
        activity_type AS activityType,
        anchor_start_at AS anchorStartAt,
        anchor_end_at AS anchorEndAt,
        anchor_distance_km AS anchorDistanceKm,
        canonical_workout_id AS canonicalWorkoutId,
        status
      FROM training_sessions`;

function loadExistingTrainingSessions(database: DatabaseSync): ExistingTrainingSession[] {
  return database
    .prepare(`${TRAINING_SESSION_SELECT}
      WHERE activity_type = ? AND status IN ('active', 'ambiguous', 'inactive')
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END,
        id
    `)
    .all(workoutTypes.running) as unknown as ExistingTrainingSession[];
}

function selectWorkoutIdsInWindows(
  database: DatabaseSync,
  windows: ReadonlyArray<readonly [number, number]>
): string[] {
  const ids = new Set<string>();
  for (const chunk of chunkValues(windows, WINDOW_CHUNK_SIZE)) {
    const clause = chunk.map(() => "(w.start_at BETWEEN ? AND ?)").join(" OR ");
    const params = chunk.flatMap(([from, to]) => [
      new Date(from).toISOString(),
      new Date(to).toISOString()
    ]);
    const rows = database
      .prepare(`SELECT w.id AS id FROM workouts w
        WHERE w.activity_type = ? AND ${workoutPresentConditionSql("w")} AND (${clause})`)
      .all(workoutTypes.running, ...params) as unknown as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  }
  return [...ids];
}

function selectGroupMemberIds(
  database: DatabaseSync,
  workoutIds: readonly string[]
): string[] {
  const ids = new Set<string>();
  for (const chunk of chunkValues(workoutIds, ID_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = database
      .prepare(`SELECT DISTINCT member.workout_id AS id
        FROM workout_group_members member
        WHERE member.group_id IN (
          SELECT group_id FROM workout_group_members WHERE workout_id IN (${placeholders})
        )`)
      .all(...chunk) as unknown as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  }
  return [...ids];
}

/**
 * 本批真正可能被改写的训练集合 = dirty 时间 ±120s 的初始集合 → 同组成员 ∪ 重复邻居的闭包。
 *
 * 返回 `null` 表示"放弃作用域、退回全量加载"（跨度过大 / 脏点过多 / 闭包不收敛）。
 * 方向必须是**超集**：多加载只会多算，漏加载会留下指向已删组的 `canonical_group_id`。
 */
function selectAffectedWorkoutIds(
  database: DatabaseSync,
  dirtyTimes: readonly number[]
): { ids: Set<string> } | null {
  if (dirtyTimes.length > MAX_DIRTY_WINDOWS_FOR_SCOPE) return null;
  const min = Math.min(...dirtyTimes) - SCOPE_WINDOW_MS;
  const max = Math.max(...dirtyTimes) + SCOPE_WINDOW_MS;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max - min > MAX_SCOPE_SPAN_MS) return null;

  const windows: Array<readonly [number, number]> = dirtyTimes.length > MAX_SCOPE_WINDOWS
    ? [[min, max]]
    : dirtyTimes.map((time) => [time - SCOPE_WINDOW_MS, time + SCOPE_WINDOW_MS] as const);
  const selected = new Map<string, WorkoutCandidate>();
  for (const row of loadRunningWorkoutsByIds(database, new Set(selectWorkoutIdsInWindows(database, windows)))) {
    selected.set(row.id, row);
  }

  for (let round = 0; round < MAX_CLOSURE_ROUNDS; round += 1) {
    const sizeBefore = selected.size;
    // (a) 同组成员必须**整组**纳入：组 id 由成员 id 集合决定，少一个成员就会算出另一个组，
    //     而该成员原来那一行会被 `deleteGroup` 级联删掉 ⇒ 变成指向已删组的悬空引用。
    const memberIds = selectGroupMemberIds(database, [...selected.keys()])
      .filter((id) => !selected.has(id));
    if (memberIds.length > 0) {
      for (const row of loadRunningWorkoutsByIds(database, new Set(memberIds))) {
        selected.set(row.id, row);
      }
    }
    // (b) ±120s 邻居里**确实构成重复**的。不能把整个窗口都选进来：那会把不相干的
    //     singleton 也重写一遍，`groupCount` 与写入行数都会偏离全量运行。
    const starts = [...selected.values()]
      .map((workout) => Date.parse(workout.startAt))
      .filter((value) => Number.isFinite(value));
    const neighborIds = selectWorkoutIdsInWindows(
      database, starts.map((time) => [time - SCOPE_WINDOW_MS, time + SCOPE_WINDOW_MS] as const)
    ).filter((id) => !selected.has(id));
    if (neighborIds.length > 0) {
      const members = [...selected.values()];
      for (const candidate of loadRunningWorkoutsByIds(database, new Set(neighborIds))) {
        if (members.some((member) => overlapsAsDuplicate(member, candidate))) {
          selected.set(candidate.id, candidate);
        }
      }
    }
    if (selected.size === sizeBefore) return { ids: new Set(selected.keys()) };
  }
  return null;
}

function groupWorkouts(workouts: readonly WorkoutCandidate[]): Map<number, WorkoutCandidate[]> {
  const unionFind = new UnionFind(workouts.length);
  for (let leftIndex = 0; leftIndex < workouts.length; leftIndex += 1) {
    const left = workouts[leftIndex];
    if (!left) continue;
    const leftStart = Date.parse(left.startAt);
    for (let rightIndex = leftIndex + 1; rightIndex < workouts.length; rightIndex += 1) {
      const right = workouts[rightIndex];
      if (!right) continue;
      const startDifferenceSeconds = (Date.parse(right.startAt) - leftStart) / 1000;
      if (startDifferenceSeconds > 120) break;
      if (overlapsAsDuplicate(left, right)) unionFind.union(leftIndex, rightIndex);
    }
  }
  const groups = new Map<number, WorkoutCandidate[]>();
  workouts.forEach((workout, index) => {
    const root = unionFind.find(index);
    const members = groups.get(root) ?? [];
    members.push(workout);
    groups.set(root, members);
  });
  return groups;
}

/** 组 id 只由成员 id 集合决定。会话 identity 匹配与写组**必须**共用这一份。 */
function workoutGroupId(members: readonly WorkoutCandidate[]): string {
  return stableId("workout_group", members.map((member) => member.id).sort());
}

function trainingSessionIdForGroup(members: readonly WorkoutCandidate[]): string {
  return stableId("training_session", [workoutGroupId(members)]);
}

/**
 * 作用域内的会话：闭包完成后候选集合的 ±120s 窗口 ∪ 两条 **identity** 通道。
 *
 * 后两条不能省：`matchesExistingTrainingSession` 的几何匹配有 120s 门槛，但 identity 匹配
 * （稳定 id / `canonical_workout_id ∈ 成员`）**没有时间约束** —— 一条被改过起点的训练
 * 仍会命中同一会话，并且在 `:387` 处短路几何匹配。只按时间窗加载会凭空新建一个重复会话。
 */
function loadTrainingSessionsForGroups(
  database: DatabaseSync,
  workouts: readonly WorkoutCandidate[],
  groups: ReadonlyMap<number, WorkoutCandidate[]>
): ExistingTrainingSession[] {
  const sessions = new Map<string, ExistingTrainingSession>();
  const add = (rows: ExistingTrainingSession[]): void => {
    for (const row of rows) sessions.set(row.id, row);
  };

  const windows = workouts
    .map((workout) => Date.parse(workout.startAt))
    .filter((value) => Number.isFinite(value))
    .map((time) => [time - SCOPE_WINDOW_MS, time + SCOPE_WINDOW_MS] as const);
  for (const chunk of chunkValues(windows, WINDOW_CHUNK_SIZE)) {
    const clause = chunk.map(() => "(anchor_start_at BETWEEN ? AND ?)").join(" OR ");
    const params = chunk.flatMap(([from, to]) => [
      new Date(from).toISOString(),
      new Date(to).toISOString()
    ]);
    add(database
      .prepare(`${TRAINING_SESSION_SELECT}
        WHERE activity_type = ? AND (${clause})`)
      .all(workoutTypes.running, ...params) as unknown as ExistingTrainingSession[]);
  }

  const canonicalWorkoutIds = workouts.map((workout) => workout.id);
  for (const chunk of chunkValues(canonicalWorkoutIds, ID_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    add(database
      .prepare(`${TRAINING_SESSION_SELECT}
        WHERE activity_type = ? AND canonical_workout_id IN (${placeholders})`)
      .all(workoutTypes.running, ...chunk) as unknown as ExistingTrainingSession[]);
  }

  const stableIds = [...groups.values()].map(trainingSessionIdForGroup);
  for (const chunk of chunkValues(stableIds, ID_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => "?").join(", ");
    add(database
      .prepare(`${TRAINING_SESSION_SELECT}
        WHERE activity_type = ? AND id IN (${placeholders})`)
      .all(workoutTypes.running, ...chunk) as unknown as ExistingTrainingSession[]);
  }
  return [...sessions.values()];
}

interface TrainingSessionIndex {
  byId: Map<string, ExistingTrainingSession>;
  byCanonicalWorkoutId: Map<string, ExistingTrainingSession[]>;
  /** 按 `anchor_start_at` 升序（无效时刻被排除：几何匹配本来也匹配不上）。 */
  ordered: ExistingTrainingSession[];
  starts: number[];
}

function indexTrainingSessions(sessions: readonly ExistingTrainingSession[]): TrainingSessionIndex {
  const byId = new Map<string, ExistingTrainingSession>();
  const byCanonicalWorkoutId = new Map<string, ExistingTrainingSession[]>();
  for (const session of sessions) {
    byId.set(session.id, session);
    if (session.canonicalWorkoutId !== null) {
      const bucket = byCanonicalWorkoutId.get(session.canonicalWorkoutId) ?? [];
      bucket.push(session);
      byCanonicalWorkoutId.set(session.canonicalWorkoutId, bucket);
    }
  }
  const ordered = sessions
    .filter((session) => Number.isFinite(Date.parse(session.anchorStartAt)))
    .sort((left, right) => {
      const difference = Date.parse(left.anchorStartAt) - Date.parse(right.anchorStartAt);
      return difference !== 0 ? difference : left.id.localeCompare(right.id);
    });
  return {
    byId,
    byCanonicalWorkoutId,
    ordered,
    starts: ordered.map((session) => Date.parse(session.anchorStartAt))
  };
}

/** 与 `instant` 的 `anchor_start_at` 相差不超过 `windowMs` 的会话（含边界）。 */
function sessionsNear(
  index: TrainingSessionIndex,
  instant: number,
  windowMs: number
): ExistingTrainingSession[] {
  const from = instant - windowMs;
  const to = instant + windowMs;
  let low = 0;
  let high = index.starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((index.starts[middle] ?? Number.POSITIVE_INFINITY) < from) low = middle + 1;
    else high = middle;
  }
  const result: ExistingTrainingSession[] = [];
  for (let position = low; position < index.starts.length; position += 1) {
    if ((index.starts[position] ?? Number.POSITIVE_INFINITY) > to) break;
    const session = index.ordered[position];
    if (session !== undefined) result.push(session);
  }
  return result;
}

/** 无训练变更时仍要跑的两条全局语句：抽出来让快速路径与主路径共用一份实现。 */
function markUnreferencedSessionsInactive(database: DatabaseSync): void {
  database
    .prepare(`
      UPDATE training_sessions
      SET status = 'inactive', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE activity_type = ?
        AND id NOT IN (SELECT training_session_id FROM workout_groups WHERE training_session_id IS NOT NULL)
    `)
    .run(workoutTypes.running);
}

function rebuildAmbiguousSessionIssues(database: DatabaseSync): void {
  database.prepare("DELETE FROM import_issues WHERE code = 'AMBIGUOUS_TRAINING_SESSION_MATCH'").run();
  database
    .prepare(`
      INSERT INTO import_issues (severity, code, object_id, message)
      SELECT
        'warning',
        'AMBIGUOUS_TRAINING_SESSION_MATCH',
        id,
        'A candidate workout group matched more than one existing training session.'
      FROM training_sessions
      WHERE activity_type = ? AND status = 'ambiguous'
      ORDER BY id
    `)
    .run(workoutTypes.running);
}

/**
 * 空 dirty 的快速路径：本批没有任何训练/路线/统计变更。
 *
 * 此时逐组重写的结果与库中现状逐字相同（组 id 由成员集合决定、会话匹配是确定性函数），
 * 唯一被跳过的是两趟全表加载与 O(组数 × 会话数) 的匹配 —— 那正是"记录-only 批次"在
 * 一万条历史上要付二十秒的地方。三条全局语句**照旧执行**，计数口径与时间戳行为不变。
 */
function canonicalizeWithoutWorkoutChanges(
  database: DatabaseSync,
  callerOwned: boolean
): CanonicalizationResult {
  const runningWorkoutCount = countRunningWorkouts(database);
  beginOwnedTransaction(database, CANONICALIZE_WORKOUTS_SAVEPOINT, callerOwned);
  try {
    markUnreferencedSessionsInactive(database);
    rebuildAmbiguousSessionIssues(database);
    commitOwnedTransaction(database, CANONICALIZE_WORKOUTS_SAVEPOINT, callerOwned);
  } catch (error) {
    rollbackOwnedTransaction(database, CANONICALIZE_WORKOUTS_SAVEPOINT, callerOwned);
    throw error;
  }
  return {
    runningWorkoutCount,
    groupCount: 0,
    duplicateGroupCount: 0,
    excludedDuplicateCount: 0,
    trainingSessionCount: 0,
    ambiguousTrainingSessionCount: 0,
    affectedWorkoutCount: 0,
    loadedWorkoutCount: 0
  };
}

/**
 * 调用参数。
 *
 * - `callerOwnedTransaction`：提交权归调用方（本段用 SAVEPOINT）。见 owned-transaction.ts。
 * - `scope`：邻域作用域诊断开关。`"neighborhood"`（默认）只加载可能被改写的候选；
 *   `"all"` 强制全量加载 —— **只**用于等价性回归与新旧对比基准，生产不传。
 *   两条路径必须产出逐字相同的库状态，这是作用域正确性的唯一判据。
 */
export interface CanonicalizationOptions {
  callerOwnedTransaction?: boolean;
  scope?: "neighborhood" | "all";
}

export function canonicalizeRunningWorkouts(
  database: DatabaseSync,
  incremental?: IncrementalCanonicalizationOptions,
  options: CanonicalizationOptions = {}
): CanonicalizationResult {
  // caller 模式下提交权归调用方：本段边界是 SAVEPOINT，不是新事务（见 owned-transaction.ts）。
  const callerOwned = options.callerOwnedTransaction === true;
  // 空 dirty 说明本批没有任何可变输入（训练/统计/路线归属都没动）。此时逐组重写的结果
  // 与库中现状逐字相同，只有两趟全表加载与 O(组数×会话数) 的匹配是白付的。
  const dirtyTimes = incremental === undefined
    ? null
    : [...new Set(incremental.dirtyWorkoutTimes.map(Date.parse).filter(Number.isFinite))];
  if (dirtyTimes !== null && dirtyTimes.length === 0) {
    return canonicalizeWithoutWorkoutChanges(database, callerOwned);
  }

  // `null` = 放弃邻域、退回全量（跨度太大 / 闭包不收敛 / 诊断开关要求全量）。方向必须是超集。
  const scope = dirtyTimes === null || options.scope === "all"
    ? null
    : selectAffectedWorkoutIds(database, dirtyTimes);
  const workouts = scope === null
    ? loadRunningWorkouts(database)
    : loadRunningWorkoutsByIds(database, scope.ids);
  const runningWorkoutCount = scope === null ? workouts.length : countRunningWorkouts(database);
  // 组必须先算：作用域模式要拿组 id 去补 identity 会话（`canonical_workout_id` / 稳定 id）。
  const groups = groupWorkouts(workouts);
  const existingSessions = scope === null
    ? loadExistingTrainingSessions(database)
    : loadTrainingSessionsForGroups(database, workouts, groups);
  const sessionIndex = indexTrainingSessions(existingSessions);
  let ambiguousTrainingSessionCount = 0;

  beginOwnedTransaction(database, CANONICALIZE_WORKOUTS_SAVEPOINT, callerOwned);
  try {
    if (incremental) {
      const selectedIds = workouts.map((workout) => workout.id);
      const deleteGroup = database.prepare(`
        DELETE FROM workout_groups WHERE id IN (
          SELECT group_id FROM workout_group_members WHERE workout_id = ?
        )
      `);
      for (const id of selectedIds) deleteGroup.run(id);
      const resetWorkout = database.prepare(
        "UPDATE workouts SET canonical_group_id = NULL, is_canonical = 0 WHERE id = ?"
      );
      for (const id of selectedIds) resetWorkout.run(id);
    } else {
      database.exec("DELETE FROM workout_group_members");
      database.exec("DELETE FROM workout_groups");
      database
        .prepare("UPDATE workouts SET canonical_group_id = NULL, is_canonical = 0 WHERE activity_type = ?")
        .run(workoutTypes.running);
    }

    const insertGroup = database.prepare(`
      INSERT INTO workout_groups (
        id, activity_type, canonical_workout_id, member_count, reason, training_session_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertMember = database.prepare(`
      INSERT INTO workout_group_members (
        group_id, workout_id, is_canonical, canonical_rank
      ) VALUES (?, ?, ?, ?)
    `);
    const updateWorkout = database.prepare(`
      UPDATE workouts SET canonical_group_id = ?, is_canonical = ? WHERE id = ?
    `);
    const insertSession = database.prepare(`
      INSERT INTO training_sessions (
        id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
        canonical_workout_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateSession = database.prepare(`
      UPDATE training_sessions
      SET
        anchor_start_at = ?,
        anchor_end_at = ?,
        anchor_distance_km = ?,
        canonical_workout_id = ?,
        status = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `);
    const usedExistingSessionIds = new Set<string>();

    for (const members of groups.values()) {
      const ranked = [...members].sort((left, right) => {
        const rankDifference = canonicalRank(right) - canonicalRank(left);
        return rankDifference !== 0 ? rankDifference : left.id.localeCompare(right.id);
      });
      const canonical = ranked[0];
      if (!canonical) continue;
      const groupId = workoutGroupId(members);
      const reason = members.length > 1 ? "time_overlap_and_distance_match" : "singleton";
      const canonicalDistanceKm = distanceToKilometers(
        canonical.distanceValue,
        canonical.distanceUnit
      );
      // Stable source identity survives corrections to distance/time. Geometry
      // is only a fallback for matching a genuinely new source observation.
      const memberIds = new Set(members.map((member) => member.id));
      // Identity 通道（**无时间约束**，且会短路几何匹配）：稳定 id 一条 + 成员命中若干条。
      const identity = new Set<ExistingTrainingSession>();
      const stableMatch = sessionIndex.byId.get(stableId("training_session", [groupId]));
      if (stableMatch !== undefined) identity.add(stableMatch);
      for (const memberId of memberIds) {
        for (const session of sessionIndex.byCanonicalWorkoutId.get(memberId) ?? []) {
          identity.add(session);
        }
      }
      const identityMatches = [...identity]
        .filter((session) => !usedExistingSessionIds.has(session.id));
      // 几何回退：`matchesExistingTrainingSession` 的 120s 门槛 ⇒ ±120s 窗口是精确超集。
      const canonicalStart = Date.parse(canonical.startAt);
      const matches = identityMatches.length > 0
        ? identityMatches
        : (Number.isFinite(canonicalStart)
            ? sessionsNear(sessionIndex, canonicalStart, SCOPE_WINDOW_MS).filter(
                (session) =>
                  !usedExistingSessionIds.has(session.id) &&
                  matchesExistingTrainingSession(canonical, session)
              )
            : []);
      let trainingSessionId: string;
      let sessionStatus: "active" | "ambiguous" = "active";

      if (matches.length >= 1) {
        // Multi-match: prefer active over ambiguous over inactive, then stable id.
        const matched = [...matches].sort(
          (left, right) =>
            sessionStatusRank(left.status) - sessionStatusRank(right.status) ||
            left.id.localeCompare(right.id)
        )[0];
        if (!matched) throw new Error("Expected an existing training session match");
        trainingSessionId = matched.id;
        usedExistingSessionIds.add(trainingSessionId);
        if (matches.length > 1) {
          sessionStatus = "ambiguous";
          ambiguousTrainingSessionCount += 1;
        }
        updateSession.run(
          canonical.startAt,
          canonical.endAt,
          canonicalDistanceKm,
          canonical.id,
          sessionStatus,
          trainingSessionId
        );
      } else {
        trainingSessionId = stableId("training_session", [groupId]);
        insertSession.run(
          trainingSessionId,
          canonical.activityType,
          canonical.startAt,
          canonical.endAt,
          canonicalDistanceKm,
          canonical.id,
          sessionStatus
        );
      }
      insertGroup.run(
        groupId,
        workoutTypes.running,
        canonical.id,
        members.length,
        reason,
        trainingSessionId
      );
      for (const member of members) {
        const isCanonical = member.id === canonical.id ? 1 : 0;
        insertMember.run(groupId, member.id, isCanonical, canonicalRank(member));
        updateWorkout.run(groupId, isCanonical, member.id);
      }
    }

    // 两条全局语句与快速路径共用一份实现：内容由全表重算，与本次作用域无关。
    markUnreferencedSessionsInactive(database);
    rebuildAmbiguousSessionIssues(database);

    commitOwnedTransaction(database, CANONICALIZE_WORKOUTS_SAVEPOINT, callerOwned);
  } catch (error) {
    rollbackOwnedTransaction(database, CANONICALIZE_WORKOUTS_SAVEPOINT, callerOwned);
    throw error;
  }

  const duplicateGroups = [...groups.values()].filter((group) => group.length > 1);
  return {
    runningWorkoutCount,
    groupCount: groups.size,
    duplicateGroupCount: duplicateGroups.length,
    excludedDuplicateCount: duplicateGroups.reduce(
      (count, group) => count + group.length - 1,
      0
    ),
    trainingSessionCount: groups.size,
    ambiguousTrainingSessionCount,
    affectedWorkoutCount: workouts.length,
    loadedWorkoutCount: workouts.length
  };
}
