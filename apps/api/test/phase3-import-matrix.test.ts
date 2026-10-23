// 阶段 3 / P3-04：导入、删除、路线及幂等矩阵的**真实车道**回归。
//
// 覆盖矩阵行：T05、T06、T07、T10、T11、T14，以及一条 F04（dirty evidence 回读失败）。
// 夹具与 `direct-sync-ingest.test.ts` / `data-only-import.test.ts` 同源：
//   · 真 `RaiDatabase` 临时库；
//   · 真 `computeImportPayloadSha256`（worker 准入用的同一个函数）；
//   · 真 `applyDirectSyncImport` / `applyDataOnlyImport`（不 mock 事务）；
//   · 断言落盘状态（事实、账本、代次、任务、回执），不是只看返回值。
//
// 本文件**不重复**已有用例：
//   · T01/T03/T04/T08/T09/T12/T13 的既有落点见 deliverables/.../TEST_MATRIX.md；
//   · 8 MiB 精确边界与 `> 8 MiB` 终态拒收已在 `direct-sync-ingest.test.ts` 覆盖；
//   · T05 的纯函数判据已在 `packages/health-export-parser/test/dirty-range.test.ts` 覆盖，
//     这里补的是"真实登记任务里到底有没有 incrementalPlan"的端到端一面。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION, healthTypes, workoutTypes } from "@rai/contracts";
import { RaiDatabase } from "@rai/storage-sqlite";
import {
  DATA_ONLY_MAX_RECORDS, DATA_ONLY_MAX_XML_BYTES, NATIVE_VERSION,
  identityAlgorithmFingerprint, isDataOnlyRecordXml, parseAppleHealthXml
} from "@rai/health-export-parser";

import { applyDataOnlyImport, type DataOnlyImportInput } from "../src/data-only-import.js";
import {
  DIRECT_SYNC_MAX_RECORDS, DIRECT_SYNC_MAX_ROUTE_BYTES, DIRECT_SYNC_MAX_ROUTE_FILES,
  DIRECT_SYNC_MAX_XML_BYTES, applyDirectSyncImport, isDirectSyncRejection, preflightDirectSyncPayload,
  type DirectSyncImportInput
} from "../src/direct-sync-ingest.js";
import { readImportReceipt } from "../src/import-publication.js";
import { computeImportPayloadSha256 } from "../src/import-payload-identity.js";

const a = "00000000-0000-0000-0000-00000000000a";
const b = "00000000-0000-0000-0000-00000000000b";
const c = "00000000-0000-0000-0000-00000000000c";
const step = healthTypes.stepCount;
const heartRate = healthTypes.heartRate;

function record(
  uuid: string, value = "10", type: string = step,
  start = "2018-01-01 00:00:00 +0000", end = "2018-01-01 00:01:00 +0000",
  syncId?: string
): string {
  return `<Record type="${type}" sourceName="Watch" unit="count" value="${value}"
    startDate="${start}" endDate="${end}">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/>
    ${syncId === undefined ? "" : `<MetadataEntry key="HKMetadataKeySyncIdentifier" value="${syncId}"/>`}
  </Record>`;
}

function workout(startAt = "2018-01-02 08:00:00 +0000", syncId = "workout-1", routePath?: string): string {
  const endAt = startAt.replace("08:00:00", "08:30:00");
  return `<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
    startDate="${startAt}" endDate="${endAt}" duration="30" durationUnit="min">
    <MetadataEntry key="HKMetadataKeySyncIdentifier" value="${syncId}"/>
    ${routePath === undefined ? "" : `<WorkoutRoute><FileReference path="/workout-routes/${routePath}"/></WorkoutRoute>`}
  </Workout>`;
}

const xml = (rows = ""): string => `<HealthData>${rows}</HealthData>`;

interface InputOptions {
  job?: string;
  deletedRecords?: { type: string; uuid: string }[];
  deletedWorkoutIds?: string[];
  gpx?: Record<string, string>;
}

interface Fixture {
  root: string;
  main: string;
  input(rows?: string, options?: InputOptions): Promise<DirectSyncImportInput & DataOnlyImportInput>;
  seed(rows: string): Promise<void>;
}

