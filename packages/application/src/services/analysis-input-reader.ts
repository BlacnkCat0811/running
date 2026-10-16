import type { DatabaseSync } from "node:sqlite";

import { loadDirtyRangeInput, planIncrementalAnalysisDirtyRange, type AnalysisDirtyDomains } from "@rai/health-export-parser";

import {
  analysisInputDigest,
  dependencyCoverageHolds,
  selectInterveningBatches,
  type AnalysisInputBinding,
  type BatchGenerationFacts,
  type DependencyCoverageVerdict
} from "../analysis-input-binding.js";
import {
  DEFAULT_ANALYSIS_INPUT_BUDGET,
  SnapshotFactView,
  SegmentedFactView,
  materializeFactSnapshot,
  probeFactSize,
  readFactViewGenerations,
  type AnalysisFactView,
  type AnalysisInputBudget,
  type FactViewGenerations
} from "./analysis-fact-view.js";

/**
 * 分析**输入读取器**：在一个只读连接的同一个读事务里捕获"这次算的是哪一版输入"
 * （O06-A / WP-22）。
 *
 * ## 为什么用独立的只读连接，而不是复用写入连接
 *
 * 分析写在 worker 线程里、经写租约代理受"单写者"约束；它的连接随时可能在两段写之间
 * 让路（`yieldIfStale`）。用那条连接读"输入是哪一版"，读到的东西会被并发批次改动 ——
 * 那正是 O06 的病灶。独立只读连接上的**一个 `BEGIN DEFERRED` 读事务**给出的是
 * WAL 下的一致快照：绑定与账本证据在同一个时间点上自洽。
 *
 * ⛔ 本类**只读**：不写任何表、不开写事务、不迁移。捕获完立刻关闭读事务，
 * 于是它既不会长时间持锁，也不会让 WAL 无限增长。
 *
 * ## 账本缺口 ⇒ 不允许安全前缀复用
 *
 * 捕获代次可能**已经超过**任务登记时的目标代次（分析还没跑，下一批就到了）。这时
 * 单批 dirty 已经不代表实际输入，必须把"已覆盖代次之后、捕获代次之前"的账本一起并进来。
 * 合并不完整时（路线证据、历史批次的代次未知）**退回全量**并给出原因码 —— 宁可多算，
 * 不可错复用。这是审查文档 §4-O06 步骤 2 与决策 D4 的共同要求。
 */
export interface AnalysisInputCaptureRequest {
  runId: string;
  jobId: string;
  scope: string;
  timezoneIdentifier: string;
  evaluatedAt: string;
  /** 任务登记时写下的目标代次（老任务为 null = 不承诺）。 */
  targetRawGeneration: number | null;
  targetDependencyGeneration: number | null;
  /** 任务登记时写下的预期 incumbent。 */
  expectedIncumbentReleaseId: string | null;
  /** 登记时按**本批**算出的计划；捕获时代次未前进就沿用它。 */
  registeredPlan: { dirtyFromAt: string; domains: AnalysisDirtyDomains } | null;
  /**
   * 步骤 5 的漂移重排：把**这个 raw 代次之后**的全部账本并进本次计划。
   *
   * 缺省 / `null` = 用本次捕获到的代次（"之后"是空集，行为与 WP-22a 逐字节相同）；
   * 漂移重排时传**漂移前捕获的 raw 代次**，于是新计划覆盖新批次弄脏的范围，
   * 而不是只算登记时那一个单批。
   */
  mergeFromRawGeneration?: number | null;
}

export interface AnalysisInputCapture {
  binding: AnalysisInputBinding;
  coverage: DependencyCoverageVerdict;
  /** 本次实际应执行的计划；`null` = 全量重算。 */
  plan: { dirtyFromAt: string; domains: AnalysisDirtyDomains } | null;
  /** 计划被调整过时的机器可读原因（`coverage_merged` / `coverage_gap` / `route_evidence_unmerged`）。 */
  planAdjustment: string | null;
  /**
   * 本次捕获额外并进来的批次（代次前进时把它们的账本一起算了）。
   * 调用方还会把它自己的那一批并进来，一起写 `analysis_job_coverage`。
   */
  mergedBatchIds: string[];
  /**
   * **固定输入**（O06-A 步骤 3–5）：本次计算的事实只能从这里读。
   *
   * 物化模式（小任务）：绑定与全部事实在**同一个读事务**里取出，事务随即关闭；
   * 分段模式（超过预算）：不建整库快照，逐条读各自一个短读事务，且每条读都在同一事务里
   * 核对代次 —— 代次一变就抛 `AnalysisInputDriftError`，由调用方作废候选并重排。
   */
  facts: AnalysisFactView;
  /** 物化证据：模式、行/字节与原因码（`null` = 未降级）。写进任务事件，便于事后审计"这一版算的是什么"。 */
  materialization: {
    mode: "materialized" | "segmented";
    rows: number;
    bytes: number;
    reason: string | null;
    tables: number;
  };
}

