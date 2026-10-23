// P2 复审（2026-10-22）：删库操作日志 / 启动裁决 / CLI 恢复的真实故障注入验收。
//
// 每个用例都使用**真实 API 子进程**、真实 `DatabaseMaintenance`、真实
// dataset-epoch 侧车、runtime.sqlite 与主库文件；故障点是代码里的确定性屏障
// (`RAI_FAULT_POINT=...:sigkill`)，不是测试计时窗口。强杀后**原目录重启**，
// 测试不手工修补任何状态（只有明确标注的“运维确认/恢复”入口会通过 CLI 执行）。
//
// 覆盖 review §1.3 的九类输入：
//   1. 首次安装；2. prepared 前/后主库仍在；3. prepared + 主库缺失；
//   4. main_removed + 未写许可；5. permit_issued + 响应前强杀；
//   6. writer_entered 后主库消失 + runtime 账本损坏；
//   7. 侧车损坏/配置不匹配/快照缺失/账本实例不符/写失败；
//   8. 保护快照回滚/恢复旧库。

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import { RaiDatabase } from "@rai/storage-sqlite";
import { CONTRACT_VERSION } from "@rai/contracts";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";

import { readDatasetEpoch, readDatasetEpochState, writeDatasetEpoch } from "../src/dataset-epoch.js";
import { ImportPublicationJournal } from "../src/import-publication.js";
import { DatabaseMaintenance } from "../src/maintenance.js";
import { RestoreJournal } from "../src/restore-journal.js";
import { RuntimeStateStore } from "../src/runtime-state.js";

const projectRoot = resolve(import.meta.dirname, "../../..");
const READY_TIMEOUT_MS = 60_000;

interface ServerHandle {
  child: ChildProcess;
  port: number;
  output: () => string;
  stop: () => Promise<void>;
}

interface Harness {
  root: string;
  databasePath: string;
  runtimePath: string;
  sidecarPath: string;
  start: (env?: Record<string, string>) => Promise<ServerHandle>;
  remove: () => void;
}

function createHarness(prefix: string): Harness {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(root, "var/rai.sqlite");
  mkdirSync(join(root, "var"), { recursive: true });
  return {
    root,
    databasePath,
    runtimePath: join(root, "var/runtime.sqlite"),
    sidecarPath: `${databasePath}.dataset-epoch.sqlite`,
    start: (env = {}) => startServer(root, databasePath, env),
    remove: () => rmSync(root, { recursive: true, force: true })
  };
}

async function startServer(root: string, databasePath: string, env: Record<string, string>): Promise<ServerHandle> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/server.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      RAI_RUNTIME_ROOT: root,
      RAI_DATABASE: databasePath,
      RAI_API_PORT: "0",
      RAI_LOG_LEVEL: "silent",
      RAI_API_TOKEN: "",
      RAI_SERVER_ID: "local",
      RAI_ATHLETE_ID: "athlete_1",
      RAI_DATASET_EPOCH: "default",
      // P3: fault injection fires only with BOTH the explicit switch and a
      // test-environment marker.
      RAI_FAULT_INJECTION: "1",
      RAI_FAULT_TEST_ENV: "1",
      ...env
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const timer = setTimeout(() => rejectPort(new Error(output || "API 没有上报绑定端口")), READY_TIMEOUT_MS);
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
    child,
    port,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
      child.kill("SIGTERM");
      await Promise.race([closed, delay(10_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Wait for the child to die from the injected SIGKILL (not merely for kill() to return). */
async function waitForHardKill(handle: ServerHandle): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (handle.child.exitCode === null && handle.child.signalCode === null) {
    assert.ok(Date.now() < deadline, `子进程没有在 30s 内被强杀：${handle.output()}`);
    await delay(20);
  }
  assert.equal(handle.child.signalCode, "SIGKILL",
    `故障点必须产生 SIGKILL，而不是正常退出：exit=${handle.child.exitCode} signal=${handle.child.signalCode}`);
}

async function deleteDatabase(handle: ServerHandle): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${handle.port}/v1/database`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "删除我的 RAI 数据" }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    // A crash barrier kills the process before it can answer; the persisted state is
    // the evidence, not the HTTP response.
    return null;
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface SidecarState {
  epoch: { configuredEpoch: string; epoch: string } | null;
  deletion: Record<string, unknown> | null;
}

function readSidecar(harness: Harness): SidecarState {
  if (!existsSync(harness.sidecarPath)) return { epoch: null, deletion: null };
  const db = new DatabaseSync(harness.sidecarPath, { readOnly: true });
  try {
    const epochRow = db.prepare("SELECT payload FROM dataset_epoch WHERE id=1").get() as
      { payload: string } | undefined;
    const deletionTable = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='dataset_deletion'"
    ).get() as { present: number } | undefined;
    const deletionRow = deletionTable
      ? db.prepare("SELECT payload FROM dataset_deletion WHERE id=1").get() as { payload: string } | undefined
      : undefined;
    return {
      epoch: epochRow ? JSON.parse(epochRow.payload) as { configuredEpoch: string; epoch: string } : null,
      deletion: deletionRow ? JSON.parse(deletionRow.payload) as Record<string, unknown> : null
    };
  } finally { db.close(); }
}

function readEvidence(harness: Harness, scope: string): Record<string, unknown> | null {
  if (!existsSync(harness.runtimePath)) return null;
  const db = new DatabaseSync(harness.runtimePath, { readOnly: true });
  try {
    const table = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='import_scope_evidence'"
    ).get() as { present: number } | undefined;
    if (!table) return null;
    return (db.prepare(`SELECT scope, state, first_empty_epoch AS firstEmptyEpoch,
      pristine_at AS pristineAt, permit_source AS permitSource, permit_revoked_at AS permitRevokedAt,
      writer_entered_at AS writerEnteredAt, dataset_established_at AS datasetEstablishedAt
      FROM import_scope_evidence WHERE scope = ?`).get(scope) as Record<string, unknown> | undefined) ?? null;
  } finally { db.close(); }
}

function allEvidence(harness: Harness): Array<Record<string, unknown>> {
  if (!existsSync(harness.runtimePath)) return [];
  const db = new DatabaseSync(harness.runtimePath, { readOnly: true });
  try {
    const table = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='import_scope_evidence'"
    ).get() as { present: number } | undefined;
    if (!table) return [];
    return db.prepare(`SELECT scope, state, permit_source AS permitSource,
      permit_revoked_at AS permitRevokedAt, writer_entered_at AS writerEnteredAt
      FROM import_scope_evidence ORDER BY scope`).all() as Array<Record<string, unknown>>;
  } finally { db.close(); }
}

function scopeOf(epoch: string): string {
  return JSON.stringify(["local", "athlete_1", epoch]);
}

function runCli(harness: Harness, args: string[], env: Record<string, string> = {}): {
  status: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null;
} {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "apps/api/src/import-scope-cli.ts", ...args],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        RAI_RUNTIME_ROOT: harness.root,
        RAI_DATABASE: harness.databasePath,
        RAI_SERVER_ID: "local",
        RAI_ATHLETE_ID: "athlete_1",
        RAI_DATASET_EPOCH: "default",
        ...env
      },
      encoding: "utf8",
      timeout: 60_000
    }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, signal: result.signal ?? null };
}

// ---------------------------------------------------------------------------
// 真 HTTP 首包：复用 direct-sync 的 upload → inspect → job 流程。
// ---------------------------------------------------------------------------

const u16 = (value: number): Buffer => { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; };
const u32 = (value: number): Buffer => { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; };

function storedZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const nameData = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data);
    const compressed = deflateRawSync(entry.data);
    const useDeflate = compressed.length > 0 && compressed.length < entry.data.length;
    const stored = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(checksum), u32(stored.length), u32(entry.data.length), u16(nameData.length), u16(0), nameData, stored
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(checksum), u32(stored.length), u32(entry.data.length), u16(nameData.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(localOffset), nameData
    ]);
    locals.push(local);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]), u16(0), u16(0),
    u16(entries.length), u16(entries.length), u32(centralBytes.length), u32(localOffset), u16(0)
  ]);
  return Buffer.concat([...locals, centralBytes, end]);
}

const FIRST_PACKET_XML = `<HealthData>
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="10"
    startDate="2026-02-21 00:00:00 +0800" endDate="2026-02-21 00:01:00 +0800">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="00000000-0000-4000-8000-000000000001"/>
  </Record>
</HealthData>`;

function firstPacketZip(): Buffer {
  return storedZip([
    { name: "export.xml", data: Buffer.from(FIRST_PACKET_XML, "utf8") },
    { name: "sync-manifest.json", data: Buffer.from(JSON.stringify({
      version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
    }), "utf8") }
  ]);
}

async function importFirstPacket(handle: ServerHandle, batchId: string): Promise<void> {
  const base = `http://127.0.0.1:${handle.port}`;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(firstPacketZip())], { type: "application/zip" }),
    "apple-health-healthkit.zip");
  let response = await fetch(`${base}/v1/imports/uploads`, {
    method: "POST", headers: { "x-rai-sync-batch": batchId }, body: form
  });
  let text = await response.text();
  assert.equal(response.status, 200, text);
  const upload = JSON.parse(text) as { sourceId: string };
  response = await fetch(`${base}/v1/imports/inspect`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: upload.sourceId })
  });
  text = await response.text();
  assert.equal(response.status, 200, text);
  response = await fetch(`${base}/v1/import-jobs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: upload.sourceId })
  });
  text = await response.text();
  assert.equal(response.status, 202, text);
  const job = JSON.parse(text) as { id: string };
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(`${base}/v1/import-jobs/${job.id}`);
    const statusText = await statusResponse.text();
    assert.equal(statusResponse.status, 200, statusText);
    const status = JSON.parse(statusText) as { status: string; phase: string; message: string };
    if (status.status === "succeeded") return;
    if (["failed", "cancelled"].includes(status.status)) {
      assert.fail(`首包导入失败：${JSON.stringify(status)}`);
    }
    await delay(100);
  }
  assert.fail("首包导入在 120s 内没有终态");
}

/** Upload + inspect + create the job, returning its id without waiting for a terminal state. */
async function startFirstPacketJob(handle: ServerHandle, batchId: string): Promise<string> {
  const base = `http://127.0.0.1:${handle.port}`;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(firstPacketZip())], { type: "application/zip" }),
    "apple-health-healthkit.zip");
  let response = await fetch(`${base}/v1/imports/uploads`, {
    method: "POST", headers: { "x-rai-sync-batch": batchId }, body: form
  });
  let text = await response.text();
  assert.equal(response.status, 200, text);
  const upload = JSON.parse(text) as { sourceId: string };
  response = await fetch(`${base}/v1/imports/inspect`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: upload.sourceId })
  });
  text = await response.text();
  assert.equal(response.status, 200, text);
  response = await fetch(`${base}/v1/import-jobs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: upload.sourceId })
  });
  text = await response.text();
  assert.equal(response.status, 202, text);
  return (JSON.parse(text) as { id: string }).id;
}

/**
 * POST a backup restore, retrying the transient 409 "a task is running" window
 * that the startup schedule can briefly produce. Any other status is returned
 * immediately for the test to assert.
 */
async function requestRestore(handle: ServerHandle, name: string): Promise<Response> {
  const url = `http://127.0.0.1:${handle.port}/v1/backups/${encodeURIComponent(name)}/restore`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "恢复此备份" })
    });
    if (response.status !== 409 || Date.now() > deadline) return response;
    await delay(250);
  }
}

