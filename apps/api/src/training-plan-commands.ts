import type {
  MobilePlanAudit,
  MobilePlannedDay,
  MobileRaceTarget,
  TrainingPlanAdmissionState,
  TrainingPlanCommandChangeSet,
  TrainingPlanCommandPreviewRequest,
  TrainingPlanCommandPreviewResponse,
  TrainingPlanCommandRequest,
  TrainingPlanCommandResponse,
  TrainingPlanRaceGoalView,
  TrainingPlanScope,
  TrainingPlanStateSummary
} from "@rai/api-contracts";
import { TRAINING_PLAN_CONTRACT_VERSION } from "@rai/api-contracts";
import type { TrainingPlanRefreshRequest, TrainingPlanRefreshResponse } from "@rai/api-contracts";

import type { CoachZonePrescription } from "./mobile-coach.js";

import type { MobileGoalsStore } from "./mobile-goals.js";
import { PlanOperationError, PlanPublicationService } from "./plan-publication.js";
import { MutationConflictError } from "./mutation-coordinator.js";
import { mergePlanWindow } from "./weekly-plan-service.js";
import { digest } from "./plan-digest.js";
import {
  admissionStateFor,
  applyTrainingConfigurationCommand,
  raceDistanceFor,
  raceGoalSupport,
  resolveTrainingMode,
  trainingPlanContextDigest,
  TRAINING_MODE_POLICY_VERSION,
  type TrainingConfigurationState
} from "./training-mode-policy.js";
import {
  TrainingPlanStateConflictError,
  TrainingPlanStateError,
  type TrainingPlanState,
  type TrainingPlanStateRow
} from "./training-plan-store.js";

/**
 * PR4-2: configuration commands over the unified state.
 *
 * Scope of this slice, deliberately explicit:
 * - **preview** is stateless and never writes. It returns a candidate id bound to
 *   the exact draft, state revision and expiry, so a later submit cannot silently
 *   apply a different configuration.
 * - **submit** publishes configuration and an externally prepared plan together.
 *   The route generates outside the transaction; submit rechecks revision and
 *   facts before committing. Pause generates nothing and clears the current lock.
 *   Configuration-only callers retain `planRefreshRequired: true`.
 * - the unified state write, its history row, the legacy goals mirror and the
 *   operation result all commit in ONE control-database transaction (the caller
 *   provides `PlanPublicationService`, which runs the action inside
 *   `withPublicationTransaction`). A crash cannot leave a new goal with an old
 *   legacy projection.
 * - an ended source cannot be resumed into the ended programme (explicit error);
 *   it needs a fresh configuration.
 */

export const TRAINING_PLAN_PREVIEW_TTL_SECONDS = 120;

type CommandInput = {
  action: TrainingPlanCommandRequest["action"];
  raceGoal?: TrainingPlanCommandRequest["raceGoal"];
};

function requireContractTwo(version: unknown): void {
  if (version !== TRAINING_PLAN_CONTRACT_VERSION) {
    throw new PlanOperationError("training_contract_required",
      `该端点只接受训练合同版本 ${TRAINING_PLAN_CONTRACT_VERSION}。`, 422);
  }
}

function assertScope(actual: TrainingPlanScope, identity: TrainingPlanScope): void {
  if (!actual || typeof actual !== "object" ||
    ![actual.serverId, actual.athleteId, actual.datasetEpoch].every(value => typeof value === "string" && value.length > 0)) {
    throw new PlanOperationError("training_command_invalid", "operationScope 必须声明服务、运动员与数据集。", 422);
  }
  if (actual.serverId !== identity.serverId || actual.athleteId !== identity.athleteId ||
    actual.datasetEpoch !== identity.datasetEpoch) {
    throw new PlanOperationError("training_scope_mismatch", "命令属于其他服务或数据集，不能跨域执行。", 409);
  }
}

function requireOperationId(value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PlanOperationError("training_command_invalid", "提交必须声明持久 operationId。", 422);
  }
}

