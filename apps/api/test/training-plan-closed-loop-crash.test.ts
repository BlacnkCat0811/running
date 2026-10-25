import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { seedCrashFixture, type CrashLane, type CrashPoint } from "./helpers/training-plan-crash-child.js";

const childScript = fileURLToPath(new URL("./helpers/training-plan-crash-child.ts", import.meta.url));
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function start(mode: "crash" | "recover", root: string, lane: CrashLane, point: CrashPoint) {
  const child = spawn(process.execPath, ["--import", "tsx", childScript, mode, root, lane, point],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // Attach a handler immediately so a spawn failure is never an unhandled rejection.
  void closed.catch(() => {});
  return { child, closed, output: () => output };
}

// T22/T28/S05-01: exact pre/post-COMMIT barriers, real OS signals, fresh-process
// recovery. POSIX local evidence complements, but cannot sign, Linux/systemd G5.
for (const lane of ["session", "execution", "refresh", "evaluation"] as const) {
  for (const point of ["before_commit", "after_commit"] as const) {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      test(`B09/T22/T28: ${lane} ${point} ${signal} recovers atomically in a new process`, {
        skip: process.platform === "win32" ? "Real POSIX signal and WAL crash recovery require macOS/Linux" : false,
        timeout: 45_000
      }, async t => {
        const root = mkdtempSync(join(tmpdir(), "rai-b09-crash-"));
        let running: ReturnType<typeof start> | undefined;
        try {
          const seeded = await seedCrashFixture(root, lane);
          running = start("crash", root, lane, point);
          const deadline = Date.now() + 15_000;
          while (!existsSync(join(root, "checkpoint.json"))) {
            assert.equal(running.child.exitCode, null, running.output());
            assert.equal(running.child.signalCode, null, running.output());
            assert.ok(Date.now() < deadline, `checkpoint timeout: ${running.output()}`);
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          const checkpoint = read(join(root, "checkpoint.json"));
          assert.equal(checkpoint.inTransaction, point === "before_commit");
          assert.equal(checkpoint.result.outcome, lane === "evaluation" ? "no_change" : "changed");
          assert.equal(running.child.kill(signal), true);
          assert.deepEqual(await running.closed, { code: null, signal }, running.output());
          running = undefined;

          // Inspect before opening MobileGoalsStore (whose startup clears the
          // dead publisher marker). The OS released its WAL writer lock.
          const db = new DatabaseSync(join(root, "control.sqlite"));
          let crashEpoch: number;
          try {
            assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
            const guard = db.prepare("SELECT epoch, pending_since FROM mobile_publication_guard").get()!;
            assert.equal(typeof guard.pending_since, "string", "killed process left the committed marker");
            crashEpoch = guard.epoch as number;
            assert.equal(crashEpoch, seeded.guard.epoch + 1);
          } finally { db.close(); }

          running = start("recover", root, lane, point);
          const timer = setTimeout(() => running?.child.kill("SIGKILL"), 15_000);
          let exit;
          try { exit = await running.closed; } finally { clearTimeout(timer); }
          assert.deepEqual(exit, { code: 0, signal: null }, running.output());
          running = undefined;
          const result = read(join(root, "recovered.json"));
          assert.deepEqual(result.guardBefore, { epoch: crashEpoch, pendingSince: null },
            "startup clears a dead marker immediately while retaining its epoch");
          if (point === "before_commit") {
            assert.deepEqual(result.before, seeded.snapshot, "all uncommitted business rows rolled back byte-for-byte");
            assert.equal(result.queried.status, "notFound");
            assert.equal(result.guardAfter.epoch, crashEpoch + 1, "one fresh submission, after verified notFound");
            if (lane === "session") assert.equal(result.rejectedCandidate, "training_session_candidate_mismatch");
          } else {
            assert.deepEqual(result.before, checkpoint.snapshot, "COMMIT persisted every business row together");
            assert.equal(result.queried.status, "committed");
            assert.deepEqual(result.queried.result, checkpoint.result);
            assert.deepEqual(result.recovered, checkpoint.result, "lost response recovers the original stored result");
            assert.deepEqual(result.after, result.before, "recovery and replay perform no business writes");
            assert.deepEqual(result.guardAfter, result.guardBefore, "committed replay never starts a publication");
          }
          assert.equal(result.revision, seeded.revision + (lane === "evaluation" ? 0 : 1));
          assert.equal(result.after.mobile_plan_operations.length, seeded.snapshot.mobile_plan_operations!.length + 1);
          assert.equal(result.guardAfter.pendingSince, null);
          if (lane === "session") {
            assert.equal(result.recovered.session.sessionId, "synthetic-stable-session");
            assert.equal(result.recovered.session.prescription.localDate, "2026-10-29");
            assert.equal(result.recovered.session.protection, "user_protected");
          } else if (lane === "execution") {
            assert.equal(result.recovered.execution.association, "confirmed");
            assert.equal(result.recovered.execution.trainingSessionId, "synthetic-crash-run");
            assert.equal(result.recovered.execution.prescriptionSessionRevision, 1);
            assert.equal(result.recovered.execution.assessment.dose.status, "met");
            assert.equal(result.recovered.execution.assessment.stimulus.status, "not_assessable");
            assert.equal(result.recovered.session.lifecycle, "completed");
            assert.equal(result.after.mobile_training_execution_history.length, 1);
          } else {
            const cursor = result.after.mobile_training_plan_evaluation;
            assert.equal(cursor.length, 1);
            assert.equal(cursor[0].input_key, "input-after-crash");
            if (lane === "evaluation") {
              for (const table of Object.keys(seeded.snapshot)) {
                if (!["mobile_training_plan_evaluation", "mobile_plan_operations"].includes(table)) {
                  assert.deepEqual(result.after[table], seeded.snapshot[table], `${table}: no_change adds no content/history`);
                }
              }
            }
          }
          t.diagnostic(`${process.platform} ${lane}/${point}/${signal}: WAL integrity ok; ` +
            `operation=${result.recovered.operationId}; stateRevision=${result.revision}; recovery verified`);
          t.diagnostic(JSON.stringify({ beforeSHA256: createHash("sha256").update(JSON.stringify(result.before)).digest("hex"),
            afterSHA256: createHash("sha256").update(JSON.stringify(result.after)).digest("hex"),
            rows: Object.fromEntries(Object.entries(result.after).map(([table, rows]) => [table, (rows as unknown[]).length])) }));
        } finally {
          if (running) { running.child.kill("SIGKILL"); await running.closed.catch(() => {}); }
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}
