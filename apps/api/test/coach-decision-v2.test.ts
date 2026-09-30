import assert from "node:assert/strict";
import test from "node:test";

import { COACH_MODEL_VERSION } from "@rai/api-contracts";
import type { ReadinessAssessmentResult } from "@rai/contracts";

import {
  decideNextSession,
  decideNextSessionDecision,
  decideVerdict,
  decideVerdictFromSnapshots,
  projectCoachDecisionV2,
  type CoachInput,
  type CoachPlanDisposition
} from "../src/mobile-coach.js";

/**
 * §16.1 **C01** / §13.3：Coach 决策的版本化输出。
 *
 * 独立审计（2026-09-30）确认：在这次改动之前**全仓既没有 Coach 版本常量，
 * 也没有版本化的决策输出类型**，唯一的形状是无版本字段的 `MobileVerdict`。
 * 这批用例钉住三件事：
 *
 * 1. **同一次决策的两个投影**：`tone`/`reasons` 直接来自 `MobileVerdict`，
 *    不是第二次计算；改文案不影响 `action`/`tone`/`codes`。
 * 2. **`action` 来自决策自己报告的分支**（`CoachPlanDisposition`），不是比较课型倒推。
 * 3. **`action` 为 null 是刻意且唯一被允许的"表达不了"**：六值枚举覆盖不了
 *    "今天没有已保存的计划"，此时必须给 `no_stored_plan_today` 而不是硬填一个值。
 */

const base = (): CoachInput => ({
  today: "2026-09-03",
  latestDataDate: "2026-09-03",
  recoveryEvidenceDate: "2026-09-03",
  recoveryEvidenceStatus: "valid",
  calibration: "completed",
  eligibleSessions: 20,
  trueAbility: 44,
  currentAbility: 43.5,
  changeFrom7DaysAgo: 0.2,
  growthVelocityPerWeek: 0.1,
  decayPoints: 0,
  snapshotDate: "2026-09-03",
  explanationCodes: [],
  trainingStatus: "effective_stimulus",
  loadRatio: 1.05,
  rampRate: 0.1,
  strain: 40,
  strainP90: 80,
  monotony: 1.2,
  recoveryEvidence: 0.7,
  lastNightSleepMinutes: 420,
  sleepBaselineMinutes: 430,
  nightsBelowSleepBaseline: 0,
  morningHrvMs: 50,
  hrvBaselineMs: 52,
  restingHeartRateBpm: 52,
  restingHeartRateBaselineBpm: 53,
  consecutiveQualityDays: 0,
  daysSinceLastRun: 1,
  daysSinceLastQuality: 3,
  weekDistanceKm: 18,
  weekDurationSeconds: 7200,
  weekEasyDurationSeconds: 5400,
  weekQualityCount: 0,
  weeklyDistanceGoalKm: 30,
  easyDurationFloorFraction: 0.7,
  qualitySessionCap: 2,
  fourWeekDistanceChangeFraction: 0.1,
  previousWeekDistanceKm: 20,
  currentWeekDistanceKm: 18,
  longestRun8WeekKm: 16,
  latestLongRunKm: 14,
  intendedEasyCount: 3,
  easyEnoughCount: 3,
  latestWorkout: null,
  todayWorkoutCount: 0,
  storedWeekPlan: [],
  lockedSession: null,
  zones: {
    easyPaceLower: 330, easyPaceUpper: 390,
    easyHrLower: 120, easyHrUpper: 145,
    thresholdPaceLower: 270, thresholdPaceUpper: 300,
    thresholdHrLower: 160, thresholdHrUpper: 172,
    intervalPaceLower: 240, intervalPaceUpper: 265
  },
  raceTarget: null,
  raceShapeScore: 0.6,
  raceVolumeFraction: 0.7,
  raceLongRunFraction: 0.8,
  weekDaily: []
});

