import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { basename, dirname, relative, resolve } from "node:path";

import { parseAppleHealthXml } from "./apple-health-parser.js";
import { stageAuditFiles, writeAuditFiles } from "./audit.js";
import { canonicalizeRunningWorkouts } from "./canonicalize.js";
import { canonicalizeNights } from "./canonicalize-nights.js";
import { RaiDatabase } from "./database.js";
import {
  moveFileWithRetry,
  removeDatabaseFilesWithRetry,
  removeFileWithRetry
} from "./file-operations.js";
import { importGpxRoutes } from "./gpx-parser.js";
import { ImportRemovalGuardError } from "./import-guard.js";
import { stableId } from "./utils.js";
import { acquireDatabasePublicationLock, publishDatabaseFile } from "@rai/storage-sqlite";

interface ParsedArguments {
  command: "import" | "incremental-import" | "audit";
  input: string;
  database: string;
  report: string;
  jsonReport: string;
  replace: boolean;
  batchId: string | null;
  /**
   * Whether absence from the payload may be read as deletion. Off by default:
   * an incremental package only covers the window since its last anchor, so a
   * missing entity is not a deleted entity. `--replace-absent` is the explicit
   * opt-in for an authoritative full replacement.
   */
  replaceAbsent: boolean;
  allowLargeRemoval: boolean;
  /**
   * 审计报告头部要写"这份数字来自哪个库"。命令行独立调用时就是 `--database`，
   * 但服务端导入走的是 `var/rai.importing.<jobId>.sqlite` 这样的**暂存副本**，
   * 报告最终却发布到 `docs/DATA_AUDIT.md` 描述生产库 —— 所以允许调用方用
   * `--source-database` 显式说明"这份报告描述的目标库"。
   */
  sourceDatabase: string | null;
}

function optionValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0];
  if (command !== "import" && command !== "incremental-import" && command !== "audit") {
    throw new Error(
      "Usage: data:import -- --input <export-folder> --database <sqlite> --replace\n" +
        "   or: tsx packages/health-export-parser/src/cli.ts incremental-import --input <export-folder> --database <cloned-sqlite> [--batch-id <id>] [--replace-absent] [--allow-large-removal]\n" +
        "   or: data:audit -- --database <sqlite> --report <markdown> [--source-database <sqlite>]"
    );
  }

  return {
    command,
    input: resolve(optionValue(argv, "--input", "apple_health_export")),
    database: resolve(optionValue(argv, "--database", "var/rai.sqlite")),
    report: resolve(optionValue(argv, "--report", "docs/DATA_AUDIT.md")),
    jsonReport: resolve(
      optionValue(argv, "--json-report", "var/reports/data-audit.json")
    ),
    replace: argv.includes("--replace")
    ,batchId: argv.includes("--batch-id") ? optionValue(argv, "--batch-id", "") : null
    // Deletion by absence is opt-in. `--preserve-absent` is accepted as a
    // no-op for backwards compatibility: it now names the default behaviour.
    ,replaceAbsent: argv.includes("--replace-absent")
    // A snapshot that omits most of the history is refused by default; this flag
    // is the explicit opt-in for a deliberate full replacement.
    ,allowLargeRemoval: argv.includes("--allow-large-removal")
    // 审计报告头部的"数据源"行。缺省用 `--database` 相对当前工作目录的路径 ——
    // 这样 `docs/DATA_AUDIT.md` 的读者能直接看出这组数字来自哪个库（本地工作区
    // 还是线上生产），而不是只能猜。服务端导入另传目标库，因为 CLI 眼里只有暂存副本。
    ,sourceDatabase: argv.includes("--source-database")
      ? optionValue(argv, "--source-database", "")
      : null
  };
}

/**
 * 审计报告头部显示的"数据源"。
 *
 * 刻意使用相对路径：报告是仓库里的已跟踪文档，绝对路径会把本机用户名带进仓库。
 * 目标在当前位置之外时只保留文件名并显式标注"工作区外"，读者据此就能判断
 * "这不是我本地工作区那个库"。
 */
function auditSourceLabel(args: ParsedArguments): string {
  const target = resolve(args.sourceDatabase ?? args.database);
  const asRelative = relative(process.cwd(), target);
  return asRelative.startsWith("..") ? `(工作区外) ${basename(target)}` : asRelative;
}

