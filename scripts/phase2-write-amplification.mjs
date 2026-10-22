// 阶段 2 写入证据：在同一实验根的真实 D2 副本上测 assessment 事务的
// 完整事务 / 持锁 / COMMIT 成本，并把“实际执行配置 + WAL 起始状态”变成可执行断言。
//
// 2026-10-21 复审整改 v3（对应 RAI_Phase2_Remaining_Issues A1–A6）：
//   · 三组：normalized（wal_autocheckpoint=0，TRUNCATE 后空 WAL，辅证）、
//     empty-wal（autocheckpoint=1000，TRUNCATE 后空 WAL）、near-threshold
//     （autocheckpoint=1000，计时前用 ballast 预填充到 950–999 帧，提交跨过 1000）；
//   · 每个样本回读 setupPragmas / timedPragmas，验收组 timedPragmas.walAutoCheckpoint 必须为 1000；
//   · WAL 帧数用 `PRAGMA wal_checkpoint(NOOP)` 的 busy/log/checkpointed 观测（不推进 checkpoint），
//     文件字节容量只作容量近似记录，不用于断言；
//   · 计时覆盖 BEGIN IMMEDIATE → 1 个模板 model run + 500 行 assessment → COMMIT；
//   · 每轮从同一 pristine 副本恢复；每变体 1 轮独立预热不入样；AB/BA 轮换；
//   · 结束后在隔离副本读回 model run / assessment / 外键 / 目标索引；
//   · `--verify <json>` 用 scripts/phase2-write-verdict.mjs 的纯裁决逻辑独立验收，
//     缺组、少样本、错表、PRAGMA 不符、未跨阈值、超门槛、异常均退出 1。
//
// 退出码：0=全部门禁通过；1=实验/正确性/性能/证据失败；2=非法参数或路径拒绝。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cpus, hostname, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  ASSESSMENT_ROWS_PER_TRANSACTION,
  ASSESSMENT_TABLE,
  EVIDENCE_SCHEMA_VERSION,
  WAL_OBSERVATION_METHOD,
  buildWriteGate,
  summarize,
  validateEvidence
} from "./phase2-write-verdict.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERDICT_MODULE_PATH = resolve(dirname(SCRIPT_PATH), "phase2-write-verdict.mjs");
const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

/** 固定评估输入：所有样本写同一组值，只让事务边界不同。 */
const ASSESSED_AT = "2026-10-21T12:00:00.000Z";
const SEQUENCE_BASE = 10_000;
const REVIEWED_AT = "2026-10-21";

