import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  TrainingPlanClosedLoopCommandResponse, TrainingPlanScope, TrainingPlanSession,
  TrainingPlanSessionCommandRequest, TrainingPlanSessionDraft, TrainingPlanSessionImpact,
  TrainingPlanSessionPreviewRequest, TrainingPlanSessionPreviewResponse
} from "@rai/api-contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { MobileGoalsStore } from "./mobile-goals.js";
import { digest } from "./plan-digest.js";
import { PlanOperationError, PlanPublicationService } from "./plan-publication.js";
import { parseSessionPrescription, sessionRecord, sessionKeys, sessionId, sessionRevision,
  TrainingPlanSessionStateError } from "./training-plan-session-state.js";
import { parseTrainingPlanState, type TrainingPlanSessionState } from "./training-plan-store.js";
import { isValidLocalDate } from "./local-date.js";
import { internalErrorLogDetail } from "./training-plan-commands.js";
import { MAX_PLANNED_DISTANCE_KM } from "./session-structure.js";
import { measureStructure, pacesFromZones, roundKm, type CoachZonePrescription } from "./mobile-coach.js";

const route = "training-plan-session-command";
const invalid = (message: string): never => { throw new PlanOperationError("training_session_command_invalid", message, 422); };
const conflict = (code: string, message: string): never => { throw new PlanOperationError(code, message, 409); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strict wire parsing: no normalization or unknown-field erasure at this boundary. */
export function parseTrainingSessionRequest(body: unknown, submit: boolean): TrainingPlanSessionPreviewRequest | TrainingPlanSessionCommandRequest {
  try {
    if (!sessionRecord(body)) return invalid("课程命令必须是 JSON 对象。");
    sessionKeys(body, ["contractVersion", "operationScope", "expectedStateRevision", "planInstanceId", "draft",
      ...(submit ? ["operationId", "candidateId"] : [])], "command");
    if (body.contractVersion !== 1) throw new PlanOperationError("training_session_contract_required", "课程命令只接受合同 1。", 422);
    sessionRevision(body.expectedStateRevision, "expectedStateRevision");
    sessionId(body.planInstanceId, "planInstanceId");
    if (!sessionRecord(body.operationScope)) return invalid("缺少 operationScope。");
    sessionKeys(body.operationScope, ["serverId", "athleteId", "datasetEpoch"], "operationScope");
    for (const key of ["serverId", "athleteId", "datasetEpoch"]) sessionId(body.operationScope[key], key);
    if (submit) {
      if (typeof body.operationId !== "string" || !uuid.test(body.operationId)) return invalid("operationId 必须是持久 UUID。");
      if (typeof body.candidateId !== "string" || !body.candidateId || body.candidateId.length > 4096) return invalid("缺少有效 candidateId。");
    }
    const draft = body.draft;
    if (!sessionRecord(draft)) return invalid("缺少 draft。");
    const fields: Record<string, string[]> = {
      move: ["sessionId", "sessionRevision", "localDate"], edit: ["sessionId", "sessionRevision", "patch"],
      add: ["prescription"], cancel: ["sessionId", "sessionRevision"], set_rest: ["localDate"], unlock: ["sessionId", "sessionRevision"]
    };
    if (typeof draft.action !== "string" || !Object.hasOwn(fields, draft.action)) return invalid("未知课程动作。");
    sessionKeys(draft, ["action", ...fields[draft.action]!], "draft");
    for (const field of fields[draft.action]!) if (!Object.hasOwn(draft, field)) return invalid(`缺少 ${field}。`);
    if (["move", "edit", "cancel", "unlock"].includes(draft.action)) {
      sessionId(draft.sessionId, "sessionId"); sessionRevision(draft.sessionRevision, "sessionRevision");
    }
    if (["move", "set_rest"].includes(draft.action) && (typeof draft.localDate !== "string" || !isValidLocalDate(draft.localDate))) return invalid("日期非法。");
    if (draft.action === "add") {
      const day = parseSessionPrescription(draft.prescription);
      if (day.kind === "rest" || !day.structure) return invalid("新增跑课需要完整训练结构。");
    }
    if (draft.action === "edit") {
      if (!sessionRecord(draft.patch) || Object.keys(draft.patch).length === 0) return invalid("patch 不能为空。");
      sessionKeys(draft.patch, ["kind", "distanceKm", "structure", "reason"], "patch");
      // Validate omission/null distinctly by applying the patch to a valid skeleton.
      const day = parseSessionPrescription({ localDate: "2000-01-01", kind: "easy", distanceKm: null, structure: null, ...draft.patch });
      if (day.kind === "rest" || Object.hasOwn(draft.patch, "structure") && draft.patch.structure === null) return invalid("edit 不接受休息或清空结构。");
    }
    const reason = draft.action === "edit" ? (draft.patch as Record<string, unknown>).reason
      : draft.action === "add" ? (draft.prescription as Record<string, unknown>).reason : undefined;
    if (typeof reason === "string" && reason.length > 400) return invalid("课程说明不能超过400字。");
    return structuredClone(body) as unknown as TrainingPlanSessionPreviewRequest | TrainingPlanSessionCommandRequest;
  } catch (error) {
    if (error instanceof TrainingPlanSessionStateError) return invalid(error.message);
    throw error;
  }
}

export const trainingSessionMetadataOnly = (draft: TrainingPlanSessionDraft): boolean =>
  draft.action === "cancel" || draft.action === "set_rest";

export interface TrainingSessionFacts {
  fingerprint: string;
  prescription: CoachZonePrescription | null;
  /** Must reject an unsafe candidate, never silently resize a user prescription. */
  validate: (after: TrainingPlanSessionState, impact: TrainingPlanSessionImpact) => void;
}

type Candidate = { availableAt: string; expiresAt: string; newSessionId: string; inputKey: string };

/** Existing publication/CAS primitives own every business write. Preview writes nothing. */
export class TrainingPlanSessionCommandService {
  // Restart invalidates uncommitted previews. Committed operation replay precedes
  // candidate verification and survives restart, expiry and disabled capability.
  private readonly candidateKey = randomBytes(32);
  constructor(private readonly store: MobileGoalsStore, private readonly identity: () => TrainingPlanScope,
    private readonly businessDate: () => string, private readonly facts: () => TrainingSessionFacts,
    private readonly now: () => number = Date.now) {}

  private scope(): string { const id = this.identity(); return JSON.stringify([id.serverId, id.athleteId, id.datasetEpoch]); }
  private assertScope(request: TrainingPlanSessionPreviewRequest): void {
    if (digest(request.operationScope) !== digest(this.identity())) conflict("training_scope_mismatch", "命令属于其他服务或数据集。");
  }
  private current(request: TrainingPlanSessionPreviewRequest) {
    this.assertScope(request);
    const row = this.store.trainingPlanStateRow(this.scope());
    if (row?.state.schemaVersion !== 2) return conflict("training_session_contract_unsupported", "当前数据域尚未完成课程身份迁移。");
    if (row.state.planInstanceId !== request.planInstanceId) conflict("training_plan_instance_mismatch", "计划实例已变化，请重读。");
    if (row.revision !== request.expectedStateRevision) conflict("training_state_revision_conflict", "训练计划已变化，请保留草稿并重新预览。");
    return { ...row, state: row.state as TrainingPlanSessionState };
  }
  replay(request: TrainingPlanSessionCommandRequest): TrainingPlanClosedLoopCommandResponse | null {
    this.assertScope(request);
    return this.store.replayOperation(this.scope(), request.operationId, route, request);
  }
  private devicePushes() {
    return this.store.activePlanPushes().filter(push => push.scope == null || digest(push.scope) === digest(this.identity()));
  }
  private inputKey(request: TrainingPlanSessionPreviewRequest, state: TrainingPlanSessionState, fingerprint: string): string {
    return digest({ scope: request.operationScope, revision: request.expectedStateRevision, state,
      businessDate: this.businessDate(), fingerprint, deviceSchedules: this.devicePushes(), policy: "session-commands-1" });
  }
  private signature(request: TrainingPlanSessionPreviewRequest, candidate: Candidate): string {
    return createHmac("sha256", this.candidateKey).update(digest({ contractVersion: request.contractVersion,
      operationScope: request.operationScope, expectedStateRevision: request.expectedStateRevision,
      planInstanceId: request.planInstanceId, draft: request.draft, candidate })).digest("hex");
  }
  private encode(request: TrainingPlanSessionPreviewRequest, candidate: Candidate): string {
    return `${Buffer.from(JSON.stringify(candidate)).toString("base64url")}.${this.signature(request, candidate)}`;
  }
  private decode(request: TrainingPlanSessionCommandRequest): Candidate {
    let candidate: Candidate;
    const [encoded, signature, extra] = request.candidateId.split(".");
    try {
      candidate = JSON.parse(Buffer.from(encoded!, "base64url").toString()) as Candidate;
      if (!candidate || typeof candidate.availableAt !== "string" || typeof candidate.expiresAt !== "string" ||
        typeof candidate.newSessionId !== "string" || typeof candidate.inputKey !== "string" || extra !== undefined ||
        typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(this.signature(request, candidate)))) throw new Error("signature");
    } catch { return conflict("training_session_candidate_mismatch", "候选不属于该预览或服务已重启，请重新预览。"); }
    if (!Number.isFinite(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= this.now()) {
      conflict("training_session_candidate_expired", "预览已过期，请重新预览。");
    }
    return candidate;
  }

  private apply(request: TrainingPlanSessionPreviewRequest, state: TrainingPlanSessionState, c: Candidate,
    facts: TrainingSessionFacts | null): { state: TrainingPlanSessionState; impact: TrainingPlanSessionImpact; changed: boolean } {
    const after = structuredClone(state);
    const draft = request.draft;
    const existing = "sessionId" in draft ? after.sessions.find(s => s.sessionId === draft.sessionId) : null;
    if ("sessionId" in draft && !existing) throw new PlanOperationError("training_session_not_found", "当前实例中找不到该课程。", 404);
    if (existing) {
      if (existing.sessionRevision !== (draft as { sessionRevision: number }).sessionRevision) conflict("training_session_revision_conflict", "课程已变化，请重新预览。");
      if (existing.lifecycle !== "pending" || existing.supersededBySessionId !== null || existing.prescription.localDate < this.businessDate()) {
        conflict("training_session_not_editable", "已执行、结束、替换或过去的课程不能编辑。");
      }
    }
    const before = existing ? structuredClone(existing) : null;
    const targetDate = draft.action === "move" || draft.action === "set_rest" ? draft.localDate
      : draft.action === "add" ? draft.prescription.localDate : existing!.prescription.localDate;
    if (targetDate < this.businessDate()) invalid("不能向过去日期排课或改写休息。");
    if (draft.action === "add" || draft.action === "move" && targetDate !== existing!.prescription.localDate || draft.action === "set_rest") {
      if (after.sessions.some(s => s.lifecycle !== "cancelled" && s.supersededBySessionId === null && s.prescription.localDate === targetDate) ||
        after.suppressions.some(s => s.localDate === targetDate && s.reason === "explicit_rest" && draft.action !== "set_rest") ||
        after.lockedSession?.localDate === targetDate) conflict("training_session_date_occupied", "目标日期已有课程、锁课或明确休息，请先处理占位。");
    }
    let session: TrainingPlanSession | null = existing ?? null;
    const suppress = (localDate: string, reason: "moved" | "cancelled" | "explicit_rest", id: string | null) => {
      after.suppressions = after.suppressions.filter(s => s.localDate !== localDate);
      after.suppressions.push({ localDate, reason, sessionId: id, availableAt: c.availableAt });
    };
    if (draft.action === "add") {
      after.suppressions = after.suppressions.filter(s => s.localDate !== targetDate);
      session = { planInstanceId: state.planInstanceId, sessionId: c.newSessionId, sessionRevision: 1,
        prescription: structuredClone(draft.prescription), recommendation: null,
        userOverride: null, protection: "user_protected", lifecycle: "pending", availableAt: c.availableAt, supersededBySessionId: null };
      after.sessions.push(session);
    } else if (draft.action === "move") {
      if (targetDate !== session!.prescription.localDate) suppress(session!.prescription.localDate, "moved", session!.sessionId);
      session!.prescription.localDate = targetDate;
    } else if (draft.action === "edit") {
      session!.prescription = { ...session!.prescription, ...structuredClone(draft.patch) };
    } else if (draft.action === "cancel") {
      session!.lifecycle = "cancelled";
      suppress(targetDate, "cancelled", session!.sessionId);
    } else if (draft.action === "set_rest") {
      const current = after.suppressions.find(s => s.localDate === targetDate && s.reason === "explicit_rest");
      if (!current) suppress(targetDate, "explicit_rest", null);
    } else if (draft.action === "unlock") {
      session!.protection = "automatic";
      session!.userOverride = null;
      after.suppressions = after.suppressions.filter(s => s.sessionId !== session!.sessionId);
    }
    if (session) {
      if (draft.action !== "unlock") {
        session.protection = "user_protected";
        session.userOverride = { action: draft.action, prescription: structuredClone(session.prescription), availableAt: c.availableAt };
      }
      // Pure no-op edit/move/unlock preserves the existing version and history.
      const semantic = (s: TrainingPlanSession) => ({ prescription: s.prescription, protection: s.protection,
        lifecycle: s.lifecycle, supersededBySessionId: s.supersededBySessionId });
      if (before && digest(semantic(before)) === digest(semantic(session))) {
        Object.assign(session, before);
      } else if (before) { session.sessionRevision++; session.availableAt = c.availableAt; }
    }
    const releasedDates = draft.action === "add" || draft.action === "unlock"
      ? state.suppressions.filter(s => !after.suppressions.some(next =>
        next.localDate === s.localDate && next.reason === s.reason && next.sessionId === s.sessionId)).map(s => s.localDate) : [];
    const affectedDates = [...new Set([...(before ? [before.prescription.localDate] : []), targetDate, ...releasedDates])].sort();
    if (after.lockedSession && affectedDates.includes(after.lockedSession.localDate)) after.lockedSession = null;
    // Materialize only from entities + existing rest decisions, never edit weekPlan independently.
    const days = new Map(state.weekPlan.filter(d => d.kind === "rest").map(d => [d.localDate, structuredClone(d)]));
    for (const date of affectedDates) days.delete(date);
    for (const s of after.suppressions) days.set(s.localDate, { localDate: s.localDate, kind: "rest", distanceKm: null,
      structure: null, reason: s.reason === "explicit_rest" ? "用户指定休息。" : "课程已改期或取消；不自动补课。" });
    for (const s of after.sessions) if (s.lifecycle !== "cancelled" && s.supersededBySessionId === null) days.set(s.prescription.localDate, s.prescription);
    after.weekPlan = [...days.values()].sort((a, b) => a.localDate.localeCompare(b.localDate));
    const impact: TrainingPlanSessionImpact = { before, after: session ? structuredClone(session) : null,
      affectedDates, suppressions: after.suppressions.filter(s => affectedDates.includes(s.localDate)),
      deviceWithdrawalRequired: this.devicePushes().some(push => affectedDates.includes(push.localDate)),
      warnings: ["保存课程不会自动更新设备排期；如有已排期内容，需先撤回再重新下发。",
        ...(releasedDates.length ? [`${draft.action === "add" ? "新增课程" : "解除保护"}将释放以下日期的旧抑制：${releasedDates.join("、")}。`] : [])] };
    if (!trainingSessionMetadataOnly(draft) && session) {
      const p = session.prescription;
      // Legacy nullable structures survive moves/unlock. New content must be fully sized.
      const contentChanged = draft.action === "add" || draft.action === "edit" &&
        ["kind", "distanceKm", "structure"].some(key => Object.hasOwn(draft.patch, key));
      if (contentChanged) {
        if (!p.structure) return invalid("修改训练内容需要明确结构，不能只改显示距离。");
        const steps = [...(p.structure.warmup ? [p.structure.warmup] : []), ...p.structure.blocks.flatMap(b => b.steps),
          ...(p.structure.cooldown ? [p.structure.cooldown] : [])];
        if (steps.some(step => step.goal.type === "open")) invalid("人工课程需要整米或整秒剂量。");
        const measured = measureStructure(p.structure, p.kind, pacesFromZones(facts!.prescription));
        if (measured.distanceKm <= 0 || measured.distanceKm > MAX_PLANNED_DISTANCE_KM || measured.durationSeconds > 4 * 3600) invalid("训练剂量超出合法范围。");
        if (p.distanceKm !== null && Math.abs(p.distanceKm - roundKm(measured.distanceKm)) > 1e-8) invalid("距离与训练结构不一致，请同时调整结构。");
      }
      facts!.validate(after, impact);
    }
    parseTrainingPlanState(after);
    return { state: after, impact, changed: digest(after) !== digest(state) };
  }

  preview(raw: TrainingPlanSessionPreviewRequest): TrainingPlanSessionPreviewResponse {
    const request = parseTrainingSessionRequest(raw, false) as TrainingPlanSessionPreviewRequest;
    const row = this.current(request);
    const facts = trainingSessionMetadataOnly(request.draft) ? null : this.facts();
    const c: Candidate = { availableAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 120_000).toISOString(),
      newSessionId: `session-${randomUUID()}`, inputKey: this.inputKey(request, row.state, facts?.fingerprint ?? "metadata-only") };
    const result = this.apply(request, row.state, c, facts);
    return { ...request, candidateId: this.encode(request, c), expiresAt: c.expiresAt, inputKey: c.inputKey, impact: result.impact };
  }

  submit(raw: TrainingPlanSessionCommandRequest): TrainingPlanClosedLoopCommandResponse {
    const request = parseTrainingSessionRequest(raw, true) as TrainingPlanSessionCommandRequest;
    const replay = this.replay(request);
    if (replay !== null) return replay;
    const c = this.decode(request);
    const row = this.current(request);
    const facts = trainingSessionMetadataOnly(request.draft) ? null : this.facts();
    if (this.inputKey(request, row.state, facts?.fingerprint ?? "metadata-only") !== c.inputKey) conflict("training_session_candidate_mismatch", "事实或政策已变化，请重新预览。");
    const prepared = this.apply(request, row.state, c, facts);
    return new PlanPublicationService(this.store, () => this.scope(), this.identity).publish(route, request, () => {
      const current = this.current(request);
      const liveFacts = trainingSessionMetadataOnly(request.draft) ? null : this.facts();
      if (this.inputKey(request, current.state, liveFacts?.fingerprint ?? "metadata-only") !== c.inputKey) conflict("training_session_candidate_mismatch", "提交前输入已变化，请重新预览。");
      if (!prepared.changed) return { contractVersion: 1, operationId: request.operationId, stateRevision: current.revision,
        goalsRevision: current.state.goalsRevision, planInstanceId: current.state.planInstanceId, outcome: "no_change",
        session: prepared.impact.after, execution: null, planUpdate: "pending", warnings: prepared.impact.warnings };
      const goals = this.store.write({ expectedRevision: this.store.read().revision, weekPlan: prepared.state.weekPlan,
        lockedSession: prepared.state.lockedSession, weekPlanReplanRequired: true },
        { preserveWeekPlan: true, sessionCommand: true, runCoach: null });
      const committed = this.store.commitTrainingPlanCommandState({ scope: this.scope(), expectedRevision: current.revision,
        state: { ...prepared.state, goalsRevision: goals.revision }, eventType: `session:${request.draft.action}` });
      return { contractVersion: 1, operationId: request.operationId, stateRevision: committed.revision, goalsRevision: goals.revision,
        planInstanceId: prepared.state.planInstanceId, outcome: "changed", session: prepared.impact.after, execution: null,
        planUpdate: "pending", warnings: prepared.impact.warnings };
    });
  }
}

/** Replay is read-only and precedes capability, recovery, facts and candidate gates. */
export function createTrainingSessionCommandHandlers(service: TrainingPlanSessionCommandService,
  admit: (request: FastifyRequest) => void,
  withFactsLease: <T>(fn: () => Promise<T>) => Promise<T>) {
  const handle = (submit: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const body = parseTrainingSessionRequest(request.body, submit);
      if (submit) {
        const replay = service.replay(body as TrainingPlanSessionCommandRequest);
        if (replay !== null) return replay;
      }
      admit(request);
      const run = async () => submit ? service.submit(body as TrainingPlanSessionCommandRequest) : service.preview(body);
      return trainingSessionMetadataOnly(body.draft) ? await run() : await withFactsLease(run);
    } catch (error) {
      if (error instanceof PlanOperationError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      request.log.error({ error: internalErrorLogDetail(error), requestId: request.id }, "training session command failed");
      return reply.code(503).send({ code: "training_session_storage_unavailable", message: "课程存储暂不可用，请查询原操作结果。" });
    }
  };
  return { preview: handle(false), submit: handle(true) };
}
