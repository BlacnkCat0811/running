import assert from "node:assert/strict";
import test from "node:test";
import { SpeedWindows, type SpeedSample } from "../src/speed-windows.js";

import { referenceSpeedWindow } from "./speed-window-reference.js";

test("speed window sweep exactly matches reference arithmetic for unsorted overlaps and clipping", () => {
  let state = 812_031;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let trial = 0; trial < 180; trial++) {
    const samples = Array.from({ length: 5 + Math.floor(random() * 150) }, () => ({
      value: random() * 8 + 0.01,
      startOffsetSeconds: Math.floor(random() * 1200) / 10,
      durationSeconds: random() * 10 + 0.01
    }));
    const windows = new SpeedWindows(samples);
    for (let query = 0; query < 35; query++) {
      const start = Math.floor(random() * 1200) / 10 - 5;
      const end = start + random() * 75;
      assert.deepEqual(windows.summarize(start, end), referenceSpeedWindow(samples, start, end),
        `trial=${trial} window=[${start},${end}]`);
    }
  }
});

test("speed sweep keeps duplicates, gaps, event boundaries and exceptional floating values", () => {
  const samples = [
    { value: 0.1, startOffsetSeconds: -0, durationSeconds: 0.3 },
    { value: 0.2, startOffsetSeconds: 0.1, durationSeconds: 0.2 },
    { value: 0.1, startOffsetSeconds: 0, durationSeconds: 0.3 },
    { value: 1e308, startOffsetSeconds: 60, durationSeconds: 10 },
    { value: 1e308, startOffsetSeconds: 65, durationSeconds: 10 },
    { value: 3, startOffsetSeconds: 100, durationSeconds: 10 },
    { value: 4, startOffsetSeconds: 1e308, durationSeconds: 1e308 },
    { value: 4, startOffsetSeconds: 1e20, durationSeconds: 1 },
    { value: NaN, startOffsetSeconds: 0, durationSeconds: 50 },
    { value: 3, startOffsetSeconds: -1, durationSeconds: 50 },
    { value: 3, startOffsetSeconds: 0, durationSeconds: Infinity }
  ];
  const windows = new SpeedWindows(samples);
  for (const [start, end] of [[0, 0.3], [0.1, 0.3], [0, 60], [60, 90], [10, 50], [10, 10],
    [-5, 30], [100, 105], [NaN, 1], [0, NaN], [0, Infinity], [1e308, Infinity]]) {
    assert.deepEqual(windows.summarize(start!, end!), referenceSpeedWindow(samples, start!, end!));
  }
});

test("ordinary one-Hz samples require one construction visit per sample instead of repeated scans", () => {
  const count = 7200;
  const samples = Array.from({ length: count }, (_, i) => ({ value: 2.3 + i % 9 / 10, startOffsetSeconds: i, durationSeconds: 1 }));
  const windows = new SpeedWindows(samples);
  assert.equal(windows.segmentCount, count);
  assert.equal(windows.constructionValueVisits, count);
  for (let start = 0; start < count; start += 60) {
    assert.deepEqual(windows.summarize(start, start + 60), referenceSpeedWindow(samples, start, start + 60));
  }
});
