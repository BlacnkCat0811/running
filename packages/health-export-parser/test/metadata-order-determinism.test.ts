import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { workoutTypes } from "@rai/contracts";
import { analyzeDatasetChange } from "../../../apps/api/src/import-dataset-analysis.js";

import { parseAppleHealthXml } from "../src/apple-health-parser.js";
import { RaiDatabase } from "../src/database.js";
import { stableId } from "../src/utils.js";

/**
 * Two exports of the **same, unchanged** workout whose `<MetadataEntry>` lines
 * appear in opposite order.
 *
 * This is not a synthetic curiosity — it is what the app actually produced.
 * `HealthKitExport.metadataXML` walked `workout.metadata`, a Swift
 * `Dictionary`, whose iteration order is seeded per process. The parser turns
 * those lines into a `MetadataMap` (`addMetadata` creates the entry for a key on
 * first sight), so the *key order* of `workouts.metadata_json` changed between
 * two exports of an untouched run — and that whole object feeds
 * `stableId("workout_content", …)`.
 *
 * Two consequences, in this order:
 *   1. `observeImportEntity` sees a new content hash ⇒ `change_type='updated'`
 *      for the workout, so the incremental importer replays the model from the
 *      start of the window. That is the user-visible "已更新 N 次跑步" on a day
 *      with no new runs.
 *   2. Nothing here is about bytes: the *rows* are identical. So the judgement
 *      cannot be "the files differ" — it has to be "the entity did not change".
 *
 * The tests below pin both layers, plus the falsifier that keeps them honest:
 * a real metadata change **must** still be reported, otherwise "no changes" could
 * simply mean the change ledger was never written.
 */

const START = "2026-01-01 08:00:00 +0800";
const END = "2026-01-01 08:30:00 +0800";

/** `HKMetadataKeySyncIdentifier` fixes the workout's identity across exports. */
const METADATA_KEYS = ["HKA", "HKB"] as const;

