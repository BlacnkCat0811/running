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
 * 事实侧与已发布分析侧各自的版本号（PR5 D2，见 `docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md` §2）。
 *
 * 🔴 **只派生、不新增存储。** 四个值全部来自既有表：`import_generations` 的两列、
 * `active_model_run` 的单行指针、以及该代次上最新一个分析任务的状态 —— 本类型不是
 * 第 N 份真相，它是那几份真相在**同一个读快照**里的投影。
 *
 * `facts` / `analysis` 是**批次计数器**（`import_generations`，PR4 2d 起由直连车道
 * `apps/api/src/direct-sync-ingest.ts` 递增），不是墙上时钟：`facts` 每个批次 +1，
 * `analysis` 只在本批会影响分析时 +1。对外呈现用 `String(n)`（§10.1 的口径）。
 */
export interface FactVersions {
  /** `import_generations.raw_generation`；`null` = 这一侧还没有版本可报（见 `Freshness.reason`）。 */
  facts: string | null;
  /** `import_generations.dependency_generation`；`null` 的含义同上。 */
  analysis: string | null;
  /** `active_model_run.model_run_id`；`null` = 还没有任何已发布分析。 */
  releaseId: string | null;
  analysisStatus: AnalysisStatus;
}

/**
 * 新鲜度**派生值**。`stale === true` ⇔ `analysisStatus !== "published"` **或**
 * `analysis !== facts`（D2 原文）。
 *
 * ⚠️ `generations_absent` 也算 stale，但它的**行为不同**：它表示"计数器的数字还不可信"
 * （见 {@link FactVersions} 与 `apps/api/src/data.ts` 的回退分支），消费方在该状态下必须
 * **沿用今天的行为**，不得凭它把 `executable` 判 `false`、也不得凭它拒锁课 ——
 * 那不是在保护，而是把产品关掉（D2 的过渡期口径，2026-10-13 实测：全新库与"只走过普通
 * 导入路径的老库"里 `import_generations` 都是 `(0, 0)`，而训练事实已经在库里）。
 */
export interface Freshness {
  stale: boolean;
  reason: "up_to_date" | "analysis_behind" | "analysis_failed" | "analysis_missing" | "generations_absent";
  versions: FactVersions;
}

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
 * 不可能触发的条目要用 `vacuousOnDirectLane` 明写出来。
 *
 * ✅ 2026-10-13（PR4 步骤 4）：真空清单现在是**空的**，两条都补上了真通道 ——
 * `seed-import-generations` 补了 `storeMethod`；`canonical-nights-full-rebuild` 在直连车道
 * 接上**窗口重建**之后补了源码级通道 + 行为判据（见 `apps/api/test/direct-sync-ingest.test.ts`
 * 的野值金丝雀）。守卫测试把这份清单写死断言成空：再出现真空必须显式声明，不能悄悄混进来。
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
  /**
   * **源码级**通道：列出的文件里出现这些标识符（词边界）即视为触发。
   *
   * 只在别的手段都不可得时使用（这里是"包级函数"：既不是 worker 方法、也不是 store 方法、
   * 也不经过子进程）。它有源级判据的固有盲区（改名、间接调用、动态 import 都能绕），
   * 所以它**不能**单独构成保证 —— 配套的行为判据见
   * `apps/api/test/direct-sync-ingest.test.ts` 的"窗口外逐字节不变"。
   * 词边界是刻意的：`canonicalizeNights` 不会匹配到 `canonicalizeNightsForWindow`。
   */
  readonly forbiddenIdentifiers?: {
    readonly files: readonly string[];
    readonly identifiers: readonly string[];
  } | null;
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
    // ✅ 2026-10-13（PR4 步骤 4）：直连车道**现在会跑 canonical** —— 只按本批窗口跑
    // （`canonicalizeNightsForWindow`），全表版本仍然禁止。因此本条目不再是"声明的真空"：
    // 它有了两条真判据 ——①源码级（下面这个通道：直连接收器里不得出现全表函数），
    // ②行为级（`direct-sync-ingest.test.ts`：窗口外的 canonical 行必须逐字节不变）。
    forbiddenIdentifiers: {
      files: ["apps/api/src/direct-sync-ingest.ts", "apps/api/src/data-only-import.ts"],
      identifiers: ["canonicalizeNights"]
    },
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
      && (operation.forbiddenIdentifiers ?? null) === null
      && operation.commandSubcommands.length === 0
      && operation.stages.length === 0)
    .map((operation) => operation.id);
}
