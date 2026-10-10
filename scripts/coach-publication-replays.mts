import assert from "node:assert/strict";
import type { CoachLoopCommand, CoachLoopRuntimeResponse, MobileRunCoachConfig } from "@rai/api-contracts";
import { COACH_RUNTIME_POLICY_HASH, COACH_RUNTIME_MANIFEST, validateCoachLoopSettings,
  type CoachRuntimeReceipt } from "../apps/api/src/coach-loop-runtime.js";
import { buildSubjectiveFeedback } from "../apps/api/src/coach-subjective-feedback.js";
import { manualPlanWriteInput } from "../apps/api/src/manual-plan-policy.js";
import { buildCompleteEasyStructure, assessSessionDose } from "../apps/api/src/coach-session-dose.js";
import { shiftCoachDate } from "../apps/api/src/coach-loop-facts.js";
import { digest } from "../apps/api/src/plan-digest.js";
import { coachRuntimeFixture, runtimeReplayScope as scope, runtimeReplaySettings as settings } from "./coach-runtime-fixtures.mjs";
import { replayRun } from "./coach-replay-scenarios.mjs";
import { replayAcceptanceCases, type AcceptanceReplayCase, type AcceptanceCheck } from "./coach-acceptance-trace.mjs";

type Fixture = ReturnType<typeof coachRuntimeFixture>;
const boundary = "synthetic_facts_real_sqlite_control_publication_not_device_or_Fitness_effect";
const operationId = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const enable = (f: Fixture) => f.runtime.command(f.command("enable", {
  settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH, operationId: operationId(1) }));
const refresh = (f: Fixture, index: number) => f.runtime.command(f.command("refresh", { operationId: operationId(index) }));
// Do not hash SQLite wall-clock updatedAt/changedAt; semantic identity includes
// facts, all executable prescriptions, authorization, policy and revision.
const semantic = (out: CoachLoopRuntimeResponse) => ({
  days: out.days, revision: out.revision, factsHash: out.factsHash, volume: out.volumePolicy,
  settings: out.settings, policyHash: out.policyHash, refreshRequired: out.refreshRequired,
  execution: out.executionSummary, feedback: out.feedback
});
const mark = (check: AcceptanceCheck, ac: string, id: string, f: Fixture,
  out: CoachLoopRuntimeResponse, assertion: () => void) =>
  check(ac, id, { facts: f.facts, scope, settings: out.settings }, semantic(out), assertion);
const raceConfig = (days: number): MobileRunCoachConfig => ({
  goal: "time", raceDate: shiftCoachDate("2026-10-08", days), raceDistanceKm: 10, targetTimeSeconds: 3000,
  runningDays: settings.runningDays, longRunDays: settings.longRunDays, targetType: "pace",
  strengthTraining: false
});

