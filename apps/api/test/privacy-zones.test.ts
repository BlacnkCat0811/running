import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RaiApplicationService } from "@rai/application";

import {
  PrivacyZoneRevisionConflictError,
  PrivacyZoneValidationError,
  RaiDatabase,
  SqlitePrivacyZoneRepository
} from "@rai/storage-sqlite";

/**
 * V03 belongs to the share-card geometry, but the *storage* has its own way of
 * failing private: a rejected write that still emptied the table would leave the
 * runner with no zones at all — and every card they share afterwards unredacted.
 */
async function withRepository(run: (repository: SqlitePrivacyZoneRepository, store: RaiDatabase) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-privacy-"));
  try {
    const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
    try {
      run(new SqlitePrivacyZoneRepository(store.database), store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const zone = (overrides: Record<string, unknown> = {}) => ({
  id: "home",
  label: "家",
  centerLatitude: 31.23,
  centerLongitude: 121.47,
  radiusMeters: 300,
  createdAt: "2026-10-02T00:00:00.000Z",
  ...overrides
});

for (const transactionMode of ["owned", "savepoint"] as const) {
  test(`privacy-zone application writes compose with ${transactionMode} transactions`, async () => {
    await withRepository((repository, store) => {
      if (transactionMode === "savepoint") store.database.exec("BEGIN IMMEDIATE");
      const service = new RaiApplicationService(store, transactionMode);
      assert.equal(service.replacePrivacyZones([zone()], 0).revision, 1);
      assert.throws(() => service.replacePrivacyZones([], 0), PrivacyZoneRevisionConflictError);
      assert.equal(repository.list().length, 1);
      assert.equal(service.replacePrivacyZones([zone(), zone({ id: "work" })], 1).revision, 2);
      if (transactionMode === "savepoint") {
        store.database.exec("ROLLBACK");
        assert.equal(repository.revision(), 0);
        assert.deepEqual(repository.list(), []);
      }
    });
  });
}

test("V03: zones start empty at revision 0 and a write is revision-guarded", async () => {
  await withRepository((repository) => {
    assert.equal(repository.revision(), 0);
    assert.deepEqual(repository.list(), []);

    const revision = repository.replace([zone()], 0);
    assert.equal(revision, 1);
    assert.equal(repository.revision(), 1);
    const stored = repository.list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.label, "家");
    assert.ok(stored[0]!.updatedAt.length > 0, "the write stamps updatedAt");

    // A client that read revision 0 must be rejected, not silently allowed to
    // replace the zone that was added in between.
    assert.throws(() => repository.replace([], 0), (error: unknown) => {
      assert.ok(error instanceof PrivacyZoneRevisionConflictError);
      assert.equal(error.expectedRevision, 0);
      assert.equal(error.actualRevision, 1);
      return true;
    });
    assert.equal(repository.list().length, 1, "the rejected write must not have emptied the table");
  });
});

test("V03: an invalid zone is refused and leaves the existing set intact", async () => {
  await withRepository((repository) => {
    repository.replace([zone()], 0);
    for (const invalid of [
      zone({ id: "x", radiusMeters: 0 }),
      zone({ id: "y", radiusMeters: 10_000 }),
      zone({ id: "z", centerLatitude: 91 }),
      zone({ id: "w", centerLongitude: -181 }),
      zone({ id: "v", label: "  " })
    ]) {
      assert.throws(() => repository.replace([invalid], 1), (error: unknown) => {
        assert.ok(error instanceof PrivacyZoneValidationError, `expected validation error for ${JSON.stringify(invalid)}`);
        return true;
      });
    }
    assert.equal(repository.list().length, 1, "a refused write must not roll back the previous set");
    assert.equal(repository.revision(), 1, "and must not consume a revision");
  });
});

test("V03: duplicate ids and an over-long list are refused before anything is written", async () => {
  await withRepository((repository) => {
    repository.replace([zone()], 0);
    assert.throws(
      () => repository.replace([zone(), zone({ label: "公司" })], 1),
      PrivacyZoneValidationError
    );
    const many = Array.from({ length: 21 }, (_, index) => zone({ id: `z${index}` }));
    assert.throws(() => repository.replace(many, 1), PrivacyZoneValidationError);
    assert.equal(repository.list().length, 1);
  });
});

test("V03: removing every zone is an ordinary write, and it is what makes future cards unfiltered", async () => {
  await withRepository((repository) => {
    repository.replace([zone()], 0);
    const revision = repository.replace([], 1);
    assert.equal(revision, 2);
    assert.deepEqual(repository.list(), []);
  });
});

test("a failed insert rolls back the entire privacy-zone replacement", async () => {
  await withRepository((repository, store) => {
    const service = new RaiApplicationService(store);
    service.replacePrivacyZones([zone()], 0);
    store.database.exec(`CREATE TRIGGER reject_privacy_zone BEFORE INSERT ON privacy_zones
      WHEN NEW.id = 'rejected' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END`);
    assert.throws(() => service.replacePrivacyZones([zone({ id: "first" }), zone({ id: "rejected" })], 1), /fixture insert failure/);
    assert.deepEqual(repository.list().map(item => item.id), ["home"]);
    assert.equal(repository.revision(), 1);
    assert.equal(service.replacePrivacyZones([zone()], 1).revision, 2);
  });
});

test("restored collection content invalidates stale writes even at the same revision", async () => {
  await withRepository((repository, store) => {
    const service = new RaiApplicationService(store);
    const original = service.replacePrivacyZones([zone()], 0, repository.stateToken());
    store.database.exec("UPDATE privacy_zones SET center_latitude = 32, label = 'restored' WHERE id = 'home'");
    assert.equal(repository.revision(), original.revision);
    assert.notEqual(repository.stateToken(), original.stateToken);
    assert.throws(() => service.replacePrivacyZones([], original.revision, original.stateToken), PrivacyZoneRevisionConflictError);
    assert.equal(repository.list()[0]?.centerLatitude, 32);
    assert.equal(repository.revision(), 1);
    const current = repository.stateToken();
    assert.equal(service.replacePrivacyZones([zone({ label: "updated" })], 1, current).revision, 2);
    assert.throws(() => service.replacePrivacyZones([], 1, current), PrivacyZoneRevisionConflictError,
      "a late request from another tab cannot reuse an already consumed state");
  });
});
