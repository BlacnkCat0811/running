import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CONTRACT_VERSION, DATABASE_TIMEZONE } from "@rai/contracts";
import type { ImportJobResponse } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import {
  DATA_ONLY_MAX_XML_BYTES, DATA_ONLY_MAX_RECORDS, DATA_ONLY_RECORD_TYPES,
  DATA_ONLY_WRITE_GUARD, RecordDeltaNotEligibleError, isDataOnlyRecordXml,
  identityAlgorithmFingerprint, parseAppleHealthXml, parseHealthSyncManifest, NATIVE_VERSION,
  CANONICAL_NIGHT_ALGORITHM_VERSION
} from "@rai/health-export-parser";
import { createHash } from "node:crypto";
import { readImportReceiptInDatabase, writeImportReceiptInDatabase } from "./import-publication.js";
import { importPayloadSha256 } from "./import-payload-identity.js";
import { digestHealthKitRecordSnapshot } from "./import-sources.js";
import { scoringHealthTypes } from "./health-change-plan.js";

/** Only the completed candidate pipeline may attest that its derived baseline
 * matches today's policy. A raw parser stamp alone cannot prove canonical
 * recovery facts are current after a canonicalization algorithm upgrade. */
export function dataOnlyBaselineContract(): string {
  return createHash("sha256").update(JSON.stringify({
    policy: "record-delta-v1", parser: CONTRACT_VERSION, identity: identityAlgorithmFingerprint(),
    canonicalNights: CANONICAL_NIGHT_ALGORITHM_VERSION, timezone: DATABASE_TIMEZONE,
    scoringTypes: scoringHealthTypes, deltaTypes: DATA_ONLY_RECORD_TYPES
  })).digest("hex");
}

export interface DataOnlyImportInput {
  databasePath: string;
  inputPath: string;
  jobId: string;
  payloadSha256: string;
  startedAtMs: number;
}

export type DataOnlyImportResult = {
  summary: NonNullable<ImportJobResponse["summary"]>;
  replayed: boolean;
} | null;

const allowedTables = new Set([
  "health_records", "healthkit_record_sources", "healthkit_record_aliases",
  "healthkit_record_facts", "import_entity_generations", "import_entity_tombstones",
  "import_source_tombstones", "import_entity_changes", "import_batches", "import_manifest"
]);
const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Defense in depth around the shared parser. A mapped UUID/alias may point to
 * a different stored type; checking only the incoming type is insufficient.
 * TEMP guards affect only this connection, never other readers or persisted schema. */
function installWriteGuards(db: DatabaseSync): void {
  const types = DATA_ONLY_RECORD_TYPES.map((type) => `'${type}'`).join(",");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      if (allowedTables.has(name) && name !== "health_records") continue;
      const condition = name !== "health_records" ? "" : `WHEN ${
        event === "INSERT" ? `NEW.type NOT IN (${types})`
          : event === "DELETE" ? `OLD.type NOT IN (${types})`
            : `OLD.type NOT IN (${types}) OR NEW.type NOT IN (${types})`
      }`;
      db.exec(`CREATE TEMP TRIGGER ${quoted(`rai_delta_${name}_${event}`)}
        BEFORE ${event} ON main.${quoted(name)} ${condition}
        BEGIN SELECT RAISE(ABORT, '${DATA_ONLY_WRITE_GUARD}'); END`);
    }
  }
  db.exec("CREATE TEMP TABLE rai_delta_record_writes (id TEXT PRIMARY KEY, removed INTEGER NOT NULL)");
  for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
    db.exec(`CREATE TEMP TRIGGER ${quoted(`rai_delta_track_${event}`)}
      AFTER ${event} ON main.health_records BEGIN
        INSERT OR REPLACE INTO rai_delta_record_writes VALUES
          (${event === "DELETE" ? "OLD" : "NEW"}.id, ${event === "DELETE" ? 1 : 0});
      END`);
  }
}

function identityState(db: DatabaseSync): Map<string, string> {
  return new Map((db.prepare(`SELECT key,value FROM import_manifest
    WHERE key IN ('dataset_version','parser_contract_version','parser_identity_algorithm','import_completed_at','data_only_baseline_contract')`)
    .all() as { key: string; value: string }[]).map(({ key, value }) => [key, value]));
}

