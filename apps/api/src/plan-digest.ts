import { createHash } from "node:crypto";
import type { MobileSessionStructure, MobileWorkoutPlanDay } from "@rai/api-contracts";

export function stableJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const digest = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");

export function prescriptionDigest(kind: string, structure: MobileSessionStructure | null): string {
  const number = (value: number | null | undefined): string => value == null ? "~" : (Object.is(value, -0) ? 0 : value).toFixed(6);
  const step = (value: NonNullable<MobileSessionStructure["warmup"]> | null): string[] => value === null ? ["~"] : [
    value.purpose, value.goal.type,
    value.goal.type === "distance" ? number(value.goal.meters) : value.goal.type === "time" ? number(value.goal.seconds) : "~",
    value.alert?.kind ?? "~", number(value.alert?.lower), number(value.alert?.upper)
  ];
  const parts = ["rai-prescription-v1", kind];
  if (structure === null) parts.push("~");
  else {
    parts.push(...step(structure.warmup), String(structure.blocks.length));
    for (const block of structure.blocks) {
      parts.push(number(block.iterations), String(block.steps.length));
      for (const item of block.steps) parts.push(...step(item));
    }
    parts.push(...step(structure.cooldown));
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function executionContent(days: MobileWorkoutPlanDay[]): unknown {
  return days.map(day => [day.localDate, day.kind, day.executable, prescriptionDigest(day.kind, day.structure)]);
}
