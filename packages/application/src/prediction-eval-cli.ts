import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { RaiDatabase } from "@rai/storage-sqlite";

function optionValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const databasePath = resolve(optionValue(args, "--database", "var/rai.sqlite"));
  const asOf = optionValue(args, "--as-of", new Date().toISOString());
  if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  const database = RaiDatabase.openReadonly(databasePath);
  try {
    const active = database.prepare(`
      SELECT run.id, run.model_version AS modelVersion,
        run.artifact_path AS artifactPath, run.artifact_sha256 AS artifactSha256,
        active.activated_at AS activatedAt
      FROM active_prediction_model active
      JOIN prediction_model_runs run ON run.id = active.prediction_model_run_id
      WHERE active.singleton = 1 AND run.status = 'succeeded'
    `).get() as {
      id: string;
      modelVersion: string;
      artifactPath: string;
      artifactSha256: string;
      activatedAt: string;
    } | undefined;
    if (!active) {
      console.log(JSON.stringify({ databasePath, asOf, status: "no_active_catboost_model" }, null, 2));
      return;
    }
    const evaluationPath = resolve(active.artifactPath, "evaluation.json");
    if (!existsSync(evaluationPath)) throw new Error(`CatBoost evaluation not found: ${evaluationPath}`);
    const evaluation = JSON.parse(readFileSync(evaluationPath, "utf8")) as unknown;
    console.log(JSON.stringify({
      databasePath,
      asOf,
      status: "active_catboost_evaluation",
      activeModel: active,
      evaluation
    }, null, 2));
  } finally {
    database.close();
  }
}

main();