function requireAction(action: unknown): void {
  if (!["set_race_goal", "clear_race_goal", "pause", "resume"].includes(action as string)) {
    throw new PlanOperationError("training_command_invalid", "不支持该训练命令。", 422);
  }
}

/** Content-derived race identity: the same race always gets the same id. */
function raceGoalId(scopeKey: string, draft: TrainingPlanCommandRequest["raceGoal"]): string {
  return `goal-${digest({ scopeKey, draft: draft ?? null, policy: TRAINING_MODE_POLICY_VERSION }).slice(0, 24)}`;
}

function toConfiguration(state: TrainingPlanState): TrainingConfigurationState {
  return { raceGoal: state.raceGoal, runState: state.runState, preferencesComplete: state.preferencesComplete };
}

function summarize(state: TrainingPlanState, businessDate: string): TrainingPlanStateSummary {
  const mode = resolveTrainingMode({ raceGoal: state.raceGoal, businessDate });
  const admission: TrainingPlanAdmissionState = state.sourceStatus === "ended"
    ? "needs_confirmation"
    : admissionStateFor(toConfiguration(state));
  const raceGoal: TrainingPlanRaceGoalView | null = state.raceGoal === null ? null : {
    ...state.raceGoal,
    support: raceGoalSupport(state.raceGoal, businessDate)
  };
  return {
    mode: mode.mode,
    modeReason: mode.reason,
    daysToRace: mode.daysToRace,
    runState: state.runState,
    admission,
    raceGoal
  };
}

function changeSet(before: TrainingPlanStateSummary, after: TrainingPlanStateSummary,
  goalIdentity: TrainingPlanCommandChangeSet["goalIdentity"]): TrainingPlanCommandChangeSet {
  return {
    goalIdentity,
    goalChanged: digest(before.raceGoal) !== digest(after.raceGoal),
    runStateChanged: before.runState !== after.runState,
    modeChanged: before.mode !== after.mode
  };
}

/**
 * Legacy `mobile_goals.race_target` mirror.
 *
 * `undefined` = leave the stored value untouched (pause/resume).
 * A standard-distance race goal is mirrored so v1 readers see the same goal; a
 * custom distance cannot be expressed by `MobileRaceTarget`, so it stays in the
 * unified state only and the legacy projection is cleared (`null`) rather than
 * leaving a stale target that disagrees with the unified owner.
 */
export function legacyRaceTargetMirror(state: TrainingPlanState): MobileRaceTarget | null | undefined {
  if (state.raceGoal === null) return null;
  const distance = raceDistanceFor(state.raceGoal.distanceKm);
  if (distance === null) return null;
  return { date: state.raceGoal.date, distance, targetPaceSecondsPerKm: null };
}

export class TrainingPlanCommandService {
  constructor(
    private readonly store: MobileGoalsStore,
    private readonly scopeKey: () => string,
    private readonly identity: () => TrainingPlanScope,
    private readonly businessDate: () => string,
    private readonly now: () => number = Date.now
  ) {}

  private publication(): PlanPublicationService {
    // The identity is required by construction: a missing one would silently skip
    // cross-domain replay checks (see PlanPublicationService's header comment).
    return new PlanPublicationService(this.store, this.scopeKey, this.identity);
  }

  private readState(): { row: TrainingPlanStateRow; state: TrainingPlanState } {
    const row = this.store.trainingPlanStateRow(this.scopeKey());
    if (row === null) {
      throw new PlanOperationError("training_plan_not_migrated",
        "该数据域尚未迁移到统一训练状态；请先完成迁移。", 409);
    }
    return { row, state: row.state };
  }

