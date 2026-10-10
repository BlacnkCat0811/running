import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { replayCoachScenario } from "./coach-replay-core.mjs";
import { coachReplayScenarios } from "./coach-replay-scenarios.mjs";
import { digest } from "../apps/api/src/plan-digest.js";
import { coachExecutionReplays, coachRepairReplays } from "./coach-loop-extra-replays.mjs";
import { coachReplaySourceIdentity } from "./coach-replay-provenance.mjs";
import { coachFeedbackReplays, coachGoalGapReplays } from "./coach-feedback-goal-replays.mjs";
import { coachRaceProtectionReplays } from "./coach-race-protection-replays.mjs";
import { coachRuntimeReplays } from "./coach-runtime-replays.mjs";
import { coachAcceptanceReplays } from "./coach-acceptance-replays.mjs";
import { coachPublicationReplays } from "./coach-publication-replays.mjs";
import { coachSummaryReplays } from "./coach-summary-replays.mjs";
import { coachReplayAudit } from "./coach-replay-audit.mjs";
import { parseArgs } from "node:util";

export function runCoachBehaviorReplay(outputPath?: string, mutationEvidence?: unknown) {
  const sourceIdentity = coachReplaySourceIdentity();
  const scenarios = coachReplayScenarios().map(replayCoachScenario);
  const executionScenarios = coachExecutionReplays();
  const repairScenarios = coachRepairReplays();
  const feedbackScenarios = coachFeedbackReplays();
  const goalScenarios = coachGoalGapReplays();
  const raceScenarios = coachRaceProtectionReplays();
  const runtimeScenarios = coachRuntimeReplays();
  const acceptanceScenarios = [...coachAcceptanceReplays(), ...coachPublicationReplays(), ...coachSummaryReplays()];
  const behaviorScenarios = [...scenarios, ...executionScenarios, ...repairScenarios, ...feedbackScenarios, ...goalScenarios,
    ...raceScenarios, ...runtimeScenarios, ...acceptanceScenarios];
  const evidenceAudit = coachReplayAudit(behaviorScenarios, sourceIdentity.sourceTreeHash, mutationEvidence);
  const allScenarios = [...behaviorScenarios, evidenceAudit];
  if (sourceIdentity.sourceTreeHash !== coachReplaySourceIdentity().sourceTreeHash)
    throw new Error("Source changed during coach behavior replay");
  const report = {
    schemaVersion: 1, purpose: "behavior_reliability_not_training_effect",
    scope: "O8_candidate_and_runtime_regressions",
    ...sourceIdentity,
    status: allScenarios.every(scenario => scenario.status === "passed") ? "passed" : "failed",
    fullPlanAcceptance: "not_evaluable",
    limitations: ["selected_assertions_per_scenario_not_all_plan_acceptance",
      "real_health_effect_not_measured", "legacy_device_consumer_acceptance_not_measured"],
    scenarios, executionScenarios, repairScenarios, feedbackScenarios, goalScenarios, raceScenarios, runtimeScenarios,
    acceptanceScenarios, evidenceAudit
  };
  const encoded = JSON.stringify({ ...report, reportHash: digest(report) }, null, 2);
  if (outputPath) {
    const path = resolve(outputPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${encoded}\n`);
    console.log(`Coach replay: ${report.status}; ${allScenarios.length} candidate/runtime subscenarios. ${path}`);
  } else console.log(encoded);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: "string" }, "mutation-evidence": { type: "string" } } });
  const mutations = values["mutation-evidence"] ? JSON.parse(readFileSync(resolve(values["mutation-evidence"]), "utf8")) : undefined;
  process.exitCode = runCoachBehaviorReplay(values.output, mutations).status === "passed" ? 0 : 1;
}
