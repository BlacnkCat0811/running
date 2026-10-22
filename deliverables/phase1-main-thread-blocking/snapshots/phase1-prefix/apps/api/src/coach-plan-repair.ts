import type { CoachDecisionReason, CoachPlanRepairCost, MobilePlannedDay } from "@rai/api-contracts";
import { isValidLocalDate } from "./local-date.js";
import { coachReason } from "./coach-loop-policy.js";
import { digest, prescriptionDigest } from "./plan-digest.js";
import { flattenStructure } from "./workout-segments.js";
import { normalizeSessionStructure } from "./session-structure.js";

export const PLAN_REPAIR_CANDIDATE_VERSION = "rai-coach-plan-repair-candidate-v1";
export const MAXIMUM_REPAIR_CANDIDATES_PER_DATE = 5;
export const MAXIMUM_REPAIR_WINDOW_DAYS = 7;

export interface CoachRepairDay {
  day: MobilePlannedDay;
  executable: boolean;
  /** Identity is part of execution, even when the step bytes are unchanged. */
  authorizedDecisionRef: string | null;
}

export interface CoachRepairCandidate extends CoachRepairDay {
  templateId: string;
  /** Null for a newly selected intent; relocation names the original date. */
  originDate: string | null;
  preferenceRank: number;
}

export interface CoachRepairValidation {
  feasible: boolean;
  /** Result of the caller's ONE existing final constraint pipeline. */
  effectiveDays: readonly CoachRepairDay[];
  reasons: readonly CoachDecisionReason[];
}

export interface CoachPlanRepairResult {
  version: string;
  policyStatus: "candidate";
  /** Candidate output is not an atomic publication or an authorization. */
  publishable: false;
  status: "no_change" | "patched" | "safe_fallback" | "not_evaluable";
  storedDays: readonly MobilePlannedDay[];
  effectiveDays: readonly CoachRepairDay[];
  cost: CoachPlanRepairCost | null;
  affectedDates: string[];
  changes: Array<{
    localDate: string;
    layer: "stored_plan" | "effective_execution";
    beforeDigest: string | null;
    afterDigest: string | null;
    safetyDowngrade: boolean;
    reasons: CoachDecisionReason[];
  }>;
  evaluatedCandidates: number;
  reasons: CoachDecisionReason[];
}

export interface CoachConstraintDependency {
  code: string;
  dates: readonly string[];
}

/** Propagate only inside the requested window; outside rows stay fixed inputs. */
export function coachRepairConstraintClosure(input: {
  windowDates: readonly string[];
  seeds: readonly string[];
  dependencies: readonly CoachConstraintDependency[];
}): string[] {
  const window = new Set(input.windowDates);
  const affected = new Set(input.seeds.filter(date => window.has(date)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const dependency of input.dependencies) {
      if (!dependency.dates.some(date => affected.has(date))) continue;
      for (const date of dependency.dates) if (window.has(date) && !affected.has(date)) {
        affected.add(date);
        changed = true;
      }
    }
  }
  return [...affected].sort();
}

const executionKey = (row: CoachRepairDay) => digest({
  localDate: row.day.localDate, kind: row.day.kind, structure: prescriptionDigest(row.day.kind, row.day.structure ?? null),
  hintOnlyDistanceKm: row.day.structure == null ? row.day.distanceKm : null,
  executable: row.executable, authorizedDecisionRef: row.authorizedDecisionRef
});
const storedKey = (day: MobilePlannedDay) => day.structure != null ? prescriptionDigest(day.kind, day.structure) :
  digest({ kind: day.kind, structure: null, hintOnlyDistanceKm: day.distanceKm });

/** Comparable work dose only; seconds/meters/reps are never pooled together. */
function workDose(day: MobilePlannedDay): { value: number; unit: "work_seconds" | "work_meters" | "reps" } | null {
  if (!day.structure || day.kind === "rest") return null;
  const normalized = normalizeSessionStructure(day.structure);
  if (!normalized || digest(normalized) !== digest(day.structure)) return null;
  const work = flattenStructure(day.structure).filter(item => item.step.purpose === "work");
  if (day.kind === "interval") return { value: work.length, unit: "reps" };
  if (work.length && work.every(item => item.step.goal.type === "time")) return {
    value: work.reduce((sum, item) => sum + (item.step.goal.type === "time" ? item.step.goal.seconds : 0), 0), unit: "work_seconds"
  };
  if (work.length && work.every(item => item.step.goal.type === "distance")) return {
    value: work.reduce((sum, item) => sum + (item.step.goal.type === "distance" ? item.step.goal.meters : 0), 0), unit: "work_meters"
  };
  return null;
}

/**
 * Lexicographic stability objective. Moving an original session counts once,
 * not as a deletion plus a newly created training obligation on the target day.
 */
