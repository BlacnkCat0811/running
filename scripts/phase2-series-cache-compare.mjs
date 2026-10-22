// 阶段 2 follow-up B：把 baseline / candidate 的 HTTP 首读证据合成机器 verdict。
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { compareHotWindows } from "./phase2-series-hot-verdict.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const baselinePath = readArg("--baseline");
const candidatePath = readArg("--candidate");
const dataset = readArg("--dataset", "D2");
const out = readArg("--json");
const hotOnly = args.includes("--hot-only");
if (!baselinePath || !candidatePath || !out || !isAbsolute(out)) {
  console.error("usage: phase2-series-cache-compare.mjs --baseline <json> --candidate <json> --dataset D2|D3 --json <absolute-out> [--hot-only] [--allow-legacy-window-mapping]");
  process.exit(2);
}
// 只用于只读复核旧 JSON；新证据必须携带选窗元数据。
const allowLegacyWindowMapping = args.includes("--allow-legacy-window-mapping");
const baseline = JSON.parse(readFileSync(resolve(baselinePath), "utf8"));
const candidate = JSON.parse(readFileSync(resolve(candidatePath), "utf8"));
const failures = [];
const states = hotOnly ? [] : Object.keys(candidate.states ?? {});
if (!hotOnly && states.length === 0) failures.push({ code: "missing_states", detail: "candidate has no states" });
if (!hotOnly && Object.keys(baseline.states ?? {}).length !== states.length) failures.push({ code: "state_mismatch", detail: "baseline/candidate state sets differ" });

const perState = {};
for (const state of states) {
  const base = baseline.states?.[state];
  const next = candidate.states?.[state];
  if (!base || !next) {
    failures.push({ code: "missing_state", detail: state });
    continue;
  }
  const bodyEqual = base.samples.length === next.samples.length
    && base.samples.every((sample, index) => sample.firstSeries.bodySha256 === next.samples[index]?.firstSeries.bodySha256);
  const secondEqual = base.samples.length === next.samples.length
    && base.samples.every((sample, index) => sample.secondSeries.bodySha256 === next.samples[index]?.secondSeries.bodySha256);
  if (!bodyEqual) failures.push({ code: "body_diff", detail: `${state}: first /series body differs from baseline` });
  if (!secondEqual) failures.push({ code: "body_diff", detail: `${state}: second /series body differs from baseline` });
  if (next.firstSeries.samples !== candidate.cycles) failures.push({ code: "sample_count", detail: `${state}: ${next.firstSeries.samples}` });
  if (next.statuses.some((status) => status !== 200)) failures.push({ code: "status", detail: `${state}: ${next.statuses.join(",")}` });
  if (next.serverErrors !== 0) failures.push({ code: "server_error", detail: `${state}: ${next.serverErrors}` });
  const eventLoopPass = next.eventLoopP95Ms.p95 <= 50 && next.eventLoopMaxMs.max <= 1000;
  const healthPass = next.concurrentHealth.p95 <= 50;
  if (!eventLoopPass) failures.push({ code: "event_loop_p95", detail: `${state}: ${next.eventLoopP95Ms.p95.toFixed(2)}ms > 50ms` });
  if (!healthPass) failures.push({ code: "health_p95", detail: `${state}: ${next.concurrentHealth.p95.toFixed(2)}ms > 50ms` });
  if (dataset === "D2" && next.firstSeries.p95 > 100) {
    failures.push({ code: "series_p95", detail: `${state}: first /series p95 ${next.firstSeries.p95.toFixed(2)}ms > 100ms` });
  }
  const rssGrowth = (next.rssBytes.end ?? 0) - (next.rssBytes.start ?? 0);
  if (rssGrowth > 64 * 1024 * 1024) failures.push({ code: "rss_growth", detail: `${state}: ${(rssGrowth / 1048576).toFixed(1)} MiB` });
  perState[state] = {
    firstSeries: next.firstSeries,
    concurrentHealth: next.concurrentHealth,
    secondSeries: next.secondSeries,
    eventLoopP95Ms: next.eventLoopP95Ms,
    eventLoopMaxMs: next.eventLoopMaxMs,
    bodyEqual,
    secondEqual,
    eventLoopPass,
    healthPass,
    rssBytes: next.rssBytes,
    rssGrowthBytes: rssGrowth
  };
}

const hotComparison = compareHotWindows(baseline, candidate, { allowLegacyWindowMapping });
failures.push(...hotComparison.failures);
const hotWindows = hotComparison.windows;

const verdict = {
  ok: failures.length === 0,
  dataset,
  generatedAt: new Date().toISOString(),
  cycles: candidate.cycles,
  blocks: candidate.blocks,
  states: perState,
  hotWindowsEvaluable: hotComparison.evaluable,
  windowTimelineVerified: hotComparison.windowTimelineVerified,
  windowMappingVerified: hotComparison.windowMappingVerified,
  hotWindows,
  warnings: hotComparison.warnings,
  failures
};
writeFileSync(out, `${JSON.stringify(verdict, null, 2)}\n`);
console.log(JSON.stringify({ ok: verdict.ok, dataset, states: Object.fromEntries(Object.entries(perState).map(([state, value]) => [state, {
  firstP95: value.firstSeries.p95, healthP95: value.concurrentHealth.p95, secondP95: value.secondSeries.p95,
  eventLoopP95: value.eventLoopP95Ms.p95, bodyEqual: value.bodyEqual
}])), hotWindows, hotWindowsEvaluable: verdict.hotWindowsEvaluable, windowTimelineVerified: verdict.windowTimelineVerified, windowMappingVerified: verdict.windowMappingVerified, warnings: verdict.warnings, failures: verdict.failures }, null, 2));
if (!verdict.ok) process.exitCode = 1;
