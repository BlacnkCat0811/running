import type { DatabaseSync } from "node:sqlite";

/**
 * Manually entered race results (docs/ALGORITHM.md §12.10).
 *
 * The label pipeline accepted only labels attached to a training session, so a
 * runner whose races predate the watch — the exact state the project review
 * recorded as "零有效比赛/测试标签" — could never produce a label. This table is the
 * missing door, and it is the prerequisite for any personal calibration.
 *
 * `revoked_at` is a tombstone rather than a delete: T03 requires a withdrawn label
 * to propagate its invalidation, which a missing row cannot do.
 */
export function migrateModelV27(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE performance_entries (
      id TEXT PRIMARY KEY,
      local_date TEXT NOT NULL,
      distance TEXT NOT NULL CHECK(distance IN ('five_k', 'ten_k', 'half_marathon')),
      duration_seconds REAL NOT NULL CHECK(duration_seconds > 0),
      source TEXT NOT NULL CHECK(source IN ('manual')),
      note TEXT,
      recorded_at TEXT NOT NULL,
      revoked_at TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1)
    );

    CREATE INDEX idx_performance_entries_recorded ON performance_entries(recorded_at);
    CREATE INDEX idx_performance_entries_date ON performance_entries(local_date);
  `);
}
