// 阶段 4（I1/T11/T12）：跨进程写者互斥与冷备路径闭包的可执行判据。
//
// 这里不重复 dataset-deletion / restore-journal 已经覆盖的故障矩阵；只钉住
// 阶段 4 新引入/复核的边界：
//   1. 控制库有自己的跨进程 publication lock：在线 API 持有它时，
//      `migrate-training-planner --apply` 必须拒绝且不写库；
//   2. API 启动时同样拒绝已被另一个写者持有的控制库锁；
//   3. `deploy/backup-runtime.sh` 的路径闭包检查必须识别外置主库/符号链接，
//      并把五个存储与逐文件摘要写进 manifest v2；
//   4. 同一物理库的符号链接/硬链接别名不能取得第二把 publication lock。

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase, acquireDatabasePublicationLock } from "@rai/storage-sqlite";

import { MobileGoalsStore } from "../src/mobile-goals.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PLANNER = join(REPO_ROOT, "scripts", "migrate-training-planner.mts");
const PATH_CHECKER = join(REPO_ROOT, "scripts", "check-runtime-backup-paths.mjs");
const IDENTITY = { serverId: "local", athleteId: "athlete_1", datasetEpoch: "default" };
const BUSINESS_DATE = "2026-10-20";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A control database with one legacy goals row — the planner's real input shape. */
function createControlFixture(root: string): string {
  const control = join(root, "rai-control.sqlite");
  const seed = new MobileGoalsStore(root, control);
  seed.close();
  const database = new DatabaseSync(control);
  try {
    database.prepare("UPDATE mobile_goals SET revision = 3, payload_json = ?, updated_at = ? WHERE singleton = 1")
      .run(JSON.stringify({
        easyDurationFloorFraction: 0.75,
        qualitySessionCap: 2,
        raceTarget: null,
        weekPlan: [],
        lockedSession: null,
        weekPlanAudit: null,
        weekPlanReplanRequired: false,
        weekPlanPreservedDate: null,
        runCoach: null
      }), "2026-10-20T02:00:00.000Z");
  } finally {
    database.close();
  }
  return control;
}

function plannerArgs(control: string, extra: string[] = []): string[] {
  return [
    "--import", "tsx", PLANNER,
    "--control-db", control,
    "--server-id", IDENTITY.serverId,
    "--athlete-id", IDENTITY.athleteId,
    "--dataset-epoch", IDENTITY.datasetEpoch,
    "--business-date", BUSINESS_DATE,
    ...extra
  ];
}

function runPlanner(control: string, extra: string[] = []) {
  return spawnSync(process.execPath, plannerArgs(control, extra), {
    cwd: REPO_ROOT, encoding: "utf8", timeout: 180_000
  });
}

function sourceDigest(control: string): string {
  const dryRun = runPlanner(control);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  return String((JSON.parse(dryRun.stdout) as { sourceDigest?: unknown }).sourceDigest);
}

function trainingStateRows(control: string): number {
  const database = new DatabaseSync(control, { readOnly: true });
  try {
    const table = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='mobile_training_state'"
    ).get();
    if (!table) return 0;
    return Number((database.prepare("SELECT COUNT(*) AS n FROM mobile_training_state").get() as { n: number }).n);
  } finally {
    database.close();
  }
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** The fixture's business rows, used to prove a refused writer did not touch them. */
function mobileGoalsRows(control: string): unknown[] {
  const database = new DatabaseSync(control, { readOnly: true });
  try {
    return database.prepare(
      "SELECT singleton, revision, payload_json, updated_at FROM mobile_goals ORDER BY singleton"
    ).all();
  } finally {
    database.close();
  }
}

function createSqliteFixture(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE identity_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO identity_fixture (id, value) VALUES (1, 'unchanged')").run();
  } finally {
    database.close();
  }
}

function sqliteFixtureRows(databasePath: string): unknown[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT id, value FROM identity_fixture ORDER BY id").all();
  } finally {
    database.close();
  }
}

