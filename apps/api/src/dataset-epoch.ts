import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATASET_EPOCH_KEY = "rai.dataset-epoch";
/**
 * Version 3 binds the journal to the exact `serverId + athleteId` namespace.
 *
 * A record written for one deployment must never authorize a permit in another
 * deployment that happens to reuse the same `configuredEpoch` string. Version 1
 * and 2 records have no such binding; they remain readable for diagnostics and
 * for a rollback of an unstarted deletion, but they can never issue a permit
 * without an explicit operator migration.
 */
const DELETION_RECORD_VERSION = 3;

/**
 * 显式删除数据集的持久操作阶段。
 *
 * 单调顺序：`prepared → main_removed → permit_issued → writer_entered`。
 * `rolled_back` 收口未消费的删除；`superseded` 收口写者已经进入、随后由
 * 显式备份恢复替换的数据集。两者都不会再发放许可。
 */
export const DATASET_DELETION_STAGES = [
  "prepared", "main_removed", "permit_issued", "writer_entered", "rolled_back", "superseded"
] as const;
export type DatasetDeletionStage = (typeof DATASET_DELETION_STAGES)[number];

export type DatasetDeletionProtectionKind = "backup" | "quarantine";

export interface ProtectionSnapshotFile {
  suffix: "" | "-wal" | "-shm";
  sizeBytes: number;
  sha256: string;
}

/**
 * 一次显式删库操作的持久身份。
 *
 * 它**不是**第二份健康数据库：只记录“谁在什么阶段删了哪个 epoch、用哪份保护
 * 快照兜底、当时的作用域账本实例是谁”。所有字段都参与严格校验；任何缺键、
 * 类型错误、配置身份不匹配都按“无法证明”处理。
 */
export interface DatasetDeletionRecord {
  version: 1 | 2 | typeof DELETION_RECORD_VERSION;
  deletionId: string;
  configuredEpoch: string;
  previousEpoch: string;
  nextEpoch: string;
  protectionSnapshot: string;
  protectionKind: DatasetDeletionProtectionKind;
  /** Version 2 binds the exact snapshot bytes, including quarantine WAL/SHM. */
  protectionFiles?: ProtectionSnapshotFile[];
  /** Version 3 binds the journal to one deployment namespace (P2-7). */
  serverId?: string;
  athleteId?: string;
  runtimeInstanceId: string;
  stage: DatasetDeletionStage;
  createdAt: string;
  updatedAt: string;
}

/** The deployment namespace a deletion record must be bound to. */
export interface DatasetDeletionIdentity {
  serverId: string;
  athleteId: string;
}

export class DatasetEpochError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetEpochError";
  }
}

export class DatasetDeletionJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetDeletionJournalError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isInstant = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const DELETION_KEYS = new Set([
  "version", "deletionId", "configuredEpoch", "previousEpoch", "nextEpoch",
  "protectionSnapshot", "protectionKind", "runtimeInstanceId", "stage",
  "createdAt", "updatedAt"
]);
const DELETION_KEYS_V2 = new Set([...DELETION_KEYS, "protectionFiles"]);
const DELETION_KEYS_V3 = new Set([...DELETION_KEYS_V2, "serverId", "athleteId"]);

function validProtectionFiles(value: unknown, kind: DatasetDeletionProtectionKind): value is ProtectionSnapshotFile[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return false;
  const suffixes = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).length !== 3
        || !["suffix", "sizeBytes", "sha256"].every((key) => key in item)
        || (item.suffix !== "" && item.suffix !== "-wal" && item.suffix !== "-shm")
        || !Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0
        || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)
        || suffixes.has(item.suffix)) return false;
    suffixes.add(item.suffix);
  }
  return (value[0] as ProtectionSnapshotFile).suffix === ""
    && (value[0] as ProtectionSnapshotFile).sizeBytes > 0
    && (kind === "quarantine" || (value.length === 1 && suffixes.has("")));
}

