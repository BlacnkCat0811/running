import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  FROZEN_IDENTITY_ALGORITHM,
  IDENTITY_ALGORITHM_PROBES,
  identityAlgorithmFingerprint
} from "../src/identity-algorithm.js";
import { stableId } from "../src/utils.js";

/**
 * The sentinel for the identity algorithm.
 *
 * `import-worker` folds `identityAlgorithmFingerprint()` into the payload digest
 * (`apps/api/src/import-payload-identity.ts`), so an algorithm change invalidates
 * every existing payload anchor **by itself** and the next import takes the full
 * path. That is the right behaviour, and it means this assertion is a *tripwire*,
 * not a description of a bug: it exists so the change is loud instead of silent.
 */
test("the identity algorithm fingerprint still matches the frozen value", () => {
  assert.equal(
    identityAlgorithmFingerprint(),
    FROZEN_IDENTITY_ALGORITHM,
    [
      "身份算法指纹变了 —— 这是哨兵，不是坏掉的测试。",
      "改了 stableId / canonicalize / JSON 编码，就等于改了「同一份载荷会派生哪些 id」。",
      "线上影响：所有既有库的载荷锚点会自动失配（import-worker 已把指纹折进摘要），",
      "下一次导入跑完整路径并消耗一次全库备份（该项目回滚窗口不到 1 小时）。",
      "更新 FROZEN_IDENTITY_ALGORITHM 之前请先回答两件事：",
      "  1) 这次算法变更是有意的吗？现在能接受一次完整重导入吗？",
      "  2) 载荷的**含义**也变了吗（解析 / 规范化规则）？那就还要 bump CONTRACT_VERSION。",
      "如果只是往 IDENTITY_ALGORITHM_PROBES 里加探针，指纹同样会变 —— 那属于有意扩大覆盖面。"
    ].join("\n")
  );
  assert.equal(
    identityAlgorithmFingerprint(),
    identityAlgorithmFingerprint(),
    "指纹必须是纯函数：不依赖时钟、时区、环境或文件系统"
  );
});

/**
 * `canonicalize`'s contract, asserted per branch rather than as one golden value,
 * so a partial regression lands on a named assertion.
 */
test("object keys are a set, array order is a sequence — and it recurses", () => {
  assert.equal(
    stableId("record_content", [{ activeEnergy: 1, distance: 2 }]),
    stableId("record_content", [{ distance: 2, activeEnergy: 1 }]),
    "两个「数据上相等」的对象必须哈希相同，无论键的插入顺序"
  );
  assert.notEqual(
    stableId("x", [[1, 2, 3]]),
    stableId("x", [[3, 2, 1]]),
    "数组是序列不是集合：调换顺序必须改 id（metadata[key] 的 lastMetadataValue 依赖这条）"
  );
  assert.equal(
    stableId("workout_content", [{ metadata: { HKA: ["a"], HKB: ["b"] }, indoor: true }]),
    stableId("workout_content", [{ indoor: true, metadata: { HKB: ["b"], HKA: ["a"] } }]),
    "规范化必须递归进嵌套的普通对象 —— 只修一层的实现会在这里露馅"
  );
});

test("non-plain objects pass through instead of collapsing to {}", () => {
  assert.notEqual(
    stableId("x", [new Date("2026-01-01T00:00:00.000Z")]),
    stableId("x", [{}]),
    "Date 走 JSON.stringify 自己的 toJSON，不应被拍平成 {} —— 这就是「透传」的证明"
  );
  // Map 与 Set 的可枚举属性为空，所以 JSON.stringify 的结果与 {} 相同。这不是缺陷，
  // 是编码层的既有事实，钉在这里免得有人把它当成回归去「修」。
  assert.equal(stableId("x", [new Map([["k", 1]])]), stableId("x", [{}]));
  assert.equal(stableId("x", [new Set([1, 2])]), stableId("x", [{}]));
  assert.equal(
    stableId("x", [Object.create(null)]),
    stableId("x", [{}]),
    "null 原型的对象仍然是普通对象，必须参与键排序"
  );
});

test("stableId keeps kind and payload apart", () => {
  assert.notEqual(stableId("a", ["b"]), stableId("b", ["a"]), "kind 参与哈希");
  assert.notEqual(stableId("x", ["a", "b"]), stableId("x\u0000a", ["b"]), "`\\0` 分隔符必须有效");
  assert.notEqual(stableId("x", ["a\u0000b"]), stableId("x\u0000a", ["b"]));
  assert.equal(stableId("x", [null]), stableId("x", [undefined]), "JSON.stringify 把两者都折叠成 null（已知且无歧义）");
});

/**
 * The safety property that made `a9b0759` deployable without rewriting stored ids:
 * every real primary key — record, workout, route, training_session,
 * canonical_night, workout_group and the job ids — passes a **flat list of
 * primitives**, so those ids must stay byte-identical to the plain
 * `JSON.stringify` formula. Recomputed the old way here, so this goes red the
 * moment anyone extends canonicalisation to arrays.
 */
test("a flat array of primitives still hashes exactly as the pre-canonicalisation formula did", () => {
  const parts = [
    "HKQuantityTypeIdentifierRunningSpeed",
    "唐攀的Apple Watch",
    "2026-09-01T10:00:00.000Z",
    "10.5",
    "km/hr"
  ];
  const legacy = createHash("sha256");
  legacy.update("record");
  legacy.update("\0");
  legacy.update(JSON.stringify(parts));
  assert.equal(stableId("record", parts), `record_${legacy.digest("hex").slice(0, 32)}`);
});

test("every probe in the fingerprint set actually produces an id", () => {
  // A probe that quietly failed to construct (say a swallowed error) would shrink
  // the fingerprint's coverage instead of failing, which is the one way this
  // guard could rot without anyone noticing.
  assert.ok(
    IDENTITY_ALGORITHM_PROBES.length >= 30,
    `探针集缩到 ${IDENTITY_ALGORITHM_PROBES.length} 条 —— 覆盖面变窄是静默的，必须显式改这条下限`
  );
  for (const [kind, parts] of IDENTITY_ALGORITHM_PROBES) {
    assert.match(
      stableId(kind, parts),
      /^.+_[0-9a-f]{32}$/,
      `探针 [${JSON.stringify(kind)}] 没有产出合法 id`
    );
  }
});