function exportXml(
  order: "forward" | "reverse",
  overrides: Record<string, string> = {},
  exportDate = "2026-01-03 00:00:00 +0800"
): string {
  const keys: readonly string[] =
    order === "forward" ? METADATA_KEYS : [...METADATA_KEYS].reverse();
  const entries = keys
    .map((key) => `    <MetadataEntry key="${key}" value="${overrides[key] ?? `v-${key}`}"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <ExportDate value="${exportDate}"/>
  <Workout workoutActivityType="${workoutTypes.running}" duration="30" durationUnit="min" sourceName="Watch" sourceVersion="1" creationDate="${START}" startDate="${START}" endDate="${END}" device="Watch">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <MetadataEntry key="HKMetadataKeySyncIdentifier" value="sync-1"/>
    <MetadataEntry key="RAIHealthKitWorkoutUUID" value="uuid-1"/>
${entries}
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" unit="km" sum="5"/>
  </Workout>
</HealthData>`;
}

interface WorkoutDigest {
  id: string;
  contentHash: string;
}

function digestOf(store: RaiDatabase): WorkoutDigest {
  const workout = store.database.prepare("SELECT id FROM workouts").get() as { id: string };
  const generation = store.database
    .prepare(
      "SELECT content_hash AS contentHash FROM import_entity_generations WHERE entity_kind = 'workout' AND entity_id = ?"
    )
    .get(workout.id) as { contentHash: string };
  return { id: workout.id, contentHash: generation.contentHash };
}

function changeRows(store: RaiDatabase, batchId: string): Array<{ entityKind: string; changeType: string }> {
  // Rebuilt as plain objects: `node:sqlite` rows have a null prototype, so a
  // `deepEqual` against an object literal fails on the prototype alone.
  const rows = store.database
    .prepare(
      "SELECT entity_kind AS entityKind, change_type AS changeType FROM import_entity_changes WHERE batch_id = ? ORDER BY entity_kind, change_type"
    )
    .all(batchId) as Array<{ entityKind: string; changeType: string }>;
  return rows.map((row) => ({ entityKind: row.entityKind, changeType: row.changeType }));
}

function openBatch(store: RaiDatabase, id: string, status: string): void {
  store.database
    .prepare(
      "INSERT INTO import_batches (id, xml_sha256, status, import_mode, summary_json) VALUES (?, 'pending', ?, 'incremental', '{}')"
    )
    .run(id, status);
}

test("canonicalising object keys leaves every primitive-array identity byte-identical", () => {
  // The safety property that makes this change deployable without touching any
  // stored data: every real primary key — record, workout, route,
  // training_session, canonical_night, workout_group and the job ids — passes a
  // flat array of primitives, so its hash must be **exactly** what the plain
  // `JSON.stringify` formula produced. Recomputed here the old way, so this goes
  // red the moment anyone extends canonicalisation to arrays.
  const parts = [
    "HKQuantityTypeIdentifierRunningSpeed",
    "唐攀的Apple Watch",
    "2026-09-01T10:00:00.000Z",
    "2026-09-01T10:00:10.000Z",
    "10.5",
    "km/hr"
  ];
  const legacy = createHash("sha256");
  legacy.update("record");
  legacy.update("\0");
  legacy.update(JSON.stringify(parts));
  assert.equal(stableId("record", parts), `record_${legacy.digest("hex").slice(0, 32)}`);

  // Arrays are a sequence, not a set: reordering two entries must still produce a
  // different id. `metadata[key]` relies on this (`lastMetadataValue` takes the
  // last entry).
  const swapped = [parts[1]!, parts[0]!, ...parts.slice(2)];
  assert.notEqual(stableId("record", swapped), stableId("record", parts));
});

test("a reversed <MetadataEntry> order keeps the same workout row and the same content hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-metadata-order-"));
  const xmlPath = join(root, "export.xml");
  const stores: RaiDatabase[] = [];
  try {
    const digests: WorkoutDigest[] = [];
    for (const order of ["forward", "reverse"] as const) {
      const store = await RaiDatabase.open(join(root, `${order}.sqlite`));
      stores.push(store);
      writeFileSync(xmlPath, exportXml(order));
      await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });
      digests.push(digestOf(store));
    }
    assert.equal(digests.length, 2);
    // The identity comes from `HKMetadataKeySyncIdentifier` and must not move at
    // all: `stableId` canonicalises object **keys**, never arrays, so every real
    // primary key (a flat list of primitives) hashes exactly as before. A
    // regression here would rename rows across the whole database.
    assert.equal(
      digests[1]!.id,
      digests[0]!.id,
      "the <MetadataEntry> line order changed the workout's stable id"
    );
    assert.equal(
      digests[1]!.contentHash,
      digests[0]!.contentHash,
      "the <MetadataEntry> line order changed the workout's content hash"
    );
  } finally {
    stores.forEach((store) => store.close());
    rmSync(root, { recursive: true, force: true });
  }
});