/** 严格解析；未知键也拒绝（防止把另一版本/另一操作的行误读成当前行）。 */
export function parseDatasetDeletionRecord(
  payload: string, configuredEpoch: string,
  identity?: DatasetDeletionIdentity
): DatasetDeletionRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    throw new DatasetDeletionJournalError("Malformed persisted dataset deletion record");
  }
  if (!isRecord(raw)) throw new DatasetDeletionJournalError("Malformed persisted dataset deletion record");
  const keys = Object.keys(raw);
  const allowed = raw.version === DELETION_RECORD_VERSION
    ? DELETION_KEYS_V3
    : raw.version === 2 ? DELETION_KEYS_V2 : DELETION_KEYS;
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    throw new DatasetDeletionJournalError("Dataset deletion record has an unexpected field set");
  }
  if ((raw.version !== 1 && raw.version !== 2 && raw.version !== DELETION_RECORD_VERSION)
      || !isNonEmptyString(raw.deletionId)
      || !isNonEmptyString(raw.configuredEpoch)
      || !isNonEmptyString(raw.previousEpoch)
      || !isNonEmptyString(raw.nextEpoch)
      || !isNonEmptyString(raw.protectionSnapshot)
      || (raw.protectionKind !== "backup" && raw.protectionKind !== "quarantine")
      || !isNonEmptyString(raw.runtimeInstanceId)
      || !isInstant(raw.createdAt)
      || !isInstant(raw.updatedAt)
      || !DATASET_DELETION_STAGES.includes(raw.stage as DatasetDeletionStage)
      || ((raw.version === 2 || raw.version === DELETION_RECORD_VERSION)
        && !validProtectionFiles(raw.protectionFiles, raw.protectionKind as DatasetDeletionProtectionKind))
      || (raw.version === DELETION_RECORD_VERSION
        && (!isNonEmptyString(raw.serverId) || !isNonEmptyString(raw.athleteId)))) {
    throw new DatasetDeletionJournalError("Dataset deletion record is incomplete or has invalid values");
  }
  if (raw.configuredEpoch !== configuredEpoch) {
    throw new DatasetDeletionJournalError(
      `Dataset deletion record belongs to configured epoch ${JSON.stringify(raw.configuredEpoch)}, `
      + `not the current ${JSON.stringify(configuredEpoch)}`);
  }
  if (identity !== undefined && raw.version === DELETION_RECORD_VERSION
      && (raw.serverId !== identity.serverId || raw.athleteId !== identity.athleteId)) {
    throw new DatasetDeletionJournalError(
      `Dataset deletion record belongs to deployment ${JSON.stringify([raw.serverId, raw.athleteId])}, `
      + `not the current ${JSON.stringify([identity.serverId, identity.athleteId])}`);
  }
  if (raw.previousEpoch === raw.nextEpoch) {
    throw new DatasetDeletionJournalError("Dataset deletion record reuses the previous epoch");
  }
  if (basename(raw.protectionSnapshot) !== raw.protectionSnapshot
      || !raw.protectionSnapshot.endsWith(".sqlite")) {
    throw new DatasetDeletionJournalError("Dataset deletion record has an invalid protection snapshot name");
  }
  return raw as unknown as DatasetDeletionRecord;
}

/**
 * A permit may only be issued or consumed for a journal bound to **this**
 * deployment. Version 1/2 records predate the binding and cannot be used to
 * mint a permit; an operator must either roll the deletion back (unstarted) or
 * migrate the record explicitly.
 */
export function assertDeletionPermitIdentity(
  record: DatasetDeletionRecord, identity: DatasetDeletionIdentity
): void {
  if (record.version !== DELETION_RECORD_VERSION) {
    throw new DatasetDeletionJournalError(
      `Legacy v${record.version} dataset deletion record has no deployment identity; `
      + "refusing to issue or consume a permit without an explicit migration");
  }
  if (record.serverId !== identity.serverId || record.athleteId !== identity.athleteId) {
    throw new DatasetDeletionJournalError(
      `Dataset deletion record belongs to deployment ${JSON.stringify([record.serverId, record.athleteId])}, `
      + `not the current ${JSON.stringify([identity.serverId, identity.athleteId])}`);
  }
}

