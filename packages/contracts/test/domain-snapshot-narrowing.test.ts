import assert from "node:assert/strict";
import test from "node:test";
import { readFitnessSnapshot, readLoadSnapshot } from "../src/index.js";

const fitnessPayload = (daily: unknown[], lineage?: unknown) => ({ lineage, assessments: [], daily });
const loadPayload = (days: unknown[], lineage?: unknown) => ({ lineage, days });

test("fitness narrowing reads the sealed V2 shape and the legacy shape without inventing a lineage", () => {
  const v2 = readFitnessSnapshot(fitnessPayload(
    [{ local_date: "2026-01-01", true_ability: 55, snapshot_status: "active" }],
    { baselineEpochId: "epoch-a" }
  ));
  assert.deepEqual(v2, {
    baselineEpochId: "epoch-a",
    daily: [{ localDate: "2026-01-01", trueAbility: 55, status: "active" }]
  });
  // legacy 分支写的是 {assessments, daily}，**没有** lineage ⇒ epoch 是未知，不是"与当前相同"。
  const legacy = readFitnessSnapshot(fitnessPayload(
    [{ local_date: "2026-01-02", true_ability: null, snapshot_status: "no_data" }]
  ));
  assert.deepEqual(legacy, {
    baselineEpochId: null,
    daily: [{ localDate: "2026-01-02", trueAbility: null, status: "no_data" }]
  });
});

test("fitness narrowing refuses a load payload instead of reading days as daily", () => {
  // 这是本层存在的理由：`load` 域存 `{lineage, days}`。若消费方把字段名当通用，
  // 就会把负荷日次当成能力日次画出来，而且不会报错。
  assert.equal(readFitnessSnapshot(loadPayload([{ local_date: "2026-01-01" }])), null);
  assert.equal(readLoadSnapshot(fitnessPayload([{ local_date: "2026-01-01" }])), null);
});

test("narrowing skips rows without the required key and returns null when none survive", () => {
  const partial = readFitnessSnapshot(fitnessPayload([
    { true_ability: 50, snapshot_status: "active" },
    { local_date: "2026-01-03", true_ability: 52, snapshot_status: "active" }
  ]));
  assert.deepEqual(partial?.daily, [{ localDate: "2026-01-03", trueAbility: 52, status: "active" }]);
  assert.equal(readFitnessSnapshot(fitnessPayload([{ true_ability: 50 }])), null);
  assert.equal(readFitnessSnapshot(fitnessPayload([])), null);
  assert.equal(readFitnessSnapshot(undefined), null);
  assert.equal(readFitnessSnapshot("not-an-object"), null);
});

test("non-finite ability becomes null rather than NaN reaching the chart", () => {
  const view = readFitnessSnapshot(fitnessPayload([
    { local_date: "2026-01-04", true_ability: Number.NaN, snapshot_status: "active" },
    { local_date: "2026-01-05", true_ability: Number.POSITIVE_INFINITY, snapshot_status: "active" }
  ]));
  // NaN 一旦漏到图表/JSON 里会变成 null 或静默传播，所以在这里就归一到 null。
  assert.deepEqual(view?.daily.map((row) => row.trueAbility), [null, null]);
});

test("load narrowing exposes the day rows and their epoch", () => {
  const view = readLoadSnapshot(loadPayload(
    [{ local_date: "2026-01-01", training_load: 42 }],
    { baselineEpochId: "epoch-a" }
  ));
  assert.equal(view?.baselineEpochId, "epoch-a");
  assert.deepEqual(view?.days, [{ local_date: "2026-01-01", training_load: 42 }]);
  assert.equal(readLoadSnapshot(loadPayload([])), null);
});
