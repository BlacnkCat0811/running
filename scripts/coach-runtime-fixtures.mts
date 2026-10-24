import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CoachLoopCommand, CoachLoopSettings, MobileTodayResponse } from "@rai/api-contracts";
import { MobileGoalsStore } from "../apps/api/src/mobile-goals.js";
import { CoachLoopRuntime, type CoachRuntimeFacts } from "../apps/api/src/coach-loop-runtime.js";
import { coachReplayInput, replayRun } from "./coach-replay-scenarios.mjs";
import { coachQualityExecutionSummary } from "../apps/api/src/coach-execution-assessment.js";

export const runtimeReplayScope = { serverId: "test-server", athleteId: "synthetic", datasetEpoch: "synthetic-v1" };
export const runtimeReplaySettings: Omit<CoachLoopSettings, "status"> = {
  mode: "daily_adaptive", runningDays: [1,2,3,4,5,6,7], longRunDays: [7],
  availabilityMinutesByWeekday: {}, targetType: "pace", race: null
};

/** Synthetic frozen facts + actual SQLite publication, never the user's DB. */
export function coachRuntimeFixture() {
  const root = mkdtempSync(join(tmpdir(), "coach-runtime-"));
  const controlPath = join(root, "control.sqlite");
  let store = new MobileGoalsStore(root, controlPath);
  const input = coachReplayInput();
  let facts: CoachRuntimeFacts = {
    asOf: input.asOf, date: "2026-10-08", facts: [...input.facts, replayRun("monday-20", "2026-10-05", 20)],
    factsHash: "frozen-training-v1", feedback: [], execution: [],
    executionSummary: coachQualityExecutionSummary({ asOf: input.asOf, prescriptions: [], observedDates: [], assessments: [] }), qualityDates: [],
    historyCoverageFrom: input.historyCoverageFrom, predictionIdentity: null, predictionSummary: null,
    inputs: { prescription: input.zones, recentWeeklyKm: 20, previousWeekDistanceKm: 20, weeklyVolumeBaselineKm: 20, preparation: null,
      legacyHistory: { stableWeeklyKm: 0, observedRecentWeeks: 0 },
      today: { today: { localDate: "2026-10-08", workoutCount: 0 }, recoveryAssessment: { coverage: "none", assessment: "not_assessed" },
        recommendation: { basis: "training_load_and_plan" }, injuryFlags: [], calibration: { status: "completed" },
        sync: { status: "ok" }, verdict: { tone: "green" }, weekStructure: { easyDurationFraction: 1, qualitySessionCount: 0 },
        week: { distanceKm: 20, durationSeconds: 7200 } } as unknown as MobileTodayResponse }
  };
  const runtimeOptions = { now: () => Date.parse(facts.asOf) };
  let runtime = new CoachLoopRuntime(store, () => runtimeReplayScope, () => facts, undefined, runtimeOptions);
  const command = (action: CoachLoopCommand["action"], extra: Partial<CoachLoopCommand> = {}): CoachLoopCommand => ({
    contractVersion: 1, operationId: randomUUID(), operationScope: runtimeReplayScope,
    expectedRevision: store.read().revision, expectedFactsHash: facts.factsHash, action, ...extra
  });
  return {
    controlPath, get store() { return store; }, get runtime() { return runtime; }, command,
    get facts() { return facts; }, set facts(value: CoachRuntimeFacts) { facts = value; },
    restart() {
      store.close();
      store = new MobileGoalsStore(root, controlPath);
      runtime = new CoachLoopRuntime(store, () => runtimeReplayScope, () => facts, undefined, runtimeOptions);
    },
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); }
  };
}
