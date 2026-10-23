#!/usr/bin/env node
// 阶段 4 / T12：整 runtime 冷备 + 整套恢复的最小演练（隔离目录，无生产访问）。
//
// 它刻意不调用 `deploy/backup-runtime.sh --apply`：那个脚本会通过 systemctl
// 停/启服务，而本演练的目标是**归档与恢复语义**本身。脚本做的是同一组动作的
// 可审计子集：
//   1. 用真实存储/API 初始化五个存储与工件，写入可核对的业务状态：
//      workout/training_session、控制库计划与 operation receipt、runtime 的
//      source/job（含一个未终态 job）、epoch 侧车、**实际存在**的 restore
//      journal、保护快照、active model release bundle、预测工件，以及一个
//      带非空 WAL 的 SQLite 样例；
//   2. 停掉所有写者（本演练只有同步种子，没有常驻进程）；
//   3. 路径闭包检查（manifest v2，含逐文件摘要）+ tar 整根归档 + 归档闭包校验；
//   4. 演示外部/悬空/根内符号链接的裁决（一律拒绝）；
//   5. 移开旧根、解包，逐项复核 manifest 的权威文件可读性与摘要；
//   6. 对每个实际存在的 SQLite 库做 quick_check；
//   7. 启动真实 API，核对 epoch、scope、operation receipt、active bundle、
//      未终态任务与来源文件；启动后 restore journal 应被恢复到终态并清除；
//   8. 输出 JSON 证据（哈希、查询结果、RTO）。目录随后删除，--keep 保留现场。
//
// 运行：node --import tsx scripts/phase4-backup-restore-rehearsal.mjs [--keep]

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  RaiDatabase, REQUIRED_MODEL_DOMAINS, SqliteModelReleaseRepository, SqliteModelRunRepository,
  semanticHash
} from "@rai/storage-sqlite";

import { writeDatasetEpoch, writeSidecarDatasetEpoch } from "../apps/api/src/dataset-epoch.js";
import { writeImportReceipt } from "../apps/api/src/import-publication.js";
import { MobileGoalsStore } from "../apps/api/src/mobile-goals.js";
import { RestoreJournal } from "../apps/api/src/restore-journal.js";
import { RuntimeStateStore } from "../apps/api/src/runtime-state.js";

const keep = process.argv.includes("--keep");
const repoRoot = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "rai-phase4-rehearsal-"));
if (!resolve(root).startsWith(resolve(tmpdir()))) {
  throw new Error(`Rehearsal root must be under ${tmpdir()}; refusing ${root}`);
}

const sourceRoot = join(root, "source");
const restoredRoot = join(root, "restored");
const archiveDir = join(root, "archive");
const databasePath = join(sourceRoot, "var/rai.sqlite");
const controlPath = join(sourceRoot, "var/rai-control.sqlite");
const journalPath = `${databasePath}.restore-journal.sqlite`;
const protectionSnapshotName = "rehearsal-protection.sqlite";
const protectionSnapshotPath = join(sourceRoot, "var/backups", protectionSnapshotName);
const configuredEpoch = "default";
const restoredEpoch = "epoch-2026-10-23-rehearsal-a";
const serverId = "local";
const athleteId = "athlete_1";
const scope = JSON.stringify([serverId, athleteId, restoredEpoch]);
const importJobId = "job-rehearsal-0001";
const pendingJobId = "job-rehearsal-pending-0001";
const pendingSourceId = "source_rehearsal_pending";
const modelRunId = "run_rehearsal_active";
const startedAt = Date.now();
const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail });

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sqliteQuickCheck(path) {
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const result = database.prepare("PRAGMA quick_check").get();
      return result?.quick_check === "ok" ? null : JSON.stringify(result);
    } finally { database.close(); }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function readJsonFromSqlite(path, sql, params = []) {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return database.prepare(sql).get(...params) ?? null; } finally { database.close(); }
}

/** 一个非空 WAL 的真实样例：子进程写 WAL 后 SIGKILL，文件不会在退出时被 checkpoint 删除。 */
function createWalSample(path) {
  mkdirSync(dirname(path), { recursive: true });
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.env.WAL_DB);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    db.exec("CREATE TABLE sample (x INTEGER); INSERT INTO sample VALUES (1);");
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, WAL_DB: path }, encoding: "utf8", timeout: 30_000
  });
  const wal = `${path}-wal`;
  return {
    ok: child.signal === "SIGKILL" && existsSync(wal) && statSync(wal).size > 0,
    detail: `signal=${child.signal ?? child.status} walBytes=${existsSync(wal) ? statSync(wal).size : 0}`
  };
}