const signal = (name: "sleep" | "hrv" | "rhr") => ({
  name, value: 8, baseline: 8, ratio: 1, low: false,
  quality: "adequate" as const, observedAt: "2026-09-03T00:00:00.000Z",
  availableAt: "2026-09-03T00:00:00.000Z", evidenceLocalDate: "2026-09-03"
});

const readiness = (over: Partial<ReadinessAssessmentResult> = {}): ReadinessAssessmentResult => ({
  modelVersion: "rai-readiness-v1.0.0",
  asOf: "2026-09-03T15:59:59.999Z",
  localDate: "2026-09-03",
  coverage: "complete",
  assessment: "no_low_signal",
  state: "no_low_signal",
  stateEvidence: {
    method: "heuristic_rules",
    validationStatus: "not_empirically_validated",
    ruleSetVersion: "rai-readiness-ruleset-v1",
    validationTarget: null,
    validationReportId: null
  },
  intendedUse: "training_guidance_not_diagnosis",
  score: null,
  scoreStatus: "not_calibrated",
  signals: { sleep: signal("sleep"), hrv: signal("hrv"), rhr: signal("rhr") },
  sleepStreak: false,
  reasonCodes: [],
  ...over
});

/** 走真实路径：同一次决策 → (legacy 投影, V2 投影)。 */
function project(input: CoachInput) {
  const verdict = decideVerdict(input);
  const { session, disposition } = decideNextSessionDecision(input, verdict);
  return {
    verdict,
    session,
    disposition,
    decision: projectCoachDecisionV2({
      context: input, verdict, disposition, sessionKind: session.kind, readiness: readiness()
    })
  };
}

test("C01: the V2 output is a projection of the same decision, not a second computation", () => {
  const { verdict, decision } = project(base());
  assert.equal(decision.version, COACH_MODEL_VERSION);
  assert.equal(decision.tone, verdict.tone, "tone 必须与 legacy 投影逐字相同");
  // reasons 是 triggers 的翻译，不是另一套代码。
  for (const trigger of verdict.triggers) {
    assert.ok(decision.reasons.some((reason) => reason.code === trigger.code), trigger.code);
  }
});

test("C01: the projection never reads display text — only tone, codes and triggers", () => {
  // 两个 verdict 只在**文案**上不同；V2 输出必须逐字相同。
  const { verdict, session, disposition } = project(base());
  const rewritten = {
    ...verdict,
    title: "完全不同的标题",
    reason: "完全不同的理由",
    triggers: verdict.triggers.map((item) => ({ ...item, detail: "改写过的 detail" }))
  };
  const a = projectCoachDecisionV2({ context: base(), verdict, disposition, sessionKind: session.kind, readiness: readiness() });
  const b = projectCoachDecisionV2({ context: base(), verdict: rewritten, disposition, sessionKind: session.kind, readiness: readiness() });
  assert.deepEqual(b, a, "换语言不得改变 action/tone/codes");
});

test("C01: a day with no stored plan reports action=null instead of stretching the enum", () => {
  const { verdict, disposition, decision } = project(base()); // storedWeekPlan: []
  assert.equal(disposition, "no_stored_plan");
  assert.equal(decision.action, null, "六值里没有一个是'今天没有计划'");
  assert.ok(decision.reasons.some((reason) => reason.code === "no_stored_plan_today"));
  assert.ok(decision.reasons.some((reason) => reason.code === "plan_disposition_no_stored_plan"));
  // tone 仍然照常给出：没有计划不等于没有判断。
  assert.equal(decision.tone, verdict.tone);
});

test("C01: keeping a stored plan reports keep_plan without re-deriving it", () => {
  const input: CoachInput = {
    ...base(),
    recoveryEvidenceStatus: "valid",
    trainingStatus: "effective_stimulus",
    storedWeekPlan: [{ localDate: "2026-09-03", kind: "easy", reason: null, distanceKm: 8, structure: null }]
  };
  const { verdict, session, disposition, decision } = project(input);
  if (verdict.tone === "green" || verdict.tone === "yellow") {
    // 计划是 easy，不是质量课，所以不会被降阶 ⇒ 保留。
    assert.equal(disposition, "kept_stored_plan");
    assert.equal(decision.action, "keep_plan");
    assert.equal(session.kind, "easy");
  }
});