  private decide(row: TrainingPlanStateRow, input: CommandInput): {
    decision: ReturnType<typeof applyTrainingConfigurationCommand>;
    afterState: TrainingPlanState;
  } {
    const scopeKey = this.scopeKey();
    const decision = applyTrainingConfigurationCommand({
      state: toConfiguration(row.state),
      command: input.action === "set_race_goal"
        ? { type: "set_race_goal", draft: input.raceGoal ?? {} }
        : input.action === "clear_race_goal" ? { type: "clear_race_goal" }
          : input.action === "pause" ? { type: "pause" } : { type: "resume" },
      businessDate: this.businessDate(),
      newGoalId: raceGoalId(scopeKey, input.raceGoal)
    });
    const afterState: TrainingPlanState = {
      ...row.state,
      raceGoal: decision.state.raceGoal,
      runState: decision.state.runState,
      // Pause revokes the current prescription, while append-only history stays.
      lockedSession: decision.state.runState === "paused" ? null : row.state.lockedSession,
      planContextDigest: trainingPlanContextDigest({ raceGoal: decision.state.raceGoal, runState: decision.state.runState })
    };
    return { decision, afterState };
  }

  private rejectIfInvalid(decision: ReturnType<typeof applyTrainingConfigurationCommand>): void {
    if (decision.accepted) return;
    const reason = decision.rejection === "draft"
      ? "目标尚未填写完整（日期、距离或成绩时间），不会改变当前模式。"
      : `目标配置非法：${decision.reasons.join("、")}。`;
    throw new PlanOperationError("training_configuration_invalid", reason, 422);
  }

  private candidateIdFor(input: CommandInput, expectedStateRevision: number, expiresAt: string): string {
    return `${digest({ scope: this.scopeKey(), action: input.action, raceGoal: input.raceGoal ?? null, expectedStateRevision,
      policy: TRAINING_MODE_POLICY_VERSION, expiresAt })}:${expiresAt}`;
  }

  /** Immutable results are checked before current-state validation or generation. */
  replayCommand(request: TrainingPlanCommandRequest): TrainingPlanCommandResponse | null {
    requireContractTwo(request.contractVersion);
    requireOperationId(request.operationId);
    assertScope(request.operationScope, this.identity());
    return this.store.replayOperation<TrainingPlanCommandResponse>(
      this.scopeKey(), request.operationId, "training-plan-command", request);
  }

  private validateCandidate(request: TrainingPlanCommandRequest): void {
    const expiresAt = typeof request.candidateId === "string" ? this.candidateExpiry(request.candidateId) : null;
    if (expiresAt === null) {
      throw new PlanOperationError("training_candidate_expired", "预览已过期或候选不合法，请重新预览。", 409);
    }
    if (this.candidateIdFor(request, request.expectedStateRevision, expiresAt) !== request.candidateId) {
      throw new PlanOperationError("training_candidate_mismatch", "提交内容与预览的候选不一致，请重新预览。", 409);
    }
  }

  /**
   * PR4-4: the configuration a command would commit, without writing anything.
   * The route prepares the candidate plan against this state (outside the control
   * transaction), then `submit` re-derives it and verifies the configuration digest.
   */
  planFor(request: TrainingPlanCommandRequest): { row: TrainingPlanStateRow; afterState: TrainingPlanState } {
    requireContractTwo(request.contractVersion);
    requireAction(request.action);
    assertScope(request.operationScope, this.identity());
    const { row, state } = this.readState();
    if (request.expectedStateRevision !== row.revision) {
      throw new PlanOperationError("training_revision_conflict",
        `训练状态已更新（当前 revision ${row.revision}），请重新读取并重新预览。`, 409);
    }
    this.validateCandidate(request);
    if (state.sourceStatus === "ended" && request.action === "resume") {
      throw new PlanOperationError("training_cannot_resume", "已结束的训练节目不能恢复，请建立新的配置。", 409);
    }
    const input: CommandInput = { action: request.action, raceGoal: request.raceGoal ?? null };
    const { decision, afterState } = this.decide(row, input);
    this.rejectIfInvalid(decision);
    return { row, afterState };
  }

