import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import { buildPredictionEvaluationReport } from "../src/prediction-report.js";

const CLI = resolve("packages/application/src/prediction-walk-forward-cli.ts");
const AS_OF = "2026-07-11T00:00:00+08:00";

/**
 * Walks every number in the report *before* it is serialized. This cannot be
 * folded into the stdout assertions: `JSON.stringify` silently rewrites `NaN`
 * and `Infinity` to `null`, so a regex over the printed JSON would report
 * "clean" for exactly the failure it claims to catch.
 */
function assertAllNumbersFinite(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} is not a finite number: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAllNumbersFinite(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertAllNumbersFinite(item, `${path}.${key}`);
    }
  }
}

async function withEmptyDatabase(
  run: (databasePath: string) => void | Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-walk-forward-cli-"));
  const databasePath = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(databasePath);
  store.close();
  try {
    await run(databasePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: resolve("."),
    encoding: "utf8"
  });
}

test("walk-forward CLI degrades on labeled-outcome-free database without throwing", async () => {
  await withEmptyDatabase(async (databasePath) => {
    const result = runCli("--database", databasePath, "--as-of", AS_OF);
    assert.equal(result.status, 0, result.stderr);

    const payload = JSON.parse(result.stdout) as {
      databasePath: string;
      asOf: string;
      status: string;
      evaluation: {
        reportVersion: string;
        status: string;
        labeledOutcomeCount: number;
        evaluatedOutcomeCount: number;
        machineLearningCandidate: { status: string; trainedExampleCount: number };
      };
    };
    assert.equal(payload.databasePath, databasePath);
    assert.equal(payload.status, "insufficient_labeled_outcomes");
    assert.equal(payload.evaluation.reportVersion, "rai-prediction-walk-forward-v2");
    assert.equal(payload.evaluation.status, "insufficient_labeled_outcomes");
    assert.equal(payload.evaluation.labeledOutcomeCount, 0);
    assert.equal(payload.evaluation.evaluatedOutcomeCount, 0);
    assert.equal(
      payload.evaluation.machineLearningCandidate.status,
      "insufficient_walk_forward_samples"
    );
    assert.equal(payload.evaluation.machineLearningCandidate.trainedExampleCount, 0);
  });
});

test("walk-forward evaluation produces no non-finite number before serialization", async () => {
  await withEmptyDatabase((databasePath) => {
    const database = RaiDatabase.openReadonly(databasePath);
    try {
      const evaluation = buildPredictionEvaluationReport(database, AS_OF);
      assertAllNumbersFinite(evaluation);
      // Documented-intent null, not a NaN that survived serialization.
      assert.equal(evaluation.machineLearningCandidate.meanAbsoluteErrorImprovement, null);
    } finally {
      database.close();
    }
  });
});

test("walk-forward CLI refuses a missing database file and a valueless option", async () => {
  const missing = runCli("--database", join(tmpdir(), "rai-walk-forward-absent.sqlite"));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Database not found/);

  const valueless = runCli("--database");
  assert.notEqual(valueless.status, 0);
  assert.match(valueless.stderr, /--database requires a value/);
});
