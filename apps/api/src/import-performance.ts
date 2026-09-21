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

  snapshot(): ImportJobPerformance {
    return {
      validationMode: this.validationMode,
      totalMs: Math.max(0, this.now() - this.startedAt),
      stagesMs: { ...this.stagesMs }
    };
  }
}
