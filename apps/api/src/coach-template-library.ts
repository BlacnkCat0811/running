import type { CoachTrainingMode, MobilePlannedDay, MobileSessionKind, MobileSessionStructure } from "@rai/api-contracts";
import { buildSessionStructure, type CoachZonePrescription } from "./mobile-coach.js";
import { assessSessionDose, buildCompleteEasyStructure } from "./coach-session-dose.js";
import type { PeriodizationPhase } from "./plan-periodization.js";
import { normalizeSessionStructure } from "./session-structure.js";

export const COACH_TEMPLATE_LIBRARY_VERSION = "rai-coach-template-library-v1";
export type CoachIntent = "easy" | "recovery" | "aerobic_endurance" | "long_aerobic" | "threshold" | "interval" | "fartlek";
export interface CoachTemplateChoice {
  id: CoachIntent;
  kind: MobileSessionKind;
  structure: MobileSessionStructure;
  distanceUpperKm: number;
  /** Upper duration is unknown when a distance step's slow pace bound is open. */
  durationSeconds: number | null;
  quality: boolean;
  reasons: string[];
}

/** Finite server-side templates. Slow fartlek steps are explicitly recovery,
 * so existing measurement, HR conversion and export preserve their easy target. */
export function coachTemplateCandidates(input: {
  date: string;
  mode: CoachTrainingMode;
  phase: PeriodizationPhase | null;
  distance: "five_k" | "ten_k" | "half_marathon" | null;
  zones: CoachZonePrescription | null;
  calibrated: boolean;
  qualityAllowed: boolean;
  extension: boolean;
  availableSeconds: number | null;
  longestPreviousRunKm: number;
  longRunCapKm: number;
  longDay: boolean;
  recentQualityKinds: readonly MobileSessionKind[];
}): { candidates: CoachTemplateChoice[]; rejected: Array<{ id: CoachIntent; reasons: string[] }> } {
  const easy = buildCompleteEasyStructure("easy", input.zones);
  const continuous = (seconds: number): MobileSessionStructure => ({
    ...easy, blocks: [{ iterations: 1, steps: [{ ...easy.blocks[0]!.steps[0]!,
      goal: { type: "time", seconds: seconds - 600 } }] }]
  });
  const interval = buildSessionStructure("interval", input.zones)!;
  const fartlek: MobileSessionStructure = {
    ...interval, blocks: [{ iterations: 8, steps: [
      { ...interval.blocks[0]!.steps[0]!, goal: { type: "time", seconds: 120 } },
      { purpose: "recovery", goal: { type: "time", seconds: 60 }, alert: easy.blocks[0]!.steps[0]!.alert }
    ] }]
  };
  const templates: Array<{ id: CoachIntent; kind: MobileSessionKind; structure: MobileSessionStructure }> = [
    { id: "easy", kind: "easy", structure: easy },
    { id: "recovery", kind: "recovery", structure: easy },
    { id: "aerobic_endurance", kind: "easy", structure: continuous(2400) },
    { id: "long_aerobic", kind: "long_run", structure: continuous(3600) },
    { id: "threshold", kind: "tempo", structure: buildSessionStructure("tempo", input.zones)! },
    { id: "interval", kind: "interval", structure: interval },
    { id: "fartlek", kind: "interval", structure: fartlek }
  ];
  const candidates: CoachTemplateChoice[] = [], rejected: Array<{ id: CoachIntent; reasons: string[] }> = [];
  for (const template of templates) {
    // Measure and authorize the exact representation the shared store/device
    // will retain, including integer target bounds and goal normalization.
    template.structure = normalizeSessionStructure(template.structure)!;
    const quality = template.kind === "tempo" || template.kind === "interval";
    const dose = assessSessionDose({ ...template, zones: input.zones,
      availableSeconds: input.availableSeconds, allowColdStartEstimate: !quality && !input.extension });
    const reasons = [...dose.reasonCodes];
    if (input.extension && template.id !== "easy") reasons.push("extension_easy_only");
    if (quality && (!input.calibrated || !input.qualityAllowed || input.phase === "base" && template.kind === "interval"))
      reasons.push("quality_not_eligible");
    const distanceUpperKm = dose.distanceKm?.upper ?? null;
    if (template.kind === "long_run" && (!input.calibrated || !input.longDay || distanceUpperKm === null ||
      distanceUpperKm > Math.min(input.longRunCapKm, input.longestPreviousRunKm * 1.1)))
      reasons.push("long_run_history_or_cap");
    // A candidate whose km cost cannot be proven is not offered: the weekly
    // envelope, the long-run cap and the device reservation all spend km.
    if (distanceUpperKm === null) {
      rejected.push({ id: template.id, reasons: [...reasons, "dose_distance_upper_unproven"] });
      continue;
    }
    if (dose.status !== "feasible" || reasons.length) { rejected.push({ id: template.id, reasons }); continue; }
    candidates.push({ ...template, quality, distanceUpperKm,
      durationSeconds: dose.durationSeconds?.upper ?? null, reasons: ["template_eligible", COACH_TEMPLATE_LIBRARY_VERSION] });
  }
  const preferredQuality: CoachIntent = input.distance === "half_marathon" || input.distance === "ten_k" ? "threshold" :
    input.distance === "five_k" ? "interval" :
      input.recentQualityKinds.at(-1) === "interval" ? "threshold" :
        input.recentQualityKinds.at(-1) === "tempo" ? "fartlek" : "interval";
  const order: CoachIntent[] = input.qualityAllowed
    ? [preferredQuality, "threshold", "interval", "fartlek", "long_aerobic", "aerobic_endurance", "easy", "recovery"]
    : ["long_aerobic", "aerobic_endurance", "easy", "recovery", preferredQuality];
  candidates.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || a.id.localeCompare(b.id));
  return { candidates, rejected };
}

export function templateDay(date: string, choice: CoachTemplateChoice): MobilePlannedDay {
  // An open slow pace bound leaves the upper duration unknown; say so instead of
  // turning the unknown into a made-up minute count.
  const duration = choice.durationSeconds === null ? "整课时长上限未定（缺少慢端配速证据）" :
    `整课 ${choice.durationSeconds / 60} 分钟`;
  return { localDate: date, kind: choice.kind, structure: choice.structure, distanceKm: choice.distanceUpperKm,
    reason: `规则模板 ${choice.id}；${duration}。` };
}
