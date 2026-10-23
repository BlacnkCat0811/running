import { healthTypes, scoringHealthTypes } from "@rai/contracts";
import { DATA_ONLY_RECORD_TYPES } from "./record-delta-policy.js";

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
 * 删除只有旧/账本时刻。fail-safe 保留：任何不可解析/非法区间 ⇒ `full`
 * （方向永远是"宁可全算，不可错复用"）。
 *
 * 🔴 P0-2（2026-10-18）：`vo2Max` 变更**不再**升级为 `full`。它是一条**可界定的证据变更**：
 * 把该样本区间当作普通脏区间（与训练相交时回绕到训练起点），边界落进 `domains.fitness`
 * （分区／阈值／能力时间线按此边界重算）。旧实现命中 `vo2_evidence_changed` 就
 * `full = true`，生产实测「1 条 VO2Max 样本 ⇒ 286 条历史训练全量重算 103 s」。
 *
 * ⚠️ 为什么计划里三个域都拿到同一个边界（而不是只给 `fitness`）：本计划类型没有
 * "该域不脏"的取值 —— 某域为 `null` 的语义是**该域不可增量、必须全算**（见
 * `recompute-pipeline` 的 `DomainBoundaries`）。特征前缀复用要求 `domains.features` 非空；
 * 而能力时间线复用读的正是 `domains.features`（`resumeModelReplay`）。VO2Max 不进训练特征，
 * 所以"把边界给 features"的代价只是重算边界之后那一段（通常 1 场训练），
 * 方向仍是保守（多算一段，不错复用）。
 *
 * 只有区间不可解析／无边界／出现未知记录类型时才是 `full`
 * （`invalid_health_interval` / `health_boundary_unknown` / `unknown_record_type`）。
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
 * - `activity_summary`/`route`：通常只有时刻（`newEnd` 为 `null`）⇒ 构造**点区间** `[t, t]`
 *   后同样进相交回退。🔴 不能只 `addInstant`：路线／活动摘要的时刻可能落在训练**中段**，
 *   只取该时刻会让训练前半段的特征、负荷与分区不复算（§7.2 步骤 7，2026-10-17 修复）；
 * - `recoveryBoundaries`：canonical 恢复（夜/HRV）重建触及的时刻（可为空集）；
 * - 变更非空但没有任何可用边界 ⇒ `full`（`health_boundary_unknown`，与 CLI 同口径）。
 */
/**
 * 覆盖计划的**规范化形态**：一个"从某边界起需要重算"的声明。
 * `null`（整体）= 没有可信边界 ⇒ 调用方必须全量。
 */
export interface AnalysisDirtyPlan {
  dirtyFromAt: string | null;
  domains: AnalysisDirtyDomains;
}

/**
 * 覆盖计划的**合并**（R01 重排 / R02 合并 / capture 主路径**唯一的**一处实现）。
 *
 * ## 为什么必须只有一处
 *
 * "把两份 dirty 合并成一份"曾经在重排与合并函数里各写一遍（`MIN(dirty)` 的两份方言），
 * 而复查抓到的两类漏算（R01 重排丢原任务范围、R02 合并丢未入选批次）本质是**同一件事**：
 * 合并时丢了一侧的边界。两处实现必然继续分叉 —— 所以收敛到这一个纯函数，
 * 两个调用方只负责"把哪两份喂进来"。
 *
 * ## 合并语义（保守优先，与全仓方向一致）
 *
 * - 任一侧为 `null`（无计划/全量承诺）⇒ 合并结果 `null`（全量）。**不许**把"不可知的
 *   一侧"读成"不需要重算"。
 * - 任一侧某域为 `null`（该域不可复用/全算）⇒ 结果该域为 `null`：较晚的新边界
 *   **不得覆盖**"这个域不可增量"的声明。
 * - 其余逐域取**最早**（更早必然覆盖更晚：早边界包含晚边界的全部变更时刻）。
 * - 三域与顶层边界全为 `null` ⇒ 结果 `null`（等价于全量，不保留一个空壳计划）。
 */
export function mergeDirtyPlans(
  left: AnalysisDirtyPlan | null,
  right: AnalysisDirtyPlan | null
): AnalysisDirtyPlan | null {
  if (left === null || right === null) return null;
  const pick = (a: string | null, b: string | null): string | null =>
    a === null || b === null ? null : a <= b ? a : b;
  const domains: AnalysisDirtyDomains = {
    features: pick(left.domains.features, right.domains.features),
    fitness: pick(left.domains.fitness, right.domains.fitness),
    readiness: pick(left.domains.readiness, right.domains.readiness)
  };
  const dirtyFromAt = pick(left.dirtyFromAt, right.dirtyFromAt)
    ?? domains.features ?? domains.fitness ?? domains.readiness;
  if (dirtyFromAt === null) return null;
  return { dirtyFromAt, domains };
}

