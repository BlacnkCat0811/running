import { beginOwnedTransaction, commitOwnedTransaction, rollbackOwnedTransaction } from "./owned-transaction.js";
import type { DatabaseSync } from "node:sqlite";

import { DATABASE_TIMEZONE, healthTypes } from "@rai/contracts";

import { localDateAt, localDateTimeAt, stableId } from "./utils.js";

/**
 * 算法版本写入每行的 `provenance_json.algorithmVersion`，用来回答"这行是哪版算法产的"。
 *
 * `v1 → v2`：日期范围从"只看段的开始时刻"改为"开始与结束都看"。
 * v1 下**最近的一夜永远不入表**（那一夜的段都开始于前一晚），而 `canonicalizeNights`
 * 本身是 DELETE + 全量重建，所以下一次导入就会用新版本覆盖全部行
 * （与 `docs/DATA_PIPELINE.md` 的 bump 政策一致）。
 */
export const CANONICAL_NIGHT_ALGORITHM_VERSION = "canonical-night-v2" as const;

export type CanonicalNightKind = "main" | "nap";
export type HrvDayConfidence = "confident" | "sparse" | "missing";

export interface CanonicalNight {
  id: string;
  wakeDate: string;
  timezoneIdentifier: string;
  kind: CanonicalNightKind;
  sourceName: string;
  sourceCategory: string;
  sourceRank: number;
  hasStages: boolean;
  sleepOnsetAt: string | null;
  wakeAt: string | null;
  asleepUnionMinutes: number | null;
  inBedUnionMinutes: number | null;
  awakeMinutes: number | null;
  stageMinutes: { core: number; deep: number; rem: number; unspecified: number; awake: number };
  segmentCount: number;
  provenance: { algorithmVersion: typeof CANONICAL_NIGHT_ALGORITHM_VERSION; competingSourceCount: number; rejectedInBedOnly: boolean };
}

export interface CanonicalHrvDay {
  id: string;
  localDate: string;
  timezoneIdentifier: string;
  nightId: string;
  hrvSdnnMs: number | null;
  sampleCount: number;
  confidence: HrvDayConfidence;
  windowStartAt: string | null;
  windowEndAt: string | null;
  sourceName: string | null;
  provenance: { algorithmVersion: typeof CANONICAL_NIGHT_ALGORITHM_VERSION; fallbackWatch: boolean };
}

interface Segment {
  id: string;
  sourceName: string;
  sourceCategory: string;
  value: string;
  start: number;
  end: number;
}

const STAGE_VALUES = new Map<string, keyof CanonicalNight["stageMinutes"]>([
  ["HKCategoryValueSleepAnalysisAsleepCore", "core"],
  ["HKCategoryValueSleepAnalysisAsleepDeep", "deep"],
  ["HKCategoryValueSleepAnalysisAsleepREM", "rem"],
  ["HKCategoryValueSleepAnalysisAsleepUnspecified", "unspecified"],
  ["HKCategoryValueSleepAnalysisAwake", "awake"]
]);

function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const value = new Date(Date.UTC(y!, m! - 1, d! + days));
  return value.toISOString().slice(0, 10);
}

function sourceRank(category: string, hasStages: boolean): number {
  if (category === "apple_watch") return hasStages ? 1 : 2;
  if (["coros", "huawei", "connect"].includes(category)) return 3;
  if (category === "apple_phone") return 5;
  return 5;
}

