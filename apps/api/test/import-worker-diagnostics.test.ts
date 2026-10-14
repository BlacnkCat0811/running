import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RaiDatabase } from "@rai/storage-sqlite";

import { ImportWorker, PUBLIC_IMPORT_FAILURE_ERROR } from "../src/import-worker.js";
import { mobileRefreshOutcome } from "../src/mobile-sync.js";
import { RuntimeStateStore } from "../src/runtime-state.js";

interface CommandSurface {
  command(args: string[]): Promise<void>;
}

function fixture(project?: string) {
  const root = mkdtempSync(join(tmpdir(), "rai-import-diagnostics-"));
  const worker = new ImportWorker(join(root, "rai.sqlite"), project ?? root, root);
  return {
    root, worker,
    surface: worker as unknown as CommandSurface,
    async close() {
      await worker.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("import command preserves stdout business failure, stderr warning, and exit code", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.surface.command(["-e", `
      console.error("ExperimentalWarning: SQLite is an experimental feature");
      console.log(JSON.stringify({status: "failed", error: {message: "fixture recompute business failure"}}));
      process.exitCode = 7;
    `]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /code=7, signal=none/);
      assert.match(error.message, /stderr:\nExperimentalWarning/);
      assert.match(error.message, /stdout:\n.*fixture recompute business failure/);
      return true;
    });
  } finally { await f.close(); }
});

test("import command drains output larger than pipe capacity while retaining bounded tails",
  { timeout: 10_000 }, async () => {
    const f = fixture();
    try {
      const output = `
        console.log("stdout-prefix-" + "x".repeat(2 * 1024 * 1024) + "-stdout-tail");
        console.error("stderr-prefix-" + "y".repeat(2 * 1024 * 1024) + "-stderr-tail");
      `;
      // Successful children also need both pipes drained, not just failed ones.
      await f.surface.command(["-e", output]);
      await assert.rejects(f.surface.command(["-e", output + "process.exitCode = 1;"]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.length < 34_000, "diagnostics must not retain the entire export");
          assert.match(error.message, /-stdout-tail/);
          assert.match(error.message, /-stderr-tail/);
          assert.doesNotMatch(error.message, /stdout-prefix|stderr-prefix/);
          return true;
        });
    } finally { await f.close(); }
  });

test("失败批次的诊断按持久化纪律落盘，且不留任何候选产物（S3.3：staging 链路已删）",
  { timeout: 60_000 }, async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例让真实重算在 `feature_runs` 触发器上失败，断言
  // "诊断在 staging 回滚**之前**落盘、staging 数据库被清理"。staging 链路与它的重算都已从
  // 运行期删除（收口后失败发生在写入之前），"诊断先于清理"的对照物不存在了；保留的判据换成
  // 同一份**持久化纪律**在收口路径上的验证：真实 worker 跑出的失败必须
  // ① 内部诊断（稳定码形式）落进 RuntimeStateStore；② 公开层只有通用文案；
  // ③ 不产生任何 `rai.importing.*` 候生产物；④ 失败批次零写入。
  const f = fixture(resolve(import.meta.dirname, "../../.."));
  const store = await RaiDatabase.open(join(f.root, "rai.sqlite"));
  // 保留一枚"陷阱"：若收口后还有任何路径把失败批次写进重算表，这里会炸出来。
  store.database.exec(`
    CREATE TRIGGER fixture_recompute_failure BEFORE INSERT ON feature_runs
    BEGIN SELECT RAISE(ABORT, 'fixture actual recompute failure'); END;
  `);
  store.close();
  const input = join(f.root, "export");
  mkdirSync(input);
  writeFileSync(join(input, "export.xml"), `<HealthData>
    <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Apple Watch"
      duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="km"
      startDate="2026-10-09 08:00:00 +0800" endDate="2026-10-09 08:30:00 +0800"/>
  </HealthData>`);
  try {
    const created = f.worker.create(input);
    const deadline = Date.now() + 50_000;
    while (f.worker.isRunning) {
      assert.ok(Date.now() < deadline, "real failed import did not finalize");
      await new Promise((done) => setTimeout(done, 25));
    }
    const internal = new RuntimeStateStore(f.root).job(created.id)!;
    assert.equal(internal.status, "failed");
    assert.equal(internal.error, "direct_sync_internal_integrity:not_queued",
      "内部诊断必须是稳定码形式（机器面）；公开层只拿通用文案");
    assert.equal(f.worker.latest()?.error, PUBLIC_IMPORT_FAILURE_ERROR);
    assert.deepEqual(
      readdirSync(join(f.root, "var")).filter((name) => name.startsWith("rai.importing")),
      [],
      "收口后不得产生任何 staging/候选数据库");
    const live = await RaiDatabase.open(join(f.root, "rai.sqlite"));
    try {
      assert.equal(live.database.prepare("SELECT COUNT(*) AS n FROM workouts").get()?.n, 0,
        "失败批次不得写入任何事实");
    } finally { live.close(); }
  } finally { await f.close(); }
});

