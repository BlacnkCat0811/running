import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RaceDistance } from "@rai/contracts";

import { buildPredictionReport } from "./prediction-report.js";

function optionValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function optionalNumber(args: string[], name: string): number | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (!raw || raw.startsWith("--")) throw new Error(`${name} requires a value`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  const databasePath = resolve(optionValue(args, "--database", "var/rai.sqlite"));
  const asOf = optionValue(args, "--as-of", new Date().toISOString());
  if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  const elevationGainMeters: Partial<Record<RaceDistance, number>> = {};
  const fiveK = optionalNumber(args, "--elevation-5k");
  const tenK = optionalNumber(args, "--elevation-10k");
  const half = optionalNumber(args, "--elevation-half");
  if (fiveK !== undefined) elevationGainMeters.five_k = fiveK;
  if (tenK !== undefined) elevationGainMeters.ten_k = tenK;
  if (half !== undefined) elevationGainMeters.half_marathon = half;
  const temperatureC = optionalNumber(args, "--temperature-c");
  const humidityPercent = optionalNumber(args, "--humidity-percent");
  const recoveryReadiness = optionalNumber(args, "--recovery-readiness");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const report = buildPredictionReport(database, {
      asOf,
      ...(temperatureC === undefined ? {} : { temperatureC }),
      ...(humidityPercent === undefined ? {} : { humidityPercent }),
      ...(recoveryReadiness === undefined ? {} : { recoveryReadiness }),
      ...(Object.keys(elevationGainMeters).length === 0 ? {} : { elevationGainMeters })
    });
    console.log(JSON.stringify({ databasePath, ...report }, null, 2));
  } finally {
    database.close();
  }
}

main();
