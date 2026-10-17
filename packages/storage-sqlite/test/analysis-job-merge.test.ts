// O06-B / WP-40：**连续批次的重复计算合并**（`analysis_job_merges`，v42）。
//
// 这个文件钉的是七件事，每一件都有对应的失败形态（不是"测一遍新代码"）：
//
//   1. 十条兼容的排队批次只生成**一条**覆盖任务，其余九条**不得**被独立领取 ——
//      否则"合并"退化成"多了一条任务"，重复计算照旧；
//   2. 覆盖任务**真正发布**之后，十条原任务才结算成 `succeeded`，
//      且每一条都能沿**原 id** 查到自己的真实结果（含发布绑定的摘要）；
//   3. 已经 `running` 的任务**不得**被并进来（"已运行任务不能偷换输入"）；
//   4. 历史固定截止点（`full_recompute` / 载荷带 `asOf`）与不同时区/不同配置的任务
//      **不得**合并（否则等于偷换请求语义）；
//   5. 覆盖任务失败/取消时，被覆盖任务**留在队列**并且关联被释放（可重新规划），
//      **绝不**被结算 —— "失败"与"重排"保留各自真实含义；
//   6. 发布时刻的依赖覆盖证明不成立（计算期间又来了推依赖代次的批次）⇒ **不结算**；
//      raw-only 批次（不推依赖）⇒ 同绑定发布、照常结算（D4）；
//   7. 防饿死（B6）：被覆盖次数达到上限的任务**必须单独执行**，
//      不会"被无限创建又无限丢弃"。
//
// ⚠️ 界限：本文件证明的是**仓库层**的判据。真实分析的端到端验收（十条只跑一份计算、
// 发布 gate 拒绝时安全重排）在 `apps/api/test/analysis-job-merge.test.ts`。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLI_OWNED_IMPORT_REQUEST_MODE,
  DATABASE_TIMEZONE,
  DIRECT_SYNC_ANALYSIS_REQUEST_MODE
} from "@rai/contracts";
import {
  ANALYSIS_JOB_MERGE_MAX_ATTEMPTS,
  ANALYSIS_JOB_MERGE_MAX_MEMBERS,
  ANALYSIS_JOB_MERGE_MAX_SPAN_MS,
  RecomputeJobRepository,
  type JobCoverageReport
} from "../src/recompute-job-repository.js";
import { RaiDatabase } from "../src/database.js";

