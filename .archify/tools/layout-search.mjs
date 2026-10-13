#!/usr/bin/env node
/**
 * Read-only layout search for an Archify architecture candidate.
 * Preserves every id / type / label / source / connection / boundary / card as
 * authored, and searches only component positions, sizes, and endpoint port
 * sides so that the geometry contract holds: no overlapping boxes, no edge
 * passing through a foreign box, no proper crossings, no collinear overlap.
 *
 * Usage: node layout-search.mjs <candidate.json> <fixedIdsCsv> [seconds]
 * Prints the suggested positions and sides; writes nothing.
 */
import { readFileSync } from "node:fs";
import { auditArchitecture } from "./check-geometry.mjs";

const file = process.argv[2];
const fixed = new Set((process.argv[3] ?? "").split(",").filter(Boolean));
const budgetMs = Number(process.argv[4] ?? 60) * 1000;
const arch = JSON.parse(readFileSync(file, "utf8"));

const W = 200, H = 84;
for (const c of arch.components) c.size = [W, H];

const XS = [40, 300, 560, 820, 1080, 1340];
const YS = [120, 320, 520, 720, 920, 1120];
const CELLS = [];
for (const x of XS) for (const y of YS) CELLS.push([x, y]);
const SIDES = [undefined, "left", "right", "top", "bottom"];

const movable = arch.components.filter((c) => !fixed.has(c.id));
const CARD = 260, GAP = 40;
const weight = (p) => {
  if (p.startsWith("BOX-OVERLAP")) return 1000;
  if (p.startsWith("SEG-THROUGH-BOX")) return 900;
  if (p.startsWith("CROSSING")) return 100;
  if (p.startsWith("COLLINEAR-OVERLAP")) return 80;
  return 400;
};
const column = (x) => Math.floor(x / CARD);
const row = (y) => Math.floor(y / (160 + GAP));
const MIN_GAP = 16;
/** Keep the canvas narrow enough that ordinary context text stays readable at 1440px. */
function compactnessPenalty(components) {
  let penalty = 0;
  let maxX = 0, maxY = 0;
  for (const c of components) { maxX = Math.max(maxX, c.pos[0]); maxY = Math.max(maxY, c.pos[1]); }
  if (maxX > 1340) penalty += (maxX - 1340) * 4;
  if (maxY > 920) penalty += (maxY - 920) * 2;
  const usedRows = new Set(components.map((c) => row(c.pos[1])));
  penalty += Math.max(0, usedRows.size - 4) * 120;
  return penalty;
}
const cost = (problems) => problems.reduce((sum, p) => sum + weight(p), 0);
function evaluate() {
  const p = auditArchitecture(arch);
  return { problems: p, c: cost(p) + compactnessPenalty(arch.components) };
}

const deadline = Date.now() + budgetMs;
let bestEver = null;
let solved = false;

for (let attempt = 0; attempt < 400 && Date.now() < deadline && !solved; attempt++) {
  if (bestEver) {
    // Restart from the best known state, jittered.
    for (const c of arch.components) {
      const known = bestEver.snapshot.find(([id]) => id === c.id);
      c.pos = [...known[1]];
    }
    for (const conn of arch.connections) {
      const known = bestEver.sides.find(([id]) => id === (conn.id ?? `${conn.from}->${conn.to}`));
      if (known) { conn.fromSide = known[1][0]; conn.toSide = known[1][1]; }
    }
    for (const c of movable) if (Math.random() < 0.35) c.pos = [...CELLS[Math.floor(Math.random() * CELLS.length)]];
  } else {
    movable.forEach((c, index) => {
      const authored = arch.components.find((item) => item.id === c.id).pos;
      c.pos = Array.isArray(authored) ? [...authored] : [...CELLS[(index * 5 + 4) % CELLS.length]];
    });
  }

  let state = evaluate();
  let improved = true;
  while (improved && Date.now() < deadline) {
    improved = false;

    for (const c of movable) {
      const keepPos = [...c.pos];
      const order = CELLS.map((cell) => [Math.random(), cell]).sort((a, b) => a[0] - b[0]).map(([, cell]) => cell);
      let bestPos = keepPos, bestC = state.c, bestProblems = state.problems;
      for (const [x, y] of order) {
        if (x === keepPos[0] && y === keepPos[1]) continue;
        c.pos = [x, y];
        const next = evaluate();
        if (next.c < bestC) { bestC = next.c; bestPos = [x, y]; bestProblems = next.problems; }
      }
      c.pos = bestPos;
      if (bestC < state.c) { state = { c: bestC, problems: bestProblems }; improved = true; }
      if (Date.now() > deadline) break;
    }

    for (const conn of arch.connections) {
      const keepFrom = conn.fromSide, keepTo = conn.toSide;
      let bestFrom = keepFrom, bestTo = keepTo, bestC = state.c, bestProblems = state.problems;
      for (const fs of SIDES) {
        for (const ts of SIDES) {
          conn.fromSide = fs; conn.toSide = ts;
          const next = evaluate();
          if (next.c < bestC) { bestC = next.c; bestFrom = fs; bestTo = ts; bestProblems = next.problems; }
        }
      }
      conn.fromSide = bestFrom; conn.toSide = bestTo;
      if (bestC < state.c) { state = { c: bestC, problems: bestProblems }; improved = true; }
      if (Date.now() > deadline) break;
    }
  }

  if (!bestEver || state.c < bestEver.c) {
    bestEver = {
      c: state.c,
      problems: state.problems,
      snapshot: arch.components.map((c) => [c.id, [...c.pos]]),
      sides: arch.connections.map((conn) => [conn.id ?? `${conn.from}->${conn.to}`, [conn.fromSide, conn.toSide]])
    };
  }
  if (state.c === 0) { solved = true; break; }
}

if (solved) {
  console.log("LAYOUT: clean");
} else {
  console.log(`LAYOUT: best cost ${bestEver?.c}`);
  for (const p of bestEver?.problems ?? []) console.log(`  - ${p}`);
}
console.log("POSITIONS=" + JSON.stringify(Object.fromEntries(arch.components.map((c) => [c.id, c.pos]))));
const sidesOut = {};
for (const conn of arch.connections) {
  if (conn.fromSide || conn.toSide) sidesOut[conn.id ?? `${conn.from}->${conn.to}`] = { fromSide: conn.fromSide, toSide: conn.toSide };
}
console.log("SIDES=" + JSON.stringify(sidesOut));
