import { buildDailyTrainingMetricsV2, type DailyPhysEvidence } from "@rai/training-load";
import { replayModelPair } from "@rai/model-eval";
import {
  TRAINING_LOAD_CONFIG_VERSION,
  canonicalSemanticJson,
  type ReplayDescriptorV2,
  type WorkoutTrainingLoad
} from "@rai/contracts";

/**
 * §15.3 / D10 —— Load 域的跨策略回放，结构与 `readiness-replay-v2.ts` 同源：
 * **两条分支调用同一个生产函数**（`buildDailyTrainingMetricsV2`），只差"到达时间假设"。
 *
 * 为什么这一对分支对 Load 是成立的（而不是硬凑的对照）：
 * 负荷序列是**滚动**的 —— 一条迟到导入的训练会改写它之后每一天的 ATL/CTL/ACWR。
 * "把观测时间当可用性"与"按真实到达时间判定"之差，正是"历史回放时我们其实还不知道"的量，
 * 也就是 §15.3 要求区分 `event_time_reconstruction` 与 `as_known_then` 的理由本身。
 *
 * 本文件不写任何阈值、不重写风险分类：所有判定都来自被调用的生产函数。
 */

export interface LoadReplayFact {
  load: WorkoutTrainingLoad;
  /** 观测时间（训练结束时刻）。反事实支把它直接当作到达时间。 */
  observedAt: string;
  /** 系统真正拿到这条记录的时间。`null` = 未知，**不是**"已经到达"。 */
  availableAt: string | null;
}

export interface LoadReplayFacts {
  /** 被对照的那一天。 */
  localDate: string;
  /** 序列截止日。 */
  throughDate: string;
  facts: LoadReplayFact[];
  physEvidence: DailyPhysEvidence[];
}

interface LoadReplayOutput {
  localDate: string;
  includedFactCount: number;
  excludedFactCount: number;
  /** 该日在序列里不存在（例如全部事实都被排除）时为 `null`。 */
  day: {
    trainingStatus: string;
    explanationCodes: string[];
    loadRatio: number | null;
    chronicEwma: number;
    strain: number | null;
  } | null;
}

/**
 * 只看**裁决**，不看被回显的元数据。到达时间的差别会原样出现在输入与统计口径上，
 * 若直接比较整份输出，`semanticEqual` 会变成"永远不相等"，把真正的差别淹掉。
 */
function rulingOf(output: LoadReplayOutput) {
  return {
    assessesTargetDay: output.day !== null,
    trainingStatus: output.day?.trainingStatus ?? null,
    explanationCodes: output.day?.explanationCodes ?? [],
    loadRatio: output.day?.loadRatio ?? null,
    chronicEwma: output.day?.chronicEwma ?? null
  };
}

export function replayLoadRulings(input: {
  descriptor: ReplayDescriptorV2;
  facts: LoadReplayFacts;
}) {
  const asOf = Date.parse(input.descriptor.asOf);
  const run = (facts: LoadReplayFacts, arrivalEqualsObservation: boolean): LoadReplayOutput => {
    const included = facts.facts.filter((fact) =>
      arrivalEqualsObservation
        ? Date.parse(fact.observedAt) <= asOf
        : fact.availableAt !== null && Date.parse(fact.availableAt) <= asOf
    );
    const days = buildDailyTrainingMetricsV2(
      included.map((fact) => fact.load),
      facts.throughDate,
      facts.physEvidence
    );
    const day = days.find((row) => row.localDate === facts.localDate);
    return {
      localDate: facts.localDate,
      includedFactCount: included.length,
      excludedFactCount: facts.facts.length - included.length,
      day: day === undefined ? null : {
        trainingStatus: day.trainingStatus,
        explanationCodes: [...day.statusExplanations.map((explanation) => explanation.code)].sort(),
        loadRatio: day.loadRatio,
        chronicEwma: day.chronicEwma,
        strain: day.strain
      }
    };
  };

  const pair = replayModelPair(
    input.facts,
    input.descriptor,
    { version: "observation_time_arrival_counterfactual", run: (facts) => run(facts, true) },
    { version: TRAINING_LOAD_CONFIG_VERSION, run: (facts) => run(facts, false) }
  );

  const loose = rulingOf(pair.base.output);
  const strict = rulingOf(pair.candidate.output);
  return {
    version: "rai-load-replay-v1" as const,
    ...pair,
    /** 到达时间口径是否改变了这一天的负荷裁决。 */
    rulingEqual: canonicalSemanticJson(loose) === canonicalSemanticJson(strict),
    /**
     * 只有"按真实到达时间"那一支才出现的解释码。每一个码都代表一个裁决
     * 是因为"当时其实还没拿到这条记录"而不同的。
     */
    arrivalSensitiveExplanationCodes: strict.explanationCodes.filter(
      (code) => !loose.explanationCodes.includes(code)
    ),
    /** 本函数衡量的是**可用性口径**的影响，不是负荷模型的精度。 */
    accuracyStatus: "not_evaluable" as const,
    note:
      "两条分支共用同一个生产负荷函数，只差到达时间假设；差值衡量的是可用性口径的影响，不是模型精度。"
  };
}
