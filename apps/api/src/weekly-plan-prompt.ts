import type { MobileGoalsResponse, MobileTodayResponse } from "@rai/api-contracts";

import type { CoachZonePrescription } from "./mobile-coach.js";

export const WEEKLY_PLAN_PROMPT_VERSION = "weekly-plan-v2";

export interface WeeklyPlanPromptArgs {
  today: MobileTodayResponse;
  goals: Pick<
    MobileGoalsResponse,
    "weeklyDistanceKm" | "easyDurationFloorFraction" | "qualitySessionCap" | "raceTarget"
  >;
  prescription: CoachZonePrescription | null;
  /** Exact ISO dates the model is allowed to use, today first. */
  allowedDates: string[];
}

const SYSTEM_PROMPT = [
  "你是耐力跑步教练，负责为一名业余跑者编排未来一周的训练计划。",
  "你会收到结构化的客观数据（近期跑量、恢复指标、负荷、配速与心率区间、伤病旗标）。",
  "",
  "硬性要求：",
  "1. 只能使用 allowedDates 中给出的日期，一天一条，不得新增、遗漏或改动日期。",
  "2. 只能输出 JSON，结构为 {\"days\":[{\"localDate\":\"YYYY-MM-DD\",\"kind\":\"...\",\"distanceKm\":数字,\"reason\":\"简短中文理由\",\"structure\":{...}}]}。",
  "3. kind 只能是 rest / recovery / easy / long_run / tempo / interval。",
  "4. 每天都必须给出 structure，用与 WorkoutKit 一致的结构表达；rest 日 structure 为 null。",
  "5. structure 形如 {\"warmup\":STEP,\"blocks\":[{\"iterations\":整数,\"steps\":[STEP,...]}],\"cooldown\":STEP}；STEP 为 {\"purpose\":\"warmup|work|recovery|cooldown\",\"goal\":{\"type\":\"distance\",\"meters\":数字} 或 {\"type\":\"time\",\"seconds\":数字} 或 {\"type\":\"open\"},\"alert\":{\"kind\":\"pace\"|\"heart_rate\",\"lower\":数字,\"upper\":数字} 或 null}。",
  "6. 每个 STEP 最多只能有一个 alert；同一段不要同时要求配速与心率。",
  "7. 配速/心率数值必须取自给定的区间，不得自行编造更激进的目标。",
  "8. interval 用距离制重复跑（例如 800 米一组），组间给恢复段；tempo 用阈值配速的重复段；easy / long_run / recovery 用连续单段并配热身与放松。",
  "9. 质量课（tempo / interval）数量不得超过 qualitySessionCap；轻松时段占比不得低于 easyDurationFloorFraction。",
  "10. 周总跑量不得超过 weeklyDistanceKm；出现伤病旗标或负荷告警时，以保守为先。",
  "",
  "只输出 JSON，不要输出解释文字或 Markdown 代码块。"
].join("\n");

/**
 * Builds the request payload. Kept to a compact, factual context: the model is
 * given numbers, never asked to recompute them.
 */
export function buildWeeklyPlanPrompt(args: WeeklyPlanPromptArgs): { system: string; user: string } {
  const { today, goals, prescription } = args;
  const context = {
    today: today.today.localDate,
    timezone: today.timezone,
    allowedDates: args.allowedDates,
    dataFreshness: {
      latestDataDate: today.latestDataDate,
      state: today.freshness.state
    },
    weeklyGoal: {
      weeklyDistanceKm: goals.weeklyDistanceKm,
      easyDurationFloorFraction: goals.easyDurationFloorFraction,
      qualitySessionCap: goals.qualitySessionCap
    },
    currentWeek: {
      distanceKm: today.week.distanceKm,
      workoutCount: today.week.workoutCount,
      goalProgressFraction: today.week.goalProgressFraction
    },
    weekStructure: today.weekStructure,
    ability: {
      trueAbility: today.ability.trueAbility,
      currentAbility: today.ability.currentAbility,
      changeFrom7DaysAgo: today.ability.changeFrom7DaysAgo,
      decayPoints: today.ability.decayPoints
    },
    recovery: {
      score: today.recovery.score,
      lastNightSleepMinutes: today.recovery.lastNightSleepMinutes,
      sleepBaselineMinutes: today.recovery.sleepBaselineMinutes,
      morningHrvMs: today.recovery.morningHrvMs,
      hrvBaselineMs: today.recovery.hrvBaselineMs,
      restingHeartRateBpm: today.recovery.restingHeartRateBpm,
      restingHeartRateBaselineBpm: today.recovery.restingHeartRateBaselineBpm,
      state: today.recovery.state ?? null
    },
    verdict: {
      tone: today.verdict.tone,
      title: today.verdict.title,
      reason: today.verdict.reason,
      triggers: today.verdict.triggers
    },
    injuryFlags: today.injuryFlags,
    race: today.race,
    recentExecution: {
      note: "仅为历史计划与已导入训练的观测对照；pending/unknown 不代表漏跑，距离比例不代表课型或强度完成率，不得据此补偿加量。",
      days: today.recentPlanExecution ?? []
    },
    recentWorkouts: today.recentWorkouts.slice(0, 5).map((workout) => ({
      startedAt: workout.startedAt,
      sessionType: workout.sessionType,
      stimulusType: workout.stimulusType,
      distanceKm: workout.distanceKm,
      durationSeconds: workout.durationSeconds,
      averagePaceSecondsPerKm: workout.averagePaceSecondsPerKm,
      averageHeartRateBpm: workout.averageHeartRateBpm,
      indoor: workout.indoor
    })),
    zonePrescription: prescription
  };

  return {
    system: SYSTEM_PROMPT,
    user: [
      "以下是本周的训练上下文（JSON）：",
      JSON.stringify(context, null, 2),
      "",
      `请为 ${args.allowedDates.join("、")} 编排计划。`
    ].join("\n")
  };
}

export const WEEKLY_PLAN_DAYS = 7;