async function fixture(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-phase3-import-"));
  const main = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  store.setProfile({ dateOfBirth: "1990-01-01" });
  store.close();
  let ordinal = 0;
  const input: Fixture["input"] = async (rows = "", options = {}) => {
    const inputPath = join(root, `input-${ordinal++}`);
    mkdirSync(inputPath);
    writeFileSync(join(inputPath, "export.xml"), xml(rows));
    writeFileSync(join(inputPath, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", sourceIds: [],
      deletedSourceIds: options.deletedWorkoutIds ?? [],
      deletedRecords: options.deletedRecords ?? []
    }));
    for (const [name, content] of Object.entries(options.gpx ?? {})) {
      mkdirSync(join(inputPath, "workout-routes"), { recursive: true });
      writeFileSync(join(inputPath, "workout-routes", name), content);
    }
    const payloadSha256 = await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true, contractVersion: CONTRACT_VERSION,
      engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint()
    });
    return { databasePath: main, inputPath, jobId: options.job ?? "delta", payloadSha256, startedAtMs: Date.now() };
  };
  const seed = async (rows: string): Promise<void> => {
    const seeded = await RaiDatabase.open(main);
    const path = join(root, "seed.xml");
    writeFileSync(path, xml(rows));
    try {
      seeded.database.prepare(`INSERT OR IGNORE INTO import_batches
        (id,xml_sha256,status,import_mode) VALUES ('seed','seed','running','incremental')`).run();
      await parseAppleHealthXml(path, seeded, {
        fileSize: statSync(path).size, healthKitRecordIdentity: true,
        incremental: { generation: "seed", batchId: "seed", preserveAbsent: true }
      });
    } finally { seeded.close(); }
  };
  try { await run({ root, main, input, seed }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function read<T>(main: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(main, { readOnly: true });
  try { return run(db); } finally { db.close(); }
}

const count = (main: string, table: string, where = ""): number =>
  read(main, (db) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n));

function generations(main: string): { raw: number; dependency: number } {
  return read(main, (db) => {
    const row = db.prepare("SELECT raw_generation AS raw, dependency_generation AS dependency FROM import_generations WHERE singleton=1")
      .get() as { raw: number; dependency: number };
    return { raw: Number(row.raw), dependency: Number(row.dependency) };
  });
}

function analysisJob(main: string, batchId: string): {
  id: string; status: string; request: Record<string, unknown>; dirty: Record<string, unknown>;
} {
  return read(main, (db) => {
    const row = db.prepare(`SELECT id, status, request_json AS request, dirty_json AS dirty
      FROM recompute_jobs WHERE json_extract(request_json, '$.importBatchId') = ?`).get(batchId) as
      { id: string; status: string; request: string; dirty: string } | undefined;
    assert.ok(row, `批次 ${batchId} 必须登记一条分析任务`);
    return { id: row.id, status: row.status, request: JSON.parse(row.request), dirty: JSON.parse(row.dirty) };
  });
}

function dirtyEvidence(main: string, batchId: string): {
  full: boolean; dirtyFromAt: string | null; domains: Record<string, string | null>;
  routeDirtyTimes: string[]; reasons: string[];
} {
  return read(main, (db) => {
    const row = db.prepare("SELECT analysis_dirty_plan_json AS json FROM import_batches WHERE id=?")
      .get(batchId) as { json: string | null } | undefined;
    assert.ok(row?.json, `批次 ${batchId} 必须留下分析影响证据`);
    return JSON.parse(row.json);
  });
}

async function applyOrFail(input: DirectSyncImportInput) {
  const outcome = await applyDirectSyncImport(input);
  assert.ok(!isDirectSyncRejection(outcome),
    `直连批次必须被接收，实际拒收：${JSON.stringify(outcome)}`);
  return outcome;
}

// ---------------------------------------------------------------------------
// T05：未知 record 类型
// ---------------------------------------------------------------------------

test("T05 未知 record 类型（单独 / 与有界已知变更混合）都必须登记分析且不产出有界增量计划", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(workout());

    const unknownAlone = record(
      "00000000-0000-0000-0000-0000000000a1", "10", "HKQuantityTypeIdentifierFutureMetric",
      "2018-01-02 09:00:00 +0000", "2018-01-02 09:01:00 +0000");
    const alone = await applyOrFail(await input(unknownAlone, { job: "unknown-alone" }));
    assert.equal(alone.payloadClass, "analysis-required",
      "未知类型必须要求分析（第一层 fail-closed）");
    assert.equal(alone.summary.directSync?.analysisStatus, "queued");
    const aloneJob = analysisJob(main, "unknown-alone");
    assert.equal(aloneJob.request.incrementalPlan, undefined,
      "未知类型没有域依赖证明 ⇒ 不得给出 partial 计划");
    assert.ok((aloneJob.dirty.unknownRecordTypes as string[]).includes("HKQuantityTypeIdentifierFutureMetric"));
    const aloneEvidence = dirtyEvidence(main, "unknown-alone");
    assert.equal(aloneEvidence.full, true);
    assert.deepEqual(aloneEvidence.domains, { features: null, fitness: null, readiness: null });
    assert.ok(aloneEvidence.reasons.includes("unknown_record_type"));

    // 混合批：一条训练内 HR（本身有界）不能把未知类型的影响"借"成 08:00 边界。
    const unknown = record(
      "00000000-0000-0000-0000-0000000000a2", "10", "HKQuantityTypeIdentifierFutureMetric",
      "2018-01-02 09:05:00 +0000", "2018-01-02 09:06:00 +0000");
    const hr = record("00000000-0000-0000-0000-0000000000a3", "150", heartRate,
      "2018-01-02 08:10:00 +0000", "2018-01-02 08:11:00 +0000");
    const mixed = await applyOrFail(await input(unknown + hr, { job: "unknown-mixed" }));
    assert.equal(mixed.payloadClass, "analysis-required");
    assert.equal(mixed.summary.directSync?.analysisStatus, "queued");
    const mixedJob = analysisJob(main, "unknown-mixed");
    assert.equal(mixedJob.request.incrementalPlan, undefined,
      "未知依赖被 HR 的 08:00 边界掩盖了：incrementalPlan 必须不存在");
    assert.equal(mixedJob.dirty.from, null, "dirty.from 必须为 null（全量），不得写 08:00");
    const mixedEvidence = dirtyEvidence(main, "unknown-mixed");
    assert.equal(mixedEvidence.full, true, "批次证据必须是 full");
    assert.deepEqual(mixedEvidence.domains, { features: null, fitness: null, readiness: null },
      "三个域都不得拿到有界边界");
    assert.ok(mixedEvidence.reasons.includes("unknown_record_type"));
    assert.ok((mixedJob.dirty.reasons as string[]).includes("scoring_record_type:HKQuantityTypeIdentifierHeartRate"),
      "已知变更的分类原因仍要保留（诊断用），但它不能决定边界");

    // 事实仍然落库（fail-closed 的是"增量复用"，不是"拒收事实"）。
    assert.equal(count(main, "health_records"), 3);
    assert.equal(count(main, "recompute_jobs", "WHERE status='queued'"), 2);
    // data-only 结构上不接未知类型：同一份载荷在快通路必须被拒且零写入。
    const before = count(main, "health_records");
    const fastPathInput = await input(unknown, { job: "unknown-fast-path" });
    assert.equal(await applyDataOnlyImport(fastPathInput), null,
      "未知类型不得进入 data-only 快通路");
    assert.equal(count(main, "health_records"), before, "快通路拒收必须零写入");
  });
});