async function startServer(root: string, databasePath: string, controlPath: string): Promise<{
  child: ChildProcess; port: number; output: () => string; stop: () => Promise<void>;
}> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: root,
      RAI_DATABASE: databasePath,
      RAI_CONTROL_DATABASE: controlPath,
      RAI_API_PORT: "0",
      RAI_LOG_LEVEL: "silent",
      RAI_API_TOKEN: "",
      RAI_SERVER_ID: IDENTITY.serverId,
      RAI_ATHLETE_ID: IDENTITY.athleteId,
      RAI_DATASET_EPOCH: IDENTITY.datasetEpoch
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const timer = setTimeout(() => rejectPort(new Error(output || "API 没有上报绑定端口")), 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPort(new Error(output || `API 启动即退出（exit ${code}）`));
    });
    child.on("message", (message: unknown) => {
      const value = message as { type?: unknown; port?: unknown };
      if (value?.type === "rai:ready" && Number.isInteger(value.port)) {
        clearTimeout(timer);
        resolvePort(value.port as number);
      }
    });
  });
  return {
    child, port, output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((done) => child.once("close", () => done()));
      child.kill("SIGTERM");
      await Promise.race([closed, new Promise((done) => setTimeout(done, 10_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  };
}

test("控制库锁：另一个进程持有时 planner --apply 拒绝且不写状态", () => {
  const root = tempRoot("rai-phase4-control-lock-");
  try {
    const control = createControlFixture(root);
    const digest = sourceDigest(control);
    const release = acquireDatabasePublicationLock(control, "api");
    try {
      const refused = runPlanner(control, ["--apply", "--expect-source-digest", digest]);
      assert.equal(refused.status, 1, refused.stdout);
      const payload = JSON.parse(refused.stdout) as { error?: { code?: string } };
      assert.equal(payload.error?.code, "control_database_locked");
      assert.equal(trainingStateRows(control), 0, "a refused apply must not create or write mobile_training_state");
    } finally {
      release();
    }
    const applied = runPlanner(control, ["--apply", "--expect-source-digest", digest]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(trainingStateRows(control), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("控制库锁：API 启动拒绝已被持有的控制库，并让在线期间 CLI apply 无法交叉", async () => {
  const root = tempRoot("rai-phase4-api-control-lock-");
  const control = createControlFixture(root);
  const databasePath = join(root, "var/rai.sqlite");
  mkdirSync(join(root, "var"), { recursive: true });
  const digest = sourceDigest(control);
  const held = acquireDatabasePublicationLock(control, "cli");
  try {
    const blocked = spawnSync(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env, RAI_RUNTIME_ROOT: root, RAI_DATABASE: databasePath, RAI_CONTROL_DATABASE: control,
        RAI_API_PORT: "0", RAI_LOG_LEVEL: "silent", RAI_API_TOKEN: ""
      },
      encoding: "utf8", timeout: 60_000
    });
    assert.notEqual(blocked.status, 0);
    assert.match(`${blocked.stdout}${blocked.stderr}`, /Another cli process is using/);
  } finally {
    held();
  }
  const server = await startServer(root, databasePath, control);
  try {
    const refused = runPlanner(control, ["--apply", "--expect-source-digest", digest]);
    assert.equal(refused.status, 1);
    assert.equal((JSON.parse(refused.stdout) as { error?: { code?: string } }).error?.code, "control_database_locked");
  } finally {
    await server.stop();
  }
  const applied = runPlanner(control, ["--apply", "--expect-source-digest", digest]);
  assert.equal(applied.status, 0, applied.stderr);
});

test("主库锁：data:migrate --apply 在 API 锁被持有时非零退出且不执行迁移", async () => {
  const root = tempRoot("rai-phase4-main-lock-");
  try {
    const databasePath = join(root, "var/rai.sqlite");
    mkdirSync(join(root, "var"), { recursive: true });
    const store = await RaiDatabase.open(databasePath);
    store.close();
    const release = acquireDatabasePublicationLock(databasePath, "api");
    try {
      const refused = spawnSync(process.execPath, [
        "--import", "tsx", "packages/storage-sqlite/src/migrate-cli.ts",
        "--database", databasePath, "--apply", "--no-backup"
      ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
      assert.equal(refused.status, 1, refused.stdout);
      assert.match(refused.stderr, /Another api process is using/);
    } finally {
      release();
    }
    const applied = spawnSync(process.execPath, [
      "--import", "tsx", "packages/storage-sqlite/src/migrate-cli.ts",
      "--database", databasePath, "--apply", "--no-backup"
    ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
    assert.equal(applied.status, 0, applied.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("主库锁：data:prune-tombstones 在 API 锁被持有时拒绝且不删除行", async () => {
  const root = tempRoot("rai-phase4-prune-lock-");
  try {
    const databasePath = join(root, "var/rai.sqlite");
    mkdirSync(join(root, "var"), { recursive: true });
    const store = await RaiDatabase.open(databasePath);
    store.close();
    const hashBefore = fileSha256(databasePath);
    const release = acquireDatabasePublicationLock(databasePath, "api");
    try {
      const refused = spawnSync(process.execPath, [
        "--import", "tsx", "packages/health-export-parser/src/prune-tombstones-cli.ts",
        "--database", databasePath, "--older-than-days", "1"
      ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
      assert.equal(refused.status, 1, refused.stdout);
      assert.match(refused.stderr, /Another api process is using/);
      assert.equal(fileSha256(databasePath), hashBefore);
    } finally {
      release();
    }
    const applied = spawnSync(process.execPath, [
      "--import", "tsx", "packages/health-export-parser/src/prune-tombstones-cli.ts",
      "--database", databasePath, "--older-than-days", "1"
    ], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
    assert.equal(applied.status, 0, applied.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("可写 CLI 审计：每个能写权威库的入口都取 publication lock", () => {
  const writable = [
    "packages/storage-sqlite/src/migrate-cli.ts",
    "packages/health-export-parser/src/cli.ts",
    "packages/health-export-parser/src/prune-tombstones-cli.ts",
    "packages/application/src/cli.ts",
    "apps/api/src/import-scope-cli.ts",
    "scripts/migrate-training-planner.mts",
    "scripts/backfill-canonical-nights.mts"
  ];
  for (const path of writable) {
    const text = readFileSync(join(REPO_ROOT, path), "utf8");
    assert.match(text, /acquireDatabasePublicationLock/, `${path} writes an authoritative store without a publication lock`);
  }
  // 报告型 CLI 保持只读：它们不是“漏加锁”，而是没有写路径。
  for (const path of [
    "packages/application/src/analyze-cli.ts",
    "packages/application/src/prediction-cli.ts",
    "packages/application/src/prediction-eval-cli.ts"
  ]) {
    const text = readFileSync(join(REPO_ROOT, path), "utf8");
    assert.match(text, /RaiDatabase\.openReadonly/, `${path} must stay a read-only report CLI`);
  }
});

test("冷备路径闭包：显式路径必需、manifest v2、外置拒绝、缺库拒绝、Token 不回显", () => {
  const root = tempRoot("rai-phase4-path-closure-");
  try {
    const runtime = join(root, "runtime");
    mkdirSync(join(runtime, "var"), { recursive: true });
    for (const name of ["rai.sqlite", "rai-control.sqlite", "runtime.sqlite"]) {
      writeFileSync(join(runtime, "var", name), `fixture ${name}`);
    }
    const main = join(runtime, "var/rai.sqlite");
    const control = join(runtime, "var/rai-control.sqlite");
    const check = (args: string[]) => spawnSync(process.execPath, [
      PATH_CHECKER, "--runtime-root", runtime, "--database", main, "--control-database", control, ...args
    ], { cwd: REPO_ROOT, encoding: "utf8" });

    // R3：没有显式路径时不再按 <runtime>/var/rai.sqlite 推断。
    const implicit = spawnSync(process.execPath, [PATH_CHECKER, "--runtime-root", runtime, "--json"], {
      cwd: REPO_ROOT, encoding: "utf8"
    });
    assert.equal(implicit.status, 2);
    const implicitManifest = JSON.parse(implicit.stdout) as { closure: string; problems: string[] };
    assert.equal(implicitManifest.closure, "incomplete");
    assert.ok(implicitManifest.problems.some((problem) => /RAI_DATABASE is not explicitly configured/.test(problem)));

    const ok = check(["--json"]);
    assert.equal(ok.status, 0, ok.stderr);
    const manifest = JSON.parse(ok.stdout) as {
      format: string; closure: string;
      stores: Record<string, { status: string; sha256?: string }>;
      inventory: { digestsIncluded: boolean; fileCount: number; entries: Array<{ path: string; type: string; sha256: string | null }> };
    };
    assert.equal(manifest.format, "rai-runtime-path-manifest-v2");
    assert.equal(manifest.closure, "complete");
    assert.equal(manifest.inventory.digestsIncluded, true);
    for (const name of ["main", "control", "epochSidecar", "restoreJournal", "runtime"]) {
      assert.ok(`${manifest.stores[name]?.status}`.match(/^(present|absent)$/), `${name} not classified`);
    }
    assert.equal(manifest.stores.epochSidecar?.status, "absent");
    assert.match(manifest.stores.main?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok(manifest.inventory.entries.some((entry) =>
      entry.path === "var/rai.sqlite" && entry.type === "file" && /^[a-f0-9]{64}$/.test(entry.sha256 ?? "")));

    writeFileSync(join(runtime, "var/rai.sqlite-wal"), "wal-frames");
    const walManifest = JSON.parse(check(["--json"]).stdout) as {
      stores: Record<string, { walPresent?: boolean; walBytes?: number | null }>;
      inventory: { entries: Array<{ path: string }> };
    };
    assert.equal(walManifest.stores.main?.walPresent, true);
    assert.equal(walManifest.stores.main?.walBytes, "wal-frames".length);
    assert.ok(walManifest.inventory.entries.some((entry) => entry.path === "var/rai.sqlite-wal"));
    rmSync(join(runtime, "var/rai.sqlite-wal"));

    const externalDir = join(root, "outside");
    mkdirSync(externalDir, { recursive: true });
    writeFileSync(join(externalDir, "rai.sqlite"), "outside");
    const external = spawnSync(process.execPath, [
      PATH_CHECKER, "--runtime-root", runtime, "--database", join(externalDir, "rai.sqlite"),
      "--control-database", control, "--json"
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(external.status, 2);
    assert.match(external.stdout, /outside the runtime root/);

    rmSync(main);
    const missing = check(["--json"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stdout, /is missing/);

    const envFile = join(root, "rai.env");
    writeFileSync(envFile, [
      `RAI_RUNTIME_ROOT=${runtime}`,
      `RAI_DATABASE=${main}`,
      `RAI_CONTROL_DATABASE=${control}`,
      "RAI_API_TOKEN=super-secret-token"
    ].join("\n"));
    writeFileSync(main, "restored fixture");
    const withEnv = spawnSync(process.execPath, [
      PATH_CHECKER, "--runtime-root", runtime, "--deployment-env", envFile, "--json"
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(withEnv.status, 0, withEnv.stderr);
    assert.doesNotMatch(withEnv.stdout, /super-secret-token/);
    assert.doesNotMatch(withEnv.stderr, /super-secret-token/);

    const noRuntimeEnv = join(root, "no-runtime.env");
    writeFileSync(noRuntimeEnv, [
      `RAI_DATABASE=${main}`,
      `RAI_CONTROL_DATABASE=${control}`
    ].join("\n"));
    const noRuntime = spawnSync(process.execPath, [
      PATH_CHECKER, "--runtime-root", runtime, "--deployment-env", noRuntimeEnv, "--json"
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(noRuntime.status, 2);
    assert.match(noRuntime.stdout, /RAI_RUNTIME_ROOT is not explicitly configured/);

    const exportEnv = join(root, "export.env");
    writeFileSync(exportEnv, [
      `export RAI_DATABASE=${main}`,
      `export RAI_CONTROL_DATABASE=${control}`,
      `RAI_RUNTIME_ROOT=${runtime}`
    ].join("\n"));
    const exported = spawnSync(process.execPath, [
      PATH_CHECKER, "--runtime-root", runtime, "--deployment-env", exportEnv, "--json"
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(exported.status, 2);
    assert.match(exported.stderr, /export is not systemd syntax/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("冷备路径闭包：权威树内外部/悬空/根内符号链接一律拒绝备份", (context) => {
  if (process.platform === "win32") {
    context.skip("creating symbolic links needs privileges on this Windows host");
    return;
  }
  const root = tempRoot("rai-phase4-path-links-");
  try {
    const runtime = join(root, "runtime");
    mkdirSync(join(runtime, "var/imports/job"), { recursive: true });
    for (const name of ["rai.sqlite", "rai-control.sqlite", "runtime.sqlite"]) {
      writeFileSync(join(runtime, "var", name), `fixture ${name}`);
    }
    const main = join(runtime, "var/rai.sqlite");
    const control = join(runtime, "var/rai-control.sqlite");
    writeFileSync(join(root, "outside.zip"), "outside");
    writeFileSync(join(runtime, "var/imports/job/real.zip"), "real");

    const cases: Array<[string, string, string]> = [
      ["external", join(root, "outside.zip"), "var/imports/job/source.zip"],
      ["dangling", join(runtime, "var/imports/job/missing.zip"), "var/imports/job/source.zip"],
      ["root-internal", join(runtime, "var/imports/job/real.zip"), "var/imports/job/source.zip"]
    ];
    for (const [name, target, linkPath] of cases) {
      const link = join(runtime, linkPath);
      symlinkSync(target, link);
      const result = spawnSync(process.execPath, [
        PATH_CHECKER, "--runtime-root", runtime, "--database", main, "--control-database", control, "--json"
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      assert.equal(result.status, 2, `${name} link must refuse the backup`);
      const manifest = JSON.parse(result.stdout) as { closure: string; problems: string[] };
      assert.equal(manifest.closure, "incomplete");
      assert.ok(manifest.problems.some((problem) =>
        problem.includes(linkPath) && /symbolic link/.test(problem)),
      `${name} link must be named in a symbolic-link problem: ${manifest.problems.join("; ")}`);
      rmSync(link);
    }

    // 库文件本身是链接同样拒绝（tar 会存链接而不是库内容）。
    const dbLink = join(root, "db-link.sqlite");
    writeFileSync(join(root, "db-target.sqlite"), "outside database");
    symlinkSync(join(root, "db-target.sqlite"), dbLink);
    const linkedDatabase = spawnSync(process.execPath, [
      PATH_CHECKER, "--runtime-root", runtime, "--database", dbLink,
      "--control-database", control, "--json"
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(linkedDatabase.status, 2);
    assert.match(linkedDatabase.stdout, /symbolic link/);

    // 数据库路径穿过一个指向 runtime 根的链接：lexical resolve 会把它洗成
    // var/rai.sqlite 并误报 complete；按 native 语义必须在取 store 前拒绝。
    const rootAlias = join(runtime, "root-alias");
    symlinkSync(runtime, rootAlias);
    const aliasedDatabase = spawnSync(process.execPath, [
      PATH_CHECKER, "--runtime-root", runtime,
      "--database", join(rootAlias, "var/rai.sqlite"),
      "--control-database", control, "--json"
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(aliasedDatabase.status, 2);
    assert.match(aliasedDatabase.stdout, /symbolic link/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 阶段 4（R1）：API 与 CLI 必须按同一物理身份互斥。以下用例的拒绝都发生在
// 打开写连接之前，因此同时断言 owner、SQLite 业务行和文件 SHA-256 未变化。

test("控制库锁：planner --apply 通过符号链接别名仍被拒绝，owner/行/哈希不变，释放后别名可重试", (context) => {
  if (process.platform === "win32") {
    context.skip("creating symbolic links needs privileges on this Windows host");
    return;
  }
  const root = tempRoot("rai-phase4-control-lock-alias-");
  try {
    const control = createControlFixture(root);
    const alias = join(root, "control-alias.sqlite");
    symlinkSync(control, alias);
    const digest = sourceDigest(control);
    const lockPath = `${realpathSync(control)}.import.lock`;
    const hashBefore = fileSha256(control);
    const rowsBefore = mobileGoalsRows(control);

    const release = acquireDatabasePublicationLock(control, "api");
    try {
      const ownerBefore = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
      const refused = runPlanner(alias, ["--apply", "--expect-source-digest", digest]);
      assert.equal(refused.status, 1, refused.stdout);
      assert.equal((JSON.parse(refused.stdout) as { error?: { code?: string } }).error?.code, "control_database_locked");
      assert.match(refused.stderr, /Another api process is using/);
      assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), ownerBefore,
        "the refused alias must not replace the lock owner");
      assert.equal(fileSha256(control), hashBefore, "the refused alias must not change the control database file");
      assert.deepEqual(mobileGoalsRows(control), rowsBefore, "the refused alias must not change business rows");
      assert.equal(trainingStateRows(control), 0, "a refused apply must not create or write mobile_training_state");
    } finally {
      release();
    }
    assert.equal(existsSync(lockPath), false);

    const applied = runPlanner(alias, ["--apply", "--expect-source-digest", digest]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(trainingStateRows(control), 1);
    assert.equal(existsSync(lockPath), false, "planner must release the control lock after a successful apply");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("主库/控制库同物理文件：API 启动非零退出并点名冲突", (context) => {
  if (process.platform === "win32") {
    context.skip("creating symbolic links needs privileges on this Windows host");
    return;
  }
  const root = tempRoot("rai-phase4-same-physical-db-");
  try {
    const databasePath = join(root, "main.sqlite");
    createSqliteFixture(databasePath);
    const controlAlias = join(root, "control-alias.sqlite");
    symlinkSync(databasePath, controlAlias);
    const hashBefore = fileSha256(databasePath);
    const rowsBefore = sqliteFixtureRows(databasePath);

    const blocked = spawnSync(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RAI_RUNTIME_ROOT: root,
        RAI_DATABASE: databasePath,
        RAI_CONTROL_DATABASE: controlAlias,
        RAI_API_PORT: "0",
        RAI_LOG_LEVEL: "silent",
        RAI_API_TOKEN: ""
      },
      encoding: "utf8",
      timeout: 60_000
    });
    assert.notEqual(blocked.status, 0, "API startup must refuse main and control resolving to one file");
    const output = `${blocked.stdout}${blocked.stderr}`;
    assert.match(output, /same physical database file/);
    assert.ok(output.includes(databasePath), "the conflict message must name the configured main path");
    assert.ok(output.includes(controlAlias), "the conflict message must name the configured control path");
    assert.equal(fileSha256(databasePath), hashBefore);
    assert.deepEqual(sqliteFixtureRows(databasePath), rowsBefore);
    assert.equal(existsSync(`${realpathSync(databasePath)}.import.lock`), false,
      "a same-file startup refusal must not leave a publication lock behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("主库/控制库身份不可解析：API 启动失败关闭且不触碰数据库", (context) => {
  if (process.platform === "win32") {
    context.skip("creating symbolic links needs privileges on this Windows host");
    return;
  }
  const root = tempRoot("rai-phase4-unresolvable-control-");
  try {
    const databasePath = join(root, "main.sqlite");
    createSqliteFixture(databasePath);
    const danglingControl = join(root, "dangling-control.sqlite");
    symlinkSync("missing-control.sqlite", danglingControl);
    const hashBefore = fileSha256(databasePath);
    const rowsBefore = sqliteFixtureRows(databasePath);

    const blocked = spawnSync(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RAI_RUNTIME_ROOT: root,
        RAI_DATABASE: databasePath,
        RAI_CONTROL_DATABASE: danglingControl,
        RAI_API_PORT: "0",
        RAI_LOG_LEVEL: "silent",
        RAI_API_TOKEN: ""
      },
      encoding: "utf8",
      timeout: 60_000
    });
    assert.notEqual(blocked.status, 0, "API startup must fail closed when an identity cannot be resolved");
    const output = `${blocked.stdout}${blocked.stderr}`;
    assert.match(output, /Refusing to start/);
    assert.match(output, /dangling symbolic link/);
    assert.equal(fileSha256(databasePath), hashBefore);
    assert.deepEqual(sqliteFixtureRows(databasePath), rowsBefore);
    assert.equal(existsSync(`${realpathSync(databasePath)}.import.lock`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