// ---------------------------------------------------------------------------
// --verify：只读 JSON 的独立验收路径（不需要数据库，也不接受 --root）
// ---------------------------------------------------------------------------
const verifyPath = readArg("--verify");
if (verifyPath !== null) {
  let document;
  try {
    document = JSON.parse(readFileSync(resolve(verifyPath), "utf8"));
  } catch (error) {
    console.error(`phase2-write-amplification: cannot read evidence JSON: ${error?.message ?? error}`);
    process.exit(2);
  }
  const result = validateEvidence(document);
  console.log(JSON.stringify({ ok: result.ok, failures: result.failures }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
  process.exit();
}

// ---------------------------------------------------------------------------
// 路径隔离：实验根必须在仓库外，且不得是仓库祖先 / var / 符号链接
// ---------------------------------------------------------------------------
function realTarget(path) {
  let current = resolve(path);
  const suffix = [];
  while (!existsSync(current)) {
    suffix.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix);
}

function pathContains(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const rootArg = readArg("--root");
if (rootArg === null) {
  console.error("usage: phase2-write-amplification.mjs --root <experiment-root> [--json out.json] [--rounds 100] [--with-health]");
  console.error("       phase2-write-amplification.mjs --verify <evidence.json>");
  process.exit(2);
}
const root = resolve(rootArg);
const rootTarget = realTarget(root);
const repoReal = realpathSync(REPO_ROOT);
if (!isAbsolute(root) || root === "/" || root.split(sep).filter(Boolean).length < 2) {
  console.error(`refusing unsafe experiment root: ${root}`);
  process.exit(2);
}
if (rootTarget === repoReal || rootTarget.startsWith(`${repoReal}${sep}`)) {
  console.error(`experiment root must be outside the repository: ${rootTarget}`);
  process.exit(2);
}
if (pathContains(rootTarget, repoReal)) {
  console.error(`experiment root must not contain the repository: ${rootTarget} contains ${repoReal}`);
  process.exit(2);
}
if (rootTarget === join(repoReal, "var") || rootTarget.startsWith(`${join(repoReal, "var")}${sep}`)) {
  console.error(`experiment root must not contain the repository default data directory: ${rootTarget}`);
  process.exit(2);
}
if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
  console.error(`refusing symlinked experiment root: ${root}`);
  process.exit(2);
}
mkdirSync(root, { recursive: true });
const rootReal = realpathSync(root);
if (rootReal !== rootTarget) {
  console.error(`experiment root changed while resolving: ${rootTarget} -> ${rootReal}`);
  process.exit(2);
}
if (rootReal === repoReal || rootReal.startsWith(`${repoReal}${sep}`) || pathContains(rootReal, repoReal)) {
  console.error(`experiment root is not a disposable directory outside the repository: ${rootReal}`);
  process.exit(2);
}

function insideRoot(path, label) {
  const resolved = resolve(path);
  const candidate = realTarget(resolved);
  if (pathContains(repoReal, candidate)) {
    throw new Error(`${label} must not point inside the repository: ${resolved} (real ${candidate})`);
  }
  const rel = relative(rootReal, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must be inside ${rootReal}: ${resolved} (real ${candidate})`);
  }
  if (existsSync(resolved)) {
    if (lstatSync(resolved).isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${resolved}`);
    const real = realpathSync(resolved);
    const realRel = relative(rootReal, real);
    if (realRel.startsWith("..") || isAbsolute(realRel)) throw new Error(`${label} escapes ${rootReal}: ${resolved} -> ${real}`);
    if (pathContains(repoReal, real)) throw new Error(`${label} must not point inside the repository: ${resolved} -> ${real}`);
  }
  return resolved;
}

const rounds = Number(readArg("--rounds", "100"));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) {
  console.error(`--rounds must be an integer between 1 and 1000: ${readArg("--rounds")}`);
  process.exit(2);
}
const out = readArg("--json");
const withHealth = args.includes("--with-health");
// 默认完整复制：APFS clone 的 copy-on-write 会把“首次写共享块”的成本计入计时，
// 且两侧共享块布局不同会放大尾部分位。完整复制保证每轮恢复出的文件独立分配。
// `--clone-mode apfs` 仅用于需要更快迭代的调试；验收证据记录实际模式。
const cloneMode = readArg("--clone-mode", "copy");
if (!["copy", "apfs"].includes(cloneMode)) {
  console.error(`--clone-mode must be copy or apfs: ${cloneMode}`);
  process.exit(2);
}
const variants = {
  baseline: insideRoot(join(root, "datasets", "d2", "rai.sqlite"), "baseline"),
  ability: insideRoot(join(root, "datasets", "d2-candidate-c", "rai.sqlite"), "ability")
};
const healthVariants = withHealth
  ? {
      narrow: insideRoot(join(root, "datasets", "d2-candidate-a", "rai.sqlite"), "narrow"),
      cover: insideRoot(join(root, "datasets", "d2-candidate-b", "rai.sqlite"), "cover")
    }
  : null;

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(argsToRun) {
  const result = spawnSync("git", argsToRun, { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function openWriter(path, { autoCheckpoint = 0 } = {}) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (String(database.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase() !== "wal") {
    database.exec("PRAGMA journal_mode = WAL");
  }
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpoint}`);
  const pragmas = readPragmas(database);
  if (pragmas.foreignKeys !== 1 || String(pragmas.journalMode).toLowerCase() !== "wal"
    || pragmas.synchronous !== 1 || pragmas.busyTimeout !== 5000 || pragmas.walAutoCheckpoint !== autoCheckpoint) {
    database.close();
    throw new Error(`write pragmas do not match the measurement path: ${JSON.stringify(pragmas)}`);
  }
  return { database, pragmas };
}

function readPragmas(database) {
  return {
    foreignKeys: Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys ?? -1),
    journalMode: String(database.prepare("PRAGMA journal_mode").get()?.journal_mode ?? ""),
    synchronous: Number(database.prepare("PRAGMA synchronous").get()?.synchronous ?? -1),
    busyTimeout: Number(database.prepare("PRAGMA busy_timeout").get()?.timeout ?? -1),
    walAutoCheckpoint: Number(database.prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint ?? -1),
    pageSize: Number(database.prepare("PRAGMA page_size").get()?.page_size ?? -1)
  };
}

function walBytes(path) {
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}

/**
 * `PRAGMA wal_checkpoint(NOOP)` 只取得返回值，不推进 checkpoint。
 * 返回 busy/log/checkpointed 三列；不支持或列缺失时抛错（配置/观测能力不足 → 失败）。
 */
function readWalState(database, path) {
  let row;
  try {
    row = database.prepare("PRAGMA wal_checkpoint(NOOP)").get();
  } catch (error) {
    throw new Error(`wal_checkpoint(NOOP) is not available; WAL frame evidence cannot be produced: ${error?.message ?? error}`);
  }
  const busy = Number(row?.busy);
  const log = Number(row?.log);
  const checkpointed = Number(row?.checkpointed);
  if (![busy, log, checkpointed].every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error(`wal_checkpoint(NOOP) returned invalid columns: ${JSON.stringify(row)}`);
  }
  const bytes = walBytes(path);
  const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size ?? 4096);
  return {
    method: WAL_OBSERVATION_METHOD,
    busy,
    log,
    checkpointed,
    walBytes: bytes,
    // 仅作容量近似；WAL 有 32 字节头/24 字节帧头，且文件可能被重用，不能当成有效帧数。
    capacityPages: bytes > 0 ? Math.ceil(bytes / pageSize) : 0
  };
}

function truncateCheckpoint(database, path) {
  const row = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const result = {
    busy: Number(row?.busy ?? -1),
    log: Number(row?.log ?? -1),
    checkpointed: Number(row?.checkpointed ?? -1),
    walBytesBefore: walBytes(path)
  };
  if (result.busy !== 0 || result.log !== 0) {
    throw new Error(`TRUNCATE checkpoint did not leave an empty idle WAL: ${JSON.stringify(result)}`);
  }
  result.walBytesAfter = walBytes(path);
  return result;
}

// macOS 的 cp -c 使用 APFS clone，避免 100 轮 × 243 MB 的真实复制；其他平台退回普通复制。
function cloneDatabase(source, destination) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${destination}${suffix}`, { force: true });
  if (cloneMode === "apfs" && process.platform === "darwin") {
    const result = spawnSync("cp", ["-c", source, destination], { stdio: "ignore" });
    if (result.status === 0) return;
  }
  copyFileSync(source, destination);
}

function tableCounts(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    const counts = {};
    for (const table of tables) counts[table.name] = Number(database.prepare(`SELECT COUNT(*) AS c FROM "${table.name}"`).get()?.c ?? -1);
    return counts;
  } finally {
    database.close();
  }
}

