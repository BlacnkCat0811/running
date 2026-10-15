import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeBinary, NATIVE_VERSION } from "@rai/health-export-parser";
import { createImportJobId, ImportWorker } from "../src/import-worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
const available = existsSync(nativeBinary());
if (process.env.RAI_REQUIRE_RUST_TESTS === "1" && !available) throw new Error("Rust binary required");

test("Rust jobs keep their engine across restart but the import path refuses them explicitly (engine_rust)", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-native-live-"));
  const input = join(root, "export"); mkdirSync(input);
  mkdirSync(join(input, "workout-routes"));
  writeFileSync(join(input, "workout-routes/route.gpx"), `<gpx><trk><trkseg>
    <trkpt lat="31" lon="121"><ele>1</ele><time>2026-01-01T00:00:00Z</time></trkpt>
    <trkpt lat="31.01" lon="121.01"><ele>3</ele><time>2026-01-01T00:00:05Z</time></trkpt>
  </trkseg></trk></gpx>`);
  writeFileSync(join(input, "export.xml"), `<HealthData>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" value="150"
      startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:00:05 +0800"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeRunning"
    sourceName="Apple Watch" duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="km"
    startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800">
      <WorkoutRoute><FileReference path="/workout-routes/route.gpx"/></WorkoutRoute>
    </Workout></HealthData>`);
  // S3 收口后两条车道都要求 v2 清单；缺它会在 lane 判定前就被拒（missing_required_files）。
  writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
    version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
  }));
  const mutations = new MutationCoordinator(), scheduler = new TaskAdmissionScheduler(mutations);
  const release = mutations.acquire("fixture");
  const create = (name: "rust" | "typescript") => new ImportWorker(
    join(root, "main.sqlite"), resolve(import.meta.dirname, "../../.."), root, undefined, undefined, undefined, {
      scope: "fixture", admission: scheduler.owner("import"), engine: { name, version: NATIVE_VERSION, fallback: "none" }
    }
  );
  let worker = create("rust");
  try {
    const job = worker.create(input, undefined, "source");
    assert.equal(job.executionEngine?.name, "rust");
    await worker.close();
    worker = create("typescript");
    assert.equal(worker.get(job.id)?.executionEngine?.name, "rust");
    release(); worker.resume();
    const deadline = Date.now() + 60_000;
    while (worker.hasPending || worker.isRunning) {
      assert.ok(Date.now() < deadline, JSON.stringify(worker.get(job.id)));
      await new Promise((done) => setTimeout(done, 50));
    }
    const done = worker.get(job.id)!;
    // 🔴 2026-10-14（S3.1 收口后的现实）：导入路径**结构上只接 TS**
    // （`planDirectSyncLane` 的 `engine_rust`；设计 §13 PR6「首版复用 TS 主写」）。
    // 旧世界 = 拒直连后回退 CLI 子进程（rust 的）并成功；回退删除后 rust job **显式失败**。
    // native 解码/增量链路的断言（rustCalls 等）随笔随行——native `apply-records` 解禁
    // 接入主库后，本用例应恢复为对 native 执行链的断言。
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.equal((done as { failureCode?: string }).failureCode, "direct_sync_unavailable");
    assert.deepEqual(done.performance?.lane?.reasons, ["engine_rust"],
      "拒绝理由必须点名引擎（而不是静默换引擎）");
  } finally { release(); await worker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("abandoned native spool cleanup preserves pending attempts and unrelated directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-native-sweep-"));
  const input = join(root, "export"); mkdirSync(input);
  writeFileSync(join(input, "export.xml"), "<HealthData/>");
  const mutations = new MutationCoordinator();
  const release = mutations.acquire("fixture");
  const worker = new ImportWorker(join(root, "main.sqlite"), root, root, undefined, undefined, undefined, {
    scope: "fixture", admission: new TaskAdmissionScheduler(mutations).owner("import")
  });
  try {
    const job = worker.create(input);
    const active = join(root, "var", `native.${job.id}.attempt-1`);
    const abandoned = join(root, "var", `native.${createImportJobId()}.attempt-1`);
    const unrelated = join(root, "var", "unrelated");
    const old = new Date(Date.now() - 25 * 3600_000);
    for (const path of [active, abandoned, unrelated]) { mkdirSync(path); utimesSync(path, old, old); }
    assert.equal(await worker.reclaimAbandonedNativeSpools(), 1);
    assert.equal(existsSync(active), true);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(abandoned), false);
  } finally { release(); await worker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("engine mismatch is refused explicitly instead of silently switching engines", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-native-version-"));
  const input = join(root, "export"); mkdirSync(input);
  writeFileSync(join(input, "export.xml"), "<HealthData/>");
  writeFileSync(join(input, "sync-manifest.json"), JSON.stringify({
    version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
  }));
  const worker = new ImportWorker(join(root, "main.sqlite"), resolve(import.meta.dirname, "../../.."), root,
    undefined, undefined, undefined, {
      scope: "fixture", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import"),
      engine: { name: "rust", version: "incompatible", fallback: "none" }
    });
  try {
    const job = worker.create(input, undefined, "version-source");
    const deadline = Date.now() + 60_000;
    while (worker.hasPending || worker.isRunning) {
      assert.ok(Date.now() < deadline, JSON.stringify(worker.get(job.id)));
      await new Promise((done) => setTimeout(done, 30));
    }
    const done = worker.get(job.id);
    // 收口后"不静默切换引擎"升级为"显式拒绝"：引擎不符时的挂起重试机制随候选链路
    // 退场（G4，2026-10-15：其写入端已一并退役），引擎不符的 job 直接失败并**保留输入**，
    // 供重试/诊断——绝不偷偷换成 TS 跑。
    assert.equal(done?.status, "failed", JSON.stringify(done));
    assert.equal((done as { failureCode?: string } | undefined)?.failureCode, "direct_sync_unavailable");
    assert.deepEqual(done?.performance?.lane?.reasons, ["engine_rust"]);
    assert.equal(existsSync(join(input, "export.xml")), true, "输入不得被静默消费");
    assert.equal(worker.activeInputPaths().includes(input), false, "终态后不得残留占用");
    assert.equal(await worker.cancel(job.id), "terminal", "终态任务不可再取消");
    assert.equal(worker.hasPending, false);
  } finally { await worker.close(); rmSync(root, { recursive: true, force: true }); }
});
