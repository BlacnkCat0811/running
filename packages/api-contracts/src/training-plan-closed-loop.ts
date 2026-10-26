/**
 * B01 / G0 wire freeze. These declarations do not advertise capabilities or mount
 * routes. Runtime storage, validation and commands ship in B02–B08, in order.
 * Product V2, HTTP /v1, unified read 2 and these extension versions are independent.
 */
import type {
  HandshakeResponse, MobilePlannedDay, MobileSessionKind, MobileSessionStructure,
  TrainingPlanScope, WorkoutExecutionAssessment
} from "./index.js";

export const TRAINING_PLAN_CLOSED_LOOP_CONTRACT = {
  sessions: { version: 1, capability: "trainingPlanSessionContractVersion", header: "X-RAI-Training-Sessions" },
  sessionCommands: { version: 1, capability: "trainingPlanSessionCommandContractVersion", header: "X-RAI-Client-Training-Session-Commands" },
  sessionDistanceOmission: { version: 1, capability: "trainingPlanSessionDistanceOmissionContractVersion", header: "X-RAI-Client-Training-Session-Distance-Omission" },
  executionCommands: { version: 1, capability: "trainingPlanExecutionCommandContractVersion", header: "X-RAI-Client-Training-Execution-Commands" },
  updates: { version: 1, capability: "trainingPlanUpdateContractVersion", header: "X-RAI-Training-Updates" },
  routes: {
    sessionPreview: { method: "POST", path: "/v1/mobile/training-plan/session-commands/preview" },
    sessionSubmit: { method: "POST", path: "/v1/mobile/training-plan/session-commands" },
    executionCandidates: { method: "GET", path: "/v1/mobile/training-plan/sessions/:sessionId/execution-candidates" },
    executionSubmit: { method: "POST", path: "/v1/mobile/training-plan/execution-commands" }
  },
  previewTTLSeconds: 120,
  candidateDaysBefore: 2,
  candidateDaysAfter: 2,
  candidateMaxRangeDays: 31,
  candidatePageSize: 50
} as const;

/** A version match is necessary, never sufficient for scope/freshness/permission. */
export function trainingPlanClosedLoopSupport(handshake: HandshakeResponse) {
  const sessions = handshake.syncProtocolVersion === 1 && handshake.apiVersion === "v1" &&
    handshake.trainingPlanContractVersion === 2 && handshake.trainingPlanSessionContractVersion === 1;
  const durable = sessions && handshake.planPublicationContractVersion === 1;
  return {
    sessions,
    sessionCommands: durable && handshake.trainingPlanSessionCommandContractVersion === 1,
    executionCommands: durable && handshake.trainingPlanExecutionCommandContractVersion === 1,
    updates: sessions && handshake.trainingPlanUpdateContractVersion === 1
  };
}

export type TrainingPlanSessionLifecycle = "pending" | "completed" | "partial" | "skipped" | "cancelled";
export type TrainingPlanSessionProtection = "automatic" | "user_protected";
export type TrainingPlanAssociationStatus = "unlinked" | "pending_confirmation" | "confirmed" | "invalidated";

export interface TrainingPlanSession {
  planInstanceId: string;
  sessionId: string;
  sessionRevision: number;
  /** Effective intent; never an execution grant. Legacy null structure is readable. */
  prescription: MobilePlannedDay;
  recommendation: { prescription: MobilePlannedDay; source: string; policyHash: string | null } | null;
  /** Complete effective prescription, not a competing plan. */
  userOverride: { action: TrainingPlanSessionDraft["action"]; prescription: MobilePlannedDay; availableAt: string } | null;
  protection: TrainingPlanSessionProtection;
  lifecycle: TrainingPlanSessionLifecycle;
  availableAt: string;
  supersededBySessionId: string | null;
}

export interface TrainingPlanSuppression {
  localDate: string;
  reason: "moved" | "cancelled" | "explicit_rest";
  sessionId: string | null;
  availableAt: string;
}

/** Optional top-level `sessions` on unified read 2, only after exact negotiation. */
export interface TrainingPlanSessionsView {
  contractVersion: 1;
  planInstanceId: string;
  sessions: TrainingPlanSession[];
  suppressions: TrainingPlanSuppression[];
  publishedInputKey: string | null;
  /** Absent until execution reads ship; absent is unknown, not an empty history. */
  executions?: TrainingPlanSessionExecution[];
}

/** Omission keeps a field, except distance is remeasured when kind/structure changes.
 * reason:null clears it. Structure targets clear via alert:null. */
export interface TrainingPlanSessionPatch {
  kind?: Exclude<MobileSessionKind, "rest">;
  distanceKm?: number | null;
  structure?: MobileSessionStructure;
  reason?: string | null;
}

