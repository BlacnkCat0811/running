import type { DatabaseSync } from "node:sqlite";

/**
 * Cross-store publication guard (2026-10-18, review P2-2 / batch-A residual).
 *
 * Plan state lives in two SQLite files: the main facts database (imports,
 * analysis publications, canonical facts) and the control database (goals,
 * plan history, publication operations). SQLite gives snapshot isolation per
 * database, and a transaction cannot commit atomically across both files. A
 * reader that only compares "control digest before" with "control digest after"
 * can still observe a main-database commit whose control commit has not
 * happened yet — the narrow window the reviewer flagged.
 *
 * The guard closes that window without locking readers out:
 *
 * 1. A publisher increments `epoch` and sets `pending_since` in a **separate,
 *    committed** control transaction *before* it writes the main database.
 * 2. It performs the main + control publication, then clears `pending_since`.
 * 3. A reader reads the guard before building and again after building. If the
 *    epoch changed or a non-stale publication is pending, the snapshot may mix
 *    two publications, so it retries (bounded) and finally fails closed.
 *
 * Because the pending marker is committed *before* the main write, any mixed
 * read is detectable: a reader that saw the old control state either sees the
 * new epoch/pending marker afterwards, or the publisher had not started yet
 * (so its main write cannot be visible either).
 *
 * `pending_since` is a lease, not a lock: a process that dies between marking
 * and clearing leaves a stale marker. After `PUBLICATION_GUARD_STALE_MS` readers
 * may ignore it; the next publication also refreshes it when it starts.
 *
 * Callers own the surrounding transactions. `beginPublicationGuard` and
 * `endPublicationGuard` must run inside (and be committed by) their own control
 * write transaction; `readPublicationGuard` works on any connection.
 */
export const PUBLICATION_GUARD_STALE_MS = 120_000;

export interface PublicationGuardState {
  /** Monotonic publication counter. Changes on every publication start. */
  epoch: number;
  /** ISO timestamp of the publication that is currently applying, if any. */
  pendingSince: string | null;
}

export function ensurePublicationGuardSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mobile_publication_guard (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch INTEGER NOT NULL DEFAULT 0,
      pending_since TEXT
    );
  `);
  database.prepare(
    "INSERT OR IGNORE INTO mobile_publication_guard(id, epoch, pending_since) VALUES (1, 0, NULL)"
  ).run();
}

export function readPublicationGuard(database: DatabaseSync): PublicationGuardState {
  const row = database.prepare("SELECT epoch, pending_since FROM mobile_publication_guard WHERE id = 1")
    .get() as { epoch: number; pending_since: string | null } | undefined;
  return {
    epoch: typeof row?.epoch === "number" ? row.epoch : 0,
    pendingSince: row?.pending_since ?? null
  };
}

/**
 * Marks a publication as in progress and returns the new state.
 *
 * The caller must hold a control write transaction and commit it before
 * touching the main database. Returns the caller's `now` timestamp so a caller
 * that passes a clock can clear exactly the marker it set.
 */
export function beginPublicationGuard(database: DatabaseSync, now: Date = new Date()): PublicationGuardState {
  const pendingSince = now.toISOString();
  database.prepare(
    "UPDATE mobile_publication_guard SET epoch = epoch + 1, pending_since = ? WHERE id = 1"
  ).run(pendingSince);
  return readPublicationGuard(database);
}

/** Clears the pending marker; safe to call repeatedly and after a rollback. */
export function endPublicationGuard(database: DatabaseSync): void {
  database.prepare("UPDATE mobile_publication_guard SET pending_since = NULL WHERE id = 1").run();
}

/**
 * Clears a marker a previous process left behind, when this process opens the
 * control database (review P3-14).
 *
 * A publication commits its `pending_since` marker *before* the business
 * transaction and clears it afterwards. A process killed in between (SIGKILL,
 * power loss) therefore leaves a marker that no live publisher owns, and the
 * lease alone keeps every guarded read closed for up to
 * `PUBLICATION_GUARD_STALE_MS` (120 s) after a quick restart — even though a
 * publication from a dead process can never still be in flight.
 *
 * The epoch is preserved: it is how guarded readers detect a publication that
 * committed on only one of the two databases, and it must stay comparable with
 * the epochs those readers observed before the restart.
 *
 * The API holds `acquireDatabasePublicationLock` for its whole lifetime, and the
 * control database is a single-writer store, so at startup no *other* live
 * publisher can exist. Running this from a CLI or a second process is out of
 * scope for the same reason the lock exists.
 *
 * Returns whether a marker was cleared (diagnostics/tests).
 */
export function clearPublicationMarkerOnStartup(database: DatabaseSync): boolean {
  const row = database.prepare("SELECT pending_since FROM mobile_publication_guard WHERE id = 1")
    .get() as { pending_since: string | null } | undefined;
  if (row?.pending_since == null) return false;
  endPublicationGuard(database);
  return true;
}

/**
 * True when a publication marker is present and still inside its lease.
 *
 * A malformed timestamp is treated as pending (fail closed) rather than as
 * stale, so a corrupted marker cannot silently disable the check.
 */
export function isPublicationGuardPending(
  state: PublicationGuardState,
  nowMs: number = Date.now(),
  staleMs: number = PUBLICATION_GUARD_STALE_MS
): boolean {
  if (state.pendingSince === null) return false;
  const since = Date.parse(state.pendingSince);
  if (!Number.isFinite(since)) return true;
  return nowMs - since < staleMs;
}

/**
 * Returns why a snapshot is unsafe to return, or `null` when it is consistent.
 *
 * Both guards come from the same read function; callers must read the state
 * once before the build and once after it.
 */
export function publicationGuardChanged(
  before: PublicationGuardState,
  after: PublicationGuardState,
  nowMs: number = Date.now(),
  staleMs: number = PUBLICATION_GUARD_STALE_MS
): "pending_publication" | "publication_epoch_changed" | null {
  if (isPublicationGuardPending(before, nowMs, staleMs) || isPublicationGuardPending(after, nowMs, staleMs)) {
    return "pending_publication";
  }
  if (before.epoch !== after.epoch) return "publication_epoch_changed";
  return null;
}
