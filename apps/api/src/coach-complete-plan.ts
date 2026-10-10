import type { MobilePlannedDay } from "@rai/api-contracts";
import { buildSessionStructure, measureStructure, pacesFromZones, plannedDayNumbers, roundKm, type CoachZonePrescription } from "./mobile-coach.js";
import { assessSessionDose, buildCompleteEasyStructure, SESSION_DOSE_POLICY_VERSION } from "./coach-session-dose.js";
import { weeklyPlanVolumeCeiling } from "./weekly-plan-validate.js";

export function enforceAutomaticSessionDose(
  day: MobilePlannedDay, zones: CoachZonePrescription | null, warnings: string[] = []
): MobilePlannedDay {
  if (day.kind === "rest") return day;
  const structure = plannedDayNumbers(day.kind, day.structure, day.distanceKm, zones).structure;
  const dose = assessSessionDose({ kind: day.kind, structure, zones, allowColdStartEstimate: true });
  if (dose.status === "feasible") return day;
  warnings.push(`${day.localDate} ${dose.reasonCodes.join("、")}：最终自动处方不满足完整课政策，改为休息。`);
  return { ...day, kind: "rest", distanceKm: null, structure: null,
    reason: `完整课不可行（${dose.reasonCodes.join("、")}）；不抬高保护上限或凑短课。` };
}

/** Whole-session budget fitting, before the legacy scaler can create fragments. */
export function fitCompleteSessionsToBudget(
  days: MobilePlannedDay[], zones: CoachZonePrescription | null, remainingKm: number, warnings: string[] = []
): MobilePlannedDay[] {
  const cost = (day: MobilePlannedDay) => day.kind === "rest" ? 0 : Math.max(day.distanceKm ?? 0,
    assessSessionDose({ kind: day.kind, structure: day.structure ?? null, zones,
      allowColdStartEstimate: true }).distanceKm?.upper ?? 0);
  let result = days;
  let total = result.reduce((sum, day) => sum + cost(day), 0);
  for (const expensive of [...result].filter(day => day.kind !== "rest")
    .sort((a, b) => cost(b) - cost(a) || b.localDate.localeCompare(a.localDate))) {
    if (total <= remainingKm + 1e-9) break;
    total -= cost(expensive);
    warnings.push(`${expensive.localDate} 完整课超出剩余保护空间，少排一堂而不缩成短课。`);
    result = result.map(day => day.localDate === expensive.localDate ? {
      ...day, kind: "rest", structure: null, distanceKm: null,
      reason: "按快端配速核算，完整课超出剩余保护空间；不切碎剂量。"
    } : day);
  }
  return result;
}

/**
 * Allocate complete doses first, then count sessions. Never divide remaining
 * km by calendar days, pad work intentions or fill protection headroom.
 * Existing quality templates/ceiling/floor stay authoritative; legacy manual
 * validation is not silently rewritten into this automatic-dose policy.
 */
export function buildCompleteCoachWeekPlan(input: {
  allowedDates: string[];
  prescription: CoachZonePrescription | null;
  weeklyDistanceKm: number;
  previousWeekDistanceKm?: number | null;
  qualitySessionCap: number;
  easyDurationFloorFraction: number;
  injuryFlagCodes: readonly string[];
}): MobilePlannedDay[] {
  const dates = [...input.allowedDates].sort();
  const ceiling = weeklyPlanVolumeCeiling(input.weeklyDistanceKm, input.previousWeekDistanceKm);
  const make = (localDate: string, kind: "easy" | "interval" | "tempo"): MobilePlannedDay | null => {
    const structure = kind === "easy" ? buildCompleteEasyStructure("easy", input.prescription)
      : buildSessionStructure(kind, input.prescription, {});
    const dose = assessSessionDose({ kind, structure, zones: input.prescription, allowColdStartEstimate: true });
    if (dose.status !== "feasible") return null;
    const measured = measureStructure(structure!, kind, pacesFromZones(input.prescription));
    return { localDate, kind, structure, distanceKm: roundKm(measured.distanceKm),
      reason: `完整剂量优先；${SESSION_DOSE_POLICY_VERSION}，未分配建议量不产生补课义务。` };
  };
  const cost = (day: MobilePlannedDay): number => Math.max(day.distanceKm ?? 0,
    assessSessionDose({ kind: day.kind, structure: day.structure ?? null, zones: input.prescription,
      allowColdStartEstimate: true }).distanceKm?.upper ?? 0);
  const maxQuality = input.injuryFlagCodes.length ? 0 : Math.max(0, Math.min(2, input.qualitySessionCap));
  for (let qualityCount = maxQuality; qualityCount >= 0; qualityCount--) {
    const planned = new Map<string, MobilePlannedDay>();
    let spent = 0;
    const easy = dates[0] ? make(dates[0], "easy") : null;
    const easyCost = easy ? cost(easy) : Number.POSITIVE_INFINITY;
    // Legacy candidate intent only; O4's richer library is not claimed here.
    const qualitySlots = qualityCount === 2 ? [{ index: 2, kind: "interval" as const },
      { index: dates.length - 1, kind: "tempo" as const }] : qualityCount === 1 ? [{ index: 2, kind: "interval" as const }] : [];
    for (const slot of qualitySlots) {
      const date = dates[slot.index];
      if (!date || planned.has(date)) continue;
      // Dates can be sparse. Keep the existing 48h spacing across actual dates.
      if ([...planned.keys()].some(other => Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${other}T00:00:00Z`)) < 2 * 86_400_000)) continue;
      const candidate = make(date, slot.kind);
      if (candidate && spent + cost(candidate) + easyCost <= ceiling + 1e-9) {
        planned.set(date, candidate);
        spent += cost(candidate);
      }
    }
    const free = dates.filter(date => !planned.has(date));
    const count = Number.isFinite(easyCost) ? Math.min(free.length, Math.floor((ceiling - spent + 1e-9) / easyCost)) : 0;
    for (let index = 0; index < count; index++) {
      const date = free[count === 1 ? 0 : Math.round(index * (free.length - 1) / (count - 1))]!;
      const candidate = make(date, "easy");
      if (candidate) planned.set(date, candidate);
    }
    const days = [...planned.values()];
    const seconds = (day: MobilePlannedDay) => measureStructure(day.structure!, day.kind, pacesFromZones(input.prescription)).durationSeconds;
    const total = days.reduce((sum, day) => sum + seconds(day), 0);
    const easySeconds = days.filter(day => day.kind === "easy").reduce((sum, day) => sum + seconds(day), 0);
    if (qualityCount > 0 && total > 0 && easySeconds / total < input.easyDurationFloorFraction) continue;
    return dates.map(localDate => planned.get(localDate) ?? {
      localDate, kind: "rest", distanceKm: null, structure: null,
      reason: "完整常规课预算不足；不切碎剩余建议量。受控追加尚未启用。"
    });
  }
  return [];
}
