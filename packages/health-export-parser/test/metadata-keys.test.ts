import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { healthTypes, workoutTypes, type MetadataMap } from "@rai/contracts";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { RaiDatabase } from "../src/database.js";
import { addMetadata, lastMetadataValue, stableId } from "../src/utils.js";

const keys = ["__proto__", "constructor", "toString", "hasOwnProperty"];

test("metadata keys are data, never inherited properties or prototype setters", () => {
  const metadata: MetadataMap = {};
  for (const key of keys) {
    assert.equal(lastMetadataValue(metadata, key), null);
    addMetadata(metadata, key, "first");
    addMetadata(metadata, key, "last");
    assert.deepEqual(metadata[key], ["first", "last"]);
    assert.equal(lastMetadataValue(metadata, key), "last");
    assert.ok(Object.hasOwn(metadata, key));
  }
  assert.equal(Object.getPrototypeOf(metadata), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), Object.fromEntries(keys.map(key => [key, ["first", "last"]])));
});

test("content hashes retain prototype-like keys and distinguish their values", () => {
  const data = JSON.parse('{"__proto__":["one"],"constructor":["two"]}');
  const reordered = JSON.parse('{"constructor":["two"],"__proto__":["one"]}');
  const changed = JSON.parse('{"__proto__":["changed"],"constructor":["two"]}');
  assert.equal(stableId("content", [data]), stableId("content", [reordered]));
  assert.notEqual(stableId("content", [data]), stableId("content", [changed]));
  assert.notEqual(stableId("content", [data]), stableId("content", [{ constructor: ["two"] }]));
});

test("Health XML imports prototype-like metadata on records, workouts, events and routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-metadata-keys-"));
  const path = join(root, "export.xml");
  const entries = keys.map(key => `<MetadataEntry key="${key}" value="value-${key}"/>`).join("");
  writeFileSync(path, `<HealthData>
    <Record type="${healthTypes.heartRate}" sourceName="Watch" unit="count/min" value="150" __proto__="raw-data"
      startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:01:00 +0800">${entries}</Record>
    <Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch" duration="30" durationUnit="min"
      startDate="2026-01-02 08:00:00 +0800" endDate="2026-01-02 08:30:00 +0800">${entries}
      <WorkoutEvent type="HKWorkoutEventTypePause" date="2026-01-02 08:10:00 +0800">${entries}</WorkoutEvent>
      <WorkoutRoute>${entries}<FileReference path="/workout-routes/route.gpx"/></WorkoutRoute>
    </Workout>
  </HealthData>`, "utf8");
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    const result = await parseAppleHealthXml(path, store, { fileSize: statSync(path).size, native: { engine: "typescript" } });
    assert.equal(result.recordCount, 1);
    assert.equal(result.workoutCount, 1);
    const attributes = store.database.prepare("SELECT raw_attributes_json FROM health_records").get()!;
    assert.equal(JSON.parse(String(attributes.raw_attributes_json)).__proto__, "raw-data");
    for (const table of ["health_records", "workouts", "workout_events", "workout_routes"]) {
      const row = store.database.prepare(`SELECT metadata_json FROM ${table}`).get()!;
      assert.deepEqual(JSON.parse(String(row.metadata_json)), Object.fromEntries(keys.map(key => [key, [`value-${key}`]])));
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