const SCORING_RECORD_TYPES = new Set<string>(scoringHealthTypes);
const NON_SCORING_RECORD_TYPES = new Set<string>(DATA_ONLY_RECORD_TYPES);

/**
 * 记录类型能否被**局部脏边界**解释。
 *
 * 只有两类可以：评分类型（进特征/能力/负荷）与非评分白名单（结构上不碰分析）。
 * 其余一律视为未知：它既可能影响任何域，也可能只影响未建模的证据；在没有域依赖
 * 证明之前，唯一安全结论是 **full**。不能因为同一批里还有一条有界已知变更，就把
 * 未知记录的时间影响“借”给那一条边界 —— 那正是 T05 的漏算形态。
 */
function hasUnknownRecordType(change: DirtyRangeChange): boolean {
  if (change.entityKind !== "record") return false;
  return [change.newType, change.previousType].some((type) =>
    type !== null && !SCORING_RECORD_TYPES.has(type) && !NON_SCORING_RECORD_TYPES.has(type));
}

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
    // 未知记录类型没有域依赖证明：即使同批还有一条有界已知变更，也不能把未知
    // 记录的影响交给那条边界。这是第二层 fail-closed（第一层是登记分析任务）。
    if (hasUnknownRecordType(change)) {
      full = true;
      reasons.add("unknown_record_type");
      continue;
    }
    // P1-3：历史账本（v37 之前）的 `removed` 行没有 `previous_*`。删除没有新侧，
    // 旧侧也缺失时，这条变更的**类型与区间都不可证明** —— 不能因为它“没有边界”
    // 就被同一批里另一条有界变更吞掉。唯一安全结论是全量。
    if (change.changeType === "removed"
        && change.previousStart === null
        && (change.entityKind === "record" || change.entityKind === "workout"
          || change.entityKind === "activity_summary")) {
      full = true;
      reasons.add("legacy_removal_without_previous_range");
      reasons.add("health_boundary_unknown");
      continue;
    }
    if (change.entityKind === "record" && change.changeType === "removed" && change.previousType === null) {
      full = true;
      reasons.add("legacy_removal_without_previous_range");
      reasons.add("health_boundary_unknown");
      continue;
    }
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
            // P0-2（2026-10-18）：**不再 full**。只记原因；边界由下面的通用区间逻辑
            // （并集 + 相交训练回退）给出。区间非法/无边界时仍由 fail-safe 分支转 full。
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
      // activity_summary / 合成 route：点时刻（或旧的区间，若有 previous_end）。
      //
      // 🔴 B05（2026-10-17）：**仍然要进相交回退**。旧注释说"区间在下界之外无须单独回退"，
      // 但对路线变更不成立：路线文件时刻（或活动摘要）可能落在训练**中段**，只取该时刻
      // 会让训练前半段的特征、负荷与分区不被重算 —— 那正是"只改一条路线就只改一行分数"。
      // 点区间 `[t, t]` 与训练相交时，回退原语会把它压到训练开始。
      const sides = [
        { start: change.newStart, end: change.newEnd },
        { start: change.previousStart, end: change.previousEnd }
      ];
      for (const side of sides) {
        if (side.start === null || side.start === undefined) {
          // 只有 `end` 没有 `start`：不知道这次变更从哪儿开始，**不能**拿 `end` 当起点
          // （那会把更早的半段留在边界之外 = 漏算）。旧实现在这里 `addInstant(end)`，
          // 方向是错的；fail-safe 只有一条路 —— 全量。
          if (side.end !== null && side.end !== undefined) {
            full = true;
            reasons.add("invalid_health_interval");
          }
          continue;
        }
        if (!isCanonicalInstant(side.start)) {
          full = true;
          reasons.add("invalid_health_time");
          continue;
        }
        const end = side.end === null || side.end === undefined ? side.start : side.end;
        if (!isCanonicalInstant(end) || end < side.start) {
          full = true;
          reasons.add("invalid_health_interval");
          continue;
        }
        intervals.push({ start: side.start, end });
        addInstant(side.start);
      }
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