  preview(request: TrainingPlanCommandPreviewRequest): TrainingPlanCommandPreviewResponse {
    requireContractTwo(request.contractVersion);
    requireAction(request.action);
    assertScope(request.operationScope, this.identity());
    const { row, state } = this.readState();
    if (request.expectedStateRevision != null && request.expectedStateRevision !== row.revision) {
      throw new PlanOperationError("training_revision_conflict",
        `训练状态已更新（当前 revision ${row.revision}），请重新读取。`, 409);
    }
    const input: CommandInput = { action: request.action, raceGoal: request.raceGoal ?? null };
    const { decision, afterState } = this.decide(row, input);
    if (state.sourceStatus === "ended" && request.action === "resume") {
      throw new PlanOperationError("training_cannot_resume", "已结束的训练节目不能恢复，请建立新的配置。", 409);
    }
    this.rejectIfInvalid(decision);
    const businessDate = this.businessDate();
    const expiresAt = new Date(this.now() + TRAINING_PLAN_PREVIEW_TTL_SECONDS * 1000).toISOString();
    const warnings: string[] = [];
    if (input.action === "set_race_goal" && decision.state.raceGoal !== null && raceDistanceFor(decision.state.raceGoal.distanceKm) === null) {
      warnings.push("自定义距离只保存在统一状态中；旧版 raceTarget 无法表达该距离，旧版兼容字段会被清空，旧客户端看不到这个赛事。");
    }
    return {
      contractVersion: TRAINING_PLAN_CONTRACT_VERSION,
      candidateId: this.candidateIdFor(input, row.revision, expiresAt),
      expiresAt,
      expectedStateRevision: row.revision,
      before: summarize(state, businessDate),
      after: summarize(afterState, businessDate),
      changes: changeSet(summarize(state, businessDate), summarize(afterState, businessDate), decision.goalIdentity),
      planRefreshRequired: true,
      warnings
    };
  }

