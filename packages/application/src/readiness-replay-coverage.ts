import type { DatabaseSync } from "node:sqlite";

import { semanticHash } from "@rai/storage-sqlite";
import type { ReplayDescriptorV2 } from "@rai/contracts";

import { loadDatedRecoveryFacts } from "./model-v2-snapshots.js";
import { replayReadinessRulings } from "./readiness-replay-v2.js";
import { addDays, localDateAt, localDateStartAt } from "./utils.js";
import { healthTypes } from "@rai/contracts";

/**
 * §7.3 / §15.3 / §15.5 —— **在真实库上**量化"把观测时间当可用性"会改变多少天的恢复裁决。
 *
 * 为什么需要这个 runner：`replayReadinessRulings` 是纯函数、有单测，但此前**没有任何调用方**
 * 在真实数据上跑过它 —— 于是"泄漏率"这个 §15.5 要求上报的指标一直没有数字。
 * 设计把 Readiness 列为回放优先级最高的领域，正是因为它最可能出现时间泄漏。
 *
 * 口径（写进报告，不允许含糊）：
 * - **每一天以其本地日的最后一毫秒为 asOf**。理由：要评估"这一天结束时我们知道了什么"，
 *   才能让"当天观测、当天之后才入库"的事实成为**可见的**泄漏候选；
 *   若取当天 00:00，当夜睡眠尚未观测（睡眠在清晨醒来），会让所有日子都变成"缺睡眠"。
 * - 日集合 = 该时区下所有主夜 wake_date 与 canonical HRV 日的**并集**，并在窗口内**逐日填充**，
 *   所以 `coverage: none` 的日子也被计入分母（否则"可评估覆盖"会被系统性高估）。
 * - 回放模式固定 `event_time_reconstruction`：这些历史记录缺少可靠的记录级到达时间。
 *
 * 本模块只读数据库，不做文件 I/O（那是调用方的事）。
 */

export interface ReadinessReplayCoverageOptions {
  timezone: string;
  /** 只统计该本地日之后（含）。留空表示不设下界。 */
  fromLocalDate?: string | null;
  /** 只统计该本地日之前（含）。留空表示不设上界。 */
  toLocalDate?: string | null;
  /** 保护上限：窗口天数超过它时只取**最近**的若干天，并在报告里说明被截断。 */
  maxDays?: number;
}

export const READINESS_REPLAY_COVERAGE_VERSION = "rai-readiness-replay-coverage-v1" as const;

/** 本地日 D 的最后一毫秒 —— 该时刻落在 D 内，所以事实装配器评估的正是 D。 */
export function assessmentInstantForLocalDate(localDate: string, timezone: string): string {
  return new Date(Date.parse(localDateStartAt(addDays(localDate, 1), timezone)) - 1).toISOString();
}

