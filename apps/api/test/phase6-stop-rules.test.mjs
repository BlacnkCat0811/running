// 阶段 6 运行中停止条件：内存持续窗口、health 连续超时、磁盘余量与身份/oom。
import assert from "node:assert/strict";
import test from "node:test";

import { createStopRuleTracker } from "../../../scripts/phase6/stop-rules.mjs";

function tracker(overrides = {}) {
  let clock = 0;
  const instance = createStopRuleTracker({
    rules: {
      memoryAboveRatioOfMax: { ratio: 0.9, sustainedSeconds: 10 },
      healthTimeout: { consecutive: 3, eachMs: 5000 },
      diskSafetyMarginBytes: 2 * 1024 * 1024 * 1024,
      ...overrides.rules
    },
    memoryMaxBytes: 1000,
    now: () => clock,
    ...overrides
  });
  return { instance, setClock: (value) => { clock = value; } };
}

test("memory above 90% must stay above the threshold for 10 seconds before stopping", () => {
  const { instance, setClock } = tracker();
  const sample = { rssBytes: 950, cgroup: null, disk: { availableKiB: 10_000_000 } };
  setClock(1_000);
  assert.equal(instance.observeResource(sample), null);
  setClock(10_999);
  assert.equal(instance.observeResource(sample), null);
  setClock(11_000);
  const violation = instance.observeResource(sample);
  assert.equal(violation.rule, "memoryAboveRatioOfMax");
});

test("a memory sample below the ratio resets the sustained window", () => {
  const { instance, setClock } = tracker();
  setClock(0);
  assert.equal(instance.observeResource({ rssBytes: 950 }), null);
  setClock(5_000);
  assert.equal(instance.observeResource({ rssBytes: 500 }), null);
  setClock(9_000);
  assert.equal(instance.observeResource({ rssBytes: 950 }), null);
  setClock(18_999);
  assert.equal(instance.observeResource({ rssBytes: 950 }), null);
  setClock(19_000);
  assert.equal(instance.observeResource({ rssBytes: 950 }).rule, "memoryAboveRatioOfMax");
});

test("three consecutive health failures stop; one success resets the counter", () => {
  const { instance } = tracker();
  assert.equal(instance.observeHealth({ ok: false, timeout: true }), null);
  assert.equal(instance.observeHealth({ ok: false, timeout: true }), null);
  assert.equal(instance.observeHealth({ ok: true }), null);
  assert.equal(instance.observeHealth({ ok: false, timeout: true }), null);
  assert.equal(instance.observeHealth({ ok: false, status: 503 }), null);
  assert.equal(instance.observeHealth({ ok: false, timeout: true }).rule, "healthTimeout");
});

test("disk below the frozen safety margin stops immediately; an unreadable disk is not zero", () => {
  const { instance } = tracker();
  assert.equal(instance.observeResource({ rssBytes: 1, disk: { availableKiB: null } }), null);
  const violation = instance.observeResource({
    rssBytes: 1,
    disk: { availableKiB: Math.floor((2 * 1024 * 1024 * 1024 - 1) / 1024) }
  });
  assert.equal(violation.rule, "diskSafetyMargin");
});

test("escaped PID, cgroup identity mismatch and OOM kill are stop conditions", () => {
  const escaped = tracker();
  assert.equal(escaped.instance.observeResource({ escapedPids: [42] }).rule, "pathOrIdentityMismatch");

  const mismatch = tracker({ expectedCgroup: "/rai/phase6" });
  assert.equal(mismatch.instance.observeResource({
    cgroupAttribution: { target: "/other" }
  }).rule, "pathOrIdentityMismatch");

  const oom = tracker();
  assert.equal(oom.instance.observeResource({
    memoryEventsDelta: { oom_kill: 1 }
  }).rule, "unexpectedOomOrWatchdogRestart");
});
