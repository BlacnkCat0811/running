// PR5 S3–S6 的读侧一致性判据（C1/C2/C3/C8/C9/C10），依据
// `docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md` §4 与 §5 的 S3–S6 行。
//
// 为什么这个文件存在（而不是把用例塞进 `data.test.ts`）：本批四步各有**独立**的判据与
// 突变靶子，混进那支 600 行的文件里，改坏一处只会看到"某个大文件里有一条红"。这里按判据
// 编号分组，每条测试的标题就是它钉的那个句子。
//
// 夹具复用 `data.test.ts` 导出的 `seed()`：C1/C9 比较的就是"同一个库里，新旧两个读取面
// 是否指向同一批事实"，夹具一分为二会让唯一的失败形态被夹具差异掩盖。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { AnalysisView, FactsView } from "@rai/api-contracts";
import { RaiDatabase, SqliteSeriesReadRepository, readFactReadView } from "@rai/storage-sqlite";

import { RaiReadStore } from "../src/data.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { seed } from "./data.test.js";

const identity = () => ({ serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" });

/** 分析来源字段：事实块行里出现任何一个，都说明两块又拼在一起了（C2）。 */
const ANALYSIS_SOURCE_FIELDS = [
  "currentAbility", "qualityScore", "stimulusType", "stimulusConfidence",
  "trueAbilityDelta", "assessmentStatus", "eligibilityStatus"
];

/** 当前可变事实字段：分析块行里出现任何一个，分析块就变成了事实块的第二个名字（C2）。 */
const CURRENT_FACT_FIELDS = ["indoor", "sourceCategory", "endAt", "activityType", "distanceMeters"];

interface Fixture {
  databasePath: string;
  store: RaiDatabase;
  read: RaiReadStore;
  goals: MobileGoalsStore;
  root: string;
}

async function withFixture(prefix: string, run: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const read = new RaiReadStore(databasePath);
  const goals = new MobileGoalsStore(root, join(root, "control.sqlite"));
  const fixture: Fixture = { databasePath, store, read, goals, root };
  try {
    await run(fixture);
  } finally {
    goals.close();
    read.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** 直连车道的计数器写入（`apps/api/src/direct-sync-ingest.ts` 用的同一个 UPDATE）。 */
function bumpGenerations(store: RaiDatabase, raw: number, dependency: number): void {
  store.database.prepare(`UPDATE import_generations
    SET raw_generation = raw_generation + ?, dependency_generation = dependency_generation + ?
    WHERE singleton = 1`).run(raw, dependency);
}

function bindJob(store: RaiDatabase, id: string, status: string, dependency: number, raw = dependency): void {
  store.database.prepare(`INSERT INTO recompute_jobs
    (id, job_type, status, dataset_version, request_json, progress_phase,
     target_raw_generation, target_dependency_generation)
    VALUES (?, 'import', ?, 'dataset_delta_probe', '{}', 'phase', ?, ?)`).run(id, status, raw, dependency);
}

/**
 * 去掉两个新键，供 C9 的"逐字节相同"比较用。
 *
 * 🔴 必须用 `delete` 而不是 `{ ...value, currentFacts: undefined }`：后者会让对象带一个
 * **值为 `undefined` 的自有键**，而 `assert.deepEqual` 把"有键但值为 undefined"与
 * "没有这个键"判成不相等（`Object.keys` 也不一样）。写错这一步会让 C9 永远红 ——
 * 而一条永远红的判据和没有判据一样，都会让人绕开它。
 */
function withoutNewBlocks<T extends object>(value: T): T {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.currentFacts;
  delete copy.publishedAnalysis;
  return copy as T;
}

// ---------------------------------------------------------------------------
// S3 —— C10：绑定列可读，12 个旧字段逐个不变
// ---------------------------------------------------------------------------

test("C10：/v1/jobs DTO 在绑定非空的任务上读出三个绑定列，老任务仍是缺键（undefined）", async () => {
  await withFixture("rai-pr5-c10-", ({ store, read }) => {
    // ① 老任务：夹具的 `enqueueFullRecompute` **不带**绑定 ⇒ 三列 NULL。
    const legacy = store.database.prepare(
      "SELECT id FROM recompute_jobs ORDER BY created_at, rowid LIMIT 1"
    ).get() as { id: string };
    const legacyDto = read.job(legacy.id);
    assert.ok(legacyDto, "前置：夹具必须留下一条可读的老任务");
    // 🔴 `undefined` 而不是 `null`：老任务"没有绑定"与"绑定到空值"是两件事（清单 18）。
    assert.equal(legacyDto.targetDependencyGeneration, undefined);
    assert.equal(legacyDto.targetRawGeneration, undefined);
    assert.equal(legacyDto.expectedIncumbentReleaseId, undefined);
    assert.equal("targetDependencyGeneration" in legacyDto, false,
      "没有绑定的任务不该有这个键 —— 补成 null 会让「老任务」与「绑定到空值」再也分不开");

    // ② 新任务：带上三个绑定列。
    store.database.prepare(`INSERT INTO recompute_jobs
      (id, job_type, status, dataset_version, request_json, progress_phase,
       target_raw_generation, target_dependency_generation, expected_incumbent_release_id)
      VALUES ('job-bound', 'import', 'queued', 'dataset_delta_probe', '{}', 'queued', 7, 3, 'release_incumbent')`).run();
    const bound = read.job("job-bound");
    assert.ok(bound, "前置：带绑定的任务必须读得出来");
    assert.equal(bound.targetRawGeneration, 7);
    assert.equal(bound.targetDependencyGeneration, 3);
    assert.equal(bound.expectedIncumbentReleaseId, "release_incumbent");

    // ③ 12 个旧字段逐个不变（C10 的后半句）。刻意用**字面量**而不是 `deepEqual`：
    //    多一个/少一个旧字段必须报错，而不是被"对象结构相同"吞掉。
    const dto = bound as unknown as Record<string, unknown>;
    assert.equal(dto.id, "job-bound");
    assert.equal(dto.jobType, "import");
    assert.equal(dto.status, "queued");
    assert.equal(dto.progressPhase, "queued");
    assert.equal(dto.progressCurrent, 0);
    assert.equal(dto.progressTotal, 0);
    assert.equal(dto.cancelRequested, false);
    assert.equal(dto.modelRunId, null);
    assert.equal(dto.error, null);
    assert.equal(typeof dto.createdAt, "string");
    assert.equal(dto.startedAt, null);
    assert.equal(dto.completedAt, null);
    assert.ok(Array.isArray(dto.events), "`/v1/jobs/:id` 的 events 是既有形态，不是第 13 个旧字段");

    // ④ 列表与单项同源。
    assert.equal(read.jobs(30).find((job) => job.id === "job-bound")?.targetDependencyGeneration, 3);
    assert.equal(read.jobs(30).find((job) => job.id === legacy.id)?.targetDependencyGeneration, undefined);
  });
});

// ---------------------------------------------------------------------------
// S3 —— generations_absent 回退分支（D2 的过渡期口径）
// ---------------------------------------------------------------------------

test("S3：计数器为 (0,0) ⇒ reason === generations_absent（实测依据：夹具只跑过普通重算）", async () => {
  await withFixture("rai-pr5-generations-absent-", ({ store, read, goals }) => {
    const untouched = store.database.prepare(
      "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton = 1"
    ).get() as { raw: number; dependency: number };
    assert.deepEqual({ ...untouched }, { raw: 0, dependency: 0 },
      "前置（2026-10-13 实测）：只跑普通重算路径的库里计数器仍是 (0,0)，而训练事实已经在库里");

    const state = read.trainingPlanState(goals, identity);
    const metadata = state.metadata as unknown as Record<string, unknown>;
    const reportedVersions = metadata.versions as Record<string, unknown>;
    assert.equal(reportedVersions.facts, null,
      "计数器不可用时版本号必须是 null（不是 \"0\"：那会被读成「版本 0」）");
    assert.equal(reportedVersions.analysis, null);
    assert.equal(reportedVersions.analysisStatus, "published");
    assert.equal((metadata.freshness as { stale: boolean }).stale, true,
      "generations_absent 也算 stale（D2 原文）");
    assert.equal((metadata.freshness as { reason: string }).reason, "generations_absent",
      "必须显式报出这个 reason —— 消费方靠它区分「沿用今天的行为」与「真的落后了」");
    const freshnessVersions = (metadata.freshness as { versions: Record<string, unknown> }).versions;
    assert.equal(freshnessVersions.facts, null);
    assert.equal(freshnessVersions.analysis, null);
    assert.equal(freshnessVersions.analysisStatus, "published");
    // 🔴 `releaseId` 来自 `active_model_run`，与计数器**无关**：夹具跑过一次成功的重算，
    // 所以它是真的（这条同时证明"回退不是把所有东西都置空"）。
    const activeRelease = store.database.prepare(
      "SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1"
    ).get() as { id: string } | undefined;
    assert.equal(freshnessVersions.releaseId, activeRelease?.id ?? null,
      "releaseId 必须与 `active_model_run` 逐字节相同 —— 它不参与 generations_absent 回退");
    assert.equal(state.availability === "ready" || state.availability === "empty", true,
      "回退分支不得把端点打挂（D2：该状态下沿用今天的行为）");
  });
});

test("S3：直连车道写过一个批次之后 versions 报数字，且版本相等≠up_to_date", async () => {
  await withFixture("rai-pr5-generations-present-", ({ store }) => {
    bumpGenerations(store, 1, 1);
    const view = readFactReadView(store.database, { factRows: 50, analysisRows: 50 });
    assert.equal(view.versions.facts, "1");
    assert.equal(view.versions.analysis, "1");
    // analysis === facts，但绑定到代次 1 的分析任务**不存在** ⇒ `analysis_missing`。
    // 这条钉住"版本相等不等于 up_to_date"：freshness 还要看分析状态。
    assert.equal(view.freshness.reason, "analysis_missing");
    assert.equal(view.freshness.stale, true);
    assert.equal(view.versions.analysisStatus, "not_required");
  });
});

test("S3：dependency 落后于 raw ⇒ analysis_behind（C4 的输入前提）", async () => {
  await withFixture("rai-pr5-generations-behind-", ({ store }) => {
    // 直连车道里"本批不影响分析"的情形：raw +1、dependency 不动。
    bumpGenerations(store, 1, 0);
    bumpGenerations(store, 1, 0);
    const view = readFactReadView(store.database, { factRows: 50, analysisRows: 50 });
    assert.equal(view.versions.facts, "2");
    assert.equal(view.versions.analysis, "0");
    assert.equal(view.freshness.reason, "analysis_behind");
    assert.equal(view.freshness.stale, true);
  });
});

test("S3：绑定任务 succeeded ⇒ published；failed ⇒ analysis_failed", async () => {
  await withFixture("rai-pr5-generations-status-", ({ store }) => {
    bumpGenerations(store, 1, 1);
    bindJob(store, "job-failed", "failed", 1);
    const failed = readFactReadView(store.database, { factRows: 50, analysisRows: 50 });
    assert.equal(failed.freshness.reason, "analysis_failed");
    assert.equal(failed.versions.analysisStatus, "failed");
    assert.equal(failed.freshness.stale, true);

    store.database.prepare("UPDATE recompute_jobs SET status = 'succeeded' WHERE id = 'job-failed'").run();
    const published = readFactReadView(store.database, { factRows: 50, analysisRows: 50 });
    assert.equal(published.versions.analysisStatus, "published");
    assert.equal(published.freshness.reason, "up_to_date");
    assert.equal(published.freshness.stale, false);
  });
});

test("S3：取**最新**那个绑定到当前依赖代次的任务，而不是最早那次成功", async () => {
  await withFixture("rai-pr5-generations-latest-job-", ({ store }) => {
    bumpGenerations(store, 1, 1);
    bumpGenerations(store, 1, 1);
    bindJob(store, "job-1", "succeeded", 1);
    bindJob(store, "job-2", "queued", 2);
    const view = readFactReadView(store.database, { factRows: 50, analysisRows: 50 });
    assert.equal(view.versions.analysis, "2");
    assert.equal(view.versions.analysisStatus, "queued",
      "取最早那次成功会把「还在算」说成「已发布」");
    assert.equal(view.freshness.reason, "analysis_missing");
    assert.equal(view.freshness.stale, true);
  });
});

// ---------------------------------------------------------------------------
// S4 —— C2：事实块的**键集**不含任何分析来源字段
// ---------------------------------------------------------------------------

test("C2：两块行类型的键集互不相交，且各自不含对方的字段族", async () => {
  await withFixture("rai-pr5-c2-", ({ store }) => {
    const view = readFactReadView(store.database, { factRows: 50, analysisRows: 50 });
    assert.ok(view.facts.rows.length > 0, "前置：夹具必须有事实行");
    assert.ok(view.analysis.rows.length > 0, "前置：夹具必须分析行（seed 跑过重算）");

    const factsKeys = new Set(view.facts.rows.flatMap((row) => Object.keys(row)));
    const analysisKeys = new Set(view.analysis.rows.flatMap((row) => Object.keys(row)));

    for (const field of ANALYSIS_SOURCE_FIELDS) {
      assert.equal(factsKeys.has(field), false,
        `事实块行里出现了分析来源字段 ${field} —— 那正是 §9.1「两个版本拼在一起」的形态`);
    }
    for (const field of CURRENT_FACT_FIELDS) {
      assert.equal(analysisKeys.has(field), false,
        `分析块行里出现了当前可变事实字段 ${field} —— 分析块必须是「当时的输入 + 当时的结论」`);
    }
    // 🔴 键集断言而不是值断言（C2 原文）：值断言会被"这一行恰好没有值"骗过。
    assert.deepEqual([...factsKeys].sort(), [
      "activityType", "analysisState", "distanceMeters", "durationSeconds",
      "endAt", "indoor", "sourceCategory", "startAt", "workoutId"
    ]);
    assert.deepEqual([...analysisKeys].sort(), [
      "analyzedWorkoutId", "currentAbility", "factDeleted", "frozenDistanceKm",
      "frozenDurationSeconds", "frozenStartedAt", "qualityScore", "releaseId", "stimulusType"
    ]);
    // 交集为空（D1.3 的硬约束，与 `FactsAnalysisBlocksDisjoint` 的类型级断言同一条）：
    // 两块若允许重叠，`currentFacts`/`publishedAnalysis` 就只是同一堆字段的两个名字 ——
    // 而这正是 §9.1 点名要消灭的形态。**连 `workoutId` 都不许共享**，所以两边的标识符
    // 是刻意分开命名的候选；这里断言交集真的是空集。
    const intersection = [...factsKeys].filter((key) => analysisKeys.has(key));
    assert.deepEqual(intersection, [],
      "两块行类型的字段交集必须为空 —— 任何共享键都说明有一侧越界了");
  });
});

test("C2：未分析的事实在事实块里是 analysisState=pending，并计入 pendingAnalysisCount", async () => {
  await withFixture("rai-pr5-c2-pending-", ({ store }) => {
    const before = readFactReadView(store.database, { factRows: 50, analysisRows: 50 });
    assert.equal(before.facts.pendingAnalysisCount, 0, "前置：夹具里每条事实都有评估");
    assert.equal(before.facts.rows.every((row) => row.analysisState === "analyzed"), true);

    // 造一条"有事实、没有被当前 release 覆盖"的训练。🔴 刻意**先删后建**而不是直接改
    // `model_run_id`：`ability_assessments` 对 `model_runs` 有外键，改成一个不存在的
    // release 会撞 FOREIGN KEY（实测），而"伪造一个 release"会让夹具不再反映真实形态。
    // 用一个**临时训练**（`api_workout_0` 的事实 + 一条一次性评估）走完整条路径：
    // 先证明它有结论（analyzed），再把评估删掉 ⇒ 同一条事实变成 pending。
    store.database.prepare(`INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
      VALUES ('c2_session', 'HKWorkoutActivityTypeRunning', '2025-02-01T00:00:00.000Z',
        '2025-02-01T00:30:00.000Z', 5, 'api_workout_0', 'active')`).run();
    const modelRunId = (store.database.prepare(
      "SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1"
    ).get() as { id: string }).id;
    const featureId = (store.database.prepare(
      "SELECT feature_id AS id FROM ability_assessments WHERE training_session_id = 'api_session_0' LIMIT 1"
    ).get() as { id: string }).id;
    store.database.prepare(`INSERT INTO ability_assessments
      (id, model_run_id, feature_id, training_session_id, sequence_number, assessment_status,
       current_ability, effective_weights_json, confidence, confidence_factors_json,
       updated_true_ability, explanation_codes_json, explanation_json, assessed_at)
      VALUES ('c2_assessment', ?, ?, 'c2_session', 999, 'eligible', 50, '{}', 1, '{}', 1, '[]', '{}', ?)`)
      .run(modelRunId, featureId, "2025-02-01T00:00:00.000Z");

    const withConclusion = readFactReadView(store.database, { factRows: 50, analysisRows: 50 });
    assert.equal(withConclusion.facts.rows.find((row) => row.workoutId === "c2_session")?.analysisState,
      "analyzed", "前置：有评估的事实在事实块里是 analyzed");
    assert.equal(withConclusion.facts.pendingAnalysisCount, 0);

    store.database.prepare("DELETE FROM ability_assessments WHERE id = 'c2_assessment'").run();
    const after = readFactReadView(store.database, { factRows: 50, analysisRows: 50 });
    assert.equal(after.facts.pendingAnalysisCount, 1);
    assert.equal(after.facts.rows.filter((row) => row.analysisState === "pending").length, 1);
    assert.equal(after.facts.rows.find((row) => row.analysisState === "pending")?.workoutId, "c2_session");
    // 事实行**仍然在**（这正是"有事实但未被覆盖"的定义）：只换了状态，没有换集合。
    assert.equal(after.facts.rows.length, withConclusion.facts.rows.length);
  });
});

// ---------------------------------------------------------------------------
// S4 —— C1：两块与旧字段来自**同一个**读快照
// ---------------------------------------------------------------------------

test("C1：两块由同一次 BEGIN DEFERRED 读齐 —— 读事务内跨过一次事实提交仍读到同一个版本", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-pr5-c1-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const second = new DatabaseSync(databasePath);
  try {
    let versionsInside: { facts: string | null; analysis: string | null; rawInside: number } | null = null;
    let freshAfterCommit: number | null = null;
    let factsRowsInside = 0;
    const view = readFactReadView(store.database, { factRows: 50, analysisRows: 50 }, ({ database, versions, facts, analysis }) => {
      const rawInside = (database.prepare(
        "SELECT raw_generation AS raw FROM import_generations WHERE singleton = 1"
      ).get() as { raw: number }).raw;
      // 从**事务内**直接读原始列：`versions.facts` 在 generations_absent 时是 `null`，
      // 看不见"快照到底停在哪一版"，所以这里读 0/1 的那个整数。
      versionsInside = { facts: versions.facts, analysis: versions.analysis, rawInside };
      factsRowsInside = facts.rows.length;
      // 🔴 这里就是 C1 的正题：**读事务进行中**，另一个连接提交一次事实提交。
      // 若两块不是在同一次读里取的，这个提交会被某一块看到、被另一块看不到 ——
      // 那正是"两个版本拼在一起"。`BEGIN DEFERRED` 让本次事务的后续读继续落在
      // 同一个 WAL 快照上（SQLite 的 deferred 事务在第一次读时取快照）。
      second.prepare("UPDATE import_generations SET raw_generation = raw_generation + 1 WHERE singleton = 1").run();
      freshAfterCommit = Number((database.prepare(
        "SELECT raw_generation AS raw FROM import_generations WHERE singleton = 1"
      ).get() as { raw: number }).raw);
      // 两块在回调里读到的行数必须与返回的 view 完全一致（同一次读的两个出口）。
      assert.equal(facts.rows.length, analysis.rows.length);
    });
    const afterCommit = Number((second.prepare(
      "SELECT raw_generation AS raw FROM import_generations WHERE singleton = 1"
    ).get() as { raw: number }).raw);

    assert.deepEqual(versionsInside, { facts: null, analysis: null, rawInside: 0 },
      "读事务内的版本必须还是提交前的那一份 —— 变成 1 说明这个读**不在**事务里，" +
      "两块就可能来自不同快照（C1 的突变靶子：去掉 BEGIN DEFERRED）");
    assert.equal(freshAfterCommit, 0, "同一次事务内的第二次读也必须落在同一个快照上");    assert.equal(afterCommit, 1, "另一条连接确实提交了 —— 否则这条判据什么都没证明");
    assert.equal(view.facts.factVersion, null, "计数器为 0 ⇒ generations_absent 分支，版本号是 null");
    assert.equal(view.analysis.stale, true);
    assert.equal(factsRowsInside, view.facts.rows.length);
  } finally {
    second.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C1（正面控制）：两条连接**确实**能看到两个版本 —— 证明 BEGIN DEFERRED 不是形式主义", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-pr5-c1-negative-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  const second = new DatabaseSync(databasePath);
  try {
    const first = store.database.prepare(
      "SELECT raw_generation AS raw FROM import_generations WHERE singleton = 1"
    ).get() as { raw: number };
    second.prepare("UPDATE import_generations SET raw_generation = raw_generation + 1 WHERE singleton = 1").run();
    const after = store.database.prepare(
      "SELECT raw_generation AS raw FROM import_generations WHERE singleton = 1"
    ).get() as { raw: number };
    assert.equal(after.raw, first.raw + 1,
      "两条独立连接的读之间可以插入提交 ⇒ 一个读事务的价值正在于挡住这个形态");
  } finally {
    second.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// S4 —— C9：旧字段语义未变
// ---------------------------------------------------------------------------

test("C9：/v1/workouts 追加两块后，除两个新键之外的响应与旧路径逐字节相同", async () => {
  await withFixture("rai-pr5-c9-workouts-", ({ read }) => {
    const query = { limit: 50, offset: 0 } as const;
    const legacy = read.workouts(query);
    const withViews = read.workoutsWithViews(query);
    assert.deepEqual(withoutNewBlocks(withViews), legacy,
      "新块之外的取值必须逐字节相同（`...base` 是唯一允许的改动方式）");
    assert.equal(JSON.stringify(legacy), JSON.stringify(read.workouts(query)),
      "旧路径本身必须仍然可复现");
    const facts = withViews.currentFacts as FactsView | null;
    const analysis = withViews.publishedAnalysis as AnalysisView | null;
    assert.ok(facts && facts.rows.length > 0, "currentFacts 必须真的带行，而不是空对象占位");
    assert.ok(analysis && analysis.rows.length > 0, "publishedAnalysis 必须真的带行");
  });
});

test("C9：/v1/mobile/today 追加两块后，除两个新键之外的取值与旧路径逐字节相同", async (context) => {
  // 时钟钉住：`generatedAt` / `recommendation` 里带 `new Date()`，两次调用跨过一次
  // 毫秒边界就会让这条判据假红。判据要比较的是"旧字段有没有被改动"，不是"两次调用
  // 是否在同一毫秒"——用假时钟把后者从变量里去掉。
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-09T04:00:00Z") });
  await withFixture("rai-pr5-c9-today-", ({ read, goals }) => {
    const legacy = read.mobileToday(goals.read(), goals.planHistory(200));
    const withViews = read.mobileTodayWithViews(goals.read(), goals.planHistory(200));
    assert.deepEqual(withoutNewBlocks(withViews), legacy,
      "`today` / `week` / `weekDaily` / `planActual` 这些事实侧数字一个字节都不许变");
    assert.ok((withViews.currentFacts as FactsView | null)?.rows.length);
  });
});

test("C9：training-plan-state 的 metadata 只**新增**两个键，旧 12 键与 coherenceToken 不变", async () => {
  await withFixture("rai-pr5-c9-plan-state-", ({ read, goals }) => {
    const state = read.trainingPlanState(goals, identity);
    const metadata = state.metadata as unknown as Record<string, unknown>;
    for (const key of ["contractVersion", "serverId", "athleteId", "datasetEpoch", "goalsRevision",
      "coherenceToken", "timezone", "localDate", "windowStart", "windowEnd", "ruleVersion",
      "publicationDigest"]) {
      assert.notEqual(metadata[key], undefined, `旧 metadata 键 ${key} 不得消失`);
    }
    assert.equal(metadata.contractVersion, 1);
    assert.equal(typeof metadata.coherenceToken, "string");
    assert.ok(metadata.versions, "新键必须真的在（否则客户端读不到新鲜度）");
    assert.ok(metadata.freshness);

    // 🔴 `coherenceToken` 是 `digest({...})` 的产物，所以"新键没有进那份输入"这件事
    // 只能在**源码级**钉住：把 `versions`/`freshness` 写进 metadata 的**字面量**
    // 会改变 digest 输入 ⇒ 同一个库、同一天算出的 token 会变 ⇒ 所有已保存的 lock 立刻失效。
    // 这是 C9（"旧字段语义一个字节都不许变"）在计划状态端点上的具体形态。
    const source = readFileSync(join(import.meta.dirname, "../src/data.ts"), "utf8");
    const literal = /metadata:\s*\{\s*contractVersion: 1[\s\S]*?\}/.exec(source);
    assert.ok(literal, "找不到 metadata 字面量 —— 本判据的扫描面本身失效了，必须修判据而不是放过");
    assert.equal(/versions|freshness/.test(literal[0]), false,
      "`versions`/`freshness` 不得写进 metadata 的字面量：它们必须在 `coherenceToken` 算完之后追加");
    assert.match(source, /result\.metadata = \{ \.\.\.result\.metadata, versions: planView\.versions, freshness: planView\.freshness \}/,
      "追加必须发生在 token 计算之后（这一行就是那个位置）");
  });
});

// ---------------------------------------------------------------------------
// S5 —— C8：分析块路线走版本表 + 老库退化分支
// ---------------------------------------------------------------------------

test("C8：分析块路线点 == route_version_points（按 sequence），事实块走当前 route_points", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-pr5-c8-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await seed(databasePath);
  try {
    const series = new SqliteSeriesReadRepository(store.database);
    const start = "2025-01-01T00:00:00.000Z";
    store.insertWorkout({
      id: "api_workout_route", activityType: "HKWorkoutActivityTypeRunning", sourceName: "Watch",
      sourceVersion: "1", device: null, startAt: start, endAt: "2025-01-01T00:30:00.000Z",
      createdAt: null, durationSeconds: 1800, indoor: false, metadata: {}, statistics: [], events: [],
      routes: [{
        id: "api_route_0", sourceName: "Watch", sourceVersion: "1", startAt: start,
        endAt: "2025-01-01T00:30:00.000Z", createdAt: null, relativePath: null, metadata: {}
      }]
    }, "apple_watch", {});
    // 当前轨迹（事实侧）与分析侧刻意**不同**：不这样，"分析块读了哪张表"不可观测。
    store.replaceRoutePoints("api_route_0", [0, 1, 2].map((sequence) => ({
      sequence, latitude: 31 + sequence / 10, longitude: 121.1, elevationMeters: 5,
      speedMetersPerSecond: 2.5, courseDegrees: null, horizontalAccuracyMeters: 4,
      verticalAccuracyMeters: null, timestamp: start
    })));
    const staging = store.beginRouteVersion("api_route_0");
    store.appendRouteVersionPoints(staging, [0, 1, 2].map((sequence) => ({
      sequence, latitude: 40 + sequence / 10, longitude: 130.3, elevationMeters: 9,
      speedMetersPerSecond: 3.1, courseDegrees: null, horizontalAccuracyMeters: 4,
      verticalAccuracyMeters: null, timestamp: start
    })));
    store.publishRouteVersion(staging, "c8-content-hash", 3);
    const publishedId = (store.database.prepare(
      "SELECT published_route_version_id AS id FROM workout_routes WHERE id = 'api_route_0'"
    ).get() as { id: string }).id;
    assert.ok(publishedId, "前置：必须有一条已发布版本");

    // 🔴 发布之后**改掉当前轨迹**：`publishRouteVersion` 会把版本内容双写进 `route_points`
    //（那正是"真双写"，见 `database.ts` 的同名注释），所以不改的话两张表内容相同，
    // "分析块到底读了哪张表"就**不可观测** —— C8 也就没有牙。
    // 这个形态也是真实的：新一批路线数据已经落进当前表，但还没发布成新版本。
    store.replaceRoutePoints("api_route_0", [0, 1, 2].map((sequence) => ({
      sequence, latitude: 31 + sequence / 10, longitude: 121.1, elevationMeters: 5,
      speedMetersPerSecond: 2.5, courseDegrees: null, horizontalAccuracyMeters: 4,
      verticalAccuracyMeters: null, timestamp: start
    })));

    const analysis = series.routePointsByVersion(publishedId);
    assert.ok(analysis, "版本状态为 complete 且有点，必须读得到");
    assert.deepEqual(analysis.map((point) => point.latitude), [40, 40.1, 40.2],
      "分析块必须读**版本表**的点（并按 sequence 排序），而不是当前 route_points");
    assert.deepEqual(series.routePoints("api_workout_route").map((point) => point.latitude), [31, 31.1, 31.2],
      "事实块必须继续读当前 route_points（D5：两块走两张表）");

    // 老库退化分支：指针 NULL ⇒ 调用方退化读当前轨迹并标 routeVersionId: null。
    store.database.prepare("UPDATE workout_routes SET published_route_version_id = NULL WHERE id = 'api_route_0'").run();
    const pointer = store.database.prepare(
      "SELECT published_route_version_id AS id FROM workout_routes WHERE id = 'api_route_0'"
    ).get() as { id: string | null };
    assert.equal(pointer.id, null, "前置：模拟老库（v35 之前发布的路线）");
    assert.equal(series.routePointsByVersion("does-not-exist"), null,
      "不存在的版本必须返回 null（不回落、不猜）");

    // 非 `complete` 的版本同样必须拒绝 —— 否则"正在写的暂存槽"会被当成已发布内容。
    const pending = store.beginRouteVersion("api_route_0");
    assert.equal(series.routePointsByVersion(pending), null,
      "status='pending' 的版本不得被读（`beginRouteVersion` 会先清空它的点）");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C8：退化必须可观测 —— 详情端点的分析块带 routeVersionId，事实块恒为 null", async () => {
  await withFixture("rai-pr5-c8-endpoint-", ({ read, store }) => {
    // 夹具的 8 条训练**没有**路线（`data.test.ts` 的 seed 不写 `workout_routes`）
    // ⇒ 详情端点的两块都只能是"没有轨迹"。前置断言把这一点钉住，否则下面的
    // "退化"判据会因为"根本没有路线"而假绿。
    const detail = read.workout("api_session_0");
    assert.ok(detail, "前置：夹具的第一条训练必须读得出来");
    assert.equal(detail.facts?.routeVersionId, null, "事实块没有版本概念（它读当前 route_points）");
    assert.deepEqual(detail.facts?.route, []);
    assert.equal(detail.analysis?.routeVersionId, null);

    // 造一条**带路线但指针为 NULL**的训练（老库形态；`insertWorkout` 走的是
    // `workout_routes` 而不发布版本）。它必须落在 `active_ability_assessments` 覆盖的
    // 会话上，否则详情行本身读不出来（`getDetailRow` 会返回 null）。
    const start = "2025-01-01T00:00:00.000Z";
    store.database.prepare(`INSERT INTO workout_routes
      (id, workout_id, source_name, source_category, relative_path, metadata_json, point_count, file_status)
      VALUES ('route-degraded', 'api_workout_0', 'Fixture', 'apple_watch', null, '{}', 2, 'imported')`).run();
    store.database.prepare(`INSERT INTO route_points
      (route_id, sequence, timestamp, latitude, longitude, elevation_meters, speed_mps)
      VALUES ('route-degraded', 0, ?, 31.0, 121.1, 5, 2.5), ('route-degraded', 1, ?, 31.1, 121.1, 6, 2.5)`)
      .run(start, start);
    // 🔴 `RaiDatabase` 会把写攒进一个**惰性打开的事务**里（`begin()` 不立刻提交），
    // 所以直连 `database.prepare(...).run()` 的写对**另一个连接**（`RaiReadStore` 用的是
    // 只读连接）在 `flush()` 之前不可见。不 flush 的话下面的断言看到的是删除前的库，
    // 而它会以"退化分支没生效"的面目失败 —— 一个把夹具问题伪装成实现问题的坑。
    store.flush();

    const degraded = read.workout("api_session_0");
    assert.ok(degraded, "前置：加了路线之后详情仍然读得出来");
    assert.equal(degraded.analysis?.routeVersionId, null,
      "老库指针 NULL ⇒ 必须标 routeVersionId: null，**不许**假装它有版本");
    assert.equal(degraded.analysis?.stale, true, "退化读必须标 stale：它读的不是「那次发布的输入」");
    assert.deepEqual(degraded.analysis?.route, degraded.facts?.route,
      "退化时两块读同一张当前轨迹表 —— 这正是需要被标注出来的状态");
    assert.equal(degraded.facts?.routeVersionId, null);

    // 真发布一个版本、并让当前轨迹与版本内容**分叉** ⇒ 分析块必须换到版本内容上。
    const staging = store.beginRouteVersion("route-degraded");
    store.appendRouteVersionPoints(staging, [0, 1].map((sequence) => ({
      sequence, latitude: 40 + sequence / 10, longitude: 130.3, elevationMeters: 9,
      speedMetersPerSecond: 3.1, courseDegrees: null, horizontalAccuracyMeters: 4,
      verticalAccuracyMeters: null, timestamp: start
    })));
    store.publishRouteVersion(staging, "c8-endpoint-hash", 2);
    // 发布把版本内容双写进 `route_points`；再改回来，让两张表分叉（见 C8 上一条的注释）。
    store.replaceRoutePoints("route-degraded", [0, 1].map((sequence) => ({
      sequence, latitude: 31 + sequence / 10, longitude: 121.1, elevationMeters: 5,
      speedMetersPerSecond: 2.5, courseDegrees: null, horizontalAccuracyMeters: 4,
      verticalAccuracyMeters: null, timestamp: start
    })));
    store.flush();

    const versioned = read.workout("api_session_0");
    assert.equal(versioned?.analysis?.routeVersionId === null, false,
      "有已发布指针时必须真的读版本表并报出 routeVersionId");
    assert.deepEqual(versioned?.analysis?.route.map((point) => point.latitude), [40, 40.1],
      "分析块的轨迹必须是**版本内容**，而不是当前 route_points");
    assert.deepEqual(versioned?.facts?.route.map((point) => point.latitude), [31, 31.1],
      "事实块的轨迹必须是**当前** route_points");
  });
});

// ---------------------------------------------------------------------------
// S6 —— C3 在四个端点分别转绿（同源判据）
// ---------------------------------------------------------------------------

test("C3：已删事实在今日/月统计/十二周趋势上都不出现，数字恰好少掉那一条", async (context) => {
  // 时钟钉在受控事实的那一天：`mobileToday()` 的 "today" 是**墙上时钟**算出来的本地日期，
  // 而受控事实必须有确定的日期，否则"今日次数"这条断言要么看不到它、要么在别的日子红了。
  context.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-05T04:00:00Z") });
  await withFixture("rai-pr5-c3-four-endpoints-", ({ store, read, goals }) => {
    // 🔴 为什么先把夹具的负荷行清掉、只留**一条受控事实**：`mobileStatistics()` 的
    // `totals` / `months` 与 `mobileTrends()` 的周窗口**都以 `MAX(local_date)` 为锚点**，
    // 而锚点会被新增的事实推前 —— 那样两边的窗口根本不是同一个，"恰好少 5 km"这条
    // 逐位相等的判据就变成在比较两个不同的窗口（实测：会给出 -7 这种看起来像缺陷的数）。
    // 清成单条之后，锚点 = 这条事实的日期，四个端点的窗口都稳定，减法才是同源比较。
    store.database.prepare("DELETE FROM workout_training_loads WHERE training_session_id <> 'api_session_0'").run();
    const start = "2026-10-05T00:00:00.000Z";

    // 用**生产写入路径**造事实（`insertWorkout` + 带 `HKMetadataKeySyncIdentifier`），
    // 这样删除也能走**生产删除路径**（`removeWorkoutsBySyncIdentifiers`，manifest 显式删除）。
    store.insertWorkout({
      id: "c3_workout", activityType: "HKWorkoutActivityTypeRunning", sourceName: "Watch",
      sourceVersion: "1", device: null, startAt: start, endAt: "2026-10-05T00:30:00.000Z",
      createdAt: null, durationSeconds: 1800, indoor: false,
      metadata: { HKMetadataKeySyncIdentifier: ["c3-sync"] }, statistics: [], events: [], routes: []
    }, "apple_watch", {});
    store.database.prepare(`INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
      VALUES ('c3_session', 'HKWorkoutActivityTypeRunning', ?, ?, 5, 'c3_workout', 'active')`)
      .run(start, "2026-10-05T00:30:00.000Z");
    // 负荷行不能手写：`workout_training_loads` 有 20+ 个 NOT NULL 列，且
    // `active_workout_training_loads` 还要求 `training_metric_runs.status = 'succeeded'`
    // 且该 metric run 就是 `active_model_run`。所以**复制**夹具里一条真实负荷行再改键 ——
    // 手写一份会造出一条"看起来在库里、但对任何读路径都不可见"的行，判据就会假绿。
    store.database.prepare(`INSERT INTO workout_training_loads
      SELECT 'c3_load', training_metric_run_id, 'c3_session', feature_id, '2026-10-05',
        timezone_identifier, 5, 1800, 50, intensity, load_source, confidence,
        heart_rate_coverage, average_heart_rate_bpm, elevation_gain_meters, rpe, 'easy',
        explanation_codes_json, provenance_json, computed_at, zone_profile_id, stimulus_type,
        raw_hrr_trimp, internal_load, pace_load, distance_reference_meters,
        distance_exposure_ratio, distance_factor, heart_rate_load_confidence, pace_load_confidence
      FROM workout_training_loads WHERE training_session_id = 'api_session_0' LIMIT 1`).run();
    // 现在把夹具那条"模板行"本身去掉：夹具的 8 条事实里只留这一条受控事实，
    // 否则锚点与窗口里混着别的事实，"恰好少 5 km"就失去意义。
    store.database.prepare("DELETE FROM workout_training_loads WHERE id <> 'c3_load'").run();
    // 再给这条事实一条**评估行**：没有它，`/v1/workouts` 本来就不会列出这条事实，
    // "事实侧列表排除已删"这条断言就会因为"本来就没列"而假绿。
    // `sequence_number` 必须避开夹具已用的 (model_run, sequence) 唯一键，所以取一个高位序号。
    const modelRunId = (store.database.prepare(
      "SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1"
    ).get() as { id: string }).id;
    const featureId = (store.database.prepare(
      "SELECT feature_id AS id FROM ability_assessments WHERE training_session_id = 'api_session_0' LIMIT 1"
    ).get() as { id: string }).id;
    store.database.prepare(`INSERT INTO ability_assessments
      (id, model_run_id, feature_id, training_session_id, sequence_number, assessment_status,
       current_ability, effective_weights_json, confidence, confidence_factors_json,
       updated_true_ability, explanation_codes_json, explanation_json, assessed_at)
      VALUES ('c3_assessment', ?, ?, 'c3_session', 1000, 'eligible', 50, '{}', 1, '{}', 1, '[]', '{}', ?)`)
      .run(modelRunId, featureId, start);
    store.flush();
    assert.equal(Number((store.database.prepare(
      "SELECT COUNT(*) AS n FROM active_workout_training_loads"
    ).get() as { n: number }).n), 1, "前置：受控夹具里只应有一条可见的负荷行");

    const before = {
      today: read.mobileToday(goals.read(), goals.planHistory(200)),
      statistics: read.mobileStatistics(),
      trends: read.mobileTrends(),
      planState: read.trainingPlanState(goals, identity)
    };
    assert.equal(before.statistics.totals.workoutCount, 1, "前置：窗口里恰好只有这一条受控事实");
    assert.equal(before.statistics.totals.distanceKm, 5);
    assert.equal(before.today.today.workoutCount, 1);

    // 走**生产写路径**删除：它同时写 tombstone 与账目（软删标记只是其中一部分）。
    const removed = store.removeWorkoutsBySyncIdentifiers(["c3-sync"]);
    store.flush();
    assert.deepEqual(removed, [start], "前置：生产删除必须命中这条对账事实");
    assert.equal((store.database.prepare(
      "SELECT deleted_at AS at FROM workouts WHERE id = 'c3_workout'"
    ).get() as { at: string | null }).at !== null, true, "前置：删除必须落成 deleted_at 标记，而不是物理删");

    const after = {
      today: read.mobileToday(goals.read(), goals.planHistory(200)),
      statistics: read.mobileStatistics(),
      trends: read.mobileTrends(),
      planState: read.trainingPlanState(goals, identity)
    };

    // ① 事实侧列表：这条已删事实不得再出现（它的评估行刻意一起造了，否则列表本来就不列它）。
    assert.equal(read.workouts({ limit: 50, offset: 0 }).items.some((item) => item.id === "c3_session"), false);
    // ② 今日：三次读都必须归零。
    assert.equal(after.today.today.workoutCount, 0, "② 今日：已删训练不得再计入次数");
    assert.equal(after.today.today.distanceKm, 0, "② 今日：已删训练不得再计入里程");
    assert.equal(after.today.recentWorkouts.some((item) => item.id === "c3_session"), false,
      "② 今日：已删训练不得出现在 recentWorkouts 里");
    // ③ 月统计：**逐位相等**的减法，不是"少了一些"。
    assert.equal(before.statistics.totals.workoutCount - after.statistics.totals.workoutCount, 1,
      "③ 月统计：总次数必须恰好少 1 次");
    assert.equal(before.statistics.totals.distanceKm - after.statistics.totals.distanceKm, 5,
      "③ 月统计：总里程必须恰好少 5 km（该训练的距离）");
    assert.equal(after.statistics.totals.workoutCount, 0);
    // ④ 十二周趋势：同一个减法。
    const weekDelta = before.trends.weeks.reduce((sum, week) =>
      sum + week.workoutCount - (after.trends.weeks.find((row) => row.periodStart === week.periodStart)?.workoutCount ?? 0), 0);
    assert.equal(weekDelta, 1, "④ 十二周趋势：必须恰好少 1 次");
    const trendKmDelta = before.trends.weeks.reduce((sum, week) =>
      sum + week.distanceKm - (after.trends.weeks.find((row) => row.periodStart === week.periodStart)?.distanceKm ?? 0), 0);
    assert.equal(trendKmDelta, 5, "④ 趋势里程也必须恰好少 5 km");
    // ⑤ 计划状态快照：`coherenceToken` 吃的是当前事实 ⇒ 事实变了它必须跟着变，
    //    否则客户端会拿旧快照当新的。
    assert.equal(after.planState.metadata.coherenceToken !== before.planState.metadata.coherenceToken, true,
      "⑤ 事实变了 ⇒ 一致性 token 必须变");
  });
});

test("C3/S6：事实存在性判据**同源** —— 本批新增文件里没有第二处 `deleted_at IS NULL`", async () => {
  const newFiles = [
    "packages/storage-sqlite/src/read/fact-read-view.ts"
  ];
  for (const file of newFiles) {
    const source = readFileSync(join(import.meta.dirname, "../../..", file), "utf8");
    assert.equal(/deleted_at\s+IS\s+NULL/i.test(source), false,
      `${file} 里出现了第二处可见性字面量 —— 判据必须只有 \`workoutPresentConditionSql()\` 一处`);
    assert.ok(source.includes("workoutPresentConditionSql"), `${file} 必须**引用**那个函数`);
  }
});
