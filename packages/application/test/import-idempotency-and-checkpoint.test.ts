import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { healthTypes, workoutTypes } from "@rai/contracts";
import { defaultFeatureConfig } from "@rai/features";
import { canonicalizeRunningWorkouts, parseAppleHealthXml } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

/**
 * §16.1 的 F09 与 S03 —— 这两条守的是同一类事：**同一次训练只能被算一次，旧状态不能在新口径下被复用**。
 *
 * 为什么单独放在 application 层跑端到端，而不是在领域包里构造对象：
 * "重复导入不重复计数"依赖的是解析器的身份判定、canonical 分组、feature 前缀复用三层的合力。
 * 在评分函数里塞同一份 feature 两次，测到的只是我自己传了什么。
 */

const appleDate = (day: number, time: string): string =>
  `2026-01-${String(day).padStart(2, "0")} ${time}:00 +0800`;

const days = [1, 4, 7, 10, 13, 16, 19];

function writeFixture(root: string): string {
  const xmlPath = join(root, "export.xml");
  const workouts = days.map((day, index) => `
  <Workout workoutActivityType="${workoutTypes.running}" duration="30" durationUnit="min" sourceName="Fixture Apple Watch" sourceVersion="1" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" device="Watch">
    <MetadataEntry key="HKIndoorWorkout" value="0"/>
    <WorkoutStatistics type="${healthTypes.distanceWalkingRunning}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" sum="${(5 + index * 0.08).toFixed(2)}" unit="km"/>
    <WorkoutStatistics type="${healthTypes.heartRate}" startDate="${appleDate(day, "08:00")}" endDate="${appleDate(day, "08:30")}" average="${145 + index}" minimum="120" maximum="172" unit="count/min"/>
  </Workout>`).join("");
  const heartRecords = days.flatMap((day, index) =>
    Array.from({ length: 15 }, (_, sample) => {
      const minute = String(sample * 2).padStart(2, "0");
      const endMinute = String(sample * 2 + 1).padStart(2, "0");
      return `
  <Record type="${healthTypes.heartRate}" sourceName="Fixture Apple Watch" sourceVersion="1" unit="count/min" creationDate="${appleDate(day, "08:31")}" startDate="${appleDate(day, `08:${minute}`)}" endDate="${appleDate(day, `08:${endMinute}`)}" value="${140 + index + (sample % 3)}"/>`;
    })
  ).join("");
  writeFileSync(xmlPath, `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
  <ExportDate value="${appleDate(25, "12:00")}"/>
  <Me biologicalSex="HKBiologicalSexMale"/>${workouts}${heartRecords}
</HealthData>`, "utf8");
  return xmlPath;
}

interface Counts {
  sessions: number;
  features: number;
  assessments: number;
  loads: number;
  trueAbility: number | null;
}

/**
 * 计数必须**限定在生效的那个 run 上**。
 * `workout_features` / `ability_assessments` / `workout_training_loads` 都是按 run 分区的，
 * 直接 `COUNT(*)` 会把"跑了两次重算"读成"训练被算了两次" —— 那是两种完全不同的事。
 */
