// 阶段 2 follow-up B：hot-only 窗口基线/候选对比（D3 用；D2 的完整状态对比见 phase2-series-cache-compare）。
//
// 性能裁决只看原始样本：共享模块从 `samples[].ms` 重算 P95，并核对证据里声明的
// p50/p95/min/max/mean。声明值被篡改时窗口标记为“不可评估”，总裁决失败。
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { compareHotWindows } from "./phase2-series-hot-verdict.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const baseline = JSON.parse(readFileSync(readArg("--baseline"), "utf8"));
const candidate = JSON.parse(readFileSync(readArg("--candidate"), "utf8"));
const dataset = readArg("--dataset", "D3");
const out = readArg("--json");
if (!out || !isAbsolute(out)) {
  console.error("usage: --baseline --candidate --dataset D2|D3 --json <absolute> [--allow-legacy-window-mapping]");
  process.exit(2);
}
// 只用于只读复核旧 JSON：旧证据没有选窗元数据，窗口名无法验证，会在
// windowMappingVerified=false 与 warnings 中明确记录，不会伪装成已验证。
const allowLegacyWindowMapping = args.includes("--allow-legacy-window-mapping");

const comparison = compareHotWindows(baseline, candidate, { allowLegacyWindowMapping });
const verdict = {
  ok: comparison.failures.length === 0,
  dataset,
  generatedAt: new Date().toISOString(),
  hotWindowsEvaluable: comparison.evaluable,
  windowTimelineVerified: comparison.windowTimelineVerified,
  windowMappingVerified: comparison.windowMappingVerified,
  windows: comparison.windows,
  warnings: comparison.warnings,
  failures: comparison.failures
};
writeFileSync(out, `${JSON.stringify(verdict, null, 2)}\n`);
console.log(JSON.stringify(verdict, null, 2));
if (!verdict.ok) process.exitCode = 1;
