// §5.2 第 1 条：「先盘点每个字段的可用率/时点来源，报告而非猜测」。
//
// 用法（只读，不写任何库）：
//   node --import tsx scripts/normalization-coverage.mts \
//     [--database var/rai.sqlite] [--out deliverables/NORMALIZATION_COVERAGE.json]
//
// 这个脚本的产出决定了 §5.4 的 N1/N2/N3 到底能不能推进，所以它**不猜**：
// 每个数字都来自真实库的一次扫描，用到的解析器与 adapter 都是运行时那一份。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// 复用生产解析器与 adapter：另写一套解析会让报告与运行时静默分叉。
import { parsePerformanceConditions } from "@rai/application";
import { assertUnifiedEvaluationReport, evaluationReportEnvelope } from "@rai/model-eval";
import {
  NORMALIZATION_ADAPTER_VERSION,
  NORMALIZATION_POLICY_VERSION,
  createIdentityNormalizationAdapter,
  defaultConditionLedger,
  defaultIdentityNormalizationConfig,
  type NormalizationStatus
} from "@rai/normalization";
import { MODEL_CONFIG_VERSION, defaultRaiModelConfig } from "@rai/scoring";
import { SqliteRoutePointReader } from "@rai/storage-sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const readArg = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value ?? fallback;
};

const databasePath = resolve(root, readArg("--database", "var/rai.sqlite"));
const outPath = resolve(root, readArg("--out", "deliverables/NORMALIZATION_COVERAGE.json"));

// §15.8-1：产物必须能说出自己出自哪个提交。取不到就写 null（"不知道"），不编。
const repoRevision = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

