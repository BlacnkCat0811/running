import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPredictionCorrectionLedger,
  type PredictionCorrectionLedger,
  type PredictionCorrectionStep
} from "../src/index.js";

/**
 * §16.1 **P02**：相同历史环境进入两层时，ledger 阻止重复去偏差。
 *
 * 这批用例针对的是**账本本身的判据**，不是"N2 已经落地"。方案 §5.5 允许
 * "过去热天去偏差 + 未来热天加情景"（两个不同对象），禁止
 * "同一历史热惩罚被 adapter 与 performanceVdotEvidence 各去一次"。
 *
 * 关键在于：最危险的那种重复**不会**表现成两个步骤 —— 如果 adapter 把热惩罚
 * 折进 `potentialSeconds`（账本起点之前），链式重建照样成立。所以判据不能只有
 * "after−before 能重建"，还要有对象与身份（见 model-eval 里的规则说明）。
 */

const step = (over: Partial<PredictionCorrectionStep> = {}): PredictionCorrectionStep => ({
  kind: "environment",
  object: "target_scenario",
  ownerVersion: "rai-physiology-v1.8.0",
  inputHash: "scenario-hash-a",
  applied: true,
  beforeSeconds: 1200,
  afterSeconds: 1230,
  reasonCodes: ["hot_target_day"],
  ...over
});

const ledger = (over: Partial<PredictionCorrectionLedger> = {}): PredictionCorrectionLedger => ({
  distance: "half_marathon",
  potentialSeconds: 1200,
  predictedSeconds: 1230,
  steps: [step()],
  ...over
});

test("P02: a single legitimate environment correction passes", () => {
  assert.doesNotThrow(() => assertPredictionCorrectionLedger(ledger()));
});

test("P02: 过去热天去偏差 + 未来热天加情景 is allowed — they are different objects", () => {
  // 只有 target_scenario 那一步是 applied；历史那一步是说明性记录。
  assert.doesNotThrow(() => assertPredictionCorrectionLedger(ledger({
    steps: [
      step({ object: "historical_evidence", ownerVersion: "adapter", inputHash: "history-hash", applied: false,
        beforeSeconds: 1200, afterSeconds: 1200, reasonCodes: ["removed_upstream"] }),
      step()
    ]
  })));
});

test("P02: the same evidence de-biased by two owners is rejected", () => {
  assert.throws(
    () => assertPredictionCorrectionLedger(ledger({
      predictedSeconds: 1260,
      steps: [
        step({ ownerVersion: "adapter", beforeSeconds: 1200, afterSeconds: 1230 }),
        step({ ownerVersion: "rai-physiology-v1.8.0", beforeSeconds: 1230, afterSeconds: 1260 })
      ]
    })),
    /already applied by adapter, now again by rai-physiology-v1\.8\.0/
  );
});

test("P02: historical de-bias applied after potentialSeconds is the folded-in double count", () => {
  // 这是链式重建**抓不到**的那种：重建成立，但历史惩罚其实是第二次扣。
  assert.throws(
    () => assertPredictionCorrectionLedger(ledger({
      steps: [step({ object: "historical_evidence", ownerVersion: "adapter", reasonCodes: ["hot_history"] })]
    })),
    /de-biases historical evidence after potentialSeconds was formed/
  );
  // 同一步记为未应用，就只是说明，不构成重复。
  assert.doesNotThrow(() => assertPredictionCorrectionLedger(ledger({
    predictedSeconds: 1200,
    steps: [step({ object: "historical_evidence", applied: false, afterSeconds: 1200, reasonCodes: ["removed_upstream"] })]
  })));
});

test("P02: the chain must rebuild the published point prediction", () => {
  assert.throws(
    () => assertPredictionCorrectionLedger(ledger({ predictedSeconds: 1231 })),
    /applied steps rebuild 1230 but predictedSeconds is 1231/
  );
  // 两个错误互相抵消也不行：每一步自身的边界必须有限。
  assert.throws(
    () => assertPredictionCorrectionLedger(ledger({
      steps: [step({ afterSeconds: Number.NaN })]
    })),
    /non-finite boundary/
  );
});

test("P02: an applied step that changes nothing must say why", () => {
  assert.throws(
    () => assertPredictionCorrectionLedger(ledger({
      predictedSeconds: 1200,
      steps: [step({ afterSeconds: 1200, reasonCodes: [] })]
    })),
    /changes nothing and gives no reason/
  );
  // 有理由的零步是合法的：环境已中性、只是记录"确实无需修正"。
  assert.doesNotThrow(() => assertPredictionCorrectionLedger(ledger({
    predictedSeconds: 1200,
    steps: [step({ afterSeconds: 1200, reasonCodes: ["not_needed"] })]
  })));
});

