/**
 * 直接增量同步的共享合同。
 * 依据：`docs/SQLITE_DIRECT_SYNC_DESIGN.md` §10.1（状态合同）与 §14.1（禁止操作）。
 *
 * 为什么放在 `@rai/contracts`：这份清单同时被 API 层（`apps/api`）与存储层
 * （`packages/storage-sqlite`）的守卫读取，而这两者互不依赖 —— `contracts` 是它们共同
 * 依赖的**最小公共层**。放进任何一方，另一方都要反向依赖。
 *
 * ⚠️ 这一层只承载**判据**，不承载实现。清单里的每一个可观测通道名都必须与真实实现一致：
 * `apps/api/test/direct-sync-prohibited-operations.test.ts` 会断言每个 `workerMethod`
 * 在 `ImportWorker.prototype` 上确实存在、每个 `databaseTaskOperation` 确实是
 * `ImportDatabaseTask.operation` 的合法取值 —— **改名会让守卫转红，而不是静默失去覆盖**。
 */

/**
 * §10.1：原始事实的接收状态。
 *
 * 与"分析是否更新"是**两个独立维度**，不得互相替代：`committed` 只说本批事实已持久提交，
 * 它并**不**意味着派生分析已经跟上（§1.4）。
 */
export const INGEST_STATUSES = ["receiving", "validating", "applying", "committed", "rejected"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

/**
 * §10.1：派生分析的状态。
 *
 * `not_required` 是"本批在结构上不影响分析"，**不是**"分析已完成"；`published` 才是。
 * 消费方不得把 `not_required` 当成 `published` 显示（§9.1）。
 */
export const ANALYSIS_STATUSES = ["not_required", "queued", "running", "published", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/**
 * §10.1 的直连回执。
 *
 * 刻意**不带** `routeReceipts`：路线版本与分片回执属于 PR3，在 PR1 阶段没有任何生产者，
 * 先声明字段会让消费方读到一个永远为空的契约谎言。字段在有了真实生产者之后再加。
 */
export interface DirectSyncReceipt {
  ingestStatus: IngestStatus;
  analysisStatus: AnalysisStatus;
  /** 本批的持久回执 id。与 `ImportJobResponse.id` 相同，独立列出是为了让回执自洽。 */
  receiptId: string;
  /** 影响分析的依赖版本；本批不影响分析时为 `null`（**不是**空串占位）。 */
  dependencyGeneration: string | null;
  /** 当前可读的分析发布 id；本批没有发布新分析时为 `null`。 */
  publishedReleaseId: string | null;
  /** 大包分片时的父批 id；未分片为 `null`（§5.2）。 */
  parentBatchId: string | null;
}

/**
 * ⚠️ 回执里**没有**"事实版本号"，这是有意的，不要加回来当占位用。
 *
 * 曾经有一个 `rawGeneration: string` 字段，装的是批次 token `delta:<jobId>`（即
 * `import_entity_generations.generation` 那一路的值）。它有两个问题，实测确认后删除：
 * 1. 它与 `receiptId` 是同一个批次的两个名字，**重复**；
 * 2. 名字让人以为可以喂给 `FactsReader` —— 而 `openFactsReader` 要的是**非负整数**
 *    （`import_generations.raw_generation` 那一路的单调版本号），喂进去直接抛错。
 *    一个名字承担两种语义，正是这个仓反复踩过的坑。
 *
 * 数值版本号目前**还不存在**：`import_generations` 计数器与
 * `health_records.valid_from_generation` / `workouts.valid_from_generation` 打标
 * 在 v34 只有 schema，**全仓没有写入方**。所以回执现在**不承诺**任何数值事实版本 ——
 * 让消费方拿到一个用不了的值，比拿不到更糟（他会以为已经拿到）。
 *
 * 何时加回来：连同"计数器写入方 + 行打标"一起，见 `docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md`
 * 的步骤 6b。届时字段名要避开 `generation` 一词的双关。
 */

/**
 * §14.1 的"禁止操作"清单。
 *
 * 每一项都必须**可观测**：至少一个通道非空，否则守卫无法证明它没有被触发，
 * 这一条就会退化成"文档里写了、没人守"的孤儿。
 *
 * ⚠️ 这句话的**唯一**执行者是 `apps/api/test/direct-sync-prohibited-operations.test.ts`
 * （它逐条断言"声明的通道确实存在"）。本包的 `test/` 目录**存在**（5 个文件），但**没有任何
 * 一个**断言这个不变量 —— 此前这句话写着"`packages/contracts/test` 与 API 守卫测试都会断言"，
 * 把"目录里有测试"说成了"那里守住了这条"。声称有第二道守卫、实际只有一道，比只有一道更危险
 * （会让人不再去检查那一道）。
 *
 * 通道的语义各不相同，不能互相替代：
 * - `workerMethod` —— `ImportWorker` 的实例方法名。它是最细的粒度，能定位到**谁**做的。
 * - `databaseTaskOperation` —— 沿 `ImportWorker.databaseTask` 投递到工作线程的任务类型名。
 * - `storeMethod` —— `RaiDatabase` 上的方法名（**进程内**）。用于覆盖既不经过 worker、
 *   也不经过子进程的库内直接调用。
 * - `commandSubcommands` —— 子进程 CLI 的子命令。解析器与重算在子进程里跑，
 *   库内的写入无法被进程内计数看到，只能靠这个通道（§14.1 的"还要记录 SQL、任务阶段和文件操作"）。
 * - `stages` —— 会出现在 `performance.stagesMs` / `computeStagesMs` 里的阶段名，用作交叉印证。
 *
 * 🔴 **通道必须在本车道上真的可达**，否则"全 0 ⇒ 通过"是空话。在直连车道上结构性
 * 不可能触发的条目要用 `vacuousOnDirectLane` 明写出来 —— 见 `seed-import-generations`
 * （已补 `storeMethod` 通道，从真空变成真守）与 `canonical-nights-full-rebuild`（仍真空，已声明）。
 */
export interface ProhibitedDirectSyncOperation {
  /** 稳定 id。改它等于改判据，必须同时改测试与文档。 */
  readonly id: string;
  readonly workerMethod: string | null;
  readonly databaseTaskOperation: string | null;
  /**
   * `RaiDatabase.prototype` 上的方法名（**进程内**通道）。
   *
   * 存在的理由有实测证据：`seed-import-generations` 原本**只有** `commandSubcommands` 一个通道，
   * 而直连车道按设计不跑任何子进程（本文件的测试自己断言 `commands === []`）—— 于是那条守卫在
   * 直连车道上**构造性真空**：真出问题时它照样是 0，"全 0 ⇒ 通过"什么也没证明。
   * 而它真实的调用点是进程内的 `store.seedImportGenerations(...)`，与其他通道都无关。
   */
  readonly storeMethod?: string | null;
  readonly commandSubcommands: readonly string[];
  readonly stages: readonly string[];
  /**
   * 该条目在**直连车道**上是否结构性不可能被触发，以及**原因**。
   *
   * 非 `null` ⇒ 「在本车道上这条守卫恒为 0，因此它对本车道**不构成保证**」。
   * 🔴 必须显式声明：不声明的真空是缺陷（守卫看起来在守，其实什么都没守），
   * 而声明的真空是待办项（谁补上通道，谁把它删掉）。
   */
  readonly vacuousOnDirectLane?: string;
  /** 文档 §14.1 的原文条目，便于逐条对照。 */
  readonly description: string;
}

export const PROHIBITED_DIRECT_SYNC_OPERATIONS: readonly ProhibitedDirectSyncOperation[] = [
  {
    id: "current-backup",
    workerMethod: "createCurrentBackup",
    databaseTaskOperation: null,
    commandSubcommands: [],
    stages: ["backupCapacity", "backupCopy", "backupVerify"],
    description: "createCurrentBackup / 备份容量与保留策略"
  },
  {
    id: "whole-database-copy",
    workerMethod: "backupDatabase",
    databaseTaskOperation: null,
    commandSubcommands: [],
    stages: ["backupCopy", "stagingCopy"],
    description: "backupDatabase / 整库 copy（含主库→暂存候选的复制）"
  },
  {
    id: "full-database-quick-check",
    workerMethod: "isReadableDatabase",
    databaseTaskOperation: "verify",
    commandSubcommands: [],
    stages: ["database_quick_check"],
    description: "isReadableDatabase 的全库 quick_check"
  },
  {
    id: "activate-database",
    workerMethod: "activateDatabase",
    databaseTaskOperation: null,
    commandSubcommands: [],
    stages: ["activationSwap"],
    description: "activateDatabase / 文件换库"
  },
  {
    id: "install-database",
    workerMethod: "installDatabase",
    databaseTaskOperation: null,
    commandSubcommands: [],
    stages: [],
    description: "installDatabase / 把候选文件安装成正式库"
  },
  {
    id: "move-database-file",
    workerMethod: "moveDatabaseFile",
    databaseTaskOperation: null,
    commandSubcommands: [],
    stages: [],
    description: "moveDatabaseFile / 移动主库文件（rollback 与 rename 都算）"
  },
  {
    id: "forced-wal-truncate",
    workerMethod: "checkpointDatabase",
    databaseTaskOperation: "checkpoint",
    commandSubcommands: [],
    stages: ["database_checkpoint"],
    description: "强制 wal_checkpoint(TRUNCATE)，并等它完成才返回成功"
  },
  {
    id: "stage-audit-reports",
    workerMethod: "stageAuditReports",
    databaseTaskOperation: "audit",
    commandSubcommands: [],
    stages: ["activationAudit", "final_audit_build"],
    description: "stageAuditReports 完整构建（每批审计 SQL/Markdown/JSON 重建）"
  },
  {
    id: "seed-import-generations",
    workerMethod: null,
    databaseTaskOperation: null,
    storeMethod: "seedImportGenerations",
    commandSubcommands: ["import", "incremental-import"],
    stages: [],
    description: "seedImportGenerations 全库补种"
  },
  {
    id: "canonical-nights-full-rebuild",
    workerMethod: null,
    databaseTaskOperation: null,
    storeMethod: null,
    commandSubcommands: ["import", "incremental-import", "recompute"],
    stages: [],
    // ⚠️ 声明的真空：直连车道**根本不跑** canonical（局部化要等 PR4 接
    // `canonicalizeNightsForWindow`），所以本条目在那条车道上恒为 0。
    // 它现在守的是旧车道的 CLI 路径，对直连车道**不构成保证** —— 别把它算进"已守"。
    vacuousOnDirectLane: "直连车道不执行任何 canonical 重建；本条目只在旧链路的 CLI 子进程里可观测",
    description: "全表 canonical nights 删除/重建"
  }
];

/**
 * §14.1 要求每一项**至少有一个**可观测通道。返回违反这个不变量的 id 列表；
 * 空数组表示清单本身是自洽的。守卫测试与文档检查都调用它，避免只靠人眼维护。
 */
export function unobservableProhibitedOperations(
  operations: readonly ProhibitedDirectSyncOperation[] = PROHIBITED_DIRECT_SYNC_OPERATIONS
): string[] {
  return operations
    .filter((operation) => operation.workerMethod === null
      && operation.databaseTaskOperation === null
      // 🔴 `storeMethod` 必须一起算：加了这个通道却忘了在这里放开，
      // 会让 `seed-import-generations` 被误报成"没人守的孤儿"（假警报），
      // 而假警报会训练人忽略这条检查。通道加一处、判据就要跟着加一处。
      && (operation.storeMethod ?? null) === null
      && operation.commandSubcommands.length === 0
      && operation.stages.length === 0)
    .map((operation) => operation.id);
}
