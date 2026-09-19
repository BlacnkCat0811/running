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

test("accepted Rust jobs keep their engine across restart and run the actual native decoder", { skip: !available }, async () => {
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
  const mutations = new MutationCoordinator(), scheduler = new TaskAdmissionScheduler(mutations);
  const release = mutations.acquire("fixture");
  const create = (name: "rust" | "typescript") => new ImportWorker(
    join(root, "main.sqlite"), resolve(import.meta.dirname, "../../.."), root, undefined, undefined, undefined, "shadow", {
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
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.equal(done.performance?.native?.health?.rustCalls, 1);
    assert.equal(done.performance?.native?.["apply-records"]?.rustCalls, 1);
    assert.equal(done.performance?.native?.aggregate?.rustCalls, 1);
    // New jobs use the new default. Restore Rust explicitly for the incremental
    // run, which must compare native aggregates against the independent TS replay.
    await worker.close();
    worker = create("rust");
    const second = join(root, "second"); mkdirSync(second);
    writeFileSync(join(second, "export.xml"), `<HealthData><Workout workoutActivityType="HKWorkoutActivityTypeRunning"
      sourceName="Apple Watch" duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="km"
      startDate="2026-01-03 08:00:00 +0800" endDate="2026-01-03 08:30:00 +0800"/></HealthData>`);
    const next = worker.create(second, undefined, "source-second");
    const nextDeadline = Date.now() + 60_000;
    while (worker.hasPending || worker.isRunning) {
      assert.ok(Date.now() < nextDeadline, JSON.stringify(worker.get(next.id)));
      await new Promise((done) => setTimeout(done, 50));
    }
    const nextResult = worker.get(next.id)!;
    assert.equal(nextResult.status, "succeeded", JSON.stringify(nextResult));
    assert.equal(nextResult.performance?.validationMode, "shadow");
    assert.ok(nextResult.performance?.computeStagesMs?.shadowValidation! > 0);
    assert.equal(nextResult.performance?.native?.aggregate?.rustCalls, 1);
  } finally { release(); await worker.close(); rmSync(root, { recursive: true, force: true }); }
});

test("abandoned native spool cleanup preserves pending attempts and unrelated directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-native-sweep-"));
  const input = join(root, "export"); mkdirSync(input);
  writeFileSync(join(input, "export.xml"), "<HealthData/>");
  const mutations = new MutationCoordinator();
  const release = mutations.acquire("fixture");
  const worker = new ImportWorker(join(root, "main.sqlite"), root, root, undefined, undefined, undefined, "shadow", {
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

test("engine mismatch retains the queued source rather than silently switching engines", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-native-version-"));
  const input = join(root, "export"); mkdirSync(input);
  writeFileSync(join(input, "export.xml"), "<HealthData/>");
  const worker = new ImportWorker(join(root, "main.sqlite"), resolve(import.meta.dirname, "../../.."), root,
    undefined, undefined, undefined, "shadow", {
      scope: "fixture", admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import"),
      engine: { name: "rust", version: "incompatible", fallback: "none" }
    });
  try {
    const job = worker.create(input, undefined, "version-source");
    const deadline = Date.now() + 30_000;
    while (worker.get(job.id)?.phase !== "waiting_engine" || worker.isRunning) {
      assert.ok(Date.now() < deadline, JSON.stringify(worker.get(job.id)));
      await new Promise((done) => setTimeout(done, 30));
    }
    assert.equal(worker.get(job.id)?.status, "queued");
    assert.ok(worker.activeInputPaths().includes(input));
    assert.equal(existsSync(join(input, "export.xml")), true);
    assert.equal(await worker.cancel(job.id), "cancelled");
    assert.equal(worker.hasPending, false);
  } finally { await worker.close(); rmSync(root, { recursive: true, force: true }); }
});
