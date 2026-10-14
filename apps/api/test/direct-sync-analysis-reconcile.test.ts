// 分析终态对账（PR6 / task-5）：回执必须带上**分析任务 id**，好让客户端能问到一个终态。
//
// 为什么单开一个文件而不是扩 `direct-sync-ingest.test.ts`：那条路径上的既有断言（回执与批次账本
// 的 deep-equal、逐字段比对）正被其他人在读/改，新增键会让那些断言同时改动多处；本文件把
// "回执多了 `analysisJobId`" 这件事的**全部**判据收在一个新路径上，并发面最小。
//
// 这个文件要证明三件事（docs/SQLITE_DIRECT_SYNC_DESIGN.md §10.1 / §10.3 / §9.1）：
//
//   1. 需要分析的批次：回执里的 `analysisJobId` **确实等于** `recompute_jobs` 里那一行，
//      而且与 `import_batches.summary_json.analysisJobId` 同源（三处一个值）。
//      少了它，客户端只知道自己"提交过一批需要分析的事实"，永远问不到结果 ⇒
//      §10.3 的「分析已更新」/「…分析更新失败，可重试分析」在真机上不可达。
//   2. `record-only` 批次：`analysisJobId` 是 **`null`**，**不是缺键** —— "问过了，没有分析任务"
//      与"这个服务端版本还没提供这个字段"在客户端是两种含义（§9.1 不许把 `not_required`
//      读成"分析已完成"）。
//   3. 🔴 **回执不因分析推进而变**：把分析任务真的跑完之后重读回执，`analysisStatus` 仍是
//      `queued`、`analysisJobId` 仍是同一个串。回执是**写入时刻的凭证**（§8.5：消费者不得改写它），
//      "分析已更新"必须来自**独立通道**的对账（`GET /v1/jobs/:id`）。这一条是本轮的核心语义：
//      它把"回执 = 事实已保存"与"分析另行跟踪"两件事钉成两个不可互换的结论。
//
// ⚠️ 界限：本文件证明的是**服务端把 id 交出来了**。客户端拿它去 `GET /v1/jobs/:id` 并改写
// 展示结论那一半是 iOS 的（`DirectSyncCursorPolicy.reconcileAnalysis` + `HealthKitSync`），
// 本机（Windows，无 swiftc）**不编译也不执行** Swift —— 见 `deliverables/` 里的交付记录。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION, healthTypes, workoutTypes } from "@rai/contracts";
import { RaiApplicationService } from "@rai/application";
import { RaiDatabase } from "@rai/storage-sqlite";
import { NATIVE_VERSION, identityAlgorithmFingerprint } from "@rai/health-export-parser";

import {
  applyDirectSyncImport, isDirectSyncRejection, type DirectSyncImportInput, type DirectSyncImportResult
} from "../src/direct-sync-ingest.js";
import { readImportReceipt } from "../src/import-publication.js";
import { computeImportPayloadSha256 } from "../src/import-payload-identity.js";

const uuid = "00000000-0000-0000-0000-00000000000a";
const step = healthTypes.stepCount;

function record(value = "10"): string {
  return `<Record type="${step}" sourceName="Watch" unit="count" value="${value}"
    startDate="2018-01-01 00:00:00 +0000" endDate="2018-01-01 00:01:00 +0000">
    <MetadataEntry key="RAIHealthKitSampleUUID" value="${uuid}"/>
  </Record>`;
}

function workout(): string {
  return `<Workout workoutActivityType="${workoutTypes.running}" sourceName="Watch"
    startDate="2018-01-02 08:00:00 +0000" endDate="2018-01-02 08:30:00 +0000"
    duration="30" durationUnit="min">
    <MetadataEntry key="HKMetadataKeySyncIdentifier" value="workout-1"/>
  </Workout>`;
}

const xml = (rows: string) => `<HealthData>${rows}</HealthData>`;

/**
 * 观测版（阶段 1）：`applyDirectSyncImport` 返回「成功 | 拒收」判别联合。
 * 本文件全部调用都**期望成功**，统一走这里 —— 拒收时把拒收码完整打进断言消息。
 */
async function applyOrFail(input: DirectSyncImportInput): Promise<DirectSyncImportResult> {
  const outcome = await applyDirectSyncImport(input);
  assert.ok(!isDirectSyncRejection(outcome),
    `expected a successful apply, got rejection: ${JSON.stringify(outcome)}`);
  return outcome;
}

