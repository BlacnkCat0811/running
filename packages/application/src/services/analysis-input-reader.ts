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
}

/** 读取器接口：pipeline 只依赖这个形状，注入点在 worker 线程里（那里允许开连接）。 */
export interface AnalysisInputSource {
  capture(request: AnalysisInputCaptureRequest): AnalysisInputCapture;
}

interface ManifestRow { value: string }

export class SqliteAnalysisInputReader implements AnalysisInputSource {
  constructor(private readonly database: DatabaseSync, private readonly scope = "direct-sync") {}

  capture(request: AnalysisInputCaptureRequest): AnalysisInputCapture {
    // 🔴 一个读事务读完所有证据：绑定与账本必须来自**同一个**时间点，否则
    // "捕获代次"与"未覆盖批次"可能互相矛盾（前者读到了后者还没落库的状态）。
    this.database.exec("BEGIN DEFERRED");
    try {
      const generations = readGenerations(this.database);
      const datasetVersion = manifestValue(this.database, "dataset_version") ?? "dataset_unknown";
      const incumbent = this.database.prepare(
        "SELECT model_run_id AS modelRunId FROM active_model_run WHERE singleton = 1"
      ).get() as { modelRunId: string } | undefined;
      const overrideDigest = overrideSnapshotDigest(this.database);
      const configDigest = settingsDigest(this.database);
      const batches = this.database.prepare(`
        SELECT id, raw_generation AS rawGeneration, dependency_generation AS dependencyGeneration,
               dependency_bumped AS dependencyBumped, summary_json AS summaryJson
        FROM import_batches
        WHERE status = 'succeeded'
        ORDER BY COALESCE(raw_generation, 0), created_at, id
      `).all() as unknown as Array<BatchGenerationFacts & { summaryJson: string | null }>;

      const capturedRaw = generations.raw;
      const capturedDependency = generations.dependency;
      const intervening = selectInterveningBatches(batches, capturedRaw);
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

      // 代次没有前进 ⇒ 登记时的单批计划就是全部（最常见路径，也是 D4 生效的路径）。
      const advanced = request.targetDependencyGeneration !== null
        && capturedDependency > request.targetDependencyGeneration;
      if (!advanced) {
        return { binding, coverage, plan: request.registeredPlan, planAdjustment: null, mergedBatchIds: [] };
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
        return { binding, coverage, plan: null, planAdjustment: "route_evidence_unmerged", mergedBatchIds: [] };
      }
      const merged = planIncrementalAnalysisDirtyRange(loadDirtyRangeInput(
        this.database, uncovered.map((batch) => batch.batchId), [], []
      ));
      if (merged.full || merged.dirtyFromAt === null) {
        return { binding, coverage, plan: null, planAdjustment: "coverage_gap", mergedBatchIds: [] };
      }
      return {
        binding,
        coverage,
        plan: { dirtyFromAt: merged.dirtyFromAt, domains: merged.domains },
        planAdjustment: "coverage_merged",
        mergedBatchIds: uncovered.map((batch) => batch.batchId)
      };
    } finally {
      this.database.exec("COMMIT");
    }
  }
}

/** `import_generations`：老库可能没有这张表（v34 之前）⇒ 当作 (0,0) = "计数器说了不算"。 */
function readGenerations(database: DatabaseSync): { raw: number; dependency: number } {
  const exists = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_generations'"
  ).get();
  if (!exists) return { raw: 0, dependency: 0 };
  const row = database.prepare(
    "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton = 1"
  ).get() as { raw: number; dependency: number } | undefined;
  return { raw: Number(row?.raw ?? 0), dependency: Number(row?.dependency ?? 0) };
}

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
