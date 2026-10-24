// 阶段 6 夹具回归：确定性、真实 schema、会话活动类型、DX 载荷集。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DATASETS,
  SERIES_TIERS,
  buildPayloads,
  createRandom,
  datasetIdPlan,
  generateDataset
} from "../../../scripts/phase6/fixtures.mjs";
import { createOwnedExperimentRoot } from "../../../scripts/phase6/safety.mjs";

test("seeded random and id plan are deterministic", () => {
  const a = createRandom(20261024);
  const b = createRandom(20261024);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const plan = datasetIdPlan("D1");
  assert.equal(plan.workoutIds.length, DATASETS.D1.workouts);
  assert.equal(plan.series.small, "sess-000000");
  assert.equal(plan.series.large, "sess-000002");
  assert.equal(plan.deletedWorkoutId, "sess-000050");
  assert.equal(datasetIdPlan("DX"), null);
});

test("D0 fixture uses production schema, real session activity type and a stable digest", async () => {
  const parent = mkdtempSync(join(tmpdir(), "phase6-fixture-"));
  try {
    const rootA = join(parent, "run-a");
    const rootB = join(parent, "run-b");
    createOwnedExperimentRoot(rootA, { runId: "fixture-a" });
    createOwnedExperimentRoot(rootB, { runId: "fixture-b" });
    const a = await generateDataset({ root: rootA, dataset: "D0", seed: 424242 });
    const b = await generateDataset({ root: rootB, dataset: "D0", seed: 424242 });
    assert.equal(a.dataset, "D0");
    assert.equal(a.rows.health_records, b.rows.health_records);
    assert.equal(a.rows.workouts, 1);
    assert.equal(a.rows.training_sessions, 1);
    assert.equal(a.rows.route_points, 10);
    assert.equal(a.digest, b.digest, "same seed + spec must reproduce the logical digest");
    // 文件级 SHA-256 是完整性/身份，不是逻辑确定性；逻辑确定性由 digest 证明。
    assert.match(a.bytes.databaseSha256, /^[a-f0-9]{64}$/);
    assert.match(b.bytes.databaseSha256, /^[a-f0-9]{64}$/);
    assert.equal(a.schema.migrationVersion, b.schema.migrationVersion);
    assert.ok(a.schema.migrationVersion >= 47);
    const database = new DatabaseSync(join(rootA, "datasets", "D0", "rai.sqlite"), { readOnly: true });
    try {
      const session = database.prepare("SELECT activity_type FROM training_sessions").get();
      assert.equal(session.activity_type, "HKWorkoutActivityTypeRunning");
      const schema = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
      assert.equal(Number(schema.version), a.schema.migrationVersion);
    } finally {
      database.close();
    }
    // 同名数据库绝不被覆盖：第二次生成必须拒绝。
    await assert.rejects(() => generateDataset({ root: rootA, dataset: "D0", seed: 424242 }), /refuses to overwrite/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("DX payload set covers record, byte, GPX and corrupt inputs", () => {
  const parent = mkdtempSync(join(tmpdir(), "phase6-dx-"));
  try {
    const payloads = buildPayloads(parent);
    assert.equal(payloads.length, 12);
    for (const payload of payloads) {
      assert.ok(existsSync(payload.path));
      assert.ok(payload.bytes > 0);
      assert.match(payload.sha256, /^[a-f0-9]{64}$/);
    }
    assert.equal(payloads.filter((payload) => payload.s08 === true).length, 7);
    for (const payload of payloads) {
      assert.ok(payload.contract && typeof payload.contract === "object", `payload ${payload.name} needs a structured contract`);
      assert.ok(["accepted", "refused", "observational"].includes(payload.contract.expectation));
    }
    const labels = payloads.map((payload) => payload.label).join("\n");
    assert.match(labels, /超记录上限 5001/);
    assert.match(labels, /XML 字节超 2 MiB/);
    assert.match(labels, /损坏 ZIP/);
    assert.match(labels, /GPX 201 文件/);
    assert.match(labels, /direct-sync XML 超 8 MiB/);
    assert.equal(payloads.filter((payload) => payload.kind === "direct-sync").length, 3);
    assert.equal(payloads.filter((payload) => payload.kind === "workout").length, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("series tiers are frozen and non-empty", () => {
  assert.deepEqual(Object.keys(SERIES_TIERS), ["small", "medium", "large"]);
  for (const tier of Object.values(SERIES_TIERS)) {
    assert.ok(tier.heartRateSamples > 0);
    assert.ok(tier.routePoints > 0);
    assert.ok(tier.durationSeconds >= 1800);
  }
});
