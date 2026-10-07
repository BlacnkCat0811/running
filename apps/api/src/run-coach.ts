import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MobileGoalsResponse, MobilePlannedDay, MobileRunCoachCommand, MobileRunCoachPlan, MobileRunCoachResponse } from "@rai/api-contracts";
import type { RaiReadStore } from "./data.js";
import { MobileGoalsRevisionConflictError, type MobileGoalsStore } from "./mobile-goals.js";
import { buildCoachWeekPlan } from "./weekly-plan-validate.js";
import { constrainUpcomingPlan, mergePlanWindow, weeklyPlanDates } from "./weekly-plan-service.js";
import { periodizationVolumeFraction } from "./plan-periodization.js";
import { RunCoachInputError, runCoachDaysBetween, runCoachEndDate, runCoachIsTraining, runCoachPhase, runCoachRaceTarget, runCoachShiftDate, runCoachWeekday, validateRunCoachConfig } from "./run-coach-policy.js";
import { weeklyCapacity } from "./weekly-capacity.js";
import { runCoachCommandSchema } from "./schemas.js";

type Inputs = ReturnType<RaiReadStore["mobileWeeklyPlanInputs"]>;

export function runCoachAdaptationKey(plan: MobileRunCoachPlan, inputs: Inputs,
  policy?: Pick<MobileGoalsResponse, "qualitySessionCap" | "easyDurationFloorFraction" | "lockedSession" | "weekPlanPreservedDate">): string {
  const { adaptationKey: _key, adaptedAt: _at, ...configuration } = plan;
  const today = inputs.today;
  return createHash("sha256").update(JSON.stringify({ configuration, date: today.today.localDate,
    today: today.today, week: today.week, recovery: today.recoveryAssessment,
    calibration: today.calibration, injury: today.injuryFlags, verdict: today.verdict,
    coverage: today.coverage, latestDataDate: today.latestDataDate, zones: inputs.prescription,
    recent: inputs.recentWeeklyKm, previous: inputs.previousWeekDistanceKm, policy })).digest("hex");
}

export function buildRunCoachWeek(plan: MobileRunCoachPlan, goals: MobileGoalsResponse, inputs: Inputs): MobilePlannedDay[] {
  const dates = weeklyPlanDates(inputs.today.today.localDate);
  const rest = (localDate: string, reason: string): MobilePlannedDay => ({ localDate, kind: "rest", distanceKm: null, structure: null, reason });
  if (!runCoachIsTraining(plan, dates[0]!)) return dates.map(date => rest(date, "教练计划未在进行。"));
  const phase = runCoachPhase(dates[0]!, plan);
  const capacity = weeklyCapacity({ today: dates[0]!, raceTarget: runCoachRaceTarget(plan), runCoach: plan,
    recentWeeklyKm: inputs.recentWeeklyKm, previousWeekDistanceKm: inputs.previousWeekDistanceKm });
  const baseline = phase ? Math.min(capacity.baselineKm, Math.max(5, inputs.recentWeeklyKm) * periodizationVolumeFraction(phase)) : capacity.baselineKm;
  const available = dates.filter(date => plan.runningDays.includes(runCoachWeekday(date)) && date <= runCoachEndDate(plan));
  const template = buildCoachWeekPlan({ allowedDates: dates, prescription: inputs.prescription,
    weeklyDistanceKm: baseline, previousWeekDistanceKm: inputs.previousWeekDistanceKm,
    qualitySessionCap: inputs.today.calibration.status === "completed" ? goals.qualitySessionCap : 0,
    easyDurationFloorFraction: goals.easyDurationFloorFraction, injuryFlagCodes: inputs.today.injuryFlags.map(flag => flag.code) });
  const rank = (day: MobilePlannedDay) => day.kind === "long_run" ? 0 : ["tempo", "interval"].includes(day.kind) ? 1 : 2;
  const sessions = template.filter(day => day.kind !== "rest").sort((a, b) => rank(a) - rank(b)).slice(0, available.length);
  // Reuse the measured easy structure for a preferred endurance day; the final
  // validator still enforces its long-run share and the easy-duration floor.
  if (inputs.today.calibration.status === "completed" && sessions.length >= 4) {
    const longest = sessions.filter(day => day.kind === "easy").sort((a, b) => (b.distanceKm ?? 0) - (a.distanceKm ?? 0))[0];
    if (longest) longest.kind = "long_run";
    sessions.sort((a, b) => rank(a) - rank(b));
  }
  const assigned = new Map<string, MobilePlannedDay>();
  for (const session of sessions) {
    const remaining = available.filter(date => !assigned.has(date));
    const spread = remaining.slice().sort((a, b) => {
      const gap = (date: string) => Math.min(7, ...[...assigned.keys()].map(other => Math.abs(runCoachDaysBetween(other, date))));
      return gap(b) - gap(a) || a.localeCompare(b);
    });
    const date = session.kind === "long_run" ? spread.find(date => plan.longRunDays.includes(runCoachWeekday(date))) ?? spread[0] : spread[0];
    if (date) assigned.set(date, { ...session, localDate: date });
  }
  const proposed = dates.map(date => assigned.get(date) ?? rest(date, plan.runningDays.includes(runCoachWeekday(date)) ? "恢复日。" : "非可跑步日。"));
  let safe = constrainUpcomingPlan(proposed, { ...inputs, goals: { ...goals, runCoach: plan, raceTarget: runCoachRaceTarget(plan) }, weeklyVolumeBaselineKm: baseline });
  // Every race day stays blank, including distances outside the prediction set.
  // Uncalibrated distances keep the conservative pre-race recovery policy.
  if (plan.raceDate) safe = safe.map(day => {
    if (day.localDate === plan.raceDate) return rest(day.localDate, "比赛日留白；不等于比赛已完成。");
    if (day.localDate > plan.raceDate!) return rest(day.localDate, "比赛后恢复。 ");
    if (!runCoachRaceTarget(plan) && runCoachDaysBetween(day.localDate, plan.raceDate!) <= 2 && ["tempo", "interval", "long_run"].includes(day.kind)) return rest(day.localDate, "赛前减量。 ");
    return day;
  });
  return safe;
}