function unionMinutes(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0; let start = sorted[0]?.[0] ?? 0; let end = sorted[0]?.[1] ?? 0;
  for (const [s, e] of sorted.slice(1)) {
    if (s <= end) end = Math.max(end, e);
    else { total += end - start; start = s; end = e; }
  }
  return (total + end - start) / 60_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function loadSegments(database: DatabaseSync): Segment[] {
  const rows = database.prepare(`
    SELECT MIN(id) AS id, source_name AS sourceName, source_category AS sourceCategory,
           value_text AS value, start_at AS startAt, end_at AS endAt
    FROM health_records
    WHERE type = ?
    GROUP BY source_name, source_category, value_text, start_at, end_at
    ORDER BY start_at, id
  `).all(healthTypes.sleepAnalysis) as unknown as Array<Record<string, string>>;
  return rows.map((row) => ({
    id: row.id!, sourceName: row.sourceName!, sourceCategory: row.sourceCategory!, value: row.value ?? "",
    start: Date.parse(row.startAt!), end: Date.parse(row.endAt!)
  })).filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start);
}

function loadHrv(database: DatabaseSync): Array<{ id: string; sourceName: string; start: number; value: number }> {
  const rows = database.prepare(`
    SELECT MIN(id) AS id, source_name AS sourceName, start_at AS startAt, value_numeric AS value
    FROM health_records
    WHERE type = ? AND value_numeric IS NOT NULL
    GROUP BY source_name, start_at, value_numeric
    ORDER BY start_at, id
  `).all(healthTypes.hrvSdnn) as unknown as Array<Record<string, string | number>>;
  return rows.map((row) => ({ id: String(row.id), sourceName: String(row.sourceName), start: Date.parse(String(row.startAt)), value: Number(row.value) }))
    .filter((row) => Number.isFinite(row.start) && Number.isFinite(row.value) && row.value >= 0);
}

function buildNight(wakeDate: string, timezone: string, kind: CanonicalNightKind, source: { sourceName: string; sourceCategory: string; rank: number }, segments: Segment[], competingSourceCount: number): CanonicalNight {
  const asleep = segments.filter((s) => s.value.includes("Asleep"));
  const inBed = segments.filter((s) => s.value.includes("InBed"));
  const awake = segments.filter((s) => s.value.includes("Awake"));
  const stageIntervals = (key: string) => segments.filter((s) => s.value === key).map((s) => [s.start, s.end] as [number, number]);
  const stageMinutes = {
    core: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAsleepCore")),
    deep: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAsleepDeep")),
    rem: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAsleepREM")),
    unspecified: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAsleepUnspecified") .concat(stageIntervals("HKCategoryValueSleepAnalysisAsleep"))),
    awake: unionMinutes(stageIntervals("HKCategoryValueSleepAnalysisAwake"))
  };
  const onset = asleep.reduce<number | null>((v, s) => v === null ? s.start : Math.min(v, s.start), null);
  const wake = asleep.reduce<number | null>((v, s) => v === null ? s.end : Math.max(v, s.end), null);
  const id = stableId("canonical_night", [wakeDate, timezone, kind, source.sourceName, onset]);
  return {
    id, wakeDate, timezoneIdentifier: timezone, kind, sourceName: source.sourceName, sourceCategory: source.sourceCategory,
    sourceRank: source.rank, hasStages: segments.some((s) => STAGE_VALUES.has(s.value) && s.value.includes("Asleep")),
    sleepOnsetAt: onset === null ? null : new Date(onset).toISOString(), wakeAt: wake === null ? null : new Date(wake).toISOString(),
    asleepUnionMinutes: asleep.length ? unionMinutes(asleep.map((s) => [s.start, s.end])) : null,
    inBedUnionMinutes: inBed.length ? unionMinutes(inBed.map((s) => [s.start, s.end])) : null,
    awakeMinutes: awake.length ? unionMinutes(awake.map((s) => [s.start, s.end])) : null,
    stageMinutes, segmentCount: segments.length,
    provenance: { algorithmVersion: CANONICAL_NIGHT_ALGORITHM_VERSION, competingSourceCount, rejectedInBedOnly: false }
  };
}

export interface CanonicalizationNightsResult { mainCount: number; napCount: number; hrvCount: number; rejectedInBedOnly: number; timezoneIdentifier: string }

