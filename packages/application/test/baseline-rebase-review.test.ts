import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { buildBaselineRebaseReview } from "../src/baseline-rebase-review.js";

/**
 * §6.4 的 rebase 检查在真实库上**没有任何生产调用方**（唯一引用是单测）。
 * 这些用例钉住两件事：
 * 1. **可推导的事实**真的被算出来（epoch 起点、独立训练数、逐维度饱和度）；
 * 2. **推不出来的输入**被明确标成缺失，而不是用默认值糊成一个"检查结论"。
 *
 * 第 2 条是本模块存在的主要理由：`precedingSaturatedReviews` 直接决定
 * `candidate_requested` 还是 `keep_epoch`，填任何默认值都会得到一个
 * **确定但任意**的答案。所以 review.status 必须是 `not_evaluable`。
 */

const RUN = "model_run-test";

async function withDatabase(run: (store: RaiDatabase, db: RaiDatabase["database"]) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-rebase-review-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    const db = store.database;
    // 依赖链：feature_runs → model_runs → active_model_run / model_checkpoints。
    // `ability_assessments` 另有外键指向 training_sessions 与 workout_features，
    // 由 `insertAssessment` 一并建出（见那里的说明）。
    db.prepare(`INSERT INTO feature_runs (id, dataset_version, canonical_contract_version, feature_schema_version,
      feature_config_json, feature_config_hash, status)
      VALUES ('feature_run-test', 'dataset-test', 'canonical-health-v2', 'workout-feature-v4', '{}', 'fc-hash', 'succeeded')`).run();
    db.prepare(`INSERT INTO model_runs (id, feature_run_id, dataset_version, model_version, model_config_json,
      model_config_hash, evaluated_at, status, created_at)
      VALUES (?, 'feature_run-test', 'dataset-test', 'rai-model-config-v12', '{}', 'hash', ?, 'succeeded', ?)`)
      .run(RUN, "2026-07-20T02:51:58.706Z", "2026-07-20T02:51:58.706Z");
    db.prepare("INSERT INTO active_model_run (singleton, model_run_id, activated_at) VALUES (1, ?, ?)")
      .run(RUN, "2026-07-20T02:52:40.704Z");
    db.prepare(`INSERT INTO model_checkpoints (id, model_run_id, sequence_number, through_at, checkpoint_version,
      model_version, model_config_hash, feature_schema_version, feature_config_hash, timezone_identifier,
      state_json, state_hash, created_at)
      VALUES ('ckpt-1', ?, 1, '2026-07-19T12:24:01.000Z', 'rai-model-checkpoint-v2', 'rai-model-config-v12', 'hash',
        'workout-feature-v4', 'fc-hash', 'Asia/Shanghai', ?, 'state-hash', '2026-07-20T02:51:58.706Z')`)
      .run(RUN, JSON.stringify({
        baseline: { calibrationStartAt: "2026-06-01T00:00:00.000Z", calibrationEndAt: "2026-06-20T00:00:00.000Z", calibrationFeatureIds: ["a", "b"] },
        trueAbility: 46.18,
        eligibleWorkoutCount: 131
      }));
    run(store, db);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 一行合格评估。`weights` 决定哪些维度算"有效维度"。
 *
 * 夹具走**真实的引用链**（training_sessions → workout_features → ability_assessments），
 * 而不是关掉外键：`ability_assessments` 确实有这三个外键，把它们绕过去会让夹具
 * 描述一个数据库不可能存在的状态。
 */
function insertAssessment(
  db: RaiDatabase["database"],
  index: number,
  assessedAt: string,
  scores: Partial<Record<"efficiency" | "pace" | "cardio" | "stability" | "recovery", number | null>>,
  weights: Record<string, number>
): void {
  // `ability_assessments` 上有 UNIQUE(model_run_id, training_session_id)，所以今天
  // session 与 assessment 是 1:1。用不同 session 建夹具才描述真实可能的状态。
  const sessionId = `session-${index}`;
  db.prepare(`INSERT OR IGNORE INTO training_sessions
    (id, activity_type, anchor_start_at, anchor_end_at, status)
    VALUES (?, 'running', ?, ?, 'active')`)
    .run(sessionId, "2026-06-01T00:00:00.000Z", "2026-06-01T01:00:00.000Z");
  db.prepare(`INSERT INTO workout_features (id, feature_run_id, training_session_id, canonical_workout_id,
    workout_start_at, duration_seconds, source_confidence, session_type, session_type_source,
    eligibility_status, quality_score, missing_reasons_json, features_json, provenance_json)
    VALUES (?, 'feature_run-test', ?, ?, ?, 3600, 0.8, 'easy', 'auto', 'eligible', 0.8, '[]', '{}', '{}')`)
    .run(`feature-${index}`, sessionId, `canonical-${index}`, assessedAt);

  db.prepare(`INSERT INTO ability_assessments (id, model_run_id, feature_id, training_session_id, sequence_number,
    assessment_status, efficiency_score, pace_score, cardio_score, stability_score, recovery_score,
    effective_weights_json, confidence, confidence_factors_json, updated_true_ability,
    explanation_codes_json, explanation_json, assessed_at)
    VALUES (?, ?, ?, ?, ?, 'eligible', ?, ?, ?, ?, ?, ?, 0.8, '{}', 0, '[]', '{}', ?)`)
    .run(
      `assessment-${index}`, RUN, `feature-${index}`, sessionId, index,
      scores.efficiency ?? null, scores.pace ?? null, scores.cardio ?? null,
      scores.stability ?? null, scores.recovery ?? null,
      JSON.stringify(weights), assessedAt
    );
}

test("measurable facts are computed, and saturation uses only effective dimensions", async () => {
  await withDatabase((store, db) => {
    // 6 条证据：efficiency 有 2 条贴到 100（1/3 ≥ 0.2 ⇒ 触发）；cardio 权重为 0，即使贴边也不算。
    insertAssessment(db, 1, "2026-06-25T08:00:00.000Z", { efficiency: 100, cardio: 100 }, { efficiency: 1 });
    insertAssessment(db, 2, "2026-06-26T08:00:00.000Z", { efficiency: 100, cardio: 100 }, { efficiency: 1 });
    insertAssessment(db, 3, "2026-06-27T08:00:00.000Z", { efficiency: 62, cardio: 100 }, { efficiency: 1 });
    insertAssessment(db, 4, "2026-06-28T08:00:00.000Z", { efficiency: 55, cardio: 100 }, { efficiency: 1 });
    insertAssessment(db, 5, "2026-06-29T08:00:00.000Z", { efficiency: 70, cardio: 100 }, { efficiency: 1 });
    insertAssessment(db, 6, "2026-06-30T08:00:00.000Z", { efficiency: 41, cardio: 100 }, { efficiency: 1 });

    const review = buildBaselineRebaseReview(db, { asOf: "2026-07-01T00:00:00.000Z", windowDays: 28 });
    assert.equal(review.epoch.startedAt, "2026-06-20T00:00:00.000Z");
    assert.equal(review.epoch.startedAtSource, "checkpoint.state.baseline.calibrationEndAt");
    assert.equal(review.epoch.eligibleWorkoutCount, 131);
    assert.equal(review.epoch.trueAbility, 46.18);
    assert.equal(review.epoch.checkpointVersion, "rai-model-checkpoint-v2");
    assert.equal(review.evidence.eligibleAssessments, 6);
    // 当前 schema 上 UNIQUE(model_run_id, training_session_id) 让两者必然相等；
    // 用**去重计数**而不是行数是 §6.2 的要求（"一个 session 的多个窗口不算多次独立训练"），
    // 也是将来 schema 允许一次训练多个窗口时的防线。
    assert.equal(review.evidence.independentSessions, 6);
    assert.equal(review.evidence.distinctDays, 6);
    assert.equal(review.evidence.meetsMinimumIndependentSessions, false, "政策要求至少 12 次独立训练");

    const efficiency = review.saturation.perDimension.find((entry) => entry.dimension === "efficiency")!;
    assert.equal(efficiency.effectiveEvidence, 6);
    assert.equal(efficiency.saturatedEvidence, 2);
    assert.equal(efficiency.fraction, 2 / 6, '模块返回原始比例，不做四舍五入');
    // cardio 的分数条条贴边，但权重为 0 ⇒ 不是有效维度，不得参与。
    const cardio = review.saturation.perDimension.find((entry) => entry.dimension === "cardio")!;
    assert.equal(cardio.effectiveEvidence, 0);
    assert.equal(cardio.fraction, null);

    assert.equal(review.saturation.status, "measured");
    assert.equal(review.saturation.saturatedFraction, 2 / 6);
    assert.equal(review.saturation.triggerMet, true, "1/3 ≥ 0.2");
  });
});

test("a missing review history makes the verdict not_evaluable rather than a default", async () => {
  await withDatabase((store, db) => {
    insertAssessment(db, 1, "2026-06-25T08:00:00.000Z", { efficiency: 100 }, { efficiency: 1 });
    insertAssessment(db, 2, "2026-06-26T08:00:00.000Z", { efficiency: 100 }, { efficiency: 1 });

    const review = buildBaselineRebaseReview(db, { asOf: "2026-07-01T00:00:00.000Z" });
    assert.equal(review.review.status, "not_evaluable");
    assert.equal(review.review.reason, "review_history_not_persisted");
    assert.equal(review.review.autoRebase, false);
    assert.equal(review.reviewHistory.lastReviewedAt, null);
    assert.equal(review.reviewHistory.precedingSaturatedReviews, null);
    // 报告必须说清"缺的是哪两个、它们门控了什么"，否则读的人会自己去补默认值。
    assert.equal(review.reviewHistory.gatedBranches.length, 2);
    assert.match(review.reviewHistory.gatedBranches.join(" "), /precedingSaturatedReviews/);
    // 即使饱和触发成立，也不得出结论。
    assert.equal(review.saturation.triggerMet, true);
  });
});

test("the window is measured back from asOf, not from wall-clock now", async () => {
  await withDatabase((store, db) => {
    insertAssessment(db, 1, "2026-06-25T08:00:00.000Z", { efficiency: 60 }, { efficiency: 1 });
    // 窗口外（早于 asOf-28d）：不得计入分母。
    insertAssessment(db, 2, "2026-05-01T08:00:00.000Z", { efficiency: 100 }, { efficiency: 1 });
    const review = buildBaselineRebaseReview(db, { asOf: "2026-07-01T00:00:00.000Z", windowDays: 28 });
    assert.equal(review.window.fromAt, "2026-06-03T00:00:00.000Z");
    assert.equal(review.evidence.eligibleAssessments, 1);
    assert.equal(review.saturation.perDimension.find((entry) => entry.dimension === "efficiency")!.saturatedEvidence, 0);
  });
});

test("no eligible evidence yields null saturation, not zero", async () => {
  await withDatabase((store, db) => {
    const review = buildBaselineRebaseReview(db, { asOf: "2026-07-01T00:00:00.000Z" });
    assert.equal(review.saturation.status, "no_evidence");
    assert.equal(review.saturation.saturatedFraction, null, "没有证据时是 null，不是 0");
    assert.equal(review.saturation.triggerMet, null);
    assert.equal(review.evidence.eligibleAssessments, 0);
  });
});

test("an epoch that starts after the assessment instant is refused", async () => {
  await withDatabase((store, db) => {
    assert.throws(
      () => buildBaselineRebaseReview(db, { asOf: "2026-06-01T00:00:00.000Z" }),
      /Epoch start .* is after asOf/,
      "标尺建于评估时点之后时，这份 run 与这个 epoch 不自洽"
    );
  });
});
