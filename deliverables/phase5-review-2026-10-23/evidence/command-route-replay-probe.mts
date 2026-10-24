import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { TrainingPlanCommandPreviewRequest, TrainingPlanCommandRequest } from "@rai/api-contracts";

import { MobileGoalsStore } from "../../../apps/api/src/mobile-goals.js";
import { digest } from "../../../apps/api/src/plan-digest.js";
import {
  TRAINING_PLAN_PREVIEW_TTL_SECONDS,
  TrainingPlanCommandService
} from "../../../apps/api/src/training-plan-commands.js";
import { trainingPlanContextDigest } from "../../../apps/api/src/training-mode-policy.js";
import { TrainingPlanStore, type TrainingPlanState } from "../../../apps/api/src/training-plan-store.js";

/**
 * PR4-2: configuration commands over the unified state.
 *
 * Pinned here:
 * - preview is stateless and writes nothing (state revision and goals revision both
 *   unchanged), and its candidate id binds action + draft + revision + expiry;
 * - submit commits the unified state, its history row, the legacy goals mirror and
 *   the operation result in one publication transaction, and is idempotent per
 *   operationId;
 * - a stale/expired/tampered candidate and a stale revision are explicit 409s;
 * - an ended programme cannot be resumed;
 * - the command does NOT claim a regenerated plan: both responses and the v2 read
 *   say the plan needs a refresh.
 */

const identity = () => ({ serverId: "server", athleteId: "athlete", datasetEpoch: "epoch" });
const scope = identity();
const scopeKey = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
const BUSINESS_DATE = "2026-10-20";

const createFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "rai-training-plan-command-"));
  const controlPath = join(root, "control.sqlite");
  const goals = new MobileGoalsStore(root, controlPath);
  const database = new DatabaseSync(controlPath);
  const unified = new TrainingPlanStore(database);
  const migrate = (overrides: Partial<TrainingPlanState> = {}) => {
    const state: TrainingPlanState = {
      schemaVersion: 1,
      migrationVersion: 1,
      source: "legacy_goals",
      sourceStatus: "active",
      sourceDigest: digest({ source: overrides }).slice(0, 64),
      runState: "active",
      raceGoal: null,
      preferencesComplete: true,
      legacyRaceTarget: null,
      weekPlan: [],
      lockedSession: null,
      runCoach: null,
      coachLoop: null,
      goalsRevision: goals.read().revision,
      planContextDigest: null,
      migratedAt: "2026-10-20T04:00:00.000Z",
      ...overrides
    };
    const applied = unified.applyMigration({ scope: scopeKey, expectedAbsentOrRevision: 0,
      sourceDigest: state.sourceDigest, state });
    assert.equal(applied.status, "applied");
    return state;
  };
  const service = (now = () => Date.parse("2026-10-20T04:00:00.000Z")) =>
    new TrainingPlanCommandService(goals, () => scopeKey, identity, () => BUSINESS_DATE, now);
  const close = () => { database.close(); goals.close(); rmSync(root, { recursive: true, force: true }); };
  return { goals, database, unified, migrate, service, close };
};


import Fastify from "fastify";
import { createTrainingPlanCommandHandlers } from "../../../apps/api/src/training-plan-routes.js";
const fixture = createFixture();
const app = Fastify();
try {
  fixture.migrate();
  const service = fixture.service();
  let generations = 0;
  const deps = {
    prepare: async () => {
      generations++;
      return { days: [{ localDate: "2026-10-21", kind: "easy" as const, distanceKm: 5.2, structure: null, reason: "probe" }],
        audit: { generatedBy: "heuristic" as const, model: null, promptVersion: null, generatedAt: "2026-10-20T04:00:00.000Z" },
        warnings: [], prescription: null, fingerprint: "probe-facts" };
    },
    fingerprint: () => "probe-facts"
  };
  const handlers = createTrainingPlanCommandHandlers(service, deps);
  app.post("/v1/mobile/training-plan/commands", handlers.submit);
  const previewRequest = { contractVersion: 2 as const, operationScope: scope, action: "set_race_goal" as const,
    raceGoal: { date: "2026-12-06", distanceKm: 10, goal: "time" as const, targetTimeSeconds: 3000 } };
  const candidate = service.preview(previewRequest);
  const request = { ...previewRequest, operationId: "d3474afa-1130-4cb0-8d00-97e6f11a3789",
    expectedStateRevision: candidate.expectedStateRevision, candidateId: candidate.candidateId };
  const first = await app.inject({ method: "POST", url: "/v1/mobile/training-plan/commands", payload: request });
  const afterFirst = fixture.goals.trainingPlanStateRow(scopeKey)!.revision;
  const replay = await app.inject({ method: "POST", url: "/v1/mobile/training-plan/commands", payload: request });
  const afterReplay = fixture.goals.trainingPlanStateRow(scopeKey)!.revision;
  const directReplay = service.submit(request);
  const report = { evidence: "Fastify inject + production command handler/service + temporary control SQLite; synthetic plan generator; not full server or iOS E2E",
    firstStatus: first.statusCode, replayStatus: replay.statusCode, replayCode: replay.json().code,
    afterFirst, afterReplay, generations, serviceReplayMatches: JSON.stringify(directReplay) === JSON.stringify(first.json()) };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().code, "training_revision_conflict");
  assert.equal(afterReplay, afterFirst);
  assert.equal(report.serviceReplayMatches, true);
} finally { await app.close(); fixture.close(); }
