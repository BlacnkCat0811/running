import type { FeatureConfig } from "./index.js";

/**
 * §6.9 / §16.1 F08：正向异常门控的**检测器**（只报告，不门控）。
 *
 * 方案要求"正向也要检验 GPS 速度尖峰、设备切换、下坡和比赛异常，避免只防下降不防虚高"，
 * 同时 §17.3 把"正向异常门控"列为待回放政策。两份要求合起来意味着：
 * **先把检测器和解剖学做出来并报告，再决定它是否成为门控** —— 不是直接上线一个阈值。
 *
 * 所以这个模块刻意只产出一个诊断结果，不参与任何学习决策。
 *
 * ## 阈值从哪来
 *
 * 它**没有引入新的数字**：判定上限直接取自既有的准入常量
 * `FeatureConfig.minimumPaceMinutesPerKilometer`（默认 2.5 min/km）。
 * 那条规则本来就说"一次训练的**平均**配速不得快于 2.5 min/km"，即 6.667 m/s。
 * 一个**样本**快过系统已经认定不可信的平均配速，是这条既有边界的自然外推 ——
 * 而不是我另挑的一个"看起来合理"的数。
 *
 * ## 为什么单样本超标不足以定罪
 *
 * 冲刺、下坡、GPS 漂移都会产生单点高速。所以这里只回答"**存在**越界样本"，
 * 并把位置、时长和来源一起交出去；是否构成"尖峰"需要 §17.3 的回放来定，
 * 不该由这个函数偷偷决定。
 */

export interface SpeedPlausibilitySample {
  /** 已归一化为 m/s。调用方负责单位换算（见 `convertSpeedToMetersPerSecond`）。 */
  speedMetersPerSecond: number;
  startOffsetSeconds: number;
  durationSeconds: number;
  source: string | null;
}

export interface SpeedExceedance {
  startOffsetSeconds: number;
  durationSeconds: number;
  speedMetersPerSecond: number;
  source: string | null;
}

export interface SpeedPlausibilityReport {
  /** 判定上限（m/s），由既有准入常量导出，不是新参数。 */
  ceilingMetersPerSecond: number;
  /** 参与判定的样本数（非有限值与非正值已在入口剔除）。 */
  assessedSampleCount: number;
  /**
   * 超限样本数。**这是唯一需要回放才能解释的量**：0 表示本训练没有伪 GPS 迹象，
   * 大于 0 只说明"存在越界样本"，不直接等于"这次训练不可用"。
   */
  exceedanceCount: number;
  exceedances: SpeedExceedance[];
  reasonCodes: string[];
}

/**
 * @param samples 已归一化为 m/s 的速度样本
 * @param config  取 `minimumPaceMinutesPerKilometer` 作为上限
 */
export function detectImplausibleSpeedSamples(
  samples: readonly SpeedPlausibilitySample[],
  config: Pick<FeatureConfig, "minimumPaceMinutesPerKilometer">
): SpeedPlausibilityReport {
  const fastestPace = config.minimumPaceMinutesPerKilometer;
  if (!Number.isFinite(fastestPace) || fastestPace <= 0) {
    // 配置坏掉时不能说"没有异常" —— 那是把未知读成健康（§2.3-3）。
    return {
      ceilingMetersPerSecond: Number.NaN,
      assessedSampleCount: 0,
      exceedanceCount: 0,
      exceedances: [],
      reasonCodes: ["speed_ceiling_config_invalid"]
    };
  }
  const ceilingMetersPerSecond = 1000 / (fastestPace * 60);

  const reasonCodes = new Set<string>();
  const exceedances: SpeedExceedance[] = [];
  let assessedSampleCount = 0;
  for (const sample of samples) {
    const speed = sample.speedMetersPerSecond;
    // 非有限值与非正值不是"慢"，是坏数据；剔除并单独记账，不混进分布。
    if (!Number.isFinite(speed) || speed <= 0) {
      reasonCodes.add("speed_sample_not_positive_finite");
      continue;
    }
    if (!Number.isFinite(sample.startOffsetSeconds) || !Number.isFinite(sample.durationSeconds)) {
      reasonCodes.add("speed_sample_timing_invalid");
      continue;
    }
    assessedSampleCount += 1;
    if (speed > ceilingMetersPerSecond) {
      exceedances.push({
        startOffsetSeconds: sample.startOffsetSeconds,
        durationSeconds: sample.durationSeconds,
        speedMetersPerSecond: speed,
        source: sample.source
      });
    }
  }
  if (exceedances.length > 0) reasonCodes.add("speed_above_admissible_pace_ceiling");
  return {
    ceilingMetersPerSecond,
    assessedSampleCount,
    exceedanceCount: exceedances.length,
    exceedances,
    reasonCodes: [...reasonCodes].sort()
  };
}

/**
 * §6.9 的"设备切换"一项：速度样本的来源不止一个时，单点高速更可能是换设备而非能力突变。
 * 只报告事实，不推断原因。
 *
 * ⚠️ **实测警告（2026-09-30）**：`source` 串**不是稳定的设备身份**。本库同一块表出现在
 * 4 种编码变体下（`唐攀的Apple Watch` / `唐��的Apple Watch` / …），这个函数会把
 * "一块表"报成"多个来源"。所以它的输出**不能**直接当作"设备切换"证据 ——
 * 那需要先做 source 身份归一化，否则该信号会在编码假象上持续误报。
 */
export function speedSourceBreakdown(
  samples: readonly SpeedPlausibilitySample[]
): Array<{ source: string | null; sampleCount: number }> {
  const counts = new Map<string | null, number>();
  for (const sample of samples) {
    const key = sample.source ?? null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, sampleCount]) => ({ source, sampleCount }))
    .sort((left, right) => {
      if (right.sampleCount !== left.sampleCount) return right.sampleCount - left.sampleCount;
      // 同数量时把"来源未知"排在最后：未知不是一个可以参加排序的值（§2.3-3）。
      if (left.source === null) return 1;
      if (right.source === null) return -1;
      return left.source.localeCompare(right.source);
    });
}
