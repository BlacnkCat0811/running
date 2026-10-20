import assert from "node:assert/strict";
import test from "node:test";
import { coachTemplateCandidates } from "../src/coach-template-library.js";
import { runCoachSessionTargets } from "../src/run-coach-policy.js";
import { assessSessionDose } from "../src/coach-session-dose.js";

const zones = { easyPaceLower: 360, easyPaceUpper: 390, easyHrLower: 120, easyHrUpper: 150,
  thresholdPaceLower: 270, thresholdPaceUpper: 300, thresholdHrLower: 160, thresholdHrUpper: 175,
  intervalPaceLower: 240, intervalPaceUpper: 265 };
const input = { date: "2026-10-08", mode: "daily_adaptive" as const, phase: null, distance: null,
  zones, calibrated: true, qualityAllowed: true, extension: false, availableSeconds: null,
  longestPreviousRunKm: 15, longRunCapKm: 15, longDay: true, recentQualityKinds: [] };
test("O4 templates have actual dose differences, minimum full sessions and mixed fartlek targets", () => {
  const { candidates } = coachTemplateCandidates(input);
  assert.equal(candidates.length, 7);
  const by = (id: string) => candidates.find(c => c.id === id)!;
  /** Fixed zones, so every upper duration is provable; the helper keeps that explicit. */
  const provenDuration = (id: string): number => {
    const value = by(id).durationSeconds;
    assert.notEqual(value, null, `${id} must have a provable upper duration with closed zones`);
    return value!;
  };
  assert.ok(provenDuration("aerobic_endurance") > provenDuration("easy"));
  assert.ok(provenDuration("long_aerobic") > provenDuration("aerobic_endurance"));
  assert.notDeepEqual(by("fartlek").structure, by("interval").structure);
  const hr = runCoachSessionTargets(by("fartlek"), { targetType: "heart_rate" }, zones);
  assert.equal(hr.structure.blocks[0]!.steps[0]!.alert?.upper, 175);
  assert.equal(hr.structure.blocks[0]!.steps[1]!.alert?.upper, 150);
  assert.equal(assessSessionDose({ ...hr, zones }).status, "feasible");
});
test("O4 gates prohibit quality without eligibility and extensions are only complete easy", () => {
  assert.deepEqual(coachTemplateCandidates({ ...input, extension: true }).candidates.map(c => c.id), ["easy"]);
  assert.equal(coachTemplateCandidates({ ...input, availableSeconds: 1200 }).candidates.length, 0);
  assert.equal(coachTemplateCandidates({ ...input, calibrated: false }).candidates.some(c => c.quality || c.kind === "long_run"), false);
  assert.equal(coachTemplateCandidates({ ...input, distance: "half_marathon" }).candidates[0]?.id, "threshold");
});
