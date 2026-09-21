import assert from "node:assert/strict";
import test from "node:test";
import { NATIVE_OPERATIONS } from "@rai/health-export-parser";
import { NATIVE_OPERATION_NAME_PATTERN, parseNativeEngineMessage } from "../src/import-worker.js";

/**
 * 回归守卫：`rai:native-engine` 的接收端**不能**再对 operation 名做硬编码白名单。
 *
 * 这是 2026-09-21「第五形态耦合」的第二处（第一处见 `import-worker-compute-stage.test.ts`：
 * 7 个新埋点被 `import-worker.ts` 的 8 段名白名单静默吃掉）。当时接收端写的是
 * `["health","gpx","aggregate","apply-records"].includes(operation)` —— Rust 侧新增一个
 * operation 时，`rustCalls` / `wallMs` / `peakRssKiB` 会被静默吃掉，`performance.native`
 * 里就是没有它，`data-summary.issues` 也照旧是 `[]`。
 */

const metric = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "rai:native-engine", operation: "health", requested: "rust", actual: "rust", durationMs: 12.5, ...over
});

test("发送端 NATIVE_OPERATIONS 里的每一个 operation 都被接收端认得（跨端耦合断言）", () => {
  for (const operation of NATIVE_OPERATIONS) {
    const parsed = parseNativeEngineMessage(metric({ operation }));
    assert.equal(
      parsed?.operation,
      operation,
      `operation=${operation} 被接收端丢掉 ⇒ 加新 operation 会静默失效`
    );
  }
});

test("接收端从未见过的合法 operation 被接受（不再需要改接收端）", () => {
  // 这条就是"当初那 7 个埋点"的等价场景：发送端声明了、接收端不认识 ⇒ 静默丢弃。
  for (const operation of ["route-prune", "canonicalize-nights", "health2", "aggregate-x"]) {
    const parsed = parseNativeEngineMessage(metric({ operation }));
    assert.notEqual(
      parsed,
      null,
      `operation=${operation} 应被接受 —— 开放字典契约要求"新增 operation 不必改接收端"`
    );
    assert.equal(parsed?.operation, operation);
  }
});

test("actual 只接受 rust / typescript", () => {
  assert.equal(parseNativeEngineMessage(metric({ actual: "typescript" }))?.actual, "typescript");
  for (const actual of ["RUST", "Rust", "python", "", null, undefined, 1]) {
    assert.equal(parseNativeEngineMessage(metric({ actual })), null, `actual=${String(actual)} 应被拒`);
  }
});

test("非法 operation 名被拒（限制子进程往 performance_json 注入任意键）", () => {
  const rejected = [
    "",                 // 空
    "Health",           // 大写
    "apply_records",    // 下划线（真实名字用连字符）
    "9gpx",             // 数字开头
    "-gpx",             // 连字符开头
    "with.dot",
    "with space",
    "a".repeat(33),     // 超长（上限 32）
    "__proto__"         // 原型污染形态
  ];
  for (const operation of rejected) {
    assert.equal(
      parseNativeEngineMessage(metric({ operation })),
      null,
      `operation=${JSON.stringify(operation)} 应被拒`
    );
  }
  assert.equal(NATIVE_OPERATION_NAME_PATTERN.test("a".repeat(32)), true, "32 字符合法（边界内）");
  assert.equal(NATIVE_OPERATION_NAME_PATTERN.test("apply-records"), true, "真实名字必须过");
});

test("durationMs 必须是有限非负数，否则整条消息被拒", () => {
  for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "10", null, undefined]) {
    assert.equal(parseNativeEngineMessage(metric({ durationMs })), null, `durationMs=${String(durationMs)} 应被拒`);
  }
  assert.notEqual(parseNativeEngineMessage(metric({ durationMs: 0 })), null, "0 合法");
});

test("type 不匹配或消息不是对象时被拒", () => {
  assert.equal(parseNativeEngineMessage(metric({ type: "rai:other" })), null);
  assert.equal(parseNativeEngineMessage({ operation: "health", actual: "rust", durationMs: 1 }), null);
  for (const value of [null, undefined, "rai:native-engine", 42, []]) {
    assert.equal(parseNativeEngineMessage(value), null, `${JSON.stringify(value)} 应被拒`);
  }
});

test("peakRssKiB 非法时置 null，但消息本身仍被接受（它是可选附带指标）", () => {
  for (const peakRssKiB of [undefined, null, -5, Number.NaN, "1024"]) {
    const parsed = parseNativeEngineMessage(metric({ peakRssKiB }));
    assert.equal(parsed?.peakRssKiB, null, `peakRssKiB=${String(peakRssKiB)} 应为 null`);
    assert.equal(parsed?.durationMs, 12.5, "耗时仍要被记下");
  }
  assert.equal(parseNativeEngineMessage(metric({ peakRssKiB: 2048 }))?.peakRssKiB, 2048);
});

test("发送端附带的其它字段（requested / fallbackReason / version）不影响解析", () => {
  const parsed = parseNativeEngineMessage(metric({
    requested: "typescript", actual: "typescript", fallbackReason: "unsupported_xml", version: "0.4.1"
  }));
  assert.equal(parsed?.actual, "typescript");
  assert.equal(parsed?.operation, "health");
});