/** 读取器接口：pipeline 只依赖这个形状，注入点在 worker 线程里（那里允许开连接）。 */
export interface AnalysisInputSource {
  capture(request: AnalysisInputCaptureRequest, budget?: AnalysisInputBudget): AnalysisInputCapture;
}

interface ManifestRow { value: string }

export class SqliteAnalysisInputReader implements AnalysisInputSource {
  constructor(
    private readonly database: DatabaseSync,
    private readonly scope = "direct-sync",
    private readonly budget: AnalysisInputBudget = DEFAULT_ANALYSIS_INPUT_BUDGET
  ) {}

  capture(
    request: AnalysisInputCaptureRequest,
    budget: AnalysisInputBudget = this.budget
  ): AnalysisInputCapture {
    // 🔴 一个读事务读完所有证据：绑定、账本**与这次要算的事实**必须来自**同一个**时间点，
    // 否则"捕获代次"与"实际读到的输入"可能互相矛盾（前者读到了后者还没落库的状态）。
    // 步骤 3–4（WP-22b）把事实也搬进这个事务 —— 事务一关，CPU 阶段就没有任何读事务开着。
    this.database.exec("BEGIN DEFERRED");
    try {
      const generations = readFactViewGenerations(this.database);
      const datasetVersion = manifestValue(this.database, "dataset_version") ?? "dataset_unknown";
      const incumbent = this.database.prepare(
        "SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1"
      ).get() as { modelRunId: string } | undefined;
      const overrideDigest = overrideSnapshotDigest(this.database);
      const configDigest = settingsDigest(this.database);
      // 🔴 `id AS batchId` 不是排版偏好：`selectInterveningBatches` 的返回类型是
      // `BatchGenerationFacts`（字段名 `batchId`），少了这个别名，合并路径会把 `undefined`
      // 绑进 `loadDirtyRangeInput` 的 `IN (...)`，于是"代次前进了"这条路径**崩在 SQL 绑定**
      // 而不是给出计划 —— 账本缺口本该有一条显式原因，不是异常栈。
      const batches = this.database.prepare(`
        SELECT id AS batchId, raw_generation AS rawGeneration, dependency_generation AS dependencyGeneration,
               dependency_bumped AS dependencyBumped, summary_json AS summaryJson
        FROM import_batches
        WHERE status = 'succeeded'
        ORDER BY COALESCE(raw_generation, 0), created_at, id
      `).all() as unknown as Array<BatchGenerationFacts & { summaryJson: string | null }>;

      const capturedRaw = generations.raw;
      const capturedDependency = generations.dependency;
      // 合并起点：缺省就是捕获到的 raw 代次（空集）；漂移重排时是漂移**前**那一代。
      const mergeFromRaw = request.mergeFromRawGeneration ?? capturedRaw;
      const intervening = selectInterveningBatches(batches, mergeFromRaw);
      const coverage = dependencyCoverageHolds({
        capturedRawGeneration: capturedRaw,
        capturedDependencyGeneration: capturedDependency,
        currentRawGeneration: capturedRaw,
        currentDependencyGeneration: capturedDependency,
        interveningBatches: intervening
      });

      const binding: AnalysisInputBinding = {
        runId: request.runId,
        jobId: request.jobId,
        scope: this.scope,
        datasetVersion,
        capturedRawGeneration: capturedRaw,
        capturedDependencyGeneration: capturedDependency,
        targetRawGeneration: request.targetRawGeneration,
        targetDependencyGeneration: request.targetDependencyGeneration,
        incumbentReleaseId: incumbent?.modelRunId ?? null,
        timezoneIdentifier: request.timezoneIdentifier,
        overrideDigest,
        configDigest,
        cutoffAt: request.evaluatedAt,
        createdAt: new Date().toISOString(),
        inputDigest: ""
      };
      binding.inputDigest = analysisInputDigest(binding);

      // ---- 步骤 4：在**同一个读事务**里把事实拿出来（或明确拒绝物化） ----
      const { facts, materialization } = this.materialize(capturedRaw, capturedDependency, budget);
      const evidence = { facts, materialization };

      // 代次没有前进 ⇒ 登记时的单批计划就是全部（最常见路径，也是 D4 生效的路径）。
      // 漂移重排（显式给了合并起点）时，只要真的存在要并进来的批次就走合并路径 —— 否则
      // "raw-only 批次把事实改了但依赖代次没动"会被读成"没有新 dirty"，而那正是错复用。
      const advanced = intervening.length > 0
        || (request.targetDependencyGeneration !== null
          && capturedDependency > request.targetDependencyGeneration);
      if (!advanced) {
        return { binding, coverage, plan: request.registeredPlan, planAdjustment: null, mergedBatchIds: [], ...evidence };
      }

      // 代次前进了：把"目标代次之后、捕获代次之前"的批次账本并进来重算计划。
      const uncovered = intervening.filter((batch) => {
        const facts = batch as BatchGenerationFacts & { summaryJson: string | null };
        if (facts.dependencyBumped === null || facts.dependencyBumped === undefined) return true;
        return facts.dependencyBumped !== 0
          || (facts.dependencyGeneration ?? 0) > (request.targetDependencyGeneration ?? 0);
      });
      const routeEvidence = uncovered.some((batch) => {
        const raw = (batch as { summaryJson?: string | null }).summaryJson;
        if (typeof raw !== "string") return false;
        try {
          const parsed = JSON.parse(raw) as { routes?: { importedRouteCount?: unknown } };
          return Number(parsed.routes?.importedRouteCount ?? 0) > 0;
        } catch {
          return true; // 解不开的摘要按"证据不完整"处理（保守方向）。
        }
      });
      if (routeEvidence) {
        // 路线证据没法从账本重建（账本不记路线），合并出来会漏掉路线-only 更正 ⇒ 全量。
        return { binding, coverage, plan: null, planAdjustment: "route_evidence_unmerged", mergedBatchIds: [], ...evidence };
      }
      const merged = planIncrementalAnalysisDirtyRange(loadDirtyRangeInput(
        this.database, uncovered.map((batch) => batch.batchId), [], []
      ));
      if (merged.full || merged.dirtyFromAt === null) {
        return { binding, coverage, plan: null, planAdjustment: "coverage_gap", mergedBatchIds: [], ...evidence };
      }
      return {
        binding,
        coverage,
        plan: { dirtyFromAt: merged.dirtyFromAt, domains: merged.domains },
        planAdjustment: "coverage_merged",
        mergedBatchIds: uncovered.map((batch) => batch.batchId),
        ...evidence
      };
    } finally {
      this.database.exec("COMMIT");
    }
  }

