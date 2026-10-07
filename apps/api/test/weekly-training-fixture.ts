import assert from "node:assert/strict";
import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";

/** Four complete 30/50 km weeks, with no runs in the current calendar week. */
export async function seedRecentRunningWeeks(databasePath: string, today: string, weeklyKm: number): Promise<void> {
  const store = await RaiDatabase.open(databasePath);
  try {
    const monday = new Date(`${today}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const workout = store.database.prepare(`
      INSERT INTO workouts (id, activity_type, source_name, source_category, start_at, end_at,
        duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical)
      VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture Watch', 'apple_watch', ?, ?, ?, 0, '{}', '{}', 1)
    `);
    const distance = store.database.prepare(`
      INSERT INTO workout_statistics (workout_id, ordinal, type, unit, sum_value)
      VALUES (?, 0, 'HKQuantityTypeIdentifierDistanceWalkingRunning', 'km', ?)
    `);
    const override = store.database.prepare(`
      INSERT INTO workout_overrides (id, training_session_id, revision, eligibility_override, condition_tags_json)
      VALUES (?, ?, 1, 'include', '[]')
    `);
    const insert = store.database.prepare(`
      INSERT INTO training_sessions (id, activity_type, anchor_start_at, anchor_end_at,
        anchor_distance_km, canonical_workout_id, status)
      VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, ?, ?, 'active')
    `);
    for (let week = 1; week <= 4; week += 1) {
      for (const day of [0, 2, 4]) {
        const start = new Date(monday.getTime() + (day - week * 7) * 86_400_000 + 3_600_000);
        const id = `weekly-fixture-${week}-${day}`;
        const end = new Date(start.getTime() + weeklyKm / 3 * 360_000).toISOString();
        workout.run(id, start.toISOString(), end, weeklyKm / 3 * 360);
        distance.run(id, weeklyKm / 3);
        insert.run(id, start.toISOString(), end, weeklyKm / 3, id);
        override.run(`${id}-override`, id);
      }
    }
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: `${today}T04:00:00Z`, timezoneIdentifier: "Asia/Shanghai" });
    assert.equal(service.runNextJob()?.status, "succeeded");
  } finally { store.close(); }
}
