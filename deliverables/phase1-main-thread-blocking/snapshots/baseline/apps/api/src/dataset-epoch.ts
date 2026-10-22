import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const DATASET_EPOCH_KEY = "rai.dataset-epoch";

function parseEpoch(payload: string, configuredEpoch: string): string {
  const value = JSON.parse(payload) as { configuredEpoch?: unknown; epoch?: unknown } | null;
  if (typeof value?.configuredEpoch !== "string" || typeof value.epoch !== "string" || !value.epoch.trim()) {
    throw new Error("Invalid persisted dataset epoch");
  }
  return value.configuredEpoch === configuredEpoch ? value.epoch : configuredEpoch;
}

/** Independent of both the deletable facts DB and runtime.sqlite corruption recovery. */
export function writeDeletedDatasetEpoch(databasePath: string, configuredEpoch: string, epoch: string): void {
  const database = new DatabaseSync(`${databasePath}.dataset-epoch.sqlite`);
  try {
    database.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS dataset_epoch (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)`);
    database.prepare("INSERT OR REPLACE INTO dataset_epoch VALUES (1, ?)")
      .run(JSON.stringify({ configuredEpoch, epoch }));
  } finally { database.close(); }
}

function readDeletedDatasetEpoch(databasePath: string, configuredEpoch: string): string {
  const path = `${databasePath}.dataset-epoch.sqlite`;
  if (!existsSync(path)) return configuredEpoch;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const row = database.prepare("SELECT payload FROM dataset_epoch WHERE id=1").get() as { payload: string } | undefined;
    if (!row) throw new Error("Missing persisted dataset epoch");
    return parseEpoch(row.payload, configuredEpoch);
  } finally { database.close(); }
}

/** Kept in the main DB so restore commit, rollback and crash recovery agree. */
export function writeDatasetEpoch(database: DatabaseSync, configuredEpoch: string, epoch: string): void {
  database.prepare(`INSERT INTO import_manifest (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(DATASET_EPOCH_KEY, JSON.stringify({ configuredEpoch, epoch }));
}

export function readDatasetEpoch(databasePath: string, configuredEpoch: string): string {
  if (!existsSync(databasePath)) return readDeletedDatasetEpoch(databasePath, configuredEpoch);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database.prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get(DATASET_EPOCH_KEY) as { value: string } | undefined;
    if (!row) return readDeletedDatasetEpoch(databasePath, configuredEpoch);
    return parseEpoch(row.value, configuredEpoch);
  } catch (error) {
    // A missing schema or damaged DB must still allow the recovery API to boot.
    if (error instanceof Error && /no such table: import_manifest|file is not a database|database disk image is malformed|database.*corrupt/i.test(error.message)) {
      return readDeletedDatasetEpoch(databasePath, configuredEpoch);
    }
    // Lock/permission errors and malformed metadata cannot silently reuse receipts.
    throw error;
  } finally { database?.close(); }
}
