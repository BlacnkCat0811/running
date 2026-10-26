import type {
  TrainingPlanAdmissionState,
  TrainingPlanCommandPreviewRequest,
  TrainingPlanCommandRequest,
  TrainingPlanRaceGoalView,
  TrainingPlanScope,
  TrainingPlanSessionExecution,
  TrainingPlanStateResponseV2,
  TrainingPlanUpdateView
} from "@rai/api-contracts";
import { TRAINING_PLAN_CONTRACT_VERSION } from "@rai/api-contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

import { shiftCoachDate } from "./coach-loop-facts.js";
import {
  internalErrorLogDetail,
  trainingPlanCommandError,
  type PreparedTrainingPlan,
  type TrainingPlanCommandService
} from "./training-plan-commands.js";
import { isValidLocalDate } from "./local-date.js";
import { PlanOperationError } from "./plan-publication.js";
import {
  admissionStateFor,
  raceGoalSupport,
  resolveTrainingMode,
  trainingPlanContextDigest
} from "./training-mode-policy.js";
import type { TrainingPlanState, TrainingPlanStateRow } from "./training-plan-store.js";

/**
 * PR4-1: the negotiated unified read.
 *
 * Scope of this slice, deliberately narrow:
 * - one read-only endpoint (`GET /v1/mobile/training-plan-state`) that answers the
 *   migrated unified state when the client sends `X-RAI-Training-Contract: 2`;
 * - every other request keeps the existing v1 payload, byte for byte;
 * - no migration, no publication, no coordinator, no command reducer. The response
 *   therefore carries `execution.permitted: false`: a mode is not a permission and
 *   this slice has not evaluated facts freshness or device coordination yet.
 *
 * Version negotiation is explicit in both directions: an unknown version is a 409
 * `training_contract_unsupported`, never a silent downgrade to v1.
 */

export type RequestedTrainingPlanContract =
  | { version: 1; raw: null | "1" }
  | { version: 2; raw: "2" }
  | { version: "unsupported"; raw: string | null };

const WEEK_DAYS = 7;

/**
 * Parse the contract header. Absent/`1` keeps the legacy payload; `2` selects the
 * unified projection; anything else is rejected instead of guessed.
 */
export function requestedTrainingPlanContract(
  headers: Record<string, string | string[] | undefined>
): RequestedTrainingPlanContract {
  const value = headers["x-rai-training-contract"];
  const raw = Array.isArray(value) ? value.at(0) ?? null : value ?? null;
  if (raw === null || raw === "") return { version: 1, raw: null };
  const trimmed = raw.trim();
  if (trimmed === "1") return { version: 1, raw: "1" };
  if (trimmed === "2") return { version: 2, raw: "2" };
  return { version: "unsupported", raw };
}

export class TrainingPlanReadError extends Error {
  constructor(readonly code: string, readonly statusCode: 409 | 503, message: string) {
    super(message);
    this.name = "TrainingPlanReadError";
  }
}

/**
 * Build the v2 payload from a migrated state row.
 *
 * Throws `TrainingPlanReadError` when the stored payload cannot be trusted (the
 * store's parser already rejects unknown schema versions) — the route answers a
 * retryable failure rather than serving a mixed identity.
 */
export function buildTrainingPlanStateV2(input: {
  scope: TrainingPlanScope;
  businessDate: string;
  row: TrainingPlanStateRow;
  currentGoalsRevision: number;
  includeSessions?: boolean;
  /** Current execution links for this instance. Empty means "none", not unknown. */
  executions?: TrainingPlanSessionExecution[];
  /** B08 negotiated update stages. Absent unless the update header was negotiated. */
  update?: TrainingPlanUpdateView;
}): TrainingPlanStateResponseV2 {
  const state: TrainingPlanState = input.row.state;
  if (!isValidLocalDate(input.businessDate)) {
    throw new TrainingPlanReadError("training_plan_business_date_invalid", 503,
      "业务日期不可解析，不能生成统一快照。");
  }
  const mode = resolveTrainingMode({ raceGoal: state.raceGoal, businessDate: input.businessDate });
  const windowEnd = shiftCoachDate(input.businessDate, WEEK_DAYS - 1);
  // The stored weekly intent is the published plan for this slice; observation and
  // effective-execution live in the existing read models until PR4-2.
  const days = (state.weekPlan ?? [])
    .filter((day) => day.localDate >= input.businessDate && day.localDate <= windowEnd)
    .sort((left, right) => left.localDate.localeCompare(right.localDate));
  const admission: TrainingPlanAdmissionState = state.sourceStatus === "ended"
    ? "needs_confirmation"
    : admissionStateFor({ raceGoal: state.raceGoal, runState: state.runState, preferencesComplete: state.preferencesComplete });
  const raceGoal: TrainingPlanRaceGoalView | null = state.raceGoal === null ? null : {
    ...state.raceGoal,
    support: raceGoalSupport(state.raceGoal, input.businessDate)
  };
  return {
    contractVersion: TRAINING_PLAN_CONTRACT_VERSION,
    scope: input.scope,
    businessDate: input.businessDate,
    stateRevision: input.row.revision,
    migratedAt: state.migratedAt,
    migration: {
      version: state.migrationVersion,
      source: state.source,
      sourceStatus: state.sourceStatus,
      sourceDigest: state.sourceDigest
    },
    mode: mode.mode,
    modeReason: mode.reason,
    daysToRace: mode.daysToRace,
    runState: state.runState,
    admission,
    raceGoal,
    plan: {
      goalsRevision: state.goalsRevision,
      currentGoalsRevision: input.currentGoalsRevision,
      // PR4-2: configuration and plan are published in separate steps for now, so a
      // plan generated for an older configuration must read as NOT current. A legacy
      // migration carries no context digest and falls back to the revision check.
      current: state.goalsRevision === input.currentGoalsRevision &&
        (state.planContextDigest === null ||
          state.planContextDigest === trainingPlanContextDigest({ raceGoal: state.raceGoal, runState: state.runState })),
      days,
      lockedToday: state.lockedSession?.localDate === input.businessDate
    },
    execution: {
      permitted: false,
      reasonCodes: ["projection_only", "facts_freshness_not_evaluated", "device_coordination_not_evaluated"]
    },
    ...(input.includeSessions && state.schemaVersion === 2 ? { sessions: { contractVersion: 1 as const,
      planInstanceId: state.planInstanceId, sessions: state.sessions, suppressions: state.suppressions,
      publishedInputKey: state.publishedInputKey,
      ...(input.executions === undefined ? {} : { executions: input.executions }) } } : {}),
    ...(input.update === undefined ? {} : { update: input.update })
  };
}

