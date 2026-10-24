import type { CoachLoopSettings } from "@rai/api-contracts";
import { digest } from "./plan-digest.js";
import { resolveTrainingMode } from "./training-mode-policy.js";
import type { TrainingPlanState } from "./training-plan-store.js";

/** Settings evidence is immutable; unified owns the current pointer, goal and lifecycle. */
export function unifiedCoachSettings(state: TrainingPlanState, evidence: CoachLoopSettings, businessDate: string): CoachLoopSettings {
  // A past goal remains in unified history, but no longer restricts today's
  // execution to a programme whose race date has already passed.
  const goal = resolveTrainingMode({ raceGoal: state.raceGoal, businessDate }).mode === "race" ? state.raceGoal : null;
  return {
    ...evidence,
    status: state.sourceStatus === "ended" ? "ended" : state.runState,
    mode: goal === null ? "daily_adaptive" : "race_preparation",
    race: goal === null ? null : {
      ...(evidence.race ?? { runningDays: evidence.runningDays, longRunDays: evidence.longRunDays,
        targetType: evidence.targetType, strengthTraining: false }),
      goal: goal.goal, raceDate: goal.date, raceDistanceKm: goal.distanceKm, targetTimeSeconds: goal.targetTimeSeconds
    }
  };
}

export function raceGoalFromCoachSettings(settings: CoachLoopSettings,
  previous: TrainingPlanState["raceGoal"] = null): TrainingPlanState["raceGoal"] {
  if (settings.race === null || settings.mode === "daily_adaptive") return null;
  const race = settings.race;
  const id = previous?.date === race.raceDate && previous.distanceKm === race.raceDistanceKm
    ? previous.id : `goal-${digest({ date: race.raceDate, distanceKm: race.raceDistanceKm }).slice(0, 24)}`;
  return { id,
    date: race.raceDate!, distanceKm: race.raceDistanceKm!,
    goal: race.goal === "time" ? "time" : "finish", targetTimeSeconds: race.targetTimeSeconds };
}