function compatible(state: Map<string, string>): boolean {
  return Boolean(state.get("dataset_version") && state.get("import_completed_at")
    && state.get("parser_contract_version") === CONTRACT_VERSION
    && state.get("parser_identity_algorithm") === identityAlgorithmFingerprint()
    && state.get("data_only_baseline_contract") === dataOnlyBaselineContract());
}

/** Executed only under the API's existing writer admission, off the HTTP thread.
 * null is a proven rollback/no-write fallback, never a partially accepted batch. */
export async function applyDataOnlyImport(input: DataOnlyImportInput): Promise<DataOnlyImportResult> {
  // A future scoring policy expansion must disable this lane, not silently
  // reinterpret the previously non-scoring allowlist as safe.
  if (DATA_ONLY_RECORD_TYPES.some(type => (scoringHealthTypes as readonly string[]).includes(type))) return null;
  if (!existsSync(input.databasePath) || !/^[a-f0-9]{64}$/.test(input.payloadSha256)) return null;
  const entries = readdirSync(input.inputPath);
  const xmlName = entries.includes("export.xml") ? "export.xml" : "导出.xml";
  if (!entries.includes(xmlName) || !entries.includes("sync-manifest.json")
      || entries.some((name) => ![xmlName, "sync-manifest.json"].includes(name))) return null;
  const xmlPath = join(input.inputPath, xmlName);
  if (statSync(xmlPath).size > DATA_ONLY_MAX_XML_BYTES
      || statSync(join(input.inputPath, "sync-manifest.json")).size > DATA_ONLY_MAX_XML_BYTES) return null;
  const manifestText = readFileSync(join(input.inputPath, "sync-manifest.json"), "utf8");
  if (Buffer.byteLength(manifestText) > DATA_ONLY_MAX_XML_BYTES) return null;
  const manifest = parseHealthSyncManifest(manifestText);
  if (!manifest.recordIdentity || manifest.deletedWorkoutIds.length
      || manifest.deletedRecords.length > DATA_ONLY_MAX_RECORDS
      || manifest.deletedRecords.some(({ type }) => !DATA_ONLY_RECORD_TYPES.includes(type))) return null;
  // Retain one bounded immutable snapshot between eligibility and application.
  const xmlText = readFileSync(xmlPath, "utf8");
  if (!isDataOnlyRecordXml(xmlText)) return null;
  const capturedSha256 = importPayloadSha256(digestHealthKitRecordSnapshot(xmlText, manifestText), {
    preserveAbsent: true, contractVersion: CONTRACT_VERSION,
    engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint()
  });
  if (capturedSha256 !== input.payloadSha256) throw new Error("Data-only payload changed after admission");
  const probe = RaiDatabase.openReadonly(input.databasePath);
  try {
    if (!compatible(identityState(probe)) || RaiDatabase.pendingMigrations(input.databasePath).length) return null;
    const columns = probe.prepare("PRAGMA index_info(idx_healthkit_record_aliases_source)").all().map(row => row.name);
    if (JSON.stringify(columns) !== JSON.stringify(["sample_type", "sample_uuid", "alias_id"])) return null;
  } finally {
    probe.close();
  }
  const store = await RaiDatabase.open(input.databasePath, {
    migrationPolicy: "refuse", foreignKeyValidation: "after-migration", createMigrationBackup: false
  });
  const db = store.database;
  try {
    // Acknowledgement must survive power loss, not only a graceful process exit.
    db.exec("PRAGMA synchronous=FULL");
    const receipt = readImportReceiptInDatabase(db, input.jobId);
    if (receipt) {
      const batch = db.prepare("SELECT summary_json FROM import_batches WHERE id=?").get(input.jobId);
      if (!batch || JSON.parse(String(batch.summary_json)).payloadSha256 !== input.payloadSha256) {
        throw new Error("Data-only batch id was reused with different content");
      }
      return { summary: receipt, replayed: true };
    }
    installWriteGuards(db);
    let summary: NonNullable<ImportJobResponse["summary"]> | undefined;
    let previousVersion = "";
    await parseAppleHealthXml(xmlPath, store, {
      fileSize: Buffer.byteLength(xmlText), healthKitRecordIdentity: true,
      deletedRecords: manifest.deletedRecords,
      incremental: { generation: `delta:${input.jobId}`, batchId: input.jobId, preserveAbsent: true },
      recordDelta: {
        xmlText,
        onBegin() {
          const state = identityState(db);
          if (!compatible(state)) throw new RecordDeltaNotEligibleError("baseline changed before BEGIN");
          previousVersion = state.get("dataset_version")!;
          if (db.prepare("SELECT 1 FROM import_batches WHERE id=?").get(input.jobId)) {
            throw new RecordDeltaNotEligibleError("existing batch has no completed receipt");
          }
          db.prepare(`INSERT INTO import_batches
            (id,xml_sha256,status,import_mode,previous_dataset_version,summary_json)
            VALUES (?,'pending','running','incremental',?,'{}')`).run(input.jobId, previousVersion);
        },
        beforeCommit(result, xmlSha256) {
          const now = new Date().toISOString();
          const datasetVersion = `dataset_delta_${createHash("sha256")
            .update(previousVersion).update("\0").update(input.payloadSha256).digest("hex").slice(0, 32)}`;
          const changes = db.prepare(`SELECT change_type AS kind,COUNT(*) AS count
            FROM import_entity_changes WHERE batch_id=? GROUP BY change_type`).all(input.jobId);
          summary = {
            recomputeReasons: ["data_only_transaction"], importMode: "incremental",
            insertedWorkouts: 0, updatedWorkouts: 0, removedWorkouts: 0,
            unchangedWorkouts: Number(db.prepare("SELECT COUNT(*) AS n FROM training_sessions").get()!.n),
            routesUpdated: 0, featuresReused: 0, featuresRecomputed: 0, modelReplayFrom: null,
            durationMs: Date.now() - input.startedAtMs, backupName: null
          };
          const metadata = {
            dataset_version: datasetVersion, source_xml_name: basename(xmlPath),
            source_xml_bytes: String(Buffer.byteLength(xmlText)),
            import_started_at: new Date(input.startedAtMs).toISOString(), import_completed_at: now,
            audit_report_pending_version: datasetVersion,
            source_payload_anchor: JSON.stringify({ sha256: input.payloadSha256, datasetVersion })
          };
          for (const [key, value] of Object.entries(metadata)) store.setManifest(key, value);
          const batchSummary = JSON.stringify({ payloadSha256: input.payloadSha256, changes, xml: result,
            publication: "transactional-delta" });
          db.prepare(`UPDATE import_batches SET xml_sha256=?, status='succeeded',
            dataset_version=?, summary_json=?, completed_at=? WHERE id=?`)
            .run(xmlSha256, datasetVersion, batchSummary, now, input.jobId);
          writeImportReceiptInDatabase(db, input.jobId, summary);
          const unledgered = db.prepare(`SELECT mutation.id FROM temp.rai_delta_record_writes mutation
            LEFT JOIN import_entity_changes change ON change.batch_id=? AND change.entity_kind='record'
              AND change.entity_id=mutation.id
            WHERE change.entity_id IS NULL
              OR (mutation.removed=1 AND change.change_type<>'removed')
              OR (mutation.removed=0 AND change.change_type NOT IN ('inserted','updated')) LIMIT 1`).get(input.jobId);
          if (unledgered) throw new Error("Data-only write has no matching atomic change ledger");
          const batch = db.prepare("SELECT status,xml_sha256,dataset_version,summary_json,completed_at FROM import_batches WHERE id=?").get(input.jobId);
          if (batch?.status !== "succeeded" || batch.xml_sha256 !== xmlSha256 || batch.dataset_version !== datasetVersion
              || batch.summary_json !== batchSummary || batch.completed_at !== now) {
            throw new Error("Data-only batch failed its pre-commit assertion");
          }
          for (const [key, value] of Object.entries({ ...metadata, parser_contract_version: CONTRACT_VERSION,
            parser_identity_algorithm: identityAlgorithmFingerprint(), source_xml_sha256: xmlSha256 })) {
            if (db.prepare("SELECT value FROM import_manifest WHERE key=?").get(key)?.value !== value) {
              throw new Error("Data-only metadata failed its pre-commit assertion");
            }
          }
        }
      }
    });
    if (!summary) throw new Error("Data-only import completed without a receipt");
    return { summary, replayed: false };
  } catch (error) {
    store.rollbackAtomicImport();
    if (error instanceof RecordDeltaNotEligibleError ||
        (error instanceof Error && error.message.includes(DATA_ONLY_WRITE_GUARD))) return null;
    throw error;
  } finally {
    store.close();
  }
}
