import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { TrainingPlanScope, TrainingPlanSession } from "@rai/api-contracts";

import type { MobileGoalsStore } from "../../src/mobile-goals.js";
import { parseTrainingPlanState, TrainingPlanStore, type TrainingPlanSessionState } from "../../src/training-plan-store.js";

/**
 * B09 benchmark-only control fixture. Deliberately under apps/api/test/helpers:
 * the production single-writer gate excludes the test tree from the R4 rule that
 * keeps `applyMigration` and `mobile_training_state` writes out of scripts. This
 * file is not part of the API runtime and uses only temporary databases.
 */

const fixture = JSON.parse(readFileSync(new URL("../../../ios/tests/fixtures/training-plan-sessions-v2.json",
  import.meta.url), "utf8")) as { initial: TrainingPlanSession; payload2: TrainingPlanSessionState; scope: TrainingPlanScope };

export const benchmarkScope = fixture.scope;
export const benchmarkScopeKey = JSON.stringify([benchmarkScope.serverId, benchmarkScope.athleteId, benchmarkScope.datasetEpoch]);

export function seedBenchControlStore(goals: MobileGoalsStore, controlPath: string, businessDate: string): {
  sessions: TrainingPlanSession[];
  planInstanceId: string;
} {
  const database = new DatabaseSync(controlPath);
  const unified = new TrainingPlanStore(database);
  const base = structuredClone(fixture.initial);
  const shift = (date: string, offset: number): string => {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + offset);
    return value.toISOString().slice(0, 10);
  };
  const sessions = Array.from({ length: 24 }, (_unused, index) => {
    const session = structuredClone(base);
    session.sessionId = `bench-session-${String(index).padStart(2, "0")}`;
    session.sessionRevision = 1;
    session.protection = "automatic";
    session.userOverride = null;
    session.lifecycle = "pending";
    session.prescription.localDate = shift(businessDate, index - 1);
    session.availableAt = `${shift(businessDate, -2)}T03:00:00.000Z`;
    return session;
  });
  const weekPlan = sessions.map(session => session.prescription);
  goals.write({ weekPlan }, { preserveWeekPlan: true });
  const { planInstanceId, sessions: _sessions, suppressions: _suppressions, publishedInputKey: _publishedInputKey,
    ...legacy } = fixture.payload2;
  unified.applyMigration({ scope: benchmarkScopeKey, expectedAbsentOrRevision: 0, sourceDigest: legacy.sourceDigest,
    state: parseTrainingPlanState({ ...legacy, schemaVersion: 1, migrationVersion: 1, weekPlan,
      goalsRevision: goals.read().revision }) });
  unified.commitState({ scope: benchmarkScopeKey, expectedRevision: 1, eventType: "benchmark:seed", state: {
    ...fixture.payload2, sessions, suppressions: [], weekPlan, goalsRevision: goals.read().revision
  } }, { sessionMigration: true });
  database.close();
  goals.bindTrainingPlanOwner(() => benchmarkScope, () => businessDate);

  goals.withPublicationTransaction(() => {
    sessions.forEach((session, index) => {
      goals.appendTrainingPlanExecution(benchmarkScopeKey, String(planInstanceId), {
        sessionId: session.sessionId, executionRevision: 1, association: "confirmed",
        trainingSessionId: `bench-run-${index}`, sourceFactDigest: "a".repeat(64),
        prescriptionSessionRevision: 1, assessment: null,
        availableAt: `${businessDate}T03:00:00.000Z`, reasonCodes: []
      }, "benchmark:seed");
    });
  });
  const row = goals.currentTrainingPlan()!;
  goals.withPublicationTransaction(() => goals.recordTrainingPlanEvaluation(benchmarkScopeKey, {
    inputKey: "bench-input-key", stateRevision: row.revision, businessDate, policyHash: null,
    executionDigest: "b".repeat(64), operationId: "benchmark-seed", evaluatedAt: `${businessDate}T03:00:00.000Z`
  }));
  return { sessions, planInstanceId: String(planInstanceId) };
}
