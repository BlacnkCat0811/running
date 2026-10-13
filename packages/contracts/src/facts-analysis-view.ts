/**
 * 事实侧 / 分析侧的**两块视图**形状（PR5 D1、D5，见 `docs/SQLITE_DIRECT_SYNC_PR5_DESIGN.md` §2）。
 *
 * 🔴 **为什么住在 `@rai/contracts` 而不是 `@rai/api-contracts`**（包边界，2026-10-13 实测修正）
 *
 * 这两块的**行类型与视图类型**同时被两层读：
 *   · 读侧实现（`packages/storage-sqlite/src/read/fact-read-view.ts`）——它**构造**这两个视图；
 *   · API 层（`packages/api-contracts`）——它把两个视图**装进响应类型**。
 *
 * 而 `storage-sqlite` **不依赖** `api-contracts`（依赖方向是 `api-contracts → contracts`，
 * `storage-sqlite → contracts`）。把形状留在 `api-contracts` 会让 `storage-sqlite` 出现
 * 一条**向上的** import：`npm run check:package-boundaries` 两个判据同时转红
 * （未声明的 src 边 + `package.json` 没声明该依赖 ⇒ 干净安装会崩），而 `tsc` 与测试全绿 ——
 * 典型的"编译期看不见、边界门禁才看得见"。
 *
 * 本文件顶部那句既有注释就是这条纪律：**contracts 是唯一一个其他包都依赖的包**。
 * 同一个理由此前已经让 `timezone.js` 与 `direct-sync.js` 住在这里。
 *
 * ## 三条硬约束（D1）—— 它们是这两组类型的**存在理由**
 *
 * §9.1 的原话是"API 明确区分 `currentFacts`（当前可变事实）与 `publishedAnalysis`（某次已发布
 * 分析的冻结输入与结论）"。本仓此前做不到的原因不是缺名字，而是**同一个响应里两套版本被
 * JOIN 成了一个值**（`WorkoutListItem.currentAbility` 既像"当前能力"又来自某个 release）。
 *
 * 1. **块内不许跨域** —— `FactsBlockRow` 不得含任何 `active_*` 来源字段，`AnalysisBlockRow`
 *    不得读当前可变事实。这不是靠注释保证的：下面的 `AssertNoCommonKey` 是**类型级**断言，
 *    任何一边越界都会让 `tsc` 红，且报错就落在越界的那一行上。
 * 2. **旧字段语义一个字节都不许变** —— 两块是**追加**的顶层可选字段，旧行类型一个字段都不动。
 *    原因见 §1.2 锚点 21：iOS 的 `TrainingPlanStateResponse.Metadata` 是**非可选**字段结构体，
 *    给旧结构加必填字段会让旧客户端 decode 直接失败（本仓没有 flag day 的余地）。
 * 3. **默认 `null`，不是空对象** —— `null` 表示"本端点还没有这一侧视图"。空对象是一个
 *    **会撒谎的占位**：它让"没有视图"和"视图里一行都没有"变成同一个响应，
 *    而这两件事的处置完全不同（前者退回旧字段，后者是"今天确实没有训练"）。
 */

export interface FactsBlockRow {
  workoutId: string;
  activityType: string;
  startAt: string;
  endAt: string;
  durationSeconds: number;
  distanceMeters: number | null;
  indoor: boolean | null;
  sourceCategory: string | null;
  /**
   * 未分析的事实显示 `"pending"`，**不用 `null` 分数**（D5）。
   * ⚠️ 刻意不是 `analysisState: "analyzed" | "pending" | null`：`null` 在这个仓里
   * 已经表示"分析过但没有值"（如 `distanceKm: null`），两种语义共用一个取值是踩过的坑。
   */
  analysisState: "pending" | "analyzed";
}

export interface AnalysisBlockRow {
  /**
   * 被分析的那条训练。
   *
   * 🔴 刻意**不叫** `workoutId`：事实行已经用了那个名字，而 D1.3 要求两块行类型的字段
   * 交集为**空**，所以连标识符都要分开命名。合名会让下面的 `AssertNoCommonKey` 转红 ——
   * 那正是设计要的效果：任何"两块共享一个字段"的形态都必须在编译期被拦住，而不是靠评审。
   */
  analyzedWorkoutId: string;
  /** 产出这一行的 release；与所在块的 `releaseId` 相同，显式带上是为了让行**自洽**。 */
  releaseId: string;
  currentAbility: number | null;
  qualityScore: number;
  stimulusType: string;
  /**
   * 冻结的距离与时长（`workout_features.distance_km` / `duration_seconds`），
   * **不是**当前事实的距离。
   *
   * 🔴 `frozen` 前缀是**结构**要求，不是命名品味：D1.3 的第三条硬约束是两块行类型的字段
   * 交集**为空**。事实行那边是"当前事实有多长"，分析行这边是"那次发布时输入有多长"——
   * 两者同名会让交集非空，于是那个类型级断言会红（下面 `AssertNoCommonKey`）。
   * 名字把它们分开之后，"分析行读了当前事实"在类型上就不可能悄悄发生。
   */
  frozenDistanceKm: number | null;
  frozenDurationSeconds: number;
  /** 冻结的开始时刻（`workout_features.workout_start_at`），不是 `training_sessions.anchor_start_at`。 */
  frozenStartedAt: string;
  /**
   * 这一行引用的训练事实**已被删除**（D4.3）：分析块**保留**它并标注，因为"当时的输入 +
   * 当时的结论"是历史证据（§9.1"旧 run 仍作为历史证据，相关汇总明确待更新"）。
   * 事实块里绝不会出现同一行 —— 那正是两块分离的可观测形式。
   */
  factDeleted: boolean;
}

/** 块内不许跨域：两个行类型的公有键必须为空。越界 ⇒ 这里报错，而不是靠评审发现。 */
type CommonKeys<A, B> = Extract<keyof A, keyof B>;
type AssertNoCommonKey<A, B> =
  CommonKeys<A, B> extends never ? true : { "两块视图的行类型字段交集必须为空": CommonKeys<A, B> };
export type FactsAnalysisBlocksDisjoint = AssertNoCommonKey<FactsBlockRow, AnalysisBlockRow>;

/** 当前可变事实的视图。只放事实，不含任何分析字段。 */
export interface FactsView {
  /** `import_generations.raw_generation`；`null` = 数字还不可信（`Freshness.reason === "generations_absent"`）。 */
  factVersion: string | null;
  /** 已删除事实**不出现**在这里。 */
  rows: FactsBlockRow[];
  /**
   * 有事实、但**未被当前 release 覆盖**的条数。
   *
   * 刻意不是"没有分析的行数"：`analysisState: "pending"` 回答"这一行有没有结论"，
   * 而本字段回答"当前 release 是不是已经把这些事实吃进去了" —— 前者是行属性，后者是**版本关系**，
   * 两者在"分析落后于事实"的过渡期会给出不同的数（D1 的理由）。
   */
  pendingAnalysisCount: number;
}

/** 某次已发布 release 的冻结输入与结论。只放分析，不读当前可变事实。 */
export interface AnalysisView {
  /** `active_model_run.model_run_id`。 */
  releaseId: string | null;
  /** `import_generations.dependency_generation`。 */
  dependencyVersion: string | null;
  rows: AnalysisBlockRow[];
  /** D2 的 freshness 派生，**本块唯一的 stale 出口**（别在行上加 `stale`）。 */
  stale: boolean;
}
