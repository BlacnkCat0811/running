// PR4 步骤 2a：直连车道的载荷分类（docs/SQLITE_DIRECT_SYNC_PR4_DESIGN.md §2.1）。
//
// 这个判据决定一件很重的事：本批能不能在回执里写 `analysisStatus: "not_required"`。
// 所以本文件的重心不是"分类对不对"，而是**默认方向对不对** ——
// 只有证明了"这批什么都没碰到分析"才允许 record-only；任何未知一律必须分析。
//
// 🔴 两个方向的代价不对称（见被测函数的注释）：
//   该分析却宣布 not_required ⇒ 用户看到与事实不符的当前结论（§9.1 明令禁止）；
//   不必分析却登记了分析   ⇒ 多跑一次后台计算，事实与回执仍然正确。
// 因此下面有一个**正向**用例专门钉"未知类型 ⇒ 必须分析"，它就是这条默认值的守卫。

import assert from "node:assert/strict";
import test from "node:test";

import { healthTypes, scoringHealthTypes } from "@rai/contracts";

import {
  DATA_ONLY_RECORD_TYPES,
  classifyDirectSyncPayload,
  type DirectSyncPayloadFacts
} from "../src/record-delta-policy.js";

const nothing: Omit<DirectSyncPayloadFacts, "recordTypes"> = {
  hasWorkout: false, hasRoute: false, deletedRecordCount: 0, deletedWorkoutCount: 0
};

const classify = (facts: Partial<DirectSyncPayloadFacts>) =>
  classifyDirectSyncPayload({ ...nothing, recordTypes: [], ...facts });

test("非评分白名单里的每个类型都判 record-only（白名单与分类器必须一致）", () => {
  for (const type of DATA_ONLY_RECORD_TYPES) {
    const result = classify({ recordTypes: [type] });
    assert.deepEqual(
      { payloadClass: result.payloadClass, reasons: result.reasons },
      { payloadClass: "record-only", reasons: [] },
      `${type} 在非评分白名单里，却要求分析 —— 白名单与分类器已经分叉`
    );
  }
});

test("评分清单里的每个类型都判 analysis-required，且原因点名类型", () => {
  for (const type of scoringHealthTypes) {
    const result = classify({ recordTypes: [type] });
    assert.equal(result.payloadClass, "analysis-required", `${type} 影响分析，不得判 record-only`);
    assert.deepEqual(result.reasons, [`scoring_record_type:${type}`]);
  }
});

test("🔴 未知类型一律判 analysis-required（默认方向：拿不准就分析）", () => {
  // 这条是"默认放行"与"白名单"的分水岭：把未知类型当成安全会让它转红。
  const unknown = "HKQuantityTypeIdentifierSomethingAddedInAFutureiOS";
  assert.equal(DATA_ONLY_RECORD_TYPES.includes(unknown), false);
  assert.equal((scoringHealthTypes as readonly string[]).includes(unknown), false);

  const result = classify({ recordTypes: [unknown] });
  assert.equal(result.payloadClass, "analysis-required");
  assert.deepEqual(result.reasons, [`unknown_record_type:${unknown}`]);
  assert.deepEqual(result.unknownRecordTypes, [unknown]);
});

test("Workout / 路线 / 显式删除各自单独成立就要求分析", () => {
  assert.deepEqual(classify({ hasWorkout: true }).reasons, ["workout_present"]);
  assert.deepEqual(classify({ hasRoute: true }).reasons, ["route_present"]);
  assert.deepEqual(classify({ deletedRecordCount: 1 }).reasons, ["explicit_record_deletion"]);
  assert.deepEqual(classify({ deletedWorkoutCount: 1 }).reasons, ["explicit_workout_deletion"]);
  // 删除-only 的载荷（没有任何 record）同样必须分析：它是"删掉旧事实"，
  // 而不分析就等于把基于已删事实的旧结论继续当成当前结论。
  const deleteOnly = classify({ deletedWorkoutCount: 2, deletedRecordCount: 3 });
  assert.equal(deleteOnly.payloadClass, "analysis-required");
  assert.deepEqual(deleteOnly.reasons, ["explicit_record_deletion", "explicit_workout_deletion"]);
});

test("空载荷判 record-only：本批什么都没碰，not_required 是准确结论", () => {
  const result = classify({});
  assert.equal(result.payloadClass, "record-only");
  assert.deepEqual(result.reasons, []);
});

test("白名单 + 一个未知类型 ⇒ 必须分析，且只把未知的列进 unknownRecordTypes", () => {
  const known = DATA_ONLY_RECORD_TYPES[0]!;
  const result = classify({ recordTypes: [known, known, "HKQuantityTypeIdentifierNope"] });
  assert.equal(result.payloadClass, "analysis-required");
  assert.deepEqual(result.unknownRecordTypes, ["HKQuantityTypeIdentifierNope"]);
  // 重复输入不得让原因重复（否则落库的 dirty 描述会长出噪声）。
  assert.deepEqual(result.reasons, ["unknown_record_type:HKQuantityTypeIdentifierNope"]);
});

test("确定性：原因与类型列表排序，同样输入两次逐字相同", () => {
  const types = [scoringHealthTypes[0]!, "HKQuantityTypeIdentifierZZZ", "HKQuantityTypeIdentifierAAA"];
  const first = classify({ recordTypes: types });
  const second = classify({ recordTypes: [...types].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(first.reasons, [
    "unknown_record_type:HKQuantityTypeIdentifierAAA",
    "unknown_record_type:HKQuantityTypeIdentifierZZZ",
    `scoring_record_type:${scoringHealthTypes[0]!}`
  ]);
});

test("结构前提：非评分白名单与评分清单不得有交集（分类器与车道闸门都以此为前提）", () => {
  // 有交集时两个判据会互相矛盾：同一批既"可以 record-only"又"必须分析"。
  // apps/api 侧另有等价断言（data-only-import 的入口闸门），这里再钉一次是因为
  // **分类器本身**也依赖它，而它现在与闸门是两份代码、一份清单。
  const overlap = DATA_ONLY_RECORD_TYPES.filter((type) =>
    (scoringHealthTypes as readonly string[]).includes(type));
  assert.deepEqual(overlap, [], `这些类型同时在两个清单里：${overlap.join(", ")}`);
  // 两个清单都非空：任一方被清空，分类器会退化成常量（全 record-only 或全 analysis-required）。
  assert.ok(DATA_ONLY_RECORD_TYPES.length > 0 && scoringHealthTypes.length > 0);
});

test("评分清单只由 healthTypes 常量构成（不许出现手写字面量）", () => {
  const known = new Set<string>(Object.values(healthTypes));
  for (const type of scoringHealthTypes) {
    assert.ok(known.has(type), `${type} 不是 healthTypes 里的取值 —— 手写字面量会漂移`);
  }
});
