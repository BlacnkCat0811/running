import type { DatabaseSync } from "node:sqlite";

import { BASELINE_POLICY_VERSION, defaultRebasePolicy } from "@rai/scoring";

/**
 * §6.4 的 **rebase 定期检查**在真实库上的只读盘点。
 *
 * 为什么需要它：`reviewBaselineRebase` 有实现、有单测，但**没有任何生产调用方**
 * （仓库里唯一引用是 `packages/scoring/test/baseline-v2.test.ts`）。所以"每 28 天最多检查一次、
 * 冷却 90 天、饱和触发"这套政策实际上从未跑过 —— 与批次 19 的消融脚本同一类问题：
 * 代码在那里、测试是绿的、但它不在任何真实路径上。
 *
 * 本模块把**可推导的事实**算出来，并把**推不出来的事实**明确标出来，而不是用默认值糊过去：
 *
 * | 输入 | 是否可推导 | 来源 |
 * |---|---|---|
 * | `asOf` | ✅ | 默认取 active run 的 `evaluated_at`（数据前沿，不是墙上时钟） |
 * | `epochStartedAt` | ✅ | 最新 checkpoint 的 `state.baseline.calibrationEndAt` |
 * | `independentSessions` | ✅ | 窗口内 `assessment_status='eligible'` 的去重 `training_session_id` |
 * | `saturatedFraction` | ✅ | 存储的逐维度分数 vs `effective_weights_json` |
 * | `lastReviewedAt` | ❌ **未持久化** | 没有任何表记"上次检查时间" |
 * | `precedingSaturatedReviews` | ❌ **未持久化** | 没有任何表记"连续饱和次数" |
 *
 * 🔴 **为什么不用默认值补上后两个**：`precedingSaturatedReviews` 直接决定
 * `candidate_requested` 还是 `keep_epoch`（`>= consecutiveReviews` 才请求候选）。
 * 填 0 ⇒ 永远 `keep_epoch`；填 1 ⇒ 只要这次饱和就 `candidate_requested`。
 * 两个都是**确定但任意**的答案，会把"缺状态"伪装成"检查结论"。
 * 所以本报告给出 `reviewStatus = "not_evaluable"`，并把缺失项**门控了哪条分支**写出来。
 */

export const BASELINE_REBASE_REVIEW_VERSION = "rai-baseline-rebase-review-v1" as const;

/** `clamp(50 + 10 × z, 0, 100)` 的两个端点；`epsilon` 吸收浮点误差。 */
const SATURATION_LOW = 0;
const SATURATION_HIGH = 100;
const SATURATION_EPSILON = 1e-6;

export interface BaselineRebaseReviewOptions {
  /** 评估时点。默认取 active run 的 `evaluated_at` —— 那才是这份数据的前沿。 */
  asOf?: string | null;
  /** 近期窗口天数。默认取政策的 `reviewEveryDays`，不另立一个数。 */
  windowDays?: number;
  policy?: typeof defaultRebasePolicy;
}

