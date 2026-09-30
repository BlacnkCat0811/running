import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAXIMUM_DISTANCE_MAE_REGRESSION,
  MINIMUM_HOLDOUT_PREDICTIONS,
  MINIMUM_MAE_IMPROVEMENT
} from "./prediction-model-service.js";
import { evaluateResidualChallengers, parseResidualChallengerFile } from "./prediction-challengers.js";

/**
 * 只读工具：把 Python runner 的 `challengers.json` 喂进统一的三方对比门槛。
 *
 * 不读数据库、不写任何状态、不激活模型。它的输出是"能不能发布候选"的证据，
 * 而不是发布动作本身 —— 发布仍走既有的 gate 与原子发布流程（§14.7）。
 */

function optionValue(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function main(): void {
  const args = process.argv.slice(2);
  // 先判"有没有给参数"，再判"这个路径存在吗"。
  // 原实现把两件事合成一句，`--challengers` 缺席时 `optionValue(..., "")` 让 `resolve("")`
  // 变成当前目录，守卫因为"目录存在"而放行，最终报出的是 EISDIR（见 2026-09-30 审计）。
  const rawPath = optionValue(args, "--challengers", "");
  if (rawPath.trim() === "") throw new Error("--challengers requires a path to a saved challengers JSON document");
  const path = resolve(rawPath);
  if (!existsSync(path)) throw new Error(`Challengers document not found: ${path}`);
  const minimumSamples = Number(optionValue(args, "--minimum-samples", String(MINIMUM_HOLDOUT_PREDICTIONS)));
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1) {
    throw new Error("--minimum-samples must be a positive integer");
  }
  const result = evaluateResidualChallengers({
    // 原始 JSON 直接交给评估函数：校验只在那里发生一次。
    document: parseResidualChallengerFile(path),
    policy: {
      minimumSamples,
      minimumImprovement: MINIMUM_MAE_IMPROVEMENT,
      maximumDistanceRegression: MAXIMUM_DISTANCE_MAE_REGRESSION
    }
  });
  // `result.status` 属于门槛本身（passed/failed/not_evaluable），所以外层判别键另起名字，
  // 不让报告类型盖掉门槛结论。
  console.log(JSON.stringify({ report: "residual_challenger_comparison", challengersPath: path, ...result }, null, 2));
}

main();