function parseEpoch(payload: string, configuredEpoch: string, strictConfigured: boolean): string {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new DatasetEpochError("Invalid persisted dataset epoch");
  }
  if (!isRecord(value) || !isNonEmptyString(value.configuredEpoch) || !isNonEmptyString(value.epoch)) {
    throw new DatasetEpochError("Invalid persisted dataset epoch");
  }
  if (value.configuredEpoch !== configuredEpoch) {
    if (strictConfigured) {
      throw new DatasetEpochError(
        `Persisted dataset epoch belongs to configured epoch ${JSON.stringify(value.configuredEpoch)}, `
        + `not the current ${JSON.stringify(configuredEpoch)}`);
    }
    return configuredEpoch;
  }
  return value.epoch;
}

function sidecarPath(databasePath: string): string {
  return `${databasePath}.dataset-epoch.sqlite`;
}

function withSidecar<T>(databasePath: string, operation: (db: DatabaseSync) => T): T {
  const database = new DatabaseSync(sidecarPath(databasePath));
  try {
    database.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS dataset_epoch (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dataset_deletion (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)`);
    return operation(database);
  } finally { database.close(); }
}

function readDeletionPayload(database: DatabaseSync): string | null {
  const table = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='dataset_deletion'"
  ).get() as { present: number } | undefined;
  if (!table) return null;
  const row = database.prepare("SELECT payload FROM dataset_deletion WHERE id=1").get() as
    { payload: string } | undefined;
  return row?.payload ?? null;
}

/** Independent of both the deletable facts DB and runtime.sqlite corruption recovery. */
export function writeSidecarDatasetEpoch(databasePath: string, configuredEpoch: string, epoch: string): void {
  withSidecar(databasePath, (database) => {
    database.prepare("INSERT OR REPLACE INTO dataset_epoch VALUES (1, ?)")
      .run(JSON.stringify({ configuredEpoch, epoch }));
  });
}

/**
 * Historical name kept for compatibility. Prefer {@link writeSidecarDatasetEpoch}:
 * the row is now also used for operator-forced new epochs, not only deletions.
 */
export const writeDeletedDatasetEpoch = writeSidecarDatasetEpoch;

/**
 * Compare-before-write sidecar epoch advance for crash-replayable operations
 * (today: abandoning an interrupted first install).
 *
 *   - sidecar absent / configured epoch → write the new epoch;
 *   - sidecar already the new epoch      → `already_applied` (retry is complete);
 *   - any other epoch                    → refuse: this sidecar belongs to a
 *     different operation and must be reviewed by an operator.
 *
 * The comparison and the write happen in one `BEGIN IMMEDIATE` transaction over
 * the sidecar, so two concurrent commands cannot both observe "old".
 */
export function advanceSidecarDatasetEpoch(
  databasePath: string, configuredEpoch: string, expectedEpoch: string, newEpoch: string
): "written" | "already_applied" {
  const path = sidecarPath(databasePath);
  const existed = existsSync(path);
  try {
    return withSidecar(databasePath, (database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database.prepare("SELECT payload FROM dataset_epoch WHERE id=1").get() as
          { payload: string } | undefined;
        let current: string;
        if (row === undefined) {
          if (existed) {
            throw new DatasetEpochError(
              "Persisted dataset epoch sidecar exists but has no epoch row; refusing to guess its epoch");
          }
          current = configuredEpoch;
        } else {
          current = parseEpoch(row.payload, configuredEpoch, true);
        }
        if (current === newEpoch) {
          database.exec("COMMIT");
          return "already_applied" as const;
        }
        if (current !== expectedEpoch) {
          throw new DatasetEpochError(
            `Dataset epoch sidecar records ${JSON.stringify(current)}, expected ${JSON.stringify(expectedEpoch)} `
            + `before advancing to ${JSON.stringify(newEpoch)}; manual review required`);
        }
        database.prepare("INSERT OR REPLACE INTO dataset_epoch VALUES (1, ?)")
          .run(JSON.stringify({ configuredEpoch, epoch: newEpoch }));
        database.exec("COMMIT");
        return "written" as const;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* 可能已 COMMIT */ }
        throw error;
      }
    });
  } catch (error) {
    if (!existed) {
      // A brand-new sidecar that failed before its first commit would otherwise
      // linger as an empty file and make later reads look like corruption.
      for (const suffix of ["", "-wal", "-shm"]) {
        try { rmSync(`${path}${suffix}`, { force: true }); } catch { /* best effort */ }
      }
    }
    throw error;
  }
}

type SidecarEpochRead =
  | { state: "absent" }
  | { state: "no-row" }
  | { state: "value"; epoch: string };

/**
 * The explicit epoch row from the deletion sidecar, or `null` when the sidecar
 * or its row is missing. Used by recovery to compare the authoritative sidecar
 * epoch with the readable main database instead of trusting the main row alone.
 */
export function readSidecarDatasetEpochValue(
  databasePath: string, configuredEpoch: string, strictConfigured = true
): string | null {
  const sidecar = readSidecarDatasetEpoch(databasePath, configuredEpoch, strictConfigured);
  return sidecar.state === "value" ? sidecar.epoch : null;
}

/**
 * Read the epoch row from the deletion sidecar **without** substituting the
 * configured epoch for a missing or unreadable file. Callers decide whether an
 * absent sidecar means "configured epoch" or "cannot prove anything".
 */
function readSidecarDatasetEpoch(
  databasePath: string, configuredEpoch: string, strictConfigured: boolean
): SidecarEpochRead {
  const path = sidecarPath(databasePath);
  if (!existsSync(path)) return { state: "absent" };
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new DatasetEpochError(
      `Persisted dataset epoch sidecar is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const table = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='dataset_epoch'"
    ).get() as { present: number } | undefined;
    if (!table) throw new DatasetEpochError("Missing persisted dataset epoch table");
    const row = database.prepare("SELECT payload FROM dataset_epoch WHERE id=1").get() as
      { payload: string } | undefined;
    if (!row) return { state: "no-row" };
    return { state: "value", epoch: parseEpoch(row.payload, configuredEpoch, strictConfigured) };
  } finally { database.close(); }
}