async function seedDatabaseAsync(harness: Harness, marker = "fixture"): Promise<void> {
  const store = await RaiDatabase.open(harness.databasePath);
  try {
    writeDatasetEpoch(store.database, "default", "default");
    store.setManifest("dataset_version", marker);
    store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
    // A restored dataset that can accept a new direct-sync packet needs the
    // same identity stamps a real import would have left behind.
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  } finally { store.close(); }
}

/** Pre-change database: a normal RAI schema, but no `rai.dataset-epoch` row. */
async function seedLegacyEpochlessDatabaseAsync(harness: Harness, marker = "legacy"): Promise<void> {
  const store = await RaiDatabase.open(harness.databasePath);
  try {
    store.setManifest("dataset_version", marker);
    store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  } finally { store.close(); }
}

test("P2-1 首次安装：显式初始化写当前生效 scope 的唯一许可；首包一次；第二次初始化拒绝", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-fresh-");
  try {
    const first = runCli(harness, ["--apply", "--fresh-install"]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const initialized = JSON.parse(first.stdout) as { persistedEpoch: string; scope: string; permitSource: string };
    assert.equal(initialized.persistedEpoch, "default");
    assert.equal(initialized.scope, scopeOf("default"));
    assert.equal(initialized.permitSource, "operator_first_install");

    const second = runCli(harness, ["--apply", "--fresh-install"]);
    assert.notEqual(second.status, 0, "已有许可时第二次初始化必须拒绝");
    assert.match(second.stderr, /already has persistent evidence|refusing/i);
    assert.equal(existsSync(harness.databasePath), false, "初始化 CLI 不得创建主库");

    const handle = await harness.start();
    try {
      await importFirstPacket(handle, "fresh-first");
      assert.equal(existsSync(harness.databasePath), true, "持有许可的首包必须创建主库一次");
      const evidence = readEvidence(harness, scopeOf("default"));
      assert.equal(evidence?.state, "established");
      assert.notEqual(evidence?.permitRevokedAt, null, "写者进入后许可必须永久失效");
      const third = runCli(harness, ["--apply", "--fresh-install"]);
      assert.notEqual(third.status, 0, "主库已存在时不得再写首空许可");
    } finally { await handle.stop(); }
  } finally { harness.remove(); }
});

test("P1-1b 存量无 epoch 主库：启动回填 configured epoch", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-legacy-epoch-backfill-");
  try {
    await seedLegacyEpochlessDatabaseAsync(harness, "legacy-dataset");
    const server = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, true, server.output());
      const main = new DatabaseSync(harness.databasePath, { readOnly: true });
      try {
        const row = main.prepare("SELECT value FROM import_manifest WHERE key='rai.dataset-epoch'").get() as
          { value: string } | undefined;
        assert.ok(row, "startup must persist the effective epoch into the main database");
        assert.deepEqual(JSON.parse(row.value), { configuredEpoch: "default", epoch: "default" });
      } finally { main.close(); }
    } finally { await server.stop(); }
  } finally { harness.remove(); }
});

test("P2-2 prepared 前/后强杀且主库仍在：旧库字节不变、无新许可、重启回滚旧 epoch", { timeout: 180_000 }, async () => {
  for (const fault of ["deletion:before-prepared", "deletion:after-prepared"]) {
    const harness = createHarness(`rai-p2-${fault.replaceAll(":", "-")}-`);
    const marker = join(harness.root, "fault.marker");
    try {
      await seedDatabaseAsync(harness, "old-dataset");
      const beforeHash = hashFile(harness.databasePath);
      const handle = await harness.start({
        RAI_FAULT_POINT: `${fault}:sigkill`, RAI_FAULT_MARKER: marker
      });
      const response = await deleteDatabase(handle);
      await waitForHardKill(handle);
      assert.ok(existsSync(marker), `故障屏障未触发：${fault}`);
      assert.equal(existsSync(harness.databasePath), true, `${fault}：主库必须仍在`);
      assert.equal(hashFile(harness.databasePath), beforeHash, `${fault}：主库字节不得改变`);
      const side = readSidecar(harness);
      if (fault === "deletion:before-prepared") {
        assert.equal(side.deletion, null, "prepared 之前不得留下删库记录");
      } else {
        assert.equal(side.deletion?.stage, "prepared");
        assert.equal(readEvidence(harness, scopeOf(String(side.deletion?.nextEpoch))), null,
          "prepared 阶段不得签发新 scope 许可");
      }
      void response;

      const restarted = await harness.start();
      try {
        const sideAfter = readSidecar(harness);
        assert.ok(sideAfter.deletion === null || sideAfter.deletion.stage === "rolled_back",
          `启动必须收口未完成删除：${JSON.stringify(sideAfter.deletion)}`);
        assert.equal(readDatasetEpoch(harness.databasePath, "default"), "default");
        assert.equal(hashFile(harness.databasePath), beforeHash, "启动恢复不得改主库");
        const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
          datasetEpoch: string; databaseReady: boolean;
        };
        assert.equal(health.datasetEpoch, "default");
        assert.equal(health.databaseReady, true);
      } finally { await restarted.stop(); }
    } finally { harness.remove(); }
  }
});

test("P2-2b 删除中途普通异常：maintenance 从保护快照回滚，旧 scope 恢复 established，删库意图收口", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-snapshot-rollback-");
  let handle: ServerHandle | undefined;
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    handle = await harness.start({ RAI_FAULT_POINT: "deletion:after-main-unlinked:throw" });
    const response = await deleteDatabase(handle);
    // 普通异常不是 SIGKILL：服务端应返回错误，并从 before-delete 快照恢复。
    assert.ok(response, "普通异常必须能返回响应（不是进程崩溃）");
    assert.notEqual(response!.status, 200, "删除失败必须明确报错");
    await delay(300);
    assert.equal(existsSync(harness.databasePath), true, "保护快照必须把主库恢复回来");
    const restored = new DatabaseSync(harness.databasePath, { readOnly: true });
    try {
      assert.equal(restored.prepare("SELECT value FROM import_manifest WHERE key='dataset_version'").get()
        ?.value, "old-dataset", "恢复后的主库必须保留旧数据集事实");
    } finally { restored.close(); }
    const side = readSidecar(harness);
    assert.equal(side.deletion?.stage, "rolled_back", "删除意图必须收口");
    assert.equal(readDatasetEpoch(harness.databasePath, "default"), "default");
    assert.equal(readEvidence(harness, scopeOf("default"))?.state, "established");
    const nextEpoch = String(side.deletion?.nextEpoch);
    assert.equal(readEvidence(harness, scopeOf(nextEpoch))?.state ?? "unknown", "unknown",
      "回滚后未消费的 nextEpoch 许可不得存在");
    await handle.stop();
    handle = undefined;
    const restarted = await harness.start();
    handle = restarted;
    try {
      const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
        datasetEpoch: string; databaseReady: boolean;
      };
      assert.equal(health.datasetEpoch, "default");
      assert.equal(health.databaseReady, true);
      assert.equal(readSidecar(harness).deletion?.stage, "rolled_back");
    } finally {
      await restarted.stop();
      handle = undefined;
    }
  } finally {
    await handle?.stop().catch(() => {});
    harness.remove();
  }
});

