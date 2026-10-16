import type { DatabaseSync } from "node:sqlite";

import { workoutPresentConditionSql } from "@rai/storage-sqlite";

import type { DirtyRangeChange, DirtyRangeWorkout } from "./dirty-range.js";

/**
 * 脏范围的**输入装配**（O04 / WP-20 落地，O06-A / WP-22 从 `apps/api` 移到本包）。
 *
 * ## 为什么要移动
 *
 * WP-22 的输入绑定要在"当前已发布依赖代次之后、本次捕获之前"的**未覆盖账本**上
 * 重新生成执行计划 —— 那件事发生在**消费端**（`packages/application` 的分析输入读取器），
 * 而这段装配原来住在 `apps/api/src/direct-sync-ingest.ts`（登记端）。同一个口径写两份必然漂移：
 * 一份按单批次装配、一份按多批次装配，迟早对不上。所以装配下沉到与
 * `planIncrementalAnalysisDirtyRange` **同一个包**，两端各自调用同一实现。
 *
 * ## 口径（逐条都有对应的失败形态，别顺手改）
 *
 * - `record` 的新侧来自**当前行**的 JOIN；删除过的行在新侧为 NULL 是正常的 ——
 *   旧侧必须取账本 v37 的 `previous_*`，否则"删掉一条记录"会退化成"没有边界"。
 * - `workout` 变更**不看类型**：训练证据天然影响分析。软删行仍在表里，所以 JOIN 取得到。
 * - `activity_summary` 等只有时刻。
 * - route 变更由调用方以**合成条目**传入（时刻 = 该路线所属训练的开始时刻），
 *   于是"只有路线改动"的批次不退化成全量。
 * - `workouts` 是**全表**未软删训练：它是"相交训练回退"的回退全集（`rewindToOverlappingWorkoutStart`）。
 *
 * ⛔ 只读：本函数不得写任何表。
 */
export function loadDirtyRangeInput(
  db: DatabaseSync,
  batchIds: readonly string[],
  routeDirtyTimes: readonly string[],
  recoveryBoundaries: readonly string[]
): { changes: DirtyRangeChange[]; workouts: DirtyRangeWorkout[]; recoveryBoundaries: string[] } {
  const changes: DirtyRangeChange[] = [];
  const uniqueBatches = [...new Set(batchIds)];
  if (uniqueBatches.length > 0) {
    const placeholders = uniqueBatches.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT change.entity_kind AS kind, change.change_type AS changeType,
             change.effective_at AS effectiveAt,
             change.previous_effective_at AS previousAt, change.previous_end_at AS previousEndAt,
             change.previous_type AS previousType,
             record.type AS recordType, record.start_at AS recordStart, record.end_at AS recordEnd,
             workout.start_at AS workoutStart, workout.end_at AS workoutEnd
      FROM import_entity_changes change
      LEFT JOIN health_records record ON change.entity_kind='record' AND record.id=change.entity_id
      LEFT JOIN workouts workout ON change.entity_kind='workout' AND workout.id=change.entity_id
      WHERE change.batch_id IN (${placeholders})
    `).all(...uniqueBatches) as Array<{
      kind: string; changeType: "inserted" | "updated" | "removed";
      effectiveAt: string | null;
      previousAt: string | null; previousEndAt: string | null; previousType: string | null;
      recordType: string | null; recordStart: string | null; recordEnd: string | null;
      workoutStart: string | null; workoutEnd: string | null;
    }>;
    for (const row of rows) {
      if (row.kind === "record") {
        changes.push({
          entityKind: "record",
          changeType: row.changeType,
          newType: row.recordType, newStart: row.recordStart, newEnd: row.recordEnd,
          previousType: row.previousType, previousStart: row.previousAt, previousEnd: row.previousEndAt
        });
      } else if (row.kind === "workout") {
        changes.push({
          entityKind: "workout",
          changeType: row.changeType,
          newType: row.workoutStart === null ? null : "workout",
          newStart: row.workoutStart, newEnd: row.workoutEnd,
          previousType: row.previousType, previousStart: row.previousAt, previousEnd: row.previousEndAt
        });
      } else {
        changes.push({
          entityKind: "activity_summary",
          changeType: row.changeType,
          newType: null, newStart: row.effectiveAt, newEnd: null,
          previousType: null, previousStart: row.previousAt, previousEnd: row.previousEndAt
        });
      }
    }
  }
  // route 变更（本批改过的路线所属训练的时刻）作为合成条目 —— 路线-only 批次不再
  // 退化成"无边界即全量"。
  for (const routeTime of routeDirtyTimes) {
    changes.push({
      entityKind: "route",
      changeType: "updated",
      newType: null, newStart: routeTime, newEnd: routeTime,
      previousType: null, previousStart: null, previousEnd: null
    });
  }
  // 可见性判据**只有一处**：`workoutPresentConditionSql()`（`@rai/storage-sqlite` 的
  // `sql/fragments.ts`）。结构判据（`workout-presence.test.ts`）要求全仓只有 `fragments.ts`
  // 允许出现该可见性字面量 —— 本文件在 WP-22 从 `apps/api` 搬过来时把这行字面量一起搬了进来，
  // 于是成为第二处（2026-10-16 由 WP-50 发现）。
  // ⛔ 不要用"参数化 `deleted_at IS ?` + 绑定 null"来绕开那条结构判据：语义一样，
  // 但那会让判据**看不见**，而它要防的正是"同一件事两处写法迟早分叉"。
  // 同理：这段注释本身也不能照抄那个字面量 —— 结构判据读的是**文件原文**，注释一样会命中
  // （这一版就是这么被发现是"第二处"的）。
  // `health-export-parser -> storage-sqlite` 是仓里允许的依赖边（check-package-boundaries）。
  const workouts = db.prepare(
    `SELECT start_at AS startAt, end_at AS endAt FROM workouts WHERE ${workoutPresentConditionSql()}`
  ).all() as unknown as Array<DirtyRangeWorkout>;
  return { changes, workouts, recoveryBoundaries: [...recoveryBoundaries] };
}