export function coachPlanRepairCost(
  previous: readonly CoachRepairDay[], candidates: readonly CoachRepairCandidate[], effective: readonly CoachRepairDay[]
): CoachPlanRepairCost {
  const result: CoachPlanRepairCost = {
    changedDates: 0, movedSessions: 0, kindChanges: 0, workDoseRelativeDifference: 0,
    preferenceRank: candidates.reduce((sum, row) => sum + row.preferenceRank, 0)
  };
  const byDate = new Map(effective.map(row => [row.day.localDate, row]));
  const byOrigin = new Map(candidates.filter(row => row.originDate !== null).map(row => [row.originDate!, row]));
  for (const original of previous) {
    const date = original.day.localDate;
    const relocation = original.day.kind !== "rest" ? byOrigin.get(date) : undefined;
    const next = relocation ? byDate.get(relocation.day.localDate) : byDate.get(date);
    if (original.day.kind === "rest" && candidates.some(row => row.day.localDate === date &&
      row.originDate !== null && row.originDate !== date)) continue;
    if (!next || executionKey(original) !== executionKey(next)) result.changedDates++;
    if (relocation && relocation.day.localDate !== date) result.movedSessions++;
    if (next && next.day.kind !== original.day.kind) result.kindChanges++;
    const beforeDose = workDose(original.day), afterDose = next ? workDose(next.day) : null;
    if (next?.day.kind === original.day.kind && beforeDose && afterDose && beforeDose.unit === afterDose.unit && beforeDose.value > 0) {
      result.workDoseRelativeDifference += Math.abs(afterDose.value - beforeDose.value) / beforeDose.value;
    }
  }
  return result;
}

export function compareCoachPlanRepairCost(a: CoachPlanRepairCost, b: CoachPlanRepairCost): number {
  return a.changedDates - b.changedDates || a.movedSessions - b.movedSessions || a.kindChanges - b.kindChanges ||
    a.workDoseRelativeDifference - b.workDoseRelativeDifference || a.preferenceRank - b.preferenceRank;
}

/**
 * Finite deterministic candidate solver. Does NOT contain a second capacity,
 * dose, readiness, phase or quality rule engine. `validate` is supplied by the
 * existing constraint path, including all fixed rows and effective restrictions.
 * Search exhaustion is not permission to publish an unchecked/partial winner.
 */
