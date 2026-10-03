import type { DatabaseSync } from "node:sqlite";
import { SQL_UTC_OFFSET_MODIFIER } from "@rai/contracts";

export function migrateModelV29(database: DatabaseSync): void {
  database.exec(`
    DROP TRIGGER performance_entry_link_invalidation;
    -- Match the date/distance event association used by prediction-data loaders.
    CREATE TRIGGER performance_entry_link_invalidation AFTER INSERT ON performance_entries
    WHEN NEW.training_session_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM training_sessions session
      WHERE date(session.anchor_end_at, '${SQL_UTC_OFFSET_MODIFIER}') = NEW.local_date
        AND session.anchor_distance_km BETWEEN
          (CASE NEW.distance WHEN 'five_k' THEN 5 WHEN 'ten_k' THEN 10 ELSE 21.0975 END) * 0.9
          AND (CASE NEW.distance WHEN 'five_k' THEN 5 WHEN 'ten_k' THEN 10 ELSE 21.0975 END) * 1.1
    ) BEGIN
      UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
      DELETE FROM active_prediction_model;
    END;

    -- Prior unlinked replacements may already have changed model dependencies.
    UPDATE prediction_label_state SET revision = revision + 1 WHERE singleton = 1;
    DELETE FROM active_prediction_model;
  `);
}
