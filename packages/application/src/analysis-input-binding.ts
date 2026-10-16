/**
 * 分析**输入绑定**（O06-A / WP-22，2026-10-16）。
 *
 * ## 它解决什么
 *
 * 接收端在同一个事务里登记了目标代次（`recompute_jobs.target_raw_generation` /
 * `target_dependency_generation`，v35），但消费端从来没有读过它们：分析一律从**可变的当前表**
 * 读事实。于是"这条发布到底算了哪一版输入"没有持久证据，发布判据只能用
 * `import_manifest.dataset_version` 逐字相等来兜底 —— 任何中介批次（哪怕它一行分析输入都没动）
 * 都会让候选被拒，而"输入在 CPU 计算期间被下一批改掉"却看不出来。
 *
 * 本模块定义那份证据的形状；覆盖判据本体住在 `@rai/contracts`
 * （`dependencyCoverageHolds`），因为发布端 `verifyAndPoint` 必须与这里**同一份实现**。
 */

export {
  dependencyCoverageHolds,
  selectInterveningBatches,
  type BatchGenerationFacts,
  type DependencyCoverageInput,
  type DependencyCoverageReason,
  type DependencyCoverageVerdict
} from "@rai/contracts";

export interface AnalysisInputBinding {
  runId: string;
  jobId: string;
  /** 分析范围标识（今天直连车道恒为 `"direct-sync"`；为合并任务留出区分空间）。 */
  scope: string;
  datasetVersion: string;
  /** 捕获时读到的 raw 代次（本批落库后）。 */
  capturedRawGeneration: number;
  /** 捕获时读到的依赖代次。 */
  capturedDependencyGeneration: number;
  /** 登记时承诺的目标代次（老任务为 null = 不承诺）。 */
  targetRawGeneration: number | null;
  targetDependencyGeneration: number | null;
  /** 登记时预期的 incumbent release。发布时用它做**比较**（此前只有写入方、无比较方）。 */
  incumbentReleaseId: string | null;
  timezoneIdentifier: string;
  overrideDigest: string;
  configDigest: string;
  cutoffAt: string;
  /** 输入摘要：把绑定揉成一个可比较的值，供发布时同批比较与审计留痕。 */
  inputDigest: string;
  createdAt: string;
}

/**
 * 输入摘要。
 *
 * ⛔ 它不是密码学承诺，也不能替代逐项校验：发布时仍要分别核验 incumbent、override 摘要与
 * 依赖覆盖。它的用途是**同批比较**（"发布时的输入与捕获时是不是同一版"）与审计留痕。
 * 刻意**不含 `runId`**：绑定行要等 `model_runs` 建好之后才写，而摘要在捕获时就算出来了。
 *
 * ⛔ 分隔符用 `\u0001` 而**不是** `\u0000`：`node:sqlite` 绑定字符串时按 C 字符串处理，
 * NUL 会被**静默截断** —— 摘要于是退化成"只有第一个字段"，而它看起来仍是一个正常摘要。
 * （2026-10-16 由 WP-32 实测发现；`overrideSnapshotDigest` 一开始就用的 `\u0001`，
 * 所以只有这里中了。本摘要不参与任何安全判定，但"看起来对、其实只剩一个字段"正是要避免的。）
 */
export function analysisInputDigest(parts: {
  scope: string;
  datasetVersion: string;
  capturedRawGeneration: number;
  capturedDependencyGeneration: number;
  incumbentReleaseId: string | null;
  timezoneIdentifier: string;
  overrideDigest: string;
  configDigest: string;
  cutoffAt: string;
}): string {
  return [
    parts.scope,
    parts.datasetVersion,
    String(parts.capturedRawGeneration),
    String(parts.capturedDependencyGeneration),
    parts.incumbentReleaseId ?? "-",
    parts.timezoneIdentifier,
    parts.overrideDigest,
    parts.configDigest,
    parts.cutoffAt
  ].join("\u0001");
}
