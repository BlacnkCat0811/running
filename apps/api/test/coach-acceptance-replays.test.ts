import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runCoachBehaviorReplay } from "../../../scripts/coach-behavior-replay.mjs";
import { auditCoachRelease } from "../../../scripts/coach-release-gate.mjs";
import { validateCoachMutationEvidence, coachReplayAudit } from "../../../scripts/coach-replay-audit.mjs";
import { COACH_MUTATION_ASSERTIONS } from "../../../scripts/coach-mutation-contract.mjs";
import { replayAcceptanceCases } from "../../../scripts/coach-acceptance-trace.mjs";
import { digest } from "../src/plan-digest.js";

const plan = readFileSync(new URL("../../../docs/COACH_LOOP_OPTIMIZATION_PLAN.md", import.meta.url), "utf8");
// Parser fixtures only: these are never emitted as real compile evidence.
const mutationFixture = () => {
  const payload = { sourceTreeHash: "source", purpose: "compiled_behavior_mutations_not_training_effect",
    status: "passed", mutationCount: Object.keys(COACH_MUTATION_ASSERTIONS).length,
    results: Object.entries(COACH_MUTATION_ASSERTIONS).map(([id, assertionId]) => ({ id, assertionId, compiled: true, status: "killed" })) };
  return { ...payload, reportHash: digest(payload) };
};
function seal<T extends object>(payload: T) { return { ...payload, reportHash: digest(payload) }; }

test("41 missing mappings have runnable assertions: 77/78 without explicit compile evidence, not a fake AC8-05 pass", context => {
  context.mock.method(console, "log", () => {});
  const replay = runCoachBehaviorReplay();
  assert.equal(replay.status, "passed", JSON.stringify(replay.acceptanceScenarios.filter(s => s.status !== "passed")));
  assert.equal(replay.acceptanceScenarios.length, 16);
  assert.ok(replay.acceptanceScenarios.every(s => s.deterministic && s.checkpoints.length));
  const release = auditCoachRelease(plan, { replay: seal(replay) }, replay.sourceTreeHash);
  assert.equal(release.selectedAcceptanceReplayCount, 77);
  assert.deepEqual(release.missingAcceptanceReplayIds, ["AC8-05"]);
  assert.deepEqual(release.missingScenarios, []);
  assert.ok(release.acceptance.every(row => row.fullRequirementSignoff === "not_evaluable"));
  assert.ok(release.acceptance.filter(row => row.replayEvidence !== "not_evaluable").every(row => row.replayMappings.length > 0));
  assert.equal(release.status, "blocked"); assert.equal(release.deploymentAuthorized, false);
});

test("AC8-05 only consumes current, intact, complete compiled named mutation results", () => {
  const good = mutationFixture();
  assert.equal(validateCoachMutationEvidence(good, "source").compiledNamedKills, 29);
  assert.throws(() => validateCoachMutationEvidence(good, "other"), /stale/);
  assert.throws(() => validateCoachMutationEvidence({ ...good, reportHash: "tampered" }, "source"), /hash/);
  const { reportHash: _, ...payload } = good;
  for (const change of [
    { results: payload.results.slice(1) },
    { results: [...payload.results.slice(1), payload.results[1]!] },
    { results: payload.results.map((row, i) => i ? row : { ...row, compiled: false }) },
    { results: payload.results.map((row, i) => i ? row : { ...row, assertionId: "compiler_error" }) },
    { results: payload.results.map((row, i) => i ? row : { ...row, status: "survived" }) }
  ]) assert.throws(() => validateCoachMutationEvidence(seal({ ...payload, ...change }), "source"));
});

test("release requires the same linked compile artifact before accepting AC8-05", () => {
  const mutations = mutationFixture();
  const payload = { sourceTreeHash: "source", status: "passed", evidenceAudit: {
    scenarioId: "R22-replay-evidence-audit", status: "passed", mutationEvidence: { reportHash: mutations.reportHash },
    checkpoints: [{ assertions: [{ id: "compiled-named", acceptanceId: "AC8-05", status: "passed" }] }] } };
  assert.equal(auditCoachRelease(plan, { replay: seal(payload) }, "source").selectedAcceptanceReplayCount, 0);
  const failedCheckpoint = { sourceTreeHash: "source", status: "passed", scenarios: [{
    scenarioId: "R22-failed-checkpoint", status: "passed",
    checkpoints: [{ id: "AC0-12", status: "failed" }] }] };
  assert.equal(auditCoachRelease(plan, { replay: seal(failedCheckpoint) }, "source").selectedAcceptanceReplayCount, 0);
  assert.equal(auditCoachRelease(plan, { replay: seal(payload), mutations }, "source").selectedAcceptanceReplayCount, 1);
  assert.equal(auditCoachRelease(plan, { replay: seal({ ...payload, evidenceAudit: {
    ...payload.evidenceAudit, mutationEvidence: { reportHash: "another-artifact" } } }), mutations }, "source")
    .selectedAcceptanceReplayCount, 0);
});

test("failed/non-deterministic scenario cannot certify its earlier passing assertion", () => {
  const result = replayAcceptanceCases([{ id: "R22-failed", evidenceBoundary: "synthetic", execute(check) {
    check("AC0-12", "earlier-pass", {}, {}, () => {});
    check("AC0-22", "later-fault", {}, {}, () => { throw new Error("injected"); });
  } }]);
  assert.equal(result[0]?.status, "failed"); assert.deepEqual(result[0]?.checkpoints, []);
  let round = 0;
  const unstable = replayAcceptanceCases([{ id: "R22-unstable", evidenceBoundary: "synthetic",
    execute(check) { check("AC0-12", "unstable", {}, { round: round++ }, () => {}); } }]);
  assert.equal(unstable[0]?.status, "failed");
  const payload = { sourceTreeHash: "source", status: "passed", scenarios: [{
    scenarioId: "R22-failed", status: "failed", checkpoints: [{
      assertions: [{ acceptanceId: "AC0-12", status: "passed" }] }] }] };
  assert.equal(auditCoachRelease(plan, { replay: seal(payload) }, "source").selectedAcceptanceReplayCount, 0);
  assert.ok(coachReplayAudit(result, "source").checkpoints[0]!.assertions.some(a =>
    a.acceptanceId === "AC8-04" && a.status === "failed"));
});
