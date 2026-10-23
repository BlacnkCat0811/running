import { PredictionModelService } from "./prediction-model-service.js";
import { catBoostCalibrationKey } from "./prediction-policy.js";
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {SqliteCalibrationRepository,RaiDatabase,SqliteModelReleaseRepository,acquireDatabasePublicationLock,resolveDatabasePathIdentity} from '@rai/storage-sqlite';
import {defaultRaiModelConfig} from '@rai/scoring';
import {RaiApplicationService} from './service.js';
import {prepareCalibration,compareStoredModelSnapshots,type CalibrationSubmission} from './model-v2-maintenance.js';
import {currentAbilityBaselineHash} from './prediction-ability-baseline.js';
import {buildBaselineRebaseReview,recordBaselineRebaseReview} from './baseline-rebase-review.js';

const args=process.argv.slice(2),options=new Map<string,string|true>();
const names=new Set(['--database','--action','--as-of','--reference-start','--input','--base-run','--run-id','--expected-active','--prediction-run-id','--apply']);
for(let i=0;i<args.length;i++){
  const key=args[i]!;
  if(!names.has(key)||options.has(key))throw new Error(`Unknown or duplicate option: ${key}`);
  if(key==='--apply'){options.set(key,true);continue;}
  const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`${key} requires a value`);
  options.set(key,value);
}
const value=(key:string)=>{const v=options.get(key);return typeof v==='string'?v:undefined;};
const databasePath=resolveDatabasePathIdentity(value('--database')??'var/rai.sqlite');
const action=value('--action')??'inspect';
const instant=value('--as-of')??new Date().toISOString();
if(!Number.isFinite(Date.parse(instant)))throw new Error('Invalid --as-of');
const at=new Date(instant).toISOString();
if(!existsSync(databasePath))throw new Error('Database not found');
if(!['inspect','rebase','review-baseline','rollback','calibrate','compare','activate-prediction'].includes(action))throw new Error('Unsupported --action');
const reference=value('--reference-start'),runId=value('--run-id'),expected=value('--expected-active');
const baseRunId=value('--base-run'),inputPath=value('--input'),predictionRunId=value('--prediction-run-id');
if(action==='activate-prediction'&&!predictionRunId)throw new Error('activate-prediction requires --prediction-run-id');
if(action==='rebase'&&(!reference||!Number.isFinite(Date.parse(reference))||Date.parse(reference)>=Date.parse(at)))throw new Error('rebase requires a prior --reference-start');
if(action==='rollback'&&(!runId||!expected))throw new Error('rollback requires --run-id and --expected-active');
if(action==='compare'&&!baseRunId)throw new Error('compare requires --base-run');
if(action==='calibrate'&&!inputPath)throw new Error('calibrate requires --input');
const calibrationInput=action==='calibrate'?JSON.parse(readFileSync(resolve(inputPath!),'utf8')) as CalibrationSubmission:null;
if(action==='compare'){
  const db=RaiDatabase.openReadonly(databasePath);
  try{const id=runId??String(db.prepare('SELECT model_run_id AS id FROM active_model_run').get()?.id??'');
    console.log(JSON.stringify(compareStoredModelSnapshots(db,baseRunId!,id),null,2));
  }finally{db.close();}
}else if(!options.has('--apply')||action==='inspect'){
  const db=RaiDatabase.openReadonly(databasePath);
  try{
    const preview=calibrationInput?prepareCalibration(db,calibrationInput,at):null;
    const prediction=predictionRunId?db.prepare(`SELECT id,status,model_version AS modelVersion,artifact_sha256 AS artifactSha,
      ability_baseline_hash AS baselineHash,training_data_through_at AS trainingDataThroughAt,artifact_path AS artifactPath
      FROM prediction_model_runs WHERE id=?`).get(predictionRunId):null;
    console.log(JSON.stringify({mode:'dry-run',action,databasePath,reference:reference??null,runId:runId??null,
      active:db.prepare('SELECT * FROM active_model_run').all(),baselineHash:currentAbilityBaselineHash(db),
      pendingMigrations:RaiDatabase.pendingMigrations(databasePath),
      baselineReview:action==='review-baseline'?buildBaselineRebaseReview(db,{asOf:at}):null,
      predictionCandidate:prediction?{...prediction,calibrationPredictorKey:typeof prediction.artifactSha==='string'?catBoostCalibrationKey(prediction.artifactSha):null}:null,
      calibration:preview?{status:preview.status,evaluation:preview.evaluation}:null},null,2));
  }finally{db.close();}
}else{
  const release=acquireDatabasePublicationLock(databasePath,'cli');
  try{
    const store=await RaiDatabase.open(databasePath,{migrationPolicy:'refuse'});
    try{
      if(action==='rollback')new SqliteModelReleaseRepository(store.database).rollback(runId!,expected!,at);
      else if(action==='review-baseline'){
        console.log(JSON.stringify({action,...recordBaselineRebaseReview(store.database,{asOf:at})},null,2));
      }
      else if(action==='activate-prediction')new PredictionModelService(store).activate(predictionRunId!);
      else if(calibrationInput){
        const staged=prepareCalibration(store.database,calibrationInput,at);
        if(!staged.artifact||staged.status!=='passed')throw new Error(`Calibration did not pass: ${staged.status}`);
        const id=new SqliteCalibrationRepository(store.database).save(staged.artifact,staged.baselineHash,calibrationInput.test,at);
        console.log(JSON.stringify({action,status:'succeeded',calibrationArtifactId:id}));
      }else{
        if(store.database.prepare("SELECT 1 FROM recompute_jobs WHERE status IN ('queued','running') LIMIT 1").get())throw new Error('Another recompute job is pending');
        const service=new RaiApplicationService(store);
        const jobId=service.enqueueFullRecompute({evaluatedAt:at,modelConfig:{...defaultRaiModelConfig,baselineReferenceStartAt:new Date(reference!).toISOString()}});
        const job=service.runNextJob();
        if(job?.id!==jobId||job.status!=='succeeded')throw new Error(`Rebase was not published: ${JSON.stringify(job)}`);
      }
      if(!calibrationInput&&action!=='review-baseline')console.log(JSON.stringify({action,status:'succeeded'}));
    }finally{store.close();}
  }finally{release();}
}
