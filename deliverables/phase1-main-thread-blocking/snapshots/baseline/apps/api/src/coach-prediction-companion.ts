import type { DatabaseSync } from "node:sqlite";
import type { CoachPredictionSummary } from "@rai/api-contracts";
import type { PhysiologyPredictionReport } from "@rai/contracts";
import { SqliteCoachFactsRepository } from "@rai/storage-sqlite";
import { digest } from "./plan-digest.js";
import type { CoachPredictionIdentity } from "./coach-goal-gap.js";

/** Identity reads are cheap relative to building the report and never mutate a
 * release bundle. Raw-fact/override/label/model changes invalidate the pointer. */
export function coachPredictionIdentity(db: DatabaseSync, scope: { athleteId: string; datasetEpoch: string }): CoachPredictionIdentity | null {
  const active = db.prepare(`SELECT b.model_run_id AS id,b.snapshot_hash AS hash
    FROM active_model_run a JOIN model_release_bundles b ON b.model_run_id=a.model_run_id
    WHERE a.singleton=1 AND b.status='passed'`).get() as { id: string; hash: string } | undefined;
  if (!active) return null;
  const facts = db.prepare("SELECT key,value FROM import_manifest ORDER BY key").all();
  const overrides = db.prepare("SELECT * FROM effective_workout_overrides ORDER BY training_session_id").all();
  const labels = db.prepare("SELECT * FROM performance_entries ORDER BY id").all();
  const prediction = db.prepare("SELECT * FROM active_prediction_model WHERE singleton=1").get();
  return { ...scope, bundleId: active.id, bundleHash: active.hash, factsHash: digest(facts),
    overrideHash: digest(overrides), labelCohortHash: digest(labels), activePredictionArtifactId: prediction ? digest(prediction) : null,
    predictionPolicyVersion: "rai-coach-current-prepared-companion-v1", scenario: "current_prepared" };
}

export function publishCoachPredictionCompanion(db: DatabaseSync, identity: CoachPredictionIdentity,
  report: PhysiologyPredictionReport, publishedAt: string): CoachPredictionSummary {
  if (report.predictionPolicy?.mode !== "current_prepared") throw new Error("Coach summary requires current_prepared");
  const cutoff = db.prepare(`SELECT MAX(anchor_end_at) AS at FROM training_sessions
    WHERE status='active' AND julianday(anchor_end_at)<=julianday(?)`).get(report.generatedAt) as { at: string | null };
  const summary: CoachPredictionSummary = {
    schemaVersion: 1, id: "", ...identity, asOf: report.generatedAt, publishedAt, availableAt: publishedAt,
    dataThroughAt: cutoff.at, entries: report.snapshot.races.map(entry => ({
      distance: entry.distance, status: entry.predictedSeconds == null ? "insufficient_data" : "available",
      referenceSeconds: entry.predictedSeconds, method: entry.method,
      // Do not turn the report's confidence or heuristic interval into an
      // empirically calibrated individual probability.
      calibrationStatus: "uncalibrated", range: null, evidenceRefs: [],
      limitationCodes: ["reference_not_probability", "interval_calibration_not_claimed"]
    }))
  };
  summary.id = digest(summary);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (digest(coachPredictionIdentity(db, identity)) !== digest(identity)) throw new Error("Coach prediction inputs changed during calculation");
    new SqliteCoachFactsRepository(db).publishSummary(JSON.stringify([identity.athleteId, identity.datasetEpoch]),
      summary.id, digest(identity), publishedAt, summary);
    db.exec("COMMIT");
    return summary;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
