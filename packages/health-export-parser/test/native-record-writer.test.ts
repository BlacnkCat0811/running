// `NativeRecordWriter` 的输入 spool 体积守卫。
//
// 为什么要单独一个文件，而不是塞进 `native-worker.test.ts`：
// 那个文件在模块顶层就判 `existsSync(nativeBinary())`，并在 `RAI_REQUIRE_RUST_TESTS=1`
// 时直接抛 —— 本文件测的是**纯 TS + node:sqlite** 的行为，不该被 Rust 二进制的可用性绑架。
//
// 为什么这条判据此前不存在：8 GiB 的上限用默认值根本触发不了（要造约 28 万页），于是
// "每 4096 行才查一次"这个真正的缺陷没有可执行的证据。可测的做法是把**上限**注入成 1 字节，
// 让"第 512 行才检查"这件事本身成为被观测对象：
//   · 第 511 行不抛 ⇒ 不是每行都查（过度修正会在这里红）；
//   · 第 512 行抛   ⇒ 间隔确实是 512（回退成 4096 会在这里红）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CanonicalHealthRecord } from "@rai/contracts";

import { NativeRecordWriter, SPOOL_LIMIT_BYTES } from "../src/native-record-writer.js";
import { NativeWorkerError } from "../src/native-worker.js";

/** 形状照抄 `native-worker.test.ts` 的 B4 用例：它已经证明这些字段能过 `capture()`。 */
function record(index: number): CanonicalHealthRecord {
  const second = String(index % 60).padStart(2, "0");
  return {
    id: `record_spool_${index}`,
    type: "HKQuantityTypeIdentifierHeartRate",
    sourceName: "Apple Watch",
    sourceVersion: "1",
    device: null,
    unit: "count/min",
    numericValue: 120,
    textValue: null,
    startAt: `2026-01-01T00:${second}:00.000Z`,
    endAt: `2026-01-01T00:${second}:05.000Z`,
    createdAt: `2026-01-01T00:${second}:00.000Z`,
    metadata: {}
  };
}

function withWriter(options: { spoolLimitBytes?: number }, run: (writer: NativeRecordWriter) => void): void {
  const root = mkdtempSync(join(tmpdir(), "rai-spool-limit-"));
  const writer = new NativeRecordWriter(root, "fixture-generation", undefined, false, options);
  try {
    run(writer);
  } finally {
    // 构造函数开了长事务、`capture` 之后还没 `apply`，关闭时可能抛。这是清理动作，
    // 不在判据链上：上面抛的错必须原样冒出去，不能被清理失败换掉。
    try { writer.close(); } catch { /* 清理失败不改变判据 */ }
    // Windows 上 close 失败时句柄可能仍被占用，`rmSync` 抛 EBUSY 同样不能替换原错误。
    try { rmSync(root, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
}

test("spool 上限在**第 512 行**检查：511 行不抛、512 行抛 resource_limit", () => {
  withWriter({ spoolLimitBytes: 1 }, (writer) => {
    for (let index = 0; index < 511; index += 1) {
      writer.capture(record(index), "apple_watch", {}, `hash_${index}`);
    }
    // 上限是 1 字节，任何一行落盘都超界 —— 唯一让前 511 行平安无事的解释就是"还没到检查点"。
    assert.throws(
      () => writer.capture(record(511), "apple_watch", {}, "hash_511"),
      (error: unknown) => error instanceof NativeWorkerError && error.code === "resource_limit"
    );
  });
});

test("默认上限 8 GiB 下 512 行不得误报（间隔收紧不等于阈值收紧）", () => {
  withWriter({}, (writer) => {
    for (let index = 0; index < 512; index += 1) {
      writer.capture(record(index), "apple_watch", {}, `hash_${index}`);
    }
  });
});

test("默认上限就是 8 GiB（把默认值改小必须显式改这条）", () => {
  // 第二条用例只写 512 行（约 106 KiB）；若默认值被悄悄改成 8 MiB，它仍会绿。
  // 所以默认值必须被**绝对**钉住，而不能只靠"512 行不抛"这种相对判据。
  assert.equal(SPOOL_LIMIT_BYTES, 8 * 1024 ** 3);
});
