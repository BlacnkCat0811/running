import assert from "node:assert/strict";
import type { MobilePlannedDay, MobileRaceTarget } from "@rai/api-contracts";
import { buildCoachLoopCandidate } from "../apps/api/src/coach-loop-decision.js";
import { assessSessionDose, buildCompleteEasyStructure } from "../apps/api/src/coach-session-dose.js";
import { coachTemplateCandidates, COACH_TEMPLATE_LIBRARY_VERSION } from "../apps/api/src/coach-template-library.js";
import { COACH_POLICY_MANIFEST } from "../apps/api/src/coach-loop-policy.js";
import { assessWorkoutExecution, assessWorkoutExecutionBatch } from "../apps/api/src/coach-execution-assessment.js";
import { shiftCoachDate, type CoachReservation } from "../apps/api/src/coach-loop-facts.js";
import { executionPolicyContext } from "../apps/api/src/race-plan-policy.js";
import { applyRacePlanPolicy } from "../apps/api/src/weekly-plan-validate.js";
import { buildSessionStructure, measureStructure, pacesFromZones, roundKm } from "../apps/api/src/mobile-coach.js";
import { coachReplayInput, replayRun } from "./coach-replay-scenarios.mjs";
import { executionFixture, EXECUTION_AS_OF } from "./coach-execution-fixtures.mjs";
import { replayAcceptanceCases, type AcceptanceReplayCase } from "./coach-acceptance-trace.mjs";

const boundary = "synthetic_frozen_module_behavior_not_full_requirement_signoff";
const afterTwenty = () => {
  const input = coachReplayInput();
  return { ...input, facts: [...input.facts, replayRun("monday", "2026-10-05", 20)] };
};
const slot = (date: string, changes: Partial<CoachReservation> = {}): CoachReservation => ({
  slotId: `slot:${date}`, localDate: date, allocation: "extension", distanceKm: 5,
  approvedAt: `${date}T00:00:00Z`, status: "pending", matchedWorkoutIds: [],
  deviceScheduleUnresolved: false, ...changes
});
const templateInput = () => ({
  date: "2026-10-08", mode: "daily_adaptive" as const, phase: null, distance: null,
  zones: coachReplayInput().zones, calibrated: true, qualityAllowed: true, extension: false,
  availableSeconds: null, longestPreviousRunKm: 20, longRunCapKm: 20, longDay: true,
  recentQualityKinds: [] as Array<"tempo" | "interval">
});

/** Evaluator-owned frozen pre-O1 protection algorithm, with the same dose and
 * capacity versions on both sides. This is not a checkout of a historic release
 * nor an O0 short-dose/S-H old/new comparison. */
function frozenLegacyProtection(day: MobilePlannedDay, target: MobileRaceTarget, weeklyKm: number): MobilePlannedDay {
  const days = Math.round((Date.parse(`${target.date}T00:00:00Z`) -
    Date.parse(`${day.localDate}T00:00:00Z`)) / 86400000);
  if (days === 0 && day.kind !== "rest")
    return { ...day, kind: "rest", distanceKm: null, structure: null, reason: "比赛日留白；不等于比赛已完成。" };
  if (days < 1 || days > 14 || day.kind === "rest") return day;
  const zones = coachReplayInput().zones, paces = pacesFromZones(zones);
  const ceiling = Math.max(1, Math.round(Math.min(10, weeklyKm / 7 * .7) * 10) / 10);
  const measured = day.structure ? measureStructure(day.structure, day.kind, paces).distanceKm : day.distanceKm ?? 0;
  if (["easy", "recovery"].includes(day.kind) && measured <= ceiling + .05) return day;
  const structure = buildSessionStructure("easy", zones, { targetDistanceKm: Math.min(measured || ceiling, ceiling) });
  const distanceKm = structure ? roundKm(measureStructure(structure, "easy", paces).distanceKm) : null;
  return distanceKm != null && distanceKm > ceiling + .1
    ? { ...day, kind: "rest", distanceKm: null, structure: null, reason: "赛前减量，保留恢复。" }
    : { ...day, kind: "easy", structure, distanceKm, reason: "赛前两周减量；不增加强度或最长距离。" };
}

