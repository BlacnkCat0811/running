import type { FastifyInstance } from "fastify";
import type { CoachLoopCommand, CoachLoopDeviceReceipt, MobilePlanOperationScope, SubjectiveFeedback } from "@rai/api-contracts";
import { SqliteCoachFactsRepository, type RaiDatabase } from "@rai/storage-sqlite";
import { buildPredictionReportAsync } from "@rai/application";
import type { CoachLoopRuntime } from "./coach-loop-runtime.js";
import { buildSubjectiveFeedback, retractSubjectiveFeedback } from "./coach-subjective-feedback.js";
import { coachPredictionIdentity, publishCoachPredictionCompanion } from "./coach-prediction-companion.js";
import { PlanOperationError } from "./plan-publication.js";
import { digest } from "./plan-digest.js";
import { planOperationScopeSchema, coachLoopCommandSchema, coachLoopSyncedBodySchema, coachFeedbackFieldsSchema } from "./schemas.js";

const id = { type: "string", minLength: 1, maxLength: 200 } as const;
const operation = { operationId: { type: "string", format: "uuid" }, operationScope: planOperationScopeSchema };
type FeedbackFields = Parameters<typeof buildSubjectiveFeedback>[0]["fields"];
interface FeedbackCommand {
  operationId:string; operationScope:MobilePlanOperationScope; id:string; expectedRevision:number;
  action:"save"|"retract"; consent:boolean; fields?:FeedbackFields;
}

export function registerCoachLoopRoutes(args: {
  app: FastifyInstance; runtime: CoachLoopRuntime; identity: () => MobilePlanOperationScope;
  openMainDatabase: () => Promise<RaiDatabase>;
}) {
  args.app.get("/v1/mobile/coach-loop", async (_request,reply) => {
    reply.header("Cache-Control","no-store"); return args.runtime.read();
  });
  args.app.post<{Body:CoachLoopCommand}>("/v1/mobile/coach-loop", {schema:{body:coachLoopCommandSchema}},
    async request=>args.runtime.command(request.body));
  args.app.post<{ Body: CoachLoopDeviceReceipt }>("/v1/mobile/coach-loop/synced", { schema: { body: coachLoopSyncedBodySchema } },
    async request => args.runtime.recordDeviceReceipt(request.body));
  args.app.get("/v1/mobile/coach-execution",async (_request,reply)=>{
    reply.header("Cache-Control","no-store");
    const state=args.runtime.read();
    return {asOf:state.asOf,factsHash:state.factsHash,assessments:state.execution};
  });
  args.app.post<{Body:FeedbackCommand}>("/v1/mobile/coach-feedback",{schema:{body:{
    type:"object",additionalProperties:false,required:["operationId","operationScope","id","expectedRevision","action","consent"],
    properties:{...operation,id,expectedRevision:{type:"integer",minimum:0},action:{enum:["save","retract"]},
      consent:{const:true},fields:coachFeedbackFieldsSchema}
  }}},async(request)=>{
    if(digest(request.body.operationScope)!==digest(args.identity()))throw new PlanOperationError("coach_scope_mismatch","反馈属于其他数据集。");
    const store=await args.openMainDatabase();
    try{
      const repo=new SqliteCoachFactsRepository(store.database), scope=JSON.stringify([args.identity().athleteId,args.identity().datasetEpoch]);
      return repo.operation(scope,request.body.operationId,digest(request.body),()=>{
        const at=new Date().toISOString(), previous=repo.feedback<SubjectiveFeedback>(scope,at)
          .filter(row=>row.id===request.body.id).at(-1);
        if((previous?.revision??0)!==request.body.expectedRevision)throw new PlanOperationError("coach_feedback_revision_conflict","反馈已改变。");
        let feedback:SubjectiveFeedback|null;
        if(request.body.action==="retract"){
          if(!previous)throw new PlanOperationError("coach_feedback_not_found","反馈不存在。",404);
          feedback=retractSubjectiveFeedback(previous,{revision:previous.revision+1,recordedAt:at,availableAt:at});
        }else{
          if(!request.body.fields)throw new PlanOperationError("coach_feedback_invalid","缺少反馈字段。",422);
          const fields=request.body.fields;
          const workout=fields.workoutId?store.database.prepare("SELECT id FROM training_sessions WHERE id=? AND status='active'").get(fields.workoutId):null;
          const rpe=fields.rpeOverrideRef?store.database.prepare(`SELECT revision FROM workout_overrides
            WHERE training_session_id=? AND revision=? AND rpe IS NOT NULL`).get(fields.rpeOverrideRef.workoutId,fields.rpeOverrideRef.revision):null;
          try { feedback=buildSubjectiveFeedback({fields,id:request.body.id,revision:request.body.expectedRevision+1,
            scope:args.identity(),recordedAt:at,availableAt:at,knownWorkoutIds:workout&&fields.workoutId?[fields.workoutId]:[],
            knownRpeOverrides:rpe&&fields.rpeOverrideRef?[fields.rpeOverrideRef]:[]}); }
          catch(error){throw new PlanOperationError("coach_feedback_invalid",error instanceof Error?error.message:"反馈无效",422);}
        }
        if(feedback)repo.appendFeedback(scope,request.body.id,request.body.expectedRevision,at,feedback);
        return {feedback,saved:feedback!==null,refreshRequired:feedback!==null};
      });
    }finally{store.close();}
  });
  // Explicit async command, never queued or built by GET. Uses the existing
  // report builder once, then extracts a companion without altering its bundle.
  args.app.post<{Body:{operationScope:MobilePlanOperationScope}}>("/v1/mobile/coach-prediction-refresh",{schema:{body:{
    type:"object",additionalProperties:false,required:["operationScope"],properties:{operationScope:planOperationScopeSchema}
  }}},async(request)=>{
    if(digest(request.body.operationScope)!==digest(args.identity()))throw new PlanOperationError("coach_scope_mismatch","预测请求属于其他数据集。");
    const store=await args.openMainDatabase();
    try{
      const identity=coachPredictionIdentity(store.database,args.identity());
      if(!identity)return {status:"summary_unavailable",reason:"compatible_published_bundle_required"};
      const report=await buildPredictionReportAsync(store.database,{mode:"current_prepared",asOf:new Date().toISOString()});
      const summary=publishCoachPredictionCompanion(store.database,identity,report,new Date().toISOString());
      return {status:"published",summaryId:summary.id};
    }finally{store.close();}
  });
}
