import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { COACH_RUNTIME_POLICY_HASH, type CoachRuntimeReceipt } from "../src/coach-loop-runtime.js";
import { registerCoachLoopRoutes } from "../src/coach-loop-routes.js";
import { replayRun } from "../../../scripts/coach-replay-scenarios.mjs";
import { coachRuntimeFixture as fixture, runtimeReplaySettings as settings, runtimeReplayScope as scope } from "../../../scripts/coach-runtime-fixtures.mjs";

test("AC0-13 real control transaction publishes 20+5 extension, GET is readonly, retries do not add sessions",()=>{
  const f=fixture();
  try{
    assert.equal(f.runtime.read().settings,null);
    const request=f.command("enable",{settings,acceptedPolicyHash:COACH_RUNTIME_POLICY_HASH});
    const result=f.runtime.command(request);
    assert.equal(result.today.day.kind,"easy");
    assert.equal(result.today.executable,true);
    assert.ok(result.today.decisionRef);
    assert.equal(result.volumePolicy.suggestedWeeklyKm,20);
    assert.equal(result.volumePolicy.weeklyProtectionKm,26);
    assert.equal(result.volumePolicy.actualWeekKm,20);
    assert.deepEqual(f.runtime.command(request),result);
    const revision=f.store.read().revision;
    const receiptCount=f.store.coachLoopReceipts(JSON.stringify(scope)).length;
    for(let i=0;i<10;i++)assert.equal(f.runtime.read().today.executable,true);
    assert.equal(f.store.read().revision,revision);
    const refreshed=f.runtime.command(f.command("refresh"));
    assert.equal(refreshed.revision,revision);
    const saved=f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(scope))!;
    assert.equal(saved.reservations.filter(r=>r.allocation==="extension").length,1);
    assert.equal(f.store.coachLoopReceipts(JSON.stringify(scope)).length,receiptCount,"same evidence does not duplicate evaluation receipts");
  }finally{f.close();}
});

test("AC0-22 failed receipt rolls back goals, stale facts and scope are rejected",()=>{
  const f=fixture();
  try{
    const original=f.store.appendCoachLoopReceipt.bind(f.store);
    f.store.appendCoachLoopReceipt=()=>{throw new Error("injected receipt failure");};
    assert.throws(()=>f.runtime.command(f.command("enable",{settings,acceptedPolicyHash:COACH_RUNTIME_POLICY_HASH})),/injected/);
    assert.equal(f.store.read().revision,0);
    f.store.appendCoachLoopReceipt=original;
    assert.throws(()=>f.runtime.command(f.command("enable",{settings,acceptedPolicyHash:COACH_RUNTIME_POLICY_HASH,expectedFactsHash:"old"})),/事实/);
    assert.throws(()=>f.runtime.command(f.command("enable",{settings,acceptedPolicyHash:COACH_RUNTIME_POLICY_HASH,
      operationScope:{...scope,datasetEpoch:"other"}})),/数据集/);
  }finally{f.close();}
});

test("R20 high load, actual 22+5, completion and pause block unsafe extra training",()=>{
  for(const condition of ["high_load","no_headroom","completed","pause"]){
    const f=fixture();
    try{
      if(condition==="high_load")f.facts.inputs.today.injuryFlags=[{code:"load_ratio",title:"test",detail:"test"}];
      if(condition==="no_headroom")f.facts.facts[f.facts.facts.length-1]=replayRun("monday-22","2026-10-05",22);
      if(condition==="completed")f.facts.facts.push(replayRun("today","2026-10-08",5));
      let result=f.runtime.command(f.command("enable",{settings,acceptedPolicyHash:COACH_RUNTIME_POLICY_HASH}));
      if(condition==="pause")result=f.runtime.command(f.command("pause"));
      assert.equal(result.today.executable,false,condition);
    }finally{f.close();}
  }
});

