import { CLI_OWNED_IMPORT_REQUEST_MODE, DATABASE_TIMEZONE } from "@rai/contracts";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
import { importEngine, nativeFallback, NATIVE_VERSION, type NativeOptions } from "./native-worker.js";
import { stableId } from "./utils.js";
import { readHealthSyncManifest } from "./sync-manifest.js";
import {
  acquireDatabasePublicationLock,
  probeDatabaseStructure,
  publishDatabaseFile
} from "@rai/storage-sqlite";

/**
 * Reports a health-export sub-stage duration over the CLI's IPC channel.
 *
 * `ImportPerformanceTracker` in the API owns the coarse `parseImport` bucket;
 * these finer names land in `Job.performance.computeStagesMs`, whose schema is an
 * open number dictionary — so this adds observation without a contract change.
 * Timings are wall-clock and include child execution; they never carry health data.
 */
function reportStage(stage: string, durationMs: number): void {
  if (process.send && process.connected) {
    process.send({ type: "rai:compute-performance", stage, durationMs }, () => {});
  }
}

async function timedStage<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await operation();
  } finally {
    reportStage(stage, Math.max(0, performance.now() - start));
  }
}

interface ParsedArguments {
  native: NativeOptions;
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
  /** API-owned disposable candidate: no second clone, publication or audit. */
  candidateOwner: string | null;
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

  const parsed: ParsedArguments = {
    native: {
      spoolRoot: resolve(optionValue(argv, "--native-spool-root", dirname(resolve(optionValue(argv, "--database", "var/rai.sqlite"))))),
      engine: importEngine(optionValue(argv, "--engine", process.env.RAI_IMPORT_ENGINE ?? "typescript")),
      fallback: nativeFallback(optionValue(argv, "--native-fallback", process.env.RAI_RUST_FALLBACK ?? "none")),
      version: optionValue(argv, "--native-version", NATIVE_VERSION)
    },
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
    ,candidateOwner: argv.includes("--owned-candidate")
      ? optionValue(argv, "--owned-candidate", "")
      : null
  };
  if (parsed.candidateOwner !== null) validateOwnedCandidate(parsed);
  return parsed;
}

