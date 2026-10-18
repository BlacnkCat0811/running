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

export interface PublicationGuardCapableStore {
  publicationGuardState?: () => PublicationGuardState;
  /** Public accessor from `MobileGoalsStore` (preferred over private-field probing). */
  publicationInFlight?: () => boolean;
}

/**
 * Returns a guard reader when the goals store exposes one.
 *
 * The control-store owner may not have landed `publicationGuardState()` on every
 * code path yet (or a test double may not implement it). In that case callers
 * degrade to the control-digest check, which is the pre-guard behaviour.
 */
export function optionalPublicationGuard(store: PublicationGuardCapableStore): (() => PublicationGuardState) | undefined {
  const read = store.publicationGuardState;
  return typeof read === "function" ? () => read.call(store) : undefined;
}

/**
 * Guard reader for a plan read, with the publishing connection exempted.
 *
 * When the store is inside its own publication transaction the live pending
 * marker belongs to this process: it is the publisher revalidating its own
 * in-flight write (e.g. `/synced` computing `matchesCurrent`), not a cross-store
 * reader. Honoring the marker there would make every receipt registration fail
 * closed on itself. External writers cannot commit control state while that
 * transaction holds the write lock, so the control digest pair remains
 * sufficient in this window.
 */
export function planReadGuard(
  store: PublicationGuardCapableStore & { publicationTransaction?: boolean }
): (() => PublicationGuardState) | undefined {
  const readGuard = optionalPublicationGuard(store);
  if (readGuard === undefined) return undefined;
  // Prefer the store's public accessor; the private-field fallback keeps older
  // stores (and test doubles) working without a compile-time dependency.
  const publishing = typeof store.publicationInFlight === "function"
    ? store.publicationInFlight() === true
    : store.publicationTransaction === true;
  return publishing ? undefined : readGuard;
}

/** Reads the guard without letting a broken guard table mask a read failure. */
export function readSnapshotGuardSafe(
  readGuard: (() => PublicationGuardState) | undefined
): PublicationGuardState | null {
  if (!readGuard) return null;
  try {
    return readGuard();
  } catch {
    return null;
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
 * committed yet. A missing or failing guard degrades to the digest-only
 * behaviour. A pending marker older than the guard lease (crashed publisher)
 * does not block reads.
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
    const guardBefore = readSnapshotGuardSafe(options.readGuard);
    // A publication that is visibly in progress cannot produce a stable view:
    // skip the build instead of spending it on a snapshot we will discard.
    if (guardBefore !== null && isPublicationGuardPending(guardBefore, now())) continue;
    const control = options.readControl();
    // Digest before building: the caller's builder receives the snapshot and
    // must not be able to turn an unmoved store into a false mismatch.
    const controlDigest = digest(control);
    const result = options.build(control);
    const controlUnchanged = controlDigest === digest(options.readControl());
    const guardAfter = readSnapshotGuardSafe(options.readGuard);
    if (guardBefore !== null && guardAfter !== null &&
        publicationGuardChanged(guardBefore, guardAfter, now()) !== null) continue;
    if (controlUnchanged) return result;
  }
  throw options.changedError();
}
