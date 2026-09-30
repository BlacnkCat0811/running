import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type {DatabaseSync} from 'node:sqlite';
import {canonicalSemanticJson,type RaceDistance} from '@rai/contracts';
import {assertIndependentTemporalPartitions,fitEmpiricalIntervals,evaluateIntervalArtifact,assertIntervalPublicationPolicy,
  type EvaluationCase,type IntervalPolicy} from '@rai/model-eval';
import {SqliteModelReleaseRepository,semanticHash} from '@rai/storage-sqlite';
import {PHYSIOLOGY_MODEL_VERSION} from '@rai/physiology';
import {currentAbilityBaselineHash} from './prediction-ability-baseline.js';

export interface CalibrationSubmission {
  predictorVersion:string;
  baselineHash:string;
  distance:RaceDistance;
  policy:IntervalPolicy;
  trainingEventIds:string[];
  trainingLabelsAvailableThrough:string;
  calibration:EvaluationCase[];
  test:EvaluationCase[];
}

/** Shared by dry-run and apply, so a preview cannot silently use weaker rules. */
export function prepareCalibration(db:DatabaseSync,input:CalibrationSubmission,asOf:string) {
  if(!input||typeof input.predictorVersion!=='string'||!input.predictorVersion.startsWith(PHYSIOLOGY_MODEL_VERSION+':'))throw new Error('Calibration predictor version mismatch');
  const baseline=currentAbilityBaselineHash(db);
  if(!baseline||input.baselineHash!==baseline)throw new Error('Calibration input baseline differs from the active baseline');
  assertIntervalPublicationPolicy(input.policy);
  if(input.predictorVersion.includes(':catboost_residual_v6:')){
    const parts=input.predictorVersion.split(':');
    const model=db.prepare(`SELECT training_data_through_at AS through,artifact_path AS path FROM prediction_model_runs
      WHERE artifact_sha256=? AND ability_baseline_hash=? AND status='succeeded' ORDER BY completed_at DESC LIMIT 1`)
      .get(parts[3]??'',baseline);
    if(!model||typeof model.path!=='string')throw new Error('Calibrate a point-validated candidate before activating it');
    if(Date.parse(input.trainingLabelsAvailableThrough)<Date.parse(String(model.through)))throw new Error('Calibration training boundary predates the model training cutoff');
    const manifest=JSON.parse(readFileSync(resolve(model.path,'manifest.json'),'utf8')) as {modelSha256:string;artifactFiles:Record<string,string>};
    const bytes=readFileSync(resolve(model.path,'evaluation.json'));
    if(manifest.modelSha256!==parts[3]||createHash('sha256').update(bytes).digest('hex')!==manifest.artifactFiles['evaluation.json'])throw new Error('Calibration artifact evaluation hash mismatch');
    const evaluation=JSON.parse(bytes.toString('utf8')) as {releaseSplit:{trainingSampleIds:string[];holdoutSampleIds:string[]}};
    const used=[...evaluation.releaseSplit.trainingSampleIds,...evaluation.releaseSplit.holdoutSampleIds];
    const declared=new Set(input.trainingEventIds);
    if(used.some(id=>!declared.has(id)))throw new Error('Calibration must exclude all model-fit and model-selection events');
  }

  assertIndependentTemporalPartitions({...input,asOf,embargoHours:24});
  const artifact=fitEmpiricalIntervals({...input,asOf});
  const evaluation=artifact?evaluateIntervalArtifact(artifact,input.test,asOf):null;
  return {artifact,evaluation,baselineHash:baseline,status:evaluation?.status??'not_evaluable' as const};
}

const operationFields=['id','model_run_id','modelRunId','sourceRunId','feature_id','featureRunId',
  'training_metric_run_id','zone_profile_id','last_assessment_id','created_at','computed_at','createdAt','computedAt','assessed_at'];

/** Compare immutable outputs; this does not pretend to rerun a historical engine. */
export function compareStoredModelSnapshots(db:DatabaseSync,baseId:string,candidateId:string) {
  const repository=new SqliteModelReleaseRepository(db);
  const rows=[baseId,candidateId].map(id=>db.prepare(`SELECT m.dataset_version AS dataset,m.evaluated_at AS at,
    m.status,m.feature_run_id AS featureRunId,f.feature_schema_version AS schema
    FROM model_runs m JOIN feature_runs f ON f.id=m.feature_run_id WHERE m.id=?`).get(id));
  if(!rows[0]||!rows[1]||rows.some(r=>r?.status!=='succeeded')||rows[0].dataset!==rows[1].dataset||rows[0].at!==rows[1].at)throw new Error('Comparison requires succeeded runs over the same dataset and as-of');
  const lineages=[baseId,candidateId].map(id=>{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='model_v2_runs'").get())return null;
    const row=db.prepare('SELECT lineage_json AS json FROM model_v2_runs WHERE model_run_id=?').get(id);
    return typeof row?.json==='string'?JSON.parse(row.json) as {factsSnapshotHash:string;overrideSnapshotHash:string}:null;
  });
  if(lineages[0]&&lineages[1]&&(lineages[0].factsSnapshotHash!==lineages[1].factsSnapshotHash||lineages[0].overrideSnapshotHash!==lineages[1].overrideSnapshotHash))throw new Error('Comparison source facts or overrides differ');
  const read=(id:string,index:number)=>{
    const hasV2=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='model_domain_snapshots'").get());
    const snapshots=hasV2?repository.snapshots(id):[];
    if(snapshots.length)return snapshots;
    if(rows[index]?.schema==='workout-feature-v4')throw new Error('V4 snapshot bundle is incomplete');
    const metric=db.prepare('SELECT id FROM training_metric_runs WHERE model_run_id=? AND status=\'succeeded\'').get(id)?.id;
    return [
      {domain:'fitness',key:'summary',asOf:String(rows[index]!.at),payload:{assessments:db.prepare('SELECT * FROM ability_assessments WHERE model_run_id=? ORDER BY sequence_number').all(id)}},
      {domain:'load',key:'summary',asOf:String(rows[index]!.at),payload:{days:metric?db.prepare('SELECT * FROM daily_training_metrics WHERE training_metric_run_id=? ORDER BY local_date').all(metric):[]}},
      {domain:'zones',key:'summary',asOf:String(rows[index]!.at),payload:{profiles:metric?db.prepare('SELECT * FROM daily_zone_profiles WHERE training_metric_run_id=? ORDER BY local_date').all(metric):[]}},
      ...['readiness','durability'].map(domain=>({domain,key:'summary',asOf:String(rows[index]!.at),payload:{status:'not_available_in_legacy_run'}}))
    ];
  };
  const before=read(baseId,0),after=read(candidateId,1);
  const summary=(items:typeof before)=>Object.fromEntries(items.map(row=>[`${row.domain}:${row.key}`,
    JSON.parse(canonicalSemanticJson(row.payload,{ignoreKeys:operationFields})) as unknown]));
  const base=summary(before),candidate=summary(after);
  const keys=[...new Set([...Object.keys(base),...Object.keys(candidate)])].sort();
  return {version:'rai-stored-domain-comparison-v1',scope:'stored_snapshots_not_fresh_replay',
    datasetVersion:String(rows[0].dataset),asOf:String(rows[0].at),baseRunId:baseId,candidateRunId:candidateId,
    sourceLineageKnown:lineages.every(Boolean),accuracyStatus:'not_evaluable',
    domains:keys.map(key=>({key,basePresent:key in base,candidatePresent:key in candidate,
      equal:key in base&&key in candidate&&semanticHash(base[key])===semanticHash(candidate[key])})),base,candidate};
}
