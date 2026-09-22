import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RaiDatabase } from "@rai/storage-sqlite";
import { DatabaseMaintenance } from "../src/maintenance.js";
import { RestoreJournal } from "../src/restore-journal.js";

for (const point of ["prepared", "moved", "installed", "committed"] as const) {
  test(`startup replays restore interruption at ${point}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-restore-journal-"));
    mkdirSync(join(root, "var/backups"), { recursive: true });
    const target = join(root, "var/rai.sqlite");
    const snapshot = join(root, "var/backups/original.sqlite");
    const staging = `${target}.restoring.fixture`;
    try {
      const store = await RaiDatabase.open(target);
      store.database.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('original')");
      store.close();
      await copyFile(target, snapshot);
      await copyFile(target, staging);
      const candidate = new DatabaseSync(staging);
      candidate.exec("UPDATE marker SET value='candidate'"); candidate.close();
      const journal = new RestoreJournal(target, root);
      const intent = { target, staging, snapshot, snapshotIsQuarantine: false, phase: "prepared" as const };
      journal.write(intent);
      if (point !== "prepared") await rename(target, join(root, "var/backups/moved.sqlite"));
      if (point === "installed" || point === "committed") await rename(staging, target);
      if (point === "installed" || point === "committed") journal.write({ ...intent, phase: point });
      const maintenance = new DatabaseMaintenance(target, root);
      await maintenance.recoverInterruptedRestore();
      await maintenance.recoverInterruptedRestore();
      assert.ok(existsSync(target));
      const active = new DatabaseSync(target, { readOnly: true });
      try { assert.equal(active.prepare("SELECT value FROM marker").get()!.value, point === "committed" ? "candidate" : "original"); }
      finally { active.close(); }
      assert.equal(journal.read(), null);
      assert.ok(existsSync(snapshot));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a process killed between original move and candidate install recovers on restart", async () => {
  const { spawn } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const root = mkdtempSync(join(tmpdir(), "rai-restore-killed-"));
  const target = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(target);
    store.database.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('backup')"); store.close();
    const maintenance = new DatabaseMaintenance(target, root);
    const snapshot = await maintenance.createBackup();
    const db = new DatabaseSync(target); db.exec("UPDATE marker SET value='original'"); db.close();
    const script = join(root, "kill.mjs");
    const moduleUrl = new URL("../src/maintenance.ts", import.meta.url).href;
    await writeFile(script, `import { DatabaseMaintenance } from ${JSON.stringify(moduleUrl)};
      const [target, root, name] = process.argv.slice(2);
      await new DatabaseMaintenance(target, root, undefined, undefined, async () => {
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => {});
      }).restoreBackup(name);`);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      const child = spawn(process.execPath, ["--import", "tsx", script, target, root, snapshot.name], { stdio: "ignore" });
      child.once("error", fail);
      child.once("exit", (code, signal) => done({ code, signal }));
    });
    assert.ok(exit.signal === "SIGKILL" || exit.code !== 0);
    assert.equal(existsSync(target), false);
    await new DatabaseMaintenance(target, root).recoverInterruptedRestore();
    const active = new DatabaseSync(target, { readOnly: true });
    try { assert.equal(active.prepare("SELECT value FROM marker").get()!.value, "original"); }
    finally { active.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid recovery metadata cannot remove arbitrary files", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-restore-invalid-"));
  try {
    const target = join(root, "rai.sqlite");
    const journal = new RestoreJournal(target, root);
    journal.write({ target, staging: join(root, "unrelated"), snapshot: null, snapshotIsQuarantine: false, phase: "prepared" });
    await assert.rejects(new DatabaseMaintenance(target, root).recoverInterruptedRestore(), /Invalid restore journal/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
