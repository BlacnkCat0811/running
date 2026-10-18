import { statSync } from "node:fs";

import { digest } from "./plan-digest.js";
import {
  isPublicationGuardPending,
  publicationGuardChanged,
  type PublicationGuardState
} from "./publication-guard.js";

const DEFAULT_ATTEMPTS = 3;
const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 5;

/** File system errors that mean "the database file is being replaced/changed". */
const TRANSIENT_FILE_IDENTITY_ERRORS = new Set(["ENOENT", "EACCES", "EIO", "ESTALE"]);

export interface SnapshotFileIdentity {
  ino: number;
  mtimeMs: number;
}

/**
 * Reads the identity of the database file that a read snapshot must match.
 *
 * `statSync` can throw while a publisher swaps the file (rename) or while an
 * operator replaces it out of band. Callers get `null` for those transient
 * states and retry; other errors still surface as real programming errors.
 */
export function readSnapshotFileIdentity(path: string): SnapshotFileIdentity | null {
  try {
    const stat = statSync(path);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (typeof code === "string" && TRANSIENT_FILE_IDENTITY_ERRORS.has(code)) return null;
    throw error;
  }
}

/**
 * Whether the file at the path is a *different* file than the one the snapshot
 * was built from.
 *
 * Only the inode decides (review P2-02). `mtime` is recorded for diagnostics and
 * must not participate: every WAL checkpoint writes pages back into the main
 * database file and moves its mtime without replacing the file — the read
 * connection keeps serving the same consistent snapshot. Treating that as
 * "published" made `GET /v1/mobile/training-plan-state` answer a retryable 503
 * whenever an import/recompute job happened to checkpoint during the read, a
 * false positive with no mixed snapshot behind it. `read-store-manager.ts`
 * documents the same reasoning for its cached connection (reopen on inode only).
 */
export function snapshotFileReplaced(before: SnapshotFileIdentity, after: SnapshotFileIdentity): boolean {
  return before.ino !== after.ino;
}

export interface PublicationGuardCapableStore {
  publicationGuardState?: () => PublicationGuardState;
}

/**
 * One guard read, classified instead of collapsed to `null`.
 *
 * Three outcomes must stay distinguishable:
 *
 * - `absent`: the store has no guard (no control database, or a test double).
 *   Callers degrade to the pre-guard digest-only check — that is not a failure,
 *   it is the documented fallback for stores without a guard.
 * - `ready`: the guard was read; `state` is authoritative.
 * - `failed`: the store *has* a guard but reading it threw. Silently degrading
 *   here would disable the cross-store check exactly when the control database
 *   is damaged, so callers must treat this as "the snapshot cannot be proven
 *   stable": retry, then fail closed (review P3-02).
 */
export type SnapshotGuardRead =
  | { kind: "absent" }
  | { kind: "failed" }
  | { kind: "ready"; state: PublicationGuardState };

/** Returns a guard reader when the goals store exposes one. */
export function optionalPublicationGuard(store: PublicationGuardCapableStore): (() => PublicationGuardState) | undefined {
  const read = store.publicationGuardState;
  return typeof read === "function" ? () => read.call(store) : undefined;
}

/**
 * Guard reader for a plan read.
 *
 * The reader is returned whenever the store supports the guard — including while
 * that same store is inside its own publication transaction (review P3-03).
 * `MobileGoalsStore.publicationGuardState()` already hides *its own* live
 * `pending_since` marker (the publisher revalidating its own write, e.g.
 * `/synced` computing `matchesCurrent`, must not fail closed on itself) while
 * preserving `epoch`, so the before/after epoch comparison still detects a
 * foreign publication that started in between. Suppressing the reader here as
 * well used to disable epoch detection for that whole transaction, which is
 * strictly weaker and no longer needed.
 */
export function planReadGuard(store: PublicationGuardCapableStore): (() => PublicationGuardState) | undefined {
  return optionalPublicationGuard(store);
}

