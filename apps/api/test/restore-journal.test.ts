import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RaiDatabase } from "@rai/storage-sqlite";
import { DatabaseMaintenance } from "../src/maintenance.js";
import { RestoreJournal } from "../src/restore-journal.js";
import { readDatasetEpoch, writeDatasetEpoch } from "../src/dataset-epoch.js";

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

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
      writeDatasetEpoch(store.database, "configured", "original-epoch");
      store.close();
      await copyFile(target, snapshot);
      await copyFile(target, staging);
      const candidate = new DatabaseSync(staging);
      candidate.exec("UPDATE marker SET value='candidate'");
      writeDatasetEpoch(candidate, "configured", "candidate-epoch");
      candidate.close();
      const journal = new RestoreJournal(target, root);
      const candidateSha = sha256(staging);
      const intent = {
        version: 2 as const, target, staging, snapshot, snapshotIsQuarantine: false,
        configuredEpoch: "configured", serverId: "local", athleteId: "athlete_1",
        deletionId: null, backupName: "original.sqlite", backupSha256: sha256(snapshot),
        backupSizeBytes: readFileSync(snapshot).length, plannedEpoch: "candidate-epoch",
        phase: "prepared" as const
      };
      journal.write(intent);
      if (point !== "prepared") await rename(target, join(root, "var/backups/moved.sqlite"));
      if (point === "installed" || point === "committed") await rename(staging, target);
      if (point === "installed") journal.write({ ...intent, phase: "installed" });
      if (point === "committed") journal.write({ ...intent, phase: "committed", mainSha256: candidateSha });
      const maintenance = new DatabaseMaintenance(target, root);
      await maintenance.recoverInterruptedRestore();
      await maintenance.recoverInterruptedRestore();
      assert.ok(existsSync(target));
      const active = new DatabaseSync(target, { readOnly: true });
      try { assert.equal(active.prepare("SELECT value FROM marker").get()!.value, point === "committed" ? "candidate" : "original"); }
      finally { active.close(); }
      assert.equal(readDatasetEpoch(target, "configured"), point === "committed" ? "candidate-epoch" : "original-epoch");
      assert.equal(journal.read(), null);
      assert.ok(existsSync(snapshot));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}


