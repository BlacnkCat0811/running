import type { DatabaseSync } from "node:sqlite";

import { BASELINE_POLICY_VERSION, defaultRebasePolicy, reviewBaselineRebase } from "@rai/scoring";
import { semanticHash } from "@rai/storage-sqlite";

/**
 * Read-only epoch/saturation inventory and prospective review policy.
 * Migration 25 stores explicit review history; an uninitialized ledger stays
 * not_evaluable. recordBaselineRebaseReview starts observation prospectively,
 * never invents a past review and never automatically changes a baseline.
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
    "SELECT m.id AS id, m.evaluated_at AS evaluatedAt, m.dataset_version AS datasetVersion FROM model_runs m WHERE m.id=(SELECT model_run_id FROM active_model_run)"
  ).get() as { id: string; evaluatedAt: string; datasetVersion: string } | undefined;
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
  let epochStartedAt = typeof baseline?.calibrationEndAt === "string" ? baseline.calibrationEndAt : null;
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
  const effectiveAt = epochIds.length === 1 && tableExists("model_release_bundles")
    ? database.prepare(`SELECT json_extract(evaluation_json,'$.rebase.effectiveAt') AS at
        FROM model_release_bundles WHERE status='passed' AND activated_at IS NOT NULL AND dataset_version=?
        AND json_extract(evaluation_json,'$.rebase.candidateEpoch')=?
        ORDER BY created_at ASC,model_run_id ASC LIMIT 1`).get(activeRun.datasetVersion,epochIds[0]!)?.at : null;
  if (typeof effectiveAt === "string" && Number.isFinite(Date.parse(effectiveAt))) {
    if (Date.parse(effectiveAt)>Date.parse(asOf)) throw new Error("Epoch effective time is after asOf");
    epochStartedAt=effectiveAt;
  }
  const policyHash = semanticHash({policy:{...policy,policyVersion:BASELINE_POLICY_VERSION},windowDays});
  const history = epochIds.length === 1 && tableExists("baseline_rebase_reviews")
    ? database.prepare(`SELECT reviewed_at AS at,saturated_reviews AS count,evidence_json AS json
        FROM baseline_rebase_reviews WHERE epoch_id=? AND policy_hash=? AND reviewed_at<=?
        ORDER BY reviewed_at DESC LIMIT 1`).get(epochIds[0]!,policyHash,new Date(asOf).toISOString()) as
        {at:string;count:number;json:string}|undefined
    : undefined;
  const persistedDecision = history && saturatedFraction !== null
    ? (Date.parse(history.at) === Date.parse(asOf)
      ? (JSON.parse(history.json) as BaselineReviewRecord).decision
      : reviewBaselineRebase({
        asOf,epochStartedAt,lastReviewedAt:history.at,independentSessions:sessions.size,
        saturatedFraction,precedingSaturatedReviews:history.count
      },policy))
    : null;

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
      startedAtSource: typeof effectiveAt === "string" ? "published_rebase.effectiveAt" : "checkpoint.state.baseline.calibrationEndAt",
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
      lastReviewedAt: history?.at??null,
      precedingSaturatedReviews: history?.count??null,
      status: history ? "persisted" as const : "not_persisted" as const,
      /** 缺这两个输入会门控哪些分支 —— 写清楚，免得有人用默认值补上。 */
      gatedBranches: history ? [] : [
        "lastReviewedAt 为 null 时 `not_due`（每 28 天最多一次）永不成立",
        "precedingSaturatedReviews 决定 `candidate_requested` 还是 `keep_epoch`（需 >= consecutiveReviews）"
      ]
    },
    review: persistedDecision ? {...persistedDecision,reason:null} : {
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
      "只读盘点：`saturation` 与 `evidence` 是实测事实；有持久化检查历史时才继续裁决。" +
      "§6.4 的触发数字仍是候选政策，不是本项目已校准的生理常数。"
  };
}

/**
 * Explicitly start/continue prospective review history. An empty ledger means
 * "observation starts now", never evidence of a previous saturated review.
 * No model publication or automatic rebase is performed here.
 */
export function recordBaselineRebaseReview(database: DatabaseSync, options: BaselineRebaseReviewOptions = {}) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const evidence = buildBaselineRebaseReview(database, options);
    const epochId = evidence.epoch.epochId;
    if (epochId === null) throw new Error("A published baseline epoch is required to record a review");
    const policyHash = semanticHash({policy:evidence.policy,windowDays:evidence.window.windowDays});
    const previous = database.prepare(`SELECT reviewed_at AS at,saturated_reviews AS count,
      evidence_json AS json FROM baseline_rebase_reviews
      WHERE epoch_id=? AND policy_hash=? ORDER BY reviewed_at DESC LIMIT 1`)
      .get(epochId,policyHash) as {at:string;count:number;json:string}|undefined;
    const asOf = new Date(evidence.asOf).toISOString();
    if (previous && Date.parse(previous.at) > Date.parse(asOf)) throw new Error("Cannot backdate a baseline review");
    if (previous?.at === asOf) {
      const saved = JSON.parse(previous.json) as {evidence:typeof evidence};
      const measured = (value:typeof evidence) => ({
        epoch:value.epoch,policy:value.policy,window:value.window,evidence:value.evidence,saturation:value.saturation
      });
      if (semanticHash(measured(saved.evidence)) !== semanticHash(measured(evidence))) throw new Error("Review evidence changed at the same cutoff");
      database.exec("COMMIT");
      return JSON.parse(previous.json) as BaselineReviewRecord;
    }
    if (evidence.saturation.saturatedFraction === null) throw new Error("No saturation evidence; review remains not_evaluable");
    const decision = reviewBaselineRebase({
      asOf,epochStartedAt:evidence.epoch.startedAt,lastReviewedAt:previous?.at??null,
      independentSessions:evidence.evidence.independentSessions,
      saturatedFraction:evidence.saturation.saturatedFraction,precedingSaturatedReviews:previous?.count??0
    },options.policy??defaultRebasePolicy);
    const record: BaselineReviewRecord = {
      epochId,policyHash,asOf,evidence,decision,
      historyMode:previous?"continued":"prospective_history_started",
      persisted:decision.status!=="not_due"
    };
    if (record.persisted) database.prepare(`INSERT INTO baseline_rebase_reviews
      VALUES (?,?,?,?,?,?,?)`).run(epochId,policyHash,asOf,evidence.epoch.modelRunId,
        decision.status,decision.saturatedReviews,JSON.stringify(record));
    database.exec("COMMIT");
    return record;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

interface BaselineReviewRecord {
  epochId:string;
  policyHash:string;
  asOf:string;
  evidence:ReturnType<typeof buildBaselineRebaseReview>;
  decision:ReturnType<typeof reviewBaselineRebase>;
  historyMode:"continued"|"prospective_history_started";
  persisted:boolean;
}
