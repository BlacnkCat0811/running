// P1-9 / P2-3：删除失败的“已恢复且已验证”证据与许可撤销顺序。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RaiDatabase } from "@rai/storage-sqlite";

import {
  advanceDeletionOperation, beginDeletionOperation, closeDeletionOperation, readDeletionOperation,
  readDatasetEpochState, writeDatasetEpoch
} from "../src/dataset-epoch.js";
import { captureProtectionSnapshot, reconcileDatasetDeletionAtStartup } from "../src/deletion-recovery.js";
import { DatabaseDeletionFailure, DatabaseMaintenance } from "../src/maintenance.js";
import { RestoreJournal } from "../src/restore-journal.js";
import { RuntimeStateStore } from "../src/runtime-state.js";

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const identity = { serverId: "local", athleteId: "athlete_1" };
const at = "2026-10-23T00:00:00.000Z";
const scopeOf = (epoch: string): string => JSON.stringify([identity.serverId, identity.athleteId, epoch]);

test("P1-9: a failed deletion whose backup cannot restore reports unverified evidence and releases the gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-deletion-evidence-"));
  const databasePath = join(root, "var/rai.sqlite");
  try {
    mkdirSync(join(root, "var"), { recursive: true });
    const store = await RaiDatabase.open(databasePath);
    writeDatasetEpoch(store.database, "default", "previous-epoch");
    store.close();
    let gateReleased = false;
    const maintenance = new DatabaseMaintenance(
      databasePath, root,
      () => {}, () => { gateReleased = true; }
    );
    let failure: DatabaseDeletionFailure | null = null;
    try {
      await maintenance.deleteDatabase((backup) => {
        // Corrupt the protection snapshot before the unlink; the catch path can
        // no longer restore a verified database from it.
        writeFileSync(join(root, "var/backups", backup.name), "corrupted beyond sqlite");
      }, () => {
        throw new Error("fixture failure after unlink");
      });
      assert.fail("deleteDatabase must fail");
    } catch (error) {
      assert.ok(error instanceof DatabaseDeletionFailure, String(error));
      failure = error;
    }
    assert.equal(failure.evidence.originalReadable, true);
    assert.equal(failure.evidence.originalRestored, false);
    assert.equal(failure.evidence.restoredVerified, false);
    assert.equal(failure.evidence.gateReleased, true);
    assert.equal(gateReleased, true, "replace gate must be released on every failure path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


async function seedEpochDatabase(path: string, epoch: string): Promise<void> {
  const store = await RaiDatabase.open(path);
  try { writeDatasetEpoch(store.database, "default", epoch); }
  finally { store.close(); }
}

function removeMain(path: string): void {
  for (const suffix of ["-shm", "-wal", ""]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

for (const stage of ["main_removed", "permit_issued"] as const) {
  test(`P1: ${stage} + readable foreign epoch must stay recovery_required without revoking/closing`, async () => {
    const root = mkdtempSync(join(tmpdir(), `rai-deletion-foreign-${stage}-`));
    const databasePath = join(root, "var/rai.sqlite");
    try {
      mkdirSync(join(root, "var/backups"), { recursive: true });
      await seedEpochDatabase(databasePath, "previous-epoch");
      const store = new RuntimeStateStore(root);
      beginDeletionOperation({
        databasePath, configuredEpoch: "default", ...identity,
        deletionId: `deletion-foreign-${stage}`, previousEpoch: "previous-epoch", nextEpoch: "next-epoch",
        protectionSnapshot: "before-delete.sqlite", protectionKind: "backup",
        protectionFiles: [{ suffix: "", sizeBytes: 10, sha256: "a".repeat(64) }],
        runtimeInstanceId: store.runtimeInstanceId(), at
      });
      advanceDeletionOperation(databasePath, "default", `deletion-foreign-${stage}`, "main_removed", at, identity);
      if (stage === "permit_issued") {
        store.establishDeletionPermit(scopeOf("next-epoch"), `deletion-foreign-${stage}`, at);
        advanceDeletionOperation(databasePath, "default", `deletion-foreign-${stage}`, "permit_issued", at, identity);
      }
      removeMain(databasePath);
      await seedEpochDatabase(databasePath, "foreign-readable-epoch");
      const decision = reconcileDatasetDeletionAtStartup({
        databasePath, configuredEpoch: "default", runtimeRoot: root, ...identity, store
      });
      assert.equal(decision.recoveryRequired, true);
      assert.equal(decision.outcome, "recovery-required");
      assert.equal(readDeletionOperation(databasePath, "default", {
        strictConfigured: true, identity
      })?.stage, stage, "the journal must not be closed by a readable foreign epoch");
      const sidecar = new DatabaseSync(`${databasePath}.dataset-epoch.sqlite`, { readOnly: true });
      try {
        const row = sidecar.prepare("SELECT payload FROM dataset_epoch WHERE id=1").get() as { payload: string };
        assert.equal((JSON.parse(row.payload) as { epoch: string }).epoch, "next-epoch",
          "the sidecar epoch must keep the deletion's next epoch");
      } finally { sidecar.close(); }
      const permit = store.scopeEvidence(scopeOf("next-epoch"));
      if (stage === "permit_issued") {
        assert.equal(permit?.state, "pristine", "the existing permit must not be revoked");
        assert.equal(permit?.permitRevokedAt, null);
      } else {
        assert.equal(permit, null);
      }
      assert.equal(store.scopeEvidence(scopeOf("foreign-readable-epoch")), null,
        "the uncredentialed epoch must not be registered as established");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("P1: original rollback requires the bound protection snapshot identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-deletion-protection-identity-"));
  const databasePath = join(root, "var/rai.sqlite");
  try {
    mkdirSync(join(root, "var"), { recursive: true });
    await seedEpochDatabase(databasePath, "previous-epoch");
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await maintenance.createBackup("before-delete");
    const protectionFiles = captureProtectionSnapshot(root, backup.name, "backup");
    const store = new RuntimeStateStore(root);
    beginDeletionOperation({
      databasePath, configuredEpoch: "default", ...identity,
      deletionId: "deletion-protection", previousEpoch: "previous-epoch", nextEpoch: "next-epoch",
      protectionSnapshot: backup.name, protectionKind: "backup", protectionFiles,
      runtimeInstanceId: store.runtimeInstanceId(), at
    });
    removeMain(databasePath);
    advanceDeletionOperation(databasePath, "default", "deletion-protection", "main_removed", at, identity);
    // The old dataset reappears byte-for-byte from the bound protection snapshot.
    writeFileSync(databasePath, readFileSync(join(root, "var/backups", backup.name)));
    const snapshotPath = join(root, "var/backups", backup.name);
    const parked = join(root, "var/backups", "parked.sqlite");
    renameSync(snapshotPath, parked);
    const blocked = reconcileDatasetDeletionAtStartup({
      databasePath, configuredEpoch: "default", runtimeRoot: root, ...identity, store
    });
    assert.equal(blocked.recoveryRequired, true,
      "a readable previous epoch is not enough when the protection snapshot identity cannot be verified");
    assert.equal(readDeletionOperation(databasePath, "default", {
      strictConfigured: true, identity
    })?.stage, "main_removed");
    renameSync(parked, snapshotPath);
    const rolledBack = reconcileDatasetDeletionAtStartup({
      databasePath, configuredEpoch: "default", runtimeRoot: root, ...identity, store
    });
    assert.equal(rolledBack.recoveryRequired, false);
    assert.equal(rolledBack.outcome, "rolled-back");
    assert.equal(rolledBack.epochState.epoch, "previous-epoch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("P1: prepared + foreign SQLite without an explicit epoch must not be rolled back", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-deletion-prepared-no-epoch-"));
  const databasePath = join(root, "var/rai.sqlite");
  try {
    mkdirSync(join(root, "var"), { recursive: true });
    await seedEpochDatabase(databasePath, "previous-epoch");
    const maintenance = new DatabaseMaintenance(databasePath, root);
    const backup = await maintenance.createBackup("before-delete");
    const protectionFiles = captureProtectionSnapshot(root, backup.name, "backup");
    const store = new RuntimeStateStore(root);
    beginDeletionOperation({
      databasePath, configuredEpoch: "default", ...identity,
      deletionId: "deletion-prepared-no-epoch", previousEpoch: "previous-epoch", nextEpoch: "next-epoch",
      protectionSnapshot: backup.name, protectionKind: "backup", protectionFiles,
      runtimeInstanceId: store.runtimeInstanceId(), at
    });
    removeMain(databasePath);
    const foreign = new DatabaseSync(databasePath);
    try { foreign.exec("CREATE TABLE foreign_table(value TEXT)"); }
    finally { foreign.close(); }
    const decision = reconcileDatasetDeletionAtStartup({
      databasePath, configuredEpoch: "default", runtimeRoot: root, ...identity, store
    });
    assert.equal(decision.recoveryRequired, true,
      "a readable SQLite file without an explicit epoch is not the previous dataset");
    assert.equal(readDeletionOperation(databasePath, "default", {
      strictConfigured: true, identity
    })?.stage, "prepared");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("P1: rolled_back/superseded sidecar epoch is authoritative over a foreign readable main", async () => {
  for (const stage of ["rolled_back", "superseded"] as const) {
    const root = mkdtempSync(join(tmpdir(), `rai-deletion-closed-foreign-${stage}-`));
    const databasePath = join(root, "var/rai.sqlite");
    try {
      mkdirSync(join(root, "var"), { recursive: true });
      await seedEpochDatabase(databasePath, "previous-epoch");
      const store = new RuntimeStateStore(root);
      beginDeletionOperation({
        databasePath, configuredEpoch: "default", ...identity,
        deletionId: `deletion-closed-${stage}`, previousEpoch: "previous-epoch", nextEpoch: "next-epoch",
        protectionSnapshot: "before-delete.sqlite", protectionKind: "backup",
        protectionFiles: [{ suffix: "", sizeBytes: 10, sha256: "a".repeat(64) }],
        runtimeInstanceId: store.runtimeInstanceId(), at
      });
      if (stage === "rolled_back") {
        advanceDeletionOperation(databasePath, "default", `deletion-closed-${stage}`, "rolled_back", at, identity);
      } else {
        advanceDeletionOperation(databasePath, "default", `deletion-closed-${stage}`, "main_removed", at, identity);
        advanceDeletionOperation(databasePath, "default", `deletion-closed-${stage}`, "permit_issued", at, identity);
        advanceDeletionOperation(databasePath, "default", `deletion-closed-${stage}`, "writer_entered", at, identity);
        closeDeletionOperation(databasePath, "default", "restored-epoch", {
          deletionId: `deletion-closed-${stage}`, reason: "fixture superseded", at, supersedeConsumed: true
        });
      }
      const main = await RaiDatabase.open(databasePath);
      writeDatasetEpoch(main.database, "default", "foreign-readable-epoch");
      main.close();
      const decision = reconcileDatasetDeletionAtStartup({
        databasePath, configuredEpoch: "default", runtimeRoot: root, ...identity, store
      });
      assert.equal(decision.recoveryRequired, true,
        `${stage} must not adopt a main epoch that disagrees with the sidecar`);
      assert.equal(decision.epochState.epoch, stage === "rolled_back" ? "previous-epoch" : "restored-epoch");
      assert.equal(store.scopeEvidence(scopeOf("foreign-readable-epoch")), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("P2-3: revoking the permit before closing the journal leaves no consumable permit at any crash point", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-deletion-revoke-"));
  const databasePath = join(root, "var/rai.sqlite");
  try {
    mkdirSync(join(root, "var"), { recursive: true });
    const store = new RuntimeStateStore(root);
    const scope = scopeOf("next-epoch");
    const record = beginDeletionOperation({
      databasePath, configuredEpoch: "default", ...identity,
      deletionId: "deletion-revoke", previousEpoch: "previous-epoch", nextEpoch: "next-epoch",
      protectionSnapshot: "before-delete.sqlite", protectionKind: "backup",
      protectionFiles: [{ suffix: "", sizeBytes: 10, sha256: "a".repeat(64) }],
      runtimeInstanceId: store.runtimeInstanceId(), at
    });
    assert.equal(record.version, 3);
    advanceDeletionOperation(databasePath, "default", "deletion-revoke", "main_removed", at, identity);
    store.establishDeletionPermit(scope, "deletion-revoke", at);
    advanceDeletionOperation(databasePath, "default", "deletion-revoke", "permit_issued", at, identity);
    assert.ok(store.firstEmptyPermit(scope), "the recorded permit starts consumable");

    // Simulated crash window: permit revoked, journal still says permit_issued.
    assert.equal(store.revokeDeletionPermit(scope, "deletion-revoke", at), true);
    assert.equal(store.firstEmptyPermit(scope), null, "revoked permit must never be consumable");
    assert.equal(readDeletionOperation(databasePath, "default", { strictConfigured: true, identity })?.stage,
      "permit_issued");

    // Replaying the revocation is a no-op, not a second transition.
    assert.equal(store.revokeDeletionPermit(scope, "deletion-revoke", at), false);

    closeDeletionOperation(databasePath, "default", "previous-epoch", {
      deletionId: "deletion-revoke", reason: "fixture rollback", at
    });
    const state = readDatasetEpochState(databasePath, "default", { strictConfigured: true, identity });
    assert.equal(state.epoch, "previous-epoch");
    assert.equal(state.deletion?.stage, "rolled_back");
    assert.equal(store.firstEmptyPermit(scope), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("P2-4: writer_entered + a different readable epoch without a restore intent stays recovery_required", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-deletion-p2-4-unproven-"));
  const databasePath = join(root, "var/rai.sqlite");
  try {
    mkdirSync(join(root, "var"), { recursive: true });
    const store = new RuntimeStateStore(root);
    beginDeletionOperation({
      databasePath, configuredEpoch: "default", ...identity,
      deletionId: "deletion-finalize", previousEpoch: "previous-epoch", nextEpoch: "next-epoch",
      protectionSnapshot: "before-delete.sqlite", protectionKind: "backup",
      protectionFiles: [{ suffix: "", sizeBytes: 10, sha256: "a".repeat(64) }],
      runtimeInstanceId: store.runtimeInstanceId(), at
    });
    advanceDeletionOperation(databasePath, "default", "deletion-finalize", "main_removed", at, identity);
    advanceDeletionOperation(databasePath, "default", "deletion-finalize", "permit_issued", at, identity);
    advanceDeletionOperation(databasePath, "default", "deletion-finalize", "writer_entered", at, identity);
    const main = await RaiDatabase.open(databasePath);
    writeDatasetEpoch(main.database, "default", "uncredentialed-epoch");
    main.close();
    const decision = reconcileDatasetDeletionAtStartup({
      databasePath, configuredEpoch: "default", runtimeRoot: root, ...identity, store
    });
    assert.equal(decision.recoveryRequired, true,
      "a readable main with a different epoch is not proof that an explicit restore completed");
    assert.equal(decision.outcome, "recovery-required");
    assert.equal(readDeletionOperation(databasePath, "default", {
      strictConfigured: true, identity
    })?.stage, "writer_entered", "the deletion journal must stay open");
    assert.equal(store.scopeEvidence(scopeOf("uncredentialed-epoch")), null,
      "the uncredentialed epoch must not be registered as established");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P2-4: writer_entered + a readable epoch-less main cannot borrow the sidecar epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-deletion-p2-4-epochless-"));
  const databasePath = join(root, "var/rai.sqlite");
  try {
    mkdirSync(join(root, "var"), { recursive: true });
    const store = new RuntimeStateStore(root);
    beginDeletionOperation({
      databasePath, configuredEpoch: "default", ...identity,
      deletionId: "deletion-epochless", previousEpoch: "previous-epoch", nextEpoch: "next-epoch",
      protectionSnapshot: "before-delete.sqlite", protectionKind: "backup",
      protectionFiles: [{ suffix: "", sizeBytes: 10, sha256: "a".repeat(64) }],
      runtimeInstanceId: store.runtimeInstanceId(), at
    });
    advanceDeletionOperation(databasePath, "default", "deletion-epochless", "main_removed", at, identity);
    advanceDeletionOperation(databasePath, "default", "deletion-epochless", "permit_issued", at, identity);
    advanceDeletionOperation(databasePath, "default", "deletion-epochless", "writer_entered", at, identity);
    const main = await RaiDatabase.open(databasePath);
    main.close();
    const state = readDatasetEpochState(databasePath, "default", { strictConfigured: true, identity });
    assert.equal(state.epoch, "next-epoch", "the sidecar still supplies the effective epoch");
    assert.equal(state.mainEpochExplicit, false, "the main bytes have no independent epoch identity");

    const decision = reconcileDatasetDeletionAtStartup({
      databasePath, configuredEpoch: "default", runtimeRoot: root, ...identity, store
    });
    assert.equal(decision.recoveryRequired, true);
    assert.equal(decision.outcome, "recovery-required");
    assert.equal(readDeletionOperation(databasePath, "default", { strictConfigured: true, identity })?.stage,
      "writer_entered");
    assert.equal(store.scopeEvidence(scopeOf("next-epoch")), null,
      "an epoch-less main must not establish the replacement scope");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("P2-4: a committed bound restore intent finalizes writer_entered as superseded", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-deletion-p2-4-bound-"));
  const databasePath = join(root, "var/rai.sqlite");
  const journal = new RestoreJournal(databasePath, root);
  try {
    mkdirSync(join(root, "var/backups"), { recursive: true });
    writeFileSync(join(root, "var/backups/snapshot.sqlite"), "snapshot");
    const store = new RuntimeStateStore(root);
    beginDeletionOperation({
      databasePath, configuredEpoch: "default", ...identity,
      deletionId: "deletion-finalize", previousEpoch: "previous-epoch", nextEpoch: "next-epoch",
      protectionSnapshot: "snapshot.sqlite", protectionKind: "backup",
      protectionFiles: [{ suffix: "", sizeBytes: 8, sha256: "a".repeat(64) }],
      runtimeInstanceId: store.runtimeInstanceId(), at
    });
    advanceDeletionOperation(databasePath, "default", "deletion-finalize", "main_removed", at, identity);
    advanceDeletionOperation(databasePath, "default", "deletion-finalize", "permit_issued", at, identity);
    advanceDeletionOperation(databasePath, "default", "deletion-finalize", "writer_entered", at, identity);
    const main = await RaiDatabase.open(databasePath);
    writeDatasetEpoch(main.database, "default", "restored-epoch");
    main.close();
    journal.write({
      version: 2, target: databasePath, staging: `${databasePath}.restoring.fixture`,
      snapshot: join(root, "var/backups/snapshot.sqlite"), snapshotIsQuarantine: false,
      phase: "committed", configuredEpoch: "default", ...identity,
      deletionId: "deletion-finalize", backupName: "snapshot.sqlite",
      backupSha256: "b".repeat(64), backupSizeBytes: 8, plannedEpoch: "restored-epoch",
      mainSha256: sha256(databasePath)
    });
    await new DatabaseMaintenance(databasePath, root).recoverInterruptedRestore();
    assert.equal(readDeletionOperation(databasePath, "default", {
      strictConfigured: true, identity
    })?.stage, "superseded");
    assert.equal(readDatasetEpochState(databasePath, "default", {
      strictConfigured: true, identity
    }).epoch, "restored-epoch");
    assert.equal(store.scopeEvidence(scopeOf("restored-epoch"))?.state, "established");
    assert.equal(journal.read(), null, "the intent is cleared only after finalization");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
