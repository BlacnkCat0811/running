/** Only interval geometry is cached. Preserve input-order floating-point sums. */
export interface SpeedSample {
  value: number;
  startOffsetSeconds: number;
  durationSeconds: number;
}
interface Segment { start: number; end: number; average: number }
interface Event { time: number; sample: number; start: boolean }

function lowerBound(values: readonly number[], value: number): number {
  let left = 0, right = values.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (values[middle]! < value) left = middle + 1;
    else right = middle;
  }
  return left;
}

export class SpeedWindows {
  private readonly segments: Segment[] = [];
  /** Useful for deterministic complexity tests; no timers in the hot loop. */
  readonly constructionValueVisits: number;

  constructor(samples: readonly SpeedSample[]) {
    const valid = samples.filter((sample) =>
      Number.isFinite(sample.value) && sample.value > 0 &&
      Number.isFinite(sample.startOffsetSeconds) && sample.startOffsetSeconds >= 0 &&
      Number.isFinite(sample.durationSeconds) && sample.durationSeconds > 0
    );
    const events: Event[] = [];
    for (const [index, sample] of valid.entries()) {
      const end = sample.startOffsetSeconds + sample.durationSeconds;
      if (end <= sample.startOffsetSeconds) continue; // positive durations can round to zero
      events.push({ time: sample.startOffsetSeconds, sample: index, start: true },
        { time: end, sample: index, start: false });
    }
    events.sort((a, b) => a.time - b.time);
    const active: number[] = [];
    let visits = 0;
    for (let index = 0; index < events.length;) {
      const time = events[index]!.time;
      do {
        const event = events[index++]!;
        const position = lowerBound(active, event.sample);
        if (event.start) active.splice(position, 0, event.sample);
        else active.splice(position, 1);
      } while (index < events.length && events[index]!.time === time);
      const end = events[index]?.time;
      if (end === undefined || end <= time || active.length === 0) continue;
      let sum = 0;
      // A running sum or balanced sum tree changes rounding (and thresholds).
      // Scan only active samples, in the same order as the reference algorithm.
      for (const sample of active) sum += valid[sample]!.value;
      visits += active.length;
      // Do not merge equal adjacent segments: that changes multiplication/addition order.
      this.segments.push({ start: time, end, average: sum / active.length });
    }
    this.constructionValueVisits = visits;
  }

  get empty(): boolean { return this.segments.length === 0; }
  get segmentCount(): number { return this.segments.length; }

  summarize(start: number, end: number): { weightedValue: number; coveredSeconds: number } {
    if (!(end > start)) return { weightedValue: 0, coveredSeconds: 0 };
    let left = 0, right = this.segments.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (this.segments[middle]!.end <= start) left = middle + 1;
      else right = middle;
    }
    let weightedValue = 0, coveredSeconds = 0;
    for (let i = left; i < this.segments.length; i++) {
      const segment = this.segments[i]!;
      if (segment.start >= end) break;
      const seconds = Math.min(segment.end, end) - Math.max(segment.start, start);
      if (seconds <= 0) continue;
      weightedValue += segment.average * seconds;
      coveredSeconds += seconds;
    }
    return { weightedValue, coveredSeconds };
  }
}
