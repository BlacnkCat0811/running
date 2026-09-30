import assert from "node:assert/strict";
import test from "node:test";

import type { ReplayDescriptorV2, WorkoutTrainingLoad } from "@rai/contracts";

import { replayLoadRulings, type LoadReplayFacts } from "../src/load-replay-v2.js";

const AS_OF = "2026-02-01T00:00:00.000Z";

const descriptor = (replayMode: ReplayDescriptorV2["replayMode"], availabilityUnknown: boolean): ReplayDescriptorV2 => ({
  caseId: "case-load",
  asOf: AS_OF,
  timezoneIdentifier: "Asia/Shanghai",
  replayMode,
  factsSnapshotHash: "facts-hash",
  overrideSnapshotHash: "override-hash",
  availabilityUnknown
});

function load(localDate: string, value: number, sessionId: string): WorkoutTrainingLoad {
  return {
    trainingSessionId: sessionId,
    localDate,
    distanceMeters: 10_000,
    durationSeconds: 3_000,
    load: value,
    intensity: 0.6,
    source: "composite",
    confidence: 0.9,
    rpe: null,
    sessionType: "easy",
    averageHeartRate: 140,
    elevationGainMeters: null,
    stimulusType: "aerobic_base",
    breakdown: {
      rawHrrTrimp: null,
      internalLoad: null,
      paceLoad: null,
      distanceReferenceMeters: null,
      distanceExposureRatio: null,
      distanceFactor: 1,
      compositeLoad: value,
      compositeIntensity: 0.6,
      heartRateConfidence: 0.9,
      paceConfidence: 0.9
    },
    explanations: []
  };
}

/** 8 周、每周 3 次的历史；只有事实是可控的，负荷函数本身不被本测试改写。 */
function facts(overrides: { availableAtOf?: string | null; observedAtOf?: string; extra?: LoadReplayFacts["facts"] } = {}): LoadReplayFacts {
  const rows: LoadReplayFacts["facts"] = [];
  const start = Date.UTC(2025, 11, 1);
  let index = 0;
  for (let day = 0; day < 56; day += 1) {
    if (day % 2 !== 0) continue;
    const localDate = new Date(start + day * 86_400_000).toISOString().slice(0, 10);
    rows.push({
      load: load(localDate, 90 + (day % 7) * 5, `session-${index}`),
      observedAt: `${localDate}T01:00:00.000Z`,
      availableAt: `${localDate}T02:00:00.000Z`
    });
    index += 1;
  }
  const observedAtOf = overrides.observedAtOf ?? "2026-01-20T01:00:00.000Z";
  rows.push({
    load: load("2026-01-20", 260, "session-late"),
    observedAt: observedAtOf,
    availableAt: overrides.availableAtOf === undefined ? "2026-01-20T02:00:00.000Z" : overrides.availableAtOf
  });
  return {
    localDate: "2026-01-25",
    throughDate: "2026-01-31",
    facts: [...rows, ...(overrides.extra ?? [])],
    physEvidence: []
  };
}

test("D10: a load that only arrived after as-of changes the ruling, and the report says the arrival assumption did it", () => {
  // 观测在 01-20，但系统直到 02-20 才拿到 —— 对 as-of=02-01 来说当时并不知道它。
  const result = replayLoadRulings({
    descriptor: descriptor("event_time_reconstruction", false),
    facts: facts({ availableAtOf: "2026-02-20T00:00:00.000Z" })
  });
  // "假设事实即刻到达"那一支多纳入这一条；两支调用的是同一个生产负荷函数。
  assert.equal(result.base.output.includedFactCount, result.candidate.output.includedFactCount + 1);
  assert.equal(result.base.version, "observation_time_arrival_counterfactual");
  assert.equal(result.candidate.version, "training-load-config-v5");
  // 这一条事实确实改变了当天的负荷裁决：负荷序列是滚动的，迟到导入会改写它之后每一天。
  assert.equal(result.rulingEqual, false);
  assert.ok(result.arrivalSensitiveExplanationCodes.length > 0);
  assert.ok(result.candidate.output.day);
  assert.ok(result.base.output.day);
  assert.notEqual(result.base.output.day.trainingStatus, result.candidate.output.day.trainingStatus);
  // 反事实支多算了一次负荷 ⇒ 它的长期负荷必然不低于按真实到达时间算出的值。
  assert.ok(result.base.output.day.chronicEwma > result.candidate.output.day.chronicEwma);
  // 本域的回放只报告可用性口径的影响，不给出任何精度结论。
  assert.equal(result.accuracyStatus, "not_evaluable");
  assert.match(result.note, /可用性口径/);
});