async function withStore(run: (store: RaiDatabase, jobs: RecomputeJobRepository) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-analysis-job-merge-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    run(store, new RecomputeJobRepository(store.database));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

interface EnqueueOptions {
  batchId: string;
  targetRaw: number;
  targetDependency: number;
  dirtyFromAt?: string;
  timezoneIdentifier?: string;
  /** 额外塞进载荷的键（用于构造"不同配置"/"固定截止点"的对照）。 */
  extraRequest?: Record<string, unknown>;
  /** 载荷 mode（默认直连分析；用于构造"不是最新分析语义"的对照）。 */
  mode?: string;
  /** 不写 v35 绑定列（构造"没有绑定 ⇒ 不可合并"的对照）。 */
  withoutBindings?: boolean;
}

function enqueueDirectSyncAnalysis(
  store: RaiDatabase,
  jobs: RecomputeJobRepository,
  options: EnqueueOptions
): string {
  const id = jobs.enqueue(
    "import",
    `dataset_delta_${options.batchId}`,
    {
      mode: options.mode ?? DIRECT_SYNC_ANALYSIS_REQUEST_MODE,
      importBatchId: options.batchId,
      evaluatedAt: new Date().toISOString(),
      timezoneIdentifier: options.timezoneIdentifier ?? DATABASE_TIMEZONE,
      ...(options.dirtyFromAt === undefined
        ? {}
        : {
            incrementalPlan: {
              mode: "partial",
              dirtyFromAt: options.dirtyFromAt,
              domains: {
                features: options.dirtyFromAt,
                fitness: options.dirtyFromAt,
                readiness: options.dirtyFromAt
              }
            }
          }),
      ...(options.extraRequest ?? {})
    },
    options.withoutBindings
      ? undefined
      : {
          targetRawGeneration: options.targetRaw,
          targetDependencyGeneration: options.targetDependency,
          dirty: { reasons: [`batch:${options.batchId}`], unknownRecordTypes: [], from: options.dirtyFromAt ?? null }
        }
  );
  return id;
}

/** 一个"已成功落库的批次"，同时把两个计数器推到它声明的值（模拟并发到达的下一批）。 */
function insertSucceededBatch(
  store: RaiDatabase,
  batch: { id: string; raw: number; dependency: number; bumped: 0 | 1 }
): void {
  store.database.prepare(`
    INSERT INTO import_batches (
      id, xml_sha256, status, import_mode, summary_json,
      raw_generation, dependency_generation, dependency_bumped
    ) VALUES (?, ?, 'succeeded', 'incremental', '{}', ?, ?, ?)
  `).run(batch.id, "0".repeat(64), batch.raw, batch.dependency, batch.bumped);
  store.database.prepare(
    "UPDATE import_generations SET raw_generation = ?, dependency_generation = ? WHERE singleton = 1"
  ).run(batch.raw, batch.dependency);
}

function generations(store: RaiDatabase): { raw: number; dependency: number } {
  const row = store.database.prepare(
    "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton = 1"
  ).get() as { raw: number; dependency: number };
  return { raw: Number(row.raw), dependency: Number(row.dependency) };
}

/**
 * 模拟"覆盖任务真的发布了"：写 feature/model run、给任务挂上 run id，
 * 再在 `complete()` 的发布事务里写下输入绑定与**执行覆盖记录**（真实路径由 pipeline 的
 * `writeAnalysisInputBinding` 完成：绑定 + `capture.mergedBatchIds` 的覆盖行 + 执行边界证据）。
 *
 * 🔴 R02 契约：覆盖记录由**执行方**在发布事务里写下（⊇ 调度并集）；结算只核验、不改写。
 * 所以这里必须自己写 —— "只说 publish 不写覆盖记录"的模拟会因为
 * `publication_missing_union_batch` 不被结算（那是正确行为）。
 */
function publishCovering(
  store: RaiDatabase,
  jobs: RecomputeJobRepository,
  coveringJobId: string,
  options: {
    capturedRaw: number;
    capturedDependency: number;
    timezoneIdentifier?: string;
    /** 模拟"执行覆盖清单里出现并集之外的批次"（合法的 required 批次，或伪造批次）。 */
    foreignCoverageBatchId?: string;
    /** 模拟 v44 的执行边界证据；缺省 = 不写（核验方退回旧判据）。 */
    executedPlan?: { dirtyFromAt: string | null; domains: Record<string, string | null> };
  }
): boolean {
  const featureRunId = `feature_run_test_${coveringJobId}`;
  const modelRunId = `model_run_test_${coveringJobId}`;
  store.database.prepare(`
    INSERT INTO feature_runs (
      id, dataset_version, canonical_contract_version, feature_schema_version,
      feature_config_json, feature_config_hash, status
    ) VALUES (?, 'dataset_test', 'contract_test', 'workout-feature-v4', '{}', 'hash', 'succeeded')
  `).run(featureRunId);
  store.database.prepare(`
    INSERT INTO model_runs (
      id, feature_run_id, dataset_version, model_version, model_config_json,
      model_config_hash, evaluated_at, status
    ) VALUES (?, ?, 'dataset_test', 'model_test', '{}', 'hash', ?, 'succeeded')
  `).run(modelRunId, featureRunId, new Date().toISOString());
  jobs.setRunIds(coveringJobId, featureRunId, modelRunId);
  return jobs.complete(coveringJobId, "completed", 1, 1, "Model run activated", () => {
    store.database.prepare(`
      INSERT INTO analysis_run_input_bindings (
        run_id, job_id, scope, dataset_version, captured_raw_generation,
        captured_dependency_generation, target_raw_generation, target_dependency_generation,
        incumbent_release_id, timezone_identifier, override_digest, config_digest,
        cutoff_at, input_digest, executed_plan_json
      ) VALUES (?, ?, 'direct-sync', 'dataset_test', ?, ?, NULL, NULL, NULL, ?, 'overrides', 'config', ?, ?, ?)
    `).run(
      modelRunId,
      coveringJobId,
      options.capturedRaw,
      options.capturedDependency,
      options.timezoneIdentifier ?? DATABASE_TIMEZONE,
      new Date().toISOString(),
      `input_digest_${coveringJobId}`,
      options.executedPlan === undefined ? null : JSON.stringify(options.executedPlan)
    );
    // 执行覆盖记录（真实写入方 = `writeAnalysisInputBinding`）：调度并集 ∪ 运行期并入的批次。
    const unionRow = store.database.prepare(`
      SELECT union_batch_ids_json AS json FROM analysis_job_merges
      WHERE covering_job_id = ? ORDER BY covered_job_id LIMIT 1
    `).get(coveringJobId) as { json: string } | undefined;
    const union = unionRow === undefined ? [] : (JSON.parse(unionRow.json) as string[]);
    const writeCoverage = store.database.prepare(`
      INSERT INTO analysis_job_coverage (
        job_id, import_batch_id, dependency_generation_from, dependency_generation_to
      ) VALUES (?, ?, 0, ?)
      ON CONFLICT(job_id, import_batch_id) DO UPDATE SET
        dependency_generation_to = excluded.dependency_generation_to
    `);
    for (const batchId of union) writeCoverage.run(coveringJobId, batchId, options.capturedDependency);
    if (options.foreignCoverageBatchId !== undefined) {
      writeCoverage.run(coveringJobId, options.foreignCoverageBatchId, options.capturedDependency);
    }
  });
}

function jobRow(store: RaiDatabase, id: string): { status: string; phase: string; modelRunId: string | null } {
  return store.database.prepare(
    "SELECT status, progress_phase AS phase, model_run_id AS modelRunId FROM recompute_jobs WHERE id = ?"
  ).get(id) as { status: string; phase: string; modelRunId: string | null };
}

function mergeRows(store: RaiDatabase, coveringJobId: string): Array<Record<string, unknown>> {
  return store.database.prepare(
    "SELECT * FROM analysis_job_merges WHERE covering_job_id = ? ORDER BY covered_job_id"
  ).all(coveringJobId) as unknown as Array<Record<string, unknown>>;
}

function report(jobs: RecomputeJobRepository, id: string): JobCoverageReport {
  const value = jobs.coveringReport(id);
  assert.ok(value, `任务 ${id} 应当有一条覆盖关联`);
  return value;
}

test("十条兼容的排队批次只生成一条覆盖任务，其余九条不得被独立领取", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_10", raw: 10, dependency: 10, bumped: 1 });
    const members = Array.from({ length: 10 }, (_unused, index) =>
      enqueueDirectSyncAnalysis(store, jobs, {
        batchId: `batch_${index + 1}`,
        targetRaw: index + 1,
        targetDependency: index + 1,
        dirtyFromAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
      })
    );

    const claimed = jobs.claimNext();
    assert.ok(claimed, "覆盖任务必须被领取");
    assert.equal(members.includes(claimed.id), false, "被领取的必须是**新造的覆盖任务**，不是某一条原任务");
    assert.equal(claimed.status, "running");
    assert.equal(claimed.targetRawGeneration, 10, "覆盖任务的目标 = 可一致读取的最新 raw 代次");
    assert.equal(claimed.targetDependencyGeneration, 10, "同上（dependency）");

    const request = claimed.request as Record<string, unknown>;
    assert.deepEqual([...request.importBatchIds as string[]].sort(), [...members.map((_id, i) => `batch_${i + 1}`)].sort(),
      "覆盖任务的载荷必须带**并集**批次清单");
    const mergedFrom = request.mergedFromJobIds as string[];
    assert.deepEqual([...mergedFrom].sort(), [...members].sort(),
      "载荷必须说明它代表了哪些原任务（可复核）");
    assert.equal(typeof request.importBatchId, "string", "现有业务 gate 读的单数键必须仍在");

    for (const id of members) {
      assert.equal(jobRow(store, id).status, "queued", "发布之前原任务必须仍是 queued（不得谎报 not_required/成功）");
      const coverage = report(jobs, id);
      assert.equal(coverage.state, "pending");
      assert.equal(coverage.coveringJobId, claimed.id);
      assert.equal(coverage.attempts, 1);
    }
    // 🔴 关键：第二条不能被领取 —— 被覆盖任务若不从领取集合里排除，
    // "十条只算一份"当场退化成"十条各算一份"（它们与覆盖任务同毫秒登记）。
    assert.equal(jobs.claimNext(), null, "九条被覆盖任务都不得再被领取");
  });
});

