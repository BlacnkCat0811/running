import type { DatabaseSync } from "node:sqlite";

export function migrateModelV28(database: DatabaseSync): void {
  database.exec(`
    -- Keep event provenance even when an import removes the original session.
    -- References are validated on entry; loaders refuse missing/inactive sources.
    ALTER TABLE performance_entries ADD COLUMN training_session_id TEXT;
    ALTER TABLE performance_entries ADD COLUMN observed_at TEXT;
    ALTER TABLE performance_entries ADD COLUMN completed_at TEXT;
    CREATE TABLE prediction_label_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      revision INTEGER NOT NULL
    );
    INSERT INTO prediction_label_state VALUES (1, 0);

    -- Old artifacts did not enforce event-level holdout. Keep their audit rows,
    -- but require retraining before publishing predictions with the new baseline.
    DELETE FROM active_prediction_model;

    CREATE TRIGGER performance_entry_invalidation
    AFTER UPDATE OF revoked_at, duration_seconds, local_date, distance, training_session_id, observed_at, completed_at
    ON performance_entries
    WHEN OLD.revoked_at IS NOT NEW.revoked_at OR OLD.duration_seconds IS NOT NEW.duration_seconds
      OR OLD.local_date IS NOT NEW.local_date OR OLD.distance IS NOT NEW.distance
      OR OLD.training_session_id IS NOT NEW.training_session_id
      OR OLD.observed_at IS NOT NEW.observed_at OR OLD.completed_at IS NOT NEW.completed_at
    BEGIN
      UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
      DELETE FROM active_prediction_model;
    END;
    CREATE TRIGGER performance_entry_delete_invalidation AFTER DELETE ON performance_entries BEGIN
      UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
      DELETE FROM active_prediction_model;
    END;
    CREATE TRIGGER performance_entry_link_invalidation AFTER INSERT ON performance_entries
    WHEN NEW.training_session_id IS NOT NULL BEGIN
      UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
      DELETE FROM active_prediction_model;
    END;
    CREATE TRIGGER workout_label_invalidation AFTER INSERT ON workout_overrides BEGIN
      UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
      DELETE FROM active_prediction_model;
    END;
    CREATE TRIGGER workout_label_delete_invalidation AFTER DELETE ON workout_overrides BEGIN
      UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
      DELETE FROM active_prediction_model;
    END;
    CREATE TRIGGER workout_label_update_invalidation AFTER UPDATE ON workout_overrides BEGIN
      UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
      DELETE FROM active_prediction_model;
    END;
    CREATE TRIGGER performance_session_update_invalidation
    AFTER UPDATE OF status, anchor_start_at, anchor_end_at, anchor_distance_km, canonical_workout_id ON training_sessions
    WHEN (OLD.status IS NOT NEW.status OR OLD.anchor_start_at IS NOT NEW.anchor_start_at
      OR OLD.anchor_end_at IS NOT NEW.anchor_end_at OR OLD.anchor_distance_km IS NOT NEW.anchor_distance_km
      OR OLD.canonical_workout_id IS NOT NEW.canonical_workout_id)
      AND (EXISTS (SELECT 1 FROM workout_overrides WHERE training_session_id = NEW.id)
        OR EXISTS (SELECT 1 FROM performance_entries WHERE training_session_id = NEW.id))
    BEGIN
      UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
      DELETE FROM active_prediction_model;
    END;
    CREATE TRIGGER performance_session_delete_invalidation AFTER DELETE ON training_sessions
    WHEN EXISTS (SELECT 1 FROM workout_overrides WHERE training_session_id = OLD.id)
      OR EXISTS (SELECT 1 FROM performance_entries WHERE training_session_id = OLD.id)
    BEGIN
      UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
      DELETE FROM active_prediction_model;
    END;
  `);
}
