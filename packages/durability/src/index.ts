/**
 * §8 Durability —— 专项准备度（Preparation）与耐久能力（Durability）分开存证据。
 *
 * 本包的定位（§8.1 / §17.4）：
 *
 * - **Preparation**：把现有 `loadRaceReadinessEvidence` 的语义迁移过来，**保留旧计算**，
 *   并补上"历史是否完整"的诊断字段。**本轮不改变任何对外数值**（迁移 = 改名 + 加诊断）。
 * - **Durability**：只输出**证据**，**未校准时不给分数、不开 penalty**（§17.4 任务 2）。
 * - §8.2 的"同一场比赛不能被用三遍"在这里变成**构造时即校验**的证据额度账本。
 */

import type { ModelLineageV2, RaceDistance } from "@rai/contracts";

export const DURABILITY_MODEL_VERSION = "rai-durability-v1.0.0" as const;

/** §8.1：现有实现使用的窗口。 */
export const PREPARATION_WINDOW_DAYS = 56;
/**
 * §8.1 点名的缺陷：现有实现**固定**除以 8 周。
 * 历史不满 8 周的用户会被当成"训练不足"。本包保留该分母以保证数值兼容，
 * 并另行给出诊断字段让这个区别**可见**。
 */
export const LEGACY_WEEKLY_DENOMINATOR_WEEKS = 8;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const assertFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
};

/**
 * 与 `packages/application/src/prediction-data.ts` 的**本地** `daysBetween` 同语义：
 * 未取整的毫秒差。刻意不换用 `@rai/contracts` 的按日实现 —— 后者会把完整时间戳
 * 拼成 `...T00:00:00Z` 而解析成 NaN。迁移的判据是**逐位相同**，不是"看起来一样"。
 */
function fractionalDaysBetween(earlier: string, later: string): number {
  return (Date.parse(later) - Date.parse(earlier)) / 86_400_000;
}

// -----------------------------------------------------------------------------
// Preparation
// -----------------------------------------------------------------------------

export interface PreparationTarget {
  readonly weeklyDistanceKm: number;
  readonly longestRunKm: number;
  readonly runsPerWeek: number;
  readonly exposureDistanceKm: number;
  readonly exposureCount: number;
  readonly weights: {
    readonly volume: number;
    readonly longRun: number;
    readonly frequency: number;
    readonly exposure: number;
    readonly recency: number;
  };
}

/** 逐字迁移自 `prediction-data.ts` 的 `readinessTargets`；数值未动。 */
export const PREPARATION_TARGETS: Record<RaceDistance, PreparationTarget> = {
  five_k: {
    weeklyDistanceKm: 15,
    longestRunKm: 8,
    runsPerWeek: 2.5,
    exposureDistanceKm: 3,
    exposureCount: 2,
    weights: { volume: 0.25, longRun: 0.2, frequency: 0.25, exposure: 0.15, recency: 0.15 }
  },
  ten_k: {
    weeklyDistanceKm: 25,
    longestRunKm: 12,
    runsPerWeek: 3,
    exposureDistanceKm: 6,
    exposureCount: 2,
    weights: { volume: 0.3, longRun: 0.25, frequency: 0.2, exposure: 0.1, recency: 0.15 }
  },
  half_marathon: {
    weeklyDistanceKm: 35,
    longestRunKm: 18,
    runsPerWeek: 3.5,
    exposureDistanceKm: 12,
    exposureCount: 2,
    weights: { volume: 0.35, longRun: 0.35, frequency: 0.15, exposure: 0.05, recency: 0.1 }
  }
};

/**
 * 一条可用于准备度统计的训练事实。**可用性筛选（时长/配速区间）由调用方完成** ——
 * 那是数据层的事，本包只做算术。
 */
export interface PreparationTrainingFact {
  observedAt: string;
  distanceKm: number;
  durationSeconds: number;
}

export interface PreparationComponents {
  volumePreparedness: number;
  longRunExposure: number;
  frequency: number;
  targetExposure: number;
  recency: number;
}

