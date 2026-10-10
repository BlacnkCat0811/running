import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runFrozenRepairInput, syntheticRepairEasy, syntheticRepairRest, type FrozenRepairInput } from "./coach-repair-fixtures.mjs";
import { coachReplayInput } from "./coach-replay-scenarios.mjs";
import { digest } from "../apps/api/src/plan-digest.js";
import { COACH_POLICY_MANIFEST } from "../apps/api/src/coach-loop-policy.js";
import { coachReplaySourceIdentity } from "./coach-replay-provenance.mjs";
import { sevenDayRepairOracle } from "./coach-repair-oracle.mjs";

/** Real unified-constraint candidate workload, not a dummy-loop timing claim. */
export function coachRepairBenchmarkInputs(): FrozenRepairInput[] {
  const dates = ["2026-10-08", "2026-10-10", "2026-10-12"];
  const previous = dates.map(syntheticRepairEasy);
  const candidates = Object.fromEntries(dates.map(date => {
    const longer = structuredClone(syntheticRepairEasy(date));
    longer.day.structure!.blocks[0]!.steps[0]!.goal = { type: "time", seconds: 1800 };
    return [date, [
      { ...longer, templateId: "longer-complete-easy", originDate: date, preferenceRank: 1 },
      { ...syntheticRepairRest(date), templateId: "safe-rest", originDate: null, preferenceRank: 2 }
    ]];
  }));
  return [0, 10, 18, 25].map(actualKm => ({
    asOf: "2026-10-08T04:00:00Z", previous, candidates, affectedDates: dates,
    protectedDates: [], requiredIntentDates: [], zones: coachReplayInput().zones,
    weeklyKm: 20, actualKm, injuryCodes: []
  }));
}

export function benchmarkCoachRepair(outputPath?: string) {
  const inputs = coachRepairBenchmarkInputs();
  // Warm up the existing validator path before two explicit same-input rounds.
  for (const input of inputs) runFrozenRepairInput(input);
  const rounds = Array.from({ length: 2 }, (_, round) => {
    const samples = inputs.map(input => {
      const started = performance.now();
      const output = runFrozenRepairInput(input);
      return { inputHash: digest(input), elapsedMs: performance.now() - started,
        evaluatedCandidates: output.evaluatedCandidates, outputHash: digest(output), status: output.status };
    });
    const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
    return { round: round + 1, samples, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
      failureCount: samples.filter(sample => sample.status === "not_evaluable").length };
  });
  const report = {
    schemaVersion: 1, purpose: "candidate_solver_baseline_not_production_speedup",
    ...coachReplaySourceIdentity(),
    inputCohortHash: digest(inputs), policyManifest: COACH_POLICY_MANIFEST,
    publicationRuntimeBudget: "not_evaluable", oldNewSpeedup: "not_evaluable",
    deterministic: rounds[0]!.samples.every((sample, index) =>
      sample.outputHash === rounds[1]!.samples[index]?.outputHash),
    sevenDayExhaustive: sevenDayRepairOracle(),
    rounds
  };
  const encoded = JSON.stringify({ ...report, reportHash: digest(report) }, null, 2);
  if (outputPath) {
    const path = resolve(outputPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${encoded}\n`);
    console.log(`Coach repair baseline: 2 rounds × ${inputs.length} inputs; deterministic=${report.deterministic}. ${path}`);
  } else console.log(encoded);
  if (!report.deterministic || rounds.some(round => round.failureCount)) throw new Error("Coach repair benchmark failed or was not evaluable");
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args[0] !== "--output" || args.length !== 2)) throw new Error("Usage: data:coach-repair-benchmark [--output PATH]");
  benchmarkCoachRepair(args[1]);
}