export interface TrainingPlanStateRouteDeps {
  identity: () => TrainingPlanScope;
  /** Shanghai business date; the only clock a mode may be derived from. */
  businessDate: () => string;
  /** Canonical scope key → migrated row, or `null` when this scope is not migrated. */
  readUnifiedState: (scopeKey: string) => TrainingPlanStateRow | null;
  readGoalsRevision: () => number;
  /** B06: current execution links, read inside the same request as the sessions view. */
  readExecutions?: (scopeKey: string, planInstanceId: string) => TrainingPlanSessionExecution[];
  /** B08: negotiated four-stage update view; absence means "update read unsupported". */
  readUpdate?: (scopeKey: string, row: TrainingPlanStateRow) => TrainingPlanUpdateView;
  /** The unchanged v1 handler; used for every non-v2 request. */
  legacy: (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>;
}

/** Fastify handler factory: one route, two wire contracts, explicit negotiation. */
export function createTrainingPlanStateRoute(deps: TrainingPlanStateRouteDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    reply.header("Cache-Control", "no-store");
    const requested = requestedTrainingPlanContract(request.headers);
    if (requested.version === "unsupported") {
      reply.header("Vary", "X-RAI-Training-Contract");
      return reply.code(409).send({
        code: "training_contract_unsupported",
        message: `训练读合同只支持 1 或 ${TRAINING_PLAN_CONTRACT_VERSION}；收到 ${JSON.stringify(requested.raw)}。`
      });
    }
    if (requested.version === 1) {
      reply.header("Vary", "X-RAI-Training-Contract");
      return deps.legacy(request, reply);
    }
    // Every v2 representation depends on the presence/value of both optional
    // negotiation headers. Declaring all three once here prevents the old
    // sessions branch from overwriting a three-value Vary with two values and
    // lets a shared cache distinguish "no extension" from "extension asked".
    reply.header("Vary", "X-RAI-Training-Contract, X-RAI-Training-Sessions, X-RAI-Training-Updates");
    const scope = deps.identity();
    const scopeKey = JSON.stringify([scope.serverId, scope.athleteId, scope.datasetEpoch]);
    let row: TrainingPlanStateRow | null;
    try {
      row = deps.readUnifiedState(scopeKey);
    } catch {
      // A damaged/partial unified store cannot be read: retryable, never a fallback
      // to a different contract or a legacy projection.
      return reply.code(503).send({
        code: "training_plan_state_unavailable",
        message: "统一训练状态暂不可读，请重试；不会回退到旧合同。"
      });
    }
    if (row === null) {
      return reply.code(409).send({
        code: "training_plan_not_migrated",
        message: "该数据域尚未迁移到统一训练状态；请先按迁移方案完成 dry-run 与 apply。"
      });
    }
    const sessionsHeader = request.headers["x-rai-training-sessions"];
    const updatesHeader = request.headers["x-rai-training-updates"];
    if (updatesHeader !== undefined && updatesHeader !== "1") {
      return reply.code(409).send({ code: "training_update_contract_unsupported", message: "计划更新阶段读扩展版本不支持。" });
    }
    if (updatesHeader === "1" && (sessionsHeader !== "1" || row.state.schemaVersion !== 2 || deps.readUpdate === undefined)) {
      return reply.code(409).send({ code: "training_update_contract_unsupported", message: "计划更新阶段读扩展需要精确的课程读协商。" });
    }
    if (sessionsHeader !== undefined) {
      if (sessionsHeader !== "1" || row.state.schemaVersion !== 2) {
        return reply.code(409).send({ code: "training_session_contract_unsupported", message: "课程身份读扩展尚未迁移或版本不支持。" });
      }
    }
    try {
      return buildTrainingPlanStateV2({
        scope,
        businessDate: deps.businessDate(),
        row,
        currentGoalsRevision: deps.readGoalsRevision(),
        includeSessions: sessionsHeader === "1",
        ...(sessionsHeader === "1" && deps.readExecutions && row.state.schemaVersion === 2
          ? { executions: deps.readExecutions(scopeKey, row.state.planInstanceId) } : {}),
        ...(updatesHeader === "1" && deps.readUpdate ? { update: deps.readUpdate(scopeKey, row) } : {})
      });
    } catch (error) {
      // Known projection rejections carry a deliberate, user-facing message.
      // Anything else is an internal failure: its message may name SQLite
      // details, file paths or payload internals, so it stays in the log only.
      if (error instanceof TrainingPlanReadError) {
        return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      }
      request.log.error({ error: internalErrorLogDetail(error), requestId: request.id }, "training plan v2 read failed");
      return reply.code(503).send({
        code: "training_plan_state_invalid",
        message: "统一训练状态暂不可读，请稍后重试；不会回退到旧合同。"
      });
    }
  };
}