test("P2-3 prepared 已写、主库已删：启动阻断不建库；运维确认后只发一张 nextEpoch 许可并可首包", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p2-prepared-missing-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const handle = await harness.start({ RAI_FAULT_POINT: "deletion:after-main-unlinked:sigkill" });
    await deleteDatabase(handle);
    await waitForHardKill(handle);
    assert.equal(existsSync(harness.databasePath), false);
    const side = readSidecar(harness);
    assert.equal(side.deletion?.stage, "prepared", "unlink 后、main_removed 前必须仍是 prepared");
    const deletionId = String(side.deletion?.deletionId);
    const nextEpoch = String(side.deletion?.nextEpoch);

    const blockedServer = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${blockedServer.port}/v1/health`)).json() as {
        status: string; databaseReady: boolean; datasetEpoch: string;
      };
      assert.equal(health.databaseReady, false);
      assert.equal(health.datasetEpoch, nextEpoch, "API 必须采用与 CLI 相同的生效 epoch");
      assert.equal(existsSync(harness.databasePath), false, "prepared + 缺失不得自动建库");
      // P1-2: "prepared + main absent" is undecidable, not "the main database
      // was observed unreadable". The journal itself blocks the next boot, so
      // startup must not mint or revoke any scope evidence here.
      assert.equal(readEvidence(harness, scopeOf(nextEpoch)), null,
        "不可裁决的 prepared 状态不得写入或撤销 scope 证据");
      const inspect = runCli(harness, []);
      assert.equal(inspect.status, 0, inspect.stderr);
      const inspection = JSON.parse(inspect.stdout) as { persistedEpoch: string; deletion: { stage: string } | null };
      assert.equal(inspection.persistedEpoch, nextEpoch);
      assert.equal(inspection.deletion?.stage, "prepared");
      const refused = runCli(harness, ["--apply", "--deletion-id", deletionId]);
      assert.notEqual(refused.status, 0, "prepared 阶段没有明确确认时必须拒绝");
      assert.match(refused.stderr, /confirm-main-removed/i);
    } finally { await blockedServer.stop(); }

    const confirmed = runCli(harness, ["--apply", "--deletion-id", deletionId, "--confirm-main-removed"]);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.equal(readSidecar(harness).deletion?.stage, "permit_issued");
    assert.equal(existsSync(harness.databasePath), false, "CLI 不得创建主库");
    const permits = allEvidence(harness).filter((row) =>
      row.scope === scopeOf(nextEpoch) && row.state === "pristine");
    assert.equal(permits.length, 1, "只能有一张 nextEpoch 许可");
    assert.equal(permits[0]?.permitSource, `explicit_database_delete:${deletionId}`);

    const firstPacketServer = await harness.start();
    try {
      await importFirstPacket(firstPacketServer, "prepared-confirmed-first");
      assert.equal(existsSync(harness.databasePath), true);
      const mainEpoch = readDatasetEpochState(harness.databasePath, "default");
      assert.equal(mainEpoch.mainEpochExplicit, true, "the first writer must persist its epoch in the main DB");
      assert.equal(mainEpoch.epoch, nextEpoch);
      assert.equal(readEvidence(harness, scopeOf(nextEpoch))?.state, "established");
    } finally { await firstPacketServer.stop(); }
  } finally { harness.remove(); }
});

test("P2-4 main_removed 强杀、许可未写：启动幂等补发同一 nextEpoch 许可；首包一次", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p2-main-removed-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const handle = await harness.start({ RAI_FAULT_POINT: "deletion:after-main-removed:sigkill" });
    await deleteDatabase(handle);
    await waitForHardKill(handle);
    assert.equal(existsSync(harness.databasePath), false);
    const side = readSidecar(harness);
    assert.equal(side.deletion?.stage, "main_removed");
    const deletionId = String(side.deletion?.deletionId);
    const nextEpoch = String(side.deletion?.nextEpoch);
    assert.equal(readEvidence(harness, scopeOf(nextEpoch)), null, "main_removed 时许可还没有写");

    const restarted = await harness.start();
    try {
      await delay(300);
      const sideAfter = readSidecar(harness);
      assert.equal(sideAfter.deletion?.stage, "permit_issued", "启动必须补发并推进到 permit_issued");
      const permits = allEvidence(harness).filter((row) =>
        row.scope === scopeOf(nextEpoch) && row.state === "pristine");
      assert.equal(permits.length, 1);
      assert.equal(permits[0]?.permitSource, `explicit_database_delete:${deletionId}`);
      assert.equal(readDatasetEpoch(harness.databasePath, "default"), nextEpoch);
      const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
        datasetEpoch: string; databaseReady: boolean;
      };
      assert.equal(health.datasetEpoch, nextEpoch, "API 必须采用与侧车/CLI 相同的 nextEpoch");
      assert.equal(health.databaseReady, false);
      assert.equal(existsSync(harness.databasePath), false, "启动补发许可不得建库");
      // 再次重启：同一 deletionId 的重放不得产生第二张许可或第二个 epoch。
      await restarted.stop();
      const again = await harness.start();
      try {
        const permitsAgain = allEvidence(harness).filter((row) =>
          row.scope === scopeOf(nextEpoch) && row.state === "pristine");
        assert.equal(permitsAgain.length, 1);
        assert.equal(readSidecar(harness).epoch?.epoch, nextEpoch);
        await importFirstPacket(again, "main-removed-first");
        assert.equal(existsSync(harness.databasePath), true);
        assert.equal(readEvidence(harness, scopeOf(nextEpoch))?.state, "established");
      } finally { await again.stop(); }
    } catch (error) {
      await restarted.stop().catch(() => {});
      throw error;
    }
  } finally { harness.remove(); }
});

test("P2-5 permit_issued 响应前强杀：重放不产生第二张许可/第二个 epoch；旧 scope 不复活", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-permit-issued-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const handle = await harness.start({ RAI_FAULT_POINT: "deletion:before-response:sigkill" });
    await deleteDatabase(handle);
    await waitForHardKill(handle);
    const side = readSidecar(harness);
    assert.equal(side.deletion?.stage, "permit_issued");
    const deletionId = String(side.deletion?.deletionId);
    const nextEpoch = String(side.deletion?.nextEpoch);

    for (let restart = 0; restart < 2; restart += 1) {
      const server = await harness.start();
      try {
        const health = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
          datasetEpoch: string;
        };
        assert.equal(health.datasetEpoch, nextEpoch, "每次重启都必须采用同一 nextEpoch");
        const permits = allEvidence(harness).filter((row) =>
          row.scope === scopeOf(nextEpoch) && row.state === "pristine");
        assert.equal(permits.length, 1, `第 ${restart + 1} 次重启后必须仍只有一张许可`);
        assert.equal(permits[0]?.permitSource, `explicit_database_delete:${deletionId}`);
        assert.equal(readSidecar(harness).epoch?.epoch, nextEpoch);
        assert.equal(readEvidence(harness, scopeOf("default"))?.state, "established",
          "旧 scope 不得因新许可复活/回退");
      } finally { await server.stop(); }
    }
    const finalServer = await harness.start();
    try {
      await importFirstPacket(finalServer, "permit-issued-first");
      assert.equal(existsSync(harness.databasePath), true);
      assert.equal(readSidecar(harness).deletion?.stage, "writer_entered");
    } finally { await finalServer.stop(); }
  } finally { harness.remove(); }
});

test("P2-5b permit_issued 阶段保护快照轮换：CLI 仍按已有许可报告可恢复", { timeout: 120_000 }, async () => {
  const harness = createHarness("rai-p2-permit-rotation-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const handle = await harness.start({ RAI_FAULT_POINT: "deletion:before-response:sigkill" });
    await deleteDatabase(handle);
    await waitForHardKill(handle);
    const side = readSidecar(harness);
    assert.equal(side.deletion?.stage, "permit_issued");
    const deletionId = String(side.deletion?.deletionId);
    const nextEpoch = String(side.deletion?.nextEpoch);
    const snapshot = join(harness.root, "var/backups", String(side.deletion?.protectionSnapshot));
    assert.ok(existsSync(snapshot));
    renameSync(snapshot, join(harness.root, "rotated-protection.sqlite"));

    const cli = runCli(harness, ["--apply", "--deletion-id", deletionId]);
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.equal(readSidecar(harness).epoch?.epoch, nextEpoch);
    assert.equal(readSidecar(harness).deletion?.stage, "permit_issued");
    const permits = allEvidence(harness).filter((row) =>
      row.scope === scopeOf(nextEpoch) && row.state === "pristine");
    assert.equal(permits.length, 1, "CLI 只校验已有许可，不得重签许可");
  } finally { harness.remove(); }
});

test("P2-6 写者已进入后主库消失且 runtime 账本损坏：不获得 pristine、不建新空库", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p2-writer-lost-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const handle = await harness.start();
    let deletionId: string;
    let nextEpoch: string;
    try {
      const response = await deleteDatabase(handle);
      assert.ok(response && response.status === 200, `删除必须成功：${response?.status}`);
      const body = await response.json() as { deleted: boolean };
      assert.equal(body.deleted, true);
      await importFirstPacket(handle, "writer-entered-first");
      const side = readSidecar(harness);
      assert.equal(side.deletion?.stage, "writer_entered");
      deletionId = String(side.deletion?.deletionId);
      nextEpoch = String(side.deletion?.nextEpoch);
      assert.equal(readEvidence(harness, scopeOf(nextEpoch))?.state, "established");
    } finally { await handle.stop(); }

    // 主库再次消失 + runtime.sqlite 被破坏：构造器会隔离并重建空账本（新实例 id）。
    rmSync(harness.databasePath, { force: true });
    writeFileSync(harness.runtimePath, "this is not a sqlite database");
    const restarted = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
        status: string; databaseReady: boolean; datasetEpoch: string;
      };
      assert.equal(health.databaseReady, false);
      assert.equal(health.datasetEpoch, nextEpoch, "账本隔离重建后 API 仍必须采用 nextEpoch 并保持阻断");
      assert.equal(existsSync(harness.databasePath), false, "账本隔离重建不得放行新建空库");
      const sideAfter = readSidecar(harness);
      assert.equal(sideAfter.deletion?.deletionId, deletionId);
      assert.equal(sideAfter.deletion?.stage, "writer_entered");
      // P1-2: a ledger-instance mismatch is an undecidable boot, not an
      // observed-unreadable main database. No permit exists in the rebuilt
      // ledger, so there is nothing to revoke and no row to forge.
      const evidence = readEvidence(harness, scopeOf(nextEpoch));
      assert.equal(evidence, null, "账本实例不符不得伪造 unknown/pristine 证据");
      const inspect = runCli(harness, []);
      assert.equal(inspect.status, 0, inspect.stderr);
      const inspection = JSON.parse(inspect.stdout) as {
        scopeEvidence: { state: string } | null; actionRequired: string; deletionId?: string;
      };
      assert.equal(inspection.scopeEvidence, null);
      // P3: writer_entered + missing main is never "none".
      assert.equal(inspection.actionRequired, "database_recovery");
      assert.equal(inspection.deletionId, deletionId);
    } finally { await restarted.stop(); }
  } finally { harness.remove(); }
});

test("P2-7 侧车损坏/配置不匹配/快照缺失/账本实例不符/写账本失败：CLI 非零且不写主库", { timeout: 240_000 }, async () => {
  // a) 侧车损坏
  {
    const harness = createHarness("rai-p2-corrupt-sidecar-");
    try {
      await seedDatabaseAsync(harness);
      writeFileSync(harness.sidecarPath, "not a sqlite database");
      const result = runCli(harness, []);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unreadable|invalid|malformed/i);
      assert.ok(existsSync(harness.databasePath), "只读检查失败不得删除或改写主库");
    } finally { harness.remove(); }
  }
  // b) 配置 epoch 不匹配
  {
    const harness = createHarness("rai-p2-config-mismatch-");
    try {
      await seedDatabaseAsync(harness);
      const handle = await harness.start();
      const response = await deleteDatabase(handle);
      assert.ok(response && response.status === 200);
      await handle.stop();
      const side = readSidecar(harness);
      const deletionId = String(side.deletion?.deletionId);
      const mismatch = runCli(harness, ["--apply", "--deletion-id", deletionId], { RAI_DATASET_EPOCH: "other" });
      assert.notEqual(mismatch.status, 0);
      assert.match(mismatch.stderr, /configured epoch|belongs to/i);
      assert.equal(existsSync(harness.databasePath), false, "配置不匹配不得创建主库");
    } finally { harness.remove(); }
  }
  // c) 保护快照缺失（main_removed 阶段仍要求快照；permit_issued 允许轮换）
  {
    const harness = createHarness("rai-p2-snapshot-missing-");
    try {
      await seedDatabaseAsync(harness);
      const deleting = await harness.start({ RAI_FAULT_POINT: "deletion:after-main-removed:sigkill" });
      await deleteDatabase(deleting);
      await waitForHardKill(deleting);
      const side = readSidecar(harness);
      assert.equal(side.deletion?.stage, "main_removed");
      const snapshot = join(harness.root, "var/backups", String(side.deletion?.protectionSnapshot));
      assert.ok(existsSync(snapshot));
      rmSync(snapshot, { force: true });
      const deletionId = String(side.deletion?.deletionId);
      const result = runCli(harness, ["--apply", "--deletion-id", deletionId]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /protection snapshot is missing/i);
    } finally { harness.remove(); }
  }
  // d) runtime 账本实例不符
  {
    const harness = createHarness("rai-p2-instance-mismatch-");
    try {
      await seedDatabaseAsync(harness);
      const handle = await harness.start();
      const response = await deleteDatabase(handle);
      assert.ok(response && response.status === 200);
      await handle.stop();
      const deletionId = String(readSidecar(harness).deletion?.deletionId);
      const runtime = new DatabaseSync(harness.runtimePath);
      try {
        runtime.prepare("UPDATE runtime_meta SET value='runtime_other' WHERE key='rai.runtime-instance-id'").run();
      } finally { runtime.close(); }
      const result = runCli(harness, ["--apply", "--deletion-id", deletionId]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /instance.*does not match/i);
      assert.equal(existsSync(harness.databasePath), false);
    } finally { harness.remove(); }
  }
  // e) 写账本失败：fresh-install 写许可被 SQLite 触发器拒绝
  {
    const harness = createHarness("rai-p2-ledger-write-fail-");
    try {
      // 先让生产构造器建表，再安装失败触发器。
      new RuntimeStateStore(harness.root).runtimeInstanceId();
      const runtime = new DatabaseSync(harness.runtimePath);
      try {
        runtime.exec(`CREATE TRIGGER fail_scope_insert BEFORE INSERT ON import_scope_evidence
          BEGIN SELECT RAISE(ABORT, 'fixture scope evidence write failure'); END`);
      } finally { runtime.close(); }
      const result = runCli(harness, ["--apply", "--fresh-install"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /write failure|refused/i);
      assert.equal(existsSync(harness.databasePath), false, "写账本失败不得创建主库");
      assert.equal(allEvidence(harness).length, 0);
    } finally { harness.remove(); }
  }
});

test("P2-8 恢复旧备份：删库意图收口，恢复后的 scope 为 established，旧 nextEpoch 不再是当前 scope", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-restore-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const handle = await harness.start();
    try {
      const response = await deleteDatabase(handle);
      assert.ok(response && response.status === 200);
      const body = await response.json() as {
        preservation: { kind: string; backup: { name: string } };
      };
      const deletedEpoch = String(readSidecar(harness).deletion?.nextEpoch);
      const restore = await fetch(
        `http://127.0.0.1:${handle.port}/v1/backups/${encodeURIComponent(body.preservation.backup.name)}/restore`,
        {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "恢复此备份" })
        }
      );
      const restoreText = await restore.text();
      assert.equal(restore.status, 200, restoreText);
      const restored = JSON.parse(restoreText) as { restored: boolean };
      assert.equal(restored.restored, true);
      const side = readSidecar(harness);
      assert.equal(side.deletion?.stage, "rolled_back", "恢复后删库意图必须收口");
      assert.notEqual(side.epoch?.epoch, deletedEpoch, "恢复必须产生新的最终 epoch");
      const health = await (await fetch(`http://127.0.0.1:${handle.port}/v1/health`)).json() as {
        datasetEpoch: string; databaseReady: boolean;
      };
      assert.equal(health.databaseReady, true);
      assert.equal(health.datasetEpoch, side.epoch?.epoch);
      const restoredScope = scopeOf(String(side.epoch?.epoch));
      assert.equal(readEvidence(harness, restoredScope)?.state, "established");
      const inspect = runCli(harness, []);
      assert.equal(inspect.status, 0, inspect.stderr);
      const inspection = JSON.parse(inspect.stdout) as {
        persistedEpoch: string; scopeEvidence: { state: string } | null; deletion: { stage: string } | null;
      };
      assert.equal(inspection.persistedEpoch, side.epoch?.epoch);
      assert.equal(inspection.scopeEvidence?.state, "established");
      assert.equal(inspection.deletion?.stage, "rolled_back");
      assert.notEqual(inspection.persistedEpoch, deletedEpoch);
    } finally { await handle.stop(); }
  } finally { harness.remove(); }
});