test("覆盖任务真正发布后，十条原任务全部结算，且每条都能沿原 id 查到真实结果", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_3", raw: 3, dependency: 3, bumped: 1 });
    const members = [1, 2, 3].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `batch_${index}`,
      targetRaw: index,
      targetDependency: index
    }));
    const covering = jobs.claimNext();
    assert.ok(covering);
    const published = publishCovering(store, jobs, covering.id, { capturedRaw: 3, capturedDependency: 3 });
    assert.equal(published, true, "发布必须成功");

    for (const id of members) {
      const row = jobRow(store, id);
      assert.equal(row.status, "succeeded", `${id} 必须被结算`);
      assert.equal(row.phase, "covered");
      assert.equal(row.modelRunId, `model_run_test_${covering.id}`, "原任务必须指向真正覆盖它的那次发布");
      const coverage = report(jobs, id);
      assert.equal(coverage.state, "published");
      assert.ok(coverage.settledAt, "结算时刻必须落库");
      assert.equal(coverage.bindingCapturedDependencyGeneration, 3, "发布绑定必须是可复核的落库事实");
      assert.equal(coverage.bindingInputDigest, `input_digest_${covering.id}`,
        "同一覆盖任务的全部成员共享**同一份**发布绑定");
      const events = jobs.listEvents(id).map((event) => String(event.phase));
      assert.ok(events.includes("merged") && events.includes("covered"),
        `原 id 的事件流必须讲清"被合并 → 被覆盖"（实际：${events.join(",")}）`);
    }
    const coverageRows = store.database.prepare(
      "SELECT COUNT(*) AS n FROM analysis_job_coverage WHERE job_id = ?"
    ).get(covering.id) as { n: number };
    assert.equal(Number(coverageRows.n), 3, "发布事务里写下的覆盖记录必须是**并集**");
    assert.equal(jobs.claimNext(), null, "队列必须已经排空");
  });
});

test("已经 running 的任务不被合并：它的输入不得被偷换", async () => {
  await withStore((store, jobs) => {
    const first = enqueueDirectSyncAnalysis(store, jobs, { batchId: "batch_a", targetRaw: 1, targetDependency: 1 });
    // 先让第一条真的开始跑（status='running'）—— 此时队里只有它一条，不构成合并。
    assert.equal(jobs.claimNext()?.id, first);
    const second = enqueueDirectSyncAnalysis(store, jobs, { batchId: "batch_b", targetRaw: 2, targetDependency: 2 });
    // 🔴 现在队里只有一条 queued，另一条是 running。判据：**不得**把它俩并起来
    // （那会把已经跑起来的任务的输入偷换掉），第二条必须被单独领取。
    const claimed = jobs.claimNext();
    assert.equal(claimed?.id, second, "第二条必须被单独领取，而不是生成覆盖任务把 running 的那条并进去");
    assert.equal(jobRow(store, first).status, "running", "已运行任务的输入不得被改写");
    assert.deepEqual(mergeRows(store, first), [], "不得出现任何覆盖关联");
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM recompute_jobs").get()!.n,
      2,
      "不得凭空多出一条覆盖任务"
    );
  });
});

