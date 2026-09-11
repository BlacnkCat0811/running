import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { RaiDatabase } from "@rai/storage-sqlite";

const args = process.argv.slice(2);
const value = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? (() => { throw new Error(`${name} requires a value`); })();
};
const database = resolve(value("--database", "var/rai.sqlite"));
const olderThanDays = Number(value("--older-than-days", "365"));
const limit = Number(value("--limit", "1000"));
if (!existsSync(database)) throw new Error(`Database not found: ${database}`);
const store = await RaiDatabase.open(database);
try {
  const removed = store.pruneEntityTombstones({ olderThanDays, limit });
  console.log(JSON.stringify({ removed, olderThanDays, limit }));
} finally { store.close(); }
