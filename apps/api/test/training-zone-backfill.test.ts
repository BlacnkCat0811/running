import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FEATURE_SCHEMA_VERSION, TRAINING_LOAD_CONFIG_VERSION } from "@rai/contracts";
import { RaiDatabase } from "@rai/health-export-parser";

import {
  needsFullTrainingZoneBackfill,
  readTrainingZoneWorkoutSetCounts
} from "../src/training-zone-backfill.js";

const currentState = {
  activeAlgorithmVersion: TRAINING_LOAD_CONFIG_VERSION,
  activeFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
  missingSummaryCount: 0,
  orphanSummaryCount: 0
};

test("requests a full startup backfill for an old active feature schema", () => {
  assert.equal(needsFullTrainingZoneBackfill({
    ...currentState,
    activeFeatureSchemaVersion: "workout-feature-v2"
  }), true);
});

test("does not request a full startup backfill when active analysis versions and counts are current", () => {
  assert.equal(needsFullTrainingZoneBackfill(currentState), false);
});

test("requests a full startup backfill when a load has no zone summary", () => {
  assert.equal(needsFullTrainingZoneBackfill({
    ...currentState,
    missingSummaryCount: 1
  }), true);
});

test("requests a full startup backfill when a zone summary has no load", () => {
  assert.equal(needsFullTrainingZoneBackfill({
    ...currentState,
    orphanSummaryCount: 1
  }), true);
});

test("requests a full startup backfill for equal-sized but mismatched workout sets", () => {
  assert.equal(needsFullTrainingZoneBackfill({
    ...currentState,
    missingSummaryCount: 1,
    orphanSummaryCount: 1
  }), true);
});

test("accepts two empty but matching workout sets", () => {
  assert.equal(needsFullTrainingZoneBackfill(currentState), false);
});

test("queries workout-set differences against the migrated RaiDatabase schema", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-training-zone-backfill-"));
  const path = join(root, "rai.sqlite");
  try {
    const store = await RaiDatabase.open(path);
    try {
      assert.deepEqual(readTrainingZoneWorkoutSetCounts(store.database), {
        missingSummaryCount: 0,
        orphanSummaryCount: 0
      });
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