test("历史固定截止点与不同绑定不得合并（full_recompute / asOf / 时区 / 配置）", async () => {
  await withStore((store, jobs) => {
    // ① `full_recompute` 带绑定也不参加（它是历史语义，不是"更新最新分析"）。
    const fullA = jobs.enqueue("full_recompute", null, { evaluatedAt: "2026-01-01T00:00:00.000Z" }, {
      targetRawGeneration: 1, targetDependencyGeneration: 1
    });
    const fullB = jobs.enqueue("full_recompute", null, { evaluatedAt: "2026-01-02T00:00:00.000Z" }, {
      targetRawGeneration: 2, targetDependencyGeneration: 2
    });
    assert.equal(jobs.claimNext()?.id, fullA);
    assert.equal(jobs.claimNext()?.id, fullB, "两条 full_recompute 必须各自执行");
    jobs.complete(fullA, "completed", 1, 1, "done");
    jobs.complete(fullB, "completed", 1, 1, "done");

    // ② 直连载荷但带固定截止点（`asOf`）⇒ 同样不参加合并。
    // ⚠️ 两条的 `asOf` **必须相同**：若不同，它们连合并键都不同，这条用例就测不到
    // 「固定截止点不参加合并」这条判据本身（实测：把判据删掉它照样绿 —— 被合并键挡住了）。
    const asOfA = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_asof_a", targetRaw: 3, targetDependency: 3,
      extraRequest: { asOf: "2026-01-01T00:00:00.000Z" }
    });
    const asOfB = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_asof_b", targetRaw: 4, targetDependency: 4,
      extraRequest: { asOf: "2026-01-01T00:00:00.000Z" }
    });
    assert.equal(jobs.claimNext()?.id, asOfA, "固定截止点任务必须单独执行");
    assert.equal(jobs.claimNext()?.id, asOfB);
    jobs.complete(asOfA, "completed", 1, 1, "done");
    jobs.complete(asOfB, "completed", 1, 1, "done");

    // ③ 时区不同 ⇒ 不是同一个绑定 ⇒ 不合并。
    const utc = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_tz_utc", targetRaw: 5, targetDependency: 5, timezoneIdentifier: "UTC"
    });
    const shanghai = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_tz_sh", targetRaw: 6, targetDependency: 6, timezoneIdentifier: "Asia/Shanghai"
    });
    assert.equal(jobs.claimNext()?.id, utc, "不同时区的任务不得合并");
    assert.equal(jobs.claimNext()?.id, shanghai);
    jobs.complete(utc, "completed", 1, 1, "done");
    jobs.complete(shanghai, "completed", 1, 1, "done");

    // ④ 载荷里任何改变"算什么"的键不同 ⇒ 不合并（白名单式键，默认进键）。
    const configA = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_cfg_a", targetRaw: 7, targetDependency: 7,
      extraRequest: { featureConfig: { version: 2 } }
    });
    const configB = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_cfg_b", targetRaw: 8, targetDependency: 8,
      extraRequest: { featureConfig: { version: 3 } }
    });
    assert.equal(jobs.claimNext()?.id, configA, "不同 feature 配置的任务不得合并");
    assert.equal(jobs.claimNext()?.id, configB);
    jobs.complete(configA, "completed", 1, 1, "done");
    jobs.complete(configB, "completed", 1, 1, "done");

    // ⑤ 不是"更新最新分析"的载荷（CLI 自有导入）**一律不参加**：即使它有绑定。
    const cliA = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_cli_a", targetRaw: 9, targetDependency: 9, mode: CLI_OWNED_IMPORT_REQUEST_MODE
    });
    const cliB = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_cli_b", targetRaw: 10, targetDependency: 10, mode: CLI_OWNED_IMPORT_REQUEST_MODE
    });
    assert.equal(jobs.claimNext()?.id, cliA, "非直连分析语义的任务不得合并");
    assert.equal(jobs.claimNext()?.id, cliB);
  });
});

test("没有代次绑定的直连任务不参与合并（它无法被覆盖证明）", async () => {
  await withStore((store, jobs) => {
    const first = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_nb_a", targetRaw: 0, targetDependency: 0, withoutBindings: true
    });
    const second = enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "batch_nb_b", targetRaw: 0, targetDependency: 0, withoutBindings: true
    });
    assert.equal(jobs.claimNext()?.id, first, "没有绑定的任务必须单独执行");
    assert.equal(jobs.claimNext()?.id, second);
  });
});