export function buildBaselineRebaseReview(database: DatabaseSync, options: BaselineRebaseReviewOptions = {}) {
  const policy = options.policy ?? defaultRebasePolicy;
  const windowDays = options.windowDays ?? policy.reviewEveryDays;
  if (!Number.isInteger(windowDays) || windowDays <= 0) throw new Error("windowDays must be a positive integer");

  const tableExists = (name: string): boolean =>
    database.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
  const columnExists = (table: string, column: string): boolean =>
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((row) => row.name === column);

  const activeRun = database.prepare(
    "SELECT m.id AS id, m.evaluated_at AS evaluatedAt FROM model_runs m WHERE m.id=(SELECT model_run_id FROM active_model_run)"
  ).get() as { id: string; evaluatedAt: string } | undefined;
  if (!activeRun) throw new Error("No active model run; there is no epoch to review");

  const asOf = options.asOf ?? String(activeRun.evaluatedAt);
  if (!Number.isFinite(Date.parse(asOf))) throw new Error(`Invalid asOf: ${asOf}`);

  // —— epoch 起点：checkpoint 的 baseline 建立时刻。这是"当前标尺从哪一刻开始"的存储事实。
  const checkpoint = database.prepare(
    `SELECT checkpoint_version AS version, through_at AS throughAt, state_json AS state
     FROM model_checkpoints WHERE model_run_id=? ORDER BY sequence_number DESC LIMIT 1`
  ).get(activeRun.id) as { version: string; throughAt: string | null; state: string } | undefined;
  if (!checkpoint) throw new Error("The active model run has no checkpoint; the epoch start is unknown");
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(String(checkpoint.state)) as Record<string, unknown>;
  } catch {
    throw new Error("The active model run checkpoint state is not valid JSON");
  }
  const baseline = (state.baseline ?? null) as
    { calibrationStartAt?: unknown; calibrationEndAt?: unknown; calibrationFeatureIds?: unknown } | null;
  const epochStartedAt = typeof baseline?.calibrationEndAt === "string" ? baseline.calibrationEndAt : null;
  if (epochStartedAt === null || !Number.isFinite(Date.parse(epochStartedAt))) {
    throw new Error("The checkpoint does not record a usable baseline calibrationEndAt");
  }
  if (Date.parse(epochStartedAt) > Date.parse(asOf)) {
    // 标尺建于评估时点之后 ⇒ 这份 run 与这个 epoch 不自洽，不能拿来做检查。
    throw new Error(`Epoch start ${epochStartedAt} is after asOf ${asOf}`);
  }

  // —— 近期窗口内的合格证据。只用**eligible**：trial/excluded/calibrating 不是"合格证据"。
  const windowFromAt = new Date(Date.parse(asOf) - windowDays * 86_400_000).toISOString();
  const rows = database.prepare(
    `SELECT id AS id, training_session_id AS sessionId, assessed_at AS assessedAt,
            efficiency_score AS efficiency, pace_score AS pace, cardio_score AS cardio,
            stability_score AS stability, recovery_score AS recovery,
            effective_weights_json AS weights
     FROM ability_assessments
     WHERE model_run_id=? AND assessment_status='eligible'
       AND assessed_at>=? AND assessed_at<=?
     ORDER BY assessed_at`
  ).all(activeRun.id, windowFromAt, asOf) as Array<Record<string, unknown>>;

  const dimensions = ["efficiency", "pace", "cardio", "stability", "recovery"] as const;
  const isSaturated = (value: number): boolean =>
    Math.abs(value - SATURATION_LOW) <= SATURATION_EPSILON || Math.abs(value - SATURATION_HIGH) <= SATURATION_EPSILON;
  const perDimension = dimensions.map((dimension) => {
    let scored = 0;
    let saturated = 0;
    for (const row of rows) {
      const raw = row[dimension];
      const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      if (value === null) continue;
      // 只有**有效维度**（本次评估里权重 > 0）才算；权重为 0 的维度即使有分数也不参与。
      let weight = 0;
      try {
        const parsed = JSON.parse(String(row.weights ?? "{}")) as Record<string, unknown>;
        const candidate = parsed[dimension];
        weight = typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
      } catch {
        weight = 0;
      }
      if (weight <= 0) continue;
      scored += 1;
      if (isSaturated(value)) saturated += 1;
    }
    return {
      dimension,
      effectiveEvidence: scored,
      saturatedEvidence: saturated,
      fraction: scored === 0 ? null : saturated / scored
    };
  });
  const measured = perDimension.filter((entry) => entry.fraction !== null);
  // §6.4 的措辞是"**一个**有效维度 … ≥20% 达到上限或下限"，所以取各维度的最大值。
  const saturatedFraction = measured.length === 0
    ? null
    : Math.max(...measured.map((entry) => entry.fraction as number));
  const triggerMet = saturatedFraction === null ? null : saturatedFraction >= policy.saturationFraction;

  const sessions = new Set(rows.map((row) => String(row.sessionId)));
  const days = new Set(rows.map((row) => String(row.assessedAt).slice(0, 10)));

  // epoch id 只在较新的 schema 上存在。**不编一个 hash 冒充它** —— 那会得到一个
  // 看起来像标识符、实际与任何已发布 lineage 都对不上的字符串。
  const epochIdAvailable = columnExists("daily_ability_snapshots", "baseline_epoch_id");
  const epochIds = epochIdAvailable
    ? (database.prepare(
      `SELECT DISTINCT baseline_epoch_id AS id FROM daily_ability_snapshots
       WHERE model_run_id=? AND baseline_epoch_id IS NOT NULL`
    ).all(activeRun.id) as Array<{ id: string }>).map((row) => String(row.id))
    : [];

  return {
    reportVersion: BASELINE_REBASE_REVIEW_VERSION,
    asOf,
    asOfSource: options.asOf == null ? "active_run_evaluated_at" : "argument",
    policy: { ...policy, policyVersion: BASELINE_POLICY_VERSION },
    epoch: {
      epochId: epochIds.length === 1 ? epochIds[0]! : null,
      epochIds,
      epochIdStatus: !epochIdAvailable
        ? "not_available_at_this_schema" as const
        : epochIds.length === 0 ? "column_empty_for_this_run" as const
          : epochIds.length === 1 ? "available" as const : "multiple_values_for_one_run" as const,
      startedAt: epochStartedAt,
      startedAtSource: "checkpoint.state.baseline.calibrationEndAt",
      modelRunId: activeRun.id,
      checkpointVersion: String(checkpoint.version),
      checkpointThroughAt: checkpoint.throughAt === null ? null : String(checkpoint.throughAt),
      calibrationFeatureCount: Array.isArray(baseline?.calibrationFeatureIds)
        ? baseline.calibrationFeatureIds.length : null,
      eligibleWorkoutCount: typeof state.eligibleWorkoutCount === "number" ? state.eligibleWorkoutCount : null,
      trueAbility: typeof state.trueAbility === "number" ? state.trueAbility : null
    },
    window: { fromAt: windowFromAt, toAt: asOf, windowDays, windowSource: options.windowDays == null ? "policy.reviewEveryDays" : "argument" },
    evidence: {
      eligibleAssessments: rows.length,
      independentSessions: sessions.size,
      distinctDays: days.size,
      /** 政策要求"独立训练至少 12 次"；这里给出实测值，判定留给读报告的人。 */
      minimumIndependentSessions: policy.minimumIndependentSessions,
      meetsMinimumIndependentSessions: sessions.size >= policy.minimumIndependentSessions
    },
    saturation: {
      status: saturatedFraction === null ? "no_evidence" as const : "measured" as const,
      definition: "各有效维度在窗口内合格证据中落到 0 或 100 的比例，取最大值（§6.4 的\"一个有效维度\"）",
      threshold: policy.saturationFraction,
      saturatedFraction,
      triggerMet,
      perDimension
    },
    reviewHistory: {
      lastReviewedAt: null,
      precedingSaturatedReviews: null,
      status: "not_persisted" as const,
      /** 缺这两个输入会门控哪些分支 —— 写清楚，免得有人用默认值补上。 */
      gatedBranches: [
        "lastReviewedAt 为 null 时 `not_due`（每 28 天最多一次）永不成立",
        "precedingSaturatedReviews 决定 `candidate_requested` 还是 `keep_epoch`（需 >= consecutiveReviews）"
      ]
    },
    review: {
      status: "not_evaluable" as const,
      reason: "review_history_not_persisted",
      autoRebase: false as const,
      note:
        "本报告不调用 `reviewBaselineRebase`：它的六个输入里有两个没有持久化，而这两个直接决定结论。" +
        "用默认值补齐会得到一个**确定但任意**的答案，把\"缺状态\"伪装成\"检查结论\"。",
      unblockRequirement:
        "需要持久化 review 历史（上次检查时间、连续饱和次数）后，本报告才能给出 review.status ∈ " +
        "{not_due, epoch_cooldown, insufficient_evidence, keep_epoch, candidate_requested}。"
    },
    note:
      "只读盘点：`saturation` 与 `evidence` 是实测事实，`review` 是明确不可评估。" +
      "§6.4 的触发数字仍是候选政策，不是本项目已校准的生理常数。"
  };
}