function readDeletedDatasetEpoch(
  databasePath: string, configuredEpoch: string, strictConfigured: boolean
): string {
  const sidecar = readSidecarDatasetEpoch(databasePath, configuredEpoch, strictConfigured);
  if (sidecar.state === "absent") return configuredEpoch;
  if (sidecar.state === "no-row") throw new DatasetEpochError("Missing persisted dataset epoch");
  return sidecar.epoch;
}

/** Kept in the main DB so restore commit, rollback and crash recovery agree. */
export function writeDatasetEpoch(database: DatabaseSync, configuredEpoch: string, epoch: string): void {
  database.prepare(`INSERT INTO import_manifest (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(DATASET_EPOCH_KEY, JSON.stringify({ configuredEpoch, epoch }));
}

export function readDatasetEpoch(databasePath: string, configuredEpoch: string): string {
  if (!existsSync(databasePath)) return readDeletedDatasetEpoch(databasePath, configuredEpoch, false);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database.prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get(DATASET_EPOCH_KEY) as { value: string } | undefined;
    if (!row) return readDeletedDatasetEpoch(databasePath, configuredEpoch, false);
    return parseEpoch(row.value, configuredEpoch, false);
  } catch (error) {
    // A missing schema or damaged DB must still allow the recovery API to boot.
    if (error instanceof Error && /no such table: import_manifest|file is not a database|database disk image is malformed|database.*corrupt/i.test(error.message)) {
      return readDeletedDatasetEpoch(databasePath, configuredEpoch, false);
    }
    // Lock/permission errors and malformed metadata cannot silently reuse receipts.
    throw error;
  } finally { database?.close(); }
}

/**
 * Resolve the **effective** epoch with the same rules for the API startup, the
 * recovery CLI and every operator-facing diagnostic.
 *
 * `strictConfigured` is the recovery mode: a persisted epoch/deletion record that
 * belongs to another configured namespace is a hard error, not a silent reset.
 */
export interface DatasetEpochState {
  configuredEpoch: string;
  epoch: string;
  source: "main" | "deleted-sidecar" | "configured";
  deletion: DatasetDeletionRecord | null;
  /**
   * True when the main database is readable but has no `rai.dataset-epoch`
   * row, and the authoritative epoch came from the deletion sidecar. The
   * caller may then backfill the main row (P1-1) — the adjudicated epoch never
   * depends on whether that backfill succeeds.
   */
  sidecarBackfillRequired?: boolean;
  /**
   * True only when a readable main database carried an explicit
   * `rai.dataset-epoch` row. Recovery must never treat an injected/inferred
   * epoch as proof that the previous dataset was rolled back.
   */
  mainEpochExplicit?: boolean;
}

const CORRUPT_DATABASE = /file is not a database|database disk image is malformed|database.*corrupt/i;

function mainDatabaseEpochRow(databasePath: string): { state: "absent" | "row"; value?: string } {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 5000");
    const schema = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='import_manifest'"
    ).get() as { present: number } | undefined;
    if (!schema) return { state: "absent" };
    const row = database.prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get(DATASET_EPOCH_KEY) as { value: string } | undefined;
    return row ? { state: "row", value: row.value } : { state: "absent" };
  } finally { database?.close(); }
}

export function readDatasetEpochState(
  databasePath: string, configuredEpoch: string,
  options: { strictConfigured?: boolean; identity?: DatasetDeletionIdentity } = {}
): DatasetEpochState {
  const strict = options.strictConfigured === true;
  const deletion = readDeletionOperation(databasePath, configuredEpoch, {
    strictConfigured: strict, ...(options.identity === undefined ? {} : { identity: options.identity })
  });
  if (existsSync(databasePath)) {
    let mainRow: { state: "absent" | "row"; value?: string };
    try {
      mainRow = mainDatabaseEpochRow(databasePath);
    } catch (error) {
      // A damaged DB must still allow the recovery API to boot; lock and
      // permission errors are a different fact and must not be mistaken for
      // the legacy "no epoch row" format. Keep the deletion/sidecar decision,
      // but never treat it as a readable main database.
      if (!(error instanceof Error && CORRUPT_DATABASE.test(error.message))) throw error;
      mainRow = { state: "absent" };
      const sidecar = readSidecarDatasetEpoch(databasePath, configuredEpoch, strict);
      if (sidecar.state === "value") {
        return { configuredEpoch, epoch: sidecar.epoch, source: "deleted-sidecar", deletion, mainEpochExplicit: false };
      }
      if (deletion !== null && deletion.stage !== "rolled_back" && deletion.stage !== "superseded") {
        return { configuredEpoch, epoch: deletion.nextEpoch, source: "deleted-sidecar", deletion, mainEpochExplicit: false };
      }
      return { configuredEpoch, epoch: deletion?.previousEpoch ?? configuredEpoch, source: "deleted-sidecar", deletion, mainEpochExplicit: false };
    }
    if (mainRow.state === "row") {
      return { configuredEpoch, epoch: parseEpoch(mainRow.value!, configuredEpoch, strict), source: "main", deletion,
        mainEpochExplicit: true };
    }
    // Readable main database without an epoch row. This is the legacy
    // "deletion happened, then the first import created a fresh database"
    // layout: the sidecar holds the only proof of the effective epoch.
    if (deletion === null) {
      const sidecar = readSidecarDatasetEpoch(databasePath, configuredEpoch, strict);
      if (sidecar.state === "value") {
        return {
          configuredEpoch, epoch: sidecar.epoch, source: "deleted-sidecar", deletion,
          sidecarBackfillRequired: true, mainEpochExplicit: false
        };
      }
      if (sidecar.state === "no-row") {
        throw new DatasetEpochError(
          "Persisted dataset epoch sidecar exists but has no epoch row; refusing to fall back to the configured epoch");
      }
      return { configuredEpoch, epoch: configuredEpoch, source: "configured", deletion, mainEpochExplicit: false };
    }
    // A stage-aware decision: never let an old sidecar value override the
    // nextEpoch of a deletion that has not reached `writer_entered`.
    if (deletion.stage === "writer_entered") {
      return { configuredEpoch, epoch: deletion.nextEpoch, source: "main", deletion, mainEpochExplicit: false };
    }
    if (deletion.stage === "rolled_back" || deletion.stage === "superseded") {
      const sidecar = readSidecarDatasetEpoch(databasePath, configuredEpoch, strict);
      if (sidecar.state === "no-row") {
        throw new DatasetEpochError(
          `A ${deletion.stage} deletion requires a sidecar epoch row; none is persisted`);
      }
      if (sidecar.state === "value") {
        return {
          configuredEpoch, epoch: sidecar.epoch, source: "deleted-sidecar", deletion,
          sidecarBackfillRequired: true, mainEpochExplicit: false
        };
      }
      return { configuredEpoch, epoch: configuredEpoch, source: "configured", deletion, mainEpochExplicit: false };
    }
    return { configuredEpoch, epoch: deletion.previousEpoch, source: "main", deletion, mainEpochExplicit: false };
  }
  const sidecar = readSidecarDatasetEpoch(databasePath, configuredEpoch, strict);
  if (deletion !== null && deletion.stage !== "rolled_back" && deletion.stage !== "superseded") {
    return { configuredEpoch, epoch: deletion.nextEpoch, source: "deleted-sidecar", deletion };
  }
  if (sidecar.state === "value") {
    return { configuredEpoch, epoch: sidecar.epoch, source: "deleted-sidecar", deletion };
  }
  if (sidecar.state === "no-row") {
    throw new DatasetEpochError(
      "Persisted dataset epoch sidecar exists but has no epoch row; refusing to fall back to the configured epoch");
  }
  return { configuredEpoch, epoch: configuredEpoch, source: "configured", deletion };
}

/**
 * Copy the sidecar-only epoch into the main database's `import_manifest`.
 *
 * P1-1: after a legacy "delete → first import creates an epoch-less main DB"
 * upgrade, the effective epoch must eventually live in the main DB too, so a
 * later restore/rollback and the runtime scope read the same value. The write
 * is compare-before-write and replayable:
 *   - no row            → write
 *   - identical row     → no-op
 *   - different row     → identity conflict (never silently overwrite)
 * Failure of this maintenance write never changes the already-adjudicated epoch.
 */
export function backfillDatasetEpochToMain(
  databasePath: string, configuredEpoch: string, epoch: string
): "written" | "unchanged" {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
    database.exec("BEGIN IMMEDIATE");
    try {
      const schema = database.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='import_manifest'"
      ).get() as { present: number } | undefined;
      if (!schema) {
        database.exec("ROLLBACK");
        throw new DatasetEpochError("Main database has no import_manifest table; cannot backfill the dataset epoch");
      }
      const row = database.prepare("SELECT value FROM import_manifest WHERE key = ?")
        .get(DATASET_EPOCH_KEY) as { value: string } | undefined;
      if (row !== undefined) {
        const existing = parseEpoch(row.value, configuredEpoch, true);
        database.exec("COMMIT");
        if (existing !== epoch) {
          throw new DatasetEpochError(
            `Dataset epoch identity conflict: main database records ${JSON.stringify(existing)}, `
            + `the deletion sidecar records ${JSON.stringify(epoch)}`);
        }
        return "unchanged";
      }
      writeDatasetEpoch(database, configuredEpoch, epoch);
      const written = database.prepare("SELECT value FROM import_manifest WHERE key = ?")
        .get(DATASET_EPOCH_KEY) as { value: string } | undefined;
      if (written === undefined || parseEpoch(written.value, configuredEpoch, true) !== epoch) {
        throw new DatasetEpochError("Dataset epoch backfill failed its post-write assertion");
      }
      database.exec("COMMIT");
      return "written";
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* 可能已 COMMIT */ }
      throw error;
    }
  } finally { database.close(); }
}

/** Read the single deletion journal row, failing closed on corruption or identity mismatch. */
export function readDeletionOperation(
  databasePath: string, configuredEpoch: string,
  options: { strictConfigured?: boolean; identity?: DatasetDeletionIdentity } = {}
): DatasetDeletionRecord | null {
  const path = sidecarPath(databasePath);
  if (!existsSync(path)) return null;
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new DatasetDeletionJournalError(
      `Dataset deletion journal is unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    database.exec("PRAGMA busy_timeout=5000");
    const payload = readDeletionPayload(database);
    if (payload === null) return null;
    let raw: unknown;
    try { raw = JSON.parse(payload); } catch {
      throw new DatasetDeletionJournalError("Malformed persisted dataset deletion record");
    }
    if (isRecord(raw) && typeof raw.configuredEpoch === "string"
        && raw.configuredEpoch !== configuredEpoch && options.strictConfigured !== true) {
      return null;
    }
    return parseDatasetDeletionRecord(payload, configuredEpoch, options.identity);
  } catch (error) {
    if (error instanceof DatasetDeletionJournalError) throw error;
    throw new DatasetDeletionJournalError(
      `Dataset deletion journal is unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally { database.close(); }
}

export interface BeginDeletionOperationInput {
  databasePath: string;
  configuredEpoch: string;
  serverId: string;
  athleteId: string;
  deletionId: string;
  previousEpoch: string;
  nextEpoch: string;
  protectionSnapshot: string;
  protectionKind: DatasetDeletionProtectionKind;
  protectionFiles: ProtectionSnapshotFile[];
  runtimeInstanceId: string;
  at?: string;
}

/**
 * Persist `prepared` **and** the next epoch in one sidecar transaction, before the
 * main database is removed. A crash can therefore leave either the old DB (and a
 * replayable/rollback-able intent) or no DB with an explicit deletion identity —
 * never "no DB and no explanation".
 */
export function beginDeletionOperation(input: BeginDeletionOperationInput): DatasetDeletionRecord {
  return withSidecar(input.databasePath, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existingPayload = readDeletionPayload(database);
      if (existingPayload !== null) {
        const existing = parseDatasetDeletionRecord(existingPayload, input.configuredEpoch);
        if (existing.stage !== "writer_entered" && existing.stage !== "rolled_back"
            && existing.stage !== "superseded") {
          throw new DatasetDeletionJournalError(
            `A dataset deletion is already in progress at stage ${existing.stage} (${existing.deletionId})`);
        }
      }
      const at = input.at ?? new Date().toISOString();
      const record: DatasetDeletionRecord = {
        version: DELETION_RECORD_VERSION,
        deletionId: input.deletionId,
        configuredEpoch: input.configuredEpoch,
        previousEpoch: input.previousEpoch,
        nextEpoch: input.nextEpoch,
        protectionSnapshot: input.protectionSnapshot,
        protectionKind: input.protectionKind,
        protectionFiles: input.protectionFiles,
        serverId: input.serverId,
        athleteId: input.athleteId,
        runtimeInstanceId: input.runtimeInstanceId,
        stage: "prepared",
        createdAt: at,
        updatedAt: at
      };
      parseDatasetDeletionRecord(JSON.stringify(record), input.configuredEpoch, input);
      database.prepare("INSERT OR REPLACE INTO dataset_epoch VALUES (1, ?)")
        .run(JSON.stringify({ configuredEpoch: input.configuredEpoch, epoch: input.nextEpoch }));
      database.prepare("INSERT OR REPLACE INTO dataset_deletion VALUES (1, ?)")
        .run(JSON.stringify(record));
      database.exec("COMMIT");
      return record;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* COMMIT 后抛出的冲突不需要回滚 */ }
      throw error;
    }
  });
}

const STAGE_ORDER: Record<DatasetDeletionStage, number> = {
  prepared: 0, main_removed: 1, permit_issued: 2, writer_entered: 3, rolled_back: 4, superseded: 4
};

/** Only the explicitly allowed forward edges (or the same stage, for replay). */
const ALLOWED_TRANSITIONS: Record<DatasetDeletionStage, ReadonlySet<DatasetDeletionStage>> = {
  prepared: new Set(["prepared", "main_removed", "rolled_back"]),
  main_removed: new Set(["main_removed", "permit_issued", "rolled_back"]),
  permit_issued: new Set(["permit_issued", "writer_entered", "rolled_back"]),
  writer_entered: new Set(["writer_entered", "superseded"]),
  rolled_back: new Set(["rolled_back"]),
  superseded: new Set(["superseded"])
};

/**
 * Advance (or idempotently replay) one recorded deletion. Transitioning to
 * `rolled_back` also restores the previous epoch in the same transaction, so the
 * epoch sidecar can never claim a deletion that was undone.
 */
export function advanceDeletionOperation(
  databasePath: string,
  configuredEpoch: string,
  deletionId: string,
  nextStage: DatasetDeletionStage,
  at = new Date().toISOString(),
  identity?: DatasetDeletionIdentity
): DatasetDeletionRecord {
  return withSidecar(databasePath, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const payload = readDeletionPayload(database);
      if (payload === null) throw new DatasetDeletionJournalError("No persisted dataset deletion to advance");
      const existing = parseDatasetDeletionRecord(payload, configuredEpoch, identity);
      if (identity !== undefined && (nextStage === "permit_issued" || nextStage === "writer_entered")) {
        assertDeletionPermitIdentity(existing, identity);
      }
      if (existing.deletionId !== deletionId) {
        throw new DatasetDeletionJournalError(
          `Dataset deletion identity mismatch: journal has ${existing.deletionId}, requested ${deletionId}`);
      }
      if (!ALLOWED_TRANSITIONS[existing.stage].has(nextStage)) {
        throw new DatasetDeletionJournalError(
          `Illegal dataset deletion transition ${existing.stage} → ${nextStage}`);
      }
      if (existing.stage === nextStage) {
        // P3: an idempotent replay is a read, but it must still end the
        // explicit transaction; otherwise the connection is left with an open
        // write transaction until it is closed.
        database.exec("COMMIT");
        return existing;
      }
      if (STAGE_ORDER[nextStage] < STAGE_ORDER[existing.stage] && nextStage !== "rolled_back") {
        throw new DatasetDeletionJournalError(
          `Dataset deletion stage cannot move backwards: ${existing.stage} → ${nextStage}`);
      }
      const record: DatasetDeletionRecord = { ...existing, stage: nextStage, updatedAt: at };
      database.prepare("INSERT OR REPLACE INTO dataset_deletion VALUES (1, ?)")
        .run(JSON.stringify(record));
      if (nextStage === "rolled_back") {
        database.prepare("INSERT OR REPLACE INTO dataset_epoch VALUES (1, ?)")
          .run(JSON.stringify({ configuredEpoch, epoch: existing.previousEpoch }));
      }
      database.exec("COMMIT");
      return record;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* 可能已 COMMIT */ }
      throw error;
    }
  });
}

/**
 * Close a deletion intent after an explicit restore/rollback and align the epoch
 * sidecar with the **final effective** scope.
 *
 * This never issues a permit: it only removes the possibility that a future
 * startup mistakes an old intent for an unfinished deletion.
 */
export function closeDeletionOperation(
  databasePath: string, configuredEpoch: string, finalEpoch: string,
  options: { deletionId?: string; reason?: string; at?: string; supersedeConsumed?: boolean } = {}
): void {
  withSidecar(databasePath, (database) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const payload = readDeletionPayload(database);
      if (payload !== null) {
        const existing = parseDatasetDeletionRecord(payload, configuredEpoch);
        if (options.deletionId !== undefined && existing.deletionId !== options.deletionId) {
          throw new DatasetDeletionJournalError(
            `Dataset deletion identity mismatch: journal has ${existing.deletionId}, requested ${options.deletionId}`);
        }
        if (existing.stage === "writer_entered" && !options.supersedeConsumed) {
          throw new DatasetDeletionJournalError("A consumed deletion cannot be rolled back without an explicit restore");
        }
        if (existing.stage !== "rolled_back" && existing.stage !== "superseded") {
          const record: DatasetDeletionRecord = {
            ...existing,
            stage: existing.stage === "writer_entered" ? "superseded" : "rolled_back",
            updatedAt: options.at ?? new Date().toISOString()
          };
          database.prepare("INSERT OR REPLACE INTO dataset_deletion VALUES (1, ?)")
            .run(JSON.stringify(record));
        }
      }
      database.prepare("INSERT OR REPLACE INTO dataset_epoch VALUES (1, ?)")
        .run(JSON.stringify({ configuredEpoch, epoch: finalEpoch }));
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
  });
}
