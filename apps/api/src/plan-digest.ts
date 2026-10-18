import { createHash } from "node:crypto";
import { MOBILE_SESSION_KINDS } from "@rai/contracts";
import type { MobileSessionStructure, MobileWorkoutPlanDay } from "@rai/api-contracts";

/** Thrown when a prescription cannot have a stable cross-language identity. */
export class PrescriptionDigestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrescriptionDigestInputError";
  }
}

/** The only kind values `rai-prescription-v1` was defined for. */
const PRESCRIPTION_KINDS: ReadonlySet<string> = new Set(MOBILE_SESSION_KINDS);

/**
 * Largest absolute value a prescription number may carry before the identity stops
 * being stable. `micro = floor(x*1e6 + 0.5)` is an exact integer for |x| <= 1e9
 * (|micro| <= 1e15 < 2^53), which is what makes the TS and Swift implementations
 * produce the same bytes; above it the two binary64 expressions can disagree.
 */
export const PRESCRIPTION_MAXIMUM_ABSOLUTE_VALUE = 1e9;

/**
 * Six-decimal POSIX-style rendering of a prescription number.
 *
 * Deliberately **not** `value.toFixed(6)`: JavaScript rounds the binary value to
 * the nearest six-decimal string, while Swift's locale-aware `%.6f` rounds the
 * shortest decimal representation half-to-even, so `1.0000005` came out as
 * `1.000001` on one side and `1.000000` on the other. The shared rule is to
 * quantize to integer micro-units first — `floor(x*1e6 + 0.5)`, i.e. exact halves
 * round toward +infinity and `-0` becomes `0` — then render that integer as a
 * fixed six-decimal string. Both languages compute the same binary64 expression
 * and the same integer, so the bytes are identical.
 */
export function prescriptionNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new PrescriptionDigestInputError(`prescription number must be finite, received ${String(value)}`);
  }
  if (Math.abs(value) > PRESCRIPTION_MAXIMUM_ABSOLUTE_VALUE) {
    throw new PrescriptionDigestInputError(
      `prescription number ${String(value)} exceeds the stable range |x| <= ${PRESCRIPTION_MAXIMUM_ABSOLUTE_VALUE}`
    );
  }
  const micro = Math.floor(value * 1e6 + 0.5);
  if (!Number.isSafeInteger(micro)) {
    throw new PrescriptionDigestInputError(`prescription number ${String(value)} cannot be quantized safely`);
  }
  if (micro === 0) return "0.000000";
  const sign = micro < 0 ? "-" : "";
  const absolute = Math.abs(micro);
  const whole = Math.floor(absolute / 1e6);
  const fraction = absolute % 1e6;
  return `${sign}${whole}.${String(fraction).padStart(6, "0")}`;
}

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
  // The kind is a field of the identity, joined with `|` below. Accepting an
  // arbitrary string let `kind = "easy|~|0"` + a null structure hash exactly like
  // `kind = "easy"` + an empty structure: two different prescriptions, one
  // identity. The contract says enumeration fields may not contain the separator;
  // enforcing the enumeration is the cheapest way to keep that true.
  if (!PRESCRIPTION_KINDS.has(kind)) {
    throw new PrescriptionDigestInputError(`unsupported prescription kind ${JSON.stringify(kind)}`);
  }
  const number = (value: number | null | undefined): string => value == null ? "~" : prescriptionNumber(value);
  const step = (value: NonNullable<MobileSessionStructure["warmup"]> | null | undefined): string[] => value == null ? ["~"] : [
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
