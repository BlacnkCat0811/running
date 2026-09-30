import { semanticHash } from "@rai/storage-sqlite";
import type { DatabaseSync } from "node:sqlite";
import { READINESS_MODEL_VERSION, READINESS_RULE_SET_VERSION, healthTypes, type ModelLineageV2, type ReadinessSignalName } from "@rai/contracts";
import { READINESS_SLEEP_RATIO_THRESHOLD, READINESS_HRV_RATIO_THRESHOLD, READINESS_RHR_RATIO_THRESHOLD, READINESS_SLEEP_STREAK_THRESHOLD, assessDatedReadiness, withReadinessLineage, type DatedRecoverySignal } from "@rai/readiness";
import { localDateAt, localDateStartAt, addDays, median } from "./utils.js";

/**
 * 装配一天的全部恢复**事实**，不做任何判定。
 *
 * §4.1 的原则是"先解决证据接口，再增加公式"：判定只有 `assessDatedReadiness` 一处，
 * 而"事实从哪来、到达时间怎么算"只有这里一处。回放器需要的是**事实**而不是结论
 * （`replayReadinessRulings` 要拿同一批事实跑两支到达时间假设），所以必须把它单独暴露出来 ——
 * 否则回放器只能自己再写一遍这些 SQL，而那正是"两套恢复口径"的开端。
 *
 * `loadDatedReadiness` = `assessDatedReadiness(loadDatedRecoveryFacts(...))`，逐位等价。
 */
export interface DatedReadinessFacts {
  asOf: string;
  localDate: string;
  signals: Record<ReadinessSignalName, DatedRecoverySignal>;
  nights: DatedRecoverySignal[];
}

/** Canonical computed_at is known. Raw source-created time is never treated as ingestion time. */
export function loadDatedRecoveryFacts(database: DatabaseSync, asOf: string, timezone: string): DatedReadinessFacts {
  // A completed publication is a conservative upper bound, not a fabricated
  // record-level arrival time. It cannot make an older observed date "today".
  const publication = database.prepare("SELECT value FROM import_manifest WHERE key='import_completed_at'").get()?.value;
  const publicationAt = typeof publication === "string" && Number.isFinite(Date.parse(publication))
    && Date.parse(publication) <= Date.parse(asOf) ? new Date(publication).toISOString() : null;
  const date = localDateAt(asOf, timezone);
  const fromDate = addDays(date, -28);
  const fromAt = localDateStartAt(fromDate, timezone), todayAt = localDateStartAt(date, timezone);
  const center = (rows: Array<{value: number | null}>) => {
    const xs = rows.flatMap((r) => r.value !== null && Number.isFinite(r.value) && r.value > 0 ? [r.value] : []);
    return xs.length >= 7 ? median(xs) : null;
  };
  const sleepBase = center(database.prepare(`SELECT asleep_union_minutes AS value FROM canonical_nights
    WHERE kind='main' AND timezone_identifier=? AND wake_date>=? AND wake_date<? AND julianday(wake_at)<julianday(?) AND julianday(computed_at)<=julianday(?)`)
    .all(timezone,fromDate,date,todayAt,asOf) as Array<{value:number|null}>);
  const hrvBase = center(database.prepare(`SELECT hrv_sdnn_ms AS value FROM canonical_hrv_days
    WHERE timezone_identifier=? AND local_date>=? AND local_date<? AND julianday(window_end_at)<julianday(?) AND julianday(computed_at)<=julianday(?)`)
    .all(timezone,fromDate,date,todayAt,asOf) as Array<{value:number|null}>);
  const rhrRows = database.prepare(`SELECT value_numeric AS value,start_at AS at FROM health_records
    WHERE type=? AND julianday(start_at)>=julianday(?) AND julianday(end_at)<julianday(?) AND value_numeric>0 ORDER BY start_at`)
    .all(healthTypes.restingHeartRate,fromAt,todayAt) as Array<{value:number;at:string}>;
  const byDate = new Map<string, number[]>();
  for (const row of rhrRows) { const d=localDateAt(row.at,timezone); byDate.set(d,[...(byDate.get(d)??[]),row.value]); }
  const rhrBase = publicationAt === null ? null : center([...byDate.values()].map((xs)=>({value:median(xs)})));
  const nightRows = database.prepare(`SELECT wake_date AS date,wake_at AS observedAt,computed_at AS availableAt,
    asleep_union_minutes AS value FROM canonical_nights WHERE kind='main' AND timezone_identifier=?
    AND wake_date>=? AND wake_date<=? AND julianday(wake_at)<=julianday(?) ORDER BY wake_date`)
    .all(timezone,addDays(date,-2),date,asOf) as Array<{date:string;observedAt:string;availableAt:string;value:number|null}>;
  const hrv = database.prepare(`SELECT local_date AS date,window_end_at AS observedAt,computed_at AS availableAt,
    hrv_sdnn_ms AS value FROM canonical_hrv_days WHERE timezone_identifier=? AND local_date=?
    AND julianday(window_end_at)<=julianday(?) ORDER BY computed_at DESC LIMIT 1`).get(timezone,date,asOf) as
    {date:string;observedAt:string;availableAt:string;value:number|null}|undefined;
  const rhr = database.prepare(`SELECT start_at AS observedAt,value_numeric AS value FROM health_records
    WHERE type=? AND julianday(start_at)>=julianday(?) AND julianday(end_at)<=julianday(?) ORDER BY start_at DESC LIMIT 1`)
    .get(healthTypes.restingHeartRate,todayAt,asOf) as {observedAt:string;value:number|null}|undefined;
  const signal = (row: {date:string;observedAt:string;availableAt:string|null;value:number|null}|undefined, baseline:number|null): DatedRecoverySignal => ({
    value:row?.value??null, baseline, observedAt:row?.observedAt??null, availableAt:row?.availableAt??null, localDate:row?.date??null,
    availabilitySource: row?.availableAt ? "canonical_computation" : "unknown"
  });
  return {asOf, localDate: date, signals:{
    sleep:signal(nightRows.find((n)=>n.date===date),sleepBase), hrv:signal(hrv,hrvBase),
    rhr:{...signal(rhr?{...rhr,date,availableAt:publicationAt}:undefined,rhrBase),
      availabilitySource:publicationAt ? "dataset_publication_upper_bound" : "unknown"}
  },nights:nightRows.map((row)=>signal(row,sleepBase))};
}

export function loadDatedReadiness(database: DatabaseSync, asOf: string, timezone: string) {
  return assessDatedReadiness(loadDatedRecoveryFacts(database, asOf, timezone));
}

export function readinessForRun(db: DatabaseSync, lineage: ModelLineageV2) {
  return withReadinessLineage(loadDatedReadiness(db,lineage.asOf,lineage.timezoneIdentifier),{
    ...lineage,modelVersion:READINESS_MODEL_VERSION,configVersion:READINESS_RULE_SET_VERSION,
    configHash:semanticHash({sleep:READINESS_SLEEP_RATIO_THRESHOLD,hrv:READINESS_HRV_RATIO_THRESHOLD,
      rhr:READINESS_RHR_RATIO_THRESHOLD,streak:READINESS_SLEEP_STREAK_THRESHOLD,baselineDays:28,minimumBaselineDays:7,
      availability:"canonical_computation_or_publication_upper_bound"}),
    baselineEpochId:null,calibrationCohortHash:null
  });
}
