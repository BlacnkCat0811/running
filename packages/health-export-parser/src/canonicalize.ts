import type { DatabaseSync } from "node:sqlite";

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
  activityType: string;
  anchorStartAt: string;
  anchorEndAt: string;
  anchorDistanceKm: number | null;
}

export interface CanonicalizationResult {
  runningWorkoutCount: number;
  groupCount: number;
  duplicateGroupCount: number;
  excludedDuplicateCount: number;
  trainingSessionCount: number;
  ambiguousTrainingSessionCount: number;
  affectedWorkoutCount?: number;
}

export interface IncrementalCanonicalizationOptions {
  dirtyWorkoutTimes: readonly string[];
}

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

function loadRunningWorkouts(database: DatabaseSync): WorkoutCandidate[] {
  return database
    .prepare(`
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
      FROM workouts w
      WHERE w.activity_type = ?
      ORDER BY w.start_at, w.id
    `)
    .all(
      healthTypes.distanceWalkingRunning,
      healthTypes.distanceWalkingRunning,
      healthTypes.heartRate,
      healthTypes.runningPower,
      healthTypes.runningSpeed,
      healthTypes.runningStrideLength,
      healthTypes.runningVerticalOscillation,
      healthTypes.runningGroundContactTime,
      workoutTypes.running
    ) as unknown as WorkoutCandidate[];
}

function loadExistingTrainingSessions(database: DatabaseSync): ExistingTrainingSession[] {
  return database
    .prepare(`
      SELECT
        id,
        activity_type AS activityType,
        anchor_start_at AS anchorStartAt,
        anchor_end_at AS anchorEndAt,
        anchor_distance_km AS anchorDistanceKm
      FROM training_sessions
      WHERE activity_type = ? AND status IN ('active', 'ambiguous')
    `)
    .all(workoutTypes.running) as unknown as ExistingTrainingSession[];
}

export function canonicalizeRunningWorkouts(
  database: DatabaseSync,
  incremental?: IncrementalCanonicalizationOptions
): CanonicalizationResult {
  const allWorkouts = loadRunningWorkouts(database);
  let workouts = allWorkouts;
  if (incremental) {
    const dirtyTimes = incremental.dirtyWorkoutTimes.map(Date.parse).filter(Number.isFinite);
    const selected = new Set(allWorkouts.filter((workout) => dirtyTimes.some(
      (time) => Math.abs(Date.parse(workout.startAt) - time) <= 120_000
    )).map((workout) => workout.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of allWorkouts) {
        if (selected.has(candidate.id)) continue;
        if (allWorkouts.some((member) => selected.has(member.id) && overlapsAsDuplicate(member, candidate))) {
          selected.add(candidate.id);
          changed = true;
        }
      }
    }
    const priorMembers = database.prepare(`
      SELECT DISTINCT member.workout_id AS workoutId
      FROM workout_group_members member
      WHERE member.group_id IN (
        SELECT group_id FROM workout_group_members WHERE workout_id = ?
      )
    `);
    for (const workoutId of [...selected]) {
      const rows = priorMembers.all(workoutId) as unknown as Array<{ workoutId: string }>;
      for (const row of rows) selected.add(row.workoutId);
    }
    workouts = allWorkouts.filter((workout) => selected.has(workout.id));
  }
  const existingSessions = loadExistingTrainingSessions(database);
  const unionFind = new UnionFind(workouts.length);
  let ambiguousTrainingSessionCount = 0;

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

  database.exec("BEGIN IMMEDIATE");
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
    const insertIssue = database.prepare(`
      INSERT INTO import_issues (severity, code, object_id, message)
      VALUES ('warning', 'AMBIGUOUS_TRAINING_SESSION_MATCH', ?, ?)
    `);
    const usedExistingSessionIds = new Set<string>();

    for (const members of groups.values()) {
      const ranked = [...members].sort((left, right) => {
        const rankDifference = canonicalRank(right) - canonicalRank(left);
        return rankDifference !== 0 ? rankDifference : left.id.localeCompare(right.id);
      });
      const canonical = ranked[0];
      if (!canonical) continue;
      const groupId = stableId(
        "workout_group",
        members.map((member) => member.id).sort()
      );
      const reason = members.length > 1 ? "time_overlap_and_distance_match" : "singleton";
      const canonicalDistanceKm = distanceToKilometers(
        canonical.distanceValue,
        canonical.distanceUnit
      );
      const matches = existingSessions.filter(
        (session) =>
          !usedExistingSessionIds.has(session.id) &&
          matchesExistingTrainingSession(canonical, session)
      );
      let trainingSessionId: string;
      let sessionStatus: "active" | "ambiguous" = "active";

      if (matches.length === 1) {
        const matched = matches[0];
        if (!matched) throw new Error("Expected exactly one existing training session");
        trainingSessionId = matched.id;
        usedExistingSessionIds.add(trainingSessionId);
        updateSession.run(
          canonical.startAt,
          canonical.endAt,
          canonicalDistanceKm,
          canonical.id,
          "active",
          trainingSessionId
        );
      } else {
        trainingSessionId = stableId("training_session", [groupId]);
        if (matches.length > 1) {
          sessionStatus = "ambiguous";
          ambiguousTrainingSessionCount += 1;
          insertIssue.run(
            trainingSessionId,
            "A candidate workout group matched more than one existing training session."
          );
        }
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

    database
      .prepare(`
        UPDATE training_sessions
        SET status = 'inactive', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE activity_type = ?
          AND id NOT IN (SELECT training_session_id FROM workout_groups WHERE training_session_id IS NOT NULL)
      `)
      .run(workoutTypes.running);

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const duplicateGroups = [...groups.values()].filter((group) => group.length > 1);
  return {
    runningWorkoutCount: allWorkouts.length,
    groupCount: groups.size,
    duplicateGroupCount: duplicateGroups.length,
    excludedDuplicateCount: duplicateGroups.reduce(
      (count, group) => count + group.length - 1,
      0
    ),
    trainingSessionCount: groups.size,
    ambiguousTrainingSessionCount,
    affectedWorkoutCount: workouts.length
  };
}