export type EvidenceLevel = "insufficient" | "developing" | "established";

export interface PreparationAssessment {
  modelVersion: typeof DURABILITY_MODEL_VERSION;
  status: "available" | "insufficient_data";
  /** 逐位兼容旧 `loadRaceReadiness` 的三个距离分数。 */
  values: Partial<Record<RaceDistance, number>>;
  components: Partial<Record<RaceDistance, PreparationComponents>>;
  evidenceCount: number;
  latestTrainingAt: string | null;
  weeklyDistanceKm: number | null;
  runsPerWeek: number | null;
  longestRunKm: number | null;
  /** 最早一条可用训练距 `asOf` 的天数（未取整，与 `daysBetween` 同语义）。 */
  historyCoverageDays: number | null;
  /**
   * **仅诊断，不参与任何分数。** 把固定 8 周分母换成"实际观察到的覆盖周数"
   * （`historyCoverageDays / 7`，夹在 [1, 8] 之间）后的周跑量。
   * §8.1 要求区分"历史不完整"与"真实低跑量"；改分母会改变对外数值，
   * 那是一次需要独立回放对照的政策变更，不是本批的事。
   */
  observedCoverageWeeklyDistanceKm: number | null;
  /**
   * 由**覆盖天数**判定，不引入新阈值：
   * - `insufficient`：没有任何可用训练。
   * - `developing`：有训练，但历史不足一个完整窗口（`PREPARATION_WINDOW_DAYS`）
   *   ⇒ 固定 8 周分母在此**不具意义**，此时低分不等于低跑量。
   * - `established`：历史已覆盖整个窗口。
   */
  evidenceLevel: EvidenceLevel;
  reasonCodes: string[];
}

function validateTargets(targets: Record<RaceDistance, PreparationTarget>): void {
  for (const [distance, target] of Object.entries(targets)) {
    for (const [name, value] of Object.entries({
      weeklyDistanceKm: target.weeklyDistanceKm,
      longestRunKm: target.longestRunKm,
      runsPerWeek: target.runsPerWeek,
      exposureDistanceKm: target.exposureDistanceKm,
      exposureCount: target.exposureCount
    })) {
      assertFinite(`${distance}.${name}`, value);
      if (value <= 0) throw new Error(`${distance}.${name} must be positive`);
    }
    const weightSum = Object.values(target.weights).reduce((sum, value) => sum + value, 0);
    if (Math.abs(weightSum - 1) > 1e-9) {
      throw new Error(`${distance} preparation weights must sum to 1, got ${weightSum}`);
    }
  }
}

/**
 * §8.1 的语义迁移。**同一组输入必须给出与旧实现逐位相同的结果** ——
 * `loadRaceReadinessEvidence` 现在委托到这里，迁移前后实测逐位一致。
 */
