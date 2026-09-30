#!/usr/bin/env node
// §16.1 F08 的**检测率盘点**：报告，不猜测。
//
// 方案 §6.9 要求"正向也要检验 GPS 速度尖峰…避免只防下降不防虚高"，
// §17.3 把"正向异常门控"列为待回放政策。两份要求合起来给出的下一步不是"上线一个阈值"，
// 而是**先看看这份数据里到底有没有这类样本**。这个脚本就只做这件事，exit 0。
//
// 两个口径必须说清，否则数字会被读成它不支持的结论：
//
// 1. 数据源是 `health_records` 的 `HKQuantityTypeIdentifierRunningSpeed` ——
//    这正是 `RecomputePipeline` 喂给特征的时间线（`runningSpeedType`）。
//    因此这里的分布就是**管线输入**的分布，不是某个更远端的代理。
// 2. 判定上限**不是新参数**：它由既有准入常量
//    `FeatureConfig.minimumPaceMinutesPerKilometer`（2.5 min/km）导出。
//    那条规则本来就说"一次训练的平均配速不得快于 2.5 min/km"。
//
// 单位陷阱（第一版盘点就踩了）：`unit` 列**不唯一**，本库同时存在 `km/hr` 与 `m/s`。
// 混在一起排序会得出"7781/11835 个样本超限"这种惊人的假结论。
// 因此这里一律经 `convertSpeedToMetersPerSecond` 归一化，并**单独报告单位构成** ——
// 缺失单位会被那个函数默认成 km/hr，若某个来源其实用 m/s，它的值会被低估 3.6 倍。
//
// 用法：
//   node --import tsx scripts/speed-plausibility-inventory.mts [--database var/rai.sqlite] [--out <path>]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { convertSpeedToMetersPerSecond } from "@rai/application";
import { defaultFeatureConfig } from "@rai/features";
import { evaluationReportEnvelope } from "@rai/model-eval";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const readArg = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? fallback) : fallback;
};

const databasePath = resolve(root, readArg("--database", "var/rai.sqlite"));
// §15.8-1：产物必须能说出自己出自哪个提交。第一版这里写死了 null，
// 于是它成了五份 envelope 产物里唯一永远说不出 revision 的那一份（审计 2026-09-30 发现）。
// 取不到时返回 null 是"不知道"，与"从不记录"是两件事。
const repoRevision = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();
// `--out` 是可选的：不传就只打印，不写盘（与其它只读盘点脚本一致）。
const outIndex = argv.indexOf("--out");
const outPath = outIndex >= 0 ? (argv[outIndex + 1] ?? null) : null;
if (!existsSync(databasePath)) {
  process.stderr.write(`database not found: ${databasePath}\n`);
  process.exit(1);
}

const ceilingMetersPerSecond =
  1000 / (defaultFeatureConfig.minimumPaceMinutesPerKilometer * 60);

const database = new DatabaseSync(databasePath, { readOnly: true });
const rows = database
  .prepare(
    `SELECT value_numeric AS value, unit, source_name AS source, start_at AS startAt
     FROM health_records
     WHERE type = 'HKQuantityTypeIdentifierRunningSpeed' AND value_numeric IS NOT NULL`
  )
  .all();

const samples = [];
const unitCensus = new Map();
const missingUnit = { count: 0, sources: new Set() };
let rejectedNotPositiveFinite = 0;
for (const row of rows) {
  const rawValue = row.value;
  if (typeof rawValue !== "number") continue;
  const rawUnit = typeof row.unit === "string" ? row.unit : null;
  const unitKey = rawUnit === null || rawUnit.trim() === "" ? "(missing)" : rawUnit;
  unitCensus.set(unitKey, (unitCensus.get(unitKey) ?? 0) + 1);
  if (unitKey === "(missing)") {
    missingUnit.count += 1;
    missingUnit.sources.add(typeof row.source === "string" ? row.source : "(unknown)");
  }
  // 经管线的同一个换算函数归一化，不在这里自己写第二套单位逻辑。
  const metersPerSecond = convertSpeedToMetersPerSecond(rawValue, rawUnit);
  if (!Number.isFinite(metersPerSecond) || metersPerSecond <= 0) {
    rejectedNotPositiveFinite += 1;
    continue;
  }
  samples.push({
    metersPerSecond,
    source: typeof row.source === "string" ? row.source : null,
    startAt: typeof row.startAt === "string" ? row.startAt : null
  });
}

const sorted = samples.map((sample) => sample.metersPerSecond).sort((a, b) => a - b);
const quantile = (p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null);
const exceedances = samples.filter((sample) => sample.metersPerSecond > ceilingMetersPerSecond);

