// R4（`deliverables/IOS_SYNC_REREVIEW_2026-10-19.md` §R4，P2）读侧回归：
// `freshness()` / `analysisVisibility()` 的"触及训练"判据必须能看见**持久脏证据**
// （v45 `import_batches.analysis_dirty_plan_json`）与账本 v37 的**更新前区间**。
//
// 两个真实复现（同目录 output/ios-sync-rereview-2026-10-19/api-review-probes.test.ts）：
//   1. 路线-only 批次：workout XML 未变 ⇒ 没有 `import_entity_changes` workout 行，账本
//      重建不出边界；只有 dirty plan 的 `routeDirtyTimes` 指向本训练。旧读侧报 published。
//   2. 记录时间更正：`previous_effective_at` 仍在窗口内、当前 `effective_at` 已移出窗口。
//      旧 `touchMatcher` 只看当前 MIN/MAX ⇒ 报 published。
//
// 🔴 方向：宁可多报 pending（分析本来就会按脏范围重算），不可把待更新的旧结论说成最新。
// 但**不能**反过来把"没碰到本训练"的批次也算进来（那会让每一批记录都把历史翻成 pending），
// 所以本文件同时钉住"不触及 ⇒ 保持 published"与 raw-only 批次的排除。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "../src/database.js";
import {
  parseBatchAnalysisDirtyEvidence
} from "../src/read/batch-analysis-dirty-evidence.js";
import { SqliteWorkoutReadRepository } from "../src/read/workout-read-repository.js";

/** 本训练窗口（与生产事故同形）。 */
const STARTED_AT = "2026-10-18T11:46:38.000Z";
const ENDED_AT = "2026-10-18T12:28:46.000Z";
const WORKOUT_ID = "workout_r4_fixture";
const SESSION_ID = "training_session_r4_fixture";

/** 前一晚的训练：用来证明"没碰到的那条训练不会被翻成 pending"。 */
const STARTED_AT_PRIOR = "2026-10-17T07:00:00.000Z";
const ENDED_AT_PRIOR = "2026-10-17T07:40:00.000Z";
const WORKOUT_ID_PRIOR = "workout_r4_fixture_prior";
const SESSION_ID_PRIOR = "training_session_r4_fixture_prior";

const FACTS_BATCH = "batch_r4_facts";
const FACTS_BATCH_COMPLETED_AT = "2026-10-18T12:29:38.755Z";
const FACTS_JOB = "recompute_job_r4_facts";
const RELEASE_RUN = "model_run_r4_release";
const RELEASE_ACTIVATED_AT = "2026-10-18T12:31:21.265Z";

interface BatchOptions {
  batchId: string;
  completedAt: string;
  rawGeneration?: number;
  dependencyGeneration?: number;
  /** 省略 = 不影响分析（v39 之前的形态）。 */
  dependencyBumped?: number | null;
  /** `undefined` = 不写（等价 v45 之前的老批次）；`null` = 显式无值。 */
  dirtyEvidenceJson?: string | null;
  jobId?: string;
  jobStatus?: "queued" | "running" | "succeeded" | "failed";
  targetDependencyGeneration?: number;
}

/** 部分脏证据的规范形态（写端 `encodeBatchAnalysisDirtyEvidence` 同形）。 */
function partialPlan(options: {
  dirtyFromAt: string;
  routeDirtyTimes?: string[];
  recoveryBoundaries?: string[];
  reasons?: string[];
}): string {
  return JSON.stringify({
    version: 1,
    full: false,
    dirtyFromAt: options.dirtyFromAt,
    domains: {
      features: options.dirtyFromAt,
      fitness: options.dirtyFromAt,
      readiness: options.dirtyFromAt
    },
    routeDirtyTimes: options.routeDirtyTimes ?? [],
    recoveryBoundaries: options.recoveryBoundaries ?? [],
    reasons: options.reasons ?? ["bounded_health_change"]
  });
}

