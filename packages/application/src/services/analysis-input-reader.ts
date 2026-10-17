import type { DatabaseSync } from "node:sqlite";

import { workoutTypes } from "@rai/contracts";

import {
  loadDirtyRangeInput,
  mergeDirtyPlans,
  parseBatchAnalysisDirtyEvidence,
  planIncrementalAnalysisDirtyRange,
  type AnalysisDirtyDomains,
  type AnalysisDirtyPlan
} from "@rai/health-export-parser";

import {
  analysisInputDigest,
  dependencyCoverageHolds,
  selectInterveningBatches,
  type AnalysisInputBinding,
  type BatchGenerationFacts,
  type DependencyCoverageVerdict
} from "../analysis-input-binding.js";
// 会话口径必须是**同一个常量**（`listActiveForFeatures` 用的就是它）：路线点裁剪的
// session 子查询要与"哪些会话会被算"逐字一致，抄一份字面量就是下一次静默分叉。
import { runningType } from "../service-types.js";
import {
  DEFAULT_ANALYSIS_INPUT_BUDGET,
  PINNED_FACT_VIEWS,
  RECORDS_MAX_LOOKBACK_MS,
  SNAPSHOT_TABLES,
  SegmentedFactView,
  SnapshotFactView,
  buildFactTableFilters,
  materializeFactSnapshot,
  probeFactSize,
  readFactViewGenerations,
  type AnalysisFactView,
  type AnalysisInputBudget,
  type FactPruneCoverage,
  type FactTableFilters,
  type FactViewGenerations,
  type SnapshotCoverage
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
   * 登记/合并时声明的批次清单（"原任务未发布范围"的批次证据）。
   *
   * 单任务 = 它自己的 `importBatchId`；合并任务 = 成员并集（`importBatchIds`）。
   * 用途有两个，都在发布证据链上：
   * 1. 无可信基线（兼容路径）时判断"库里还有没有没被任何途径覆盖的影响批次"；
   * 2. 写 `analysis_job_coverage` —— 执行实际覆盖批次 = required ∪ 本清单。
   */
  registeredBatchIds?: readonly string[];
  /**
   * 步骤 5 的漂移重排：把**这个 raw 代次之后**的全部账本并进本次计划。
   *
   * 缺省 / `null` = 用本次捕获到的代次（"之后"是空集，行为与 WP-22a 逐字节相同）；
   * 漂移重排时传**漂移前捕获的 raw 代次**，于是新计划覆盖新批次弄脏的范围，
   * 而不是只算登记时那一个单批。
   *
   * ⚠️ 这是**兼容路径**（无可信基线）的合并起点。可信基线存在时计划由基线起算
   * （见 {@link CoverageBase}），本字段不再承担语义。
   */
  mergeFromRawGeneration?: number | null;
  /**
   * R06 内部兜底：**禁用事实裁剪**（全量物化）。
   *
   * 只由 `runDirectSyncAnalysis` 的覆盖守卫回退路径使用（越界 ⇒ 关闭裁剪重捕获一次）；
   * 不是给调用方的性能开关（默认不裁会让大库每次都物化全史）。测试也用它构造对照。
   */
  disableFactPruning?: boolean;
  /**
   * 诊断：**禁用批次读取的代次下界**（退回全读）。
   *
   * 只用于等价性回归：两种读法必须给出同一个 `plan` / `coverage` / `mergedBatchIds`，
   * 下界只改变"读了多少行"。生产不传。
   */
  disableBatchFloor?: boolean;
}

/**
 * 执行覆盖证据（B04，版本化）。
 *
 * 为什么必须带 `version` 与 `mode`：SQL 里"没有值（NULL）"只能有一种含义。旧形态用它
 * 同时表示"全量重算 ⇒ 覆盖一切"与"这份绑定没有证据"，结算方无法区分，于是新老行只能
 * 共用最宽松的判据。版本化之后：
 *   * `NULL` = 证据缺失（v44 之前的绑定行）⇒ 结算方退回旧判据；
 *   * 有值且 `version === 1` = 本次执行到底算了什么（`rebuild` 明确覆盖一切）；
 *   * 有值但版本/形状不认识 ⇒ **失败关闭**，绝不按缺省放行。
 */
export interface ExecutedPlanEvidence {
  version: 1;
  mode: "partial" | "rebuild";
  /** `mode: "rebuild"` 时恒 `null`（不是"未知"——是"覆盖一切"）。 */
  dirtyFromAt: string | null;
  /** 逐域边界；`null` 域 = 该域全算。`rebuild` 时三项都是 `null`。 */
  domains: { features: string | null; fitness: string | null; readiness: string | null };
}

