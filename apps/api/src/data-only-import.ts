import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CONTRACT_VERSION, DATABASE_TIMEZONE } from "@rai/contracts";
import type { ImportJobResponse } from "@rai/api-contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import {
  DATA_ONLY_MAX_XML_BYTES, DATA_ONLY_MAX_RECORDS, DATA_ONLY_RECORD_TYPES,
  DATA_ONLY_WRITE_GUARD, RecordDeltaNotEligibleError, isDataOnlyRecordXml,
  identityAlgorithmFingerprint, parseAppleHealthXml, parseHealthSyncManifest, NATIVE_VERSION
} from "@rai/health-export-parser";
import { createHash } from "node:crypto";
import { readImportReceiptInDatabase, writeImportReceiptInDatabase } from "./import-publication.js";
import { assertDirectSyncRequestShape, directSyncParserOptions } from "./direct-sync-plan.js";
import { importPayloadSha256 } from "./import-payload-identity.js";
import { digestHealthKitRecordSnapshot } from "./import-sources.js";
import { scoringHealthTypes } from "./health-change-plan.js";

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
  "import_source_tombstones", "import_entity_changes", "import_batches", "import_manifest",
  // R6（2026-10-15）：本车道现在**有意**推进 `import_generations.raw_generation`
  // （成功批次 +1，与直连车道同语义，见 `beforeCommit` 里的注释）。在此表态后写守卫才会
  // 放行；不表态会被 fail-closed 拦下——而那条拒绝路径恰好会把整批吞成 `null`
  // （`catch` 里的 `DATA_ONLY_WRITE_GUARD` 分支），排查代价不小。
  "import_generations"
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
    WHERE key IN ('dataset_version','parser_contract_version','parser_identity_algorithm','import_completed_at')`)
    .all() as { key: string; value: string }[]).map(({ key, value }) => [key, value]));
}

function compatible(state: Map<string, string>): boolean {
  // 2026-10-15（P1-1）：第 5 条件（`data_only_baseline_contract`）已按设计 §4.3 退役 ——
  // `docs/SQLITE_DIRECT_SYNC_DESIGN.md:166`：「不再作为普通原始接收能否进入直接路径的门槛」。
  // 该键在收口后没有任何生产写入方（旧写手随候选链路删除），继续检查它 = 对从未写过该键的库恒 false。
  // 该基线契约哈希函数本体已随死代码清理批次（G4，2026-10-15）退役。
  return Boolean(state.get("dataset_version") && state.get("import_completed_at")
    && state.get("parser_contract_version") === CONTRACT_VERSION
    && state.get("parser_identity_algorithm") === identityAlgorithmFingerprint());
}

/** Executed only under the API's existing writer admission, off the HTTP thread.
 * null is a proven rollback/no-write fallback, never a partially accepted batch. */
export async function applyDataOnlyImport(input: DataOnlyImportInput): Promise<DataOnlyImportResult> {
  // 形状先于一切：直连请求携带快照语义字段 ⇒ 部分载荷会被当成完整快照 ⇒ 静默全库删除。
  // 类型挡不住 `{ ...request, preserveAbsent: false }` 这种展开，所以在这里运行期再拦一次。
  assertDirectSyncRequestShape(input);
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
  // 本批的代次取值。**一个变量只承担一种语义**：它只做解析器的 `entityGeneration`
  // （落在 `import_entity_generations.generation` 上），**不是**事实版本号 ——
  // 回执不承诺版本号（见 `DirectSyncReceipt` 的说明），所以这里也不叫 generation 的别名。
  const entityGeneration = `delta:${input.jobId}`;
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
      incremental: { generation: entityGeneration, batchId: input.jobId, ...directSyncParserOptions() },
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
            // 口径（2026-10-15，P3-e）：同 `direct-sync-ingest.ts` 的同名字段 —— 从库读的
            // **会话总数**（历史语义、对外回执字段），勿按"本批未变化数"解读。
            unchangedWorkouts: Number(db.prepare("SELECT COUNT(*) AS n FROM training_sessions").get()!.n),
            routesUpdated: 0, featuresReused: 0, featuresRecomputed: 0, modelReplayFrom: null,
            durationMs: Date.now() - input.startedAtMs, backupName: null,
            // §10.1 的直连回执。`analysisStatus: "not_required"` **不是**"分析已完成"：
            // 它能这么写，是因为本车道在入口就证明了这批载荷**结构上不可能**动到分析 ——
            // 上面的 `DATA_ONLY_RECORD_TYPES ∩ scoringHealthTypes = ∅` 判定（见函数开头）
            // 与 `isDataOnlyRecordXml` 的类型白名单是两道独立闸门，任一条不成立就直接
            // return null 回到旧路径。所以它是**结构性结论，不是样本观察**。
            directSync: {
              ingestStatus: "committed",
              analysisStatus: "not_required",
              receiptId: input.jobId,
              dependencyGeneration: null,
              publishedReleaseId: null,
              parentBatchId: null
            },
            // 这条车道**明确不登记**分析任务（`analysisStatus: "not_required"` 是结构性结论，
            // 见上面那段注释）。写 `null` 而不是省略这个键，是刻意的：客户端必须能分清
            // "问过了，本批没有分析任务"（`null`）与"这个服务端版本还没提供这个字段"（缺键）。
            // 缺键会让一个本该说「分析更新中」的批次被读成"分析已完事"（§9.1）。
            analysisJobId: null
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
          // R6（2026-10-15）：事实已变（本批真的写了记录）⇒ raw 代次必须推进——与直连车道
          // （`direct-sync-ingest.ts` 的"raw 每个批次都递增"）同语义。此前这条车道只改
          // `dataset_version`、不动计数器，读侧的 `analysis !== facts` 便把它读成"分析永久
          // 落后"（R6 的现象①）。依赖代次**不动**：本车道在入口就证明了本批结构上不可能
          // 动到分析（`analysisStatus: "not_required"` 是结构性结论，见上面那段注释）。
          db.prepare(`UPDATE import_generations SET raw_generation = raw_generation + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE singleton = 1`).run();
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