// ---------------------------------------------------------------------------
// T06：同 job 同内容重放
// ---------------------------------------------------------------------------

test("T06 同 job 同内容重放（worker 层）：返回原回执，事实/任务/代次不重复", async () => {
  await fixture(async ({ main, input }) => {
    const batch = await input(workout(), { job: "replay-1" });
    const first = await applyOrFail(batch);
    assert.equal(first.replayed, false);
    const receipt = readImportReceipt(main, batch.jobId);
    assert.ok(receipt);
    const jobId = first.summary.analysisJobId;
    assert.equal(typeof jobId, "string");
    const before = {
      records: count(main, "health_records"), workouts: count(main, "workouts"),
      batches: count(main, "import_batches"), jobs: count(main, "recompute_jobs"),
      generations: generations(main)
    };
    assert.equal(before.workouts, 1);
    assert.equal(before.jobs, 1);

    const replay = await applyDirectSyncImport(batch);
    assert.ok(!isDirectSyncRejection(replay));
    assert.equal(replay.replayed, true, "同 job 同内容必须命中持久回执重放");
    assert.deepEqual(replay.summary, first.summary, "重放必须逐字段返回原回执");
    assert.equal(replay.summary.analysisJobId, jobId, "重放不得换 task id");

    assert.deepEqual({
      records: count(main, "health_records"), workouts: count(main, "workouts"),
      batches: count(main, "import_batches"), jobs: count(main, "recompute_jobs"),
      generations: generations(main)
    }, before, "重放不得新增事实、批次、任务或推进代次");
    assert.deepEqual(readImportReceipt(main, batch.jobId), receipt, "持久回执不得被重放改写");
  });
});

// ---------------------------------------------------------------------------
// T07：同 batch/job id 不同内容
// ---------------------------------------------------------------------------

test("T07 同 job id 不同内容：显式身份冲突拒绝，原成功批次与回执不变", async () => {
  await fixture(async ({ main, input }) => {
    const original = await input(record(a), { job: "identity-1" });
    const first = await applyOrFail(original);
    assert.equal(first.summary.directSync?.ingestStatus, "committed");
    const receipt = readImportReceipt(main, "identity-1");
    const before = {
      records: count(main, "health_records"), batches: count(main, "import_batches"),
      generations: generations(main)
    };

    await assert.rejects(
      applyDirectSyncImport(await input(record(b), { job: "identity-1" })),
      /reused with different content/,
      "同 job id 不同内容必须显式拒绝，不能静默返回旧回执"
    );

    assert.deepEqual({
      records: count(main, "health_records"), batches: count(main, "import_batches"),
      generations: generations(main)
    }, before, "冲突批不得写入任何事实/批次/代次");
    assert.deepEqual(readImportReceipt(main, "identity-1"), receipt, "原成功回执必须一字不变");
    const row = read(main, (db) => db.prepare(
      "SELECT value_numeric AS value FROM health_records").get() as { value: number });
    assert.equal(Number(row.value), 10, "原批次的事实必须保持原值");
  });
});

// ---------------------------------------------------------------------------
// T10：删除 / 墓碑 / 共享来源 / 车道分析策略
// ---------------------------------------------------------------------------

test("T10 直连删除先于到达：墓碑阻止复活；删除-only 必须要求分析", async () => {
  await fixture(async ({ main, input }) => {
    const deletion = await input("", {
      job: "delete-first",
      deletedRecords: [{ type: step, uuid: a }]
    });
    const applied = await applyOrFail(deletion);
    assert.equal(applied.payloadClass, "analysis-required", "显式删除必须要求分析");
    assert.equal(applied.summary.directSync?.analysisStatus, "queued");
    assert.equal(analysisJob(main, "delete-first").status, "queued");
    assert.equal(count(main, "health_records"), 0);
    assert.equal(count(main, "import_source_tombstones"), 1, "删除必须留下墓碑");

    // 后到的同一 UUID 载荷不得复活它。
    await applyOrFail(await input(record(a), { job: "late-arrival" }));
    assert.equal(count(main, "health_records"), 0, "墓碑必须阻止后来载荷复活记录");
    assert.equal(count(main, "import_source_tombstones"), 1);
    assert.equal(count(main, "import_batches"), 2, "两个批次都要有账本行");
    assert.ok(readImportReceipt(main, "late-arrival"), "迟到批仍必须提交回执");
  });
});

