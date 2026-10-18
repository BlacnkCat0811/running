/**
 * Cross-process publication fixture for `plan-publication-stress.test.ts`.
 *
 * Not a test file (the runner only discovers `*.test.ts`). The HTTP stress test
 * needs a publication that is genuinely concurrent with the API process: a real
 * API server handles every request synchronously, so its own HTTP writers can
 * never be observed between the two guard reads, and a second API process is
 * refused by `acquireDatabasePublicationLock` by design. This fixture is the
 * remaining faithful shape: a separate process that publishes through the real
 * control store while the API serves reads and HTTP writes.
 *
 * It performs the production publication order with the guard protocol:
 *
 *   1. BEGIN IMMEDIATE; beginPublicationGuard; COMMIT   — epoch+pending committed
 *   2. sleep <window>                                    — models the main-store
 *      write: a real import publication holds the marker for far longer
 *   3. MobileGoalsStore.write(...)                       — the control publication
 *   4. BEGIN IMMEDIATE; endPublicationGuard; COMMIT      — clear pending
 *   5. sleep <gap>                                       — let a reader settle
 *
 * The API process may write the same control store concurrently (the HTTP
 * writers in the test), so the control write retries revision conflicts like a
 * busy client would.
 *
 * Usage:
 *   node --import tsx plan-publication-stress-publisher.ts \
 *     <runtime-root> <control-db> <publications> <window-ms> <gap-ms>
 *
 * IPC: `{type:"ready"}` → wait `{type:"go"}` → publish → `{type:"done"}` → exit.
 */

import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { beginPublicationGuard, endPublicationGuard, ensurePublicationGuardSchema } from "../src/publication-guard.js";

const [runtimeRoot, controlPath, rawPublications, rawWindowMs, rawGapMs] = process.argv.slice(2);
if (!runtimeRoot || !controlPath) throw new Error("usage: <runtime-root> <control-db> [publications] [window-ms] [gap-ms]");
const publications = Math.max(1, Math.trunc(Number(rawPublications ?? "300")));
const windowMs = Math.max(0, Math.trunc(Number(rawWindowMs ?? "5")));
const gapMs = Math.max(0, Math.trunc(Number(rawGapMs ?? "1")));

const control = new DatabaseSync(controlPath);
control.exec("PRAGMA journal_mode = WAL");
control.exec("PRAGMA busy_timeout = 5000");
ensurePublicationGuardSchema(control);
const store = new MobileGoalsStore(runtimeRoot, controlPath);

const guarded = (action: () => void): void => {
  control.exec("BEGIN IMMEDIATE");
  try {
    action();
    control.exec("COMMIT");
  } catch (error) {
    try { control.exec("ROLLBACK"); } catch { /* SQLite may have rolled back already. */ }
    throw error;
  }
};

if (process.send) {
  process.send({ type: "ready" });
  await new Promise<void>(resolve => {
    process.once("message", message => {
      if ((message as { type?: unknown } | null)?.type === "go") resolve();
    });
  });
}

for (let index = 1; index <= publications; index += 1) {
  guarded(() => { beginPublicationGuard(control); });
  await sleep(windowMs);
  let committed = false;
  for (let attempt = 0; attempt < 10 && !committed; attempt += 1) {
    try {
      store.write({ qualitySessionCap: 1 + (index % 4) });
      committed = true;
    } catch {
      // A concurrent API write won the revision race; a real client retries the
      // same metadata write rather than failing the stress fixture.
      await sleep(2);
    }
  }
  if (!committed) throw new Error("publisher could not commit a control publication");
  guarded(() => { endPublicationGuard(control); });
  await sleep(gapMs);
}

process.send?.({ type: "done", publications });
control.close();
