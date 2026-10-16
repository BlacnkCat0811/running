import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

/**
 * 分析**事实视图**（O06-A / WP-22 步骤 3–5，2026-10-16）。
 *
 * ## 它在整条链上的位置
 *
 * 步骤 1–2（WP-22a `93fd898`）已经让分析在**独立只读连接的一个读事务**里捕获
 * `AnalysisInputBinding`：这次算的是哪一版输入，有了持久证据。但那次捕获**只读绑定**：
 * 真正的事实（`health_records` / `workouts` / `canonical_nights` / override / 分区设置…）
 * 仍然是运行期间从 `pipeline.database` —— 也就是**写租约闸门后面那条连接** —— 懒散地、
 * 反复地读的。于是绑定说的是一版输入，CPU 阶段读到的却可能是另一版：
 * 导入批次在特征阶段和负荷阶段之间提交，候选就成了**混代**结果。
 *
 * 本模块提供那份"固定输入"：
 *
 * - {@link SnapshotFactView}（**物化**，小任务）：在捕获的**同一个读事务**里把事实表复制进
 *   一块 `:memory:` 快照；读事务随即关闭，CPU 阶段**没有任何读事务开着**，事实读取只命中快照。
 * - {@link SegmentedFactView}（**分段**，超过预算的大任务）：不建整库快照，改为**逐条读各自
 *   一个短读事务**，并且**每条读都在同一个事务里核对 `import_generations`** —— 读到的代次
 *   与捕获代次不一致就抛 {@link AnalysisInputDriftError}，绝不把两代事实拼在一起。
 *
 * ## ⛔ 这不是"复制主库"，也不是"整库快照"
 *
 * 复制面**只有事实表**（{@link PINNED_FACT_TABLES}），派生结果（`workout_features`、
 * `ability_assessments`、`daily_*`、发布指针…）一行都不复制 —— 历史前缀继续读**已发布的派生结果**
 * （O09 的前缀复用路径），这里不造版本计数器、不做版本回填。快照是**进程内内存**（`:memory:`），
 * 不落盘、不复制数据库文件、不持锁，`dispose()` 即消失。
 *
 * ## 为什么内存快照不算"第二条连接"
 *
 * `write-lease.test.ts` 的结构判据要求分析侧**只有一条通往主库的连接**（它必须经过写闸门）。
 * `:memory:` 不打开任何文件、不参与 WAL、不持任何主库锁，因此既不绕过写许可，也不制造
 * 第二个写者；它只是"把这次要算的输入拿出来"的一块缓冲区。主库连接仍然只有一条
 * （注入的只读连接 + 闸门后的写连接），本模块**不打开主库**。
 */

/**
 * 物化／分段预算。
 *
 * 判定顺序：先数行（`COUNT(*)`，走最小索引），超了就**不再**做字节扫描；行数在预算内
 * 才算字节（真字节：所有文本列 `LENGTH` 之和 + 每行固定开销）。
 */
export interface AnalysisInputBudget {
  /** 一次物化最多复制多少行事实。 */
  maxRows: number;
  /** 一次物化最多复制多少字节事实（近似：文本列长度 + 行开销）。 */
  maxBytes: number;
  /** 分段模式下**单条语句**允许返回的行数上限；超过只记账并上报，不静默。 */
  maxReadRows: number;
  /** 分段模式下单条语句允许的读取时长上限（毫秒）；超过只记账并上报。 */
  maxReadMs: number;
}

/**
 * 默认预算：够覆盖一台手表几年、几十万条记录的私人库；超过它说明这个库不适合
 * "一次读事务把输入拿出来"，此时走分段校验读而不是无限读（见 O06-A 步骤 4）。
 */
export const DEFAULT_ANALYSIS_INPUT_BUDGET: AnalysisInputBudget = {
  maxRows: 400_000,
  maxBytes: 256 * 1024 * 1024,
  maxReadRows: 250_000,
  maxReadMs: 15_000
};

/**
 * 被固定的事实表 —— **全量清单**，不是只冻结心率表。
 *
 * 分类口径：由导入／用户输入写入、且分析**读**它们的行。派生结果表（`workout_features`、
 * `ability_assessments`、`daily_*`、`workout_training_loads`、`model_*`、`recompute_jobs`…
 * 以及 `analysis_run_input_bindings` / `analysis_job_coverage`）不在此列：它们要么由本次
 * 运行自己写，要么属于发布证据。
 */