/** 写一条事实批次 + 它的分析任务（与生产同事务形态）。 */
function seedFacts(database: DatabaseSync): void {
  database.prepare(`INSERT INTO workouts
    (id, activity_type, source_name, source_category, source_version, device,
     start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
    VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture Apple Watch', 'apple_watch', '1', 'Watch',
      ?, ?, 2528, 0, '{}', '{}', 1)`).run(WORKOUT_ID, STARTED_AT, ENDED_AT);
  database.prepare(`INSERT INTO workouts
    (id, activity_type, source_name, source_category, source_version, device,
     start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
    VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture Apple Watch', 'apple_watch', '1', 'Watch',
      ?, ?, 2400, 0, '{}', '{}', 1)`).run(WORKOUT_ID_PRIOR, STARTED_AT_PRIOR, ENDED_AT_PRIOR);
  const insertSession = database.prepare(`INSERT INTO training_sessions
    (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
    VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 6.0125, ?, 'active')`);
  insertSession.run(SESSION_ID, STARTED_AT, ENDED_AT, WORKOUT_ID);
  insertSession.run(SESSION_ID_PRIOR, STARTED_AT_PRIOR, ENDED_AT_PRIOR, WORKOUT_ID_PRIOR);

  database.prepare(`INSERT INTO import_batches
    (id, xml_sha256, status, import_mode, completed_at, summary_json,
     raw_generation, dependency_generation, dependency_bumped)
    VALUES (?, ?, 'succeeded', 'incremental', ?, '{}', 1, 1, 1)`)
    .run(FACTS_BATCH, "a".repeat(64), FACTS_BATCH_COMPLETED_AT);
  database.prepare(`INSERT INTO import_entity_changes
    (batch_id, entity_kind, entity_id, change_type, effective_at, content_hash)
    VALUES (?, 'workout', ?, 'inserted', ?, NULL)`)
    .run(FACTS_BATCH, WORKOUT_ID, STARTED_AT);
  database.prepare(`INSERT INTO recompute_jobs
    (id, job_type, status, request_json, created_at, progress_phase, completed_at,
     target_raw_generation, target_dependency_generation)
    VALUES (?, 'import', 'succeeded', ?, ?, 'succeeded', ?, 1, 1)`)
    .run(FACTS_JOB, JSON.stringify({ mode: "direct_sync_analysis", importBatchId: FACTS_BATCH }),
      FACTS_BATCH_COMPLETED_AT, FACTS_BATCH_COMPLETED_AT);
}

/**
 * 发布一版分析（只造读侧需要的行：feature_run → workout_feature ×2 → model_run →
 * ability_assessment ×2 → active 指针 → v39 输入绑定）。
 *
 * `capturedDependencyGeneration` = 这一版实际吃到的依赖代次；后续批次代次更大 ⇒ 未被覆盖。
 */
