import type {
  MobileIntervalBlock,
  MobileSessionStructure,
  MobileStepAlert,
  MobileStepGoal,
  MobileStepPurpose,
  MobileWorkoutStep
} from "@rai/api-contracts";

/**
 * Shape validation for structured sessions.
 *
 * This is a trust boundary: structures arrive from the LLM, from the network,
 * and from previously persisted JSON. Nothing here may assume the input is
 * well formed, and anything rejected is dropped rather than propagated.
 */

const PURPOSES = new Set<MobileStepPurpose>(["warmup", "work", "recovery", "cooldown"]);
const ALERT_KINDS = new Set<MobileStepAlert["kind"]>(["pace", "heart_rate"]);

/** Bounds keep a hallucinated plan from producing an absurd workout. */
export const MAX_STEP_METERS = 100_000;
export const MAX_STEP_SECONDS = 4 * 60 * 60;
export const MAX_BLOCK_ITERATIONS = 20;
export const MAX_BLOCKS = 8;
export const MAX_ALERT_PACE_SECONDS_PER_KM = 1200;
export const MAX_ALERT_HEART_RATE_BPM = 240;
/**
 * Single-day distance ceiling. Shared by the JSON schema, the goals store and
 * the plan validator so a value one layer accepts is never silently truncated
 * by the next.
 *
 * The field bounds in this file do not add up to it. A structure may satisfy
 * every one of them — one step at `MAX_STEP_METERS`, one block at
 * `MAX_BLOCK_ITERATIONS` repetitions — and still describe a 2000 km run, so
 * every layer that accepts a structure also caps its *measurement*
 * (`capStructureToDayCeiling`), not just its fields.
 */
export const MAX_PLANNED_DISTANCE_KM = 80;
/**
 * One 100 m rounding step. Shared so every layer that rebuilds a day to a cap
 * asks for the same margin: a request *at* a ceiling measures just above it.
 */
export const DISTANCE_ROUNDING_KM = 0.1;

function finiteOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAlert(value: unknown): MobileStepAlert | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (typeof kind !== "string" || !ALERT_KINDS.has(kind as MobileStepAlert["kind"])) return null;
  const limit = kind === "pace" ? MAX_ALERT_PACE_SECONDS_PER_KM : MAX_ALERT_HEART_RATE_BPM;
  const clamp = (input: unknown, min: number): number | null => {
    const parsed = finiteOrNull(input);
    if (parsed == null) return null;
    return Math.min(limit, Math.max(min, Math.round(parsed)));
  };
  let lower = clamp(raw.lower, 1);
  let upper = clamp(raw.upper, 1);
  if (lower != null && upper != null && lower > upper) {
    const swap = lower;
    lower = upper;
    upper = swap;
  }
  if (lower == null && upper == null) return null;
  return { kind: kind as MobileStepAlert["kind"], lower, upper };
}

function normalizeGoal(value: unknown): MobileStepGoal | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === "open") return { type: "open" };
  if (raw.type === "distance") {
    const meters = finiteOrNull(raw.meters);
    if (meters == null || meters < 1) return null;
    return { type: "distance", meters: Math.min(MAX_STEP_METERS, Math.round(meters)) };
  }
  if (raw.type === "time") {
    const seconds = finiteOrNull(raw.seconds);
    if (seconds == null || seconds < 1) return null;
    return { type: "time", seconds: Math.min(MAX_STEP_SECONDS, Math.round(seconds)) };
  }
  return null;
}

function normalizeStep(value: unknown, expected?: MobileStepPurpose): MobileWorkoutStep | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const purpose = raw.purpose;
  if (typeof purpose !== "string" || !PURPOSES.has(purpose as MobileStepPurpose)) return null;
  if (expected != null && purpose !== expected) return null;
  const goal = normalizeGoal(raw.goal);
  if (!goal) return null;
  return { purpose: purpose as MobileStepPurpose, goal, alert: normalizeAlert(raw.alert) };
}

function normalizeBlock(value: unknown): MobileIntervalBlock | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const iterations = finiteOrNull(raw.iterations);
  if (iterations == null || iterations < 1) return null;
  const stepsRaw = Array.isArray(raw.steps) ? raw.steps : [];
  const steps = stepsRaw.map((step) => normalizeStep(step)).filter((step): step is MobileWorkoutStep => step != null);
  if (steps.length === 0) return null;
  return {
    iterations: Math.min(MAX_BLOCK_ITERATIONS, Math.max(1, Math.round(iterations))),
    steps
  };
}

/** Returns a sanitized structure, or null when nothing usable remains. */
export function normalizeSessionStructure(value: unknown): MobileSessionStructure | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const warmup = normalizeStep(raw.warmup, "warmup");
  const cooldown = normalizeStep(raw.cooldown, "cooldown");
  const blocksRaw = Array.isArray(raw.blocks) ? raw.blocks : [];
  const blocks = blocksRaw
    .map((block) => normalizeBlock(block))
    .filter((block): block is MobileIntervalBlock => block != null)
    .slice(0, MAX_BLOCKS);
  if (!warmup && !cooldown && blocks.length === 0) return null;
  return { warmup, blocks, cooldown };
}

/** Total work repetitions in a structure; used by the plan guard rails. */
export function structureWorkRepetitions(structure: MobileSessionStructure): number {
  let total = 0;
  for (const block of structure.blocks) {
    const workSteps = block.steps.filter((step) => step.purpose === "work").length;
    total += Math.max(1, block.iterations) * Math.max(1, workSteps);
  }
  return total;
}
