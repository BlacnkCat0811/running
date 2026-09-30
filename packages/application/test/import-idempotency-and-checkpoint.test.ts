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

/**
 * §16.1 **T02**：「删除训练后重放 → 所有下游去除该事实影响」。
 *
 * 🔴 这一条此前**一条断言都没有**：矩阵检查把它算作"被引用"，靠的全是
 * `${localDate}T02:00:00.000Z` 这类时间戳模板里的 `T02` 恰好在词边界上（见
 * `scripts/check-acceptance-matrix.mts` 里 citedIdsIn 的注释）。收紧判据后它掉出来，
 * 被如实写进 KNOWN_GAPS。现在把缺口补上。
 *
 * 覆盖面：导入层早有"删除后不得复活"的守卫（`tombstone-deletion.test.ts`），
 * 但那测的是**事实层**。T02 要的是**派生层**：删除之后重放，被删训练不得继续出现在
 * 特征 run、逐次负荷与能力时间线里。
 *
 * 重现的是**真实删除路径产生的那个状态**，而不是我另编一个：
 * `canonicalize.ts:436-443` 会把"不再属于任何 workout group"的训练
 * `SET status='inactive'`（workout 从导出里消失时就是这样），并因
 * `canonical_workout_id` 是 `ON DELETE SET NULL` 而失去 canonical 链接。
 * 两者一起就是"这次训练被删了"在库里的样子。直接 `DELETE FROM workouts` 不是合法路径
 * —— 它会被外键挡住（本用例第一版就是这么失败的）。
 *
 * `listActiveForFeatures` 的两个条件（`JOIN workouts` + `status IN ('active','ambiguous')`）
 * 正好分别对应这两处，所以这个用例同时钉住两条排除路径。
 *
 * ⚠️ **为什么用 24 次训练而不是共用的那 7 次**：第一版用 7 次时，第二次全量重算
 * **直接失败**，报 `Model-version gate failed: eligible_session_delta` ——
 * 删掉 1/7 = 14%，超过 `maxEligibleSessionDelta = 0.05`（`model-transition-gate.ts:103,164`）。
 * 也就是说：**历史短的时候，任何一次删除都会让重放被版本闸门挡住**，
 * §4.7 要的"下游去除影响"根本走不完。这是本用例查出来的真实交互，已记进状态文档 §十六。
 * 24 次时 1/24 = 4.2% < 5%，闸门放行，才谈得上验证下游。
 */
/**
 * 🔴 **T02 仍然没有覆盖，但原因从"没人写"变成了"走不通"** —— 本用例把这个阻塞钉住。
 *
 * 我按 §16.1 T02 的要求写了断言（删除训练 → 重放 → 下游一条都不剩），它**跑不完**：
 * 第二次全量重算直接失败，`Model-version gate failed: eligible_session_delta`。
 * 7 次训练时删 1 个是 14%；换成 24 次（名义 4.2%）**同样失败**。
 * 闸门比的是**合格**训练数（`eligibility_status IN ('eligible','trial')`，
 * `model-run-repository.ts:262,265-266`），不是特征行数，所以"删掉 N 分之一"不等于
 * delta 就是 1/N —— 具体基数我还没查清，不猜。
 *
 * 我不改闸门（放宽它正是本方案禁止的那类作弊），也不把这条测试改成断言"失败是对的"
 * 来假装 T02 已完成。**这个用例只声明一件确定的事**：
 * **删除训练后重放会被版本闸门挡住，而且被挡住的候选不会半发布** ——
 * 旧 run 仍然是活跃的，它的派生行一个字都没动（§2.3-9「发布不可半成功」）。
 *
 * 它的用处：如果将来有人让"删除后可重放"，这条用例会**转红**，
 * 逼着他回来把 T02 从 KNOWN_GAPS 里摘掉。
 */
test("deleting a training blocks the replay at the version gate, and nothing is half-published", async () => {
  await withFixture(async (store, xmlPath) => {
    await parseAppleHealthXml(xmlPath, store, { fileSize: 1 });
    canonicalizeRunningWorkouts(store.database);
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    assert.equal(service.runNextJob()?.status, "succeeded");
    const before = readCounts(store);
    const activeBefore = (store.database.prepare("SELECT model_run_id AS id FROM active_model_run").get() as { id: string }).id;
    assert.equal(before.features, days.length);

    // 重现真实删除路径产生的状态（canonicalize.ts:436-443 的 SET status='inactive'
    // 加上 canonical_workout_id 的 ON DELETE SET NULL）。
    const target = store.database.prepare(`
      SELECT session.id AS sessionId FROM training_sessions session
      JOIN workouts workout ON workout.id = session.canonical_workout_id
      ORDER BY workout.start_at DESC LIMIT 1
    `).get() as unknown as { sessionId: string };
    store.database.prepare(
      "UPDATE training_sessions SET status = 'inactive', canonical_workout_id = NULL WHERE id = ?"
    ).run(target.sessionId);

    store.setManifest("dataset_version", "dataset_after_delete");
    store.flush();
    service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    const job = service.runNextJob();

    assert.equal(job?.status, "failed", "预期的阻塞：删除训练后重放会被 eligible_session_delta 挡住");
    const jobRow = store.database.prepare(
      "SELECT error_json AS error FROM recompute_jobs ORDER BY created_at DESC LIMIT 1"
    ).get() as unknown as { error: string };
    assert.match(jobRow.error, /eligible_session_delta/, "挡住它的必须是那个明确的 gate 原因，不是别的偶发错误");

    // 关键的一半：被拒的候选**不得半发布**。
    const activeAfter = (store.database.prepare("SELECT model_run_id AS id FROM active_model_run").get() as { id: string }).id;
    assert.equal(activeAfter, activeBefore, "闸门失败时活跃指针必须原地不动");
    const after = readCounts(store);
    assert.equal(after.features, days.length, "旧 run 的派生行不得被失败候选动过");
    assert.equal(after.loads, days.length);
  });
});

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