async function seed() {
  for (const path of [
    join(sourceRoot, "var/imports/upload_rehearsal/extracted"),
    join(sourceRoot, "var/imports/upload_pending/extracted"),
    join(sourceRoot, "var/model-artifacts/prediction"),
    join(sourceRoot, "var/reports"),
    join(sourceRoot, "var/backups"),
    join(sourceRoot, "var/quarantine")
  ]) mkdirSync(path, { recursive: true });

  const store = await RaiDatabase.open(databasePath);
  const db = store.database;
  try {
    db.prepare("INSERT INTO import_manifest (key, value) VALUES ('dataset_version', ?)")
      .run("dataset_rehearsal_2026_10_23");
    db.prepare(`INSERT INTO workouts (
      id, activity_type, source_name, source_category, source_version, device,
      start_at, end_at, duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical
    ) VALUES ('workout_rehearsal_1','HKWorkoutActivityTypeRunning','Rehearsal Watch','apple_watch',
      '1','Watch','2026-10-22T23:00:00.000Z','2026-10-22T23:30:00.000Z',1800,0,'{}','{}',1)`).run();
    db.prepare(`INSERT INTO workout_statistics (
      workout_id, ordinal, type, unit, sum_value, average_value, minimum_value, maximum_value
    ) VALUES ('workout_rehearsal_1',0,'HKQuantityTypeIdentifierDistanceWalkingRunning','km',5,null,null,null)`).run();
    db.prepare(`INSERT INTO training_sessions (
      id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id, status
    ) VALUES ('session_rehearsal_1','HKWorkoutActivityTypeRunning','2026-10-22T23:00:00.000Z',
      '2026-10-22T23:30:00.000Z',5,'workout_rehearsal_1','active')`).run();
    writeDatasetEpoch(db, configuredEpoch, restoredEpoch);

    // active model release bundle：覆盖 model_runs / model_v2_runs / 域快照 /
    // release bundle / active pointer 这一整组跨表状态。
    const releases = new SqliteModelReleaseRepository(db);
    const models = new SqliteModelRunRepository(db);
    db.prepare(`INSERT INTO feature_runs(id,dataset_version,canonical_contract_version,feature_schema_version,
      feature_config_json,feature_config_hash,status)
      VALUES('feature_rehearsal','dataset_rehearsal_2026_10_23','canonical-health-v2','workout-feature-v4',
      '{}','hash','succeeded')`).run();
    db.prepare(`INSERT INTO model_runs(id,feature_run_id,dataset_version,model_version,model_config_json,
      model_config_hash,evaluated_at,status)
      VALUES(?,'feature_rehearsal','dataset_rehearsal_2026_10_23','v2','{}','hash',?,'succeeded')`)
      .run(modelRunId, "2026-10-22T20:00:00.000Z");
    db.prepare(`INSERT INTO training_metric_runs(id,model_run_id,algorithm_version,config_json,config_hash,
      timezone_identifier,evaluated_at,status)
      VALUES('metrics_rehearsal',?,'v5','{}','hash','Asia/Shanghai',?,'succeeded')`)
      .run(modelRunId, "2026-10-22T20:00:00.000Z");
    const lineage = {
      sourceRunId: modelRunId,
      datasetVersion: "dataset_rehearsal_2026_10_23",
      factsSnapshotHash: semanticHash({}),
      overrideSnapshotHash: semanticHash([]),
      modelVersion: "rai-v2.0.0",
      featureSchemaVersion: "workout-feature-v4",
      configVersion: "v12",
      configHash: "hash",
      baselineEpochId: restoredEpoch,
      calibrationCohortHash: null,
      normalizationVersion: null,
      normalizationConfigHash: null,
      timezoneIdentifier: "Asia/Shanghai",
      asOf: "2026-10-22T20:00:00.000Z",
      dataThroughAt: null
    };
    releases.recordLineage(modelRunId, "rai-v2.0.0", "v12", lineage);
    for (const domain of REQUIRED_MODEL_DOMAINS) {
      releases.putSnapshot(modelRunId, domain, "summary", "2026-10-22T20:00:00.000Z",
        { status: "no_data", lineage });
    }
    releases.recordEvaluation({
      runId: modelRunId, baseRunId: null, datasetVersion: "dataset_rehearsal_2026_10_23",
      status: "passed", createdAt: "2026-10-22T20:00:00.000Z", report: { status: "passed" }
    });
    models.activateSucceeded(modelRunId, "2026-10-22T20:00:00.000Z");
  } finally {
    store.close();
  }
  writeSidecarDatasetEpoch(databasePath, configuredEpoch, restoredEpoch);
  writeImportReceipt(databasePath, importJobId, {
    importMode: "incremental",
    insertedWorkouts: 1,
    updatedWorkouts: 0,
    removedWorkouts: 0,
    unchangedWorkouts: 0,
    routesUpdated: 0,
    featuresReused: 0,
    featuresRecomputed: 0,
    durationMs: 12,
    modelReplayFrom: null,
    backupName: null
  });
  // 保护快照：一份停写后的主库副本，同时作为 restore journal 的回滚点。
  copyFileSync(databasePath, protectionSnapshotPath);

  const goals = new MobileGoalsStore(sourceRoot, controlPath);
  goals.close();
  const control = new DatabaseSync(controlPath);
  try {
    control.prepare("UPDATE mobile_goals SET revision = 7, payload_json = ?, updated_at = ? WHERE singleton = 1")
      .run(JSON.stringify({
        easyDurationFloorFraction: 0.75, qualitySessionCap: 2, raceTarget: null, weekPlan: [],
        lockedSession: null, weekPlanAudit: null, weekPlanReplanRequired: false,
        weekPlanPreservedDate: null, runCoach: null
      }), "2026-10-22T20:00:00.000Z");
    control.prepare(`INSERT INTO mobile_plan_operations(scope, operation_id, request_digest, result_json, expires_at)
      VALUES (?, 'op-rehearsal-1', 'digest-rehearsal-1', '{"ok":true,"revision":7}', '2027-01-01T00:00:00.000Z')`)
      .run(JSON.stringify([serverId, athleteId, restoredEpoch]));
  } finally {
    control.close();
  }

  const runtime = new RuntimeStateStore(sourceRoot);
  runtime.upsertSource({
    id: "source_rehearsal_1", kind: "upload", displayName: "Rehearsal export",
    inputPath: join(sourceRoot, "var/imports/upload_rehearsal/extracted"),
    originalPath: join(sourceRoot, "var/imports/upload_rehearsal/source.zip"),
    sourceSha256: "a".repeat(64), idempotencyKey: "rehearsal-idempotency-1",
    exportFileName: "export.xml", exportBytes: 1024, routeFileCount: 1,
    modifiedAt: "2026-10-22T20:00:00.000Z", createdAt: "2026-10-22T20:00:00.000Z",
    lastUsedAt: "2026-10-22T20:01:00.000Z", archiveSha256: "b".repeat(64)
  });
  runtime.upsertJob({
    id: importJobId, sourceId: "source_rehearsal_1", status: "succeeded", phase: "complete",
    message: "rehearsal fixture", createdAt: "2026-10-22T20:01:00.000Z",
    completedAt: "2026-10-22T20:01:01.000Z", error: null,
    inputPath: join(sourceRoot, "var/imports/upload_rehearsal/extracted"), progress: 1
  });
  // 未终态来源/任务：归档必须带上“正在处理”的状态，恢复后不能当作已完成。
  runtime.upsertSource({
    id: pendingSourceId, kind: "upload", displayName: "Pending rehearsal export",
    inputPath: join(sourceRoot, "var/imports/upload_pending/extracted"),
    originalPath: join(sourceRoot, "var/imports/upload_pending/source.zip"),
    sourceSha256: "c".repeat(64), idempotencyKey: "rehearsal-pending-idempotency-1",
    exportFileName: "pending.xml", exportBytes: 2048, routeFileCount: 1,
    modifiedAt: "2026-10-22T20:10:00.000Z", createdAt: "2026-10-22T20:10:00.000Z",
    lastUsedAt: "2026-10-22T20:10:00.000Z", archiveSha256: "d".repeat(64)
  });
  runtime.upsertJob({
    id: pendingJobId, sourceId: pendingSourceId, status: "running", phase: "importing",
    message: "rehearsal pending job", createdAt: "2026-10-22T20:11:00.000Z",
    completedAt: null, error: null, inputPath: join(sourceRoot, "var/imports/upload_pending/extracted"),
    progress: 0.4
  });
  runtime.registerStartupDatabaseObservation(scope, databasePath);

  writeFileSync(join(sourceRoot, "var/model-artifacts/prediction/model.onnx"), "rehearsal-onnx-bytes");
  writeFileSync(join(sourceRoot, "var/imports/upload_rehearsal/source.zip"), "rehearsal-zip-bytes");
  writeFileSync(join(sourceRoot, "var/imports/upload_rehearsal/extracted/export.xml"), "<HealthData/>");
  writeFileSync(join(sourceRoot, "var/imports/upload_pending/source.zip"), "pending-zip-bytes");
  writeFileSync(join(sourceRoot, "var/imports/upload_pending/extracted/export.xml"), "<HealthData pending/>");
  writeFileSync(join(sourceRoot, "var/reports/rehearsal.json"), '{"fixture":true}\n');

  const wal = createWalSample(join(sourceRoot, "var/quarantine/wal-sample.sqlite"));
  record("wal:sample_nonempty", wal.ok, wal.detail);

  // restore journal 真实存在：prepared 阶段 + 指向保护快照。API 启动时会把它
  // 走到终态（恢复同一份快照并清空 journal），这是恢复语义的一部分。
  // 路径按“恢复后”的 runtime 根写：真实运维是原路径原地解包；演练把根
  // 改名到 restoredRoot，因此 journal 的 target/staging/snapshot 都指向
  // restoredRoot，解包后文件恰好存在。这样 API 启动能真实走恢复路径。
  const restoredDatabasePath = join(restoredRoot, "var/rai.sqlite");
  new RestoreJournal(databasePath, sourceRoot).write({
    target: resolve(restoredDatabasePath),
    staging: `${resolve(restoredDatabasePath)}.restoring.rehearsal`,
    snapshot: resolve(restoredRoot, "var/backups", protectionSnapshotName),
    snapshotIsQuarantine: false,
    phase: "prepared"
  });
}

