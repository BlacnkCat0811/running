// 阶段 6 F4：cgroup 读回的纯逻辑负例（模拟 /proc 与 /sys/fs/cgroup，不依赖 Linux）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  cgroupAttribution,
  cgroupDirectoryForPid,
  limitReadbackErrors,
  normalizeCgroupDirectory,
  parseCpuMax,
  parseIoStat,
  parseMemoryLimit,
  readCgroupSnapshot,
  readCgroupRelative
} from "../../../scripts/phase6/cgroup.mjs";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "phase6-cgroup-"));
  const procRoot = join(root, "proc");
  const cgroupRoot = join(root, "cgroup");
  const target = join(cgroupRoot, "rai", "phase6");
  const other = join(cgroupRoot, "observer");
  mkdirSync(join(procRoot, "123"), { recursive: true });
  mkdirSync(join(procRoot, "456"), { recursive: true });
  mkdirSync(join(procRoot, "789"), { recursive: true });
  mkdirSync(target, { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(procRoot, "123", "cgroup"), "0::/rai/phase6\n");
  writeFileSync(join(procRoot, "456", "cgroup"), "0::/rai/phase6\n");
  writeFileSync(join(procRoot, "789", "cgroup"), "0::/observer\n");
  const files = {
    "cpu.max": "150000 100000\n",
    "memory.current": "1000\n",
    "memory.peak": "2000\n",
    "memory.high": "1153433600\n",
    "memory.max": "1468006400\n",
    "memory.swap.max": "536870912\n",
    "pids.current": "4\n",
    "pids.max": "128\n",
    "memory.events": "low 0\nhigh 1\nmax 2\noom 0\noom_kill 0\n",
    "cpu.stat": "usage_usec 1000\nthrottled_usec 0\nnr_throttled 0\n",
    "io.stat": "8:0 rbytes=1 wbytes=2\n"
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(target, name), content);
  return { root, procRoot, cgroupRoot, target };
}

const expected = {
  cpuQuotaCores: 1.5, memoryHighBytes: 1153433600, memoryMaxBytes: 1468006400,
  swapMaxBytes: 536870912, tasksMax: 128
};

test("cpu.max 与 memory limits 解析为明确单位，缺失保持 null", () => {
  assert.deepEqual(parseCpuMax("150000 100000"), { raw: "150000 100000", quota: 150000, period: 100000, cores: 1.5 });
  assert.equal(parseCpuMax("max 100000").cores, null);
  assert.equal(parseCpuMax(null).cores, null);
  assert.equal(parseMemoryLimit("1153433600"), 1153433600);
  assert.equal(parseMemoryLimit("max"), null);
  assert.equal(parseMemoryLimit(null), null);
  assert.deepEqual(parseIoStat("8:0 rbytes=1 wbytes=2"), { "8:0": { rbytes: 1, wbytes: 2 } });
});

test("目标 PID cgroup 归属与逃逸 PID 被明确记录", () => {
  const { root, procRoot, cgroupRoot } = tree();
  try {
    assert.deepEqual(normalizeCgroupDirectory(join(cgroupRoot, "rai", "phase6"), cgroupRoot), {
      directory: realpathSync(join(cgroupRoot, "rai", "phase6")), relative: "/rai/phase6"
    });
    mkdirSync(join(root, "elsewhere"));
    assert.throws(() => normalizeCgroupDirectory(join(root, "elsewhere"), cgroupRoot), /must be a child/);
    const target = cgroupDirectoryForPid({ procRoot, cgroupRoot, pid: 123 });
    assert.equal(target.relative, "/rai/phase6");
    assert.equal(readCgroupRelative(procRoot, 789), "/observer");
    const attribution = cgroupAttribution({ procRoot, cgroupRoot, targetPid: 123, pids: [123, 456, 789] });
    assert.equal(attribution.target, "/rai/phase6");
    assert.deepEqual(attribution.escaped, [789]);
    assert.equal(attribution.processes.find((item) => item.pid === 456).matchesTarget, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("读回值与冻结限额逐项比较；缺失/改错给出具体字段", () => {
  const { root, target } = tree();
  try {
    const snapshot = readCgroupSnapshot(target);
    assert.equal(snapshot.cpuMaxCores, 1.5);
    assert.equal(snapshot.memoryHighBytes, 1153433600);
    assert.equal(snapshot.memoryMaxBytes, 1468006400);
    assert.equal(snapshot.memorySwapMaxBytes, 536870912);
    assert.equal(snapshot.pidsMax, 128);
    assert.deepEqual(limitReadbackErrors(snapshot, expected), []);

    writeFileSync(join(target, "cpu.max"), "100000 100000\n");
    writeFileSync(join(target, "memory.max"), "1\n");
    writeFileSync(join(target, "memory.swap.max"), "max\n");
    const errors = limitReadbackErrors(readCgroupSnapshot(target), expected);
    assert.ok(errors.some((error) => error.includes("cpu.max")));
    assert.ok(errors.some((error) => error.includes("memory.max")));
    assert.ok(errors.some((error) => error.includes("memory.swap.max")));

    rmSync(join(target, "memory.high"));
    assert.ok(limitReadbackErrors(readCgroupSnapshot(target), expected)
      .some((error) => error.includes("memory.high")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