test("import command reports empty-output exits", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.surface.command(["-e", "process.exitCode = 3;"]),
      /code=3, signal=none/);
  } finally { await f.close(); }
});

test("import command reports terminating signals",
  { skip: process.platform === "win32" }, async () => {
    const f = fixture();
    try {
      await assert.rejects(f.surface.command(["-e", "process.kill(process.pid, 'SIGTERM');"]),
        /code=null, signal=SIGTERM/);
    } finally { await f.close(); }
  });

test("失败批次的诊断跨清理与重启保持，且不泄漏到公共/移动端 DTO（S3.3：收口路径）",
  { timeout: 10_000 }, async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例把候选 CLI 的调用点改写成抛一条带用户路径的
  // 错误，断言"内部诊断保留原文、公共层只拿到通用文案、跨重启一致"。CLI 调用链已删除，那条
  // 注入通道不再可达（收口后可达的失败不再携带用户路径）。保留的判据换成同一份**分层纪律**
  // 在收口路径上的验证：内部诊断 = 稳定码形式；公共/移动端 DTO 恒为通用文案；跨重启一致；
  // sourceId 索引一致。
  const f = fixture();
  let restarted: ImportWorker | undefined;
  writeFileSync(join(f.root, "export.xml"), "<HealthData/>");
  try {
    const created = f.worker.create(f.root, undefined, "source-fixture");
    const deadline = Date.now() + 8_000;
    while (f.worker.isRunning) {
      assert.ok(Date.now() < deadline, "failed import did not finalize");
      await new Promise((done) => setTimeout(done, 20));
    }
    const state = new RuntimeStateStore(f.root);
    assert.equal(state.job(created.id)?.status, "failed");
    assert.equal(state.job(created.id)?.error, "direct_sync_internal_integrity:not_queued",
      "内部诊断必须是稳定码形式（机器面）");
    assert.equal(f.worker.get(created.id)?.error, PUBLIC_IMPORT_FAILURE_ERROR);
    assert.equal(mobileRefreshOutcome(f.worker.latest())?.error, PUBLIC_IMPORT_FAILURE_ERROR);
    await f.worker.close();
    restarted = new ImportWorker(join(f.root, "rai.sqlite"), f.root, f.root);
    assert.equal(restarted.get(created.id)?.error, PUBLIC_IMPORT_FAILURE_ERROR);
    assert.equal(restarted.findBySourceId("source-fixture")?.error, PUBLIC_IMPORT_FAILURE_ERROR);
    assert.equal(mobileRefreshOutcome(restarted.latest())?.error, PUBLIC_IMPORT_FAILURE_ERROR);
    assert.equal(state.job(created.id)?.error, "direct_sync_internal_integrity:not_queued",
      "重启不改变持久层里的内部诊断");
  } finally {
    await restarted?.close();
    await f.close();
  }
});