function indexDefinitions(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all();
  } finally {
    database.close();
  }
}

function schemaInfo(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const sqlite = database.prepare("SELECT sqlite_version() AS version").get();
    const pageSize = database.prepare("PRAGMA page_size").get();
    const pageCount = database.prepare("PRAGMA page_count").get();
    const journalMode = database.prepare("PRAGMA journal_mode").get();
    const migration = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    return {
      sqliteVersion: String(sqlite?.version ?? ""),
      pageSize: Number(pageSize?.page_size ?? 0),
      pageCount: Number(pageCount?.page_count ?? 0),
      journalMode: String(journalMode?.journal_mode ?? ""),
      schemaVersion: Number(migration?.version ?? 0)
    };
  } finally {
    database.close();
  }
}

/**
 * 预热本次事务会碰到的表/索引页（计时外）。
 *
 * 每个样本从 pristine 副本新开连接，页缓存是冷的；生产中写连接是长驻的。
 * 不预热会把“首次读 900+ 行的评估表/索引页”误算成索引维护成本。两侧执行同一
 * 预热 SQL；只读，不改变数据。预热后再做 WAL 归一化/预填充。
 */
function warmAssessmentPages(database) {
  database.prepare("SELECT * FROM ability_assessments").all();
  database.prepare("SELECT training_session_id, model_run_id FROM ability_assessments").all();
  database.prepare("SELECT * FROM model_runs").all();
  database.prepare("SELECT * FROM workout_features").all();
  database.prepare("SELECT * FROM training_sessions").all();
}

function anchorRows(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(`
      SELECT feature.id AS feature_id, feature.training_session_id AS session_id
      FROM workout_features feature
      JOIN training_sessions session ON session.id = feature.training_session_id
      ORDER BY feature.id
      LIMIT 500
    `).all();
  } finally {
    database.close();
  }
}

function hashRows(rows) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

// ---------------------------------------------------------------------------
// assessment 工作负载
// ---------------------------------------------------------------------------
function createAssessmentVariant(path, label) {
  if (!existsSync(path)) throw new Error(`missing ${label} database: ${path}`);
  const { database, pragmas } = openWriter(path, { autoCheckpoint: 0 });
  const baseModelRun = database.prepare(
    "SELECT id FROM model_runs WHERE status = 'succeeded' ORDER BY id LIMIT 1"
  ).get();
  if (!baseModelRun) throw new Error(`${label} has no succeeded model run to anchor assessments`);
  const anchors = database.prepare(`
    SELECT feature.id AS feature_id, feature.training_session_id AS session_id
    FROM workout_features feature
    JOIN training_sessions session ON session.id = feature.training_session_id
    ORDER BY feature.id
    LIMIT 500
  `).all();
  if (anchors.length < ASSESSMENT_ROWS_PER_TRANSACTION) {
    throw new Error(`${label} has only ${anchors.length} feature/session pairs`);
  }
  const cloneModelRun = database.prepare(`
    INSERT INTO model_runs
      (id, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
       evaluated_at, status, created_at, completed_at)
    SELECT ?, feature_run_id, dataset_version, model_version, model_config_json, model_config_hash,
           evaluated_at, status, created_at, completed_at
    FROM model_runs WHERE id = ?
  `);
  const insert = database.prepare(`INSERT INTO ability_assessments
    (id, model_run_id, feature_id, training_session_id, sequence_number, assessment_status,
     confidence, effective_weights_json, confidence_factors_json, updated_true_ability,
     explanation_codes_json, explanation_json, assessed_at)
    VALUES (?, ?, ?, ?, ?, 'eligible', 0.7, '{}', '{}', 1, '[]', '{}', ?)`);
  return {
    label,
    path,
    database,
    setupPragmas: pragmas,
    baseModelRun: baseModelRun.id,
    anchors,
    cloneModelRun,
    insert,
    runId: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    samples: [],
    warmupSamples: []
  };
}