if (!existsSync(databasePath)) {
  process.stderr.write(`database not found: ${databasePath}\n`);
  process.exit(1);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
const adapter = createIdentityNormalizationAdapter();

const scalar = (sql: string, ...params: ReadonlyArray<string | number>): number => {
  const row = database.prepare(sql).get(...params) as { c: number } | undefined;
  return row?.c ?? 0;
};

const canonicalWorkouts = scalar("SELECT COUNT(*) c FROM workouts WHERE is_canonical = 1");

const metadataRows = database
  .prepare("SELECT id, metadata_json FROM workouts WHERE is_canonical = 1")
  .all() as unknown as ReadonlyArray<{ id: string; metadata_json: string | null }>;

const fieldPresent = { temperatureC: 0, humidityPercent: 0, elevationGainMeters: 0 };
const statusCounts: Record<NormalizationStatus, number> = {
  applied: 0,
  not_needed: 0,
  unavailable: 0,
  out_of_domain: 0
};
const reasonHistogram = new Map<string, number>();
let indoorFlagged = 0;

for (const row of metadataRows) {
  const conditions = parsePerformanceConditions(row.metadata_json ?? "{}");
  if (conditions.temperatureC !== null) fieldPresent.temperatureC += 1;
  if (conditions.humidityPercent !== null) fieldPresent.humidityPercent += 1;
  if (conditions.elevationGainMeters !== null) fieldPresent.elevationGainMeters += 1;

  const result = adapter.normalize({
    id: row.id,
    // Identity does not read these, but they must be positive for the adapter to accept the
    // observation; 1/1 keeps the coverage question about the *context*, not the run.
    distanceMeters: 1,
    durationSeconds: 1,
    context: conditions
  });
  statusCounts[result.trace.status] += 1;
  for (const reason of result.trace.reasonCodes) {
    reasonHistogram.set(reason, (reasonHistogram.get(reason) ?? 0) + 1);
  }
  // Recorded as evidence for the batch report: this export carries no weather at all.
  try {
    const metadata = JSON.parse(row.metadata_json ?? "{}") as Record<string, unknown>;
    const raw = metadata.HKIndoorWorkout;
    if (Array.isArray(raw) ? raw[0] === "1" || raw[0] === 1 : raw === 1 || raw === "1") {
      indoorFlagged += 1;
    }
  } catch {
    // A malformed metadata blob is a separate concern; parsePerformanceConditions already
    // treats it as "no conditions", which is what this report counts.
  }
}

const workoutsWithRoute = scalar(
  "SELECT COUNT(DISTINCT w.id) c FROM workouts w JOIN workout_routes wr ON wr.workout_id = w.id WHERE w.is_canonical = 1"
);
// 🔴 路线点的三个计数走**唯一**的路线点入口（O11 / WP-50）：`route_points` 表在双写退役后
// 只剩指针为 NULL 的老路线，直接数它会**少报**已发布路线的点（覆盖率凭空掉一半）。
// 口径仍是"按点计"，只是"点"现在定义为"此刻可读的点"（`readable_route_points` 视图）。
const routePointCounts = new SqliteRoutePointReader(database).readablePointCounts();
const routePoints = routePointCounts.points;
const routeElevation = routePointCounts.elevationPoints;
const routeSpeed = routePointCounts.speedPoints;

const rate = (value: number, total: number): number | null => (total === 0 ? null : value / total);
const notReference = canonicalWorkouts - statusCounts.not_needed;

const report = {
  // §15.8 的公共部分由 envelope 统一提供。
  ...evaluationReportEnvelope({
    generatedBy: "scripts/normalization-coverage.mts",
    databasePath,
    repoRevision,
    reproduceCommand: "node --import tsx scripts/normalization-coverage.mts --database var/rai.sqlite --out deliverables/NORMALIZATION_COVERAGE.json",
    accuracyStatus: "not_evaluable",
    accuracyReason:
      "这是环境字段的可得率盘点，不是归一化修正的精度评估；N3 校准需要更多同条件样本。",
    gates: [
      {
        name: "identity_adapter_never_claims_normalisation",
        // N0 的核心承诺：没证据时不谎报"已归一化"。
        status: statusCounts.applied === 0 ? "passed" : "not_evaluable",
        reason: statusCounts.applied === 0
          ? null
          : `有 ${statusCounts.applied} 条被标为 applied；N0 只应产出 not_needed/unavailable/out_of_domain`
      },
      {
        name: "comparability_wired_into_learning",
        status: notReference === 0 ? "passed" : "failed",
        reason:
          `若把 comparability 接进学习门控，${notReference}/${canonicalWorkouts} 条会低于门槛`
      }
    ],
    notEvaluable: [
      { item: "fitted_normalisation_adapter", reason: "只有 identity adapter（N0）；N3 需要更多同条件样本" },
      {
        item: "normalizedCorrelations",
        reason: "stored V3 特征不含 normalized 信号，无法给出 raw 与 normalized 的相关性对比"
      }
    ]
  }),
  reportVersion: "rai-normalization-coverage-v1",
  adapterVersion: NORMALIZATION_ADAPTER_VERSION,
  policyVersion: NORMALIZATION_POLICY_VERSION,
  modelConfigVersion: MODEL_CONFIG_VERSION,
  databasePath,
  policySnapshot: defaultIdentityNormalizationConfig,
  canonicalWorkouts,
  fieldAvailability: {
    // 时点来源：canonical workout 的 metadata（导入时写入），**不是**同期天气。
    source: "workouts.metadata_json，经 @rai/application 的 parsePerformanceConditions 解析",
    temperatureC: { present: fieldPresent.temperatureC, rate: rate(fieldPresent.temperatureC, canonicalWorkouts) },
    humidityPercent: { present: fieldPresent.humidityPercent, rate: rate(fieldPresent.humidityPercent, canonicalWorkouts) },
    elevationGainMeters: { present: fieldPresent.elevationGainMeters, rate: rate(fieldPresent.elevationGainMeters, canonicalWorkouts) },
    indoorFlagged: { present: indoorFlagged, rate: rate(indoorFlagged, canonicalWorkouts) }
  },
  contextStatus: {
    ...statusCounts,
    notReference,
    notReferenceRate: rate(notReference, canonicalWorkouts)
  },
  reasonHistogram: [...reasonHistogram.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count),
  routeAvailability: {
    workoutsWithRoute,
    workoutsWithRouteRate: rate(workoutsWithRoute, canonicalWorkouts),
    routePoints,
    routePointElevationPresent: routeElevation,
    routePointElevationRate: rate(routeElevation, routePoints),
    routePointSpeedPresent: routeSpeed,
    routePointSpeedRate: rate(routeSpeed, routePoints)
  },
  conditionLedger: defaultConditionLedger,
  wiringAssessment: {
    // 把 identity 的可比性接进 §6.2 之前必须看这个数。
    minimumComparabilityForLearning: defaultRaiModelConfig.minimumComparabilityForLearning,
    comparabilityUnavailable: defaultIdentityNormalizationConfig.comparabilityUnavailable,
    comparabilityOutOfDomain: defaultIdentityNormalizationConfig.comparabilityOutOfDomain,
    workoutsBelowGateIfWired: notReference,
    workoutsBelowGateIfWiredRate: rate(notReference, canonicalWorkouts)
  },
  notes: [
    "本报告只做观测与记账，不改变任何数值，也不接入评分路径（§5.4 的 N0）。",
    "构建 identity adapter 只判状态，因此 distance/duration 传 1/1：这里问的是环境上下文的可得性，不是这条训练本身。",
    "路线点的覆盖率按**点**计，不按 workout 计；有路线的 workout 只有一所列比例，两个口径不能混用。",
    "路线点数取**此刻可读**的那一份（`readable_route_points` 视图 = 唯一的路线点入口），不是某一张实现表的行数 —— 双写退役后两者会差一半。",
    "§5.4 的 N3（温湿度候选校准）在天气字段可得率为 0 时不可能推进；引入新天气服务须按 §5.2 第 3 条另开一批。"
  ]
};

mkdirSync(dirname(outPath), { recursive: true });
assertUnifiedEvaluationReport(report);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(`\nWrote ${outPath}\n`);
database.close();
