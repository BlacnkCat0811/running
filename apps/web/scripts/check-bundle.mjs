import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const assetDirectory = resolve(import.meta.dirname, "../dist/assets");
export const budgets = [
  { pattern: /^charts-.*\.js$/, maximumBytes: 450 * 1024, label: "shared chart code" },
  { pattern: /^index-.*\.js$/, maximumBytes: 250 * 1024, label: "application entry" },
  { pattern: /^index-.*\.css$/, maximumBytes: 100 * 1024, label: "application styles" }
];

export async function checkBundleBudgets(directory, configuredBudgets = budgets) {
  const assets = await readdir(directory);
  const failures = [];
  for (const budget of configuredBudgets) {
    const matches = assets.filter((name) => budget.pattern.test(name));
    if (matches.length === 0) {
      failures.push(`${budget.label} did not match any bundle assets (${budget.pattern})`);
      continue;
    }

    for (const name of matches) {
      const info = await stat(resolve(directory, name));
      if (info.size > budget.maximumBytes) {
        failures.push(`${budget.label} ${name} is ${info.size} bytes; budget is ${budget.maximumBytes} bytes`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Web bundle budget check failed:\n${failures.join("\n")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkBundleBudgets(assetDirectory);
}
