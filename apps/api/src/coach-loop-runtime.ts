import type {
  CoachCapacityAnchor, CoachLoopCommand, CoachLoopRuntimeResponse, CoachLoopSettings, CoachPolicyManifest,
  MobileGoalsResponse, MobilePlanOperationScope, MobilePlannedDay, MobileSessionKind, CoachLoopDeviceReceipt
} from "@rai/api-contracts";
import type { RaiReadStore } from "./data.js";
import { MobileGoalsRevisionConflictError, planDayWithLock, type MobileGoalsStore, type PlanHistoryRevision } from "./mobile-goals.js";
import { PlanOperationError, PlanPublicationService } from "./plan-publication.js";
import { buildCoachLoopCandidate, type CoachLoopDecisionInput } from "./coach-loop-decision.js";
import { buildCoachCapacityAnchor, coachCapacityEnvelope } from "./weekly-capacity.js";
import { COACH_POLICY_MANIFEST, coachReason } from "./coach-loop-policy.js";
import { coachLocalDate, shiftCoachDate, visibleCoachRuns, type CoachReservation } from "./coach-loop-facts.js";
import { effectiveSubjectiveFeedback } from "./coach-subjective-feedback.js";
import { assessSessionDose } from "./coach-session-dose.js";
import { coachTemplateCandidates, templateDay, COACH_TEMPLATE_LIBRARY_VERSION } from "./coach-template-library.js";
import { repairCoachPlan, type CoachRepairDay } from "./coach-plan-repair.js";
import { currentPeriodizationWeek, periodizationWeekStart } from "./plan-periodization.js";
import { executionPolicyContext, raceExecutionProtection } from "./race-plan-policy.js";
import { runCoachRaceTarget, runCoachSessionTargets, runCoachWeekday, validateRunCoachConfig } from "./run-coach-policy.js";
import { digest, prescriptionDigest } from "./plan-digest.js";
import { planReadGuard, readStableSnapshot, type PublicationGuardCapableStore } from "./plan-read-consistency.js";
import { coachGoalGap } from "./coach-goal-gap.js";
import { recordCoachLoopDeviceReceipt } from "./coach-loop-device-sync.js";
import { normalizeSessionStructure } from "./session-structure.js";
import { plannedDayNumbers } from "./mobile-coach.js";
import { DATABASE_TIMEZONE } from "@rai/contracts";

/** Explicit version negotiation + per-user acceptance. No environment activation. */
export const COACH_RUNTIME_MANIFEST: CoachPolicyManifest = { ...COACH_POLICY_MANIFEST,
  contractVersion: 2, trainingModeVersion: "rai-coach-runtime-mode-v1",
  adaptationVersion: "rai-coach-runtime-repair-v2", templateLibraryVersion: COACH_TEMPLATE_LIBRARY_VERSION };
export const COACH_RUNTIME_POLICY_HASH = digest(COACH_RUNTIME_MANIFEST);
export type CoachRuntimeFacts = ReturnType<RaiReadStore["coachLoopFacts"]>;
export interface CoachRuntimeReceipt {
  settings: CoachLoopSettings;
  policyHash: string;
  policyManifest: CoachPolicyManifest;
  factsHash: string;
  inputDigest: string;
  effectiveDigest: string;
  anchor: CoachCapacityAnchor;
  reservations: Array<CoachReservation & { prescriptionDigest: string; decisionRef: string }>;
  templateIds: Record<string, string>;
  goalsRevision: number;
  evaluatedAt: string;
  result: "no_change" | "patched";
  changes: Array<{ date: string; before: string | null; after: string; reason: string }>;
  volumePolicy: CoachLoopRuntimeResponse["volumePolicy"];
}
const rest = (date: string, reason: string): MobilePlannedDay => ({
  localDate: date, kind: "rest", structure: null, distanceKm: null, reason
});
const key = (day: MobilePlannedDay) => prescriptionDigest(day.kind, day.structure ?? null);
const weekEnd = (date: string) => shiftCoachDate(periodizationWeekStart(date), 6);
const quality = (day: MobilePlannedDay) => day.kind === "tempo" || day.kind === "interval";

export function validateCoachLoopSettings(settings: Omit<CoachLoopSettings, "status">, date: string,
  creatingRace: boolean): void {
  const fail = () => { throw new PlanOperationError("coach_settings_invalid", "训练模式或偏好无效。", 422); };
  const keys = ["mode", "runningDays", "longRunDays", "availabilityMinutesByWeekday", "targetType", "race"];
  if (!settings || Object.keys(settings).some(k => !keys.includes(k)) ||
    !["daily_adaptive", "race_preparation"].includes(settings.mode) || !["pace", "heart_rate"].includes(settings.targetType)) fail();
  const days = (list: number[], empty: boolean) => Array.isArray(list) && (empty || list.length > 0) &&
    new Set(list).size === list.length && list.every(d => Number.isInteger(d) && d >= 1 && d <= 7);
  if (!days(settings.runningDays, false) || !days(settings.longRunDays, true) ||
    settings.longRunDays.some(d => !settings.runningDays.includes(d)) || !settings.availabilityMinutesByWeekday ||
    typeof settings.availabilityMinutesByWeekday !== "object" || Array.isArray(settings.availabilityMinutesByWeekday)) fail();
  for (const [day, minutes] of Object.entries(settings.availabilityMinutesByWeekday))
    if (!/^[1-7]$/.test(day) || minutes !== null && (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 10 || minutes > 240)) fail();
  if (settings.mode === "daily_adaptive") { if (settings.race !== null) fail(); }
  else {
    if (!settings.race || settings.race.goal === "fitness") fail();
    validateRunCoachConfig(settings.race!, date, creatingRace);
    if (digest(settings.race!.runningDays) !== digest(settings.runningDays) ||
      digest(settings.race!.longRunDays) !== digest(settings.longRunDays) ||
      settings.race!.targetType !== settings.targetType) fail();
  }
}