const bySource = new Map();
for (const sample of samples) {
  const key = sample.source ?? "(unknown)";
  const entry = bySource.get(key) ?? { source: key, sampleCount: 0, exceedanceCount: 0, maxMetersPerSecond: 0 };
  entry.sampleCount += 1;
  entry.maxMetersPerSecond = Math.max(entry.maxMetersPerSecond, sample.metersPerSecond);
  if (sample.metersPerSecond > ceilingMetersPerSecond) entry.exceedanceCount += 1;
  bySource.set(key, entry);
}

const report = {
  ...evaluationReportEnvelope({
    generatedBy: "scripts/speed-plausibility-inventory.mts",
    databasePath: databasePath.replace(root, "."),
    repoRevision,
    reproduceCommand:
      "node --import tsx scripts/speed-plausibility-inventory.mts --database var/rai.sqlite --out deliverables/SPEED_PLAUSIBILITY_INVENTORY.json",
    accuracyStatus: "not_evaluable",
    accuracyReason:
      "这是检测率盘点，不是门控效果的验收：检出率只能说明这类样本多不多，不能说明门控是否改善了能力学习。",
    gates: [
      {
        name: "detector_ceiling_is_derived_not_invented",
        // 上限必须恰好等于既有准入常量导出的值，防止有人后来偷偷调它。
        status: Math.abs(ceilingMetersPerSecond - 1000 / (2.5 * 60)) < 1e-9 ? "passed" : "failed",
        reason: null
      },
      {
        name: "positive_anomaly_gate",
        status: "not_evaluable",
        reason: "§17.3 把正向异常门控列为待回放政策；本脚本只盘点，不接线"
      }
    ],
    notEvaluable: [
      { item: "gate_effect_on_learning", reason: "门控未接线，无法评估它对正负接受率的影响" },
      ...(unitCensus.has("(missing)")
        ? [{
            item: "missing_unit_samples",
            reason: `${missingUnit.count} 个样本没有 unit；convertSpeedToMetersPerSecond 会默认按 km/hr 解释，若来源其实用 m/s 则被低估 3.6 倍`
          }]
        : [])
    ]
  }),
  sourceType: "HKQuantityTypeIdentifierRunningSpeed",
  sourceNote:
    "与 RecomputePipeline 的 runningSpeedType 同一张表同一类型，因此这是管线输入的分布，不是远端代理。",
  ceiling: {
    metersPerSecond: ceilingMetersPerSecond,
    derivedFrom: "FeatureConfig.minimumPaceMinutesPerKilometer",
    configuredValue: defaultFeatureConfig.minimumPaceMinutesPerKilometer,
    note: "既有准入常量：一次训练的平均配速不得快于此值。样本级判定是它的自然外推。"
  },
  unitCensus: Object.fromEntries([...unitCensus.entries()].sort((a, b) => b[1] - a[1])),
  missingUnit: { sampleCount: missingUnit.count, sources: [...missingUnit.sources] },
  // 坏数据单独记账，不混进分布，也不读成"慢"。
  rejectedNotPositiveFinite,
  sampleCount: samples.length,
  distributionMetersPerSecond: {
    min: sorted[0] ?? null,
    p50: quantile(0.5),
    p90: quantile(0.9),
    p99: quantile(0.99),
    p999: quantile(0.999),
    max: sorted.at(-1) ?? null
  },
  exceedanceCount: exceedances.length,
  exceedanceRate: samples.length === 0 ? null : exceedances.length / samples.length,
  exceedances: exceedances.slice(0, 20),
  bySource: [...bySource.values()].sort((a, b) => b.sampleCount - a.sampleCount),
  // 实测第二发现：同一块表在这份库里以 **4 种拼写**出现（编码坏损），
  // 于是 `speedSourceBreakdown` 会把"一块表"报成"多个来源"。
  // §6.9 把"设备切换"列为正向异常信号 —— 若直接拿原始 source 串当设备身份，
  // 那个信号会在这个编码假象上**持续误报**。身份归一化是它的前置条件。
  sourceIdentityNote:
    "原始 source_name 不是稳定的设备身份：本库同一块表出现在多个编码变体下。" +
    "在把 source 变化当作『设备切换』证据之前，必须先做身份归一化，否则该信号会误报。",
  limitations: [
    "样本级越界只说明存在越界样本，不等于那次训练不可用；冲刺、下坡、GPS 漂移都会产生它。",
    "本盘点不能替代 §17.3 的回放：检出率不回答'门控是否让能力学习更准'。",
    "速度样本来自设备，未覆盖无 RunningSpeed 记录的跑步；未导入的路线不在这里。",
    "source_name 存在编码变体，不能直接当设备身份使用（见 sourceIdentityNote）。"
  ]
};
database.close();

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (outPath !== null) {
  const resolved = resolve(root, outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`\nWrote ${resolved}\n`);
}
