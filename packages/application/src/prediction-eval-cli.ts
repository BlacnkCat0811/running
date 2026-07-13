import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildPredictionEvaluationReport } from "./prediction-report.js";

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
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    console.log(JSON.stringify({
      databasePath,
      ...buildPredictionEvaluationReport(database, asOf)
    }, null, 2));
  } finally {
    database.close();
  }
}

main();
