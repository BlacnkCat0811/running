import { healthTypes, scoringHealthTypes } from "@rai/contracts";

/**
 * O04（WP-20）：分析的**脏范围**与**影响域边界**纯函数。
 *
 * 与 `planHealthChanges`（CLI 路径，比对 main × previous 两个附着库）的分工：直连车道
 * **没有** previous 附着库 —— "旧行"来自账本 v37 的 `previous_*` 列、"新行"来自对当前表
 * 的 JOIN。本模块把这些输入规范化成同一套区间语义（回退原语与判据单点定义，两处共用）。
 *
 * 🔴 与旧 `dirtyFromAt()` 的差异（本次修复的缺陷）：旧实现只取账本**时刻**的 min ——
 * 记录时间更正（如训练中段心率）算出的边界落在训练**开始之后**，特征复用
 * （`extractFeatures`: `workoutStartAt >= dirtyFromAt`）据此把"起点 < 边界"的相交训练
 * 当成未受影响 ⇒ **错误复用旧特征**（合成库已复现）。本函数在时刻 min 之外，对每个
 * 变更区间做**相交训练回退**：任何与变更区间相交（`start_at < 区间.end` 且
 * `end_at >= 区间.start`，与 `planHealthChanges` 的 SQL 逐字同义）的训练，其 `start_at`
 * 一并压低边界。
 *
 * 区间语义：一条记录变更携带新旧**两个区间**（时间前后移时旧范围同样脏，取并集）；
 * 删除只有旧/账本时刻。fail-safe 保留：任何不可解析/非法区间或 vo2Max 变更 ⇒ `full`
 * （方向永远是"宁可全算，不可错复用"）。
 */

/** 一条待分析变更（账本行 + 当前行 JOIN 后的合并视图）。 */
export interface DirtyRangeChange {
  entityKind: "record" | "workout" | "activity_summary" | "route";
  changeType: "inserted" | "updated" | "removed";
  /** 旧行（账本 `previous_*` 列；`inserted` 时为 null）。 */
  previousType: string | null;
  previousStart: string | null;
  previousEnd: string | null;
  /** 新行（对当前表的 JOIN；`removed` 时为 null）。 */
  newType: string | null;
  newStart: string | null;
  newEnd: string | null;
}

/** 相交回退只需训练的时间区间（与 `workouts.start_at/end_at` 同口径）。 */
export interface DirtyRangeWorkout {
  startAt: string;
  endAt: string;
}

/** 按影响域给出的边界（WP-32 分域复用的输入；全部为保守下界，`null` = 无边界）。 */
export interface AnalysisDirtyDomains {
  /** 特征前缀复用与 Fitness 重放的边界。 */
  features: string | null;
  /** 负荷/能力基线（180 天 HR max 等）的边界。 */
  fitness: string | null;
  /** 恢复/就绪（canonical 夜 / HRV）边界。 */
  readiness: string | null;
}

export interface AnalysisDirtyRange {
  /** `true` = 不可增量（调用方必须全量重算，忽略其余字段）。 */
  full: boolean;
  /** 脏下界（`full` 或"有变更但边界未知"时为 null）。 */
  dirtyFromAt: string | null;
  domains: AnalysisDirtyDomains;
  reasons: string[];
}

/** 与 `health-change-plan.ts` 共用同一份规范化判据（单点定义，禁止分叉）。 */
export function isCanonicalInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

/** 区间与训练相交谓词（与 `planHealthChanges` 的 SQL 逐字同义：`start_at < ? AND end_at >= ?`）。 */
function overlaps(workout: DirtyRangeWorkout, start: string, end: string): boolean {
  return workout.startAt < end && workout.endAt >= start;
}

/**
 * 相交训练回退原语：与任一区间相交的训练里**最早**的 `startAt`。
 * `null` = 没有相交训练（调用方保持原边界）。`planHealthChanges` 与直连车道共用它。
 */
