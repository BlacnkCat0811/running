import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CanonicalWorkout, RoutePoint } from "@rai/contracts";

import { RaiDatabase } from "../src/database.js";

function sampleWorkout(overrides: Partial<CanonicalWorkout> = {}): CanonicalWorkout {
  return {
    id: "workout-a",
    activityType: "HKWorkoutActivityTypeRunning",
    sourceName: "Watch",
    sourceVersion: "1",
    device: null,
    startAt: "2026-01-01T00:00:00.000Z",
    endAt: "2026-01-01T00:30:00.000Z",
    createdAt: null,
    durationSeconds: 1800,
    indoor: false,
    metadata: {},
    statistics: [],
    events: [],
    routes: [],
    ...overrides
  };
}

function sampleRoute(id: string, relativePath: string) {
  return {
    id,
    sourceName: "Watch",
    sourceVersion: "1",
    startAt: "2026-01-01T00:00:00.000Z",
    endAt: "2026-01-01T00:30:00.000Z",
    createdAt: null,
    relativePath,
    metadata: {}
  };
}

function samplePoint(sequence: number, latitude: number): RoutePoint {
  return {
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    latitude,
    longitude: 121.1,
    elevationMeters: 5,
    speedMetersPerSecond: 2.5,
    courseDegrees: null,
    horizontalAccuracyMeters: 4,
    verticalAccuracyMeters: null
  };
}

