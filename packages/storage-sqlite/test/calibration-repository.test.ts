import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import test from "node:test";
import {fitEmpiricalIntervals,type EvaluationCase} from "@rai/model-eval";
import {RaiDatabase,SqliteCalibrationRepository} from "../src/index.js";
const rows=(prefix:string,month:string):EvaluationCase[]=>Array.from({length:24},(_,i)=>-0.1+i*0.2/23).map((r,i)=>({
 eventId:`${prefix}-${i}`,distance:'five_k',predictedAt:`2026-${month}-${String(i+1).padStart(2,'0')}T00:00:00Z`,
 outcomeAt:`2026-${month}-${String(i+1).padStart(2,'0')}T01:00:00Z`,availableAt:`2026-${month}-${String(i+1).padStart(2,'0')}T02:00:00Z`,
 actualSeconds:1000*Math.exp(r),predictedSeconds:1000
}));
test('calibration artifacts are immutable, temporal, cohort-verifiable and scoped to the final predictor',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rai-calibration-'));
 const store=await RaiDatabase.open(join(root,'db.sqlite'),{createMigrationBackup:false});
 try{
  const repository=new SqliteCalibrationRepository(store.database);
  const predictor='physiology:current_prepared:formula:scenariohash';
  const artifact=fitEmpiricalIntervals({predictorVersion:predictor,distance:'five_k',calibration:rows('cal','07'),asOf:'2026-09-01T00:00:00Z',policy:{minimumCalibrationSamples:24,minimumTestSamples:24,minimumCoverage:{p80:0.75,p90:0.85},maximumMeanRelativeWidth:0.5}})!;
  const tests=rows('test','08').map(r=>({...r,actualSeconds:1000}));
  const baseline='b'.repeat(64),at='2026-09-01T08:00:00+08:00';
  const id=repository.save(artifact,baseline,tests,at);
  assert.equal(repository.select(predictor,baseline,'five_k','2026-09-01T00:00:00Z',1000)?.artifactId,id);
  assert.equal(repository.select(predictor,baseline,'five_k','2026-08-31T00:00:00Z',1000),null);
  assert.equal(repository.select(predictor,'a'.repeat(64),'five_k',at,1000),null);
  assert.equal(repository.select(predictor+':new-scenario',baseline,'five_k',at,1000),null);
  assert.equal(repository.select(predictor,baseline,'ten_k',at,1000),null);
  assert.throws(()=>repository.save({...artifact,quantiles:{...artifact.quantiles,q95:1}},baseline,tests,at),/differs/);
  assert.throws(()=>repository.save(artifact,baseline,rows('cal','07'),at),/overlaps/);
  assert.throws(()=>store.database.prepare("UPDATE prediction_calibration_artifacts SET status='failed' WHERE id=?").run(id),/immutable/);
  assert.equal(repository.save(artifact,baseline,tests,at),id);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM prediction_calibration_artifacts').get()?.n,1);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
