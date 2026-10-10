import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { coachAcceptanceInventory, auditCoachRelease } from "../../../scripts/coach-release-gate.mjs";
import { digest } from "../src/plan-digest.js";

const plan = readFileSync(new URL("../../../docs/COACH_LOOP_OPTIMIZATION_PLAN.md", import.meta.url), "utf8");
test("AC8-01/04/06: all 78 acceptance IDs are inventoried; missing evidence and human/device gates never pass", () => {
  assert.equal(coachAcceptanceInventory(plan).length, 78);
  assert.throws(() => coachAcceptanceInventory(plan.replace("| AC0-01 |", "| WRONG |")), /78/);
  const report = auditCoachRelease(plan, {}, "source");
  assert.equal(report.status, "blocked");
  assert.equal(report.deploymentAuthorized, false);
  assert.equal(report.acceptance.filter(row => row.replayEvidence === "not_evaluable").length, 78);
  assert.ok(report.blockers.includes("missing_replay_evidence"));
  assert.ok(report.blockers.includes("physical_device_and_rollback_acceptance_required"));
});

test("release audit rejects stale/tampered artifacts and does not equate one passing assertion with full requirement signoff", () => {
  const replay = { status: "passed", sourceTreeHash: "current", scenarios: [{ scenarioId: "R19-positive", status: "passed",
    checkpoints: [{ assertions: [{ acceptanceId: "AC0-13", status: "passed" }] }] }] };
  const artifact = { ...replay, reportHash: digest(replay) };
  const report = auditCoachRelease(plan, { replay: artifact }, "current");
  assert.equal(report.acceptance.find(row => row.id === "AC0-13")?.replayEvidence, "selected_assertions_passed");
  assert.equal(report.acceptance.find(row => row.id === "AC0-13")?.fullRequirementSignoff, "not_evaluable");
  assert.ok(auditCoachRelease(plan, { replay: artifact }, "other").blockers.includes("stale_replay_source"));
  const tampered = auditCoachRelease(plan, { replay: { ...artifact, reportHash: "forged" } }, "current");
  assert.ok(tampered.blockers.includes("invalid_replay_hash"));
  assert.equal(tampered.acceptance.find(row => row.id === "AC0-13")?.replayEvidence, "not_evaluable");
});
