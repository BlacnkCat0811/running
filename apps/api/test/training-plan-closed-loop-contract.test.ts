import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TRAINING_PLAN_CLOSED_LOOP_CONTRACT as contract,
  TRAINING_PLAN_CLOSED_LOOP_ERRORS as errors,
  trainingPlanClosedLoopSupport,
  type HandshakeResponse, type TrainingPlanSessionCommandRequest,
  type TrainingPlanSessionPreviewRequest, type TrainingPlanSessionsView,
  type TrainingPlanStateResponseV2, type TrainingPlanExecutionCandidate
} from "@rai/api-contracts";
import { buildTrainingPlanStateV2 } from "../src/training-plan-routes.js";
import { parseTrainingPlanState } from "../src/training-plan-store.js";
import { normalizeSessionStructure } from "../src/session-structure.js";

// Shared with the Swift regression in the aggregate iOS chain. Synthetic only;
// this is a protocol freeze, not proof of session storage or command execution.
const fixture = JSON.parse(readFileSync(new URL("../../ios/tests/fixtures/training-plan-closed-loop.json", import.meta.url), "utf8")) as {
  scope: TrainingPlanSessionPreviewRequest["operationScope"];
  businessDate: string;
  capabilities: Array<{ name: string; handshake: HandshakeResponse; expected: ReturnType<typeof trainingPlanClosedLoopSupport> }>;
  projections: Array<{ name: string; state: Record<string, unknown>; rejected: boolean; wire?: TrainingPlanStateResponseV2 }>;
  sessions: TrainingPlanSessionsView;
  sessionPreview: TrainingPlanSessionPreviewRequest;
  sessionSubmit: TrainingPlanSessionCommandRequest;
  sameDayRuns: TrainingPlanExecutionCandidate[];
};

test("B01: old/production/validation/unknown capabilities obey the shared exact-version matrix", () => {
  assert.equal(fixture.capabilities.length, 22);
  for (const row of fixture.capabilities) {
    assert.deepEqual(trainingPlanClosedLoopSupport(row.handshake), row.expected, row.name);
  }
  // Current configuration write support must never imply session write support.
  const current = fixture.capabilities.find(row => row.name === "validation_configuration_only")!;
  assert.equal(current.handshake.trainingPlanCommandContractVersion, 2);
  assert.equal(trainingPlanClosedLoopSupport(current.handshake).sessionCommands, false);
});

test("B01: shared unmanaged/managed/runCoach/paused/ended/empty projections match the current real parser and resolver", () => {
  assert.deepEqual(fixture.projections.map(row => row.name),
    ["unmanaged", "managed", "legacy_run_coach", "paused", "ended", "empty_data", "unknown_source"]);
  for (const row of fixture.projections) {
    if (row.rejected) {
      assert.throws(() => parseTrainingPlanState(row.state), /source must be/);
      continue;
    }
    const state = parseTrainingPlanState(row.state);
    const actual = buildTrainingPlanStateV2({ scope: fixture.scope, businessDate: fixture.businessDate,
      row: { scope: JSON.stringify([fixture.scope.serverId, fixture.scope.athleteId, fixture.scope.datasetEpoch]),
        revision: 3, updatedAt: state.migratedAt, state },
      currentGoalsRevision: 7 });
    assert.deepEqual(actual, row.wire, row.name);
    assert.equal(actual.execution.permitted, false);
    if (row.name === "legacy_run_coach") {
      assert.deepEqual(state.runCoach?.runningDays, [1, 3, 5]);
      assert.equal(state.runCoach?.targetType, "heart_rate");
    }
  }
  // B02 recognizes 2 but never fabricates missing identities while reading.
  assert.throws(() => parseTrainingPlanState({ ...fixture.projections[0]!.state, schemaVersion: 2 }), /planInstanceId/);
  assert.throws(() => parseTrainingPlanState({ ...fixture.projections[0]!.state, schemaVersion: 999 }), /unknown.*schemaVersion/);
});

test("B01: frozen session preview/submit wire uses the exact new path/body and preserves ID", () => {
  const preview = {
    contractVersion: 1, operationScope: fixture.scope, expectedStateRevision: 3, planInstanceId: "synthetic-plan",
    draft: { action: "move", sessionId: "synthetic-session", sessionRevision: 1, localDate: "2026-10-29" }
  } satisfies TrainingPlanSessionPreviewRequest;
  const submit = { ...preview, operationId: "00000000-0000-4000-8000-000000000001", candidateId: "synthetic-candidate"
  } satisfies TrainingPlanSessionCommandRequest;
  assert.deepEqual(preview, fixture.sessionPreview);
  assert.deepEqual(submit, fixture.sessionSubmit);
  assert.deepEqual(contract.routes.sessionPreview, { method: "POST", path: "/v1/mobile/training-plan/session-commands/preview" });
  assert.deepEqual(contract.routes.sessionSubmit, { method: "POST", path: "/v1/mobile/training-plan/session-commands" });
  assert.deepEqual(contract.routes.executionSubmit, { method: "POST", path: "/v1/mobile/training-plan/execution-commands" });
  assert.equal(contract.previewTTLSeconds, 120);
  assert.equal(fixture.sessions.sessions[0]!.sessionId, submit.draft.sessionId);
  const prescription = fixture.sessions.sessions[0]!.prescription;
  assert.deepEqual(normalizeSessionStructure(prescription.structure), prescription.structure);
  assert.equal(prescription.distanceKm, 8);
  assert.deepEqual(prescription.structure?.blocks[0]?.steps[0]?.goal, { type: "distance", meters: 8000 });
});

test("B01: unknown/absent/null remain distinct in JSON; multiple same-day runs remain candidates", () => {
  const omitted = { action: "edit", sessionId: "s", sessionRevision: 1, patch: { kind: "easy" }
  } satisfies TrainingPlanSessionPreviewRequest["draft"];
  const cleared = { action: "edit", sessionId: "s", sessionRevision: 1, patch: { reason: null }
  } satisfies TrainingPlanSessionPreviewRequest["draft"];
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(omitted)).patch, "reason"), false);
  assert.equal(JSON.parse(JSON.stringify(cleared)).patch.reason, null);
  assert.equal(fixture.sameDayRuns.length, 2);
  assert.equal(new Set(fixture.sameDayRuns.map(row => row.trainingSessionId)).size, 2);
  assert.ok(fixture.sameDayRuns.every(row => row.evidence === "needs_confirmation"));
  assert.equal(contract.candidateDaysBefore, 2);
  assert.equal(contract.candidateDaysAfter, 2);
  assert.equal(contract.candidateMaxRangeDays, 31);
  assert.equal(contract.candidatePageSize, 50);
});

test("B01: all new error codes and capability headers are documented without declaring runtime support", () => {
  const doc = readFileSync(new URL("../../../docs/TRAINING_PLAN_V2_CLOSED_LOOP_CONTRACT.md", import.meta.url), "utf8");
  for (const [code, status] of Object.entries(errors)) {
    assert.ok(doc.includes(`\`${code}\``), code);
    assert.ok([404, 409, 422, 503].includes(status));
  }
  for (const key of ["sessions", "sessionCommands", "executionCommands", "updates"] as const) {
    assert.ok(doc.includes(contract[key].capability));
    assert.ok(doc.includes(contract[key].header));
  }
  assert.match(doc, /B01 不实现新存储、路由/);
});
