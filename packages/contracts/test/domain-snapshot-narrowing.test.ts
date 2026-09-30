import assert from "node:assert/strict";
import test from "node:test";
import { readFitnessSnapshot, readLoadSnapshot, readReadinessSnapshot } from "../src/index.js";

const fitnessPayload = (daily: unknown[], lineage?: unknown) => ({ lineage, assessments: [], daily });
const loadPayload = (days: unknown[], lineage?: unknown) => ({ lineage, days });

// readiness 的 fixture：形状照抄 `readinessForRun` 的产出（`ReadinessAssessmentResult & {lineage}`）。
const readinessSignal = (name: "sleep" | "hrv" | "rhr", overrides: Record<string, unknown> = {}) => ({
  name,
  value: 420,
  baseline: 450,
  ratio: 0.9333,
  low: false,
  quality: "adequate",
  observedAt: "2026-01-05T06:40:00.000Z",
  availableAt: "2026-01-05T06:45:00.000Z",
  evidenceLocalDate: "2026-01-05",
  availabilitySource: "canonical_computation",
  ...overrides
});

const readinessSignals = () => ({
  sleep: readinessSignal("sleep"),
  hrv: readinessSignal("hrv", { value: 62, baseline: 70, ratio: 0.8857 }),
  rhr: readinessSignal("rhr", { value: 48, baseline: 46, ratio: 1.0435 })
});

const readinessPayload = (overrides: Record<string, unknown> = {}) => ({
  lineage: { baselineEpochId: "epoch-r" },
  modelVersion: "rai-readiness-v1.0.0",
  asOf: "2026-01-05T07:00:00.000Z",
  localDate: "2026-01-05",
  coverage: "complete",
  assessment: "no_low_signal",
  state: "no_low_signal",
  stateEvidence: {
    method: "heuristic_rules",
    validationStatus: "not_empirically_validated",
    ruleSetVersion: "rai-readiness-ruleset-v1",
    validationTarget: null,
    validationReportId: null
  },
  intendedUse: "training_guidance_not_diagnosis",
  score: null,
  scoreStatus: "not_calibrated",
  signals: readinessSignals(),
  sleepStreak: false,
  reasonCodes: ["no_low_signal"],
  ...overrides
});

/** 删键（而不是置 `undefined`）：要测的是"产出端根本没写过这个字段"。 */
const withoutKey = (payload: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...payload };
  delete copy[key];
  return copy;
};

test("fitness narrowing reads the sealed V2 shape and the legacy shape without inventing a lineage", () => {
  const v2 = readFitnessSnapshot(fitnessPayload(
    [{ local_date: "2026-01-01", true_ability: 55, snapshot_status: "active" }],
    { baselineEpochId: "epoch-a" }
  ));
  assert.deepEqual(v2, {
    baselineEpochId: "epoch-a",
    daily: [{ localDate: "2026-01-01", trueAbility: 55, status: "active" }]
  });
  // legacy 分支写的是 {assessments, daily}，**没有** lineage ⇒ epoch 是未知，不是"与当前相同"。
  const legacy = readFitnessSnapshot(fitnessPayload(
    [{ local_date: "2026-01-02", true_ability: null, snapshot_status: "no_data" }]
  ));
  assert.deepEqual(legacy, {
    baselineEpochId: null,
    daily: [{ localDate: "2026-01-02", trueAbility: null, status: "no_data" }]
  });
});

test("fitness narrowing refuses a load payload instead of reading days as daily", () => {
  // 这是本层存在的理由：`load` 域存 `{lineage, days}`。若消费方把字段名当通用，
  // 就会把负荷日次当成能力日次画出来，而且不会报错。
  assert.equal(readFitnessSnapshot(loadPayload([{ local_date: "2026-01-01" }])), null);
  assert.equal(readLoadSnapshot(fitnessPayload([{ local_date: "2026-01-01" }])), null);
});

test("narrowing skips rows without the required key and returns null when none survive", () => {
  const partial = readFitnessSnapshot(fitnessPayload([
    { true_ability: 50, snapshot_status: "active" },
    { local_date: "2026-01-03", true_ability: 52, snapshot_status: "active" }
  ]));
  assert.deepEqual(partial?.daily, [{ localDate: "2026-01-03", trueAbility: 52, status: "active" }]);
  assert.equal(readFitnessSnapshot(fitnessPayload([{ true_ability: 50 }])), null);
  assert.equal(readFitnessSnapshot(fitnessPayload([])), null);
  assert.equal(readFitnessSnapshot(undefined), null);
  assert.equal(readFitnessSnapshot("not-an-object"), null);
});

test("non-finite ability becomes null rather than NaN reaching the chart", () => {
  const view = readFitnessSnapshot(fitnessPayload([
    { local_date: "2026-01-04", true_ability: Number.NaN, snapshot_status: "active" },
    { local_date: "2026-01-05", true_ability: Number.POSITIVE_INFINITY, snapshot_status: "active" }
  ]));
  // NaN 一旦漏到图表/JSON 里会变成 null 或静默传播，所以在这里就归一到 null。
  assert.deepEqual(view?.daily.map((row) => row.trueAbility), [null, null]);
});

