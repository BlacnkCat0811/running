import type { ImportExecutionEngine } from "@rai/api-contracts";

/**
 * 直连车道的判定与形状约束（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §2.2 / §2.6）。
 *
 * 为什么把这个判定单独抽出来：它原本内联在 `ImportWorker.run` 的一个六条件 `if` 里，
 * 读不出"为什么这批走了旧链路"。抽成纯函数之后，每一条否决都能被单测钉住，
 * 而且**新旧两条链路的分歧只在这一个地方**，不散落在 worker 的流程里。
 */

export interface DirectSyncLaneInput {
  /** 任务是否经排队入口。无队列的直跑路径不走直连车道。 */
  queued: boolean;
  /** 运行时回退开关：`false` 表示退回旧候选链路（`dataOnlyFastPath`）。 */
  fastPathEnabled: boolean;
  engine: Pick<ImportExecutionEngine, "name" | "version">;
  /** 当前构建的原生引擎版本；`engine.version` 与它不等时不出直连（执行语义会不一致）。 */
  nativeVersion: string;
  /** 载荷声明"缺省即删除"。为 `false` 时它是完整快照，**绝不能**走直连。 */
  preserveAbsent: boolean;
  databaseExists: boolean;
}

export interface DirectSyncLaneDecision {
  readonly lane: "direct" | "legacy";
  /**
   * 直连的**事实范围**。`"full"` = 这条车道接受任意增量载荷（Workout / 评分类型 / 显式删除 /
   * GPX 轨迹），并由接收器**按账本**决定要不要登记分析任务。
   *
   * 🔴 这里回答的是"车道**能不能**装下这类载荷"，不是"这批**是否**需要分析" ——
   * 后者必须等事实落库、账本出来才能判定（§2.4：分类是**事后**结论，不许为了分类再扫一遍 XML）。
   * 所以：
   *   - `"full"` 不等于"每批都会登记任务"：纯 record-only 载荷仍然不登记（回执 `not_required`）；
   *   - 一旦载荷里有 Workout / 评分类型 / 删除，接收器**必须在同一个事务里**登记 `import` 任务
   *     并把回执写成 `queued`（`apps/api/src/direct-sync-ingest.ts` 的提交前断言守着这条）。
   *
   * 2026-10-13（PR4 步骤 2e）由 `"record-only"` 放开到 `"full"`：三步顺序的第 1 步（消费者认识
   * `import`，`d2069a4`）与第 2 步（同事务登记 + 绑定列，`d08ad81`）都已落地，前置清空。
   * 改回去会让"Workout 批次原始已存、分析永不更新"重新变成可能 —— 直接违反上位设计 §1.5。
   */
  readonly deltaMode: "record-only" | "full" | null;
  /** 否决原因，按判定顺序。仅直连时为空。 */
  readonly reasons: readonly string[];
}

/** 判定本批走直连还是旧候选链路。纯函数：不读库、不写库、不看时间。 */
export function planDirectSyncLane(input: DirectSyncLaneInput): DirectSyncLaneDecision {
  const reject = (reason: string): DirectSyncLaneDecision => ({ lane: "legacy", deltaMode: null, reasons: [reason] });
  if (!input.queued) return reject("not_queued");
  if (!input.fastPathEnabled) return reject("fast_path_disabled");
  if (input.engine.name !== "typescript") return reject(`engine_${input.engine.name}`);
  if (input.engine.version !== input.nativeVersion) return reject("engine_version_mismatch");
  if (!input.preserveAbsent) return reject("payload_is_a_complete_snapshot");
  if (!input.databaseExists) return reject("no_existing_database");
  return { lane: "direct", deltaMode: "full", reasons: [] };
}

/**
 * 直连车道里**不允许存在**的字段。
 *
 * 这三个都能把"缺省即删除"打开：一旦载荷被当作完整快照，缺失的实体就会被判为已删除
 * —— 而直连车道的载荷是**部分**的，那等于**静默全库删除**。
 *
 * ⚠️ 关键：保证必须是"结构上不可能"，不是"记得别传 `false`"。
 * 所以直连恒为增量这一点由 {@link directSyncParserOptions} 的**返回类型**保证（写死字面量 `true`，
 * `false` 在类型上无法表达），而这里只负责在**运行期**再拦一次越界字段。
 */
export const DIRECT_SYNC_SNAPSHOT_FIELDS = ["preserveAbsent", "replaceAbsent", "guardAbsentRemoval"] as const;

/**
 * 直连车道的解析器增量选项。
 *
 * 🔴 **不接受参数、返回类型写死 `true`**：这不是"默认值"，是"唯一可能的值"。
 * 想让直连车道按完整快照解析，必须先改这个函数的签名 —— 那是一次显式、可被评审的改动，
 * 而不是某个调用点悄悄传了个 `false`。
 */
export function directSyncParserOptions(): { preserveAbsent: true } {
  return { preserveAbsent: true };
}

/**
 * 运行期兜底：直连请求对象里不得携带快照语义字段。
 *
 * 为什么需要它而不只是靠类型：TypeScript 的"多余属性检查"只作用于**对象字面量**。
 * `{ ...request, preserveAbsent: false }` 这种展开会静默通过类型检查 ——
 * 而那恰好是最容易写出来的写法。
 */
export function assertDirectSyncRequestShape(request: object): void {
  for (const field of DIRECT_SYNC_SNAPSHOT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(request, field)) {
      throw new Error(
        `Direct sync request must not carry \`${field}\`: it turns absence into deletion, ` +
        "and a partial payload would then delete every fact it does not mention."
      );
    }
  }
}