export const PINNED_FACT_TABLES: readonly string[] = [
  "health_records",
  "workouts",
  "workout_statistics",
  "workout_routes",
  "route_points",
  "training_sessions",
  "workout_overrides",
  "canonical_nights",
  "canonical_hrv_days",
  "profile",
  "training_zone_profile_settings",
  "performance_entries",
  "import_manifest",
  "import_entity_changes",
  "import_entity_tombstones"
];

/** 事实侧的视图：`effective_workout_overrides` 是 `workout_overrides` 上的 take-latest 视图。 */
export const PINNED_FACT_VIEWS: readonly string[] = ["effective_workout_overrides"];

/**
 * **已发布派生结果**里被证据读取 JOIN 到的那几张（成绩/标签证据走
 * `prediction-data.ts`：`training_sessions ⋈ workout_features ⋈ model_runs ⋈ active_model_run`）。
 *
 * 为什么它们也进快照：那些查询是"事实 ⋈ 已发布派生"，**不能**只按事实切分（SQL 在另一个
 * 模块里，且拆开等于把一份查询抄两遍）。把这几张**发布后不可变**的表一起冻结，读到的就是
 * "捕获那一刻的当前发布 + 那一刻的事实"，两侧同源；`active_model_run` 冻结的正是绑定里
 * 记下的那个 incumbent。它们不是"整库快照"：没有 `daily_*`、没有 checkpoint、没有任务表，
 * 也不落盘。
 */
export const PINNED_PUBLISHED_EVIDENCE_TABLES: readonly string[] = [
  "workout_features",
  "model_runs",
  "active_model_run"
];

/**
 * 物化快照要复制的表：事实 + 上面那几张已发布证据表。
 *
 * ⛔ 仍然**只**复制这些：派生计算表（`daily_*`、`ability_assessments`、checkpoint、
 * `workout_training_loads`…）与发布/任务表一行都不复制 —— 它们要么由本次运行自己写，
 * 要么属于发布证据，快照会把"自己刚写的行"读成旧版本。
 */
export const SNAPSHOT_TABLES: readonly string[] = [
  ...PINNED_FACT_TABLES,
  ...PINNED_PUBLISHED_EVIDENCE_TABLES
];

/** 分段读的实际用量：既用于审计，也用于"超预算必须说出来"的记账。 */
export interface AnalysisFactViewStats {
  mode: "materialized" | "segmented";
  /** 物化模式：复制的行／字节；分段模式：累计读到的行（字节不重复统计）。 */
  rows: number;
  bytes: number;
  /** 语句次数。 */
  reads: number;
  /** 分段模式：单条读超过 `maxReadRows` / `maxReadMs` 的**显式**记账（不是静默截断）。 */
  overruns: string[];
  /** 分段模式下每条读实际观察到的代次集合，用于证明"整段同代"。 */
  observedGenerations: string[];
  /**
   * 分段模式下观察到的 **raw-only** 前进（依赖代次没动的批次）。
   *
   * 它们**不**作废候选：判据是"依赖绑定未变"（O06-A 步骤 5 的原话），而 raw-only 批次按
   * 定义没有推动依赖代次 —— 与发布短事务里 D4 准入用的是同一个分类结论。这里只留痕，
   * 让"这一版算的时候 raw 动过"成为可查事实，而不是悄悄放过。
   */
  rawAdvances: string[];
}

/** 段间代次判据的粒度为「代次对」。 */
export interface FactViewGenerations {
  raw: number;
  dependency: number;
}

/**
 * 输入在计算中途被下一批改掉 —— **不是**普通错误：候选必须整体作废（保留旧发布结果），
 * 由调用方合并新增 dirty 范围后重排（O06-A 步骤 5）。
 *
 * 单独一个错误类型是为了让调用方能**只**对这一种失败做重排，而不是把任何异常都当成"重来"。
 */
export class AnalysisInputDriftError extends Error {
  constructor(
    readonly stage: string,
    readonly expected: FactViewGenerations,
    readonly observed: FactViewGenerations
  ) {
    super(
      `Analysis input changed during ${stage}: captured raw/dependency ` +
        `${expected.raw}/${expected.dependency}, observed ${observed.raw}/${observed.dependency}`
    );
    this.name = "AnalysisInputDriftError";
  }
}

/** 事实读取的最小形状：只读，且**没有** `run` —— 写入仍然只能走 `AnalysisStore`。 */
export interface AnalysisFactStatement {
  all(...args: SQLInputValue[]): unknown;
  get(...args: SQLInputValue[]): unknown;
}