test("load narrowing exposes the day rows and their epoch", () => {
  const view = readLoadSnapshot(loadPayload(
    [{ local_date: "2026-01-01", training_load: 42 }],
    { baselineEpochId: "epoch-a" }
  ));
  assert.equal(view?.baselineEpochId, "epoch-a");
  assert.deepEqual(view?.days, [{ local_date: "2026-01-01", training_load: 42 }]);
  assert.equal(readLoadSnapshot(loadPayload([])), null);
});

test("readiness narrowing round-trips the sealed V2 payload", () => {
  const view = readReadinessSnapshot(readinessPayload());
  assert.notEqual(view, null);
  assert.equal(view?.baselineEpochId, "epoch-r");
  assert.equal(view?.asOf, "2026-01-05T07:00:00.000Z");
  assert.equal(view?.localDate, "2026-01-05");
  assert.equal(view?.coverage, "complete");
  assert.equal(view?.assessment, "no_low_signal");
  assert.equal(view?.state, "no_low_signal");
  assert.deepEqual(view?.stateEvidence, readinessPayload().stateEvidence);
  assert.equal(view?.score, null);
  assert.equal(view?.scoreStatus, "not_calibrated");
  assert.deepEqual(view?.signals, readinessSignals());
  // 解释层需要的两个字段：`sleepStreak` 是规则自身的结论（读端不重算），`reasonCodes`
  // 是 §13.3 里"只格式化、不重跑阈值分支"的输入。
  assert.equal(view?.sleepStreak, false);
  assert.deepEqual(view?.reasonCodes, ["no_low_signal"]);
  // 顶层 freshness：产出端写在各信号上，所以这里只能是 `null`。
  // 拿 `asOf` 兜底会把"到达时间未知"读成"刚刚才拿到"。
  assert.equal(view?.availableAt, null);
  assert.equal(view?.observedAt, null);
  assert.equal(view?.evidenceLocalDate, null);
});

test("readiness narrowing carries top-level freshness only when the payload really wrote it", () => {
  const view = readReadinessSnapshot(readinessPayload({
    availableAt: "2026-01-05T06:50:00.000Z",
    observedAt: "2026-01-05T06:40:00.000Z",
    evidenceLocalDate: "2026-01-04"
  }));
  assert.equal(view?.availableAt, "2026-01-05T06:50:00.000Z");
  assert.equal(view?.observedAt, "2026-01-05T06:40:00.000Z");
  assert.equal(view?.evidenceLocalDate, "2026-01-04");
  // 非字符串 = 读不出来 ⇒ `null`，不替产出端编一个时间。
  assert.equal(readReadinessSnapshot(readinessPayload({ availableAt: 17_364_000_000 }))?.availableAt, null);
});

test("readiness narrowing refuses fitness and load payloads instead of reading a state out of them", () => {
  // 与 fitness/load 那两条同源：字段名不是通用的。
  // 这里不需要特例 —— 它们拿不出 `state` / `stateEvidence` / `signals`，自然就是 `null`。
  assert.equal(readReadinessSnapshot(fitnessPayload(
    [{ local_date: "2026-01-05", true_ability: 55, snapshot_status: "active" }]
  )), null);
  assert.equal(readReadinessSnapshot(loadPayload([{ local_date: "2026-01-05", training_load: 42 }])), null);
  assert.equal(readReadinessSnapshot(undefined), null);
  assert.equal(readReadinessSnapshot("not-an-object"), null);
  assert.equal(readReadinessSnapshot([]), null);
});

test("readiness narrowing returns null when the §7.4 validation label is missing", () => {
  // 这条守的是 §7.4：启发式/验证标签必须随数字到达每个消费方。
  // "缺了就默认成 not_empirically_validated"看着无害，但那是**读端发明**一个标签：
  // 它把一个不是 readiness 快照的 payload 变成了一份带健康结论的快照。
  assert.equal(readReadinessSnapshot(withoutKey(readinessPayload(), "stateEvidence")), null);
  assert.equal(readReadinessSnapshot(readinessPayload({
    stateEvidence: { ...readinessPayload().stateEvidence, method: "validated_thresholds" }
  })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({
    stateEvidence: { ...readinessPayload().stateEvidence, validationStatus: "probably_fine" }
  })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({
    stateEvidence: { ...readinessPayload().stateEvidence, ruleSetVersion: "" }
  })), null);
  // 标签在，就必须原样带出来（包括"已验证"与目标/报告 ID）。
  const labelled = readReadinessSnapshot(readinessPayload({
    stateEvidence: {
      method: "heuristic_rules",
      validationStatus: "validated_for_declared_target",
      ruleSetVersion: "rai-readiness-ruleset-v2",
      validationTarget: "holdout-2026-09",
      validationReportId: "report-7"
    }
  }));
  assert.deepEqual(labelled?.stateEvidence, {
    method: "heuristic_rules",
    validationStatus: "validated_for_declared_target",
    ruleSetVersion: "rai-readiness-ruleset-v2",
    validationTarget: "holdout-2026-09",
    validationReportId: "report-7"
  });
});