/**
 * 登记成员超过这个数量时放弃下推下界、退回全读。
 *
 * 下界的 SQL 形态是 `id IN (?,?,…)`，参数个数必须可控（旧版 SQLite 的上限是 999）。
 * 合并任务真的登记了这么多成员时，说明它在合并一大段历史 —— 全读更简单也更安全。
 */
const MAX_REGISTERED_BATCHES_FOR_FLOOR = 500;

export interface AnalysisInputCapture {
  binding: AnalysisInputBinding;
  coverage: DependencyCoverageVerdict;
  /**
   * 本次批次账本的**读取范围**（诊断用，不进入 `binding.inputDigest`）。
   *
   * `floor = null` 表示"兼容路径，必须全读"；否则 SQL 只取 `raw_generation > floor`
   * 或登记成员的批次。没有这个字段，"下推下界是否真的生效"只能靠读代码猜 ——
   * 一个把下界写错成 `null` 的改动不会让任何结果变化，直到批次表长到足够大。
   */
  batchScan: { scanned: number; floor: number | null };
  /** 本次实际应执行的计划；`null` = 全量重算。 */
  plan: { dirtyFromAt: string; domains: AnalysisDirtyDomains } | null;
  /** 计划被调整过时的机器可读原因（`coverage_merged` / `coverage_gap` / `route_evidence_unmerged` / `coverage_unverifiable`）。 */
  planAdjustment: string | null;
  /**
   * 本次捕获额外并进来的批次（代次前进时把它们的账本一起算了）。
   * 调用方还会把它自己的那一批并进来，一起写 `analysis_job_coverage`。
   */
  mergedBatchIds: string[];
  /**
   * 执行覆盖证据（R02 + B04）：本次执行**实际覆盖**的范围。
   *
   * 供发布事务持久化（`analysis_run_input_bindings.executed_plan_json`）——
   * 结算方据此验证"成员登记边界确实被执行范围覆盖"，而不是只看调度成员清单。
   *
   * 🔴 B04（2026-10-17）：**计算模式与覆盖清单必须独立**。旧形态用 `null` 同时表示
   * "全量重算（覆盖一切）"和"没有这份证据"，于是 rebuild 与"缺证据"在数据库里长得一样。
   * 现在每次捕获都写一份**版本化**证据：
   * - `mode: "partial"` ⇒ `dirtyFromAt` / `domains` 是真实边界，逐域核验；
   * - `mode: "rebuild"` ⇒ 执行范围覆盖一切，边界字段为 `null`（不是"未知"）。
   */
  executedPlan: ExecutedPlanEvidence;
  /**
   * 可信基线（R05/F30）：当前 active release 的输入绑定所记录的捕获代次。
   *
   * `null` = 没有绑定行（v39 之前的老发布 / CLI 直接发布 / 从未发布）。
   * 复用判据读它：**只有从可信基线起算的计划才允许复用前序 checkpoint 前缀** ——
   * 没有它，"父发布到当前之间没有未处理影响"就没有证据载体。
   */
  coverageBase: { raw: number; dependency: number } | null;
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
    /**
     * R06：预算探针是否保住了精确值。`false` = 探针在行数超限时**提前停**（rows/tables
     * 是已扫描的下界、bytes 只含行开销）；这两种情况下调用方必然走分段读，下界足以判定。
     */
    bytesExact: boolean;
    reason: string | null;
    tables: number;
    /**
     * R06：本次事实裁剪的覆盖边界（缺省 / `null` = 未裁剪 —— 全量计划、禁用裁剪或分段读）。
     *
     * 写进 `input_materialization` 事件，作为"这一版输入**没**包含哪些行"的持久证据：
     * 事后追一个数字对不上时，第一件事就是看当时裁到哪。
     */
    pruning?: { recordsFrom: string; routeFrom: string } | null;
  };
}

/** 读取器接口：pipeline 只依赖这个形状，注入点在 worker 线程里（那里允许开连接）。 */
export interface AnalysisInputSource {
  capture(request: AnalysisInputCaptureRequest, budget?: AnalysisInputBudget): AnalysisInputCapture;
}

interface ManifestRow { value: string }

/** 覆盖计划生成的输出：计划本体 + 调整原因 + 本次真正并入计划的批次（写覆盖证据用）。 */
interface PlannedCoverage {
  plan: { dirtyFromAt: string; domains: AnalysisDirtyDomains } | null;
  planAdjustment: string | null;
  mergedBatchIds: string[];
}

/** 批次行（代次足迹 + 覆盖计划要读的摘要与 B05 的持久证据）。 */
type BatchWithSummary = BatchGenerationFacts & {
  summaryJson: string | null;
  /** v45 `import_batches.analysis_dirty_plan_json`；`null` = 老批次 / 该批不影响分析。 */
  dirtyEvidenceJson: string | null;
};

