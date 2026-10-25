import type {
  MobilePlannedDay, TrainingPlanClosedLoopCommandResponse, TrainingPlanExecutionCandidatesResponse,
  TrainingPlanExecutionCandidate, TrainingPlanExecutionCommandRequest, TrainingPlanExecutionDraft,
  TrainingPlanScope, TrainingPlanSession, TrainingPlanSessionExecution
} from "@rai/api-contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { MobileGoalsStore } from "./mobile-goals.js";
import { digest, prescriptionDigest } from "./plan-digest.js";
import { PlanOperationError, PlanPublicationService } from "./plan-publication.js";
import { assessWorkoutExecution, type CoachExecutionWorkout } from "./coach-execution-assessment.js";
import { parseTrainingPlanState, type TrainingPlanSessionState } from "./training-plan-store.js";
import { isValidLocalDate } from "./local-date.js";
import { sessionId, sessionRevision, TrainingPlanSessionStateError } from "./training-plan-session-state.js";
import { lifecycleForAssessment, pageExecutionCandidates, resolveExecutionRange, shiftLocalDate, type ExecutionFact } from "./training-plan-execution-match.js";
import type { TrainingPlanExecutionRow } from "./training-plan-execution-repository.js";
import { internalErrorLogDetail } from "./training-plan-commands.js";

