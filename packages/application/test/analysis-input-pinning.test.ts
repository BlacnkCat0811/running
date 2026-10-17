// O06-A / WP-22 步骤 3–5：直连分析车道的**固定输入**端到端判据。
//
// 为什么必须有这条用例：`analysis-input-materialization.test.ts` 证明的是读取器自己的行为；
// 真正要钉住的是**pipeline 有没有真的用它**。三个方向各一条对照：
//   ① 下一批导入在计算途中落地 ⇒ 要么同绑定发布（raw-only，由 D4 裁决），要么安全重排；
//      绝不允许"读到一半的输入"混进候选 —— 用"捕获之后插入的训练不得出现在候选里"来判；
//   ② override/配置在计算途中变化 ⇒ 旧候选必须被拒绝（`verifyAndPoint` 的 override 摘要）；
//   ③ 历史固定截止点的任务保持自己的 `asOf`，不得被"当前数据更新了"偷换语义。
//
// 夹具全部是合成的（无真实健康数据）；断言只看计数、绑定行与发布指针。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  RaiApplicationService,
  SqliteAnalysisInputReader,
  type AnalysisInputBudget,
  type AnalysisInputCapture,
  type AnalysisInputCaptureRequest
} from "../src/index.js";
import { RaiDatabase, RecomputeJobRepository } from "@rai/storage-sqlite";

// 逼出分段路径：行数预算 1（事实远多于 1 行），并把单条读上限压到 1 行以便验证"越界必须记账"。
// `maxRows`/`maxBytes` 只负责把捕获逼进**分段模式**；`maxReadRows` 必须留足余量 ——
// 2026-10-17 起它是一条**硬上限**（超过就抛错），不再是"记账继续算"。
const SMALL_BUDGET: AnalysisInputBudget = { maxRows: 1, maxBytes: 1, maxReadRows: 10_000, maxReadMs: 60_000 };
const SESSION_COUNT = 6;

function dateForRun(index: number): string {
  return new Date(Date.UTC(2025, 0, 1 + index * 3, 0, 0, 0)).toISOString();
}

