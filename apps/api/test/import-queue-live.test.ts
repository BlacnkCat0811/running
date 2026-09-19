import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ImportWorker } from "../src/import-worker.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { readImportReceipt } from "../src/import-publication.js";

test("real queued imports parse, analyze off-thread, shadow-check, publish receipts, and recover results", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-live-queue-"));
  const main = join(root, "main.sqlite");
  const project = resolve(import.meta.dirname, "../../..");
  let worker: ImportWorker | undefined;
  const input = (day: string) => {
    const directory = join(root, day);
    mkdirSync(directory);
    writeFileSync(join(directory, "export.xml"), `<HealthData>
      <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Apple Watch" sourceVersion="1"
        duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="km"
        creationDate="${day} 08:00:00 +0800" startDate="${day} 08:00:00 +0800" endDate="${day} 08:30:00 +0800">
        <MetadataEntry key="RAIHealthKitWorkoutUUID" value="fixture-${day}"/>
      </Workout>
    </HealthData>`);
    writeFileSync(join(directory, "sync-manifest.json"), JSON.stringify({
      version: 1, sourceScope: "healthkit", sourceEntityType: "HKWorkoutActivityTypeRunning",
      sourceIds: [`fixture-${day}`], deletedSourceIds: []
    }));
    return directory;
  };
  const make = () => new ImportWorker(main, project, root, undefined, undefined, undefined, "shadow", {
    scope: "fixture", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
  });
  const wait = async () => {
    const deadline = Date.now() + 90_000;
    while (worker!.hasPending || worker!.isRunning) {
      assert.ok(Date.now() < deadline, "real import timed out");
      await new Promise((done) => setTimeout(done, 50));
    }
  };
  try {
    worker = make();
    const first = worker.create(input("2026-01-01"), undefined, "source-first");
    await wait();
    assert.equal(worker.get(first.id)?.status, "succeeded", JSON.stringify(worker.get(first.id)));
    assert.ok(readImportReceipt(main, first.id));
    const second = worker.create(input("2026-01-03"), undefined, "source-second");
    await wait();
    const result = worker.get(second.id)!;
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.performance?.validationMode, "shadow");
    assert.ok(result.performance?.stagesMs.changeAnalysis! > 0);
    assert.ok(result.performance?.computeStagesMs?.shadowValidation! > 0);
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
