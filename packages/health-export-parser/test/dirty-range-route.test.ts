// B05（2026-10-17 第二轮复查）：**路线变更必须同时推进三个域**。
//
// 这条判据防的不是"算错了"，而是"只算了一半"：把路线变更当成"只影响特征（配速/高程）"，
// 于是 `fitness` / `readiness` 仍从更晚的边界起算 —— 负荷与分区会拿旧训练量去拼新轨迹。
// 文档 §7.2 步骤 7 的原话是"不把『只改一条路线』误解成『只改一行分数』"。
//
// 纯函数层能钉住的是"计划给出的边界"；消费端是否照它续算由 `analysis-input-reader`
// 的物化/裁剪判据覆盖。

import assert from "node:assert/strict";
import test from "node:test";

import { planIncrementalAnalysisDirtyRange } from "../src/index.js";

const WORKOUT_START = "2026-03-05T09:00:00.000Z";
const WORKOUT_END = "2026-03-05T09:30:00.000Z";

function routeChange(at: string) {
  return {
    entityKind: "route" as const,
    changeType: "updated" as const,
    newType: null, newStart: at, newEnd: at,
    previousType: null, previousStart: null, previousEnd: null
  };
}

function recordChange(start: string, end: string) {
  return {
    entityKind: "record" as const,
    changeType: "updated" as const,
    newType: "HKQuantityTypeIdentifierHeartRate",
    newStart: start, newEnd: end,
    previousType: "HKQuantityTypeIdentifierHeartRate",
    previousStart: start, previousEnd: end
  };
}

test("B05：路线-only 变更同时推进 features / fitness / readiness", () => {
  const range = planIncrementalAnalysisDirtyRange({
    changes: [routeChange(WORKOUT_START)],
    workouts: [{ startAt: WORKOUT_START, endAt: WORKOUT_END }]
  });
  assert.equal(range.full, false, "单一训练的路线变更不该退化成全量");
  assert.equal(range.dirtyFromAt, WORKOUT_START);
  assert.equal(range.domains.features, WORKOUT_START);
  assert.equal(range.domains.fitness, WORKOUT_START,
    "路线变更同样改变负荷边界：只推进 features 会让旧训练量拼新轨迹");
  assert.equal(range.domains.readiness, WORKOUT_START);
});

test("B05：路线变更与更早的记录更正合并时，三域都取更早的那一个", () => {
  const earlier = "2026-03-01T09:00:00.000Z";
  const range = planIncrementalAnalysisDirtyRange({
    changes: [
      recordChange(earlier, "2026-03-01T09:10:00.000Z"),
      routeChange(WORKOUT_START)
    ],
    workouts: [
      { startAt: earlier, endAt: "2026-03-01T09:30:00.000Z" },
      { startAt: WORKOUT_START, endAt: WORKOUT_END }
    ]
  });
  assert.equal(range.full, false);
  assert.equal(range.domains.features, earlier);
  assert.equal(range.domains.fitness, earlier, "负荷边界不能被路线批次的较晚时刻覆盖");
  assert.equal(range.domains.readiness, earlier);
});

test("B05：路线时刻与训练相交时回退到训练开始（不后移到路线文件时刻）", () => {
  // 轨迹是跑完之后才成形的；合成条目给的是训练开始时刻，这里再钉一次"边界 = 训练开始"。
  const range = planIncrementalAnalysisDirtyRange({
    changes: [routeChange("2026-03-05T09:20:00.000Z")],
    workouts: [{ startAt: WORKOUT_START, endAt: WORKOUT_END }]
  });
  assert.equal(range.full, false);
  assert.equal(range.dirtyFromAt, WORKOUT_START,
    "落在训练区间内的路线时刻必须回退到训练开始，否则训练前半段不会被重算");
  assert.equal(range.domains.fitness, WORKOUT_START);
  assert.equal(range.domains.readiness, WORKOUT_START);
});

test("B05：activity_summary 走同一条分支 —— 点时刻同样回退到训练开始", () => {
  // 这条不是重复：`else` 分支同时服务 `route` 与 `activity_summary`，只钉 route 的话，
  // 有人把分支按实体拆开时，活动摘要这一侧会静默退化成"只取时刻"。
  const range = planIncrementalAnalysisDirtyRange({
    changes: [{
      entityKind: "activity_summary" as const,
      changeType: "updated" as const,
      newType: null, newStart: "2026-03-05T09:20:00.000Z", newEnd: null,
      previousType: null, previousStart: null, previousEnd: null
    }],
    workouts: [{ startAt: WORKOUT_START, endAt: WORKOUT_END }]
  });
  assert.equal(range.full, false);
  assert.equal(range.dirtyFromAt, WORKOUT_START);
  assert.equal(range.domains.fitness, WORKOUT_START);
  assert.equal(range.domains.readiness, WORKOUT_START);
});

test("B05：只有 end 没有 start ⇒ 全量（不得拿 end 冒充变更起点）", () => {
  // 不知道变更从哪儿开始，就只能全算。把 `end` 当起点会让更早的半段留在边界之外 ——
  // 这是"看起来算过、其实漏了"的形态，比慢危险。
  //
  // 🔴 必须**同时**给一条能产生边界的变更：否则孤立场景会走
  // `health_boundary_unknown` 变全量，删掉守卫也照样"绿"（假绿）。
  const earlier = "2026-03-01T09:00:00.000Z";
  const range = planIncrementalAnalysisDirtyRange({
    changes: [
      recordChange(earlier, "2026-03-01T09:10:00.000Z"),
      {
        entityKind: "activity_summary" as const,
        changeType: "updated" as const,
        newType: null, newStart: null, newEnd: "2026-03-05T09:20:00.000Z",
        previousType: null, previousStart: null, previousEnd: null
      }
    ],
    workouts: [
      { startAt: earlier, endAt: "2026-03-01T09:30:00.000Z" },
      { startAt: WORKOUT_START, endAt: WORKOUT_END }
    ]
  });
  assert.equal(range.full, true,
    "起点未知的变更必须让整批转全量，不能拿着另一条变更的边界继续 partial");
  assert.equal(range.dirtyFromAt, null);
  assert.ok(range.reasons.includes("invalid_health_interval"));
});

test("B05：没有路线时刻也没有其他变更 ⇒ 不是全量，也不产生边界", () => {
  const range = planIncrementalAnalysisDirtyRange({ changes: [], workouts: [] });
  assert.equal(range.full, false);
  assert.equal(range.dirtyFromAt, null);
  assert.deepEqual(range.domains, { features: null, fitness: null, readiness: null });
});