const STRESS_PREFILL_VALUE = "x".repeat(4000);
const STRESS_PREFILL_TARGET_MIN = 950;
const STRESS_PREFILL_TARGET_MAX = 1000;

/**
 * 自动 checkpoint 关闭时，把 WAL 预填充到 950–999 个有效帧（计时外）。
 * 按批提交并每批用 NOOP 回读；接近目标时缩小批量，避免越过 1000。
 */
function prefillWalToThreshold(variant) {
  const { database, path } = variant;
  const insert = database.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)");
  let rows = 0;
  let batchIndex = 0;
  for (;;) {
    const before = readWalState(database, path);
    if (before.log >= STRESS_PREFILL_TARGET_MIN) {
      if (before.log >= STRESS_PREFILL_TARGET_MAX) {
        throw new Error(`prefill overshot the autocheckpoint threshold: ${before.log} frames`);
      }
      return { rows, wal: before, targetMin: STRESS_PREFILL_TARGET_MIN, targetMax: STRESS_PREFILL_TARGET_MAX };
    }
    const batch = before.log < 800 ? 100 : 25;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < batch; index += 1) {
        insert.run(`phase2-wal-ballast-${variant.label}-${batchIndex}-${index}`, STRESS_PREFILL_VALUE);
        rows += 1;
      }
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
    batchIndex += 1;
    if (rows > 5000) throw new Error("prefill did not converge below 1000 WAL frames");
  }
}