export function assessPreparation(
  facts: readonly PreparationTrainingFact[],
  asOf: string,
  targets: Record<RaceDistance, PreparationTarget> = PREPARATION_TARGETS
): PreparationAssessment {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("asOf must be a parseable instant");
  validateTargets(targets);
  for (const fact of facts) {
    if (!Number.isFinite(Date.parse(fact.observedAt))) {
      throw new Error(`fact.observedAt must be a parseable instant: ${fact.observedAt}`);
    }
    assertFinite("fact.distanceKm", fact.distanceKm);
    assertFinite("fact.durationSeconds", fact.durationSeconds);
  }

  const base = {
    modelVersion: DURABILITY_MODEL_VERSION,
    evidenceCount: facts.length,
    latestTrainingAt: null,
    weeklyDistanceKm: null,
    runsPerWeek: null,
    longestRunKm: null,
    historyCoverageDays: null,
    observedCoverageWeeklyDistanceKm: null
  } as const;

  if (facts.length === 0) {
    return {
      ...base,
      status: "insufficient_data",
      values: {},
      components: {},
      evidenceLevel: "insufficient",
      // 没有可用训练时覆盖率确实是 0，不是"未知" —— 与 §8.3 的 `number` 类型不冲突。
      historyCoverageDays: 0,
      reasonCodes: ["no_usable_training"]
    };
  }

  // 与旧实现完全一致的五个量。
  const weeklyDistanceKm = facts.reduce((sum, fact) => sum + fact.distanceKm, 0) / LEGACY_WEEKLY_DENOMINATOR_WEEKS;
  const runsPerWeek = facts.length / LEGACY_WEEKLY_DENOMINATOR_WEEKS;
  const longestRunKm = Math.max(...facts.map((fact) => fact.distanceKm));
  const latestAt = facts.at(-1)?.observedAt ?? asOf;
  const daysSinceRun = Math.max(0, fractionalDaysBetween(latestAt, asOf));
  const recencyScore = Math.exp(-Math.max(0, daysSinceRun - 3) / 14);
  const earliestAt = facts[0]?.observedAt ?? asOf;
  const historyCoverageDays = Math.max(0, fractionalDaysBetween(earliestAt, asOf));
  const coverageWeeks = clamp(historyCoverageDays / 7, 1, LEGACY_WEEKLY_DENOMINATOR_WEEKS);
  const totalDistanceKm = facts.reduce((sum, fact) => sum + fact.distanceKm, 0);

  const values: Partial<Record<RaceDistance, number>> = {};
  const components: Partial<Record<RaceDistance, PreparationComponents>> = {};
  for (const distance of Object.keys(targets) as RaceDistance[]) {
    const target = targets[distance];
    const volume = clamp(weeklyDistanceKm / target.weeklyDistanceKm, 0, 1);
    const longRun = clamp(longestRunKm / target.longestRunKm, 0, 1);
    const frequency = clamp(runsPerWeek / target.runsPerWeek, 0, 1);
    const exposures = facts.filter((fact) => fact.distanceKm >= target.exposureDistanceKm).length;
    const exposure = clamp(exposures / target.exposureCount, 0, 1);
    components[distance] = {
      volumePreparedness: volume,
      longRunExposure: longRun,
      frequency,
      targetExposure: exposure,
      recency: recencyScore
    };
    values[distance] = clamp(
      target.weights.volume * volume +
        target.weights.longRun * longRun +
        target.weights.frequency * frequency +
        target.weights.exposure * exposure +
        target.weights.recency * recencyScore,
      0,
      1
    );
  }

  const established = historyCoverageDays >= PREPARATION_WINDOW_DAYS;

  return {
    modelVersion: DURABILITY_MODEL_VERSION,
    status: "available",
    values,
    components,
    evidenceCount: facts.length,
    latestTrainingAt: latestAt,
    weeklyDistanceKm,
    runsPerWeek,
    longestRunKm,
    historyCoverageDays,
    observedCoverageWeeklyDistanceKm: totalDistanceKm / coverageWeeks,
    evidenceLevel: established ? "established" : "developing",
    reasonCodes: established ? ["history_covers_window"] : ["history_incomplete"]
  };
}

// -----------------------------------------------------------------------------
// Durability
// -----------------------------------------------------------------------------

export interface DurabilityInput {
  /** §8.3 的零件：长持续运动后配速/效率是否维持。未计算时为 null。 */
  lateRunStability: number | null;
  matchedPerformanceEvidence: number | null;
  lateRunEvidenceCount: number;
  /**
   * 该距离的暴露次数目标（来自 `PREPARATION_TARGETS[distance].exposureCount`）。
   * 传参而不是在本包写死阈值 —— 免得又发明一个没人校准过的数字。
   */
  evidenceTargetCount: number;
}