  submit(request: TrainingPlanCommandRequest, options: {
    prepared?: PreparedTrainingPlan;
    fingerprint?: () => string;
  } = {}): TrainingPlanCommandResponse {
    requireContractTwo(request.contractVersion);
    requireAction(request.action);
    requireOperationId(request.operationId);
    assertScope(request.operationScope, this.identity());
    const input: CommandInput = { action: request.action, raceGoal: request.raceGoal ?? null };
    return this.publication().publish("training-plan-command", request, () => {
      const { row, state } = this.readState();
      if (request.expectedStateRevision !== row.revision) {
        throw new PlanOperationError("training_revision_conflict",
          `训练状态已更新（当前 revision ${row.revision}），请重新读取并重新预览。`, 409);
      }
      this.validateCandidate(request);
      if (state.sourceStatus === "ended" && request.action === "resume") {
        throw new PlanOperationError("training_cannot_resume", "已结束的训练节目不能恢复，请建立新的配置。", 409);
      }
      const { decision, afterState } = this.decide(row, input);
      this.rejectIfInvalid(decision);
      const warnings: string[] = [];
      const beforeSummary = summarize(state, this.businessDate());
      // An unsupported custom distance cannot be represented by the legacy
      // mirror; clearing it is safer than leaving a stale old race visible to
      // old clients. The preview already explains the compatibility warning.
      const mirror = input.action === "clear_race_goal" || input.action === "set_race_goal"
        ? legacyRaceTargetMirror(afterState) : undefined;
      // PR4-4: one operation may publish configuration AND plan. The candidate was
      // generated outside this transaction for the configuration `planFor()` returned;
      // re-derive it here and verify the digest, so a concurrent edit cannot pair a
      // new goal with a plan generated for a different one.
      const publishesPlan = options.prepared !== undefined && afterState.runState === "active";
      let preparedDays: MobilePlannedDay[] | null = null;
      let preparedAudit: MobilePlanAudit | null = null;
      if (publishesPlan) {
        const prepared = options.prepared!;
        const contextDigest = trainingPlanContextDigest({
          raceGoal: afterState.raceGoal, runState: afterState.runState
        });
        if (afterState.planContextDigest !== contextDigest) {
          throw new PlanOperationError("training_snapshot_changed",
            "配置在生成期间变化，请重新生成；原计划保持不变。", 409);
        }
        if (options.fingerprint !== undefined && options.fingerprint() !== prepared.fingerprint) {
          throw new PlanOperationError("training_snapshot_changed",
            "训练事实在生成期间变化，请重新生成；原计划保持不变。", 409);
        }
        const goalsBefore = this.store.read();
        preparedDays = mergePlanWindow(goalsBefore.weekPlan, prepared.days, this.businessDate());
        preparedAudit = prepared.audit;
      }
      const goals = this.store.write({
        expectedRevision: this.store.read().revision,
        ...(afterState.runState === "paused" ? { lockedSession: null } : {}),
        ...(mirror === undefined ? {} : { raceTarget: mirror }),
        ...(publishesPlan && preparedDays !== null && preparedAudit !== null
          ? { weekPlan: preparedDays, weekPlanAudit: preparedAudit, weekPlanReplanRequired: false }
          : {
            // Until the unified refresh publishes a plan, the legacy generator must
            // not overwrite the window: it would be a second scheduler.
            weekPlanReplanRequired: true
          })
      }, publishesPlan && preparedAudit !== null
        ? { prescription: options.prepared!.prescription, confirmCoachPlan: true, runCoach: null } : { runCoach: null });
      const committed = this.store.commitTrainingPlanCommandState({
        scope: this.scopeKey(),
        expectedRevision: row.revision,
        state: {
          ...afterState,
          // Keep unified's migrated preference evidence even though the legacy
          // projection's programme was cleared above to revoke its authority.
          ...(mirror === undefined ? {} : { legacyRaceTarget: mirror }),
          ...(options.prepared?.coachReceipt === undefined ? {} : {
            coachLoop: this.publishCoachEvidence(request.operationId, goals.revision, options.prepared)
          }),
          ...(publishesPlan && preparedDays !== null
            ? { weekPlan: preparedDays, planContextDigest: afterState.planContextDigest } : {}),
          goalsRevision: goals.revision
        },
        eventType: `command:${request.action}`
      });
      const afterSummary = summarize({ ...afterState, goalsRevision: goals.revision }, this.businessDate());
      return {
        contractVersion: TRAINING_PLAN_CONTRACT_VERSION,
        operationId: request.operationId,
        stateRevision: committed.revision,
        goalsRevision: goals.revision,
        before: beforeSummary,
        after: afterSummary,
        changes: changeSet(beforeSummary, afterSummary, decision.goalIdentity),
        planRefreshRequired: !publishesPlan,
        plan: publishesPlan && preparedDays !== null && preparedAudit !== null
          ? { days: preparedDays, audit: preparedAudit,
            contextDigest: afterState.planContextDigest!, goalsRevision: goals.revision }
          : null,
        warnings
      };
    });
  }