export class CoachLoopRuntime {
  constructor(private readonly store: MobileGoalsStore, private readonly identity: () => MobilePlanOperationScope,
    private readonly readFacts: (goals: MobileGoalsResponse, history: PlanHistoryRevision[]) => CoachRuntimeFacts,
    private readonly publicationReady: () => boolean = () => true) {}
  private scope() { return JSON.stringify(this.identity()); }
  private saved() { return this.store.coachLoopState<CoachRuntimeReceipt>(this.scope()); }
  private effectiveGoals(goals: MobileGoalsResponse, settings: CoachLoopSettings | null): MobileGoalsResponse {
    return settings ? { ...goals, runCoach: null,
      raceTarget: settings.race ? runCoachRaceTarget(settings.race) : null } : goals;
  }

  read(): CoachLoopRuntimeResponse {
    // Control rows (receipt, goals, history) live in another store than the
    // training facts read inside `readFacts`. Re-read the control snapshot after
    // the build so a concurrent control write cannot be returned as "old plan
    // state + new facts"; iOS schedules this response directly, so a mixed
    // snapshot must fail closed with a retryable error instead.
    const readGuard = planReadGuard(this.store as unknown as PublicationGuardCapableStore);
    return readStableSnapshot({
      // One control read per table per attempt; the same objects feed the
      // before-digest and the build (review batch C read amplification).
      readControl: () => ({ saved: this.saved(), goals: this.store.read(), history: this.store.planHistory(200) }),
      build: control => this.evaluate(control.goals,
        this.readFacts(this.effectiveGoals(control.goals, control.saved?.settings ?? null), control.history),
        control.saved, control.saved?.settings ?? null).response,
      changedError: () => new PlanOperationError("coach_snapshot_changed",
        "教练计划状态在读取期间变化，请重新读取。", 503),
      // Cross-store publication guard when the control store exposes it; without
      // it the control digest pair remains the only check (pre-guard behaviour).
      ...(readGuard === undefined ? {} : { readGuard })
    });
  }


  recordDeviceReceipt(receipt: CoachLoopDeviceReceipt) {
    return recordCoachLoopDeviceReceipt(this.store, this.identity(), () => this.read(), receipt, this.publicationReady);
  }

