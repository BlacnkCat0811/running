import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const assetDirectory = resolve(import.meta.dirname, "../dist/assets");
const budgets = [
  { pattern: /^charts-.*\.js$/, maximumBytes: 450 * 1024, label: "shared chart code" },
  { pattern: /^index-.*\.js$/, maximumBytes: 250 * 1024, label: "application entry" },
  { pattern: /^index-.*\.css$/, maximumBytes: 100 * 1024, label: "application styles" }
];

const assets = await readdir(assetDirectory);
const failures = [];
for (const budget of budgets) {
  const matches = assets.filter((name) => budget.pattern.test(name));
  for (const name of matches) {
    const info = await stat(resolve(assetDirectory, name));
    if (info.size > budget.maximumBytes) {
      failures.push(`${budget.label} ${name} is ${info.size} bytes; budget is ${budget.maximumBytes} bytes`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Web bundle budget exceeded:\n${failures.join("\n")}`);
}
