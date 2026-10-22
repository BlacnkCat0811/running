// 阶段 2 迁移证据：从真实 v46 副本升级到 v47，记录 schema、checksum、原子回滚、
// 迁移窗口与兼容回滚读取。只操作实验根内的副本；拒绝仓库默认数据库。
//
//   node --import tsx scripts/phase2-migration-evidence.mjs \
//     --source <v46.sqlite> --root <experiment-root> [--json out.json]
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { FROZEN_MIGRATION_CHECKSUMS, RaiDatabase } from "../packages/storage-sqlite/src/database.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const source = readArg("--source");
const rootArg = readArg("--root");
const out = readArg("--json");
if (!source || !rootArg) {
  console.error("usage: phase2-migration-evidence.mjs --source <v46.sqlite> --root <dir>");
  process.exit(2);
}
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
const root = resolve(rootArg);
const rootTarget = realTarget(root);
const repoReal = realpathSync(REPO_ROOT);
if (!isAbsolute(root) || root === "/" || root.split(sep).filter(Boolean).length < 2) {
  console.error(`refusing unsafe experiment root: ${root}`);
  process.exit(2);
}
if (rootTarget === repoReal || rootTarget.startsWith(`${repoReal}${sep}`)
  || rootTarget === join(repoReal, "var") || rootTarget.startsWith(`${join(repoReal, "var")}${sep}`)) {
  console.error(`experiment root must be outside the repository: ${rootTarget}`);
  process.exit(2);
}
if (pathContains(rootTarget, repoReal)) {
  console.error(`experiment root must not contain the repository: ${rootTarget} contains ${repoReal}`);
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
if (pathContains(rootReal, repoReal)) {
  console.error(`experiment root must not contain the repository: ${rootReal}`);
  process.exit(2);
}
const sourceResolved = resolve(source);
const sourceRel = relative(rootReal, realTarget(sourceResolved));
if (sourceRel.startsWith("..") || isAbsolute(sourceRel)) {
  console.error("source must be inside the experiment root");
  process.exit(2);
}
if (!existsSync(sourceResolved)) {
  console.error(`source does not exist: ${sourceResolved}`);
  process.exit(2);
}
if (pathContains(repoReal, realTarget(sourceResolved)) || pathContains(repoReal, sourceResolved)) {
  console.error(`source must not point inside the repository: ${sourceResolved}`);
  process.exit(2);
}
if (lstatSync(sourceResolved).isSymbolicLink()) {
  console.error(`source must not be a symlink: ${sourceResolved}`);
  process.exit(2);
}
const sourceReal = realpathSync(sourceResolved);
const sourceRealRel = relative(rootReal, sourceReal);
if (sourceRealRel.startsWith("..") || isAbsolute(sourceRealRel)) {
  console.error(`source escapes the experiment root: ${sourceResolved} -> ${sourceReal}`);
  process.exit(2);
}
if (pathContains(repoReal, sourceReal)) {
  console.error(`source must not point inside the repository: ${sourceResolved} -> ${sourceReal}`);
  process.exit(2);
}

const target = join(rootReal, "migration-copy.sqlite");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(`${target}${suffix}`)) rmSync(`${target}${suffix}`);
  if (existsSync(`${sourceReal}${suffix}`)) copyFileSync(`${sourceReal}${suffix}`, `${target}${suffix}`);
}

