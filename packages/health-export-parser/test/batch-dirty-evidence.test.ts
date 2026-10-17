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