function locateHealthXml(input: string): string {
  const preferred = [resolve(input, "export.xml"), resolve(input, "导出.xml")];
  const match = preferred.find(existsSync);
  if (match) return match;
  throw new Error(`No Apple Health export XML found in ${input}`);
}

function removeDatabaseFiles(path: string): void {
  for (const candidate of [path, `${path}-shm`, `${path}-wal`]) {
    if (existsSync(candidate)) rmSync(candidate);
  }
}

async function prepareStagingDatabase(target: string, incremental: boolean): Promise<string> {
  const staging = `${target}.importing.${randomUUID()}`;
  removeDatabaseFiles(staging);
  if (!incremental) return staging;

  const source = new DatabaseSync(target, { readOnly: true });
  try {
    await backup(source, staging);
  } finally {
    source.close();
  }
  return staging;
}

interface DatabaseActivation {
  displacedDatabase: string | null;
  rollback(): Promise<void>;
}

function acquireImportLock(target: string): () => void {
  return acquireDatabasePublicationLock(target, "cli");
}

async function activateStagingDatabase(
  staging: string,
  target: string
): Promise<DatabaseActivation> {
  const displaced = `${target}.replaced.${randomUUID()}`;
  const hadTarget = existsSync(target);
  try {
    await publishDatabaseFile({
      candidatePath: staging,
      targetPath: target,
      rollbackPath: displaced,
      targetExists: () => existsSync(target),
      prepareOriginal: async () => {
        const active = new DatabaseSync(target);
        try { active.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
        finally { active.close(); }
        for (const sidecar of [`${target}-wal`, `${target}-shm`]) {
          await removeFileWithRetry(sidecar);
        }
      },
      moveFile: moveFileWithRetry,
      validateInstalled: () => {
        const installed = new DatabaseSync(target, { readOnly: true });
        try {
          return (installed.prepare("PRAGMA quick_check").get() as { quick_check?: string }).quick_check === "ok";
        } finally { installed.close(); }
      }
    });
  } catch (error) {
    if (hadTarget && existsSync(displaced)) {
      await removeDatabaseFilesWithRetry(target);
      await moveFileWithRetry(displaced, target);
    } else if (!hadTarget) {
      await removeDatabaseFilesWithRetry(target);
    }
    throw error;
  }

  return {
    displacedDatabase: hadTarget ? displaced : null,
    async rollback() {
      if (!hadTarget) {
        await removeDatabaseFilesWithRetry(target);
        return;
      }
      await removeDatabaseFilesWithRetry(target);
      await moveFileWithRetry(displaced, target);
    }
  };
}

async function importCommand(args: ParsedArguments): Promise<void> {
  const incremental = args.command === "incremental-import";
  if (!existsSync(args.input)) throw new Error(`Input folder does not exist: ${args.input}`);
  if (!incremental && existsSync(args.database) && !args.replace) {
    throw new Error(
      `Database already exists: ${args.database}. Pass --replace to rebuild it explicitly.`
    );
  }
  if (incremental && !existsSync(args.database)) {
    throw new Error(`Incremental import requires a cloned active database: ${args.database}`);
  }
  mkdirSync(dirname(args.database), { recursive: true });
  const xmlPath = locateHealthXml(args.input);
  const xmlSize = statSync(xmlPath).size;
  const releaseImportLock = acquireImportLock(args.database);
  let stagingDatabase: string;
  try {
    stagingDatabase = await prepareStagingDatabase(args.database, incremental);
  } catch (error) {
    releaseImportLock();
    throw error;
  }
  let store: RaiDatabase;
  try {
    store = await RaiDatabase.open(stagingDatabase);
  } catch (error) {
    removeDatabaseFiles(stagingDatabase);
    releaseImportLock();
    throw error;
  }
  const importJobId = stableId("recompute_job", ["import", new Date().toISOString(), xmlPath]);
  let storeClosed = false;
  let activated = false;
  let activation: DatabaseActivation | null = null;

  try {
    const batchId = args.batchId ?? stableId("import_batch", [new Date().toISOString(), xmlPath]);
    if (incremental) store.database.prepare(`
      INSERT OR IGNORE INTO import_batches (
        id, xml_sha256, status, import_mode, previous_dataset_version, summary_json
      ) VALUES (?, 'pending', 'running', 'incremental',
        (SELECT value FROM import_manifest WHERE key = 'dataset_version'), '{}')
    `).run(batchId);
    store.database
      .prepare(`
        INSERT INTO recompute_jobs (
          id, job_type, status, request_json, progress_phase, started_at
        ) VALUES (?, 'import', 'running', ?, 'prepare', ?)
      `)
      .run(importJobId, JSON.stringify({ mode: "cli_export_import" }), new Date().toISOString());
    store.database
      .prepare(`
        INSERT INTO recompute_job_events (
          id, job_id, phase, progress_current, progress_total, message
        ) VALUES (?, ?, 'prepare', 0, 0, 'Apple Health import started')
      `)
      .run(stableId("recompute_job_event", [importJobId, "prepare"]), importJobId);
    store.setManifest("source_xml_name", basename(xmlPath));
    store.setManifest("source_xml_bytes", String(xmlSize));
    store.setManifest("import_started_at", new Date().toISOString());
    store.flush();

    console.log(`Parsing Apple Health XML (${Math.round(xmlSize / 1024 / 1024)} MiB)...`);
    const xmlResult = await parseAppleHealthXml(xmlPath, store, {
      fileSize: xmlSize,
      atomic: false,
      deletedWorkoutIds: readSyncManifest(args.input),
      ...(incremental ? { incremental: {
        generation: stableId("import_generation", [batchId, new Date().toISOString()]),
        batchId,
        ...(!args.replaceAbsent ? { preserveAbsent: true } : {}),
        ...(args.allowLargeRemoval ? { guardAbsentRemoval: false } : {})
      } } : {}),
      onProgress: ({ bytesRead, totalBytes, recordCount, workoutCount }) => {
        const percent = ((bytesRead / totalBytes) * 100).toFixed(0);
        console.log(`  ${percent}% | records=${recordCount} workouts=${workoutCount}`);
      }
    });

    console.log("Parsing GPX routes...");
    const gpxResult = await importGpxRoutes(
    args.input,
    store,
    !args.replaceAbsent ? { preserveAbsent: true } : undefined
  );

    console.log("Building canonical running workout groups...");
    const routeDirtyTimes = (gpxResult.changedRouteIds ?? []).flatMap((routeId) => {
      const row = store.database.prepare(`
        SELECT w.start_at AS startAt FROM workout_routes route
        JOIN workouts w ON w.id = route.workout_id WHERE route.id = ?
      `).get(routeId) as unknown as { startAt: string } | undefined;
      return row ? [row.startAt] : [];
    });
    const dirtyWorkoutTimes = [...(xmlResult.dirtyWorkoutTimes ?? []), ...routeDirtyTimes];
    const canonicalResult = canonicalizeRunningWorkouts(
      store.database,
      incremental ? { dirtyWorkoutTimes } : undefined
    );
    const nightlyResult = canonicalizeNights(store.database, "Asia/Shanghai");

    const fingerprints = store.database
      .prepare(
        "SELECT key, value FROM import_manifest WHERE key IN ('source_xml_sha256', 'source_gpx_bundle_sha256') ORDER BY key"
      )
      .all() as unknown as Array<{ key: string; value: string }>;
    store.setManifest("dataset_version", stableId("dataset", fingerprints));

    store.setManifest("import_completed_at", new Date().toISOString());
    store.flush();
    const datasetVersionRow = store.database
      .prepare("SELECT value FROM import_manifest WHERE key = 'dataset_version'")
      .get() as unknown as { value: string } | undefined;
    const changeRows = incremental ? store.database.prepare(`
      SELECT change_type AS changeType, COUNT(*) AS count
      FROM import_entity_changes WHERE batch_id = ? GROUP BY change_type
    `).all(batchId) as unknown as Array<{ changeType: string; count: number }> : [];
    const changes = Object.fromEntries(changeRows.map((row) => [row.changeType, row.count]));
    const dirtyFromAt = dirtyWorkoutTimes.sort()[0] ?? null;
    if (incremental) store.database.prepare(`
      UPDATE import_batches SET xml_sha256 = ?, route_bundle_sha256 = ?, status = 'succeeded',
        dataset_version = ?, dirty_from_at = ?, summary_json = ?, completed_at = ? WHERE id = ?
    `).run(
      fingerprints.find((row) => row.key === "source_xml_sha256")?.value ?? "unknown",
      fingerprints.find((row) => row.key === "source_gpx_bundle_sha256")?.value ?? null,
      datasetVersionRow?.value ?? null, dirtyFromAt,
      JSON.stringify({ changes, xml: xmlResult, gpx: gpxResult, canonicalization: canonicalResult }),
      new Date().toISOString(), batchId
    );
    store.database
      .prepare(`
        UPDATE recompute_jobs
        SET status = 'succeeded', dataset_version = ?, progress_phase = 'completed',
            progress_current = 1, progress_total = 1, completed_at = ?
        WHERE id = ?
      `)
      .run(
        datasetVersionRow?.value ?? null,
        new Date().toISOString(),
        importJobId
      );
    store.database
      .prepare(`
        INSERT INTO recompute_job_events (
          id, job_id, phase, progress_current, progress_total, message
        ) VALUES (?, ?, 'completed', 1, 1, 'Apple Health import completed')
      `)
      .run(stableId("recompute_job_event", [importJobId, "completed"]), importJobId);
    const stagedAudit = stageAuditFiles(
      store.database,
      args.report,
      args.jsonReport,
      auditSourceLabel(args)
    );

    store.close();
    storeClosed = true;
    try {
      activation = await activateStagingDatabase(stagingDatabase, args.database);
      activated = true;
      stagedAudit.commit();
      stagedAudit.finalize();
    } catch (error) {
      stagedAudit.discard();
      if (activation) {
        await activation.rollback();
        activated = false;
      }
      throw error;
    }

    console.log(
      JSON.stringify(
        {
          xml: xmlResult,
          nightly: nightlyResult,
          gpx: gpxResult,
          canonicalization: canonicalResult,
          modelCohorts: stagedAudit.audit.readiness,
          report: args.report,
          database: args.database
          ,mode: incremental ? "incremental" : "full"
          ,batchId
          ,changes
          ,dirtyFromAt
          ,datasetVersion: datasetVersionRow?.value ?? null
          ,displacedDatabase: activation.displacedDatabase
        },
        null,
        2
      )
    );
  } finally {
    try {
      if (!storeClosed) store.close();
    } finally {
      removeDatabaseFiles(stagingDatabase);
      releaseImportLock();
    }
  }
}

export function readSyncManifest(inputRoot: string): string[] {
  let current = resolve(inputRoot);
  let path: string | null = null;
  for (let depth = 0; depth <= 3; depth += 1) {
    const candidate = resolve(current, "sync-manifest.json");
    if (existsSync(candidate)) {
      path = candidate;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!path) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; deletedSourceIds?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.deletedSourceIds)) return [];
    return parsed.deletedSourceIds.filter((value): value is string => typeof value === "string" && value.length > 0);
  } catch {
    throw new Error("sync-manifest.json 无法读取，拒绝将缺失内容当作删除");
  }
}