/** Never expose this optimization as a generic "write the active DB in place". */
function validateOwnedCandidate(args: ParsedArguments): void {
  const owner = args.candidateOwner!;
  const prefix = `rai.importing.${owner}`;
  const name = basename(args.database);
  const suffix = name.slice(prefix.length);
  if (args.command === "audit" || !/^[A-Za-z0-9_-]+$/.test(owner)
      || !name.startsWith(prefix) || !/^(?:\.attempt-[1-9]\d*)?\.sqlite$/.test(suffix)
      || args.sourceDatabase === null || resolve(args.sourceDatabase) === args.database) {
    throw new Error("--owned-candidate requires a private rai.importing.<owner>.sqlite and a distinct --source-database");
  }
  const entry = lstatSync(args.database, { throwIfNoEntry: false });
  if (entry) {
    if (!entry.isFile()) throw new Error("Owned candidate must be a regular file, not a symlink");
    if (existsSync(args.sourceDatabase)) {
      const candidate = statSync(args.database);
      const source = statSync(args.sourceDatabase);
      if (candidate.dev === source.dev && candidate.ino === source.ino) {
        throw new Error("Owned candidate must not alias the active database");
      }
    }
  }
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
      // 这里原本跑 `PRAGMA quick_check`：一次 506 MB 的全库扫描，真机冷态实测 12.1 s
      // （热态 0.25 s，48×），而它就落在 `parseImport` 没有任何埋点的尾部。
      // 换成结构探针的依据见 `@rai/storage-sqlite` 的 `probeDatabaseStructure` 文档：
      // ① 交付的库是本进程刚写完的，发布后再全库扫描属于重复校验；
      // ② 发布闸门（`import-worker.ts` 的 `activateDatabase`）仍保留一次 quick_check
      //    兜底 —— 页内损坏会在那里被拦下并触发回滚。
      validateInstalled: () => timedStage("validate_installed", () => {
        const report = probeDatabaseStructure(target);
        if (!report.readable) {
          process.stderr.write(`Installed database failed the structure probe: ${report.reason}\n`);
        }
        return report.readable;
      })
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
  const xmlPath = await timedStage("locate_health_xml", () => locateHealthXml(args.input));
  const xmlSize = statSync(xmlPath).size;
  const releaseImportLock = acquireImportLock(args.database);
  let stagingDatabase: string;
  try {
    // 增量导入先复制整份库（506 MB 实测 1.6–2.1 s）。这一段此前完全没有埋点，
    // 是「`parseImport` 涨幅全在埋点之外」的另一半原因。
    if (args.candidateOwner !== null) {
      // Keep the native writer's existing UUID-suffixed private-path + one-shot
      // permit barrier. Moving a private candidate is metadata-only, not a copy,
      // and does not require deploying a relaxed Rust write barrier.
      stagingDatabase = args.native.engine === "rust"
        ? `${args.database}.importing.${randomUUID()}` : args.database;
      if (stagingDatabase !== args.database && existsSync(args.database)) {
        const database = new DatabaseSync(args.database);
        try {
          const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
          if (checkpoint?.busy !== 0) throw new Error("Owned candidate checkpoint is busy");
        } finally {
          database.close();
        }
        for (const sidecar of [`${args.database}-wal`, `${args.database}-shm`]) {
          await removeFileWithRetry(sidecar);
        }
        renameSync(args.database, stagingDatabase);
      }
    } else {
      stagingDatabase = await timedStage(
        "prepare_staging_copy",
        () => prepareStagingDatabase(args.database, incremental)
      );
    }
  } catch (error) {
    releaseImportLock();
    throw error;
  }
  let store: RaiDatabase;
  try {
    store = await timedStage("open_staging_store", () => RaiDatabase.open(stagingDatabase));
  } catch (error) {
    if (args.candidateOwner === null || stagingDatabase !== args.database) removeDatabaseFiles(stagingDatabase);
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
      // 判别物走共享常量：`isApplicationConsumableJob`（消费者与恢复流程的**唯一**判据）
      // 正是按这个值把 CLI 任务判给外部所有者。两边写字面量会让它们悄悄分叉，
      // 而分叉的后果是"消费者把 CLI 导入任务当分析任务跑"。
      .run(importJobId, JSON.stringify({ mode: CLI_OWNED_IMPORT_REQUEST_MODE }), new Date().toISOString());
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
    const xmlResult = await timedStage("parse_health_xml", () => parseAppleHealthXml(xmlPath, store, {
      native: { ...args.native, stagingDatabase },
      fileSize: xmlSize,
      atomic: false,
      ...syncManifestParseOptions(args.input),
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
    }));

    console.log("Parsing GPX routes...");
    const gpxResult = await timedStage("import_gpx_routes", () => importGpxRoutes(
      args.input,
      store,
      { ...(!args.replaceAbsent ? { preserveAbsent: true } : {}), native: args.native }
    ));

    console.log("Building canonical running workout groups...");
    const routeDirtyTimes = (gpxResult.changedRouteIds ?? []).flatMap((routeId) => {
      const row = store.database.prepare(`
        SELECT w.start_at AS startAt FROM workout_routes route
        JOIN workouts w ON w.id = route.workout_id WHERE route.id = ?
      `).get(routeId) as unknown as { startAt: string } | undefined;
      return row ? [row.startAt] : [];
    });
    const dirtyWorkoutTimes = [...(xmlResult.dirtyWorkoutTimes ?? []), ...routeDirtyTimes];
    const canonicalResult = await timedStage("canonicalize_workouts", () => canonicalizeRunningWorkouts(
      store.database,
      incremental ? { dirtyWorkoutTimes } : undefined
    ));
    const nightlyResult = await timedStage("canonicalize_nights", () => canonicalizeNights(store.database, DATABASE_TIMEZONE));

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
    // 本批删除/取代过的记录时刻也必须压低分析下界：只取训练时刻会让"值更正"
    // 这类记录-only 批次的窗口落在边界之外（`supersededRecordTimes` 来自解析器，
    // 是被取代旧行的 `start_at`；账本 `previous_*` 写着同一区间）。
    const dirtyFromAt = [...dirtyWorkoutTimes, ...(xmlResult.supersededRecordTimes ?? [])].sort()[0] ?? null;
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
    // The API audits the final candidate after recomputation. Independent CLI
    // imports keep their existing database + report publication contract.
    const stagedAudit = args.candidateOwner !== null ? null : await timedStage("stage_audit_files", () => stageAuditFiles(
      store.database,
      args.report,
      args.jsonReport,
      auditSourceLabel(args)
    ));

    if (args.candidateOwner !== null) {
      await timedStage("checkpoint_candidate", () => {
        store.flush();
        const checkpoint = store.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
        if (checkpoint.busy !== 0) throw new Error("Owned candidate checkpoint is busy");
      });
    }
    await timedStage("close_store", () => store.close());
    storeClosed = true;
    if (args.candidateOwner !== null && stagingDatabase !== args.database) {
      await removeFileWithRetry(`${stagingDatabase}-wal`);
      await removeFileWithRetry(`${stagingDatabase}-shm`);
      await moveFileWithRetry(stagingDatabase, args.database);
    }
    if (stagedAudit) try {
      // 这一段（含 `validateInstalled` 的发布后校验）此前完全没有埋点 —— 冷态下
      // page cache 被挤出后，它单独能占掉十几秒，全部计在 `parseImport` 头上。
      activation = await timedStage(
        "activate_staging",
        () => activateStagingDatabase(stagingDatabase, args.database)
      );
      activated = true;
      await timedStage("commit_audit_files", () => {
        stagedAudit.commit();
        stagedAudit.finalize();
      });
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
          modelCohorts: stagedAudit?.audit.readiness ?? null,
          report: stagedAudit ? args.report : null,
          database: args.database
          ,mode: incremental ? "incremental" : "full"
          ,batchId
          ,changes
          ,dirtyFromAt
          ,datasetVersion: datasetVersionRow?.value ?? null
          ,displacedDatabase: activation?.displacedDatabase ?? null
        },
        null,
        2
      )
    );
  } finally {
    try {
      if (!storeClosed) store.close();
    } finally {
      if (args.candidateOwner === null || stagingDatabase !== args.database) removeDatabaseFiles(stagingDatabase);
      releaseImportLock();
    }
  }
}

export function readSyncManifest(inputRoot: string): string[] {
  return readHealthSyncManifest(inputRoot).deletedWorkoutIds;
}

function syncManifestParseOptions(inputRoot: string) {
  const manifest = readHealthSyncManifest(inputRoot);
  return { deletedWorkoutIds: manifest.deletedWorkoutIds, deletedRecords: manifest.deletedRecords,
    healthKitRecordIdentity: manifest.recordIdentity };
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

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
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