export function rewindToOverlappingWorkoutStart(
  intervals: readonly { start: string; end: string }[],
  workouts: readonly DirtyRangeWorkout[]
): string | null {
  let earliest: string | null = null;
  for (const interval of intervals) {
    for (const workout of workouts) {
      if (!overlaps(workout, interval.start, interval.end)) continue;
      if (earliest === null || workout.startAt < earliest) earliest = workout.startAt;
    }
  }
  return earliest;
}

/**
 * 主入口：把"本批变更 + 全表训练 + 恢复边界"归约成一个脏范围与分域边界。
 *
 * - `record`/`workout`：为新旧两侧各构造区间（区间并集语义），区间进相交回退；
 * - `activity_summary`/`route`：点时刻（其自身由"边界之后全部重算"覆盖）；
 * - `recoveryBoundaries`：canonical 恢复（夜/HRV）重建触及的时刻（可为空集）；
 * - 变更非空但没有任何可用边界 ⇒ `full`（`health_boundary_unknown`，与 CLI 同口径）。
 */
export function planIncrementalAnalysisDirtyRange(input: {
  changes: readonly DirtyRangeChange[];
  workouts: readonly DirtyRangeWorkout[];
  recoveryBoundaries?: readonly (string | null)[] | null;
}): AnalysisDirtyRange {
  let full = false;
  let boundary: string | null = null;
  let recoveryBoundary: string | null = null;
  const reasons = new Set<string>();
  const intervals: { start: string; end: string }[] = [];

  const addInstant = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (!isCanonicalInstant(value)) {
      full = true;
      reasons.add("invalid_health_time");
      return;
    }
    if (boundary === null || value < boundary) boundary = value;
  };

  for (const change of input.changes) {
    if (change.entityKind === "record" || change.entityKind === "workout") {
      const sides = [
        { type: change.newType, start: change.newStart, end: change.newEnd },
        { type: change.previousType, start: change.previousStart, end: change.previousEnd }
      ];
      for (const side of sides) {
        if (side.start === null && side.end === null) continue;
        if (change.entityKind === "record") {
          if (!(scoringHealthTypes as readonly unknown[]).includes(side.type)) continue;
          if (side.type === healthTypes.vo2Max) {
            full = true;
            reasons.add("vo2_evidence_changed");
          }
        }
        if (!isCanonicalInstant(side.start) || !isCanonicalInstant(side.end) || side.end < side.start) {
          full = true;
          reasons.add("invalid_health_interval");
          continue;
        }
        intervals.push({ start: side.start, end: side.end });
        addInstant(side.start);
      }
    } else {
      // activity_summary / 合成 route：只有点时刻（区间在下界之外无须单独回退）。
      addInstant(change.newStart);
      addInstant(change.previousStart);
      addInstant(change.previousEnd);
    }
  }

  if (!full && intervals.length > 0 && input.workouts.length > 0) {
    const rewound = rewindToOverlappingWorkoutStart(intervals, input.workouts);
    if (rewound !== null) {
      addInstant(rewound);
      reasons.add("overlapping_workout_rewound");
    }
  }

  for (const value of input.recoveryBoundaries ?? []) {
    if (value === null || value === undefined) continue;
    if (!isCanonicalInstant(value)) {
      full = true;
      reasons.add("invalid_health_time");
      continue;
    }
    if (recoveryBoundary === null || value < recoveryBoundary) recoveryBoundary = value;
    if (boundary === null || value < boundary) boundary = value;
  }

  if (!full && boundary === null && input.changes.length > 0) {
    full = true;
    reasons.add("health_boundary_unknown");
  }
  if (!full && boundary !== null) reasons.add("bounded_health_change");

  // `full` 时 `dirtyFromAt` 置 null：消费侧即使漏判 `full` 也不会拿着边界走 partial
  // 路径（fail-safe 方向与 CLI 口径一致——`planHealthChanges` 的 full 判定优先）。
  const dirtyFromAt = full ? null : boundary;
  const readiness = full ? null
    : (recoveryBoundary !== null && (boundary === null || recoveryBoundary < boundary)
      ? recoveryBoundary
      : boundary);
  return {
    full,
    dirtyFromAt,
    domains: { features: dirtyFromAt, fitness: readiness, readiness },
    reasons: [...reasons]
  };
}
