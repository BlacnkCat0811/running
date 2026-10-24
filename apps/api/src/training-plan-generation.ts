import { PlanOperationError } from "./plan-publication.js";
import type { PreparedTrainingPlan, TrainingPlanRefreshDeps } from "./training-plan-commands.js";
import type { TrainingPlanState } from "./training-plan-store.js";

/** Stable facts are publishable only after their updating task has finished. */
export function assertTrainingFactsReady(publicationReady: () => boolean): void {
  if (!publicationReady()) {
    throw new PlanOperationError("coach_sync_pending", "训练事实正在更新，请完成后重新读取并刷新。");
  }
}

/** The same bounded generation lane serves commands, refresh and coordinator. */
export function trainingPlanGenerationDeps<Snapshot extends { fingerprint: string }>(deps: {
  publicationReady: () => boolean;
  snapshot: () => Snapshot;
  dataVersion: () => string;
  generate: (snapshot: Snapshot, state: TrainingPlanState) => Promise<Omit<PreparedTrainingPlan, "fingerprint">>;
  tryAcquire: () => (() => void) | null;
}): TrainingPlanRefreshDeps {
  // Capture the physical database/version before reading inputs. Sampling after
  // await would attach a new fact version to a plan made from old facts.
  const capture = () => {
    assertTrainingFactsReady(deps.publicationReady);
    const version = deps.dataVersion();
    const snapshot = deps.snapshot();
    if (deps.dataVersion() !== version) {
      throw new PlanOperationError("training_snapshot_changed", "训练事实在读取期间变化，请重新读取。", 409);
    }
    assertTrainingFactsReady(deps.publicationReady);
    return { snapshot, fingerprint: `${snapshot.fingerprint}:${version}` };
  };
  return {
    fingerprint: () => capture().fingerprint,
    prepare: async state => {
      assertTrainingFactsReady(deps.publicationReady);
      const release = deps.tryAcquire();
      if (!release) throw new PlanOperationError("weekly_plan_generation_busy", "课表正在生成，请稍后重试", 409);
      try {
        const { snapshot, fingerprint } = capture();
        const result = await deps.generate(snapshot, state);
        assertTrainingFactsReady(deps.publicationReady);
        if (result.days.length === 0) {
          throw new PlanOperationError("training_plan_empty", "未生成有效课表；原计划保持不变。", 422);
        }
        return { ...result, fingerprint };
      } finally { release(); }
    }
  };
}
