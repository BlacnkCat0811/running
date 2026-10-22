import type { ImportJobPerformance, ImportStage } from "@rai/api-contracts";

/** Monotonic wall time, including child execution; never includes health data. */
export class ImportPerformanceTracker {
  private readonly startedAt: number;
  private readonly stagesMs: Partial<Record<ImportStage, number>> = {};
  validationMode: ImportJobPerformance["validationMode"] = "not-run";

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  async measure<T>(stage: ImportStage, operation: () => T | Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await operation();
    } finally {
      this.stagesMs[stage] = (this.stagesMs[stage] ?? 0) + Math.max(0, this.now() - start);
    }
  }

  /**
   * 记一段**在别处测量**的耗时（WP-41 / O12 步骤 7）。
   *
   * 为什么需要它：两条导入车道现在跑在**同一个** worker 任务里，主线程只看到"投递一次、
   * 拿回两条车道的耗时 + 实际执行过的车道序列"。如果这里只能 `measure(闭包)`，主线程就
   * 只能用"等任务返回"当作两条车道的耗时（两次尝试糊成一段，正是本次要拆开的东西），
   * 或者回退成"在别处测的 0 ms"——那会让账本撒谎。
   *
   * 口径与 {@link measure} 完全一致：同名阶段累加、非正数/非有限值不落账（避免把
   * "没跑"写成"跑了 0 ms"），并且**不**改 `totalMs`（总时长始终由 tracker 自己的时钟定）。
   */
  record(stage: ImportStage, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.stagesMs[stage] = (this.stagesMs[stage] ?? 0) + milliseconds;
  }

  snapshot(): ImportJobPerformance {
    return {
      validationMode: this.validationMode,
      totalMs: Math.max(0, this.now() - this.startedAt),
      stagesMs: { ...this.stagesMs }
    };
  }
}