async function auditCommand(args: ParsedArguments): Promise<void> {
  if (!existsSync(args.database)) throw new Error(`Database not found: ${args.database}`);
  const releaseImportLock = acquireImportLock(args.database);
  let store: RaiDatabase;
  try {
    store = await RaiDatabase.open(args.database);
  } catch (error) {
    releaseImportLock();
    throw error;
  }
  try {
    const audit = writeAuditFiles(store.database, args.report, args.jsonReport, auditSourceLabel(args));
    console.log(
      JSON.stringify(
        {
          running: audit.running,
          readiness: audit.readiness,
          report: args.report
        },
        null,
        2
      )
    );
  } finally {
    try {
      store.close();
    } finally {
      releaseImportLock();
    }
  }
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "import" || args.command === "incremental-import") await importCommand(args);
  else await auditCommand(args);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  if (error instanceof ImportRemovalGuardError && process.send && process.connected) {
    let acknowledged = false;
    const timeout = setTimeout(() => {
      if (process.connected) process.disconnect();
    }, 2_000);
    process.on("message", (message: unknown) => {
      if ((message as { type?: unknown })?.type !== "rai:removal-guard-ack") return;
      acknowledged = true;
      clearTimeout(timeout);
      if (process.connected) process.disconnect();
    });
    process.send(error.toPayload(), (sendError) => {
      if (sendError || acknowledged) {
        clearTimeout(timeout);
        if (process.connected) process.disconnect();
      }
    });
  }
  });
}
