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
import { factsInRange, lifecycleForAssessment, pageExecutionCandidates, resolveExecutionRange, shiftLocalDate, type ExecutionFact } from "./training-plan-execution-match.js";
import type { TrainingPlanExecutionRow } from "./training-plan-execution-repository.js";
import { internalErrorLogDetail } from "./training-plan-commands.js";

const route = "training-plan-execution-command";
const invalid = (message: string): never => { throw new PlanOperationError("training_session_command_invalid", message, 422); };
const conflict = (code: string, message: string): never => { throw new PlanOperationError(code, message, 409); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[a-f0-9]{64}$/i;
class ReconciliationNoChange extends Error {}

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
  /**
   * Execution-side reads/commands must reject a course that the current plan has
   * already replaced or cancelled. A superseded course keeps `lifecycle=pending`
   * in policy for history, so lookup by ID alone would let a stale client claim or
   * skip a course that no longer owns its date.
   */
  private executableSession(state: TrainingPlanSessionState, id: string): TrainingPlanSession {
    const session = this.sessionOf(state, id);
    if (session.supersededBySessionId !== null || session.lifecycle === "cancelled") {
      conflict("training_session_not_editable", "已被替换或取消的课程不能执行关联。");
    }
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

  private assertExecutionAuthority(state: TrainingPlanSessionState, action: TrainingPlanExecutionDraft["action"]): void {
    // Correct creates a new claim even when it replaces a historical link.
    // Retract only withdraws a saved claim and never grants execution authority.
    if (action !== "retract" && (state.runState !== "active" || state.sourceStatus === "ended")) {
      conflict("training_execution_not_active", "计划已暂停或结束，不能确认、纠正或跳过执行；仍可撤回历史关联。");
    }
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
    const session = this.executableSession(state, sessionIdValue);
    let range;
    try {
      range = resolveExecutionRange(session.prescription.localDate, query.rangeStart, query.rangeEnd);
    } catch (error) {
      return invalid(error instanceof Error ? error.message : "候选范围非法。");
    }
    const page = pageExecutionCandidates({ facts: this.facts().candidates(range.rangeStart, range.rangeEnd), range,
      scope: this.scope(), cursor: query.cursor ?? null });
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
    if (workout.id !== candidate.trainingSessionId || workout.startedAt !== candidate.startedAt ||
        workout.endedAt !== candidate.endedAt || workout.distanceMeters !== candidate.distanceMeters ||
        workout.durationSeconds !== candidate.durationSeconds || workout.evidenceRef.id !== candidate.trainingSessionId ||
        workout.evidenceRef.revisionOrHash !== candidate.sourceFactDigest) {
      conflict("training_execution_source_changed", "候选与执行评价的事实身份或摘要不一致，请重新读取。");
    }
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
    const needsFacts = request.draft.action !== "retract";
    const facts = needsFacts ? this.facts() : null;
    return new PlanPublicationService(this.store, () => this.scope(), this.identity).publish(route, request, () => {
      const current = this.current(request);
      this.assertExecutionAuthority(current.state, request.draft.action);
      // Skip takes its fingerprint after the pending/link guards below, so an
      // already completed course keeps the existing rejection semantics.
      const fingerprint = request.draft.action === "skip" ? "" : facts?.fingerprint() ?? "";
      if (request.draft.action === "confirm" || request.draft.action === "correct") {
        const assertUnchanged = () => {
          if (facts!.fingerprint() !== fingerprint) {
            conflict("training_execution_source_changed", "执行评价或提交前训练事实发生变化，请重新读取候选。");
          }
        };
        // Also covers Correct's no-change result and the operation receipt.
        this.store.beforePublicationCommit(assertUnchanged);
      }
      const draft = request.draft as TrainingPlanExecutionDraft;
      const linksExecution = draft.action !== "retract";
      const session = linksExecution ? this.executableSession(current.state, request.sessionId)
        : this.sessionOf(current.state, request.sessionId);
      if (session.sessionRevision !== request.sessionRevision) {
        conflict("training_session_revision_conflict", "课程已变化，请重新读取。");
      }
      const currentExecution = this.assertExecutionRevision(session.sessionId, request.executionRevision);
      const executionRevision = (currentExecution?.execution.executionRevision ?? 0) + 1;
      const now = new Date(this.now()).toISOString();
      const state = structuredClone(current.state);
      const target = linksExecution ? this.executableSession(state, request.sessionId) : this.sessionOf(state, request.sessionId);
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
        const skipFacts = facts!;
        const before = skipFacts.fingerprint();
        // Same unpaginated default ±2-day window as the candidate page. A wider
        // user search must not silently redefine the server's Skip eligibility.
        const range = resolveExecutionRange(target.prescription.localDate);
        const candidates = factsInRange(skipFacts.candidates(range.rangeStart, range.rangeEnd), range);
        const assertUnchanged = () => {
          if (skipFacts.fingerprint() !== before) {
            conflict("training_execution_source_changed", "跳过提交前训练事实发生变化，请刷新候选后重试。");
          }
        };
        assertUnchanged();
        if (candidates.length > 0) {
          conflict("training_execution_candidates_present", "课程候选窗口内已有实际跑步，不能跳过；请刷新候选并确认关联。");
        }
        // Runs after state/history/operation-result writes, immediately before
        // the control COMMIT. The HTTP owner holds the shared facts lease until
        // publish returns; no supported main-DB writer can enter this gap.
        this.store.beforePublicationCommit(assertUnchanged);
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
        if (facts === null) conflict("training_execution_source_changed", "执行事实不可读。");
        // Always re-read the live candidate and verify the source digest before a
        // no-op may be reported: a deleted/corrected source fact must surface as
        // source_changed, not as "nothing to change".
        const candidate = this.findCandidate(facts!, target, draft);
        if (facts!.fingerprint() !== fingerprint) conflict("training_execution_source_changed", "读取候选后训练事实发生变化，请重试。");
        if (draft.action === "correct" && currentExecution?.execution.association === "confirmed" &&
            currentExecution.execution.trainingSessionId === draft.trainingSessionId &&
            currentExecution.execution.sourceFactDigest === draft.sourceFactDigest) {
          return this.response(request, current, target, currentExecution.execution, "no_change", warnings);
        }
        const prescription = this.frozenPrescription(state, target, candidate.startedAt);
        if (prescription === null) conflict("training_execution_source_changed", "开跑前没有已发布生效的课程修订，不能把事后编辑的课当作当时处方。");
        const assessment = this.assessment(facts!, prescription!, candidate);
        if (facts!.fingerprint() !== fingerprint) conflict("training_execution_source_changed", "读取执行评价后训练事实发生变化，请重试。");
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
    const factsBefore = facts.fingerprint();
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
    if (facts.fingerprint() !== factsBefore) {
      conflict("training_execution_source_changed", "预扫描执行事实期间数据发生变化，请重试。");
    }
    if (stale.length === 0) return { changed: 0 };
    // v2 must not replay a legacy no-change tombstone; old receipts stay immutable.
    const operationId = `reconcile-${digest({ contract: "rai-training-execution-reconcile-v2", scope: this.identity(),
      stateRevision: row.revision,
      executions: stale.map(item => ({ sessionId: item.session.sessionId, executionRevision: item.execution.executionRevision,
        trainingSessionId: item.execution.trainingSessionId, sourceFactDigest: item.execution.sourceFactDigest })) }).slice(0, 40)}`;
    const publish = () => new PlanPublicationService(this.store, () => this.scope(), this.identity).publish(route, {
      operationId, operationScope: this.identity() }, () => {
      const latest = this.store.trainingPlanStateRow(this.scope());
      if (latest === null || latest.state.schemaVersion !== 2) {
        throw new PlanOperationError("training_session_contract_unsupported", "当前数据域尚未完成课程身份迁移。", 409);
      }
      const latestState = latest.state as TrainingPlanSessionState;
      this.assertExecutionAuthority(latestState, "confirm");
      if (latestState.planInstanceId !== state.planInstanceId || latest.revision !== row.revision) {
        conflict("training_state_revision_conflict", "核对期间计划状态已变化，请重试。");
      }
      // Facts can be updated concurrently between the cheap pre-scan and this
      // transaction. Re-read every candidate here and only invalidate a link that
      // is still stale now; a recovered fact must not be marked invalidated.
      this.store.beforePublicationCommit(() => {
        if (facts.fingerprint() !== factsBefore) {
          conflict("training_execution_source_changed", "核对结果提交前训练事实发生变化，请重试。");
        }
      });
      const now = new Date(this.now()).toISOString();
      const next = structuredClone(latestState);
      let changed = 0;
      for (const item of stale) {
        const execution = this.executionOf(item.session.sessionId);
        if (execution === null || execution.execution.association !== "confirmed" ||
            execution.execution.sourceFactDigest !== item.execution.sourceFactDigest) continue;
        const session = next.sessions.find(value => value.sessionId === item.session.sessionId);
        if (!session) continue;
        let range;
        try {
          range = resolveExecutionRange(session.prescription.localDate,
            shiftLocalDate(session.prescription.localDate, -15), shiftLocalDate(session.prescription.localDate, 15));
        } catch { continue; }
        const live = facts.candidates(range.rangeStart, range.rangeEnd)
          .find(fact => fact.trainingSessionId === execution.execution.trainingSessionId);
        if (live !== undefined && live.sourceFactDigest === execution.execution.sourceFactDigest) continue;
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
      if (facts.fingerprint() !== factsBefore) {
        throw new PlanOperationError("training_execution_source_changed", "核对执行事实期间数据发生变化，请重试。", 409);
      }
      // A transiently recovered source must not persist changed:0 under this
      // deterministic key and mask a later invalidation of the same old claim.
      if (changed === 0) throw new ReconciliationNoChange();
      parseTrainingPlanState(next);
      this.store.commitTrainingPlanCommandState({ scope: this.scope(), expectedRevision: latest.revision,
        state: { ...next, goalsRevision: latestState.goalsRevision }, eventType: "execution:source_changed" });
      return { changed };
    });
    try { return publish(); }
    catch (error) {
      if (error instanceof ReconciliationNoChange) return { changed: 0 };
      throw error;
    }
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
      // Skip must hold the same mutation lease as fact writers across candidate
      // validation and the entire control publication (including COMMIT).
      // Retract uses saved identity and remains metadata-only.
      return body.draft.action === "retract"
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
  return { candidates, submit: handle,
    reconcile: () => withFactsLease(async () => service.reconcileSourceChanges()) };
}
