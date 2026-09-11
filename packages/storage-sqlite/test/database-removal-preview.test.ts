import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiDatabase } from "../src/database.js";

function insertWorkout(store: RaiDatabase, id: string, startAt: string): void {
  store.database
    .prepare(`
      INSERT INTO workouts (
        id, activity_type, source_name, source_category, start_at, end_at,
        duration_seconds, metadata_json, raw_attributes_json
      ) VALUES (?, 'HKWorkoutActivityTypeRunning', 'Watch', 'apple_watch', ?, ?, 1800, '{}', '{}')
    `)
    .run(id, startAt, startAt);
}

function stampGeneration(store: RaiDatabase, id: string, generation: string): void {
  store.database
    .prepare(`
      INSERT INTO import_entity_generations (entity_kind, entity_id, generation, content_hash, effective_at)
      VALUES ('workout', ?, ?, 'seed', '2026-01-01T00:00:00.000Z')
    `)
    .run(id, generation);
}

test("previewGenerationRemoval projects deletions without touching rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-removal-preview-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    insertWorkout(store, "workout-a", "2026-01-01T00:00:00.000Z");
    insertWorkout(store, "workout-b", "2026-01-02T00:00:00.000Z");
    insertWorkout(store, "workout-c", "2026-01-03T00:00:00.000Z");
    stampGeneration(store, "workout-a", "full-import");
    stampGeneration(store, "workout-b", "full-import");
    stampGeneration(store, "workout-c", "generation-current");

    const preview = store.previewGenerationRemoval("generation-current");
    assert.equal(preview.workouts, 2, "only entities from other generations are projected");
    assert.equal(preview.records, 0);
    assert.equal(preview.total, 2);
    assert.equal(store.countImportableEntities(), 3);

    const rows = store.database.prepare("SELECT COUNT(*) AS count FROM workouts").get() as { count: number };
    assert.equal(rows.count, 3, "a preview must never delete");

    const finalized = store.finalizeImportGeneration("generation-current");
    assert.equal(finalized.removedWorkouts, 2);
    assert.equal(store.previewGenerationRemoval("generation-current").total, 0);
    assert.equal(store.countImportableEntities(), 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a complete re-import leaves the removal projection at zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-removal-complete-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    // Seed a "previous" generation, mimicking seedImportGenerations on a live db.
    insertWorkout(store, "workout-a", "2026-01-01T00:00:00.000Z");
    insertWorkout(store, "workout-b", "2026-01-02T00:00:00.000Z");
    stampGeneration(store, "workout-a", "generation-previous");
    stampGeneration(store, "workout-b", "generation-previous");

    // A complete payload re-stamps every entity with the incoming generation,
    // which is exactly what the parser does per matched workout id.
    store.database
      .prepare("UPDATE import_entity_generations SET generation = ? WHERE entity_kind = 'workout'")
      .run("generation-next");

    assert.equal(
      store.previewGenerationRemoval("generation-next").total,
      0,
      "re-importing complete history must not project any deletion"
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
