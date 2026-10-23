/**
 * Test-only preload for the P2 delete + GPX pre-commit barrier.
 *
 * Loaded with `--import` in the real API server process **and** in its ingest
 * worker thread (worker threads inherit `process.execArgv`). It patches the
 * actual `RaiDatabase.open` used by the import transaction and registers a
 * SQLite scalar function on that same connection. The fixture's trigger calls
 * it after the delete and GPX writes have executed but before COMMIT.
 *
 * No production code reads this module or any environment variable; the
 * marker path is injected only by `direct-sync-http-acceptance.test.ts`.
 */
import { writeFileSync } from "node:fs";

import { register } from "tsx/esm/api";

// Worker threads inherit --import flags but may execute this preload before the
// bootstrap module calls register(); register explicitly so the package's TS
// source (with .js specifiers) resolves identically in main and worker threads.
register();
const { RaiDatabase } = await import("@rai/storage-sqlite");

const markerPath = process.env.RAI_PRECOMMIT_BARRIER_MARKER;
if (markerPath === undefined) {
  throw new Error("RAI_PRECOMMIT_BARRIER_MARKER is required by the pre-commit barrier fixture");
}

const originalOpen = RaiDatabase.open.bind(RaiDatabase);

RaiDatabase.open = async (...args) => {
  const store = await originalOpen(...args);
  // Registering on every connection is deliberate: the import transaction opens
  // its own connection inside the ingest worker; a main-thread registration
  // would never be visible to it.
  store.database.function("rai_hold_before_commit", (key, control, workouts, versions, points, tombstones) => {
    const values = [key, control, workouts, versions, points, tombstones];
    writeFileSync(markerPath, `${JSON.stringify({
      pid: process.pid,
      at: new Date().toISOString(),
      values: values.map((value) => value === null ? null : String(value))
    })}\n`);
    // Deterministic pause: the test kills this process with SIGKILL while the
    // real import transaction is still open. Atomics.wait blocks this thread
    // without spinning; the parent owns the only wake-up (kill).
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300_000);
    return 0;
  });
  return store;
};