test("覆盖任务失败：原任务留在队列、关联被释放、绝不结算（失败保留真实含义）", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_2", raw: 2, dependency: 2, bumped: 1 });
    const members = [1, 2].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `batch_${index}`, targetRaw: index, targetDependency: index
    }));
    const covering = jobs.claimNext();
    assert.ok(covering);
    jobs.fail(covering.id, new Error("Dataset changed since candidate evaluation"));

    assert.equal(jobRow(store, covering.id).status, "failed");
    for (const id of members) {
      assert.equal(jobRow(store, id).status, "queued", "分析失败不得把原任务结算成成功");
      const coverage = report(jobs, id);
      assert.equal(coverage.state, "released");
      assert.match(String(coverage.releaseReason), /covering_job_failed/);
      assert.equal(coverage.attempts, 1);
      assert.ok(jobs.listEvents(id).some((event) => String(event.phase) === "replan"),
        "原 id 上必须留下「为什么它还停在 queued」的解释");
    }
    // 释放之后必须能重新规划：下一条覆盖任务把这批重新并进来（attempts 递增）。
    const again = jobs.claimNext();
    assert.ok(again);
    assert.notEqual(again.id, covering.id, "必须是一条**新**的覆盖任务");
    for (const id of members) assert.equal(report(jobs, id).attempts, 2);
  });
});

test("防饿死（B6）：被覆盖次数达到上限的任务必须单独执行", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_2", raw: 2, dependency: 2, bumped: 1 });
    const head = enqueueDirectSyncAnalysis(store, jobs, { batchId: "batch_1", targetRaw: 1, targetDependency: 1 });
    const second = enqueueDirectSyncAnalysis(store, jobs, { batchId: "batch_2", targetRaw: 2, targetDependency: 2 });

    for (let attempt = 1; attempt <= ANALYSIS_JOB_MERGE_MAX_ATTEMPTS; attempt += 1) {
      const covering = jobs.claimNext();
      assert.ok(covering, `第 ${attempt} 次必须仍能生成覆盖任务`);
      assert.notEqual(covering.id, head);
      jobs.fail(covering.id, new Error("publication refused"));
    }
    // 🔴 再放两条**全新**（未到上限）的兼容任务 —— 这是唯一能区分"队首到上限"这一判断的场景，
    // 也是 2026-10-16 突变实测发现的盲区：只放**两条都到上限**的任务时，
    // `members` 里的 `mergeAttempts < 上限` 过滤会把它们全丢掉、`members.length < 2` 于是返回 null，
    // 所以**去掉队首判断一样是绿的**（M2 当时 20/20 全绿）。
    // 真正会饿死的情形是"队首到上限、后面还有 ≥2 条没到上限"：此时若没有队首判断，
    // 队首会被 `members` 丢掉，而后面两条凑够数去生成**新的覆盖任务**，
    // 到上限的队首就永远等不到属于自己的那一次执行。
    insertSucceededBatch(store, { id: "batch_3", raw: 3, dependency: 3, bumped: 1 });
    enqueueDirectSyncAnalysis(store, jobs, { batchId: "batch_2", targetRaw: 2, targetDependency: 2 });
    enqueueDirectSyncAnalysis(store, jobs, { batchId: "batch_3", targetRaw: 3, targetDependency: 3 });
    // 上限已到：队首那条**必须自己跑**，而不是被第三次并进一条新的覆盖任务。
    const before = Number(store.database.prepare("SELECT COUNT(*) AS n FROM recompute_jobs").get()!.n);
    const solo = jobs.claimNext();
    assert.equal(solo?.id, head, "达到合并次数上限后必须单独执行（最小调度份额）");
    assert.equal(report(jobs, head).attempts, ANALYSIS_JOB_MERGE_MAX_ATTEMPTS);
    assert.equal(
      Number(store.database.prepare("SELECT COUNT(*) AS n FROM recompute_jobs").get()!.n),
      before,
      "队首到上限时**一条覆盖任务都不许造**（造了就等于又把它并进去一次）"
    );
    // 另一条也到上限了：它同样只能单跑 —— 于是两条都会走到真结论。
    assert.equal(jobRow(store, second).status, "queued");
    jobs.complete(head, "completed", 1, 1, "done");
    assert.equal(jobs.claimNext()?.id, second, "第二条同样必须拿到属于自己的那一次执行");
  });
});

test("发布时刻依赖覆盖证明不成立 ⇒ 不结算；raw-only 批次 ⇒ 同绑定发布并结算", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_2", raw: 2, dependency: 2, bumped: 1 });

    // ① 计算期间来了一个**推依赖代次**的批次（captured=2，当前=3）⇒ 证明不成立 ⇒ 不结算。
    const blockedMembers = [1, 2].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `blocked_${index}`, targetRaw: index, targetDependency: index
    }));
    const blockedCovering = jobs.claimNext();
    assert.ok(blockedCovering);
    insertSucceededBatch(store, { id: "batch_3", raw: 3, dependency: 3, bumped: 1 });
    const blockedPublished = publishCovering(store, jobs, blockedCovering.id, {
      capturedRaw: 2, capturedDependency: 2
    });
    assert.equal(blockedPublished, true, "仓库层这里只验证结算判据；真实发布 gate 在 pipeline 里拒绝");
    for (const id of blockedMembers) {
      assert.equal(jobRow(store, id).status, "queued", "证明不成立时原任务不得被结算");
      assert.equal(report(jobs, id).state, "released");
      assert.match(String(report(jobs, id).releaseReason), /dependency_coverage_/);
    }

    // ② 计算期间只来了一个 **raw-only** 批次（不推依赖代次）⇒ D4 放行 ⇒ 同绑定发布并结算。
    const okMembers = [1, 2].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `rawonly_${index}`, targetRaw: 4, targetDependency: 3
    }));
    const okCovering = jobs.claimNext();
    assert.ok(okCovering);
    insertSucceededBatch(store, { id: "batch_4", raw: 4, dependency: 3, bumped: 0 });
    assert.equal(generations(store).dependency, 3, "前提：raw-only 批次不得推进依赖代次");
    assert.equal(publishCovering(store, jobs, okCovering.id, { capturedRaw: 4, capturedDependency: 3 }), true);
    for (const id of okMembers) {
      assert.equal(jobRow(store, id).status, "succeeded", "raw-only 批次不得阻止同绑定发布后的结算");
      assert.equal(report(jobs, id).state, "published");
    }
  });
});