test("T10 直连共享 UUID 来源：删除一个来源不误删另一来源", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(record(a, "10", step, undefined, undefined, "vendor")
      + record(b, "20", step, undefined, undefined, "vendor"));
    assert.equal(count(main, "health_records"), 1, "前提：两条 UUID 共享同一 canonical 行");
    assert.equal(count(main, "healthkit_record_sources"), 2);

    const applied = await applyOrFail(await input("", {
      job: "shared-delete",
      deletedRecords: [{ type: step, uuid: b }]
    }));
    assert.equal(applied.payloadClass, "analysis-required");
    assert.equal(applied.summary.directSync?.analysisStatus, "queued");

    assert.equal(count(main, "health_records"), 1, "共享行必须保留");
    // 墓碑来源行保留作证据；"只有一个存活来源"才是"没误删另一来源"的判据。
    assert.equal(count(main, "healthkit_record_sources"), 2, "已删来源的别名行保留作墓碑证据");
    const liveSources = read(main, (db) => Number((db.prepare(`
      SELECT COUNT(*) AS n FROM healthkit_record_sources source
      WHERE source.record_id = (SELECT id FROM health_records LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM import_source_tombstones tomb
          WHERE tomb.entity_kind='record' AND tomb.source_identifier =
            'healthkit-record:v2:' || source.sample_type || ':' || source.sample_uuid)`).get() as { n: number }).n));
    assert.equal(liveSources, 1, "只删除点名的那一个来源");
    const value = read(main, (db) => Number((db.prepare(
      "SELECT value_numeric AS value FROM health_records").get() as { value: number }).value));
    assert.equal(value, 10, "保留来源的值不得被删除来源覆盖");
    assert.equal(count(main, "import_source_tombstones", "WHERE entity_kind='record'"), 1);
  });
});

test("T10 data-only 白名单删除：not_required、无本批任务、raw+1 且 dependency 不变", async () => {
  await fixture(async ({ main, input }) => {
    const applied = await applyDataOnlyImport(await input("", {
      job: "data-only-delete",
      deletedRecords: [{ type: step, uuid: a }]
    }));
    assert.ok(applied, "白名单类型的显式删除可以走 data-only");
    assert.equal(applied.summary.directSync?.ingestStatus, "committed");
    assert.equal(applied.summary.directSync?.analysisStatus, "not_required",
      "data-only 在入口证明了载荷碰不到分析 ⇒ 删除也合法 not_required");
    assert.equal(applied.summary.analysisJobId, null);
    assert.equal(count(main, "recompute_jobs"), 0, "data-only 不得登记本批任务");
    assert.deepEqual(generations(main), { raw: 1, dependency: 0 }, "raw 前进、dependency 不动");
    assert.equal(count(main, "import_source_tombstones"), 1);
  });
});

// ---------------------------------------------------------------------------
// T11：GPX 内容变化 / 同大小替换 / 路线归属 A→B
// ---------------------------------------------------------------------------

const gpx = (marker = "1"): string =>
  `<gpx><trk><trkseg>${[0, 1, 2].map((index) =>
    `<trkpt lat="23.1${marker}${index}" lon="113.3${index}"><ele>12.5</ele>` +
    `<time>2018-01-02T00:00:0${index}Z</time></trkpt>`
  ).join("")}</trkseg></trk></gpx>`;

test("T11 同大小 GPX 内容替换：发布新路线版本，并按路线归属把分析标脏", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(workout("2018-01-02 08:00:00 +0000", "workout-a"));
    const first = await applyOrFail(await input(
      workout("2018-01-02 08:00:00 +0000", "workout-a", "route-1.gpx"),
      { job: "gpx-first", gpx: { "route-1.gpx": gpx("1") } }));
    assert.equal(first.summary.directSync?.analysisStatus, "queued");
    const routeSha = (): string => read(main, (db) => String((db.prepare(`
      SELECT version.content_sha256 AS sha FROM workout_routes route
      JOIN route_versions version ON version.id = route.published_route_version_id
      WHERE route.relative_path = 'workout-routes/route-1.gpx'`).get() as { sha: string }).sha));
    const firstSha = routeSha();

    const changed = gpx("9");
    assert.equal(Buffer.byteLength(changed), Buffer.byteLength(gpx("1")),
      "夹具必须是同字节数的内容替换");
    const second = await applyOrFail(await input(
      workout("2018-01-02 08:00:00 +0000", "workout-a", "route-1.gpx"),
      { job: "gpx-same-size", gpx: { "route-1.gpx": changed } }));
    assert.equal(second.summary.directSync?.analysisStatus, "queued");

    // 路线版本 id 是确定性的（每条路线一个 published 槽位），所以"版本数"不是判据；
    // 判据是**已发布内容摘要真的换了**，且不是靠文件数量/大小变化才换的。
    const secondSha = routeSha();
    assert.notEqual(secondSha, firstSha, "同大小内容替换必须被 sha 区分并发布新版本");
    assert.equal(secondSha, createHash("sha256").update(changed).digest("hex"),
      "已发布版本的摘要必须等于新 GPX 文件内容的 sha256");
    const evidence = dirtyEvidence(main, "gpx-same-size");
    assert.ok(evidence.routeDirtyTimes.some((time) => time.startsWith("2018-01-02T08:00:00")),
      `路线变更必须把所属训练标脏（实际 ${JSON.stringify(evidence.routeDirtyTimes)}）`);
    assert.equal(evidence.full, false, "有界路线变更不应退化成 full");
  });
});

