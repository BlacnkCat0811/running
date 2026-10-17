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
  /** 一次物化最多复制多少字节事实（真实 UTF-8 字节 + 行开销）。 */
  maxBytes: number;
  /**
   * 分段模式下**单条语句**允许返回的行数上限。
   * 🔴 超过即抛 {@link AnalysisInputReadBudgetExceeded}（任务失败），**不截断**继续算 ——
   * "少读了几行"会变成一份看起来完整、其实缺数据的输入，比失败更坏。
   */
  maxReadRows: number;
  /** 分段模式下单条语句允许的读取时长上限（毫秒）；超过同样抛错。 */
  maxReadMs: number;
}

/** 分段读的预算守卫：每读这么多行检查一次（时间上限也要能在单条大读内部生效）。 */
const READ_BUDGET_CHECK_EVERY = 512;
/** 达到上限的这个比例就记一条 `nearLimit`（给运维留提前量，不等到任务失败才发现）。 */
const READ_BUDGET_WARN_RATIO = 0.8;

/**
 * 单条事实读超预算。
 *
 * 携带表名、行数、耗时与两个上限，并点名可调的环境变量 —— 否则"任务失败"在事件里
 * 只剩一句 internal_error，运维只能猜。
 */
export class AnalysisInputReadBudgetExceeded extends Error {
  constructor(readonly detail: {
    table: string;
    rows: number;
    elapsedMs: number;
    maxReadRows: number;
    maxReadMs: number;
  }) {
    super(
      `Analysis fact read exceeded its budget (${detail.table}: ${detail.rows} rows, `
      + `${Math.round(detail.elapsedMs)} ms; limits rows=${detail.maxReadRows}, ms=${detail.maxReadMs}). `
      + "Raise RAI_ANALYSIS_INPUT_MAX_READ_ROWS / RAI_ANALYSIS_INPUT_MAX_READ_MS or narrow the read — "
      + "the input is never truncated."
    );
    this.name = "AnalysisInputReadBudgetExceeded";
  }
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
  // 🔴 O11 / WP-50（v43）之后，**已发布路线**的点只存在 `route_version_points` 一处：
  // `route_points` 退化成"只装指针为 NULL 的 legacy 路线"。所以两张都要进快照 ——
  // 只钉 `route_points` 的话，任何有过已发布路线的库在物化快照里**一个点都没有**，
  // CPU 相位的 routeQuality / 高程会与主库和 native 聚合器不是同一个世界。
  // 读端对"快照里取不到路线点"是**显式拒绝**（`RoutePointSourceUnavailableError`），
  // 所以漏钉不会静默改分数，但会硬失败 —— 那同样是错的，故此处在同批补齐。
  "route_points",
  "route_version_points",
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

/**
 * 事实侧的视图：`effective_workout_overrides` 是 `workout_overrides` 上的 take-latest 视图；
 * `readable_route_points` 是 v43 的**唯一路线点读入口**（按 `published_route_version_id`
 * 切开"已发布版本 / legacy 旧表"两条互斥分支）。
 *
 * 视图必须和表一起钉住：它们是同一个"读什么"的答案（O11 的判据只有一处），
 * 少钉一个就等于快照里少半条路径。
 */
export const PINNED_FACT_VIEWS: readonly string[] = [
  "effective_workout_overrides",
  "readable_route_points"
];

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

// ===================== R06（2026-10-17）：有界物化（事实裁剪） =====================
//
// 复查证据："输入捕获复制全部历史事实……捕获行数随全历史近似线性增长"。R06 的修法是
// **只物化必要行**；本节的机制层回答两个问题：**哪些行是必要的**、以及**裁错了怎么办**。
//
// 两类行之外的一切都是"复制了也从不被读"的死重（读取面已由三轮审计全会审过）：
// 1. **全史保留的类型**：`RESTING_HEART_RATE` / `VO2_MAX` —— 它们被"任意 asOf 可重算"的
//    证据链读取（`recompute-pipeline.ts` 的 `loadRestingHeartRateEvidence`/`recomputableEvidenceTimestamps`、
//    `prediction-data.ts` 的 `loadDirectVo2Evidence`），窗口化会改变合集与中位数；
// 2. **窗口保留的类型**：`HEART_RATE` / `RUNNING_SPEED` —— 明细行（可能每秒一条）只被
//    "训练窗 ∪ 回看窗"读取；窗口外的一律不读。
//
// ⚠️ `PRUNED_RECORD_TYPES_*` 是**唯一清单**：新增任何 `health_records` 的类型过滤都必须
// 先在这里表态（`analysis-input-pruning.test.ts` 有源码级判据把三处消费文件里的类型引用
// 与这份清单对账；漏表态会让新类型的数据被裁掉且无人察觉）。
export const FACT_PRUNE_ALWAYS_KEPT_RECORD_TYPES: readonly string[] = [
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierVO2Max"
];

export const FACT_PRUNE_WINDOWED_RECORD_TYPES: readonly string[] = [
  "HKQuantityTypeIdentifierHeartRate",
  "HKQuantityTypeIdentifierRunningSpeed"
];

/**
 * 明细类记录的最大回看窗：**365 天（乳酸阈值证据窗）+ 180 天（生理画像窗）**。
 *
 * 推导（`prediction-data.ts`）：阈值证据取 `asOf - 365d` 窗内会话（`:758`），每个会话再取
 * `会话 asOf - 180d` 的最大心率（`:497`）⇒ 最老需要的明细早于 `asOf - 545d`。
 * ⛔ 不要把它改小去"省几行"：它正是"裁剪边界"与"读取需求"之间的安全余量。
 */
export const RECORDS_MAX_LOOKBACK_MS = (365 + 180) * 86_400_000;

/** 单会话装配（`workoutAssembly`）对心率/速度明细的最大回看：训练 start - 180 天。 */
export const SESSION_RECORDS_LOOKBACK_MS = 180 * 86_400_000;

/**
 * 分区日链的峰值证据窗：**365 天**。
 *
 * 推导（`@rai/training-zones` 的 `buildDailyZoneProfile`）：某一天的 `comparableEvidence`
 * 取 365 天内、峰值不低于当前最大心率的资格峰值；`validPeaks`（180 天）与
 * `maximumHeartRateWorkouts` 都含在它里面 ⇒ 日链需要的明细下沿 = `该日 - 365 天`。
 * 守卫（`recompute-pipeline.assertFactCoverage`）用**这个**窗而不是
 * {@link RECORDS_MAX_LOOKBACK_MS}：后者更大 ⇒ 守卫更严 ⇒ 会在合法复用上误报。
 */
export const PEAK_EVIDENCE_LOOKBACK_MS = 365 * 86_400_000;

/** 表级过滤：`where` 里只允许自足的子查询/常量比较（复制与探针共用同一谓词）。 */
export interface FactTableFilter {
  where: string;
  params: readonly SQLInputValue[];
}

export type FactTableFilters = ReadonlyMap<string, FactTableFilter>;

/** 事实裁剪的**覆盖边界**（写进快照、供消费方守卫）。`null` 域 = 未裁剪。 */
export interface FactPruneCoverage {
  /** 物化的 HR/speed 明细起点（更早的被裁）；白名单类型不受它约束。 */
  recordsFrom: string;
  /** 物化路线点的会话下界（`workout.start_at < routeFrom` 的会话名下的点被裁）。 */
  routeFrom: string;
}

/** 快照覆盖元数据：消费方（pipeline）据它守卫越界读、替代全局 MIN 查询。 */
export interface SnapshotCoverage {
  recordsFrom: string | null;
  routeFrom: string | null;
  /**
   * 全局最早事实行的 id（捕获读事务内算出；**与运行期 `MIN(start_at)` 查询逐字同 SQL**）。
   * `null` = 库里没有事实行（与原查询的 `undefined` 等价）。快照模式**总是**提供；
   * 未提供（`undefined`，如分段模式）时消费方回退原查询。
   */
  globalEarliestRecordId: string | null;
}

/**
 * 由裁剪边界构造**表级过滤**（纯函数，逐字可测）。
 *
 * - `health_records`：白名单类型全史 + 窗口类型 `start_at >= recordsFrom`；
 * - `route_points` / `route_version_points`：只保留"被算会话"名下的点 —— 会话口径与
 *   `SqliteTrainingSessionRepository.listActiveForFeatures` **逐字一致**
 *   （`activity_type = ? AND status IN ('active','ambiguous')`），边界列 = `workout.start_at`
 *   （与 `extractFeatures` 的 `session.workoutStartAt >= dirtyFromAt` 同一列）。
 *   版本表走三跳（`route_versions.route_id → workout_routes.workout_id`），两条分支都覆盖。
 *
 * ⛔ 过滤谓词是"读到了也必须保守"的一侧：多留行只损失空间，少留行靠**覆盖守卫**
 * （`AnalysisInputCoverageOutOfBoundsError`）显式失败并回退全量 —— 绝不静默少读。
 */
export function buildFactTableFilters(
  coverage: FactPruneCoverage,
  runningActivityType: string
): FactTableFilters {
  const always = FACT_PRUNE_ALWAYS_KEPT_RECORD_TYPES;
  const windowed = FACT_PRUNE_WINDOWED_RECORD_TYPES;
  const sessionScope = `
    session.activity_type = ? AND session.status IN ('active', 'ambiguous')
    AND workout.start_at >= ?`;
  const filters: Array<[string, FactTableFilter]> = [
    [
      "health_records",
      {
        where: `type IN (${always.map(() => "?").join(", ")}) ` +
          `OR (type IN (${windowed.map(() => "?").join(", ")}) AND start_at >= ?)`,
        params: [...always, ...windowed, coverage.recordsFrom]
      }
    ],
    [
      "route_points",
      {
        where: `route_id IN (
          SELECT route.id FROM workout_routes route
          JOIN training_sessions session ON session.canonical_workout_id = route.workout_id
          JOIN workouts workout ON workout.id = session.canonical_workout_id
          WHERE ${sessionScope}
        )`,
        params: [runningActivityType, coverage.routeFrom]
      }
    ],
    [
      "route_version_points",
      {
        where: `route_version_id IN (
          SELECT version.id FROM route_versions version
          JOIN workout_routes route ON route.id = version.route_id
          JOIN training_sessions session ON session.canonical_workout_id = route.workout_id
          JOIN workouts workout ON workout.id = session.canonical_workout_id
          WHERE ${sessionScope}
        )`,
        params: [runningActivityType, coverage.routeFrom]
      }
    ]
  ];
  return new Map(filters);
}

/**
 * 裁剪守卫越界：某次读需要的数据早于**物化覆盖起点**。
 *
 * 语义（文档 §4-R06 步骤 2/7）：越界必须**显式失败或重新规划，不能默默返回空**。
 * 触发路径 = "计划说会复用、实际却全量重算"（复用被更深层证据拒绝）——调用方
 * （`runDirectSyncAnalysis`）捕获后**关闭裁剪重捕获一次**再跑，绝不循环。
 */
export class AnalysisInputCoverageOutOfBoundsError extends Error {
  constructor(
    readonly kind: "records" | "route",
    readonly requiredFrom: string,
    readonly coverageFrom: string,
    readonly context: string
  ) {
    super(
      `Analysis input coverage out of bounds (${kind}): need data from ${requiredFrom}, ` +
        `but the pinned snapshot only covers from ${coverageFrom} (${context})`
    );
    this.name = "AnalysisInputCoverageOutOfBoundsError";
  }
}

/** 分段读的实际用量：既用于审计，也用于"超预算必须说出来"的记账。 */
export interface AnalysisFactViewStats {
  mode: "materialized" | "segmented";
  /** 物化模式：复制的行／字节；分段模式：累计读到的行。 */
  rows: number;
  /**
   * 分段模式：**整份输入**的字节估计（来自探针，含每行开销），不是逐条读的累计。
   * 旧实现写死 0 —— 那让事件里的 `bytes` 看起来像"没读到字节"，是假的。
   */
  bytes: number;
  /** 语句次数。 */
  reads: number;
  /**
   * 分段模式：单条读**接近**上限（≥80%）的显式记账。
   * 超限不再记账 —— 它已经抛 {@link AnalysisInputReadBudgetExceeded} 让任务失败。
   */
  nearLimit: string[];
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
   * R06：快照的**覆盖元数据**（物化模式提供；分段模式为 `undefined` —— 它读源库、全量，
   * 消费方据此回退"未裁剪"行为）。守卫与全局 MIN 的替代读取都读它。
   */
  readonly snapshotCoverage?: SnapshotCoverage;
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
 * 预算探针：**只数行、只量字节**，不改任何东西。
 *
 * 🔴 字节口径 = `LENGTH(CAST(col AS BLOB))`（UTF-8 真实字节）。旧的 `LENGTH(col)` 对 TEXT
 * 返回**字符数**，中文/emoji 会被低估 2–4 倍 —— 于是"256 MiB 上限"在小语种数据上从未真正生效。
 *
 * 为什么行数先于字节：`SUM(...)` 是整表扫。行数一旦超预算，后面无论多少字节都已经"超过预算"，
 * 再扫一遍纯属浪费 —— 于是超行预算时直接给出下界，并标 `bytesExact: false`。
 *
 * R06（2026-10-16 复查）：`stopAfterRows` 让"超限即停"**真的停**（有界探针）——
 * 旧实现即使行数早已超限，也会把每个表的文本列 `SUM(LENGTH(...))` 全部扫完；
 * 而调用方（输入捕获）在行超限时必然转分段读，那些字节扫描是**纯浪费**（文档 §4-R06
 * 步骤 6：预算探针先按有界读取计划计数，达到上限立即停止）。
 * 传了预算后，超限时：`rows` / `tables` 是**已扫描的下界**、`bytes` 是行开销下界、
 * `bytesExact = false`；不传（默认无限）时行为与旧实现逐字节相同。
 */
export function probeFactSize(
  database: DatabaseSync,
  tables: readonly string[] = SNAPSHOT_TABLES,
  options: { stopAfterRows?: number; filters?: FactTableFilters } = {}
): { rows: number; bytes: number; bytesExact: boolean; tables: number } {
  const stopAfterRows = options.stopAfterRows ?? Number.POSITIVE_INFINITY;
  let rows = 0;
  let bytes = 0;
  let tablesCounted = 0;
  let bytesExact = true;
  for (const table of tables) {
    if (!tableExists(database, table)) continue;
    // R06：探针与**实际物化**共用同一份表级谓词（裁剪计划）—— 探针数的必须是"要复制的
    // 那些行"，否则超预算判定与物化规模脱钩（旧形态：裁剪后仍按全量判预算 ⇒ 大库永远
    // 直接转分段、裁剪路径永不触达）。
    const filter = options.filters?.get(table);
    // 表级 `COUNT(*)` 走最小索引、是整数计数；即使行数早已超限也保持**全清单**的计数
    // （`tables` 是审计字段，"看过哪些表"必须完整；而且它比文本扫描便宜一个量级）。
    const countRow = (filter
      ? database.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE ${filter.where}`).get(...filter.params)
      : database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()) as { n: number } | undefined;
    const count = Number(countRow?.n ?? 0);
    rows += count;
    bytes += count * ROW_OVERHEAD_BYTES;
    tablesCounted += 1;
    if (rows > stopAfterRows) {
      // 已经超限 ⇒ **不再对任何表做 `SUM(LENGTH(...))`**（那才是"为了判断是否超限又把全部
      // 历史行整行扫一遍"的浪费；R06 的原文反对的正是这一步）。判定不会因此改变：行超即
      // 超，调用方必然转分段读。字节从此只有行开销下界，并如实标记 `bytesExact: false`。
      bytesExact = false;
      continue;
    }
    if (count > 0) {
      const columns = (database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as Array<{ name: string }>)
        .map((column) => column.name);
      if (columns.length > 0) {
        const expression = columns.map((column) => `COALESCE(LENGTH(CAST("${column}" AS BLOB)), 0)`).join(" + ");
        const sumSql = `SELECT COALESCE(SUM(${expression}), 0) AS b FROM "${table}"`
          + (filter ? ` WHERE ${filter.where}` : "");
        const sumRow = (filter
          ? database.prepare(sumSql).get(...filter.params)
          : database.prepare(sumSql).get()) as { b: number } | undefined;
        bytes += Number(sumRow?.b ?? 0);
      }
    }
  }
  return { rows, bytes, bytesExact, tables: tablesCounted };
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
  /** R06：覆盖元数据（物化模式总是提供；未裁剪时 `recordsFrom/routeFrom` 为 null）。 */
  readonly snapshotCoverage: SnapshotCoverage;

  private disposed = false;
  private readonly state: AnalysisFactViewStats;

  constructor(
    private readonly memory: DatabaseSync,
    rows: number,
    bytes: number,
    private readonly liveGenerations: () => FactViewGenerations,
    coverage: SnapshotCoverage = { recordsFrom: null, routeFrom: null, globalEarliestRecordId: null }
  ) {
    this.database = memory;
    this.snapshotCoverage = coverage;
    // `reads` 只在分段模式下有意义（那里每条读都要开事务、核代次）；物化模式恒为 0。
    this.state = {
      mode: "materialized", rows, bytes, reads: 0, nearLimit: [], observedGenerations: [], rawAdvances: []
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
      nearLimit: [...this.state.nearLimit],
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
 * - `maxReadRows` / `maxReadMs` 是**硬上限**：单条读超过就抛
 *   {@link AnalysisInputReadBudgetExceeded}，任务失败并留下表名/耗时。**绝不截断** ——
 *   静默截断会变成"少读了几行"的错结果；只告警则等于没有上限（旧行为）。
 */
export class SegmentedFactView implements AnalysisFactView {
  readonly mode = "segmented" as const;
  readonly database: DatabaseSync;

  private reads = 0;
  private rows = 0;
  private readonly nearLimit: string[] = [];
  private readonly generations: string[] = [];
  private readonly rawAdvances: string[] = [];
  private disposed = false;

  constructor(
    private readonly source: DatabaseSync,
    private readonly captured: FactViewGenerations,
    private readonly budget: AnalysisInputBudget,
    /** 探针给出的整份输入字节估计（分段模式不逐条累计字节 —— 那要把每行再序列化一遍）。 */
    private readonly estimatedBytes: number
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
      bytes: this.estimatedBytes,
      reads: this.reads,
      nearLimit: [...this.nearLimit],
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
        return {
          all: (...args: SQLInputValue[]) => view.readAll(sql, args),
          get: (...args: SQLInputValue[]) => view.readOne(sql, args)
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

  /**
   * `all()` 的**有界**实现：逐行消费、每 {@link READ_BUDGET_CHECK_EVERY} 行查一次上限。
   *
   * 旧实现直接 `statement.all()`：结果集在调用返回前就已经全部物化，之后再看行数已经晚了 ——
   * "预算"只能事后记账。用 `iterate()` 才能在大结果集**内部**停手并抛错（不截断、不返回半份）。
   */
  private readAll(sql: string, args: SQLInputValue[]): unknown[] {
    if (this.disposed) throw new Error("Analysis fact view is closed");
    const started = performance.now();
    const began = this.beginRead();
    let completed = false;
    try {
      this.assertPinned("read");
      const statement = this.source.prepare(sql);
      const rows: unknown[] = [];
      for (const row of statement.iterate(...args)) {
        rows.push(row);
        if (rows.length % READ_BUDGET_CHECK_EVERY === 0) {
          this.assertReadBudget(sql, rows.length, performance.now() - started);
        }
      }
      const elapsedMs = performance.now() - started;
      this.assertReadBudget(sql, rows.length, elapsedMs);
      completed = true;
      this.record(sql, rows.length, elapsedMs);
      return rows;
    } finally {
      if (began) this.source.exec(completed ? "COMMIT" : "ROLLBACK");
    }
  }

  /** `get()`：至多一行，但**时长**上限同样成立（一条病态查询可以一行都读不完）。 */
  private readOne(sql: string, args: SQLInputValue[]): unknown {
    if (this.disposed) throw new Error("Analysis fact view is closed");
    const started = performance.now();
    const began = this.beginRead();
    let completed = false;
    try {
      this.assertPinned("read");
      const value = this.source.prepare(sql).get(...args);
      const elapsedMs = performance.now() - started;
      const rows = value === undefined ? 0 : 1;
      this.assertReadBudget(sql, rows, elapsedMs);
      completed = true;
      this.record(sql, rows, elapsedMs);
      return value;
    } finally {
      if (began) this.source.exec(completed ? "COMMIT" : "ROLLBACK");
    }
  }

  /** 超限即抛；**不**截断返回值。 */
  private assertReadBudget(sql: string, rows: number, elapsedMs: number): void {
    if (rows <= this.budget.maxReadRows && elapsedMs <= this.budget.maxReadMs) return;
    throw new AnalysisInputReadBudgetExceeded({
      table: firstTable(sql),
      rows,
      elapsedMs,
      maxReadRows: this.budget.maxReadRows,
      maxReadMs: this.budget.maxReadMs
    });
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

  /** 记账。这里只留"接近上限"的痕迹 —— 真超限已经在 {@link assertReadBudget} 抛出去了。 */
  private record(sql: string, rows: number, elapsedMs: number): void {
    this.reads += 1;
    this.rows += rows;
    this.generations.push(`${this.captured.raw}/${this.captured.dependency}@${firstTable(sql)}`);
    if (rows >= this.budget.maxReadRows * READ_BUDGET_WARN_RATIO) {
      this.nearLimit.push(`rows:${rows}/${this.budget.maxReadRows}:${firstTable(sql)}`);
    }
    if (elapsedMs >= this.budget.maxReadMs * READ_BUDGET_WARN_RATIO) {
      this.nearLimit.push(`durationMs:${Math.round(elapsedMs)}/${this.budget.maxReadMs}:${firstTable(sql)}`);
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
 * - 默认复制 `SELECT *` 的**全部行**。R06（2026-10-17）：`options.filters` 允许对**逐表**施加
 *   裁剪谓词（只物化必要行）——被裁表必须同时满足两条纪律，缺一不可：
 *   ① 谓词由 `buildFactTableFilters` 从覆盖边界构造（单一实现）；
 *   ② 消费方经**覆盖守卫**（`AnalysisInputCoverageOutOfBoundsError`）显式失败并回退全量——
 *      "只取脏区间那一段"若没有守卫就会静默改变结果，那正是本函数此前拒绝裁剪的理由。
 *   被裁表的复制 SQL 加 `ORDER BY rowid`（保持与全量复制相同的相对行序：快照内的 rowid 是
 *   插入序，而 `model-v2-snapshots.ts` 的 `ORDER BY start_at,rowid` 用它做同刻并列的 tie-break）。
 */
export function materializeFactSnapshot(
  source: DatabaseSync,
  tables: readonly string[] = SNAPSHOT_TABLES,
  views: readonly string[] = PINNED_FACT_VIEWS,
  options: { filters?: FactTableFilters } = {}
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
      const filter = options.filters?.get(table);
      const projection = columns.map((column) => `"${column}"`).join(", ");
      const select = source.prepare(
        filter
          ? `SELECT ${projection} FROM "${table}" WHERE ${filter.where} ORDER BY rowid`
          : `SELECT ${projection} FROM "${table}"`
      );
      // 逐行读 + 逐行写：事实表没有 BLOB 列，行数由预算探针兜住，不需要分块事务。
      const stream = (filter
        ? select.iterate(...filter.params)
        : select.iterate()) as Iterable<Record<string, SQLOutputValue>>;
      for (const row of stream) {
        const values = columns.map((column) => (row[column] ?? null) as SQLInputValue);
        insert.run(...values);
        rows += 1;
        bytes += ROW_OVERHEAD_BYTES;
      }
    }
    for (const table of tables) {
      // R06（2026-10-16 复查）：把源库在这些表上的**显式索引**一并重放 —— 快照此前只有表
      // 结构，于是"近期区间"查询在快照里退化成全表 `SCAN`（复查实测）。索引建在**数据全部
      // 插入之后**：比逐行维护索引快，且与源库同名同定义（`EXPLAIN QUERY PLAN` 的索引选择
      // 与源库一致）。`sql IS NULL` 的是主键/唯一约束的 auto-index —— 随建表 DDL 自动生成，
      // 不重放。⛔ 失败不静默：索引 SQL 直接取自源库，同版本 SQLite 必定能重放；
      // 吞掉失败会让"快照没索引"这种性能回归无声无息。
      const indexes = source.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
      ).all(table) as Array<{ sql: string | null }>;
      for (const index of indexes) {
        if (index.sql != null) memory.exec(index.sql);
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
