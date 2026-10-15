import assert from "node:assert/strict";
import test from "node:test";
import { extractWorkoutFeatureVectorV4, encodeFeaturePayloadV4, decodeStoredFeature, projectFeatureV4, storedFeatureSchema, defaultFeatureConfig, type WorkoutFeatureSource } from "../src/index.js";
const source:WorkoutFeatureSource={id:"w",trainingSessionId:"s",trainingSessionStatus:"active",workoutStartAt:"2026-01-01T00:00:00Z",workoutEndAt:"2026-01-01T01:00:00Z",durationSeconds:3600,distanceKm:10,indoor:false,sourceCategory:"apple_watch",routePointCount:10,routeQuality:1,
  speed:{average:3,minimum:3,maximum:3,sampleCount:60,firstAt:null,lastAt:null,coefficientOfVariation:0},
  heartRate:{average:150,minimum:150,maximum:150,sampleCount:60,firstAt:null,lastAt:null,coefficientOfVariation:0,coveredDurationSeconds:3600},
  speedSamples:[{value:3,startOffsetSeconds:0,durationSeconds:3600}],heartRateSamples:[{value:150,startOffsetSeconds:0,durationSeconds:3600}],
  restingHeartRate:50,restingHeartRateReference:50,hrvSdnn:50,sleepDurationMinutes:420,recentLoadMinutes:100,observedMaximumHeartRate:190,override:null};
const extract=(s=source)=>extractWorkoutFeatureVectorV4("f","run",s,defaultFeatureConfig,"2026-01-02T00:00:00Z");
test("identity normalization preserves measured speed even when distance/time differs",()=>{
 const value=extract({...source,environment:{temperatureC:15,humidityPercent:50,elevationGainMeters:0}});
 assert.equal(value.payload.normalization.status,"not_needed");
 assert.equal(value.payload.raw.paceRawMetersPerSecond,3);
 assert.equal(value.payload.normalized.speedMetersPerSecond,3);
 assert.equal(value.payload.normalized.efficiencySpeedPerBpm,value.payload.raw.efficiencyRaw);
});
test("V4 roundtrip never includes recovery/cardio; changing recovery cannot change the payload",()=>{
 const a=extract(),b=extract({...source,restingHeartRate:90,hrvSdnn:1,sleepDurationMinutes:1});
 assert.deepEqual(a,b);assert.equal("recoveryRaw" in a.payload.raw,false);
 const projected=projectFeatureV4(a);assert.equal(projected.signals.recoveryRaw,null);
 assert.deepEqual(decodeStoredFeature(encodeFeaturePayloadV4(a.payload),projected),projected);
 assert.equal(a.payload.normalization.status,"unavailable");assert.equal(a.payload.normalized.speedMetersPerSecond,null);
});
test("P2-6: recovery inputs are structurally inert — every field, every extreme, byte-identical output",()=>{
 // P2-6（2026-10-15）：恢复隔离的**数据证据**在测试层。recompute-pipeline 的运行期反事实
 // 在 V4 强制 null（`v4.ts:19-21`）下恒真，只是"防未来回归"的哨兵（见其注释）；这里把
 // 隔离断言参数化：**任意**恢复字段取任意极值/形态，V4 输出必须逐位相同。
 // （上一条用例只覆盖三个数值字段；本条补全 recentLoadMinutes 与两个对象字段。）
 const baseline=extract();
 const variants:WorkoutFeatureSource[]=[
  // 数值字段：边界与极端值。
  {...source,restingHeartRate:0},{...source,restingHeartRate:99},{...source,restingHeartRate:999},
  {...source,hrvSdnn:0},{...source,hrvSdnn:1},{...source,hrvSdnn:999},
  {...source,sleepDurationMinutes:0},{...source,sleepDurationMinutes:1},{...source,sleepDurationMinutes:1440},
  {...source,recentLoadMinutes:0},{...source,recentLoadMinutes:9999},
  // 对象字段：真实形态（与 features.test.ts 的 RecoveryBaseline/RecoveryContext 同构）+ null。
  {...source,recoveryBaseline:{sleepMinutes:0,restingHeartRateBpm:0,hrvSdnnMs:0,loadMinutes:0,lookbackDays:0,
    validDays:{sleep:0,rhr:0,hrv:0,load:0}},recoveryContext:{nightId:"night-x",hrvConfidence:"confident"}},
  {...source,recoveryBaseline:null,recoveryContext:null}
 ];
 for(const [index,variant] of variants.entries()){
  assert.deepEqual(extract(variant),baseline,`恢复输入变体 #${index} 不得改变 V4 输出（恢复事实结构上不进特征）`);
 }
 // 产物里不得出现任何恢复痕迹（V4 的结构性承诺，不只靠字段覆盖）。
 const encoded=JSON.stringify(encodeFeaturePayloadV4(baseline.payload));
 assert.equal(encoded.includes("recoveryBaseline"),false);
 assert.equal(encoded.includes("recoveryContext"),false);
});
test("paired steady windows measure raw decoupling; missing/interval data stays unknown",()=>{
 assert.equal(extract().payload.execution.aerobicDecouplingPct,0);
 const drift=extract({...source,heartRateSamples:[{value:150,startOffsetSeconds:0,durationSeconds:1800},{value:165,startOffsetSeconds:1800,durationSeconds:1800}]});
 assert.ok(drift.payload.execution.aerobicDecouplingPct!>0);
 assert.equal(extract({...source,heartRateSamples:[]}).payload.execution.aerobicDecouplingPct,null);
 assert.throws(()=>decodeStoredFeature('{"schemaVersion":"workout-feature-v99"}',projectFeatureV4(extract())),/Unsupported/);
});
test("legacy V3 read is marked, keeps legacy fields, and never fabricates V4 evidence",()=>{
 const v4=extract(),projected=projectFeatureV4(v4);
 // A real V3 row stores only the signals object in features_json; every other field is a column.
 const legacyRead=decodeStoredFeature(JSON.stringify(projected.signals),{...projected,provenance:{},missingReasons:[]});
 assert.equal(storedFeatureSchema(legacyRead),"workout-feature-v3-legacy");
 assert.equal(storedFeatureSchema(projected),"workout-feature-v4");
 assert.deepEqual(legacyRead.signals,projected.signals);
 assert.ok(legacyRead.missingReasons.includes("unavailable_in_legacy_feature"));
 assert.equal("featurePayloadV4" in legacyRead.provenance,false);
 // Reading an already-marked record must not accumulate the marker.
 assert.deepEqual(decodeStoredFeature(JSON.stringify(projected.signals),legacyRead).missingReasons,legacyRead.missingReasons);
 // Absence of the V4 stamp is classified legacy, never promoted to V4 on trust.
 assert.equal(storedFeatureSchema({...projected,provenance:{}}),"workout-feature-v3-legacy");
});