function runAssessmentTransaction(variant, {
  round, state, orderIndex, setupPragmas, timedPragmas, walBefore, truncate, prefill
}) {
  const modelRunId = `write-model-${variant.runId}-${round}`;
  const startedAt = performance.now();
  let begunAt = null;
  let insertedAt = null;
  let committedAt = null;
  let modelRunRows = 0;
  let rowsInserted = 0;
  try {
    variant.database.exec("BEGIN IMMEDIATE");
    begunAt = performance.now();
    modelRunRows = Number(variant.cloneModelRun.run(modelRunId, variant.baseModelRun).changes);
    for (const [index, anchor] of variant.anchors.entries()) {
      rowsInserted += Number(variant.insert.run(`write-a-${variant.runId}-${round}-${index}`, modelRunId,
        anchor.feature_id, anchor.session_id, SEQUENCE_BASE + index, ASSESSED_AT).changes);
    }
    insertedAt = performance.now();
    variant.database.exec("COMMIT");
    committedAt = performance.now();
  } catch (error) {
    try { if (variant.database.isTransaction) variant.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
  const walAfter = readWalState(variant.database, variant.path);
  const framesAdded = walAfter.log - walBefore.log;
  const sample = {
    round,
    orderIndex,
    state,
    variant: variant.label,
    table: ASSESSMENT_TABLE,
    modelRunId,
    modelRunRows,
    rowsInserted,
    assessedAt: ASSESSED_AT,
    sequenceBase: SEQUENCE_BASE,
    beginMs: begunAt - startedAt,
    insertMs: insertedAt - begunAt,
    commitMs: committedAt - insertedAt,
    lockMs: committedAt - begunAt,
    totalMs: committedAt - startedAt,
    setupPragmas,
    timedPragmas,
    truncate: truncate ?? null,
    prefill: prefill ? { rows: prefill.rows, walLog: prefill.wal.log, targetMin: prefill.targetMin, targetMax: prefill.targetMax } : null,
    prefillRows: prefill?.rows ?? 0,
    walBefore,
    walAfter,
    framesAdded,
    checkpointedFrames: walAfter.checkpointed - walBefore.checkpointed,
    crossedThreshold: state === "near-threshold" && walBefore.log < 1000 && walAfter.log >= 1000,
    walCapacityApproximation: {
      beforePages: walBefore.capacityPages,
      afterPages: walAfter.capacityPages,
      note: "ceil(walBytes/pageSize) is capacity only; assertions use NOOP log/checkpointed frames"
    }
  };
  return sample;
}

function summarizeAssessmentVariant(variant) {
  const samples = variant.samples;
  return {
    label: variant.label,
    path: variant.path,
    table: ASSESSMENT_TABLE,
    rowsPerTransaction: ASSESSMENT_ROWS_PER_TRANSACTION,
    pragmas: { setup: variant.setupPragmas, timed: variant.timedPragmas },
    transaction: summarize(samples.map((sample) => sample.totalMs)),
    lock: summarize(samples.map((sample) => sample.lockMs)),
    begin: summarize(samples.map((sample) => sample.beginMs)),
    insert: summarize(samples.map((sample) => sample.insertMs)),
    commit: summarize(samples.map((sample) => sample.commitMs)),
    startingWalFrames: summarize(samples.map((sample) => sample.walBefore.log)),
    endingWalFrames: summarize(samples.map((sample) => sample.walAfter.log)),
    checkpointedFrames: summarize(samples.map((sample) => sample.checkpointedFrames)),
    checkpointPauses: {
      over50msTotal: samples.filter((sample) => sample.totalMs > 50).length,
      over50msCommit: samples.filter((sample) => sample.commitMs > 50).length,
      autocheckpointPages: 1000
    },
    samples,
    warmupSamples: variant.warmupSamples
  };
}

function measureAssessmentGroup(state, sourcePaths) {
  const workDir = join(root, "work", "assessment", state);
  mkdirSync(workDir, { recursive: true });
  const groups = Object.fromEntries(["baseline", "ability"].map((label) => [label, {
    label,
    path: sourcePaths[label],
    setupPragmas: null,
    timedPragmas: null,
    samples: [],
    warmupSamples: []
  }]));

  const runOne = (label, round, record, orderIndex) => {
    const sourcePath = sourcePaths[label];
    const workPath = insideRoot(join(workDir, `${label}.sqlite`), `work/assessment/${state}/${label}`);
    cloneDatabase(sourcePath, workPath);
    const handle = createAssessmentVariant(workPath, label);
    const group = groups[label];
    try {
      group.setupPragmas = handle.setupPragmas;
      warmAssessmentPages(handle.database);
      const truncate = truncateCheckpoint(handle.database, workPath);
      let prefill = null;
      if (state === "near-threshold") {
        prefill = prefillWalToThreshold(handle);
        // 预填充 ballast 会挤掉评估表的页缓存；计时前重新预热，保持与生产长驻
        // 写连接可比，同时不改变 WAL 起始帧。
        warmAssessmentPages(handle.database);
      }
      const walBefore = readWalState(handle.database, workPath);
      if (state !== "normalized") {
        handle.database.exec("PRAGMA wal_autocheckpoint = 1000");
      }
      const timedPragmas = readPragmas(handle.database);
      group.timedPragmas = timedPragmas;
      const sample = runAssessmentTransaction(handle, {
        round,
        state,
        orderIndex,
        setupPragmas: handle.setupPragmas,
        timedPragmas,
        walBefore,
        truncate,
        prefill
      });
      (record ? group.samples : group.warmupSamples).push(sample);
    } finally {
      handle.database.close();
    }
  };

  for (const label of ["baseline", "ability"]) runOne(label, -1, false, 0);
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0 ? ["baseline", "ability"] : ["ability", "baseline"];
    for (const [orderIndex, label] of order.entries()) runOne(label, round, true, orderIndex);
  }
  return Object.fromEntries(Object.entries(groups).map(([label, group]) => [label, summarizeAssessmentVariant(group)]));
}

// ---------------------------------------------------------------------------
// 提交持久化读回（隔离副本，事务结束后重新打开只读连接）
// ---------------------------------------------------------------------------
function persistenceCheck(label, sourcePath) {
  const workDir = join(root, "work", "persistence");
  mkdirSync(workDir, { recursive: true });
  const workPath = insideRoot(join(workDir, `${label}.sqlite`), `work/persistence/${label}`);
  cloneDatabase(sourcePath, workPath);
  const before = tableCounts(workPath);
  const handle = createAssessmentVariant(workPath, label);
  const modelRunId = `persist-model-${label}`;
  try {
    handle.database.exec("BEGIN IMMEDIATE");
    handle.cloneModelRun.run(modelRunId, handle.baseModelRun);
    for (const [index, anchor] of handle.anchors.entries()) {
      handle.insert.run(`persist-a-${label}-${index}`, modelRunId, anchor.feature_id,
        anchor.session_id, SEQUENCE_BASE + index, ASSESSED_AT);
    }
    handle.database.exec("COMMIT");
    handle.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    try { if (handle.database.isTransaction) handle.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
    handle.database.close();
    throw error;
  }
  handle.database.close();

  const database = new DatabaseSync(workPath, { readOnly: true });
  try {
    const modelRun = database.prepare("SELECT id, status, feature_run_id, dataset_version, model_version, model_config_hash FROM model_runs WHERE id = ?")
      .get(modelRunId);
    const baseRow = database.prepare("SELECT feature_run_id, dataset_version, model_version, model_config_hash FROM model_runs WHERE id = ?")
      .get(handle.baseModelRun);
    const assessment = database.prepare(`
      SELECT COUNT(*) AS rows,
        COUNT(DISTINCT feature_id) AS features,
        COUNT(DISTINCT training_session_id) AS sessions,
        SUM(CASE WHEN assessed_at = ? THEN 1 ELSE 0 END) AS fixed_timestamps
      FROM ability_assessments WHERE model_run_id = ?
    `).get(ASSESSED_AT, modelRunId);
    const orphan = database.prepare(`
      SELECT COUNT(*) AS rows
      FROM ability_assessments assessment
      LEFT JOIN workout_features feature ON feature.id = assessment.feature_id
      LEFT JOIN training_sessions session ON session.id = assessment.training_session_id
      WHERE assessment.model_run_id = ?
        AND (feature.id IS NULL OR session.id IS NULL
          OR feature.training_session_id <> assessment.training_session_id)
    `).get(modelRunId);
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    const quickCheck = database.prepare("PRAGMA quick_check").get();
    const indexRow = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_ability_assessments_session'").get();
    const after = tableCounts(workPath);
    const expectedIndex = label === "ability";
    const rowsReadBack = Number(assessment?.rows ?? -1);
    const modelRunsReadBack = modelRun ? 1 : 0;
    const ok = Boolean(
      modelRun && baseRow
      && String(modelRun.status) === "succeeded"
      && String(modelRun.feature_run_id) === String(baseRow.feature_run_id)
      && String(modelRun.dataset_version) === String(baseRow.dataset_version)
      && String(modelRun.model_version) === String(baseRow.model_version)
      && String(modelRun.model_config_hash) === String(baseRow.model_config_hash)
      && rowsReadBack === ASSESSMENT_ROWS_PER_TRANSACTION
      && Number(assessment?.features) === ASSESSMENT_ROWS_PER_TRANSACTION
      && Number(assessment?.sessions) === ASSESSMENT_ROWS_PER_TRANSACTION
      && Number(assessment?.fixed_timestamps) === ASSESSMENT_ROWS_PER_TRANSACTION
      && Number(orphan?.rows) === 0
      && foreignKeys.length === 0
      && String(quickCheck?.quick_check ?? "") === "ok"
      && (indexRow !== undefined) === expectedIndex
      && after[ASSESSMENT_TABLE] === before[ASSESSMENT_TABLE] + ASSESSMENT_ROWS_PER_TRANSACTION
      && after.model_runs === before.model_runs + 1
    );
    return {
      ok,
      label,
      table: ASSESSMENT_TABLE,
      path: workPath,
      modelRunId,
      modelRunsReadBack,
      rowsReadBack,
      distinctFeatures: Number(assessment?.features ?? -1),
      distinctSessions: Number(assessment?.sessions ?? -1),
      fixedTimestamps: Number(assessment?.fixed_timestamps ?? -1),
      orphanRows: Number(orphan?.rows ?? -1),
      foreignKeyViolations: foreignKeys.length,
      quickCheck: String(quickCheck?.quick_check ?? ""),
      targetIndexPresent: indexRow !== undefined,
      targetIndexSql: indexRow?.sql ?? null,
      expectedTargetIndex: expectedIndex,
      countsBefore: before,
      countsAfter: after,
      readBackStatus: modelRun?.status ?? null,
      baseModelRunId: handle.baseModelRun,
      connectionsClosed: true
    };
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// 可选：健康记录 1000 行写入（独立健康索引实验，不作为 assessment 验收替代）
// ---------------------------------------------------------------------------
function measureHealthWrites(sourcePaths) {
  const workDir = join(root, "work", "health");
  mkdirSync(workDir, { recursive: true });
  const result = {};
  for (const [label, sourcePath] of Object.entries(sourcePaths)) {
    const samples = [];
    const warmups = [];
    for (let round = -1; round < rounds; round += 1) {
      const workPath = insideRoot(join(workDir, `${label}.sqlite`), `work/health/${label}`);
      cloneDatabase(sourcePath, workPath);
      const { database, pragmas } = openWriter(workPath, { autoCheckpoint: 0 });
      try {
        truncateCheckpoint(database, workPath);
        database.exec("PRAGMA wal_autocheckpoint = 1000");
        const timedPragmas = readPragmas(database);
        const startedAt = performance.now();
        database.exec("BEGIN IMMEDIATE");
        const begunAt = performance.now();
        const insert = database.prepare(`INSERT INTO health_records
          (id, type, source_name, source_category, unit, value_numeric, start_at, end_at, metadata_json, raw_attributes_json)
          VALUES (?, 'HKQuantityTypeIdentifierHeartRate', 'Apple Watch', 'apple_watch', 'count/min', 150, ?, ?, '{}', '{}')`);
        const base = Date.UTC(2026, 9, 21, 12, 0, 0) + Math.max(0, round) * 3_600_000;
        let rowsInserted = 0;
        for (let index = 0; index < 1000; index += 1) {
          const start = base + index * 1000;
          rowsInserted += Number(insert.run(`phase2-health-${label}-${round}-${index}`,
            new Date(start).toISOString(), new Date(start + 500).toISOString()).changes);
        }
        const insertedAt = performance.now();
        database.exec("COMMIT");
        const committedAt = performance.now();
        const sample = {
          round, table: "health_records", rowsInserted,
          setupPragmas: pragmas, timedPragmas,
          beginMs: begunAt - startedAt,
          insertMs: insertedAt - begunAt,
          commitMs: committedAt - insertedAt,
          lockMs: committedAt - begunAt,
          totalMs: committedAt - startedAt
        };
        (round < 0 ? warmups : samples).push(sample);
      } finally {
        database.close();
      }
    }
    result[label] = {
      path: sourcePath,
      table: "health_records",
      rowsPerTransaction: 1000,
      transaction: summarize(samples.map((sample) => sample.totalMs)),
      lock: summarize(samples.map((sample) => sample.lockMs)),
      commit: summarize(samples.map((sample) => sample.commitMs)),
      samples,
      warmupSamples: warmups,
      note: "independent health-index experiment; not part of the assessment checkpoint acceptance"
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
let document;
try {
  const environment = {
    node: process.version,
    sqlite: (() => {
      const database = new DatabaseSync(":memory:");
      try { return String(database.prepare("SELECT sqlite_version() AS version").get()?.version ?? ""); }
      finally { database.close(); }
    })(),
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    totalMemoryBytes: totalmem(),
    hostname: hostname()
  };
  const datasetInfo = {
    baseline: {
      path: variants.baseline,
      bytes: statSync(variants.baseline).size,
      sha256: sha256File(variants.baseline),
      schema: schemaInfo(variants.baseline),
      counts: tableCounts(variants.baseline),
      indexes: indexDefinitions(variants.baseline),
      anchorsSha256: hashRows(anchorRows(variants.baseline))
    },
    ability: {
      path: variants.ability,
      bytes: statSync(variants.ability).size,
      sha256: sha256File(variants.ability),
      schema: schemaInfo(variants.ability),
      counts: tableCounts(variants.ability),
      indexes: indexDefinitions(variants.ability),
      anchorsSha256: hashRows(anchorRows(variants.ability))
    }
  };
  const baselineIndexes = new Set(datasetInfo.baseline.indexes.map((index) => index.name));
  const abilityIndexes = new Set(datasetInfo.ability.indexes.map((index) => index.name));
  const indexDiff = {
    onlyBaseline: [...baselineIndexes].filter((name) => !abilityIndexes.has(name)),
    onlyAbility: [...abilityIndexes].filter((name) => !baselineIndexes.has(name)),
    expectedOnlyAbility: ["idx_ability_assessments_session"]
  };
  const identityOk = datasetInfo.baseline.anchorsSha256 === datasetInfo.ability.anchorsSha256
    && JSON.stringify(datasetInfo.baseline.counts) === JSON.stringify(datasetInfo.ability.counts)
    && indexDiff.onlyBaseline.length === 0
    && indexDiff.onlyAbility.length === 1
    && indexDiff.onlyAbility[0] === "idx_ability_assessments_session"
    && datasetInfo.ability.indexes.some((index) => index.name === "idx_ability_assessments_session")
    && !datasetInfo.baseline.indexes.some((index) => index.name === "idx_ability_assessments_session");

  const groups = {
    normalized: measureAssessmentGroup("normalized", variants),
    "empty-wal": measureAssessmentGroup("empty-wal", variants),
    "near-threshold": measureAssessmentGroup("near-threshold", variants)
  };
  const gates = {
    normalized: buildWriteGate(groups.normalized.baseline, groups.normalized.ability),
    "empty-wal": buildWriteGate(groups["empty-wal"].baseline, groups["empty-wal"].ability),
    "near-threshold": buildWriteGate(groups["near-threshold"].baseline, groups["near-threshold"].ability)
  };
  const persistence = {
    baseline: persistenceCheck("baseline", variants.baseline),
    ability: persistenceCheck("ability", variants.ability)
  };

  document = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    reviewedAt: REVIEWED_AT,
    root: rootReal,
    environment,
    source: {
      head: git(["rev-parse", "HEAD"]),
      worktreeDirty: (git(["status", "--porcelain"]) ?? "") !== "",
      scriptSha256: sha256File(SCRIPT_PATH),
      verdictModuleSha256: sha256File(VERDICT_MODULE_PATH),
      nodeCommand: process.argv.join(" "),
      scriptPath: SCRIPT_PATH,
      verdictModulePath: VERDICT_MODULE_PATH
    },
    measurementMode: {
      timedScope: "BEGIN IMMEDIATE -> 1 model run + 500 assessments -> COMMIT",
      sampleIsolation: "fresh copy from the same pristine D2 copy before every timed transaction; referenced tables are read once outside timing (warm connection pages, same SQL both sides)",
      groups: {
        normalized: "auxiliary: wal_autocheckpoint=0; TRUNCATE checkpoint before every timed transaction",
        emptyWal: "acceptance: wal_autocheckpoint=1000; TRUNCATE checkpoint leaves an empty WAL",
        nearThreshold: "acceptance: wal_autocheckpoint=1000; ballast prefill outside timing to 950-999 frames; COMMIT crosses 1000"
      },
      lockMs: "application-level interval from BEGIN return to COMMIT return; not SQLite internal lock instrumentation",
      checkpointAccounting: "automatic checkpoint time inside COMMIT is included; nothing is subtracted"
    },
    workload: {
      table: ASSESSMENT_TABLE,
      rowsPerTransaction: ASSESSMENT_ROWS_PER_TRANSACTION,
      modelRunsPerTransaction: 1,
      anchors: 500,
      anchorQuery: "workout_features JOIN training_sessions ORDER BY feature.id LIMIT 500",
      anchorIdentityOk: identityOk,
      assessedAt: ASSESSED_AT,
      sequenceBase: SEQUENCE_BASE
    },
    rounds,
    warmupRoundsPerVariant: 1,
    samplesPerVariant: rounds,
    cloneMode,
    walObservation: {
      method: WAL_OBSERVATION_METHOD,
      supported: true,
      columns: ["busy", "log", "checkpointed"],
      note: "NOOP returns the frame counters without advancing a checkpoint; walBytes capacity is recorded but never used for assertions"
    },
    dataset: datasetInfo,
    indexDiff,
    groups,
    gates,
    persistence,
    healthWriteExperiment: withHealth ? measureHealthWrites({ baseline: variants.baseline, ...healthVariants }) : null,
    failures: []
  };

  const provisional = validateEvidence({ ...document, verdict: { ok: true, failures: [] } });
  const gateFailures = [];
  const warnings = [];
  for (const [name, gate] of [["normalized", gates.normalized], ["empty-wal", gates["empty-wal"]], ["near-threshold", gates["near-threshold"]]]) {
    for (const [metric, detail] of Object.entries(gate.metrics)) {
      if (!detail.p95Pass) {
        const entry = {
          code: "p95_over_limit",
          where: name,
          detail: `${metric} delta=${detail.p95Ms.toFixed(3)}ms limit=${detail.p95LimitMs.toFixed(3)}ms`
        };
        (name === "normalized" ? warnings : gateFailures).push(entry);
      }
    }
  }
  const failures = [...provisional.failures];
  for (const failure of gateFailures) {
    if (!failures.some((item) => item.code === failure.code && item.where === failure.where && item.detail === failure.detail)) {
      failures.push(failure);
    }
  }
  document.verdict = {
    ok: failures.length === 0,
    failures,
    warnings,
    auxiliary: {
      normalized: gates.normalized.ok,
      note: "normalized is auxiliary evidence and cannot replace the two formal groups"
    },
    formalGroups: {
      "empty-wal": gates["empty-wal"].ok,
      "near-threshold": gates["near-threshold"].ok
    },
    checks: {
      workload: identityOk,
      sampleIntegrity: provisional.ok || !failures.some((failure) => ["sample_count", "missing_round", "duplicate_round", "warmup_count", "warmup_mixed_into_samples", "invalid_round"].includes(failure.code)),
      configuration: !failures.some((failure) => ["invalid_setup_pragmas", "invalid_timed_pragmas"].includes(failure.code)),
      walState: !failures.some((failure) => ["wal_not_empty", "wal_start_out_of_range", "threshold_not_crossed", "checkpoint_not_observed", "invalid_wal_observation", "truncate_not_clean"].includes(failure.code)),
      persistence: Object.values(persistence).every((check) => check.ok),
      gates: gates["empty-wal"].ok && gates["near-threshold"].ok
    }
  };
  // 用独立校验器复核最终文档（包括 verdict 自身的一致性）。
  const finalValidation = validateEvidence(document);
  if (!finalValidation.ok) {
    document.verdict.ok = false;
    document.verdict.failures = [...document.verdict.failures, ...finalValidation.failures];
  }
} catch (error) {
  document = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    reviewedAt: REVIEWED_AT,
    root: rootReal,
    rounds,
    workload: {
      table: ASSESSMENT_TABLE,
      rowsPerTransaction: ASSESSMENT_ROWS_PER_TRANSACTION,
      modelRunsPerTransaction: 1
    },
    groups: {},
    gates: {},
    persistence: {},
    walObservation: { method: WAL_OBSERVATION_METHOD, supported: false },
    failures: [{ code: "experiment_failed", message: String(error?.stack ?? error) }],
    verdict: { ok: false, failures: [{ code: "experiment_failed", message: String(error?.message ?? error) }] }
  };
}

if (!args.includes("--keep-work") && existsSync(join(root, "work"))) {
  rmSync(join(root, "work"), { recursive: true, force: true });
  document.cleanup = { workDirectoryRemoved: true, note: "all evidence connections closed before cleanup" };
}
if (out) writeFileSync(resolve(out), `${JSON.stringify(document, null, 2)}\n`);
console.log(JSON.stringify(document, null, 2));
if (!document.verdict?.ok) process.exitCode = 1;
