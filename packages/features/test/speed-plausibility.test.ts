import assert from "node:assert/strict";
import test from "node:test";

import { defaultFeatureConfig } from "../src/index.js";
import {
  detectImplausibleSpeedSamples,
  speedSourceBreakdown,
  type SpeedPlausibilitySample
} from "../src/speed-plausibility.js";

/**
 * §16.1 **F08**：快速下坡/速度尖峰**不产生未经质量门控的正向 TA 跳升**。
 *
 * 这批用例覆盖的是"检测器"，不是"门控"。方案 §6.9 要求正向也要检验伪 GPS，
 * §17.3 把"正向异常门控"列为**待回放**政策，所以这里只把解剖学做出来并报告，
 * 不把它接进任何学习决策 —— 用例本身也断言了这一点（它没有任何 TA 参数）。
 *
 * 阈值出处：判定上限由既有准入常量 `minimumPaceMinutesPerKilometer`（2.5 min/km）
 * 导出，不引入新数字。
 */

const ceiling = 1000 / (defaultFeatureConfig.minimumPaceMinutesPerKilometer * 60); // 6.6667 m/s

const sample = (
  speedMetersPerSecond: number,
  startOffsetSeconds = 0,
  durationSeconds = 1,
  source: string | null = "watch"
): SpeedPlausibilitySample => ({ speedMetersPerSecond, startOffsetSeconds, durationSeconds, source });

test("F08: the ceiling is derived from the existing admission constant, not a new parameter", () => {
  const report = detectImplausibleSpeedSamples([], defaultFeatureConfig);
  assert.ok(Math.abs(report.ceilingMetersPerSecond - ceiling) < 1e-9);
  assert.equal(report.exceedanceCount, 0);
  assert.deepEqual(report.reasonCodes, []);
});

test("F08: an ordinary run has no exceedance", () => {
  // 3.0–3.5 m/s 是常见的轻松跑到节奏跑。
  const report = detectImplausibleSpeedSamples(
    [sample(3.0), sample(3.3), sample(3.5), sample(2.8)],
    defaultFeatureConfig
  );
  assert.equal(report.assessedSampleCount, 4);
  assert.equal(report.exceedanceCount, 0);
  assert.deepEqual(report.reasonCodes, []);
});

test("F08: a single GPS spike above the admissible pace is reported with its position", () => {
  const report = detectImplausibleSpeedSamples(
    [sample(3.2), sample(3.4), sample(14.0, 600, 1), sample(3.3)],
    defaultFeatureConfig
  );
  assert.equal(report.assessedSampleCount, 4);
  assert.equal(report.exceedanceCount, 1);
  assert.deepEqual(report.reasonCodes, ["speed_above_admissible_pace_ceiling"]);
  const [exceedance] = report.exceedances;
  assert.equal(exceedance?.startOffsetSeconds, 600);
  assert.equal(exceedance?.speedMetersPerSecond, 14.0);
  assert.equal(exceedance?.source, "watch");
});

test("F08: the detector reports but never judges — a fast sprint is not called invalid", () => {
  // 5.0 m/s 是人类冲刺的合理值（3:20/km），仍低于 2.5 min/km 的平均配速边界。
  const sprint = detectImplausibleSpeedSamples([sample(5.0, 0, 8)], defaultFeatureConfig);
  assert.equal(sprint.exceedanceCount, 0, "a plausible sprint must not be flagged");
  // 越界样本只是被**列出**，结果里没有"不可用"这种判定字段。
  const flagged = detectImplausibleSpeedSamples([sample(9.0, 0, 2)], defaultFeatureConfig);
  assert.equal(flagged.exceedanceCount, 1);
  assert.deepEqual(Object.keys(flagged).sort(), [
    "assessedSampleCount", "ceilingMetersPerSecond", "exceedanceCount", "exceedances", "reasonCodes"
  ]);
});

test("F08: bad samples are excluded and accounted for, not treated as slow", () => {
  const report = detectImplausibleSpeedSamples(
    [sample(3.2), sample(0), sample(-1), sample(Number.NaN), sample(Number.POSITIVE_INFINITY), sample(3.4)],
    defaultFeatureConfig
  );
  // 只有 3.2 与 3.4 进入判定；坏数据既不进分布，也不算"慢"。
  assert.equal(report.assessedSampleCount, 2);
  assert.deepEqual(report.reasonCodes, ["speed_sample_not_positive_finite"]);
});

test("F08: invalid sample timing is separated from invalid speed", () => {
  const report = detectImplausibleSpeedSamples(
    [sample(3.2), sample(3.3, Number.NaN, 1), sample(3.4, 0, Number.NaN)],
    defaultFeatureConfig
  );
  assert.equal(report.assessedSampleCount, 1);
  assert.deepEqual(report.reasonCodes, ["speed_sample_timing_invalid"]);
});

test("F08: a broken config reports unknown instead of 'no anomaly'", () => {
  // 把未知读成健康是 §2.3-3 明令禁止的。
  for (const broken of [0, -1, Number.NaN]) {
    const report = detectImplausibleSpeedSamples([sample(3.2)], {
      minimumPaceMinutesPerKilometer: broken
    });
    assert.deepEqual(report.reasonCodes, ["speed_ceiling_config_invalid"], String(broken));
    assert.equal(report.exceedanceCount, 0);
    assert.ok(Number.isNaN(report.ceilingMetersPerSecond));
  }
});

test("F08: device switching is reported as a fact, not inferred as the cause", () => {
  const breakdown = speedSourceBreakdown([
    sample(3.0, 0, 1, "watch"),
    sample(3.1, 1, 1, "watch"),
    sample(13.0, 2, 1, "phone"),
    sample(3.2, 3, 1, null)
  ]);
  // 数量降序；数量相同时"来源未知"排最后 —— 未知不参加排序。
  assert.deepEqual(breakdown, [
    { source: "watch", sampleCount: 2 },
    { source: "phone", sampleCount: 1 },
    { source: null, sampleCount: 1 }
  ]);
  assert.equal(speedSourceBreakdown([]).length, 0);
});
