/**
 * Child-process publisher for `plan-publication-stress.test.ts`.
 *
 * Not a test file (the runner only discovers `*.test.ts`): it exists so the
 * publication guard can be exercised by two real OS processes instead of two
 * connections inside one event loop. The publication order is exactly the
 * production one (`MobileGoalsStore.withPublicationTransaction`):
 *
 *   1. BEGIN IMMEDIATE; beginPublicationGuard; COMMIT   — epoch + pending marker
 *      are committed *before* the main-store write.
 *   2. BEGIN IMMEDIATE; UPDATE marker; COMMIT           — the "main database" write.
 *   3. BEGIN IMMEDIATE; endPublicationGuard; COMMIT     — clear the pending marker.
 *
 * Usage:
 *   node --import tsx plan-publication-stress-child.ts <control-db> <main-db> [publications]
 *
 * IPC: sends `{type:"ready"}` once the connections are open, waits for
 * `{type:"go"}`, then publishes; sends `{type:"done", publications}` and exits.
 * The parent reads while this process publishes; see the test for the invariant.
 */

import { DatabaseSync } from "node:sqlite";
import {
  beginPublicationGuard, endPublicationGuard, ensurePublicationGuardSchema
} from "../src/publication-guard.js";

const [controlPath, mainPath, rawPublications] = process.argv.slice(2);
if (!controlPath || !mainPath) throw new Error("usage: <control-db> <main-db> [publications]");
const publications = Math.max(0, Math.trunc(Number(rawPublications ?? "300")));

const control = new DatabaseSync(controlPath);
const main = new DatabaseSync(mainPath);
for (const database of [control, main]) {
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  // Keep the default (FULL) synchronous mode on purpose: three fsyncs per
  // publication make the child's publication window long enough for the parent
  // reader loop to observe many in-flight markers. This is a stress fixture, not
  // a throughput benchmark.
}
ensurePublicationGuardSchema(control);
const updateMarker = main.prepare("UPDATE marker SET value = ?");

const transaction = (database: DatabaseSync, action: () => void): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    action();
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* SQLite may have rolled back already. */ }
    throw error;
  }
};

// The parent reads the settled state (and proves the invariant) before it lets
// publications start, so a detection count of zero cannot be blamed on startup.
if (process.send) {
  process.send({ type: "ready" });
  await new Promise<void>(resolve => {
    process.once("message", message => {
      if ((message as { type?: unknown } | null)?.type === "go") resolve();
    });
  });
}

for (let index = 0; index < publications; index += 1) {
  let epoch = 0;
  transaction(control, () => { epoch = beginPublicationGuard(control).epoch; });
  transaction(main, () => { updateMarker.run(epoch); });
  transaction(control, () => { endPublicationGuard(control); });
}

process.send?.({ type: "done", publications });
control.close();
main.close();
