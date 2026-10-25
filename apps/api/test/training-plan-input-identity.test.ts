import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "../src/plan-digest.js";
import {
  trainingPlanAnalysisReady, trainingPlanConfigDigest, trainingPlanDesiredInputKey, trainingPlanExecutionDigest,
  trainingPlanFactsDigest, trainingPlanOverridesDigest, TRAINING_PLAN_INPUT_CONTRACT, type TrainingPlanAnalysisIdentity,
  type TrainingPlanInputFact
} from "../src/training-plan-input-identity.js";
import type { TrainingPlanSessionExecution } from "@rai/api-contracts";
import type { TrainingPlanSessionState } from "../src/training-plan-store.js";

const scope = { serverId: "s", athleteId: "a", datasetEpoch: "e" };
const analysis: TrainingPlanAnalysisIdentity = { releaseId: "release-1", analysisStatus: "published",
  factsGeneration: "12", dependencyGeneration: "7" };
const fact = (id: string, updatedAt = "2026-10-25T00:00:00.000Z"): TrainingPlanInputFact => ({
  trainingSessionId: id, startedAt: "2026-10-24T23:00:00.000Z", endedAt: "2026-10-25T00:00:00.000Z",
  distanceMeters: 8000, durationSeconds: 2700, updatedAt
});
const state = (overrides: Partial<TrainingPlanSessionState> = {}): TrainingPlanSessionState => ({
  schemaVersion: 2, migrationVersion: 2, source: "legacy", sourceStatus: "active", sourceDigest: "d".repeat(64),
  migratedAt: "2026-10-25T00:00:00.000Z", planInstanceId: "plan-1", publishedInputKey: null,
  raceGoal: null, runState: "active", runCoach: null, coachLoop: null, preferencesComplete: true,
  legacyRaceTarget: null, planContextDigest: "c".repeat(64), goalsRevision: 1, weekPlan: [], lockedSession: null,
  sessions: [], suppressions: [], ...overrides
} as TrainingPlanSessionState);
const key = (input: Partial<Parameters<typeof trainingPlanDesiredInputKey>[0]> = {}) => trainingPlanDesiredInputKey({
  scope, businessDate: "2026-10-25", facts: [fact("run-1")], analysis,
  configDigest: trainingPlanConfigDigest(state()), overridesDigest: trainingPlanOverridesDigest(state()),
  executionDigest: trainingPlanExecutionDigest([]), policyHash: null, ...input
});

test("B08/S04-01: the same inputs and a later wall clock produce the same key; output revisions are excluded", () => {
  const first = key();
  const second = key();
  assert.equal(first, second);
  assert.equal(key({ configDigest: digest({ different: "clock" }) }) === first, false);
  assert.equal(first, digest({ contract: TRAINING_PLAN_INPUT_CONTRACT, scope, businessDate: "2026-10-25",
    facts: trainingPlanFactsDigest([fact("run-1")]), analysis, config: trainingPlanConfigDigest(state()),
    overrides: trainingPlanOverridesDigest(state()), executions: trainingPlanExecutionDigest([]), policyHash: null }));
});

test("B08/S04-01: relevant facts, corrected runs, a new analysis release, config/override/execution changes move the key", () => {
  const base = key();
  assert.notEqual(key({ facts: [fact("run-1", "2026-10-26T00:00:00.000Z")] }), base, "a corrected run changes updated_at");
  assert.notEqual(key({ facts: [fact("run-1"), fact("run-2")] }), base, "a new run enters the window");
  assert.notEqual(key({ analysis: { ...analysis, releaseId: "release-2" } }), base, "a new published release");
  assert.notEqual(key({ analysis: { ...analysis, analysisStatus: "failed" } }), base, "analysis status is part of the input");
  assert.notEqual(key({ configDigest: digest({ changed: true }) }), base);
  assert.notEqual(key({ overridesDigest: digest({ changed: true }) }), base);
  const execution: TrainingPlanSessionExecution = { sessionId: "session-1", executionRevision: 1,
    association: "confirmed", trainingSessionId: "run-1", sourceFactDigest: "a".repeat(64),
    prescriptionSessionRevision: 1, assessment: null, availableAt: "2026-10-25T00:00:00.000Z", reasonCodes: [] };
  assert.notEqual(key({ executionDigest: trainingPlanExecutionDigest([execution]) }), base);
});

test("B08/S04-01: record-only updates and unrelated record fields do not enter the facts digest", () => {
  const first = trainingPlanFactsDigest([fact("run-1")]);
  assert.equal(trainingPlanFactsDigest([fact("run-1")]), first, "no wall clock in the facts digest");
  assert.notEqual(trainingPlanFactsDigest([{ ...fact("run-1"), distanceMeters: 8100 }]), first);
  assert.equal(trainingPlanAnalysisReady(analysis), true);
  assert.equal(trainingPlanAnalysisReady({ ...analysis, analysisStatus: "queued" }), false);
  assert.equal(trainingPlanAnalysisReady({ ...analysis, releaseId: null }), true,
    "published with no required release is caught up, not stale");
});

test("B08/S04-01: automatic pending prescriptions are output, protected courses and suppressions are user decisions", () => {
  const automatic = state({ sessions: [{ planInstanceId: "plan-1", sessionId: "s1", sessionRevision: 1,
    prescription: { localDate: "2026-10-26", kind: "easy", distanceKm: 8, structure: null, reason: null },
    recommendation: null, userOverride: null, protection: "automatic", lifecycle: "pending",
    availableAt: "2026-10-25T00:00:00.000Z", supersededBySessionId: null }] });
  const changedAutomatic = structuredClone(automatic);
  changedAutomatic.sessions[0]!.prescription.distanceKm = 10;
  assert.equal(trainingPlanOverridesDigest(automatic), trainingPlanOverridesDigest(changedAutomatic),
    "generated automatic content is not an input");
  const protectedState = structuredClone(automatic);
  protectedState.sessions[0]!.protection = "user_protected";
  protectedState.sessions[0]!.userOverride = { action: "edit", prescription: protectedState.sessions[0]!.prescription,
    availableAt: "2026-10-25T00:00:00.000Z" };
  assert.notEqual(trainingPlanOverridesDigest(automatic), trainingPlanOverridesDigest(protectedState),
    "a protected course is a user decision");
  assert.notEqual(trainingPlanOverridesDigest(state({ suppressions: [{ localDate: "2026-10-27", reason: "explicit_rest",
    sessionId: null, availableAt: "2026-10-25T00:00:00.000Z" }] })), trainingPlanOverridesDigest(state()));
});
