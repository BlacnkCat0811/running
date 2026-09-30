import {createHash} from 'node:crypto';
import {canonicalSemanticJson,type PhysiologyPredictionScenario} from '@rai/contracts';
import {PHYSIOLOGY_MODEL_VERSION} from '@rai/physiology';
export const STANDARD_PREDICTION_SCENARIO:PhysiologyPredictionScenario={temperatureC:null,humidityPercent:null,elevationGainMeters:{five_k:null,ten_k:null,half_marathon:null}};
export function predictionPolicyKey(mode:string,method:string,artifactSha:string|null,scenario:PhysiologyPredictionScenario):string {
  return `${PHYSIOLOGY_MODEL_VERSION}:${mode}:${method}:${artifactSha??'none'}:${createHash('sha256').update(canonicalSemanticJson(scenario)).digest('hex')}`;
}
export function catBoostCalibrationKey(artifactSha:string):string {
  return predictionPolicyKey('current_prepared','catboost_residual_v6',artifactSha,STANDARD_PREDICTION_SCENARIO);
}
