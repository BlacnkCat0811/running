// 阶段 2 follow-up C：导出隔离数据库上的完整 workoutSeries 正文，供改造前后逐字节差分。
// 只读打开数据库；不写任何业务库。用法：
//   node --import tsx scripts/phase2-series-dump.mjs --db <sqlite> --json <out> [--limit 30]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RaiReadStore } from "../apps/api/src/data.ts";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const databasePath = readArg("--db");
const out = readArg("--json");
if (databasePath === null || out === null || !isAbsolute(out)) {
  console.error("usage: phase2-series-dump.mjs --db <sqlite> --json <absolute-out> [--limit 30]");
  process.exit(2);
}
const limit = Number(readArg("--limit", "30"));
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
  console.error(`--limit must be an integer between 1 and 1000: ${limit}`);
  process.exit(2);
}

const lookup = new DatabaseSync(resolve(databasePath), { readOnly: true });
let ids;
try {
  ids = lookup.prepare(`
    SELECT session.id AS id
    FROM training_sessions session
    JOIN workouts workout ON workout.id = session.canonical_workout_id
    ORDER BY session.anchor_start_at, session.id
    LIMIT ?
  `).all(limit).map((row) => String(row.id));
} finally { lookup.close(); }

const store = new RaiReadStore(resolve(databasePath));
const items = [];
try {
  for (const id of ids) {
    const body = store.workoutSeries(id);
    const text = JSON.stringify(body);
    items.push({
      sessionId: id,
      present: body !== null,
      bytes: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      body
    });
  }
} finally { store.close(); }

const document = { database: resolve(databasePath), count: items.length, items };
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify({ database: document.database, count: items.length, items: items.map(({ sessionId, present, bytes, sha256 }) => ({ sessionId, present, bytes, sha256 })) }, null, 2));