export function buildReadinessReplayCoverage(
  database: DatabaseSync,
  options: ReadinessReplayCoverageOptions
) {
  const { timezone } = options;
  if (typeof timezone !== "string" || timezone === "") throw new Error("A timezone is required");
  const maxDays = options.maxDays ?? 800;
  if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error("maxDays must be a positive integer");

  const factDates = new Set<string>();
  const factDaySources = { mainNights: 0, hrvDays: 0, restingHeartRateDays: 0 };
  for (const row of database.prepare(
    "SELECT DISTINCT wake_date AS d FROM canonical_nights WHERE kind='main' AND timezone_identifier=?"
  ).all(timezone) as Array<{ d: string }>) { factDates.add(String(row.d)); factDaySources.mainNights += 1; }
  for (const row of database.prepare(
    "SELECT DISTINCT local_date AS d FROM canonical_hrv_days WHERE timezone_identifier=?"
  ).all(timezone) as Array<{ d: string }>) { factDates.add(String(row.d)); factDaySources.hrvDays += 1; }
  // 静息心率没有 canonical 日表：它直接来自 `health_records`，所以要按**本地日**归属。
  // 漏掉这一类会把"只有 RHR 的日子"从日集合里删掉，于是报告会显示"没有可回放的日子"，
  // 掩盖掉真实情况（本地库恰恰只有 RHR，没有 canonical 的夜与 HRV）。
  for (const row of database.prepare(
    `SELECT start_at AS at FROM health_records WHERE type=? AND value_numeric>0 ORDER BY start_at`
  ).all(healthTypes.restingHeartRate) as Array<{ at: string }>) {
    const date = localDateAt(String(row.at), timezone);
    if (!factDates.has(date)) factDaySources.restingHeartRateDays += 1;
    factDates.add(date);
  }

  const sorted = [...factDates].filter((date) =>
    (options.fromLocalDate == null || date >= options.fromLocalDate) &&
    (options.toLocalDate == null || date <= options.toLocalDate)
  ).sort();
  if (sorted.length === 0) {
    return {
      reportVersion: READINESS_REPLAY_COVERAGE_VERSION,
      timezoneIdentifier: timezone,
      window: { fromLocalDate: null, toLocalDate: null, days: 0 },
      truncatedToRecentDays: false,
      factDaySources,
      coverage: { none: 0, partial: 0, complete: 0 },
      observedFactDays: 0,
      assessableDays: 0,
      comparableDays: 0,
      divergentDays: 0,
      unassessableReasons: [],
      rulingEqual: { true: 0, false: 0 },
      leakageStatus: "no_comparable_days" as const,
      leakageRate: null,
      leakageRateInterpretation: "没有任何可比日：两支都看不到证据，比率不存在（null 不等于 0）。",
      asKnownThenBlockedDays: 0,
      arrivalSensitiveReasonCodes: [],
      stateDistribution: {},
      longestStateRun: null,
      accuracyStatus: "not_evaluable" as const,
      note: "No canonical recovery facts in this database/timezone; nothing to replay.",
      cases: []
    };
  }

  // 逐日填充：只统计"有事实的日子"会把 coverage:none 从分母里悄悄去掉。
  // 调用方显式给了边界时以边界为准 —— 否则"从 X 到 Y"的请求会悄悄缩成"有事实的那几天"。
  const first = options.fromLocalDate ?? sorted[0]!;
  const last = options.toLocalDate ?? sorted.at(-1)!;
  if (last < first) throw new Error("The local-date window is inverted");
  const allDays: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) allDays.push(day);
  const truncated = allDays.length > maxDays;
  const days = truncated ? allDays.slice(-maxDays) : allDays;

  const coverage = { none: 0, partial: 0, complete: 0 };
  const stateDistribution: Record<string, number> = {};
  const reasonCounts = new Map<string, number>();
  const unassessableReasons = new Map<string, number>();
  let observedFactDays = 0;
  let assessableDays = 0;
  let comparableDays = 0;
  let divergentDays = 0;
  let asKnownThenBlockedDays = 0;
  let longestStateRun: { state: string; days: number } | null = null;
  let currentRunState: string | null = null;
  let currentRunLength = 0;
  const cases: Array<Record<string, unknown>> = [];

  for (const localDate of days) {
    const asOf = assessmentInstantForLocalDate(localDate, timezone);
    const facts = loadDatedRecoveryFacts(database, asOf, timezone);
    // 事实装配器按 asOf 所在日评估；这条断言保证"逐日循环"的假设不被静默破坏。
    if (facts.localDate !== localDate) {
      throw new Error(`Assessment date drifted: expected ${localDate}, got ${facts.localDate}`);
    }
    // "到达时间未知"只适用于**有读数**的信号：没有读数就无所谓到达。
    // 把"今天没有 HRV"也算成未知，会让每一天都被标成 as_known_then 不可用 ——
    // 那是"缺证据"与"到达时间不可考"两件事被合并，而它们要分开报告。
    const availabilityUnknown = Object.values(facts.signals).some(
      (signal) => signal.value !== null && signal.availableAt === null
    );
    if (availabilityUnknown) asKnownThenBlockedDays += 1;
    const descriptor: ReplayDescriptorV2 = {
      caseId: localDate,
      asOf,
      timezoneIdentifier: timezone,
      replayMode: "event_time_reconstruction",
      factsSnapshotHash: semanticHash(facts),
      overrideSnapshotHash: semanticHash([]),
      availabilityUnknown
    };
    const replay = replayReadinessRulings({ descriptor, facts });
    const strict = replay.candidate.output;
    const observationOnly = replay.base.output;
    coverage[strict.coverage] += 1;
    stateDistribution[strict.state] = (stateDistribution[strict.state] ?? 0) + 1;
    const signals = Object.values(facts.signals);
    const observedToday = signals.some((signal) => signal.value !== null);
    if (observedToday) observedFactDays += 1;
    for (const code of replay.arrivalSensitiveReasonCodes) {
      reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
    }

    const strictAssessed = strict.coverage !== "none";
    const observationAssessed = observationOnly.coverage !== "none";
    if (strictAssessed && observationAssessed) comparableDays += 1;
    // 🔴 泄漏的分母刻意**不是**"严格支可评估的日子"。
    // 最典型的泄漏恰恰是"严格支什么都看不到、'观测即到达'支看到一次低睡眠" ——
    // 那一天的裁决确实被到达时间改变了。若用严格支作分母，这类日子会被整类排除，
    // 于是最该报警的情形反而算不进泄漏率（本模块第一版就是这样，被测试抓出来）。
    else if (strictAssessed || observationAssessed) comparableDays += 1;

    if (!replay.rulingEqual) divergentDays += 1;

    if (strictAssessed) {
      if (strict.state === currentRunState) currentRunLength += 1;
      else { currentRunState = strict.state; currentRunLength = 1; }
      if (longestStateRun === null || currentRunLength > longestStateRun.days) {
        longestStateRun = { state: strict.state, days: currentRunLength };
      }
      assessableDays += 1;
    } else {
      currentRunState = null;
      currentRunLength = 0;
    }
    if (!strictAssessed && !observationAssessed) {
      // 两支都看不到任何东西 —— 这才是"不可评估"，必须带原因，
      // 否则一个 0 读起来像"模型没跑"，而不是"到达时间不成立"。
      const reason = !observedToday ? "no_reading_for_this_day"
        : signals.some((signal) => signal.value !== null && signal.availableAt === null)
          ? "reading_exists_but_arrival_time_unknown"
          : "reading_exists_but_not_assessable";
      unassessableReasons.set(reason, (unassessableReasons.get(reason) ?? 0) + 1);
    }
    cases.push({
      localDate,
      coverage: strict.coverage,
      observationOnlyCoverage: observationOnly.coverage,
      coverageChangedByArrival: strict.coverage !== observationOnly.coverage,
      state: strict.state,
      rulingEqual: replay.rulingEqual,
      availabilityUnknown,
      arrivalSensitiveReasonCodes: replay.arrivalSensitiveReasonCodes
    });
  }

  return {
    reportVersion: READINESS_REPLAY_COVERAGE_VERSION,
    timezoneIdentifier: timezone,
    window: { fromLocalDate: days[0]!, toLocalDate: days.at(-1)!, days: days.length },
    truncatedToRecentDays: truncated,
    /** 日集合的三个来源；三者互有重叠，所以总数不是它们的和。 */
    factDaySources,
    coverage,
    /** 有当日读数的天数 —— 与"可评估天数"之差就是到达时间/基线造成的缺口。 */
    observedFactDays,
    /** 严格支（真实到达时间）能形成评估的天数。这是"当时真的能判定"的天数。 */
    assessableDays,
    /**
     * 泄漏率的分母：**至少有一支**能看到东西的天数。
     * 两支都看不到的日子对"到达时间假设"不携带任何信息，放进来只会稀释指标。
     */
    comparableDays,
    divergentDays,
    /** `coverage: none` 的原因直方图，**只统计两支都看不到的日子**。空数组表示每一天都至少有一支能评估。 */
    unassessableReasons: [...unassessableReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    rulingEqual: { true: comparableDays - divergentDays, false: divergentDays },
    /**
     * §7.3 的泄漏率：在**可比**的日子里，"把观测时间当到达时间"会改变裁决的比例。
     * 分母是 `comparableDays`（至少一支能评估），**不是** `assessableDays` —— 见循环里的说明。
     *
     * 🔴 只有 `leakageStatus === "evaluated"` 时才给出数值。`0` 与 `null` 是两件不同的事：
     * 在 1 个可比日上的 0 与在 200 个可比日上的 0 完全不同，而只报一个 `0`
     * 会让"完全无法评估"读成"没有泄漏"。判据是算术性的（n < 2 的比例不携带信息），
     * 不是另编一个覆盖率下限。
     */
    leakageStatus: comparableDays === 0 ? "no_comparable_days" as const
      : comparableDays === 1 ? "single_comparable_day" as const
        : "evaluated" as const,
    leakageRate: comparableDays < 2 ? null : divergentDays / comparableDays,
    leakageRateInterpretation: comparableDays === 0
      ? "没有任何可比日：两支都看不到证据，比率不存在（null 不等于 0）。"
      : comparableDays === 1
        ? "只有 1 个可比日：比率不携带信息，按 null 报告而不是 0。"
        : `基于 ${comparableDays} 个可比日；它只描述这份数据，不构成对线上泄漏率的结论。`,
    /** §15.3：到达时间未知 ⇒ 这些日子**不能**充当 as_known_then 证据。 */
    asKnownThenBlockedDays,
    arrivalSensitiveReasonCodes: [...reasonCounts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
    stateDistribution,
    longestStateRun,
    accuracyStatus: "not_evaluable" as const,
    note:
      "两条分支共用同一个生产规则函数，只差到达时间假设；泄漏率衡量的是可用性口径的影响，不是模型精度。" +
      "本报告与 as_known_then 认证无关：这些历史记录缺少可靠的记录级到达时间。",
    cases
  };
}
