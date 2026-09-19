import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RaiDatabase } from "@rai/storage-sqlite";

test("benchmark is opt-in and restores the same isolated baseline for both modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-benchmark-test-"));
  const main = join(root, "baseline.sqlite"), input = join(root, "export"), output = join(root, "report.json");
  mkdirSync(input);
  const store = await RaiDatabase.open(main);
  store.close();
  writeFileSync(join(input, "export.xml"), `<HealthData>
    <Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Apple Watch" sourceVersion="1"
      duration="30" durationUnit="min" totalDistance="5" totalDistanceUnit="km"
      creationDate="2026-01-01 08:00:00 +0800" startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:30:00 +0800"/>
  </HealthData>`);
  const run = (...extra: string[]) => spawnSync(process.execPath, [
    "--import", "tsx", "apps/api/src/benchmark-import.ts", "--database", main,
    "--input", input, "--output", output, "--runs", "1", ...extra
  ], { cwd: resolve(import.meta.dirname, "../../.."), encoding: "utf8", timeout: 90_000 });
  try {
    const dry = run();
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /"dryRun": true/);
    assert.equal(existsSync(output), false);
    const executed = run("--execute");
    assert.equal(executed.status, 0, executed.stderr);
    const report = JSON.parse(readFileSync(output, "utf8")) as {
      evaluatedAt: string;
      results: Array<{ mode: string; job: { status: string; summary: { insertedWorkouts: number } } }>;
    };
    assert.ok(report.evaluatedAt);
    assert.deepEqual(report.results.map((item) => item.mode), ["shadow", "off"]);
    assert.deepEqual(report.results.map((item) => item.job.status), ["succeeded", "succeeded"]);
    assert.deepEqual(report.results.map((item) => item.job.summary.insertedWorkouts), [1, 1]);
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
    const baseline = new DatabaseSync(main, { readOnly: true });
    try {
      assert.equal((baseline.prepare("SELECT COUNT(*) AS n FROM training_sessions").get() as { n: number }).n, 0);
      assert.equal((baseline.prepare("SELECT COUNT(*) AS n FROM model_runs").get() as { n: number }).n, 0);
    } finally { baseline.close(); }
    assert.notEqual(run("--execute").status, 0, "an existing report must never be overwritten");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
