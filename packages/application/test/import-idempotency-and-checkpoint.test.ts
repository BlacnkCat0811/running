import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RaiApplicationService } from "@rai/application";
import { healthTypes, workoutTypes } from "@rai/contracts";
import { defaultFeatureConfig } from "@rai/features";
import { canonicalizeRunningWorkouts, parseAppleHealthXml } from "@rai/health-export-parser";
import { RaiDatabase, SqliteModelRunRepository, SqliteModelReleaseRepository, ModelRunActivationError } from "@rai/storage-sqlite";
import { replayPublishedLoadSnapshot } from "../src/load-replay-data.js";

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

// Reproduce canonicalization's explicit inactive fact; keep the old bundle immutable.
async function verifyDeletedReplay(corruptIncumbent: boolean, deleteFirst = false, deleteCount = 1): Promise<void> {
  await withFixture(async (store, xmlPath) => {
    await parseAppleHealthXml(xmlPath, store, { fileSize: 1 });
    canonicalizeRunningWorkouts(store.database);
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    assert.equal(service.runNextJob()?.status, "succeeded");
    const before = readCounts(store);
    const replay=replayPublishedLoadSnapshot(store.database,"2026-01-25T04:00:00.000Z","Asia/Shanghai");
    assert.equal(replay.base.output.includedFactCount,days.length);
    assert.equal(replay.candidate.output.includedFactCount,0,"a snapshot computed later was not historically available");
    assert.equal(replay.source.scope,"published_derived_snapshot_not_raw_as_known_then");
    assert.throws(()=>replayPublishedLoadSnapshot(store.database,"2026-01-25T04:00:00.000Z","UTC"),/timezone differs/);
    const activeBefore = (store.database.prepare("SELECT model_run_id AS id FROM active_model_run").get() as { id: string }).id;
    assert.equal(before.features, days.length);
    if (corruptIncumbent) {
      // An unrelated eligibility mismatch must not be forgiven merely because
      // this dataset also contains one legitimate deletion.
      store.database.prepare(`UPDATE ability_assessments SET assessment_status='eligible'
        WHERE id=(SELECT id FROM ability_assessments WHERE model_run_id=?
          AND assessment_status='calibrating' ORDER BY sequence_number LIMIT 1)`).run(activeBefore);
    }

    // 重现真实删除路径产生的状态（canonicalize.ts:436-443 的 SET status='inactive'
    // 加上 canonical_workout_id 的 ON DELETE SET NULL）。
    const targets = store.database.prepare(`
      SELECT session.id AS sessionId FROM training_sessions session
      JOIN workouts workout ON workout.id = session.canonical_workout_id
      ORDER BY workout.start_at ${deleteFirst ? "ASC" : "DESC"} LIMIT ?
    `).all(deleteCount) as unknown as Array<{ sessionId: string }>;
    const target=targets[0]!;
    for (const target of targets) store.database.prepare(
      "UPDATE training_sessions SET status = 'inactive', canonical_workout_id = NULL WHERE id = ?"
    ).run(target.sessionId);

    store.setManifest("dataset_version", "dataset_after_delete");
    store.flush();
    service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    const job = service.runNextJob();

    if (corruptIncumbent) {
      assert.equal(job?.status, "failed");
      assert.match(String(store.database.prepare("SELECT error_json AS error FROM recompute_jobs WHERE id=?")
        .get(job!.id)?.error), /eligible_session_delta/);
      assert.equal(store.database.prepare("SELECT model_run_id AS id FROM active_model_run").get()?.id, activeBefore);
      assert.equal(readCounts(store).features, before.features);
      return;
    }
    assert.equal(job?.status, "succeeded", JSON.stringify(job));
    const activeAfter = (store.database.prepare("SELECT model_run_id AS id FROM active_model_run").get() as { id: string }).id;
    assert.notEqual(activeAfter, activeBefore);
    const after = readCounts(store);
    assert.equal(after.features, days.length - deleteCount);
    assert.equal(after.loads, days.length - deleteCount);
    for (const table of ["active_ability_assessments", "active_workout_training_loads"]) {
      assert.equal(store.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE training_session_id=?`).get(target.sessionId)?.n, 0);
    }
    assert.equal(store.database.prepare(`SELECT COUNT(*) AS n FROM workout_features f
      JOIN model_runs m ON m.feature_run_id=f.feature_run_id WHERE m.id=? AND f.training_session_id=?`)
      .get(activeAfter, target.sessionId)?.n, 0);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM ability_assessments WHERE model_run_id=?")
      .get(activeBefore)?.n, before.assessments, "the rollback bundle remains immutable");
    const report = JSON.parse(String(store.database.prepare(
      "SELECT evaluation_json AS json FROM model_release_bundles WHERE model_run_id=?").get(activeAfter)?.json));
    assert.equal(report.thresholds.maxEligibleSessionDelta, 0.05);
    assert.equal(report.factChanges.removedEligibleSessions, deleteCount === days.length ? 1 : deleteFirst ? 0 : 1);
    assert.equal(report.factChanges.deletionRecalibration, deleteFirst);
    if (deleteFirst) {
      assert.equal(report.rebase.rebaseReason,"calibration_evidence_removed");
      assert.equal(report.rebase.effectiveAt,"2026-01-25T04:00:00.000Z");
    }
    assert.equal(report.factChanges.retainedDeletedSessions, 0);
    assert.equal(report.metrics.eligibleSessionDelta, 0);
    if (deleteCount === days.length) {
      assert.equal(report.emptyCohort.baseSessions, days.length);
      assert.equal(report.emptyCohort.removedBaseSessions, days.length);
      assert.equal(report.emptyCohort.domainSnapshotsEmpty, true);
      for (const table of ["active_ability_assessments", "active_workout_training_loads", "active_daily_ability_snapshots", "active_daily_training_metrics"]) {
        assert.equal(store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0, table);
      }
      // Empty-on-empty recomputes must remain valid; never reuse the deleted run.
      service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
      assert.equal(service.runNextJob()?.status, "succeeded");
      assert.equal(readCounts(store).assessments, 0);
    }
    await withFixture(async (fresh, path) => {
      await parseAppleHealthXml(path, fresh, { fileSize: 1 });
      canonicalizeRunningWorkouts(fresh.database);
      for (const target of targets) fresh.database.prepare("UPDATE training_sessions SET status='inactive',canonical_workout_id=NULL WHERE id=?")
        .run(target.sessionId);
      const clean = new RaiApplicationService(fresh);
      clean.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
      assert.equal(clean.runNextJob()?.status, "succeeded");
      const scores = (db: RaiDatabase) => db.database.prepare(`SELECT training_session_id, assessment_status,
        current_ability, true_ability_after FROM active_ability_assessments ORDER BY sequence_number`).all();
      assert.deepEqual(scores(store), scores(fresh), "no deleted contribution survives in the remaining ability trajectory");
    });

  });
}

test("T02: deleted training is removed from the published replay without relaxing drift thresholds", () => verifyDeletedReplay(false));
test("T02: deleting calibration evidence rebuilds the remaining trajectory", () => verifyDeletedReplay(false, true));
test("T02: removing calibration evidence can return to an uncalibrated state without stale scores", () => verifyDeletedReplay(false, true, 2));
test("T02: removing all trainings publishes an empty bundle and repeated empty replays stay valid", () => verifyDeletedReplay(false, true, days.length));
test("known deletion does not excuse unexplained eligibility drift or half-publication", () => verifyDeletedReplay(true));

test("an empty historical cutoff cannot masquerade as confirmed deletion while source sessions remain", async () => {
  await withFixture(async (store, xmlPath) => {
    await parseAppleHealthXml(xmlPath, store, { fileSize: 1 });
    canonicalizeRunningWorkouts(store.database);
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    const initial = service.runNextJob()!;
    assert.equal(initial.status, "succeeded");
    service.enqueueFullRecompute({ evaluatedAt: "2025-12-01T00:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    const candidate = service.runNextJob()!;
    assert.equal(candidate.status, "failed");
    assert.match(String(candidate.error?.message ?? ""), /empty_cohort_evidence_invalid/);
    assert.equal(store.database.prepare("SELECT model_run_id AS id FROM active_model_run").get()?.id, initial.modelRunId);
    assert.equal(readCounts(store).features, days.length);
  });
});

test("activation and CLI rollback reject old overrides without changing either active pointer", async () => {
  await withFixture(async (store, xmlPath) => {
    await parseAppleHealthXml(xmlPath, store, { fileSize: 1 });
    canonicalizeRunningWorkouts(store.database);
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: new Date().toISOString(), timezoneIdentifier: "Asia/Shanghai" });
    const first = service.runNextJob()!;
    assert.equal(first.status, "succeeded");
    const target = String(store.database.prepare(`SELECT training_session_id AS id
      FROM active_ability_assessments ORDER BY sequence_number DESC LIMIT 1`).get()?.id);
    service.appendWorkoutOverride({ trainingSessionId: target, expectedRevision: 0,
      eligibilityOverride: "exclude", sessionType: null, performanceProtocol: null,
      rpe: null, conditionTags: [], note: null });
    const second = service.runNextJob()!;
    assert.equal(second.status, "succeeded", JSON.stringify(second));
    const repo = new SqliteModelRunRepository(store.database);
    const releases = new SqliteModelReleaseRepository(store.database);
    assert.throws(() => repo.activateSucceeded(first.modelRunId!, new Date().toISOString()),
      (error: unknown) => error instanceof ModelRunActivationError && error.code === "release_gate" && /overrides changed/i.test(error.message));
    assert.throws(() => releases.rollback(first.modelRunId!, second.modelRunId!, new Date().toISOString()), /overrides changed/i);
    // V3 compatibility activation cannot bypass the same check by using its
    // older training_metric_runs.config_json snapshot location.
    store.database.prepare("UPDATE feature_runs SET feature_schema_version='workout-feature-v3' WHERE id=?").run(first.featureRunId!);
    assert.throws(() => repo.activateSucceeded(first.modelRunId!, new Date().toISOString()),
      (error: unknown) => error instanceof ModelRunActivationError && error.code === "release_gate");
    for (const table of ["active_model_run", "active_model_release"]) {
      assert.equal(store.database.prepare(`SELECT model_run_id AS id FROM ${table}`).get()?.id, second.modelRunId);
    }
    assert.equal(store.database.prepare("SELECT assessment_status AS status FROM active_ability_assessments WHERE training_session_id=?").get(target)?.status, "excluded");
    // An unchanged override revision still allows a genuine same-facts rollback.
    service.enqueueFullRecompute({ evaluatedAt: new Date().toISOString(), timezoneIdentifier: "Asia/Shanghai" });
    const third = service.runNextJob()!;
    assert.equal(third.status, "succeeded");
    releases.rollback(second.modelRunId!, third.modelRunId!, new Date().toISOString());
    assert.equal(store.database.prepare("SELECT model_run_id AS id FROM active_model_run").get()?.id, second.modelRunId);
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

test("O04: rewinding the dirty boundary to the overlapping workout start recomputes that workout instead of reusing it", async () => {
  await withFixture(async (store, xmlPath) => {
    await parseAppleHealthXml(xmlPath, store, { fileSize: 1 });
    canonicalizeRunningWorkouts(store.database);
    const service = new RaiApplicationService(store);
    service.enqueueFullRecompute({ evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" });
    assert.equal(service.runNextJob()?.status, "succeeded");

    const reusedCounts = async (datasetVersion: string, dirtyFromAt: string) => {
      store.setManifest("dataset_version", datasetVersion);
      store.flush();
      service.enqueueIncrementalRecompute(
        { mode: "partial", dirtySessionIds: [], dirtyFromAt, reasons: ["test"] },
        { evaluatedAt: "2026-01-25T04:00:00.000Z", timezoneIdentifier: "Asia/Shanghai" }
      );
      assert.equal(service.runNextJob()?.status, "succeeded");
      return store.database.prepare(`
        SELECT reused_feature_count AS reused, recomputed_feature_count AS recomputed
        FROM feature_runs WHERE dataset_version = ?
      `).get(datasetVersion) as unknown as { reused: number; recomputed: number };
    };

    // 每个训练都是本地 08:00 起（= 00:00Z）；01-16 的"训练内变更"（08:10 本地 = 00:10Z）
    // 在旧实现里会把边界留在 00:10Z —— 该训练（00:00Z）不满足 `>= dirtyFromAt` ⇒ 被错误复用。
    const withoutRewind = await reusedCounts("dataset_no_rewind", "2026-01-16T00:10:00.000Z");
    assert.equal(withoutRewind.reused, 6);
    assert.equal(withoutRewind.recomputed, 1);
    // O04 修复形态：边界回退到相交训练起点（00:00Z）⇒ 01-16 进入重算集（与 S03 的同口径 5/2 对齐）。
    const rewound = await reusedCounts("dataset_rewound", "2026-01-16T00:00:00.000Z");
    assert.equal(rewound.reused, withoutRewind.reused - 1,
      "回退必须恰好多抢回一条（被更正的那次训练）——不是少复用几条、也不是整体退化");
    assert.equal(rewound.reused, 5);
    assert.equal(rewound.recomputed, 2);
    // 拒绝复用不等于产出残缺 run：重算之后齐全。
    const counts = readCounts(store);
    assert.equal(counts.features, days.length);
    assert.equal(counts.loads, days.length);
  });
});