  /**
   * PR4-3: publish a fresh plan for the current unified configuration.
   *
   * Generation happens outside the transaction; the commit re-checks the input
   * fingerprint and the state revision, then writes the legacy week plan, the
   * unified state and the history row in one publication transaction. A paused
   * configuration is refused: pause revokes execution, it does not silently draft.
   */
  async refresh(request: TrainingPlanRefreshRequest, deps: TrainingPlanRefreshDeps): Promise<TrainingPlanRefreshResponse> {
    requireContractTwo(request.contractVersion);
    requireOperationId(request.operationId);
    assertScope(request.operationScope, this.identity());
    // Retry of an already-committed refresh: answer the frozen result first, because
    // the state revision it expects is the one this operation itself advanced.
    const replayed = this.store.replayOperation<TrainingPlanRefreshResponse>(
      this.scopeKey(), request.operationId, "training-plan-refresh", request);
    if (replayed !== null) return replayed;
    const { row, state } = this.readState();
    if (state.runState !== "active") {
      throw new PlanOperationError("training_paused", "训练已暂停；恢复后才能生成新课表。", 409);
    }
    if (request.expectedStateRevision !== row.revision) {
      throw new PlanOperationError("training_revision_conflict",
        `训练状态已更新（当前 revision ${row.revision}），请重新读取。`, 409);
    }
    const prepared = await deps.prepare(state);
    return this.publication().publish("training-plan-refresh", request, () => {
      const current = this.readState();
      if (current.row.revision !== request.expectedStateRevision) {
        throw new PlanOperationError("training_revision_conflict",
          `训练状态已更新（当前 revision ${current.row.revision}），请重新读取。`, 409);
      }
      if (current.state.runState !== "active") {
        throw new PlanOperationError("training_paused", "训练已暂停；恢复后才能生成新课表。", 409);
      }
      if (deps.fingerprint() !== prepared.fingerprint) {
        throw new PlanOperationError("training_snapshot_changed",
          "训练事实在生成期间变化，请重新生成；原计划保持不变。", 409);
      }
      const contextDigest = trainingPlanContextDigest({
        raceGoal: current.state.raceGoal, runState: current.state.runState
      });
      if (current.state.planContextDigest !== null && current.state.planContextDigest !== contextDigest) {
        throw new PlanOperationError("training_snapshot_changed",
          "配置在生成期间变化，请重新生成；原计划保持不变。", 409);
      }
      const goals = this.store.read();
      const mirror = legacyRaceTargetMirror(current.state);
      // Today's finished/locked day and the current natural week's earlier days stay
      // stored: the generator only owns the seven-day window from today.
      const weekPlan = mergePlanWindow(goals.weekPlan, prepared.days, this.businessDate());
      const written = this.store.write({
        expectedRevision: goals.revision,
        weekPlan,
        weekPlanAudit: prepared.audit,
        ...(mirror === undefined ? {} : { raceTarget: mirror }),
        weekPlanReplanRequired: false
      }, { prescription: prepared.prescription, confirmCoachPlan: true, runCoach: null });
      const committed = this.store.commitTrainingPlanCommandState({
        scope: this.scopeKey(),
        expectedRevision: current.row.revision,
        state: {
          ...current.state,
          ...(prepared.coachReceipt === undefined ? {} : {
            coachLoop: this.publishCoachEvidence(request.operationId, written.revision, prepared)
          }),
          weekPlan,
          planContextDigest: contextDigest,
          goalsRevision: written.revision
        },
        eventType: "command:refresh"
      });
      return {
        contractVersion: TRAINING_PLAN_CONTRACT_VERSION,
        operationId: request.operationId,
        stateRevision: committed.revision,
        goalsRevision: written.revision,
        plan: { days: weekPlan, audit: prepared.audit, current: true, contextDigest },
        warnings: prepared.warnings
      };
    });
  }

  private candidateExpiry(candidateId: string): string | null {
    // The digest is hex (no colons), so the FIRST colon separates it from the ISO
    // timestamp; splitting on the last one would cut inside the time itself.
    const separator = candidateId.indexOf(":");
    if (separator <= 0) return null;
    const expiresAt = candidateId.slice(separator + 1);
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed) || parsed <= this.now()) return null;
    return expiresAt;
  }

  replayRefresh(request: TrainingPlanRefreshRequest): TrainingPlanRefreshResponse | null {
    requireContractTwo(request.contractVersion);
    requireOperationId(request.operationId);
    assertScope(request.operationScope, this.identity());
    return this.store.replayOperation<TrainingPlanRefreshResponse>(this.scopeKey(), request.operationId, "training-plan-refresh", request);
  }

  private publishCoachEvidence(operationId: string, goalsRevision: number, prepared: PreparedTrainingPlan): TrainingPlanState["coachLoop"] {
    const receipt = prepared.coachReceipt!;
    this.store.appendCoachLoopReceipt(JSON.stringify(this.identity()), operationId, { ...receipt, goalsRevision });
    return { operationId, policyHash: receipt.policyHash, evaluatedAt: receipt.evaluatedAt };
  }
}

