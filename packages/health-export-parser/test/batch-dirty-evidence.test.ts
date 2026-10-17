// B05（2026-10-17 第二轮复查）：批次级分析影响证据的**解析判据**。
//
// 这份证据决定"允不允许 partial"。它的失效方式全是静默的：
//   * 把损坏读成"没有影响" ⇒ 少算该批的路线变更（漏算）；
//   * 把未知版本读成"当前形态" ⇒ 用错的字段语义算边界（漏算）；
//   * 把"可增量但没有边界"读成全量 ⇒ 只是慢，安全，但会掩盖生产端的自相矛盾。
// 所以解析只有三态：absent / invalid / ok，缺字段一律 invalid（绝不取默认值）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION,
  encodeBatchAnalysisDirtyEvidence,
  parseBatchAnalysisDirtyEvidence,
  type BatchAnalysisDirtyEvidence
} from "../src/index.js";

const BOUNDARY = "2026-03-01T09:00:00.000Z";

function valid(overrides: Partial<BatchAnalysisDirtyEvidence> = {}): BatchAnalysisDirtyEvidence {
  return {
    version: BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION,
    full: false,
    dirtyFromAt: BOUNDARY,
    domains: { features: BOUNDARY, fitness: BOUNDARY, readiness: BOUNDARY },
    routeDirtyTimes: ["2026-03-01T09:00:00.000Z"],
    recoveryBoundaries: ["2026-02-28T16:00:00.000Z"],
    reasons: ["bounded_health_change"],
    ...overrides
  };
}

test("B05：合法证据 round-trip 后逐字段一致", () => {
  const encoded = encodeBatchAnalysisDirtyEvidence(valid());
  const parsed = parseBatchAnalysisDirtyEvidence(encoded);
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  assert.deepEqual(parsed.evidence, valid());
});

test("B05：没有值 ⇒ absent（老批次走兼容路径，不是「没有影响」）", () => {
  assert.equal(parseBatchAnalysisDirtyEvidence(null).status, "absent");
  assert.equal(parseBatchAnalysisDirtyEvidence(undefined).status, "absent");
  assert.equal(parseBatchAnalysisDirtyEvidence("").status, "absent");
});

test("B05：未知版本或非 JSON ⇒ invalid（失败关闭，不猜字段语义）", () => {
  assert.deepEqual(parseBatchAnalysisDirtyEvidence("not json"), {
    status: "invalid", reason: "not_json"
  });
  const future = parseBatchAnalysisDirtyEvidence(JSON.stringify({
    ...valid(), version: BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION + 1
  }));
  assert.equal(future.status, "invalid");
});

test("B05：`full:false` 却没有边界 ⇒ invalid（自相矛盾的证据不是「全量」）", () => {
  const parsed = parseBatchAnalysisDirtyEvidence(JSON.stringify(valid({ dirtyFromAt: null })));
  assert.deepEqual(parsed, { status: "invalid", reason: "partial_without_boundary" });
});

test("B05：`full:true` 允许边界为空（那是「覆盖一切」而不是「未知」）", () => {
  const parsed = parseBatchAnalysisDirtyEvidence(JSON.stringify(valid({
    full: true,
    dirtyFromAt: null,
    domains: { features: null, fitness: null, readiness: null }
  })));
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  assert.equal(parsed.evidence.full, true);
});

test("B05：缺 domains 字段 ⇒ invalid（缺字段与「该域全算」语义相反）", () => {
  const raw = { ...valid(), domains: { features: BOUNDARY, fitness: BOUNDARY } };
  assert.deepEqual(parseBatchAnalysisDirtyEvidence(JSON.stringify(raw)), {
    status: "invalid", reason: "domains_invalid"
  });
});

test("B05：路线时刻不是规范时刻 ⇒ invalid（绝不按字符串猜测）", () => {
  const raw = { ...valid(), routeDirtyTimes: ["2026-03-01 09:00:00"] };
  assert.deepEqual(parseBatchAnalysisDirtyEvidence(JSON.stringify(raw)), {
    status: "invalid", reason: "route_dirty_times_invalid"
  });
});

test("B05：reasons 不是字符串数组 ⇒ invalid（诊断字段也不能松散放行）", () => {
  const raw = { ...valid(), reasons: ["ok", 1] };
  assert.deepEqual(parseBatchAnalysisDirtyEvidence(JSON.stringify(raw)), {
    status: "invalid", reason: "reasons_invalid"
  });
});

test("B05：路线时刻去重并排序（同一训练被多次改动只留一条）", () => {
  const parsed = parseBatchAnalysisDirtyEvidence(JSON.stringify(valid({
    routeDirtyTimes: ["2026-03-02T09:00:00.000Z", "2026-03-01T09:00:00.000Z", "2026-03-02T09:00:00.000Z"]
  })));
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  assert.deepEqual(parsed.evidence.routeDirtyTimes, [
    "2026-03-01T09:00:00.000Z", "2026-03-02T09:00:00.000Z"
  ]);
});

test("B05：缺 routeDirtyTimes / recoveryBoundaries / reasons ⇒ invalid（缺字段 ≠ 空数组）", () => {
  // 写端 `encodeBatchAnalysisDirtyEvidence` 永远写出这三个键；缺键只可能是截断/漏写。
  // 读成 `[]` 会把"证据不完整"说成"这批没有路线变更" —— 正是这份证据最危险的失效形态。
  for (const [key, reason] of Object.entries({
    routeDirtyTimes: "route_dirty_times_invalid",
    recoveryBoundaries: "recovery_boundaries_invalid",
    reasons: "reasons_invalid"
  })) {
    const raw: Record<string, unknown> = { ...valid() };
    delete raw[key];
    const parsed = parseBatchAnalysisDirtyEvidence(JSON.stringify(raw));
    assert.deepEqual(parsed, { status: "invalid", reason }, `${key} 缺失必须 invalid`);
  }
});

test("B05：当前版本号被**字面量**钉住（抬常量必须是一次显式决定）", () => {
  // 绝对判据，刻意不跟着常量漂移。上面那条 `+1` 用例是**相对**判据 —— 常量抬到 2 时它
  // 只是在测 3，永远绿，所以它证明不了"版本号没被随手改过"。
  assert.equal(BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION, 1,
    "抬版本号前先读 batch-dirty-evidence.ts 的「升级协议」：库里旧批次的证据会全部 invalid ⇒ 退全量");

  // 已知的旧版本与未来版本都必须 invalid —— 不许"尽量读懂"。
  // 用"当前值 ±1"而不是写死 `[0, 2]`：将来抬版本时，写死的列表会把**新的当前版本**也判成
  // invalid，与本条判据的本意（只拒绝不认识的版本）自相矛盾。
  for (const version of [
    BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION - 1,
    BATCH_ANALYSIS_DIRTY_EVIDENCE_VERSION + 1
  ]) {
    const parsed = parseBatchAnalysisDirtyEvidence(JSON.stringify({ ...valid(), version }));
    assert.equal(parsed.status, "invalid", `version=${version} 必须 invalid`);
  }
  // 反向对照：当前版本必须仍然 ok。否则"拒绝未知版本"可以靠"什么都拒绝"骗过去。
  assert.equal(parseBatchAnalysisDirtyEvidence(encodeBatchAnalysisDirtyEvidence(valid())).status, "ok");
});