function publishRelease(database: DatabaseSync, capturedDependencyGeneration: number): void {
  const evaluatedAt = "2026-10-18T12:31:16.543Z";
  database.prepare(`INSERT INTO feature_runs
    (id, dataset_version, canonical_contract_version, feature_schema_version,
     feature_config_json, feature_config_hash, status)
    VALUES ('feature_run_r4_release', 'dataset_fixture', 'v1', 'v1', '{}', 'hash', 'succeeded')`).run();
  const insertFeature = database.prepare(`INSERT INTO workout_features
    (id, feature_run_id, training_session_id, canonical_workout_id, workout_start_at,
     duration_seconds, distance_km, average_heart_rate_bpm, heart_rate_sample_count,
     heart_rate_coverage, route_point_count, route_quality, source_confidence, session_type,
     session_type_source, eligibility_status, quality_score, missing_reasons_json,
     features_json, provenance_json)
    VALUES (?, 'feature_run_r4_release', ?, ?, ?, 2528, 6.0125, 153.4, 3,
      0.8, 0, NULL, 0.9, 'easy', 'auto', 'eligible', 0.82, '[]', '{}', '{}')`);
  insertFeature.run("workout_feature_r4", SESSION_ID, WORKOUT_ID, STARTED_AT);
  insertFeature.run("workout_feature_r4_prior", SESSION_ID_PRIOR, WORKOUT_ID_PRIOR, STARTED_AT_PRIOR);
  database.prepare(`INSERT INTO model_runs
    (id, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
     evaluated_at, status)
    VALUES (?, 'feature_run_r4_release', 'dataset_fixture', 'rai-model-config-fixture',
      '{}', 'hash', ?, 'succeeded')`).run(RELEASE_RUN, evaluatedAt);
  const insertAssessment = database.prepare(`INSERT INTO ability_assessments
    (id, model_run_id, feature_id, training_session_id, sequence_number, assessment_status,
     current_ability, efficiency_score, pace_score, cardio_score, stability_score, recovery_score,
     effective_weights_json, confidence, confidence_factors_json, workout_contribution,
     updated_true_ability, explanation_codes_json, explanation_json, assessed_at)
    VALUES (?, ?, ?, ?, ?, 'eligible', 61.5, 60, 62, 58, 55, 50, '{"pace":0.4}', 0.72, '{}', 0.3,
      1, '[]', '{}', ?)`);
  insertAssessment.run("assessment_r4", RELEASE_RUN, "workout_feature_r4", SESSION_ID, 1, evaluatedAt);
  insertAssessment.run("assessment_r4_prior", RELEASE_RUN, "workout_feature_r4_prior",
    SESSION_ID_PRIOR, 2, evaluatedAt);
  database.prepare(`INSERT INTO active_model_run (singleton, model_run_id, activated_at)
    VALUES (1, ?, ?)`).run(RELEASE_RUN, RELEASE_ACTIVATED_AT);
  database.prepare(`INSERT INTO analysis_run_input_bindings
    (run_id, job_id, scope, dataset_version, captured_raw_generation,
     captured_dependency_generation, target_raw_generation, target_dependency_generation,
     incumbent_release_id, timezone_identifier, override_digest, config_digest, cutoff_at, input_digest)
    VALUES (?, ?, 'direct-sync', 'dataset_fixture', ?, ?, NULL, NULL, NULL, 'Asia/Shanghai',
      'override-digest', 'config-digest', ?, 'input-digest')`)
    .run(RELEASE_RUN, FACTS_JOB, capturedDependencyGeneration, capturedDependencyGeneration, evaluatedAt);
}

/** 追加一个批次（可选独立任务）；manifest 里只有"批次 + 任务"，实体变更由用例自己写。 */
function addBatch(database: DatabaseSync, options: BatchOptions): void {
  database.prepare(`INSERT INTO import_batches
    (id, xml_sha256, status, import_mode, completed_at, summary_json,
     raw_generation, dependency_generation, dependency_bumped, analysis_dirty_plan_json)
    VALUES (?, ?, 'succeeded', 'incremental', ?, '{}', ?, ?, ?, ?)`)
    .run(options.batchId, "b".repeat(64), options.completedAt,
      options.rawGeneration ?? null, options.dependencyGeneration ?? null,
      options.dependencyBumped === undefined ? null : options.dependencyBumped,
      options.dirtyEvidenceJson ?? null);
  if (options.jobId !== undefined) {
    database.prepare(`INSERT INTO recompute_jobs
      (id, job_type, status, request_json, created_at, progress_phase,
       target_raw_generation, target_dependency_generation)
      VALUES (?, 'import', ?, ?, ?, 'queued', ?, ?)`)
      .run(options.jobId, options.jobStatus ?? "queued",
        JSON.stringify({ mode: "direct_sync_analysis", importBatchId: options.batchId }),
        options.completedAt, options.rawGeneration ?? null,
        options.targetDependencyGeneration ?? null);
  }
}