function runPathChecker(runtimeRoot, database, control, extra = []) {
  return spawnSync(process.execPath, [
    "scripts/check-runtime-backup-paths.mjs", "--runtime-root", runtimeRoot,
    "--database", database, "--control-database", control, "--json", ...extra
  ], { cwd: repoRoot, encoding: "utf8" });
}

/** 链接裁决：外部/悬空/根内链接一律拒绝；返回每个场景的退出码与诊断。 */
function linkAdjudication() {
  const cases = [];
  const outside = join(root, "negative-outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "outside.zip"), "outside");
  for (const [name, install] of [
    ["external", (runtime) => {
      mkdirSync(join(runtime, "var/imports/job"), { recursive: true });
      symlinkSync(join(outside, "outside.zip"), join(runtime, "var/imports/job/source.zip"));
    }],
    ["dangling", (runtime) => {
      mkdirSync(join(runtime, "var/imports/job"), { recursive: true });
      symlinkSync(join(runtime, "var/imports/job/missing.zip"), join(runtime, "var/imports/job/source.zip"));
    }],
    ["root-internal", (runtime) => {
      mkdirSync(join(runtime, "var/imports/job"), { recursive: true });
      writeFileSync(join(runtime, "var/imports/job/real.zip"), "real");
      symlinkSync(join(runtime, "var/imports/job/real.zip"), join(runtime, "var/imports/job/source.zip"));
    }]
  ]) {
    const runtime = join(root, `negative-${name}`);
    mkdirSync(join(runtime, "var"), { recursive: true });
    for (const file of ["rai.sqlite", "rai-control.sqlite", "runtime.sqlite"]) {
      writeFileSync(join(runtime, "var", file), `fixture ${file}`);
    }
    install(runtime);
    const result = runPathChecker(runtime, join(runtime, "var/rai.sqlite"), join(runtime, "var/rai-control.sqlite"));
    const rejected = result.status === 2 && /symbolic link/.test(result.stdout);
    const problem = (() => {
      try { return JSON.parse(result.stdout).problems[0] ?? ""; } catch { return result.stderr.trim().split("\n")[0] ?? ""; }
    })();
    record(`links:${name}:rejected`, rejected, `exit=${result.status} ${problem}`);
    cases.push({ name, decision: "reject", exit: result.status });
  }
  return cases;
}

async function startServer(runtimeRoot) {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: runtimeRoot,
      RAI_DATABASE: join(runtimeRoot, "var/rai.sqlite"),
      RAI_CONTROL_DATABASE: join(runtimeRoot, "var/rai-control.sqlite"),
      RAI_API_PORT: "0", RAI_API_TOKEN: "", RAI_LOG_LEVEL: "silent",
      RAI_SERVER_ID: serverId, RAI_ATHLETE_ID: athleteId, RAI_DATASET_EPOCH: configuredEpoch
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const port = await new Promise((resolvePort, rejectPort) => {
    const timer = setTimeout(() => rejectPort(new Error(output || "API did not report a port")), 60_000);
    child.once("exit", (code) => { clearTimeout(timer); rejectPort(new Error(output || `API exited ${code}`)); });
    child.on("message", (message) => {
      if (message?.type === "rai:ready" && Number.isInteger(message.port)) {
        clearTimeout(timer); resolvePort(message.port);
      }
    });
  });
  return { child, port, output: () => output };
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const closed = new Promise((done) => server.child.once("close", done));
  server.child.kill("SIGTERM");
  await Promise.race([closed, new Promise((done) => setTimeout(done, 10_000))]);
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill("SIGKILL");
}

try {
  await seed();
  const linkCases = linkAdjudication();

  const manifestResult = spawnSync(process.execPath, [
    "scripts/check-runtime-backup-paths.mjs", "--runtime-root", sourceRoot,
    "--database", databasePath, "--control-database", controlPath,
    "--out", join(root, "path-manifest.json"), "--json"
  ], { cwd: repoRoot, encoding: "utf8" });
  record("path-closure:complete", manifestResult.status === 0,
    manifestResult.stderr.trim() || "all stores inside runtime root");
  const manifest = JSON.parse(manifestResult.stdout);
  record("manifest:format", manifest.format === "rai-runtime-path-manifest-v2", manifest.format);
  for (const name of ["main", "control", "runtime", "epochSidecar", "restoreJournal"]) {
    record(`manifest:${name}:${manifest.stores[name].status}`,
      ["present", "absent"].includes(manifest.stores[name].status), manifest.stores[name].resolved);
  }
  record("manifest:restore_journal_present", manifest.stores.restoreJournal.status === "present",
    manifest.stores.restoreJournal.resolved);
  for (const tree of ["var/imports", "var/model-artifacts/prediction", "var/backups", "var/quarantine"]) {
    record(`manifest:tree:${tree}`,
      manifest.inventory.entries.some((entry) => entry.path === tree && entry.type === "directory"),
      tree);
  }
  record("manifest:inventory_digests", manifest.inventory.digestsIncluded === true,
    `${manifest.inventory.fileCount} files, ${manifest.inventory.totalBytes} bytes`);

  mkdirSync(archiveDir, { recursive: true });
  const archive = join(archiveDir, "runtime.tar");
  const tarred = spawnSync("tar", ["-C", sourceRoot, "-cf", archive, "."],
    { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  record("archive:tar", tarred.status === 0, tarred.stderr.trim() || archive);
  const archiveSha256 = sha256(archive);
  const archiveBytes = statSync(archive).size;

  const archiveVerification = spawnSync(process.execPath, [
    "scripts/verify-runtime-backup-archive.mjs", "--archive", archive,
    "--manifest", join(root, "path-manifest.json"), "--source-root", sourceRoot, "--json"
  ], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 30 });
  const archiveVerificationJson = archiveVerification.stdout ? JSON.parse(archiveVerification.stdout) : null;
  record("archive:semantic_closure", archiveVerification.status === 0,
    archiveVerificationJson?.passed === true
      ? `${archiveVerificationJson.checks.length} checks`
      : (archiveVerification.stderr.trim().split("\n")[0] ?? `exit ${archiveVerification.status}`));

  renameSync(sourceRoot, join(root, "source.offline"));
  mkdirSync(restoredRoot, { recursive: true });
  const extracted = spawnSync("tar", ["-C", restoredRoot, "-xf", archive], { encoding: "utf8" });
  record("restore:extract", extracted.status === 0, extracted.stderr.trim() || restoredRoot);
  const restoreStartedAt = Date.now();

  // 逐项复核 manifest 的权威文件：可读、类型、大小、摘要（脚本会重新解包比对）。
  const restoredManifest = JSON.parse(readFileSync(join(root, "path-manifest.json"), "utf8"));
  let readable = 0;
  for (const entry of restoredManifest.inventory.entries) {
    const path = join(restoredRoot, entry.path);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (entry.type === "directory" ? stat.isDirectory()
      : stat.isFile() && !stat.isSymbolicLink() && (entry.sizeBytes === null || stat.size === entry.sizeBytes)) {
      readable += 1;
    }
  }
  record("restore:manifest_entries_readable", readable === restoredManifest.inventory.entries.length,
    `${readable}/${restoredManifest.inventory.entries.length}`);
  const restoredArchiveVerification = spawnSync(process.execPath, [
    "scripts/verify-runtime-backup-archive.mjs", "--archive", archive,
    "--manifest", join(root, "path-manifest.json"), "--source-root", restoredRoot, "--json"
  ], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 30 });
  record("restore:archive_matches_restored_root", restoredArchiveVerification.status === 0,
    restoredArchiveVerification.stderr.trim().split("\n")[0] ?? "verified");

  const sqliteFiles = ["var/rai.sqlite", "var/rai-control.sqlite", "var/runtime.sqlite",
    "var/rai.sqlite.dataset-epoch.sqlite", "var/rai.sqlite.restore-journal.sqlite",
    "var/quarantine/wal-sample.sqlite", "var/backups/rehearsal-protection.sqlite"];
  for (const rel of sqliteFiles) {
    const path = join(restoredRoot, rel);
    if (!existsSync(path)) { record(`quick_check:${rel}:absent`, true, "optional/missing"); continue; }
    const problem = sqliteQuickCheck(path);
    record(`quick_check:${rel}`, problem === null, problem ?? "ok");
  }
  record("restore:wal_sample_preserved",
    existsSync(join(restoredRoot, "var/quarantine/wal-sample.sqlite-wal"))
      && statSync(join(restoredRoot, "var/quarantine/wal-sample.sqlite-wal")).size > 0,
    "non-empty WAL restored");

  const restoredControl = readJsonFromSqlite(join(restoredRoot, "var/rai-control.sqlite"),
    "SELECT revision FROM mobile_goals WHERE singleton = 1");
  record("control:plan_revision", restoredControl?.revision === 7, restoredControl?.revision);
  const restoredOperation = readJsonFromSqlite(join(restoredRoot, "var/rai-control.sqlite"),
    "SELECT result_json AS result FROM mobile_plan_operations WHERE operation_id = 'op-rehearsal-1'");
  record("control:operation_receipt", restoredOperation?.result === '{"ok":true,"revision":7}', restoredOperation?.result);
  const restoredScope = readJsonFromSqlite(join(restoredRoot, "var/runtime.sqlite"),
    "SELECT state FROM import_scope_evidence WHERE scope = ?", [scope]);
  record("runtime:scope_established", restoredScope?.state === "established", restoredScope?.state);
  const restoredJob = readJsonFromSqlite(join(restoredRoot, "var/runtime.sqlite"),
    "SELECT status FROM import_jobs WHERE id = ?", [importJobId]);
  record("runtime:job_terminal", restoredJob?.status === "succeeded", restoredJob?.status);
  const restoredPendingJob = readJsonFromSqlite(join(restoredRoot, "var/runtime.sqlite"),
    "SELECT status, phase FROM import_jobs WHERE id = ?", [pendingJobId]);
  record("runtime:pending_job_preserved",
    restoredPendingJob?.status === "running" && restoredPendingJob?.phase === "importing",
    JSON.stringify(restoredPendingJob));
  const restoredPendingSource = readJsonFromSqlite(join(restoredRoot, "var/runtime.sqlite"),
    "SELECT original_path AS originalPath FROM import_sources WHERE id = ?", [pendingSourceId]);
  record("runtime:pending_source_preserved",
    typeof restoredPendingSource?.originalPath === "string"
      && restoredPendingSource.originalPath.endsWith("/var/imports/upload_pending/source.zip")
      && existsSync(join(restoredRoot, "var/imports/upload_pending/source.zip")),
    restoredPendingSource?.originalPath);
  const restoredBundle = readJsonFromSqlite(join(restoredRoot, "var/rai.sqlite"),
    "SELECT model_run_id AS id FROM active_model_release WHERE singleton = 1");
  record("main:active_bundle", restoredBundle?.id === modelRunId, restoredBundle?.id);
  const restoredJournal = readJsonFromSqlite(journalPath.replace(sourceRoot, restoredRoot),
    "SELECT payload FROM restore_intent WHERE id = 1");
  record("main:restore_journal_present",
    typeof restoredJournal?.payload === "string"
      && JSON.parse(restoredJournal.payload).phase === "prepared",
    "prepared intent restored");

  const server = await startServer(restoredRoot);
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/v1/health`);
    const healthBody = await health.json();
    record("api:health", health.status === 200 && healthBody.status === "ok" && healthBody.databaseReady === true,
      JSON.stringify({ status: healthBody.status, databaseReady: healthBody.databaseReady }));
    record("api:dataset_epoch", healthBody.datasetEpoch === restoredEpoch, healthBody.datasetEpoch);
    const workouts = await fetch(`http://127.0.0.1:${server.port}/v1/workouts?limit=5`);
    const workoutBody = await workouts.json();
    const count = Array.isArray(workoutBody) ? workoutBody.length : workoutBody?.items?.length ?? workoutBody?.workouts?.length ?? 0;
    record("api:workouts_restored", workouts.status === 200 && count === 1, `status=${workouts.status} count=${count}`);
    record("artifact:onnx_bytes",
      readFileSync(join(restoredRoot, "var/model-artifacts/prediction/model.onnx"), "utf8") === "rehearsal-onnx-bytes",
      "byte-identical");
    record("artifact:upload_bytes",
      readFileSync(join(restoredRoot, "var/imports/upload_rehearsal/source.zip"), "utf8") === "rehearsal-zip-bytes",
      "byte-identical");
    record("source:pending_original_readable",
      readFileSync(join(restoredRoot, "var/imports/upload_pending/source.zip"), "utf8") === "pending-zip-bytes",
      "pending source byte-identical");
  } finally {
    await stopServer(server);
  }
  const restoredReceipt = readJsonFromSqlite(join(restoredRoot, "var/rai.sqlite"),
    "SELECT value FROM import_manifest WHERE key = 'rai.applied-import.job-rehearsal-0001'");
  record("main:import_receipt", typeof restoredReceipt?.value === "string"
    && JSON.parse(restoredReceipt.value).importMode === "incremental", "receipt present");
  const activeAfterStartup = readJsonFromSqlite(join(restoredRoot, "var/rai.sqlite"),
    "SELECT model_run_id AS id FROM active_model_release WHERE singleton = 1");
  record("main:active_bundle_after_startup", activeAfterStartup?.id === modelRunId, activeAfterStartup?.id);
  record("main:restore_journal_closed",
    !existsSync(join(restoredRoot, "var/rai.sqlite.restore-journal.sqlite"))
      || readJsonFromSqlite(join(restoredRoot, "var/rai.sqlite.restore-journal.sqlite"),
        "SELECT COUNT(*) AS n FROM restore_intent WHERE id = 1")?.n === 0,
    "startup recovery consumed the prepared journal");

  const rtoMs = Date.now() - restoreStartedAt;
  const result = {
    format: "rai-phase4-backup-restore-rehearsal-v2",
    at: new Date().toISOString(),
    root,
    archive: { path: archive, bytes: archiveBytes, sha256: archiveSha256, entries: archiveVerificationJson?.archiveEntries ?? null },
    files: Object.fromEntries(sqliteFiles.map((rel) => [rel, existsSync(join(restoredRoot, rel)) ? "present" : "absent"])),
    pathManifest: manifest,
    linkAdjudication: linkCases,
    checks,
    passed: checks.every((check) => check.ok),
    rpo: "0 for the stopped-writer window (no writes accepted after archive started)",
    rtoMs,
    environment: {
      platform: process.platform, arch: process.arch, node: process.version,
      note: "isolated temp root; systemctl stop/start and real production config were not exercised"
    }
  };
  writeFileSync(join(root, "rehearsal-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
  if (!keep) {
    rmSync(root, { recursive: true, force: true });
  } else {
    process.stderr.write(`kept rehearsal root: ${root}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  if (!keep) rmSync(root, { recursive: true, force: true });
  process.exitCode = 1;
}