test("preserve-absent insertWorkout keeps routes when the payload omits them", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-storage-preserve-routes-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    store.insertWorkout(
      sampleWorkout({
        routes: [sampleRoute("route-a", "workout-routes/a.gpx")]
      }),
      "apple_watch",
      {}
    );
    store.replaceRoutePoints("route-a", [samplePoint(0, 31.1), samplePoint(1, 31.2)]);

    store.insertWorkout(
      sampleWorkout({ durationSeconds: 1860, routes: [] }),
      "apple_watch",
      {},
      { preserveAbsent: true }
    );

    const route = store.database.prepare(`
      SELECT id, point_count AS pointCount, file_status AS fileStatus
      FROM workout_routes WHERE workout_id = 'workout-a'
    `).get() as { id: string; pointCount: number; fileStatus: string };
    const points = store.database.prepare("SELECT COUNT(*) AS count FROM route_points").get() as { count: number };
    const duration = store.database.prepare(
      "SELECT duration_seconds AS duration FROM workouts WHERE id = 'workout-a'"
    ).get() as { duration: number };
    assert.equal(route.id, "route-a");
    assert.equal(route.pointCount, 2);
    assert.equal(route.fileStatus, "imported");
    assert.equal(points.count, 2);
    assert.equal(duration.duration, 1860);

    store.insertWorkout(sampleWorkout({ routes: [] }), "apple_watch", {});
    const stripped = store.database.prepare("SELECT COUNT(*) AS count FROM workout_routes").get() as { count: number };
    assert.equal(stripped.count, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserve-absent insertWorkout upserts present routes without deleting omitted ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-storage-preserve-subset-routes-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    store.insertWorkout(
      sampleWorkout({
        routes: [
          sampleRoute("route-a", "workout-routes/a.gpx"),
          sampleRoute("route-b", "workout-routes/b.gpx")
        ]
      }),
      "apple_watch",
      {}
    );
    store.replaceRoutePoints("route-a", [samplePoint(0, 31.1)]);
    store.replaceRoutePoints("route-b", [samplePoint(0, 32.2), samplePoint(1, 32.3)]);

    store.insertWorkout(
      sampleWorkout({
        durationSeconds: 1860,
        routes: [
          sampleRoute("route-a", "workout-routes/a.gpx"),
          sampleRoute("route-c", "workout-routes/c.gpx")
        ]
      }),
      "apple_watch",
      {},
      { preserveAbsent: true }
    );

    const routes = store.database.prepare(`
      SELECT id, relative_path AS relativePath, point_count AS pointCount, file_status AS fileStatus
      FROM workout_routes WHERE workout_id = 'workout-a' ORDER BY id
    `).all() as Array<{ id: string; relativePath: string; pointCount: number; fileStatus: string }>;
    assert.deepEqual(routes.map((row) => ({ ...row })), [
      { id: "route-a", relativePath: "workout-routes/a.gpx", pointCount: 1, fileStatus: "imported" },
      { id: "route-b", relativePath: "workout-routes/b.gpx", pointCount: 2, fileStatus: "imported" },
      { id: "route-c", relativePath: "workout-routes/c.gpx", pointCount: 0, fileStatus: "pending" }
    ]);
    assert.equal(
      (store.database.prepare("SELECT COUNT(*) AS count FROM route_points").get() as { count: number }).count,
      3
    );
    assert.equal(
      (store.database.prepare(
        "SELECT duration_seconds AS duration FROM workouts WHERE id = 'workout-a'"
      ).get() as { duration: number }).duration,
      1860
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserve-absent insertWorkout skips relative_path collisions instead of deleting the owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-storage-route-collision-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    store.insertWorkout(
      sampleWorkout({
        id: "workout-a",
        routes: [sampleRoute("route-a", "workout-routes/route_1.gpx")]
      }),
      "apple_watch",
      {}
    );
    store.replaceRoutePoints("route-a", [samplePoint(0, 31.1)]);

    store.insertWorkout(
      sampleWorkout({
        id: "workout-b",
        startAt: "2026-01-02T00:00:00.000Z",
        endAt: "2026-01-02T00:30:00.000Z",
        routes: [sampleRoute("route-b", "workout-routes/route_1.gpx")]
      }),
      "apple_watch",
      {},
      { preserveAbsent: true }
    );

    const routes = store.database.prepare(`
      SELECT id, workout_id AS workoutId, point_count AS pointCount
      FROM workout_routes ORDER BY id
    `).all() as Array<{ id: string; workoutId: string; pointCount: number }>;
    const points = store.database.prepare("SELECT COUNT(*) AS count FROM route_points").get() as { count: number };
    assert.deepEqual(routes.map((row) => ({ ...row })), [
      { id: "route-a", workoutId: "workout-a", pointCount: 1 }
    ]);
    assert.equal(points.count, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("setProfile merge keeps existing keys when incoming Me is empty or a subset", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-storage-profile-merge-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"), { createMigrationBackup: false });
  try {
    store.setProfile({
      HKCharacteristicTypeIdentifierDateOfBirth: "1990-01-01",
      HKCharacteristicTypeIdentifierHeight: "180",
      HKCharacteristicTypeIdentifierBiologicalSex: "HKBiologicalSexMale"
    });

    store.setProfile({}, { merge: true });
    store.setProfile(
      { HKCharacteristicTypeIdentifierBiologicalSex: "HKBiologicalSexMale" },
      { merge: true }
    );

    const merged = JSON.parse(
      (store.database.prepare("SELECT attributes_json AS attributesJson FROM profile WHERE id = 1")
        .get() as { attributesJson: string }).attributesJson
    ) as Record<string, string>;
    assert.equal(merged.HKCharacteristicTypeIdentifierDateOfBirth, "1990-01-01");
    assert.equal(merged.HKCharacteristicTypeIdentifierHeight, "180");
    assert.equal(merged.HKCharacteristicTypeIdentifierBiologicalSex, "HKBiologicalSexMale");

    store.setProfile(
      { HKCharacteristicTypeIdentifierBiologicalSex: "HKBiologicalSexFemale" },
      { merge: true }
    );
    const updated = JSON.parse(
      (store.database.prepare("SELECT attributes_json AS attributesJson FROM profile WHERE id = 1")
        .get() as { attributesJson: string }).attributesJson
    ) as Record<string, string>;
    assert.equal(updated.HKCharacteristicTypeIdentifierDateOfBirth, "1990-01-01");
    assert.equal(updated.HKCharacteristicTypeIdentifierBiologicalSex, "HKBiologicalSexFemale");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
