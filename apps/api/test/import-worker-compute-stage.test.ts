import assert from "node:assert/strict";
import test from "node:test";
import { COMPUTE_STAGE_NAME_PATTERN, parseComputeStageMessage } from "../src/import-worker.js";

/**
 * 回归守卫：`rai:compute-performance` 的接收端**不能**再对 stage 名做硬编码白名单。
 *
 * 2026-09-21 的线上事故：在 `packages/health-export-parser/src/cli.ts` 里给 `parseImport`
 * 尾部补了 7 个 `timedStage` 之后，线上 `computeStagesMs` 里**一个新段名都没有**、
 * 且**零报错**（`data-summary.issues` 仍是 `[]`）—— 因为接收端白名单没同步改。
 * 这两个用例把"发送端加的段必须能被接收端记下"钉成断言。
 */

/** 2026-09-20 之前就在用的段名（白名单时代的全部成员）。 */
const LEGACY_STAGES = [
  "features",
  "trainingMetrics",
  "modelReplay",
  "parse_health_xml",
  "import_gpx_routes",
  "canonicalize_workouts",
  "canonicalize_nights",
  "stage_audit_files"
];

/** 2026-09-21 新增的 7 个段名 —— 就是被白名单静默丢弃的那一批。 */
const NEW_STAGES = [
  "locate_health_xml",
  "prepare_staging_copy",
  "open_staging_store",
  "close_store",
  "activate_staging",
  "validate_installed",
  "commit_audit_files"
];

test("旧的 8 个段名仍然被接受（改接收端不能把已生效的埋点弄丢）", () => {
  for (const stage of LEGACY_STAGES) {
    const parsed = parseComputeStageMessage({ type: "rai:compute-performance", stage, durationMs: 12.5 });
    assert.deepEqual(parsed, { stage, durationMs: 12.5, processMaxRssKiB: null }, `stage=${stage} 应被接受`);
  }
});

test("新增的 7 个段名被接受（2026-09-21 白名单事故的回归守卫）", () => {
  for (const stage of NEW_STAGES) {
    const parsed = parseComputeStageMessage({ type: "rai:compute-performance", stage, durationMs: 3 });
    assert.notEqual(parsed, null, `stage=${stage} 被拒 ⇒ 新增埋点又会被静默丢弃`);
    assert.equal(parsed?.stage, stage);
  }
});

test("合法但此前未出现过的段名一律被接受（不再需要改接收端）", () => {
  for (const stage of ["a", "z_9", "future_stage_name", "anotherNewStage"]) {
    assert.notEqual(
      parseComputeStageMessage({ type: "rai:compute-performance", stage, durationMs: 1 }),
      null,
      `stage=${stage} 应被接受 —— 开放字典契约要求"新增埋点不必改接收端"`
    );
  }
});

test("非法 stage 名被拒（限制子进程往 performance_json 注入任意键）", () => {
  const rejected = [
    "",                       // 空
    "9stage",                 // 数字开头
    "_stage",                 // 下划线开头
    "with-dash",              // 连字符
    "with.dot",               // 点
    "with space",             // 空格
    "a".repeat(49),           // 超长（上限 48）
    "__proto__"               // 原型污染形态（下划线开头已拦，双保险）
  ];
  for (const stage of rejected) {
    assert.equal(
      parseComputeStageMessage({ type: "rai:compute-performance", stage, durationMs: 1 }),
      null,
      `stage=${JSON.stringify(stage)} 应被拒`
    );
  }
  assert.equal(COMPUTE_STAGE_NAME_PATTERN.test("a".repeat(48)), true, "48 字符合法（边界内）");
});

test("durationMs 必须是有限非负数，否则整条消息被拒", () => {
  const stage = "validate_installed";
  for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, "10", null, undefined]) {
    assert.equal(
      parseComputeStageMessage({ type: "rai:compute-performance", stage, durationMs }),
      null,
      `durationMs=${String(durationMs)} 应被拒`
    );
  }
  assert.notEqual(parseComputeStageMessage({ type: "rai:compute-performance", stage, durationMs: 0 }), null, "0 合法");
});

test("type 不匹配或消息不是对象时被拒", () => {
  assert.equal(parseComputeStageMessage({ type: "rai:other", stage: "features", durationMs: 1 }), null);
  assert.equal(parseComputeStageMessage({ stage: "features", durationMs: 1 }), null);
  for (const value of [null, undefined, "rai:compute-performance", 42, []]) {
    assert.equal(parseComputeStageMessage(value), null, `${JSON.stringify(value)} 应被拒`);
  }
});

test("processMaxRssKiB 非法时置 null，但消息本身仍被接受（它是可选附带指标）", () => {
  const stage = "activate_staging";
  for (const processMaxRssKiB of [undefined, null, -5, Number.NaN, "1024"]) {
    const parsed = parseComputeStageMessage({ type: "rai:compute-performance", stage, durationMs: 7, processMaxRssKiB });
    assert.equal(parsed?.processMaxRssKiB, null, `processMaxRssKiB=${String(processMaxRssKiB)} 应为 null`);
    assert.equal(parsed?.durationMs, 7, "阶段耗时仍要被记下");
  }
  const withRss = parseComputeStageMessage({ type: "rai:compute-performance", stage, durationMs: 7, processMaxRssKiB: 2048 });
  assert.equal(withRss?.processMaxRssKiB, 2048);
});