test("P2-9 prepared 日志与可读主库 epoch 冲突：全局保持恢复阻断，备份恢复仍可用", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-prepared-epoch-conflict-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const deleting = await harness.start({ RAI_FAULT_POINT: "deletion:after-prepared:sigkill" });
    await deleteDatabase(deleting);
    await waitForHardKill(deleting);
    const deletion = readSidecar(harness).deletion;
    assert.equal(deletion?.stage, "prepared");
    const nextEpoch = String(deletion?.nextEpoch);
    const main = new DatabaseSync(harness.databasePath);
    try {
      main.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES ('rai.dataset-epoch', ?)")
        .run(JSON.stringify({ configuredEpoch: "default", epoch: "foreign-readable-epoch" }));
    } finally { main.close(); }

    const blocked = await harness.start();
    try {
      const base = `http://127.0.0.1:${blocked.port}`;
      const health = await (await fetch(`${base}/v1/health`)).json() as {
        status: string; databaseReady: boolean; datasetEpoch: string;
      };
      assert.equal(health.status, "recovery_required");
      assert.equal(health.databaseReady, false);
      assert.equal(health.datasetEpoch, nextEpoch);
      // P1-2: the conflict is undecidable, not an observed-unreadable main DB.
      // No permit exists for nextEpoch, so no evidence row may be forged.
      assert.equal(readEvidence(harness, scopeOf(nextEpoch)), null,
        "可读主库不得把冲突的 nextEpoch 标为 established");
      const dashboard = await fetch(`${base}/v1/dashboard`);
      assert.equal(dashboard.status, 409, "恢复阻断必须覆盖读侧");
      const submit = await fetch(`${base}/v1/import-jobs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: "missing-source" })
      });
      assert.equal(submit.status, 409, "恢复阻断必须覆盖元数据写入入口");

      const snapshot = String(deletion?.protectionSnapshot);
      const restore = await fetch(`${base}/v1/backups/${encodeURIComponent(snapshot)}/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: "恢复此备份" })
      });
      assert.equal(restore.status, 200, await restore.text());
      const ready = await (await fetch(`${base}/v1/health`)).json() as { databaseReady: boolean };
      assert.equal(ready.databaseReady, true, "显式恢复后同一进程应解除阻断");
    } finally { await blocked.stop(); }
  } finally { harness.remove(); }
});


for (const stage of ["main_removed", "permit_issued"] as const) {
  test(`P2-9b ${stage} + 外来可读主库：保持 recovery_required，不撤销许可、不关闭日志`, { timeout: 180_000 }, async () => {
    const harness = createHarness(`rai-p2-foreign-readable-${stage}-`);
    try {
      await seedDatabaseAsync(harness, "foreign-readable-fixture");
      const fault = stage === "main_removed"
        ? "deletion:after-main-removed:sigkill"
        : "deletion:before-response:sigkill";
      const deleting = await harness.start({ RAI_FAULT_POINT: fault });
      await deleteDatabase(deleting);
      await waitForHardKill(deleting);
      const before = readSidecar(harness).deletion;
      assert.equal(before?.stage, stage);
      const nextEpoch = String(before?.nextEpoch);
      const foreign = await RaiDatabase.open(harness.databasePath);
      try { writeDatasetEpoch(foreign.database, "default", "foreign-readable-epoch"); }
      finally { foreign.close(); }

      const blocked = await harness.start();
      try {
        const health = await (await fetch(`http://127.0.0.1:${blocked.port}/v1/health`)).json() as {
          status: string; databaseReady: boolean; datasetEpoch: string;
        };
        assert.equal(health.status, "recovery_required");
        assert.equal(health.databaseReady, false);
        assert.equal(health.datasetEpoch, nextEpoch, "不得采用无凭据的新 epoch");
        const side = readSidecar(harness).deletion;
        assert.equal(side?.stage, stage, "可读外来库不得关闭删库日志");
        const sidecarEpoch = new DatabaseSync(harness.sidecarPath, { readOnly: true })
          .prepare("SELECT payload FROM dataset_epoch WHERE id=1").get() as { payload: string };
        assert.equal((JSON.parse(sidecarEpoch.payload) as { epoch: string }).epoch, nextEpoch);
        const permit = readEvidence(harness, scopeOf(nextEpoch));
        if (stage === "permit_issued") {
          assert.equal(permit?.state, "pristine", "已有许可不得被撤销");
          assert.equal(permit?.permitRevokedAt, null);
        } else {
          assert.equal(permit, null);
        }
        assert.equal(readEvidence(harness, scopeOf("foreign-readable-epoch")), null);
        assert.equal((await fetch(`http://127.0.0.1:${blocked.port}/v1/backups`)).status, 200);
      } finally { await blocked.stop(); }
    } finally { harness.remove(); }
  });
}

test("P2-10 permit_issued 丢失 scope 行但账本实例不变：CLI 不得重签许可", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-permit-row-lost-");
  try {
    await seedDatabaseAsync(harness);
    const server = await harness.start();
    const response = await deleteDatabase(server);
    assert.ok(response && response.status === 200);
    await server.stop();
    const deletion = readSidecar(harness).deletion;
    assert.equal(deletion?.stage, "permit_issued");
    const deletionId = String(deletion?.deletionId);
    const nextScope = scopeOf(String(deletion?.nextEpoch));
    const ledger = new RuntimeStateStore(harness.root);
    const instance = ledger.runtimeInstanceId();
    ledger.markScopeWriterEntered(nextScope, new Date().toISOString());
    const runtime = new DatabaseSync(harness.runtimePath);
    try {
      runtime.prepare("DELETE FROM import_scope_evidence WHERE scope=?").run(nextScope);
    } finally { runtime.close(); }
    assert.equal(new RuntimeStateStore(harness.root).runtimeInstanceId(), instance);

    const blocked = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${blocked.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, false);
      const cli = runCli(harness, ["--apply", "--deletion-id", deletionId]);
      assert.notEqual(cli.status, 0);
      assert.match(cli.stderr, /missing or consumed/i);
      // P1-2: nothing to revoke and nothing to mint; the ledger row stays absent.
      assert.equal(readEvidence(harness, nextScope), null);
      assert.equal(existsSync(harness.databasePath), false);
    } finally { await blocked.stop(); }
  } finally { harness.remove(); }
});

test("P2-11 首包消费后恢复备份：旧删库日志 superseded，主库再缺失不回到旧 nextEpoch", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-consumed-restore-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const server = await harness.start();
    let oldNextEpoch: string;
    let restoredEpoch: string;
    try {
      const response = await deleteDatabase(server);
      assert.ok(response && response.status === 200);
      const body = await response.json() as { preservation: { backup: { name: string } } };
      oldNextEpoch = String(readSidecar(harness).deletion?.nextEpoch);
      await importFirstPacket(server, "consumed-then-restore");
      assert.equal(readSidecar(harness).deletion?.stage, "writer_entered");
      const restoreUrl = `http://127.0.0.1:${server.port}/v1/backups/`
        + `${encodeURIComponent(body.preservation.backup.name)}/restore`;
      let restore: Response | null = null;
      const deadline = Date.now() + 60_000;
      do {
        restore = await fetch(restoreUrl, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "恢复此备份" })
        });
        if (restore.status !== 409) break;
        await delay(250);
      } while (Date.now() < deadline);
      assert.ok(restore);
      assert.equal(restore.status, 200, await restore.text());
      const side = readSidecar(harness);
      assert.equal(side.deletion?.stage, "superseded");
      restoredEpoch = String(side.epoch?.epoch);
      assert.notEqual(restoredEpoch, oldNextEpoch);
      assert.equal(readEvidence(harness, scopeOf(restoredEpoch))?.state, "established");
    } finally { await server.stop(); }
    rmSync(harness.databasePath, { force: true });
    const restarted = await harness.start();
    try {
      assert.equal(existsSync(harness.databasePath), false,
        `恢复后移走主库应保持缺失，侧车：${JSON.stringify(readSidecar(harness))}`);
      const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
        databaseReady: boolean; datasetEpoch: string;
      };
      assert.equal(health.databaseReady, false);
      assert.equal(health.datasetEpoch, restoredEpoch);
      assert.notEqual(health.datasetEpoch, oldNextEpoch);
      // P1-2: an absent main file after a completed restore is a block, not an
      // "unreadable" observation. The restored scope keeps its established
      // evidence; no permit is revived and no new empty database is created.
      assert.equal(readEvidence(harness, scopeOf(restoredEpoch))?.state, "established",
        "恢复后的 established 证据不得因主库文件缺失被抹掉");
    } finally { await restarted.stop(); }
  } finally { harness.remove(); }
});