test("readiness narrowing returns null for a state outside the declared union, never a fallback state", () => {
  // 兜底成 `not_assessed` 会把"payload 不是 readiness 快照"翻译成一句"今天没评估"的陈述。
  assert.equal(readReadinessSnapshot(readinessPayload({ state: "fully_recovered" })), null);
  assert.equal(readReadinessSnapshot(withoutKey(readinessPayload(), "state")), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ coverage: "mostly" })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ assessment: "low_signals" })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ scoreStatus: "calibrated" })), null);
});

test("readiness narrowing refuses a payload missing one of the three signal channels", () => {
  // 少一个通道不是"更小的 readiness 快照"，而是不可比的另一份：
  // 静默丢通道正是"未知被读成正常"。
  assert.equal(readReadinessSnapshot(readinessPayload({
    signals: withoutKey(readinessSignals(), "hrv")
  })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ signals: {} })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ signals: null })), null);
  assert.equal(readReadinessSnapshot(withoutKey(readinessPayload(), "signals")), null);
});

test("readiness narrowing validates each signal channel instead of trusting its shape", () => {
  // `name` 与键不一致 ⇒ `signals.sleep` 会拿到另一条通道，且不会报错。
  assert.equal(readReadinessSnapshot(readinessPayload({
    signals: { ...readinessSignals(), sleep: readinessSignal("hrv") }
  })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({
    signals: { ...readinessSignals(), sleep: readinessSignal("sleep", { quality: "good" }) }
  })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({
    signals: { ...readinessSignals(), sleep: readinessSignal("sleep", { low: "false" }) }
  })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({
    signals: { ...readinessSignals(), sleep: readinessSignal("sleep", { value: Number.NaN }) }
  })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({
    signals: { ...readinessSignals(), sleep: readinessSignal("sleep", { ratio: Number.POSITIVE_INFINITY }) }
  })), null);
  // `value: null` 是"没测到"，是契约里的合法值 —— 不能和"字段畸形"混为一谈。
  const notMeasured = readReadinessSnapshot(readinessPayload({
    signals: { ...readinessSignals(), sleep: readinessSignal("sleep", { value: null, ratio: null, quality: "missing" }) }
  }));
  assert.notEqual(notMeasured, null);
  assert.equal(notMeasured?.signals.sleep.value, null);
  assert.equal(notMeasured?.signals.sleep.quality, "missing");
});

test("readiness narrowing returns null when score is not finite rather than coercing it to 0", () => {
  // `NaN` 一旦被读成"没有值"或 `0`，就会变成一个看起来正常的分数。
  assert.equal(readReadinessSnapshot(readinessPayload({ score: Number.NaN })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ score: Number.POSITIVE_INFINITY })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ score: "72" })), null);
  // 缺 `score` 键 ≠ `score: null`：前者是畸形 payload，后者是契约定义的"未标定"。
  assert.equal(readReadinessSnapshot(withoutKey(readinessPayload(), "score")), null);
});

test("a null score with not_calibrated status is a valid readiness snapshot", () => {
  // 未标定是契约定义的状态（第一版由 `state` 驱动 Coach），不是畸形 payload。
  const view = readReadinessSnapshot(readinessPayload({ score: null, scoreStatus: "not_calibrated" }));
  assert.notEqual(view, null);
  assert.equal(view?.score, null);
  assert.equal(view?.scoreStatus, "not_calibrated");
  // 已标定的分数同样透传，读端不做任何换算。
  const calibrated = readReadinessSnapshot(readinessPayload({ score: 72, scoreStatus: "available" }));
  assert.equal(calibrated?.score, 72);
  assert.equal(calibrated?.scoreStatus, "available");
});

test("readiness narrowing keeps the streak flag and reason codes faithful to the rules", () => {
  // 缺 `sleepStreak` / `reasonCodes` 是畸形 payload：补一个 `false` 或空数组，
  // 就是把"这份快照没说"读成"规则说了没有"。
  assert.equal(readReadinessSnapshot(withoutKey(readinessPayload(), "sleepStreak")), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ sleepStreak: "false" })), null);
  assert.equal(readReadinessSnapshot(withoutKey(readinessPayload(), "reasonCodes")), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ reasonCodes: null })), null);
  // 空理由码是合法的"确实没有可说的理由"，与"字段缺席"不是同一件事。
  assert.deepEqual(readReadinessSnapshot(readinessPayload({ reasonCodes: [] }))?.reasonCodes, []);
  // 元素必须是非空字符串：否则解释层会去翻译一个不存在的 code。
  assert.equal(readReadinessSnapshot(readinessPayload({ reasonCodes: [""] })), null);
  assert.equal(readReadinessSnapshot(readinessPayload({ reasonCodes: [7] })), null);
  assert.deepEqual(
    readReadinessSnapshot(readinessPayload({
      sleepStreak: true,
      reasonCodes: ["sleep_streak_below_baseline", "hrv_unavailable_at_assessment"]
    }))?.reasonCodes,
    ["sleep_streak_below_baseline", "hrv_unavailable_at_assessment"]
  );
});