/**
 * 这个批次**有没有可能动过分析输入**（`dependency_bumped` 的三值语义）：
 * `null`（v39 前历史行）= 未知 ⇒ 保守当作"可能动过"；`0` = 只推了 raw
 * （record-only 车道按构造不含评分输入）⇒ 安全排除；其余 = 动过。
 */
function affectsAnalysis(batch: BatchGenerationFacts): boolean {
  if (batch.dependencyBumped === null || batch.dependencyBumped === undefined) return true;
  return batch.dependencyBumped !== 0;
}

/** 批次**认领**了这次依赖代次移动（非 null 且非 0 的显式声明）。 */
function isDependencyClaimant(batch: BatchGenerationFacts): boolean {
  return batch.dependencyBumped !== null && batch.dependencyBumped !== undefined &&
    batch.dependencyBumped !== 0;
}

/** 批次的路线证据（账本不记路线；有它 ⇒ 合并计划无法重建 ⇒ 保守全量）。解不开按"证据不完整"。 */
function batchHasRouteEvidence(batch: { summaryJson?: string | null }): boolean {
  const raw = batch.summaryJson;
  if (typeof raw !== "string") return false;
  try {
    const parsed = JSON.parse(raw) as { routes?: { importedRouteCount?: unknown } };
    return Number(parsed.routes?.importedRouteCount ?? 0) > 0;
  } catch {
    return true;
  }
}

/**
 * B05：这一批**是否必须靠持久 dirty 证据**才能安全并入计划。
 *
 * 只有在"计划真的重建不出来"时才算 —— 这个区分决定了失败原因码：
 * `route_evidence_unmerged`（路线证据缺/坏）与 `coverage_gap`（账本本身有缺口）
 * 是两种不同的成本，混成一个码就没人知道该补哪一边。
 *
 * - `ok`：`full`（本批不可增量）或真的改过路线（证据里的合成条目非空）⇒ 必须；
 * - `invalid`：证据损坏 ⇒ 必须走证据路径，而它不可用 ⇒ 全量；
 * - `absent`：v45 之前的老批次 ⇒ 退回摘要判据（`importedRouteCount > 0`），与修复前一致。
 */
function batchNeedsDirtyEvidence(batch: BatchWithSummary): boolean {
  const parsed = parseBatchAnalysisDirtyEvidence(batch.dirtyEvidenceJson);
  if (parsed.status === "ok") {
    return parsed.evidence.full || parsed.evidence.routeDirtyTimes.length > 0;
  }
  if (parsed.status === "invalid") return true;
  return batchHasRouteEvidence(batch);
}

