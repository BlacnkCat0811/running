import assert from "node:assert/strict";
import test from "node:test";

import { negativeLearningReleaseBlockers } from "../src/index.js";

// §6.9-7：有充分合格负机会却长期 0 接受，必须阻止该门控版本发布。
// 判据只用文档的措辞（机会数 > 0 且接受数 = 0），**没有**另编一个"负接受率下限"——
// §6.9-6 明确说分布未知时不要捏造全局比例。

test("a candidate that never accepts a negative is a release blocker", () => {
  const { findings, releaseBlockers } = negativeLearningReleaseBlockers([
    { candidate: "v2a", negativeOpportunities: 26, negativeAccepted: 0 }
  ]);
  assert.deepEqual(findings, [
    { candidate: "v2a", status: "never_accepted", negativeOpportunities: 26, negativeAccepted: 0 }
  ]);
  assert.deepEqual(releaseBlockers, [
    { candidate: "v2a", code: "negative_learning_never_accepted", negativeOpportunities: 26 }
  ]);
});

test("a candidate that accepts even one negative is not blocked by this rule", () => {
  const { findings, releaseBlockers } = negativeLearningReleaseBlockers([
    { candidate: "v2a", negativeOpportunities: 26, negativeAccepted: 1 }
  ]);
  assert.equal(findings[0]?.status, "accepted");
  assert.deepEqual(releaseBlockers, []);
});

test("no negative opportunity is its own status, never silently treated as a pass", () => {
  // 把"从来没有机会"读成"通过了"，正是这条规则最容易被绕过的方式：
  // 覆盖不足的库会安静地拿到绿灯。所以它是独立状态，且必须出现在 findings 里。
  const { findings, releaseBlockers } = negativeLearningReleaseBlockers([
    { candidate: "empty", negativeOpportunities: 0, negativeAccepted: 0 }
  ]);
  assert.equal(findings[0]?.status, "no_opportunity");
  assert.deepEqual(releaseBlockers, []);
});

test("one blocked candidate blocks, and the finding names it", () => {
  const { releaseBlockers } = negativeLearningReleaseBlockers([
    { candidate: "ok", negativeOpportunities: 10, negativeAccepted: 4 },
    { candidate: "ratchet", negativeOpportunities: 42, negativeAccepted: 0 },
    { candidate: "no_data", negativeOpportunities: 0, negativeAccepted: 0 }
  ]);
  assert.deepEqual(releaseBlockers.map((blocker) => blocker.candidate), ["ratchet"]);
});

test("impossible censuses throw instead of being reported as a rate", () => {
  assert.throws(() => negativeLearningReleaseBlockers([
    { candidate: "x", negativeOpportunities: 5, negativeAccepted: 6 }
  ]), /cannot exceed/);
  assert.throws(() => negativeLearningReleaseBlockers([
    { candidate: "x", negativeOpportunities: -1, negativeAccepted: 0 }
  ]), /non-negative integer/);
  assert.throws(() => negativeLearningReleaseBlockers([
    { candidate: "x", negativeOpportunities: 1.5, negativeAccepted: 0 }
  ]), /non-negative integer/);
  assert.throws(() => negativeLearningReleaseBlockers([
    { candidate: "", negativeOpportunities: 1, negativeAccepted: 0 }
  ]), /candidate name/);
});