export interface DurabilityAssessment {
  modelVersion: typeof DURABILITY_MODEL_VERSION;
  /**
   * **本版本恒为 `null`。** §8.2/§17.4：Durability 未校准时只输出证据、不给分数、不开 penalty；
   * 局部零标签，任何数值映射都会是编的。`null` 也不是 0 —— 0 会被读成"耐力为零"这个断言。
   */
  durabilityScore: null;
  evidenceLevel: EvidenceLevel;
  components: {
    lateRunStability: number | null;
    matchedPerformanceEvidence: number | null;
  };
  reasonCodes: string[];
}

export function assessDurability(input: DurabilityInput): DurabilityAssessment {
  if (!Number.isInteger(input.lateRunEvidenceCount) || input.lateRunEvidenceCount < 0) {
    throw new Error("lateRunEvidenceCount must be a non-negative integer");
  }
  assertFinite("evidenceTargetCount", input.evidenceTargetCount);
  if (input.evidenceTargetCount <= 0) throw new Error("evidenceTargetCount must be positive");
  for (const [name, value] of [
    ["lateRunStability", input.lateRunStability],
    ["matchedPerformanceEvidence", input.matchedPerformanceEvidence]
  ] as const) {
    if (value !== null) {
      assertFinite(name, value);
      if (value < 0 || value > 1) throw new Error(`${name} must be within [0, 1]`);
    }
  }

  const evidenceLevel: EvidenceLevel =
    input.lateRunEvidenceCount === 0
      ? "insufficient"
      : input.lateRunEvidenceCount >= input.evidenceTargetCount
        ? "established"
        : "developing";

  const reasonCodes = ["penalty_withheld_pending_calibration"];
  if (input.lateRunEvidenceCount === 0) reasonCodes.push("no_late_run_evidence");
  if (input.lateRunStability === null) reasonCodes.push("late_run_stability_unavailable");

  return {
    modelVersion: DURABILITY_MODEL_VERSION,
    durabilityScore: null,
    evidenceLevel,
    components: {
      lateRunStability: input.lateRunStability,
      matchedPerformanceEvidence: input.matchedPerformanceEvidence
    },
    reasonCodes
  };
}

// -----------------------------------------------------------------------------
// §8.3 快照
// -----------------------------------------------------------------------------

export interface DurabilitySnapshotComponents {
  volumePreparedness: number | null;
  longRunExposure: number | null;
  frequency: number | null;
  targetExposure: number | null;
  lateRunStability: number | null;
  matchedPerformanceEvidence: number | null;
}

export interface DurabilitySnapshot {
  modelVersion: typeof DURABILITY_MODEL_VERSION;
  distance: RaceDistance;
  preparationScore: number | null;
  durabilityScore: number | null;
  evidenceLevel: EvidenceLevel;
  historyCoverageDays: number;
  components: DurabilitySnapshotComponents;
  reasonCodes: string[];
  lineage: ModelLineageV2;
}

export function buildDurabilitySnapshot(input: {
  distance: RaceDistance;
  preparation: PreparationAssessment;
  durability: DurabilityAssessment;
  lineage: ModelLineageV2;
}): DurabilitySnapshot {
  const preparationComponents = input.preparation.components[input.distance] ?? null;
  return {
    modelVersion: DURABILITY_MODEL_VERSION,
    distance: input.distance,
    preparationScore: input.preparation.values[input.distance] ?? null,
    durabilityScore: input.durability.durabilityScore,
    // 两者都取较弱的一方：准备度不足时不能因为耐久证据齐备就说"established"。
    evidenceLevel:
      input.preparation.evidenceLevel === "established" && input.durability.evidenceLevel === "established"
        ? "established"
        : input.preparation.evidenceLevel === "insufficient"
          ? "insufficient"
          : "developing",
    historyCoverageDays: input.preparation.historyCoverageDays ?? 0,
    components: {
      volumePreparedness: preparationComponents?.volumePreparedness ?? null,
      longRunExposure: preparationComponents?.longRunExposure ?? null,
      frequency: preparationComponents?.frequency ?? null,
      targetExposure: preparationComponents?.targetExposure ?? null,
      lateRunStability: input.durability.components.lateRunStability,
      matchedPerformanceEvidence: input.durability.components.matchedPerformanceEvidence
    },
    reasonCodes: [...new Set([...input.preparation.reasonCodes, ...input.durability.reasonCodes])],
    lineage: input.lineage
  };
}

