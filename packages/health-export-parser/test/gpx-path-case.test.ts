import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workoutTypes } from "@rai/contracts";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { RaiDatabase } from "../src/database.js";
import { importGpxRoutes } from "../src/gpx-parser.js";
import {
  normalizeRelativePath,
  normalizeRelativePathForFileSystem
} from "../src/utils.js";

const appleDate = (hour: string): string => `2026-01-02 ${hour}:00 +0800`;

const gpxWithElevation = `<gpx><trk><trkseg>
  <trkpt lat="23.1" lon="113.3"><ele>12.5</ele></trkpt>
  <trkpt lat="23.2" lon="113.4"><ele>15</ele></trkpt>
</trkseg></trk></gpx>`;

function writeExport(root: string, referenceName: string): string {
  mkdirSync(join(root, "workout-routes"), { recursive: true });
  const xmlPath = join(root, "export.xml");
  writeFileSync(
    xmlPath,
    `<HealthData><Workout workoutActivityType="${workoutTypes.running}"
      sourceName="Watch" startDate="${appleDate("08:00")}" endDate="${appleDate("08:30")}" duration="30" durationUnit="min">
      <WorkoutRoute><FileReference path="/workout-routes/${referenceName}"/></WorkoutRoute>
    </Workout></HealthData>`,
    "utf8"
  );
  return xmlPath;
}

test("keeps case when normalizing a path for the filesystem", () => {
  assert.equal(
    normalizeRelativePathForFileSystem("\\Workout-Routes\\Route-A.GPX"),
    "Workout-Routes/Route-A.GPX"
  );
  assert.equal(normalizeRelativePathForFileSystem("/workout-routes/A.gpx"), "workout-routes/A.gpx");
  // Identity lookups stay case-insensitive on top of the same normalization.
  assert.equal(normalizeRelativePath("/workout-routes/Route-A.GPX"), "workout-routes/route-a.gpx");
});

test("imports a route whose archived path case differs from the XML reference", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-gpx-case-mismatch-"));
  const xmlPath = writeExport(root, "mixedcaseroute.gpx");
  // iOS names the entry after the uppercased `HKWorkout.uuidString`; the export
  // pipeline lowercases the path identity it stores. Both must still meet.
  const onDiskName = "MixedCaseRoute.GPX";
  writeFileSync(join(root, "workout-routes", onDiskName), gpxWithElevation, "utf8");

  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    const result = await importGpxRoutes(root, store, { preserveAbsent: true });

    assert.equal(result.routeFileCount, 1);
    assert.equal(result.importedRouteCount, 1);
    assert.equal(result.missingRouteCount, 0);
    assert.equal(result.unresolvedRouteCount, 0);
    assert.equal(result.pointCount, 2);

    const routes = store.database
      .prepare("SELECT id, workout_id, relative_path, point_count, file_status FROM workout_routes")
      .all() as unknown as Array<{
        id: string; workout_id: string | null; relative_path: string;
        point_count: number; file_status: string;
      }>;
    assert.equal(routes.length, 1);
    // The XML-referenced row must be the one that received the points — not an orphan.
    assert.ok(routes[0]!.workout_id);
    assert.equal(routes[0]!.relative_path, "workout-routes/mixedcaseroute.gpx");
    assert.equal(routes[0]!.file_status, "imported");
    assert.equal(routes[0]!.point_count, 2);

    const points = store.database
      .prepare("SELECT elevation_meters FROM route_points WHERE route_id = ? ORDER BY sequence")
      .all(routes[0]!.id) as unknown as Array<{ elevation_meters: number }>;
    assert.deepEqual(points.map((point) => point.elevation_meters), [12.5, 15]);

    // Fingerprints keep the on-disk case so the next import finds its own row.
    const fingerprint = store.database
      .prepare("SELECT relative_path FROM route_file_fingerprints")
      .get() as unknown as { relative_path: string };
    assert.equal(fingerprint.relative_path, `workout-routes/${onDiskName}`);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested routes are imported and not pruned as missing on the next import", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-gpx-nested-"));
  const xmlPath = writeExport(root, "year/Route.GPX");
  mkdirSync(join(root, "workout-routes/year"));
  writeFileSync(join(root, "workout-routes/year/Route.GPX"), gpxWithElevation);
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
    for (const preserveAbsent of [true, false]) {
      const result = await importGpxRoutes(root, store, { preserveAbsent });
      assert.equal(result.routeFileCount, 1);
      assert.equal(result.pointCount, 2);
      assert.equal(result.missingRouteCount, 0);
    }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
