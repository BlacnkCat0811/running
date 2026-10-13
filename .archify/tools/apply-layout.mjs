#!/usr/bin/env node
/**
 * One-off, read-only-elsewhere helper: applies a reviewed component-position map
 * to an Archify architecture candidate. Touches only the target candidate file.
 *
 * Usage: node apply-layout.mjs <candidate.json> <positions.json>
 * positions.json: { "<componentId>": [x, y], ... }
 */
import { readFileSync, writeFileSync } from "node:fs";

const [candidatePath, positionsPath] = process.argv.slice(2);
if (!candidatePath || !positionsPath) {
  console.error("usage: node apply-layout.mjs <candidate.json> <positions.json>");
  process.exit(2);
}
const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
const positions = JSON.parse(readFileSync(positionsPath, "utf8"));

const known = new Set(candidate.components.map((c) => c.id));
for (const id of Object.keys(positions)) {
  if (!known.has(id)) { console.error(`unknown component id: ${id}`); process.exit(3); }
}
let moved = 0;
for (const component of candidate.components) {
  const next = positions[component.id];
  if (!Array.isArray(next) || next.length !== 2) continue;
  component.pos = [next[0], next[1]];
  moved += 1;
}
writeFileSync(candidatePath, JSON.stringify(candidate, null, 2) + "\n", "utf8");
console.log(`applied ${moved} position(s) to ${candidatePath}`);
