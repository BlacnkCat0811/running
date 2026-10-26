import type { TrainingPlanSessionExecution } from "@rai/api-contracts";
import { digest } from "./plan-digest.js";
import type { TrainingPlanState } from "./training-plan-store.js";
import type { TrainingPlanScope } from "@rai/api-contracts";

/**
 * B08 desired-input identity.
 *
 * The key answers "which inputs would the next plan be generated from". It
 * deliberately excludes:
 * - the wall clock / evaluation time;
 * - the output `stateRevision` / `goalsRevision`;
 * - generated automatic prescriptions and their session IDs (those are output).
 *
 * It includes only decisions the algorithm consumes: recent running facts, the
 * published analysis release, configuration/preferences, user-protected
 * courses and suppressions, execution associations, and the policy identity.
 * A record-only import that leaves those unchanged therefore does not force a
 * whole-plan regeneration, while a corrected run or a new analysis release does.
 */
export const TRAINING_PLAN_INPUT_CONTRACT = "rai-training-plan-input-v1";
export const TRAINING_PLAN_FACTS_LOOKBACK_DAYS = 28;
export const TRAINING_PLAN_FACTS_LOOKAHEAD_DAYS = 7;

export interface TrainingPlanInputFact {
  trainingSessionId: string;
  startedAt: string;
  endedAt: string;
  distanceMeters: number | null;
  durationSeconds: number | null;
  /**
   * Storage bookkeeping only. `canonicalizeRunningWorkouts` may rewrite this
   * column for an otherwise unchanged fact, so it must never enter an input
   * key. Kept on the read model for diagnostics and compatibility; it is not
   * semantic fact content.
   */
  updatedAt: string;
}

export interface TrainingPlanAnalysisIdentity {
  releaseId: string | null;
  analysisStatus: string;
  /**
   * Raw import generation. It advances for every batch (including record-only
   * batches) and is exposed only for the update view; it is not content
   * identity and is deliberately omitted from the desired input key.
   */
  factsGeneration: string | null;
  /** Analysis dependency generation; changes only when this batch affects analysis input. */
  dependencyGeneration: string | null;
}

/** Digest the semantic fact content only; storage timestamps and batch counters are not inputs. */
export function trainingPlanFactsDigest(facts: readonly TrainingPlanInputFact[]): string {
  return digest([...facts].sort((left, right) => left.startedAt.localeCompare(right.startedAt) ||
    left.trainingSessionId.localeCompare(right.trainingSessionId))
    .map(fact => ({ id: fact.trainingSessionId, start: fact.startedAt, end: fact.endedAt,
      meters: fact.distanceMeters, seconds: fact.durationSeconds })));
}

/**
 * The analysis fields the generator actually consumes. `releaseId` identifies
 * the published artifact; `dependencyGeneration` identifies the analysis-input
 * generation it belongs to. `factsGeneration` is the raw batch counter and is
 * intentionally excluded.
 *
 * The read view reports `dependencyGeneration:null` while generation counters
 * are absent and `"0"` once a record-only batch has materialized the zero
 * dependency. Both mean "no analysis dependency" and must not change the key.
 */
function trainingPlanAnalysisInputIdentity(analysis: TrainingPlanAnalysisIdentity): {
  releaseId: string | null; analysisStatus: string; dependencyGeneration: string;
} {
  return { releaseId: analysis.releaseId, analysisStatus: analysis.analysisStatus,
    dependencyGeneration: analysis.dependencyGeneration ?? "0" };
}

/** Configuration the generator actually consumes; `evaluatedAt` is an output clock. */
export function trainingPlanConfigDigest(state: TrainingPlanState): string {
  const runCoach = state.runCoach as Record<string, unknown> | null;
  return digest({
    raceGoal: state.raceGoal,
    sourceStatus: state.sourceStatus,
    runState: state.runState,
    preferencesComplete: state.preferencesComplete,
    coachLoop: state.coachLoop === null ? null : { policyHash: state.coachLoop.policyHash },
    runCoach: runCoach === null ? null : {
      goal: runCoach.goal ?? null, raceDate: runCoach.raceDate ?? null, raceDistanceKm: runCoach.raceDistanceKm ?? null,
      targetTimeSeconds: runCoach.targetTimeSeconds ?? null, runningDays: runCoach.runningDays ?? null,
      longRunDays: runCoach.longRunDays ?? null, targetType: runCoach.targetType ?? null,
      strengthTraining: runCoach.strengthTraining ?? null, status: runCoach.status ?? null
    }
  });
}

/**
 * User decisions that must survive a regeneration. Automatic pending
 * prescriptions are output and are intentionally absent; protected courses,
 * completed lifecycles and suppressions are decisions.
 */
export function trainingPlanOverridesDigest(state: TrainingPlanState): string {
  if (state.schemaVersion !== 2) return digest({ legacy: true });
  // Automatic pending courses are generator output; their IDs and prescriptions
  // must not feed back into the next input (that would make every refresh look
  // like a new input forever). Protected or non-pending courses are decisions.
  const sessions = state.sessions.filter(session => session.protection === "user_protected" ||
    session.lifecycle !== "pending").map(session => ({
    sessionId: session.sessionId,
    protection: session.protection,
    lifecycle: session.lifecycle,
    localDate: session.prescription.localDate,
    ...(session.protection === "user_protected" ? {
      prescription: session.prescription,
      userOverride: session.userOverride === null ? null : { action: session.userOverride.action,
        prescription: session.userOverride.prescription }
    } : {})
  })).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  return digest({ sessions, suppressions: [...state.suppressions].sort((left, right) =>
    left.localDate.localeCompare(right.localDate) || (left.sessionId ?? "").localeCompare(right.sessionId ?? "")),
    lockedSession: state.lockedSession });
}

export function trainingPlanExecutionDigest(executions: readonly TrainingPlanSessionExecution[]): string {
  return digest([...executions].map(row => ({ sessionId: row.sessionId, revision: row.executionRevision,
    association: row.association, trainingSessionId: row.trainingSessionId,
    sourceFactDigest: row.sourceFactDigest, prescriptionRevision: row.prescriptionSessionRevision }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId)));
}

export function trainingPlanDesiredInputKey(input: {
  scope: TrainingPlanScope;
  businessDate: string;
  facts: readonly TrainingPlanInputFact[];
  analysis: TrainingPlanAnalysisIdentity;
  configDigest: string;
  overridesDigest: string;
  executionDigest: string;
  policyHash: string | null;
}): string {
  return digest({ contract: TRAINING_PLAN_INPUT_CONTRACT,
    scope: { serverId: input.scope.serverId, athleteId: input.scope.athleteId, datasetEpoch: input.scope.datasetEpoch },
    businessDate: input.businessDate, facts: trainingPlanFactsDigest(input.facts),
    analysis: trainingPlanAnalysisInputIdentity(input.analysis), config: input.configDigest,
    overrides: input.overridesDigest,
    executions: input.executionDigest, policyHash: input.policyHash });
}

/**
 * Ready means the analysis side has caught up with the required facts. A null
 * release is legitimate when no scoring release was required (required === 0);
 * it is not the same as "never published", which reports queued/running/failed.
 */
export function trainingPlanAnalysisReady(analysis: TrainingPlanAnalysisIdentity): boolean {
  return analysis.analysisStatus === "published";
}
