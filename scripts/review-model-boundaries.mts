#!/usr/bin/env node
// Adversarial review probes, intentionally separate from the passing regression
// suite. All databases and health XML are synthetic and removed in finally.
// Exit 1 means a reviewed invariant was violated; exit 2 means the probe failed.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RaiApplicationService, buildBaselineRebaseReview } from "@rai/application";
import { healthTypes, workoutTypes } from "@rai/contracts";
import { canonicalizeRunningWorkouts, parseAppleHealthXml } from "@rai/health-export-parser";
import { defaultRaiModelConfig, type RaiModelConfig } from "@rai/scoring";
import { RaiDatabase, SqliteModelRunRepository } from "@rai/storage-sqlite";

const asOf = "2026-01-31T04:00:00.000Z";
const options = { evaluatedAt: asOf, timezoneIdentifier: "Asia/Shanghai" };
const { values } = parseArgs({ options: { out: { type: "string" } } });
const results: Array<Record<string, unknown> & { id: string; violation: boolean }> = [];

async function fixture(run: (store: RaiDatabase, service: RaiApplicationService) => void) {
  const root = mkdtempSync(join(tmpdir(), "rai-review-boundary-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"), { createMigrationBackup: false });
  try {
    const date = (day: number, minute: string) =>
      `2026-01-${String(day).padStart(2, "0")} 08:${minute}:00 +0800`;
    const body = Array.from({ length: 10 }, (_, index) => {
      const day = 1 + index * 3;
      return `<Workout workoutActivityType="${workoutTypes.running}" duration="30" durationUnit="min"
        sourceName="Fixture Apple Watch" sourceVersion="1" creationDate="${date(day, "31")}"
        startDate="${date(day, "00")}" endDate="${date(day, "30")}" device="Watch">
        <MetadataEntry key="HKIndoorWorkout" value="0"/>
        <WorkoutStatistics type="${healthTypes.distanceWalkingRunning}" startDate="${date(day, "00")}"
          endDate="${date(day, "30")}" sum="${5 + index * 0.08}" unit="km"/>
        <WorkoutStatistics type="${healthTypes.heartRate}" startDate="${date(day, "00")}"
          endDate="${date(day, "30")}" average="${145 + index}" minimum="120" maximum="172" unit="count/min"/>
        </Workout>` + Array.from({ length: 15 }, (_, sample) =>
        `<Record type="${healthTypes.heartRate}" sourceName="Fixture Apple Watch" sourceVersion="1" unit="count/min"
          creationDate="${date(day, "31")}" startDate="${date(day, String(sample * 2).padStart(2, "0"))}"
          endDate="${date(day, String(sample * 2 + 1).padStart(2, "0"))}" value="${140 + index + sample % 3}"/>`
      ).join("");
    }).join("");
    const xml = join(root, "export.xml");
    writeFileSync(xml, `<HealthData><Me biologicalSex="HKBiologicalSexMale"/>${body}</HealthData>`);
    await parseAppleHealthXml(xml, store, { fileSize: 1 });
    canonicalizeRunningWorkouts(store.database);
    run(store, new RaiApplicationService(store));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function execute(service: RaiApplicationService, modelConfig?: RaiModelConfig, evaluatedAt = asOf): string {
  service.enqueueFullRecompute({ ...options, evaluatedAt, ...(modelConfig ? { modelConfig } : {}) });
  const job = service.runNextJob();
  if (job?.status !== "succeeded" || !job.modelRunId) {
    throw new Error(`Probe prerequisite recompute failed: ${JSON.stringify(job)}`);
  }
  return job.modelRunId;
}

try {
  await fixture((store, service) => {
    // appendWorkoutOverride uses the current clock for its queued recompute.
    // Keep the incumbent at that same date, rather than accidentally measuring
    // eight months of inactivity decay in the override/rollback probe.
    const evaluatedAt = new Date().toISOString();
    execute(service, undefined, evaluatedAt);
    const target = String(store.database.prepare(`SELECT training_session_id AS id
      FROM active_ability_assessments ORDER BY sequence_number DESC LIMIT 1`).get()?.id);
    const initial = String(store.database.prepare("SELECT model_run_id AS id FROM active_model_run").get()?.id);
    service.appendWorkoutOverride({
      trainingSessionId: target, eligibilityOverride: "exclude", expectedRevision: 0,
      sessionType: null, performanceProtocol: null, rpe: null, conditionTags: [], note: null
    });
    const job = service.runNextJob();
    if (job?.status !== "succeeded") throw new Error(`Override prerequisite failed: ${JSON.stringify(job)}`);
    const status = () => store.database.prepare(`SELECT assessment_status AS status
      FROM active_ability_assessments WHERE training_session_id=?`).get(target)?.status;
    const before = status();
    let refused = false;
    try { new SqliteModelRunRepository(store.database).activateSucceeded(initial, new Date().toISOString()); }
    catch { refused = true; }
    const after = status();
    const effectiveOverride = store.database.prepare(`SELECT eligibility_override AS status
      FROM effective_workout_overrides WHERE training_session_id=?`).get(target)?.status;
    results.push({ id: "R1", violation: !refused && effectiveOverride === "exclude" && after !== "excluded",
      refused, effectiveOverride, before, after, evaluatedAt });
  });
  await fixture((store, service) => {
    execute(service);
    store.database.exec("UPDATE training_sessions SET status='inactive',canonical_workout_id=NULL");
    store.setManifest("dataset_version", "after_confirmed_removal");
    store.flush();
    service.enqueueFullRecompute(options);
    const job = service.runNextJob();
    const remainingPublishedRows = Number(store.database.prepare(
      "SELECT COUNT(*) AS n FROM active_ability_assessments").get()?.n ?? 0);
    results.push({ id: "R2", violation: job?.status !== "succeeded" || remainingPublishedRows !== 0,
      jobStatus: job?.status, error: job?.error ?? null, remainingPublishedRows });
  });
  await fixture((store, service) => {
    execute(service);
    const config = { ...defaultRaiModelConfig, baselineReferenceStartAt: "2026-01-04T00:00:00.000Z" };
    const origin = execute(service, config);
    const before = buildBaselineRebaseReview(store.database, { asOf });
    for (let round = 0; round < 3; round++) execute(service, config);
    const after = buildBaselineRebaseReview(store.database, { asOf });
    results.push({ id: "R3", violation: before.epoch.startedAt !== after.epoch.startedAt,
      before: before.epoch.startedAt, after: after.epoch.startedAt,
      sameEpoch: before.epoch.epochId === after.epoch.epochId,
      originReceiptRetained: Boolean(store.database.prepare(
        "SELECT 1 FROM model_release_bundles WHERE model_run_id=?").get(origin)) });
  });
  const report = { version: "rai-model-boundary-review-v1", writes: "synthetic_temporary_databases_only",
    results, violationCount: results.filter((result) => result.violation).length };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (values.out) {
    const out = resolve(values.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
  process.stdout.write(json);
  process.exitCode = report.violationCount ? 1 : 0;
} catch (error) {
  console.error(error);
  process.exitCode = 2;
}
