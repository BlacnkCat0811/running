import { assessDatedReadiness, type DatedRecoverySignal } from "@rai/readiness";
import { replayModelPair } from "@rai/model-eval";
import {
  READINESS_RULE_SET_VERSION,
  canonicalSemanticJson,
  type ReadinessAssessmentResult,
  type ReplayDescriptorV2
} from "@rai/contracts";

/**
 * 一天的全部恢复证据。每个信号都必须自带 `observedAt` / `availableAt`，否则无法做 as_known_then。
 * 三个键显式写出（而不是 `Record<...>`）以便索引访问留在类型里、不被 `noUncheckedIndexedAccess` 变成可空。
 */
export interface ReadinessReplayFacts {
  localDate: string;
  signals: {
    sleep: DatedRecoverySignal;
    hrv: DatedRecoverySignal;
    rhr: DatedRecoverySignal;
  };
  nights: DatedRecoverySignal[];
}

/**
 * 「假设事实在发生的那一刻就已到达」的反事实信号：把 `availableAt` **一律**改写成 `observedAt`。
 *
 * 不能只在"到达时间缺失"时才改写 —— 那样"到达得比 asOf 晚"的信号在反事实支里仍然迟到，
 * 两支会退化成同一个东西（这个 bug 我第一版就写错了，靠测试里"两支必须不同"的断言抓到）。
 */
function assumeInstantArrival(signal: DatedRecoverySignal): DatedRecoverySignal {
  return signal.observedAt === null ? signal : { ...signal, availableAt: signal.observedAt };
}

const reasonCodesOf = (result: ReadinessAssessmentResult): string[] =>
  [...result.reasonCodes].sort();

/**
 * 只看**裁决**，不看回显的元数据。
 *
 * 为什么需要这一层：反事实支必然改写 `availableAt`，而结果会把到达时间**原样回显**到
 * `signals[*].availableAt`/`observedAt`/`evidenceLocalDate`。于是整份输出的语义 JSON
 * **永远**不可能相等（`semanticEqual` 恒为 false），把两支的差别淹没在元数据里。
 * 真正该问的是"**裁决变了吗**"，所以这里显式投影出裁决字段。
 */
function rulingOf(result: ReadinessAssessmentResult) {
  const signal = (name: "sleep" | "hrv" | "rhr") => {
    const s = result.signals[name];
    return { value: s.value, ratio: s.ratio, low: s.low, quality: s.quality };
  };
  return {
    coverage: result.coverage,
    assessment: result.assessment,
    state: result.state,
    reasonCodes: reasonCodesOf(result),
    signals: { sleep: signal("sleep"), hrv: signal("hrv"), rhr: signal("rhr") }
  };
}

/**
 * Readiness 的跨策略回放。
 *
 * **两个分支调用的是同一个生产函数 `assessDatedReadiness`**，唯一差别是"到达时间假设"：
 *  - `observation_only_counterfactual`：把缺失的到达时间当成"= 观测时间"（等价于只看观测时间）；
 *  - `rai-readiness-ruleset-v1`：按**真实**到达时间判定（`availableAt === null` 即不可用）。
 *
 * 所以两者之差 = **"用观测时间当可用性"会改变多少天的裁决**，也就是 §7.3 的泄漏量本身。
 * 这一支刻意是**反事实**而不是"某个历史版本"—— 它不冒充上线过的规则集，名字里就写着 counterfactual。
 *
 * 不在本函数里写任何阈值或规则：规则全部来自被调用的生产函数，改规则不会让这里静默分叉。
 */
export function replayReadinessRulings(input: {
  descriptor: ReplayDescriptorV2;
  facts: ReadinessReplayFacts;
}) {
  const run = (facts: ReadinessReplayFacts, assumeArrival: boolean): ReadinessAssessmentResult =>
    assessDatedReadiness({
      asOf: input.descriptor.asOf,
      localDate: facts.localDate,
      signals: assumeArrival
        ? {
          sleep: assumeInstantArrival(facts.signals.sleep),
          hrv: assumeInstantArrival(facts.signals.hrv),
          rhr: assumeInstantArrival(facts.signals.rhr)
        }
        : facts.signals,
      nights: assumeArrival ? facts.nights.map(assumeInstantArrival) : facts.nights
    });

  const pair = replayModelPair(
    input.facts,
    input.descriptor,
    { version: "observation_only_counterfactual", run: (facts) => run(facts, true) },
    { version: READINESS_RULE_SET_VERSION, run: (facts) => run(facts, false) }
  );

  const loose = reasonCodesOf(pair.base.output);
  const strict = reasonCodesOf(pair.candidate.output);
  return {
    version: "rai-readiness-replay-v1" as const,
    ...pair,
    /**
     * **裁决**（`coverage`/`assessment`/`state`/`reasonCodes`/逐信号值）是否相同。
     * 这才是"到达时间口径有没有改变判定"的答案 —— `semanticEqual` 会被回显的时间戳弄成恒 false。
     */
    rulingEqual: canonicalRuling(pair.base.output) === canonicalRuling(pair.candidate.output),
    /**
     * 只有"严格支"才有的理由码 —— 每一码都代表一个信号的裁决因到达时间而改变。
     * 这是**报告出来的量**，不是裁决：本函数不决定该不该采信哪一支。
     */
    arrivalSensitiveReasonCodes: strict.filter((code) => !loose.includes(code)),
    accuracyStatus: "not_evaluable" as const,
    note:
      "两条分支共用同一个生产函数，只差到达时间假设；差值衡量的是可用性口径的影响，不是模型精度。"
  };
}

const canonicalRuling = (result: ReadinessAssessmentResult): string =>
  canonicalSemanticJson(rulingOf(result));