test("P2-12 快照存在但字节损坏：自动恢复和 CLI 都拒绝补发许可", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-snapshot-corrupt-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const deleting = await harness.start({ RAI_FAULT_POINT: "deletion:after-main-removed:sigkill" });
    await deleteDatabase(deleting);
    await waitForHardKill(deleting);
    const deletion = readSidecar(harness).deletion;
    assert.equal(deletion?.stage, "main_removed");
    const deletionId = String(deletion?.deletionId);
    const nextScope = scopeOf(String(deletion?.nextEpoch));
    const snapshot = join(harness.root, "var/backups", String(deletion?.protectionSnapshot));
    const original = readFileSync(snapshot);
    assert.ok(original.length > 0);
    const damaged = Buffer.from(original);
    damaged[Math.floor(damaged.length / 2)]! ^= 0x01;
    writeFileSync(snapshot, damaged);
    assert.equal(statSync(snapshot).size, original.length, "same-size tampering must be caught by SHA-256");

    const restarted = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, false);
      assert.equal(readSidecar(harness).deletion?.stage, "main_removed");
      assert.notEqual(readEvidence(harness, nextScope)?.state, "pristine");
      const cli = runCli(harness, ["--apply", "--deletion-id", deletionId]);
      assert.notEqual(cli.status, 0);
      assert.match(cli.stderr, /snapshot bytes changed/i);
      assert.equal(existsSync(harness.databasePath), false);
    } finally { await restarted.stop(); }
  } finally { harness.remove(); }
});


// ---------------------------------------------------------------------------
// P1-2 / P1-5 / P2-5（2026-10-23 复审）
// ---------------------------------------------------------------------------

test("P1-2 保护快照暂时移走再放回：原许可不被撤销，首包只消费一次", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p1-2-snapshot-rotation-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const deleting = await harness.start({ RAI_FAULT_POINT: "deletion:after-main-removed:sigkill" });
    await deleteDatabase(deleting);
    await waitForHardKill(deleting);
    const deletion = readSidecar(harness).deletion;
    assert.equal(deletion?.stage, "main_removed");
    const nextEpoch = String(deletion?.nextEpoch);
    const nextScope = scopeOf(nextEpoch);
    const snapshotName = String(deletion?.protectionSnapshot);
    const snapshotPath = join(harness.root, "var/backups", snapshotName);
    const parked = join(harness.root, "snapshot.parked.sqlite");
    renameSync(snapshotPath, parked);

    const blocked = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${blocked.port}/v1/health`)).json() as {
        databaseReady: boolean; datasetEpoch: string;
      };
      assert.equal(health.databaseReady, false);
      assert.equal(health.datasetEpoch, nextEpoch);
      // P1-2: "snapshot temporarily absent" is an undecidable boot. It must not
      // mint or revoke the recorded permit.
      assert.equal(readEvidence(harness, nextScope), null,
        "快照暂时缺失不得撤销/伪造作用域证据");
    } finally { await blocked.stop(); }

    renameSync(parked, snapshotPath);
    const resumed = await harness.start();
    let pristineAt: unknown;
    let firstEmptyEpoch: unknown;
    try {
      const permit = readEvidence(harness, nextScope);
      assert.equal(permit?.state, "pristine");
      assert.equal(permit?.permitSource, `explicit_database_delete:${deletion?.deletionId}`);
      assert.equal(readSidecar(harness).deletion?.stage, "permit_issued");
      pristineAt = permit?.pristineAt;
      firstEmptyEpoch = permit?.firstEmptyEpoch;
      await importFirstPacket(resumed, "p1-2-first-packet");
      const consumed = readEvidence(harness, nextScope);
      assert.equal(consumed?.state, "established");
      assert.equal(consumed?.pristineAt, pristineAt, "原许可的 pristineAt 不得变化");
      assert.equal(consumed?.firstEmptyEpoch, firstEmptyEpoch, "原许可的代次不得变化");
    } finally { await resumed.stop(); }

    // A later restart keeps the same consumed evidence: no second permit.
    const later = await harness.start();
    try {
      const evidence = readEvidence(harness, nextScope);
      assert.equal(evidence?.state, "established");
      assert.equal(evidence?.permitSource, `explicit_database_delete:${deletion?.deletionId}`);
      assert.equal(readSidecar(harness).deletion?.stage, "writer_entered");
    } finally { await later.stop(); }
  } finally { harness.remove(); }
});

test("P1-5 写者进入后建库前 SIGKILL：显式放弃生成新 epoch，旧 scope 不复活", { timeout: 300_000 }, async () => {
  const harness = createHarness("rai-p1-5-writer-crash-");
  try {
    const fresh = runCli(harness, ["--apply", "--fresh-install"]);
    assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
    const crashing = await harness.start({ RAI_FAULT_POINT: "deletion:writer-runtime-entered:sigkill" });
    let jobId: string | null = null;
    try {
      jobId = await startFirstPacketJob(crashing, "p1-5-crash");
      await waitForHardKill(crashing);
    } catch {
      // The kill may land while the upload/inspect response is in flight.
      await waitForHardKill(crashing).catch(() => {});
    }
    assert.ok(jobId !== null, "任务必须在强杀前已创建");
    assert.equal(existsSync(harness.databasePath), false, "故障点之后不得创建主库");
    assert.equal(readSidecar(harness).deletion, null, "首次安装路径没有删库日志");
    const crashEvidence = readEvidence(harness, scopeOf("default"));
    assert.equal(crashEvidence?.state, "writer_entered");
    assert.equal(crashEvidence?.datasetEstablishedAt, null);

    const inspect = runCli(harness, []);
    assert.equal(inspect.status, 0, inspect.stderr);
    const inspection = JSON.parse(inspect.stdout) as { actionRequired: string };
    assert.equal(inspection.actionRequired, "database_recovery");

    const refused = runCli(harness, [
      "--apply", "--abandon-and-create-new-epoch", "--confirm-abandon", "default"
    ]);
    assert.notEqual(refused.status, 0, "没有 --reason 必须拒绝");
    assert.match(refused.stderr, /reason/i);

    const abandoned = runCli(harness, [
      "--apply", "--abandon-and-create-new-epoch", "--confirm-abandon", "default",
      "--reason", "acceptance: writer entered but no main database was created"
    ]);
    assert.equal(abandoned.status, 0, abandoned.stderr);
    const abandonedBody = JSON.parse(abandoned.stdout) as {
      previousEpoch: string; persistedEpoch: string; oldScope: string; scope: string; permitSource: string;
    };
    assert.equal(abandonedBody.previousEpoch, "default");
    assert.notEqual(abandonedBody.persistedEpoch, "default");
    assert.equal(abandonedBody.permitSource, "operator_abandon_and_new_epoch:default");
    assert.equal(readEvidence(harness, scopeOf("default"))?.state, "abandoned");

    const resumed = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${resumed.port}/v1/health`)).json() as {
        datasetEpoch: string; databaseReady: boolean;
      };
      assert.equal(health.datasetEpoch, abandonedBody.persistedEpoch);
      const runtime = new DatabaseSync(harness.runtimePath, { readOnly: true });
      try {
        const row = runtime.prepare("SELECT status, phase FROM import_jobs WHERE id = ?").get(jobId) as
          { status: string; phase: string } | undefined;
        assert.equal(row?.phase, "superseded", "旧任务不得被伪造成 failed/未提交");
      } finally { runtime.close(); }
      // Old scope's job cannot run; the new epoch's first packet consumes the new permit once.
      await importFirstPacket(resumed, "p1-5-new-epoch-first");
      assert.equal(readEvidence(harness, `["local","athlete_1","${abandonedBody.persistedEpoch}"]`)?.state,
        "established");
      assert.equal(readEvidence(harness, scopeOf("default"))?.state, "abandoned");
    } finally { await resumed.stop(); }
  } finally { harness.remove(); }
});

test("P2-5 不可读主库只能通过显式隔离继续原 deletionId", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p2-5-quarantine-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const deleting = await harness.start({ RAI_FAULT_POINT: "deletion:after-main-removed:sigkill" });
    await deleteDatabase(deleting);
    await waitForHardKill(deleting);
    const deletion = readSidecar(harness).deletion;
    assert.equal(deletion?.stage, "main_removed");
    const deletionId = String(deletion?.deletionId);
    writeFileSync(harness.databasePath, "not a sqlite database");

    const blocked = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${blocked.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, false);
    } finally { await blocked.stop(); }

    const list = runCli(harness, ["--list-quarantine"]);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /snapshots/);

    const refused = runCli(harness, [
      "--apply", "--quarantine-unreadable-main", "--deletion-id", deletionId
    ]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /confirm-quarantine/i);
    assert.equal(existsSync(harness.databasePath), true, "未确认时不得移动主库");

    const quarantined = runCli(harness, [
      "--apply", "--quarantine-unreadable-main", "--deletion-id", deletionId, "--confirm-quarantine"
    ]);
    assert.equal(quarantined.status, 0, quarantined.stderr);
    assert.equal(existsSync(harness.databasePath), false);
    assert.equal(readSidecar(harness).deletion?.stage, "main_removed");
    assert.ok(readdirSync(join(harness.root, "var/quarantine")).some((name) => name.endsWith(".manifest.json")),
      "隔离必须留下字节清单");

    const recovered = runCli(harness, ["--apply", "--deletion-id", deletionId]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readSidecar(harness).deletion?.stage, "permit_issued");
    const final = await harness.start();
    try {
      await importFirstPacket(final, "p2-5-quarantined-first");
      assert.equal(existsSync(harness.databasePath), true);
    } finally { await final.stop(); }
  } finally { harness.remove(); }
});

