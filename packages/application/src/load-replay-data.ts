import type { DatabaseSync } from "node:sqlite";
import { semanticHash } from "@rai/storage-sqlite";
import { loadDailyPhysEvidence, loadPersistedTrainingLoads } from "./training-load-data.js";
import { replayLoadRulings } from "./load-replay-v2.js";
import { localDateAt } from "./utils.js";

/**
 * Replay a published load snapshot, not an invented historical raw-fact replay.
 * Availability is conservatively the completed derived run, never workout time
 * or Apple creationDate. This includes upstream zone/override dependencies.
 */
export function replayPublishedLoadSnapshot(database:DatabaseSync,asOf:string,timezoneIdentifier:string) {
  if(!Number.isFinite(Date.parse(asOf)))throw new Error("Invalid replay cutoff");
  const run=database.prepare(`SELECT t.id,t.completed_at AS completedAt,t.evaluated_at AS evaluatedAt,
    t.algorithm_version AS version,t.timezone_identifier AS timezone
    FROM training_metric_runs t JOIN active_model_run a ON a.model_run_id=t.model_run_id
    WHERE t.status='succeeded' ORDER BY t.completed_at DESC,t.id DESC LIMIT 1`)
    .get() as {id:string;completedAt:string|null;evaluatedAt:string;version:string;timezone:string}|undefined;
  if(!run)throw new Error("No published load snapshot");
  if(run.timezone!==timezoneIdentifier)throw new Error("Replay timezone differs from the published load snapshot");
  const loads=loadPersistedTrainingLoads(database,run.id);
  const observed=new Map((database.prepare(`SELECT DISTINCT s.id,s.anchor_end_at AS endAt
    FROM training_sessions s JOIN workout_training_loads l ON l.training_session_id=s.id
    WHERE l.training_metric_run_id=?`).all(run.id) as Array<{id:string;endAt:string}>)
    .map(row=>[row.id,row.endAt]));
  const availableAt=run.completedAt!==null && Number.isFinite(Date.parse(run.completedAt)) &&
    Number.isFinite(Date.parse(run.evaluatedAt))
    ? new Date(Math.max(Date.parse(run.completedAt),Date.parse(run.evaluatedAt))).toISOString():null;
  const throughDate=localDateAt(asOf,timezoneIdentifier);
  const facts={
    localDate:throughDate,throughDate,
    facts:loads.map(load=>({load,observedAt:observed.get(load.trainingSessionId)!,availableAt})),
    physEvidence:loads.length?loadDailyPhysEvidence(database,loads[0]!.localDate,throughDate,timezoneIdentifier,asOf):[]
  };
  const result=replayLoadRulings({
    descriptor:{caseId:`published-load:${run.id}`,asOf,timezoneIdentifier,
      replayMode:"event_time_reconstruction",factsSnapshotHash:semanticHash(facts),
      overrideSnapshotHash:semanticHash({scope:"already_materialized_in_load_snapshot",runId:run.id}),
      availabilityUnknown:availableAt===null},
    facts
  });
  return {...result,source:{
    trainingMetricRunId:run.id,loadConfigVersion:run.version,availableAt,
    scope:"published_derived_snapshot_not_raw_as_known_then",
    recoveryPolicy:"same_as_of_production_readiness_for_both_branches"
  }};
}