test("D10: an already-arrived load leaves both branches identical, so arrival timing is not load-bearing", () => {
  const result = replayLoadRulings({
    descriptor: descriptor("as_known_then", false),
    facts: facts()
  });
  assert.equal(result.rulingEqual, true);
  assert.deepEqual(result.arrivalSensitiveExplanationCodes, []);
  assert.equal(result.base.output.includedFactCount, result.candidate.output.includedFactCount);
});

test("D10: unknown arrival times cannot certify as-known-then replay", () => {
  // `availableAt: null` 是"不知道什么时候到的"，不是"已经到了"。
  // 允许它进入 as_known_then 会把一次历史重建冒充成当时可实现的预测。
  assert.throws(
    () => replayLoadRulings({
      descriptor: descriptor("as_known_then", true),
      facts: facts({ availableAtOf: null })
    }),
    /Unknown arrival times cannot certify as-known-then replay/
  );
  // 同一条事实在 event_time_reconstruction 下仍然可以回放 —— 那正是该模式的用途。
  const reconstructed = replayLoadRulings({
    descriptor: descriptor("event_time_reconstruction", true),
    facts: facts({ availableAtOf: null })
  });
  assert.equal(reconstructed.candidate.output.includedFactCount, reconstructed.base.output.includedFactCount - 1);
});

test("D10: the same frozen facts replay deterministically", () => {
  const input = { descriptor: descriptor("event_time_reconstruction", false), facts: facts() };
  const first = replayLoadRulings(input);
  const second = replayLoadRulings(input);
  assert.equal(first.candidate.semantic, second.candidate.semantic);
  assert.equal(first.base.semantic, second.base.semantic);
});

test("D10: a day outside the resulting series is reported as absent, not as a zero-load day", () => {
  // 事实全被到达时间排除 ⇒ 序列里没有这一天。把它当成"负荷 0 的休息日"会凭空
  // 造出一个"恢复良好"的结论。
  const empty = replayLoadRulings({
    descriptor: descriptor("as_known_then", false),
    facts: { localDate: "2026-01-25", throughDate: "2026-01-31", facts: [], physEvidence: [] }
  });
  assert.equal(empty.candidate.output.day, null);
  assert.equal(empty.candidate.output.excludedFactCount, 0);
});

test("F05: load replay checks event time as well as availability and does not trust a false unknown flag", () => {
  const input = {
    descriptor: descriptor("as_known_then", false),
    facts: facts({ observedAtOf: "2026-02-20T01:00:00Z" })
  };
  const result = replayLoadRulings(input);
  assert.equal(result.base.output.includedFactCount, input.facts.facts.length - 1);
  assert.equal(result.candidate.output.includedFactCount, input.facts.facts.length - 1);
  assert.throws(() => replayLoadRulings({
    ...input, facts: facts({ availableAtOf: null })
  }), /Unknown arrival times/);
  assert.throws(() => replayLoadRulings({
    ...input, facts: facts({ observedAtOf: "invalid" })
  }), /Invalid load observation/);
  assert.throws(() => replayLoadRulings({
    ...input, facts: facts({ extra: [input.facts.facts[0]!] })
  }), /Duplicate replay session/);
});
