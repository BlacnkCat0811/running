import assert from "node:assert/strict";
import type { CoachLoopRuntimeResponse } from "@rai/api-contracts";
import { coachRuntimeFixture, runtimeReplaySettings as settings } from "./coach-runtime-fixtures.mjs";
import { COACH_RUNTIME_POLICY_HASH } from "../apps/api/src/coach-loop-runtime.js";
import { shiftCoachDate } from "../apps/api/src/coach-loop-facts.js";
import { replayRun } from "./coach-replay-scenarios.mjs";
import { digest } from "../apps/api/src/plan-digest.js";
import { assessSessionDose } from "../apps/api/src/coach-session-dose.js";
import { coachTemplateCandidates } from "../apps/api/src/coach-template-library.js";
import { buildSubjectiveFeedback } from "../apps/api/src/coach-subjective-feedback.js";

type Fixture = ReturnType<typeof coachRuntimeFixture>;
type Step = { id: string; date: string; outputHash: string };
type Case = { id: string; run: (f: Fixture, check: (id: string, output: CoachLoopRuntimeResponse, assertion: () => void) => void) => void };
function at(f: Fixture, date: string) {
  f.facts.date = date; f.facts.asOf = `${date}T04:00:00Z`;
  f.facts.inputs.today.today.localDate = date;
  f.facts.factsHash = digest({ date, facts: f.facts.facts, feedback: f.facts.feedback,
    zones: f.facts.inputs.prescription, flags: f.facts.inputs.today.injuryFlags });
}
function enable(f: Fixture, extra: Partial<typeof settings> = {}) {
  return f.runtime.command(f.command("enable", { operationId: "10000000-0000-4000-8000-000000000001",
    settings: { ...settings, ...extra }, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
}
function refresh(f: Fixture, index: number) {
  return f.runtime.command(f.command("refresh", {
    operationId: `10000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}` }));
}

const cases: Case[] = [
  { id: "R01-runtime-cold-eight-weeks", run(f, check) {
    f.facts.facts = []; f.facts.historyCoverageFrom = null;
    f.facts.inputs.weeklyVolumeBaselineKm = 5;
    f.facts.inputs.recentWeeklyKm = 0; f.facts.inputs.previousWeekDistanceKm = 0;
    f.facts.inputs.today.recommendation.basis = "insufficient_training_history";
    f.facts.inputs.today.calibration.status = "not_started";
    at(f, "2026-09-07"); enable(f);
    for (let week = 0; week < 8; week++) {
      const date = shiftCoachDate("2026-09-07", week * 7);
      if (week > 0) f.facts.facts.push(replayRun(`external-${week}`, shiftCoachDate(date, -2), 3));
      at(f, date);
      const result = refresh(f, week);
      check("AC0-07", result, () => {
        assert.ok(result.days.every(row => !["tempo", "interval"].includes(row.day.kind)));
        assert.equal(result.volumePolicy.weeklyProtectionKm, 5);
      });
    }
  } },
  { id: "R04-runtime-no-debt-after-gap", run(f, check) {
    enable(f);
    for (const [i, date] of ["2026-10-12", "2026-10-19", "2026-10-26"].entries()) {
      at(f, date); const out = refresh(f, i);
      check("AC3-06", out, () => {
        assert.equal(out.volumePolicy.actualWeekKm, 0);
        assert.ok(out.days.every(row => !/补课债务/.test(row.day.reason ?? "")));
      });
    }
  } },
  { id: "R07-runtime-distance-templates", run(f, check) {
    const out = enable(f);
    for (const distance of ["five_k", "ten_k", "half_marathon"] as const) check(`AC4-01-${distance}`, out, () => {
      const choices = coachTemplateCandidates({ date: f.facts.date, mode: "race_preparation", phase: "build", distance,
        zones: f.facts.inputs.prescription, calibrated: true, qualityAllowed: true, extension: false,
        availableSeconds: null, longestPreviousRunKm: 20, longRunCapKm: 20, longDay: false, recentQualityKinds: [] });
      assert.equal(choices.candidates[0]?.id, distance === "five_k" ? "interval" : "threshold");
    });
  } },
  { id: "R09-runtime-lock-and-safety", run(f, check) {
    const enabled = enable(f);
    // An explicit feedback restriction changes effective execution on GET,
    // not the protected stored prescription or historical revision.
    const revision = f.store.read().revision;
    f.facts.feedback = [buildSubjectiveFeedback({ id: "stop", revision: 1, scope: { athleteId: "synthetic", datasetEpoch: "synthetic-v1" },
      fields: { phase: "pre_run", workoutId: null, fatigue: null, soreness: null, discomfort: null, requestedAction: "rest",
        interruptionReason: null, replacementReason: null, rpeOverrideRef: null, observedAt: f.facts.asOf },
      recordedAt: f.facts.asOf, availableAt: f.facts.asOf, knownWorkoutIds: [], knownRpeOverrides: [] })!];
    const out = f.runtime.read();
    check("AC3-04-effective", out, () => { assert.equal(out.today.executable, false); assert.equal(f.store.read().revision, revision);
      assert.deepEqual(f.store.read().weekPlan, enabled.goals.weekPlan); });
  } },
  { id: "R12-runtime-availability", run(f, check) {
    const out = enable(f, { availabilityMinutesByWeekday: { "1":20,"2":20,"3":20,"4":20,"5":20,"6":20,"7":20 } });
    check("AC4-03", out, () => assert.ok(out.days.every(row => !row.executable)));
  } },
  { id: "R13-runtime-daily-without-programme", run(f, check) {
    f.facts.facts = f.facts.facts.filter(row => row.id !== "monday-20");
    enable(f, { runningDays: [4], longRunDays: [] });
    for (let week = 0; week < 5; week++) {
      at(f, shiftCoachDate("2026-10-08", week * 7));
      const out = refresh(f, week);
      check("AC0-01", out, () => { assert.equal(out.settings?.mode, "daily_adaptive"); assert.equal(out.executionPolicy.phase, null);
        assert.equal(out.goals.runCoach, null); });
    }
  } },
  { id: "R15-runtime-final-dose", run(f, check) {
    const out = enable(f);
    check("AC0-06", out, () => {
      for (const row of out.days.filter(row => row.executable)) {
        const dose = assessSessionDose({ kind: row.day.kind, structure: row.day.structure ?? null, zones: f.facts.inputs.prescription });
        assert.equal(dose.status, "feasible"); assert.ok((dose.durationSeconds?.lower ?? Number.NaN) >= 1800);
      }
    });
  } },
  { id: "R16-runtime-lifecycle", run(f, check) {
    enable(f);
    const paused = f.runtime.command(f.command("pause"));
    check("AC0-08-pause", paused, () => assert.ok(paused.days.every(row => !row.executable)));
    at(f, "2026-10-12");
    check("AC0-08-paused-cross-week", refresh(f, 1), () => assert.equal(f.runtime.read().settings?.status, "paused"));
    f.runtime.command(f.command("resume"));
    const ended = f.runtime.command(f.command("end"));
    check("AC0-08-ended", ended, () => assert.ok(ended.days.every(row => !row.executable)));
    at(f, "2026-10-19");
    check("AC0-08-not-restarted", refresh(f, 2), () => assert.equal(f.runtime.read().settings?.status, "ended"));
  } },
  { id: "R17-runtime-read-command-coherence", run(f, check) {
    const out = enable(f);
    check("AC0-02", out, () => {
      assert.equal(out.today.decisionRef, f.runtime.read().today.decisionRef);
      assert.deepEqual(out.today.day, f.runtime.read().days.find(row => row.day.localDate === f.facts.date)?.day);
      assert.equal(refresh(f, 1).revision, out.revision);
    });
  } },
  { id: "R18-runtime-template-whitelist", run(f, check) {
    const out = enable(f);
    check("AC4-10", out, () => {
      assert.equal(out.days.find(row => row.day.localDate === f.facts.date)?.templateId, "easy");
      assert.equal(out.volumePolicy.extension.authorizedDecisionRef, out.today.decisionRef);
    });
  } },
  { id: "R20-runtime-cross-week-repeated-refresh", run(f, check) {
    const out = enable(f);
    const h = out.volumePolicy.weeklyProtectionKm;
    check("AC0-15", refresh(f, 1), () => assert.equal(f.store.read().revision, out.revision));
    f.facts.facts.push(replayRun("external-completion", "2026-10-08", 5)); at(f, "2026-10-09");
    const consumed = refresh(f, 2);
    check("AC0-15-anchor", consumed, () => { assert.equal(consumed.volumePolicy.weeklyProtectionKm, h); assert.equal(consumed.today.executable, false); });
    at(f, "2026-10-12");
    const next = refresh(f, 3);
    check("AC0-16", next, () => assert.ok(next.volumePolicy.constraints.some(row => row.code === "rolling_7_days" && row.actualKm > 0)));
  } },
  { id: "R22-runtime-failure-atomicity", run(f, check) {
    const out = enable(f), revision = out.revision, original = f.store.appendCoachLoopReceipt.bind(f.store);
    at(f, "2026-10-12");
    f.store.appendCoachLoopReceipt = () => { throw new Error("injected publication failure"); };
    assert.throws(() => refresh(f, 1), /injected/);
    f.store.appendCoachLoopReceipt = original;
    check("AC0-22", f.runtime.read(), () => assert.equal(f.store.read().revision, revision));
    check("AC0-22-retry", refresh(f, 1), () => assert.ok(f.store.read().revision >= revision));
  } }
];

export function coachRuntimeReplays() {
  return cases.map(scenario => {
    const execute = () => {
      const fixture = coachRuntimeFixture(), checkpoints: Step[] = [];
      try {
        scenario.run(fixture, (id, output, assertion) => {
          assertion();
          checkpoints.push({ id, date: output.asOf, outputHash: digest({
            days: output.days, settings: output.settings, volume: output.volumePolicy, revision: output.revision
          }) });
        });
        return checkpoints;
      } finally { fixture.close(); }
    };
    try {
      const first = execute(), second = execute();
      assert.deepEqual(second, first, `${scenario.id}: replay must be deterministic`);
      return { id: scenario.id, status: "passed" as const, scope: "synthetic_facts_real_sqlite_publication",
        checkpoints: first, outputHash: digest(first) };
    } catch (error) {
      return { id: scenario.id, status: "failed" as const, scope: "synthetic_facts_real_sqlite_publication",
        error: error instanceof Error ? error.message : String(error), checkpoints: [] as Step[], outputHash: null };
    }
  });
}
