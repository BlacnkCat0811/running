// 阶段 2 热读窗口证据的共享裁决。
//
// 裁决只使用原始样本 `samples[].ms`：先校验 200 个正式样本、有限非负耗时、
// 状态/身份/业务内容，再从样本重算 p50/p95/min/max/mean 并核对证据里声明的
// 汇总字段。性能增量使用重算 P95，绝不直接信任 `p95` 字段。
//
// P95 固定为最近秩法：排序后的 durations[ceil(N * 0.95) - 1]，200 个样本即
// 第 190 个值。汇总一致性容差只用于发现证据篡改/漂移，不参与性能门槛。
import { WINDOW_SELECTION_VERSION, expectedWindowIndex } from "./phase2-series-window-selection.mjs";

export const HOT_WINDOW_NAMES = Object.freeze(["recent", "p25", "p50", "p75", "oldest"]);
const CHRONOLOGICAL_WINDOW_NAMES = Object.freeze(["oldest", "p25", "p50", "p75", "recent"]);
export const HOT_SAMPLE_COUNT = 200;
export const SUMMARY_TOLERANCE_MS = 0.000001;

const SUMMARY_FIELDS = Object.freeze(["p50", "p95", "min", "max", "mean"]);

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isDuration = (value) => isFiniteNumber(value) && value >= 0;