/** `AnalysisDirtyPlan` → 捕获输出形态（`dirtyFromAt` 必须可落地为请求里的字符串）。 */
function analysisPlanOf(
  plan: AnalysisDirtyPlan | { dirtyFromAt: string; domains: AnalysisDirtyDomains } | null
): { dirtyFromAt: string; domains: AnalysisDirtyDomains } | null {
  if (plan === null) return null;
  const dirtyFromAt = plan.dirtyFromAt ?? plan.domains.features ?? plan.domains.fitness ?? plan.domains.readiness;
  if (dirtyFromAt === null || dirtyFromAt === undefined) return null;
  return { dirtyFromAt, domains: plan.domains };
}

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
      const capturedRaw = generations.raw;
      const capturedDependency = generations.dependency;
      // 合并起点：缺省就是捕获到的 raw 代次（空集）；漂移重排时是漂移**前**那一代。
      const mergeFromRaw = request.mergeFromRawGeneration ?? capturedRaw;
      const registeredBatchIds = [...new Set(request.registeredBatchIds ?? [])];
      // 🔴 基线**先读**：它只读 `active_model_run` JOIN 绑定表，不依赖批次集合。
      // 有了它才能把"基线之前、又不是登记成员"的历史批次挡在 SQL 外 —— 否则每次分析都把
      // 全部成功批次的 `summary_json` 拉回来再筛（批次表只增不减）。
      const coverageBase = this.readCoverageBase();
      const batchFloor = coverageBase === null
        || request.disableBatchFloor === true
        || registeredBatchIds.length > MAX_REGISTERED_BATCHES_FOR_FLOOR
        ? null
        : Math.min(coverageBase.raw, mergeFromRaw);
      // 🔴 `id AS batchId` 不是排版偏好：`selectInterveningBatches` 的返回类型是
      // `BatchGenerationFacts`（字段名 `batchId`），少了这个别名，合并路径会把 `undefined`
      // 绑进 `loadDirtyRangeInput` 的 `IN (...)`，于是"代次前进了"这条路径**崩在 SQL 绑定**
      // 而不是给出计划 —— 账本缺口本该有一条显式原因，不是异常栈。
      const batchSelect = `
        SELECT id AS batchId, raw_generation AS rawGeneration, dependency_generation AS dependencyGeneration,
               dependency_bumped AS dependencyBumped, summary_json AS summaryJson,
               analysis_dirty_plan_json AS dirtyEvidenceJson
        FROM import_batches`;
      const batchOrder = "ORDER BY COALESCE(raw_generation, 0), created_at, id";
      // 🔴 兼容路径（没有可信基线）必须看到全部批次：它的 `miss` 判定就是"有没有既不可归因
      // 又未登记的**影响批次**"，截断会把缺口藏起来。只有有基线时才下推下界。
      // 登记成员可能为空（普通单批任务）：`IN ()` 是语法错误，所以子句要按需拼。
      const registeredClause = registeredBatchIds.length > 0
        ? ` OR id IN (${registeredBatchIds.map(() => "?").join(", ")})`
        : "";
      const batches = (batchFloor === null
        ? this.database.prepare(`${batchSelect} WHERE status = 'succeeded' ${batchOrder}`).all()
        : this.database.prepare(`${batchSelect}
            WHERE status = 'succeeded'
              AND (raw_generation IS NULL OR raw_generation > ?${registeredClause})
            ${batchOrder}`
          ).all(batchFloor, ...registeredBatchIds)
      ) as unknown as Array<BatchWithSummary>;
      const batchScan = { scanned: batches.length, floor: batchFloor };
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

      // ---- 覆盖计划（R01/R02 共用一处合并实现 `mergeDirtyPlans`） ----
      //
      // 🔴 这里回答的是"**从旧发布到当前，哪些变更必须重算**"，不是"哪些批次被登记了"：
      //   · 有可信基线（active release 的输入绑定）时：基线之后**全部**已影响分析的批次
      //     并入计划 —— 不按 job 是否 queued/failed 过滤，也不只看调度成员。R02 的
      //     "未入选批次被漏算、发布却宣称最新"就是这一步缺失的形态。
      //   · 原任务/合并任务登记的计划（未发布范围）同样并入 —— R01 的"重排丢掉原任务
      //     尚未发布的 dirty 范围"就是这一半缺失的形态。
      //   · 两者取并集用同一个纯函数（逐域取最早、null 传染），不允许两处各写一套 MIN。
      // 基线缺失（v39 前的老发布 / CLI 直接发布 / 从未发布）⇒ 显式兼容路径，
      // 与 WP-22 的既有行为保持兼容，且**不允许**把无法证明的覆盖当成证明。
      // `registeredBatchIds` / `coverageBase` 已在批次查询前解析（下推下界要用）。
      const planned = coverageBase === null
        ? this.planWithoutCoverageBase(batches, request, capturedRaw, capturedDependency, registeredBatchIds)
        : this.planFromCoverageBase(
            batches, coverageBase, capturedDependency, request.registeredPlan, registeredBatchIds
          );

      // ---- 步骤 4（R06 起）：在**同一个读事务**里把**必要**事实拿出来 ----
      //
      // 🔴 物化必须排在**计划之后**：裁剪边界从覆盖计划推导（域边界 - 最大回看窗），
      // 拿登记计划当边界会在 `coverage_merged` 时偏晚——那正是"读了错误版本还不自知"的入口。
      const prune = this.factPruneFor(planned.plan, request);
      const globalEarliest = this.database.prepare(
        // ⛔ 与 `recompute-pipeline.ts` 的全局最早记录查询**逐字同 SQL**（含 `LIMIT 1` 的择一
        // 语义）——两处口径一旦分叉，发布 gate 的 `earliestInsertedIsNewGlobalEarliest`
        // 会与证据批选择的判定互相打架（`recompute-job-repository.ts` 的 `selectEvidenceBatch`）。
        "SELECT id FROM health_records WHERE start_at = (SELECT MIN(start_at) FROM health_records) LIMIT 1"
      ).get() as { id: string } | undefined;
      const { facts, materialization } = this.materialize(capturedRaw, capturedDependency, budget, {
        prune,
        coverage: {
          recordsFrom: prune?.recordsFrom ?? null,
          routeFrom: prune?.routeFrom ?? null,
          globalEarliestRecordId: globalEarliest?.id ?? null
        }
      });
      const evidence = { facts, materialization };
      return {
        binding,
        coverage,
        ...planned,
        executedPlan: planned.plan === null
          ? {
              version: 1,
              mode: "rebuild" as const,
              dirtyFromAt: null,
              domains: { features: null, fitness: null, readiness: null }
            }
          : {
              version: 1,
              mode: "partial" as const,
              dirtyFromAt: planned.plan.dirtyFromAt,
              domains: planned.plan.domains
            },
        coverageBase,
        batchScan,
        ...evidence
      };
    } finally {
      this.database.exec("COMMIT");
    }
  }

  /**
   * 可信基线：当前 active release 的输入绑定所记录的**捕获代次**。
   *
   * 为什么它可信：绑定行由发布事务（`writeAnalysisInputBinding` + `verifyAndPoint` 同事务）
   * 写下，记录的就是那次发布**实际算的是哪一版输入**。于是"基线之后落库的批次"
   * 就是"旧发布没有覆盖的变更"——这是覆盖计划唯一的、可验证的起点。
   *
   * `null` 的三种来源都必须保守处置（走兼容路径，不复用无法证明的前缀）：
   * v39 之前的老发布（无绑定列/行）、CLI `full_recompute` 直接发布、以及从未发布过。
   */
  private readCoverageBase(): { raw: number; dependency: number } | null {
    const tableExists = this.database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='analysis_run_input_bindings'"
    ).get();
    if (!tableExists) return null;
    const row = this.database.prepare(`
      SELECT binding.captured_raw_generation AS raw,
             binding.captured_dependency_generation AS dependency
      FROM active_model_run active
      JOIN analysis_run_input_bindings binding ON binding.run_id = active.model_run_id
      WHERE active.singleton = 1
    `).get() as { raw: number; dependency: number } | undefined;
    return row === undefined ? null : { raw: Number(row.raw), dependency: Number(row.dependency) };
  }

  /**
   * 主路径（有可信基线）：把"基线之后、尚未被旧发布覆盖"的**全部**影响批次并入计划。
   *
   * ## 判定顺序（每一步的失败方向都是"宁可全量，不可错复用"）
   *
   * 1. 依赖代次相对基线前进了，却没有任何影响批次认领这次移动 ⇒ 计数器移动没有账本证据
   *    （与 `dependencyCoverageHolds` 的 `unattributed_dependency_move` 同一分类结论）
   *    ⇒ 全量。绝不假设"没有批次认领就等于它们都不影响分析"。
   * 2. 基线之后没有影响批次 ⇒ 登记计划就是全部（没有新变更要并）。
   * 3. 影响批次里含路线证据（`summaryJson.routes.importedRouteCount > 0`）⇒ 账本不记路线，
   *    合并出来会漏路线-only 更正 ⇒ 全量。
   * 4. 其余情况：批次账本 → 逐域边界；与登记计划逐域取并集（{@link mergeDirtyPlans}）。
   */
  private planFromCoverageBase(
    batches: readonly BatchWithSummary[],
    base: { raw: number; dependency: number },
    capturedDependency: number,
    registered: { dirtyFromAt: string; domains: AnalysisDirtyDomains } | null,
    registeredBatchIds: readonly string[]
  ): PlannedCoverage {
    const afterBase = selectInterveningBatches(batches, base.raw);
    const influencing = afterBase.filter(affectsAnalysis);
    const influencingIds = influencing.map((batch) => batch.batchId);
    // 🔴 B04（2026-10-17）：`mergedBatchIds` 的语义是「本次**执行**覆盖了哪些批次」，
    // 不是「计划合并了哪些批次」。退回全量（`plan: null`）只是放弃前缀复用，
    // **不改变执行覆盖范围** —— 全量计算当然覆盖了登记成员与基线之后的全部影响批次。
    //
    // 旧实现让多个 rebuild 分支返回空数组，于是发布事务写下空的 `analysis_job_coverage`，
    // 结算方看到"成员未被覆盖"⇒ 把已经算完的成员重新排进队列（复查复现：两个 VO₂ 批次
    // 触发完整计算，覆盖任务 succeeded，两个成员仍 queued，关联 released）。
    const rebuildCoverage = [...new Set([...registeredBatchIds, ...influencingIds])];
    const dependencyMoved = capturedDependency > base.dependency;
    if (dependencyMoved && !influencing.some(isDependencyClaimant)) {
      return { plan: null, planAdjustment: "coverage_gap", mergedBatchIds: rebuildCoverage };
    }
    if (influencing.length === 0) {
      return {
        plan: analysisPlanOf(registered),
        planAdjustment: null,
        mergedBatchIds: [...registeredBatchIds]
      };
    }
    // 🔴 B05（2026-10-17）：含路线证据的批次只能靠**持久证据**重建 —— 账本不记路线，
    // 拿账本重建会漏掉路线-only 更正。全部可重建 ⇒ 继续 partial（这是 B05 的收益）；
    // 任一缺证据 / 损坏 / 该批本身 `full` ⇒ 显式全量，原因与成本分开记录。
    const fromBatches = this.planDirtyForBatches(influencing);
    if (fromBatches === null) {
      return {
        plan: null,
        planAdjustment: influencing.some(batchNeedsDirtyEvidence)
          ? "route_evidence_unmerged"
          : "coverage_gap",
        mergedBatchIds: rebuildCoverage
      };
    }
    // 登记计划为 null = 任务本来承诺全量 ⇒ 保持全量（不允许用 partial 悄悄缩小承诺范围；
    // 全量必然覆盖 fromBatches，方向安全）。
    const merged = registered === null ? null : mergeDirtyPlans(registered, fromBatches);
    if (merged === null) {
      return {
        plan: null,
        planAdjustment: registered === null ? null : "coverage_gap",
        // 即使 `registered` 为 null，`registeredBatchIds` 也可能非空（合并任务登记了成员
        // 批次、但没登记 partial 计划）—— 那批成员同样被这次全量执行覆盖。
        mergedBatchIds: rebuildCoverage
      };
    }
    return {
      plan: analysisPlanOf(merged),
      planAdjustment: "coverage_merged",
      mergedBatchIds: [...new Set([...registeredBatchIds, ...influencingIds])]
    };
  }

  /**
   * 兼容路径（无可信基线）：保留 WP-22 的既有判定，并补两条 R01/R02 的覆盖面判据。
   *
   * - **未覆盖检查**（先于任何分支）：库里存在"既不在本次可归因批次、也不在登记批次"
   *   的影响批次 ⇒ 无基线时无法证明它们的 dirty 已进计划 ⇒ 全量（`coverage_unverifiable`）。
   *   这是"33 批超 32 成员上限，第 33 批被漏"这类形态的兜底。
   * - **登记范围保留**：显式给了合并起点（漂移重排）时，合并结果必须与登记计划
   *   逐域取并集（{@link mergeDirtyPlans}）——否则重排会丢掉原任务尚未发布的早期 dirty。
   */
  private planWithoutCoverageBase(
    batches: readonly BatchWithSummary[],
    request: AnalysisInputCaptureRequest,
    capturedRaw: number,
    capturedDependency: number,
    registeredBatchIds: readonly string[]
  ): PlannedCoverage {
    const mergeFromRaw = request.mergeFromRawGeneration ?? capturedRaw;
    const intervening = selectInterveningBatches(batches, mergeFromRaw);
    const attributableIds = new Set([
      ...intervening.map((batch) => batch.batchId),
      ...registeredBatchIds
    ]);
    const miss = batches.filter((batch) =>
      affectsAnalysis(batch) && !attributableIds.has(batch.batchId));
    // B04：同上 —— 退回全量只改变计划，不改变执行覆盖的批次集合。
    // 兼容路径全量执行覆盖「登记批次 ∪ 本窗口可归因批次」；`miss` 那部分没有归属证据，
    // 不写进覆盖清单（写了等于宣称一次我们没有证据的执行范围）。
    const rebuildCoverage = [...new Set([
      ...registeredBatchIds,
      ...intervening.map((batch) => batch.batchId)
    ])];
    if (miss.length > 0) {
      return { plan: null, planAdjustment: "coverage_unverifiable", mergedBatchIds: rebuildCoverage };
    }
    // 代次没有前进 ⇒ 登记时的单批计划就是全部（最常见路径，也是 D4 生效的路径）。
    // 漂移重排（显式给了合并起点）时，只要真的存在要并进来的批次就走合并路径 —— 否则
    // "raw-only 批次把事实改了但依赖代次没动"会被读成"没有新 dirty"，而那正是错复用。
    const advanced = intervening.length > 0
      || (request.targetDependencyGeneration !== null
        && capturedDependency > request.targetDependencyGeneration);
    if (!advanced) {
      return {
        plan: analysisPlanOf(request.registeredPlan),
        planAdjustment: null,
        mergedBatchIds: [...registeredBatchIds]
      };
    }
    // 代次前进了：把"目标代次之后、捕获代次之前"的批次账本并进来重算计划。
    const uncovered = intervening.filter((batch) => {
      if (batch.dependencyBumped === null || batch.dependencyBumped === undefined) return true;
      return batch.dependencyBumped !== 0
        || (batch.dependencyGeneration ?? 0) > (request.targetDependencyGeneration ?? 0);
    });
    // B04：这三条 rebuild 分支同样保留「登记批次 ∪ 本次可归因批次」的执行覆盖证据。
    const uncoveredCoverage = [...new Set([
      ...registeredBatchIds,
      ...uncovered.map((batch) => batch.batchId)
    ])];
    // B05：与主路径同一份判据 —— 含路线证据的批次用持久证据重建；缺证据/损坏 ⇒ 全量。
    const fromBatches = this.planDirtyForBatches(uncovered);
    if (fromBatches === null) {
      return {
        plan: null,
        planAdjustment: uncovered.some(batchNeedsDirtyEvidence)
          ? "route_evidence_unmerged"
          : "coverage_gap",
        mergedBatchIds: uncoveredCoverage
      };
    }
    const merged = request.registeredPlan === null
      ? fromBatches
      : mergeDirtyPlans(request.registeredPlan, fromBatches);
    if (merged === null) {
      return { plan: null, planAdjustment: "coverage_gap", mergedBatchIds: uncoveredCoverage };
    }
    return {
      plan: analysisPlanOf(merged),
      planAdjustment: "coverage_merged",
      mergedBatchIds: [...new Set([...registeredBatchIds, ...uncovered.map((batch) => batch.batchId)])]
    };
  }

  /**
   * 若干批次 → 一份覆盖计划（**逐批**取证，再合并）。
   *
   * ## 为什么必须逐批
   *
   * 账本（`import_entity_changes`）只记记录/训练/活动摘要，**不记路线**。含路线变更的批次
   * 只能从 v45 的持久证据（`import_batches.analysis_dirty_plan_json`）里读出它自己的边界。
   * 把所有批次混在一次 `loadDirtyRangeInput` 里，路线那部分就永久丢失了 —— 这正是 B05 之前
   * 只能靠"有路线 ⇒ 全量"兜底的原因。
   *
   * ## 三条出口（失败方向全部是"宁可全量"）
   *
   * - `evidence`：有证据 ⇒ 用它（`full` ⇒ `null`，让调用方走全量）；
   * - `invalid`：证据损坏 ⇒ `null`（绝不按缺省放行）；
   * - `absent`：v45 之前的老批次 ⇒ 无路线摘要时并入**一次**账本重建（省掉 N 次全表扫描），
   *   有路线摘要时 `null`（兼容路径，与修复前逐字相同）。
   *
   * 账本重建只对"缺证据且无路线"的批次做一次批量装配；证据批次逐条解析后与它取最早。
   */
  private planDirtyForBatches(batches: readonly BatchWithSummary[]): AnalysisDirtyPlan | null {
    if (batches.length === 0) return null;
    const evidenceBatches: BatchWithSummary[] = [];
    const ledgerBatchIds: string[] = [];
    for (const batch of batches) {
      const parsed = parseBatchAnalysisDirtyEvidence(batch.dirtyEvidenceJson);
      if (parsed.status === "ok") {
        // 本批自身不可增量 ⇒ 包含它的合并计划也不可能 partial。
        if (parsed.evidence.full) return null;
        evidenceBatches.push(batch);
        continue;
      }
      if (parsed.status === "invalid") return null;
      if (batchHasRouteEvidence(batch)) return null;
      ledgerBatchIds.push(batch.batchId);
    }
    let merged: AnalysisDirtyPlan | null = null;
    if (ledgerBatchIds.length > 0) {
      const range = planIncrementalAnalysisDirtyRange(
        loadDirtyRangeInput(this.database, ledgerBatchIds, [], [])
      );
      if (range.full || range.dirtyFromAt === null) return null;
      merged = { dirtyFromAt: range.dirtyFromAt, domains: range.domains };
    }
    for (const batch of evidenceBatches) {
      const parsed = parseBatchAnalysisDirtyEvidence(batch.dirtyEvidenceJson);
      if (parsed.status !== "ok" || parsed.evidence.dirtyFromAt === null) return null;
      const plan: AnalysisDirtyPlan = {
        dirtyFromAt: parsed.evidence.dirtyFromAt,
        domains: parsed.evidence.domains
      };
      merged = merged === null ? plan : mergeDirtyPlans(merged, plan);
      if (merged === null) return null;
    }
    return merged;
  }

  /**
   * R06：由**覆盖计划**推导事实裁剪边界。
   *
   * ## 为什么边界 = 逐域最早 − **最大**回看窗
   *
   * 计划的 `dirtyFromAt` 回答"从哪一刻起必须重算"；但重算**读**的事实可以比它更早 ——
   * 每个域各有最大回看窗（训练装配 180 天、分区峰值证据 365 天、乳酸阈值证据链
   * 365 + 180 = 545 天；常量与推导见 `analysis-fact-view.ts`）。边界取"逐域最早"再减
   * **最大**那个窗（{@link RECORDS_MAX_LOOKBACK_MS}），于是任意域的组合都覆盖得住；
   * 用单一常量换掉"逐域各减各的窗"，少一处会静默漂移的第二实现。
   *
   * 边界取 `min` 的前提是它来自**覆盖计划**而不是登记计划：`coverage_merged` 时计划比
   * 登记时更早，拿登记那一档当边界会**偏晚** —— 那正是"读了错误版本还不自知"的入口
   * （所以 `capture()` 把本步排在计划计算之后）。
   *
   * ## `null`（不裁剪）的全部来源（都是"宁可全量"的方向）
   *
   * 1. 计划为 `null`：本次承诺全量重算 ⇒ 读全史；
   * 2. `disableFactPruning`：守卫回退路径（{@link runDirectSyncAnalysis} 的覆盖越界回退）；
   * 3. 计划里一个域边界都没有：形态异常 ⇒ 不猜。
   *
   * **谁来兜住裁错的后果**：物化侧裁剪之后，pipeline 侧必须在三处**读口**守卫
   * （`assertFactCoverage`：特征装配、分区/证据、路线点）；越界 ⇒ 抛
   * `AnalysisInputCoverageOutOfBoundsError` ⇒ 调用方关闭裁剪重捕获一次。**绝不静默少读**。
   */
  private factPruneFor(
    plan: { dirtyFromAt: string; domains: AnalysisDirtyDomains } | null,
    request: AnalysisInputCaptureRequest
  ): FactPruneCoverage | null {
    if (plan === null || request.disableFactPruning === true) return null;
    const boundaries = [plan.domains.features, plan.domains.fitness, plan.domains.readiness]
      .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
    if (boundaries.length === 0) return null;
    const boundaryMs = Math.min(...boundaries.map((value) => Date.parse(value)));
    return {
      recordsFrom: new Date(boundaryMs - RECORDS_MAX_LOOKBACK_MS).toISOString(),
      // 路线点按"被算会话"筛选（`buildFactTableFilters` 的 session 子查询）。边界比计划边界
      // **再早一天**：路线读取的驱动量是"会话所属**本地日** >= 边界日"（负荷阶段按
      // `localDateAt` 跳前缀），而过滤列是精确时刻 `workout.start_at` —— 两者之间隔着时区
      // 偏移（最多 ±14h）。留一天余量，日粒度的需求永远落在覆盖内；代价最多是白留一天的路线点。
      routeFrom: new Date(boundaryMs - 86_400_000).toISOString()
    };
  }

  /**
   * 事实物化（O06-A 步骤 4）：预算内 ⇒ 同一个读事务里整份复制进内存快照，随后事务关闭；
   * 超预算 ⇒ **不**退化成无限读，转 {@link SegmentedFactView} 的分段校验读。
   *
   * R06：裁剪（{@link FactPruneCoverage}）同时喂给**探针与物化**（同一份表级谓词）——
   * 探针数的必须是"要复制的那些行"；只裁物化不裁探针，大库会永远按全量判超限、
   * 裁剪路径永不触达（探针与物化规模脱钩）。**裁剪只在物化模式生效**：分段模式读源库
   * （全量），不裁剪也不需要守卫。
   *
   * ⛔ 预算不够时**不能**"先关掉这个快照、再去读最新一段拼上"：分段模式每条读都自带代次核对，
   * 一旦观察到别的代次就抛 `AnalysisInputDriftError`，由 pipeline 作废候选并重排。
   */
  private materialize(
    capturedRaw: number,
    capturedDependency: number,
    budget: AnalysisInputBudget,
    options: { prune: FactPruneCoverage | null; coverage: SnapshotCoverage }
  ): {
    facts: AnalysisFactView;
    materialization: AnalysisInputCapture["materialization"];
  } {
    const filters: FactTableFilters | undefined = options.prune === null
      ? undefined
      : buildFactTableFilters(options.prune, runningType);
    // R06：探针是**有界**的 —— 行数一旦超过物化预算就立即停（不再扫各表文本列；
    // 判定不会因此改变：行超即走分段读），避免"为了判断是否超限又把全部历史扫一遍"。
    const probe = probeFactSize(this.database, undefined, filters === undefined
      ? { stopAfterRows: budget.maxRows }
      : { stopAfterRows: budget.maxRows, filters });
    const overRows = probe.rows > budget.maxRows;
    const overBytes = probe.bytes > budget.maxBytes;
    const pruning = options.prune === null
      ? null
      : { recordsFrom: options.prune.recordsFrom, routeFrom: options.prune.routeFrom };
    if (!overRows && !overBytes) {
      const snapshot = materializeFactSnapshot(
        this.database, SNAPSHOT_TABLES, PINNED_FACT_VIEWS,
        filters === undefined ? {} : { filters }
      );
      return {
        facts: new SnapshotFactView(
          snapshot.database, snapshot.rows, snapshot.bytes,
          () => readFactViewGenerations(this.database),
          options.coverage
        ),
        materialization: {
          mode: "materialized", rows: snapshot.rows, bytes: snapshot.bytes,
          bytesExact: true, reason: null, tables: probe.tables, pruning
        }
      };
    }
    const captured: FactViewGenerations = { raw: capturedRaw, dependency: capturedDependency };
    return {
      facts: new SegmentedFactView(this.database, captured, budget, probe.bytes),
      materialization: {
        mode: "segmented",
        rows: probe.rows,
        bytes: probe.bytes,
        bytesExact: probe.bytesExact,
        reason: overRows ? "fact_rows_exceed_budget" : "fact_bytes_exceed_budget",
        tables: probe.tables,
        // 分段读的是源库（全量），裁剪没有生效 —— 记账照实写，别让事件看起来像裁过。
        pruning: null
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
