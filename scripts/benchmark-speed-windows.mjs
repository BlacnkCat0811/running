import assert from "node:assert/strict";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { SpeedWindows } from "../packages/features/src/speed-windows.ts";
import { filterValidSpeedSamples, summarizeValidSpeedWindow } from "../packages/features/test/speed-window-reference.ts";

// Synthetic one-hour, 10 Hz stream. Timings include timeline construction.
const samples = Array.from({ length: 36000 }, (_, index) => ({
  value: 3 + Math.sin(index / 100) / 2,
  startOffsetSeconds: index / 10,
  durationSeconds: 0.1
}));
const queries = [60, 30].flatMap((size) =>
  Array.from({ length: 3600 / size }, (_, index) => [index * size, (index + 1) * size]));
const reference = () => {
  const valid = filterValidSpeedSamples(samples);
  return queries.map(([start, end]) => summarizeValidSpeedWindow(valid, start, end));
};
const optimized = () => {
  const windows = new SpeedWindows(samples);
  return queries.map(([start, end]) => windows.summarize(start, end));
};
assert.deepEqual(optimized(), reference());
const times = { reference: [], optimized: [] };
for (let run = 0; run < 5; run++) {
  const order = run % 2 ? ["optimized", "reference"] : ["reference", "optimized"];
  for (const name of order) {
    const start = performance.now();
    (name === "reference" ? reference : optimized)();
    times[name].push(performance.now() - start);
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const referenceMs = median(times.reference), optimizedMs = median(times.optimized);
console.log(JSON.stringify({
  scope: "Synthetic speed-window kernel only; not end-to-end import or N100 measurement",
  node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
  samples: samples.length, windows: queries.length, exactEquality: true,
  referenceMedianMs: referenceMs, optimizedMedianMs: optimizedMs,
  speedup: referenceMs / optimizedMs, runsMs: times
}, null, 2));