function sizes(path) {
  const result = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${path}${suffix}`;
    result[suffix || "main"] = existsSync(file) ? statSync(file).size : 0;
  }
  result.total = Object.values(result).reduce((sum, value) => sum + value, 0);
  return result;
}

function sqliteState(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
    const pageCount = Number(db.prepare("PRAGMA page_count").get().page_count);
    const freelist = Number(db.prepare("PRAGMA freelist_count").get().freelist_count);
    const migrations = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
    const indexes = db.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all();
    return {
      pageSize, pageCount, freelist,
      logicalBytes: pageSize * (pageCount - freelist),
      maxMigration: migrations.at(-1)?.version ?? null,
      migrations: migrations.length,
      hasV47Index: indexes.some((row) => row.name === "idx_ability_assessments_session"),
      indexes: indexes.length
    };
  } finally { db.close(); }
}

// 在 v46 源副本上模拟“迁移语句执行后、账本提交前中断”：同一事务里建索引再 ROLLBACK，
// 索引与账本都必须回到 v46 状态。这是 SQLite DDL 事务性的直接证据。
const interrupted = join(rootReal, "migration-interrupted.sqlite");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(`${interrupted}${suffix}`)) rmSync(`${interrupted}${suffix}`);
  if (existsSync(`${sourceReal}${suffix}`)) copyFileSync(`${sourceReal}${suffix}`, `${interrupted}${suffix}`);
}
let interruptedEvidence;
{
  const db = new DatabaseSync(interrupted);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("BEGIN IMMEDIATE");
  db.exec("CREATE INDEX idx_ability_assessments_session ON ability_assessments(training_session_id, model_run_id)");
  db.exec("ROLLBACK");
  const rolledBack = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_ability_assessments_session'").get();
  const ledger = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 47").get();
  db.close();
  interruptedEvidence = {
    indexPresentAfterRollback: Boolean(rolledBack),
    ledgerRowsAfterRollback: Number(ledger?.count ?? 0)
  };
  for (const suffix of ["-wal", "-shm"]) rmSync(`${interrupted}${suffix}`, { force: true });
  rmSync(interrupted, { force: true });
}

const before = { bytes: sizes(target), state: sqliteState(target) };
const pending = RaiDatabase.pendingMigrations(target).map((row) => row.version);
const startedAt = performance.now();
const opened = await RaiDatabase.open(target, { createMigrationBackup: false });
const applyMs = performance.now() - startedAt;
const during = sizes(target);
opened.close();
const after = { bytes: sizes(target), state: sqliteState(target) };

// 兼容回滚读取：v47 账本 + 当前查询实现。当前批次没有改任何查询 SQL，
// 所以这份构建本身就是“认识 v47、使用旧查询”的回滚构建。
const rollbackStore = await import("../apps/api/src/data.ts");
const store = new rollbackStore.RaiReadStore(target);
let rollbackRead = null;
try {
  const list = store.workoutsWithViews({ limit: 5, offset: 0 });
  const summary = store.dataSummary();
  rollbackRead = {
    ok: true,
    items: list.items.length,
    total: list.total,
    healthRecords: summary.counts.healthRecords
  };
} catch (error) {
  rollbackRead = { ok: false, error: String(error?.message ?? error) };
} finally { store.close(); }

// 兼容回滚构建的服务器级证据：当前构建认识 v47 账本，查询 SQL 与 v46 相同。
// 只读检查不够——还要验证真实 API 进程能启动、能写、能优雅关闭，且写入落盘。
const rollbackRuntime = join(rootReal, "rollback-runtime");
mkdirSync(join(rollbackRuntime, "var"), { recursive: true });
const freePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no free port"))));
  });
});
async function fetchJson(port, path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      host: `127.0.0.1:${port}`,
      authorization: "Bearer phase2-migration-token",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {})
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${body.slice(0, 400)}`);
  return body.length === 0 ? null : JSON.parse(body);
}
let rollbackServer;
{
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: rollbackRuntime,
      RAI_DATABASE: target,
      RAI_CONTROL_DATABASE: join(rollbackRuntime, "var", "rai-control.sqlite"),
      RAI_API_PORT: String(port),
      RAI_API_HOST: "127.0.0.1",
      RAI_API_TOKEN: "phase2-migration-token",
      RAI_LOG_LEVEL: "silent"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const note = `phase2-rollback-${Date.now()}`;
  const startedAtServer = performance.now();
  let startupMs = null;
  let writeResult = null;
  let readResult = null;
  let error = null;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`rollback API exited ${child.exitCode}: ${output}`);
      try {
        await fetchJson(port, "/v1/health");
        startupMs = performance.now() - startedAtServer;
        break;
      } catch { /* not ready */ }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (startupMs === null) throw new Error(`rollback API did not become ready: ${output}`);
    // 启动后的 import worker 有一个短暂的 scheduled 窗口，会返回 409；
    // 这是“进程正在忙”而不是写入失败，等它空闲后再发真实写入。
    for (let attempt = 0; ; attempt += 1) {
      try {
        writeResult = await fetchJson(port, "/v1/performance-entries", {
          method: "POST",
          body: JSON.stringify({
            localDate: "2026-10-21",
            distance: "five_k",
            durationSeconds: 1500,
            note
          })
        });
        break;
      } catch (caught) {
        if (!/ -> 409:/.test(String(caught)) || attempt >= 50) throw caught;
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
    }
    readResult = await fetchJson(port, "/v1/performance-entries");
    await fetchJson(port, "/v1/workouts?limit=5");
  } catch (caught) {
    error = String(caught?.stack ?? caught);
  } finally {
    child.kill("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  const persisted = (() => {
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM performance_entries WHERE note = ?").get(note);
      const v47 = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='index' AND name='idx_ability_assessments_session'").get();
      return { count: Number(row?.count ?? 0), indexPresent: Boolean(v47) };
    } finally { db.close(); }
  })();
  rollbackServer = {
    ok: error === null && persisted.count === 1 && persisted.indexPresent
      && child.exitCode === 0,
    startupMs,
    writeStatus: writeResult === null ? null : "ok",
    readEntries: readResult?.entries?.length ?? null,
    savedEntryId: writeResult?.id ?? null,
    shutdown: { exitCode: child.exitCode, signal: child.signalCode },
    persisted,
    error,
    outputTail: output.slice(-600)
  };
}