interface Fixture {
  main: string;
  input(rows?: string): Promise<DirectSyncImportInput>;
}

/** 与 `direct-sync-ingest.test.ts` 同源的夹具：同一条生产摘要函数、同一份导入目录形状。 */
async function fixture(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "rai-analysis-reconcile-"));
  const main = join(root, "rai.sqlite");
  const store = await RaiDatabase.open(main);
  store.setManifest("dataset_version", "baseline");
  store.setManifest("parser_contract_version", CONTRACT_VERSION);
  store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
  store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
  store.setProfile({ dateOfBirth: "1990-01-01" });
  store.close();
  let ordinal = 0;
  const input: Fixture["input"] = async (rows = "") => {
    const inputPath = join(root, `input-${ordinal++}`);
    mkdirSync(inputPath);
    writeFileSync(join(inputPath, "export.xml"), xml(rows));
    writeFileSync(join(inputPath, "sync-manifest.json"), JSON.stringify({
      version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
    }));
    const payloadSha256 = await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true, contractVersion: CONTRACT_VERSION,
      engine: `typescript@${NATIVE_VERSION}`, identityAlgorithm: identityAlgorithmFingerprint()
    });
    return { databasePath: main, inputPath, jobId: "delta", payloadSha256, startedAtMs: Date.now() };
  };
  try { await run({ main, input }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

/** 只读打开一次，问几个问题，关掉。 */
function read<T>(main: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(main, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

test("需要分析的批次：回执的 analysisJobId 等于 recompute_jobs 那一行，且与批次账本同源", async () => {
  await fixture(async ({ main, input }) => {
    const batch = await input(workout());
    const applied = await applyOrFail(batch);
    assert.ok(applied, "含 Workout 的载荷必须被接收");
    assert.equal(applied.payloadClass, "analysis-required");
    // 前提：本批**确实**跑在直连车道上、回执真的说 queued（否则下面那条断言会假绿）。
    assert.equal(applied.summary.directSync?.ingestStatus, "committed");
    assert.equal(applied.summary.directSync?.analysisStatus, "queued");

    const jobId = applied.summary.analysisJobId;
    assert.equal(typeof jobId, "string", "需要分析的批次必须交出分析任务 id（否则客户端永远问不到终态）");
    assert.notEqual(jobId, "", "空串不是「没有任务」，它是「有任务但 id 是空的」—— 两者都不可用");
    // 🔴 `assert.ok` 不只是运行时断言，它同时是 `tsc` 的**类型收窄**：合同里
    // `analysisJobId` 是 `string | null | undefined`（可选键 + 允许 null），少了这一句
    // 后面每一处 `db.prepare(...).get(jobId)` 都会 TS2769（`undefined` 不是 `SQLInputValue`）。
    // 这一条是**只能靠 `npm run typecheck` 发现**的：`tsx` 剥类型后运行时照样绿。
    assert.ok(jobId, "上面两条断言必须把 jobId 收窄成非空 string");

    read(main, (db) => {
      const rows = db.prepare("SELECT id, job_type AS jobType, status FROM recompute_jobs").all() as
        Array<{ id: string; jobType: string; status: string }>;
      assert.equal(rows.length, 1, "含 Workout 的批次必须登记恰好一个分析任务");
      assert.equal(jobId, rows[0]!.id, "回执里的 id 必须就是那条真实任务 —— 差一个字符，客户端就会去问一个不存在的任务");
      assert.equal(rows[0]!.jobType, "import");
      assert.equal(rows[0]!.status, "queued", "登记完只是排队；回执说 queued 与任务状态一致");
    });

    // 三处同源：用户可见回执 / 批次账本 / 真实任务行。批次账本那一处**今天已经在写**
    // （`direct-sync-ingest.ts` 的 batchSummary），本用例把"回执跟它一致"钉住 ——
    // 将来谁把回执的 id 换成别的（例如换成 sourceId），这里立刻红。
    const ledger = read(main, (db) => JSON.parse(String((db.prepare(
      "SELECT summary_json AS summary FROM import_batches WHERE id = ?"
    ).get(batch.jobId) as { summary: string }).summary)) as { analysisJobId?: unknown });
    assert.equal(ledger.analysisJobId, jobId, "回执与批次账本必须指向同一个任务");

    // 持久回执（磁盘上那份，不是内存里返回的那个对象）也必须带着这个键。
    const persisted = readImportReceipt(main, batch.jobId);
    assert.equal(persisted?.analysisJobId, jobId, "回执要落盘，不能只在响应里出现一次");
    assert.deepEqual(readImportReceipt(main, batch.jobId), applied.summary,
      "持久回执必须与本次返回的摘要逐字段一致");
  });
});

test("record-only 批次：analysisJobId 是 null（不是缺键）", async () => {
  await fixture(async ({ main, input }) => {
    const batch = await input(record());
    const applied = await applyOrFail(batch);
    assert.ok(applied, "record-only 载荷必须被接收");
    assert.equal(applied.payloadClass, "record-only");
    assert.equal(applied.summary.directSync?.analysisStatus, "not_required");

    assert.equal(applied.summary.analysisJobId, null,
      "本批不登记分析任务 ⇒ 如实写 null");
    // 🔴 `null` 与"缺键"必须分开：客户端读 `undefined` 时只能说"问不到"，
    // 读 `null` 才能说"问过了，没有分析任务"。缺键会让 §9.1 的 `not_required`
    // 与"老服务端"混成同一格。
    assert.ok(Object.hasOwn(applied.summary, "analysisJobId"),
      "键必须存在（值为 null），不能靠省略来表达「没有分析任务」");
    assert.equal(read(main, (db) => Number((db.prepare(
      "SELECT COUNT(*) AS n FROM recompute_jobs"
    ).get() as { n: number }).n)), 0, "record-only 批次不得登记分析任务");

    const persisted = readImportReceipt(main, batch.jobId);
    assert.ok(persisted && Object.hasOwn(persisted, "analysisJobId"),
      "落盘的回执同样必须带这个键（客户端重启后读的是这一份）");
    assert.equal(persisted.analysisJobId, null);
  });
});

test("🔴 回执不因分析推进而变：跑完分析后重读，analysisStatus 仍是 queued、id 仍是同一个", async () => {
  await fixture(async ({ main, input }) => {
    const batch = await input(workout());
    const applied = await applyOrFail(batch);
    assert.ok(applied);
    const jobId = applied.summary.analysisJobId;
    assert.equal(typeof jobId, "string");
    // 与上面同一句理由：`assert.ok` 是 `tsc` 的类型收窄，不只是运行时判据。
    assert.ok(jobId, "jobId 必须是可用的任务 id（下面要用它查任务行）");
    const before = readImportReceipt(main, batch.jobId);
    assert.ok(before, "回执必须在同一个事务里落库");

    // 用**真消费者**把这条任务跑完（与 `direct-sync-ingest.test.ts` 的"闭环"同一手法）。
    const store = await RaiDatabase.open(main);
    let completedId: string | undefined;
    let completedStatus: string | undefined;
    try {
      const completed = new RaiApplicationService(store).runNextJob();
      completedId = completed?.id;
      completedStatus = completed?.status;
    } finally { store.close(); }
    assert.equal(completedId, jobId, "消费者必须领到本批登记的那条任务");
    assert.equal(completedStatus, "succeeded", "分析必须真的跑成功了，否则这条用例没证明「推进之后」");

    // ① 分析通道**确实**到了终态。这是客户端对账要问的东西 ——
    //    读侧投影就是 `GET /v1/jobs/:id` 走的那条路（`apps/api/src/data.ts` 的 `mapJobFromDomain`）。
    const projected = read(main, (db) => db.prepare(
      "SELECT status FROM recompute_jobs WHERE id = ?"
    ).get(jobId) as { status: string } | undefined);
    assert.equal(projected?.status, "succeeded", "任务行必须反映终态");

    // ② 回执**一个字节都没变**（§8.5：消费者不得改写它）。
    const after = readImportReceipt(main, batch.jobId);
    assert.deepEqual(after, before,
      "分析跑完之后回执必须逐字段不变 —— 它记的是「服务端当时提交了什么」，不是「分析现在到哪了」");
    assert.equal(after?.directSync?.analysisStatus, "queued",
      "回执里的 analysisStatus 是 COMMIT 快照，永远停在 queued");
    assert.equal(after?.analysisJobId, jobId, "对账用的 id 也不得被改写");
    // ③ 结论不能混：回执的**事实那一半**仍然只说 committed，它没有、也不该有"分析已发布"。
    assert.equal(after?.directSync?.publishedReleaseId, null,
      "回执不得声称已发布分析（那是分析那一半的结论，§9.1）");
  });
});
