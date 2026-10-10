import assert from "node:assert/strict";
import { digest } from "../apps/api/src/plan-digest.js";
import { COACH_POLICY_MANIFEST } from "../apps/api/src/coach-loop-policy.js";
import { COACH_MUTATION_ASSERTIONS } from "./coach-mutation-contract.mjs";
import { coachLocalDate } from "../apps/api/src/coach-loop-facts.js";
import { periodizationWeekStart } from "../apps/api/src/plan-periodization.js";

type Row = Record<string, any>;
/** Compiled mutation evidence is an explicit input, never a remembered old
 * result or test title. No evidence means not_evaluable, not a fake AC8-05 pass. */
export function validateCoachMutationEvidence(value: unknown, sourceTreeHash: string) {
  const report = value as Row | null;
  if (!report || typeof report !== "object") throw new Error("Missing compiled mutation evidence");
  const { reportHash, ...payload } = report;
  assert.equal(reportHash, digest(payload), "Mutation artifact hash mismatch");
  assert.equal(report.sourceTreeHash, sourceTreeHash, "Mutation artifact source is stale");
  assert.equal(report.purpose, "compiled_behavior_mutations_not_training_effect");
  assert.equal(report.status, "passed");
  assert.ok(Array.isArray(report.results));
  assert.equal(report.mutationCount, Object.keys(COACH_MUTATION_ASSERTIONS).length);
  assert.equal(report.results.length, report.mutationCount);
  const ids = new Set<string>();
  for (const row of report.results) {
    assert.ok(!ids.has(row.id), "Duplicate mutation probe"); ids.add(row.id);
    assert.ok(Object.hasOwn(COACH_MUTATION_ASSERTIONS, row.id), "Unknown mutation probe");
    assert.equal(row.assertionId, COACH_MUTATION_ASSERTIONS[row.id], "Unnamed/wrong behavior rejection");
    assert.equal(row.compiled, true, "Compile failure is not a semantic kill");
    assert.equal(row.status, "killed", "Surviving/crashing probe is not a kill");
  }
  return { reportHash: String(reportHash), mutationCount: report.mutationCount as number,
    compiledNamedKills: report.results.length as number };
}

/** Explicit evaluator trace and denominator. These are checkpoint observations,
 * not numbers of actual workouts, production throughput or training benefits. */