const cases: AcceptanceReplayCase[] = [
  { id: "R14-acceptance-suggestion-and-hard-space", evidenceBoundary: boundary, execute(check) {
    for (const actual of [13, 17.4, 20, 22, 27]) {
      const input = afterTwenty();
      input.facts[input.facts.length - 1] = replayRun("monday", "2026-10-05", actual);
      const out = buildCoachLoopCandidate(input);
      check("AC0-04", `remaining-${actual}`, input, out, () => {
        assert.equal(out.volumePolicy.actualWeekKm, actual);
        assert.equal(out.allocation, actual <= 13 ? "regular" : actual <= 20 ? "extension" : "rest");
        if (out.kind !== "rest") assert.equal(out.dose.durationSeconds?.lower, 1800);
        else assert.ok(out.reasons.some(r => r.code === "weekly_protection_reached"));
      });
    }
    for (const historical of [10, 12.5]) {
      const input = afterTwenty();
      input.facts = input.facts.map(run => ({ ...run, distanceKm: run.id === "monday" ? 22 :
        run.id.startsWith("history") ? historical : run.distanceKm }));
      input.absoluteProtectionKm = 32;
      const out = buildCoachLoopCandidate(input);
      check("AC0-14", `actual22-historical-${historical}`, input, out, () => {
        assert.equal(out.volumePolicy.weeklyProtectionKm, historical === 10 ? 26 : 32);
        assert.equal(out.allocation, historical === 10 ? "rest" : "extension");
        assert.equal(out.volumePolicy.suggestedWeeklyKm, 20);
      });
    }
  } },
  { id: "R15-acceptance-second-and-dose-boundaries", evidenceBoundary: boundary, execute(check) {
    const zones = coachReplayInput().zones;
    for (const seconds of [1799, 1800, 1801]) {
      const structure = buildCompleteEasyStructure("easy", zones);
      structure.blocks[0]!.steps[0]!.goal = { type: "time", seconds: seconds - 600 };
      const input = { kind: "easy" as const, structure, zones };
      const out = assessSessionDose(input);
      check("AC0-05", `duration-${seconds}`, input, out, () => {
        assert.equal(out.status, seconds < 1800 ? "not_feasible" : "feasible");
        assert.equal(out.durationSeconds?.lower, seconds);
        assert.ok(Math.abs((out.distanceKm?.upper ?? Number.NaN) - seconds / 360) < 1e-9);
        assert.ok(Math.abs((out.distanceKm?.lower ?? Number.NaN) - seconds / 420) < 1e-9);
      });
    }
    for (const availableSeconds of [1200, 1800]) {
      const input = { kind: "easy" as const, structure: buildCompleteEasyStructure("easy", zones), zones, availableSeconds };
      const out = assessSessionDose(input);
      check("AC0-05", `availability-${availableSeconds}`, input, out,
        () => assert.equal(out.status, availableSeconds === 1800 ? "feasible" : "not_feasible"));
    }
    const structure = buildCompleteEasyStructure("easy", null);
    structure.blocks[0]!.steps[0]!.goal = { type: "open" };
    const unknown = assessSessionDose({ kind: "easy", structure, zones: null });
    check("AC0-05", "open-time-is-unknown", structure, unknown,
      () => assert.equal(unknown.status, "not_assessable"));
  } },
  { id: "R20-acceptance-slot-occupancy", evidenceBoundary: boundary, execute(check) {
    for (const status of ["pending", "completed", "cancelled", "revoked"] as const) {
      for (const count of [0, 1, 2]) {
        const input = { ...afterTwenty(), reservations: ["2026-10-04", "2026-10-06"].slice(0, count)
          .map(date => slot(date, { status })) };
        // Ample H isolates the count gate from the separately tested km gate.
        input.facts = input.facts.map(run => run.id.startsWith("history") ? { ...run, distanceKm: 20 } : run);
        const out = buildCoachLoopCandidate(input), occupied = ["pending", "completed"].includes(status) ? count : 0;
        check("AC0-17", `${status}-${count}`, input, out, () => {
          assert.equal(out.volumePolicy.extension.approvedSessionsInRolling7Days, occupied);
          assert.equal(out.allocation, occupied === 2 ? "rest" : "extension");
          if (occupied === 2) assert.ok(out.reasons.some(r => r.code === "extension_count_limit"));
        });
      }
    }
    const input = { ...afterTwenty(), reservations: ["2026-10-04", "2026-10-06"]
      .map(date => slot(date, { status: "cancelled", deviceScheduleUnresolved: true })) };
    const out = buildCoachLoopCandidate(input);
    check("AC0-17", "unresolved-device-still-occupies", input, out, () => {
      assert.equal(out.volumePolicy.extension.approvedSessionsInRolling7Days, 2);
      assert.equal(out.volumePolicy.extensionReservedKm, 5);
      assert.equal(out.allocation, "rest");
    });
    const completed = replayRun("completed", "2026-10-07", 5);
    const matched = { ...afterTwenty(), facts: [...afterTwenty().facts, completed],
      reservations: [slot("2026-10-07", { status: "completed", matchedWorkoutIds: [completed.id] })] };
    const replaced = buildCoachLoopCandidate(matched);
    check("AC0-17", "completion-replaces-volume-not-count", matched, replaced, () => {
      assert.equal(replaced.volumePolicy.actualWeekKm, 25);
      assert.equal(replaced.volumePolicy.extensionReservedKm, 0);
      assert.equal(replaced.volumePolicy.extension.approvedSessionsInRolling7Days, 1);
    });
  } },
  { id: "R21-acceptance-critical-evidence", evidenceBoundary: boundary, execute(check) {
    for (const variant of ["sufficient", "coverage", "dates", "load", "sync"] as const) {
      const input = afterTwenty();
      if (variant === "coverage") input.historyCoverageFrom = null;
      if (variant === "dates") input.facts = input.facts.filter(r => !r.id.endsWith("-1"));
      if (variant === "load") input.loadHistorySufficient = false;
      if (variant === "sync") input.syncStatus = "failed";
      const out = buildCoachLoopCandidate(input);
      check("AC0-18", variant, input, out, () => {
        assert.equal(out.allocation, variant === "sufficient" ? "extension" : "rest");
        if (variant !== "sufficient") assert.ok(out.reasons.some(r => r.code === "extension_evidence_insufficient"));
      });
    }
  } },
  { id: "R19-acceptance-race-extension-gates", evidenceBoundary: boundary, execute(check) {
    for (const distance of ["five_k", "ten_k", "half_marathon", "unsupported"] as const) {
      for (const days of [42, 14, 7, 0]) {
        const raceDate = shiftCoachDate("2026-10-08", days);
        const input = { ...afterTwenty(), mode: "race_preparation" as const, raceDate,
          raceTarget: distance === "unsupported" ? null : { date: raceDate, distance, targetPaceSecondsPerKm: null } };
        const out = buildCoachLoopCandidate(input);
        check("AC0-20", `${distance}-${days}`, input, out, () => {
          assert.equal(out.allocation, distance !== "unsupported" && days === 42 ? "extension" : "rest");
          assert.ok(["easy", "rest"].includes(out.kind));
          if (out.allocation === "rest") assert.ok(out.reasons.some(r => r.code === "pre_race_extension_blocked"));
        });
      }
    }
  } },
  { id: "R03-acceptance-phase-and-frozen-protection", evidenceBoundary:
    "frozen_pre_O1_algorithm_same_dose_capacity_not_historical_release_checkout", execute(check) {
    // Fixture-owned E02 boundaries, deliberately not imported from production.
    const tables = { five_k: { build: 2, taper: 1 }, ten_k: { build: 3, taper: 2 },
      half_marathon: { build: 4, taper: 2 } } as const;
    for (const distance of ["five_k", "ten_k", "half_marathon"] as const) {
      const target = { date: "2026-11-01", distance, targetPaceSecondsPerKm: null };
      const table = tables[distance];
      for (let week = -1; week <= 9; week++) {
        const monday = shiftCoachDate("2026-10-26", -week * 7);
        const expected = week < 0 ? "past" : week === 0 ? "race_week" : week <= table.taper ? "taper" :
          week === table.taper + 1 ? "peak" : week <= table.taper + 1 + table.build ? "build" : "base";
        for (const offset of [0, 1, 6]) {
          const localDate = shiftCoachDate(monday, offset);
          const out = executionPolicyContext({ localDate, raceTarget: target, weeklyDistanceKm: 60 });
          check("AC1-01", `${distance}-${week}-${offset}`, { localDate, target }, out,
            () => assert.equal(out.phase, expected));
        }
      }
      for (const days of [35, 15, 14, 13, 1, 0, -1, -7]) for (const kind of ["easy", "interval", "long_run"] as const) {
        const day: MobilePlannedDay = { localDate: shiftCoachDate(target.date, -days), kind, distanceKm: 8,
          structure: buildSessionStructure(kind, coachReplayInput().zones, { targetDistanceKm: 8 }), reason: "frozen" };
        const safe = applyRacePlanPolicy([day], target, 60, coachReplayInput().zones);
        check("AC1-05", `${distance}-${days}-${kind}-idempotent`, { day, target, weeklyKm: 60 }, safe,
          () => assert.deepEqual(applyRacePlanPolicy(safe, target, 60, coachReplayInput().zones), safe));
        const legacy = frozenLegacyProtection(day, target, 60);
        check("AC1-06", `${distance}-${days}-${kind}-same-dose`, { day, target, weeklyKm: 60 }, { safe, legacy },
          () => assert.deepEqual(safe, [legacy]));
      }
    }
  } },
  { id: "R02-acceptance-execution-tolerance-and-association", evidenceBoundary: boundary, execute(check) {
    const fixture = executionFixture();
    const evaluate = (workout = fixture.workout) => assessWorkoutExecution({ asOf: EXECUTION_AS_OF,
      prescription: fixture.prescription, workouts: [workout], associations: [fixture.association] });
    const light = { ...fixture.workout, signalIntervals: fixture.workout.signalIntervals.map(s => ({ ...s, value: 390 })) };
    const out = evaluate(light);
    check("AC2-01", "light-replacement-not-quality", { ...fixture, workout: light }, out, () => {
      assert.equal(out.observation, "observed"); assert.equal(out.stimulus.status, "too_easy");
      assert.equal(out.completion, "known_not_met"); assert.ok(out.reasons.length);
    });
    for (const fraction of [.899, .9]) {
      const workout = { ...fixture.workout, segments: fixture.workout.segments.map(s =>
        s.purpose === "work" ? { ...s, distanceMeters: 800 * fraction } : s) };
      const result = evaluate(workout);
      check("AC2-05", `dose-${fraction}`, workout, result,
        () => assert.equal(result.dose.status, fraction === .9 ? "met" : "partial"));
    }
    for (const fraction of [.799, .8]) {
      const workout = { ...fixture.workout, signalIntervals: fixture.workout.signalIntervals.map(s =>
        ({ ...s, durationSeconds: s.durationSeconds * fraction })) };
      const result = evaluate(workout);
      check("AC2-05", `coverage-${fraction}`, workout, result, () => {
        assert.equal(result.stimulus.status, fraction === .8 ? "matched" : "not_assessable");
        assert.equal(result.completion, fraction === .8 ? "confirmed" : "unconfirmed");
      });
    }
    const recovery = executionFixture("recovery");
    recovery.workout.signalIntervals = recovery.workout.signalIntervals.map(s => ({ ...s, value: 250 }));
    const hard = assessWorkoutExecution({ asOf: EXECUTION_AS_OF, prescription: recovery.prescription,
      workouts: [recovery.workout], associations: [recovery.association] });
    check("AC2-06", "faster-recovery-is-too-hard", recovery, hard, () => {
      assert.equal(hard.dose.status, "met"); assert.equal(hard.stimulus.status, "too_hard");
      assert.equal(hard.completion, "known_not_met");
    });
    const input = { asOf: EXECUTION_AS_OF, prescription: fixture.prescription,
      workouts: [fixture.workout, { ...fixture.workout, id: "other-run" }], associations: [fixture.association] };
    const single = assessWorkoutExecution(input);
    check("AC2-07", "one-binding-does-not-pool", input, single, () => {
      assert.deepEqual(single.workoutIds, [fixture.workout.id]); assert.equal(single.dose.verifiedReps, 4);
    });
    const batchInput = { ...input, prescriptions: [fixture.prescription,
      { ...fixture.prescription, day: { ...fixture.prescription.day, localDate: "2026-10-07" } }] };
    const batch = assessWorkoutExecutionBatch(batchInput);
    check("AC2-07", "same-run-cannot-discharge-two-obligations", batchInput, batch,
      () => assert.ok(batch.every(r => r.association.status === "ambiguous" && r.completion === "unconfirmed")));
  } },
  { id: "R18-acceptance-substantive-template-library", evidenceBoundary: boundary,
    policyManifest: { ...COACH_POLICY_MANIFEST, templateLibraryVersion: COACH_TEMPLATE_LIBRARY_VERSION }, execute(check) {
    const input = templateInput(), choices = coachTemplateCandidates(input);
    for (const weak of [{ calibrated: false }, { qualityAllowed: false }, { zones: null }]) {
      const variant = { ...input, ...weak }, out = coachTemplateCandidates(variant);
      check("AC4-02", `weak-${Object.keys(weak)[0]}`, variant, out,
        () => assert.ok(out.candidates.every(c => !c.quality)));
    }
    for (const [recentQualityKinds, expected] of [[[], "interval"], [["interval"], "threshold"], [["tempo"], "fartlek"]] as const) {
      const variant = { ...input, recentQualityKinds }, out = coachTemplateCandidates(variant);
      check("AC4-08", `recent-${recentQualityKinds.join() || "none"}`, variant, out,
        () => assert.equal(out.candidates[0]?.id, expected));
    }
    const long = coachTemplateCandidates({ ...input, qualityAllowed: false });
    check("AC4-08", "eligible-long-day", { ...input, qualityAllowed: false }, long,
      () => assert.equal(long.candidates[0]?.id, "long_aerobic"));
    const by = (id: string) => choices.candidates.find(c => c.id === id)!;
    check("AC4-09", "dose-and-steps-not-title-only", input, choices, () => {
      assert.equal(by("easy").durationSeconds, 1800);
      assert.equal(by("aerobic_endurance").durationSeconds, 2400);
      assert.equal(by("long_aerobic").durationSeconds, 3600);
      assert.notDeepEqual(by("fartlek").structure, by("interval").structure);
      assert.equal(by("fartlek").structure.blocks[0]!.steps[1]!.purpose, "recovery");
      assert.ok(!coachTemplateCandidates({ ...input, longestPreviousRunKm: 3 }).candidates.some(c => c.kind === "long_run"));
    });
    const short = coachTemplateCandidates({ ...input, availableSeconds: 1800 });
    check("AC4-05", "quality-cannot-fit-full-dose", { ...input, availableSeconds: 1800 }, short, () => {
      assert.ok(short.candidates.length > 0);
      assert.ok(short.candidates.every(c => !c.quality));
      assert.ok(short.rejected.find(c => c.id === "interval")?.reasons.includes("available_time_exceeded"));
      assert.ok(short.candidates.every(c => c.reasons.includes("template_eligible")));
    });
    const padded = structuredClone(by("interval").structure);
    padded.blocks[0]!.iterations = 1;
    padded.warmup!.goal = { type: "time", seconds: 1500 };
    const dose = assessSessionDose({ kind: "interval", structure: padded, zones: input.zones });
    check("AC4-11", "padding-does-not-rescue-interval", padded, dose, () => {
      assert.ok((dose.durationSeconds?.lower ?? Number.NaN) >= 1800);
      assert.equal(dose.status, "not_feasible");
      assert.ok(dose.reasonCodes.includes("minimum_work_dose_not_met"));
    });
  } }
];

export function coachAcceptanceReplays() { return replayAcceptanceCases(cases); }
