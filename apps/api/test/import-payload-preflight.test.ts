import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CONTRACT_VERSION } from "@rai/contracts";
import { NATIVE_VERSION, identityAlgorithmFingerprint } from "@rai/health-export-parser";
import { RaiDatabase } from "@rai/storage-sqlite";

import {
  IMPORT_PAYLOAD_ANCHOR_KEY,
  computeImportPayloadSha256,
  importPayloadSha256,
  readDatabaseImportIdentity
} from "../src/import-payload-identity.js";
import { ImportWorker } from "../src/worker.js";
import { MutationCoordinator } from "../src/mutation-coordinator.js";
import { TaskAdmissionScheduler } from "../src/task-admission.js";

/**
 * The pre-flight short-circuit answers "did this payload change anything?" from
 * the payload alone, before the import pays for an O(database) backup, staging
 * copy, parse and diff. These tests pin both halves: that the identity is
 * sensitive to everything that changes what an import writes, and that every
 * guard which makes a short-circuit unsound actually disables it.
 */

/**
 * G4（2026-10-15）：锚点写入函数已随死代码清理退役（生产唯一调用方 command()
 * 不复存在）。fixture 需要的"预置锚点"改为内联 SQL 直写 manifest。
 */
function writeAnchor(databasePath: string, anchor: { sha256: string; datasetVersion: string }): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)")
      .run(IMPORT_PAYLOAD_ANCHOR_KEY, JSON.stringify(anchor));
  } finally { db.close(); }
}

interface PreflightSurface {
  executionEngine: { name: string; version: string; fallback: "none" | "typescript" };
  run(job: Record<string, unknown>): Promise<void>;
  detectUnchangedPayload(
    job: Record<string, unknown>,
    engine: { name: string; version: string; fallback: "none" | "typescript" }
  ): Promise<{ sha256: string; datasetVersion: string; unchangedWorkouts: number } | null>;
}

/**
 * 排队构造（2026-10-14）：`planDirectSyncLane` 第一条要求 `job.queue && queueOptions`
 * （`import-worker.ts:649`），无队列直跑会被 `not_queued` 拒收；收口后拒收 = 显式失败
 * （旧候选回退已删）。`admission` 用测试同款的最小调度器。
 */
const preflightWorker = (databasePath: string, root: string): PreflightSurface =>
  new ImportWorker(databasePath, root, root, undefined, undefined, undefined, {
    scope: "preflight",
    admission: new TaskAdmissionScheduler(new MutationCoordinator()).owner("import")
  }) as unknown as PreflightSurface;

const BASE_CONTEXT = {
  preserveAbsent: true,
  contractVersion: CONTRACT_VERSION,
  engine: "typescript"
};