export function repairCoachPlan(input: {
  previous: readonly CoachRepairDay[];
  windowDates: readonly string[];
  affectedDates: readonly string[];
  protectedDates: readonly string[];
  /** Explicit intent selected by O0; mere green readiness is not an upgrade. */
  requiredIntentDates: readonly string[];
  candidates: Readonly<Record<string, readonly CoachRepairCandidate[]>>;
  maximumEvaluations: number;
  /** Skip enumeration only after proving the all-zero retained lower bound. */
  retainFeasibleWindow?: boolean;
  inputDigest: string;
  reasonsByDate: Readonly<Record<string, readonly CoachDecisionReason[]>>;
  validate: (storedDays: readonly MobilePlannedDay[]) => CoachRepairValidation;
}): CoachPlanRepairResult {
  const dates = [...input.windowDates].sort();
  if (!dates.length || dates.length > MAXIMUM_REPAIR_WINDOW_DAYS || new Set(dates).size !== dates.length ||
    dates.some(date => !isValidLocalDate(date)) || !Number.isInteger(input.maximumEvaluations) ||
    input.maximumEvaluations < 1 || !input.inputDigest) throw new Error("Invalid bounded coach repair inputs");
  const previous = [...input.previous].sort((a, b) => a.day.localDate.localeCompare(b.day.localDate));
  if (new Set(previous.map(row => row.day.localDate)).size !== previous.length) throw new Error("Duplicate previous prescription date");
  const window = new Set(dates), affected = new Set(input.affectedDates), protectedDates = new Set(input.protectedDates);
  const requiredIntents = new Set(input.requiredIntentDates);
  if (input.requiredIntentDates.some(date => !window.has(date) || protectedDates.has(date))) {
    throw new Error("Required intent cannot modify a protected/out-of-window date");
  }
  const fixed = previous.filter(row => !window.has(row.day.localDate));
  const options = dates.map(date => {
    const original = previous.find(row => row.day.localDate === date);
    const keep: CoachRepairCandidate[] = original ? [{ ...original, originDate: original.day.kind === "rest" ? null : date,
      templateId: "keep-original", preferenceRank: 0 }] : [];
    const editable = !original || affected.has(date);
    let all = protectedDates.has(date) || !editable ? keep : [...keep, ...(input.candidates[date] ?? [])];
    if (protectedDates.has(date) && !original) throw new Error("Protected prescription has no original row");
    if (all.some(row => row.day.localDate !== date || !row.templateId || !Number.isFinite(row.preferenceRank) ||
      row.preferenceRank < 0 || row.originDate !== null && !previous.some(old => old.day.localDate === row.originDate && old.day.kind !== "rest"))) {
      throw new Error("Invalid coach repair candidate identity/origin");
    }
    if (requiredIntents.has(date)) all = all.filter(row => row.day.kind !== "rest");
    const unique = new Map<string, CoachRepairCandidate>();
    for (const row of all) {
      const key = digest([executionKey(row), row.originDate]);
      const existing = unique.get(key);
      if (!existing || row.preferenceRank < existing.preferenceRank ||
        row.preferenceRank === existing.preferenceRank && (row.templateId < existing.templateId ||
          row.templateId === existing.templateId && digest(row.day) < digest(existing.day))) unique.set(key, row);
    }
    all = [...unique.values()].sort((a, b) => a.preferenceRank - b.preferenceRank ||
      a.templateId.localeCompare(b.templateId) || executionKey(a).localeCompare(executionKey(b)));
    if (all.length > MAXIMUM_REPAIR_CANDIDATES_PER_DATE) throw new Error("Too many coach repair candidates");
    return all;
  });
  let evaluated = 0, exhausted = false;
  let best: { selected: CoachRepairCandidate[]; validation: CoachRepairValidation; cost: CoachPlanRepairCost; tie: string } | null = null;
  const validate = (selected: readonly CoachRepairCandidate[]) => {
    const stored = [...fixed.map(row => row.day), ...selected.map(row => row.day)].sort((a, b) => a.localDate.localeCompare(b.localDate));
    // Caller validation cannot mutate the original/stored prescription text.
    const safeInput = structuredClone(stored);
    const before = digest(safeInput);
    const validation = input.validate(safeInput);
    if (digest(safeInput) !== before) throw new Error("Coach repair validator mutated prescriptions");
    if (validation.feasible && (new Set(validation.effectiveDays.map(row => row.day.localDate)).size !== validation.effectiveDays.length ||
      validation.effectiveDays.length !== stored.length ||
      stored.some(day => !validation.effectiveDays.some(row => row.day.localDate === day.localDate)))) {
      throw new Error("Final repair validation must account for every stored date");
    }
    return validation;
  };
  // A fully retained feasible window has the lexicographic lower bound (all
  // costs zero). No need to enumerate 5^7 alternatives on every GET/refresh.
  if (input.retainFeasibleWindow && !requiredIntents.size && dates.every(date => previous.some(row => row.day.localDate === date))) {
    const retained = dates.map(date => {
      const row = previous.find(row => row.day.localDate === date)!;
      return { ...row, originDate: row.day.kind === "rest" ? null : date, templateId: "keep-original", preferenceRank: 0 };
    });
    const validation = validate(retained);
    evaluated++;
    if (validation.feasible && previous.every(row => {
      const effective = validation.effectiveDays.find(item => item.day.localDate === row.day.localDate);
      return effective && executionKey(effective) === executionKey(row);
    })) {
      return {
        version: PLAN_REPAIR_CANDIDATE_VERSION, policyStatus: "candidate", publishable: false, status: "no_change",
        storedDays: previous.map(row => row.day), effectiveDays: [...validation.effectiveDays],
        cost: { changedDates: 0, movedSessions: 0, kindChanges: 0, workDoseRelativeDifference: 0, preferenceRank: 0 },
        affectedDates: [], changes: [], evaluatedCandidates: evaluated, reasons: [...validation.reasons]
      };
    }
    // The retained validation is not part of the bounded search enumeration.
    evaluated = 0;
  }
  const visit = (index: number, selected: CoachRepairCandidate[]) => {
    if (exhausted) return;
    if (index === dates.length) {
      if (evaluated >= input.maximumEvaluations) { exhausted = true; return; }
      evaluated++;
      const validation = validate(selected);
      if (!validation.feasible) return;
      if (selected.some(row => requiredIntents.has(row.day.localDate) &&
        validation.effectiveDays.find(effective => effective.day.localDate === row.day.localDate)?.day.kind === "rest")) return;
      const finalSelected = selected.map(row => {
        const original = previous.find(old => old.day.localDate === row.day.localDate);
        const effective = validation.effectiveDays.find(day => day.day.localDate === row.day.localDate)!;
        if (protectedDates.has(row.day.localDate) || original && !affected.has(row.day.localDate)) return row;
        // Record the result AFTER the one final constraint pipeline. Storage
        // is preserved only for protected rows, never for an invalid draft.
        return { ...row, ...effective,
          day: original && storedKey(original.day) === storedKey(effective.day) ? original.day : effective.day };
      });
      const allSelected = [...fixed.map(row => ({ ...row, originDate: row.day.localDate,
        templateId: "fixed-outside-window", preferenceRank: 0 })), ...finalSelected];
      const cost = coachPlanRepairCost(previous, allSelected, validation.effectiveDays);
      const tie = JSON.stringify(finalSelected.map(row => [row.day.localDate, row.templateId, storedKey(row.day)]));
      if (!best || compareCoachPlanRepairCost(cost, best.cost) < 0 ||
        compareCoachPlanRepairCost(cost, best.cost) === 0 && tie < best.tie) best = { selected: finalSelected, validation, cost, tie };
      return;
    }
    for (const candidate of options[index]!) {
      if (candidate.originDate && candidate.day.kind !== "rest" && selected.some(row =>
        row.day.kind !== "rest" && row.originDate === candidate.originDate)) continue;
      visit(index + 1, [...selected, candidate]);
      if (exhausted) return;
    }
  };
  visit(0, []);
  const base: CoachPlanRepairResult = {
    version: PLAN_REPAIR_CANDIDATE_VERSION, policyStatus: "candidate", publishable: false,
    status: "not_evaluable", storedDays: previous.map(row => row.day), effectiveDays: [], cost: null,
    affectedDates: [], changes: [], evaluatedCandidates: evaluated, reasons: []
  };
  if (exhausted) return { ...base, reasons: [coachReason("repair_search_budget_exhausted",
    PLAN_REPAIR_CANDIDATE_VERSION, dates, { evaluated, maximum: input.maximumEvaluations, inputDigest: input.inputDigest })] };
  // The explicit assertion keeps control-flow narrowing independent of closure mutations.
  const winner = best as { selected: CoachRepairCandidate[]; validation: CoachRepairValidation; cost: CoachPlanRepairCost; tie: string } | null;
  if (!winner) {
    const fallback = dates.map(date => {
      const original = previous.find(row => row.day.localDate === date);
      return protectedDates.has(date) || original && !affected.has(date) ? {
        ...original!, originDate: original!.day.kind === "rest" ? null : date, templateId: "protected-original", preferenceRank: 0
      } : {
        day: { localDate: date, kind: "rest" as const, structure: null, distanceKm: null, reason: "no_feasible_safe_plan" },
        executable: false, authorizedDecisionRef: null, originDate: null, templateId: "safe-rest", preferenceRank: 0
      };
    });
    const validation = validate(fallback);
    if (!validation.feasible) return { ...base, reasons: [coachReason("no_feasible_safe_plan",
      PLAN_REPAIR_CANDIDATE_VERSION, dates, { inputDigest: input.inputDigest })] };
    return finish(fallback, validation, "safe_fallback", null);
  }
  return finish(winner.selected, winner.validation, "patched", winner.cost);

  function finish(selected: readonly CoachRepairCandidate[], validation: CoachRepairValidation,
    status: "patched" | "safe_fallback", cost: CoachPlanRepairCost | null): CoachPlanRepairResult {
    const stored = [...fixed.map(row => row.day), ...selected.map(row => row.day)].sort((a, b) => a.localDate.localeCompare(b.localDate));
    const changes: CoachPlanRepairResult["changes"] = [];
    for (const day of stored) {
      const before = previous.find(row => row.day.localDate === day.localDate);
      const effective = validation.effectiveDays.find(row => row.day.localDate === day.localDate)!;
      const reasons = [...(input.reasonsByDate[day.localDate] ?? []), ...validation.reasons.filter(reason => reason.affectedDates.includes(day.localDate))];
      if (!reasons.length) reasons.push(coachReason("repair_candidate_selected", PLAN_REPAIR_CANDIDATE_VERSION,
        [day.localDate], { inputDigest: input.inputDigest }));
      if (!before || storedKey(before.day) !== storedKey(day)) changes.push({
        localDate: day.localDate, layer: "stored_plan", beforeDigest: before ? storedKey(before.day) : null,
        afterDigest: storedKey(day), safetyDowngrade: day.kind === "rest" && before?.day.kind !== "rest", reasons
      });
      if (!before || executionKey(before) !== executionKey(effective)) changes.push({
        localDate: day.localDate, layer: "effective_execution", beforeDigest: before ? executionKey(before) : null,
        afterDigest: executionKey(effective), safetyDowngrade: before?.executable === true && !effective.executable, reasons
      });
    }
    return {
      ...base, status: changes.length ? status : "no_change", storedDays: stored,
      effectiveDays: [...validation.effectiveDays], cost,
      changes, affectedDates: [...new Set(changes.map(change => change.localDate))].sort(),
      reasons: [...validation.reasons]
    };
  }
}