const cases: AcceptanceReplayCase[] = [
  { id: "R22-acceptance-publication-read-retry-restart", evidenceBoundary: boundary, execute(check) {
    const f = coachRuntimeFixture();
    try {
      const request = f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH, operationId: operationId(1) });
      const published = f.runtime.command(request);
      const before = digest(f.store.read()), receipts = f.store.coachLoopReceipts(JSON.stringify(scope)).length;
      for (let i = 0; i < 100; i++) {
        const out = f.runtime.read();
        if (i === 99) mark(check, "AC0-12", "100-get-no-business-write", f, out, () => {
          assert.equal(digest(f.store.read()), before); assert.ok(out.today.executable);
          assert.equal(f.store.coachLoopReceipts(JSON.stringify(scope)).length, receipts);
        });
      }
      const refreshed = refresh(f, 2);
      mark(check, "AC3-01", "same-facts-same-revision", f, refreshed, () => {
        assert.equal(refreshed.revision, published.revision);
        assert.equal(f.store.coachLoopReceipts(JSON.stringify(scope)).length, receipts);
      });
      f.restart();
      const retry = f.runtime.command(request);
      mark(check, "AC3-01", "restart-replays-original-operation", f, retry, () => {
        assert.deepEqual(semantic(retry), semantic(published));
        assert.equal(f.store.read().revision, published.revision);
        assert.equal(f.store.coachLoopReceipts(JSON.stringify(scope)).length, receipts);
      });
      const original = f.store.appendCoachLoopReceipt.bind(f.store);
      f.facts.inputs.prescription!.easyPaceLower = 370; f.facts.factsHash = "zones-changed";
      f.store.appendCoachLoopReceipt = () => { throw new Error("injected after goals write"); };
      assert.throws(() => refresh(f, 3), /injected/);
      f.store.appendCoachLoopReceipt = original;
      const failed = f.runtime.read();
      mark(check, "AC0-12", "failed-refresh-retains-plan-and-requires-refresh", f, failed, () => {
        assert.equal(digest(f.store.read()), before);
        assert.equal(f.store.coachLoopReceipts(JSON.stringify(scope)).length, receipts);
        assert.equal(failed.refreshRequired, true);
      });
      mark(check, "AC3-08", "failure-and-stale-cas-scope-facts", f, failed, () => {
        assert.throws(() => f.runtime.command(f.command("refresh", { expectedRevision: 999 })));
        assert.throws(() => f.runtime.command(f.command("refresh", { expectedFactsHash: "stale" })), /事实/);
        assert.throws(() => f.runtime.command(f.command("refresh", { operationScope: { ...scope, datasetEpoch: "other" } })), /数据集/);
        assert.equal(digest(f.store.read()), before);
      });
    } finally { f.close(); }
  } },
  { id: "R16-acceptance-race-creation-and-explicit-switch", evidenceBoundary: boundary, execute(check) {
    const f = coachRuntimeFixture();
    try {
      for (const days of [41, 42, 364, 365]) {
        const config = { ...settings, mode: "race_preparation" as const, race: raceConfig(days) };
        check("AC0-11", `race-horizon-${days}`, config, { days }, () => {
          if (days === 41 || days === 365) assert.throws(() => validateCoachLoopSettings(config, f.facts.date, true), /6–52/);
          else validateCoachLoopSettings(config, f.facts.date, true);
        });
      }
      const config = { ...settings, mode: "race_preparation" as const, race: raceConfig(42) };
      const out = f.runtime.command(f.command("enable", { settings: config, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH,
        operationId: operationId(1) }));
      const history = f.store.planHistory(200).length;
      for (const change of [{ raceDate: shiftCoachDate(config.race.raceDate!, 7) }, { raceDistanceKm: 5 },
        { goal: "finish" as const, targetTimeSeconds: null }]) {
        mark(check, "AC0-11", `explicit-switch-${Object.keys(change)[0]}`, f, out, () => {
          assert.throws(() => f.runtime.command(f.command("update", {
            settings: { ...config, race: { ...config.race, ...change } } })), /结束/);
          assert.equal(f.store.planHistory(200).length, history);
        });
      }
      const changedGoal = f.runtime.command(f.command("update", {
        settings: { ...config, race: { ...config.race, targetTimeSeconds: 2700 } }, operationId: operationId(2) }));
      mark(check, "AC4-07", "goal-time-is-not-capacity", f, changedGoal, () => {
        assert.equal(changedGoal.volumePolicy.actualWeekKm, out.volumePolicy.actualWeekKm);
        assert.equal(changedGoal.volumePolicy.weeklyProtectionKm, out.volumePolicy.weeklyProtectionKm);
        assert.deepEqual(changedGoal.days.map(d => d.day.structure), out.days.map(d => d.day.structure));
      });
      f.runtime.command(f.command("end", { operationId: operationId(3) }));
      const switched = f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH,
        operationId: operationId(4) }));
      mark(check, "AC0-11", "end-then-enable-does-not-erase-history", f, switched, () => {
        assert.equal(switched.settings?.mode, "daily_adaptive"); assert.equal(switched.goals.runCoach, null);
        assert.ok(f.store.planHistory(200).length > history);
      });
    } finally { f.close(); }
  } },
  { id: "R15-acceptance-manual-short-and-real-short-fact", evidenceBoundary: boundary, execute(check) {
    const f = coachRuntimeFixture();
    try {
      const structure = buildCompleteEasyStructure("easy", f.facts.inputs.prescription);
      structure.blocks[0]!.steps[0]!.goal = { type: "time", seconds: 600 };
      const day = { localDate: f.facts.date, kind: "easy" as const, distanceKm: 3.3, structure, reason: "manual 20 minutes" };
      const lockedSession = { localDate: day.localDate, verdictTone: "green" as const, lockedAt: f.facts.asOf,
        session: { kind: day.kind, title: "人工短课", reason: day.reason, distanceKm: day.distanceKm, durationMinutes: 20,
          paceSecondsPerKmLower: null, paceSecondsPerKmUpper: null, heartRateBpmLower: null,
          heartRateBpmUpper: null, structure } };
      const goals = f.store.write(manualPlanWriteInput({ weekPlan: [day], lockedSession }, f.facts.asOf),
        { prescription: f.facts.inputs.prescription, evaluatedAt: f.facts.asOf });
      const original = goals.weekPlan[0]!;
      f.facts.facts.push({ ...replayRun("autonomous15", f.facts.date, 2.5), durationSeconds: 900 });
      f.facts.factsHash = "short-actual";
      const out = enable(f);
      mark(check, "AC0-10", "manual-and-imported-short-are-not-rewritten", f, out, () => {
        assert.deepEqual(out.goals.weekPlan.find(d => d.localDate === day.localDate), original);
        assert.equal(out.volumePolicy.actualWeekKm, 22.5);
        assert.equal(f.facts.facts.at(-1)?.durationSeconds, 900);
        assert.equal(assessSessionDose({ kind: day.kind, structure, zones: f.facts.inputs.prescription }).status, "not_feasible");
        assert.equal(out.today.executable, false);
      });
    } finally { f.close(); }
  } },
  { id: "R12-acceptance-availability-contract", evidenceBoundary: boundary, execute(check) {
    const f = coachRuntimeFixture();
    try {
      for (const minutes of [9, 10, 240, 241, null]) {
        const config = { ...settings, availabilityMinutesByWeekday: { "4": minutes } };
        check("AC4-04", `available-${minutes}`, config, { minutes }, () => {
          if (minutes === 9 || minutes === 241) assert.throws(() => validateCoachLoopSettings(config, f.facts.date, false));
          else validateCoachLoopSettings(config, f.facts.date, false);
        });
      }
      const out = enable(f), factsBefore = digest({ runs: f.facts.facts, inputs: f.facts.inputs });
      const lessTime = f.runtime.command(f.command("update", {
        settings: { ...settings, availabilityMinutesByWeekday: { "4": 20 } }, operationId: operationId(2) }));
      mark(check, "AC4-07", "availability-does-not-edit-observed-inputs", f, lessTime, () => {
        assert.equal(digest({ runs: f.facts.facts, inputs: f.facts.inputs }), factsBefore);
        assert.equal(lessTime.volumePolicy.actualWeekKm, out.volumePolicy.actualWeekKm);
        assert.equal(lessTime.today.executable, false);
      });
    } finally { f.close(); }
  } },
  { id: "R22-acceptance-policy-template-and-authority", evidenceBoundary: boundary, execute(check) {
    const f = coachRuntimeFixture();
    try {
      check("AC0-21", "negotiation-required-before-publication", settings, f.runtime.read().policyManifest, () => {
        assert.throws(() => f.runtime.command({ ...f.command("enable", { settings }), contractVersion: 2 } as unknown as CoachLoopCommand), /合同/);
        assert.throws(() => f.runtime.command(f.command("enable", { settings, acceptedPolicyHash: "unapproved" })), /规则/);
        assert.equal(f.store.read().revision, 0);
      });
      const out = enable(f), old = f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(scope))!;
      assert.ok(out.today.executable);
      f.store.publicationOperation(JSON.stringify(scope), operationId(2), "fixture", {}, () => {
        f.store.appendCoachLoopReceipt(JSON.stringify(scope), operationId(2), {
          ...old, effectiveDigest: "same-steps-without-authority" });
        return true;
      });
      const authorized = refresh(f, 3);
      mark(check, "AC0-21", "authority-is-part-of-equality", f, authorized, () => {
        assert.ok(authorized.revision > out.revision);
        assert.deepEqual(authorized.today.day.structure, out.today.day.structure);
        assert.ok(authorized.today.decisionRef);
        assert.equal(authorized.volumePolicy.suggestedWeeklyKm, 20);
      });
      const history = digest(f.store.planHistory(200)), plan = digest(f.store.read().weekPlan);
      const saved = f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(scope))!;
      f.store.publicationOperation(JSON.stringify(scope), operationId(4), "fixture", {}, () => {
        f.store.appendCoachLoopReceipt(JSON.stringify(scope), operationId(4), { ...saved,
          policyHash: "revoked-library", policyManifest: { ...COACH_RUNTIME_MANIFEST, templateLibraryVersion: "revoked-v0" } });
        return true;
      });
      const revoked = f.runtime.read();
      mark(check, "AC4-06", "unaccepted-library-fails-closed", f, revoked, () => {
        assert.ok(revoked.days.every(d => !d.executable));
        assert.throws(() => refresh(f, 5), /规则/);
        assert.equal(digest(f.store.read().weekPlan), plan);
      });
      mark(check, "AC4-12", "revoked-version-preserves-history-and-blocks-execution", f, revoked, () => {
        assert.equal(digest(f.store.planHistory(200)), history);
        assert.ok(revoked.days.every(d => !d.executable));
      });
      const accepted = f.runtime.command(f.command("update", {
        settings, acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH, operationId: operationId(6) }));
      mark(check, "AC4-06", "explicit-current-version-acceptance", f, accepted, () => {
        assert.ok(accepted.today.executable); assert.equal(accepted.policyHash, COACH_RUNTIME_POLICY_HASH);
      });
    } finally { f.close(); }
  } },
  { id: "R06-acceptance-skipped-and-explicit-feedback", evidenceBoundary: boundary, execute(check) {
    const f = coachRuntimeFixture();
    try {
      const out = enable(f), before = digest(f.store.read());
      const immutable = digest({ runs: f.facts.facts, inputs: f.facts.inputs, execution: f.facts.execution });
      const fields = { phase: "pre_run" as const, workoutId: null, observedAt: f.facts.asOf, fatigue: null,
        soreness: null, discomfort: null, requestedAction: null, interruptionReason: null,
        replacementReason: null, rpeOverrideRef: null };
      const input = { fields, id: "skipped", revision: 1, scope, recordedAt: f.facts.asOf,
        availableAt: f.facts.asOf, knownWorkoutIds: [], knownRpeOverrides: [] };
      const skipped = buildSubjectiveFeedback(input);
      check("AC5-01", "skipped-means-no-record", input, skipped, () => {
        assert.equal(skipped, null); assert.deepEqual(out.feedback.activeFeedbackIds, []);
        assert.ok(out.today.executable);
      });
      f.facts.feedback = [buildSubjectiveFeedback({ ...input, id: "explicit-rest",
        fields: { ...fields, requestedAction: "rest" } })!];
      f.facts.factsHash = "feedback-rest";
      const stopped = f.runtime.read();
      mark(check, "AC5-05", "good-device-tone-cannot-override-requested-rest", f, stopped, () => {
        assert.equal(f.facts.inputs.today.verdict.tone, "green");
        assert.equal(stopped.today.executable, false); assert.equal(stopped.today.day.kind, "rest");
        assert.equal(digest(f.store.read()), before);
      });
      mark(check, "AC5-06", "feedback-does-not-edit-ability-source-or-actuals", f, stopped, () => {
        assert.equal(digest({ runs: f.facts.facts, inputs: f.facts.inputs, execution: f.facts.execution }), immutable);
        assert.equal(stopped.volumePolicy.actualWeekKm, out.volumePolicy.actualWeekKm);
        assert.equal(stopped.volumePolicy.weeklyProtectionKm, out.volumePolicy.weeklyProtectionKm);
      });
    } finally { f.close(); }
  } }
];

export function coachPublicationReplays() {
  return replayAcceptanceCases(cases.map(scenario => ({ ...scenario, policyManifest: COACH_RUNTIME_MANIFEST })));
}
