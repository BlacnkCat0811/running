// 阶段 2 写入证据的纯裁决逻辑（无数据库依赖）。
//
// 生成脚本与验收器共用这里的分位数、门禁和结构校验；`--verify <json>` 只读 JSON，
// 因此“写了 verdict.ok=true 但缺少证据”可以被独立拒绝，而不需要重跑实验。
//
// 证据口径（2026-10-21 复审整改 v3）：
//   · 正式组必须是 empty-wal 与 near-threshold，各 100 个正式样本 + 1 个独立预热；
//   · 每个正式样本回读 timedPragmas（自动 checkpoint 必须为 1000）；normalized 辅证组为 0；
//   · empty-wal 起始日志为空；near-threshold 起始 950 ≤ logFrames < 1000，
//     提交后 logFrames ≥ 1000 且 checkpointed 帧数增加；
//   · 三项 P95（完整事务 / 持锁 / COMMIT）增量 ≤ max(基线 P95 × 10%, 5 ms)；
//   · 原始样本可独立复算；缺组、少样本、错表、无索引、PRAGMA 不符、未跨阈值、
//     超门槛、异常均失败。

export const EVIDENCE_SCHEMA_VERSION = 2;
export const ASSESSMENT_TABLE = "ability_assessments";
export const ASSESSMENT_ROWS_PER_TRANSACTION = 500;
export const MODEL_RUNS_PER_TRANSACTION = 1;
export const FORMAL_GROUPS = ["empty-wal", "near-threshold"];
export const ALL_GROUPS = ["normalized", ...FORMAL_GROUPS];
export const WAL_OBSERVATION_METHOD = "PRAGMA wal_checkpoint(NOOP)";