test("re-importing the same workout with the <MetadataEntry> lines reversed reports no change", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-metadata-order-incremental-"));
  const xmlPath = join(root, "export.xml");
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    writeFileSync(xmlPath, exportXml("forward"));
    await parseAppleHealthXml(xmlPath, store, { fileSize: statSync(xmlPath).size });

    openBatch(store, "order-swap", "succeeded");
    writeFileSync(xmlPath, exportXml("reverse"));
    const result = await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "order-swap", batchId: "order-swap", preserveAbsent: true }
    });
    assert.equal(result.insertedWorkoutCount, 0);
    assert.deepEqual(
      changeRows(store, "order-swap"),
      [],
      "an order-only re-export must not be recorded as a change"
    );

    // The falsifier. Without it "no rows" could just mean this batch never wrote
    // to the ledger at all (a wrong batch id, or an incremental path that
    // silently fell back to a full import) — which would make the assertion
    // above pass for the wrong reason.
    openBatch(store, "value-change", "succeeded");
    writeFileSync(xmlPath, exportXml("reverse", { HKA: "v-HKA-changed" }));
    const mutated = await parseAppleHealthXml(xmlPath, store, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "value-change", batchId: "value-change", preserveAbsent: true }
    });
    assert.deepEqual(
      changeRows(store, "value-change"),
      [{ entityKind: "workout", changeType: "updated" }],
      "a real metadata change must still be recorded as an update"
    );
    assert.equal(mutated.insertedWorkoutCount, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real re-export — a new <ExportDate> wall clock plus a reshuffled metadata order — is still unchanged", async () => {
  // This is the scenario the app actually produced, and the one the earlier
  // tests missed: they all pinned `<ExportDate>` to a constant, while the
  // exporter writes `appleDate(Date())` — a fresh wall clock on every export.
  // If any part of the diff keyed on the raw XML bytes, `unchanged` would be
  // unreachable in production no matter how deterministic the exporter became,
  // and the whole A/B/C fix would be only half green.
  const root = mkdtempSync(join(tmpdir(), "rai-export-date-"));
  const xmlPath = join(root, "export.xml");
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const batchId = "export-date-diff";
  const previous = await RaiDatabase.open(previousPath);
  const staging = await RaiDatabase.open(stagingPath);
  let xmlSha256: [string, string] = ["", ""];
  try {
    writeFileSync(xmlPath, exportXml("forward", {}, "2026-01-03 00:00:00 +0800"));
    const size = statSync(xmlPath).size;
    await parseAppleHealthXml(xmlPath, previous, { fileSize: size });
    await parseAppleHealthXml(xmlPath, staging, { fileSize: size });

    openBatch(staging, batchId, "succeeded");
    writeFileSync(xmlPath, exportXml("reverse", {}, "2026-01-04 09:17:42 +0800"));
    await parseAppleHealthXml(xmlPath, staging, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "export-date", batchId, preserveAbsent: true }
    });
    const fingerprint = (store: RaiDatabase): string =>
      (
        store.database
          .prepare("SELECT value FROM import_manifest WHERE key = 'source_xml_sha256'")
          .get() as { value: string }
      ).value;
    xmlSha256 = [fingerprint(previous), fingerprint(staging)];
  } finally {
    previous.close();
    staging.close();
  }
  try {
    // Anti-false-green: prove the two exports really were byte-different XML.
    // Without this the assertions below could pass because the fixture was
    // accidentally identical, not because the diff is robust.
    assert.notEqual(
      xmlSha256[1],
      xmlSha256[0],
      "the fixture did not actually change the XML bytes, so it proves nothing"
    );
    const change = analyzeDatasetChange(stagingPath, previousPath, batchId);
    assert.equal(change.updatedWorkouts, 0, "a moving <ExportDate> was read as a workout update");
    assert.equal(change.insertedWorkouts, 0);
    assert.equal(change.removedWorkouts, 0);
    // `unchanged` is what lets the worker skip the job and its full-database
    // backup. Anything else means the server still does the work.
    assert.equal(
      change.mode,
      "unchanged",
      "a re-export whose only byte difference is <ExportDate> must still be unchanged"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Reproduce the `dataset_version` write that the production import performs.
 *
 * `apps/api/src/import-worker.ts:492-496` runs the import as a child process:
 * `tsx packages/health-export-parser/src/cli.ts incremental-import …`, and that
 * command ends with (`cli.ts:338-344`):
 *
 *   SELECT key,value FROM import_manifest
 *     WHERE key IN ('source_xml_sha256','source_gpx_bundle_sha256') ORDER BY key
 *   setManifest("dataset_version", stableId("dataset", fingerprints))
 *
 * Omitting this step is how a test can go green while production still never
 * classifies a re-export as `unchanged`: `analyzeDatasetChange` compares
 * `dataset_version` (`import-dataset-analysis.ts:115-122`), so if the field moves
 * on every import, the verdict can never be `unchanged` no matter how
 * deterministic the exporter becomes.
 */
function persistDatasetVersion(store: RaiDatabase): string {
  const fingerprints = store.database
    .prepare(
      "SELECT key, value FROM import_manifest WHERE key IN ('source_xml_sha256', 'source_gpx_bundle_sha256') ORDER BY key"
    )
    .all() as unknown as Array<{ key: string; value: string }>;
  const value = stableId("dataset", fingerprints);
  store.setManifest("dataset_version", value);
  return value;
}

test("the production dataset_version chain: a moving <ExportDate> still classifies as unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-dataset-version-"));
  const xmlPath = join(root, "export.xml");
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const batchId = "dataset-version-diff";
  const previous = await RaiDatabase.open(previousPath);
  const staging = await RaiDatabase.open(stagingPath);
  const versions: string[] = [];
  try {
    // Both sides start from the identical export, the way `previous` is a
    // snapshot of the last successful import.
    writeFileSync(xmlPath, exportXml("forward", {}, "2026-01-03 00:00:00 +0800"));
    const size = statSync(xmlPath).size;
    await parseAppleHealthXml(xmlPath, previous, { fileSize: size });
    versions.push(persistDatasetVersion(previous));
    await parseAppleHealthXml(xmlPath, staging, { fileSize: size });
    versions.push(persistDatasetVersion(staging));

    // Now the real re-export: new wall clock in <ExportDate>, reshuffled
    // metadata order, zero changes to the workout itself.
    openBatch(staging, batchId, "succeeded");
    writeFileSync(xmlPath, exportXml("reverse", {}, "2026-01-04 09:17:42 +0800"));
    await parseAppleHealthXml(xmlPath, staging, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "dataset-version", batchId, preserveAbsent: true }
    });
    persistDatasetVersion(staging);
    versions.push(persistDatasetVersion(staging));
  } finally {
    previous.close();
    staging.close();
  }
  try {
    const change = analyzeDatasetChange(stagingPath, previousPath, batchId);
    assert.equal(change.updatedWorkouts, 0, "a moving <ExportDate> was read as a workout update");
    assert.equal(
      change.mode,
      "unchanged",
      `the import diff must stay unchanged across a re-export; ` +
        `dataset_version moved (${versions[0]} -> ${versions[versions.length - 1]}) even though no entity changed`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an order-only re-export is classified as unchanged by the import diff", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-metadata-order-diff-"));
  const xmlPath = join(root, "export.xml");
  const previousPath = join(root, "previous.sqlite");
  const stagingPath = join(root, "staging.sqlite");
  const batchId = "order-swap-diff";
  // Two separate files rather than a snapshot of one: `previous` is the state
  // before the swapped re-export, so the diff sees exactly that one difference.
  const previous = await RaiDatabase.open(previousPath);
  const staging = await RaiDatabase.open(stagingPath);
  try {
    writeFileSync(xmlPath, exportXml("forward"));
    const size = statSync(xmlPath).size;
    await parseAppleHealthXml(xmlPath, previous, { fileSize: size });
    await parseAppleHealthXml(xmlPath, staging, { fileSize: size });

    openBatch(staging, batchId, "succeeded");
    writeFileSync(xmlPath, exportXml("reverse"));
    await parseAppleHealthXml(xmlPath, staging, {
      fileSize: statSync(xmlPath).size,
      incremental: { generation: "order-swap", batchId, preserveAbsent: true }
    });
  } finally {
    previous.close();
    staging.close();
  }
  try {
    const change = analyzeDatasetChange(stagingPath, previousPath, batchId);
    assert.equal(change.updatedWorkouts, 0, "the diff saw a workout update that did not happen");
    assert.equal(change.insertedWorkouts, 0);
    assert.equal(change.removedWorkouts, 0);
    assert.equal(change.routesUpdated, 0);
    // This is the assertion that matters operationally: `unchanged` is what makes
    // the worker skip the import (and its full-database backup) entirely. A
    // `data-only` verdict with zero updated workouts still means real work.
    assert.equal(change.mode, "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