export interface AnalysisFactView {
  readonly mode: "materialized" | "segmented";
  /**
   * 交给 pipeline 的事实读取句柄。它可能是真实的内存 `DatabaseSync`（物化模式），
   * 也可能是逐条读加校验的代理（分段模式）—— 两者都只支持 `prepare(...).all()/.get()`。
   */
  readonly database: DatabaseSync;
  /** 当前观察到的代次（活读，不经过快照）。 */
  observeGenerations(): FactViewGenerations;
  /** 段间判据：物化模式恒成立（快照已固定）；分段模式核对代次，变了就抛 drift。 */
  assertPinned(stage: string): void;
  stats(): AnalysisFactViewStats;
  dispose(): void;
}

/** 每行固定开销（SQLite 行头 + 列指针）；文本列另按 `LENGTH` 计。 */
const ROW_OVERHEAD_BYTES = 32;

function tableExists(database: DatabaseSync, name: string): boolean {
  return database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE name = ?")
    .get(name) !== undefined;
}

function readGenerations(database: DatabaseSync): FactViewGenerations {
  if (!tableExists(database, "import_generations")) return { raw: 0, dependency: 0 };
  const row = database.prepare(
    "SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton = 1"
  ).get() as { raw: number; dependency: number } | undefined;
  return { raw: Number(row?.raw ?? 0), dependency: Number(row?.dependency ?? 0) };
}

/**
 * 预算探针：**只数行、只量文本**，不改任何东西。
 *
 * 为什么行数先于字节：`SUM(LENGTH(...))` 是整表扫。行数一旦超预算，后面无论多少字节都
 * 已经"超过预算"，再扫一遍纯属浪费 —— 于是超行预算时直接给出下界，并标 `bytesExact: false`。
 */
