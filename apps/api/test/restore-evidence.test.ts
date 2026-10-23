import assert from "node:assert/strict";
import test from "node:test";

import {
  attachRestoreFailureEvidence,
  decideRestoreFailureRelease,
  readRestoreFailureEvidence,
  type RestoreFailureCallerEvidence,
  type RestoreFailureEvidence
} from "../src/restore-evidence.js";

const untouched: RestoreFailureEvidence = {
  version: 1,
  mainDatabaseTouched: false,
  originalExisted: true,
  originalSnapshotDurable: false,
  originalRestoredVerified: false,
  recoveryErrors: 0,
  replaceGateReleased: true,
  restoreJournalClosed: true
};

const caller: RestoreFailureCallerEvidence = {
  mainDatabaseReadable: true,
  requiredTablesPresent: true,
  epochUnchanged: true,
  sidecarScopeConsistent: true,
  hadRecoveryBlock: false
};

const restoredAfterTouch: RestoreFailureEvidence = {
  ...untouched,
  mainDatabaseTouched: true,
  originalSnapshotDurable: true,
  originalRestoredVerified: true
};

test("restore failure evidence is versioned and survives error wrapping", () => {
  const error = new Error("fixture");
  attachRestoreFailureEvidence(error, restoredAfterTouch);
  assert.deepEqual(readRestoreFailureEvidence(error), restoredAfterTouch);
  assert.equal(readRestoreFailureEvidence(new Error("no evidence")), null);
  assert.equal(readRestoreFailureEvidence(null), null);
});

test("a rejection that never touched the main database may release the freeze", () => {
  assert.deepEqual(decideRestoreFailureRelease(untouched, caller), { safe: true });
});

test("a touched database is safe only after a durable snapshot and a verified rollback", () => {
  assert.deepEqual(decideRestoreFailureRelease(restoredAfterTouch, caller), { safe: true });
  const decision = decideRestoreFailureRelease({ ...restoredAfterTouch, originalSnapshotDurable: false }, caller);
  assert.equal(decision.safe, false);
  const unverified = decideRestoreFailureRelease({ ...restoredAfterTouch, originalRestoredVerified: false }, caller);
  assert.equal(unverified.safe, false);
  const withRecoveryError = decideRestoreFailureRelease({ ...restoredAfterTouch, recoveryErrors: 1 }, caller);
  assert.equal(withRecoveryError.safe, false);
});

test("an open journal or held gate always keeps the freeze", () => {
  for (const evidence of [
    { ...untouched, restoreJournalClosed: false },
    { ...untouched, replaceGateReleased: false },
    { ...restoredAfterTouch, restoreJournalClosed: false }
  ]) {
    assert.equal(decideRestoreFailureRelease(evidence, caller).safe, false);
  }
});

test("caller-side identity, tables, epoch, sidecar or a pre-existing block veto the release", () => {
  for (const field of ["mainDatabaseReadable", "requiredTablesPresent", "epochUnchanged",
    "sidecarScopeConsistent"] as const) {
    const decision = decideRestoreFailureRelease(untouched, { ...caller, [field]: false });
    assert.equal(decision.safe, false, field);
  }
  const blocked = decideRestoreFailureRelease(untouched, { ...caller, hadRecoveryBlock: true });
  assert.equal(blocked.safe, false, "an independent recovery block must survive");
});

test("missing or malformed evidence never releases a freeze", () => {
  assert.equal(decideRestoreFailureRelease(null, caller).safe, false);
  const malformed = { ...untouched, recoveryErrors: "0" } as unknown as RestoreFailureEvidence;
  const error = new Error("fixture");
  attachRestoreFailureEvidence(error, malformed);
  assert.equal(readRestoreFailureEvidence(error), null);
  assert.equal(decideRestoreFailureRelease(null, caller).safe, false);
});
