import { existsSync } from "node:fs";
import { RaiDatabase, acquireDatabasePublicationLock, resolveDatabasePathIdentity } from "@rai/storage-sqlite";

const args = process.argv.slice(2);
const value = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] ?? (() => { throw new Error(`${name} requires a value`); })();
};
const database = resolveDatabasePathIdentity(value("--database", "var/rai.sqlite"));
const olderThanDays = Number(value("--older-than-days", "365"));
const limit = Number(value("--limit", "1000"));
if (!existsSync(database)) throw new Error(`Database not found: ${database}`);
// 阶段 4（I1）：这是可写主库 CLI（`RaiDatabase.open` 还可能执行迁移，
// `pruneEntityTombstones` 会删除行），必须在打开写连接前与 API/其他 CLI 互斥。
const releasePublication = acquireDatabasePublicationLock(database, "cli");
let store: RaiDatabase | undefined;
try {
  store = await RaiDatabase.open(database);
  const removed = store.pruneEntityTombstones({ olderThanDays, limit });
  console.log(JSON.stringify({ removed, olderThanDays, limit }));
} finally {
  try { store?.close(); } finally { releasePublication(); }
}
