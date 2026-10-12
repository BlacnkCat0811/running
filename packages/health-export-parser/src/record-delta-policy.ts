import { healthTypes } from "@rai/contracts";
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
