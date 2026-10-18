import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { healthTypes, workoutTypes } from "@rai/contracts";
import { canonicalizeRunningWorkouts, parseAppleHealthXml } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

/**
 * §6.9 / P3-10: the *why* of a refused true-ability update has to survive the trip
 * into the database.
 *
 * `updateTrueAbilityFromFeatureScore` already distinguishes nine refusal reasons and
 * the docs promise a per-reason report, but the recompute pipeline used to persist
 * only `updated_true_ability: false` — the reason was computed and dropped, so the
 * only way to answer "why did TA not move?" was to re-derive the thresholds, which
 * the design explicitly forbids. The reason now lives in `explanation_json` (no
 * migration: it is an existing JSON column).
 *
 * The fixture is seven 30-minute runs; the last one carries only WorkoutStatistics
 * (an average heart rate with no series), so it is `trial` and its TA update must be
 * refused with a reason.
 */

const appleDate = (day: number, time: string): string =>
  `2026-01-${String(day).padStart(2, "0")} ${time}:00 +0800`;

const REFUSAL_REASONS = [
  "not_eligible",
  "no_learning_target",
  "no_evidence_strength",
  "reliability_missing",
  "reliability_below_learning_minimum",
  "comparability_missing",
  "comparability_below_learning_minimum",
  "awaiting_negative_confirmation",
  "unchanged_after_update"
] as const;

test("P3-10: a refused true-ability update persists its refusal reason in explanation_json", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-refusal-attribution-"));
  try {
    const xmlPath = join(root, "export.xml");
    // Six series-backed runs complete calibration (6 sessions / 14-day span), then a
    // seventh run with statistics only: eligible for an assessment, not for learning.
    const days = [1, 4, 7, 10, 13, 16, 19];
    const workouts = days.map((day, index) => `
  <Workout workoutActivityType="${workoutTypes.running}" duration="30" durationUnit="min" sourceName="Fixture Apple Watch" sourceVersion="1" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" device="Watch">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <WorkoutStatistics type="${healthTypes.distanceWalkingRunning}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" sum="${(5 + index * 0.08).toFixed(2)}" unit="km"/>
    <WorkoutStatistics type="${healthTypes.heartRate}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" average="${145 + index}" minimum="120" maximum="172" unit="count/min"/>
  </Workout>`).join("");
    const heartRecords = days.slice(0, 6).flatMap((day, index) =>
      Array.from({ length: 15 }, (_, sample) => {
        const minute = String(sample * 2).padStart(2, "0");
        const endMinute = String(sample * 2 + 1).padStart(2, "0");
        return `
  <Record type="${healthTypes.heartRate}" sourceName="Fixture Apple Watch" sourceVersion="1" unit="count/min" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, `08:${minute}`)}" endDate="${appleDate(day, `08:${endMinute}`)}" value="${140 + index + (sample % 3)}"/>`;
      })
    ).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <ExportDate value="${appleDate(25, "12:00")}"/>
  <Me biologicalSex="HKBiologicalSexMale"/>${workouts}${heartRecords}
</HealthData>`;
    writeFileSync(xmlPath, xml, "utf8");

    const store = await RaiDatabase.open(join(root, "rai.sqlite"));
    try {
      await parseAppleHealthXml(xmlPath, store, { fileSize: Buffer.byteLength(xml) });
      canonicalizeRunningWorkouts(store.database);
      const service = new RaiApplicationService(store);
      const jobId = service.enqueueFullRecompute({
        evaluatedAt: "2026-01-25T04:00:00.000Z",
        timezoneIdentifier: "Asia/Shanghai"
      });
      assert.equal(service.runNextJob()?.id, jobId);

      const rows = store.database.prepare(`
        SELECT assessment_status AS status, updated_true_ability AS updated,
               explanation_json AS explanationJson
        FROM ability_assessments
        ORDER BY sequence_number
      `).all() as Array<{ status: string; updated: number; explanationJson: string }>;
      assert.equal(rows.length, 7);

      const explanations = rows.map((row) => {
        const parsed = JSON.parse(row.explanationJson) as Record<string, unknown>;
        // Calibration/excluded assessments never attempt an update, so they carry no
        // reason. Every row that *did* reach the learning gate must say what it decided.
        if ("confidenceV2" in parsed) {
          assert.ok("refusalReason" in parsed, "every update attempt must say why it was refused");
          const reason = parsed.refusalReason;
          if (reason !== null) {
            assert.ok(
              (REFUSAL_REASONS as readonly unknown[]).includes(reason),
              `unknown refusal reason persisted: ${String(reason)}`
            );
          }
        }
        return { status: row.status, updated: row.updated, reason: parsed.refusalReason ?? null, gated: "confidenceV2" in parsed };
      });

      // The statistics-only run must have been assessed and refused *with a reason*,
      // not merely marked as "not updated".
      const refused = explanations.filter((entry) => entry.reason !== null);
      assert.ok(refused.length > 0, "the fixture must exercise at least one refusal");
      assert.ok(
        refused.some((entry) => entry.reason === "not_eligible"),
        `expected a not_eligible refusal, got ${JSON.stringify(refused.map((entry) => entry.reason))}`
      );
      for (const entry of refused) {
        assert.equal(entry.updated, 0, "a refused update must not have applied");
      }
      // The persisted reason is the scoring layer's decision, never a re-derivation:
      // the same row that says "not updated" carries the gate that stopped it.
      const last = explanations.at(-1)!;
      assert.equal(last.reason, "not_eligible");
      assert.equal(last.status, "trial");
    } finally {
      store.database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