test("T11 路线归属 A→B（同内容）：旧、新归属都必须进入脏证据", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(workout("2018-01-02 08:00:00 +0000", "workout-a")
      + workout("2018-01-03 08:00:00 +0000", "workout-b"));
    await applyOrFail(await input(
      workout("2018-01-02 08:00:00 +0000", "workout-a", "route-1.gpx"),
      { job: "route-first", gpx: { "route-1.gpx": gpx("1") } }));

    // 同一个 GPX 路径、同一份字节，但 WorkoutRoute 换到 B。
    const moved = await applyOrFail(await input(
      workout("2018-01-03 08:00:00 +0000", "workout-b", "route-1.gpx"),
      { job: "route-move", gpx: { "route-1.gpx": gpx("1") } }));
    assert.equal(moved.summary.directSync?.analysisStatus, "queued");

    const owner = read(main, (db) => db.prepare(`
      SELECT workout.start_at AS startAt FROM workout_routes route
      JOIN workouts workout ON workout.id = route.workout_id
      WHERE route.relative_path = 'workout-routes/route-1.gpx'`).get() as { startAt: string });
    assert.ok(owner.startAt.startsWith("2018-01-03T08:00:00"), "路线行必须改归 B");

    const evidence = dirtyEvidence(main, "route-move");
    assert.ok(evidence.routeDirtyTimes.some((time) => time.startsWith("2018-01-02T08:00:00")),
      `旧归属 A 必须标脏（实际 ${JSON.stringify(evidence.routeDirtyTimes)}）`);
    assert.ok(evidence.routeDirtyTimes.some((time) => time.startsWith("2018-01-03T08:00:00")),
      `新归属 B 必须标脏（实际 ${JSON.stringify(evidence.routeDirtyTimes)}）`);
    assert.ok(evidence.dirtyFromAt !== null && evidence.dirtyFromAt <= "2018-01-02T08:00:00.000Z",
      `边界必须覆盖旧归属，不得只从 B 开始（实际 ${evidence.dirtyFromAt}）`);
  });
});

test("T11 仅 XML 改归属、未附 GPX：旧 A/新 B 都脏，路线点与已发布版本保留", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(workout("2018-01-02 08:00:00 +0000", "workout-a")
      + workout("2018-01-03 08:00:00 +0000", "workout-b"));
    const first = await applyOrFail(await input(
      workout("2018-01-02 08:00:00 +0000", "workout-a", "route-1.gpx"),
      { job: "xml-route-first", gpx: { "route-1.gpx": gpx("1") } }));
    assert.equal(first.summary.routesUpdated, 1);
    // P2-8 边界：字节与归属都没有变化的路线不计入 routesUpdated。
    const unchanged = await applyOrFail(await input(
      workout("2018-01-02 08:00:00 +0000", "workout-a", "route-1.gpx"),
      { job: "xml-route-unchanged", gpx: { "route-1.gpx": gpx("1") } }));
    assert.equal(unchanged.summary.routesUpdated, 0,
      "内容与归属都未变的路线不是「本批变化的路线」");
    const before = read(main, (db) => db.prepare(`
      SELECT route.id AS id, route.point_count AS pointCount,
             route.published_route_version_id AS versionId,
             workout.start_at AS startAt
      FROM workout_routes route JOIN workouts workout ON workout.id = route.workout_id
      WHERE route.relative_path = 'workout-routes/route-1.gpx'`).get() as {
        id: string; pointCount: number; versionId: string | null; startAt: string;
      });
    assert.ok(before.startAt.startsWith("2018-01-02T08:00:00"));
    assert.equal(before.pointCount, 3);
    assert.ok(before.versionId, "首批必须发布路线版本");

    // 关键变体：增量包**没有** workout-routes/route-1.gpx，只有 XML 的显式
    // WorkoutRoute 引用把旧路线改挂到 B。旧实现按 GPX 文件清单快照，A 不会脏。
    const moved = await applyOrFail(await input(
      workout("2018-01-03 08:00:00 +0000", "workout-b", "route-1.gpx"),
      { job: "xml-route-move" }));
    assert.equal(moved.summary.directSync?.analysisStatus, "queued");
    assert.equal(moved.summary.routesUpdated, 1, "仅 XML 改归属也必须计入本批路线变更");

    const after = read(main, (db) => db.prepare(`
      SELECT route.id AS id, route.point_count AS pointCount,
             route.published_route_version_id AS versionId,
             workout.start_at AS startAt
      FROM workout_routes route JOIN workouts workout ON workout.id = route.workout_id
      WHERE route.relative_path = 'workout-routes/route-1.gpx'`).get() as {
        id: string; pointCount: number; versionId: string | null; startAt: string;
      });
    assert.ok(after.startAt.startsWith("2018-01-03T08:00:00"), "路线必须改归 B");
    assert.equal(after.id, before.id, "必须复用旧 route 行（不改 route id）");
    assert.equal(after.pointCount, before.pointCount, "路线点必须保留");
    assert.equal(after.versionId, before.versionId, "已发布路线版本必须保留");

    const evidence = dirtyEvidence(main, "xml-route-move");
    assert.ok(evidence.routeDirtyTimes.some((time) => time.startsWith("2018-01-02T08:00:00")),
      `旧归属 A 必须进入脏证据（实际 ${JSON.stringify(evidence.routeDirtyTimes)}）`);
    assert.ok(evidence.routeDirtyTimes.some((time) => time.startsWith("2018-01-03T08:00:00")),
      `新归属 B 必须进入脏证据（实际 ${JSON.stringify(evidence.routeDirtyTimes)}）`);
    assert.ok(evidence.dirtyFromAt !== null && evidence.dirtyFromAt <= "2018-01-02T08:00:00.000Z",
      `有界边界必须覆盖 A（实际 ${evidence.dirtyFromAt}）`);
    assert.equal(evidence.full, false, "路线归属变化不应退化成 full");
  });
});

