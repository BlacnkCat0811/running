/** Coalesce UI progress only; calculation writes and cancellation are untouched. */
export class RecomputeProgressGate {
  private previous: { jobId: string; phase: string; current: number; total: number; at: number } | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  shouldPublish(jobId: string, phase: string, current: number, total: number): boolean {
    const at = this.now();
    const previous = this.previous;
    if (previous && previous.jobId === jobId && previous.phase === phase &&
        previous.total === total && current > previous.current &&
        current < total && at - previous.at < 250) return false;
    this.previous = { jobId, phase, current, total, at };
    return true;
  }
}
