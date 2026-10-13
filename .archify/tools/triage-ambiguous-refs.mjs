import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = "D:\\running";
const doc = ".archify/rai-audit-20261013-160439/verification/VERIFICATION.md";
const text = readFileSync(resolve(root, doc), "utf8");

// Refs the checker flagged as out-of-range, plus their candidate files.
const flagged = [
  ["cli.ts", "171-176"],
  ["cli.ts", "184-196"],
  ["cli.ts", "189-195"],
  ["cli.ts", "214"],
  ["cli.ts", "234-240"],
  ["cli.ts", "471"],
  ["recompute-job-repository.ts", "104-129"],
  ["recompute-job-repository.ts", "109-120"]
];

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n").filter(Boolean);

function lineCount(rel) {
  return readFileSync(resolve(root, rel), "utf8").split("\n").length;
}

for (const [base, range] of flagged) {
  const candidates = tracked.filter((p) => p.endsWith("/" + base) || p === base);
  const first = Number(range.split("-")[0]);
  const last = Number(range.split("-")[1] ?? range);
  console.log(`${base}:${range}`);
  for (const c of candidates) {
    const n = lineCount(c);
    const fits = last <= n;
    console.log(`    ${fits ? "FITS  " : "EXCEED"} ${String(n).padStart(5)} lines  ${c}`);
  }
  // Which candidate does the sentence actually name?
  const context = text.split("\n").filter((l) => l.includes(`${base}:${range.split("-")[0]}`));
  for (const line of context.slice(0, 2)) {
    const owner = line.match(/([A-Za-z0-9_./-]+\/)?([A-Za-z0-9_./-]*cli\.ts|[A-Za-z0-9_./-]*recompute-job-repository\.ts)/g) ?? [];
    console.log(`    context mentions: ${[...new Set(owner)].join(", ") || "(bare basename)"}`);
  }
  console.log("");
}
