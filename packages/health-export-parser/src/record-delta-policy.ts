import { healthTypes, scoringHealthTypes } from "@rai/contracts";
import { SaxesParser } from "saxes";

/** The existing health-change planner's non-scoring types, closed rather than
 * assuming every future HealthKit type is safe to accept without recomputation. */
export const DATA_ONLY_RECORD_TYPES: readonly string[] = [
  healthTypes.activeEnergy, healthTypes.distanceWalkingRunning,
  healthTypes.heartRateRecoveryOneMinute, healthTypes.physicalEffort,
  healthTypes.runningGroundContactTime, healthTypes.runningPower,
  healthTypes.runningStrideLength, healthTypes.runningVerticalOscillation,
  healthTypes.stepCount, "HKQuantityTypeIdentifierBodyMass",
  "HKQuantityTypeIdentifierRespiratoryRate", "HKQuantityTypeIdentifierAppleSleepingWristTemperature"
];

export const DATA_ONLY_MAX_XML_BYTES = 2 * 1024 * 1024;
export const DATA_ONLY_MAX_RECORDS = 5000;
export const DATA_ONLY_WRITE_GUARD = "rai_data_only_requires_normal_import";

export class RecordDeltaNotEligibleError extends Error {
  constructor(reason: string) {
    super(`Record delta requires the normal import path: ${reason}`);
    this.name = "RecordDeltaNotEligibleError";
  }
}

/** A bounded, conservative payload-only check. Unsupported or malformed XML
 * falls back to the ordinary parser; it is never acknowledged as an empty batch. */
export function isDataOnlyRecordXml(xml: string): boolean {
  if (Buffer.byteLength(xml, "utf8") > DATA_ONLY_MAX_XML_BYTES) return false;
  const parser = new SaxesParser({ xmlns: false });
  const stack: string[] = [];
  let eligible = true, roots = 0, records = 0;
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    const name = tag.name;
    if (parent === undefined) {
      roots++;
      if (name !== "HealthData" || roots !== 1) eligible = false;
    } else if (parent === "HealthData") {
      if (!["Me", "ExportDate", "Record"].includes(name)) eligible = false;
      if (name === "Record") {
        records++;
        if (!DATA_ONLY_RECORD_TYPES.includes(String(tag.attributes.type))
            || records > DATA_ONLY_MAX_RECORDS) eligible = false;
      }
    } else if (parent !== "Record" || name !== "MetadataEntry") {
      eligible = false;
    }
    stack.push(name);
  });
  parser.on("closetag", () => { stack.pop(); });
  parser.on("doctype", () => { eligible = false; });
  parser.on("text", (text) => { if (text.trim()) eligible = false; });
  parser.on("cdata", (text) => { if (text.trim()) eligible = false; });
  try {
    parser.write(xml).close();
    return eligible && roots === 1 && stack.length === 0;
  } catch {
    return false;
  }
}

/**
 * 直连车道的载荷分类（PR4 步骤 2a，见 `docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md` §2.1）。
 *
 * 它回答一个问题：**本批是否必须在同一个事务里登记分析任务**（§4.2），
 * 还是可以在回执里写 `analysisStatus: "not_required"`。
 *
 * 🔴 **默认方向是"必须分析"。** 只有**证明了**"一个评分类型、一个 Workout、一条路线、
 * 一条删除都没有，且所有类型都在非评分白名单里"才允许 `record-only`。
 * 任何**未知类型**（既不在非评分白名单、也不在评分清单里）一律 `analysis-required`。
 *
 * 为什么默认值必须偏向分析：两个方向的代价不对称 ——
 *   · 该分析却宣布 `not_required` ⇒ 用户看到的是**与事实不符的当前结论**（§9.1 明令禁止）；
 *   · 不必分析却登记了分析 ⇒ 多跑一次后台计算，事实与回执**仍然正确**。
 * 所以"拿不准就分析"不是保守，是唯一说得通的一侧。
 *
 * 纯函数：不读库、不写库、不看时间、不看文件大小 —— 事实由调用方扫描后传入。
 */
export interface DirectSyncPayloadFacts {
  /** 本批 XML 出现的 record 类型（允许重复，本函数会去重）。 */
  readonly recordTypes: readonly string[];
  /** 本批是否含 Workout 元素（含 `<Workout>` 与 workout 事件）。 */
  readonly hasWorkout: boolean;
  /** 本批是否含路线（GPX / WorkoutRoute）。 */
  readonly hasRoute: boolean;
  /** manifest 声明的显式删除记录数。 */
  readonly deletedRecordCount: number;
  /** manifest 声明的显式删除训练数。 */
  readonly deletedWorkoutCount: number;
}

export interface DirectSyncPayloadClassification {
  readonly payloadClass: "record-only" | "analysis-required";
  /** 判为 `analysis-required` 的原因（**排序后**，便于比较与落库）；`record-only` 时为空数组。 */
  readonly reasons: readonly string[];
  /** 既不在非评分白名单、也不在评分清单里的类型。 */
  readonly unknownRecordTypes: readonly string[];
}

export function classifyDirectSyncPayload(facts: DirectSyncPayloadFacts): DirectSyncPayloadClassification {
  const types = [...new Set(facts.recordTypes)].sort();
  const nonScoring = new Set<string>(DATA_ONLY_RECORD_TYPES);
  const scoring = new Set<string>(scoringHealthTypes);
  const unknownRecordTypes = types.filter((type) => !nonScoring.has(type) && !scoring.has(type));
  const reasons = [
    ...unknownRecordTypes.map((type) => `unknown_record_type:${type}`),
    ...types.filter((type) => scoring.has(type)).map((type) => `scoring_record_type:${type}`),
    ...(facts.hasWorkout ? ["workout_present"] : []),
    ...(facts.hasRoute ? ["route_present"] : []),
    ...(facts.deletedRecordCount > 0 ? ["explicit_record_deletion"] : []),
    ...(facts.deletedWorkoutCount > 0 ? ["explicit_workout_deletion"] : [])
  ];
  return {
    payloadClass: reasons.length === 0 ? "record-only" : "analysis-required",
    reasons,
    unknownRecordTypes
  };
}