test("T11 孤儿 GPX 被 XML 训练认领且不重传文件：归属变化计入路线回执", async () => {
  await fixture(async ({ main, input }) => {
    await applyOrFail(await input("", {
      job: "orphan-route-first", gpx: { "route-1.gpx": gpx("1") }
    }));
    const orphan = read(main, (db) => db.prepare(`SELECT id, workout_id AS workoutId,
      point_count AS pointCount FROM workout_routes
      WHERE relative_path='workout-routes/route-1.gpx'`).get() as
      { id: string; workoutId: string | null; pointCount: number });
    assert.equal(orphan.workoutId, null, "首批 GPX 必须确实生成孤儿路线");

    const claimed = await applyOrFail(await input(
      workout("2018-01-03 08:00:00 +0000", "workout-b", "route-1.gpx"),
      { job: "orphan-route-claimed" }
    ));
    assert.equal(claimed.summary.routesUpdated, 1, "null → 训练 B 的归属变化也必须计入路线回执");
    const owner = read(main, (db) => db.prepare(`SELECT id, workout_id AS workoutId,
      point_count AS pointCount FROM workout_routes
      WHERE relative_path='workout-routes/route-1.gpx'`).get() as
      { id: string; workoutId: string | null; pointCount: number });
    assert.equal(owner.id, orphan.id, "认领必须保留同一条路线");
    assert.ok(owner.workoutId, "路线必须归属新训练");
    assert.equal(owner.pointCount, orphan.pointCount, "未重传 GPX 时必须保留既有点");
    assert.ok(dirtyEvidence(main, "orphan-route-claimed").routeDirtyTimes.some(
      (time) => time.startsWith("2018-01-03T08:00:00")), "新父训练必须进入脏范围");
  });
});

test("T11 同批同一路径出现两次归属变更：确定性拒收，整批回滚", async () => {
  await fixture(async ({ main, input, seed }) => {
    await seed(workout("2018-01-02 08:00:00 +0000", "workout-a")
      + workout("2018-01-03 08:00:00 +0000", "workout-b")
      + workout("2018-01-04 08:00:00 +0000", "workout-c"));
    await applyOrFail(await input(
      workout("2018-01-02 08:00:00 +0000", "workout-a", "route-1.gpx"),
      { job: "conflict-first", gpx: { "route-1.gpx": gpx("1") } }));
    const before = {
      workouts: count(main, "workouts"),
      batches: count(main, "import_batches"),
      routes: count(main, "workout_routes"),
      changes: count(main, "import_entity_changes"),
      jobs: count(main, "recompute_jobs"),
      receipts: count(main, "import_manifest"),
      owner: read(main, (db) => String((db.prepare(`
        SELECT workout.start_at AS startAt FROM workout_routes route
        JOIN workouts workout ON workout.id = route.workout_id
        WHERE route.relative_path = 'workout-routes/route-1.gpx'`).get() as { startAt: string }).startAt))
    };

    // 当前归属 A；XML 先改到 C（事件 1）、再改到 B（事件 2）：同一 route id 两次变更。
    // P2-6：这是**稳定拒收**（返回 DirectSyncRejection），不是抛裸 Error；整批仍然回滚。
    const conflict = await applyDirectSyncImport(await input(
      workout("2018-01-04 08:00:00 +0000", "workout-c", "route-1.gpx")
      + workout("2018-01-03 08:00:00 +0000", "workout-b", "route-1.gpx"),
      { job: "conflict-double" }));
    assert.ok(isDirectSyncRejection(conflict), "同批矛盾归属必须拒收，不能按 XML 顺序静默取最后一个");
    assert.equal(conflict.reason, "route_ownership_conflict");
    assert.match(String(conflict.detail), /changed ownership more than once/);
    assert.equal(count(main, "workouts"), before.workouts);
    assert.equal(count(main, "import_batches"), before.batches);
    assert.equal(count(main, "workout_routes"), before.routes);
    assert.equal(count(main, "import_entity_changes"), before.changes,
      "拒收不得留下事实账本行");
    assert.equal(count(main, "recompute_jobs"), before.jobs,
      "拒收不得登记分析任务");
    assert.equal(count(main, "import_manifest"), before.receipts,
      "拒收不得写回执");
    assert.equal(readImportReceipt(main, "conflict-double"), null,
      "矛盾批次不得有可重放回执");
    assert.equal(count(main, "import_batches", "WHERE id='conflict-double'"), 0,
      "矛盾批次不得留下批次/脏证据行");
    assert.equal(read(main, (db) => String((db.prepare(`
      SELECT workout.start_at AS startAt FROM workout_routes route
      JOIN workouts workout ON workout.id = route.workout_id
      WHERE route.relative_path = 'workout-routes/route-1.gpx'`).get() as { startAt: string }).startAt)),
    before.owner, "拒收不得改变原归属");
  });
});

