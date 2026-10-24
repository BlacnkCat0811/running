// 阶段 6 停止条件：把 protocol.stopRules 变成可在运行中执行的纯逻辑。
//
// runner 在 driver 跑起来后持续喂入资源采样与健康探测结果；这里不读取
// 进程/文件，只维护窗口状态并返回第一个触发项，便于负例测试。
//
// 口径：
//   · memoryAboveRatioOfMax：持续超过 memory.max 的 ratio 达 sustainedSeconds 才停止；
//     任一次低于阈值会重置窗口。没有 memory.max 时不假装有内存上限。
//   · healthTimeout：连续 consecutive 次探测超时/失败才停止；一次成功即清零。
//   · diskSafetyMarginBytes：可用空间低于冻结余量立即停止。
//   · pathOrIdentityMismatch / unexpectedOomOrWatchdogRestart：出现即停止。

export function createStopRuleTracker({ rules = {}, memoryMaxBytes = null, expectedCgroup = null, now = () => Date.now() } = {}) {
  const ratioRule = rules.memoryAboveRatioOfMax ?? null;
  const memoryRatio = Number(ratioRule?.ratio ?? 0.9);
  const memorySustainedMs = Math.max(0, Number(ratioRule?.sustainedSeconds ?? 10) * 1000);
  const healthRule = rules.healthTimeout ?? null;
  const healthConsecutive = Math.max(1, Number(healthRule?.consecutive ?? 3));
  const diskMarginBytes = Math.max(0, Number(rules.diskSafetyMarginBytes ?? 0));
  let memoryAboveSinceMs = null;
  let healthFailureCount = 0;
  let lastHealth = null;

  const violation = (rule, detail) => ({ rule, detail, at: new Date().toISOString() });

  return {
    observeResource(sample) {
      if (sample === null || typeof sample !== "object") return null;
      if (Array.isArray(sample.escapedPids) && sample.escapedPids.length > 0) {
        return violation("pathOrIdentityMismatch", `escaped PIDs observed: ${sample.escapedPids.join(",")}`);
      }
      if (expectedCgroup !== null && sample.cgroupAttribution?.target !== undefined
          && sample.cgroupAttribution.target !== expectedCgroup) {
        return violation("pathOrIdentityMismatch",
          `target cgroup ${String(sample.cgroupAttribution.target)} != expected ${expectedCgroup}`);
      }
      const oomKillDelta = Number(sample.memoryEventsDelta?.oom_kill ?? 0);
      if (Number.isFinite(oomKillDelta) && oomKillDelta > 0) {
        return violation("unexpectedOomOrWatchdogRestart", `memory.events oom_kill increased by ${oomKillDelta}`);
      }

      const currentBytes = Number(sample.cgroup?.memoryCurrentBytes ?? sample.rssBytes ?? NaN);
      const maximumBytes = Number(memoryMaxBytes ?? sample.cgroup?.memoryMaxBytes ?? NaN);
      if (Number.isFinite(currentBytes) && Number.isFinite(maximumBytes) && maximumBytes > 0) {
        const atMs = now();
        if (currentBytes > maximumBytes * memoryRatio) {
          if (memoryAboveSinceMs === null) memoryAboveSinceMs = atMs;
          if (atMs - memoryAboveSinceMs >= memorySustainedMs) {
            return violation("memoryAboveRatioOfMax",
              `memory ${currentBytes} > ${memoryRatio} * ${maximumBytes} for ${atMs - memoryAboveSinceMs} ms`);
          }
        } else {
          memoryAboveSinceMs = null;
        }
      }

      const availableKiB = sample.disk?.availableKiB;
      const availableBytes = availableKiB === null || availableKiB === undefined
        ? NaN : Number(availableKiB) * 1024;
      if (diskMarginBytes > 0 && Number.isFinite(availableBytes) && availableBytes < diskMarginBytes) {
        return violation("diskSafetyMargin", `disk available ${availableBytes} < safety margin ${diskMarginBytes}`);
      }
      return null;
    },

    observeHealth({ ok, timeout = false, status = null, error = null } = {}) {
      if (ok === true) {
        healthFailureCount = 0;
        lastHealth = { ok: true, status };
        return null;
      }
      healthFailureCount += 1;
      lastHealth = { ok: false, timeout, status, error };
      if (healthFailureCount >= healthConsecutive) {
        return violation("healthTimeout",
          `${healthFailureCount} consecutive health failures (last: ${timeout ? "timeout" : String(error ?? status)})`);
      }
      return null;
    },

    snapshot() {
      return { memoryAboveSinceMs, healthFailureCount, lastHealth };
    }
  };
}
