/**
 * 读侧的**批次级分析影响证据**解析（v45 `import_batches.analysis_dirty_plan_json`）。
 *
 * ## 为什么这里有一份本地解析器（而不是 import 权威实现）
 *
 * 权威实现是 `@rai/health-export-parser/src/batch-dirty-evidence.ts`，schema 与三种出口
 * （`absent` / `invalid` / `ok`）以那份文件为准。但依赖方向是
 * `@rai/health-export-parser → @rai/storage-sqlite`（`dirty-range-input.ts` 用
 * `workoutPresentConditionSql()`），反向 import 会形成包环。所以本文件按同一份 schema
 * 重写一份**只读**解析：不认识版本/形状一律 `invalid`，绝不猜测。
 *
 * ## 与权威实现的同步纪律（改之前逐条确认）
 *
 * 1. **版本常量只跟随权威实现**：`BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION` 在权威实现里递增后，
 *    这里要跟着改；在此之前，库里的新版本证据对读侧是 `invalid` —— 方向**保守**
 *    （"这一批动过什么不知道" ⇒ 不被当作已发布覆盖），不是漏算。
 * 2. **不加"缺字段取默认值"的宽容**：`domains.features` 缺键与"该域全算"在语义上相反，
 *    把 `undefined` 读成 `null` 会把"证据不完整"说成"全算"。
 * 3. **只读**：本文件不写任何表。
 *
 * ## 三种出口
 *
 * - `absent`：没有值（v45 之前的老批次 / 该批不影响分析）⇒ 调用方走兼容路径（不额外触及）；
 * - `invalid`：有值但版本或形状不认识 ⇒ 调用方按**保守**处理（这一批可能动过任何训练）；
 * - `ok`：字段全部通过规范化校验。
 */

/** 当前能解读的形态（与权威实现 `batch-dirty-evidence.ts` 的常量同值）。 */
export const BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION = 1;

/** 已通过严格校验的批次证据（只保留读侧真正消费的字段；形状校验覆盖全部已知键）。 */
export interface BatchAnalysisDirtyEvidenceReadView {
  version: typeof BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION;
  /** `true` = 本批无法用增量计划表达 ⇒ 不能归因到单条训练。 */
  full: boolean;
  /** 从这一刻起（含）的分析输入可能变脏；`full: false` 时必非 null。 */
  dirtyFromAt: string | null;
  /**
   * 分域边界。`null` 的语义是**该域不可增量（全算）**，不是"该域不脏"
   * （见 `recompute-pipeline.ts` 的 `domainBoundaries`）—— 读侧必须按"全算"保守处理。
   */
  domains: { features: string | null; fitness: string | null; readiness: string | null };
  /** 本批改过路线所属训练的开始时刻（合成 route 条目）。 */
  routeDirtyTimes: string[];
  /** 本批触及的 canonical 恢复边界（夜/HRV 重建的时刻）。 */
  recoveryBoundaries: string[];
}

export type ParsedBatchAnalysisDirtyEvidence =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; evidence: BatchAnalysisDirtyEvidenceReadView };

/** 严格解析。任何形状问题都返回 `invalid`，**绝不**猜测。 */
export function parseBatchAnalysisDirtyEvidence(
  json: string | null | undefined
): ParsedBatchAnalysisDirtyEvidence {
  if (json === null || json === undefined || json.length === 0) return { status: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { status: "invalid", reason: "not_json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "invalid", reason: "not_an_object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION) {
    return { status: "invalid", reason: `unknown_version:${String(record.version)}` };
  }
  if (typeof record.full !== "boolean") return { status: "invalid", reason: "full_not_boolean" };
  const dirtyFromAt = pickInstant(record.dirtyFromAt);
  if (dirtyFromAt === undefined) return { status: "invalid", reason: "dirty_from_at_invalid" };
  // `domains` 读侧不直接消费边界时刻，但**形状必须校验**：缺键与"该域全算"语义相反，
  // 放过它等于把"证据不完整"读成"没问题"。（`null` 是合法的"该域全算"。）
  const domains = parseDomains(record.domains);
  if (domains === null) return { status: "invalid", reason: "domains_invalid" };
  const routeDirtyTimes = parseInstants(record.routeDirtyTimes);
  if (routeDirtyTimes === null) return { status: "invalid", reason: "route_dirty_times_invalid" };
  const recoveryBoundaries = parseInstants(record.recoveryBoundaries);
  if (recoveryBoundaries === null) {
    return { status: "invalid", reason: "recovery_boundaries_invalid" };
  }
  // `reasons` 是诊断字段，但缺键与"空数组"是两件事：写端从不省这个键，
  // 缺键只可能来自截断/漏写 ⇒ 形状损坏。
  if (!Array.isArray(record.reasons)
      || record.reasons.some((value) => typeof value !== "string")) {
    return { status: "invalid", reason: "reasons_invalid" };
  }
  if (!record.full && dirtyFromAt === null) {
    // "可增量但没有边界" 与 "全量" 是两件事：前者说明证据自相矛盾。
    return { status: "invalid", reason: "partial_without_boundary" };
  }
  return {
    status: "ok",
    evidence: {
      version: BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION,
      full: record.full,
      dirtyFromAt,
      domains,
      routeDirtyTimes,
      recoveryBoundaries
    }
  };
}

/** 与权威实现 `isCanonicalInstant` 同义（规范化 ISO 时刻；偏移写法不算）。 */
export function isCanonicalInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

/**
 * `undefined` = **缺字段**（形状不对）；`null` = 显式无值；`string` = 合法时刻。
 *
 * 🔴 三者必须分开：`domains.features` 为 `null` 表示"该域全算"，缺这个键表示
 * "证据不完整" —— 把后者读成前者会静默把一次漏算说成"全算"。
 */
function pickInstant(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isCanonicalInstant(value)) return undefined;
  return value;
}

function parseDomains(value: unknown): BatchAnalysisDirtyEvidenceReadView["domains"] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const domains = value as Record<string, unknown>;
  const features = pickInstant(domains.features);
  const fitness = pickInstant(domains.fitness);
  const readiness = pickInstant(domains.readiness);
  if (features === undefined || fitness === undefined || readiness === undefined) return null;
  return { features, fitness, readiness };
}

/**
 * 时刻数组。**缺键 = invalid**：写端总是写出这两个数组，因此 `undefined` 只可能来自
 * 截断/漏写；把它读成 `[]` 会把"证据不完整"说成"没有路线变更"。显式 `[]` 才是合法的"空"。
 */
function parseInstants(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const instants: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isCanonicalInstant(item)) return null;
    instants.push(item);
  }
  return [...new Set(instants)].sort();
}
