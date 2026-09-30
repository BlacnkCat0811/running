import { canonicalSemanticJson, type ReplayDescriptorV2, type WorkoutFeatureVector } from "@rai/contracts";
import { extractLegacyWorkoutFeatureVectorV3, legacyFeatureConfigV3, extractWorkoutFeatureVectorV4,
  projectFeatureV4,defaultFeatureConfig,type WorkoutFeatureSource } from "@rai/features";
import { legacyV1, createPersonalBaseline, hasCompletedCalibration, scoreFeature, defaultRaiModelConfig,
  updateTrueAbilityFromFeatureScore, trueAbilityAfterInactivity, buildAdaptiveBaselineTimeline, buildLegacyStratumHistory,
  type RaiModelConfig, SCORING_MODEL_VERSION } from "@rai/scoring";
import { replayModelPair } from "@rai/model-eval";
import { localDateAt } from "./utils.js";

export interface ModelReplayInput {
  descriptor:ReplayDescriptorV2;
  sources:Array<{source:WorkoutFeatureSource; availableAt:string|null}>;
  candidateConfig?:RaiModelConfig;
}

/** Frozen V1 and current V2 consume the identical as-of source facts, never each other's derived scores. */
export function replayFitnessVersions(input:ModelReplayInput) {
  const cutoff=Date.parse(input.descriptor.asOf);
  if(!Number.isFinite(cutoff))throw new Error("Invalid replay cutoff");
  const unique=new Set<string>();
  const sources=input.sources.filter(({source,availableAt})=>{
    if(!Number.isFinite(Date.parse(source.workoutEndAt)))throw new Error("Invalid workout completion");
    if(Date.parse(source.workoutEndAt)>cutoff)return false;
    if(input.descriptor.replayMode==="as_known_then"){
      if(availableAt===null||!Number.isFinite(Date.parse(availableAt)))throw new Error("Unknown fact arrival time");
      if(Date.parse(availableAt)>cutoff)return false;
    }
    if(unique.has(source.trainingSessionId))throw new Error("Duplicate replay session");
    unique.add(source.trainingSessionId);return true;
  }).sort((a,b)=>Date.parse(a.source.workoutStartAt)-Date.parse(b.source.workoutStartAt)||a.source.trainingSessionId.localeCompare(b.source.trainingSessionId));
  const config=input.candidateConfig??defaultRaiModelConfig;
  const run=(legacy:boolean,replaySources:typeof sources)=>{
    const features=replaySources.map(({source},index)=>legacy
      ? extractLegacyWorkoutFeatureVectorV3(`feature-${index}`,"replay",source,legacyFeatureConfigV3,input.descriptor.asOf)
      : projectFeatureV4(extractWorkoutFeatureVectorV4(`feature-${index}`,"replay",source,defaultFeatureConfig,input.descriptor.asOf)));
    const calibration:WorkoutFeatureVector[]=[];
    for(const f of features){if(f.eligibilityStatus!=="eligible")continue;
      if(!legacy&&config.baselineReferenceStartAt&&Date.parse(f.workoutStartAt)<Date.parse(config.baselineReferenceStartAt))continue;
      calibration.push(f);if(legacy?legacyV1.hasCompletedCalibration(calibration):hasCompletedCalibration(calibration,config))break;}
    const mature=legacy?legacyV1.hasCompletedCalibration(calibration):hasCompletedCalibration(calibration,config);
    const baseline=mature?(legacy?legacyV1.createPersonalBaseline(calibration):createPersonalBaseline(calibration)):null;
    const complete=baseline?Math.max(...features.map((f,i)=>baseline.calibrationFeatureIds.includes(f.id)?i:-1)):Infinity;
    const histories=config.comparabilityHistoryMode==="bounded"?buildAdaptiveBaselineTimeline(features).map((x)=>x.history):buildLegacyStratumHistory(features);
    let ta=50,n=0,pending=0,lastDate:string|null=null,lastTa=50;
    const timeline=features.map((f,i)=>{
      if(f.eligibilityStatus==="excluded"||i<=complete||!baseline)return {sessionId:f.trainingSessionId,status:f.eligibilityStatus==="excluded"?"excluded":"calibrating",ca:null,ta:null,updated:false};
      const date=localDateAt(f.workoutStartAt,input.descriptor.timezoneIdentifier);
      if(lastDate!==null)ta=(legacy?legacyV1.trueAbilityAfterInactivity:trueAbilityAfterInactivity)(lastTa,(Date.parse(date)-Date.parse(lastDate))/86400000);
      const maturity=Math.max(0.25,Math.min(1,(n+1)/12));
      if(legacy){
        const score=legacyV1.scoreFeature(f,baseline,maturity);
        const update=legacyV1.updateTrueAbilityFromFeatureScore(ta,n,score);
        ta=update.nextTrueAbility;if(score.status==="eligible"){n++;lastDate=date;lastTa=ta;}
        return {sessionId:f.trainingSessionId,status:score.status,ca:score.currentAbility,ta,updated:update.updated};
      }
      const score=scoreFeature(f,baseline,maturity,histories[i]??null,config);
      const update=updateTrueAbilityFromFeatureScore(ta,n,score,config,pending);
      pending=update.pendingNegativeConfirmations;ta=update.nextTrueAbility;
      if(score.status==="eligible"){n++;lastDate=date;lastTa=ta;}
      return {sessionId:f.trainingSessionId,status:score.status,ca:score.currentAbility,ta,updated:update.updated};
    });
    return {timeline,calibrationCount:calibration.length,finalAbility:baseline?ta:null};
  };
  const pair=replayModelPair({sources},input.descriptor,
    {version:"rai-v1.0.0-dev@62b4a97",run:(facts)=>run(true,facts.sources)},
    {version:SCORING_MODEL_VERSION,run:(facts)=>run(false,facts.sources)});
  return {version:"rai-version-replay-v1",...pair,accuracyStatus:"not_evaluable" as const,
    note:"Deterministic same-source model comparison, not external-label accuracy certification."};
}
