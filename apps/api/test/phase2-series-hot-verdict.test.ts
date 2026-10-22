import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../../..");
const HOT_COMPARE = join(ROOT, "scripts/phase2-series-hot-compare.mjs");
const FULL_COMPARE = join(ROOT, "scripts/phase2-series-cache-compare.mjs");
const WINDOWS = ["recent", "p25", "p50", "p75", "oldest"] as const;
const WINDOW_INDEX: Record<(typeof WINDOWS)[number], number> = {
  oldest: 0,
  p25: 1,
  p50: 2,
  p75: 3,
  recent: 4
};
const SELECTION_VERSION = "phase2-series-window-selection-v1";

interface HotSample {
  ms: number;
  status: number;
  bodySha256: string;
  trainingSessionId: string | null;
  metricSamples: number | null;
}

interface HotWindow {
  sessionId: string;
  p95: number;
  p50: number;
  min: number;
  max: number;
  mean: number;
  samples: HotSample[];
  window?: {
    selectionVersion: string;
    name: string;
    trainingSessionId: string;
    startedAt: string;
    endedAt: string | null;
    indexFromOldest: number;
    readableSessions: number;
  };
}

interface Evidence {
  hotWindows: Record<string, HotWindow>;
  states?: Record<string, unknown>;
}

type Entry = { name: string; script: string; extraArgs: string[] };

const ENTRIES: Entry[] = [
  { name: "hot-only", script: HOT_COMPARE, extraArgs: [] },
  { name: "full", script: FULL_COMPARE, extraArgs: ["--hot-only"] }
];

const timestamp = (index: number, end = false) => (
  `2026-01-${String(index + 1).padStart(2, "0")}T${end ? "01:00:00" : "00:00:00"}.000Z`
);

const windowFixture = (name: string, id: string, ms = 10): HotWindow => ({
  sessionId: id,
  p95: ms,
  p50: ms,
  min: ms,
  max: ms,
  mean: ms,
  samples: Array.from({ length: 200 }, () => ({
    ms,
    status: 200,
    bodySha256: `hash-${name}`,
    trainingSessionId: id,
    metricSamples: 10
  })),
  window: {
    selectionVersion: SELECTION_VERSION,
    name,
    trainingSessionId: id,
    startedAt: timestamp(WINDOW_INDEX[name as (typeof WINDOWS)[number]]),
    endedAt: timestamp(WINDOW_INDEX[name as (typeof WINDOWS)[number]], true),
    indexFromOldest: WINDOW_INDEX[name as (typeof WINDOWS)[number]],
    readableSessions: WINDOWS.length
  }
});

const fixture = (): Evidence => ({
  hotWindows: Object.fromEntries(WINDOWS.map((name) => [
    name,
    windowFixture(name, `s${WINDOW_INDEX[name]}`)
  ])),
  states: {}
});

