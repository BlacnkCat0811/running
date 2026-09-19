import type { SpeedSample } from "../src/speed-windows.js";

/** Frozen reference implementation: intentionally slow, test-only. */
export function referenceSpeedWindow(samples: readonly SpeedSample[], start: number, end: number) {
  return summarizeValidSpeedWindow(filterValidSpeedSamples(samples), start, end);
}

export function filterValidSpeedSamples(samples: readonly SpeedSample[]) {
  return samples.filter((sample) =>
    Number.isFinite(sample.value) && sample.value > 0 &&
    Number.isFinite(sample.startOffsetSeconds) && sample.startOffsetSeconds >= 0 &&
    Number.isFinite(sample.durationSeconds) && sample.durationSeconds > 0
  );
}

export function summarizeValidSpeedWindow(valid: readonly SpeedSample[], start: number, end: number) {
  const overlaps = valid.flatMap((sample) => {
    const first = Math.max(start, sample.startOffsetSeconds);
    const last = Math.min(end, sample.startOffsetSeconds + sample.durationSeconds);
    return last > first ? [{ start: first, end: last, value: sample.value }] : [];
  });
  const boundaries = [...new Set(overlaps.flatMap((sample) => [sample.start, sample.end]))].sort((a, b) => a - b);
  let weightedValue = 0, coveredSeconds = 0;
  for (let index = 1; index < boundaries.length; index++) {
    const first = boundaries[index - 1]!, last = boundaries[index]!;
    const active = overlaps.filter((sample) => sample.start < last && sample.end > first);
    if (!active.length) continue;
    weightedValue += (active.reduce((sum, sample) => sum + sample.value, 0) / active.length) * (last - first);
    coveredSeconds += last - first;
  }
  return { weightedValue, coveredSeconds };
}