type ExistingSession = { sessionId: string; sessionRevision: number };
export type TrainingPlanSessionDraft =
  | (ExistingSession & { action: "move"; localDate: string })
  | (ExistingSession & { action: "edit"; patch: TrainingPlanSessionPatch })
  | { action: "add"; prescription: Omit<MobilePlannedDay, "kind" | "structure" | "distanceKm"> & {
      kind: Exclude<MobileSessionKind, "rest">; structure: MobileSessionStructure;
      /** Omitted: server derives distance (null for pure time). Explicit values are checked. */
      distanceKm?: number | null } }
  | (ExistingSession & { action: "cancel" })
  | { action: "set_rest"; localDate: string }
  | (ExistingSession & { action: "unlock" });

export interface TrainingPlanSessionPreviewRequest {
  contractVersion: 1;
  operationScope: TrainingPlanScope;
  expectedStateRevision: number;
  planInstanceId: string;
  draft: TrainingPlanSessionDraft;
}

export interface TrainingPlanSessionImpact {
  before: TrainingPlanSession | null;
  after: TrainingPlanSession | null;
  suppressions: TrainingPlanSuppression[];
  affectedDates: string[];
  deviceWithdrawalRequired: boolean;
  warnings: string[];
}

export interface TrainingPlanSessionPreviewResponse extends TrainingPlanSessionPreviewRequest {
  candidateId: string;
  expiresAt: string;
  inputKey: string;
  impact: TrainingPlanSessionImpact;
}

/** Same draft and versions as preview. New IDs for add are allocated by the server. */
export interface TrainingPlanSessionCommandRequest extends TrainingPlanSessionPreviewRequest {
  operationId: string;
  candidateId: string;
}

export interface TrainingPlanExecutionCandidate {
  trainingSessionId: string;
  sourceFactDigest: string;
  startedAt: string;
  endedAt: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  evidence: "verified_identity" | "needs_confirmation";
}

export interface TrainingPlanExecutionCandidatesResponse {
  contractVersion: 1;
  scope: TrainingPlanScope;
  stateRevision: number;
  planInstanceId: string;
  sessionId: string;
  sessionRevision: number;
  executionRevision: number;
  rangeStart: string;
  rangeEnd: string;
  candidates: TrainingPlanExecutionCandidate[];
  nextCursor: string | null;
}

/** 0 means no current execution row yet. Correct replaces the prior link atomically. */
export type TrainingPlanExecutionDraft =
  | { action: "confirm" | "correct"; trainingSessionId: string; sourceFactDigest: string }
  | { action: "retract"; trainingSessionId: string; sourceFactDigest: string }
  | { action: "skip"; reason: string };

export interface TrainingPlanExecutionCommandRequest {
  contractVersion: 1;
  operationId: string;
  operationScope: TrainingPlanScope;
  expectedStateRevision: number;
  planInstanceId: string;
  sessionId: string;
  sessionRevision: number;
  executionRevision: number;
  draft: TrainingPlanExecutionDraft;
}

export interface TrainingPlanSessionExecution {
  sessionId: string;
  executionRevision: number;
  association: TrainingPlanAssociationStatus;
  trainingSessionId: string | null;
  sourceFactDigest: string | null;
  prescriptionSessionRevision: number;
  assessment: WorkoutExecutionAssessment | null;
  availableAt: string;
  reasonCodes: string[];
}

export interface TrainingPlanClosedLoopCommandResponse {
  contractVersion: 1;
  operationId: string;
  stateRevision: number;
  goalsRevision: number | null;
  planInstanceId: string;
  outcome: "changed" | "no_change";
  session: TrainingPlanSession | null;
  execution: TrainingPlanSessionExecution | null;
  planUpdate: "pending" | "current" | "blocked";
  warnings: string[];
}

/** Optional top-level `update` on unified read 2. Each stage has its own evidence. */
export interface TrainingPlanUpdateView {
  contractVersion: 1;
  facts: { status: "pending" | "stored" | "failed"; identity: string | null };
  analysis: { status: "pending" | "ready" | "failed"; identity: string | null };
  association: { status: "pending" | "current" | "blocked"; identity: string | null };
  plan: {
    status: "pending" | "current" | "blocked";
    desiredInputKey: string | null;
    publishedInputKey: string | null;
    evaluatedInputKey: string | null;
    evaluatedStateRevision: number | null;
    reasonCodes: string[];
  };
}

/** New route errors only; existing command/operation error meanings stay intact. */
export const TRAINING_PLAN_CLOSED_LOOP_ERRORS = {
  training_session_contract_unsupported: 409,
  training_update_contract_unsupported: 409,
  training_session_contract_required: 422,
  training_session_commands_disabled: 409,
  training_execution_commands_disabled: 409,
  training_execution_not_active: 409,
  training_session_command_invalid: 422,
  training_scope_mismatch: 409,
  training_plan_instance_mismatch: 409,
  training_state_revision_conflict: 409,
  training_session_revision_conflict: 409,
  training_execution_revision_conflict: 409,
  training_session_candidate_expired: 409,
  training_session_candidate_mismatch: 409,
  training_session_date_occupied: 409,
  training_session_not_editable: 409,
  training_session_not_found: 404,
  training_execution_source_changed: 409,
  training_execution_candidates_present: 409,
  training_execution_link_conflict: 409,
  training_session_safety_rejected: 422,
  training_session_storage_unavailable: 503
} as const;