/**
 * §15.3「事实可得时间」/ 证据可追溯：`computed_at` **就是到达时间**。
 *
 * `packages/application/src/model-v2-snapshots.ts` 读的是 `computed_at AS availableAt`，
 * 而 readiness 只在 `availableAt <= asOf` 时承认一条事实可得。可是本函数是
 * 全量 `DELETE` + 重建，两条 INSERT 都**不带** `computed_at`（该列有 `DEFAULT now`），
 * 于是**每次导入都把全部历史行的到达时间改写成"现在"**。
 * 后果不是"少一点精度"：`asOf` 落在 D 当天时，所有行的到达时间都晚于 D，
 * readiness 对**每一个历史日**都返回 `not_assessed`。
 *
 * 这条提示语本来就在函数自己的注释里写着 —— 原话是
 * "Canonical computed_at is known. Raw source-created time is never treated as ingestion time."
 * 全量重建恰好把那个"known"抹掉了。
 *
 * 判据是**内容**，不是 id 在不在：
 *   · id 已存在且**事实列**逐字未变 → 保留原到达时间（这条事实当年就到了）
 *   · 新增行，或事实列变了        → 到达时间就是现在（新值确实是现在到的）
 * 只按 id 保留会把"被更正过的旧事实"伪装成"当时就知道"，那是往未来泄漏的方向错。
 * `provenance_json`（内含 algorithmVersion）**不**参与比较：算法换版重新推导出同一个事实，
 * 并没有让这条事实晚到；产出它的版本另有 provenance 记录。
 */
const ARRIVAL_FACT_COLUMNS: Record<string, readonly string[]> = {
  canonical_nights: [
    "wake_date", "timezone_identifier", "kind", "source_name", "source_category", "source_rank",
    "has_stages", "sleep_onset_at", "wake_at", "asleep_union_minutes", "in_bed_union_minutes",
    "awake_minutes", "stage_minutes_json", "segment_count"
  ],
  canonical_hrv_days: [
    "local_date", "timezone_identifier", "night_id", "hrv_sdnn_ms", "sample_count", "confidence",
    "window_start_at", "window_end_at", "source_name"
  ]
};

/** `quote()` 让每个值自定界（NULL / 数字 / 带转义的字符串），所以拼接无需再加分隔符也不会歧义。 */
function arrivalFingerprint(table: string, prefix: string): string {
  return ARRIVAL_FACT_COLUMNS[table]!.map((column) => `quote(${prefix}${column})`).join("||");
}