test("P02: different objects with the same kind do not collide", () => {
  // 同样的 kind，但 inputHash 不同 ⇒ 是两份不同的证据，允许各自应用一次。
  assert.doesNotThrow(() => assertPredictionCorrectionLedger(ledger({
    predictedSeconds: 1260,
    steps: [
      step({ inputHash: "history-and-pace", beforeSeconds: 1200, afterSeconds: 1230 }),
      step({ inputHash: "target-day-weather", beforeSeconds: 1230, afterSeconds: 1260 })
    ]
  })));
});

test("P02: non-finite endpoints are refused before any arithmetic", () => {
  assert.throws(
    () => assertPredictionCorrectionLedger(ledger({ potentialSeconds: Number.POSITIVE_INFINITY })),
    /must be finite/
  );
});

/**
 * §16.1 **P04**：Preparation + Durability 使用同源信息时不重复扣罚。
 *
 * §8.2 把两者定义为**不同职责**（Preparation = 训练暴露；Durability = 长持续运动后
 * 表现是否维持），§8.5 D3 要求二者重复时"合并/替换对应项，而不是继续叠加 penalty"。
 * 判据因此是**证据身份**：durability 若声明与 preparation 相同的 inputHash，
 * 它就不是独立证据，而是把同一份暴露又罚了一次。
 */

const prepAndDurability = (
  durabilityInputHash: string,
  preparationInputHash = "exposure-56d"
): PredictionCorrectionLedger => ({
  distance: "half_marathon",
  potentialSeconds: 1200,
  predictedSeconds: 1185,
  steps: [
    {
      kind: "preparation", object: null, ownerVersion: "rai-durability-v1.0.0",
      inputHash: preparationInputHash, applied: true,
      beforeSeconds: 1200, afterSeconds: 1195, reasonCodes: ["preparation_prior"]
    },
    {
      kind: "durability", object: null, ownerVersion: "rai-durability-v1.0.0",
      inputHash: durabilityInputHash, applied: true,
      beforeSeconds: 1195, afterSeconds: 1185, reasonCodes: ["late_run_stability"]
    }
  ]
});

test("P04: durability may adjust on top of preparation when it brings independent evidence", () => {
  assert.doesNotThrow(() => assertPredictionCorrectionLedger(prepAndDurability("late-run-stability-8w")));
});

test("P04: durability re-using the preparation evidence is the same penalty twice", () => {
  assert.throws(
    () => assertPredictionCorrectionLedger(prepAndDurability("exposure-56d")),
    /consumes the same evidence as the preparation step/
  );
  // 报错必须点名两个 owner，否则读的人不知道该改哪一侧。
  assert.throws(
    () => assertPredictionCorrectionLedger(prepAndDurability("exposure-56d")),
    /rai-durability-v1\.0\.0/
  );
});

test("P04: only *applied* steps count — a recorded-but-unapplied durability step is harmless", () => {
  const steps = prepAndDurability("exposure-56d").steps.map((entry) =>
    entry.kind === "durability" ? { ...entry, applied: false, afterSeconds: entry.beforeSeconds } : entry
  );
  assert.doesNotThrow(() => assertPredictionCorrectionLedger({
    distance: "half_marathon", potentialSeconds: 1200, predictedSeconds: 1195, steps
  }));
});

test("P04: a durability step that declares no evidence identity cannot collide", () => {
  // inputHash=null 表示"不声明证据身份"。它不会与 preparation 撞车，
  // 但也因此**不受**规则 4 保护 —— 这是声明身份的价值所在。
  assert.doesNotThrow(() => assertPredictionCorrectionLedger(prepAndDurability(null as unknown as string)));
});

test("P04: two durability steps on the same evidence are still caught by rule 2", () => {
  const base = prepAndDurability("late-run-stability-8w");
  assert.throws(
    () => assertPredictionCorrectionLedger({
      ...base,
      predictedSeconds: 1175,
      steps: [...base.steps, {
        kind: "durability", object: null, ownerVersion: "second-owner",
        inputHash: "late-run-stability-8w", applied: true,
        beforeSeconds: 1185, afterSeconds: 1175, reasonCodes: ["duplicate"]
      }]
    }),
    /already applied by rai-durability-v1\.0\.0, now again by second-owner/
  );
});