export function runCoachResponse(goals: MobileGoalsResponse, inputs: Inputs): MobileRunCoachResponse {
  const plan = goals.runCoach ?? null;
  const today = inputs.today.today.localDate;
  const notices: string[] = [];
  const phases: MobileRunCoachResponse["phases"] = [];
  if (plan) {
    for (let date = plan.startedOn; date <= runCoachEndDate(plan); date = runCoachShiftDate(date, 1)) {
      const phase = runCoachPhase(date, plan) ?? "base";
      const last = phases.at(-1);
      if (last?.phase === phase) { last.endsOn = date; last.current ||= date === today; }
      else phases.push({ phase, startsOn: date, endsOn: date, current: date === today });
    }
  }
  if (plan && plan.goal !== "fitness" && !runCoachRaceTarget(plan)) notices.push("该比赛距离暂无经过校准的成绩预测；训练仍受跑量和恢复闸门约束。");
  if (plan?.targetType === "heart_rate" && inputs.prescription?.easyHrUpper == null) notices.push("心率分区尚未建立，暂不下发心率目标。");
  if (inputs.today.calibration.status !== "completed") notices.push("校准未完成，暂以轻松训练建立基础。");
  if (plan && runCoachEndDate(plan) < today) notices.push("训练周期已结束；这不代表已完成比赛或达到目标。");
  const strength = plan?.strengthTraining && runCoachIsTraining(plan, today) && !inputs.today.injuryFlags.length && inputs.today.verdict.tone !== "red" ?
    goals.weekPlan.filter(day => day.localDate >= today && ["easy", "recovery"].includes(day.kind)).filter((_, index) => index % 2 === 0).slice(0, 2).map(day => ({
      localDate: day.localDate, durationMinutes: 15, exercises: [{ name: "提踵", dose: "2 组 × 12 次" }, { name: "臀桥", dose: "2 组 × 12 次" }, { name: "鸟狗式", dose: "每侧 2 组 × 8 次" }, { name: "侧平板支撑", dose: "每侧 2 组 × 20 秒" }]
    })) : [];
  return { revision: goals.revision, plan, phase: plan ? runCoachPhase(today, plan) : null,
    daysToRace: plan?.raceDate ? Math.max(0, runCoachDaysBetween(today, plan.raceDate)) : null,
    elapsedWeeks: plan ? Math.max(0, Math.floor(runCoachDaysBetween(plan.startedOn, today) / 7)) : 0,
    weeklyCapacityKm: inputs.weeklyVolumeBaselineKm, notices, phases, strength };
}

