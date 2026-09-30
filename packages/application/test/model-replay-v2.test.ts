import assert from "node:assert/strict";
import test from "node:test";
import {replayFitnessVersions,type ModelReplayInput} from "../src/model-replay-v2.js";
const source=(i:number):ModelReplayInput['sources'][number]=>{
 const at=new Date(Date.UTC(2026,0,1+i*3)).toISOString();
 return {availableAt:new Date(Date.parse(at)+3600000).toISOString(),source:{
  id:`w${i}`,trainingSessionId:`s${i}`,trainingSessionStatus:'active',workoutStartAt:at,workoutEndAt:new Date(Date.parse(at)+1800000).toISOString(),
  durationSeconds:1800,distanceKm:5,indoor:false,sourceCategory:'apple_watch',routePointCount:100,routeQuality:1,
  speed:{average:2.8+i*0.01,minimum:2.6,maximum:3,sampleCount:30,firstAt:null,lastAt:null,coefficientOfVariation:0.04},
  heartRate:{average:150,minimum:140,maximum:160,sampleCount:30,firstAt:null,lastAt:null,coefficientOfVariation:0.04,coveredDurationSeconds:1800},
  restingHeartRate:50,restingHeartRateReference:50,hrvSdnn:50,sleepDurationMinutes:430,recentLoadMinutes:100,observedMaximumHeartRate:190,override:null
 }};
};
test('frozen V1 and V2 consume identical facts deterministically and never claim external accuracy',()=>{
 const input:ModelReplayInput={descriptor:{caseId:'case',asOf:'2026-02-01T00:00:00Z',timezoneIdentifier:'Asia/Shanghai',replayMode:'event_time_reconstruction',factsSnapshotHash:'fixture',overrideSnapshotHash:'fixture',availabilityUnknown:true},sources:Array.from({length:9},(_,i)=>source(i))};
 const a=replayFitnessVersions(input),b=replayFitnessVersions(input);
 assert.deepEqual(a,b);assert.equal(a.base.version,'rai-v1.0.0-dev@62b4a97');
 assert.equal(a.candidate.version,'rai-v2.0.0');assert.equal(a.base.output.timeline.length,9);
 // The claim in the test name is "identical facts": assert BOTH sides consumed the same
 // as-of fact set. Checking only the base side let a truncated candidate stay green.
 assert.equal(a.candidate.output.timeline.length,9);
 const sessions=(t:typeof a.base.output.timeline)=>t.map((entry)=>entry.sessionId);
 assert.deepEqual(sessions(a.base.output.timeline),sessions(a.candidate.output.timeline));
 assert.equal(a.base.output.calibrationCount,a.candidate.output.calibrationCount);
 assert.deepEqual(sessions(a.base.output.timeline),input.sources.map((item)=>item.source.trainingSessionId));
 assert.equal(a.accuracyStatus,'not_evaluable');
 assert.throws(()=>replayFitnessVersions({...input,descriptor:{...input.descriptor,replayMode:'as_known_then'}}),/arrival/);
 // §15.3: even when the cohort is not flagged availabilityUnknown, a single fact with no
 // arrival timestamp must fail the strict as-known-then cohort rather than be assumed
 // available because its workout time is early enough.
 assert.throws(()=>replayFitnessVersions({...input,
   descriptor:{...input.descriptor,replayMode:'as_known_then',availabilityUnknown:false},
   sources:[input.sources[0]!,{...input.sources[1]!,availableAt:null},...input.sources.slice(2)]}),/arrival/);
 assert.throws(()=>replayFitnessVersions({...input,sources:[...input.sources,input.sources[0]!]}),/Duplicate/);
});