/** Reads the guard once, classifying failure instead of swallowing it. */
export function readSnapshotGuard(readGuard: (() => PublicationGuardState) | undefined): SnapshotGuardRead {
  if (!readGuard) return { kind: "absent" };
  try {
    return { kind: "ready", state: readGuard() };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * Builds a result from a control-store snapshot only when that snapshot was
 * stable across the build, i.e. no control write landed between the cheap
 * control reads around the facts read.
 *
 * `CoachLoopRuntime.read()` used to read the control tables (saved receipt,
 * goals, plan history) once and then read training facts from the main store
 * inside a separate transaction. A control write between those reads (Monday
 * generation, another device's refresh/update) combined the old plan state with
 * new facts, and the returned `executionToken` still bound the old revision.
 * iOS schedules that response directly, so the mixed snapshot must fail closed
 * instead of being returned.
 *
 * Each attempt reads the control snapshot, builds the result, and re-reads the
 * control snapshot. Equal digests return that attempt's result; a change
 * retries against a fresh snapshot, and exhausting `attempts` (default 3,
 * clamped to 1..5) throws `changedError()`.
 *
 * When `readGuard` is supplied, a cross-store publication that starts (epoch
 * changes) or is still pending also discards the attempt — the control digest
 * alone cannot see a main-database commit whose control transaction has not
 * committed yet. A missing guard degrades to the digest-only behaviour; a guard
 * that *fails to read* does not (see {@link SnapshotGuardRead}). A pending marker
 * older than the guard lease (crashed publisher) does not block reads.
 *
 * ### Why the retries are synchronous (P3-15, deliberate)
 *
 * Attempts run back to back with no sleep. That is a decision, not an oversight:
 *
 * - the contended window is a *synchronous* publication on this event loop
 *   (`MobileGoalsStore.withPublicationTransaction` never awaits), so an
 *   in-process publish either starts and finishes inside our own inter-attempt
 *   gap — which the epoch check catches — or it cannot run at all while this
 *   loop is running. The cross-process case is bounded by the SQLite
 *   control-database write transaction, which is milliseconds, not seconds;
 * - sleeping between attempts while `/v1/mobile/workout-plan/synced` holds its
 *   control write transaction would extend the lock hold for every other
 *   writer, and the client already has the retry semantic it needs: a 503 with
 *   `Retry-After: 1` (see `api-error.ts`).
 *
 * Cost ceiling: at most `attempts` (≤ 5, default 3) control pairs and builds.
 * Measured on a ~42.6k-row synthetic library, `trainingPlanState`'s build is
 * p50 ≈ 15.7 ms / p95 ≈ 26.4 ms, so the worst case here is ~80 ms of synchronous
 * work before failing closed — the same order as one successful plan read.
 */
export function readStableSnapshot<Control, Result>(options: {
  readControl: () => Control;
  build: (control: Control) => Result;
  changedError: () => Error;
  attempts?: number;
  readGuard?: () => PublicationGuardState;
  /** Injectable clock (guard lease tests); production uses `Date.now`. */
  now?: () => number;
}): Result {
  const requested = options.attempts ?? DEFAULT_ATTEMPTS;
  const attempts = Number.isFinite(requested)
    ? Math.min(MAX_ATTEMPTS, Math.max(MIN_ATTEMPTS, Math.trunc(requested)))
    : DEFAULT_ATTEMPTS;
  const now = options.now ?? Date.now;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const guardBefore = readSnapshotGuard(options.readGuard);
    // An unreadable guard cannot prove the snapshot stable: fail closed instead
    // of silently disabling the cross-store check (review P3-02).
    if (guardBefore.kind === "failed") continue;
    // A publication that is visibly in progress cannot produce a stable view:
    // skip the build instead of spending it on a snapshot we will discard.
    if (guardBefore.kind === "ready" && isPublicationGuardPending(guardBefore.state, now())) continue;
    const control = options.readControl();
    // Digest before building: the caller's builder receives the snapshot and
    // must not be able to turn an unmoved store into a false mismatch.
    const controlDigest = digest(control);
    const result = options.build(control);
    const controlUnchanged = controlDigest === digest(options.readControl());
    const guardAfter = readSnapshotGuard(options.readGuard);
    if (guardAfter.kind === "failed") continue;
    if (guardBefore.kind === "ready" && guardAfter.kind === "ready" &&
        publicationGuardChanged(guardBefore.state, guardAfter.state, now()) !== null) continue;
    if (controlUnchanged) return result;
  }
  throw options.changedError();
}