test("P1-4 待迁移主库 + 删库裁决：API 不退出 78，且恢复前不执行任何主库作业恢复", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p1-4-pending-migrations-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const db = new DatabaseSync(harness.databasePath);
    try {
      // A readable main database with a different epoch than the prepared deletion.
      db.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES ('rai.dataset-epoch', ?)")
        .run(JSON.stringify({ configuredEpoch: "default", epoch: "foreign-readable-epoch" }));
      db.prepare(`INSERT INTO recompute_jobs
        (id, job_type, status, request_json, progress_phase, created_at, started_at)
        VALUES ('stale-running-job', 'import', 'running', '{}', 'features', '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:01.000Z')`).run();
      // Make the database require a migration: with no deletion decision this
      // startup would exit 78 (PendingMigrationsError).
      db.prepare("DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)").run();
    } finally { db.close(); }
    const runtime = new RuntimeStateStore(harness.root);
    const record = {
      version: 3, deletionId: "delete-pending-migrations", configuredEpoch: "default",
      previousEpoch: "old-epoch", nextEpoch: "next-epoch",
      protectionSnapshot: "before-delete.sqlite", protectionKind: "backup",
      protectionFiles: [{ suffix: "", sizeBytes: 1, sha256: "a".repeat(64) }],
      serverId: "local", athleteId: "athlete_1", runtimeInstanceId: runtime.runtimeInstanceId(),
      stage: "prepared", createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z"
    };
    const sidecar = new DatabaseSync(harness.sidecarPath);
    try {
      sidecar.exec(`CREATE TABLE dataset_epoch (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
        CREATE TABLE dataset_deletion (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)`);
      sidecar.prepare("INSERT INTO dataset_epoch VALUES (1, ?)")
        .run(JSON.stringify({ configuredEpoch: "default", epoch: "next-epoch" }));
      sidecar.prepare("INSERT INTO dataset_deletion VALUES (1, ?)").run(JSON.stringify(record));
    } finally { sidecar.close(); }
    const before = hashFile(harness.databasePath);

    const server = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
        status: string; databaseReady: boolean;
      };
      assert.equal(health.status, "recovery_required");
      assert.equal(health.databaseReady, false);
      assert.equal(hashFile(harness.databasePath), before,
        "恢复阻断期间不得迁移、回填或改写主库字节");
      const check = new DatabaseSync(harness.databasePath, { readOnly: true });
      try {
        const job = check.prepare("SELECT status FROM recompute_jobs WHERE id='stale-running-job'").get() as
          { status: string } | undefined;
        assert.equal(job?.status, "running",
          "recoverDatabaseJobs 不得在删库阻断期间运行（否则会把在飞任务改写为中断）");
      } finally { check.close(); }
      // The recovery route itself stays reachable.
      const backups = await fetch(`http://127.0.0.1:${server.port}/v1/backups`);
      assert.equal(backups.status, 200);
    } finally { await server.stop(); }
  } finally { harness.remove(); }
});

test("P2-9 删除恢复期间：退役路由仍 410、未知路由 404、现役业务路由 409", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-9-retired-priority-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const deleting = await harness.start({ RAI_FAULT_POINT: "deletion:after-main-removed:sigkill" });
    await deleteDatabase(deleting);
    await waitForHardKill(deleting);
    const blocked = await harness.start();
    try {
      const base = `http://127.0.0.1:${blocked.port}`;
      const retiredGet = await fetch(`${base}/v1/mobile/goals`);
      assert.equal(retiredGet.status, 410, "退役路由必须穿过删库恢复 409 直接回答 410");
      assert.equal((await retiredGet.json() as { code: string }).code, "legacy_surface_retired");
      const retiredPost = await fetch(`${base}/v1/backups`, { method: "POST" });
      assert.equal(retiredPost.status, 410);
      assert.equal((await retiredPost.json() as { code: string }).code, "backup_creation_retired");
      assert.equal((await fetch(`${base}/v1/definitely-not-a-route`)).status, 404);
      const live = await fetch(`${base}/v1/mobile/training-plan-state`);
      assert.equal(live.status, 409, "现役业务路由在被阻断时必须仍是 409");
      assert.ok(["database_recovery_required", "database_not_ready"].includes(
        (await live.json() as { code: string }).code));
      assert.equal((await fetch(`${base}/v1/backups`)).status, 200, "诊断/恢复入口必须可达");
    } finally { await blocked.stop(); }
  } finally { harness.remove(); }
});

test("P1-7 停在恢复裁决的导入任务不得否决显式备份恢复", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p1-7-restore-bypass-");
  try {
    await seedDatabaseAsync(harness, "old-dataset");
    const backup = await new DatabaseMaintenance(harness.databasePath, harness.root).createBackup("p1-7-fixture");
    const state = new RuntimeStateStore(harness.root);
    state.upsertJob({
      id: "parked-import", status: "queued", phase: "queued", message: "",
      createdAt: "2026-10-23T00:00:00.000Z", completedAt: null, error: null,
      inputPath: harness.root,
      queue: {
        scope: JSON.stringify(["local", "athlete_1", "default"]), attempts: 0, finalized: false,
        databaseAbsentAtEnqueue: true
      }
    });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${harness.databasePath}${suffix}`, { force: true });

    const server = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, false);
      const restore = await fetch(
        `http://127.0.0.1:${server.port}/v1/backups/${encodeURIComponent(backup.name)}/restore`,
        {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "恢复此备份" })
        }
      );
      const text = await restore.text();
      assert.equal(restore.status, 200,
        `显式 restore 不得因停在恢复裁决的任务返回 409：${text}\n${server.output()}`);
      const body = JSON.parse(text) as { restored: boolean };
      assert.equal(body.restored, true);
      const ready = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(ready.databaseReady, true, "恢复成功后同一进程必须解除业务阻断");
      const runtime = new DatabaseSync(harness.runtimePath, { readOnly: true });
      try {
        const row = runtime.prepare("SELECT status, phase FROM import_jobs WHERE id='parked-import'").get() as
          { status: string; phase: string } | undefined;
        assert.equal(row?.phase, "superseded", "旧 scope 任务必须标为被显式恢复替代，而不是伪失败");
      } finally { runtime.close(); }
      // The acceptance condition is not "the health flag flipped": a fresh
      // import must actually run to completion in this same process.
      await importFirstPacket(server, "p1-7-after-restore");
      const after = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(after.databaseReady, true);
    } finally { await server.stop(); }
  } finally { harness.remove(); }
});

test("P2-13 不存在的备份只临时冻结：连续失败后一次成功恢复仍可导入", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p2-missing-backup-");
  try {
    await seedDatabaseAsync(harness);
    const backup = await new DatabaseMaintenance(harness.databasePath, harness.root).createBackup("p2-13-fixture");
    mkdirSync(join(harness.root, "var/backups"), { recursive: true });
    writeFileSync(join(harness.root, "var/backups/rai.still-corrupt.fixture.sqlite"), "not a sqlite database");
    const server = await harness.start();
    try {
      const missing = await requestRestore(server, "no-such-backup.sqlite");
      const missingText = await missing.text();
      assert.equal(missing.status, 404, `${missingText}\n${server.output()}`);
      assert.equal((JSON.parse(missingText) as { code: string }).code, "backup_not_found");

      const corrupt = await requestRestore(server, "rai.still-corrupt.fixture.sqlite");
      assert.equal(corrupt.status, 500, `${await corrupt.text()}\n${server.output()}`);
      const afterFailures = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(afterFailures.databaseReady, true, "无副作用的恢复失败不得留下全局阻断");

      // A success after two failures must not leak a freeze handle either.
      const restored = await requestRestore(server, backup.name);
      const restoredText = await restored.text();
      assert.equal(restored.status, 200, `${restoredText}\n${server.output()}`);
      assert.notEqual((JSON.parse(restoredText) as { restartRequired?: boolean }).restartRequired, true);
      // Acceptance: the same process must still import. A hidden freeze would
      // leave the task queued until restart.
      await importFirstPacket(server, "after-missing-backup");
    } finally { await server.stop(); }
  } finally { harness.remove(); }
});

test("P2-14 替换门后失败且原库已回滚验证：只释放临时冻结，不解除独立阻断", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-rolled-back-restore-");
  try {
    await seedDatabaseAsync(harness, "pre-restore-dataset");
    const backup = await new DatabaseMaintenance(harness.databasePath, harness.root).createBackup("p2-12-fixture");
    const server = await harness.start({ RAI_FAULT_POINT: "restore:after-install:throw" });
    try {
      const restore = await fetch(
        `http://127.0.0.1:${server.port}/v1/backups/${encodeURIComponent(backup.name)}/restore`,
        {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "恢复此备份" })
        }
      );
      const text = await restore.text();
      assert.equal(restore.status, 500, `${text}\n${server.output()}`);
      const health = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
        databaseReady: boolean; datasetEpoch: string;
      };
      assert.equal(health.databaseReady, true, "完整回滚并验证后不得把进程留在恢复阻断");
      const main = new DatabaseSync(harness.databasePath, { readOnly: true });
      try {
        assert.equal((main.prepare("SELECT value FROM import_manifest WHERE key='dataset_version'").get() as
          { value: string }).value, "pre-restore-dataset", "回滚必须恢复原库字节");
      } finally { main.close(); }
      await importFirstPacket(server, "after-rolled-back-restore");
    } finally { await server.stop(); }
  } finally { harness.remove(); }
});

function runCliAsync(harness: Harness, args: string[], env: Record<string, string> = {}): Promise<{
  status: number | null; stdout: string; stderr: string;
}> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/api/src/import-scope-cli.ts", ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        RAI_RUNTIME_ROOT: harness.root,
        RAI_DATABASE: harness.databasePath,
        RAI_SERVER_ID: "local",
        RAI_ATHLETE_ID: "athlete_1",
        RAI_DATASET_EPOCH: "default",
        ...env
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolveRun({ status: code, stdout, stderr }));
  });
}

const abandonmentCounts = (harness: Harness): { rows: number; pristinePermits: number; newEpoch: string | null } => {
  const runtime = new DatabaseSync(harness.runtimePath, { readOnly: true });
  try {
    const rows = runtime.prepare("SELECT new_epoch AS newEpoch FROM scope_abandonments").all() as
      Array<{ newEpoch: string }>;
    const permits = runtime.prepare(`SELECT COUNT(*) AS count FROM import_scope_evidence
      WHERE state='pristine' AND permit_source LIKE 'operator_abandon_and_new_epoch:%'`).get() as { count: number };
    return { rows: rows.length, pristinePermits: permits.count, newEpoch: rows[0]?.newEpoch ?? null };
  } finally { runtime.close(); }
};

