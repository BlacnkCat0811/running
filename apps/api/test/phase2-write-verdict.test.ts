import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A 项的失败夹具：纯裁决逻辑直接使用 JSON 证据，不需要数据库。
 *
 * 这些夹具证明“写了 verdict.ok=true 但缺少证据”会被独立验收器拒绝；它们不替代
 * 隔离库上的真实 100 轮实验（那只在实验根执行）。
 */
const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SCRIPT = join(REPO_ROOT, "scripts", "phase2-write-amplification.mjs");
const ROUNDS = 100;
const SETUP_PRAGMAS = {
  foreignKeys: 1,
  journalMode: "wal",
  synchronous: 1,
  busyTimeout: 5000,
  walAutoCheckpoint: 0,
  pageSize: 4096
};

type Sample = Record<string, any>;
type Variant = Record<string, any>;
type Document = Record<string, any>;

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]!;
}

function summarize(values: number[]): Record<string, number> {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0]!,
    max: sorted.at(-1)!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  };
}

function gate(baseline: Variant, ability: Variant): Record<string, any> {
  const metrics: Record<string, any> = {};
  for (const [key, label] of [["transaction", "完整事务"], ["lock", "持锁"], ["commit", "COMMIT"]] as const) {
    const base = baseline[key] as { p50: number; p95: number };
    const next = ability[key] as { p50: number; p95: number };
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
  return { ok: Object.values(metrics).every((metric: any) => metric.p95Pass), p50AllPass: true, metrics };
}

function wal(state: string, phase: "before" | "after"): Record<string, number> {
  if (state === "near-threshold") {
    return phase === "before"
      ? { busy: 0, log: 960, checkpointed: 0, walBytes: 3_960_000, capacityPages: 967 }
      : { busy: 0, log: 1035, checkpointed: 1035, walBytes: 4_270_000, capacityPages: 1043 };
  }
  return phase === "before"
    ? { busy: 0, log: 0, checkpointed: 0, walBytes: 0, capacityPages: 0 }
    : { busy: 0, log: 75, checkpointed: 0, walBytes: 310_000, capacityPages: 76 };
}

function sample(state: string, variantLabel: string, round: number, offsetMs: number): Sample {
  const beginMs = 0.5;
  const insertMs = 20 + (round % 4) * 0.2 + offsetMs;
  const commitMs = 8 + (round % 3) * 0.15 + offsetMs;
  const lockMs = insertMs + commitMs;
  const totalMs = beginMs + lockMs;
  const before = wal(state, "before");
  const after = wal(state, "after");
  return {
    round,
    orderIndex: 0,
    state,
    variant: variantLabel,
    table: "ability_assessments",
    modelRunId: `fixture-${state}-${variantLabel}-${round}`,
    modelRunRows: 1,
    rowsInserted: 500,
    assessedAt: "2026-10-21T12:00:00.000Z",
    sequenceBase: 10_000,
    beginMs,
    insertMs,
    commitMs,
    lockMs,
    totalMs,
    setupPragmas: SETUP_PRAGMAS,
    timedPragmas: { ...SETUP_PRAGMAS, walAutoCheckpoint: state === "normalized" ? 0 : 1000 },
    truncate: { busy: 0, log: 0, checkpointed: 0, walBytesBefore: 0, walBytesAfter: 0 },
    prefill: state === "near-threshold" ? { rows: 945, walLog: 960, targetMin: 950, targetMax: 1000 } : null,
    prefillRows: state === "near-threshold" ? 945 : 0,
    walBefore: before,
    walAfter: after,
    framesAdded: after.log! - before.log!,
    checkpointedFrames: after.checkpointed! - before.checkpointed!,
    crossedThreshold: state === "near-threshold",
    walCapacityApproximation: { beforePages: before.capacityPages, afterPages: after.capacityPages, note: "capacity only" }
  };
}

function variant(state: string, label: string, offsetMs: number, orderShift: number): Variant {
  const samples: Sample[] = Array.from({ length: ROUNDS }, (_, round) =>
    ({ ...sample(state, label, round, offsetMs), orderIndex: (round + orderShift) % 2 }));
  const warmup = { ...sample(state, label, -1, offsetMs), orderIndex: 0 };
  const summaryOf = (field: string) => summarize(samples.map((entry) => entry[field]));
  return {
    label,
    path: `/tmp/fixture-${state}-${label}.sqlite`,
    table: "ability_assessments",
    rowsPerTransaction: 500,
    pragmas: {
      setup: SETUP_PRAGMAS,
      timed: { ...SETUP_PRAGMAS, walAutoCheckpoint: state === "normalized" ? 0 : 1000 }
    },
    transaction: summaryOf("totalMs"),
    lock: summaryOf("lockMs"),
    begin: summaryOf("beginMs"),
    insert: summaryOf("insertMs"),
    commit: summaryOf("commitMs"),
    startingWalFrames: summarize(samples.map((entry) => entry.walBefore.log)),
    endingWalFrames: summarize(samples.map((entry) => entry.walAfter.log)),
    checkpointedFrames: summarize(samples.map((entry) => entry.checkpointedFrames)),
    checkpointPauses: { over50msTotal: 0, over50msCommit: 0, autocheckpointPages: 1000 },
    samples,
    warmupSamples: [warmup]
  };
}

function buildDocument(): Document {
  const groups: Document = {};
  for (const state of ["normalized", "empty-wal", "near-threshold"]) {
    groups[state] = {
      baseline: variant(state, "baseline", 0, 0),
      ability: variant(state, "ability", 0.3, 1)
    };
  }
  const gates: Document = {};
  for (const state of ["normalized", "empty-wal", "near-threshold"]) {
    gates[state] = gate(groups[state].baseline, groups[state].ability);
  }
  return {
    schemaVersion: 2,
    rounds: ROUNDS,
    workload: { table: "ability_assessments", rowsPerTransaction: 500, modelRunsPerTransaction: 1 },
    walObservation: { method: "PRAGMA wal_checkpoint(NOOP)", supported: true },
    dataset: { baseline: {}, ability: {} },
    groups,
    gates,
    persistence: {
      baseline: {
        ok: true, table: "ability_assessments", rowsReadBack: 500, modelRunsReadBack: 1,
        foreignKeyViolations: 0, targetIndexPresent: false
      },
      ability: {
        ok: true, table: "ability_assessments", rowsReadBack: 500, modelRunsReadBack: 1,
        foreignKeyViolations: 0, targetIndexPresent: true
      }
    },
    failures: [],
    verdict: { ok: true, failures: [] }
  };
}

function runVerify(document: Document): { status: number | null; output: string } {
  const directory = mkdtempSync(join(tmpdir(), "rai-write-verdict-"));
  try {
    const path = join(directory, "evidence.json");
    writeFileSync(path, JSON.stringify(document));
    const result = spawnSync(process.execPath, [SCRIPT, "--verify", path], { cwd: REPO_ROOT, encoding: "utf8" });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function rebuildGate(document: Document, state: string): void {
  document.gates[state] = gate(document.groups[state].baseline, document.groups[state].ability);
}

test("write evidence verdict: a complete 100-round fixture passes", () => {
  const result = runVerify(buildDocument());
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /"ok": true/);
});

test("write evidence verdict: one missing round fails", () => {
  const document = buildDocument();
  document.groups["empty-wal"].baseline.samples.pop();
  const result = runVerify(document);
  assert.equal(result.status, 1);
  assert.match(result.output, /sample_count/);
});

test("write evidence verdict: a warmup sample mixed into formal samples fails", () => {
  const document = buildDocument();
  document.groups["empty-wal"].ability.samples.push({ ...document.groups["empty-wal"].ability.warmupSamples[0] });
  const result = runVerify(document);
  assert.equal(result.status, 1);
  assert.match(result.output, /warmup_mixed_into_samples/);
});

test("write evidence verdict: a health_records workload cannot stand in for assessments", () => {
  const document = buildDocument();
  document.workload.table = "health_records";
  const result = runVerify(document);
  assert.equal(result.status, 1);
  assert.match(result.output, /wrong_workload_table/);
});

test("write evidence verdict: summary 0 conflicts with timed PRAGMA 1000", () => {
  const document = buildDocument();
  document.groups["empty-wal"].baseline.pragmas.timed.walAutoCheckpoint = 0;
  const result = runVerify(document);
  assert.equal(result.status, 1);
  assert.match(result.output, /invalid_timed_pragmas/);
});

test("write evidence verdict: near-threshold without crossing 1000 frames fails", () => {
  const document = buildDocument();
  for (const label of ["baseline", "ability"]) {
    for (const entry of document.groups["near-threshold"][label].samples) {
      entry.walAfter = { ...entry.walAfter, log: 999, checkpointed: 900 };
      entry.crossedThreshold = false;
      entry.framesAdded = 39;
    }
  }
  const result = runVerify(document);
  assert.equal(result.status, 1);
  assert.match(result.output, /threshold_not_crossed/);
});

test("write evidence verdict: any formal P95 over limit fails", () => {
  const document = buildDocument();
  const group = document.groups["empty-wal"];
  for (const entry of group.ability.samples) {
    entry.totalMs += 50;
    entry.lockMs += 50;
    entry.insertMs += 50;
  }
  const summaryOf = (field: string) => summarize(group.ability.samples.map((entry: Sample) => entry[field]));
  group.ability.transaction = summaryOf("totalMs");
  group.ability.lock = summaryOf("lockMs");
  group.ability.insert = summaryOf("insertMs");
  rebuildGate(document, "empty-wal");
  const result = runVerify(document);
  assert.equal(result.status, 1);
  assert.match(result.output, /p95_over_limit/);
});

test("write evidence verdict: a missing group and a missing index fail", () => {
  const missing = buildDocument();
  delete missing.groups["near-threshold"];
  const missingResult = runVerify(missing);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.output, /missing_group/);

  const index = buildDocument();
  index.persistence.ability.targetIndexPresent = false;
  const indexResult = runVerify(index);
  assert.equal(indexResult.status, 1);
  assert.match(indexResult.output, /index_mismatch/);
});

test("write evidence verdict: an experiment exception cannot be hidden behind ok=true", () => {
  const document = buildDocument();
  document.failures.push({ code: "experiment_failed", message: "commit failed" });
  const result = runVerify(document);
  assert.equal(result.status, 1);
  assert.match(result.output, /experiment_failures/);
});

test("write evidence verdict: deleting the verdict evidence fails even when ok is true", () => {
  const document = buildDocument();
  document.verdict.ok = false;
  document.verdict.failures = [{ code: "manual", detail: "not measured" }];
  const result = runVerify(document);
  assert.equal(result.status, 1);
  assert.match(result.output, /verdict_not_ok/);
});
