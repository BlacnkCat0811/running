import assert from "node:assert/strict";
import { digest } from "../apps/api/src/plan-digest.js";
import { COACH_POLICY_MANIFEST } from "../apps/api/src/coach-loop-policy.js";
import type { CoachPolicyManifest } from "@rai/api-contracts";

export type AcceptanceCheck = (acceptanceId: string, id: string, input: unknown, output: unknown,
  assertion: () => void) => void;
export interface AcceptanceReplayCase {
  id: string;
  evidenceBoundary: string;
  policyManifest?: CoachPolicyManifest;
  execute(check: AcceptanceCheck): void;
}

/** Assertions belong to the evaluator, not the production inputs. Each case
 * reruns from a fresh fixture; hashes omit clocks/UUIDs only where explicitly
 * projected by the caller. A failed case cannot contribute partial coverage. */
export function replayAcceptanceCases(cases: readonly AcceptanceReplayCase[]) {
  return cases.map(scenario => {
    const execute = () => {
      const checkpoints: Array<{ id: string; inputHash: string; outputHash: string; reasonCodes: string[];
        assertions: Array<{ id: string; acceptanceId: string; status: "passed" }> }> = [];
      const ids = new Set<string>();
      scenario.execute((acceptanceId, id, input, output, assertion) => {
        assert.match(acceptanceId, /^AC[0-68]-\d{2}$/);
        assert.ok(!ids.has(id), `Duplicate assertion ${scenario.id}:${id}`);
        ids.add(id);
        assertion();
        const reasonCodes = new Set<string>();
        const collect = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value)) { value.forEach(collect); return; }
          const row = value as Record<string, unknown>;
          if (typeof row.code === "string") reasonCodes.add(row.code);
          for (const key of ["reasonCodes", "reasons"]) if (Array.isArray(row[key]))
            for (const reason of row[key]) if (typeof reason === "string") reasonCodes.add(reason);
          Object.values(row).forEach(collect);
        };
        collect(output);
        checkpoints.push({ id, inputHash: digest(input), outputHash: digest(output), reasonCodes: [...reasonCodes].sort(),
          assertions: [{ id, acceptanceId, status: "passed" }] });
      });
      assert.ok(checkpoints.length, "An empty acceptance replay cannot pass");
      return checkpoints;
    };
    try {
      const checkpoints = execute();
      assert.deepEqual(execute(), checkpoints, `${scenario.id}: repeated semantic trace differs`);
      return { scenarioId: scenario.id, scenarioVersion: "synthetic-acceptance-v1",
        policyManifest: scenario.policyManifest ?? COACH_POLICY_MANIFEST, evidenceBoundary: scenario.evidenceBoundary,
        status: "passed" as const, deterministic: true, checkpoints };
    } catch (error) {
      return { scenarioId: scenario.id, scenarioVersion: "synthetic-acceptance-v1",
        policyManifest: scenario.policyManifest ?? COACH_POLICY_MANIFEST, evidenceBoundary: scenario.evidenceBoundary,
        status: "failed" as const, deterministic: false, checkpoints: [],
        error: error instanceof Error ? error.message : String(error) };
    }
  });
}