const route = "training-plan-execution-command";
const invalid = (message: string): never => { throw new PlanOperationError("training_session_command_invalid", message, 422); };
const conflict = (code: string, message: string): never => { throw new PlanOperationError(code, message, 409); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/i;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${path}: unknown field ${key}`);
}

/** Strict wire parser: a malformed execution command writes nothing. */
export function parseTrainingExecutionRequest(body: unknown): TrainingPlanExecutionCommandRequest {
  try {
    if (!record(body)) return invalid("执行命令必须是 JSON 对象。");
    keys(body, ["contractVersion", "operationId", "operationScope", "expectedStateRevision", "planInstanceId",
      "sessionId", "sessionRevision", "executionRevision", "draft"], "command");
    if (body.contractVersion !== 1) throw new PlanOperationError("training_session_contract_required", "执行命令只接受合同 1。", 422);
    if (typeof body.operationId !== "string" || !UUID.test(body.operationId)) return invalid("operationId 必须是持久 UUID。");
    if (!record(body.operationScope)) return invalid("缺少 operationScope。");
    keys(body.operationScope, ["serverId", "athleteId", "datasetEpoch"], "operationScope");
    for (const key of ["serverId", "athleteId", "datasetEpoch"]) sessionId(body.operationScope[key], key);
    sessionRevision(body.expectedStateRevision, "expectedStateRevision");
    sessionId(body.planInstanceId, "planInstanceId");
    sessionId(body.sessionId, "sessionId");
    sessionRevision(body.sessionRevision, "sessionRevision");
    if (typeof body.executionRevision !== "number" || !Number.isSafeInteger(body.executionRevision) || body.executionRevision < 0) {
      return invalid("executionRevision 必须是非负整数。");
    }
    if (!record(body.draft)) return invalid("缺少 draft。");
    const action = body.draft.action;
    if (!["confirm", "correct", "retract", "skip"].includes(action as string)) return invalid("未知执行动作。");
    if (action === "skip") {
      keys(body.draft, ["action", "reason"], "draft");
      if (typeof body.draft.reason !== "string" || !body.draft.reason.trim() || body.draft.reason.length > 200) {
        return invalid("跳过必须提供不超过 200 字的明确原因。");
      }
    } else {
      keys(body.draft, ["action", "trainingSessionId", "sourceFactDigest"], "draft");
      sessionId(body.draft.trainingSessionId, "trainingSessionId");
      if (typeof body.draft.sourceFactDigest !== "string" || !SHA256_HEX.test(body.draft.sourceFactDigest)) {
        return invalid("sourceFactDigest 必须是事实摘要。");
      }
    }
    return structuredClone(body) as unknown as TrainingPlanExecutionCommandRequest;
  } catch (error) {
    if (error instanceof TrainingPlanSessionStateError) return invalid(error.message);
    throw error;
  }
}

/** Everything the command service may read: contract shape, never a plan writer. */
export interface ExecutionCommandFacts {
  /** Main-library data version, checked again before any write. */
  fingerprint: () => string;
  candidates: (rangeStart: string, rangeEnd: string) => ExecutionFact[];
  workout: (trainingSessionId: string, day: MobilePlannedDay, asOf: string) => CoachExecutionWorkout | null;
}

export interface ExecutionCandidateQuery {
  planInstanceId: string;
  rangeStart?: string | null;
  rangeEnd?: string | null;
  cursor?: string | null;
}

export class TrainingPlanExecutionCommandService {
  constructor(private readonly store: MobileGoalsStore, private readonly identity: () => TrainingPlanScope,
    private readonly businessDate: () => string, private readonly facts: () => ExecutionCommandFacts,
    private readonly now: () => number = Date.now) {}

  private scope(): string { const id = this.identity(); return JSON.stringify([id.serverId, id.athleteId, id.datasetEpoch]); }
  private scopeOf(request: { operationScope: TrainingPlanScope }): string {
    return JSON.stringify([request.operationScope.serverId, request.operationScope.athleteId, request.operationScope.datasetEpoch]);
  }
  private assertScope(request: { operationScope: TrainingPlanScope }): void {
    if (digest(request.operationScope) !== digest(this.identity())) conflict("training_scope_mismatch", "命令属于其他服务或数据集。");
  }
  private current(request: TrainingPlanExecutionCommandRequest) {
    this.assertScope(request);
    const row = this.store.trainingPlanStateRow(this.scope());
    if (row?.state.schemaVersion !== 2) return conflict("training_session_contract_unsupported", "当前数据域尚未完成课程身份迁移。");
    if (row.state.planInstanceId !== request.planInstanceId) conflict("training_plan_instance_mismatch", "计划实例已变化，请重读。");
    if (row.revision !== request.expectedStateRevision) conflict("training_state_revision_conflict", "训练计划已变化，请保留草稿并重新读取。");
    return { ...row, state: row.state as TrainingPlanSessionState };
  }
  private sessionOf(state: TrainingPlanSessionState, id: string): TrainingPlanSession {
    const session = state.sessions.find(item => item.sessionId === id);
    if (!session) throw new PlanOperationError("training_session_not_found", "当前实例中找不到该课程。", 404);
    return session;
  }
  private executionOf(id: string): TrainingPlanExecutionRow | null {
    return this.store.trainingPlanExecution(this.scope(), id);
  }
  private assertExecutionRevision(id: string, expected: number): TrainingPlanExecutionRow | null {
    const current = this.executionOf(id);
    if ((current?.execution.executionRevision ?? 0) !== expected) {
      conflict("training_execution_revision_conflict", "关联已变化，请重新读取课程后重试。");
    }
    return current;
  }

  replay(request: TrainingPlanExecutionCommandRequest): TrainingPlanClosedLoopCommandResponse | null {
    this.assertScope(request);
    return this.store.replayOperation(this.scope(), request.operationId, route, request);
  }

  /**
   * Candidate read. The returned list is a filter over real running facts; it
   * never claims identity. Only a link that is already confirmed with the same
   * source digest is presented as `verified_identity`.
   */
  candidates(sessionIdValue: string, query: ExecutionCandidateQuery): TrainingPlanExecutionCandidatesResponse {
    sessionId(sessionIdValue, "sessionId");
    if (typeof query.planInstanceId !== "string" || !query.planInstanceId) invalid("缺少 planInstanceId。");
    const row = this.store.trainingPlanStateRow(this.scope());
    if (row?.state.schemaVersion !== 2) return conflict("training_session_contract_unsupported", "当前数据域尚未完成课程身份迁移。");
    const state = row.state as TrainingPlanSessionState;
    if (state.planInstanceId !== query.planInstanceId) conflict("training_plan_instance_mismatch", "计划实例已变化，请重读。");
    const session = this.sessionOf(state, sessionIdValue);
    let range;
    try {
      range = resolveExecutionRange(session.prescription.localDate, query.rangeStart, query.rangeEnd);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : "候选范围非法。");
    }
    const page = pageExecutionCandidates({ facts: this.facts().candidates(range.rangeStart, range.rangeEnd), range, cursor: query.cursor ?? null });
    const current = this.executionOf(sessionIdValue);
    const candidates: TrainingPlanExecutionCandidate[] = page.candidates.map(candidate => {
      const claim = this.store.trainingPlanExecutionForRun(this.scope(), candidate.trainingSessionId);
      const verified = claim !== null && claim.execution.sessionId === sessionIdValue &&
        claim.execution.association === "confirmed" && claim.execution.sourceFactDigest === candidate.sourceFactDigest;
      return { ...candidate, evidence: verified ? "verified_identity" : "needs_confirmation" };
    });
    return { contractVersion: 1, scope: this.identity(), stateRevision: row.revision, planInstanceId: state.planInstanceId,
      sessionId: session.sessionId, sessionRevision: session.sessionRevision,
      executionRevision: current?.execution.executionRevision ?? 0,
      rangeStart: range.rangeStart, rangeEnd: range.rangeEnd, candidates, nextCursor: page.nextCursor };
  }

  private frozenPrescription(state: TrainingPlanSessionState, session: TrainingPlanSession, startedAt: string) {
    // The prescription must have been published and effective before the run
    // started. Current is valid only when it already existed then; otherwise the
    // frozen revision from the indexed history is the only honest source.
    if (Date.parse(session.availableAt) <= Date.parse(startedAt)) return session;
    const frozen = this.store.trainingPlanSessionAt(this.scope(), state.planInstanceId, session.sessionId, startedAt);
    return frozen?.session ?? null;
  }

  private assessment(facts: ExecutionCommandFacts, prescription: TrainingPlanSession, candidate: ExecutionFact) {
    const fallback: CoachExecutionWorkout = { id: candidate.trainingSessionId, startedAt: candidate.startedAt,
      endedAt: candidate.endedAt, availableAt: new Date(this.now()).toISOString(), distanceMeters: candidate.distanceMeters,
      durationSeconds: candidate.durationSeconds, evidenceLevel: "summary_only", measuredStepsComplete: false,
      segments: [], signalIntervals: [], evidenceRef: { source: "workout", id: candidate.trainingSessionId,
        observedAt: candidate.startedAt, availableAt: new Date(this.now()).toISOString(), revisionOrHash: candidate.sourceFactDigest } };
    const workout = facts.workout(candidate.trainingSessionId, prescription.prescription, new Date(this.now()).toISOString()) ?? fallback;
    const hash = prescriptionDigest(prescription.prescription.kind, prescription.prescription.structure ?? null);
    const assessment = assessWorkoutExecution({ asOf: new Date(this.now()).toISOString(),
      prescription: { day: prescription.prescription, revision: prescription.sessionRevision, createdAt: prescription.availableAt,
        availableAt: prescription.availableAt, evidenceRef: { source: "training_session_history",
          id: `${prescription.planInstanceId}:${prescription.sessionId}:${prescription.sessionRevision}`,
          observedAt: prescription.availableAt, availableAt: prescription.availableAt, revisionOrHash: hash } },
      workouts: [workout], associations: [{ workoutId: candidate.trainingSessionId, prescriptionDigest: hash,
        method: workout.evidenceLevel === "measured_steps" ? "measured_steps_with_plan" : "plan_history",
        validFrom: prescription.availableAt, validUntil: null, availableAt: workout.availableAt,
        retractedAt: null, evidenceRef: workout.evidenceRef }] });
    return assessment;
  }

  private findCandidate(facts: ExecutionCommandFacts, session: TrainingPlanSession, draft: { trainingSessionId: string; sourceFactDigest: string }) {
    let range;
    try {
      // The largest allowed user-expanded window, centred on the course date.
      // Confirm still re-verifies the live fact digest inside the transaction.
      range = resolveExecutionRange(session.prescription.localDate,
        shiftLocalDate(session.prescription.localDate, -15), shiftLocalDate(session.prescription.localDate, 15));
    } catch (error) { return invalid(error instanceof Error ? error.message : "候选范围非法。"); }
    const candidate = facts.candidates(range.rangeStart, range.rangeEnd)
      .find(fact => fact.trainingSessionId === draft.trainingSessionId);
    if (!candidate) conflict("training_execution_source_changed", "找不到这条实际训练，或它已不在课程候选窗口内。");
    if (Date.parse(candidate!.endedAt) > this.now()) {
      conflict("training_execution_source_changed", "实际训练尚未结束，不能确认完成。");
    }
    if (candidate!.sourceFactDigest !== draft.sourceFactDigest) {
      conflict("training_execution_source_changed", "实际训练已更正或重新导入，请重新读取候选。");
    }
    const claim = this.store.trainingPlanExecutionForRun(this.scope(), draft.trainingSessionId);
    if (claim !== null && claim.execution.sessionId !== session.sessionId) {
      conflict("training_execution_link_conflict", "这条实际训练已确认给另一堂课，请先撤回原关联。");
    }
    return candidate!;
  }

  submit(raw: TrainingPlanExecutionCommandRequest): TrainingPlanClosedLoopCommandResponse {
    const request = parseTrainingExecutionRequest(raw);
    const replay = this.replay(request);
    if (replay !== null) return replay;
    const needsFacts = request.draft.action === "confirm" || request.draft.action === "correct";
    const facts = needsFacts ? this.facts() : null;
    return new PlanPublicationService(this.store, () => this.scope(), this.identity).publish(route, request, () => {
      const current = this.current(request);
      const fingerprint = facts?.fingerprint() ?? "";
      const session = this.sessionOf(current.state, request.sessionId);
      if (session.sessionRevision !== request.sessionRevision) {
        conflict("training_session_revision_conflict", "课程已变化，请重新读取。");
      }
      const currentExecution = this.assertExecutionRevision(session.sessionId, request.executionRevision);
      const executionRevision = (currentExecution?.execution.executionRevision ?? 0) + 1;
      const now = new Date(this.now()).toISOString();
      const state = structuredClone(current.state);
      const target = this.sessionOf(state, request.sessionId);
      const draft = request.draft as TrainingPlanExecutionDraft;
      let nextExecution: TrainingPlanSessionExecution | null = currentExecution?.execution ?? null;
      const reason = `execution:${draft.action}`;
      let lifecycleChanged = false;
      const warnings = ["执行关联只确认实际训练身份；剂量与刺激仍按证据独立评价。",
        "保存关联不会自动更新设备排期，也不会调用 WorkoutKit。"];

      if (draft.action === "skip") {
        if (target.lifecycle !== "pending") conflict("training_session_not_editable", "只有尚未执行的课程可以明确跳过。");
        if (currentExecution?.execution.association === "confirmed") {
          conflict("training_execution_link_conflict", "已确认实际训练的课程不能跳过；请先撤回关联。");
        }
        target.lifecycle = "skipped";
        target.sessionRevision += 1;
        target.availableAt = now;
        lifecycleChanged = true;
        warnings.push("跳过是用户决定；系统不会根据没有观测自动跳过。");
      } else if (draft.action === "retract") {
        if (currentExecution === null || currentExecution.execution.trainingSessionId === null ||
            currentExecution.execution.sourceFactDigest === null) conflict("training_execution_link_conflict", "当前课程没有可撤回的执行关联。");
        if (currentExecution!.execution.trainingSessionId !== draft.trainingSessionId ||
            currentExecution!.execution.sourceFactDigest !== draft.sourceFactDigest) {
          conflict("training_execution_source_changed", "关联已变化，请重新读取。");
        }
        if (currentExecution!.execution.association === "invalidated") {
          return this.response(request, current, target, currentExecution!.execution, "no_change", warnings);
        }
        nextExecution = { ...currentExecution!.execution, executionRevision, association: "invalidated",
          assessment: currentExecution!.execution.assessment,
          reasonCodes: [...new Set([...currentExecution!.execution.reasonCodes, "execution_retracted"])], availableAt: now };
        if (target.lifecycle === "completed" || target.lifecycle === "partial") {
          target.lifecycle = "pending";
          target.sessionRevision += 1;
          target.availableAt = now;
          lifecycleChanged = true;
        }
        warnings.push("撤回只撤销当前完成结论；原处方和当时评价仍保留在执行历史中。");
      } else {
        // confirm / correct
        if (target.lifecycle === "skipped" || target.lifecycle === "cancelled") {
          conflict("training_session_not_editable", "已跳过或已取消的课程不能确认执行。");
        }
        if (draft.action === "confirm" && currentExecution?.execution.association === "confirmed") {
          conflict("training_execution_link_conflict", "课程已有关联；更换实际训练请使用纠正。");
        }
        if (draft.action === "correct" && currentExecution?.execution.association !== "confirmed" &&
            currentExecution?.execution.association !== "invalidated" && currentExecution?.execution.association !== "pending_confirmation") {
          conflict("training_execution_link_conflict", "当前没有可纠正的关联；首次关联请使用确认。");
        }
        if (draft.action === "correct" && currentExecution?.execution.association === "confirmed" &&
            currentExecution.execution.trainingSessionId === draft.trainingSessionId &&
            currentExecution.execution.sourceFactDigest === draft.sourceFactDigest) {
          return this.response(request, current, target, currentExecution.execution, "no_change", warnings);
        }
        if (facts === null) conflict("training_execution_source_changed", "执行事实不可读。");
        const candidate = this.findCandidate(facts!, target, draft);
        if (facts!.fingerprint() !== fingerprint) conflict("training_execution_source_changed", "读取候选后训练事实发生变化，请重试。");
        const prescription = this.frozenPrescription(state, target, candidate.startedAt);
        if (prescription === null) conflict("training_execution_source_changed", "开跑前没有已发布生效的课程修订，不能把事后编辑的课当作当时处方。");
        const assessment = this.assessment(facts!, prescription!, candidate);
        const lifecycle = lifecycleForAssessment(assessment);
        nextExecution = { sessionId: target.sessionId, executionRevision, association: "confirmed",
          trainingSessionId: candidate.trainingSessionId, sourceFactDigest: candidate.sourceFactDigest,
          prescriptionSessionRevision: prescription!.sessionRevision, assessment, availableAt: now,
          reasonCodes: assessment.reasons.map(item => item.code) };
        if (target.lifecycle !== lifecycle) {
          target.lifecycle = lifecycle;
          target.sessionRevision += 1;
          target.availableAt = now;
          lifecycleChanged = true;
        }
      }

      parseTrainingPlanState(state);
      let stateRevision = current.revision;
      if (lifecycleChanged) {
        const committed = this.store.commitTrainingPlanCommandState({ scope: this.scope(), expectedRevision: current.revision,
          state: { ...state, goalsRevision: current.state.goalsRevision }, eventType: reason });
        stateRevision = committed.revision;
      } else if (nextExecution === null || nextExecution === currentExecution?.execution) {
        throw new PlanOperationError("training_execution_link_conflict", "没有可提交的执行变化。", 409);
      }
      if (nextExecution !== null && nextExecution !== currentExecution?.execution) {
        try {
          this.store.appendTrainingPlanExecution(this.scope(), state.planInstanceId, nextExecution, reason);
        } catch (error) {
          if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
            conflict("training_execution_link_conflict", "这条实际训练已被另一堂课确认，请重新读取。");
          }
          throw error;
        }
      }
      return this.response(request, { ...current, revision: stateRevision }, target, nextExecution, "changed", warnings);
    });
  }

  /**
   * B06/S03-04 source reconciliation. A corrected/deleted/merged run invalidates
   * the current link and appends a new execution revision; the old completion
   * prescription and assessment stay readable in history. This is a background
   * write path (never a GET) with a deterministic operation key, so a retried
   * tick replays the same result instead of adding revisions.
   */
  reconcileSourceChanges(): { changed: number } {
    const row = this.store.trainingPlanStateRow(this.scope());
    if (row?.state.schemaVersion !== 2 || row.state.runState !== "active") return { changed: 0 };
    const state = row.state as TrainingPlanSessionState;
    const current = this.store.trainingPlanExecutions(this.scope(), state.planInstanceId)
      .filter(execution => execution.association === "confirmed");
    if (current.length === 0) return { changed: 0 };
    const facts = this.facts();
    const stale: Array<{ execution: TrainingPlanSessionExecution; session: TrainingPlanSession }> = [];
    for (const execution of current) {
      const session = state.sessions.find(item => item.sessionId === execution.sessionId);
      if (!session) continue;
      let range;
      try {
        range = resolveExecutionRange(session.prescription.localDate,
          shiftLocalDate(session.prescription.localDate, -15), shiftLocalDate(session.prescription.localDate, 15));
      } catch { continue; }
      const live = facts.candidates(range.rangeStart, range.rangeEnd)
        .find(fact => fact.trainingSessionId === execution.trainingSessionId);
      if (live !== undefined && live.sourceFactDigest === execution.sourceFactDigest) continue;
      stale.push({ execution, session });
    }
    if (stale.length === 0) return { changed: 0 };
    const operationId = `reconcile-${digest({ contract: "rai-training-execution-reconcile-v1", scope: this.identity(),
      stateRevision: row.revision,
      executions: stale.map(item => ({ sessionId: item.session.sessionId, executionRevision: item.execution.executionRevision,
        trainingSessionId: item.execution.trainingSessionId, sourceFactDigest: item.execution.sourceFactDigest })) }).slice(0, 40)}`;
    return new PlanPublicationService(this.store, () => this.scope(), this.identity).publish(route, {
      operationId, operationScope: this.identity() }, () => {
      const latest = this.store.trainingPlanStateRow(this.scope());
      if (latest === null || latest.state.schemaVersion !== 2) {
        throw new PlanOperationError("training_session_contract_unsupported", "当前数据域尚未完成课程身份迁移。", 409);
      }
      const latestState = latest.state as TrainingPlanSessionState;
      const now = new Date(this.now()).toISOString();
      const next = structuredClone(latestState);
      let changed = 0;
      for (const item of stale) {
        const execution = this.executionOf(item.session.sessionId);
        if (execution === null || execution.execution.association !== "confirmed" ||
            execution.execution.sourceFactDigest !== item.execution.sourceFactDigest) continue;
        const session = next.sessions.find(value => value.sessionId === item.session.sessionId);
        if (!session) continue;
        const executionRevision = execution.execution.executionRevision + 1;
        const invalidated: TrainingPlanSessionExecution = { ...execution.execution, executionRevision,
          association: "invalidated", reasonCodes: [...new Set([...execution.execution.reasonCodes, "execution_source_changed"])],
          availableAt: now };
        if (session.lifecycle === "completed" || session.lifecycle === "partial") {
          session.lifecycle = "pending";
          session.sessionRevision += 1;
          session.availableAt = now;
        }
        this.store.appendTrainingPlanExecution(this.scope(), next.planInstanceId, invalidated, "reconcile:source_changed");
        changed += 1;
      }
      if (changed === 0) return { changed: 0 };
      parseTrainingPlanState(next);
      this.store.commitTrainingPlanCommandState({ scope: this.scope(), expectedRevision: latest.revision,
        state: { ...next, goalsRevision: latestState.goalsRevision }, eventType: "execution:source_changed" });
      return { changed };
    });
  }

  private response(request: TrainingPlanExecutionCommandRequest, row: { state: TrainingPlanSessionState; revision: number },
    session: TrainingPlanSession, execution: TrainingPlanSessionExecution | null,
    outcome: "changed" | "no_change", warnings: string[]): TrainingPlanClosedLoopCommandResponse {
    return { contractVersion: 1, operationId: request.operationId, stateRevision: row.revision,
      goalsRevision: row.state.goalsRevision, planInstanceId: row.state.planInstanceId, outcome,
      session: structuredClone(session), execution: execution === null ? null : structuredClone(execution),
      planUpdate: "pending", warnings };
  }
}

/** Replay precedes capability, storage and revision gates; write admission follows. */
export function createTrainingExecutionCommandHandlers(service: TrainingPlanExecutionCommandService,
  admit: (request: FastifyRequest) => void,
  withFactsLease: <T>(fn: () => Promise<T>) => Promise<T>) {
  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const body = parseTrainingExecutionRequest(request.body);
      const replay = service.replay(body);
      if (replay !== null) return replay;
      admit(request);
      // Retract/skip are metadata-only: they remain available while a sync holds
      // the facts lease, and must not be blocked by an import in progress.
      return body.draft.action === "retract" || body.draft.action === "skip"
        ? await service.submit(body) : await withFactsLease(async () => service.submit(body));
    } catch (error) {
      if (error instanceof PlanOperationError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      request.log.error({ error: internalErrorLogDetail(error), requestId: request.id }, "training execution command failed");
      return reply.code(503).send({ code: "training_session_storage_unavailable", message: "执行关联存储暂不可用，请查询原操作结果。" });
    }
  };
  const candidates = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      admit(request);
      const params = request.params as { sessionId?: string };
      const query = request.query as Record<string, unknown>;
      const optional = (key: string): string | null => {
        const value = query[key];
        if (value === undefined || value === "") return null;
        if (typeof value !== "string") return invalid(`query ${key} 必须是字符串。`);
        if (key !== "cursor" && !isValidLocalDate(value)) return invalid(`query ${key} 不是合法日期。`);
        return value;
      };
      return await withFactsLease(async () => service.candidates(params.sessionId ?? "", {
        planInstanceId: typeof query.planInstanceId === "string" ? query.planInstanceId : "",
        rangeStart: optional("rangeStart"), rangeEnd: optional("rangeEnd"), cursor: optional("cursor")
      }));
    } catch (error) {
      if (error instanceof PlanOperationError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      request.log.error({ error: internalErrorLogDetail(error), requestId: request.id }, "training execution candidates failed");
      return reply.code(503).send({ code: "training_session_storage_unavailable", message: "执行候选暂不可用，请稍后重试。" });
    }
  };
  return { candidates, submit: handle, reconcile: () => service.reconcileSourceChanges() };
}