test("a committed intent never infers success from a readable main with another epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-restore-mismatch-"));
  mkdirSync(join(root, "var/backups"), { recursive: true });
  const target = join(root, "var/rai.sqlite");
  const snapshot = join(root, "var/backups/original.sqlite");
  const staging = `${target}.restoring.fixture`;
  const journal = new RestoreJournal(target, root);
  try {
    const store = await RaiDatabase.open(target);
    writeDatasetEpoch(store.database, "configured", "actual-epoch");
    store.close();
    await copyFile(target, snapshot);
    await copyFile(target, staging);
    journal.write({
      version: 2, target, staging, snapshot, snapshotIsQuarantine: false, phase: "committed",
      configuredEpoch: "configured", serverId: "local", athleteId: "athlete_1",
      deletionId: null, backupName: "original.sqlite", backupSha256: sha256(snapshot),
      backupSizeBytes: readFileSync(snapshot).length, plannedEpoch: "planned-epoch",
      mainSha256: sha256(target)
    });
    await assert.rejects(
      new DatabaseMaintenance(target, root).recoverInterruptedRestore(),
      /does not match its durable intent|planned restore epoch/i);
    assert.notEqual(journal.read(), null, "a mismatched main must leave the intent open");
    assert.equal(readDatasetEpoch(target, "configured"), "actual-epoch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restoreBackup writes a bound intent and keeps it until finalization", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-restore-bound-"));
  mkdirSync(join(root, "var"), { recursive: true });
  const target = join(root, "var/rai.sqlite");
  const journal = new RestoreJournal(target, root);
  try {
    const store = await RaiDatabase.open(target);
    store.database.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('original')");
    writeDatasetEpoch(store.database, "configured", "original-epoch");
    store.close();
    const maintenance = new DatabaseMaintenance(target, root);
    const backup = await maintenance.createBackup("bound-fixture");
    await maintenance.restoreBackup(
      backup.name, undefined,
      database => writeDatasetEpoch(database, "configured", "restored-epoch"),
      {
        plannedEpoch: "restored-epoch", configuredEpoch: "configured",
        serverId: "local", athleteId: "athlete_1", deletionId: null
      }
    );
    const intent = journal.read();
    assert.equal(intent?.phase, "committed");
    assert.ok(intent && "plannedEpoch" in intent);
    assert.equal(intent.backupName, backup.name);
    assert.equal(intent.backupSizeBytes, backup.sizeBytes);
    assert.equal(intent.plannedEpoch, "restored-epoch");
    assert.match(intent.backupSha256, /^[0-9a-f]{64}$/);
    assert.match(intent.mainSha256!, /^[0-9a-f]{64}$/);
    await maintenance.finalizeCommittedRestore();
    assert.equal(journal.read(), null);
    assert.equal(readDatasetEpoch(target, "configured"), "restored-epoch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("a failed restore over an absent original keeps the candidate but replays the absence on restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-restore-absent-original-"));
  mkdirSync(join(root, "var"), { recursive: true });
  const target = join(root, "var/rai.sqlite");
  const journal = new RestoreJournal(target, root);
  const previous = {
    injection: process.env.RAI_FAULT_INJECTION,
    point: process.env.RAI_FAULT_POINT,
    testEnv: process.env.RAI_FAULT_TEST_ENV
  };
  try {
    const seed = await RaiDatabase.open(target);
    writeDatasetEpoch(seed.database, "configured", "source-epoch");
    seed.close();
    const maintenance = new DatabaseMaintenance(target, root);
    const backup = await maintenance.createBackup("absent-original-fixture");
    rmSync(target, { force: true });
    process.env.RAI_FAULT_INJECTION = "1";
    process.env.RAI_FAULT_TEST_ENV = "1";
    process.env.RAI_FAULT_POINT = "restore:after-install:throw";
    await assert.rejects(maintenance.restoreBackup(
      backup.name, undefined,
      database => writeDatasetEpoch(database, "configured", "planned-epoch"),
      {
        plannedEpoch: "planned-epoch", configuredEpoch: "configured",
        serverId: "local", athleteId: "athlete_1", deletionId: null
      }
    ), /Injected fault.*startup recovery/);
    assert.equal(existsSync(target), true, "失败处理不得删除唯一可读候选库");
    assert.notEqual(journal.read(), null, "无法证明回到原状态时必须保留恢复意图");
    await maintenance.recoverInterruptedRestore();
    assert.equal(existsSync(target), false, "重启必须按 installed 阶段恢复“原本无主库”");
    assert.equal(journal.read(), null);
  } finally {
    if (previous.injection === undefined) delete process.env.RAI_FAULT_INJECTION;
    else process.env.RAI_FAULT_INJECTION = previous.injection;
    if (previous.point === undefined) delete process.env.RAI_FAULT_POINT;
    else process.env.RAI_FAULT_POINT = previous.point;
    if (previous.testEnv === undefined) delete process.env.RAI_FAULT_TEST_ENV;
    else process.env.RAI_FAULT_TEST_ENV = previous.testEnv;
    rmSync(root, { recursive: true, force: true });
  }
});


test("a legacy committed journal without a bound epoch requires manual recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-restore-legacy-committed-"));
  mkdirSync(join(root, "var/backups"), { recursive: true });
  const target = join(root, "var/rai.sqlite");
  const journal = new RestoreJournal(target, root);
  try {
    const store = await RaiDatabase.open(target);
    writeDatasetEpoch(store.database, "configured", "foreign-epoch");
    store.close();
    journal.write({
      target, staging: `${target}.restoring.fixture`, snapshot: null,
      snapshotIsQuarantine: false, phase: "committed"
    });
    await assert.rejects(
      new DatabaseMaintenance(target, root).recoverInterruptedRestore(),
      /Legacy committed restore journal cannot be verified/);
    assert.notEqual(journal.read(), null, "legacy journal must stay for manual recovery");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a bound intent whose deletion sidecar disappeared is refused, not closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-restore-missing-deletion-"));
  mkdirSync(join(root, "var/backups"), { recursive: true });
  const target = join(root, "var/rai.sqlite");
  const journal = new RestoreJournal(target, root);
  try {
    const store = await RaiDatabase.open(target);
    writeDatasetEpoch(store.database, "configured", "planned-epoch");
    store.close();
    const snapshot = join(root, "var/backups/original.sqlite");
    await copyFile(target, snapshot);
    journal.write({
      version: 2, target, staging: `${target}.restoring.fixture`, snapshot,
      snapshotIsQuarantine: false, phase: "committed", configuredEpoch: "configured",
      serverId: "local", athleteId: "athlete_1", deletionId: "missing-deletion",
      backupName: "original.sqlite", backupSha256: sha256(snapshot),
      backupSizeBytes: readFileSync(snapshot).length, plannedEpoch: "planned-epoch",
      mainSha256: sha256(target)
    });
    await assert.rejects(
      new DatabaseMaintenance(target, root).recoverInterruptedRestore(),
      /sidecar has no deletion operation/);
    assert.notEqual(journal.read(), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("an empty journal file is not silently treated as no restore intent", () => {
  const root = mkdtempSync(join(tmpdir(), "rai-restore-empty-journal-"));
  try {
    const target = join(root, "rai.sqlite");
    writeFileSync(`${target}.restore-journal.sqlite`, "");
    const journal = new RestoreJournal(target, root);
    assert.throws(() => journal.read(), /restore_intent table|journal is unreadable/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