test("发布记录里出现并集之外的批次 ⇒ 不结算（运行期计划被改写过，边界不再可证）", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_2", raw: 2, dependency: 2, bumped: 1 });
    const members = [1, 2].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `member_${index}`, targetRaw: index, targetDependency: index
    }));
    const covering = jobs.claimNext();
    assert.ok(covering);
    assert.equal(publishCovering(store, jobs, covering.id, {
      capturedRaw: 2, capturedDependency: 2, foreignCoverageBatchId: "legacy_batch_not_in_union"
    }), true);
    for (const id of members) {
      assert.equal(jobRow(store, id).status, "queued", "外来批次出现时不得结算");
      assert.match(String(report(jobs, id).releaseReason), /publication_included_unplanned_batches/);
    }
  });
});

test("并集计划：dirty 边界取所有成员的最早值", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_3", raw: 3, dependency: 3, bumped: 1 });
    enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "plan_a", targetRaw: 1, targetDependency: 1, dirtyFromAt: "2026-01-10T00:00:00.000Z"
    });
    enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "plan_b", targetRaw: 2, targetDependency: 2, dirtyFromAt: "2026-01-05T00:00:00.000Z"
    });
    enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "plan_c", targetRaw: 3, targetDependency: 3, dirtyFromAt: "2026-01-20T00:00:00.000Z"
    });
    const covering = jobs.claimNext();
    assert.ok(covering);
    const plan = (covering.request as { incrementalPlan?: { dirtyFromAt?: string } }).incrementalPlan;
    assert.equal(plan?.dirtyFromAt, "2026-01-05T00:00:00.000Z", "dirty 边界必须取最早的成员边界");
  });
});

test("并集计划：成员里有全量任务 ⇒ 覆盖任务必须全量（不写 incrementalPlan）", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_2", raw: 2, dependency: 2, bumped: 1 });
    enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "plan_partial", targetRaw: 1, targetDependency: 1, dirtyFromAt: "2026-02-01T00:00:00.000Z"
    });
    enqueueDirectSyncAnalysis(store, jobs, {
      batchId: "plan_full", targetRaw: 2, targetDependency: 2
    });
    const covering = jobs.claimNext();
    assert.ok(covering);
    assert.equal(
      (covering.request as { incrementalPlan?: unknown }).incrementalPlan,
      undefined,
      "任一边界不可知（全量成员）⇒ 并集必须全量：只重算一段会错复用"
    );
  });
});

test("证据批的选择：并集里有删除 ⇒ 单批证据必须落在有删除的那一批上", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "clean_a", raw: 1, dependency: 1, bumped: 1 });
    insertSucceededBatch(store, { id: "clean_b", raw: 2, dependency: 2, bumped: 1 });
    enqueueDirectSyncAnalysis(store, jobs, { batchId: "clean_a", targetRaw: 1, targetDependency: 1 });
    enqueueDirectSyncAnalysis(store, jobs, { batchId: "clean_b", targetRaw: 2, targetDependency: 2 });
    // 其中一批真的删过东西（发布 gate 会用这一条决定"能不能按纯回填放行"）。
    store.database.prepare(`
      INSERT INTO import_entity_changes (batch_id, entity_kind, entity_id, change_type)
      VALUES ('clean_b', 'record', 'record_deleted', 'removed')
    `).run();
    store.database.prepare(`
      INSERT INTO import_entity_tombstones (entity_kind, entity_id, batch_id, deleted_at)
      VALUES ('record', 'record_deleted', 'clean_b', '2026-01-02T00:00:00.000Z')
    `).run();

    const covering = jobs.claimNext();
    assert.ok(covering);
    assert.equal(
      (covering.request as { importBatchId?: string }).importBatchId,
      "clean_b",
      "并集里有删除时，喂给现有 gate 的单批证据必须落在**有删除**的那一批上（否则删除会被藏起来）"
    );
    // 并集本身也必须落库（诊断 + 核对），且覆盖任务仍带着全部批次。
    assert.deepEqual(
      [...(covering.request as { importBatchIds: string[] }).importBatchIds].sort(),
      ["clean_a", "clean_b"]
    );
  });
});