test("P2-15 账本提交后 SIGKILL：同一条放弃命令重试只补齐侧车，不生成第二个 epoch", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-abandon-crash-ledger-");
  try {
    const at = "2026-10-23T00:00:00.000Z";
    const store = new RuntimeStateStore(harness.root);
    store.establishPristineScope(scopeOf("default"), "fixture_first_install", at);
    store.markScopeWriterEntered(scopeOf("default"), at);
    const args = ["--apply", "--abandon-and-create-new-epoch", "--confirm-abandon", "default",
      "--reason", "acceptance: crash after ledger commit"];
    const crashed = runCli(harness, args, {
      RAI_FAULT_INJECTION: "1", RAI_FAULT_TEST_ENV: "1",
      RAI_FAULT_POINT: "scope-abandon:after-ledger-commit:sigkill"
    });
    assert.equal(crashed.signal, "SIGKILL", `${crashed.stdout}\n${crashed.stderr}`);
    const afterCrash = abandonmentCounts(harness);
    assert.equal(afterCrash.rows, 1, "账本事务必须已提交且恰好一行");
    assert.equal(afterCrash.pristinePermits, 1, "第一张许可恰好一张");
    assert.equal(readSidecar(harness).epoch, null, "崩溃点必须位于侧车写入之前");

    const retried = runCli(harness, args);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    const body = JSON.parse(retried.stdout) as {
      previousEpoch: string; persistedEpoch: string; completed: boolean; replayed: boolean;
    };
    assert.equal(body.completed, true);
    assert.equal(body.replayed, true);
    assert.equal(body.previousEpoch, "default");
    assert.equal(body.persistedEpoch, afterCrash.newEpoch, "重试必须复用持久化的同一 new epoch");
    assert.equal(readSidecar(harness).epoch?.epoch, afterCrash.newEpoch, "第二步必须补齐侧车");
    const afterRetry = abandonmentCounts(harness);
    assert.equal(afterRetry.rows, 1);
    assert.equal(afterRetry.pristinePermits, 1, "不得出现第二张 pristine 许可");

    // Repeating the completed command reports completion without writing again.
    const repeated = runCli(harness, args);
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    assert.equal((JSON.parse(repeated.stdout) as { completed: boolean }).completed, true);
    assert.equal(abandonmentCounts(harness).rows, 1);
    assert.equal(abandonmentCounts(harness).pristinePermits, 1);

    // Another confirmed epoch is a different operation identity: refuse it.
    const conflicting = runCli(harness, [
      "--apply", "--abandon-and-create-new-epoch", "--confirm-abandon", "another-epoch",
      "--reason", "acceptance: conflict"
    ]);
    assert.notEqual(conflicting.status, 0, "不同 --confirm-abandon 必须拒绝，而不是再造许可");
    assert.equal(abandonmentCounts(harness).rows, 1);

    // The new epoch's first packet consumes its permit exactly once.
    const resumed = await harness.start();
    try {
      await importFirstPacket(resumed, "p2-15-new-epoch-first");
      const newScope = scopeOf(afterCrash.newEpoch!);
      assert.equal(readEvidence(harness, newScope)?.state, "established");
      assert.equal(readEvidence(harness, newScope)?.permitSource, "operator_abandon_and_new_epoch:default");
      assert.equal(readEvidence(harness, scopeOf("default"))?.state, "abandoned");
    } finally { await resumed.stop(); }
  } finally { harness.remove(); }
});

test("P2-15b 放弃重试发现新 epoch 许可已被消费：拒绝推进侧车", { timeout: 120_000 }, async () => {
  const harness = createHarness("rai-p2-abandon-permit-consumed-");
  try {
    const at = "2026-10-23T00:00:00.000Z";
    const store = new RuntimeStateStore(harness.root);
    store.establishPristineScope(scopeOf("default"), "fixture_first_install", at);
    store.markScopeWriterEntered(scopeOf("default"), at);
    const args = ["--apply", "--abandon-and-create-new-epoch", "--confirm-abandon", "default",
      "--reason", "acceptance: retry must re-check the new permit"];
    const crashed = runCli(harness, args, {
      RAI_FAULT_INJECTION: "1", RAI_FAULT_TEST_ENV: "1",
      RAI_FAULT_POINT: "scope-abandon:after-ledger-commit:sigkill"
    });
    assert.equal(crashed.signal, "SIGKILL", `${crashed.stdout}\n${crashed.stderr}`);
    const afterCrash = abandonmentCounts(harness);
    assert.equal(afterCrash.rows, 1);
    assert.ok(afterCrash.newEpoch);
    assert.equal(readSidecar(harness).epoch, null, "崩溃点必须位于侧车写入之前");

    // Simulate the one-shot permit being consumed after the ledger commit but
    // before the retry reaches step two (e.g. another process started the new
    // epoch). The retry must not switch the sidecar to a scope with no permit.
    const runtime = new DatabaseSync(harness.runtimePath);
    try {
      runtime.prepare(`UPDATE import_scope_evidence SET state='established',
        writer_entered_at=?, dataset_established_at=? WHERE scope=?`)
        .run(at, at, scopeOf(afterCrash.newEpoch!));
    } finally { runtime.close(); }

    const retried = runCli(harness, args);
    assert.notEqual(retried.status, 0, retried.stderr || retried.stdout);
    assert.match(retried.stderr, /not replayable|missing, consumed or revoked/i);
    assert.equal(readSidecar(harness).epoch, null, "许可不可用时不得推进侧车");
    assert.equal(abandonmentCounts(harness).pristinePermits, 0);
  } finally { harness.remove(); }
});

test("P2-15c 侧车已完成且首包消费许可后：同一放弃命令只报告已完成", { timeout: 120_000 }, async () => {
  const harness = createHarness("rai-p2-abandon-completed-replay-");
  try {
    const at = "2026-10-23T00:00:00.000Z";
    const store = new RuntimeStateStore(harness.root);
    store.establishPristineScope(scopeOf("default"), "fixture_first_install", at);
    store.markScopeWriterEntered(scopeOf("default"), at);
    const args = ["--apply", "--abandon-and-create-new-epoch", "--confirm-abandon", "default",
      "--reason", "acceptance: completed abandonment is idempotent"];
    const first = runCli(harness, args);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const recorded = abandonmentCounts(harness);
    assert.ok(recorded.newEpoch);
    assert.equal(readSidecar(harness).epoch?.epoch, recorded.newEpoch);

    // The first import consumes the new scope's one-shot permit.
    store.markScopeWriterEntered(scopeOf(recorded.newEpoch!), at);

    const retried = runCli(harness, args);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal((JSON.parse(retried.stdout) as { completed: boolean }).completed, true);
    assert.equal(abandonmentCounts(harness).rows, 1);
    assert.equal(abandonmentCounts(harness).pristinePermits, 0, "consumed permit must not be recreated");
    assert.equal(readSidecar(harness).epoch?.epoch, recorded.newEpoch);
  } finally { harness.remove(); }
});

test("P2-16 侧车写入后 SIGKILL：重试只报告已完成，不新增 epoch/许可/操作行", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-abandon-crash-sidecar-");
  try {
    const at = "2026-10-23T00:00:00.000Z";
    const store = new RuntimeStateStore(harness.root);
    store.establishPristineScope(scopeOf("default"), "fixture_first_install", at);
    store.markScopeWriterEntered(scopeOf("default"), at);
    const args = ["--apply", "--abandon-and-create-new-epoch", "--confirm-abandon", "default",
      "--reason", "acceptance: crash after sidecar"];
    const crashed = runCli(harness, args, {
      RAI_FAULT_INJECTION: "1", RAI_FAULT_TEST_ENV: "1",
      RAI_FAULT_POINT: "scope-abandon:after-sidecar-write:sigkill"
    });
    assert.equal(crashed.signal, "SIGKILL", `${crashed.stdout}\n${crashed.stderr}`);
    const afterCrash = abandonmentCounts(harness);
    assert.equal(afterCrash.rows, 1);
    assert.equal(readSidecar(harness).epoch?.epoch, afterCrash.newEpoch, "侧车必须已指向新 epoch");

    const retried = runCli(harness, args);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    const body = JSON.parse(retried.stdout) as { persistedEpoch: string; completed: boolean };
    assert.equal(body.completed, true);
    assert.equal(body.persistedEpoch, afterCrash.newEpoch);
    assert.equal(abandonmentCounts(harness).rows, 1);
    assert.equal(abandonmentCounts(harness).pristinePermits, 1);
    assert.equal(readSidecar(harness).epoch?.epoch, afterCrash.newEpoch);
  } finally { harness.remove(); }
});

test("P2-17 恢复前已阻断的发布意图：恢复后持久记为取代，重启不再重新阻断", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-publish-supersede-");
  try {
    await seedDatabaseAsync(harness, "pre-intent-dataset");
    const backup = await new DatabaseMaintenance(harness.databasePath, harness.root).createBackup("p2-17-fixture");
    const rollback = join(harness.root, "var/backups/rai.import-rollback.p2-17.sqlite");
    copyFileSync(harness.databasePath, rollback);
    const journal = new ImportPublicationJournal(harness.databasePath, harness.root);
    journal.prepare("blocked-pre-restore-intent", rollback, true);
    journal.commit("blocked-pre-restore-intent");
    const oldScope = scopeOf("default");
    new RuntimeStateStore(harness.root).upsertJob({
      id: "queued-behind-recovery", status: "queued", phase: "queued", message: "",
      createdAt: "2026-10-23T00:00:00.000Z", completedAt: null, error: null,
      inputPath: harness.root,
      queue: { scope: oldScope, attempts: 0, finalized: false }
    });
    const runtime = new DatabaseSync(harness.runtimePath);
    try {
      runtime.exec(`CREATE TABLE IF NOT EXISTS mutation_commands (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        scope TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL)`);
      runtime.prepare(`INSERT INTO mutation_commands (id, scope, status, payload) VALUES (?, ?, 'queued', ?)`)
        .run("command-behind-recovery", oldScope, JSON.stringify({
          id: "command-behind-recovery", scope: oldScope, status: "queued", attempts: 0,
          completedAt: null
        }));
    } finally { runtime.close(); }

    const server = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, false, "未裁决的发布意图必须阻断写入");
      const restore = await requestRestore(server, backup.name);
      const text = await restore.text();
      assert.equal(restore.status, 200, `${text}\n${server.output()}`);
      const body = JSON.parse(text) as { restored: boolean; restartRequired?: boolean };
      assert.equal(body.restored, true);
      assert.notEqual(body.restartRequired, true, "发布意图已被显式恢复裁决，不应要求重启");

      const settled = new DatabaseSync(harness.runtimePath, { readOnly: true });
      try {
        const importJob = settled.prepare("SELECT phase FROM import_jobs WHERE id='queued-behind-recovery'")
          .get() as { phase: string } | undefined;
        assert.equal(importJob?.phase, "superseded", "等待中的旧 scope 导入必须随恢复收口");
        const command = settled.prepare(`SELECT status, payload FROM mutation_commands
          WHERE id='command-behind-recovery'`).get() as { status: string; payload: string } | undefined;
        assert.equal(command?.status, "failed", "等待中的旧 scope 命令必须随恢复收口");
        assert.equal((JSON.parse(command!.payload) as { error: { code: string } }).error.code,
          "dataset_scope_changed");
      } finally { settled.close(); }

      const after = new ImportPublicationJournal(harness.databasePath, harness.root);
      assert.equal(after.has("blocked-pre-restore-intent"), false, "旧意图必须失效");
      const supersessions = after.supersessions();
      assert.equal(supersessions.length, 1);
      assert.equal(supersessions[0]!.id, "blocked-pre-restore-intent");
      await importFirstPacket(server, "p2-17-after-restore");
    } finally { await server.stop(); }

    // Restart: the durable supersession record wins over the old intent.
    const restarted = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, true, "重启不得因已被取代的旧意图重新阻断");
      await importFirstPacket(restarted, "p2-17-after-restart");
    } finally { await restarted.stop(); }
  } finally { harness.remove(); }
});