test("C01: an insufficient-data verdict maps to collect_evidence, not to a plan action", () => {
  // 校准未完成 ⇒ decideVerdict 必然打 insufficient_data 触发器。
  const input: CoachInput = { ...base(), calibration: "calibrating" };
  const { verdict, decision } = project(input);
  assert.ok((verdict.reasonCodes ?? []).includes("insufficient_data"));
  assert.equal(decision.action, "collect_evidence");
});

test("C01: every disposition maps to a declared action, and null is reserved for one case", () => {
  const dispositions: CoachPlanDisposition[] = [
    "no_stored_plan", "kept_stored_plan", "stored_rest_kept", "race_day_blank",
    "downgraded_quality", "downgraded_taper", "downgraded_red_tone",
    "budget_limited", "budget_exhausted"
  ];
  const verdict = decideVerdict(base());
  const seen = new Set<string | null>();
  for (const disposition of dispositions) {
    for (const sessionKind of ["rest", "recovery", "easy", "long_run", "tempo", "interval"] as const) {
      const decision = projectCoachDecisionV2({
        context: base(), verdict, disposition, sessionKind, readiness: readiness()
      });
      // 每个分支都必须给出一个**已声明**的取值（或那个唯一的 null）。
      assert.ok(
        decision.action === null || [
          "keep_plan", "reduce_intensity", "reduce_duration", "easy_only", "rest", "collect_evidence"
        ].includes(decision.action),
        `${disposition}/${sessionKind} → ${String(decision.action)}`
      );
      if (disposition === "no_stored_plan") assert.equal(decision.action, null);
      else assert.notEqual(decision.action, null, `${disposition} 不该是 null`);
      seen.add(decision.action);
    }
  }
  // 枚举被真正用满，而不是所有分支塌缩到一两个值。
  assert.ok(seen.size >= 4, `只用到 ${seen.size} 个 action`);
});

test("C01: inputSnapshotIds carry real identities and never an empty placeholder", () => {
  const { session, disposition, verdict } = project(base());
  const decision = projectCoachDecisionV2({
    context: base(), verdict, disposition, sessionKind: session.kind, readiness: readiness()
  });
  assert.deepEqual(decision.inputSnapshotIds, [
    "readiness:rai-readiness-v1.0.0@2026-09-03T15:59:59.999Z",
    "readiness_ruleset:rai-readiness-ruleset-v1",
    "fitness:2026-09-03"
  ]);
  for (const id of decision.inputSnapshotIds) assert.notEqual(id.trim(), "");
  // 没有发布记录时是显式占位，不是编造的 id。
  assert.equal(decision.bundleId, "no_active_release_bundle");
  // readiness 缺席时不写空串：那一类直接不出现。
  const withoutReadiness = projectCoachDecisionV2({
    context: base(), verdict, disposition, sessionKind: session.kind, readiness: null
  });
  assert.deepEqual(withoutReadiness.inputSnapshotIds, ["fitness:2026-09-03"]);
});

/** 只保留决策合同里允许的字段；恢复原始读数一律由调用方剔除（§13.1）。 */
function snapshotContext(input: CoachInput) {
  const {
    lastNightSleepMinutes: _sleep, sleepBaselineMinutes: _sleepBaseline,
    morningHrvMs: _hrv, hrvBaselineMs: _hrvBaseline,
    restingHeartRateBpm: _rhr, restingHeartRateBaselineBpm: _rhrBaseline,
    nightsBelowSleepBaseline: _nights, recoveryEvidenceDate: _date,
    recoveryEvidenceStatus: _status,
    ...context
  } = input;
  return context;
}