export function registerRunCoachRoutes(args: { app: FastifyInstance; store: MobileGoalsStore; inputs: (goals: MobileGoalsResponse) => Inputs }) {
  args.app.get("/v1/mobile/run-coach", async () => {
    const goals = args.store.read();
    return runCoachResponse(goals, args.inputs(goals));
  });
  args.app.post<{ Body: MobileRunCoachCommand }>("/v1/mobile/run-coach", { schema: { body: runCoachCommandSchema } }, async (request, reply) => {
    const goals = args.store.read();
    if (request.body.expectedRevision !== goals.revision) return reply.code(409).send({ code: "mobile_goals_revision_conflict", message: "计划已更新，请刷新后重试。" });
    const inputs = args.inputs(goals);
    const today = inputs.today.today.localDate;
    const { action, config } = request.body;
    let plan = goals.runCoach ?? null;
    try {
      if (config && !["start", "update"].includes(action)) throw new RunCoachInputError("该操作不接受训练设置。");
      if (["start", "update"].includes(action)) {
        if (!config) throw new RunCoachInputError("缺少教练计划设置。");
        validateRunCoachConfig(config, today, action === "start");
      }
      if (action === "start") {
        if (plan && plan.status !== "ended" && runCoachEndDate(plan) >= today) throw new RunCoachInputError("请先结束当前计划。");
        plan = { ...config!, id: randomUUID(), startedOn: today, status: "active", pausedOn: null, endedOn: null, adaptationKey: null, adaptedAt: null };
      } else {
        if (!plan) throw new RunCoachInputError("尚未创建教练计划。");
        if (action === "refresh" && plan.status !== "active") return runCoachResponse(goals, inputs);
        if (action === "update") {
          if (plan.status === "ended") throw new RunCoachInputError("已结束计划不能修改。");
          if (config!.goal !== plan.goal || config!.raceDate !== plan.raceDate || config!.raceDistanceKm !== plan.raceDistanceKm || (config!.durationWeeks ?? 12) !== (plan.durationWeeks ?? 12)) throw new RunCoachInputError("计划目标、距离和结束日期不能更换，请结束后创建新计划。");
          plan = { ...plan, ...config! };
        }
        if (action === "pause") {
          if (plan.status !== "active") throw new RunCoachInputError("只有进行中的计划可以暂停。");
          plan = { ...plan, status: "paused", pausedOn: today };
        }
        if (action === "resume") {
          if (plan.status !== "paused" || runCoachEndDate(plan) < today) throw new RunCoachInputError("该计划不能恢复。");
          plan = { ...plan, status: "active", pausedOn: null };
        }
        if (action === "end") plan = { ...plan, status: "ended", endedOn: today };
        if (runCoachEndDate(plan) < today) plan = { ...plan, status: "ended", endedOn: today };
      }
      const effectiveGoals = { ...goals, runCoach: plan, raceTarget: runCoachRaceTarget(plan) };
      const effectiveInputs = args.inputs(effectiveGoals);
      const key = runCoachAdaptationKey(plan, effectiveInputs, { qualitySessionCap: goals.qualitySessionCap,
        easyDurationFloorFraction: goals.easyDurationFloorFraction, lockedSession: goals.lockedSession,
        weekPlanPreservedDate: goals.weekPlanPreservedDate ?? null });
      if (action === "refresh" && plan.adaptationKey === key) return runCoachResponse(goals, inputs);
      const days = buildRunCoachWeek(plan, { ...effectiveGoals, weekPlan: goals.weekPlan.filter(day => day.localDate <= today) }, effectiveInputs);
      plan = { ...plan, adaptationKey: key, adaptedAt: new Date().toISOString() };
      const retainedToday = goals.weekPlanPreservedDate === today || effectiveInputs.today.today.workoutCount > 0 || goals.lockedSession?.localDate === today;
      const written = args.store.write({ expectedRevision: goals.revision, raceTarget: runCoachRaceTarget(plan),
        weekPlan: mergePlanWindow(goals.weekPlan.filter(day => day.localDate <= today), days.filter(day => day.localDate !== today || !retainedToday), today),
        weekPlanAudit: { generatedBy: "heuristic", model: null, promptVersion: null, generatedAt: plan.adaptedAt },
        ...(plan.status !== "active" ? { lockedSession: null } : {})
      }, { runCoach: plan, confirmCoachPlan: true, prescription: effectiveInputs.prescription });
      return runCoachResponse(written, args.inputs(written));
    } catch (error) {
      if (error instanceof MobileGoalsRevisionConflictError) return reply.code(409).send({ code: error.code, message: error.message });
      if (error instanceof RunCoachInputError) return reply.code(422).send({ code: "run_coach_invalid", message: error.message });
      throw error;
    }
  });
}
