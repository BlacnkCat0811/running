import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { RaiDatabase, SqliteCoachFactsRepository } from "@rai/storage-sqlite";
import type { SubjectiveFeedback } from "@rai/api-contracts";
import type { PhysiologyPredictionReport } from "@rai/contracts";
import { registerCoachLoopRoutes } from "../src/coach-loop-routes.js";
import { CoachLoopRuntime } from "../src/coach-loop-runtime.js";
import { MobileGoalsStore } from "../src/mobile-goals.js";
import { coachPredictionIdentity, publishCoachPredictionCompanion } from "../src/coach-prediction-companion.js";
import { coachGoalGap } from "../src/coach-goal-gap.js";
import { digest } from "../src/plan-digest.js";

const scope={serverId:"test",athleteId:"test-athlete",datasetEpoch:"test-epoch"};
test("O5 real feedback HTTP command is append-only, CAS/idempotent, reversible and independent of goals/Fitness",async()=>{
  const root=mkdtempSync(join(tmpdir(),"coach-feedback-")),path=join(root,"main.sqlite");
  (await RaiDatabase.open(path,{createMigrationBackup:false})).close();
  const control=new MobileGoalsStore(root,join(root,"control.sqlite")),app=Fastify({ajv:{customOptions:{removeAdditional:false}}});
  registerCoachLoopRoutes({app,runtime:new CoachLoopRuntime(control,()=>scope,()=>{throw new Error("Feedback save must not refresh plan");}),
    identity:()=>scope,openMainDatabase:()=>RaiDatabase.open(path,{migrationPolicy:"refuse"})});
  try{
    const request={operationId:randomUUID(),operationScope:scope,id:"feedback1",expectedRevision:0,action:"save",consent:true,
      fields:{phase:"pre_run",workoutId:null,fatigue:"usual",soreness:"none",discomfort:"none",requestedAction:"rest",
        interruptionReason:null,replacementReason:null,rpeOverrideRef:null,observedAt:new Date().toISOString()}};
    const first=await app.inject({method:"POST",url:"/v1/mobile/coach-feedback",payload:request});
    assert.equal(first.statusCode,200,first.body);
    const retry=await app.inject({method:"POST",url:"/v1/mobile/coach-feedback",payload:request});
    assert.deepEqual(retry.json(),first.json());
    assert.equal(control.read().revision,0);
    const revoked=await app.inject({method:"POST",url:"/v1/mobile/coach-feedback",payload:{
      operationId:randomUUID(),operationScope:scope,id:"feedback1",expectedRevision:1,action:"retract",consent:true}});
    assert.equal(revoked.statusCode,200,revoked.body);
    const db=RaiDatabase.openReadonly(path);
    try{
      const rows=new SqliteCoachFactsRepository(db).feedback<SubjectiveFeedback>(JSON.stringify([scope.athleteId,scope.datasetEpoch]),new Date().toISOString());
      assert.equal(rows.length,2);assert.equal(rows[0]!.retractedAt,null);assert.ok(rows[1]!.retractedAt);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM workout_overrides").get()?.n,0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_runs").get()?.n,0);
    }finally{db.close();}
    const invalid=await app.inject({method:"POST",url:"/v1/mobile/coach-feedback",payload:{...request,operationId:randomUUID(),
      id:"bad",fields:{...request.fields,rpe:10}}});
    assert.equal(invalid.statusCode,400);
  }finally{await app.close();control.close();rmSync(root,{recursive:true,force:true});}
});

test("O6 companion publication leaves sealed bundle untouched and invalidates on facts/model identity",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE active_model_run(singleton INTEGER,model_run_id TEXT);
    CREATE TABLE model_release_bundles(model_run_id TEXT,snapshot_hash TEXT,status TEXT);
    INSERT INTO active_model_run VALUES(1,'bundle');
    INSERT INTO model_release_bundles VALUES('bundle','sealed-hash','passed');
    CREATE TABLE import_manifest(key TEXT,value TEXT);
    INSERT INTO import_manifest VALUES('generation','1');
    CREATE TABLE effective_workout_overrides(training_session_id TEXT);
    CREATE TABLE performance_entries(id TEXT);
    CREATE TABLE active_prediction_model(singleton INTEGER,model_run_id TEXT);
    CREATE TABLE training_sessions(anchor_end_at TEXT,status TEXT);
    INSERT INTO training_sessions VALUES('2026-10-09T01:00:00Z','active');
    CREATE TABLE coach_prediction_summaries(scope TEXT,id TEXT,identity_hash TEXT,available_at TEXT,payload_json TEXT,PRIMARY KEY(scope,id));
  `);
  try{
    const identity=coachPredictionIdentity(db,scope)!;
    const before=db.prepare("SELECT * FROM model_release_bundles").all();
    const report={predictionPolicy:{mode:"current_prepared"},generatedAt:"2026-10-10T01:00:00Z",
      snapshot:{races:[{distance:"ten_k",predictedSeconds:3000,method:"formula"}]}} as unknown as PhysiologyPredictionReport;
    const published=publishCoachPredictionCompanion(db,identity,report,"2026-10-10T02:00:00Z");
    assert.deepEqual(db.prepare("SELECT * FROM model_release_bundles").all(),before);
    assert.equal(coachGoalGap({asOf:"2026-10-10T03:00:00Z",distance:"ten_k",targetSeconds:2700,
      summary:published,currentIdentity:identity}).gapSeconds,300);
    db.exec("UPDATE import_manifest SET value='2'");
    assert.throws(()=>publishCoachPredictionCompanion(db,identity,report,"2026-10-10T04:00:00Z"),/changed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM coach_prediction_summaries").get()?.n,1);
    const repository=new SqliteCoachFactsRepository(db);
    assert.equal(repository.summary(JSON.stringify([scope.athleteId,scope.datasetEpoch]),
      digest(coachPredictionIdentity(db,scope)),"2026-10-10T05:00:00Z"),null);
  }finally{db.close();}
});

test("O5 fact operation rolls back append on failure and rejects reuse for a different request",async()=>{
  const root=mkdtempSync(join(tmpdir(),"coach-fact-tx-")),path=join(root,"main.sqlite");
  const store=await RaiDatabase.open(path,{createMigrationBackup:false}),repo=new SqliteCoachFactsRepository(store.database);
  try{
    assert.throws(()=>repo.operation("scope","operation","request",()=>{
      repo.appendFeedback("scope","fact",0,"2026-10-10T00:00:00Z",{revision:1});
      throw new Error("fail after append");
    }),/fail after/);
    assert.equal(repo.feedback("scope","2026-10-11T00:00:00Z").length,0);
    repo.operation("scope","operation","request",()=>{repo.appendFeedback("scope","fact",0,"2026-10-10T00:00:00Z",{revision:1});return "saved";});
    assert.equal(repo.operation("scope","operation","request",()=>{throw new Error("must not run");}),"saved");
    assert.throws(()=>repo.operation("scope","operation","different",()=>null),/conflict/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