test("new HTTP contract negotiates explicit policy and publishes actual extension",async()=>{
  const f=fixture(),app=Fastify();
  registerCoachLoopRoutes({app,runtime:f.runtime,identity:()=>scope,
    openMainDatabase:async()=>{throw new Error("GET must not open writer or build prediction");}});
  try{
    const initial=await app.inject({method:"GET",url:"/v1/mobile/coach-loop"});
    assert.equal(initial.statusCode,200);
    const response=await app.inject({method:"POST",url:"/v1/mobile/coach-loop",
      payload:f.command("enable",{settings,acceptedPolicyHash:initial.json().policyHash})});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().today.executable,true);
    const revision=f.store.read().revision;
    for(let i=0;i<100;i++)assert.equal((await app.inject({method:"GET",url:"/v1/mobile/coach-loop"})).statusCode,200);
    assert.equal(f.store.read().revision,revision);
  }finally{await app.close();f.close();}
});

test("O4 runtime can select a quality course in a complete supported week, not only offline templates",()=>{
  const f=fixture();
  try{
    f.facts.facts=f.facts.facts.filter(run=>run.id!=="monday-20").map(run=>({...run,distanceKm:run.distanceKm*2,durationSeconds:run.durationSeconds*2}));
    f.facts.inputs.weeklyVolumeBaselineKm=40;
    f.facts.inputs.recentWeeklyKm=40; f.facts.inputs.previousWeekDistanceKm=40;
    f.facts.inputs.today.week.durationSeconds=0; f.facts.inputs.today.week.distanceKm=0;
    const result=f.runtime.command(f.command("enable",{settings,acceptedPolicyHash:COACH_RUNTIME_POLICY_HASH}));
    assert.ok(result.days.some(row=>row.executable && ["tempo","interval"].includes(row.day.kind)),
      JSON.stringify(result.days.map(row=>[row.day.localDate,row.day.kind,row.executable])));
    assert.equal(result.volumePolicy.extension.status,"not_needed");
  }finally{f.close();}
});

test("completed extension keeps its rolling count and original stored prescription; expired intentions are not completed",()=>{
  const f=fixture();
  try{
    const enabled=f.runtime.command(f.command("enable",{settings,acceptedPolicyHash:COACH_RUNTIME_POLICY_HASH}));
    const original=enabled.goals.weekPlan.find(day=>day.localDate===f.facts.date)!;
    f.facts.facts.push(replayRun("actual-extra","2026-10-08",5));f.facts.factsHash="after-extension";
    const completed=f.runtime.command(f.command("refresh"));
    assert.equal(completed.today.executable,false);
    assert.deepEqual(completed.goals.weekPlan.find(day=>day.localDate===f.facts.date),original);
    const saved=f.store.coachLoopState<CoachRuntimeReceipt>(JSON.stringify(scope))!;
    assert.equal(saved.reservations[0]?.status,"completed");
    assert.deepEqual(saved.reservations[0]?.matchedWorkoutIds,["actual-extra"]);
  }finally{f.close();}
});

test("AC3-01/AC0-21: fractional real-world zones are canonical before authorization, so same-facts refresh never manufactures a revision", () => {
  for (const targetType of ["pace", "heart_rate"] as const) {
    const f = fixture();
    try {
      const zones = f.facts.inputs.prescription!;
      for (const key of Object.keys(zones) as Array<keyof typeof zones>) {
        if (typeof zones[key] === "number") zones[key] = zones[key]! + 0.37;
      }
      const published = f.runtime.command(f.command("enable", { settings: { ...settings, targetType },
        acceptedPolicyHash: COACH_RUNTIME_POLICY_HASH }));
      const refreshed = f.runtime.command(f.command("refresh"));
      assert.equal(refreshed.revision, published.revision, "AC3-01-fractional-zone-no-revision");
      assert.deepEqual(refreshed.today, published.today);
      assert.equal(refreshed.refreshRequired, false);
      assert.ok(refreshed.today.executable, "positive fractional-zone authorization cannot be passed by resting");
    } finally { f.close(); }
  }
});
