import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";import {join} from "node:path";import {tmpdir} from "node:os";import test from "node:test";
import {RaiDatabase,SqliteModelRunRepository,SqliteModelReleaseRepository,ModelRunActivationError,REQUIRED_MODEL_DOMAINS,semanticHash} from "../src/index.js";
import type {ModelLineageV2} from "@rai/contracts";
const at="2026-09-29T00:00:00Z";
test("S01: v23 releases atomically publish/rollback and reject failed, stale and changed snapshots",async()=>{
 const root=mkdtempSync(join(tmpdir(),"rai-v2-release-"));const store=await RaiDatabase.open(join(root,"db.sqlite"),{createMigrationBackup:false});
 try{
 const db=store.database;db.prepare("INSERT INTO import_manifest VALUES('dataset_version','dataset')").run();
 const releases=new SqliteModelReleaseRepository(db),models=new SqliteModelRunRepository(db);
 const seed=(id:string,base:string|null,status:"passed"|"failed"|"not_evaluable"="passed")=>{
 db.prepare(`INSERT INTO feature_runs(id,dataset_version,canonical_contract_version,feature_schema_version,feature_config_json,feature_config_hash,status) VALUES(?,'dataset','canonical-health-v2','workout-feature-v4','{}','hash','succeeded')`).run('f'+id);
 db.prepare(`INSERT INTO model_runs(id,feature_run_id,dataset_version,model_version,model_config_json,model_config_hash,evaluated_at,status) VALUES(?,?,'dataset','v2','{}','hash',?,'succeeded')`).run(id,'f'+id,at);
 db.prepare(`INSERT INTO training_metric_runs(id,model_run_id,algorithm_version,config_json,config_hash,timezone_identifier,evaluated_at,status) VALUES(?,?,'v5','{}','hash','Asia/Shanghai',?,'succeeded')`).run('t'+id,id,at);
 const lineage:ModelLineageV2={sourceRunId:id,datasetVersion:"dataset",factsSnapshotHash:semanticHash({}),overrideSnapshotHash:semanticHash([]),modelVersion:"rai-v2.0.0",featureSchemaVersion:"workout-feature-v4",configVersion:"v11",configHash:"hash",calibrationCohortHash:null,baselineEpochId:null,normalizationVersion:null,normalizationConfigHash:null,timezoneIdentifier:"Asia/Shanghai",asOf:at,dataThroughAt:null};
 releases.recordLineage(id,"rai-v2.0.0","v11",lineage);
 for(const domain of REQUIRED_MODEL_DOMAINS)releases.putSnapshot(id,domain,"summary",at,{status:"no_data",lineage});
 releases.recordEvaluation({runId:id,baseRunId:base,datasetVersion:"dataset",status,report:{status},createdAt:at});
 };
 seed('a',null);models.activateSucceeded('a',at);
 seed('b','a');db.exec("CREATE TRIGGER fail_pointer BEFORE UPDATE ON active_model_run BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
 assert.throws(()=>models.activateSucceeded('b',at),/fixture failure/);
 assert.equal(db.prepare("SELECT model_run_id AS id FROM active_model_release").get()?.id,'a');
 assert.equal(db.prepare("SELECT activated_at AS at FROM model_release_bundles WHERE model_run_id='b'").get()?.at,null);
 db.exec("DROP TRIGGER fail_pointer");models.activateSucceeded('b',at);releases.rollback('a','b',at);
 assert.equal(db.prepare("SELECT model_run_id AS id FROM active_model_run").get()?.id,'a');
 seed('bad','a','not_evaluable');assert.throws(()=>models.activateSucceeded('bad',at),/not passed/);
 assert.throws(()=>releases.putSnapshot('a','fitness','summary',at,{changed:true}),/immutable/);
 db.exec("UPDATE import_manifest SET value='new' WHERE key='dataset_version'");
 assert.throws(()=>releases.rollback('b','a',at),/Dataset changed/);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test("switching back to an already published release is a rollback; unsealed or failed candidates stay blocked",async()=>{
 const root=mkdtempSync(join(tmpdir(),"rai-v2-switchback-"));const store=await RaiDatabase.open(join(root,"db.sqlite"),{createMigrationBackup:false});
 try{
 const db=store.database;db.prepare("INSERT INTO import_manifest VALUES('dataset_version','dataset')").run();
 const releases=new SqliteModelReleaseRepository(db),models=new SqliteModelRunRepository(db);
 const seed=(id:string,base:string|null,status:"passed"|"failed"|"not_evaluable"="passed",seal=true)=>{
  db.prepare(`INSERT INTO feature_runs(id,dataset_version,canonical_contract_version,feature_schema_version,feature_config_json,feature_config_hash,status) VALUES(?,'dataset','canonical-health-v2','workout-feature-v4','{}',?,'succeeded')`).run('f'+id,'hash-'+id);
  db.prepare(`INSERT INTO model_runs(id,feature_run_id,dataset_version,model_version,model_config_json,model_config_hash,evaluated_at,status) VALUES(?,?,'dataset','v2','{}','hash',?,'succeeded')`).run(id,'f'+id,at);
  db.prepare(`INSERT INTO training_metric_runs(id,model_run_id,algorithm_version,config_json,config_hash,timezone_identifier,evaluated_at,status) VALUES(?,?,'v5','{}','hash','Asia/Shanghai',?,'succeeded')`).run('t'+id,id,at);
  if(!seal)return;
  const lineage:ModelLineageV2={sourceRunId:id,datasetVersion:"dataset",factsSnapshotHash:semanticHash({}),overrideSnapshotHash:semanticHash([]),modelVersion:"rai-v2.0.0",featureSchemaVersion:"workout-feature-v4",configVersion:"v11",configHash:"hash",calibrationCohortHash:null,baselineEpochId:null,normalizationVersion:null,normalizationConfigHash:null,timezoneIdentifier:"Asia/Shanghai",asOf:at,dataThroughAt:null};
  releases.recordLineage(id,"rai-v2.0.0","v11",lineage);
  for(const domain of REQUIRED_MODEL_DOMAINS)releases.putSnapshot(id,domain,"summary",at,{status:"no_data",lineage});
  releases.recordEvaluation({runId:id,baseRunId:base,datasetVersion:"dataset",status,report:{status},createdAt:at});
 };
 // A V4 run that was never sealed cannot be activated, however it reaches the API. The
 // refusal is a typed activation error so the HTTP layer can answer 409, not 500.
 seed('unsealed',null,"passed",false);
 assert.throws(()=>models.activateSucceeded('unsealed',at),
   (error:unknown)=>error instanceof ModelRunActivationError&&error.code==="release_gate"&&/absent or has not passed/.test(error.message));
 seed('a',null);models.activateSucceeded('a',at);
 seed('b','a');models.activateSucceeded('b',at);
 assert.equal(db.prepare("SELECT model_run_id AS id FROM active_model_run").get()?.id,'b');
 // The product's "switch model version" action goes back to an older release. That is a
 // rollback, not a forward publication, so the incumbent is expected to differ.
 assert.equal(releases.isPublished('a'),true);
 models.activateSucceeded('a',at);
 assert.equal(db.prepare("SELECT model_run_id AS id FROM active_model_run").get()?.id,'a');
 assert.equal(db.prepare("SELECT model_run_id AS id FROM active_model_release").get()?.id,'a');
 // A failed gate is still refused even though the release row exists.
 seed('bad','a',"not_evaluable");
 assert.throws(()=>models.activateSucceeded('bad',at),/absent or has not passed/);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