// ---------------------------------------------------------------------------
// T14：边界语义（严格 >；等于上限接收）
// ---------------------------------------------------------------------------

test("T14 上限常量未被放宽：直连 8 MiB / 删除配额 5000 / 200 / 64 MiB，data-only 2 MiB / 5000", () => {
  assert.equal(DIRECT_SYNC_MAX_XML_BYTES, 8 * 1024 * 1024);
  assert.equal(DIRECT_SYNC_MAX_RECORDS, 5000);
  assert.equal(DIRECT_SYNC_MAX_ROUTE_FILES, 200);
  assert.equal(DIRECT_SYNC_MAX_ROUTE_BYTES, 64 * 1024 * 1024);
  assert.equal(DATA_ONLY_MAX_XML_BYTES, 2 * 1024 * 1024);
  assert.equal(DATA_ONLY_MAX_RECORDS, 5000);
});

test("T14 data-only 纯判据：2 MiB 恰好接收、+1 字节拒绝；5000 条接收、5001 条拒绝", async () => {
  await fixture(async ({ main, input }) => {
    const skeleton = Buffer.byteLength(xml(record(a, "")), "utf8");
    const exactXml = xml(record(a, "1".repeat(2 * 1024 * 1024 - skeleton)));
    assert.equal(Buffer.byteLength(exactXml), 2 * 1024 * 1024, "夹具必须精确落在 2 MiB");
    assert.equal(isDataOnlyRecordXml(exactXml), true, "恰好 2 MiB 必须仍然可走 data-only（严格 >）");
    const overXml = xml(record(a, "1".repeat(2 * 1024 * 1024 - skeleton + 1)));
    assert.equal(Buffer.byteLength(overXml), 2 * 1024 * 1024 + 1);
    assert.equal(isDataOnlyRecordXml(overXml), false, "2 MiB+1 必须拒绝（不能改成 >=）");

    const repeat = (n: number): string => `<HealthData>${Array.from({ length: n }, (_, index) =>
      record(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)).join("")}</HealthData>`;
    const atLimit = repeat(5000);
    const oneOver = repeat(5001);
    assert.ok(Buffer.byteLength(atLimit) < 2 * 1024 * 1024, "夹具在字节维度必须合规，才测得到条数维度");
    assert.equal(isDataOnlyRecordXml(atLimit), true, "恰好 5000 条必须接收");
    assert.ok(Buffer.byteLength(oneOver) < 2 * 1024 * 1024);
    assert.equal(isDataOnlyRecordXml(oneOver), false, "5001 条必须拒绝");

    // 终态一面：5001 条在 data-only 入口被拒后零写入；worker 随后交给直连，直连按产品合同接收它（maxRecords 只限删除配额）。
    const before = count(main, "health_records");
    assert.equal(await applyDataOnlyImport(await input(oneOver, { job: "data-only-5001" })), null);
    assert.equal(count(main, "health_records"), before, "data-only 拒收不得留下半批");
    assert.equal(readImportReceipt(main, "data-only-5001"), null);
  });
});