  /**
   * 事实物化（O06-A 步骤 4）：预算内 ⇒ 同一个读事务里整份复制进内存快照，随后事务关闭；
   * 超预算 ⇒ **不**退化成无限读，转 {@link SegmentedFactView} 的分段校验读。
   *
   * ⛔ 预算不够时**不能**"先关掉这个快照、再去读最新一段拼上"：分段模式每条读都自带代次核对，
   * 一旦观察到别的代次就抛 `AnalysisInputDriftError`，由 pipeline 作废候选并重排。
   */
  private materialize(
    capturedRaw: number,
    capturedDependency: number,
    budget: AnalysisInputBudget
  ): {
    facts: AnalysisFactView;
    materialization: AnalysisInputCapture["materialization"];
  } {
    const probe = probeFactSize(this.database);
    const overRows = probe.rows > budget.maxRows;
    const overBytes = probe.bytes > budget.maxBytes;
    if (!overRows && !overBytes) {
      const snapshot = materializeFactSnapshot(this.database);
      return {
        facts: new SnapshotFactView(
          snapshot.database, snapshot.rows, snapshot.bytes,
          () => readFactViewGenerations(this.database)
        ),
        materialization: {
          mode: "materialized", rows: snapshot.rows, bytes: snapshot.bytes, reason: null, tables: probe.tables
        }
      };
    }
    const captured: FactViewGenerations = { raw: capturedRaw, dependency: capturedDependency };
    return {
      facts: new SegmentedFactView(this.database, captured, budget),
      materialization: {
        mode: "segmented",
        rows: probe.rows,
        bytes: probe.bytes,
        reason: overRows ? "fact_rows_exceed_budget" : "fact_bytes_exceed_budget",
        tables: probe.tables
      }
    };
  }
}

/**
 * `import_generations` 的读取已下沉到 `analysis-fact-view.ts`（分段视图每条读都要用同一口径
 * 核对代次，两处实现必然漂移）。这里只保留 manifest 读取。
 */
function manifestValue(database: DatabaseSync, key: string): string | null {
  const row = database.prepare("SELECT value FROM import_manifest WHERE key = ?").get(key) as ManifestRow | undefined;
  return row?.value ?? null;
}

/**
 * override 摘要：与发布判据用的口径**同源**（`verifyAndPoint` 校验的是
 * `effective_workout_overrides` 的有序 id 集合）。这里只是把它读出来做绑定，
 * 真正的比较仍在发布短事务里做。
 */
function overrideSnapshotDigest(database: DatabaseSync): string {
  const ids = database.prepare(
    "SELECT id FROM effective_workout_overrides ORDER BY training_session_id"
  ).all().map((row) => String((row as { id: string }).id));
  return ids.join("\u0001");
}

/** 分区设置摘要：设置一变，历史分区/负荷就不再可复用。 */
function settingsDigest(database: DatabaseSync): string {
  const exists = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='training_zone_profile_settings'"
  ).get();
  if (!exists) return "";
  const rows = database.prepare(
    "SELECT id, revision FROM training_zone_profile_settings ORDER BY effective_from_local_date, id"
  ).all().map((row) => {
    const item = row as { id: string; revision: number };
    return `${item.id}:${item.revision}`;
  });
  return rows.join("\u0001");
}