/** 账本行：记录时间更正（当前时刻 `effectiveAt`，更新前区间 `[previousAt, previousEndAt]`）。 */
function addMovedRecordChange(database: DatabaseSync, options: {
  batchId: string; effectiveAt: string; previousAt: string | null; previousEndAt: string | null;
}): void {
  database.prepare(`INSERT INTO import_entity_changes
    (batch_id, entity_kind, entity_id, change_type, effective_at, content_hash,
     previous_effective_at, previous_end_at, previous_type)
    VALUES (?, 'record', ?, 'updated', ?, NULL, ?, ?, ?)`)
    .run(options.batchId, `${options.batchId}_hr`, options.effectiveAt,
      options.previousAt, options.previousEndAt,
      options.previousAt === null ? null : "HKQuantityTypeIdentifierHeartRate");
}

async function withDatabase(
  run: (context: { path: string; database: DatabaseSync }) => void | Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-freshness-r4-"));
  const path = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(path, { createMigrationBackup: false });
  try {
    seedFacts(store.database);
    await run({ path, database: store.database });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 用**新连接**读（生产读路径就是另一条连接；避免同连接证据缓存的干扰）。 */
function freshness(path: string, sessionId: string = SESSION_ID) {
  const database = new DatabaseSync(path);
  try {
    return new SqliteWorkoutReadRepository(database).freshness(sessionId);
  } finally {
    database.close();
  }
}

function assertAnalysis(
  stored: ReturnType<typeof freshness>,
  expected: { status: "published" | "pending" | "failed"; available: boolean },
  label: string
): void {
  assert.ok(stored, `${label}：freshness 必须可读`);
  assert.equal(stored.analysis.status, expected.status, `${label}：analysis.status`);
  assert.equal(stored.analysis.available, expected.available, `${label}：analysis.available`);
}

// ---------------------------------------------------------------------------
// 解析器：三种出口 + fail-closed
// ---------------------------------------------------------------------------

test("R4：持久脏证据解析只有 absent/invalid/ok 三种出口，未知版本与缺键一律 invalid", () => {
  assert.deepEqual(parseBatchAnalysisDirtyEvidence(null), { status: "absent" });
  assert.deepEqual(parseBatchAnalysisDirtyEvidence(""), { status: "absent" });

  const ok = parseBatchAnalysisDirtyEvidence(partialPlan({
    dirtyFromAt: STARTED_AT, routeDirtyTimes: [STARTED_AT], recoveryBoundaries: []
  }));
  assert.equal(ok.status, "ok");
  assert.ok(ok.status === "ok");
  assert.equal(ok.evidence.dirtyFromAt, STARTED_AT);
  assert.deepEqual(ok.evidence.routeDirtyTimes, [STARTED_AT]);
  assert.deepEqual(ok.evidence.recoveryBoundaries, []);
  assert.deepEqual(ok.evidence.domains, {
    features: STARTED_AT, fitness: STARTED_AT, readiness: STARTED_AT
  });
  assert.equal(ok.evidence.full, false);

  // 未知版本：不能猜（读成"没有影响"就是漏算）。
  const unknownVersion = parseBatchAnalysisDirtyEvidence(JSON.stringify({
    ...JSON.parse(partialPlan({ dirtyFromAt: STARTED_AT })), version: 2
  }));
  assert.equal(unknownVersion.status, "invalid");

  // 形状损坏：缺 `reasons` / 缺 `routeDirtyTimes` / 缺 `domains` 键 / 非法时刻 / 非 JSON。
  assert.equal(parseBatchAnalysisDirtyEvidence(JSON.stringify({
    version: 1, full: false, dirtyFromAt: STARTED_AT,
    domains: { features: STARTED_AT, fitness: STARTED_AT, readiness: STARTED_AT },
    routeDirtyTimes: [], recoveryBoundaries: []
  })).status, "invalid", "缺 reasons 键 = 证据不完整");
  assert.equal(parseBatchAnalysisDirtyEvidence(JSON.stringify({
    version: 1, full: false, dirtyFromAt: STARTED_AT,
    domains: { features: STARTED_AT, fitness: STARTED_AT, readiness: STARTED_AT },
    recoveryBoundaries: [], reasons: []
  })).status, "invalid", "缺 routeDirtyTimes 键 = 证据不完整");
  assert.equal(parseBatchAnalysisDirtyEvidence(JSON.stringify({
    version: 1, full: false, dirtyFromAt: STARTED_AT,
    domains: { features: STARTED_AT, readiness: STARTED_AT },
    routeDirtyTimes: [], recoveryBoundaries: [], reasons: []
  })).status, "invalid", "缺 domains.fitness 键 = 证据不完整");
  assert.equal(parseBatchAnalysisDirtyEvidence(JSON.stringify({
    version: 1, full: false, dirtyFromAt: "2026-10-18T11:00:00+08:00",
    domains: { features: STARTED_AT, fitness: STARTED_AT, readiness: STARTED_AT },
    routeDirtyTimes: [], recoveryBoundaries: [], reasons: []
  })).status, "invalid", "偏移写法不是规范化时刻");
  assert.equal(parseBatchAnalysisDirtyEvidence(JSON.stringify({
    version: 1, full: false, dirtyFromAt: null,
    domains: { features: null, fitness: null, readiness: null },
    routeDirtyTimes: [], recoveryBoundaries: [], reasons: []
  })).status, "invalid", "可增量却没有边界 = 自相矛盾");

  // `full = true` 是合法形态（其余边界字段无意义）。
  const full = parseBatchAnalysisDirtyEvidence(JSON.stringify({
    version: 1, full: true, dirtyFromAt: null,
    domains: { features: null, fitness: null, readiness: null },
    routeDirtyTimes: [], recoveryBoundaries: [], reasons: ["health_boundary_unknown"]
  }));
  assert.equal(full.status, "ok");
  assert.ok(full.status === "ok");
  assert.equal(full.evidence.full, true);
  assert.equal(full.evidence.dirtyFromAt, null);
  assert.deepEqual(parseBatchAnalysisDirtyEvidence("{"), { status: "invalid", reason: "not_json" });
});

// ---------------------------------------------------------------------------
// 读仓库：路线-only、时间迁移、full/invalid/absent、不触及
// ---------------------------------------------------------------------------

test("R4：路线-only 批次（无账本行，dirty plan 指向本训练）⇒ pending，旧分析仍可读", async () => {
  await withDatabase(async ({ path, database }) => {
    publishRelease(database, 1);
    // 基线：已发布且覆盖到代次 1。
    assertAnalysis(freshness(path), { status: "published", available: true }, "基线");
    assert.equal(freshness(path, SESSION_ID_PRIOR)?.analysis.status, "published", "基线（前一晚）");

    // 新批次：依赖代次 2、queued 任务；workout XML 未变 ⇒ **没有** `import_entity_changes` 行。
    // 唯一能证明"它动过本训练"的是 v45 的持久脏证据。
    addBatch(database, {
      batchId: "batch_r4_route_only", completedAt: "2026-10-18T13:00:00.000Z",
      rawGeneration: 2, dependencyGeneration: 2, dependencyBumped: 1,
      dirtyEvidenceJson: partialPlan({
        dirtyFromAt: STARTED_AT, routeDirtyTimes: [STARTED_AT], reasons: ["route_changed"]
      }),
      jobId: "recompute_job_r4_route_only", targetDependencyGeneration: 2
    });

    const stored = freshness(path);
    assertAnalysis(stored, { status: "pending", available: true }, "路线-only");
    assert.equal(stored?.analysis.publishedAt, RELEASE_ACTIVATED_AT,
      "旧分析的发布时刻仍是可读证据");
    // 没被这条路线碰到的前一晚训练保持 published（不能把整段历史都翻成 pending）。
    assertAnalysis(freshness(path, SESSION_ID_PRIOR), { status: "published", available: true }, "前一晚");

    // 任务已结束（发布没跟上）也不能回到 published：这是 `uncovered` 分支（不是 inFlight）
    // 在读同一份脏证据 —— 两条入口必须一致，不能只有"任务在排队"时才看见路线变更。
    database.prepare("UPDATE recompute_jobs SET status = 'succeeded', completed_at = ? WHERE id = ?")
      .run("2026-10-18T13:01:00.000Z", "recompute_job_r4_route_only");
    assertAnalysis(freshness(path), { status: "pending", available: true }, "路线-only（任务已结束）");
  });
});

test("R4：记录从窗口内更正到窗口外（previous_* 仍在窗口内）⇒ pending", async () => {
  await withDatabase(async ({ path, database }) => {
    publishRelease(database, 1);
    assertAnalysis(freshness(path), { status: "published", available: true }, "基线");

    // 当前 effective_at 已移出窗口，但更新前区间 [11:50, 11:51] 落在训练内。
    // dirty plan 刻意留空：本用例只钉住**账本区间并集**这一条证据。
    addBatch(database, {
      batchId: "batch_r4_moved_out", completedAt: "2026-10-18T13:10:00.000Z",
      rawGeneration: 3, dependencyGeneration: 3, dependencyBumped: 1,
      jobId: "recompute_job_r4_moved_out", targetDependencyGeneration: 3
    });
    addMovedRecordChange(database, {
      batchId: "batch_r4_moved_out",
      effectiveAt: "2026-10-18T14:00:00.000Z",
      previousAt: "2026-10-18T11:50:00.000Z",
      previousEndAt: "2026-10-18T11:51:00.000Z"
    });

    assertAnalysis(freshness(path), { status: "pending", available: true }, "移出窗口");
  });
});

test("R4：记录从窗口外更正到窗口内（previous_* 在窗口外）⇒ pending", async () => {
  await withDatabase(async ({ path, database }) => {
    publishRelease(database, 1);
    assertAnalysis(freshness(path), { status: "published", available: true }, "基线");

    addBatch(database, {
      batchId: "batch_r4_moved_in", completedAt: "2026-10-18T13:20:00.000Z",
      rawGeneration: 4, dependencyGeneration: 4, dependencyBumped: 1,
      jobId: "recompute_job_r4_moved_in", targetDependencyGeneration: 4
    });
    addMovedRecordChange(database, {
      batchId: "batch_r4_moved_in",
      effectiveAt: "2026-10-18T11:50:00.000Z",
      previousAt: "2026-10-18T10:00:00.000Z",
      previousEndAt: "2026-10-18T10:01:00.000Z"
    });

    assertAnalysis(freshness(path), { status: "pending", available: true }, "移入窗口");
  });
});

test("R4：full=true 的脏证据不能归因到单条训练 ⇒ 同一发布下的训练全部 pending", async () => {
  await withDatabase(async ({ path, database }) => {
    publishRelease(database, 1);
    assertAnalysis(freshness(path), { status: "published", available: true }, "基线");
    assertAnalysis(freshness(path, SESSION_ID_PRIOR), { status: "published", available: true }, "基线（前一晚）");

    addBatch(database, {
      batchId: "batch_r4_full", completedAt: "2026-10-18T13:30:00.000Z",
      rawGeneration: 5, dependencyGeneration: 5, dependencyBumped: 1,
      dirtyEvidenceJson: JSON.stringify({
        version: 1, full: true, dirtyFromAt: null,
        domains: { features: null, fitness: null, readiness: null },
        routeDirtyTimes: [], recoveryBoundaries: [], reasons: ["health_boundary_unknown"]
      }),
      jobId: "recompute_job_r4_full", targetDependencyGeneration: 5
    });

    // 本训练（窗口内/外都算）：full 批次可能动过任何分析输入。
    assertAnalysis(freshness(path), { status: "pending", available: true }, "full（本训练）");
    assertAnalysis(freshness(path, SESSION_ID_PRIOR), { status: "pending", available: true }, "full（前一晚）");

    // 分域边界为 null = **该域不可增量（全算）**，不是"该域不脏"：即使顶层边界在两条
    // 训练之后，任何训练的分析输入仍可能变 ⇒ 不能报 published。
    database.prepare("UPDATE import_batches SET analysis_dirty_plan_json = ? WHERE id = ?").run(
      JSON.stringify({
        version: 1, full: false, dirtyFromAt: "2026-10-19T00:00:00.000Z",
        domains: { features: null, fitness: "2026-10-19T00:00:00.000Z", readiness: "2026-10-19T00:00:00.000Z" },
        routeDirtyTimes: [], recoveryBoundaries: [], reasons: ["invalid_health_interval"]
      }), "batch_r4_full");
    assertAnalysis(freshness(path), { status: "pending", available: true }, "domains.features = null（本训练）");
    assertAnalysis(freshness(path, SESSION_ID_PRIOR), { status: "pending", available: true },
      "domains.features = null（前一晚）");
  });
});

test("R4：损坏/未知版本的脏证据按保守处理（pending），不是 published", async () => {
  await withDatabase(async ({ path, database }) => {
    publishRelease(database, 1);
    assertAnalysis(freshness(path), { status: "published", available: true }, "基线");

    // 未知版本 + 缺键：两种损坏都必须落到保守档（"这一批动过什么"不可知）。
    addBatch(database, {
      batchId: "batch_r4_unknown_version", completedAt: "2026-10-18T13:40:00.000Z",
      rawGeneration: 6, dependencyGeneration: 6, dependencyBumped: 1,
      dirtyEvidenceJson: JSON.stringify({ version: 99, full: false }),
      jobId: "recompute_job_r4_unknown_version", targetDependencyGeneration: 6
    });
    assertAnalysis(freshness(path), { status: "pending", available: true }, "未知版本");

    // 换成一个"版本对、形状坏"的证据，同样不能读成"没有影响"。
    database.prepare("UPDATE import_batches SET analysis_dirty_plan_json = ? WHERE id = ?")
      .run(JSON.stringify({
        version: 1, full: false, dirtyFromAt: STARTED_AT,
        domains: { features: STARTED_AT, fitness: STARTED_AT, readiness: STARTED_AT },
        recoveryBoundaries: [], reasons: []
      }), "batch_r4_unknown_version");
    assertAnalysis(freshness(path), { status: "pending", available: true }, "形状损坏");
  });
});

test("R4：脏证据没碰到本训练 ⇒ 保持 published；raw-only 批次仍然排除", async () => {
  await withDatabase(async ({ path, database }) => {
    publishRelease(database, 1);
    assertAnalysis(freshness(path), { status: "published", available: true }, "基线");

    // ① 干净的部分证据：边界在训练结束之后（另一天/更晚的记录），没有路线/恢复时刻。
    addBatch(database, {
      batchId: "batch_r4_not_touching", completedAt: "2026-10-18T15:00:00.000Z",
      rawGeneration: 7, dependencyGeneration: 7, dependencyBumped: 1,
      dirtyEvidenceJson: partialPlan({ dirtyFromAt: "2026-10-18T14:30:00.000Z" }),
      jobId: "recompute_job_r4_not_touching", targetDependencyGeneration: 7
    });
    assertAnalysis(freshness(path), { status: "published", available: true },
      "脏边界在训练之后的批次不得把本训练翻成 pending");

    // ② raw-only（dependency_bumped = 0）：即使账本行落在窗口内也不参与分析新鲜度判据。
    //    ⚠️ 生产不会为它登记分析任务（`analysisRequired = false`），这里也不登记 ——
    //    否则就变成"任务在排队"的另一种证据。
    addBatch(database, {
      batchId: "batch_r4_raw_only", completedAt: "2026-10-18T15:10:00.000Z",
      rawGeneration: 8, dependencyGeneration: 7, dependencyBumped: 0
    });
    addMovedRecordChange(database, {
      batchId: "batch_r4_raw_only",
      effectiveAt: "2026-10-18T11:55:00.000Z",
      previousAt: null, previousEndAt: null
    });
    assertAnalysis(freshness(path), { status: "published", available: true },
      "raw-only 批次不推依赖代次 ⇒ 不是分析落后");
  });
});
