// 分析输入**覆盖证明**的判据（O06-A / WP-22，决策 D4）。
//
// 为什么单独测它：`verifyAndPoint` 里"dataset 版本逐字相等"这条判据被它替代之后，
// 放宽的**唯一**依据就是这里返回的 `holds`。它错在"松"的一侧 ⇒ 旧计算会被当最新发布；
// 错在"紧"的一侧 ⇒ 正常批次被无故拒绝（老毛病）。两个方向都必须有对照用例钉住。
//
// 判据按 `@rai/contracts` 的原文：不确定性（NULL / 未知）一律按**不安全**处理。

import assert from "node:assert/strict";
import test from "node:test";

import {
  dependencyCoverageHolds,
  selectInterveningBatches,
  type BatchGenerationFacts
} from "../src/analysis-input-coverage.js";

const batch = (
  batchId: string,
  rawGeneration: number | null,
  dependencyGeneration: number | null,
  dependencyBumped: number | null
): BatchGenerationFacts => ({ batchId, rawGeneration, dependencyGeneration, dependencyBumped });

const verdict = (
  capturedRaw: number,
  capturedDependency: number,
  currentRaw: number,
  currentDependency: number,
  intervening: BatchGenerationFacts[]
) => dependencyCoverageHolds({
  capturedRawGeneration: capturedRaw,
  capturedDependencyGeneration: capturedDependency,
  currentRawGeneration: currentRaw,
  currentDependencyGeneration: currentDependency,
  interveningBatches: intervening
});

test("依赖代次没动 ⇒ 成立（up_to_date）：没有任何东西推进过分析输入", () => {
  const result = verdict(5, 3, 5, 3, []);
  assert.equal(result.holds, true);
  assert.equal(result.reason, "up_to_date");
  assert.deepEqual(result.offendingBatchIds, []);
});

test("只有 raw-only 批次进来 ⇒ 成立：D4 要放行的就是这一档（依赖计数器根本不动）", () => {
  // 捕获在 raw=5/dep=3；之后三个只写记录、不动依赖代次的批次。
  // 🔴 判据落在**依赖计数器不动**上，而不是"逐个批次自称没推过"：
  // record-only 车道结构上只推 raw（`data-only-import.ts`），所以 dep 没动就是证明。
  const result = verdict(5, 3, 8, 3, [
    batch("b6", 6, 3, 0),
    batch("b7", 7, 3, 0),
    batch("b8", 8, 3, 0)
  ]);
  assert.equal(result.holds, true);
  assert.equal(result.reason, "up_to_date");
  assert.deepEqual(result.offendingBatchIds, []);
});

test("依赖代次前进但**没有**任何批次认领 ⇒ 不成立（unattributed_dependency_move）", () => {
  // 现实形态：批次行被清理、计数器被手工推进、或账本与计数器不一致。
  // ⛔ 不能因为"中介批次都自称 raw-only"就放行 —— 那句自称在没有对应批次时证明不了任何事，
  // 而依赖代次按结构**只**在影响分析的批次上 +1。这一档正是"不确定按不安全处理"。
  const result = verdict(5, 3, 5, 4, [batch("b5", 5, 3, 0)]);
  assert.equal(result.holds, false);
  assert.equal(result.reason, "unattributed_dependency_move");
  assert.deepEqual(result.offendingBatchIds, []);
});

test("有批次推进了依赖代次 ⇒ 不成立（dependency_moved），并点名是哪一个", () => {
  const result = verdict(5, 3, 7, 4, [
    batch("b6", 6, 3, 0),
    batch("b7", 7, 4, 1)
  ]);
  assert.equal(result.holds, false);
  assert.equal(result.reason, "dependency_moved");
  assert.deepEqual(result.offendingBatchIds, ["b7"],
    "诊断必须点名 —— 只报『不成立』让人无从判断是哪个批次把候选弄旧的");
});

test("批次代次未知（v39 之前的历史行）⇒ 不成立：不确定一律按不安全处理", () => {
  const result = verdict(5, 3, 7, 4, [batch("legacy", null, null, null)]);
  assert.equal(result.holds, false);
  assert.equal(result.reason, "unknown_batch_generation",
    "把 NULL 当成『没推过』就是拿未知当安全 —— 那正是这条判据要防的");
  assert.deepEqual(result.offendingBatchIds, ["legacy"]);
});

test("计数器回退 ⇒ 不成立（generations_regressed），不靠猜", () => {
  assert.equal(verdict(5, 3, 4, 3, []).reason, "generations_regressed");
  assert.equal(verdict(5, 3, 5, 2, []).reason, "generations_regressed");
  assert.equal(verdict(5, 3, 4, 3, []).holds, false);
});

test("dependency 前进且完全没有中介批次行 ⇒ 不成立（说不清就不放行）", () => {
  const result = verdict(5, 3, 5, 4, []);
  assert.equal(result.holds, false);
  assert.equal(result.reason, "unattributed_dependency_move");
});

test("选取规则：raw 严格大于捕获值，或 raw 未知（历史行）", () => {
  const batches = [
    batch("old", 4, 2, 0),
    batch("at", 5, 3, 0),
    batch("after", 6, 3, 0),
    batch("legacy", null, null, null)
  ];
  const selected = selectInterveningBatches(batches, 5).map((item) => item.batchId);
  assert.deepEqual(selected, ["after", "legacy"],
    "等于捕获值的批次**已经算进去了**，不能再算成中介；raw 未知的行必须留在证明里（会被判为不安全）");
});

test("选取 + 判定的联动：历史行即使 raw 看不出前进也会进证明并被拒", () => {
  const batches = [batch("legacy", null, null, null)];
  const intervening = selectInterveningBatches(batches, 999);
  assert.deepEqual(intervening.map((item) => item.batchId), ["legacy"],
    "raw 未知的行在选取层被保留 ⇒ 判定层才能拒绝它。少这一条，未知会被静默丢弃");
  assert.equal(verdict(999, 3, 999, 4, intervening).holds, false);
});