// ---------------------------------------------------------------------------
// PR4-2 command routes
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function commandRequestError(message: string): PlanOperationError {
  return new PlanOperationError("training_command_invalid", message, 422);
}

/**
 * Preview and submit share one shape check: both must carry a v2 contract and the
 * exact operation scope. Shape errors are 422 before any state is read.
 */
function parseCommandBody<T extends { operationScope?: unknown; action?: unknown }>(body: unknown): T {
  if (!isRecord(body)) throw commandRequestError("命令体必须是 JSON 对象。");
  if (!isRecord(body.operationScope)) throw commandRequestError("operationScope 必须声明服务、运动员与数据集。");
  if (!["set_race_goal", "clear_race_goal", "pause", "resume"].includes(body.action as string)) {
    throw commandRequestError("action 必须是 set_race_goal/clear_race_goal/pause/resume。");
  }
  return body as T;
}

export interface TrainingPlanPlanDeps {
  prepare: (state: import("./training-plan-store.js").TrainingPlanState) => Promise<PreparedTrainingPlan>;
  fingerprint: () => string;
}

export function createTrainingPlanCommandHandlers(service: TrainingPlanCommandService, planDeps?: TrainingPlanPlanDeps,
  admit: (request: FastifyRequest) => void = () => {},
  withGenerationLease: <T>(fn: () => Promise<T>) => Promise<T> = fn => fn()) {
  /** One place that both logs internal detail and keeps the wire answer fixed. */
  const errorContext = (request: FastifyRequest) => ({
    requestId: request.id,
    report: (detail: { error: unknown; requestId?: string }) =>
      request.log.error({ error: internalErrorLogDetail(detail.error), requestId: detail.requestId },
        "training plan command failed")
  });
  return {
    preview: async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        const body = parseCommandBody<TrainingPlanCommandPreviewRequest>(request.body);
        admit(request);
        return service.preview(body);
      } catch (error) {
        const mapped = error instanceof Error && error.message.includes("必须") && !(error as { statusCode?: number }).statusCode
          ? commandRequestError(error.message) : trainingPlanCommandError(error, errorContext(request));
        return reply.code(mapped.statusCode).send({ code: mapped.code, message: mapped.message });
      }
    },
    submit: async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        const body = parseCommandBody<TrainingPlanCommandRequest>(request.body);
        const replayed = service.replayCommand(body);
        if (replayed !== null) return replayed;
        admit(request);
        // PR4-4: configuration and plan publish in ONE operation. The candidate is
        // generated outside the control transaction (plan §8.1) for the exact next
        // configuration; `submit` re-derives it and verifies the configuration
        // digest before the atomic write. A pause publishes no plan.
        if (planDeps !== undefined && body.action !== "pause") {
          const next = service.planFor(body);
          // A paused/ended programme publishes no plan; preparing a candidate would
          // consume facts and could reject a valid configuration command for a
          // preference that is not going to be used.
          if (next.afterState.runState !== "active") return service.submit(body);
          // Generation reads the main DB; hold the same lease as legacy main-DB
          // writers so a zones/profile write cannot commit between generation and
          // the fingerprint re-check unnoticed.
          return await withGenerationLease(async () => {
            const prepared = await planDeps.prepare(next.afterState);
            return service.submit(body, { prepared, fingerprint: planDeps.fingerprint });
          });
        }
        return service.submit(body);
      } catch (error) {
        const mapped = error instanceof Error && error.message.includes("必须") && !(error as { statusCode?: number }).statusCode
          ? commandRequestError(error.message) : trainingPlanCommandError(error, errorContext(request));
        return reply.code(mapped.statusCode).send({ code: mapped.code, message: mapped.message });
      }
    }
  };
}
