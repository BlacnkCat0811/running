#!/usr/bin/env node
// Offline release rehearsal. The source is read-only; every write targets a
// disposable SQLite backup. No source migration, pointer change or ML activation.
import { parseArgs } from "node:util";
import { backup, DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { RaiApplicationService, buildPredictionReport, buildPredictionReportAsync } from "@rai/application";
import { RaiDatabase, SqliteModelReleaseRepository, semanticHash } from "@rai/storage-sqlite";
import { assertPerformanceComparisonIsComparable, type PerformanceComparison } from "@rai/model-eval";

const {values}=parseArgs({options:{
  database:{type:"string"},out:{type:"string"},"as-of":{type:"string"},timezone:{type:"string",default:"Asia/Shanghai"}
}});
if(!values.database||!values.out||!values["as-of"]) throw new Error("--database, --out and --as-of are required");
const sourcePath=resolve(values.database),out=resolve(values.out),asOf=new Date(values["as-of"]).toISOString();
const sha=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const originalHash=sha(sourcePath),root=mkdtempSync(join(tmpdir(),"rai-release-rehearsal-")),path=join(root,"copy.sqlite");
let store:RaiDatabase|undefined;
try {
  const source=new DatabaseSync(sourcePath,{readOnly:true});
  try {await backup(source,path);} finally {source.close();}
  store=await RaiDatabase.open(path,{createMigrationBackup:false});
  const db=store.database,service=new RaiApplicationService(store);
  if(db.prepare("SELECT 1 FROM recompute_jobs WHERE status IN ('queued','running')").get()) {
    throw new Error("Snapshot contains pending jobs; refuse to alter their state");
  }
  const options={evaluatedAt:asOf,timezoneIdentifier:values.timezone!};
  const active=()=>String(db.prepare("SELECT model_run_id AS id FROM active_model_run").get()?.id);
  const scoreHash=()=>semanticHash(db.prepare(`SELECT training_session_id,assessment_status,
    current_ability,true_ability_after FROM active_ability_assessments ORDER BY sequence_number`).all());
  const run=(mode:"full"|"incremental")=>{
    const start=performance.now();
    const id=mode==="full"?service.enqueueFullRecompute(options):service.enqueueIncrementalRecompute({
      mode:"partial",dirtySessionIds:[],dirtyFromAt:asOf,reasons:["import_dataset_diff"]
    },options);
    const job=service.runNextJob();
    assert.equal(job?.id,id);
    assert.equal(job?.status,"succeeded",JSON.stringify(db.prepare("SELECT error_json FROM recompute_jobs WHERE id=?").get(id!)));
    return {elapsedMs:performance.now()-start,scoreHash:scoreHash(),runId:active()};
  };
  const warmup=run("full"),baseline=[],candidate=[];
  // Alternate modes to avoid comparing a cold run against a warmed run.
  for(let i=0;i<2;i++){
    baseline.push(run("full"));
    candidate.push(run("incremental"));
  }
  for(const sample of [...baseline,...candidate])assert.equal(sample.scoreHash,warmup.scoreHash);
  const environment=`${platform()}/${arch()}; Node ${process.version}; source sha256 ${originalHash}`;
  const comparison:PerformanceComparison={
    baseline:{subject:"V2 full recompute",cacheState:"warm",rounds:2,environment},
    candidate:{subject:"V2 unchanged-facts incremental recompute",cacheState:"warm",rounds:2,environment},
    isolatedVariable:"full versus incremental recompute, identical facts/as-of/config",
    claim:"measured_under_stated_conditions"
  };
  assertPerformanceComparisonIsComparable(comparison);
  const predictionOptions={asOf,timezoneIdentifier:values.timezone!,mode:"current_prepared" as const};
  const sync=buildPredictionReport(db,predictionOptions);
  const asyncReport=await buildPredictionReportAsync(db,predictionOptions);
  for(const report of [sync,asyncReport])for(const race of report.snapshot.races) {
    assert.equal(race.heuristicRange?.kind,"heuristic_not_calibrated");
    assert.equal(race.intervalEvidence?.status,"insufficient_calibration");
  }
  const beforeRollback=active();
  // The production retention window keeps two prior releases, not all rounds.
  const rollbackTarget=baseline.at(-1)!.runId;
  new SqliteModelReleaseRepository(db).rollback(rollbackTarget,beforeRollback,asOf);
  assert.equal(active(),rollbackTarget);
  assert.equal(scoreHash(),warmup.scoreHash);
  const aggregates={
    schemaVersion:db.prepare("SELECT MAX(version) AS n FROM schema_migrations").get()?.n,
    activeFeatureSchema:db.prepare(`SELECT f.feature_schema_version AS v FROM active_model_run a
      JOIN model_runs m ON m.id=a.model_run_id JOIN feature_runs f ON f.id=m.feature_run_id`).get()?.v,
    publishedSnapshots:db.prepare("SELECT COUNT(*) AS n FROM model_domain_snapshots WHERE model_run_id=?").get(rollbackTarget)?.n,
    copyBytes:statSync(path).size,peakRssKb:process.resourceUsage().maxRSS
  };
  store.close();store=undefined;
  // Reopen to prove pointers and bundle selection are not only in-memory.
  const reopened=RaiDatabase.openReadonly(path);
  try {assert.equal(reopened.prepare("SELECT model_run_id AS id FROM active_model_run").get()?.id,rollbackTarget);}
  finally {reopened.close();}
  assert.equal(sha(sourcePath),originalHash);
  const report={
    version:"rai-v2-release-rehearsal-v1",asOf,sourceHash:originalHash,sourceUnchanged:true,
    writes:"disposable_backup_only",aggregates,comparison,warmup,baseline,candidate,
    rollback:{status:"passed",from:beforeRollback,to:rollbackTarget,reopenVerified:true},
    predictionContracts:"sync_and_async_heuristic_fallback_verified",
    accuracyStatus:"not_evaluable",note:"No V1/V2 speedup or prediction accuracy claim; two warm rounds per recompute mode."
  };
  mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
} finally {
  store?.close();
  rmSync(root,{recursive:true,force:true});
}