export function probeFactSize(
  database: DatabaseSync,
  tables: readonly string[] = SNAPSHOT_TABLES
): { rows: number; bytes: number; bytesExact: boolean; tables: number } {
  let rows = 0;
  let bytes = 0;
  let tablesCounted = 0;
  for (const table of tables) {
    if (!tableExists(database, table)) continue;
    const count = Number(
      (database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n
    );
    rows += count;
    bytes += count * ROW_OVERHEAD_BYTES;
    tablesCounted += 1;
    if (count > 0) {
      const columns = (database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{ name: string }>)
        .map((column) => column.name);
      if (columns.length > 0) {
        const expression = columns.map((column) => `COALESCE(LENGTH("${column}"), 0)`).join(" + ");
        bytes += Number(
          (database.prepare(`SELECT COALESCE(SUM(${expression}), 0) AS b FROM "${table}"`).get() as { b: number }).b
        );
      }
    }
  }
  return { rows, bytes, bytesExact: true, tables: tablesCounted };
}

/**
 * **物化**事实视图：把 `PINNED_FACT_TABLES` 复制进一块 `:memory:` 快照。
 *
 * ⛔ 复制必须发生在**捕获绑定的那个读事务里**（见 `SqliteAnalysisInputReader.capture`）：
 * 绑定与事实同源才算"输入固定"。本类只提供复制与读取，事务由调用方持有。
 */
export class SnapshotFactView implements AnalysisFactView {
  readonly mode = "materialized" as const;
  readonly database: DatabaseSync;

  private disposed = false;
  private readonly state: AnalysisFactViewStats;

  constructor(
    private readonly memory: DatabaseSync,
    rows: number,
    bytes: number,
    private readonly liveGenerations: () => FactViewGenerations
  ) {
    this.database = memory;
    // `reads` 只在分段模式下有意义（那里每条读都要开事务、核代次）；物化模式恒为 0。
    this.state = {
      mode: "materialized", rows, bytes, reads: 0, overruns: [], observedGenerations: [], rawAdvances: []
    };
  }

  observeGenerations(): FactViewGenerations {
    return this.liveGenerations();
  }

  /** 物化模式没有"续算分段"：整段输入来自一个读事务，快照本身就是判据。 */
  assertPinned(): void {}

  stats(): AnalysisFactViewStats {
    return {
      ...this.state,
      overruns: [...this.state.overruns],
      observedGenerations: [...this.state.observedGenerations],
      rawAdvances: [...this.state.rawAdvances]
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.memory.close();
  }
}

/**
 * **分段**事实视图：预算不够时的路径 —— 不建整库快照，逐条读各自一个短读事务。
 *
 * 每一条读都是同一个形状：
 *
 * ```
 * BEGIN DEFERRED;
 *   SELECT raw_generation, dependency_generation FROM import_generations;  -- 先看代次
 *   SELECT ...事实...;                                                      -- 再读事实
 * COMMIT;
 * ```
 *
 * 代次在**同一个读事务**里读，所以"这批事实属于哪一代"是结构性事实而不是猜测：
 * 导入在提交批次与事实的**同一个事务**里递增 `import_generations`（见
 * `apps/api/src/direct-sync-ingest.ts`），因此代次相等 ⇒ 没有更晚的批次存在于这条读里。
 *
 * ## 判据是**依赖代次**（O06-A 步骤 5 的原话："验证依赖绑定未变"）
 *
 * - `dependency_generation` 变了：绑定真的变了 ⇒ 抛 {@link AnalysisInputDriftError}，
 *   候选整体作废（保留旧发布结果），由调用方合并新增 dirty 范围后重排。
 * - 只有 `raw_generation` 前进了（raw-only 批次）：绑定没变 ⇒ **不作废**，但逐条留痕
 *   （{@link AnalysisFactViewStats.rawAdvances}）。这不是"这里的自行放宽"：依赖代次只在
 *   直连车道把本批判为 `analysis-required` 时才 +1（`classifyDirectSyncPayload`），
 *   所以 raw-only 批次**按构造**不含评分输入 —— `@rai/contracts` 的
 *   `dependencyCoverageHolds` 正是拿这条结构性事实当证明（"currentDependency ≤ captured
 *   ⇒ 成立"），发布端 D4 放行的也是同一档。计算期与发布期用**同一个结论**，不允许两处
 *   各判一次：判据分叉的方向永远是"计算更松、发布更严"或反之，两个方向都出过事故。
 * - `maxReadRows` / `maxReadMs` 越界只记账上报，不截断 —— 静默截断会变成"少读了几行"的错结果。
 */
export class SegmentedFactView implements AnalysisFactView {
  readonly mode = "segmented" as const;
  readonly database: DatabaseSync;

  private reads = 0;
  private rows = 0;
  private readonly overruns: string[] = [];
  private readonly generations: string[] = [];
  private readonly rawAdvances: string[] = [];
  private disposed = false;

  constructor(
    private readonly source: DatabaseSync,
    private readonly captured: FactViewGenerations,
    private readonly budget: AnalysisInputBudget
  ) {
    this.database = this.proxy();
  }

  observeGenerations(): FactViewGenerations {
    return readGenerations(this.source);
  }

  assertPinned(stage: string): void {
    const observed = readGenerations(this.source);
    if (observed.dependency !== this.captured.dependency) {
      throw new AnalysisInputDriftError(stage, { ...this.captured }, observed);
    }
    if (observed.raw !== this.captured.raw) {
      this.rawAdvances.push(`${stage}:${this.captured.raw}->${observed.raw}`);
    }
  }

  stats(): AnalysisFactViewStats {
    return {
      mode: "segmented",
      rows: this.rows,
      bytes: 0,
      reads: this.reads,
      overruns: [...this.overruns],
      observedGenerations: [...new Set(this.generations)],
      rawAdvances: [...this.rawAdvances]
    };
  }

  dispose(): void {
    // 只读连接由读取器（worker 线程）持有并关闭；这里不越权关别人的连接。
    this.disposed = true;
  }

  /**
   * 只读代理。写成 `DatabaseSync` 是因为读取器要把句柄交给一批只读装配函数
   * （`readinessForRun` / `loadDirectVo2Evidence` / `listActiveForFeatures` …），
   * 它们只调用 `prepare(...).all()/.get()`。**唯一的类型断言就在这一处**，
   * 且 `run` / `exec` 一律显式抛错 —— 事实视图不许写。
   */
  private proxy(): DatabaseSync {
    const view = this;
    const proxy = {
      prepare(sql: string): AnalysisFactStatement {
        const statement = view.source.prepare(sql);
        return {
          all: (...args: SQLInputValue[]) => view.read(sql, () => statement.all(...args), "all"),
          get: (...args: SQLInputValue[]) => view.read(sql, () => statement.get(...args), "get")
        };
      },
      exec(): never {
        throw new Error("Pinned analysis facts are read-only: writes go through AnalysisStore");
      },
      close(): void {
        view.dispose();
      }
    };
    return proxy as unknown as DatabaseSync;
  }

  /** 一条读 = 一个短读事务 + 一次同事务代次核对。 */
  private read<T>(sql: string, run: () => T, action: "all" | "get"): T {
    if (this.disposed) throw new Error("Analysis fact view is closed");
    const started = performance.now();
    const began = this.beginRead();
    let completed = false;
    try {
      this.assertPinned("read");
      const value = run();
      completed = true;
      this.record(sql, value, action, performance.now() - started);
      return value;
    } finally {
      if (began) this.source.exec(completed ? "COMMIT" : "ROLLBACK");
    }
  }

  /**
   * 读事务边界。正常情况下这里一定是"从没有事务"进入；`BEGIN` 报"已在事务里"
   * （调用方自己开了外层事务）时不重复开，此时本条读与调用方共享那个快照 —— 代次核对语义不变。
   */
  private beginRead(): boolean {
    try {
      this.source.exec("BEGIN DEFERRED");
      return true;
    } catch (error) {
      if (/within a transaction/i.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
  }

  private record(sql: string, value: unknown, action: "all" | "get", elapsedMs: number): void {
    const rows = action === "get" ? (value === undefined ? 0 : 1) : Array.isArray(value) ? value.length : 0;
    this.reads += 1;
    this.rows += rows;
    this.generations.push(`${this.captured.raw}/${this.captured.dependency}@${firstTable(sql)}`);
    if (rows > this.budget.maxReadRows) {
      this.overruns.push(`rows:${rows}>${this.budget.maxReadRows}:${firstTable(sql)}`);
    }
    if (elapsedMs > this.budget.maxReadMs) {
      this.overruns.push(`durationMs:${Math.round(elapsedMs)}>${this.budget.maxReadMs}:${firstTable(sql)}`);
    }
  }
}

/** 取语句里第一个表名，仅用于上报（不参与判定，允许近似）。 */
function firstTable(sql: string): string {
  const match = /(?:from|join)\s+([a-z_][a-z0-9_]*)/i.exec(sql);
  return match?.[1] ?? "unknown";
}

/**
 * 把事实表复制进一块新的 `:memory:` 快照。
 *
 * - 表结构从 `sqlite_master` **原样重放**（不手抄列名，迁移改列不会漂）。
 * - 视图最后建（`effective_workout_overrides` 依赖 `workout_overrides`）。
 * - 外键**关掉**：事实表之间有引用（`route_points → workout_routes` 等），按引用序复制既慢又脆；
 *   快照只读，关外键不影响正确性。
 * - 复制的是 `SELECT *` 的**全部行**：事实读取里存在 `MIN(start_at)`、全历史 RHR 证据这类
 *   全局语义，"只取脏区间那一段"会静默改变结果。取不动就分段读（超预算路径），不偷偷少取。
 */
export function materializeFactSnapshot(
  source: DatabaseSync,
  tables: readonly string[] = SNAPSHOT_TABLES,
  views: readonly string[] = PINNED_FACT_VIEWS
): { database: DatabaseSync; rows: number; bytes: number } {
  const memory = new DatabaseSync(":memory:");
  memory.exec("PRAGMA foreign_keys = OFF");
  let rows = 0;
  let bytes = 0;
  try {
    for (const table of tables) {
      const ddl = source.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string | null } | undefined;
      if (ddl?.sql == null) continue;
      memory.exec(ddl.sql);
      const columns = (source.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{ name: string }>)
        .map((column) => column.name);
      if (columns.length === 0) continue;
      const insert = memory.prepare(
        `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) ` +
        `VALUES (${columns.map(() => "?").join(", ")})`
      );
      const select = source.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(", ")} FROM "${table}"`);
      // 逐行读 + 逐行写：事实表没有 BLOB 列，行数由预算探针兜住，不需要分块事务。
      for (const row of select.iterate() as Iterable<Record<string, SQLOutputValue>>) {
        const values = columns.map((column) => (row[column] ?? null) as SQLInputValue);
        insert.run(...values);
        rows += 1;
        bytes += ROW_OVERHEAD_BYTES;
      }
    }
    for (const view of views) {
      const ddl = source.prepare("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
        .get(view) as { sql: string | null } | undefined;
      if (ddl?.sql == null) continue;
      memory.exec(ddl.sql);
    }
    // 字节：文本列长度之和（与探针同口径）。
    for (const table of tables) {
      if (!tableExists(memory, table)) continue;
      const columns = (memory.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{ name: string }>)
        .map((column) => column.name);
      if (columns.length === 0) continue;
      const expression = columns.map((column) => `COALESCE(LENGTH("${column}"), 0)`).join(" + ");
      bytes += Number(
        (memory.prepare(`SELECT COALESCE(SUM(${expression}), 0) AS b FROM "${table}"`).get() as { b: number }).b
      );
    }
    return { database: memory, rows, bytes };
  } catch (error) {
    memory.close();
    throw error;
  }
}

export { readGenerations as readFactViewGenerations, firstTable as factReadLabel };