/** Two exports of the same data differ only by the exporter's wall clock. */
function exportXml(exportDate: string, extra = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="zh_CN">
 <ExportDate value="${exportDate}"/>
${extra} <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" value="142" startDate="2026-01-01 08:00:00 +0800" endDate="2026-01-01 08:00:01 +0800"><MetadataEntry key="RAIHealthKitSampleUUID" value="00000000-0000-4000-8000-0000000000a1"/></Record>
</HealthData>`;
}

function writeExport(root: string, xml: string): string {
  const inputPath = join(root, "export");
  mkdirSync(inputPath, { recursive: true });
  writeFileSync(join(inputPath, "export.xml"), xml, "utf8");
  // S3 收口后两条车道都要求 v2 清单（`sync-manifest.json`）；缺它会被
  // `missing_required_files` 显式拒绝（回退旧链路已删）。真机导出天然带它。
  writeFileSync(join(inputPath, "sync-manifest.json"), JSON.stringify({
    version: 2, sourceScope: "healthkit", sourceIds: [], deletedSourceIds: [], deletedRecords: []
  }), "utf8");
  return inputPath;
}

async function seedDatabase(path: string): Promise<void> {
  const store = await RaiDatabase.open(path);
  try {
    // S3.2 的库身份三态：直连车道要求 eligible（四项身份齐全且与当前契约相符）；
    // 只写 dataset_version 会被判 `baseline_rebuild_required`。模板照抄
    // `import-worker-direct-sync.test.ts` 的合规 fixture。
    store.setManifest("dataset_version", "preflight_fixture");
    store.setManifest("parser_contract_version", CONTRACT_VERSION);
    store.setManifest("parser_identity_algorithm", identityAlgorithmFingerprint());
    store.setManifest("import_completed_at", "2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      const workoutId = `preflight_workout_${index}`;
      const startedAt = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
      const endedAt = new Date(Date.parse(startedAt) + 1_800_000).toISOString();
      store.database.prepare(`
        INSERT INTO workouts (
          id, activity_type, source_name, source_category, start_at, end_at,
          duration_seconds, indoor, metadata_json, raw_attributes_json, is_canonical
        ) VALUES (?, 'HKWorkoutActivityTypeRunning', 'Fixture', 'apple_watch', ?, ?, 1800, 0, '{}', '{}', 1)
      `).run(workoutId, startedAt, endedAt);
      store.database.prepare(`
        INSERT INTO training_sessions (
          id, activity_type, anchor_start_at, anchor_end_at, anchor_distance_km,
          canonical_workout_id, status
        ) VALUES (?, 'HKWorkoutActivityTypeRunning', ?, ?, 5, ?, 'active')
      `).run(`preflight_session_${index}`, startedAt, endedAt, workoutId);
    }
  } finally {
    store.close();
  }
}

function queuedJob(inputPath: string, preserveAbsent: boolean): Record<string, unknown> {
  return {
    id: `web_import_preflight_${Math.random().toString(36).slice(2)}`,
    status: "queued",
    phase: "queued",
    message: "queued",
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    inputPath,
    // lane 判定（`import-worker.ts:649`）要求 `job.queue && queueOptions` 双在；
    // 形状与 `ImportWorker.create` 的排队分支一致。
    queue: {
      scope: "preflight", attempts: 0, finalized: false,
      engine: { name: "typescript", version: NATIVE_VERSION, fallback: "none" }
    },
    ...(preserveAbsent ? { preserveAbsent: true } : {})
  };
}

const stageNames = (job: Record<string, unknown>): string[] =>
  Object.keys((job.performance as { stagesMs: Record<string, number> } | undefined)?.stagesMs ?? {});

const anchorOf = (databasePath: string): unknown => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT value FROM import_manifest WHERE key = ?")
      .get(IMPORT_PAYLOAD_ANCHOR_KEY) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } finally {
    database.close();
  }
};

test("payload identity moves with every input that changes what an import writes", () => {
  const baseline = importPayloadSha256("content-a", BASE_CONTEXT);
  assert.equal(importPayloadSha256("content-a", BASE_CONTEXT), baseline, "same inputs must reproduce it");
  assert.notEqual(importPayloadSha256("content-b", BASE_CONTEXT), baseline, "payload content");
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, preserveAbsent: false }),
    baseline,
    "deletion semantics"
  );
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, contractVersion: "canonical-health-v3" }),
    baseline,
    "parser contract version"
  );
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, engine: "rust@0.1.0" }),
    baseline,
    "execution engine"
  );
  // The engine's *version* is part of the engine input, not decoration: a native
  // binary upgrade writes different rows under the same `name`, so it must move
  // the digest on its own.
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, engine: "rust@0.2.0" }),
    importPayloadSha256("content-a", { ...BASE_CONTEXT, engine: "rust@0.1.0" }),
    "execution engine version"
  );
  // The identity algorithm is the input a payload cannot show: identical bytes can
  // derive different ids. `import-worker` always folds the fingerprint in, so an
  // algorithm change invalidates the anchor by itself instead of being skipped.
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, identityAlgorithm: "f".repeat(64) }),
    baseline,
    "identity algorithm"
  );
  // ...and the field must be purely additive: a context that omits it reproduces
  // the pre-field digest byte-for-byte, so its existence cannot re-key a fixture or
  // an older embedder. Recomputed with the original formula rather than compared
  // against `baseline` (which would be the same call and prove nothing).
  const preFieldDigest = createHash("sha256")
    .update("rai.import-payload.v1\0")
    .update(BASE_CONTEXT.contractVersion)
    .update("\0")
    .update(BASE_CONTEXT.preserveAbsent ? "preserve" : "replace")
    .update("\0")
    .update(BASE_CONTEXT.engine)
    .update("\0")
    .update("content-a")
    .digest("hex");
  assert.equal(
    importPayloadSha256("content-a", BASE_CONTEXT),
    preFieldDigest,
    "an absent identity algorithm must not move the digest"
  );
  assert.notEqual(
    importPayloadSha256("content-a", { ...BASE_CONTEXT, identityAlgorithm: identityAlgorithmFingerprint() }),
    preFieldDigest,
    "the value production passes must move the digest"
  );
  // The value production actually passes is the frozen fingerprint; assert it is a
  // real digest rather than an empty string that would silently disable the guard.
  assert.match(identityAlgorithmFingerprint(), /^[0-9a-f]{64}$/);
});

test("payload content digest ignores the exporter wall clock but notices real data", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-identity-"));
  try {
    const first = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
    const before = await computeImportPayloadSha256(first, BASE_CONTEXT);
    // A re-export of identical data carries a new <ExportDate>; the identity must
    // survive that, otherwise the shortcut would never fire for the iOS sync path.
    writeFileSync(join(first, "export.xml"), exportXml("2026-09-24 11:22:33 +0800"), "utf8");
    assert.equal(await computeImportPayloadSha256(first, BASE_CONTEXT), before, "wall clock must not move it");
    writeFileSync(
      join(first, "export.xml"),
      exportXml("2026-09-24 11:22:33 +0800", ' <Record type="HKQuantityTypeIdentifierStepCount" value="9"/>\n'),
      "utf8"
    );
    assert.notEqual(await computeImportPayloadSha256(first, BASE_CONTEXT), before, "new data must move it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("payload anchors round-trip, and an unusable anchor reads as absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-anchor-"));
  const databasePath = join(root, "identity.sqlite");
  try {
    await seedDatabase(databasePath);
    // Nothing recorded yet: the pre-flight must have no basis to short-circuit.
    assert.deepEqual(readDatabaseImportIdentity(databasePath), { anchor: null, datasetVersion: "preflight_fixture" });

    writeAnchor(databasePath, { sha256: "abc", datasetVersion: "preflight_fixture" });
    assert.deepEqual(readDatabaseImportIdentity(databasePath), {
      anchor: { sha256: "abc", datasetVersion: "preflight_fixture" },
      datasetVersion: "preflight_fixture"
    });

    // A corrupt anchor must read as absent rather than as "unchanged" — refusing to
    // guess is what keeps a broken row from becoming a skipped import.
    const raw = new DatabaseSync(databasePath);
    try {
      raw.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)")
        .run(IMPORT_PAYLOAD_ANCHOR_KEY, "{not json");
    } finally {
      raw.close();
    }
    assert.equal(readDatabaseImportIdentity(databasePath)?.anchor, null);
    for (const malformed of ['{"sha256":"abc"}', '{"sha256":"","datasetVersion":"x"}', '{"sha256":"a","datasetVersion":""}']) {
      const writer = new DatabaseSync(databasePath);
      try {
        writer.prepare("INSERT OR REPLACE INTO import_manifest (key, value) VALUES (?, ?)")
          .run(IMPORT_PAYLOAD_ANCHOR_KEY, malformed);
      } finally {
        writer.close();
      }
      assert.equal(readDatabaseImportIdentity(databasePath)?.anchor, null, malformed);
    }
    assert.equal(readDatabaseImportIdentity(join(root, "absent.sqlite")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an import records the payload anchor and the next identical sync skips the whole pipeline", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-hit-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = preflightWorker(databasePath, root);
    const expected = await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true,
      contractVersion: CONTRACT_VERSION,
      engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
      identityAlgorithm: identityAlgorithmFingerprint()
    });

    // First import: no anchor yet, so it must take the full path — write the data,
    // and record the anchor for the payload it applied. 收口后"全管线"= 直连接收器
    // （备份/CLI 候选链路已删，A15/S3.3）；判据 = 数据真落库 + anchor 真记录
    // （短路路径两者都不做）。
    const first = queuedJob(inputPath, true);
    await worker.run(first);
    assert.equal(first.status, "succeeded", String(first.error ?? ""));
    const counts = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((counts.prepare("SELECT COUNT(*) AS n FROM health_records").get() as { n: number }).n, 1,
        "the first import must actually write the record (no anchor ⇒ no short-circuit)");
    } finally { counts.close(); }
    // 导入推进库代次（`dataset_delta_<hash>`，direct-sync-ingest.ts:724）——旧代次锚点
    // 由此失效，这是设计行为；断言锁"新代次落库 + 摘要指向本 payload"。
    const anchor = anchorOf(databasePath) as { sha256: string; datasetVersion: string } | null;
    assert.ok(anchor, "导入后必须记录锚点");
    assert.equal(anchor.sha256, expected);
    assert.match(anchor.datasetVersion, /^dataset_delta_/, "锚点落在导入推进后的新代次上");

    // 收口后备份链路已删（A15/S3.3）：`var/backups` 应根本不存在——"第二次不产生新备份"
    // 的判据由"前后目录内容相同"升级为"整个目录都不出现"。
    assert.equal(existsSync(join(root, "var", "backups")), false, "收口后不产生备份目录");

    // Second import of the identical payload: nothing is backed up, copied, parsed
    // or diffed. This is the whole point of the change.
    const second = queuedJob(inputPath, true);
    await worker.run(second);
    assert.equal(second.status, "succeeded", String(second.error ?? ""));
    assert.equal((second.summary as { importMode: string }).importMode, "unchanged");
    const summary = second.summary as { unchangedWorkouts: number; backupName: string | null; recomputeReasons: string[] };
    assert.equal(summary.unchangedWorkouts, 3, "every existing session is unchanged by a no-op payload");
    assert.equal(summary.backupName, null, "no backup is produced on this path");
    assert.deepEqual(summary.recomputeReasons, ["payload_identity_unchanged"]);
    // 🔴 这份清单必须跟着契约走。2026-10-11 `backup` 拆成三段后，若这里仍写 "backup"，
    // 断言会**恒真**（那个名字再也不可能出现）—— 守卫就静默失效了，而且不会变红。
    for (const skipped of ["backupCapacity", "backupCopy", "backupVerify", "stagingCopy", "parseImport"]) {
      assert.ok(!stageNames(second).includes(skipped), `${skipped} must not run`);
    }
    assert.equal(existsSync(join(root, "var", "backups")), false, "no backup directory appears after the short-circuit either");
    assert.deepEqual(
      readdirSync(join(root, "var")).filter((name) => name.startsWith("rai.importing.")),
      [],
      "no staging database left behind"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a payload that declares absence-as-deletion never short-circuits", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-delete-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = preflightWorker(databasePath, root);
    // The anchor is recorded under deleting semantics, so the identity *would*
    // match a deleting re-import. Refusal can therefore only come from the guard.
    writeAnchor(databasePath, {
      sha256: await computeImportPayloadSha256(inputPath, {
        preserveAbsent: false,
        contractVersion: CONTRACT_VERSION,
        engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
        identityAlgorithm: identityAlgorithmFingerprint()
      }),
      datasetVersion: "preflight_fixture"
    });
    assert.equal(
      await worker.detectUnchangedPayload(queuedJob(inputPath, false), worker.executionEngine),
      null
    );

    // Sanity: the same payload under non-deleting semantics, anchored under those
    // semantics, does hit — so the refusal above is the guard and not a broken
    // identity path.
    writeAnchor(databasePath, {
      sha256: await computeImportPayloadSha256(inputPath, {
        preserveAbsent: true,
        contractVersion: CONTRACT_VERSION,
        engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
        identityAlgorithm: identityAlgorithmFingerprint()
      }),
      datasetVersion: "preflight_fixture"
    });
    const hit = await worker.detectUnchangedPayload(
      queuedJob(inputPath, true),
      worker.executionEngine
    );
    assert.ok(hit, "the non-deleting payload must short-circuit");
    assert.equal(hit.datasetVersion, "preflight_fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a database that moved since the anchor was recorded disables the short-circuit", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-stale-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = preflightWorker(databasePath, root);
    const expected = await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true,
      contractVersion: CONTRACT_VERSION,
      engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
      identityAlgorithm: identityAlgorithmFingerprint()
    });
    writeAnchor(databasePath, { sha256: expected, datasetVersion: "preflight_fixture" });
    assert.ok(await worker.detectUnchangedPayload(queuedJob(inputPath, true), worker.executionEngine));

    // Another import landed in between. `dataset_version` is what makes that
    // visible; without this guard a deletion-only sync would be silently undone by
    // replaying a payload that still carries the deleted row.
    const other = new DatabaseSync(databasePath);
    try {
      other.prepare("UPDATE import_manifest SET value = ? WHERE key = 'dataset_version'").run("preflight_moved");
    } finally {
      other.close();
    }
    assert.ok(readDatabaseImportIdentity(databasePath));
    assert.equal(
      await worker.detectUnchangedPayload(queuedJob(inputPath, true), worker.executionEngine),
      null
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a payload whose identity differs still runs the full pipeline", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-miss-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = preflightWorker(databasePath, root);
    writeAnchor(databasePath, { sha256: "not-this-payload", datasetVersion: "preflight_fixture" });

    const job = queuedJob(inputPath, true);
    await worker.run(job);
    assert.equal(job.status, "succeeded", String(job.error ?? ""));
    // 收口后"全管线"= 直连接收器真跑（备份/CLI 候选链路已删，A15/S3.3）；判据 =
    // 锚点被更新为**本 payload** 的摘要（短路误命中时锚点保持 "not-this-payload" 不变）。
    const anchor = anchorOf(databasePath) as { sha256: string; datasetVersion: string } | null;
    assert.ok(anchor, "非短路导入后必须记录锚点");
    assert.equal(anchor.sha256, await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true,
      contractVersion: CONTRACT_VERSION,
      engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
      identityAlgorithm: identityAlgorithmFingerprint()
    }));
    assert.match(anchor.datasetVersion, /^dataset_delta_/, "锚点落在导入推进后的新代次上");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable payload disables the short-circuit and is refused explicitly (not a crash)", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-unreadable-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  // The directory exists but carries no export.xml, so the identity cannot be read.
  const inputPath = join(root, "export");
  mkdirSync(inputPath);
  try {
    await seedDatabase(databasePath);
    const worker = preflightWorker(databasePath, root);
    writeAnchor(databasePath, { sha256: "abc", datasetVersion: "preflight_fixture" });
    assert.equal(
      await worker.detectUnchangedPayload(queuedJob(inputPath, true), worker.executionEngine),
      null
    );
    // 收口后"不可读"不再回退 CLI（已删），而是**显式失败**（稳定码；进程不崩、
    // 不静默换道）——与"载荷摘要缺失 ⇒ ImportLaneRefusal"的收口语义一致。
    const job = queuedJob(inputPath, true);
    await worker.run(job);
    assert.equal(job.status, "failed");
    assert.equal((job as { failureCode?: string }).failureCode, "direct_sync_input_not_allowed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the recorded anchor survives a real direct import into the live database", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-payload-preflight-activate-"));
  const databasePath = join(root, "var", "rai.sqlite");
  mkdirSync(join(root, "var"));
  const inputPath = writeExport(root, exportXml("2026-09-23 10:01:26 +0800"));
  try {
    await seedDatabase(databasePath);
    const worker = preflightWorker(databasePath, root);
    // 收口后导入是直连事务路径（无 CLI/staging/换库可注入）；这条用例现在验证的
    // 是"真导入之后锚点与库同代"——换库前时代的"survives activation"判据已随链路退场。
    const job = queuedJob(inputPath, true);
    await worker.run(job);
    assert.equal(job.status, "succeeded", String(job.error ?? ""));
    const anchor = anchorOf(databasePath) as { sha256: string; datasetVersion: string } | null;
    assert.ok(anchor, "真导入后锚点必须与库同代存在");
    assert.equal(anchor.sha256, await computeImportPayloadSha256(inputPath, {
      preserveAbsent: true,
      contractVersion: CONTRACT_VERSION,
      engine: `${worker.executionEngine.name}@${worker.executionEngine.version}`,
      identityAlgorithm: identityAlgorithmFingerprint()
    }));
    assert.match(anchor.datasetVersion, /^dataset_delta_/, "锚点落在导入推进后的新代次上");
    assert.equal(
      readFileSync(join(root, "var", "runtime.sqlite")).length > 0,
      true,
      "runtime state remains readable"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
