import assert from "node:assert/strict";
import test from "node:test";

import { compareDailyEvidenceDays } from "../src/services/recompute-pipeline.js";

/**
 * v2 日级证据快照的比较判据。
 *
 * 它替掉的是"把前缀逐行重算一遍"的旧证明，所以**比较本身必须精确**：
 * 少看一天 ⇒ 把变过的历史日前缀当没变（静默错值）；多看一天 ⇒ 把边界外的变化
 * 当成前缀变化（白重算，方向安全但会掩盖真正的越界）。这里逐条钉住。
 */
test("daily evidence comparison localizes the first changed day, not just a boolean", () => {
  const days = (text: string): string => text.padEnd(80, "u");
  const base = days("udrpu");
  assert.deepEqual(compareDailyEvidenceDays(base, base, 5), { kind: "match" });
  assert.deepEqual(compareDailyEvidenceDays(base, base, 0), { kind: "match" });
  assert.deepEqual(compareDailyEvidenceDays(base, base, 1), { kind: "match" });

  // 边界上的差异必须给**精确日偏移**（含分块的第 64/65 位）。
  const long = "u".repeat(80);
  for (const offset of [0, 1, 2, 62, 63, 64, 65, 79]) {
    const changed = `${long.slice(0, offset)}d${long.slice(offset + 1)}`;
    assert.deepEqual(
      compareDailyEvidenceDays(long, changed, 80),
      { kind: "mismatch", offset },
      `offset=${offset}`
    );
  }

  // 只比较 [0, span)：边界之外的差异不算数（父 run 的快照本来就覆盖到更晚的日期）。
  const later = `${long.slice(0, 70)}r${long.slice(71)}`;
  assert.deepEqual(compareDailyEvidenceDays(long, later, 70), { kind: "match" });
  assert.deepEqual(compareDailyEvidenceDays(long, later, 71), { kind: "mismatch", offset: 70 });
});

test("daily evidence comparison refuses to prove a span that either side does not cover", () => {
  // 任一侧比 span 短 ⇒ insufficient（调用方退回逐行证明），绝不把"已比过的部分相同"当整段。
  assert.deepEqual(compareDailyEvidenceDays("udr", "udrpu", 5), { kind: "insufficient" });
  assert.deepEqual(compareDailyEvidenceDays("udrpu", "udr", 5), { kind: "insufficient" });
  assert.deepEqual(compareDailyEvidenceDays("", "udrpu", 1), { kind: "insufficient" });
  assert.deepEqual(compareDailyEvidenceDays("udrpu", "", 1), { kind: "insufficient" });
  assert.deepEqual(compareDailyEvidenceDays("udrpu", "udrpu", -1), { kind: "insufficient" });
});