export interface PreparedTrainingPlan {
  coachReceipt?: Omit<import("./coach-loop-runtime.js").CoachRuntimeReceipt, "goalsRevision">;
  days: MobilePlannedDay[];
  audit: MobilePlanAudit;
  warnings: string[];
  prescription: CoachZonePrescription | null;
  /** Digest of the read inputs the plan was generated from (facts + goals + zones). */
  fingerprint: string;
}

/**
 * PR4-3 reading side: the candidate plan is generated **outside** the control write
 * transaction (plan §8.1: do not hold the SQLite write lock through a candidate
 * search), then the commit re-verifies the same fingerprint and the same state
 * revision. A fact import or a concurrent command between generation and commit is
 * a 409, never a silently stale plan.
 */
export interface TrainingPlanRefreshDeps {
  prepare: (state: TrainingPlanState) => Promise<PreparedTrainingPlan>;
  fingerprint: () => string;
}

/**
 * Redacted form of an internal error for the server log.
 *
 * The raw `Error.message` may carry an absolute database path, a SQLite
 * diagnostic or a token pasted into a connection string. The wire never sees
 * it; the log should not either. Keep the error type/code (useful for triage)
 * and a message with paths/credentials replaced.
 */
export function internalErrorLogDetail(error: unknown): { name: string; code?: string; message: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const rawCode = (error as { code?: unknown } | null)?.code;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage
    .replace(/(?:\/Users|\/home|\/var|\/tmp|\/private|[A-Za-z]:\\)[^\s"']*/g, "<path>")
    .replace(/\b(token|secret|password|authorization)\s*[=:]\s*\S+/gi, "$1=<redacted>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>");
  return { name, ...(typeof rawCode === "string" ? { code: rawCode } : {}), message };
}

/**
 * HTTP-facing facade: one entry point per operation, with explicit error mapping.
 *
 * 2026-10-21 (PR-01): unknown exceptions used to reach the wire verbatim. That
 * leaked internal paths, SQLite messages and anything else an Error message may
 * carry (probe E-06). The rule is now a whitelist:
 *
 * - `PlanOperationError` is a deliberate business rejection; its stable
 *   `code`/`message` are the contract and stay unchanged;
 * - a unified-state CAS conflict is a known concurrency outcome (the English
 *   store message names an internal revision, so it is replaced by a stable,
 *   user-facing sentence);
 * - a `TrainingPlanStateError` is an internal store failure; only its code is
 *   stable, never its message;
 * - anything else is an unexpected 500 with one fixed message.
 *
 * The original error is handed to `report` for a sanitized, requestId-linked
 * server log. Nothing from that callback is serialized to the client.
 */
export interface TrainingPlanCommandErrorContext {
  requestId?: string;
  /** Internal-detail sink (server log). Must never write to the HTTP response. */
  report?: (detail: { error: unknown; requestId?: string }) => void;
}

export function trainingPlanCommandError(
  error: unknown,
  context: TrainingPlanCommandErrorContext = {}
): { statusCode: number; code: string; message: string } {
  if (error instanceof PlanOperationError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  if (error instanceof MutationConflictError) {
    return { statusCode: 409, code: error.code, message: error.message };
  }
  if (error instanceof TrainingPlanStateConflictError) {
    return {
      statusCode: 409,
      code: "training_revision_conflict",
      message: "训练状态已更新，请重新读取并重新预览；不会自动提升 expectedRevision。"
    };
  }
  if (error instanceof TrainingPlanStateError) {
    context.report?.({ error, ...(context.requestId === undefined ? {} : { requestId: context.requestId }) });
    return { statusCode: 503, code: "training_plan_state_invalid",
      message: "统一训练状态暂不可读，请稍后重试；请勿重复提交。" };
  }
  context.report?.({ error, ...(context.requestId === undefined ? {} : { requestId: context.requestId }) });
  return { statusCode: 500, code: "training_plan_command_failed",
    message: "训练命令处理失败，请稍后重试；原计划保持不变。" };
}
