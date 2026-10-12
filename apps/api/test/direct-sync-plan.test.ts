// 直连车道判定与形状约束（docs/SQLITE_DIRECT_SYNC_PR2_PR3_DESIGN.md §2.2 / §2.6）。
//
// 两件事分开证明：
//   ① **判定**：六条件逐条等价于原内联 `if`，每条否决都能点名原因。
//   ② **形状**：直连恒为增量这件事是"类型上只有 `true` 一种可能"，
//      并且运行期还有一道兜底拦住"展开出来的多余字段"——那是类型挡不住的写法。

import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_SYNC_SNAPSHOT_FIELDS,
  assertDirectSyncRequestShape,
  directSyncParserOptions,
  planDirectSyncLane,
  type DirectSyncLaneInput
} from "../src/direct-sync-plan.js";
import { applyDataOnlyImport } from "../src/data-only-import.js";

const base: DirectSyncLaneInput = {
  queued: true,
  fastPathEnabled: true,
  engine: { name: "typescript", version: "0.1.0" },
  nativeVersion: "0.1.0",
  preserveAbsent: true,
  databaseExists: true
};

test("六个条件全满足才走直连，且直连只可能是 record-only 车道", () => {
  const decision = planDirectSyncLane(base);
  assert.equal(decision.lane, "direct");
  assert.deepEqual(decision.reasons, []);
  // 🔴 扩展到 "full" 必须同时把分析任务登记接上，否则会出现"原始已存、分析不更新"。
  // 这条断言就是那个闸门：有人放宽 deltaMode 时会先在这里变红。
  assert.equal(decision.deltaMode, "record-only");
});

test("逐条否决：每个条件单独失效都会被点名，且不误判为直连", () => {
  const cases: Array<[Partial<DirectSyncLaneInput>, string]> = [
    [{ queued: false }, "not_queued"],
    [{ fastPathEnabled: false }, "fast_path_disabled"],
    [{ engine: { name: "rust", version: "0.1.0" } }, "engine_rust"],
    [{ engine: { name: "typescript", version: "9.9.9" } }, "engine_version_mismatch"],
    [{ preserveAbsent: false }, "payload_is_a_complete_snapshot"],
    [{ databaseExists: false }, "no_existing_database"]
  ];
  for (const [override, reason] of cases) {
    const decision = planDirectSyncLane({ ...base, ...override });
    assert.equal(decision.lane, "legacy", JSON.stringify(override));
    assert.deepEqual(decision.reasons, [reason], JSON.stringify(override));
    assert.equal(decision.deltaMode, null);
  }
});

test("完整快照（preserveAbsent=false）在**任何**其它条件组合下都不会进入直连", () => {
  // 这是"静默全库删除"的唯一入口条件，所以单独枚举而不是只测一条。
  for (const queued of [true, false]) {
    for (const fastPathEnabled of [true, false]) {
      for (const databaseExists of [true, false]) {
        const decision = planDirectSyncLane({ ...base, queued, fastPathEnabled, databaseExists, preserveAbsent: false });
        assert.equal(decision.lane, "legacy");
      }
    }
  }
});

test("直连的增量选项是单一来源：返回值恒为 true，且不接受参数", () => {
  assert.deepEqual(directSyncParserOptions(), { preserveAbsent: true });
  // 返回类型写死字面量 `true` ⇒ `false` 在类型上不可表达；
  // 这里再从运行期确认一次，避免有人把它改成 `boolean` 而不改签名之外的任何东西。
  assert.equal(directSyncParserOptions().preserveAbsent, true);
  assert.equal(directSyncParserOptions.length, 0, "不得接受参数 —— 否则就有了传 false 的入口");
});

test("运行期兜底拦住快照语义字段，包括类型挡不住的展开写法", () => {
  const valid = { databasePath: "/x", inputPath: "/x", jobId: "j", payloadSha256: "a".repeat(64), startedAtMs: 0 };
  assert.doesNotThrow(() => assertDirectSyncRequestShape(valid));

  for (const field of DIRECT_SYNC_SNAPSHOT_FIELDS) {
    const spread = { ...valid, [field]: false };
    assert.throws(() => assertDirectSyncRequestShape(spread),
      new RegExp(`must not carry \`${field}\``));
  }
  // 值不是 false 也照样拒绝：字段**存在**本身就是要拦的信号。
  assert.throws(() => assertDirectSyncRequestShape({ ...valid, preserveAbsent: true }), /must not carry/);
});

test("applyDataOnlyImport 在**读取任何文件之前**先做形状校验", async () => {
  const request = {
    databasePath: "/definitely/not/a/database.sqlite",
    inputPath: "/definitely/not/an/input",
    jobId: "shape-probe",
    payloadSha256: "a".repeat(64),
    startedAtMs: Date.now(),
    // 展开写法：类型不报错，运行期必须被拦下。
    ...{ preserveAbsent: false as unknown as never }
  };
  await assert.rejects(applyDataOnlyImport(request), /must not carry `preserveAbsent`/);
  // 顺序判据：同一份请求若**没有**那个字段，应当走到"路径不存在 ⇒ return null"，
  // 而不是抛错。两条对照一起跑，才能证明上一条不是碰巧抛在了别处。
  const clean = { ...request };
  delete (clean as { preserveAbsent?: unknown }).preserveAbsent;
  assert.equal(await applyDataOnlyImport(clean), null);
});
