import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workoutTypes } from "@rai/contracts";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { RaiDatabase } from "../src/database.js";

interface FixtureWorkout {
  start: string;
  syncId: string;
}

function startOf(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + index));
  return `${date.toISOString().slice(0, 10)} 08:00:00 +0800`;
}

function exportXml(workouts: readonly FixtureWorkout[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US"><ExportDate value="2026-06-01 00:00:00 +0800"/>
${workouts.map((workout) => `<Workout workoutActivityType="${workoutTypes.running}"
 sourceName="Watch" startDate="${workout.start}" endDate="${workout.start.replace("08:00:00", "08:30:00")}"
 duration="30" durationUnit="min">
  <MetadataEntry key="HKMetadataKeySyncIdentifier" value="${workout.syncId}"/>
</Workout>`).join("\n")}
</HealthData>`;
}

/** 仍在数据集里的训练数。软删（v36）之后"行还在、事实已删"，所以只数 `deleted_at IS NULL`。 */
function workoutCount(store: RaiDatabase): number {
  return (store.database.prepare(
    "SELECT COUNT(*) AS count FROM workouts WHERE deleted_at IS NULL"
  ).get() as { count: number }).count;
}

/** 仍在数据集里的训练 id（软删行不算：`deleted_at` 非空 = 事实已删）。 */
function workoutIds(store: RaiDatabase): string[] {
  return (store.database.prepare(
    "SELECT id FROM workouts WHERE deleted_at IS NULL ORDER BY start_at"
  ).all() as unknown as Array<{ id: string }>).map((row) => row.id);
}

async function openStore(root: string, xmlPath: string): Promise<RaiDatabase> {
  writeFileSync(xmlPath, exportXml([
    { start: startOf(0), syncId: "sync-a" },
    { start: startOf(1), syncId: "sync-b" },
    { start: startOf(2), syncId: "sync-c" }
  ]));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
  return store;
}

/**
 * The resurrection path this protects: an explicit deletion is followed by a
 * later payload that still carries the removed entity (a re-uploaded older
 * archive, a client whose anchor was reset). Deletion must be durable, so the
 * entity must not come back.
 */
test("an explicitly deleted workout is not resurrected by a later payload", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-tombstone-resurrect-"));
  const xmlPath = join(root, "export.xml");
  try {
    const store = await openStore(root, xmlPath);
    try {
      assert.equal(workoutCount(store), 3);
      const ids = workoutIds(store);
      const [idA, idB, idC] = ids;
      assert.ok(idA && idB && idC, "expected three workout ids");

      // The client reports that its second workout was deleted in Health.
      const removed = store.removeWorkoutsBySyncIdentifiers(["sync-b"]);
      assert.equal(removed.length, 1);
      assert.equal(workoutCount(store), 2);
      assert.equal(store.countEntityTombstones(), 1);
      assert.equal(
        store.isEntityTombstoned("workout", idB),
        true,
        "the removed workout must leave a durable tombstone"
      );

      // The same workout reappears in a full history payload.
      await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "generation-after-delete", preserveAbsent: true }
      });
      assert.equal(workoutCount(store), 2, "a tombstoned workout must stay deleted");
      assert.deepEqual(workoutIds(store), [idA, idC]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the parser reports how many carried entities a tombstone kept deleted", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-tombstone-report-"));
  const xmlPath = join(root, "export.xml");
  try {
    const store = await openStore(root, xmlPath);
    try {
      store.removeWorkoutsBySyncIdentifiers(["sync-a", "sync-c"]);
      assert.equal(workoutCount(store), 1);

      const result = await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "generation-report", preserveAbsent: true }
      });
      assert.equal(result.tombstonedCount, 2, "the payload still carried both deleted workouts");
      assert.equal(result.insertedWorkoutCount, 0);
      assert.equal(workoutCount(store), 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Deletion by absence still exists, but only for a payload that declares itself
 * a complete snapshot. It must leave tombstones too, otherwise the next sync
 * that still mentions the entity would silently restore it.
 */
test("deletion by absence records tombstones as well", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-tombstone-absence-"));
  const xmlPath = join(root, "export.xml");
  try {
    const store = await openStore(root, xmlPath);
    try {
      writeFileSync(xmlPath, exportXml([{ start: startOf(0), syncId: "sync-a" }]));
      await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "generation-snapshot" }
      });
      assert.equal(workoutCount(store), 1);
      assert.equal(store.countEntityTombstones(), 2, "each removed workout leaves a tombstone");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A complete snapshot is authoritative about what exists, so it is allowed to
 * supersede earlier tombstones. Without this, a user who deleted a session by
 * mistake could never bring it back from a good archive.
 */
test("an authoritative full snapshot clears earlier tombstones", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-tombstone-cleared-"));
  const xmlPath = join(root, "export.xml");
  try {
    const store = await openStore(root, xmlPath);
    try {
      store.removeWorkoutsBySyncIdentifiers(["sync-b"]);
      assert.equal(store.countEntityTombstones(), 1);

      await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "generation-authoritative", guardAbsentRemoval: false }
      });
      assert.equal(store.countEntityTombstones(), 0, "a complete snapshot supersedes old tombstones");
      assert.equal(workoutCount(store), 3, "the superseded deletion is restored");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


for (const deletionKey of ["HKMetadataKeySyncIdentifier", "RAIHealthKitWorkoutUUID"]) {
  test(`deletion before arrival stays durable via ${deletionKey}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "rai-tombstone-before-arrival-"));
    const xmlPath = join(root, "export.xml");
    const databasePath = join(root, "rai.sqlite");
    let store = await RaiDatabase.open(databasePath, { createMigrationBackup: false });
    try {
      assert.deepEqual(store.removeWorkoutsBySyncIdentifiers(["deleted-id"]), []);
      store.close();
      store = await RaiDatabase.open(databasePath, { createMigrationBackup: false });
      let xml = exportXml([
        { start: startOf(0), syncId: deletionKey === "HKMetadataKeySyncIdentifier" ? "deleted-id" : "other-sync" },
        { start: startOf(1), syncId: "unrelated" }
      ]);
      if (deletionKey === "RAIHealthKitWorkoutUUID") {
        xml = xml.replace('</Workout>', '<MetadataEntry key="RAIHealthKitWorkoutUUID" value="deleted-id"/></Workout>');
      }
      writeFileSync(xmlPath, xml);
      const result = await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "old-archive", preserveAbsent: true }
      });
      assert.equal(result.tombstonedCount, 1);
      assert.equal(workoutCount(store), 1);
      // An authoritative snapshot explicitly restores the previously deleted entity.
      await parseAppleHealthXml(xmlPath, store, {
        fileSize: statSync(xmlPath).size,
        incremental: { generation: "authoritative" }
      });
      assert.equal(workoutCount(store), 2);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
