import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { digest } from "../apps/api/src/plan-digest.js";
import { coachReplaySourceIdentity } from "./coach-replay-provenance.mjs";
import { validateCoachMutationEvidence } from "./coach-replay-audit.mjs";

export function coachAcceptanceInventory(plan: string) {
  const rows = [...plan.matchAll(/^\| (AC[0-6]-\d{2}) \| (.*?) \| (.*?) \|$/gm)]
    .map(match => ({ id: match[1]!, scenario: match[2]!, requirement: match[3]! }));
  for (const match of plan.matchAll(/^- (AC8-\d{2})：(.+)$/gm))
    rows.push({ id: match[1]!, scenario: "行为回放", requirement: match[2]! });
  if (rows.length !== 78 || new Set(rows.map(row => row.id)).size !== 78) throw new Error("Expected all 78 unique plan acceptance IDs; fail closed on document drift");
  return rows;
}

type Evidence = { sourceTreeHash: string; reportHash: string; status?: string; [key: string]: unknown };
export function auditCoachRelease(plan: string, evidence: Record<string, Evidence>, expectedSourceHash: string) {
  const inventory = coachAcceptanceInventory(plan), blockers: string[] = [], assertions = new Set<string>(), scenarios = new Set<string>();
  const mappings = new Map<string, Array<{ scenarioId: string | null; checkpointId: string | null;
    assertionId: string; evidenceBoundary: unknown; policyManifest: unknown }>>();
  const required = ["replay", "mutations", "benchmark", "isolated", "verification"];
  for (const name of required) {
    const artifact = evidence[name];
    if (!artifact) { blockers.push(`missing_${name}_evidence`); continue; }
    const { reportHash, ...payload } = artifact;
    if (reportHash !== digest(payload)) blockers.push(`invalid_${name}_hash`);
    if (artifact.sourceTreeHash !== expectedSourceHash) blockers.push(`stale_${name}_source`);
    if (artifact.status != null && artifact.status !== "passed") blockers.push(`failed_${name}`);
  }
  let compiledMutationsCertified = false;
  try {
    const certified = validateCoachMutationEvidence(evidence.mutations, expectedSourceHash);
    compiledMutationsCertified = (evidence.replay?.evidenceAudit as Record<string, any> | undefined)
      ?.mutationEvidence?.reportHash === certified.reportHash;
  } catch { /* Missing, stale or uncompiled mutation evidence cannot map AC8-05. */ }
  type Context = { scenarioId: string | null; checkpointId: string | null; evidenceBoundary: unknown; policyManifest: unknown };
  const emptyContext: Context = { scenarioId: null, checkpointId: null, evidenceBoundary: null, policyManifest: null };
  function record(rawId: string, assertionId: string, context: Context) {
    const id = rawId.match(/^AC[0-68]-\d{2}(?:$|[-/])/)?.[0].match(/^AC[0-68]-\d{2}/)?.[0];
    if (!id || id === "AC8-05" && !compiledMutationsCertified) return;
    assertions.add(id);
    const entry = { ...context, assertionId }, rows = mappings.get(id) ?? [];
    if (!rows.some(row => digest(row) === digest(entry))) rows.push(entry);
    mappings.set(id, rows);
  }
  function walk(value: unknown, parent: Context = emptyContext) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const row of value) walk(row, parent); return; }
    const row = value as Record<string, unknown>;
    // A failed scenario/checkpoint never certifies its earlier passing children.
    if (row.status != null && row.status !== "passed") return;
    const scenarioId = typeof row.scenarioId === "string" ? row.scenarioId :
      typeof row.id === "string" && /^R\d{2}/.test(row.id) ? row.id : parent.scenarioId;
    const context = { scenarioId, checkpointId: parent.checkpointId,
      evidenceBoundary: row.evidenceBoundary ?? row.scope ?? parent.evidenceBoundary,
      policyManifest: row.policyManifest ?? parent.policyManifest };
    if (row.status === "passed" && typeof row.scenarioId === "string" || row.status === "passed" && typeof row.id === "string" && /^R\d{2}/.test(row.id)) {
      const id = String(row.scenarioId ?? row.id).match(/^R\d{2}/)?.[0]; if (id) scenarios.add(id);
    }
    if (row.status === "passed" && typeof row.acceptanceId === "string") {
      record(row.acceptanceId, String(row.id ?? row.acceptanceId), context);
    }
    // Runtime checkpoint functions throw on any failed assertion; their parent
    // scenario status is certified before these compact checkpoint IDs count.
    if (row.status === "passed" && Array.isArray(row.checkpoints)) for (const checkpoint of row.checkpoints) {
      if (checkpoint && typeof checkpoint.id === "string" &&
          (checkpoint.status == null || checkpoint.status === "passed") &&
          (!Array.isArray(checkpoint.assertions) || checkpoint.assertions.every((a: Record<string, unknown>) => a.status === "passed"))) {
        record(checkpoint.id, checkpoint.id, { ...context, checkpointId: checkpoint.id });
      }
    }
    for (const [key, child] of Object.entries(row)) {
      if (key === "checkpoints" && Array.isArray(child)) {
        for (const checkpoint of child) walk(checkpoint, { ...context,
          checkpointId: String(checkpoint.id ?? checkpoint.asOf ?? "") || null });
      } else walk(child, context);
    }
  }
  // Never count an artifact that failed its own hash/source identity check.
  if (evidence.replay?.sourceTreeHash === expectedSourceHash &&
      evidence.replay.status === "passed" && digest(Object.fromEntries(Object.entries(evidence.replay).filter(([key]) => key !== "reportHash"))) === evidence.replay.reportHash)
    walk(evidence.replay);
  const coverage = inventory.map(row => ({ ...row, replayEvidence: assertions.has(row.id) ? "selected_assertions_passed" : "not_evaluable",
    replayMappings: mappings.get(row.id) ?? [], fullRequirementSignoff: "not_evaluable" }));
  const missingScenarios = Array.from({ length: 22 }, (_, i) => `R${String(i + 1).padStart(2, "0")}`).filter(id => !scenarios.has(id));
  if (missingScenarios.length) blockers.push("incomplete_22_scenario_classes");
  if (coverage.some(row => row.replayEvidence === "not_evaluable")) blockers.push("incomplete_78_acceptance_replay_coverage");
  // Technical evidence can never sign for these independent owners. No
  // boolean flag or empty JSON can manufacture a professional/device approval.
  blockers.push("independent_domain_policy_review_required", "independent_golden_review_required",
    "physical_device_and_rollback_acceptance_required", "longitudinal_real_data_acceptance_required",
    "full_requirement_signoff_required");
  return { schemaVersion: 1, purpose: "release_readiness_not_training_effect", status: "blocked",
    sourceTreeHash: expectedSourceHash, deploymentAuthorized: false, blockers: [...new Set(blockers)],
    scenarioClassesWithSelectedEvidence: [...scenarios].sort(), missingScenarios,
    selectedAcceptanceReplayCount: coverage.filter(row => row.replayEvidence === "selected_assertions_passed").length,
    missingAcceptanceReplayIds: coverage.filter(row => row.replayEvidence === "not_evaluable").map(row => row.id),
    acceptance: coverage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { evidence: { type: "string" }, output: { type: "string" },
    "require-release": { type: "boolean", default: false } } });
  if (!values.evidence || !values.output) throw new Error("Usage: check:coach-release --evidence DIR --output PATH [--require-release]");
  const evidence: Record<string, Evidence> = {};
  for (const name of ["replay", "mutations", "benchmark", "isolated", "verification"]) {
    try { evidence[name] = JSON.parse(readFileSync(resolve(values.evidence, `${name}.json`), "utf8")); }
    catch { /* Missing/invalid artifacts become explicit blockers, never a pass. */ }
  }
  const report = auditCoachRelease(readFileSync(resolve("docs/COACH_LOOP_OPTIMIZATION_PLAN.md"), "utf8"),
    evidence, coachReplaySourceIdentity().sourceTreeHash);
  const path = resolve(values.output); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...report, reportHash: digest(report) }, null, 2)}\n`);
  console.log(`Coach release ${report.status}; ${report.acceptance.length} individually inventoried criteria. ${path}`);
  if (values["require-release"]) process.exitCode = 1;
}