function seed(database: DatabaseSync): void {
  database.prepare("INSERT INTO import_manifest (key, value) VALUES ('dataset_version', ?)")
    .run("dataset_fixture_v1");
  database.prepare("INSERT INTO import_manifest (key, value) VALUES ('parser_contract_version', ?)")
    .run("canonical-health-v1");
  const insertWorkout = database.prepare(`
    INSERT INTO workouts (
      id, activity_type, source_name, source_category, source_version, device,
      start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical
    ) VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture Apple Watch', 'apple_watch',
      '1', 'Watch', ?, ?, 1800, 0, '{}', '{}', 1)
  `);
  const insertStatistic = database.prepare(`
    INSERT INTO workout_statistics (
      workout_id, ordinal, type, unit, sum_value, average_value, minimum_value, maximum_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSession = database.prepare(`
    INSERT INTO training_sessions (
      id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
      canonical_workout_id, status
    ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')
  `);
  for (let index = 0; index < SESSION_COUNT; index += 1) {
    const workoutId = `workout_${index}`;
    const start = dateForRun(index);
    const end = new Date(Date.parse(start) + 1_800_000).toISOString();
    insertWorkout.run(workoutId, start, end);
    insertStatistic.run(workoutId, 0, "HKQuantityTypeIdentifierDistanceWalkingRunning", "km", 5, null, null, null);
    insertStatistic.run(workoutId, 1, "HKQuantityTypeIdentifierHeartRate", "count/min", null, 145 - index, 130, 165);
    insertStatistic.run(workoutId, 2, "HKQuantityTypeIdentifierRunningSpeed", "km/hr", null, 10 + index * 0.15, 9, 11);
    insertSession.run(`session_${index}`, start, end, workoutId);
  }
}

/**
 * 模拟"下一批导入"：写事实 + 记批次 + 推代次（并按需改 dataset 版本）。
 *
 * `payload` 两档必须与直连车道的分类合同一致：
 * - `"scoring_workout"`：新增一场跑步训练 ⇒ `analysisRequired` ⇒ `dependency_bumped = 1`；
 * - `"raw_only_record"`：只写一条**非评分**记录（体成分），raw 前进而依赖不动。
 *   让"raw-only"的批次里出现训练，测的就变成"分类器坏了"，而不是本判据。
 */
function commitNextBatch(
  database: DatabaseSync,
  options: { dependencyBumped: boolean; payload: "scoring_workout" | "raw_only_record"; datasetVersion: string | null }
): void {
  if (options.payload === "raw_only_record") {
    database.prepare(`INSERT INTO health_records
      (id, type, source_name, source_category, source_version, device, unit, value_numeric, value_text,
       start_at, end_at, created_at, metadata_json, raw_attributes_json)
      VALUES ('record_late_body_mass', 'HKQuantityTypeIdentifierBodyMass', 'Fixture Apple Watch',
        'apple_watch', '1', 'Watch', 'kg', 70, NULL, '2025-01-20T07:00:00.000Z', '2025-01-20T07:00:00.000Z',
        '2025-01-20T07:01:00.000Z', '{}', '{}')`).run();
  }
  if (options.payload === "scoring_workout") {
    const start = dateForRun(SESSION_COUNT);
    const end = new Date(Date.parse(start) + 1_800_000).toISOString();
    database.prepare(`INSERT INTO workouts (
      id, activity_type, source_name, source_category, source_version, device,
      start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
      VALUES ('workout_late', 'HKWorkoutActivityTypeRunning', 'Fixture Apple Watch', 'apple_watch',
        '1', 'Watch', ?, ?, 1800, 0, '{}', '{}', 1)`).run(start, end);
    database.prepare(`INSERT INTO workout_statistics
      (workout_id, ordinal, type, unit, sum_value, average_value, minimum_value, maximum_value)
      VALUES ('workout_late', 0, 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'km', 5, NULL, NULL, NULL)`).run();
    database.prepare(`INSERT INTO training_sessions
      (id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status)
      VALUES ('session_late', 'HKWorkoutActivityTypeRunning', ?, ?, 5, 'workout_late', 'active')`)
      .run(start, end);
  }
  database.prepare(`INSERT INTO import_batches (id, xml_sha256, status, import_mode, created_at,
    raw_generation, dependency_generation, dependency_bumped)
    VALUES ('batch_late', ?, 'succeeded', 'incremental', '2025-01-20T00:00:00.000Z', 1, ?, ?)`)
    .run("0".repeat(64), options.dependencyBumped ? 1 : 0, options.dependencyBumped ? 1 : 0);
  if (options.payload === "scoring_workout") {
    // 账本证据（外键要求批次行先落库）：没有它，合并路径算不出可复用边界，会显式退成全量。
    database.prepare(`INSERT INTO import_entity_changes
      (batch_id, entity_kind, entity_id, change_type, effective_at)
      VALUES ('batch_late', 'workout', 'workout_late', 'inserted', ?)`).run(dateForRun(SESSION_COUNT));
  }
  database.prepare(
    "UPDATE import_generations SET raw_generation = 1, dependency_generation = ? WHERE singleton = 1"
  ).run(options.dependencyBumped ? 1 : 0);
  if (options.datasetVersion !== null) {
    database.prepare("UPDATE import_manifest SET value = ? WHERE key = 'dataset_version'")
      .run(options.datasetVersion);
  }
}

/** 捕获完成后（同一时刻）注入下一批：这正是"CPU 阶段输入被改掉"的最短复现。 */
class NextBatchDuringCaptureReader extends SqliteAnalysisInputReader {
  constructor(
    database: DatabaseSync,
    budget: AnalysisInputBudget,
    private readonly inject: () => void
  ) {
    super(database, "direct-sync", budget);
  }

  override capture(request: AnalysisInputCaptureRequest, budget?: AnalysisInputBudget): AnalysisInputCapture {
    const capture = super.capture(request, budget);
    this.inject();
    return capture;
  }
}

interface Fixture {
  path: string;
  store: Awaited<ReturnType<typeof RaiDatabase.open>>;
}

function withFixture<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rai-input-pinning-"));
  const path = join(root, "rai.sqlite");
  return RaiDatabase.open(path, { createMigrationBackup: false }).then(async (store) => {
    try {
      seed(store.database);
      return await run({ path, store });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

/** 先跑一次普通全量，建立 incumbent 与第一条发布。 */
function publishBaseline(fixture: Fixture): string {
  const service = new RaiApplicationService(fixture.store);
  const jobId = service.enqueueFullRecompute({
    evaluatedAt: new Date(Date.UTC(2025, 1, 1)).toISOString(),
    timezoneIdentifier: "UTC"
  });
  const job = service.runNextJob();
  assert.equal(job?.id, jobId);
  assert.equal(job?.status, "succeeded", JSON.stringify(job?.error ?? {}));
  const active = fixture.store.database
    .prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1").get() as { id: string };
  return active.id;
}

/** 登记一条直连分析任务（与 `direct-sync-ingest.ts` 同形状，但只取测试需要的字段）。 */
function enqueueDirectSyncJob(
  fixture: Fixture,
  input: { importBatchId: string; evaluatedAt: string; dirtyFromAt: string | null; targetRaw: number; targetDependency: number }
): string {
  return new RecomputeJobRepository(fixture.store.database).enqueue(
    "import",
    "dataset_fixture_v1",
    {
      mode: "direct_sync_analysis",
      importBatchId: input.importBatchId,
      evaluatedAt: input.evaluatedAt,
      timezoneIdentifier: "UTC",
      ...(input.dirtyFromAt === null ? {} : {
        incrementalPlan: {
          mode: "partial" as const,
          dirtyFromAt: input.dirtyFromAt,
          domains: { features: input.dirtyFromAt, fitness: input.dirtyFromAt, readiness: input.dirtyFromAt }
        }
      })
    },
    {
      targetRawGeneration: input.targetRaw,
      targetDependencyGeneration: input.targetDependency
    }
  );
}

function featureCount(store: Fixture["store"], modelRunId: string): number {
  return Number(store.database.prepare(`
    SELECT COUNT(*) AS n FROM workout_features feature
    JOIN model_runs model ON model.feature_run_id = feature.feature_run_id
    WHERE model.id = ?`).get(modelRunId)!.n);
}

test("注入下一批（合法 raw-only）⇒ 同绑定发布，且代次前进仍留痕", async () => {
  await withFixture(async (fixture) => {
    const baseline = publishBaseline(fixture);
    const input = RaiDatabase.openReadonly(fixture.path);
    try {
      const reader = new NextBatchDuringCaptureReader(input, { maxRows: 400_000, maxBytes: 1 << 30, maxReadRows: 10_000, maxReadMs: 60_000 }, () => {
        commitNextBatch(fixture.store.database, {
          dependencyBumped: false, payload: "raw_only_record", datasetVersion: "dataset_delta_fixture"
        });
      });
      const service = new RaiApplicationService(fixture.store, "owned", undefined, undefined, reader);
      const jobId = enqueueDirectSyncJob(fixture, {
        importBatchId: "batch_late",
        evaluatedAt: new Date(Date.UTC(2025, 1, 1)).toISOString(),
        dirtyFromAt: null,
        targetRaw: 0,
        targetDependency: 0
      });
      const job = service.runNextJob();
      assert.equal(job?.id, jobId);
      assert.equal(job?.status, "succeeded", JSON.stringify(job?.error ?? {}));
      // ① 合法 raw-only 批次按 D4 依赖级判据准入（依赖代次没动 ⇒ 不动分析输入）。
      assert.equal(featureCount(fixture.store, job!.modelRunId!), SESSION_COUNT);
      // ② 阶段判据必须留痕：物化模式不因代次前进作废候选，但"计算期间 raw 动过"要可查
      //    （静默放过一次代次前进与"没有前进"在事后看起来一模一样）。
      const advancedEvents = fixture.store.database.prepare(`
        SELECT message FROM recompute_job_events
        WHERE job_id = ? AND phase = 'input_binding' AND message LIKE 'Generation advanced during%'`)
        .all(jobId) as Array<{ message: string }>;
      assert.ok(advancedEvents.length >= 1, "阶段判据必须记下'计算期间代次前进'");
      for (const event of advancedEvents) {
        assert.match(event.message, /captured 0\/0, observed 1\/0/);
      }
      // ③ 绑定行落库，且写的是**捕获**时的代次（不是发布时的最新代次）。
      const binding = fixture.store.database.prepare(`
        SELECT captured_raw_generation AS raw, captured_dependency_generation AS dependency,
               target_raw_generation AS targetRaw
        FROM analysis_run_input_bindings WHERE run_id = ?`).get(job!.modelRunId!) as
        { raw: number; dependency: number; targetRaw: number };
      assert.equal(Number(binding.raw), 0);
      assert.equal(Number(binding.dependency), 0);
      assert.equal(Number(binding.targetRaw), 0);
      // ④ 发布确实发生了，而且发生在新库状态上（raw-only 批次由 D4 依赖级判据准入）。
      const active = fixture.store.database
        .prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1").get() as { id: string };
      assert.equal(active.id, job!.modelRunId);
      assert.notEqual(active.id, baseline);
    } finally {
      input.close();
    }
  });
});

test("注入下一批（含新训练、推依赖代次）⇒ 候选只含固定输入的训练，且不得混代发布", async () => {
  await withFixture(async (fixture) => {
    const baseline = publishBaseline(fixture);
    const input = RaiDatabase.openReadonly(fixture.path);
    try {
      const reader = new NextBatchDuringCaptureReader(input, { maxRows: 400_000, maxBytes: 1 << 30, maxReadRows: 10_000, maxReadMs: 60_000 }, () => {
        commitNextBatch(fixture.store.database, {
          dependencyBumped: true, payload: "scoring_workout", datasetVersion: "dataset_delta_fixture"
        });
      });
      const service = new RaiApplicationService(fixture.store, "owned", undefined, undefined, reader);
      const jobId = enqueueDirectSyncJob(fixture, {
        importBatchId: "batch_late",
        evaluatedAt: new Date(Date.UTC(2025, 1, 1)).toISOString(),
        dirtyFromAt: null,
        targetRaw: 0,
        targetDependency: 0
      });
      const job = service.runNextJob();
      assert.equal(job?.id, jobId);
      // ① 输入固定：候选里**只有**捕获那一刻的 6 场训练，第 7 场（捕获之后落库）不得出现。
      //    这一条就是"事实读取真的走了固定输入"的直接证据 —— 退了固定输入这里会变成 7。
      assert.equal(featureCount(fixture.store, job!.modelRunId!), SESSION_COUNT,
        "捕获之后到达的训练混进了候选 ⇒ 事实读取没有走固定输入");
      // ② 依赖代次前进了 ⇒ 发布判据（D4）必须拒绝这一版候选：不混代发布，旧 release 不动。
      assert.equal(job?.status, "failed");
      assert.match(String(job?.error?.message ?? ""), /Dataset changed since candidate evaluation/);
      const active = fixture.store.database
        .prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1").get() as { id: string };
      assert.equal(active.id, baseline, "依赖代次前进后仍然激活了候选 ⇒ 混代发布");
    } finally {
      input.close();
    }
  });
});

test("注入下一批（推依赖代次）且输入超出物化预算 ⇒ 候选作废、旧发布保留、**原任务**退回队列重排", async () => {
  await withFixture(async (fixture) => {
    const baseline = publishBaseline(fixture);
    const input = RaiDatabase.openReadonly(fixture.path);
    try {
      // 只注入一次：重排时读取器会被再次调用，但"下一批"不会重复到达（否则就是夹具自己的重复写）。
      let injected = false;
      const reader = new NextBatchDuringCaptureReader(input, SMALL_BUDGET, () => {
        if (injected) return;
        injected = true;
        commitNextBatch(fixture.store.database, {
          dependencyBumped: true, payload: "scoring_workout", datasetVersion: "dataset_delta_fixture"
        });
      });
      const service = new RaiApplicationService(fixture.store, "owned", undefined, undefined, reader);
      const jobId = enqueueDirectSyncJob(fixture, {
        importBatchId: "batch_late",
        evaluatedAt: new Date(Date.UTC(2025, 1, 1)).toISOString(),
        dirtyFromAt: null,
        targetRaw: 0,
        targetDependency: 0
      });
      const job = service.runNextJob();
      assert.equal(job?.id, jobId);
      // 🔴 B03（2026-10-17）：漂移重排**退回原任务**（同 id、同回执），不再新建后继，
      // 也不再把原 id 判死。客户端唯一持有的句柄就是 `analysisJobId` —— 把它写成 failed，
      // 而真正算完的是另一个 id，等于让客户端永远读不到真实结局。
      assert.equal(job?.status, "queued",
        "漂移后原任务必须退回队列，而不是永久 failed（原 id 是客户端唯一持有的句柄）");
      assert.equal(job?.error ?? null, null, "重排不是失败：不得留下终态错误");
      // ① 旧发布结果原样保留。
      const active = fixture.store.database
        .prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1").get() as { id: string };
      assert.equal(active.id, baseline, "漂移不得动发布指针");
      // ② 分段模式被显式记账（不是"悄悄无限读"）。
      const materialization = fixture.store.database.prepare(`
        SELECT message FROM recompute_job_events
        WHERE job_id = ? AND phase = 'input_materialization' ORDER BY rowid`)
        .all(jobId) as Array<{ message: string }>;
      assert.ok(materialization.length >= 1, "必须留下物化/降级证据");
      const declared = JSON.parse(materialization[0]!.message) as { mode: string; reason: string };
      assert.equal(declared.mode, "segmented");
      assert.equal(declared.reason, "fact_rows_exceed_budget");
      // （"越界读必须上报"由下面那条'分段路径照样算完并发布'的用例判：本用例在第一条读上
      //   就因依赖代次前进而作废，不会产生任何**完成**的读。）
      // ③ 合并新增 dirty 范围后重排：**同一条任务**带上新计划与重排计数。
      const replanned = fixture.store.database.prepare(`
        SELECT request_json AS request, progress_phase AS phase, error_json AS errorJson
        FROM recompute_jobs WHERE id = ?`).get(jobId) as {
          request: string; phase: string; errorJson: string | null;
        };
      assert.equal(replanned.phase, "replan_pending", "阶段必须说明正在重排，而不是失败");
      assert.equal(replanned.errorJson, null, "重排不得留下错误载荷");
      const request = JSON.parse(replanned.request) as Record<string, unknown>;
      assert.equal(Number(request.bindingDriftReplans), 1);
      assert.equal((request.incrementalPlan as { mode?: string } | undefined)?.mode, "partial");
      assert.equal((request.incrementalPlan as { dirtyFromAt?: string }).dirtyFromAt, dateForRun(SESSION_COUNT));
      // ④ 没有后继任务：原 id 是唯一句柄，"重排"不等于"另起一条"。
      const total = fixture.store.database.prepare(
        "SELECT COUNT(*) AS n FROM recompute_jobs WHERE job_type = 'import'"
      ).get() as { n: number };
      assert.equal(Number(total.n), 1, "重排不得新建后继任务");
    } finally {
      input.close();
    }
  });
});

test("超过**物化**预算的分段路径照样算完并发布：输入仍固定、单条读预算充足时不留越界记账", async () => {
  await withFixture(async (fixture) => {
    const baseline = publishBaseline(fixture);
    const input = RaiDatabase.openReadonly(fixture.path);
    try {
      // 捕获之后注入一个 **raw-only** 批次：依赖代次不动 ⇒ 分段读不作废（与 D4 同口径），
      // 于是整条分段路径必须跑完、发布，并且把"这一版算的是哪一代"写清楚。
      let injected = false;
      const reader = new NextBatchDuringCaptureReader(input, SMALL_BUDGET, () => {
        if (injected) return;
        injected = true;
        commitNextBatch(fixture.store.database, {
          dependencyBumped: false, payload: "raw_only_record", datasetVersion: "dataset_delta_fixture"
        });
      });
      const service = new RaiApplicationService(fixture.store, "owned", undefined, undefined, reader);
      const jobId = enqueueDirectSyncJob(fixture, {
        importBatchId: "batch_late",
        evaluatedAt: new Date(Date.UTC(2025, 1, 1)).toISOString(),
        dirtyFromAt: null,
        targetRaw: 0,
        targetDependency: 0
      });
      const job = service.runNextJob();
      assert.equal(job?.id, jobId);
      assert.equal(job?.status, "succeeded", JSON.stringify(job?.error ?? {}));
      // ① 分段路径下输入同样固定：捕获之后到达的训练不得进入候选。
      assert.equal(featureCount(fixture.store, job!.modelRunId!), SESSION_COUNT);
      assert.notEqual(job!.modelRunId, baseline);
      // ② 降级必须留痕；单条读的硬上限由 `analysis-read-budget.test.ts` 判（超限即抛错）。
      const events = (fixture.store.database.prepare(`
        SELECT message FROM recompute_job_events
        WHERE job_id = ? AND phase = 'input_materialization' ORDER BY rowid`).all(jobId) as Array<{ message: string }>)
        .map((row) => JSON.parse(row.message) as { mode?: string; reason?: string; nearLimit?: string[]; rawAdvances?: string[] });
      assert.equal(events[0]?.mode, "segmented");
      assert.equal(events[0]?.reason, "fact_rows_exceed_budget");
      assert.deepEqual(
        events.flatMap((event) => event.nearLimit ?? []), [],
        "单条读都在预算内时，不得留下任何\"接近上限\"的记账"
      );
      assert.ok(
        events.flatMap((event) => event.rawAdvances ?? []).length > 0,
        "raw-only 前进必须留痕"
      );
    } finally {
      input.close();
    }
  });
});

test("override 在计算途中变化 ⇒ 旧候选必须被拒绝（发布短事务的 override 摘要判据）", async () => {
  await withFixture(async (fixture) => {
    const baseline = publishBaseline(fixture);
    const input = RaiDatabase.openReadonly(fixture.path);
    try {
      const reader = new NextBatchDuringCaptureReader(input, { maxRows: 400_000, maxBytes: 1 << 30, maxReadRows: 10_000, maxReadMs: 60_000 }, () => {
        fixture.store.database.prepare(`INSERT INTO workout_overrides
          (id, training_session_id, revision, eligibility_override, session_type, rpe, condition_tags_json, note)
          VALUES ('override_late', 'session_0', 1, 'exclude', 'race', 9, '[]', NULL)`).run();
      });
      const service = new RaiApplicationService(fixture.store, "owned", undefined, undefined, reader);
      const jobId = enqueueDirectSyncJob(fixture, {
        importBatchId: "batch_none",
        evaluatedAt: new Date(Date.UTC(2025, 1, 1)).toISOString(),
        dirtyFromAt: null,
        targetRaw: 0,
        targetDependency: 0
      });
      const job = service.runNextJob();
      assert.equal(job?.id, jobId);
      assert.equal(job?.status, "failed");
      assert.match(String(job?.error?.message ?? ""), /[Oo]verrides changed/);
      const active = fixture.store.database
        .prepare("SELECT model_run_id AS id FROM active_model_run WHERE singleton = 1").get() as { id: string };
      assert.equal(active.id, baseline, "override 变了就绝不能激活旧候选");
    } finally {
      input.close();
    }
  });
});

test("历史固定截止点的直连任务保持自己的 asOf（不被'当前数据更新了'偷换语义）", async () => {
  await withFixture(async (fixture) => {
    // 这条用例**故意**不做基线发布：历史截止点任务与"最新数据"的比较会触发能力漂移闸门，
    // 而这里要判的是**请求语义**（asOf 与参与计算的训练范围），不是闸门 —— 让它作为首次
    // 发布（bootstrap 分支）跑完，才能把 asOf 与特征范围都看到。
    const input = RaiDatabase.openReadonly(fixture.path);
    try {
      const cutoff = dateForRun(SESSION_COUNT - 2);
      const reader = new SqliteAnalysisInputReader(input);
      const service = new RaiApplicationService(fixture.store, "owned", undefined, undefined, reader);
      const jobId = enqueueDirectSyncJob(fixture, {
        importBatchId: "batch_historical",
        evaluatedAt: cutoff,
        dirtyFromAt: null,
        targetRaw: 0,
        targetDependency: 0
      });
      const job = service.runNextJob();
      assert.equal(job?.id, jobId);
      assert.equal(job?.status, "succeeded", JSON.stringify(job?.error ?? {}));
      const lineage = fixture.store.database.prepare(
        "SELECT lineage_json AS json FROM model_v2_runs WHERE model_run_id = ?"
      ).get(job!.modelRunId!) as { json: string };
      assert.equal((JSON.parse(lineage.json) as { asOf: string }).asOf, cutoff);
      // 截止点之前的训练照旧算，之后的训练不参与 —— 输入固定不会把请求改写成"最新数据"。
      assert.equal(featureCount(fixture.store, job!.modelRunId!), SESSION_COUNT - 2);
    } finally {
      input.close();
    }
  });
});