export function coachReplayAudit(scenarios: readonly Row[], sourceTreeHash: string, mutationEvidence?: unknown) {
  const checkpoints = scenarios.flatMap(s => (s.checkpoints ?? []).map((c: Row) => ({ scenarioId: s.scenarioId ?? s.id, ...c })));
  const eventScenarios = scenarios.filter(s => Array.isArray(s.events) && s.events.length);
  const outputRows = checkpoints.filter(c => c.output != null);
  const metrics = {
    denominator: "evaluated_checkpoints_not_unique_workouts",
    scenarioCount: scenarios.length, checkpointCount: checkpoints.length,
    eventScenarioCount: eventScenarios.length,
    eventCount: eventScenarios.reduce((n, s) => n + s.events.length, 0),
    checkpointOutputChangeCount: outputRows.filter((c, i) => i > 0 &&
      outputRows[i - 1]!.scenarioId === c.scenarioId && outputRows[i - 1]!.outputHash !== c.outputHash).length,
    changedCheckpointDates: outputRows.filter((c, i) => i > 0 &&
      outputRows[i - 1]!.scenarioId === c.scenarioId && outputRows[i - 1]!.outputHash !== c.outputHash).map(c => c.asOf),
    assessedDoseCheckpointCount: outputRows.filter(c => c.output.dose?.durationSeconds).length,
    doseBounds: outputRows.filter(c => c.output.dose?.durationSeconds).map(c => ({
      scenarioId: c.scenarioId, asOf: c.asOf, durationSeconds: c.output.dose.durationSeconds })),
    executionAssessmentCheckpointCount: outputRows.filter(c => c.output.observation != null).length,
    unknownExecutionCheckpointCount: outputRows.filter(c => c.output.observation === "unknown").length,
    shortProposedSessionCount: scenarios.reduce((n, s) => n + (s.metrics?.proposedShortSessionCount ?? 0), 0),
    hardViolationProposedSessionCount: scenarios.reduce((n, s) => n + (s.metrics?.proposedHardConstraintViolationCount ?? 0), 0),
    baseline: "same_frozen_input_repeated_current_policy_not_longitudinal_control_group",
    longitudinalRealTrainingEffect: "not_evaluable", fullRequirementSignoff: "not_evaluable"
  };
  const assertions: Array<{ id: string; acceptanceId: string; status: string; error?: string }> = [];
  const check = (acceptanceId: string, id: string, assertion: () => void) => {
    try { assertion(); assertions.push({ id, acceptanceId, status: "passed" }); }
    catch (error) { assertions.push({ id, acceptanceId, status: "failed",
      error: error instanceof Error ? error.message : String(error) }); }
  };
  check("AC8-01", "versioned-scenarios-and-reason-trace", () => {
    for (let group = 0; group <= 6; group++)
      assert.ok(checkpoints.some(c => c.assertions?.some((a: Row) => a.status === "passed" && a.acceptanceId.startsWith(`AC${group}-`))));
    assert.ok(scenarios.every(s => /^R\d{2}/.test(s.scenarioId ?? s.id)));
    assert.ok(scenarios.filter(s => s.scenarioId).every(s => s.policyManifest));
    assert.ok(outputRows.some(c => c.output.reasons?.some((r: Row) => r.code && r.policyVersion)));
  });
  check("AC8-02", "cross-week-event-trace-and-observation-denominators", () => {
    assert.ok(eventScenarios.length > 0);
    for (const s of eventScenarios) {
      const weeks = new Set(s.checkpoints.map((c: Row) => periodizationWeekStart(coachLocalDate(c.asOf))));
      assert.ok(weeks.size >= 2, `${s.scenarioId}: event trace must cross a natural-week boundary`);
      for (const c of s.checkpoints) for (const id of c.visibleEventIds) {
        const e = s.events.find((item: Row) => item.eventId === id);
        assert.ok(e && Date.parse(e.observedAt) <= Date.parse(c.asOf) && Date.parse(e.availableAt) <= Date.parse(c.asOf));
      }
    }
    assert.ok(metrics.eventCount > 0 && metrics.assessedDoseCheckpointCount > 0);
    assert.ok(metrics.executionAssessmentCheckpointCount > 0 && metrics.unknownExecutionCheckpointCount > 0);
    assert.equal(metrics.longitudinalRealTrainingEffect, "not_evaluable");
  });
  check("AC8-04", "selected-proposal-hard-metrics-zero-not-evaluable-effects", () => {
    assert.ok(scenarios.every(s => s.status === "passed"));
    assert.equal(metrics.shortProposedSessionCount, 0); assert.equal(metrics.hardViolationProposedSessionCount, 0);
    assert.ok(metrics.checkpointCount > 0); assert.ok(metrics.baseline);
    assert.equal(metrics.fullRequirementSignoff, "not_evaluable");
  });
  check("AC8-06", "behavior-reliability-not-training-benefit", () => {
    assert.equal(metrics.longitudinalRealTrainingEffect, "not_evaluable");
    assert.ok(scenarios.every(s => s.evidenceBoundary || s.scope));
    assert.ok(scenarios.filter(s => s.metrics).every(s =>
      s.metrics.longTermTrainingEffect == null || s.metrics.longTermTrainingEffect === "not_evaluable"));
  });
  let mutations: ReturnType<typeof validateCoachMutationEvidence> | null = null;
  if (mutationEvidence != null) check("AC8-05", "current-source-compiled-named-mutations", () => {
    mutations = validateCoachMutationEvidence(mutationEvidence, sourceTreeHash);
  });
  else assertions.push({ acceptanceId: "AC8-05", id: "current-source-compiled-named-mutations", status: "not_evaluable" });
  return { scenarioId: "R22-replay-evidence-audit", scenarioVersion: "evidence-audit-v1",
    policyManifest: COACH_POLICY_MANIFEST, evidenceBoundary: "engineering_artifacts_not_human_or_device_signoff",
    status: assertions.some(a => a.status === "failed") ? "failed" : "passed",
    metrics, mutationEvidence: mutations, checkpoints: [{ id: "replay-evidence", outputHash: digest(metrics), assertions }] };
}