  command(command: CoachLoopCommand): CoachLoopRuntimeResponse {
    if (!this.publicationReady()) throw new PlanOperationError("coach_sync_pending", "训练事实正在更新，请完成后重新读取并刷新。");
    if (command.contractVersion !== 1 || !command.operationId || !command.expectedFactsHash)
      throw new PlanOperationError("coach_contract_required", "需要教练合同版本、事实令牌和操作键。", 422);
    const publication = new PlanPublicationService(this.store, () => this.scope(), this.identity);
    return publication.publish("coach-loop", command, () => {
      const goals = this.store.read(), previous = this.saved();
      if (goals.revision !== command.expectedRevision) throw new MobileGoalsRevisionConflictError(goals.revision);
      const before = this.readFacts(this.effectiveGoals(goals, previous?.settings ?? null), this.store.planHistory(200));
      if (before.factsHash !== command.expectedFactsHash) throw new PlanOperationError("coach_facts_changed", "训练事实已变化，请重新读取。");
      let settings = previous?.settings ?? null;
      if (command.action === "enable") {
        if (previous && previous.settings.status !== "ended") throw new PlanOperationError("coach_already_enabled", "已有教练模式，请更新或结束。");
        if (command.acceptedPolicyHash !== COACH_RUNTIME_POLICY_HASH || !command.settings)
          throw new PlanOperationError("coach_policy_acceptance_required", "请确认当前教练规则版本及配置。", 422);
        if (goals.weekPlanReplanRequired || goals.weekPlanPreservedDate === before.date)
          throw new PlanOperationError("coach_migration_confirmation_required", "请先完成既有课表迁移确认。");
        const scheduled = this.store.activePlanPushes().some(push => push.localDate >= before.date);
        if (scheduled) throw new PlanOperationError("coach_schedule_reconciliation_required",
          "旧设备排期尚未撤回或核对，请先完成现有排期协调再切换新合同。");
        validateCoachLoopSettings(command.settings, before.date, true);
        settings = { ...command.settings, status: "active" };
      } else {
        if (!previous || !settings) throw new PlanOperationError("coach_not_enabled", "请先启用持续训练或比赛模式。");
        if (previous.policyHash !== COACH_RUNTIME_POLICY_HASH && !["pause", "end"].includes(command.action) &&
          !(command.action === "update" && command.acceptedPolicyHash === COACH_RUNTIME_POLICY_HASH))
          throw new PlanOperationError("coach_policy_changed", "规则版本变化，需要通过update明确确认；暂停和结束始终可用。");
        if (command.action === "update") {
          if (settings.status === "ended" || !command.settings) throw new PlanOperationError("coach_settings_invalid", "结束后需重新创建。", 422);
          validateCoachLoopSettings(command.settings, before.date, false);
          if (command.settings.mode !== settings.mode || command.settings.race?.raceDate !== settings.race?.raceDate ||
            command.settings.race?.raceDistanceKm !== settings.race?.raceDistanceKm ||
            command.settings.race?.goal !== settings.race?.goal)
            throw new PlanOperationError("coach_new_race_required", "更换目标类别、赛事或模式需先结束并重新启用。");
          settings = { ...command.settings, status: settings.status };
        }
        if (command.action === "pause") settings = { ...settings, status: "paused" };
        if (command.action === "end") settings = { ...settings, status: "ended" };
        if (command.action === "resume") {
          if (settings.status !== "paused" || settings.race?.raceDate && settings.race.raceDate < before.date)
            throw new PlanOperationError("coach_cannot_resume", "当前状态不能恢复。");
          settings = { ...settings, status: "active" };
        }
      }
      if (!settings) throw new Error("Coach settings missing");
      const facts = this.readFacts(this.effectiveGoals(goals, settings), this.store.planHistory(200));
      if (facts.factsHash !== before.factsHash) throw new PlanOperationError("coach_facts_changed", "发布前训练事实发生变化，原课表保持不变。");
      const evaluation = this.evaluate(goals, facts, previous, settings, true);
      const planned = evaluation.planned;
      const effectiveDigest = digest(evaluation.response.days.map(row =>
        [row.day.localDate, key(row.day), row.executable, row.decisionRef]));
      const changed = digest(goals.weekPlan.map(d => [d.localDate, key(d)])) !== digest(planned.map(d => [d.localDate, key(d)])) ||
        digest(previous?.settings) !== digest(settings) || digest(previous?.reservations) !== digest(evaluation.reservations) ||
        previous?.effectiveDigest !== effectiveDigest;
      const updated = changed ? this.store.write({
        expectedRevision: goals.revision, weekPlan: planned,
        raceTarget: settings.race ? runCoachRaceTarget(settings.race) : null,
        weekPlanAudit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: facts.asOf },
        ...(settings.status !== "active" ? { lockedSession: null } : {})
      }, { prescription: facts.inputs.prescription, runCoach: null, confirmCoachPlan: true, evaluatedAt: facts.asOf }) : goals;
      const receipt: CoachRuntimeReceipt = {
        settings, policyHash: COACH_RUNTIME_POLICY_HASH, policyManifest: COACH_RUNTIME_MANIFEST,
        factsHash: facts.factsHash, inputDigest: evaluation.inputDigest, effectiveDigest,
        anchor: evaluation.response.volumePolicy.anchor, reservations: evaluation.reservations,
        volumePolicy: evaluation.response.volumePolicy,
        templateIds: evaluation.templateIds, goalsRevision: updated.revision, evaluatedAt: facts.asOf,
        result: changed ? "patched" : "no_change",
        changes: planned.flatMap(day => {
          const old = goals.weekPlan.find(d => d.localDate === day.localDate);
          return old && key(old) === key(day) ? [] : [{ date: day.localDate, before: old ? key(old) : null,
            after: key(day), reason: day.reason ?? "coach_rule_changed" }];
        })
      };
      if (changed || previous?.inputDigest !== receipt.inputDigest)
        this.store.appendCoachLoopReceipt(this.scope(), command.operationId, receipt);
      return this.evaluate(updated, facts, receipt, settings).response;
    });
  }

  private evaluate(goals: MobileGoalsResponse, facts: CoachRuntimeFacts, saved: CoachRuntimeReceipt | null,
    settings: CoachLoopSettings | null, publishing = false) {
    const date = facts.date, scope = this.identity(), zones = facts.inputs.prescription;
    const defaults: CoachLoopSettings = { mode: "daily_adaptive", status: "active", runningDays: [1,2,3,4,5,6,7],
      longRunDays: [7], availabilityMinutesByWeekday: {}, targetType: "pace", race: null };
    const config = settings ?? defaults;
    const raceTarget = config.race ? runCoachRaceTarget(config.race) : null;
    const feedback = effectiveSubjectiveFeedback({ scope, asOf: facts.asOf, revisions: facts.feedback });
    const rawLockedDay = goals.lockedSession?.localDate === date ? planDayWithLock(goals, date)! : null;
    // Reads and write responses may carry different distance hints. Display the
    // same measured distance without rewriting the locked structure or storage.
    const lockedDay = rawLockedDay ? { ...rawLockedDay, distanceKm: rawLockedDay.structure
      ? plannedDayNumbers(rawLockedDay.kind, rawLockedDay.structure, rawLockedDay.distanceKm, zones).distanceKm
      : rawLockedDay.distanceKm } : null;
    const live = settings !== null ? settings.status === "active" && (!config.race?.raceDate || config.race.raceDate >= date)
      : !goals.runCoach && !goals.raceTarget;
    const runs = visibleCoachRuns(facts.facts, facts.asOf);
    const activePolicy = saved?.policyHash === COACH_RUNTIME_POLICY_HASH || publishing || settings === null;
    const lifecycle = live && activePolicy;
    const available = (day: string) => {
      const minutes = config.availabilityMinutesByWeekday[String(runCoachWeekday(day))];
      return minutes == null ? null : minutes * 60;
    };
    const completedDates = new Set(runs.map(run => coachLocalDate(run.startedAt)));
    const activePushes = this.store.activePlanPushes().filter(push => push.coachLoop &&
      digest(push.scope) === digest(scope) && push.workoutID && push.scheduledAt);
    const historicalReservations = (saved?.reservations ?? []).map(slot => {
      const ids = runs.filter(run => coachLocalDate(run.startedAt) === slot.localDate).map(run => run.id);
      const deviceScheduleUnresolved = activePushes.some(push => push.localDate === slot.localDate &&
        push.prescriptionDigest === slot.prescriptionDigest);
      return { ...slot, matchedWorkoutIds: ids,
        deviceScheduleUnresolved,
        status: ids.length ? "completed" as const : slot.localDate < date && !deviceScheduleUnresolved ? "expired" as const : slot.status };
    });
    const unresolvedDeviceReservations: CoachReservation[] = activePushes.filter(push =>
      !completedDates.has(push.localDate) && !historicalReservations.some(slot =>
        slot.localDate === push.localDate && slot.prescriptionDigest === push.prescriptionDigest))
      .map(push => ({
        slotId: `device:${push.workoutID}:${push.scheduledAt}`, localDate: push.localDate, allocation: "other" as const,
        distanceKm: assessSessionDose({ kind: push.kind, structure: push.structure, zones, allowColdStartEstimate: true })
          .distanceKm?.upper ?? 200,
        approvedAt: push.verifiedAt ?? push.pushedAt, status: "pending" as const, matchedWorkoutIds: [],
        deviceScheduleUnresolved: true
      }));
    const originalToday = historicalReservations.find(slot => slot.localDate === date && slot.status === "pending");
    const todayData = facts.inputs.today;
    const recoveryRestricted = feedback.extensionBlocked ||
      ["low_signal", "multiple_low_signals"].includes(todayData.recoveryAssessment.assessment) ||
      todayData.recommendation.basis === "high_load";
    const rawAnchor = buildCoachCapacityAnchor({ asOf: facts.asOf, facts: runs, scope,
      historyCoverageFrom: facts.historyCoverageFrom, revision: saved?.anchor.revision ?? 1 });
    const anchorRevision = saved?.anchor.weekStart === rawAnchor.weekStart && saved.anchor.factsHash !== rawAnchor.factsHash
      ? saved.anchor.revision + 1 : rawAnchor.revision;
    // Once opted in, both daily and fitness use the same no-programme capacity.
    const suggested = facts.inputs.weeklyVolumeBaselineKm;
    const phase = currentPeriodizationWeek({ today: date, raceTarget, recentWeeklyKm: facts.inputs.recentWeeklyKm });
    const preRace = raceExecutionProtection(date, config.race?.raceDate ?? null);
    const reservations: CoachReservation[] = [
      ...historicalReservations.filter(slot => slot !== originalToday && slot.slotId !== originalToday?.slotId),
      ...unresolvedDeviceReservations,
      ...goals.weekPlan.filter(day => day.localDate >= date && day.kind !== "rest" &&
        !historicalReservations.some(slot => slot.localDate === day.localDate) && !completedDates.has(day.localDate))
        .map(day => ({ slotId: `regular:${day.localDate}`, localDate: day.localDate, allocation: "regular" as const,
          distanceKm: assessSessionDose({ kind: day.kind, structure: day.structure ?? null, zones, allowColdStartEstimate: true }).distanceKm?.upper ?? day.distanceKm ?? 0,
          approvedAt: goals.updatedAt, status: "pending" as const, matchedWorkoutIds: [], deviceScheduleUnresolved: false }))
    ].filter(slot => slot.distanceKm > 0);
    // Evaluate today's retained extension, not a second copy; and free future
    // automatic regular reservations whose S has already been consumed.
    const actualWeek = runs.filter(run => coachLocalDate(run.startedAt) >= periodizationWeekStart(date))
      .reduce((sum, run) => sum + run.distanceKm, 0);
    // Automatic regular days are reallocated as a set by finalValidate below.
    // They must not make an otherwise affordable existing session look like an
    // extra session merely because future regular days reserved all of S.
    const extensionReservations = reservations.filter(slot => slot.allocation !== "regular");
    const input: CoachLoopDecisionInput = {
      asOf: facts.asOf, scope, mode: config.mode, raceTarget, raceDate: config.race?.raceDate ?? null,
      lifecycleAllowsTraining: lifecycle, runningDay: config.runningDays.includes(runCoachWeekday(date)),
      requestedRest: feedback.restRequested || lockedDay?.kind === "rest", facts: runs, reservations: extensionReservations,
      historyCoverageFrom: facts.historyCoverageFrom, anchorRevision,
      loadHistorySufficient: todayData.recommendation.basis !== "insufficient_training_history",
      syncStatus: !this.publicationReady() ? "pending" : todayData.sync.status === "ok" ? "ok" : todayData.sync.status === "failed" ? "failed" : "unknown",
      blockingFlagCodes: todayData.injuryFlags.map(flag => flag.code), recoveryRestricted,
      zones, targetType: config.targetType, availableSeconds: available(date), suggestedWeeklyKm: suggested, legacyProtectionKm: suggested,
      absoluteProtectionKm: 200, explicitPhaseHardCapKm: preRace.preRace || preRace.raceDay || preRace.past ? phase?.volumeBandKm.upper ?? suggested : null
    };
    let candidate = buildCoachLoopCandidate(input);
    if (originalToday?.deviceScheduleUnresolved && originalToday.prescriptionDigest !== candidate.prescriptionDigest) {
      candidate = buildCoachLoopCandidate({ ...input, reservations: [...input.reservations, originalToday] });
    }
    const volume = candidate.volumePolicy;
    const envelope = coachCapacityEnvelope({ anchor: volume.anchor, suggestedWeeklyKm: suggested,
      legacyProtectionKm: suggested, loadHistorySufficient: input.loadHistorySufficient,
      absoluteProtectionKm: 200, explicitPhaseHardCapKm: input.explicitPhaseHardCapKm });
    const inputDigest = digest({ factsHash: facts.factsHash, settings: config, policy: COACH_RUNTIME_POLICY_HASH,
      anchor: volume.anchor.factsHash,
      lockedDay: lockedDay ? [key(lockedDay), lockedDay.structure == null ? lockedDay.distanceKm : null] : null,
      reservations: historicalReservations.filter(slot => slot.localDate !== date) });
    const window = Array.from({ length: 7 }, (_, i) => shiftCoachDate(date, i));
    const templateIds = { ...saved?.templateIds };
    const protectedDates = lockedDay || goals.weekPlan.some(day => day.localDate === date) &&
      (goals.weekPlanPreservedDate === date || completedDates.has(date)) ? [date] : [];
    const isExtension = candidate.allocation === "extension";
    const slotId = `extension:${scope.datasetEpoch}:${date}`;
    const decisionRef = originalToday?.prescriptionDigest === candidate.prescriptionDigest ? originalToday.decisionRef :
      digest({ slotId, inputDigest, prescription: candidate.prescriptionDigest });
    const projectedReservations = historicalReservations.filter(slot => slot.localDate !== date ||
      slot.status !== "pending" || slot.deviceScheduleUnresolved);
    if (isExtension && (publishing || originalToday?.prescriptionDigest === candidate.prescriptionDigest)) {
      const previousSlotIndex = projectedReservations.findIndex(slot => slot.slotId === slotId);
      if (previousSlotIndex >= 0) projectedReservations.splice(previousSlotIndex, 1);
      projectedReservations.push({ slotId, localDate: date, allocation: "extension",
        distanceKm: candidate.dose.distanceKm!.upper, approvedAt: originalToday?.approvedAt ?? facts.asOf,
        status: "pending", matchedWorkoutIds: [], deviceScheduleUnresolved: false,
        prescriptionDigest: candidate.prescriptionDigest!, decisionRef });
    }
    const authorization = isExtension && (publishing || originalToday?.prescriptionDigest === candidate.prescriptionDigest) ? decisionRef : null;
    const choices: Record<string, ReturnType<typeof coachTemplateCandidates>["candidates"]> = {};
    const targetedTemplate = (day: string, choice: ReturnType<typeof coachTemplateCandidates>["candidates"][number]) => {
      const proposed = runCoachSessionTargets(templateDay(day, choice), { targetType: config.targetType }, zones);
      return { ...proposed, structure: normalizeSessionStructure(proposed.structure)! };
    };
    const priorMaximum = Math.max(0, ...runs.filter(r => coachLocalDate(r.startedAt) < periodizationWeekStart(date)).map(r => r.distanceKm));
    for (const day of window) {
      const dayPhase = currentPeriodizationWeek({ today: day, raceTarget, recentWeeklyKm: facts.inputs.recentWeeklyKm });
      const negativeSimilar = facts.execution.filter(row => row.completion === "known_not_met" &&
        row.localDate >= shiftCoachDate(day, -14)).length > 0;
      choices[day] = coachTemplateCandidates({ date: day, mode: config.mode, phase: dayPhase?.phase ?? null,
        distance: raceTarget?.distance ?? null, zones, calibrated: todayData.calibration.status === "completed",
        qualityAllowed: !(day === date && feedback.qualityBlocked) && !negativeSimilar && !input.blockingFlagCodes.length &&
          (day !== date || todayData.verdict.tone === "green"),
        extension: day === date && isExtension, availableSeconds: available(day), longestPreviousRunKm: priorMaximum,
        longRunCapKm: dayPhase?.longRunCapKm ?? Math.min(priorMaximum * 1.1, suggested * 0.38),
        longDay: config.longRunDays.includes(runCoachWeekday(day)),
        recentQualityKinds: facts.qualityDates.map(row => row.kind as MobileSessionKind) }).candidates;
    }
    const fixed = goals.weekPlan.filter(day => day.localDate >= date && !window.includes(day.localDate));
    const previous: CoachRepairDay[] = [...fixed, ...window.map(day => goals.weekPlan.find(old => old.localDate === day) ??
      (day === date ? lockedDay : null) ?? rest(day, "尚未排课"))]
      .map(day => ({ day, executable: day.kind !== "rest", authorizedDecisionRef: day.localDate === date ? originalToday?.decisionRef ?? null : null }));
    // Frozen actual volume is invariant across all <=2187 candidate evaluations.
    // Cache interval sums per evaluation, never across facts revisions/requests.
    const actualByDate = new Map<string, number>();
    for (const run of runs) {
      const day = coachLocalDate(run.startedAt);
      actualByDate.set(day, (actualByDate.get(day) ?? 0) + run.distanceKm);
    }
    const actualWindowCache = new Map<string, number>();
    const actual = (from: string, to: string) => {
      const identity = `${from}:${to}`;
      if (!actualWindowCache.has(identity)) actualWindowCache.set(identity, [...actualByDate]
        .reduce((sum, [day, km]) => sum + (day >= from && day <= to ? km : 0), 0));
      return actualWindowCache.get(identity)!;
    };
    const finalValidate = (days: readonly MobilePlannedDay[]) => {
      const all: MobilePlannedDay[] = [];
      const dailyCosts = new Map<string, number>();
      const plannedQuality: string[] = [];
      let feasible = true;
      for (const storedDay of [...days].sort((a,b) => a.localDate.localeCompare(b.localDate))) {
        // Preserve stored history, but measure and limit the actual locked
        // prescription. Completed dates still have no remaining obligation.
        const day = storedDay.localDate === date && lockedDay && !completedDates.has(date) ? lockedDay : storedDay;
        let permitted = lifecycle && config.runningDays.includes(runCoachWeekday(day.localDate)) &&
          !completedDates.has(day.localDate) && (!config.race?.raceDate || day.localDate < config.race.raceDate) &&
          !(day.localDate === date && (feedback.restRequested || todayData.verdict.tone === "red"));
        if (day.kind !== "rest") {
          const dose = assessSessionDose({ kind: day.kind, structure: day.structure ?? null, zones,
            availableSeconds: available(day.localDate), allowColdStartEstimate: true });
          const context = executionPolicyContext({ localDate: day.localDate, raceTarget, raceDate: config.race?.raceDate ?? null,
            weeklyDistanceKm: suggested });
          const protections = context.protections.flatMap(p => p.constraints);
          const protectedCap = protections.find(c => c.kind === "cap_distance")?.value;
          const phaseForDay = currentPeriodizationWeek({ today: day.localDate, raceTarget, recentWeeklyKm: facts.inputs.recentWeeklyKm });
          permitted &&= dose.status === "feasible" && (protectedCap == null || dose.distanceKm!.upper <= protectedCap);
          permitted &&= !protections.some(c => c.kind === "no_extra_training" ||
            c.kind === "no_quality_or_long_run" && (quality(day) || day.kind === "long_run"));
          // Eligibility approved one exact complete course, not any retained
          // day that happens to fit H. A mismatch must participate in repair.
          if (day.localDate === date && isExtension) permitted &&= key(day) === candidate.prescriptionDigest;
          if (day.kind === "long_run") permitted &&= dose.distanceKm!.upper <= (phaseForDay?.longRunCapKm ?? suggested * 0.38) &&
            dose.distanceKm!.upper <= priorMaximum * 1.1;
          if (quality(day)) {
            permitted &&= todayData.calibration.status === "completed" && !input.blockingFlagCodes.length &&
              !(day.localDate === date && (feedback.qualityBlocked || todayData.verdict.tone !== "green")) &&
              !context.protections.length && !negativeExecution(facts, day.localDate) &&
              !(phaseForDay?.phase === "base" && day.kind === "interval") &&
              [...facts.qualityDates.map(r => r.date), ...plannedQuality].every(d =>
                Math.abs(Date.parse(d) - Date.parse(day.localDate)) >= 2 * 86_400_000);
            plannedQuality.push(day.localDate);
          }
          if (!permitted && !protectedDates.includes(day.localDate)) feasible = false;
          if (permitted) dailyCosts.set(day.localDate, dose.distanceKm!.upper);
        }
        all.push(permitted || day.kind === "rest" ? day : rest(day.localDate, "有效训练限制；保留原课历史"));
      }
      const deviceCost = (from: string, to: string) => [...historicalReservations, ...unresolvedDeviceReservations].filter(slot =>
        slot.deviceScheduleUnresolved && slot.status !== "completed" && slot.localDate >= from && slot.localDate <= to &&
        !completedDates.has(slot.localDate) && !all.some(day => day.localDate === slot.localDate && day.kind !== "rest" &&
          activePushes.some(push => push.localDate === day.localDate && push.prescriptionDigest === key(day))))
        .reduce((sum, slot) => sum + slot.distanceKm, 0);
      const plannedCost = (from: string,to: string, regularOnly = false) => [...dailyCosts].reduce((sum,[d,c]) =>
        sum+(d>=from && d<=to && !(regularOnly && d===date && isExtension) ? c : 0),0);
      for (const week of new Set([...dailyCosts.keys()].map(periodizationWeekStart))) {
        const end=weekEnd(week), a=actual(week,end);
        if (a+plannedCost(week,end)+deviceCost(week,end)>envelope.weeklyProtectionKm+1e-9 ||
          a+plannedCost(week,end,true)>Math.max(a,suggested)+1e-9) feasible=false;
        const q=all.filter(d=>quality(d) && periodizationWeekStart(d.localDate)===week).length+
          facts.qualityDates.filter(d=>periodizationWeekStart(d.date)===week).length;
        const phaseForWeek=currentPeriodizationWeek({today:week,raceTarget,recentWeeklyKm:facts.inputs.recentWeeklyKm});
        if(q>Math.min(goals.qualitySessionCap,phaseForWeek?.qualityDose??goals.qualitySessionCap))feasible=false;
        let total=0,easy=0;
        for(const day of all.filter(d=>periodizationWeekStart(d.localDate)===week && d.structure && d.kind!=="rest")){
          const dose=assessSessionDose({kind:day.kind,structure:day.structure!,zones,allowColdStartEstimate:true});
          const duration=dose.durationSeconds?.upper??0; total+=duration;
          easy+=quality(day)?day.structure!.blocks.reduce((sum,b)=>sum+b.iterations*b.steps.reduce((s,step)=>
            s+(step.purpose!=="work" && step.goal.type==="time"?step.goal.seconds:0),0),0)+
            (day.structure!.warmup?.goal.type==="time"?day.structure!.warmup.goal.seconds:0)+
            (day.structure!.cooldown?.goal.type==="time"?day.structure!.cooldown.goal.seconds:0):duration;
        }
        if(week===periodizationWeekStart(date)){total+=todayData.weekStructure.easyDurationFraction!=null?
          todayData.week.durationSeconds:0;
          easy+=(todayData.weekStructure.easyDurationFraction??0)*todayData.week.durationSeconds;}
        if(q>0 && total>0 && easy/total+1e-9<goals.easyDurationFloorFraction)feasible=false;
      }
      for(const d of dailyCosts.keys()) for(const length of [7,14] as const) for(let offset=0;offset<length;offset++){
        const end=shiftCoachDate(d,offset),start=shiftCoachDate(end,1-length);
        if(actual(start,end)+plannedCost(start,end)+deviceCost(start,end)>(length===7?envelope.rolling7Km:envelope.rolling14Km)+1e-9)feasible=false;
      }
      return {feasible,effectiveDays:all.map(day=>({day,executable:feasible && day.kind!=="rest",
        authorizedDecisionRef:day.localDate===date&&day.kind!=="rest"&&isExtension&&key(day)===candidate.prescriptionDigest
          ?authorization:null})),reasons:[]};
    };
    // Greedy seed only selects feasible intentions. The solver then minimizes
    // changes among old/template/rest options instead of rewarding all-rest.
    let seed: MobilePlannedDay[] = [...fixed];
    const required: string[] = [];
    for(const day of window){
      const old=previous.find(row=>row.day.localDate===day)!.day;
      if(protectedDates.includes(day) && old){seed.push(old);continue;}
      const chosen=choices[day]!.filter(c=>!c.quality).map(c=>targetedTemplate(day,c))
        .find(proposed=> finalValidate([...seed,proposed]).feasible);
      seed.push(chosen??rest(day,"完整课不可行或等待今日追加评估"));
      if(chosen && (!old || old.kind==="rest")) required.push(day);
    }
    // Select quality against a COMPLETE week's low-intensity support, not a
    // half-built prefix (which would reject every first quality session).
    for (const day of window) {
      if (protectedDates.includes(day) || day === date && isExtension) continue;
      for (const choice of choices[day]!.filter(c => c.quality)) {
        const proposed = targetedTemplate(day, choice);
        let trial = seed.map(row => row.localDate === day ? proposed : row);
        if (!finalValidate(trial).feasible) {
          for (const other of window.filter(d => d !== day && !protectedDates.includes(d))) {
            const easy = choices[other]!.find(c => c.id === "easy");
            const original = trial.find(row => row.localDate === other);
            if (!easy || !original || original.kind !== "easy") continue;
            trial = trial.map(row => row.localDate === other
              ? targetedTemplate(other, easy) : row);
            if (finalValidate(trial).feasible) break;
          }
        }
        if (finalValidate(trial).feasible) { seed = trial; break; }
      }
    }
    const repair = repairCoachPlan({ previous, windowDates:window,affectedDates:window,protectedDates,requiredIntentDates:required,
      candidates:Object.fromEntries(window.map(day=>{
        const proposed=seed.find(d=>d.localDate===day)!;
        return [day,[proposed,rest(day,"完整课不可行")].map((d,index)=>({day:d,executable:d.kind!=="rest",
          authorizedDecisionRef:d.localDate===date&&isExtension?authorization:null,originDate:null,
          templateId:choices[day]?.find(c=>key(targetedTemplate(day,c))===key(d))?.id??"rest",preferenceRank:index}))];
      })), maximumEvaluations:2187,retainFeasibleWindow:true,inputDigest,reasonsByDate:{},validate:finalValidate });
    const fallback = [...fixed,...window.map(d=>protectedDates.includes(d)?previous.find(row=>row.day.localDate===d)!.day:rest(d,"无可行完整课"))];
    const selected=repair.status==="not_evaluable"?fallback:[...repair.storedDays];
    const effective=repair.status==="not_evaluable"?finalValidate(fallback).effectiveDays:repair.effectiveDays;
    for(const { day } of effective) templateIds[day.localDate]=day.kind==="rest"?"rest":
      choices[day.localDate]?.find(c=>key(targetedTemplate(day.localDate,c))===key(day))?.id ??
      (day.localDate===date&&lockedDay&&key(day)===key(lockedDay)?"locked":templateIds[day.localDate]??"rest");
    // Only keep a pending authorization if final whole-window validation kept
    // that exact course. Eligibility alone never consumes a slot.
    const survivingToday = effective.find(row => row.day.localDate === date && row.executable);
    const committedReservations = projectedReservations.filter(slot =>
      slot.localDate !== date || slot.status !== "pending" || slot.deviceScheduleUnresolved ||
      !!survivingToday && slot.prescriptionDigest === key(survivingToday.day));
    if (originalToday && !committedReservations.some(slot => slot.slotId === originalToday.slotId))
      committedReservations.push({ ...originalToday, status: "revoked" });
    const unchanged = saved?.inputDigest === inputDigest;
    // Outside rows remain fixed budget inputs and stored prescriptions, not
    // additional dates in the client's strictly seven-day execution window.
    const outputDays = effective.filter(row=>window.includes(row.day.localDate)).map(row=>({ ...row, decisionRef:row.authorizedDecisionRef,
      templateId:templateIds[row.day.localDate]??null,
      executable: row.executable && (publishing || !!settings &&
        key(planDayWithLock(goals,row.day.localDate)??rest(row.day.localDate,"未排课"))===key(row.day)) &&
        (row.day.localDate!==date || !isExtension || authorization!==null) }));
    const today=outputDays.find(row=>row.day.localDate===date)??{day:rest(date,"未排课"),executable:false,decisionRef:null};
    volume.extension.authorizedDecisionRef=today.executable?authorization:null;
    volume.policyManifest=COACH_RUNTIME_MANIFEST;
    const executionToken = digest({ scope, factsHash: facts.factsHash, revision: goals.revision,
      policyHash: COACH_RUNTIME_POLICY_HASH, settings, days: outputDays.map(row =>
        [row.day.localDate, key(row.day), row.executable, row.decisionRef]) });
    const response:CoachLoopRuntimeResponse={contractVersion:1,scope,timezone:DATABASE_TIMEZONE,executionToken,
      policyHash:COACH_RUNTIME_POLICY_HASH,policyManifest:COACH_RUNTIME_MANIFEST,
      revision:goals.revision,factsHash:facts.factsHash,asOf:facts.asOf,settings,raceTarget,volumePolicy:volume,
      refreshRequired:!!settings&&(!unchanged||selected.some(d=>!goals.weekPlan.some(old=>old.localDate===d.localDate&&key(old)===key(d)))),
      today,days:outputDays,feedback,subjectiveFeedback:facts.feedback.filter(row =>
        row.scope.athleteId === scope.athleteId && row.scope.datasetEpoch === scope.datasetEpoch &&
        Date.parse(row.availableAt) <= Date.parse(facts.asOf)),
      execution:facts.execution,executionSummary:facts.executionSummary,
      executionPolicy:executionPolicyContext({localDate:date,raceTarget,raceDate:config.race?.raceDate??null,weeklyDistanceKm:suggested}),
      goalGap:coachGoalGap({asOf:facts.asOf,
        distance:raceTarget?.distance??(config.race?"unsupported":null),
        targetSeconds:config.race?.targetTimeSeconds??null,summary:facts.predictionSummary,currentIdentity:facts.predictionIdentity}),
      goals,reasons:candidate.reasons};
    return {response, planned:[...goals.weekPlan.filter(d=>d.localDate<date),...selected].sort((a,b)=>a.localDate.localeCompare(b.localDate)),
      reservations:committedReservations,templateIds,inputDigest};
  }
}

function negativeExecution(facts: CoachRuntimeFacts, date: string) {
  return facts.execution.some(row=>row.localDate>=shiftCoachDate(date,-14)&&row.completion==="known_not_met");
}