// -----------------------------------------------------------------------------
// §8.2 比赛证据的额度账本
// -----------------------------------------------------------------------------

/**
 * §8.2 点名的三个受益通道。同一场比赛**只能**合计占用 1 份额度：
 * "不要同一比赛既抬高 VDOT，又全额解除 preparation penalty，并再奖励 durability"。
 */
export type RaceEvidenceChannel = "ability_estimate" | "preparation_penalty_relief" | "durability_reward";

export const RACE_EVIDENCE_CHANNELS: readonly RaceEvidenceChannel[] = [
  "ability_estimate",
  "preparation_penalty_relief",
  "durability_reward"
] as const;

export interface RaceEvidenceConsumer {
  readonly id: string;
  readonly channel: RaceEvidenceChannel;
  /** 该通道占用的证据额度，0..1。所有通道之和必须 ≤ 1。 */
  readonly shareFraction: number;
  /** 一个通道可以有多个代码落点（同一份证据的不同表示），仍只算一份额度。 */
  readonly locations: readonly string[];
  readonly note: string;
}

/**
 * 现状登记（2026-09-29 对照源码确认）。标注成绩进能力估计有**两个表示**
 * （`loadLabeledPerformanceEvidence` 的原始 VO2 证据、`loadPerformanceVdotEvidence`
 * 的条件修正表示），但它们同属"能力估计"这一个通道 ⇒ 记 **1** 份额度，
 * 而不是两次。额度此时**已用满**：任何新通道都必须先把这 1 份让出一部分。
 *
 * `preparation_penalty_relief` 与 `durability_reward` 目前**没有**消费者 ——
 * §8.1 还明确要求"并不立即增加一个额外扣分"。
 */
export const defaultRaceEvidenceLedger: readonly RaceEvidenceConsumer[] = [
  {
    id: "labeled-performance-to-ability-estimate",
    channel: "ability_estimate",
    shareFraction: 1,
    locations: [
      "packages/application/src/prediction-data.ts:loadLabeledPerformanceEvidence",
      "packages/application/src/prediction-data.ts:loadPerformanceVdotEvidence"
    ],
    note: "比赛/标准测试/计时赛成绩进入能力估计（VO2max/VDOT 证据）。两个落点是同一份证据的两种表示，合并计一份额度。"
  }
];

export function validateRaceEvidenceLedger(consumers: readonly RaceEvidenceConsumer[]): void {
  const identifiers = new Set<string>();
  let total = 0;
  for (const consumer of consumers) {
    if (consumer.id.length === 0) throw new Error("race evidence consumer id must not be empty");
    if (identifiers.has(consumer.id)) throw new Error(`duplicate race evidence consumer id: ${consumer.id}`);
    identifiers.add(consumer.id);
    if (!RACE_EVIDENCE_CHANNELS.includes(consumer.channel)) {
      throw new Error(`race evidence consumer ${consumer.id} has unknown channel: ${consumer.channel}`);
    }
    if (consumer.locations.length === 0) {
      throw new Error(`race evidence consumer ${consumer.id} has no locations`);
    }
    assertFinite(`${consumer.id}.shareFraction`, consumer.shareFraction);
    if (consumer.shareFraction < 0 || consumer.shareFraction > 1) {
      throw new Error(`race evidence consumer ${consumer.id} shareFraction must be within [0, 1]`);
    }
    total += consumer.shareFraction;
  }
  if (total > 1 + 1e-9) {
    // §8.2：同一场比赛被多次全额计入。
    throw new Error(
      `race evidence over-consumed: total shareFraction is ${total}, above the single-race budget of 1`
    );
  }
}

validateRaceEvidenceLedger(defaultRaceEvidenceLedger);