function describe(value) {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * 校验同一侧五个窗口的时间顺序与统一总数。
 *
 * 必须放在“逐窗口两侧相等”之外：两侧同时把 recent/oldest 的元数据写反时，
 * 相等检查会通过，只有按名称推导的期望下标和时间顺序能拦住。
 */
function validateWindowTimeline(side, hotWindows) {
  const failures = [];
  const entries = CHRONOLOGICAL_WINDOW_NAMES.map((name) => ({
    name,
    window: hotWindows?.[name]?.window
  }));
  // 缺元数据由逐窗口校验报错；这里不重复，但必须标记为“未验证”，不能返回 true。
  if (entries.some((entry) => !entry.window)) return { ok: true, verified: false, failures };

  const totals = new Set();
  for (const entry of entries) {
    if (Number.isInteger(entry.window.readableSessions) && entry.window.readableSessions >= 1) {
      totals.add(entry.window.readableSessions);
    }
  }
  if (totals.size > 1) {
    failures.push({
      code: "hot_window_timeline",
      detail: `${side}: readableSessions differ across windows: ${[...totals].join(",")}`
    });
  }

  let previous = null;
  for (const entry of entries) {
    const window = entry.window;
    if (!isTimestamp(window.startedAt)) continue;
    if (previous !== null) {
      const previousStart = Date.parse(previous.window.startedAt);
      const currentStart = Date.parse(window.startedAt);
      if (previousStart > currentStart) {
        failures.push({
          code: "hot_window_timeline",
          detail: `${side}: ${previous.name} starts after ${entry.name}`
        });
      } else if (previousStart === currentStart
        && typeof previous.window.trainingSessionId === "string"
        && typeof window.trainingSessionId === "string"
        && previous.window.trainingSessionId > window.trainingSessionId) {
        failures.push({
          code: "hot_window_timeline",
          detail: `${side}: equal start times are not ordered by training id at ${previous.name}/${entry.name}`
        });
      }
    }
    previous = entry;
  }
  return { ok: failures.length === 0, verified: failures.length === 0, failures };
}

/** 最近秩分位：调用方必须传入数值升序副本。 */
export function percentileNearestRank(sorted, ratio) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

/** 与基准脚本 `summarize()` 相同的算法；不修改输入数组。 */
export function summarizeMilliseconds(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentileNearestRank(sorted, 0.5),
    p95: percentileNearestRank(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  };
}

function validateSide(name, side, value) {
  const failures = [];
  const prefix = `${name}/${side}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push({ code: "hot_window_invalid", detail: `${prefix}: window must be an object` });
    return {
      failures,
      sessionId: null,
      sampleCount: 0,
      samplesValid: false,
      summaryConsistent: false,
      evaluable: false,
      declared: null,
      recomputed: null,
      summary: null
    };
  }

  const identityValid = typeof value.sessionId === "string" && value.sessionId.length > 0;
  if (!identityValid) {
    failures.push({ code: "hot_identity", detail: `${prefix}: sessionId must be a non-empty string` });
  }

  const samples = value.samples;
  const sampleCountValid = Array.isArray(samples) && samples.length === HOT_SAMPLE_COUNT;
  if (!sampleCountValid) {
    failures.push({
      code: "hot_sample_count",
      detail: `${prefix}: ${Array.isArray(samples) ? samples.length : 0}`
    });
  }

  const durations = [];
  const invalidDurations = [];
  if (Array.isArray(samples)) {
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (!sample || typeof sample !== "object") {
        invalidDurations.push(`${index}:not-an-object`);
      } else if (!isDuration(sample.ms)) {
        invalidDurations.push(`${index}:${describe(sample.ms)}`);
      } else {
        durations.push(sample.ms);
      }
    }
  }
  if (invalidDurations.length > 0) {
    const shown = invalidDurations.slice(0, 5).join(", ");
    const rest = invalidDurations.length > 5 ? `, +${invalidDurations.length - 5} more` : "";
    failures.push({ code: "hot_duration_invalid", detail: `${prefix}: ${shown}${rest}` });
  }

  let statusValid = false;
  let samplesIdentityValid = false;
  let contentValid = false;
  if (Array.isArray(samples) && samples.length > 0) {
    const statuses = [...new Set(samples.map((sample) => sample?.status))];
    statusValid = statuses.length === 1 && statuses[0] === 200;
    if (!statusValid) failures.push({ code: "hot_status", detail: `${prefix}: ${statuses.join(",")}` });

    const identities = [...new Set(samples.map((sample) => sample?.trainingSessionId))];
    samplesIdentityValid = identities.length === 1 && identities[0] === value.sessionId;
    if (!samplesIdentityValid) {
      failures.push({ code: "hot_identity", detail: `${prefix}: ${identities.join(",")} != ${String(value.sessionId)}` });
    }

    const metricSamples = samples.map((sample) => sample?.metricSamples);
    contentValid = metricSamples.every((count) => isFiniteNumber(count) && count > 0);
    if (!contentValid) failures.push({ code: "hot_empty_content", detail: prefix });
  }

  const samplesValid = sampleCountValid
    && invalidDurations.length === 0
    && statusValid
    && samplesIdentityValid
    && contentValid
    && identityValid;
  const canCompute = sampleCountValid && invalidDurations.length === 0;
  const recomputed = canCompute ? summarizeMilliseconds(durations) : null;

  const declared = {};
  const summary = {};
  const invalidSummaryFields = [];
  const mismatchedSummaryFields = [];
  for (const field of SUMMARY_FIELDS) {
    const declaredValue = value[field];
    declared[field] = declaredValue;
    if (!isFiniteNumber(declaredValue)) {
      invalidSummaryFields.push(field);
      summary[field] = { declared: declaredValue, recomputed: recomputed?.[field] ?? null, consistent: false };
      continue;
    }
    if (recomputed === null) {
      summary[field] = { declared: declaredValue, recomputed: null, consistent: false };
      continue;
    }
    const delta = Math.abs(declaredValue - recomputed[field]);
    const consistent = delta <= SUMMARY_TOLERANCE_MS;
    summary[field] = { declared: declaredValue, recomputed: recomputed[field], delta, consistent };
    if (!consistent) mismatchedSummaryFields.push(field);
  }
  if (invalidSummaryFields.length > 0) {
    failures.push({
      code: "hot_summary_invalid",
      detail: `${prefix}: ${invalidSummaryFields.join(",")} must be finite numbers`
    });
  }
  if (mismatchedSummaryFields.length > 0) {
    const details = mismatchedSummaryFields
      .map((field) => `${field} declared=${describe(summary[field].declared)} recomputed=${describe(summary[field].recomputed)}`)
      .join(", ");
    failures.push({ code: "hot_summary_mismatch", detail: `${prefix}: ${details}` });
  }
  const summaryConsistent = recomputed !== null
    && invalidSummaryFields.length === 0
    && mismatchedSummaryFields.length === 0;

  return {
    failures,
    sessionId: identityValid ? value.sessionId : null,
    sampleCount: Array.isArray(samples) ? samples.length : 0,
    samplesValid,
    summaryConsistent,
    evaluable: samplesValid && summaryConsistent,
    declared,
    recomputed,
    summary
  };
}

function bodiesEqual(base, next) {
  if (!Array.isArray(base?.samples) || !Array.isArray(next?.samples)) return false;
  if (base.samples.length !== next.samples.length) return false;
  return base.samples.every((sample, index) => (
    typeof sample?.bodySha256 === "string"
    && sample.bodySha256.length > 0
    && sample.bodySha256 === next.samples[index]?.bodySha256
  ));
}

function validateWindowMapping(name, base, next, allowLegacyWindowMapping) {
  const baseWindow = base?.window;
  const nextWindow = next?.window;
  const failures = [];
  const warnings = [];

  if (!baseWindow && !nextWindow) {
    if (allowLegacyWindowMapping) {
      warnings.push({
        code: "hot_window_mapping_unverified",
        detail: `${name}: legacy evidence has no window selection metadata; window names are opaque labels`
      });
      return { ok: true, verified: false, selection: null, failures, warnings };
    }
    failures.push({
      code: "hot_window_selection_missing",
      detail: `${name}: baseline and candidate lack window selection metadata (use --allow-legacy-window-mapping only for read-only legacy rechecks)`
    });
    return { ok: false, verified: false, selection: null, failures, warnings };
  }
  if (!baseWindow || !nextWindow) {
    failures.push({
      code: "hot_window_selection_missing",
      detail: `${name}: only ${baseWindow ? "candidate" : "baseline"} has window selection metadata`
    });
    return { ok: false, verified: false, selection: null, failures, warnings };
  }

  if (baseWindow.selectionVersion !== nextWindow.selectionVersion) {
    failures.push({
      code: "hot_window_selection_version",
      detail: `${name}: baseline ${describe(baseWindow.selectionVersion)} != candidate ${describe(nextWindow.selectionVersion)}`
    });
  }
  if (baseWindow.selectionVersion !== WINDOW_SELECTION_VERSION) {
    failures.push({
      code: "hot_window_selection_version",
      detail: `${name}: selection version ${describe(baseWindow.selectionVersion)} != ${WINDOW_SELECTION_VERSION}`
    });
  }
  if (baseWindow.name !== name || nextWindow.name !== name) {
    failures.push({
      code: "hot_window_selection_mismatch",
      detail: `${name}: baseline name ${describe(baseWindow.name)}, candidate name ${describe(nextWindow.name)}`
    });
  }
  if (baseWindow.trainingSessionId !== base.sessionId || nextWindow.trainingSessionId !== next.sessionId) {
    failures.push({
      code: "hot_window_selection_mismatch",
      detail: `${name}: selection training id does not match window sessionId`
    });
  }
  if (!isTimestamp(baseWindow.startedAt) || !isTimestamp(nextWindow.startedAt)) {
    failures.push({
      code: "hot_window_selection_missing",
      detail: `${name}: startedAt must be an ISO timestamp on both sides`
    });
  } else if (Date.parse(baseWindow.startedAt) !== Date.parse(nextWindow.startedAt)) {
    failures.push({
      code: "hot_window_selection_mismatch",
      detail: `${name}: startedAt ${baseWindow.startedAt} != ${nextWindow.startedAt}`
    });
  }
  const baseEndedAt = baseWindow.endedAt ?? null;
  const nextEndedAt = nextWindow.endedAt ?? null;
  const endedAtValid = (value) => value === null || isTimestamp(value);
  if (!endedAtValid(baseEndedAt) || !endedAtValid(nextEndedAt)) {
    failures.push({
      code: "hot_window_selection_missing",
      detail: `${name}: endedAt must be null or an ISO timestamp on both sides`
    });
  } else if (baseEndedAt === null || nextEndedAt === null) {
    if (baseEndedAt !== nextEndedAt) {
      failures.push({
        code: "hot_window_selection_mismatch",
        detail: `${name}: endedAt ${describe(baseEndedAt)} != ${describe(nextEndedAt)}`
      });
    }
  } else if (Date.parse(baseEndedAt) !== Date.parse(nextEndedAt)) {
    failures.push({
      code: "hot_window_selection_mismatch",
      detail: `${name}: endedAt ${baseEndedAt} != ${nextEndedAt}`
    });
  }
  for (const [side, window] of [["baseline", baseWindow], ["candidate", nextWindow]]) {
    if (isTimestamp(window.startedAt) && window.endedAt !== null && window.endedAt !== undefined
      && isTimestamp(window.endedAt) && Date.parse(window.endedAt) < Date.parse(window.startedAt)) {
      failures.push({
        code: "hot_window_time_range",
        detail: `${name}/${side}: endedAt ${window.endedAt} is before startedAt ${window.startedAt}`
      });
    }
  }

  const baseReadable = baseWindow.readableSessions;
  const nextReadable = nextWindow.readableSessions;
  const readableSessionsValid = Number.isInteger(baseReadable) && baseReadable >= 1
    && Number.isInteger(nextReadable) && nextReadable >= 1;
  if (!readableSessionsValid) {
    failures.push({
      code: "hot_window_selection_missing",
      detail: `${name}: readableSessions must be a positive integer on both sides`
    });
  } else if (baseReadable !== nextReadable) {
    failures.push({
      code: "hot_window_selection_mismatch",
      detail: `${name}: readableSessions ${baseReadable} != ${nextReadable}`
    });
  }

  for (const [side, window] of [["baseline", baseWindow], ["candidate", nextWindow]]) {
    const index = window.indexFromOldest;
    if (!Number.isInteger(index) || index < 0) {
      failures.push({
        code: "hot_window_selection_missing",
        detail: `${name}/${side}: indexFromOldest must be a non-negative integer`
      });
      continue;
    }
    if (!readableSessionsValid) continue;
    const expected = expectedWindowIndex(name, window.readableSessions);
    if (index > window.readableSessions - 1 || index !== expected) {
      failures.push({
        code: "hot_window_index_mismatch",
        detail: `${name}/${side}: indexFromOldest ${index} is invalid for ${window.readableSessions} readable sessions; expected ${expected}`
      });
    }
  }
  if (baseWindow.indexFromOldest !== nextWindow.indexFromOldest
    && Number.isInteger(baseWindow.indexFromOldest) && Number.isInteger(nextWindow.indexFromOldest)
    && baseWindow.indexFromOldest >= 0 && nextWindow.indexFromOldest >= 0) {
    failures.push({
      code: "hot_window_selection_mismatch",
      detail: `${name}: indexFromOldest ${baseWindow.indexFromOldest} != ${nextWindow.indexFromOldest}`
    });
  }

  return {
    ok: failures.length === 0,
    verified: failures.length === 0,
    selection: failures.length === 0 ? {
      version: baseWindow.selectionVersion,
      startedAt: baseWindow.startedAt,
      endedAt: baseEndedAt,
      indexFromOldest: baseWindow.indexFromOldest,
      readableSessions: baseWindow.readableSessions
    } : null,
    failures,
    warnings
  };
}

/**
 * 比较两个证据文档的 hotWindows。
 *
 * 默认要求新格式的选窗元数据；只有显式 `allowLegacyWindowMapping` 才允许
 * 旧 JSON 在“窗口名不可验证”的警告下做只读 P95 复核。无论是否允许旧格式，
 * 性能裁决都使用原始样本重算值。
 */
export function compareHotWindows(baseline, candidate, options = {}) {
  const allowLegacyWindowMapping = options.allowLegacyWindowMapping === true;
  const failures = [];
  const warnings = [];
  const windows = {};
  let allWindowsEvaluable = true;
  let windowMappingVerified = true;

  const candidateWindows = candidate?.hotWindows ?? {};
  for (const required of HOT_WINDOW_NAMES) {
    if (!candidateWindows[required]) {
      failures.push({ code: "missing_required_window", detail: required });
      allWindowsEvaluable = false;
      windowMappingVerified = false;
    }
  }

  const baselineTimeline = validateWindowTimeline("baseline", baseline?.hotWindows);
  const candidateTimeline = validateWindowTimeline("candidate", candidateWindows);
  const timelineFailures = [...baselineTimeline.failures, ...candidateTimeline.failures];
  const timelineOk = timelineFailures.length === 0;
  const timelineVerified = timelineOk && baselineTimeline.verified && candidateTimeline.verified;
  failures.push(...timelineFailures);
  if (!timelineVerified) windowMappingVerified = false;

  for (const [name, next] of Object.entries(candidateWindows)) {
    const base = baseline?.hotWindows?.[name];
    if (!base) {
      failures.push({ code: "missing_window", detail: name });
      windows[name] = {
        sessionId: next?.sessionId ?? null,
        evaluable: false,
        performance: "not_evaluable",
        pass: null
      };
      allWindowsEvaluable = false;
      windowMappingVerified = false;
      continue;
    }

    const baseSide = validateSide(name, "baseline", base);
    const nextSide = validateSide(name, "candidate", next);
    failures.push(...baseSide.failures, ...nextSide.failures);

    const sessionMismatch = baseSide.sessionId !== nextSide.sessionId;
    if (sessionMismatch) {
      failures.push({
        code: "hot_session_mismatch",
        detail: `${name}: ${String(baseSide.sessionId)} != ${String(nextSide.sessionId)}`
      });
    }

    const mapping = validateWindowMapping(name, base, next, allowLegacyWindowMapping);
    failures.push(...mapping.failures);
    warnings.push(...mapping.warnings);

    const bodyEqual = bodiesEqual(base, next);
    if (!bodyEqual) failures.push({ code: "body_diff", detail: name });

    const evaluable = baseSide.evaluable
      && nextSide.evaluable
      && !sessionMismatch
      && mapping.ok
      && timelineOk
      && bodyEqual;
    let deltaMs = null;
    let deltaPercent = null;
    let limitMs = null;
    let pass = null;
    if (evaluable) {
      deltaMs = nextSide.recomputed.p95 - baseSide.recomputed.p95;
      deltaPercent = baseSide.recomputed.p95 > 0 ? (deltaMs / baseSide.recomputed.p95) * 100 : null;
      limitMs = Math.max(baseSide.recomputed.p95 * 0.1, 20);
      pass = deltaMs <= limitMs;
      if (!pass) {
        failures.push({
          code: "hot_window_p95",
          detail: `${name}: ${deltaMs.toFixed(2)}ms > ${limitMs.toFixed(2)}ms`
        });
      }
    } else {
      allWindowsEvaluable = false;
    }
    if (!mapping.verified) windowMappingVerified = false;

    const allSamples = [
      ...(Array.isArray(base.samples) ? base.samples : []),
      ...(Array.isArray(next.samples) ? next.samples : [])
    ];
    const metricSamples = allSamples
      .map((sample) => sample?.metricSamples)
      .filter((count) => isFiniteNumber(count));

    windows[name] = {
      sessionId: nextSide.sessionId,
      sampleCount: {
        baseline: baseSide.sampleCount,
        candidate: nextSide.sampleCount
      },
      declaredP95: {
        baseline: baseSide.declared?.p95 ?? null,
        candidate: nextSide.declared?.p95 ?? null
      },
      recomputedP95: {
        baseline: baseSide.recomputed?.p95 ?? null,
        candidate: nextSide.recomputed?.p95 ?? null
      },
      // 兼容旧报告字段：自本版本起指向重算值，不再指向声明值。
      baselineP95: baseSide.recomputed?.p95 ?? null,
      candidateP95: nextSide.recomputed?.p95 ?? null,
      summaryConsistent: {
        baseline: baseSide.summaryConsistent,
        candidate: nextSide.summaryConsistent
      },
      summary: {
        baseline: baseSide.summary,
        candidate: nextSide.summary
      },
      deltaMs,
      deltaPercent,
      limitMs,
      pass,
      evaluable,
      performance: !evaluable ? "not_evaluable" : pass ? "pass" : "fail",
      bodyEqual,
      windowMapping: mapping.selection === null || !timelineVerified
        ? { verified: false }
        : { verified: true, ...mapping.selection },
      statuses: [...new Set(allSamples.map((sample) => sample?.status))],
      metricSamplesMin: metricSamples.length > 0 ? Math.min(...metricSamples) : null
    };
  }

  return {
    failures,
    warnings,
    windows,
    // 证据可评估性与“性能是否通过”分开：超限是有效的失败结论，不是不可评估。
    evaluable: allWindowsEvaluable,
    windowTimelineVerified: timelineVerified,
    windowMappingVerified
  };
}