test("T14 直连 XML record 数不设上限（maxRecords 只限删除配额）：5001 条在 8 MiB 内必须接收", { timeout: 120_000 }, async () => {
  await fixture(async ({ main, input }) => {
    // 产品合同（api-contracts:223-229 / IOS_NATIVE_API_CONTRACT:66）：`directSyncBounds.maxRecords`
    // 只约束 manifest 的**删除配额**，不是 XML `<Record>` 条数；iOS `DirectSyncBatchBudget.swift`
    // 明确允许到 12,000 条。因此 5001 条 XML 记录是合法载荷，不得按 5000 拒收。
    const repeat = (n: number): string => {
      const pad = (value: number): string => String(value).padStart(2, "0");
      return `<HealthData>${Array.from({ length: n }, (_, index) => {
        const moment = new Date(Date.UTC(2018, 0, 1, 0, 0, index));
        const stamp = `${moment.getUTCFullYear()}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())} ` +
          `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())} +0000`;
        return record(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          "10", step, stamp, stamp);
      }).join("")}</HealthData>`;
    };

    const overPlanLimit = await applyOrFail(await input(repeat(5001), { job: "records-5001" }));
    assert.equal(overPlanLimit.summary.directSync?.ingestStatus, "committed");
    assert.equal(overPlanLimit.summary.directSync?.analysisStatus, "not_required");
    assert.equal(count(main, "health_records"), 5001, "5001 条必须全部落库（不得按 5000 拒收）");
    assert.equal(readImportReceipt(main, "records-5001")?.directSync?.records?.parsed, 5001);
    assert.equal(count(main, "import_batches"), 1);
    assert.equal(count(main, "recompute_jobs"), 0);
    assert.deepEqual(generations(main), { raw: 1, dependency: 0 });

    // 真正受 5000 约束的是删除配额：恰好 5000 条删除接收，5001 条删除在 prepare 终态拒收。
    const deletions = (n: number): { type: string; uuid: string }[] => Array.from({ length: n }, (_, index) => ({
      type: step, uuid: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`
    }));
    const atLimit = await applyOrFail(await input("", { job: "deletions-5000", deletedRecords: deletions(5000) }));
    assert.equal(atLimit.summary.directSync?.ingestStatus, "committed");
    assert.equal(atLimit.summary.directSync?.analysisStatus, "queued");
    assert.equal(count(main, "import_source_tombstones"), 5000, "恰好 5000 条删除必须全部留墓碑");

    const over = await applyDirectSyncImport(await input("", {
      job: "deletions-5001", deletedRecords: deletions(5001)
    }));
    assert.ok(isDirectSyncRejection(over), "5001 条删除必须终态拒收");
    assert.equal(over.reason, "deletions_exceed_bounds");
    assert.equal(over.stage, "prepare");
    assert.equal(over.actual?.deletions, 5001);
    assert.equal(over.bounds?.maxRecords, 5000);

    assert.equal(count(main, "import_source_tombstones"), 5000, "拒收批不得留下额外墓碑");
    assert.equal(count(main, "import_batches"), 2, "拒收批不得留下批次行");
    assert.deepEqual(generations(main), { raw: 2, dependency: 1 }, "拒收批不得推进代次");
    assert.equal(readImportReceipt(main, "deletions-5001"), null);
  });
});

test("T14 GPX 边界：200 文件恰好接收、201 拒绝；64 MiB 恰好接收、+1 字节拒绝", async () => {
  await fixture(async ({ root }) => {
    const make = (name: string, files: number, bytesPerFile: number): string => {
      const dir = join(root, name);
      mkdirSync(join(dir, "workout-routes"), { recursive: true });
      writeFileSync(join(dir, "export.xml"), xml(""));
      writeFileSync(join(dir, "sync-manifest.json"), JSON.stringify({
        version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
      }));
      for (let index = 0; index < files; index += 1) {
        const path = join(dir, "workout-routes", `route-${index}.gpx`);
        writeFileSync(path, "");
        if (bytesPerFile > 0) {
          // 稀疏文件：只改逻辑大小，避免真的写 64 MiB 数据。
          const fd = openSync(path, "r+");
          ftruncateSync(fd, bytesPerFile);
          closeSync(fd);
        }
      }
      return dir;
    };

    const at200 = preflightDirectSyncPayload(make("gpx-200", 200, 0));
    assert.equal(at200.ok, true, `恰好 200 个 GPX 必须接收，实际 ${JSON.stringify(at200)}`);
    const at201 = preflightDirectSyncPayload(make("gpx-201", 201, 0));
    assert.ok(!at201.ok);
    assert.equal(at201.rejection.reason, "route_exceeds_bounds");
    assert.equal(at201.rejection.actual?.routeFiles, 201);
    assert.equal(at201.rejection.bounds?.maxRouteFiles, 200);

    const exact = preflightDirectSyncPayload(make("gpx-64m", 1, 64 * 1024 * 1024));
    assert.equal(exact.ok, true, `恰好 64 MiB GPX 必须接收，实际 ${JSON.stringify(exact)}`);
    const over = preflightDirectSyncPayload(make("gpx-64m-1", 1, 64 * 1024 * 1024 + 1));
    assert.ok(!over.ok);
    assert.equal(over.rejection.reason, "route_exceeds_bounds");
    assert.equal(over.rejection.actual?.routeBytes, 64 * 1024 * 1024 + 1);
    assert.equal(over.rejection.bounds?.maxRouteBytes, 64 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// F04：dirty evidence 回读失败 ⇒ 整批回滚
// ---------------------------------------------------------------------------

test("F04 分析脏证据写入被静默忽略（回读不一致）⇒ 事实/批次/任务/回执整批回滚", async () => {
  await fixture(async ({ main, input }) => {
    const db = new DatabaseSync(main);
    db.exec(`CREATE TRIGGER ignore_dirty_evidence BEFORE UPDATE OF analysis_dirty_plan_json ON import_batches
      BEGIN SELECT RAISE(IGNORE); END`);
    db.close();
    const batch = await input(record(c) + workout(), { job: "dirty-evidence-fail" });
    await assert.rejects(applyDirectSyncImport(batch), /analysis dirty plan read-back mismatch/);

    assert.equal(count(main, "health_records"), 0, "事实必须回滚");
    assert.equal(count(main, "workouts"), 0, "训练必须回滚");
    assert.equal(count(main, "import_batches"), 0, "批次行必须回滚");
    assert.equal(count(main, "recompute_jobs"), 0, "登记的分析任务必须回滚");
    assert.deepEqual(generations(main), { raw: 0, dependency: 0 }, "代次计数器不得留下痕迹");
    assert.equal(readImportReceipt(main, "dirty-evidence-fail"), null);
  });
});
