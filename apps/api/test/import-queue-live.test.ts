import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CONTRACT_VERSION } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import { identityAlgorithmFingerprint } from "@rai/health-export-parser";
import { ImportWorker } from "../src/import-worker.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { readImportReceipt } from "../src/import-publication.js";

test("真实排队直连：Workout 增量走统一接收器（离线程执行）、回执落盘、跨重启可恢复", async () => {
  // 2026-10-14（S3.3）**改写而非删除**：原用例让**真实项目根的候选 CLI**（子进程解析、
  // 影子校验、发布回执）跑两批。候选链路已删除；本用例保留"真实排队导入端到端"的判据，
  // 改用直连车道的资格形态：v2 清单（recordIdentity 齐备）+ 五项身份齐备的库 ⇒ 统一接收器
  // 在同一事务里落事实（Workout + canonical session）并在需要时登记分析；"离线程执行"由阶段
  // 账本里的 `directSyncApply` 留痕（它跑在真实工作者线程里）。清单从 v1 升到 v2：v1 载荷在
  // 收口后会被 `missing_record_identity` 显式拒收（该拒因由 direct-sync-ingest 拒收码词典覆盖）。
  const root = mkdtempSync(join(tmpdir(), "rai-live-queue-"));
  const main = join(root, "main.sqlite");
  const project = resolve(import.meta.dirname, "../../..");
  let worker: ImportWorker | undefined;
  const input = (day: string, uuid: string) => {
    const directory = join(root, day);
    mkdirSync(directory);
    writeFileSync(join(directory, "export.xml"), `<HealthData>
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Apple Watch" sourceVersion="1"
        duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="km"
        creationDate="${day} 08:00:00 +0800" startDate="${day} 08:00:00 +0800" endDate="${day} 08:30:00 +0800">
        <MetadataEntry key="RAIHealthKitWorkoutUUID" value="${uuid}"/>
      </Workout>
    </HealthData>`);
    writeFileSync(join(directory, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
    }));
    return directory;
  };
  const make = () => new ImportWorker(main, project, root, () => {
    // 第 4 个参数是"进入替换/发布门"的回调。它一旦被调用，就说明这批走了旧候选链路。
    throw new Error("delta must not enter the replacement gate");
  }, undefined, undefined, {
    scope: "fixture", dataOnlyFastPath: true,
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
  });
  const wait = async () => {
    const deadline = Date.now() + 90_000;
    while (worker!.hasPending || worker!.isRunning) {
      assert.ok(Date.now() < deadline, "real import timed out");
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  try {
    const store = await RaiDatabase.open(main);
    store.setManifest("dataset_version", "baseline");
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
    store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
    store.close();
    worker = make();
    const first = worker.create(input("2026-01-01", "00000000-0000-0000-0000-0000000000a1"), undefined, "source-first");
    await wait();
    assert.equal(worker.get(first.id)?.status, "succeeded", JSON.stringify(worker.get(first.id)));
    assert.ok(readImportReceipt(main, first.id));
    assert.equal(worker.get(first.id)?.performance?.lane?.outcome, "direct");
    assert.equal(worker.get(first.id)?.performance?.lane?.directSource, "direct-sync");
    const second = worker.create(input("2026-01-03", "00000000-0000-0000-0000-0000000000a2"), undefined, "source-second");
    await wait();
    const result = worker.get(second.id)!;
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.performance?.validationMode, "not-run");
    assert.ok(result.performance?.stagesMs.directSyncApply! > 0,
      "统一接收器必须真的跑了（真实工作者线程里的离线程执行）");
    assert.ok(readImportReceipt(main, second.id));
    const db = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM training_sessions").get() as { n: number }).n, 2);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
    await worker.close();
    worker = make();
    assert.equal(worker.findBySourceId("source-second")?.id, second.id);
    assert.equal(worker.get(second.id)?.status, "succeeded");
    assert.equal(worker.hasPending, false);
  } finally {
    await worker?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