test("v42 迁移：关联表存在、状态取值受 CHECK 约束、冻结校验和已钉", async () => {
  await withStore((store, jobs) => {
    const columns = (store.database.prepare("PRAGMA table_info(analysis_job_merges)").all() as unknown as
      Array<{ name: string }>).map((row) => row.name);
    for (const column of ["covered_job_id", "covering_job_id", "state", "attempts", "evidence_json"]) {
      assert.ok(columns.includes(column), `v42 关联表缺列：${column}`);
    }
    // 三种状态是**枚举**，不是自由文本：写错值必须被库拒绝。
    assert.throws(() => {
      store.database.prepare(`
        INSERT INTO analysis_job_merges (
          covered_job_id, covering_job_id, state, scope, import_batch_id,
          covered_target_raw_generation, covered_target_dependency_generation,
          union_batch_ids_json, evidence_json
        ) VALUES ('missing_a', 'missing_b', 'superseded', 'direct-sync', 'b', 0, 0, '[]', '{}')
      `).run();
    }, /CHECK constraint failed|FOREIGN KEY constraint failed/i);
    // `recompute_jobs.status` 的 CHECK **没有**被放宽（v35 的硬约束）。
    assert.throws(() => {
      store.database.prepare(`
        INSERT INTO recompute_jobs (id, job_type, status, request_json, progress_phase)
        VALUES ('probe_status', 'import', 'superseded', '{}', 'queued')
      `).run();
    }, /CHECK constraint failed/i);
    assert.equal(jobs.coveringReport("does_not_exist"), null);
  });
});

test("合并规模与时间窗上限（B6）：成员数与成员时刻跨度都必须有界", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_n", raw: 40, dependency: 40, bumped: 1 });
    // ① 成员数上限：33 条排队 ⇒ 覆盖任务至多并 32 条，剩下那条留给下一次合并。
    const ids = Array.from({ length: 33 }, (_unused, index) =>
      enqueueDirectSyncAnalysis(store, jobs, {
        batchId: `bulk_${index}`, targetRaw: index + 1, targetDependency: index + 1
      })
    );
    const covering = jobs.claimNext();
    assert.ok(covering);
    const merged = (covering.request as { mergedFromJobIds: string[] }).mergedFromJobIds;
    assert.equal(merged.length, ANALYSIS_JOB_MERGE_MAX_MEMBERS, "一次合并的成员数必须有上限");
    const leftBehind = ids.filter((id) => !merged.includes(id));
    assert.equal(leftBehind.length, 1, "超出上限的那条必须留在队列里等下一次合并，而不是被丢掉");
    assert.equal(jobs.coveringReport(leftBehind[0]!), null, "超出上限的那条这一轮**没有**关联");
    assert.equal(jobRow(store, leftBehind[0]!).status, "queued", "它必须仍然可被领取");
    jobs.fail(covering.id, new Error("stop"));
  });

  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_span", raw: 2, dependency: 2, bumped: 1 });
    // ② 时刻跨度上限：第二条比队首晚了超过 MAX_SPAN ⇒ 不并进同一次覆盖任务。
    const head = enqueueDirectSyncAnalysis(store, jobs, { batchId: "span_a", targetRaw: 1, targetDependency: 1 });
    enqueueDirectSyncAnalysis(store, jobs, { batchId: "span_b", targetRaw: 2, targetDependency: 2 });
    store.database.prepare(
      "UPDATE recompute_jobs SET created_at = ? WHERE id != ?"
    ).run(new Date(Date.parse(new Date().toISOString()) + ANALYSIS_JOB_MERGE_MAX_SPAN_MS + 60_000).toISOString(), head);
    assert.equal(jobs.claimNext()?.id, head,
      "跨度超限的成员不得共用一次合并（年龄上限）；队首必须立刻拿到自己的那次执行");
  });
});

test("结算判据：发布绑定落后于成员目标代次 ⇒ 不结算", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_3", raw: 3, dependency: 3, bumped: 1 });
    // 两条成员的目标代次比"发布绑定捕获到的代次"更大（计数器被重建过/登记与发布错位）。
    const members = [5, 5].map((target, index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `behind_${index}`, targetRaw: target, targetDependency: target
    }));
    const covering = jobs.claimNext();
    assert.ok(covering);
    assert.equal(covering.targetDependencyGeneration, 5, "前提：覆盖任务承诺的是成员里最新的目标代次");
    assert.equal(publishCovering(store, jobs, covering.id, { capturedRaw: 3, capturedDependency: 3 }), true);
    for (const id of members) {
      assert.equal(jobRow(store, id).status, "queued", "绑定捕获的代次落后于成员目标 ⇒ 不得结算");
      assert.match(String(report(jobs, id).releaseReason), /captured_dependency_behind|captured_raw_behind/);
    }
  });
});

test("结算判据：raw 代次落后而依赖代次够 ⇒ 同样不结算（两个方向都要各自成立）", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_3", raw: 3, dependency: 3, bumped: 1 });
    // 非对称：raw 目标 5 > 捕获的 3，而依赖目标 2 ≤ 捕获的 3。
    // 这样只有"raw 代次包含"这条判据能拦住结算（删掉它这条用例必红）。
    const members = [0, 1].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `raw_behind_${index}`, targetRaw: 5, targetDependency: 2
    }));
    const covering = jobs.claimNext();
    assert.ok(covering);
    assert.equal(covering.targetRawGeneration, 5);
    assert.equal(covering.targetDependencyGeneration, 3);
    assert.equal(publishCovering(store, jobs, covering.id, { capturedRaw: 3, capturedDependency: 3 }), true);
    for (const id of members) {
      assert.equal(jobRow(store, id).status, "queued", "raw 代次没被发布覆盖 ⇒ 不得结算");
      assert.match(String(report(jobs, id).releaseReason), /captured_raw_behind/);
    }
  });
});