test("C01: the snapshot entry path is the one that produces the versioned decision", () => {
  // §13.1：快照入口下，决策只看 readiness，不看原始恢复读数。
  const input = base();
  const context = snapshotContext(input);
  const verdict = decideVerdictFromSnapshots(context, readiness());
  // 处方仍然拿完整 input —— 与生产接线一致（mobile-read.ts:306-307）。
  const { session, disposition } = decideNextSessionDecision(input, verdict);
  const decision = projectCoachDecisionV2({
    context: input, verdict, disposition, sessionKind: session.kind, readiness: readiness()
  });
  assert.equal(decision.tone, verdict.tone);
  assert.equal(decision.version, COACH_MODEL_VERSION);
  // 包装函数与成对函数必须给出同一个处方 —— 这是"接线没改行为"的断言。
  assert.deepEqual(decideNextSession(input, verdict), session);
});

/**
 * 下面两条是 2026-09-30 那次 829,440 组输入扫描**查出来的自相矛盾**，各留一条回归：
 * 修好之前它们分别是"比赛日无计划却不说没计划"和"处方式休息却说缩短时长"。
 */

test("C01: a race day with no stored plan still says no plan was stored", () => {
  const input: CoachInput = { ...base(), raceTarget: { date: "2026-09-03", distance: "half_marathon" } as CoachInput["raceTarget"] };
  const { session, disposition, decision } = project(input);
  assert.equal(disposition, "race_day_blank");
  assert.equal(session.kind, "rest");
  // 比赛日保留的是"比赛"这份承诺，所以是 keep_plan……
  assert.equal(decision.action, "keep_plan");
  // ……但"没有已保存周计划"这个事实必须照样说出来，不能因为 action 非 null 就消失。
  assert.ok(decision.reasons.some((reason) => reason.code === "no_stored_plan_today"));
});

test("C01: a budget-exhausted rest is labelled rest, not reduce_duration", () => {
  // 扫描的现场：周预算已用完 ⇒ 处方是"本周预算已完成"的**休息**，
  // 而修好之前这里一律映射成 reduce_duration —— 处方式休息却说"缩短时长"。
  const input: CoachInput = { ...base(), weekDistanceKm: 30, weeklyDistanceGoalKm: 30 };
  const verdict = decideVerdict(input);
  const { session, disposition } = decideNextSessionDecision(input, verdict);
  assert.equal(disposition, "budget_exhausted");
  assert.equal(session.kind, "rest");
  const decision = projectCoachDecisionV2({
    context: input, verdict, disposition, sessionKind: session.kind, readiness: readiness()
  });
  assert.equal(decision.action, "rest", "处方式休息不能报成缩短时长");
  // 该分支没有已保存计划，事实照样要说出来。
  assert.ok(decision.reasons.some((reason) => reason.code === "no_stored_plan_today"));
});

test("C01: evidence insufficiency does not pre-empt the plan outcome", () => {
  // 修好之前 collect_evidence 被放在最前面，吞掉了 483,840/829,440 组，
  // 其中包括 161,280 个"比赛日留白" —— 对比赛日说"去收集证据"是错的指令。
  const raceDay: CoachInput = {
    ...base(), calibration: "calibrating",
    raceTarget: { date: "2026-09-03", distance: "half_marathon" } as CoachInput["raceTarget"]
  };
  const verdict = decideVerdict(raceDay);
  const { session, disposition } = decideNextSessionDecision(raceDay, verdict);
  const decision = projectCoachDecisionV2({
    context: raceDay, verdict, disposition, sessionKind: session.kind, readiness: readiness()
  });
  assert.equal(disposition, "race_day_blank");
  assert.equal(decision.action, "keep_plan", "比赛日的动作不该被证据不足改写");
  // 证据不足仍然如实留在 reasons 里，只是不再冒充"动作"。
  assert.ok(decision.reasons.some((reason) => reason.code === "insufficient_data"));
});