function runEntry(entry: Entry, baseline: unknown, candidate: unknown, extraArgs: string[] = []): {
  status: number | null;
  json: Record<string, any>;
} {
  const root = mkdtempSync(join(tmpdir(), "rai-series-hot-verdict-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const candidatePath = join(root, "candidate.json");
    const outPath = join(root, "out.json");
    writeFileSync(baselinePath, JSON.stringify(baseline));
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const result = spawnSync(process.execPath, [
      entry.script, "--baseline", baselinePath, "--candidate", candidatePath,
      "--dataset", "D2", "--json", outPath, ...entry.extraArgs, ...extraArgs
    ], { cwd: ROOT, encoding: "utf8" });
    const json = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, any>;
    return { status: result.status, json };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function windowsOf(entry: Entry, json: Record<string, any>): Record<string, any> {
  return entry.name === "hot-only" ? json.windows : json.hotWindows;
}

function failureCodes(json: Record<string, any>): string[] {
  return (json.failures as Array<{ code: string }>).map((failure) => failure.code);
}

function assertBothEntriesReject(baseline: Evidence, candidate: Evidence, code: string, extraArgs: string[] = []): void {
  for (const entry of ENTRIES) {
    const run = runEntry(entry, baseline, candidate, extraArgs);
    assert.equal(run.status, 1, `${entry.name}: ${JSON.stringify(run.json.failures)}`);
    assert.ok(failureCodes(run.json).includes(code), `${entry.name}: expected ${code}, got ${failureCodes(run.json).join(",")}`);
  }
}

function setWindowSamples(window: HotWindow, values: number[]): void {
  window.samples = values.map((ms, index) => ({
    ...window.samples[index]!,
    ms
  }));
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
  window.p50 = percentile(0.5);
  window.p95 = percentile(0.95);
  window.min = sorted[0]!;
  window.max = sorted.at(-1)!;
  window.mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
}

test("hot-window verdict rejects 404 samples, identity mismatches and empty content in both entries", () => {
  const baseline = fixture();
  const valid = fixture();
  for (const entry of ENTRIES) {
    const validRun = runEntry(entry, baseline, valid);
    assert.equal(validRun.status, 0, `${entry.name}: ${JSON.stringify(validRun.json.failures)}`);
    assert.equal(validRun.json.ok, true);
    assert.equal(validRun.json.windowTimelineVerified, true);
    assert.equal(validRun.json.windowMappingVerified, true);
  }

  const with404 = fixture();
  with404.hotWindows.p50!.samples[0]!.status = 404;
  assertBothEntriesReject(baseline, with404, "hot_status");

  const withWrongIdentity = fixture();
  withWrongIdentity.hotWindows.oldest!.samples[0]!.trainingSessionId = "s999";
  assertBothEntriesReject(baseline, withWrongIdentity, "hot_identity");

  const emptyContent = fixture();
  emptyContent.hotWindows.recent!.samples[0]!.metricSamples = 0;
  assertBothEntriesReject(baseline, emptyContent, "hot_empty_content");

  const bodyDiff = fixture();
  bodyDiff.hotWindows.recent!.samples[0]!.bodySha256 = "different-body";
  assertBothEntriesReject(baseline, bodyDiff, "body_diff");
});

test("P95 is recomputed from raw samples with the nearest-rank rule (200 -> 190th)", () => {
  const baseline = fixture();
  const candidate = fixture();
  const values = Array.from({ length: 200 }, (_, index) => index + 1);
  const shuffled = values.map((_, index) => values[(index * 37) % 200]!);
  setWindowSamples(baseline.hotWindows.recent!, shuffled);
  setWindowSamples(candidate.hotWindows.recent!, shuffled);
  assert.equal(baseline.hotWindows.recent!.p95, 190);
  assert.equal(baseline.hotWindows.recent!.p50, 100);
  assert.equal(baseline.hotWindows.recent!.mean, 100.5);

  for (const entry of ENTRIES) {
    const run = runEntry(entry, baseline, candidate);
    assert.equal(run.status, 0, `${entry.name}: ${JSON.stringify(run.json.failures)}`);
    const window = windowsOf(entry, run.json).recent;
    assert.equal(window.recomputedP95.baseline, 190);
    assert.equal(window.recomputedP95.candidate, 190);
    assert.equal(window.declaredP95.candidate, 190);
    assert.equal(window.summaryConsistent.candidate, true);
    assert.equal(window.pass, true);
  }
});

test("tampered summary is rejected and never yields a passing window", () => {
  const baseline = fixture();
  const candidate = fixture();
  setWindowSamples(candidate.hotWindows.recent!, Array.from({ length: 200 }, () => 1000));
  // 模拟旧缺陷：只改原始耗时，保留旧汇总，必须被汇总一致性检查拦截。
  candidate.hotWindows.recent!.p50 = 10;
  candidate.hotWindows.recent!.p95 = 10;
  candidate.hotWindows.recent!.min = 10;
  candidate.hotWindows.recent!.max = 10;
  candidate.hotWindows.recent!.mean = 10;

  for (const entry of ENTRIES) {
    const run = runEntry(entry, baseline, candidate);
    assert.equal(run.status, 1, `${entry.name}: tampered summary must fail`);
    assert.ok(failureCodes(run.json).includes("hot_summary_mismatch"));
    const window = windowsOf(entry, run.json).recent;
    assert.equal(window.recomputedP95.candidate, 1000);
    assert.equal(window.declaredP95.candidate, 10);
    assert.equal(window.summaryConsistent.candidate, false);
    assert.equal(window.pass, null);
    assert.equal(window.performance, "not_evaluable");
  }
});

test("performance gate uses recomputed P95 and keeps the original threshold", () => {
  const baseline = fixture();
  const atLimit = fixture();
  setWindowSamples(atLimit.hotWindows.recent!, Array.from({ length: 200 }, () => 30));
  for (const entry of ENTRIES) {
    const run = runEntry(entry, baseline, atLimit);
    assert.equal(run.status, 0, `${entry.name}: delta 20ms must pass: ${JSON.stringify(run.json.failures)}`);
    const window = windowsOf(entry, run.json).recent;
    assert.equal(window.deltaMs, 20);
    assert.equal(window.limitMs, 20);
    assert.equal(window.pass, true);
    assert.equal(window.evaluable, true);
  }

  const overLimit = fixture();
  setWindowSamples(overLimit.hotWindows.recent!, Array.from({ length: 200 }, () => 30.001));
  for (const entry of ENTRIES) {
    const run = runEntry(entry, baseline, overLimit);
    assert.equal(run.status, 1, `${entry.name}: delta 20.001ms must fail`);
    assert.ok(failureCodes(run.json).includes("hot_window_p95"));
    const window = windowsOf(entry, run.json).recent;
    assert.equal(window.pass, false);
    assert.equal(window.performance, "fail");
  }
});

test("invalid sample counts and durations invalidate evidence without filtering samples", () => {
  const baseline = fixture();
  for (const length of [199, 201]) {
    const candidate = fixture();
    const window = candidate.hotWindows.recent!;
    if (length === 199) window.samples = window.samples.slice(0, 199);
    else window.samples.push({ ...window.samples[0]! });
    assertBothEntriesReject(baseline, candidate, "hot_sample_count");
  }

  for (const invalid of [null, "10", -1] as const) {
    const candidate = fixture();
    candidate.hotWindows.recent!.samples[0]!.ms = invalid as unknown as number;
    for (const entry of ENTRIES) {
      const run = runEntry(entry, baseline, candidate);
      assert.equal(run.status, 1, `${entry.name}: ${String(invalid)} must fail`);
      assert.ok(failureCodes(run.json).includes("hot_duration_invalid"));
      assert.equal(windowsOf(entry, run.json).recent.sampleCount.candidate, 200);
    }
  }
});

test("window selection metadata must match across baseline and candidate", () => {
  const baseline = fixture();

  const movedWindow = fixture();
  movedWindow.hotWindows.recent!.window!.startedAt = "2026-02-01T00:00:00.000Z";
  assertBothEntriesReject(baseline, movedWindow, "hot_window_selection_mismatch");

  const movedEnd = fixture();
  movedEnd.hotWindows.recent!.window!.endedAt = "2026-02-01T01:00:00.000Z";
  assertBothEntriesReject(baseline, movedEnd, "hot_window_selection_mismatch");

  const otherSession = fixture();
  const otherSessionWindow = otherSession.hotWindows.recent!;
  otherSessionWindow.sessionId = "s9";
  otherSessionWindow.window!.trainingSessionId = "s9";
  for (const sample of otherSessionWindow.samples) sample.trainingSessionId = "s9";
  assertBothEntriesReject(baseline, otherSession, "hot_session_mismatch");

  const otherVersion = fixture();
  otherVersion.hotWindows.p25!.window!.selectionVersion = "phase2-series-window-selection-v0";
  assertBothEntriesReject(baseline, otherVersion, "hot_window_selection_version");

  const missingMetadata = fixture();
  delete missingMetadata.hotWindows.recent!.window;
  assertBothEntriesReject(baseline, missingMetadata, "hot_window_selection_missing");

  const legacyBaseline = fixture();
  const legacyCandidate = fixture();
  for (const name of WINDOWS) {
    delete legacyBaseline.hotWindows[name]!.window;
    delete legacyCandidate.hotWindows[name]!.window;
  }
  for (const entry of ENTRIES) {
    const run = runEntry(entry, legacyBaseline, legacyCandidate, ["--allow-legacy-window-mapping"]);
    assert.equal(run.status, 0, `${entry.name}: ${JSON.stringify(run.json.failures)}`);
    assert.equal(run.json.windowMappingVerified, false);
    assert.equal(run.json.windowTimelineVerified, false);
    assert.ok((run.json.warnings as Array<{ code: string }>).some((warning) => warning.code === "hot_window_mapping_unverified"));
  }
});

test("identical wrong metadata on both sides still fails name/index/time validation", () => {
  const both = (mutate: (evidence: Evidence) => void): [Evidence, Evidence] => {
    const baseline = fixture();
    const candidate = fixture();
    mutate(baseline);
    mutate(candidate);
    return [baseline, candidate];
  };
  const assertWrongBothSides = (mutate: (evidence: Evidence) => void, code: string): void => {
    const [baseline, candidate] = both(mutate);
    for (const entry of ENTRIES) {
      const run = runEntry(entry, baseline, candidate);
      assert.equal(run.status, 1, `${entry.name}: both-sides-wrong fixture must fail`);
      assert.ok(failureCodes(run.json).includes(code), `${entry.name}: expected ${code}, got ${failureCodes(run.json).join(",")}`);
      assert.equal(run.json.windowMappingVerified, false);
    }
  };

  // 两侧同时把 recent 写成 0、oldest 写成 N-1：相等，但名称对应的下标错误。
  assertWrongBothSides((evidence) => {
    evidence.hotWindows.recent!.window!.indexFromOldest = 0;
    evidence.hotWindows.oldest!.window!.indexFromOldest = 4;
  }, "hot_window_index_mismatch");

  // 总数 5，下标却为 999：越界。
  assertWrongBothSides((evidence) => {
    evidence.hotWindows.p50!.window!.indexFromOldest = 999;
  }, "hot_window_index_mismatch");

  // 结束时间早于开始时间。
  assertWrongBothSides((evidence) => {
    evidence.hotWindows.p50!.window!.endedAt = "2026-01-02T00:00:00.000Z";
  }, "hot_window_time_range");

  // 五窗口时间顺序颠倒：oldest 被放到 recent 之后。
  assertWrongBothSides((evidence) => {
    evidence.hotWindows.oldest!.window!.startedAt = "2026-01-06T00:00:00.000Z";
    evidence.hotWindows.oldest!.window!.endedAt = "2026-01-06T01:00:00.000Z";
  }, "hot_window_timeline");

  // 同一侧五个窗口声称不同的可读训练总数。
  assertWrongBothSides((evidence) => {
    evidence.hotWindows.p50!.window!.readableSessions = 6;
  }, "hot_window_timeline");
});
