import { isCanonicalInstant, type AnalysisDirtyDomains } from "./dirty-range.js";

/**
 * B05（2026-10-17 第二轮复查）：**批次级分析影响证据**的形态与严格解析。
 *
 * ## 它回答什么问题
 *
 * 「这一批导入到底让哪些分析输入变脏」—— 包括**路线**变更。账本（`import_entity_changes`）
 * 只记记录/训练/活动摘要，不记路线；而路线-only 更正同样会改动训练特征与时间线。
 * 于是消费端在"只看账本"时无法重建含路线批次的边界，只能保守全量。
 *
 * 接收端在同一个事务里**已经**算过这份计划（`planIncrementalAnalysisDirtyRange` 的输入里，
 * 路线变更以"所属训练的开始时刻"作为合成条目传入）。本类型就是那份计划的可持久形态，
 * 落在 `import_batches.analysis_dirty_plan_json`（v45）。
 *
 * ## 为什么带 `version` 且解析必须严格
 *
 * 消费端要用它决定"允不允许 partial"。把损坏/未知版本读成"没有影响"就是**漏算**；
 * 读成"有一份计划"则是伪造证据。所以解析只有三种出口：
 *
 * - `absent`：没有值（v45 之前的老批次 / 该批不影响分析）⇒ 调用方走兼容路径；
 * - `invalid`：有值但版本或形状不认识 ⇒ 调用方**拒绝**（同样退全量，但原因与成本要如实记录）；
 * - `ok`：字段全部通过规范化校验。
 *
 * ⛔ 不做"缺字段 ⇒ 取默认值"的宽容：缺 `domains.features` 与"该域全算"在语义上相反。
 */

/**
 * 当前形态。
 *
 * ## 升级协议（改这个数之前逐条确认）
 *
 * 1. **只有字段语义/形状变了才递增**。「加了字段、旧证据仍能正确解读」⇒ 不要递增：解析器
 *    对多余键是宽容的，只有已知键的类型错误才会 `invalid`。
 * 2. 递增之后，库里**已经写出的旧版本证据全部变成 `invalid`**（解析对未知版本 fail-closed），
 *    消费端 `analysis-input-reader.ts` 的 `invalid` 分支 ⇒ 退全量。方向是**安全**的（慢，不漏算），
 *    但要接受一次全量重算的代价，并且**在提交 message 里写明**这次代价。
 * 3. 若不愿付这次全量：在解析器里为旧版本**显式加一个分支**（按旧语义构造等价的新证据），
 *    或在迁移里回填历史批次。⛔ 禁止"只抬常量、让旧行按新语义解读"—— 那是漏算。
 * 4. 生产写入点的 `version` 字段类型是 `typeof BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION`，
 *    所以"常量抬了、写入点没跟"是**类型错**，不需要人工守。真正需要人工守的是 1–3 条。
 *    本文件的测试另用**字面量**钉住当前值，等于强制在抬常量时回到这里写下结论。
 */
export const BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION = 1;

export interface BatchAnalysisDirtyEvidence {
  version: typeof BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION;
  /**
   * 该批**无法用增量计划表达**（`planIncrementalAnalysisDirtyRange` 返回 `full`）。
   * `true` ⇒ 任何包含它的合并计划都必须全量；其余边界字段没有意义。
   */
  full: boolean;
  /** `full: false` 时必须是一个可解析的规范时刻。 */
  dirtyFromAt: string | null;
  domains: AnalysisDirtyDomains;
  /**
   * 本批改过的路线所属训练的开始时刻（合成 route 条目的原始输入）。
   *
   * 保留它是为了让证据**可自查**：消费端不重算，但事后能比对"这批到底因为哪几条训练被
   * 判成路线脏"。它不含轨迹点，也不含 GPX。
   */
  routeDirtyTimes: string[];
  /** 本批触及的 canonical 恢复边界（夜/HRV 重建的时刻）。 */
  recoveryBoundaries: string[];
  /** 机器可读原因（`planIncrementalAnalysisDirtyRange` 的 `reasons`，诊断用）。 */
  reasons: string[];
}

export type ParsedBatchAnalysisDirtyEvidence =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; evidence: BatchAnalysisDirtyEvidence };

/** 序列化（只接受已构造好的证据；不做隐式修正）。 */
export function encodeBatchAnalysisDirtyEvidence(evidence: BatchAnalysisDirtyEvidence): string {
  return JSON.stringify(evidence);
}

/**
 * 严格解析。任何形状问题都返回 `invalid`，**绝不**猜测。
 */
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
  const domains = parseDomains(record.domains);
  if (domains === null) return { status: "invalid", reason: "domains_invalid" };
  const routeDirtyTimes = parseInstants(record.routeDirtyTimes);
  if (routeDirtyTimes === null) return { status: "invalid", reason: "route_dirty_times_invalid" };
  const recoveryBoundaries = parseInstants(record.recoveryBoundaries);
  if (recoveryBoundaries === null) {
    return { status: "invalid", reason: "recovery_boundaries_invalid" };
  }
  // `reasons` 是诊断字段，但**缺键**与"空数组"是两件事：前者是形状损坏（写端从来不会省），
  // 后者是合法的"没有原因"。缺键取默认值等于把"证据不完整"读成"没问题"。
  if (!Array.isArray(record.reasons)
      || record.reasons.some((value) => typeof value !== "string")) {
    return { status: "invalid", reason: "reasons_invalid" };
  }
  const reasons = [...record.reasons] as string[];
  if (!record.full && dirtyFromAt === null) {
    // "可增量但没有边界" 与 "全量" 是两件事。前者说明证据自相矛盾。
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
      recoveryBoundaries,
      reasons
    }
  };
}

/**
 * `undefined` = **缺字段**（形状不对）；`null` = 显式无值；`string` = 合法时刻。
 *
 * 🔴 `undefined` 与 `null` 必须分开：`domains.features` 为 `null` 表示"该域全算"，
 * 而**缺这个键**表示"证据不完整"。把后者读成前者会静默把一次漏算说成"全算"。
 */
function pickInstant(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isCanonicalInstant(value)) return undefined;
  return value;
}

function parseDomains(value: unknown): AnalysisDirtyDomains | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const domains = value as Record<string, unknown>;
  const features = pickInstant(domains.features);
  const fitness = pickInstant(domains.fitness);
  const readiness = pickInstant(domains.readiness);
  if (features === undefined || fitness === undefined || readiness === undefined) return null;
  return { features, fitness, readiness };
}

/**
 * 时刻数组。**缺键 = invalid**：写端 `encodeBatchAnalysisDirtyEvidence` 总是写出这两个数组，
 * 因此 `undefined` 只可能来自截断/漏写；把它读成 `[]` 会把"证据不完整"说成"没有路线变更"。
 * 显式 `[]` 才是合法的"空"。
 */
function parseInstants(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const instants: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isCanonicalInstant(item)) return null;
    instants.push(item);
  }
  // 去重 + 排序：合成条目只用于取最早边界，顺序不影响语义；规范化让证据可比。
  return [...new Set(instants)].sort();
}