const checksum = (() => {
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    return db.prepare("SELECT checksum FROM schema_migrations WHERE version = 47").get()?.checksum ?? null;
  } finally { db.close(); }
})();
const foreignKeyCheck = (() => {
  const db = new DatabaseSync(target, { readOnly: true });
  try { return db.prepare("PRAGMA foreign_key_check").all().length; } finally { db.close(); }
})();

// 迁移 CLI dry-run：在另一份 v46 副本上运行，不打开写连接、不建备份。
const cliCopy = join(rootReal, "migration-cli-dry-run.sqlite");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(`${cliCopy}${suffix}`)) rmSync(`${cliCopy}${suffix}`);
  if (existsSync(`${sourceReal}${suffix}`)) copyFileSync(`${sourceReal}${suffix}`, `${cliCopy}${suffix}`);
}
const cli = spawnSync(process.execPath, ["--import", "tsx", "packages/storage-sqlite/src/migrate-cli.ts",
  "--database", cliCopy], { cwd: resolve("."), encoding: "utf8" });
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${cliCopy}${suffix}`, { force: true });
const checksumMatches = checksum === FROZEN_MIGRATION_CHECKSUMS[47];
const verdictChecks = {
  checksumMatches,
  foreignKeyViolations: foreignKeyCheck === 0,
  interruptedMigrationRolledBack: interruptedEvidence.indexPresentAfterRollback === false
    && interruptedEvidence.ledgerRowsAfterRollback === 0,
  rollbackRead: rollbackRead?.ok === true,
  rollbackServer: rollbackServer?.ok === true,
  migrationCliDryRun: cli.status === 0
};
const result = {
  generatedAt: new Date().toISOString(),
  source: sourceReal,
  target,
  pendingBefore: pending,
  applyMs,
  before,
  during,
  after,
  checksum,
  frozenChecksum: FROZEN_MIGRATION_CHECKSUMS[47],
  checksumMatches,
  foreignKeyViolations: foreignKeyCheck,
  interruptedEvidence,
  rollbackRead,
  rollbackServer,
  migrationCliDryRun: {
    status: cli.status,
    stdout: cli.stdout.trim(),
    stderr: cli.stderr.trim()
  },
  verdict: { ok: Object.values(verdictChecks).every(Boolean), checks: verdictChecks }
};
if (out) writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.verdict.ok) {
  console.error("phase2-migration-evidence: acceptance checks failed");
  process.exitCode = 1;
}