function readCounts(store: RaiDatabase): Counts {
  return store.database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM training_sessions) AS sessions,
      (SELECT COUNT(*) FROM workout_features
        WHERE feature_run_id = (SELECT feature_run_id FROM active_model_run
          JOIN model_runs ON model_runs.id = active_model_run.model_run_id)) AS features,
      (SELECT COUNT(*) FROM active_ability_assessments) AS assessments,
      (SELECT COUNT(*) FROM active_workout_training_loads) AS loads,
      (SELECT true_ability_after FROM active_ability_assessments
        WHERE true_ability_after IS NOT NULL ORDER BY sequence_number DESC LIMIT 1) AS trueAbility
  `).get() as unknown as Counts;
}

async function withFixture(run: (store: RaiDatabase, xmlPath: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-import-idempotency-"));
  const store = await RaiDatabase.open(join(root, "rai.sqlite"));
  try {
    await run(store, writeFixture(root));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("F09: importing the same export twice does not count a training twice", async () => {
  await withFixture(async (store, xmlPath) => {
    const bytes = { fileSize: 1 };
    await parseAppleHealthXml(xmlPath, store, bytes);
    canonicalizeRunningWorkouts(store.database);
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    assert.equal(service.runNextJob()?.status, "succeeded");
    const first = readCounts(store);
    assert.equal(first.sessions, days.length);
    assert.equal(first.features, days.length);
    assert.equal(first.loads, days.length);

    // 同一份导出再导入一次：身份判定必须认出来，而不是新增 7 条训练。
    await parseAppleHealthXml(xmlPath, store, bytes);
    canonicalizeRunningWorkouts(store.database);
    const afterSecondImport = readCounts(store);
    assert.equal(afterSecondImport.sessions, first.sessions);
    assert.equal(afterSecondImport.features, first.features);
    assert.equal(afterSecondImport.loads, first.loads);

    // 再跑一次同样的重算：TA 与评估条数不得因为"又导入了一次"而变化。
    service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    assert.equal(service.runNextJob()?.status, "succeeded");
    const afterSecondRecompute = readCounts(store);
    assert.equal(afterSecondRecompute.sessions, first.sessions);
    assert.equal(afterSecondRecompute.assessments, first.assessments);
    assert.equal(afterSecondRecompute.trueAbility, first.trueAbility);
    // 负荷贡献同样不能翻倍：一次训练只贡献一条负荷记录。
    assert.equal(afterSecondRecompute.loads, first.loads);
  });
});

test("S03: an incremental recompute under a different feature config refuses to reuse the old checkpoint", async () => {
  await withFixture(async (store, xmlPath) => {
    await parseAppleHealthXml(xmlPath, store, { fileSize: 1 });
    canonicalizeRunningWorkouts(store.database);
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    assert.equal(service.runNextJob()?.status, "succeeded");

    // 先证明"同口径下确实会复用"：否则下一条断言可能只是因为增量路径根本没跑起来。
    store.setManifest("dataset_version", "dataset_same_config");
    store.flush();
    service.enqueueIncrementalRecompute(
      { mode: "partial", dirtySessionIds: [], dirtyFromAt: "2026-01-16T00:00:00.000Z", reasons: ["workout_or_route_change"] },
      { evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" }
    );
    assert.equal(service.runNextJob()?.status, "succeeded");
    const reused = store.database.prepare(`
      SELECT parent_feature_run_id AS parentId, reused_feature_count AS reused, recomputed_feature_count AS recomputed
      FROM feature_runs WHERE dataset_version = 'dataset_same_config'
    `).get() as unknown as { parentId: string | null; reused: number; recomputed: number };
    assert.ok(reused.parentId);
    assert.equal(reused.reused, 5);
    assert.equal(reused.recomputed, 2);

    // 换一个 feature config：checkpoint 的语义前提（同一口径）不再成立，必须整体重算。
    store.setManifest("dataset_version", "dataset_new_config");
    store.flush();
    service.enqueueIncrementalRecompute(
      { mode: "partial", dirtySessionIds: [], dirtyFromAt: "2026-01-16T00:00:00.000Z", reasons: ["workout_or_route_change"] },
      {
        evaluatedAt: "2026-01-25T04:00:00.000Z",
        timezoneIdentifier: "Asia/Shanghai",
        featureConfig: { ...defaultFeatureConfig, minimumDistanceKm: defaultFeatureConfig.minimumDistanceKm + 1 }
      }
    );
    assert.equal(service.runNextJob()?.status, "succeeded");
    const recomputed = store.database.prepare(`
      SELECT parent_feature_run_id AS parentId, reused_feature_count AS reused, recomputed_feature_count AS recomputed
      FROM feature_runs WHERE dataset_version = 'dataset_new_config'
    `).get() as unknown as { parentId: string | null; reused: number; recomputed: number };
    // 关键：不是"少复用几条"，而是**一条都不复用、且不挂到旧 run 上**。
    assert.equal(recomputed.parentId, null);
    assert.equal(recomputed.reused, 0);
    assert.equal(recomputed.recomputed, days.length);
    // 重算之后评估与快照仍然是完整的 —— 拒绝复用不等于产出残缺的 run。
    const counts = readCounts(store);
    assert.equal(counts.features, days.length);
    assert.equal(counts.loads, days.length);
  });
});