/** 只有在局部重建时才会用到；用于把快照限制在窗口内，从而让窗口外行连 `computed_at` 都不被触碰。 */
interface ArrivalScope {
  dateColumn: string;
  from: string;
  to: string;
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertLocalDate(value: string, label: string): void {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a 'YYYY-MM-DD' local date, received ${JSON.stringify(value)}`);
  }
}

/**
 * 在 DELETE 之前把 (id, 到达时间, 事实指纹) 存进临时表；重建后再按指纹相同的行还原到达时间。
 * 两步都必须在同一个事务里，否则中途失败会留下"到达时间已丢"的状态。
 *
 * `scope` 为局部重建使用：只快照窗口内的行。还原时保留逻辑天然按 staging 里的 id 过滤，
 * 所以窗口外的行既不会进入 staging、也不会被 UPDATE —— 连 `computed_at` 都保持原字节。
 */
function preserveArrivalTime(database: DatabaseSync, table: string, phase: "snapshot" | "restore", scope?: ArrivalScope): void {
  const staging = `_prior_arrival_${table}`;
  if (phase === "snapshot") {
    const where = scope ? ` WHERE ${scope.dateColumn} BETWEEN '${scope.from}' AND '${scope.to}'` : "";
    database.exec(`CREATE TEMP TABLE ${staging} AS SELECT id, computed_at, ${arrivalFingerprint(table, "")} AS fingerprint FROM ${table}${where}`);
    return;
  }
  const current = arrivalFingerprint(table, "c.");
  database.exec(`WITH current AS (SELECT c.id AS id, ${current} AS fingerprint FROM ${table} AS c)
    UPDATE ${table} SET computed_at = (
      SELECT p.computed_at FROM ${staging} p JOIN current c ON c.id = p.id
       WHERE p.fingerprint = c.fingerprint AND c.id = ${table}.id)
    WHERE id IN (SELECT p.id FROM ${staging} p JOIN current c ON c.id = p.id WHERE p.fingerprint = c.fingerprint)`);
  database.exec(`DROP TABLE ${staging}`);
}

interface RebuildCounts { mainCount: number; napCount: number; hrvCount: number; rejectedInBedOnly: number }

interface RebuildInput {
  database: DatabaseSync;
  timezoneIdentifier: string;
  /** 已经加载好的段；对某个日期 d 而言，只要包含所有与 d 的夜间/午睡窗口相交的段，结果就与全量一致。 */
  segments: Segment[];
  /** 已经加载好的 HRV 样本；同理只需覆盖窗口内日期会用到的那部分。 */
  hrv: Array<{ id: string; sourceName: string; start: number; value: number }>;
  /** inclusive 本地日期下界 */
  firstDate: string;
  /** inclusive 本地日期上界 */
  lastDate: string;
}

/**
 * 核心：对 `[firstDate, lastDate]` 逐日重建 canonical_nights / canonical_hrv_days。
 *
 * 全量与窗口重建共用它。这里**不**做 DELETE / 到达时间快照 / 事务 —— 那些由调用方按作用域处理。
 * 对某个本地日期的产出只依赖"与该日的夜间窗口 [d-1T18:00, dT14:00) 及午睡窗口 [dT14:00, dT18:00)
 * 相交的段"，所以只要调用方给的 `segments` 覆盖到这些段，逐日结果就与全量逐字等价。
 */
function rebuildCanonicalNights(input: RebuildInput): RebuildCounts {
  const { database, timezoneIdentifier, segments: all, hrv, firstDate, lastDate } = input;
  let date = firstDate; let mainCount = 0; let napCount = 0; let hrvCount = 0; let rejected = 0;
  const insertNight = database.prepare(`INSERT INTO canonical_nights (id,wake_date,timezone_identifier,kind,source_name,source_category,source_rank,has_stages,sleep_onset_at,wake_at,asleep_union_minutes,in_bed_union_minutes,awake_minutes,stage_minutes_json,segment_count,provenance_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  while (date <= lastDate) {
    const windowStart = Date.parse(localDateTimeAt(`${addLocalDays(date, -1)}T18:00:00`, timezoneIdentifier));
    const windowEnd = Date.parse(localDateTimeAt(`${date}T14:00:00`, timezoneIdentifier));
    const candidates = all.filter((s) => s.end > windowStart && s.start < windowEnd).map((s) => ({ ...s, start: Math.max(s.start, windowStart), end: Math.min(s.end, windowEnd) }));
    const bySource = new Map<string, Segment[]>();
    for (const seg of candidates) {
      const key = `${seg.sourceName}\u0000${seg.sourceCategory}`; const list = bySource.get(key) ?? []; list.push(seg); bySource.set(key, list);
    }
    const sourceGroups = [...bySource.entries()].map(([key, segs]) => {
      const [sourceName, sourceCategory] = key.split("\u0000");
      const asleep = segs.filter((s) => s.value.includes("Asleep"));
      return { sourceName: sourceName!, sourceCategory: sourceCategory!, segs, asleep, rank: sourceRank(sourceCategory!, asleep.some((s) => STAGE_VALUES.has(s.value))) };
    }).filter((group) => group.asleep.length > 0).sort((a, b) => a.rank - b.rank || b.asleep.length - a.asleep.length || a.sourceName.localeCompare(b.sourceName));
    if (sourceGroups.length === 0) { if (candidates.some((s) => s.value.includes("InBed"))) rejected += 1; date = addLocalDays(date, 1); continue; }
    const winning = sourceGroups[0]!;
    const sessions: Segment[][] = [];
    for (const seg of winning.segs.filter((s) => s.value.includes("Asleep") || s.value.includes("InBed") || s.value.includes("Awake")).sort((a, b) => a.start - b.start)) {
      const current = sessions.at(-1); if (!current || seg.start - Math.max(...current.map((item) => item.end)) > 90 * 60_000) sessions.push([seg]); else current.push(seg);
    }
    const built = sessions.map((session) => buildNight(date, timezoneIdentifier, "nap", winning, session, sourceGroups.length));
    built.sort((a, b) => (b.asleepUnionMinutes ?? 0) - (a.asleepUnionMinutes ?? 0));
    for (const [index, night] of built.entries()) {
      night.kind = index === 0 ? "main" : "nap";
      insertNight.run(
        night.id, night.wakeDate, night.timezoneIdentifier, night.kind, night.sourceName, night.sourceCategory, night.sourceRank, night.hasStages ? 1 : 0,
        night.sleepOnsetAt, night.wakeAt, night.asleepUnionMinutes, night.inBedUnionMinutes, night.awakeMinutes, JSON.stringify(night.stageMinutes), night.segmentCount, JSON.stringify(night.provenance));
      if (night.kind === "main") {
        mainCount += 1;
        const samples = hrv.filter((sample) => night.sleepOnsetAt && night.wakeAt && sample.start >= Date.parse(night.sleepOnsetAt) && sample.start <= Date.parse(night.wakeAt));
        const confidence: HrvDayConfidence = samples.length >= 2 ? "confident" : samples.length === 1 ? "sparse" : "missing";
        const hrvId = stableId("canonical_hrv_day", [date, timezoneIdentifier, night.id]);
        database.prepare(`INSERT INTO canonical_hrv_days (id,local_date,timezone_identifier,night_id,hrv_sdnn_ms,sample_count,confidence,window_start_at,window_end_at,source_name,provenance_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          hrvId, date, timezoneIdentifier, night.id, median(samples.map((s) => s.value)), samples.length, confidence, night.sleepOnsetAt, night.wakeAt,
          samples[0]?.sourceName ?? null, JSON.stringify({ algorithmVersion: CANONICAL_NIGHT_ALGORITHM_VERSION, fallbackWatch: false }));
        hrvCount += 1;
      } else napCount += 1;
    }
    // Explicit afternoon nap pass: 14:00-18:00 is outside the main night window.
    const napStart = Date.parse(localDateTimeAt(`${date}T14:00:00`, timezoneIdentifier));
    const napEnd = Date.parse(localDateTimeAt(`${date}T18:00:00`, timezoneIdentifier));
    const napGroups = new Map<string, Segment[]>();
    for (const raw of all) {
      const start = Math.max(raw.start, napStart); const end = Math.min(raw.end, napEnd);
      if (end <= start || !raw.value.includes("Asleep")) continue;
      const key = `${raw.sourceName}\u0000${raw.sourceCategory}`;
      const list = napGroups.get(key) ?? [];
      list.push({ ...raw, start, end });
      napGroups.set(key, list);
    }
    for (const [key, segments] of napGroups) {
      const [sourceName, sourceCategory] = key.split("\u0000");
      const rank = sourceRank(sourceCategory ?? "other", segments.some((s) => s.value.includes("Core") || s.value.includes("Deep") || s.value.includes("REM")));
      const sessions: Segment[][] = [];
      for (const seg of segments.sort((a, b) => a.start - b.start)) {
        const current = sessions.at(-1); const lastEnd = current?.reduce((max, item) => Math.max(max, item.end), -Infinity) ?? -Infinity;
        if (!current || seg.start - lastEnd >= 90 * 60_000) sessions.push([seg]); else current.push(seg);
      }
      for (const session of sessions) {
        const night = buildNight(date, timezoneIdentifier, "nap", { sourceName: sourceName ?? "", sourceCategory: sourceCategory ?? "other", rank }, session, 0);
        if (!night.asleepUnionMinutes) continue;
        insertNight.run(night.id, night.wakeDate, night.timezoneIdentifier, night.kind, night.sourceName, night.sourceCategory, night.sourceRank, night.hasStages ? 1 : 0, night.sleepOnsetAt, night.wakeAt, night.asleepUnionMinutes, night.inBedUnionMinutes, night.awakeMinutes, JSON.stringify(night.stageMinutes), night.segmentCount, JSON.stringify(night.provenance));
        napCount += 1;
      }
    }
    date = addLocalDays(date, 1);
  }
  return { mainCount, napCount, hrvCount, rejectedInBedOnly: rejected };
}

export function canonicalizeNights(database: DatabaseSync, timezoneIdentifier: string = DATABASE_TIMEZONE): CanonicalizationNightsResult {
  const all = loadSegments(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    preserveArrivalTime(database, "canonical_nights", "snapshot");
    preserveArrivalTime(database, "canonical_hrv_days", "snapshot");
    database.exec("DELETE FROM canonical_hrv_days; DELETE FROM canonical_nights;");
    if (all.length === 0) {
      preserveArrivalTime(database, "canonical_nights", "restore");
      preserveArrivalTime(database, "canonical_hrv_days", "restore");
      database.exec("COMMIT");
      return { mainCount: 0, napCount: 0, hrvCount: 0, rejectedInBedOnly: 0, timezoneIdentifier };
    }
    // 日期范围必须同时看段的**结束**时刻，不能只看开始。
    // 一夜的 InBed/Asleep 段通常开始于**前一晚**（约 22:00 local）。只要这一夜里
    // **有任何一段**开始于本地午夜之后，v1 的范围就已经覆盖它的 wake date；
    // 但如果**所有**段都开始于午夜之前（数据在这一夜中途结束、或这一夜很短），
    // v1 会把整个夜丢掉 —— 这是范围截断，不是概率问题。
    //
    // 实测口径：本机 3 年数据上 v1 与 v2 都产出 170 个主夜（该库的末夜恰好有午夜后的段），
    // 所以这次修复对**这份**数据是 0 差异；差异由合成用例钉住。
    // `CANONICAL_NIGHT_ALGORITHM_VERSION` 仍须 bump：产出行集合的算法文本改了，
    // provenance 的用途正是"这行是哪版算法产的"。
    const dates = all.flatMap((s) => [
      localDateAt(s.start, timezoneIdentifier),
      localDateAt(s.end, timezoneIdentifier)
    ]);
    const minDate = dates.sort()[0]!; const maxDate = dates.sort().at(-1)!;
    const hrv = loadHrv(database);
    const counts = rebuildCanonicalNights({ database, timezoneIdentifier, segments: all, hrv, firstDate: minDate, lastDate: maxDate });
    // 全部行插入完之后再还原到达时间：事实未变的行拿回原值，新增/改动的行保持 now。
    preserveArrivalTime(database, "canonical_nights", "restore");
    preserveArrivalTime(database, "canonical_hrv_days", "restore");
    database.exec("COMMIT");
    return { ...counts, timezoneIdentifier };
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

/**
 * 只重建本地日期窗口 `[fromLocalDate, toLocalDate]`（两端 inclusive）的 canonical 行。
 *
 * 与 `canonicalizeNights` 的全量重建**逐列等价**：对任意窗口，本函数产出的
 * `wake_date ∈ [a,b]` 的行，与全量重建中同一批日期的行在
 * `id / wake_date / timezone_identifier / kind / source_name / source_category / source_rank /
 * has_stages / sleep_onset_at / wake_at / asleep_union_minutes / in_bed_union_minutes / awake_minutes /
 * stage_minutes_json / segment_count / provenance_json` 上完全相同。
 *
 * 为什么可以只加载窗口相关数据：某个本地日期 d 的产出，只依赖与
 * `[d-1T18:00, dT14:00)`（夜间）与 `[dT14:00, dT18:00)`（午睡 pass）相交的段
 * （见 `rebuildCanonicalNights` 的注释）。对 `d ∈ [a,b]`，这些段都落在
 * `[a-1T18:00, bT18:00)` 内，所以按这个范围裁出的段集合对窗口内每一天都给出相同的
 * `candidates`，逐日结果因此与全量逐字相同。HRV 样本同理：被某个主夜用到的样本
 * 一定落在它的 `[sleepOnsetAt, wakeAt] ⊆ [a-1T18:00, bT18:00)`。
 *
 * 窗口外的行**一个字节都不许改**（含 `computed_at`）：DELETE 与到达时间快照都按
 * `wake_date`/`local_date` 限制在窗口内，还原时又天然只触及 staging 里的 id。
 * 唯一能绕过这条的是 FK 级联（窗口外的 hrv 行若指向窗口内的 night 会被一并删掉），
 * 所以入口处有一条显式守卫：探测到这种"数据不变量被破坏"就**抛错拒跑**，绝不静默改窗口外的行。
 *
 * 到达时间语义与全量一致：指纹未变的窗口内行保留旧 `computed_at`，内容变了才刷成 now。
 *
 * `fromLocalDate > toLocalDate` 是**显式空操作**：返回全零计数、不写任何一行（也不开事务）。
 */
/** 调用方持有事务时，窗口规范化使用的 SAVEPOINT 名。 */
export const CANONICALIZE_NIGHTS_WINDOW_SAVEPOINT = "rai_canonicalize_nights_window";

export function canonicalizeNightsForWindow(
  database: DatabaseSync,
  timezoneIdentifier: string,
  fromLocalDate: string,
  toLocalDate: string,
  transaction: { callerOwnedTransaction?: boolean } = {}
): CanonicalizationNightsResult {
  // caller 模式下提交权归调用方：本段边界是 SAVEPOINT，不是新事务（见 owned-transaction.ts）。
  const callerOwned = transaction.callerOwnedTransaction === true;
  assertLocalDate(fromLocalDate, "fromLocalDate");
  assertLocalDate(toLocalDate, "toLocalDate");
  if (fromLocalDate > toLocalDate) {
    return { mainCount: 0, napCount: 0, hrvCount: 0, rejectedInBedOnly: 0, timezoneIdentifier };
  }
  // 窗口内每一天用到的段/样本都落在 [from-1T18:00, toT18:00) 内。
  const rangeStart = Date.parse(localDateTimeAt(`${addLocalDays(fromLocalDate, -1)}T18:00:00`, timezoneIdentifier));
  const rangeEnd = Date.parse(localDateTimeAt(`${toLocalDate}T18:00:00`, timezoneIdentifier));
  const all = loadSegments(database).filter((s) => s.end > rangeStart && s.start < rangeEnd);
  const hrv = loadHrv(database).filter((s) => s.start >= rangeStart && s.start < rangeEnd);

  // FK 守卫：`canonical_hrv_days.night_id → canonical_nights(id) ON DELETE CASCADE`。
  // 生产路径下 hrv 行只由本模块写入（:289），且恒有 `local_date == night.wake_date`，
  // 所以删除窗口内 night 的级联只会带走窗口内的 hrv 行。但这条不变量**没有任何约束在守**；
  // 一旦被破坏（窗口外的 hrv 行指向窗口内的 night），级联会**删掉窗口外的 hrv 行** ——
  // 这违反本函数"窗口外一个字节都不许改"的绝对担保。
  // 这里在开事务**之前**显式探测并抛错（不写任何一行），而不是静默改掉窗口外的行。
  //
  // 注意这是**按本次窗口**的闸门，不是全局完整性检查：谓词带上了 `[from, to]`，所以
  // "日期完全落在本次窗口外"的不一致行它看不见。这**不是**覆盖不全 —— 只有
  // `n.wake_date ∈ 窗口` 的 night 会被本次 `DELETE ... WHERE wake_date BETWEEN` 删掉、才可能
  // 经级联外溢；本次不删的 night 伤不到任何行。按窗口探测恰好覆盖了本次调用可能造成伤害的
  // 全部情形，且不会因为一条与本窗口无关的坏行而拒跑。**不要**把它改成全局检查：那会让闸门
  // 从"精确"退化成"任何一个无关坏行都拒跑"。
  const crossWindowHrv = database.prepare(`
    SELECT h.id AS hrvId, h.local_date AS localDate, n.id AS nightId, n.wake_date AS nightWakeDate
    FROM canonical_hrv_days h JOIN canonical_nights n ON n.id = h.night_id
    WHERE h.local_date NOT BETWEEN ? AND ? AND n.wake_date BETWEEN ? AND ?
    LIMIT 1`).get(fromLocalDate, toLocalDate, fromLocalDate, toLocalDate) as
    { hrvId: string; localDate: string; nightId: string; nightWakeDate: string } | undefined;
  if (crossWindowHrv) {
    throw new Error(
      `canonicalizeNightsForWindow: refusing to run — canonical_hrv_days row ${crossWindowHrv.hrvId} ` +
      `(local_date=${crossWindowHrv.localDate}) is outside [${fromLocalDate}, ${toLocalDate}] but references ` +
      `in-window night ${crossWindowHrv.nightId} (wake_date=${crossWindowHrv.nightWakeDate}); deleting that night ` +
      `would cascade-delete a row outside the window, breaking the "no out-of-window mutation" guarantee`
    );
  }

  beginOwnedTransaction(database, CANONICALIZE_NIGHTS_WINDOW_SAVEPOINT, callerOwned);
  try {
    const nightScope: ArrivalScope = { dateColumn: "wake_date", from: fromLocalDate, to: toLocalDate };
    const hrvScope: ArrivalScope = { dateColumn: "local_date", from: fromLocalDate, to: toLocalDate };
    preserveArrivalTime(database, "canonical_nights", "snapshot", nightScope);
    preserveArrivalTime(database, "canonical_hrv_days", "snapshot", hrvScope);
    database.exec(`DELETE FROM canonical_hrv_days WHERE local_date BETWEEN '${fromLocalDate}' AND '${toLocalDate}';
      DELETE FROM canonical_nights WHERE wake_date BETWEEN '${fromLocalDate}' AND '${toLocalDate}';`);
    if (all.length === 0) {
      preserveArrivalTime(database, "canonical_nights", "restore");
      preserveArrivalTime(database, "canonical_hrv_days", "restore");
      commitOwnedTransaction(database, CANONICALIZE_NIGHTS_WINDOW_SAVEPOINT, callerOwned);
      return { mainCount: 0, napCount: 0, hrvCount: 0, rejectedInBedOnly: 0, timezoneIdentifier };
    }
    const counts = rebuildCanonicalNights({ database, timezoneIdentifier, segments: all, hrv, firstDate: fromLocalDate, lastDate: toLocalDate });
    preserveArrivalTime(database, "canonical_nights", "restore");
    preserveArrivalTime(database, "canonical_hrv_days", "restore");
    commitOwnedTransaction(database, CANONICALIZE_NIGHTS_WINDOW_SAVEPOINT, callerOwned);
    return { ...counts, timezoneIdentifier };
  } catch (error) {
    rollbackOwnedTransaction(database, CANONICALIZE_NIGHTS_WINDOW_SAVEPOINT, callerOwned);
    throw error;
  }
}