/** 最近秩分位数：升序后取 ceil(ratio × N) − 1（与实施计划 §4.4 一致）。 */
export function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function summarize(values) {
  if (values.length === 0) {
    return { samples: 0, p50: null, p95: null, min: null, max: null, mean: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  };
}

/** 原写入门槛：增量 ≤ max(基线 P95 × 10%, 5 ms)，P50 只作辅证。 */
export function buildWriteGate(baseline, candidate) {
  const metrics = {};
  for (const [key, label] of [["transaction", "完整事务"], ["lock", "持锁"], ["commit", "COMMIT"]]) {
    const base = baseline?.[key];
    const next = candidate?.[key];
    if (!base || !next || base.p95 === null || next.p95 === null || base.p50 === null || next.p50 === null) {
      throw new Error(`missing ${key} summary for write gate`);
    }
    const p95Ms = next.p95 - base.p95;
    const p95LimitMs = Math.max(5, base.p95 * 0.1);
    const p50Ms = next.p50 - base.p50;
    const p50LimitMs = Math.max(5, base.p50 * 0.1);
    metrics[key] = {
      label,
      baselineP50: base.p50,
      candidateP50: next.p50,
      p50Ms,
      p50Percent: (p50Ms / base.p50) * 100,
      p50LimitMs,
      p50Pass: p50Ms <= p50LimitMs,
      baselineP95: base.p95,
      candidateP95: next.p95,
      p95Ms,
      p95Percent: (p95Ms / base.p95) * 100,
      p95LimitMs,
      p95Pass: p95Ms <= p95LimitMs
    };
  }
  return {
    ok: Object.values(metrics).every((metric) => metric.p95Pass),
    p50AllPass: Object.values(metrics).every((metric) => metric.p50Pass),
    metrics
  };
}

const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const near = (left, right, tolerance = 1e-6) => Math.abs(left - right) <= tolerance;

function samePragmas(actual, expected) {
  if (!actual || typeof actual !== "object") return false;
  return Object.entries(expected).every(([key, value]) => {
    if (key === "journalMode") return String(actual[key]).toLowerCase() === String(value).toLowerCase();
    return actual[key] === value;
  });
}

function expectedTimedPragmas(state) {
  return {
    foreignKeys: 1,
    journalMode: "wal",
    synchronous: 1,
    busyTimeout: 5000,
    walAutoCheckpoint: state === "normalized" ? 0 : 1000,
    pageSize: 4096
  };
}

function expectedSetupPragmas() {
  return { ...expectedTimedPragmas("normalized"), walAutoCheckpoint: 0 };
}

/** 每个样本的计时区间必须自洽：total = begin + lock，lock = insert + commit。 */
function validateSampleTiming(sample, failures, where) {
  for (const key of ["beginMs", "insertMs", "commitMs", "lockMs", "totalMs"]) {
    if (!finiteNumber(sample[key]) || sample[key] < 0) {
      failures.push({ code: "invalid_timing", where, detail: `${key}=${sample[key]}` });
      return;
    }
  }
  if (!near(sample.totalMs, sample.beginMs + sample.lockMs, 1e-3)) {
    failures.push({ code: "invalid_timing", where, detail: "totalMs != beginMs + lockMs" });
  }
  if (!near(sample.lockMs, sample.insertMs + sample.commitMs, 1e-3)) {
    failures.push({ code: "invalid_timing", where, detail: "lockMs != insertMs + commitMs" });
  }
  if (!(sample.insertMs > 0) || !(sample.commitMs > 0) || !(sample.totalMs > 0)) {
    failures.push({ code: "invalid_timing", where, detail: "non-positive measured phase" });
  }
}

function validateSample(sample, state, variantLabel, failures, where) {
  if (sample?.round === -1) {
    failures.push({ code: "warmup_mixed_into_samples", where, detail: "round=-1 in formal samples" });
    return;
  }
  if (!Number.isInteger(sample?.round) || sample.round < 0) {
    failures.push({ code: "invalid_round", where, detail: `round=${sample?.round}` });
  }
  if (sample?.state !== state) {
    failures.push({ code: "wrong_state", where, detail: `state=${sample?.state}` });
  }
  if (sample?.variant !== undefined && sample.variant !== variantLabel) {
    failures.push({ code: "wrong_variant", where, detail: `variant=${sample.variant}` });
  }
  if (sample?.table !== ASSESSMENT_TABLE) {
    failures.push({ code: "wrong_workload_table", where, detail: `table=${sample?.table}` });
  }
  if (sample?.rowsInserted !== ASSESSMENT_ROWS_PER_TRANSACTION) {
    failures.push({ code: "wrong_row_count", where, detail: `rowsInserted=${sample?.rowsInserted}` });
  }
  if (sample?.modelRunRows !== MODEL_RUNS_PER_TRANSACTION) {
    failures.push({ code: "wrong_model_run_count", where, detail: `modelRunRows=${sample?.modelRunRows}` });
  }
  if (!samePragmas(sample?.setupPragmas, expectedSetupPragmas())) {
    failures.push({ code: "invalid_setup_pragmas", where, detail: JSON.stringify(sample?.setupPragmas) });
  }
  if (!samePragmas(sample?.timedPragmas, expectedTimedPragmas(state))) {
    failures.push({ code: "invalid_timed_pragmas", where, detail: JSON.stringify(sample?.timedPragmas) });
  }
  validateSampleTiming(sample, failures, where);
  const before = sample?.walBefore;
  const after = sample?.walAfter;
  for (const [name, wal] of [["walBefore", before], ["walAfter", after]]) {
    if (!wal || !Number.isInteger(wal.busy) || !Number.isInteger(wal.log) || !Number.isInteger(wal.checkpointed)) {
      failures.push({ code: "invalid_wal_observation", where, detail: `${name} missing NOOP columns` });
    }
  }
  if (!before || !after || !Number.isInteger(before.log) || !Number.isInteger(after.log)) return;
  if (state === "normalized" || state === "empty-wal") {
    if (before.busy !== 0) failures.push({ code: "wal_not_idle", where, detail: `walBefore.busy=${before.busy}` });
    if (before.log !== 0) failures.push({ code: "wal_not_empty", where, detail: `walBefore.log=${before.log}` });
    if (after.log >= 1000) failures.push({ code: "unexpected_autocheckpoint", where, detail: `walAfter.log=${after.log}` });
    if (after.checkpointed !== 0) {
      failures.push({ code: "unexpected_autocheckpoint", where, detail: `walAfter.checkpointed=${after.checkpointed}` });
    }
    if (sample?.truncate?.busy !== 0 || sample?.truncate?.log !== 0) {
      failures.push({ code: "truncate_not_clean", where, detail: JSON.stringify(sample?.truncate) });
    }
  }
  if (state === "near-threshold") {
    if (!(before.log >= 950 && before.log < 1000)) {
      failures.push({ code: "wal_start_out_of_range", where, detail: `walBefore.log=${before.log}` });
    }
    if (before.busy !== 0) failures.push({ code: "wal_not_idle", where, detail: `walBefore.busy=${before.busy}` });
    if (!(after.log >= 1000)) failures.push({ code: "threshold_not_crossed", where, detail: `walAfter.log=${after.log}` });
    if (!(after.checkpointed > before.checkpointed)) {
      failures.push({ code: "checkpoint_not_observed", where, detail: `checkpointed ${before.checkpointed} -> ${after.checkpointed}` });
    }
    if (sample?.crossedThreshold !== true) {
      failures.push({ code: "threshold_not_crossed", where, detail: "crossedThreshold!=true" });
    }
    if (!(sample?.framesAdded > 0)) {
      failures.push({ code: "invalid_wal_observation", where, detail: `framesAdded=${sample?.framesAdded}` });
    }
    if (!(sample?.prefillRows > 0)) {
      failures.push({ code: "missing_prefill", where, detail: `prefillRows=${sample?.prefillRows}` });
    }
  }
}

function validateVariantSummary(group, state, label, variant, rounds, failures, groupWhere) {
  if (!variant || typeof variant !== "object") {
    failures.push({ code: "missing_variant", where: groupWhere, detail: label });
    return null;
  }
  const where = `${groupWhere}/${label}`;
  const samples = Array.isArray(variant.samples) ? variant.samples : [];
  const warmups = Array.isArray(variant.warmupSamples) ? variant.warmupSamples : [];
  if (samples.length !== rounds) {
    failures.push({ code: "sample_count", where, detail: `${samples.length} != ${rounds}` });
  }
  if (warmups.length !== 1) {
    failures.push({ code: "warmup_count", where, detail: `${warmups.length} != 1` });
  }
  const roundsSeen = new Set();
  for (const [index, sample] of samples.entries()) {
    validateSample(sample, state, label, failures, `${where}/sample[${index}]`);
    if (Number.isInteger(sample?.round)) {
      if (roundsSeen.has(sample.round)) {
        failures.push({ code: "duplicate_round", where, detail: `round=${sample.round}` });
      }
      roundsSeen.add(sample.round);
    }
  }
  for (let round = 0; round < rounds; round += 1) {
    if (!roundsSeen.has(round)) failures.push({ code: "missing_round", where, detail: `round=${round}` });
  }
  if (variant.table !== undefined && variant.table !== ASSESSMENT_TABLE) {
    failures.push({ code: "wrong_workload_table", where, detail: `table=${variant.table}` });
  }
  if (variant.rowsPerTransaction !== ASSESSMENT_ROWS_PER_TRANSACTION) {
    failures.push({ code: "wrong_row_count", where, detail: `rowsPerTransaction=${variant.rowsPerTransaction}` });
  }
  if (!samePragmas(variant.pragmas?.timed, expectedTimedPragmas(state))) {
    failures.push({ code: "invalid_timed_pragmas", where, detail: `summary timed=${JSON.stringify(variant.pragmas?.timed)}` });
  }
  if (!samePragmas(variant.pragmas?.setup, expectedSetupPragmas())) {
    failures.push({ code: "invalid_setup_pragmas", where, detail: `summary setup=${JSON.stringify(variant.pragmas?.setup)}` });
  }
  const sampleFields = { transaction: "totalMs", lock: "lockMs", commit: "commitMs", begin: "beginMs", insert: "insertMs" };
  for (const [metric, sampleField] of Object.entries(sampleFields)) {
    const summary = variant[metric];
    if (!summary || summary.samples !== samples.length) {
      failures.push({ code: "summary_mismatch", where, detail: `${metric}.samples` });
      continue;
    }
    const recomputed = summarize(samples.map((sample) => sample[sampleField]));
    for (const key of ["p50", "p95", "min", "max", "mean"]) {
      if (!finiteNumber(summary[key]) || !near(summary[key], recomputed[key], 1e-3)) {
        failures.push({ code: "summary_mismatch", where, detail: `${metric}.${key} summary=${summary[key]} recomputed=${recomputed[key]}` });
      }
    }
  }
  // AB/BA 配对：同一组同一轮的两个变体顺序必须是 0/1 各一次。
  return { samples, warmups };
}

function validateOrdering(group, rounds, failures, groupWhere) {
  const byRound = new Map();
  for (const label of ["baseline", "ability"]) {
    for (const sample of group[label]?.samples ?? []) {
      if (!Number.isInteger(sample?.round)) continue;
      const entry = byRound.get(sample.round) ?? [];
      entry.push({ label, orderIndex: sample.orderIndex });
      byRound.set(sample.round, entry);
    }
  }
  for (const [round, entries] of byRound) {
    const baseline = entries.filter((entry) => entry.label === "baseline");
    const ability = entries.filter((entry) => entry.label === "ability");
    if (baseline.length !== 1 || ability.length !== 1) {
      failures.push({ code: "pairing", where: groupWhere, detail: `round=${round} entries=${JSON.stringify(entries)}` });
      continue;
    }
    const orders = new Set([baseline[0].orderIndex, ability[0].orderIndex].sort());
    if (!(orders.size === 2 && orders.has(0) && orders.has(1))) {
      failures.push({ code: "pairing", where: groupWhere, detail: `round=${round} order=${JSON.stringify(entries)}` });
    }
  }
  if (byRound.size !== rounds) {
    failures.push({ code: "pairing", where: groupWhere, detail: `${byRound.size} paired rounds != ${rounds}` });
  }
}

function validateGate(groupName, group, document, failures) {
  if (!group?.baseline || !group?.ability) return;
  let computed;
  try {
    computed = buildWriteGate(group.baseline, group.ability);
  } catch (error) {
    failures.push({ code: "missing_gate", where: groupName, detail: error.message });
    return;
  }
  const stored = document.gates?.[groupName];
  if (!stored) {
    failures.push({ code: "missing_gate", where: groupName, detail: "gates entry absent" });
  } else {
    if (stored.ok !== computed.ok) {
      failures.push({ code: "gate_mismatch", where: groupName, detail: `stored.ok=${stored.ok} recomputed=${computed.ok}` });
    }
    for (const [metric, detail] of Object.entries(computed.metrics)) {
      const recorded = stored.metrics?.[metric];
      if (!recorded) {
        failures.push({ code: "missing_gate", where: groupName, detail: `metric ${metric}` });
        continue;
      }
      for (const key of ["baselineP95", "candidateP95", "p95Ms", "p95LimitMs", "p95Pass"]) {
        const left = recorded[key];
        const right = detail[key];
        if (typeof right === "boolean" ? left !== right : !near(left, right, 1e-3)) {
          failures.push({ code: "gate_mismatch", where: groupName, detail: `${metric}.${key} recorded=${left} recomputed=${right}` });
        }
      }
    }
  }
  if (FORMAL_GROUPS.includes(groupName) && !computed.ok) {
    for (const [metric, detail] of Object.entries(computed.metrics)) {
      if (!detail.p95Pass) {
        failures.push({
          code: "p95_over_limit",
          where: groupName,
          detail: `${metric} delta=${detail.p95Ms.toFixed(3)}ms limit=${detail.p95LimitMs.toFixed(3)}ms`
        });
      }
    }
  }
  // normalized 是辅证组：它的 P95 超限写入 warnings，不改变正式验收结论，
  // 也不能被用来替代 empty-wal / near-threshold 的正式门禁。
}

/**
 * 独立校验一份写入证据 JSON。返回 {ok, failures}，不信任文档里的 verdict.ok。
 * @param {unknown} document
 */
export function validateEvidence(document) {
  const failures = [];
  if (!document || typeof document !== "object") {
    return { ok: false, failures: [{ code: "invalid_document", where: "root", detail: "not an object" }] };
  }
  if (document.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    failures.push({ code: "unsupported_schema", where: "root", detail: `schemaVersion=${document.schemaVersion}` });
  }
  const rounds = document.rounds;
  if (!Number.isInteger(rounds) || rounds < 1) {
    failures.push({ code: "invalid_rounds", where: "root", detail: `rounds=${rounds}` });
    return { ok: false, failures };
  }
  if (document.workload?.table !== ASSESSMENT_TABLE) {
    failures.push({ code: "wrong_workload_table", where: "workload", detail: `table=${document.workload?.table}` });
  }
  if (document.workload?.rowsPerTransaction !== ASSESSMENT_ROWS_PER_TRANSACTION) {
    failures.push({ code: "wrong_row_count", where: "workload", detail: `rowsPerTransaction=${document.workload?.rowsPerTransaction}` });
  }
  if (document.workload?.modelRunsPerTransaction !== MODEL_RUNS_PER_TRANSACTION) {
    failures.push({ code: "wrong_model_run_count", where: "workload", detail: "modelRunsPerTransaction" });
  }
  if (!document.walObservation || document.walObservation.method !== WAL_OBSERVATION_METHOD
    || document.walObservation.supported !== true) {
    failures.push({ code: "invalid_wal_observation", where: "walObservation", detail: "NOOP capability not recorded" });
  }
  if (!Array.isArray(document.failures) || document.failures.length > 0) {
    failures.push({ code: "experiment_failures", where: "failures", detail: JSON.stringify(document.failures ?? null) });
  }
  for (const groupName of ALL_GROUPS) {
    const group = document.groups?.[groupName];
    if (!group) {
      failures.push({ code: "missing_group", where: groupName, detail: "group absent" });
      continue;
    }
    for (const label of ["baseline", "ability"]) {
      validateVariantSummary(groupName, groupName, label, group[label], rounds, failures, `groups/${groupName}`);
    }
    validateOrdering(group, rounds, failures, `groups/${groupName}`);
    validateGate(groupName, group, document, failures);
  }
  for (const label of ["baseline", "ability"]) {
    const persistence = document.persistence?.[label];
    if (!persistence || persistence.ok !== true) {
      failures.push({ code: "persistence_failed", where: `persistence/${label}`, detail: JSON.stringify(persistence ?? null) });
      continue;
    }
    if (persistence.table !== ASSESSMENT_TABLE) {
      failures.push({ code: "wrong_workload_table", where: `persistence/${label}`, detail: `table=${persistence.table}` });
    }
    if (persistence.rowsReadBack !== ASSESSMENT_ROWS_PER_TRANSACTION
      || persistence.modelRunsReadBack !== MODEL_RUNS_PER_TRANSACTION) {
      failures.push({ code: "persistence_failed", where: `persistence/${label}`, detail: "read-back row counts" });
    }
    if (persistence.foreignKeyViolations !== 0) {
      failures.push({ code: "persistence_failed", where: `persistence/${label}`, detail: "foreign_key_check" });
    }
    const expectedIndex = label === "ability" ? true : false;
    if (persistence.targetIndexPresent !== expectedIndex) {
      failures.push({ code: "index_mismatch", where: `persistence/${label}`, detail: `targetIndexPresent=${persistence.targetIndexPresent}` });
    }
  }
  if (document.verdict?.ok !== true) {
    failures.push({ code: "verdict_not_ok", where: "verdict", detail: `verdict.ok=${document.verdict?.ok}` });
  }
  if (!Array.isArray(document.verdict?.failures) || document.verdict.failures.length > 0) {
    failures.push({ code: "verdict_failures", where: "verdict", detail: JSON.stringify(document.verdict?.failures ?? null) });
  }
  return { ok: failures.length === 0, failures };
}
