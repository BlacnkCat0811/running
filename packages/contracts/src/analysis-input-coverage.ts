/**
 * 分析**输入覆盖证明**（O06-A / WP-22，2026-10-16）。
 *
 * ## 为什么这条判据住在 contracts
 *
 * 它同时被两端使用，而且**必须是同一份实现**：
 * - 写入/登记端（`@rai/application` 的输入读取器）用它判断"捕获之后有没有依赖增量"；
 * - 发布端（`@rai/storage-sqlite` 的 `verifyAndPoint`）用它决定候选能不能激活。
 *
 * 两处各写一遍必然漂移，而漂移的后果是"发布判据比计算判据松"——那正是"旧计算当最新展示"的
 * 入口。放在共享包是让它们**在编译期**指向同一个函数。
 *
 * ## 它放宽了什么、没放宽什么
 *
 * 决策 D4（本次确认）：`verifyAndPoint` 的 dataset 版本逐字相等判据，允许被
 * **依赖级覆盖证明**替代 —— 已证明不影响分析的 raw-only 批次不再让候选被拒。
 *
 * 🔴 放宽的是判据的**形式**，不是把校验删掉：只要有一个中介批次说不清它有没有推依赖代次
 * （v39 之前的历史行是 NULL），判据就是**拒绝**。不确定性一律按不安全处理。
 */

/** 一个批次自己声明的代次足迹（`import_batches` 的 v39 三列）。 */
export interface BatchGenerationFacts {
  batchId: string;
  /** 该批之后 raw 代次达到的值。NULL = v39 之前的历史行 ⇒ **未知**，不是 0。 */
  rawGeneration: number | null;
  /** 该批之后 dependency 代次达到的值。NULL = 未知。 */
  dependencyGeneration: number | null;
  /** 该批有没有推进依赖代次（1/0）。NULL = 未知 ⇒ 必须**保守**当作"可能推过"。 */
  dependencyBumped: number | null;
}

export interface DependencyCoverageInput {
  capturedRawGeneration: number;
  capturedDependencyGeneration: number;
  currentRawGeneration: number;
  currentDependencyGeneration: number;
  /** 捕获之后落库的批次（选取规则见 {@link selectInterveningBatches}）。 */
  interveningBatches: readonly BatchGenerationFacts[];
}

export type DependencyCoverageReason =
  | "up_to_date"
  | "dependency_moved"
  | "unattributed_dependency_move"
  | "unknown_batch_generation"
  | "generations_regressed";

export interface DependencyCoverageVerdict {
  holds: boolean;
  reason: DependencyCoverageReason;
  /** 让证明不成立的那些批次（便于诊断；成立时为空）。 */
  offendingBatchIds: string[];
}

/**
 * 覆盖证明：**候选之后进来的批次有没有动过分析输入**。
 *
 * ## 判据为什么长这样（这条推导必须留着，否则下一个人会把 `raw_only_intervening` 加回来）
 *
 * `dependency_generation` 的推进规则是**结构性的**：直连车道只在
 * `classifyDirectSyncPayload` 判为 `analysis-required` 时 `+1`（`direct-sync-ingest.ts`），
 * record-only 车道只推 raw（`data-only-import.ts`）。于是
 *
 * > 依赖代次前进了 ⟺ 有一个**影响分析**的批次落了库。
 *
 * 这正是决策 D4 想要的形式：raw-only 批次**根本不会移动依赖代次**，所以
 * `currentDependency <= capturedDependency` 就已经是"候选之后没有任何东西动过分析输入"的
 * **证明**，不需要再逐个批次去证明什么。反过来说，依赖代次一旦前进，候选就一定是旧的 ——
 * 没有"虽然前进了但其实没影响"这一档。
 *
 * 判据按顺序，保守优先：
 *
 * 1. 当前 raw/dependency **小于**捕获值 ⇒ 计数器回退，不可能安全判断 ⇒ 不成立。
 *    （正常库不会发生；发生就是有人重建了计数器，此时必须拒绝而不是猜。）
 * 2. 当前 dependency ≤ 捕获值 ⇒ 成立（`up_to_date`）。**D4 放行的就是这一档。**
 * 3. 依赖代次前进 ⇒ 不成立。再按批次证据细分原因：
 *    - 能点名（某个中介批次 `dependencyBumped` ≠ 0，或历史行 NULL）⇒ `dependency_moved`
 *      / `unknown_batch_generation`；
 *    - 一个都点不出来（中介批次全都自称没推过依赖代次）⇒ 计数器的移动**没有可归因的批次**，
 *      那是账本缺口 ⇒ `unattributed_dependency_move`，**同样拒绝**。
 *      把这一档当成"raw-only 所以放行"是错的：`dependency_bumped` 是批次**自称**的，
 *      没有对应批次时它证明不了任何事。
 */
export function dependencyCoverageHolds(input: DependencyCoverageInput): DependencyCoverageVerdict {
  const {
    capturedRawGeneration: capturedRaw,
    capturedDependencyGeneration: capturedDependency,
    currentRawGeneration: currentRaw,
    currentDependencyGeneration: currentDependency
  } = input;
  if (currentRaw < capturedRaw || currentDependency < capturedDependency) {
    return { holds: false, reason: "generations_regressed", offendingBatchIds: [] };
  }
  if (currentDependency <= capturedDependency) {
    return { holds: true, reason: "up_to_date", offendingBatchIds: [] };
  }
  const offending: string[] = [];
  let unknown = false;
  for (const batch of input.interveningBatches) {
    if (batch.dependencyBumped === null || batch.dependencyBumped === undefined) {
      unknown = true;
      offending.push(batch.batchId);
      continue;
    }
    if (batch.dependencyBumped !== 0) offending.push(batch.batchId);
  }
  if (offending.length === 0) {
    // 依赖代次动了，但没有任何中介批次认领这次移动 ⇒ 账本缺口，拒绝。
    return { holds: false, reason: "unattributed_dependency_move", offendingBatchIds: [] };
  }
  return {
    holds: false,
    reason: unknown ? "unknown_batch_generation" : "dependency_moved",
    offendingBatchIds: offending
  };
}

/**
 * 选中"捕获之后落库的批次"。
 *
 * 为什么要 **或 `raw_generation IS NULL`**：v39 之前的历史批次没有这三列。把 NULL 排除在外
 * 等于把未知当成不存在 —— 而"未知"必须留在证明里，才能让 {@link dependencyCoverageHolds}
 * 拒绝它。这是"保守优先"在选取层的落实。
 *
 * 泛型保留元素类型（调用方常常带着账本摘要一起用）：选取规则仍然只有这一份实现。
 */
export function selectInterveningBatches<T extends BatchGenerationFacts>(
  batches: readonly T[],
  capturedRawGeneration: number
): T[] {
  return batches.filter((batch) =>
    batch.rawGeneration === null || batch.rawGeneration === undefined
      ? true
      : batch.rawGeneration > capturedRawGeneration);
}