test("P2-18 解除 token 前 SIGKILL：重启与无中断路径一致，不重复发布", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p2-token-crash-");
  try {
    await seedDatabaseAsync(harness, "token-crash-dataset");
    const backup = await new DatabaseMaintenance(harness.databasePath, harness.root).createBackup("p2-18-fixture");
    const state = new RuntimeStateStore(harness.root);
    state.upsertJob({
      id: "parked-before-token-crash", status: "queued", phase: "queued", message: "",
      createdAt: "2026-10-23T00:00:00.000Z", completedAt: null, error: null,
      inputPath: harness.root,
      queue: { scope: scopeOf("default"), attempts: 0, finalized: false, databaseAbsentAtEnqueue: true }
    });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${harness.databasePath}${suffix}`, { force: true });

    const crashing = await harness.start({ RAI_FAULT_POINT: "restore:before-token-resolution:sigkill" });
    try {
      await fetch(
        `http://127.0.0.1:${crashing.port}/v1/backups/${encodeURIComponent(backup.name)}/restore`,
        {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "恢复此备份" })
        }
      ).catch(() => { /* the connection dies with the process */ });
      await waitForHardKill(crashing);
    } catch {
      await waitForHardKill(crashing).catch(() => {});
    }
    const restoredEpoch = readSidecar(harness).epoch?.epoch;
    assert.ok(restoredEpoch);

    const restarted = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
        databaseReady: boolean; datasetEpoch: string;
      };
      assert.equal(health.databaseReady, true, "已提交的恢复必须在重启后得出同一结论");
      assert.equal(health.datasetEpoch, restoredEpoch);
      const runtime = new DatabaseSync(harness.runtimePath, { readOnly: true });
      try {
        const row = runtime.prepare("SELECT phase FROM import_jobs WHERE id='parked-before-token-crash'").get() as
          { phase: string } | undefined;
        assert.equal(row?.phase, "superseded", "旧作业不得被重复发布或误报");
      } finally { runtime.close(); }
      await importFirstPacket(restarted, "p2-18-after-crash");
    } finally { await restarted.stop(); }
  } finally { harness.remove(); }
});


test("P2-18b 恢复主库提交后 SIGKILL：重启只凭持久恢复意图完成 sidecar/scope/发布收口", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p2-restore-commit-crash-");
  try {
    await seedDatabaseAsync(harness, "restore-commit-crash");
    const backup = await new DatabaseMaintenance(harness.databasePath, harness.root).createBackup("p2-18b-fixture");
    const journal = new RestoreJournal(harness.databasePath, harness.root);
    const crashing = await harness.start({ RAI_FAULT_POINT: "restore:after-commit:sigkill" });
    try {
      await requestRestore(crashing, backup.name).catch(() => null);
      await waitForHardKill(crashing);
    } catch {
      await waitForHardKill(crashing).catch(() => {});
    }
    const intent = journal.read();
    assert.equal(intent?.phase, "committed", "主库提交后必须留下可重放的恢复意图");
    assert.ok("plannedEpoch" in (intent ?? {}), "恢复意图必须绑定预定 epoch");
    const restoredEpoch = String((intent as { plannedEpoch?: string }).plannedEpoch);
    assert.notEqual(restoredEpoch, "default");

    const restarted = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
        databaseReady: boolean; datasetEpoch: string;
      };
      assert.equal(health.databaseReady, true, "重启必须完成已提交的恢复");
      assert.equal(health.datasetEpoch, restoredEpoch);
      assert.equal(journal.read(), null, "sidecar/scope 收口后才能清除恢复意图");
      const side = readSidecar(harness);
      assert.equal(side.epoch?.epoch, restoredEpoch, "重启必须把恢复 epoch 写进侧车");
      assert.equal(readEvidence(harness, scopeOf(restoredEpoch))?.state, "established");
      await importFirstPacket(restarted, "p2-18b-after-restart");
    } finally { await restarted.stop(); }
  } finally { harness.remove(); }
});

test("P2-18c sidecar/scope 已收口、恢复意图未清除时 SIGKILL：重启幂等重放", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p2-restore-clear-crash-");
  try {
    await seedDatabaseAsync(harness, "restore-clear-crash");
    const backup = await new DatabaseMaintenance(harness.databasePath, harness.root).createBackup("p2-18c-fixture");
    const journal = new RestoreJournal(harness.databasePath, harness.root);
    const crashing = await harness.start({ RAI_FAULT_POINT: "restore:before-journal-clear:sigkill" });
    try {
      await requestRestore(crashing, backup.name).catch(() => null);
      await waitForHardKill(crashing);
    } catch {
      await waitForHardKill(crashing).catch(() => {});
    }
    const intent = journal.read();
    assert.equal(intent?.phase, "committed", "清除前崩溃必须保留同一恢复意图");
    const restoredEpoch = String((intent as { plannedEpoch?: string }).plannedEpoch);
    assert.equal(readSidecar(harness).epoch?.epoch, restoredEpoch,
      "崩溃点之前 sidecar 已收口到恢复 epoch");

    const restarted = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${restarted.port}/v1/health`)).json() as {
        databaseReady: boolean; datasetEpoch: string;
      };
      assert.equal(health.databaseReady, true);
      assert.equal(health.datasetEpoch, restoredEpoch);
      assert.equal(journal.read(), null);
      assert.equal(readEvidence(harness, scopeOf(restoredEpoch))?.state, "established");
      await importFirstPacket(restarted, "p2-18c-after-restart");
    } finally { await restarted.stop(); }
  } finally { harness.remove(); }
});

test("P2-19 回滚本身失败：保持阻断与恢复入口，重启从日志恢复原库且不建空库", { timeout: 240_000 }, async () => {
  const harness = createHarness("rai-p2-rollback-failure-");
  try {
    await seedDatabaseAsync(harness, "rollback-failure-original");
    const backup = await new DatabaseMaintenance(harness.databasePath, harness.root).createBackup("p2-19-fixture");
    const blocked = await harness.start({
      RAI_FAULT_POINT: "restore:after-install:throw,restore:rollback-original:throw"
    });
    try {
      const restore = await requestRestore(blocked, backup.name);
      const text = await restore.text();
      assert.equal(restore.status, 503, `${text}\n${blocked.output()}`);
      assert.equal((JSON.parse(text) as { code: string }).code, "restore_recovery_required");
      const health = await (await fetch(`http://127.0.0.1:${blocked.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, false, "无法证明回滚成功时必须保持关闭");
      const cancel = await fetch(`http://127.0.0.1:${blocked.port}/v1/jobs/none/cancel`, { method: "POST" });
      assert.equal(cancel.status, 409, "任务准入必须保持关闭");
      assert.equal((await fetch(`http://127.0.0.1:${blocked.port}/v1/backups`)).status, 200,
        "恢复入口必须保持可用");
    } finally { await blocked.stop(); }

    // Restart replays the open journal from its durable snapshot.
    const recovered = await harness.start();
    try {
      const health = await (await fetch(`http://127.0.0.1:${recovered.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, true, "重启必须从恢复日志复原而不是新建空库");
      const main = new DatabaseSync(harness.databasePath, { readOnly: true });
      try {
        assert.equal((main.prepare("SELECT value FROM import_manifest WHERE key='dataset_version'").get() as
          { value: string }).value, "rollback-failure-original");
      } finally { main.close(); }
      await importFirstPacket(recovered, "p2-19-after-restart");
    } finally { await recovered.stop(); }
  } finally { harness.remove(); }
});

test("P2-20 损坏备份：拒绝恢复且只释放临时冻结，同进程导入继续", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-corrupt-backup-");
  try {
    await seedDatabaseAsync(harness, "corrupt-backup-dataset");
    mkdirSync(join(harness.root, "var/backups"), { recursive: true });
    writeFileSync(join(harness.root, "var/backups/rai.corrupt.fixture.sqlite"), "not a sqlite database");
    const server = await harness.start();
    try {
      const restore = await fetch(
        `http://127.0.0.1:${server.port}/v1/backups/rai.corrupt.fixture.sqlite/restore`,
        {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmation: "恢复此备份" })
        }
      );
      const text = await restore.text();
      assert.equal(restore.status, 500, `${text}\n${server.output()}`);
      const health = await (await fetch(`http://127.0.0.1:${server.port}/v1/health`)).json() as {
        databaseReady: boolean;
      };
      assert.equal(health.databaseReady, true, "候选校验失败不得留下永久阻断");
      await importFirstPacket(server, "after-corrupt-backup");
    } finally { await server.stop(); }
  } finally { harness.remove(); }
});

test("P2-21 并行执行同一放弃命令：只产生一个 epoch，失败方可重试/报告已完成", { timeout: 180_000 }, async () => {
  const harness = createHarness("rai-p2-abandon-concurrent-");
  try {
    const at = "2026-10-23T00:00:00.000Z";
    const store = new RuntimeStateStore(harness.root);
    store.establishPristineScope(scopeOf("default"), "fixture_first_install", at);
    store.markScopeWriterEntered(scopeOf("default"), at);
    const args = ["--apply", "--abandon-and-create-new-epoch", "--confirm-abandon", "default",
      "--reason", "acceptance: concurrent apply"];
    const [first, second] = await Promise.all([
      runCliAsync(harness, args), runCliAsync(harness, args)
    ]);
    assert.ok(first.status === 0 || second.status === 0, `${first.stderr}\n${second.stderr}`);
    const counts = abandonmentCounts(harness);
    assert.equal(counts.rows, 1, "并行执行最终只能有一条 abandonment 记录");
    assert.equal(counts.pristinePermits, 1, "并行执行最终只能有一张 pristine 许可");
    assert.equal(readSidecar(harness).epoch?.epoch, counts.newEpoch);

    // Retrying the losing side (or either side) reports completion, not a new epoch.
    const retry = runCli(harness, args);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal((JSON.parse(retry.stdout) as { completed: boolean }).completed, true);
    assert.equal(abandonmentCounts(harness).rows, 1);
    assert.equal(abandonmentCounts(harness).pristinePermits, 1);

    // An incompatible operator statement must require manual review.
    const conflict = runCli(harness, [
      "--apply", "--abandon-and-create-new-epoch", "--confirm-abandon", "default",
      "--reason", "a different reason"
    ]);
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /operator statement|incompatible|manual review/i);
    assert.equal(abandonmentCounts(harness).rows, 1);
    assert.equal(abandonmentCounts(harness).pristinePermits, 1);
  } finally { harness.remove(); }
});
