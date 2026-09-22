import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RaiDatabase } from "../src/database.js";
import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { canonicalizeRunningWorkouts } from "../src/canonicalize.js";

for (const incremental of [false, true]) test(`workout corrections preserve session identity (${incremental ? "incremental" : "full"} grouping)`, async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-canonical-correction-"));
  const store = await RaiDatabase.open(join(root, "db.sqlite"));
  try {
    let sessionId: unknown;
    for (const [index, distance] of [5, 10, 5].entries()) {
      const xml = join(root, "export.xml");
      writeFileSync(xml, `<HealthData><Workout workoutActivityType="HKWorkoutActivityTypeRunning" sourceName="Watch" startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:30:00 +0800" duration="30" durationUnit="min"><MetadataEntry key="HKMetadataKeySyncIdentifier" value="same-workout"/><WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="${distance}"/></Workout></HealthData>`);
      const parsed = await parseAppleHealthXml(xml, store, { fileSize: statSync(xml).size, incremental: { generation: `g${index}`, preserveAbsent: true } });
      canonicalizeRunningWorkouts(store.database, incremental ? { dirtyWorkoutTimes: parsed.dirtyWorkoutTimes ?? [] } : undefined);
      const rows = store.database.prepare("SELECT id, anchor_distance_km, status FROM training_sessions").all();
      assert.equal(rows.length, 1);
      sessionId ??= rows[0]!.id;
      assert.equal(rows[0]!.id, sessionId);
      assert.equal(rows[0]!.anchor_distance_km, distance);
      assert.equal(rows[0]!.status, "active");
    }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
