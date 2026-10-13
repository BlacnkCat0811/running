#!/usr/bin/env node
/**
 * Read-only geometry pre-check for Archify architecture / dataflow candidates.
 * Models the orthogonal routing the renderer uses:
 *   - endpoint sides derived from the relative position of the two boxes
 *   - if the two ports share an axis, one straight segment
 *   - otherwise a 2-bend Z route
 * Reports overlapping boxes, segments crossing boxes, segment/segment proper
 * crossings, and collinear overlapping segments. Writes nothing; stdout only.
 *
 * Usage: node check-geometry.mjs <candidate.json>
 * Also importable: auditArchitecture(arch) -> string[]
 */
import { readFileSync } from "node:fs";

const EPS = 0.001;

function makeBox(c) {
  const [x, y] = c.pos;
  const [w, h] = c.size ?? [120, 60];
  return { id: c.id, x, y, w, h, x2: x + w, y2: y + h, cx: x + w / 2, cy: y + h / 2 };
}

const seg = (x1, y1, x2, y2) => ({
  x1: Math.min(x1, x2), y1: Math.min(y1, y2),
  x2: Math.max(x1, x2), y2: Math.max(y1, y2)
});
const isH = (s) => Math.abs(s.y1 - s.y2) < EPS;
const isV = (s) => Math.abs(s.x1 - s.x2) < EPS;
const len = (s) => (isH(s) ? s.x2 - s.x1 : s.y2 - s.y1);

function pick(box, side) {
  if (side === "left") return [box.x, box.cy];
  if (side === "right") return [box.x2, box.cy];
  if (side === "top") return [box.cx, box.y];
  return [box.cx, box.y2];
}

function autoSide(src, dst) {
  const dx = dst.cx - src.cx;
  const dy = dst.cy - src.cy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** Mirrors the renderer's default: straight when the ports are collinear, else a Z. */
export function routeConnection(a, b, fromSide, toSide) {
  const fs = fromSide ?? autoSide(a, b);
  const ts = toSide ?? autoSide(b, a);
  const [px, py] = pick(a, fs);
  const [qx, qy] = pick(b, ts);
  const out = [];
  const push = (x1, y1, x2, y2) => {
    const s = seg(x1, y1, x2, y2);
    if (len(s) > 0.5) out.push(s);
  };
  const horizontalPort = (s) => s === "left" || s === "right";
  if (Math.abs(px - qx) < EPS && !horizontalPort(fs) && !horizontalPort(ts)) { push(px, py, qx, qy); return out; }
  if (Math.abs(py - qy) < EPS && horizontalPort(fs) && horizontalPort(ts)) { push(px, py, qx, qy); return out; }
  if (horizontalPort(fs)) {
    const mid = (px + qx) / 2;
    push(px, py, mid, py); push(mid, py, mid, qy); push(mid, qy, qx, qy);
  } else {
    const mid = (py + qy) / 2;
    push(px, py, px, mid); push(px, mid, qx, mid); push(qx, mid, qx, qy);
  }
  return out;
}

function crossesBox(s, box) {
  const ix = box.x + 0.5, iy = box.y + 0.5, ix2 = box.x2 - 0.5, iy2 = box.y2 - 0.5;
  if (isH(s)) {
    if (s.y1 <= iy || s.y1 >= iy2) return false;
    return s.x1 < ix2 && s.x2 > ix;
  }
  if (s.x1 <= ix || s.x1 >= ix2) return false;
  return s.y1 < iy2 && s.y2 > iy;
}

function properCross(a, b) {
  if (isH(a) && isV(b)) {
    return b.x1 > a.x1 + EPS && b.x1 < a.x2 - EPS && a.y1 > b.y1 + EPS && a.y1 < b.y2 - EPS;
  }
  if (isV(a) && isH(b)) return properCross(b, a);
  return false;
}

function collinearOverlap(a, b) {
  if (isH(a) && isH(b) && Math.abs(a.y1 - b.y1) < EPS) {
    return Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > EPS;
  }
  if (isV(a) && isV(b) && Math.abs(a.x1 - b.x1) < EPS) {
    return Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > EPS;
  }
  return false;
}

/**
 * Two edges that share an endpoint line up on purpose when they leave the same
 * side of that endpoint (a fan-out / fan-in port). The renderer draws that as one
 * continuous stroke, which is not a defect, so only report overlaps between
 * connections that do not share a node.
 */
function sharesEndpoint(connA, connB, connections) {
  const find = (id) => connections.find((c) => (c.id ?? `${c.from}->${c.to}`) === id);
  const a = find(connA), b = find(connB);
  if (!a || !b) return false;
  return a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to;
}

export function auditArchitecture(arch) {
  const problems = [];
  const boxes = new Map();
  for (const c of arch.components ?? []) {
    if (!Array.isArray(c.pos)) { problems.push(`NO-POS: ${c.id}`); continue; }
    boxes.set(c.id, makeBox(c));
  }
  const ids = [...boxes.keys()];

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = boxes.get(ids[i]), b = boxes.get(ids[j]);
      if (a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2) problems.push(`BOX-OVERLAP: ${a.id} <-> ${b.id}`);
    }
  }

  const allSegments = [];
  for (const conn of arch.connections ?? []) {
    const a = boxes.get(conn.from), b = boxes.get(conn.to);
    if (!a || !b) { problems.push(`MISSING-NODE: ${conn.from} -> ${conn.to}`); continue; }
    const path = routeConnection(a, b, conn.fromSide, conn.toSide);
    if (!path.length) problems.push(`EMPTY-ROUTE: ${conn.from}->${conn.to}`);
    const key = conn.id ?? `${conn.from}->${conn.to}`;
    for (const s of path) {
      allSegments.push({ key, s });
      for (const box of boxes.values()) {
        if (box.id === conn.from || box.id === conn.to) continue;
        if (crossesBox(s, box)) problems.push(`SEG-THROUGH-BOX: ${key} passes box ${box.id}`);
      }
    }
  }

  const byKey = new Map();
  for (const item of allSegments) {
    if (!byKey.has(item.key)) byKey.set(item.key, []);
    byKey.get(item.key).push(item.s);
  }
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      for (const sa of byKey.get(keys[i])) {
        for (const sb of byKey.get(keys[j])) {
          if (properCross(sa, sb)) problems.push(`CROSSING: ${keys[i]} x ${keys[j]}`);
          else if (collinearOverlap(sa, sb) && !sharesEndpoint(keys[i], keys[j], arch.connections ?? [])) {
            problems.push(`COLLINEAR-OVERLAP: ${keys[i]} || ${keys[j]}`);
          }
        }
      }
    }
  }

  for (const b of arch.boundaries ?? []) {
    for (const id of b.wraps) if (!boxes.has(id)) problems.push(`BOUNDARY-UNKNOWN: ${id}`);
  }
  return [...new Set(problems)];
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
if (isMain || process.argv[1]?.endsWith("check-geometry.mjs")) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node check-geometry.mjs <candidate.json>"); process.exit(2); }
  const arch = JSON.parse(readFileSync(file, "utf8"));
  const problems = auditArchitecture(arch);
  console.log(`file: ${file}`);
  console.log(`components: ${(arch.components ?? []).length}  connections: ${(arch.connections ?? []).length}  boundaries: ${(arch.boundaries ?? []).length}`);
  if (!problems.length) console.log("GEOMETRY: clean");
  else { console.log(`GEOMETRY: ${problems.length} problem(s)`); for (const p of problems) console.log(`  - ${p}`); }
  process.exit(problems.length ? 1 : 0);
}