test("结算判据：合并边界晚于成员边界 ⇒ 不结算（脏范围可能没被覆盖）", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_2", raw: 2, dependency: 2, bumped: 1 });
    const members = [1, 2].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `dirty_${index}`, targetRaw: index, targetDependency: index,
      dirtyFromAt: `2026-03-0${index}T00:00:00.000Z`
    }));
    const covering = jobs.claimNext();
    assert.ok(covering);
    // 模拟"关联行由更早/别的实现写下、边界比成员更晚"的持久状态。
    store.database.prepare(`
      UPDATE analysis_job_merges SET merged_dirty_from_at = '2026-03-09T00:00:00.000Z'
      WHERE covered_job_id = ?
    `).run(members[1]!);
    assert.equal(publishCovering(store, jobs, covering.id, { capturedRaw: 2, capturedDependency: 2 }), true);
    assert.equal(jobRow(store, members[1]!).status, "queued", "边界晚于成员的合并不得结算该成员");
    assert.match(String(report(jobs, members[1]!).releaseReason), /merged_dirty_range_later_than_covered/);
  });
});

test("取消覆盖任务：被覆盖任务被释放、可重新规划（不会永远等一个已取消的任务）", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_2", raw: 2, dependency: 2, bumped: 1 });
    const members = [1, 2].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `cancel_${index}`, targetRaw: index, targetDependency: index
    }));
    const covering = jobs.claimNext();
    assert.ok(covering);
    assert.equal(jobs.requestCancellation(covering.id).outcome, "cancellation_requested");
    assert.equal(jobs.cancelIfRequested(covering.id), true, "取消请求必须真的把任务停掉");
    for (const id of members) {
      assert.equal(jobRow(store, id).status, "queued", "取消不是成功");
      assert.equal(report(jobs, id).state, "released");
      assert.match(String(report(jobs, id).releaseReason), /covering_job_cancelled/);
    }
    assert.ok(jobs.claimNext(), "释放之后必须能重新规划（不能卡在 pending 里）");
  });
});

test("队列里被取消的覆盖任务同样释放成员；被取消的成员不会在发布时被改写", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_2", raw: 2, dependency: 2, bumped: 1 });
    const members = [1, 2].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `queued_cancel_${index}`, targetRaw: index, targetDependency: index
    }));
    // 手工造一条 **queued** 的覆盖任务 + 关联（覆盖"队列里被取消"的路径）。
    store.database.prepare(`
      INSERT INTO recompute_jobs (id, job_type, status, request_json, progress_phase, created_at)
      VALUES ('covering_queued', 'import', 'queued',
        '{"mode":"direct_sync_analysis","importBatchId":"queued_cancel_1"}', 'queued', '2026-01-01T00:00:00.000Z')
    `).run();
    for (const id of members) {
      store.database.prepare(`
        INSERT INTO analysis_job_merges (
          covered_job_id, covering_job_id, state, scope, import_batch_id,
          covered_target_raw_generation, covered_target_dependency_generation,
          union_batch_ids_json, evidence_json
        ) VALUES (?, 'covering_queued', 'pending', 'direct-sync', 'queued_cancel_1', 1, 1, '[]', '{}')
      `).run(id);
    }
    assert.equal(jobs.requestCancellation("covering_queued").outcome, "cancelled");
    for (const id of members) assert.equal(report(jobs, id).state, "released");
  });
});

test("合并之后被取消的成员：关联被释放，发布也不得改写它", async () => {
  await withStore((store, jobs) => {
    insertSucceededBatch(store, { id: "batch_2", raw: 2, dependency: 2, bumped: 1 });
    const members = [1, 2].map((index) => enqueueDirectSyncAnalysis(store, jobs, {
      batchId: `late_cancel_${index}`, targetRaw: index, targetDependency: index
    }));
    const covering = jobs.claimNext();
    assert.ok(covering);
    // ① 用户在分析进行中取消了这一批的分析：关联必须立刻释放（它是终态，不是覆盖态）。
    assert.equal(jobs.requestCancellation(members[0]!).outcome, "cancelled");
    assert.equal(report(jobs, members[0]!).state, "released");
    // ② 另一条被**别的路径**置成终态（这里直接用 SQL 模拟"另一个执行者改了状态"），
    //    关联仍是 pending ⇒ 发布时的结算必须放过它、并且释放关联。
    store.database.prepare("UPDATE recompute_jobs SET status = 'failed' WHERE id = ?").run(members[1]!);
    assert.equal(publishCovering(store, jobs, covering.id, { capturedRaw: 2, capturedDependency: 2 }), true);
    assert.equal(jobRow(store, members[0]!).status, "cancelled", "已取消的成员不得被结算改写");
    assert.equal(jobRow(store, members[1]!).status, "failed", "已失败的成员不得被结算改写成成功");
    assert.equal(report(jobs, members[1]!).state, "released");
    assert.match(String(report(jobs, members[1]!).releaseReason), /covered_job_not_queued/);
  });
});
